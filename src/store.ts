import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { defaultCountTokens, type CoreMessage } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { getStore, storePayloadCodec } from "./persist.js";
import { storeDir } from "./paths.js";
import { RETRIEVE_TOOL_NAME } from "./compress-tool.js";
import type { CompressSettings } from "./config.js";
import type { Session } from "./session.js";

export type StoreConfig = NonNullable<CompressSettings["store"]>;

/** Per-message-ref record of ID-referenced content. `hash` is the sha1 of the
 *  original bytes — the content address, the dedup key, and the sidecar
 *  filename. The rest is deterministic metadata the wire placeholder renders so
 *  the model can judge relevance without fetching. */
export type StoredEntry = {
    hash: string;
    bytes: number;
    tokens: number;
    kind: "tool-result" | "image";
    tool?: string;
};

const EFFECTIVE_STORE_KEY = "effectiveStore";
const INDEX_KEY = "storeIndex";

// Tool results below this many tokens stay verbatim on the wire — the
// placeholder overhead is not worth it, and small results are cheap to keep.
const DEFAULT_MIN_TOKENS = 500;
// Per-session cap on stored bytes (logical, per-ref). Content beyond the cap is
// left verbatim (we never emit a placeholder whose original we did not store).
const DEFAULT_MAX_STORE_BYTES = 2 * 1024 * 1024;

/** Stamp the last-resolved store policy onto the session so the view/execution
 *  sites — and the plugin-tool path, which resolves sessions without a request
 *  context — can read it back. Mirrors storeEffectiveAbsorb (#833). */
export function storeEffectiveStore(session: Session, store: StoreConfig | undefined): void {
    session.metadata[EFFECTIVE_STORE_KEY] = store ?? null;
}

/** Read back the last-resolved store policy stamped by {@link storeEffectiveStore}. */
export function effectiveStoreConfig(session: Session | undefined): StoreConfig | undefined {
    const meta = session?.metadata[EFFECTIVE_STORE_KEY];
    if (meta && typeof meta === "object" && typeof (meta as StoreConfig).enabled === "boolean") {
        return meta as StoreConfig;
    }
    return undefined;
}

export function storeEnabled(session: Session | undefined): boolean {
    return effectiveStoreConfig(session)?.enabled === true;
}

/** The per-ref index lives in session.metadata (persisted via buildRecord's
 *  metadata spread — atomic, compaction-proof, zero new deps, same lifecycle as
 *  blockContents). It holds metadata + a content hash only, NEVER payload bytes. */
function indexOf(session: Session): Record<string, StoredEntry> {
    const raw = session.metadata[INDEX_KEY];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, StoredEntry>) : {};
}

function setIdx(session: Session, idx: Record<string, StoredEntry>): void {
    session.metadata[INDEX_KEY] = idx;
}

function idSlug(id: string): string {
    return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 20);
}

function poolDirFor(session: Session): string {
    return path.join(storeDir(), idSlug(session.id));
}

function poolFileFor(session: Session, hash: string): string {
    return path.join(poolDirFor(session), `${hash}.txt`);
}

/** Store `text` under `ref`, writing the original to a hash-keyed sidecar file
 *  and recording only metadata in the persisted index. Idempotent: re-storing
 *  the same ref returns the existing entry. Returns null when disabled, too
 *  small, or the byte budget is exhausted (the caller then leaves the original
 *  on the wire rather than emitting an unretrievable placeholder). */
