// Native dsh (deepseek-harness) cordis plugin (#941): full plugin-mode
// compression for dsh WITHOUT a launcher — bare `dsh` with this plugin
// installed via `bili plugin install dsh` (cordis.patch.yml entry) or
// injected by the `bili dsh` launcher through the same --patch overlay that
// used to carry dsh-acp.ts. Architecture mirrors pi-native.ts:
//   1. plan: attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY — the
//      launcher preset, or a user-supplied external proxy) or spawn the
//      package's own proxy (ensureProxyRunning, ephemeral port, parent-pid
//      watchdog = this dsh process);
//   2. patch globalThis.fetch (native-intercept.ts) — spawn mode rewrites
//      model-API URLs to `<proxy>/bili/<url>`; attach mode leaves routing to
//      the launcher (proxy envs / settings overlay / MITM) and only stamps
//      headers; already-routed `/bili/` URLs get headers only;
//   3. register the proxy's tool manifest (compress/decompress/acp_status)
//      as native dsh tools — parameters pass through verbatim (the manifest
//      serves real JSON Schema, and ctx.tools.register projects
//      definition.parameters as-is onto the wire);
//   4. headersFor gates plugin mode exactly like pi.ts's
//      before_provider_headers stamp: no x-bili-plugin headers until the
//      tools are registered, so round 1 rides the proxy's wire mode instead
//      of arriving tool-less. The conversation id comes from
//      ctx.agents.currentInitiator() — dsh's AsyncLocalStorage attribution,
//      read synchronously at request time inside the agent's driver chain;
//   5. /acp command (absorbs dsh-acp.ts, now session-bound when an
//      initiator is active, latest-session fallback otherwise).
// Native auto-compaction is disabled by the INSTALLER/LAUNCHER patch file
// (compaction-basic auto:false override) — not by this module. dsh has no
// compaction event hook to observe a manual /compact, so its boundary is
// left to the kernel's natural ingest diff (#395 gap, acceptable: manual
// /compact is rare and auto mode is off).

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, type NativeInterceptState } from "./native-intercept.js";
import { fetchManifest, fetchProxyVersion, fetchStatus, fetchStatusLatest, forwardTool, type ManifestTool } from "./shared.js";

export const name = "bili-native";
export const inject = ["tools", "commands", "agents"];

const RETRY_INTERVAL_MS = 10000;

type AgentLike = { session?: { id?: unknown } | undefined };
type ToolExec = { agent?: AgentLike | undefined; signal?: AbortSignal };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
};

type CommandOutcome = { kind: "success" | "error"; text: string };

type PluginContext = {
    tools: { register: (definition: ToolDefinition) => unknown };
    commands: { register: (command: { name: string; description: string; handler: () => Promise<CommandOutcome> }) => unknown };
    agents: { currentInitiator?: () => AgentLike | undefined };
};

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeDsh(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_DSH");
}

/** Native posture (#809 precedence, opencode plan shape): kill-switches >
 *  attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY) > spawn. A preset
 *  BILLION_CONTEXT_PROXY is the `bili dsh` launcher (or a user attach):
 *  routing is already owned (proxy envs / settings overlay), so we attach —
 *  stamp headers only, never rewrite, never spawn. */
