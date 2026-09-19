// `bili plugin install|remove|list <agent>`: deploys the thin agent plugin
// (dist/agent/pi.js|omp.js) or the MCP shell (dist/mcp.js) into each host's
// native config, pointing at THIS billion-context install's absolute path —
// plugin and proxy always share one version. Every writer backs the target
// file up first and is idempotent. Config locations:
//   pi       ~/.pi/agent/settings.json   packages: [<abs package root>]
//   omp      ~/.omp/agent/config.yml     extensions: [<abs>/dist/agent/omp.js]
//   claude   `claude mcp add` (user scope; writes ~/.claude.json)
//   codex    ~/.codex/config.toml        [mcp_servers.bili]
//   opencode <cfg>/opencode.json{c}|config.json (highest-precedence existing; #927)
//            mcp.bili + native plugin dir + compaction.auto=false
//          (plugin entry #925: bare "billion-context" for npm installs — opencode
//           loads it via exports["./server"] and manages install/upgrade itself;
//           local shim dir for checkout/dev installs, which are not portable)
// Installers throw on failure (bad/locked config, missing host CLI); the CLI
// layer catches, prints `bili plugin: <msg>` and exits 1.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify as jsoncModify, parse as jsoncParse, type ParseError } from "jsonc-parser";
import { resolveDshHome, resolvePiHome } from "./client-config.js";
import { clearClaudeNativePort, resolveClaudeNativePort, saveClaudeNativePort } from "./config.js";
import { isPidAlive, isProxyInstanceFile, readProxyInstanceFile } from "./instance.js";

/** #403: never freeze a dead or unverifiable origin into a client's
 *  persistent config — the MCP shell would dial it forever. An explicit
 *  BILI_MCP_PROXY env wins (the user said so); otherwise a recorded
 *  instance must be pid-alive. */
function proxyOriginForInstall(): string {
    const fromEnv = process.env.BILI_MCP_PROXY?.trim();
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    const inst = readProxyInstanceFile();
    if (inst === undefined) {
        throw new Error("no bili proxy origin found — start bili first (\`bili start\` or \`bili <client>\`), then retry, or set BILI_MCP_PROXY explicitly");
    }
    if (isProxyInstanceFile(inst) && !isPidAlive(inst.pid)) {
        throw new Error(`the recorded bili proxy (pid ${inst.pid}, ${inst.origin}) is not running — start bili and retry so a dead origin is not frozen into the client config`);
    }
    return inst.origin;
}

export const PLUGIN_AGENTS = ["pi", "omp", "claude", "codex", "opencode", "dsh"] as const;
export type PluginAgent = (typeof PLUGIN_AGENTS)[number];

export function selfPackageRoot(): string {
    // dist/plugin-install.js -> package root two levels up.
    const here = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(here), "..");
}

function homeFile(rel: string, envOverride?: string): string {
    const raw = (envOverride !== undefined ? process.env[envOverride] : undefined)?.trim();
    const base = raw && raw.length > 0 ? raw : os.homedir();
    return path.join(base, rel);
}

function backupOnce(file: string): void {
    if (fs.existsSync(file) && !fs.existsSync(`${file}.bili-bak`)) {
        fs.copyFileSync(file, `${file}.bili-bak`);
    }
}

function readJson(file: string): Record<string, unknown> {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return {};
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it or restore ${path.basename(file)}.bili-bak first; refusing to overwrite`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file}: expected a JSON object at top level, refusing to overwrite`);
    }
    return parsed as Record<string, unknown>;
}

function writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function requireDistFile(file: string): void {
    if (!fs.existsSync(file)) {
        process.stderr.write(`bili plugin: warning: ${file} does not exist yet (run \`npm run build\` in ${selfPackageRoot()}) — the entry will be dead until built\n`);
    }
}

// — pi ————————————————————————————————————————————————————————————————

function piSettingsFile(): string {
    return path.join(resolvePiHome(process.env), "settings.json");
}

// A packages entry is "ours" if it points at THIS install's package root,
// any other billion-context install (npm: form, node_modules path, or a
// dev checkout dir — separators in either style for Windows), or the legacy
// billion-context-pi package (0.1.x shipped as a separate package before the
// plugin moved into billion-context itself). install() replaces every match
// so exactly one bili plugin is live after `bili plugin install pi`.
export function isPiEntry(entry: string, root: string): boolean {
    return entry === root
        || /^npm:billion-context(-pi)?(@|$)/.test(entry)
        || /(^|[/\\])node_modules[/\\]billion-context(-pi)?([\/\\]|$)/.test(entry)
        || /(^|[/\\])billion-context(-pi)?$/.test(entry);
}

// Entries that load THIS package's pi plugin (billion-context proper).
// Legacy `billion-context-pi` entries are deliberately excluded: that is a
// separate older package — usually not installed, and it self-disables under
// BILLION_CONTEXT_PROXY — so treating it as "installed" wrongly suppressed
// the launcher's `-e` fallback and left pi with no plugin at all.
export function isBiliPiEntry(entry: string, root: string): boolean {
    return entry === root
        || /^npm:billion-context(@|$)/.test(entry)
        || /(^|[/\\])node_modules[/\\]billion-context([\/\\]|$)/.test(entry)
        || /(^|[/\\])billion-context$/.test(entry);
}

// #925 pi form of the npm-standard entry: for npm installs (package root
// under node_modules) the settings entry is the pi-managed npm spec, not
// the machine-local abs path — pi auto-installs it at startup (resource
// loader resolve() installs missing npm sources), `pi update` upgrades it,
// and the config survives node prefix moves across machines. A dev/checkout
// install keeps the abs root (pi loads local package dirs directly).
export const PI_NPM_ENTRY = "npm:billion-context";

export function piEntryFor(root: string): string {
    return isNpmInstallForm(root) ? PI_NPM_ENTRY : root;
}

function piInstall(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    const entry = piEntryFor(root);
    if (packages.some((p) => p === entry)) return `pi: already installed (${file})`;
    const removed = packages.filter((p) => isPiEntry(p, root));
    const kept = packages.filter((p) => !isPiEntry(p, root));
    kept.push(entry);
    settings.packages = kept;
    writeJson(file, settings);
    // #788: dropped entries must be visible — silently replacing a documented
    // setup (npm:billion-context-pi) left users with no compression and no
    // idea their config changed. Project-scope reminder mirrors the opencode
    // installer's LOCAL-scope note: a `pi install -l` entry lives in
    // <project>/.pi/settings.json, which this global strip never touches.
    const note = removed.length > 0
        ? `\npi: replaced existing entries: ${removed.join(", ")}`
          + "\npi: also check <project>/.pi/settings.json — a project-scope billion-context-pi entry (pi install -l) lives there, not in this global settings"
        : "";
    const form = entry === PI_NPM_ENTRY ? " (pi-managed — pi installs/updates it; `pi update` upgrades)" : "";
    return `pi: installed -> ${file} packages += ${entry}${form}${note}`;
}

