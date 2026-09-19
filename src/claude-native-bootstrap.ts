// #964 claude native bootstrap — the SessionStart hook command written into
// ~/.claude/settings.json by `bili plugin install claude`. Claude Code has no
// in-process extension point (hooks and MCP servers are child processes), so
// the native posture is a documented hybrid:
//
//   1. the installer pins env.ANTHROPIC_BASE_URL to a STABLE loopback port
//      (resolveClaudeNativePort: BILI_CLAUDE_NATIVE_PORT > config
//      claude.nativePort > 48787) with a /bili/-wrapped upstream — full
//      traffic visibility without MITM;
//   2. THIS hook (child of the claude process, fired before the first model
//      request) makes sure a proxy is listening there: attach to a healthy
//      compatible one, else spawn one detached whose parent-pid watchdog
//      watches CLAUDE's pid (this hook's parent — the hook itself exits
//      immediately) so the proxy lives and dies with the session;
//   3. the MCP shim (dist/mcp.js, registered user-scope, pinned to the same
//      stable port) provides the native compress/decompress/acp_status tools
//      and identity-registers the conversation (CLAUDE_CODE_SESSION_ID =
//      x-claude-code-session-id on every request — the proxy's existing
//      plugin-mode gating, #162/#268; zero new protocol surface).
//
// Opt-out BILI_NATIVE_CLAUDE=0 (or the global BILLION_CONTEXT_PLUGIN=0):
// the hook still answers the now-static URL — by spawning a PASSTHROUGH-mode
// proxy on the same port (verbatim forward, compression off) so claude stays
// fully functional (#964 Q2). A launch that already owns routing
// (BILLION_CONTEXT_PROXY set — `bili claude` overrides the static URL with
// its own ephemeral proxy) needs nothing: exit 0 immediately.
//
// The hook must NEVER fail claude: every error prints to stderr and exits 0.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "./launcher.js";
import { resolveClaudeNativePort } from "./config.js";
import { nativeBootstrapGate, proxyEnvOrigin } from "./agent/native-bootstrap.js";

/** dist/claude-native-bootstrap.js → sibling dist/index.js (the package
 *  bin). ensureProxyRunning's default (process.argv[1]) would re-invoke THIS
 *  hook script as the proxy — infinite self-spawn. */
function proxyScriptPath(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function log(msg: string): void {
    process.stderr.write(`[bili-claude-bootstrap] ${msg}\n`);
}

/** Pure decision (#964): what this hook does under the given environment.
 *  Exported for tests.
 *   - "exit": someone else owns routing (BILLION_CONTEXT_PROXY /
 *     BILI_PROVIDER_REWRITES) — spawn nothing.
 *   - "passthrough": opted out (BILI_NATIVE_CLAUDE=0 /
 *     BILLION_CONTEXT_PLUGIN=0) — serve the static URL verbatim-forward.
 *   - "start": bring up (or attach to) the compression proxy. */
export function planClaudeNativeBootstrap(env: NodeJS.ProcessEnv): { action: "exit" | "passthrough" | "start"; port: number } {
    const port = resolveClaudeNativePort(env);
    if (proxyEnvOrigin(env) !== undefined) return { action: "exit", port };
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_CLAUDE === "0") return { action: "passthrough", port };
    if (!nativeBootstrapGate(env, "BILI_NATIVE_CLAUDE")) return { action: "exit", port };
    return { action: "start", port };
}

async function run(): Promise<void> {
    const plan = planClaudeNativeBootstrap(process.env);
    if (plan.action === "exit") return;
    try {
        // SessionStart hooks are children of the claude process itself, so
        // OUR parent pid is claude's pid — exactly the lifetime the spawned
        // proxy's watchdog should track (the hook process exits immediately
        // after bring-up).
        const handle = await ensureProxyRunning(
            {
                host: LAUNCHER_DEFAULT_HOST,
                port: plan.port,
                passthrough: plan.action === "passthrough",
                debug: false,
                parentPid: process.ppid,
                strictPort: true,
            },
            { scriptPath: proxyScriptPath() },
        );
        log(`proxy ${handle.attached ? "attached" : "started"} at ${handle.origin}${plan.action === "passthrough" ? " (passthrough — compression off)" : ""}`);
    } catch (err) {
        log(
            `proxy bring-up failed on port ${plan.port} — ${err instanceof Error ? err.message : String(err)}` +
                (plan.action === "start" ? ` — claude will fail its model calls until this is fixed (free the port or set BILI_CLAUDE_NATIVE_PORT, then reinstall: bili plugin install claude)` : ""),
        );
    }
}

function hookMain(): void {
    // Drain the hook's stdin payload (session_id etc.) — claude waits for
    // this process to exit; we never read the payload, but draining avoids a
    // blocked writer if the payload ever exceeds the socket buffer.
    process.stdin.resume();
    void run().finally(() => {
        process.stdin.destroy();
        process.exit(0);
    });
}

// Direct entry (dist/claude-native-bootstrap.js spawned by claude's hook, or
// the ts source under tsx in tests): run only when invoked as the script
// itself, never when imported for planClaudeNativeBootstrap.
if (process.argv[1] && /claude-native-bootstrap\.(?:ts|js)$/.test(process.argv[1])) {
    hookMain();
}
