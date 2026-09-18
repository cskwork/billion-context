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
// Installers throw on failure (bad/locked config, missing host CLI); the CLI
// layer catches, prints `bili plugin: <msg>` and exits 1.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyEdits, modify as jsoncModify, parse as jsoncParse, type ParseError } from "jsonc-parser";
import { resolvePiHome } from "./client-config.js";
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

export const PLUGIN_AGENTS = ["pi", "omp", "claude", "codex", "opencode"] as const;
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

function piInstall(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    if (packages.some((p) => p === root)) return `pi: already installed (${file})`;
    const removed = packages.filter((p) => isPiEntry(p, root));
    const kept = packages.filter((p) => !isPiEntry(p, root));
    kept.push(root);
    settings.packages = kept;
    writeJson(file, settings);
    // #788: dropped entries must be visible — silently replacing a documented
    // setup (npm:billion-context-pi) left users with no compression and no
    // idea their config changed.
    const note = removed.length > 0 ? `\npi: replaced existing entries: ${removed.join(", ")}` : "";
    return `pi: installed -> ${file} packages += ${root}${note}`;
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
    return list.some((p) => p === root) ? "installed" : "not installed";
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

// CLAUDE overrides the claude binary path (absolute path for sandboxed
// setups; a guaranteed-missing file in tests so the failure path stays
// deterministic even on machines that have the real CLI).
function claudeInstall(): string {
    const root = selfPackageRoot();
    const mcpJs = path.join(root, "dist", "mcp.js");
    requireDistFile(mcpJs);
    const claude = process.env.CLAUDE?.trim() || "claude";
    try {
        execFileSync(claude, ["mcp", "add", "bili", "--scope", "user", "-e", `BILI_MCP_PROXY=${proxyOriginForInstall()}`, "--", process.execPath, mcpJs], { stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
        return `claude: installed via \`claude mcp add\` (user scope) -> ${claudeMcpJson()}`;
    } catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer | string }).stderr ?? "") : "";
        throw new Error(`claude: install failed (${stderr.trim() || (err instanceof Error ? err.message : String(err))}) — is the claude CLI on PATH?`);
    }
}

function claudeRemove(): string {
    if (claudeStatus() === "not installed") return `claude: not installed (${claudeMcpJson()})`;
    const claude = process.env.CLAUDE?.trim() || "claude";
    try {
        execFileSync(claude, ["mcp", "remove", "bili", "--scope", "user"], { stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
        return "claude: removed";
    } catch (err) {
        throw new Error(`claude: remove failed (${err instanceof Error ? err.message : String(err)})`);
    }
}

function claudeStatus(): string {
    const data = readJson(claudeMcpJson()) as { mcpServers?: Record<string, unknown> };
    return data.mcpServers && "bili" in data.mcpServers ? "installed" : "not installed";
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
        const out = execFileSync(command, ["--version"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

function opencodeInstall(): string {
    const file = opencodeTargetFile();
    const { original, data } = loadOpencodeConfig(file);
    const notes: string[] = [];
    const touched = new Set<string>();

    // MCP shell is optional: the native plugin below self-spawns a proxy, so a
    // missing live origin skips the shell instead of failing the install.
    try {
        const mcpJs = path.join(selfPackageRoot(), "dist", "mcp.js");
        requireDistFile(mcpJs);
        const rawMcp = data.mcp;
        if (rawMcp != null && !isPlainMcpObject(rawMcp)) {
            notes.push('mcp.bili skipped ("mcp" is not an object)');
        } else {
            const mcp = (rawMcp as Record<string, unknown> | undefined) ?? {};
            if ("bili" in mcp) notes.push("mcp.bili present");
            else {
                mcp.bili = { type: "local", command: [process.execPath, mcpJs], environment: { BILI_MCP_PROXY: proxyOriginForInstall() }, enabled: true };
                data.mcp = mcp;
                touched.add("mcp");
                notes.push("mcp.bili written");
            }
        }
    } catch (err) {
        notes.push(`mcp.bili skipped (${err instanceof Error ? err.message : String(err)})`);
    }

    // Native plugin (#820): self-spawned proxy + http.request URL rewrite.
    const agentJs = path.join(selfPackageRoot(), "dist", "agent", "opencode-native.js");
    requireDistFile(agentJs);
    // Single compression owner FIRST: drop any opencode-acp entry before
    // adding ours, so both never load armed in one host (#918). The write
    // below snapshots the original config to .bili-bak (first write only).
    stripLegacyOpencodeAcp(data, notes, touched);
    const dir = opencodePluginDir(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `export { default } from ${JSON.stringify(agentJs)};\n`);
    // #927: the single effective key for this host — see pickPluginKey.
    const key = pickPluginKey(detectOpencodeMajor());
    const existing = pluginEntries(data, key);
    if (!existing.includes(dir)) {
        data[key] = [...existing, dir];
        touched.add(key);
        notes.push(`${key} -> ${dir}`);
    } else {
        notes.push(`${key} present`);
    }

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

    // #927: clean our entry out of whichever key spelling carries it.
    const dir = opencodePluginDir(file);
    let dirRemoved = false;
    for (const key of PLUGIN_KEYS) {
        const entries = pluginEntries(data, key);
        if (!entries.includes(dir)) continue;
        const remaining = entries.filter((p) => p !== dir);
        if (remaining.length === 0) delete data[key];
        else data[key] = remaining;
        touched.add(key);
        dirRemoved = true;
    }
    if (dirRemoved) {
        fs.rmSync(dir, { recursive: true, force: true });
        notes.push(`plugin dir removed (${dir})`);
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
    const listed = PLUGIN_KEYS.some((k) => pluginEntries(data, k).includes(dir));
    return (isPlainMcpObject(mcp) && "bili" in mcp) || listed ? "installed" : "not installed";
}

// — dispatch ————————————————————————————————————————————————————————————

export function isPluginAgent(value: string): value is PluginAgent {
    return (PLUGIN_AGENTS as readonly string[]).includes(value);
}

export function pluginInstall(agent: PluginAgent): string {
    return agent === "pi" ? piInstall() : agent === "omp" ? ompInstall() : agent === "claude" ? claudeInstall() : agent === "codex" ? codexInstall() : opencodeInstall();
}

export function pluginRemove(agent: PluginAgent): string {
    return agent === "pi" ? piRemove() : agent === "omp" ? ompRemove() : agent === "claude" ? claudeRemove() : agent === "codex" ? codexRemove() : opencodeRemove();
}

export function pluginStatusAll(): Array<{ agent: string; status: string }> {
    const checks: Array<[string, () => string]> = [
        ["pi", piStatus],
        ["omp", ompStatus],
        ["claude", claudeStatus],
        ["codex", codexStatus],
        ["opencode", opencodeStatus],
    ];
    return checks.map(([agent, check]) => {
        try {
            return { agent, status: check() };
        } catch (err) {
            return { agent, status: `error: ${err instanceof Error ? err.message : String(err)}` };
        }
    });
}