function piRemove(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    const removed = packages.filter((p) => isPiEntry(p, root));
    if (removed.length === 0) return `pi: not installed (${file})`;
    settings.packages = packages.filter((p) => !isPiEntry(p, root));
    writeJson(file, settings);
    // #788: same visibility rule as install — removed entries are reported.
    return `pi: removed from ${file}\npi: removed entries: ${removed.join(", ")}`;
}

function piStatus(): string {
    const root = selfPackageRoot();
    const packages = readJson(piSettingsFile()).packages;
    const list = Array.isArray(packages) ? (packages as unknown[]).map(String) : [];
    // Any entry that loads THIS package's plugin counts (npm: form or abs
    // root); the legacy billion-context-pi package deliberately does not.
    return list.some((p) => isBiliPiEntry(p, root) || p === piEntryFor(root)) ? "installed" : "not installed";
}

// — omp ———————————————————————————————————————————————————————————————

// An extensions entry that loads the bili omp plugin (any install): a path
// ending in dist/agent/omp.js. Shared by install/remove/status and the
// launcher's loader check so all four agree on what "installed" means.
const OMP_ENTRY_RE = /[\\/]dist[\\/]agent[\\/]omp\.js$/;

// Line indices of the `- ` items inside the top-level `extensions:` block.
// The block starts at the column-0 `extensions:` key and ends at the first
// non-blank, non-comment line that is not a list item. Returns [] when there
// is no top-level key or when it appears more than once (ambiguous — refuse
// to guess). Matching is scoped to this block, so a same-valued line under
// any other key is never counted as installed and never removed.
function ompExtensionItemLines(text: string): number[] {
    const lines = text.split("\n");
    let keyIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^extensions:(\s+(#.*)?)?$/.test(lines[i]!)) {
            if (keyIdx !== -1) return [];
            keyIdx = i;
        }
    }
    if (keyIdx === -1) return [];
    const items: number[] = [];
    for (let i = keyIdx + 1; i < lines.length; i++) {
        const t = lines[i]!.trimStart();
        if (t === "" || t.startsWith("#")) continue;
        if (t === "-" || t.startsWith("- ")) items.push(i);
        else break;
    }
    return items;
}

// The config.yml the plugin commands read/write. When PI_CODING_AGENT_DIR
// points at a bili overlay (<home>-bili, created by `bili omp`), redirect to
// the real home: the overlay's config.yml may be a stale copy (a merge
// conflict leaves a .bili-conflict instead of the live file), so editing it
// would silently miss the real config. A note is printed so the user sees
// which file was actually touched.
function ompConfigFile(): string {
    const raw = process.env.PI_CODING_AGENT_DIR?.trim();
    if (raw && raw.length > 0) {
        if (raw.endsWith("-bili") && raw.length > "-bili".length) {
            const realHome = raw.slice(0, -"-bili".length);
            process.stderr.write(
                `bili plugin: PI_CODING_AGENT_DIR points at the bili overlay ${raw} — operating on the real omp home ${realHome} instead\n`,
            );
            return path.join(realHome, "config.yml");
        }
        return path.join(raw, "config.yml");
    }
    return path.join(os.homedir(), ".omp", "agent", "config.yml");
}

function ompExtensionPath(): string {
    return path.join(selfPackageRoot(), "dist", "agent", "omp.js");
}

function ompEntryValue(line: string): string {
    return line.replace(/#.*$/, "").trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "").trim();
}

function ompBlockLoaded(text: string): boolean {
    const lines = text.split("\n");
    return ompExtensionItemLines(text).some((i) => {
        const v = ompEntryValue(lines[i]!);
        return OMP_ENTRY_RE.test(v) && fs.existsSync(v);
    });
}

function ompRemove(): string {
    const file = ompConfigFile();
    if (!fs.existsSync(file)) return `omp: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    const drop = new Set(
        ompExtensionItemLines(text).filter((i) => OMP_ENTRY_RE.test(ompEntryValue(lines[i]!))),
    );
    if (drop.size === 0) return `omp: not installed (${file})`;
    const cleaned = lines.filter((_, i) => !drop.has(i)).join("\n");
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `omp: removed from ${file}`;
}

function ompInstall(): string {
    const file = ompConfigFile();
    const entry = ompExtensionPath();
    requireDistFile(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (ompBlockLoaded(text)) return `omp: already installed (${file})`;
    // Drop any stale copy of OUR exact entry (points at a vanished file) so
    // the insert below leaves exactly one copy instead of a duplicate.
    {
        const lines = text.split("\n");
        const stale = new Set(ompExtensionItemLines(text).filter((i) => ompEntryValue(lines[i]!) === entry));
        if (stale.size > 0) text = lines.filter((_, i) => !stale.has(i)).join("\n");
    }
    const keyCount = (text.match(/^extensions:/gm) ?? []).length;
    if (keyCount > 1) throw new Error(`${file}: multiple \`extensions:\` keys — fix the file first, refusing to edit`);
    if (/^extensions:\s*\S/m.test(text) && !/^extensions:\s*$/m.test(text)) {
        throw new Error(`${file}: \`extensions:\` uses flow style or an inline value; convert it to a block list first, refusing to edit`);
    }
    let out: string;
    const extMatch = /^extensions:\s*$/m.exec(text);
    if (extMatch !== null) {
        const afterKey = text.indexOf("\n", extMatch.index);
        const rest = afterKey < 0 ? "" : text.slice(afterKey + 1);
        const firstNonList = rest.search(/^(?!\s*-\s)\S/m);
        const existingIndent = /^(\s*)-\s\S/m.exec(rest)?.[1] ?? "  ";
        let head: string;
        let tail: string;
        if (firstNonList >= 0) {
            head = text.slice(0, afterKey + 1 + firstNonList);
            tail = text.slice(afterKey + 1 + firstNonList);
        } else {
            head = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
            tail = "";
        }
        out = `${head}${existingIndent}- ${entry}\n${tail}`;
    } else {
        out = text.endsWith("\n") || text.length === 0 ? text : text + "\n";
        out += `extensions:\n  - ${entry}\n`;
    }
    const outLines = out.split("\n");
    const occurrences = ompExtensionItemLines(out).filter((i) => ompEntryValue(outLines[i]!) === entry).length;
    if (occurrences !== 1) {
        throw new Error(`${file}: edit would leave ${occurrences} copies of the entry — aborting without writing`);
    }
    backupOnce(file);
    fs.writeFileSync(file, out);
    return `omp: installed -> ${file} extensions += ${entry}`;
}

function ompStatus(): string {
    const file = ompConfigFile();
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = text.split("\n");
    let broken = false;
    for (const i of ompExtensionItemLines(text)) {
        const v = ompEntryValue(lines[i]!);
        if (!OMP_ENTRY_RE.test(v)) continue;
        if (fs.existsSync(v)) return "installed";
        broken = true;
    }
    return broken ? "broken" : "not installed";
}

/** True when the given omp home's config.yml carries a bili plugin entry
 *  whose target file still exists on disk. The launcher uses this to decide
 *  whether `-e dist/agent/omp.js` is needed (omp does NOT ship the plugin):
 *  a loadable entry means omp already loads it — adding `-e` too would
 *  double-register the same tools/commands. Entries pointing at stale
 *  install paths (file gone) don't count: omp fails to load those, so the
 *  launcher must supply the working plugin itself. */
