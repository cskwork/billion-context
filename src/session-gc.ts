import { readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { getStore, type SessionStore } from "./persist.js";
import { sessionsDir } from "./paths.js";
import { dropSessionForGc, peekSession } from "./session.js";

/**
 * Session-file garbage collection (#1082). OPT-IN: disabled unless
 * BILI_SESSION_GC is set to 1/true/on. Session files are user data
 * (exportable, resumable), so there is no silent deletion policy — the
 * kernel store never deletes, and this sweep only runs when asked to.
 *
 * When enabled, the sweep deletes a file only when BOTH conditions hold
 * (owner requirement #1082: both are load-bearing, neither alone suffices):
 *
 *   1. AGE: last activity (envelope savedAt) older than
 *      BILI_SESSION_GC_MAX_AGE_DAYS (default 7d). The threshold must stay far
 *      beyond any plausible resume window: after deletion a resumed session
 *      restarts numbering from m00001 while a resuming agent's transcript may
 *      still cite old numbers (kernel contract: ids are never reused), so a
 *      short threshold risks silent misattribution.
 *   2. SMALL / LOSSLESS REBUILD: the session was NEVER compressed (zero
 *      blocks, active or inactive, and no blockContents) AND its re-send size
 *      is bounded — deleting it loses no summaries, only bytes:
 *        2a. metadata.rawInputTokens known (recorded per turn since #1082):
 *            rawInputTokens <= BILI_SESSION_GC_MAX_TOKENS (default 1M);
 *        2b. unknown (legacy/pre-upgrade file): stats.contextTokens <= the
 *            same threshold. A session WITH folds can read small in context
 *            yet carry huge raw history (compressed 300K → 20K) and its
 *            summaries cannot be rebuilt losslessly — those files are always
 *            kept, regardless of size.
 *
 * Every deletion is audit-logged individually (path, size, age) plus one
 * summary line per non-empty sweep. The sweep touches ONLY the sessions dir.
 *
 * The sweep walks the DISK tree, not the in-memory map: sessions evicted by
 * the MAX_SESSIONS LRU cap or dropped at boot still have files, and only a
 * disk walk sees them. mtime is a cheap pre-filter; only age-eligible files
 * are decoded (any codec-framed file — encrypted today, zstd-compressed
 * once #1083 lands — works via the store's format-agnostic reader).
 * Corrupt/unreadable files are left in place, never guessed at.
 */

export interface GcConfig {
    enabled: boolean;
    maxAgeMs: number;
    maxTokens: number;
    intervalMs: number;
}

const DEFAULT_MAX_AGE_DAYS = 7;
// Owner decision (#1082): aggressive by design — a cold rebuild (client re-sends
// full history, proxy folds via preflight) is acceptable even for large idle
// sessions, so the size gate rarely bites; the age gate does the work.
const DEFAULT_MAX_TOKENS = 1_000_000;
const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function gcConfigFromEnv(): GcConfig {
    // Opt-in only (owner requirement #1082): unset means disabled.
    const env = process.env.BILI_SESSION_GC?.toLowerCase();
    const enabled = env === "1" || env === "true" || env === "on";
    return {
        enabled,
        maxAgeMs: intEnv("BILI_SESSION_GC_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS) * DAY_MS,
        maxTokens: intEnv("BILI_SESSION_GC_MAX_TOKENS", DEFAULT_MAX_TOKENS),
        intervalMs: intEnv("BILI_SESSION_GC_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    };
}

function intEnv(name: string, fallback: number): number {
    const v = process.env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface FileView {
    id: string | null;
    savedAt: number;
    contextTokens: number;
    everCompressed: boolean;
    rawInputTokens: number | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Interpret a parsed session record (v3 envelope or legacy flat, grouped-then-
 *  flat fallbacks mirroring the readers in persist.ts). Null when unusable. */
export function viewFromParsed(parsed: unknown): FileView | null {
    const top = asRecord(parsed);
    if (!top) return null;
    const payload = asRecord(top.payload);
    const rec = payload ?? top;
    const savedAt = num(top.savedAt ?? rec.savedAt);
    if (savedAt === null || savedAt <= 0) return null;
    const state = asRecord(rec.state);
    const blocks = Array.isArray(state?.blocks) ? (state!.blocks as unknown[]) : [];
    // Any block — active OR inactive — or any stored fold content means the
    // session was compressed at some point: its summaries cannot be rebuilt
    // losslessly from a client re-send, so the file is never GC-eligible.
    const blockContents = asRecord(rec.blockContents);
    const everCompressed = blocks.length > 0 || (blockContents !== null && Object.keys(blockContents).length > 0);
    const stats = asRecord(rec.stats);
    const contextTokens = num(stats?.contextTokens ?? rec.contextTokens) ?? 0;
    const metadata = asRecord(rec.metadata);
    const rawInputTokens = num(metadata?.rawInputTokens);
    const id = typeof top.id === "string" ? top.id
        : typeof rec.id === "string" ? rec.id
            : null;
    return { id, savedAt, contextTokens, everCompressed, rawInputTokens };
}

export function isGcEligible(view: FileView, now: number, cfg: Pick<GcConfig, "maxAgeMs" | "maxTokens">): boolean {
    if (now - view.savedAt < cfg.maxAgeMs) return false;
    if (view.everCompressed) return false;
    return view.rawInputTokens !== null
        ? view.rawInputTokens <= cfg.maxTokens
        : view.contextTokens <= cfg.maxTokens;
}

async function walkSessionFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkSessionFiles(full)));
        } else if (e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".") && !e.name.includes(".tmp-")) {
            out.push(full);
        }
    }
    return out;
}

