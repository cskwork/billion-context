// #920: keep opencode-acp legacy sessions working after switching to bili.
//
// The V1 thin plugin (opencode.ts) imports the INSTALLED opencode-acp package
// as a library and wraps its hooks so that ONLY sessions with acp state on
// disk ("legacy") are handled by acp. New sessions are never adopted: every
// stateful hook gates on "an acp store file exists for this session". The
// host never loads acp from config (the launcher strips the entry from its
// temp-config clone), so acp's global self-disable on /bili/ baseURLs (its
// config hook) is never armed — we simply never invoke that hook.
//
// Graceful degradation: package not found / import failure / version drift /
// unexpected hook shape → createAcpBridge returns null and the plugin behaves
// exactly as before this change (legacy sessions degrade as they do today).

import * as fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

// Set by the launcher (src/launcher.ts) to the opencode-acp spec it stripped
// from the temp-config clone, so the bridge imports the SAME package copy the
// host would have loaded (legacy state formats must match the writer).
const ACP_SPEC_ENV = "BILI_OPENCODE_ACP_SPEC";

export interface AcpToolDef {
    description?: string;
    args?: unknown;
    execute?: (args: unknown, toolCtx: { sessionID?: string; [key: string]: unknown }) => Promise<unknown>;
    [key: string]: unknown;
}

// Loose host-wire shapes — the imported handlers are opaque; they receive
// whatever the host sends, and the wrappers forward both args untouched.
type AcpSystemTransform = (input: { sessionID?: string; [key: string]: unknown }, output: { system: unknown[] }) => Promise<void> | void;
type AcpMessagesTransform = (input: Record<string, never>, output: { messages: unknown[] }) => Promise<void> | void;
type AcpTextComplete = (input: { sessionID?: string; [key: string]: unknown }, output: { text: string }) => Promise<void> | void;
type AcpCommandBefore = (input: { command?: string; sessionID?: string; arguments?: string; [key: string]: unknown }, output: Record<string, unknown>) => Promise<void> | void;
type AcpEventHandler = (input: { event?: unknown; [key: string]: unknown }) => Promise<void> | void;

interface AcpHooks {
    "experimental.chat.system.transform"?: AcpSystemTransform;
    "experimental.chat.messages.transform"?: AcpMessagesTransform;
    "experimental.text.complete"?: AcpTextComplete;
    "command.execute.before"?: AcpCommandBefore;
    event?: AcpEventHandler;
    config?: (input: unknown) => Promise<void> | void;
    tool?: Record<string, AcpToolDef>;
}

export interface AcpBridge {
    version: string;
    storeDir: string;
    isLegacySession(sessionID: string): boolean;
    wrapped: {
        "experimental.chat.system.transform": (input: { sessionID?: string; [key: string]: unknown }, output: { system: unknown[] }) => Promise<void>;
        "experimental.chat.messages.transform": (input: Record<string, never>, output: { messages: unknown[] }) => Promise<void>;
        "experimental.text.complete": (input: { sessionID?: string; [key: string]: unknown }, output: { text: string }) => Promise<void>;
        "command.execute.before": (input: { command?: string; sessionID?: string; arguments?: string; [key: string]: unknown }, output: Record<string, unknown>) => Promise<void>;
        event: (input: { event?: unknown; [key: string]: unknown }) => Promise<void>;
    };
    tools: Record<string, AcpToolDef>;
}

function xdgDataHome(): string {
    return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
}

function xdgConfigHome(): string {
    return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
}

function xdgCacheHome(): string {
    return process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
}

/** Mirror of acp's findOpencodeDir: nearest ancestor containing .opencode. */
function findProjectAcpDir(directory: string): string | undefined {
    let cur = directory;
    for (;;) {
        const cand = path.join(cur, ".opencode");
        try {
            if (fs.statSync(cand).isDirectory()) return cand;
        } catch { /* keep walking up */ }
        const parent = path.dirname(cur);
        if (parent === cur) return undefined;
        cur = parent;
    }
}

/** Mirror of acp's storage-path resolution (lib/state/persistence.ts):
 *  empty → default dir; "~" → home; "~/x" expanded; absolute as-is;
 *  relative → against the session directory. */
function resolveStorageDir(configured: string | undefined, directory: string): string {
    if (!configured) return path.join(xdgDataHome(), "opencode", "storage", "plugin", "acp");
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return path.join(homedir(), configured.slice(2));
    if (path.isAbsolute(configured)) return configured;
    return path.join(directory, configured);
}

/** Read `storagePath` from acp's config files, same precedence as acp
 *  (project .opencode > $OPENCODE_CONFIG_DIR > global XDG config). */