export function planNativeDsh(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_DSH === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

// One registration lifecycle per process. toolsReady is the ONLY gate for
// header stamping (pi.ts discipline): stamped headers flip the proxy into
// plugin mode, which suppresses wire tool injection — stamping before the
// local tools exist would send a tool-less request.
type RegisterState = { base: string | undefined; toolsReady: boolean; retryAt: number; pending: Promise<void> | undefined };

const register: RegisterState = { base: undefined, toolsReady: false, retryAt: 0, pending: undefined };

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false },
            { scriptPath: nativeProxyScriptPath() },
        );
        state.origin = handle.origin;
        register.base = handle.origin;
        process.env.BILLION_CONTEXT_PROXY = handle.origin;
        return handle.origin;
    } catch (err) {
        console.error(`bili-native-dsh: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
        return undefined;
    }
}

function toolDefinition(base: string, tool: ManifestTool): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : String(value ?? "") }],
        },
        execute: async (args, exec) => {
            const sid = exec.agent?.session?.id;
            if (typeof sid !== "string" || sid.length === 0) {
                throw new Error(`bili tool ${tool.name} requires an owning agent session`);
            }
            return forwardTool(base, sid, tool.name, args, exec.signal);
        },
    };
}

async function registerTools(ctx: PluginContext): Promise<void> {
    if (register.pending !== undefined) return register.pending;
    const base = register.base;
    if (register.toolsReady || base === undefined) return;
    register.pending = (async () => {
        const tools = await fetchManifest(base, "anthropic");
        for (const tool of tools) ctx.tools.register(toolDefinition(base, tool));
        register.toolsReady = true;
    })()
        .catch((err: unknown) => {
            register.retryAt = Date.now() + RETRY_INTERVAL_MS;
            console.error(`bili-native-dsh: manifest registration failed (${errMessage(err)}) — retrying; requests stay in wire mode until it succeeds`);
        })
        .finally(() => {
            register.pending = undefined;
        });
    return register.pending;
}

function maybeRetry(ctx: PluginContext): void {
    if (register.toolsReady || register.base === undefined) return;
    if (register.pending !== undefined) return;
    if (Date.now() < register.retryAt) return;
    void registerTools(ctx).catch(() => {});
}

function sessionIdOf(ctx: PluginContext): string | undefined {
    try {
        const sid = ctx.agents?.currentInitiator?.()?.session?.id;
        return typeof sid === "string" && sid.length > 0 ? sid : undefined;
    } catch {
        return undefined;
    }
}

async function statusOutcome(ctx: PluginContext): Promise<CommandOutcome> {
    const base = register.base;
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — install via `bili plugin install dsh` or launch through `bili dsh`.",
        };
    }
    maybeRetry(ctx);
    const sid = sessionIdOf(ctx);
    const status = (sid !== undefined ? await fetchStatus(base, sid) : undefined) ?? (await fetchStatusLatest(base));
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        return { kind: "success", text: panel };
    }
    const version = await fetchProxyVersion(base);
    if (version) {
        return {
            kind: "success",
            text: `billion-context@${version} — proxy connected, compression armed. No model request seen yet; send one, then run /acp again.`,
        };
    }
    return {
        kind: "error",
        text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
    };
}

export function apply(ctx: PluginContext): void {
    const plan = planNativeDsh(process.env);
    if (plan.mode === "off") return;

    if (plan.mode === "attach") {
        state.attach = true;
        state.origin = plan.attachOrigin;
        state.ready = Promise.resolve(plan.attachOrigin);
        register.base = plan.attachOrigin;
        process.env.BILLION_CONTEXT_PROXY = plan.attachOrigin;
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        markNativeHost(process.env, "dsh");
        const start = singleFlight(bootstrap);
        state.respawn = start;
        state.onGiveUp = () => {
            delete process.env.BILLION_CONTEXT_PROXY;
            register.base = undefined;
            register.toolsReady = false;
        };
        state.ready = start();
    }

    state.headersFor = (_url) => {
        maybeRetry(ctx);
        if (!register.toolsReady) return undefined;
        const sid = sessionIdOf(ctx);
        if (sid === undefined) return undefined;
        return { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid };
    };

    void state.ready.then((origin) => {
        if (origin !== undefined) void registerTools(ctx).catch(() => {});
    });

    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: () => statusOutcome(ctx),
    });

    // node:test drives apply() directly with a mock ctx — never patch
    // globalThis.fetch from inside a test run.
    if (process.env.NODE_TEST_CONTEXT === undefined) installNativeFetchIntercept(state);
}

/** Test hook: reset the module-level registration lifecycle so suites can
 *  drive apply() repeatedly with a fresh mock ctx. */
export function _resetRegisterForTest(base: string | undefined): void {
    register.base = base;
    register.toolsReady = false;
    register.retryAt = 0;
    register.pending = undefined;
}