export interface GcResult {
    removed: number;
    kept: number;
    unreadable: number;
    bytesFreed: number;
}

export async function gcSessionFiles(opts?: { dir?: string; store?: SessionStore; now?: number }): Promise<GcResult> {
    const result: GcResult = { removed: 0, kept: 0, unreadable: 0, bytesFreed: 0 };
    const cfg = gcConfigFromEnv();
    if (!cfg.enabled) return result;
    const store = opts?.store ?? getStore();
    if (!store.enabled) return result;
    const dir = opts?.dir ?? sessionsDir();
    const now = opts?.now ?? Date.now();
    let files: string[];
    try {
        files = await walkSessionFiles(dir);
    } catch {
        return result;
    }
    for (const file of files) {
        let st;
        try {
            st = await stat(file);
        } catch {
            continue;
        }
        if (!st.isFile() || now - st.mtimeMs < cfg.maxAgeMs) {
            result.kept++;
            continue;
        }
        const parsed = await store.readRawFile(file);
        const view = parsed === null ? null : viewFromParsed(parsed);
        if (!view) {
            result.unreadable++;
            continue;
        }
        if (!isGcEligible(view, now, cfg)) {
            result.kept++;
            continue;
        }
        if (view.id !== null) {
            const resident = peekSession(view.id);
            if (resident) {
                // Resident + fresh in memory (activity after the on-disk write,
                // in-flight request, or pending debounced save) → deleting the
                // file would lose live state or be undone by the writer. Defer
                // to the next sweep.
                if (resident.inFlight > 0 || store.hasPending(view.id) || resident.lastSeen > view.savedAt + 1000) {
                    result.kept++;
                    continue;
                }
                dropSessionForGc(view.id);
            }
        }
        try {
            await rm(file, { force: true });
        } catch {
            result.kept++;
            continue;
        }
        // Audit trail (owner requirement #1082): every deletion is individually
        // traceable — which file, how big, how old.
        loggerLog("info", `[gc] removed ${path.relative(dir, file)} (${st.size} B, age ${Math.round((now - view.savedAt) / DAY_MS)}d)`);
        result.removed++;
        result.bytesFreed += st.size;
        const parent = path.dirname(file);
        if (parent !== dir) await rmdir(parent).catch(() => {});
    }
    if (result.removed > 0 || result.unreadable > 0) {
        loggerLog(result.unreadable > 0 ? "warn" : "info",
            `[gc] removed ${result.removed} stale session file(s) (age>${Math.round(cfg.maxAgeMs / DAY_MS)}d, ≤${cfg.maxTokens}tok), freed ${(result.bytesFreed / 1024).toFixed(1)} KB${result.unreadable > 0 ? `; left ${result.unreadable} unreadable file(s) in place` : ""}`);
    }
    return result;
}