export function ensureStored(session: Session, ref: string, text: string, tool?: string): StoredEntry | null {
    const cfg = effectiveStoreConfig(session);
    if (!cfg?.enabled || !ref || !text) return null;
    const existing = indexOf(session)[ref];
    if (existing) return existing;
    const minTokens = cfg.minTokens ?? DEFAULT_MIN_TOKENS;
    const maxStoreBytes = cfg.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
    const tokens = defaultCountTokens(text);
    if (tokens < minTokens) return null;
    const bytes = Buffer.byteLength(text, "utf8");
    const idx = indexOf(session);
    const held = Object.values(idx).reduce((a, e) => a + e.bytes, 0);
    if (held + bytes > maxStoreBytes) return null;
    const hash = createHash("sha1").update(text, "utf8").digest("hex");
    // Payload-file-first: persist the original BEFORE recording the index entry,
    // so a crash mid-arrival leaves at worst an orphan file (swept later) — never
    // a placeholder pointing at missing content.
    try {
        const dir = poolDirFor(session);
        const file = poolFileFor(session, hash);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        if (!existsSync(file)) {
            const codec = storePayloadCodec();
            writeFileSync(file, codec ? codec.encode(text) : text);
        }
    } catch (err) {
        loggerLog("warn", `[store] failed to persist ${ref}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    idx[ref] = { hash, bytes, tokens, kind: "tool-result", ...(tool ? { tool } : {}) };
    setIdx(session, idx);
    session.stats.storedBytes = Object.values(idx).reduce((a, e) => a + e.bytes, 0);
    getStore().scheduleSave(session);
    return idx[ref];
}

/** Render the deterministic wire placeholder for a stored ref. Carries enough
 *  signal (tool, size, a head preview) for the model to judge relevance without
 *  fetching, plus the exact acp_retrieve call to make. It also states that
 *  summarizing is REVERSIBLE — the original persists under this ref — so the
 *  model can freely pick gist (absorb) or full (retrieve); both fidelities
 *  coexist under the same id. Byte-stable for a given ref+original, so the
 *  upstream prefix cache stays warm across turns. */
export function renderPlaceholder(ref: string, entry: StoredEntry, original: string): string {
    const label = entry.tool ?? "tool";
    const head = original.replace(/\s+/g, " ").trim().slice(0, 60);
    const headPart = head ? ` ${JSON.stringify(head)}` : "";
    return `\u{1F4E6} [stored #${ref} \u00B7 ${label} \u00B7 ${entry.tokens} tok]${headPart} \u2192 ${RETRIEVE_TOOL_NAME}("${ref}") restores full text; safe to summarize \u2014 the original stays retrievable by this ref`;
}

/** ID-reference view: replace oversized tool-result content with a deterministic
 *  placeholder, storing the original in the session content store first. Runs
 *  after the absorb view (so model-triggered absorption wins); only shrinks the
 *  content INSIDE a tool result, leaving role/toolCallId pairing intact. Pure
 *  with respect to the wire for a given input. `storeBytesSaved` is recomputed
 *  (not accumulated) here so repeated re-substitution across turns does not
 *  inflate it — it reflects the CURRENT wire savings. */
export function applyStoreView(messages: CoreMessage[], session: Session): CoreMessage[] {
    if (effectiveStoreConfig(session)?.enabled !== true) return messages;
    const cfg = effectiveStoreConfig(session)!;
    const minTokens = cfg.minTokens ?? DEFAULT_MIN_TOKENS;
    const byRaw = session.state.messageRefs?.byRaw ?? {};
    let changed = false;
    let saved = 0;
    const out = messages.map((m) => {
        if (m.role !== "tool" || m.contentType !== "tool-result") return m;
        const text = m.text ?? "";
        if (defaultCountTokens(text) < minTokens) return m;
        const ref = byRaw[m.id];
        if (!ref) return m;
        const entry = ensureStored(session, ref, text, m.toolName);
        if (!entry) return m;
        const placeholder = renderPlaceholder(ref, entry, text);
        saved += Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(placeholder, "utf8"));
        changed = true;
        return { ...m, text: placeholder };
    });
    if (changed) session.stats.storeBytesSaved = saved;
    return changed ? out : messages;
}

/** Execute an acp_retrieve call: resolve a stored ref back to its full original
 *  text, lazy-loading the SINGLE sidecar file named by the index entry (no
 *  whole-blob parse). The returned content rides the ephemeral tool-result
 *  channel (the same intra-request re-request path as decompress) — it never
 *  enters fold space and consumes no message ref. Not-found costs one tool call
 *  and self-corrects. */
export function executeRetrieve(args: Record<string, unknown>, session: Session): string {
    session.stats.retrieveCalls = (session.stats.retrieveCalls ?? 0) + 1;
    const rawRef = args.ref;
    const ref = typeof rawRef === "string" ? rawRef.trim() : "";
    if (!ref) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        return `[${RETRIEVE_TOOL_NAME} FAILED: ref (an mNNNNN id) is required]`;
    }
    const entry = indexOf(session)[ref];
    if (!entry) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        return `[${RETRIEVE_TOOL_NAME} FAILED: ${ref} not found in store]`;
    }
    let text: string;
    try {
        const buf = readFileSync(poolFileFor(session, entry.hash));
        const codec = storePayloadCodec();
        text = codec ? codec.decode(buf) : buf.toString("utf8");
    } catch {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        return `[${RETRIEVE_TOOL_NAME} FAILED: ${ref} content unavailable]`;
    }
    session.stats.retrieveHits = (session.stats.retrieveHits ?? 0) + 1;
    loggerLog("info", `[store] retrieve ${ref} (${entry.tokens} tok, ${entry.bytes} B)${entry.tool ? ` tool=${entry.tool}` : ""}`);
    return `[retrieved #${ref} \u00B7 ${entry.tokens} tok]\n${text}`;
}
