// Thin opencode plugin for the billion-context proxy (`bili opencode`).
//
// Activates ONLY when BILLION_CONTEXT_PROXY is set (the launcher sets it);
// otherwise it is a no-op so shipping it inside the package is harmless.
// Mirrors the pi/omp plugin (src/agent/pi.ts):
//   - registers the /acp command (config hook + command.execute.before)
//   - binds the opencode session id to the proxy session via the
//     pending-register queue (POST /__bili/plugin/register on session.created)
//   - renders the proxy's buildStatusPanel via an ignored chat message

import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../compress-tool.js";
import { fetchProxyVersion, forwardTool, proxyBaseFromEnv, proxyBaseFromUrl, reportCompactionBoundary } from "./shared.js";

interface OpencodeCommandConfig {
    template: string;
    description?: string;
}

interface OpencodeConfig {
    command?: Record<string, OpencodeCommandConfig>;
    [key: string]: unknown;
}

interface OpencodeSessionInfo {
    id?: unknown;
}

interface OpencodeEvent {
    type?: string;
    properties?: { info?: OpencodeSessionInfo; [key: string]: unknown };
}

interface OpencodeEventInput {
    event?: OpencodeEvent;
}

interface OpencodeCommandInput {
    command: string;
    sessionID: string;
    arguments?: string;
}

interface OpencodePromptPart {
    type: string;
    text: string;
    ignored?: boolean;
}

interface OpencodeClient {
    session?: {
        prompt?: (args: {
            path: { id: string };
            body: { noReply: boolean; parts: OpencodePromptPart[] };
        }) => Promise<unknown>;
    };
}

interface OpencodePluginContext {
    client?: OpencodeClient;
}

interface OpencodeHooks {
    config?: (input: OpencodeConfig) => Promise<void>;
    event?: (input: OpencodeEventInput) => Promise<void>;
    "command.execute.before"?: (input: OpencodeCommandInput, output: { parts: unknown[] }) => Promise<void>;
}

const proxyBase = process.env.BILLION_CONTEXT_PROXY ?? "";

async function showText(ctx: OpencodePluginContext, sid: string, text: string): Promise<void> {
        // Direct method call — `const p = ctx.client.session.prompt; p(...)` loses `this` (this._client) and throws.
        const session = ctx.client?.session;
        if (!session || typeof session.prompt !== "function") {
            console.error("[bili-opencode] /acp render failed: session.prompt unavailable");
            return;
        }
        try {
            await session.prompt({
                path: { id: sid },
                body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
            });
        } catch (err) {
            console.error(`[bili-opencode] /acp render failed: ${err instanceof Error ? err.message : String(err)}`);
        }
}

const server = async (ctx: OpencodePluginContext): Promise<OpencodeHooks> => {
    if (!proxyBase) return {};
    console.log("[bili-opencode] plugin active (proxy " + proxyBase + ")");
    return {
        config: async (opencodeConfig) => {
            opencodeConfig.command ??= {};
            opencodeConfig.command["acp"] = {
                template: "",
                description: "Show ACP status (billion-context proxy)",
            };
        },
        "command.execute.before": async (input) => {
            if (input.command !== "acp") return;
            const sid = input.sessionID;
            let text: string;
            try {
                const res = await fetch(`${proxyBase}/__bili/plugin/status?conversationId=${encodeURIComponent(sid)}&fallback=latest`);
                const status = (await res.json()) as { ok?: boolean; panel?: string; error?: string };
                if (typeof status.panel === "string" && status.panel.length > 0) {
                    text = status.panel;
                } else if (status.ok === false) {
                    // zero sessions on the proxy (fresh launch) — friendly idle notice
                    let version: string | undefined;
                    try {
                        version = await fetchProxyVersion(proxyBase);
                    } catch {
                        version = undefined;
                    }
                    text = version !== undefined
                        ? `billion-context@${version} — proxy connected, no ACP session yet. Send a model request, then run /acp again.`
                        : "bili: no ACP session yet (send a model request first, then run /acp)";
                } else {
                    text = "bili: proxy returned no status panel";
                }
            } catch (err) {
                text = `bili: /acp failed (${err instanceof Error ? err.message : String(err)})`;
            }
            await showText(ctx, sid, text);
            throw new Error("__BILI_ACP_HANDLED__");
        },
    };
};

// ---------------------------------------------------------------------------
// OpenCode 2.0 (V2 plugin API). Same protocol-client contract as V1 above: no
// acp-kernel, no compression logic — the proxy is the single compression
// authority. Structural types only (no @opencode/plugin import) so this file
// stays loadable under both host generations via the object export below
// (V2 validates `{ id, setup }`; V1 >= 1.18.29 calls `.server()`).
//
// Runtime API facts (OpenCode 2.0 pre-release, probed live against the real
// binary — these CONTRADICT the published @opencode/plugin@2.0.2 typings):
// - session.hook("model.request") registers successfully but NEVER FIRES; the
//   working interception point is session.hook("http.request"), which fires
//   per outgoing provider request with a standard fetch Request at e.request
//   (mutating e.request.headers reaches the wire — verified end-to-end);
// - there is NO ctx.tool.reload() — host replays transforms on its own reload
//   events, so tools must be registered SYNCHRONOUSLY from bundled schemas
//   (exact parity: this file and the proxy's openai tool list are built from
//   the same source, src/compress-tool.ts);
// - the command editor exposes list/get/update/remove only — plugins cannot
//   ADD commands, so /acp does not exist under V2; the acp_status tool is the
//   in-host equivalent.
// ---------------------------------------------------------------------------

type V2Registration = { dispose?: () => void | Promise<void> };

interface V2Headers {
    set(name: string, value: string): void;
}