export function ompPluginLoadedFrom(ompHome: string): boolean {
    try {
        return ompBlockLoaded(fs.readFileSync(path.join(ompHome, "config.yml"), "utf8"));
    } catch {
        return false;
    }
}

// — claude —————————————————————————————————————————————————————————————

const CLAUDE_EXEC_TIMEOUT_MS = 15000;

function claudeMcpJson(): string {
    return homeFile(".claude.json", "CLAUDE_CONFIG_DIR");
}

/** ~/.claude/settings.json honoring CLAUDE_CONFIG_DIR (claude replaces the
 *  whole ~/.claude directory when it is set). The #964 managed block lives
 *  here — env.ANTHROPIC_BASE_URL / env.DISABLE_AUTO_COMPACT /
 *  hooks.SessionStart. */
export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
    const raw = env.CLAUDE_CONFIG_DIR?.trim();
    const base = raw && raw.length > 0 ? raw : path.join(os.homedir(), ".claude");
    return path.join(base, "settings.json");
}

/** True for an ANTHROPIC_BASE_URL value written by a bili managed block:
 *  loopback /bili/-wrapped upstream. Any port matches — an older install's
 *  port differs from the current one, and both are ours to rewrite. */
export function isBiliClaudeBaseUrl(value: unknown): boolean {
    if (typeof value !== "string") return false;
    return /^http:\/\/127\.0\.0\.1:\d{1,5}\/bili\/https?:\/\//.test(value);
}

export function claudeNativeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    const origin = `http://127.0.0.1:${resolveClaudeNativePort(env)}`;
    const relay = env.BILI_CLAUDE_UPSTREAM?.trim();
    const upstream = (relay && relay.length > 0 ? relay : "https://api.anthropic.com").replace(/\/+$/, "");
    const prefix = origin + "/bili/";
    return upstream.startsWith(prefix) ? upstream : prefix + upstream;
}

/** Pure merge of the #964 managed block into parsed settings (install path).
 *  Never clobbers user keys: a foreign ANTHROPIC_BASE_URL or a non-"1"
 *  DISABLE_AUTO_COMPACT is reported and skipped, not overwritten. Returns the
 *  mutated copy plus human notes. Exported for tests. */
export function applyClaudeManagedBlock(settings: Record<string, unknown>, opts: { baseUrl: string; hookCommand: string }): { data: Record<string, unknown>; notes: string[] } {
    const data = structuredClone(settings);
    const notes: string[] = [];
    const env = (data.env !== null && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : {}) as Record<string, unknown>;
    const cur = env.ANTHROPIC_BASE_URL;
    if (cur === undefined || cur === null || isBiliClaudeBaseUrl(cur)) {
        if (cur !== opts.baseUrl) {
            env.ANTHROPIC_BASE_URL = opts.baseUrl;
            notes.push("env.ANTHROPIC_BASE_URL pinned to the bili proxy");
        }
    } else {
        notes.push(`env.ANTHROPIC_BASE_URL left untouched (foreign value ${JSON.stringify(cur)} — unset it or set BILI_CLAUDE_UPSTREAM, then reinstall)`);
    }
    const dac = env.DISABLE_AUTO_COMPACT;
    if (dac === undefined || dac === null || dac === "1") {
        if (dac !== "1") {
            env.DISABLE_AUTO_COMPACT = "1";
            notes.push("env.DISABLE_AUTO_COMPACT=1 (bili owns compression; manual /compact survives)");
        }
    } else {
        notes.push(`env.DISABLE_AUTO_COMPACT left untouched (foreign value ${JSON.stringify(dac)})`);
    }
    if (Object.keys(env).length > 0) data.env = env;

    const hooks = (data.hooks !== null && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, unknown>;
    const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const carriesOurs = sessionStart.some(isOursSessionStartEntry);
    if (!carriesOurs) {
        sessionStart.push({ hooks: [{ type: "command", command: opts.hookCommand }] });
        hooks.SessionStart = sessionStart;
        data.hooks = hooks;
        notes.push("hooks.SessionStart += bili proxy bootstrap");
    }
    return { data, notes };
}

/** A SessionStart entry we wrote: any hook command naming our bootstrap
 *  script (path may differ across installs/upgrades). */
export function isOursSessionStartEntry(entry: unknown): boolean {
    const hooks = (entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as { hooks?: unknown }).hooks : undefined);
    if (!Array.isArray(hooks)) return false;
    return hooks.some(
        (h) => h !== null && typeof h === "object" && typeof (h as { command?: unknown }).command === "string" && /claude-native-bootstrap\.(?:js|mjs|ts)["']?$/.test((h as { command: string }).command),
    );
}

/** Pure strip of the managed block (remove path) — returns the cleaned copy
 *  and what was removed. DISABLE_AUTO_COMPACT is dropped only when it is the
 *  value we wrote ("1"); a .bili-bak with a pre-install value restores it in
 *  the caller. Exported for tests. */
export function stripClaudeManagedBlock(settings: Record<string, unknown>): { data: Record<string, unknown>; removed: string[] } {
    const data = structuredClone(settings);
    const removed: string[] = [];
    const env = (data.env !== null && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : undefined) as Record<string, unknown> | undefined;
    if (env !== undefined) {
        if (isBiliClaudeBaseUrl(env.ANTHROPIC_BASE_URL)) {
            delete env.ANTHROPIC_BASE_URL;
            removed.push("env.ANTHROPIC_BASE_URL");
        }
        if (env.DISABLE_AUTO_COMPACT === "1") {
            delete env.DISABLE_AUTO_COMPACT;
            removed.push("env.DISABLE_AUTO_COMPACT");
        }
        if (Object.keys(env).length === 0) delete data.env;
    }
    const hooks = (data.hooks !== null && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : undefined) as Record<string, unknown> | undefined;
    if (hooks !== undefined && Array.isArray(hooks.SessionStart)) {
        const kept = (hooks.SessionStart as unknown[]).filter((e) => !isOursSessionStartEntry(e));
        if (kept.length !== (hooks.SessionStart as unknown[]).length) {
            removed.push("hooks.SessionStart entry");
            if (kept.length > 0) hooks.SessionStart = kept;
            else delete hooks.SessionStart;
            if (Object.keys(hooks).length === 0) delete data.hooks;
        }
    }
    return { data, removed };
}

/** True when the managed settings block (the static ANTHROPIC_BASE_URL) is
 *  present — the `bili claude` launcher consults this to override the static
 *  URL with its own ephemeral proxy (coexistence, #964 item 5). */
export function claudeNativeInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        const data = readJson(claudeSettingsFile(env));
        return isBiliClaudeBaseUrl((data.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL);
    } catch {
        return false;
    }
}