function readConfiguredStoragePath(directory: string): string | undefined {
    const dirs: string[] = [];
    const projectDir = findProjectAcpDir(directory);
    if (projectDir) dirs.push(projectDir);
    if (process.env.OPENCODE_CONFIG_DIR) dirs.push(process.env.OPENCODE_CONFIG_DIR);
    dirs.push(path.join(xdgConfigHome(), "opencode"));
    for (const dir of dirs) {
        for (const name of ["acp.jsonc", "acp.json"]) {
            let text: string;
            try {
                text = fs.readFileSync(path.join(dir, name), "utf8");
            } catch {
                continue;
            }
            const parsed = parseJsonc(text) as { storagePath?: unknown } | null;
            if (parsed && typeof parsed === "object" && typeof parsed.storagePath === "string" && parsed.storagePath.length > 0) {
                return parsed.storagePath;
            }
        }
    }
    return undefined;
}

export function acpStoreDir(directory: string): string {
    return resolveStorageDir(readConfiguredStoragePath(directory), directory);
}

function readPkgVersion(pkgPath: string): number[] | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf8")) as { version?: string };
        const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(typeof raw.version === "string" ? raw.version : "");
        if (!m) return undefined;
        return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    } catch {
        return undefined;
    }
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return 0;
}

function isValidAcpPkg(pkgPath: string): { version: number[]; mtime: number } | undefined {
    const version = readPkgVersion(pkgPath);
    // v1 bridge only — the V1 plugin shape this bridge wraps does not exist
    // for other majors (#920 scope).
    if (!version || version[0] !== 1) return undefined;
    try {
        return { version, mtime: fs.statSync(path.join(pkgPath, "dist", "index.js")).mtimeMs };
    } catch {
        return undefined;
    }
}

/** Locate the installed opencode-acp package. The launcher-stripped spec
 *  (env hint) is authoritative when its cache slot is valid — that IS the
 *  copy the host would have loaded (legacy state must match the writer).
 *  Otherwise: <project>/node_modules, <XDG_CONFIG_HOME>/opencode/node_modules,
 *  then the newest valid <XDG_CACHE_HOME>/opencode/packages/opencode-acp* slot. */
export function resolveAcpPackage(directory: string): string | undefined {
    const spec = process.env[ACP_SPEC_ENV];
    if (typeof spec === "string" && spec.length > 0) {
        const slot = path.join(xdgCacheHome(), "opencode", "packages", spec, "node_modules", "opencode-acp");
        if (isValidAcpPkg(slot)) return slot;
        // Spec'd copy missing or broken — fall through to generic probes.
    }
    const candidates: string[] = [
        path.join(directory, "node_modules", "opencode-acp"),
        path.join(xdgConfigHome(), "opencode", "node_modules", "opencode-acp"),
    ];
    const pkgRoot = path.join(xdgCacheHome(), "opencode", "packages");
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(pkgRoot);
    } catch { /* no packages cache */ }
    for (const entry of [...entries].sort()) {
        if (/^opencode-acp(@|\/|$)/.test(entry)) {
            candidates.push(path.join(pkgRoot, entry, "node_modules", "opencode-acp"));
        }
    }
    let best: { pkgPath: string; version: number[]; mtime: number } | undefined;
    for (const candidate of candidates) {
        const valid = isValidAcpPkg(candidate);
        if (!valid) continue;
        if (!best) {
            best = { pkgPath: candidate, ...valid };
            continue;
        }
        // Higher version wins; ties keep the earlier candidate (probe-order priority).
        if (compareVersions(valid.version, best.version) > 0) {
            best = { pkgPath: candidate, ...valid };
        }
    }
    return best?.pkgPath;
}

let degradeLogged = false;

function logDegrade(why: string): void {
    if (degradeLogged) return;
    degradeLogged = true;
    console.warn(`[bili-opencode] acp bridge unavailable (${why}) — legacy sessions fall back to ordinary bili mode (#920)`);
}

interface AcpMessageLike {
    info?: { role?: string; id?: string; sessionID?: string };
    parts?: Array<{ ignored?: boolean } | null> | null;
}

/** Mirror of acp's getLastUserMessage (lib/messages/query.ts) — enough of it
 *  to extract the session id the eager adoption would key on: last real
 *  (non-synthetic, non-fully-ignored) user message, walking backwards. */
function lastUserSessionId(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as AcpMessageLike | null | undefined;
        if (!msg || typeof msg !== "object") continue;
        const info = msg.info;
        if (!info || typeof info !== "object") continue;
        if (info.role !== "user") continue;
        const id = typeof info.id === "string" ? info.id : "";
        if (id.startsWith("msg_dcp_summary_") || id.startsWith("msg_dcp_text_") || id.startsWith("msg_acp_recap_")) continue;
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        if (parts.length === 0) continue;
        if (parts.every((p) => p !== null && typeof p === "object" && p.ignored)) continue;
        return typeof info.sessionID === "string" ? info.sessionID : undefined;
    }
    return undefined;
}