interface V2HttpRequestEvent {
    sessionID?: unknown;
    model?: { providerID?: unknown; id?: unknown };
    request?: { url?: unknown; headers?: V2Headers | null };
}

interface V2ToolEditor {
    add(tool: {
        name: string;
        description?: string;
        input: unknown;
        options?: { namespace?: string; permission?: string; codemode?: boolean; pinned?: boolean };
        execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
    }): void;
}

interface V2CatalogModelEntry {
    providerID?: unknown;
    id?: unknown;
    limit?: { context?: unknown };
}

interface V2PluginContext {
    session?: {
        hook?: (name: string, cb: (e: V2HttpRequestEvent) => void | Promise<void>) => void | Promise<V2Registration | undefined>;
    };
    tool?: {
        transform?: (cb: (editor: V2ToolEditor) => void) => void | Promise<V2Registration | undefined>;
    };
    event?: { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<{ type?: unknown; data?: Record<string, unknown> }> | undefined };
    catalog?: { model?: { list?: () => Promise<{ data?: V2CatalogModelEntry[] }> | undefined } | undefined };
}

const WINDOW_REFRESH_MS = 60000;

// Kill switch = fully inert (same semantics as detectProxyBase): gates header stamping, tool forwarding, compaction reporting.
const pluginDisabled = (): boolean => process.env.BILLION_CONTEXT_PLUGIN === "0";

const V2_BILI_TOOLS = [...ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI].map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input: t.function.parameters,
}));

interface V2State {
    proxyBase?: string;
    windows?: Map<string, number>;
    windowsAt?: number;
}

function refreshWindows(ctx: V2PluginContext, state: V2State): void {
    const now = Date.now();
    if (state.windows && state.windowsAt !== undefined && now - state.windowsAt < WINDOW_REFRESH_MS) return;
    state.windowsAt = now;
    void (async () => {
        try {
            const res = await ctx.catalog?.model?.list?.();
            const map = new Map<string, number>();
            for (const m of res?.data ?? []) {
                const pid = typeof m.providerID === "string" ? m.providerID : "";
                const id = typeof m.id === "string" ? m.id : "";
                const c = m.limit?.context;
                if (pid && id && typeof c === "number" && Number.isFinite(c) && c > 0) map.set(`${pid}/${id}`, Math.floor(c));
            }
            if (map.size > 0) state.windows = map;
        } catch {
            // catalog unavailable — window header simply goes unstamped
        }
    })();
}

const setup = async (ctx: V2PluginContext): Promise<() => void> => {
    const ac = new AbortController();
    const state: V2State = {};
    const registrations: V2Registration[] = [];

    const stampHeaders = (e: V2HttpRequestEvent): void => {
        const headers = e.request?.headers;
        const sid = typeof e.sessionID === "string" ? e.sessionID : "";
        if (!headers || typeof headers.set !== "function" || !sid || !state.proxyBase) return;
        headers.set("x-bili-plugin-conversation", sid);
        headers.set("x-bili-plugin", "opencode");
        const model = e.model;
        if (model && typeof model.providerID === "string" && typeof model.id === "string") {
            const window = state.windows?.get(`${model.providerID}/${model.id}`);
            if (window !== undefined) headers.set("x-bili-plugin-context-window", String(window));
        }
    };

    const httpRequestHook = async (e: V2HttpRequestEvent): Promise<void> => {
        if (pluginDisabled()) return;
        const url = e.request?.url;
        if (typeof url !== "string") return;
        if (!state.proxyBase) {
            state.proxyBase = proxyBaseFromUrl(url) ?? proxyBaseFromEnv();
        }
        if (!state.proxyBase) return;
        refreshWindows(ctx, state);
        stampHeaders(e);
    };

    const hookReg = await ctx.session?.hook?.("http.request", httpRequestHook);
    if (hookReg) registrations.push(hookReg);

    const toolReg = await ctx.tool?.transform?.((editor) => {
        for (const t of V2_BILI_TOOLS) {
            editor.add({
                name: t.name,
                description: t.description,
                input: t.input,
                options: { codemode: false, permission: "allow" },
                execute: async (args, tctx) => {
                    if (pluginDisabled()) return { content: "bili: disabled (BILLION_CONTEXT_PLUGIN=0)" };
                    const base = state.proxyBase ?? proxyBaseFromEnv();
                    if (!base) return { content: "bili: no proxy detected (launch opencode through `bili opencode`, or point the provider baseURL at the bili proxy)" };
                    try {
                        const result = await forwardTool(base, tctx.sessionID, t.name, args);
                        return { content: result };
                    } catch (err) {
                        return { content: err instanceof Error ? err.message : String(err) };
                    }
                },
            });
        }
    });
    if (toolReg) registrations.push(toolReg);

    const subscription = ctx.event?.subscribe?.({ signal: ac.signal });
    if (subscription && typeof subscription[Symbol.asyncIterator] === "function") {
        void (async () => {
            try {
                for await (const evt of subscription) {
                    if (evt?.type !== "session.compaction.ended" || pluginDisabled()) continue;
                    const data = evt.data;
                    const cid = data && typeof data.sessionID === "string" ? data.sessionID : "";
                    const base = state.proxyBase ?? proxyBaseFromEnv();
                    if (!cid || !base) continue;
                    reportCompactionBoundary(base, cid).catch(() => {});
                }
            } catch {
                // subscription closed (abort on cleanup)
            }
        })();
    }

    return () => {
        ac.abort();
        for (const r of registrations) {
            try {
                void r.dispose?.();
            } catch {}
        }
        state.proxyBase = undefined;
        state.windows = undefined;
        state.windowsAt = undefined;
    };
};

export default { id: "billion-context-opencode", setup, server };