// Windows: npm global shims are .cmd/.bat — direct spawn is EINVAL, so
// route through the shell with per-token quoting (same handling as
// detectOpencodeMajor below). % is doubled because cmd.exe still expands
// env vars inside quoted tokens.
function runClaudeCli(claude: string, args: string[]): void {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(claude)) {
        const q = (s: string) => `"${s.replaceAll("%", "%%")}"`;
        execFileSync([claude, ...args].map(q).join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
    } else {
        execFileSync(claude, args, { stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
    }
}

// CLAUDE overrides the claude binary path (absolute path for sandboxed
// setups; a guaranteed-missing file in tests so the failure path stays
// deterministic even on machines that have the real CLI).
/** Resolve a bare CLI name to its real path on Windows — Node's spawn
 *  never consults PATHEXT, so a bare `claude` (→ claude.cmd / claude.exe)
 *  would ENOENT before runClaudeCli ever sees the .cmd. Uses where.exe; on
 *  failure or non-Windows the input is returned untouched (the original
 *  ENOENT error stays truthful). */
export function resolveClaudeCli(claude: string): string {
    if (process.platform !== "win32" || /[\\/]/.test(claude) || /\.[a-z]+$/i.test(claude)) return claude;
    try {
        const r = spawnSync("where.exe", [claude], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" });
        const first = (r.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
        return first && first.length > 0 ? first : claude;
    } catch {
        return claude;
    }
}

function claudeInstall(): string {
    if (process.env.BILI_NATIVE_CLAUDE === "0") {
        throw new Error("claude: install refused — BILI_NATIVE_CLAUDE=0 is set (clear it to install the native posture)");
    }
    const root = selfPackageRoot();
    const mcpJs = path.join(root, "dist", "mcp.js");
    const bootstrapJs = path.join(root, "dist", "claude-native-bootstrap.js");
    requireDistFile(mcpJs);
    requireDistFile(bootstrapJs);

    // Managed block first: the static URL + bootstrap hook + compaction off.
    // #964: persist the resolved port into the bili config too — the
    // SessionStart hook does NOT inherit claude's settings.env, so without a
    // persisted copy an env-driven port (BILI_CLAUDE_NATIVE_PORT=48790)
    // would live only in settings.json while the hook resolves the default
    // and brings the proxy up on the WRONG port.
    const nativePort = resolveClaudeNativePort();
    saveClaudeNativePort(nativePort);
    const file = claudeSettingsFile();
    const settings = readJson(file);
    const { data, notes } = applyClaudeManagedBlock(settings, {
        baseUrl: claudeNativeBaseUrl(),
        hookCommand: `${process.execPath} ${JSON.stringify(bootstrapJs)}`,
    });
    writeJson(file, data);

    // MCP face: same registration path as before, but pinned to the STABLE
    // port the hook brings up — never proxyOriginForInstall() (an ephemeral
    // launcher proxy would go stale in this static config).
    const stableOrigin = `http://127.0.0.1:${nativePort}`;
    const claude = resolveClaudeCli(process.env.CLAUDE?.trim() || "claude");
    try {
        runClaudeCli(claude, ["mcp", "add", "bili", "--scope", "user", "-e", `BILI_MCP_PROXY=${stableOrigin}`, "--", process.execPath, mcpJs]);
    } catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer | string }).stderr ?? "") : "";
        throw new Error(`claude: MCP registration failed (${stderr.trim() || (err instanceof Error ? err.message : String(err))}) — is the claude CLI on PATH? (the managed settings block at ${file} was written; rerun after fixing the CLI to complete the MCP face)`);
    }
    return `claude: managed block -> ${file} (${notes.join("; ")}); MCP face -> ${claudeMcpJson()} (pinned ${stableOrigin}) — restart claude to activate`;
}

function claudeRemove(): string {
    const parts: string[] = [];
    clearClaudeNativePort();
    const file = claudeSettingsFile();
    const settings = readJson(file);
    const { data, removed } = stripClaudeManagedBlock(settings);
    if (removed.length > 0) {
        // Restore a pre-install DISABLE_AUTO_COMPACT when the backup holds
        // one (writeJson snapshotted the pristine file on first install).
        const bak = `${file}.bili-bak`;
        try {
            if (fs.existsSync(bak)) {
                const bakData = readJson(bak) as { env?: Record<string, unknown> };
                const bakDac = bakData.env?.DISABLE_AUTO_COMPACT;
                if (removed.includes("env.DISABLE_AUTO_COMPACT") && bakDac !== undefined) {
                    const env = ((data.env !== null && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : {}) as Record<string, unknown>);
                    env.DISABLE_AUTO_COMPACT = bakDac;
                    data.env = env;
                }
            }
        } catch {
            // unreadable backup — the value is simply dropped
        }
        writeJson(file, data);
        parts.push(`managed block removed from ${file} (${removed.join(", ")})`);
    }
    if (claudeMcpInstalled()) {
        const claude = resolveClaudeCli(process.env.CLAUDE?.trim() || "claude");
        try {
            runClaudeCli(claude, ["mcp", "remove", "bili", "--scope", "user"]);
            parts.push("MCP face removed");
        } catch (err) {
            throw new Error(`claude: MCP removal failed (${err instanceof Error ? err.message : String(err)})${parts.length > 0 ? ` — ${parts.join("; ")} succeeded first` : ""}`);
        }
    }
    return parts.length > 0 ? `claude: ${parts.join("; ")}` : `claude: not installed (${file} / ${claudeMcpJson()})`;
}

function claudeMcpInstalled(): boolean {
    const data = readJson(claudeMcpJson()) as { mcpServers?: Record<string, unknown> };
    return isPlainMcpObject(data.mcpServers) && "bili" in data.mcpServers;
}