/** Import the installed opencode-acp as a library and wrap its hooks behind
 *  the legacy-session gate. Returns null (→ normal bili mode) on ANY failure. */
export async function createAcpBridge(ctx: { directory: string }): Promise<AcpBridge | null> {
    const directory = ctx.directory;
    const pkgPath = resolveAcpPackage(directory);
    if (!pkgPath) {
        logDegrade("opencode-acp package not found");
        return null;
    }
    // acp's BILLION_CONTEXT_PROXY guard runs when server(ctx) is CALLED, not
    // at module evaluation — save/delete around the call, restore in finally.
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    let raw: Record<string, unknown> | null;
    let version = "";
    try {
        const mod = await import(pathToFileURL(path.join(pkgPath, "dist", "index.js")).href);
        const serverFn: unknown = (mod as { default?: unknown }).default;
        if (typeof serverFn !== "function") {
            logDegrade("unexpected export shape (no default function)");
            return null;
        }
        const hooksOut = await (serverFn as (hostCtx: unknown) => Promise<Record<string, unknown>>)(ctx);
        if (!hooksOut || typeof hooksOut !== "object") {
            logDegrade("plugin returned no hooks");
            return null;
        }
        raw = hooksOut;
        try {
            version = String((JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf8")) as { version?: string }).version ?? "");
        } catch { /* version is cosmetic */ }
    } catch (err) {
        logDegrade(`import/init failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    } finally {
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
    }

    const hooks = raw as Partial<AcpHooks>;
    if (typeof hooks["experimental.chat.messages.transform"] !== "function") {
        logDegrade("version drift: messages.transform hook missing");
        return null;
    }
    const toolsRaw = hooks.tool;
    if (!toolsRaw || typeof toolsRaw !== "object" || !toolsRaw.compress || typeof toolsRaw.compress !== "object") {
        logDegrade("version drift: compress tool missing");
        return null;
    }

    const storeDir = acpStoreDir(directory);
    const isLegacySession = (sessionID: string): boolean => {
        try {
            return fs.existsSync(path.join(storeDir, `${sessionID}.json`));
        } catch {
            return false;
        }
    };

    const wrapped: AcpBridge["wrapped"] = {
        "experimental.chat.system.transform": async (input, output) => {
            if (typeof input?.sessionID !== "string" || !isLegacySession(input.sessionID)) return;
            await hooks["experimental.chat.system.transform"]!(input, output);
        },
        "experimental.chat.messages.transform": async (input, output) => {
            const sid = lastUserSessionId(output?.messages);
            if (!sid || !isLegacySession(sid)) return;
            await hooks["experimental.chat.messages.transform"]!(input, output);
        },
        "experimental.text.complete": async (input, output) => {
            if (typeof input?.sessionID !== "string" || !isLegacySession(input.sessionID)) return;
            await hooks["experimental.text.complete"]!(input, output);
        },
        "command.execute.before": async (input, output) => {
            if (typeof input?.sessionID !== "string" || !isLegacySession(input.sessionID)) return;
            await hooks["command.execute.before"]!(input, output);
        },
        event: async (input) => {
            // Ungated by design: acp's event handler only reacts to LOCAL
            // `compress` tool parts (timing bookkeeping keyed by
            // messageID+callID). Under bili, new sessions never produce local
            // compress parts — the proxy executes wire compress calls
            // server-side and strips them from the stream — so this cannot
            // adopt or touch a non-legacy session.
            await hooks.event?.(input);
        },
    };

    const tools: Record<string, AcpToolDef> = {};
    for (const [name, def] of Object.entries(toolsRaw)) {
        if (!def || typeof def !== "object") continue;
        if (def.execute) {
            const origExecute = def.execute;
            tools[name] = {
                ...def,
                execute: async (args, toolCtx) => {
                    // Static process-global registry: definitions serve legacy
                    // sessions; a non-legacy session calling one gets a
                    // degraded answer instead of accidental adoption.
                    if (typeof toolCtx?.sessionID === "string" && !isLegacySession(toolCtx.sessionID)) {
                        return `[bili] "${name}" is not available in this session — it belongs to an older opencode-acp session. This session compresses through the billion-context proxy.`;
                    }
                    return origExecute(args, toolCtx);
                },
            };
        } else {
            tools[name] = def;
        }
    }

    return { version, storeDir, isLegacySession, wrapped, tools };
}