function claudeStatus(): string {
    let block = false;
    try {
        const data = readJson(claudeSettingsFile());
        block = isBiliClaudeBaseUrl((data.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL);
    } catch {
        block = false;
    }
    const mcp = (() => {
        try {
            return claudeMcpInstalled();
        } catch {
            return false;
        }
    })();
    if (block && mcp) return "installed (managed settings block + MCP)";
    if (block) return "installed (managed settings block; MCP face missing — rerun install)";
    if (mcp) return "installed (MCP only — legacy companion posture; rerun install for the native block)";
    return "not installed";
}

// — codex ——————————————————————————————————————————————————————————————

function codexToml(): string {
    const raw = process.env.CODEX_HOME?.trim();
    if (raw && raw.length > 0) return path.join(raw, "config.toml");
    return homeFile(".codex/config.toml");
}

function codexBlock(): string {
    return `\n[mcp_servers.bili]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(selfPackageRoot(), "dist", "mcp.js"))}]\nenv = { BILI_MCP_PROXY = ${JSON.stringify(proxyOriginForInstall())} }\n`;
}

function malformedCodexArgs(block: string): boolean {
    return /^[ \t]*args[ \t]*=[ \t]*["']/m.test(block);
}

function codexInstall(): string {
    const file = codexToml();
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const existing = /^[ \t]*\[mcp_servers\.bili\][ \t]*$/m.exec(text);
    if (existing !== null) {
        const block = text.slice(existing.index, text.indexOf("\n[", existing.index + 1) === -1 ? undefined : text.indexOf("\n[", existing.index + 1));
        const canonical = codexBlock().replace(/^\n/, "");
        if (block.trimEnd() === canonical.trimEnd()) return `codex: already installed (${file})`;
        const refreshed = text.slice(0, existing.index) + canonical + text.slice(existing.index + block.length);
        backupOnce(file);
        fs.writeFileSync(file, refreshed);
        const healed = malformedCodexArgs(block) ? " (repaired args: was not an array)" : "";
        return `codex: refreshed [mcp_servers.bili] -> ${file}${healed}`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, text + (text.endsWith("\n") || text.length === 0 ? "" : "\n") + codexBlock());
    return `codex: installed -> ${file} [mcp_servers.bili]`;
}

function codexRemove(): string {
    const file = codexToml();
    if (!fs.existsSync(file)) return `codex: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const start = (() => {
        const m = /^[ \t]*\[mcp_servers\.bili\][ \t]*$/m.exec(text);
        return m === null ? -1 : m.index;
    })();
    if (start < 0) return `codex: not installed (${file})`;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const after = text.slice(start);
    const firstNewline = after.indexOf("\n");
    const nextTable = firstNewline < 0 ? -1 : after.slice(firstNewline + 1).search(/^[ \t]*\[/m);
    const end = nextTable >= 0 ? start + firstNewline + 1 + nextTable : text.length;
    const cleaned = (text.slice(0, lineStart).replace(/\n+$/, "\n") + text.slice(end)).replace(/^\n+/, "");
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `codex: removed from ${file}`;
}

function codexStatus(): string {
    const text = fs.existsSync(codexToml()) ? fs.readFileSync(codexToml(), "utf8") : "";
    return /^\[mcp_servers\.bili\]\s*$/m.test(text) ? "installed" : "not installed";
}

// — opencode ————————————————————————————————————————————————————————————

// #927: OpenCode reads BOTH `plugin` (1.x canonical) and `plugins` (2.x
// canonical): 2.x merges the two arrays, while 1.x hard-errors on `plugins`
// (ConfigInvalidError: unrecognized_keys). Dual-writing is off the table —
// pick ONE effective key by host major version. A failed version probe falls
// back to major 1, whose key (`plugin`) 2.x still honors as a legacy alias,
// so degradation can never write a dead config line.
export function pickPluginKey(major: number): "plugin" | "plugins" {
    return major >= 2 ? "plugins" : "plugin";
}

const PLUGIN_KEYS = ["plugin", "plugins"] as const;

const ocMajorCache = new Map<string, number>();

/** Host major version via `<command> --version` (probe failure → 1). Same
 *  contract as the launcher's probe; honors the BILI_CLIENT_BIN override. */
export function detectOpencodeMajor(): number {
    const command = process.env.BILI_CLIENT_BIN?.trim() || "opencode";
    const hit = ocMajorCache.get(command);
    if (hit !== undefined) return hit;
    let major = 1;
    try {
        // Windows: npm global shims are .cmd/.bat — execFileSync cannot spawn
        // those directly (EINVAL), so route through the shell with explicit
        // quoting. Plain exes and POSIX shebang scripts go straight through.
        const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
        const out = viaShell
            ? execFileSync(`"${command}" --version`, { shell: true, timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
            : execFileSync(command, ["--version"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const m = /(\d+)\s*\./.exec(out);
        if (m) major = parseInt(m[1], 10);
    } catch {}
    ocMajorCache.set(command, major);
    return major;
}

function pluginEntries(data: Record<string, unknown>, key: string): string[] {
    const v = data[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (v !== null && typeof v === "object") return Object.keys(v as Record<string, unknown>);
    return [];
}

// #927: write target = explicit OPENCODE_CONFIG override, else the
// highest-precedence file ALREADY PRESENT in the config dir (opencode merges
// config.json -> opencode.json -> opencode.jsonc, later wins), else create
// opencode.json. Never spawn a second file next to an existing config — that
// splits one logical config across files (#927).
export function opencodeTargetFile(): string {
    const raw = process.env.OPENCODE_CONFIG?.trim();
    if (raw && raw.length > 0) return raw;
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const dir = xdg && xdg.length > 0 ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
    for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    return path.join(dir, "opencode.json");
}

// #820 native mode: OpenCode 2.x rejects bare FILE paths in `plugin` — the
// entry must be a DIRECTORY whose index.js is the entrypoint (#754 probe). The
// wrapper directory lives next to the config so it survives config moves.
function opencodePluginDir(configFile: string): string {
    return path.join(path.dirname(configFile), "plugins", "billion-context");
}

// #809/N4: opencode.json may carry a non-object `mcp` (e.g. a bare string);
// `"bili" in <non-object>` throws TypeError. Guard so install/remove/status
// degrade gracefully instead of crashing (a crashing remove leaves no cleanup).
function isPlainMcpObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readOriginalText(file: string): string {
    try {
        return fs.readFileSync(file, "utf8");
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return "";
        throw err;
    }
}

// JSONC-tolerant parse: the target may be an opencode.jsonc carrying comments
// (and trailing commas) — strict JSON.parse would refuse it outright, and a
// stringify round-trip would wash the comments away on write-back. Tolerance
// is bounded: ANY diagnostic beyond comments/trailing commas means the file
// is broken, and a broken config is never overwritten (§7.3).
function parseOpencodeConfig(text: string, file: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const parsed = jsoncParse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parsed === undefined) {
        const first = errors[0];
        const detail = first ? ` (offset ${first.offset})` : "";
        throw new Error(`${file}: not valid JSON${detail} — fix it or restore ${path.basename(file)}.bili-bak first; refusing to overwrite`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file}: expected a JSON object at top level, refusing to overwrite`);
    }
    return parsed as Record<string, unknown>;
}

function loadOpencodeConfig(file: string): { original: string; data: Record<string, unknown> } {
    const original = readOriginalText(file);
    return { original, data: original === "" ? {} : parseOpencodeConfig(original, file) };
}

// Write back preserving everything bili did not touch: a missing or plain-JSON
// target is serialized whole (the historical behavior); a JSONC target gets
// surgical top-level-key edits so comments and formatting elsewhere survive
// byte-for-byte (#927). A no-op run (nothing touched) leaves the file alone.
function writeOpencodeConfig(file: string, original: string, data: Record<string, unknown>, touched: ReadonlySet<string>): void {
    if (touched.size === 0) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    if (original === "") {
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
        return;
    }
    let strict = false;
    try {
        JSON.parse(original);
        strict = true;
    } catch {}
    if (strict) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
        return;
    }
    let text = original;
    for (const key of touched) {
        text = applyEdits(text, jsoncModify(text, [key], data[key], { formattingOptions: { tabSize: 2, insertSpaces: true } }));
    }
    fs.writeFileSync(file, text);
}

// Legacy opencode-acp plugin entries — both config shapes v1 accepts:
//   array:  "opencode-acp" | "npm:opencode-acp" | "<path>/opencode-acp[/index.js]" | "opencode-acp@<ver>"
//   object: { "opencode-acp": "stable", ... }
// The in-process extension and the native plugin are two compression owners —
// keeping both armed means double compression / ref-space fights (#918).
// #927: strip from BOTH key spellings — a 2.x host may carry acp entries under
// `plugins`, an older v1 install under `plugin`.
function isLegacyOpencodeAcpEntry(entry: string): boolean {
    if (entry === "opencode-acp" || entry.startsWith("opencode-acp@")) return true;
    if (entry.startsWith("npm:")) {
        const rest = entry.slice(4);
        return rest === "opencode-acp" || rest.startsWith("opencode-acp@");
    }
    const normalized = entry.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((s) => s.length > 0);
    // Any path segment naming the package identifies an acp install — covers
    // dir specs, <dir>/index.js, and deeper entry paths like dist/index.js.
    return segments.some((s) => s === "opencode-acp" || s.startsWith("opencode-acp@"));
}

function stripLegacyOpencodeAcp(data: Record<string, unknown>, notes: string[], touched: Set<string>): void {
    const removed: string[] = [];
    for (const key of PLUGIN_KEYS) {
        const v = data[key];
        let dropped = 0;
        if (Array.isArray(v)) {
            const survivors: unknown[] = [];
            for (const entry of v) {
                if (typeof entry === "string" && isLegacyOpencodeAcpEntry(entry)) {
                    removed.push(entry);
                    dropped++;
                    continue;
                }
                survivors.push(entry);
            }
            if (dropped > 0) {
                if (survivors.length === 0) delete data[key];
                else data[key] = survivors;
                touched.add(key);
            }
        } else if (v !== null && typeof v === "object") {
            const map = v as Record<string, unknown>;
            for (const k of Object.keys(map)) {
                if (isLegacyOpencodeAcpEntry(k)) {
                    delete map[k];
                    removed.push(k);
                    dropped++;
                }
            }
            if (dropped > 0) {
                if (Object.keys(map).length === 0) delete data[key];
                touched.add(key);
            }
        }
    }
    if (removed.length > 0) {
        notes.push(`replaced opencode-acp plugin entries (${removed.join(", ")}) — single compression owner; restore from the .bili-bak backup if that was intended`);
        notes.push("also check <project>/.opencode/opencode.json — a LOCAL-scope opencode-acp install (opencode plugin opencode-acp) lives there, not in this global config");
    }
}

// #925: how THIS bili was installed decides which plugin entry install can
// publish. An npm-form install (package root under node_modules — npm/pnpm/
// yarn, both path-separator styles) ships its entry through package.json
// exports["./server"], so opencode loads the bare package name via its own
// Npm.add machinery (host-managed install + upgrade, portable config). Any
// other form (git checkout / dev build) has no published entry — local shim dir.
export function isNpmInstallForm(root: string): boolean {
    return /(^|[/\\])node_modules[/\\]/.test(root);
}

export const OPENCODE_NPM_ENTRY = "billion-context";

const DEV_FORM_NOTE = "dev form: machine-local shim, not portable across machines — an npm install writes the bare package name instead";

// #925: pick + apply the plugin entry for this install form. Replaces any
// existing entry of either form (single owner), returns note(s). #927: the
// entry lands in the host's effective key (`plugin` on OpenCode 1.x,
// `plugins` on 2.x) — pass `key`; default keeps the v1 spelling for callers
// and tests that predate the probe.
export function applyOpencodePluginEntry(args: { data: Record<string, unknown>; root: string; shimDir: string; agentJs: string; key?: "plugin" | "plugins"; touched?: Set<string> }): string[] {
    const { data, root, shimDir, agentJs } = args;
    const key = args.key ?? "plugin";
    const touched = args.touched ?? new Set<string>();
    const ours = [OPENCODE_NPM_ENTRY, shimDir];
    const plugins = pluginEntries(data, key);
    const replaced = plugins.filter((p) => ours.includes(p));
    const kept = plugins.filter((p) => !ours.includes(p));
    const write = (v: string[]): void => {
        data[key] = v;
        touched.add(key);
    };
    if (isNpmInstallForm(root)) {
        write([...kept, OPENCODE_NPM_ENTRY]);
        if (replaced.includes(shimDir)) fs.rmSync(shimDir, { recursive: true, force: true });
        if (replaced.length === 0) return [`plugin -> ${OPENCODE_NPM_ENTRY}`];
        if (replaced.every((p) => p === OPENCODE_NPM_ENTRY)) return ["plugin present"];
        return [`plugin -> ${OPENCODE_NPM_ENTRY} (replaced ${replaced.join(", ")})`];
    }
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "index.js"), `export { default } from ${JSON.stringify(agentJs)};\n`);
    write([...kept, shimDir]);
    if (replaced.length === 0) return [`plugin -> ${shimDir}`, DEV_FORM_NOTE];
    if (replaced.every((p) => p === shimDir)) return ["plugin present"];
    return [`plugin -> ${shimDir} (replaced ${replaced.join(", ")})`, DEV_FORM_NOTE];
}

function opencodeInstall(withMcp = false): string {
    const file = opencodeTargetFile();
    const { original, data } = loadOpencodeConfig(file);
    const notes: string[] = [];
    const touched = new Set<string>();

    // #926: the native plugin below registers the bili tools itself (auto
    // session-bound), so opencode gets NO mcp.bili by default — a frozen
    // BILI_MCP_PROXY there goes stale the moment the plugin's
    // ephemeral-port proxy restarts. Default heals any entry an older
    // install froze in. --with-mcp opts in; the entry then carries no origin
    // pin (dist/mcp.js discovers the live proxy via the instance file at
    // call time) unless BILI_MCP_PROXY is set for this install.
    if (!withMcp) {
        const rawMcp = data.mcp;
        if (isPlainMcpObject(rawMcp) && "bili" in rawMcp) {
            delete rawMcp.bili;
            if (Object.keys(rawMcp).length === 0) delete data.mcp;
            touched.add("mcp");
            notes.push("mcp.bili removed (stale second tool face — the native plugin provides the bili tools; install with --with-mcp to keep an MCP face)");
        } else {
            notes.push("mcp.bili not written (the native plugin provides the bili tools; --with-mcp adds an MCP face)");
        }
    } else {
        try {
            const mcpJs = path.join(selfPackageRoot(), "dist", "mcp.js");
            requireDistFile(mcpJs);
            const rawMcp = data.mcp;
            if (rawMcp != null && !isPlainMcpObject(rawMcp)) {
                notes.push('mcp.bili skipped ("mcp" is not an object)');
            } else {
                const mcp = (rawMcp as Record<string, unknown> | undefined) ?? {};
                const explicit = process.env.BILI_MCP_PROXY?.trim();
                const bili = mcp.bili;
                if (bili !== null && typeof bili === "object" && !Array.isArray(bili)) {
                    const env = (bili as Record<string, unknown>).environment;
                    const envObj = env !== null && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : undefined;
                    if (envObj?.BILI_MCP_PROXY !== undefined && explicit === undefined) {
                        delete envObj.BILI_MCP_PROXY;
                        if (Object.keys(envObj).length === 0) delete (bili as Record<string, unknown>).environment;
                        touched.add("mcp");
                        notes.push("mcp.bili present (stale BILI_MCP_PROXY pin removed — live discovery takes over)");
                    } else {
                        notes.push("mcp.bili present");
                    }
                } else {
                    const entry: Record<string, unknown> = { type: "local", command: [process.execPath, mcpJs], enabled: true };
                    if (explicit !== undefined) entry.environment = { BILI_MCP_PROXY: explicit };
                    mcp.bili = entry;
                    data.mcp = mcp;
                    touched.add("mcp");
                    notes.push(explicit !== undefined ? `mcp.bili written (BILI_MCP_PROXY=${explicit})` : "mcp.bili written (no origin pin — live discovery via instance file)");
                }
            }
        } catch (err) {
            notes.push(`mcp.bili skipped (${err instanceof Error ? err.message : String(err)})`);
        }
    }

    // Native plugin (#820/#925): self-spawned proxy + http.request URL rewrite.
    // Entry form depends on how THIS bili was installed — npm → bare package
    // name (exports["./server"], host-managed), checkout/dev → local shim dir.
    const root = selfPackageRoot();
    const agentJs = path.join(root, "dist", "agent", "opencode-native.js");
    requireDistFile(agentJs);
    // Single compression owner FIRST: drop any opencode-acp entry before
    // adding ours, so both never load armed in one host (#918). The write
    // below snapshots the original config to .bili-bak (first write only).
    stripLegacyOpencodeAcp(data, notes, touched);
    // #927 entry key for this host + #925 entry form for this install form.
    notes.push(...applyOpencodePluginEntry({ data, root, shimDir: opencodePluginDir(file), agentJs, key: pickPluginKey(detectOpencodeMajor()), touched }));

    // Single compression owner: with the native plugin installed, ACP owns
    // compression — disable host auto-compaction (merge-preserving; the key is
    // ignored on OpenCode 1.x). Restored from the pre-install backup on
    // remove. #927: skip when the target already says auto:false — the user
    // wrote it themselves, so one file carries the fact exactly once.
    const curCompaction = data.compaction;
    const curObj = curCompaction !== null && typeof curCompaction === "object" && !Array.isArray(curCompaction) ? curCompaction as Record<string, unknown> : undefined;
    if (curObj?.auto === false) {
        notes.push("compaction.auto already disabled");
    } else {
        data.compaction = { ...(curObj ?? {}), auto: false };
        touched.add("compaction");
        notes.push("compaction.auto set to false");
    }

    writeOpencodeConfig(file, original, data, touched);
    return `opencode: installed -> ${file} (${notes.join("; ")})`;
}

function opencodeRemove(): string {
    const file = opencodeTargetFile();
    const { original, data } = loadOpencodeConfig(file);
    const notes: string[] = [];
    const touched = new Set<string>();

    const mcp = data.mcp;
    if (isPlainMcpObject(mcp) && "bili" in mcp) {
        delete mcp.bili;
        if (Object.keys(mcp).length === 0) delete data.mcp;
        touched.add("mcp");
        notes.push("mcp.bili removed");
    }

    // #927: clean our entry out of whichever key spelling carries it; the
    // entry may be either form (#925) — bare npm name or shim dir.
    const dir = opencodePluginDir(file);
    const removed: string[] = [];
    for (const key of PLUGIN_KEYS) {
        const entries = pluginEntries(data, key);
        const hit = entries.filter((p) => p === OPENCODE_NPM_ENTRY || p === dir);
        if (hit.length === 0) continue;
        const remaining = entries.filter((p) => p !== OPENCODE_NPM_ENTRY && p !== dir);
        if (remaining.length === 0) delete data[key];
        else data[key] = remaining;
        touched.add(key);
        removed.push(...hit);
    }
    if (removed.length > 0) {
        if (removed.includes(dir)) fs.rmSync(dir, { recursive: true, force: true });
        notes.push(`plugin removed (${removed.join(", ")})`);
    }

    if (notes.length > 0) {
        const cur = data.compaction as Record<string, unknown> | undefined;
        if (cur && cur.auto === false) {
            const bak = `${file}.bili-bak`;
            if (fs.existsSync(bak)) {
                try {
                    const bakData = loadOpencodeConfig(bak).data;
                    if (bakData.compaction === undefined) delete data.compaction;
                    else data.compaction = bakData.compaction;
                    touched.add("compaction");
                    notes.push("compaction restored from backup");
                } catch {
                    // unreadable backup — leave current settings untouched
                }
            } else if (Object.keys(cur).length === 1) {
                // no pre-install config existed, so our {auto:false} is the entire
                // key — dropping it restores the pre-install state exactly; with
                // extra keys present we can't tell user edits apart, so leave them
                delete data.compaction;
                touched.add("compaction");
                notes.push("compaction removed (no prior config)");
            }
        }
    }

    writeOpencodeConfig(file, original, data, touched);
    return notes.length > 0 ? `opencode: removed from ${file} (${notes.join("; ")})` : `opencode: not installed (${file})`;
}

function opencodeStatus(): string {
    const file = opencodeTargetFile();
    const { data } = loadOpencodeConfig(file);
    const mcp = data.mcp;
    const dir = opencodePluginDir(file);
    const listed = PLUGIN_KEYS.some((k) => pluginEntries(data, k).some((p) => p === OPENCODE_NPM_ENTRY || p === dir));
    return (isPlainMcpObject(mcp) && "bili" in mcp) || listed ? "installed" : "not installed";
}

// — dsh ————————————————————————————————————————————————————————————————

const DSH_PATCH_BEGIN = "# bili begin (managed by billion-context — `bili plugin install dsh`)";
const DSH_PATCH_END = "# bili end";

const DSH_PATCH_HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

/** Every profile's user-layer cordis.patch.yml under $DSH_HOME/profiles/*.
 *  dsh creates a profile dir per `--profile` on first boot; a missing
 *  profiles root means dsh has never run. Returns the dirs that exist (the
 *  patch file itself may still be absent — dsh materializes it lazily). */
export function dshProfileDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const profiles = path.join(resolveDshHome(env), "profiles");
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(profiles, { withFileTypes: true });
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
            throw new Error(`no dsh profiles found under ${profiles} — run dsh once (any profile) so the profile dirs exist, then retry`);
        }
        throw err;
    }
    return entries.filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => path.join(profiles, e.name));
}

/** The managed block text appended to every profile's cordis.patch.yml:
 *  the native plugin insert (id bili-native, file:// URL to this install's
 *  dist/agent/dsh-native.js) plus the compaction-basic auto:false override —
 *  dsh's native auto-compaction stands down because the bili proxy owns
 *  compression. A patch replaces the target row's whole `config`, and
 *  dsh-base ships compaction-basic with no config, so {auto:false} is
 *  complete. */
export function dshManagedPatchBlock(root: string): string {
    const pluginUrl = pathToFileURL(path.join(root, "dist", "agent", "dsh-native.js")).href;
    return `${DSH_PATCH_BEGIN}\n- insert:\n    - id: bili-native\n      name: ${pluginUrl}\n- id: compaction-basic\n  config:\n    auto: false\n${DSH_PATCH_END}\n`;
}

/** Text-level managed-block strip: everything from the begin marker through
 *  the end marker (inclusive). Text-level (not YAML-parse-level) on purpose —
 *  the file is user-authored and must keep every comment and entry we did
 *  not write. */
export function stripDshManagedPatch(text: string): string {
    const begin = text.indexOf(DSH_PATCH_BEGIN);
    if (begin < 0) return text;
    const endMarker = text.indexOf(DSH_PATCH_END, begin);
    if (endMarker < 0) return text.slice(0, begin);
    let after = endMarker + DSH_PATCH_END.length;
    if (text[after] === "\n") after += 1;
    return text.slice(0, begin) + text.slice(after);
}

/** Merge the managed block into one profile's patch text: strip any previous
 *  block, drop a placeholder `[]` root (appending list items after `[]`
 *  would be invalid YAML), re-append the current block. Comment header and
 *  user entries survive untouched. */
export function mergeDshManagedPatch(text: string, block: string): string {
    let base = stripDshManagedPatch(text).replace(/\n+$/, "\n");
    const meaningful = base.split("\n").filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"));
    if (meaningful.length === 0 || (meaningful.length === 1 && meaningful[0].trim() === "[]")) {
        // empty / comment-only / placeholder root — comments only survive
        base = base.split("\n").filter((l) => l.trimStart().startsWith("#")).join("\n");
        base = base.length > 0 ? `${base.replace(/\n+$/, "")}\n` : DSH_PATCH_HEADER;
    }
    return base + block;
}

/** Restore the pristine comment-header + `[]` shape after removal when the
 *  remainder carries no real entries (a comment-only file parses as null,
 *  and an empty file surprises nobody — but dsh's own first-boot materializes
 *  exactly this shape, so match it). */
function restoreDshPatchPlaceholder(text: string): string {
    const meaningful = text.split("\n").filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"));
    if (meaningful.length > 0) return text.replace(/\n+$/, "\n");
    const comments = text.split("\n").filter((l) => l.trimStart().startsWith("#")).join("\n");
    const header = comments.length > 0 ? `${comments}\n` : DSH_PATCH_HEADER;
    return `${header}[]\n`;
}

/** True when this profile installs billion-context as a dsh bundle
 *  (`dsh plugin --profile <name> add billion-context` — the package lands in
 *  the profile's node_modules and its manifest-declared patch mounts as a
 *  bundle layer). Such a profile must NOT also receive the managed block:
 *  cordis rejects duplicate loader entry ids across layers, so a second
 *  `id: bili-native` insert would hard-fail dsh boot. */
export function dshBundleInstalled(profileDir: string): boolean {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8")) as { dsh?: { profile?: { bundles?: unknown } } };
        const bundles = manifest.dsh?.profile?.bundles;
        return Array.isArray(bundles) && bundles.includes("billion-context");
    } catch {
        return false;
    }
}

function dshInstall(): string {
    const root = selfPackageRoot();
    requireDistFile(path.join(root, "dist", "agent", "dsh-native.js"));
    const block = dshManagedPatchBlock(root);
    const notes: string[] = [];
    let touched = 0;
    for (const dir of dshProfileDirs()) {
        if (dshBundleInstalled(dir)) {
            notes.push(`${path.basename(dir)}: skipped (installed as a dsh bundle — remove it with \'dsh plugin --profile ${path.basename(dir)} remove billion-context\' instead)`);
            continue;
        }
        const file = path.join(dir, "cordis.patch.yml");
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            text = DSH_PATCH_HEADER;
        }
        fs.writeFileSync(file, mergeDshManagedPatch(text, block));
        touched += 1;
    }
    if (fs.existsSync(resolveDshHome(process.env)) && touched === 0 && notes.length === 0) notes.push("no profile directories found");
    return `wrote bili-native plugin + compaction off into ${touched} dsh profile(s) under ${path.join(resolveDshHome(process.env), "profiles")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""} — restart dsh to load it`;
}

function dshRemove(): string {
    const notes: string[] = [];
    let touched = 0;
    for (const dir of dshProfileDirs()) {
        if (dshBundleInstalled(dir)) {
            notes.push(`${path.basename(dir)}: installed as a dsh bundle — remove it with \'dsh plugin --profile ${path.basename(dir)} remove billion-context\' instead`);
            continue;
        }
        const file = path.join(dir, "cordis.patch.yml");
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        if (!text.includes(DSH_PATCH_BEGIN)) continue;
        fs.writeFileSync(file, restoreDshPatchPlaceholder(stripDshManagedPatch(text)));
        touched += 1;
    }
    return `removed the bili patch from ${touched} dsh profile(s)${notes.length > 0 ? ` (${notes.join("; ")})` : ""} — restart dsh to finish`;
}

function dshStatus(): string {
    const dirs = dshProfileDirs();
    const bundle = dirs.filter((dir) => dshBundleInstalled(dir));
    const withBlock = dirs.filter((dir) => {
        try {
            return fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8").includes(DSH_PATCH_BEGIN);
        } catch {
            return false;
        }
    });
    if (bundle.length === dirs.length && dirs.length > 0) return `installed (dsh bundle in all ${dirs.length} profiles — remove with 'dsh plugin --profile <name> remove billion-context')`;
    if (bundle.length > 0) return `installed as a dsh bundle in ${bundle.length}/${dirs.length} profiles`;
    if (withBlock.length === dirs.length && dirs.length > 0) return "installed";
    if (withBlock.length > 0) return `installed in ${withBlock.length}/${dirs.length} profiles — rerun install to fix`;
    return "not installed";
}

/** True when any profile's user layer carries the managed block. The `bili dsh`
 *  launcher consults this before adding its own --patch overlay: cordis rejects
 *  duplicate loader entry ids across layers, so a second `id: bili-native`
 *  insert would hard-fail dsh boot whenever the persistent install is present. */
export function dshNativeInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return false;
    }
    return dirs.some((dir) => {
        if (dshBundleInstalled(dir)) return true;
        try {
            return fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8").includes(DSH_PATCH_BEGIN);
        } catch {
            return false;
        }
    });
}

// — dispatch ————————————————————————————————————————————————————————————

export function isPluginAgent(value: string): value is PluginAgent {
    return (PLUGIN_AGENTS as readonly string[]).includes(value);
}

export function pluginInstall(agent: PluginAgent, opts: { withMcp?: boolean } = {}): string {
    return agent === "pi" ? piInstall() : agent === "omp" ? ompInstall() : agent === "claude" ? claudeInstall() : agent === "codex" ? codexInstall() : agent === "dsh" ? dshInstall() : opencodeInstall(opts.withMcp === true);
}

export function pluginRemove(agent: PluginAgent): string {
    return agent === "pi" ? piRemove() : agent === "omp" ? ompRemove() : agent === "claude" ? claudeRemove() : agent === "codex" ? codexRemove() : agent === "dsh" ? dshRemove() : opencodeRemove();
}

export function pluginStatusAll(): Array<{ agent: string; status: string }> {
    const checks: Array<[string, () => string]> = [
        ["pi", piStatus],
        ["omp", ompStatus],
        ["claude", claudeStatus],
        ["codex", codexStatus],
        ["opencode", opencodeStatus],
        ["dsh", dshStatus],
    ];
    return checks.map(([agent, check]) => {
        try {
            return { agent, status: check() };
        } catch (err) {
            return { agent, status: `error: ${err instanceof Error ? err.message : String(err)}` };
        }
    });
}
