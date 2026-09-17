// OpenCode 2.x local-kernel host (#885 follow-up, pi-parity for opencode):
// runs the acp-kernel compression engine IN-PROCESS — no proxy on the model
// path. Structurally this is plugin mode (README "Two compression modes"):
// opencode's own transcript is the session of record, the compress tool
// call + result ARE the wire carrier (kernel-rendered acp_summary_* messages
// whose block is already carried by a tool call in view are stripped), and
// tools execute against the same shared machinery the proxy uses
// (applyRanges / resolveDecompress / executeSearchContext / handleAcpStatus /
// executeAbsorb). Session state (refs, blocks, blockContents) lives in the
// same registry + StateStore the proxy uses (src/session.ts), so a later
// proxy attach over the same conversation id picks the state up seamlessly.
//
// Wire seam: session.hook("context") — fires per outgoing model request with
// the full rebuilt projection (system + messages); in-place mutation reaches
// the wire (probed live on 2.0.4, #885 verification). Mutations here are
// EPHEMERAL by construction: opencode rebuilds this projection from its own
// transcript every request, so injected nudges never persist.
//
// Token accounting mirrors opencode-acp v1: the LAST assistant message's
// provider-reported tokens (input + cache.read + cache.write + output +
// reasoning) is the real context size fed to processTurn; text estimation is
// only a first-turn fallback (estimates undercount CJK 3-4x and never arm
// nudges — same rationale as the proxy's lastInputTokens rule).

import {
    createCore,
    defaultConfig,
    defaultCountTokens,
    defaultPrompts,
    estimateTokensFast,
    renderNudgeText,
    viableRanges,
    type CompressionCore,
    type CompressionState,
    type Config,
    type CoreMessage,
    type NudgeDecision,
} from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import {
    ABSORB_TOOL_NAME,
    COMPRESS_TOOL_NAME,
    buildCompressSystemPrompt,
    parseCompressInput,
    withConversationIdNote,
    withLocalTagFormatNote,
    withMarkerIntegrityNote,
    withStagedCompressGuidance,
} from "../compress-tool.js";
import { applyRanges } from "../stream.js";
import { executeSearchContext, resolveDecompress } from "../decompress-shared.js";
import { handleAcpStatus } from "../acp-status.js";
import { effectiveAbsorbConfig, executeAbsorb } from "../absorb.js";
import {
    applyCompactionArchive,
    ensureCanonicalId,
    getSession,
    markCompactionBoundary,
    markDirty,
    snapshotMessages,
    withSessionLock,
    type Session,
} from "../session.js";
import { stripAcpTags } from "../loop/tag-echo-filter.js";
import { VERSION } from "../version.js";
import type { RewriteCtx } from "../stream.js";

type OcPart = { type: string; [k: string]: unknown };
type OcTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
type OcMessage = {
    // v2's context projection emits tool-result messages with NO id — part
    // ids (the tool call id) are the only stable key there.
    id?: string;
    role: string;
    content?: OcPart[];
    tokens?: OcTokens;
    info?: { agent?: unknown };
    [k: string]: unknown;
};
type OcSystemPart = { type?: string; text?: unknown } | undefined;

export interface V2ContextEvent {
    sessionID?: unknown;
    system?: OcSystemPart[];
    messages?: OcMessage[];
    model?: { providerID?: unknown; id?: unknown };
    [k: string]: unknown;
}

// OpenCode built-in hidden agents (title/summary/compaction) and the
// standalone internal-prompt signatures they run with. Mutating those small
// requests corrupts them and the shared session state — skip early.
const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);
const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
];

export interface OpencodeLocalHost {
    /** Wire seam: V2 session.hook("context") — fires per outgoing model
     *  request with the full projection; in-place mutation reaches the wire.
     *  `window` is the catalog-resolved context limit for the active model
     *  (plugin-side refresh); falls back to the session's last value. */
    onContext(e: V2ContextEvent, window?: number): Promise<void>;
    /** `callId` = the host tool-call id (opencode part id) so created blocks
     *  carry it and the summary-suppression rule can match the carrier. */
    executeTool(name: string, args: Record<string, unknown>, sessionID: string, callId?: string): Promise<string>;
    renderStatus(sessionID: string): Promise<string>;
    /** V2 session.compaction.ended — opencode replaced the transcript with its
     *  own summary; the next onContext archives ACP blocks whose raw ids left
     *  (plugin-mode equivalent of reportCompactionBoundary → proxy). */
    markCompaction(sessionID: string): void;
}

interface LocalMemory {
    view: CoreMessage[];
    msgs: CoreMessage[];
    config: Config;
    window: number;
    nudge?: NudgeDecision;
    systemTokens: number;
}

const FALLBACK_WINDOW = 128_000;

function textOfPart(p: OcPart): string {
    const t = p.text;
    return typeof t === "string" ? t : "";
}

function toolResultText(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}

export function opencodeToCore(messages: OcMessage[]): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (const msg of messages) {
        const parts = Array.isArray(msg.content) ? msg.content : [];
        parts.forEach((p, i) => {
            const id = `${msg.id}:${i}`;
            if (p.type === "text") {
                out.push({ id, role: msg.role as CoreMessage["role"], contentType: "text", text: textOfPart(p) });
            } else if (p.type === "tool-call") {
                out.push({
                    id,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: typeof p.name === "string" ? p.name : undefined,
                    toolCallId: typeof p.id === "string" ? p.id : undefined,
                    text: JSON.stringify(p.input ?? {}),
                });
            } else if (p.type === "tool-result") {
                // v2 projections give the carrying message id `undefined`, so a
                // positional id would collide across turns (every tool result
                // becomes "undefined:0", the kernel dedups them into one and
                // the rebuild orphans the later calls — the model then sees
                // opencode's "Tool result missing" placeholder and re-issues
                // the call in a loop). Key by call id instead: unique + stable.
                const callId = typeof p.id === "string" ? p.id : undefined;
                out.push({
                    id: callId !== undefined ? `tr_${callId}` : `${msg.id}:${i}`,
                    role: "tool",
                    contentType: "tool-result",
                    toolName: typeof p.name === "string" ? p.name : undefined,
                    toolCallId: callId,
                    text: toolResultText((p as { result?: { value?: unknown } }).result?.value),
                });
            } else if (p.type === "reasoning") {
                out.push({ id, role: "assistant", contentType: "reasoning", text: textOfPart(p) });
            } else {
                out.push({ id, role: msg.role as CoreMessage["role"], contentType: "text", text: `[part: ${p.type}]` });
            }
        });
    }
    return out;
}

// Strip model-imitated <acp ...> tags from assistant text before ingest: the
// proxy strips echoes at stream time (#206/#717); a local host has no stream
// seam, so stripping on ingest is the equivalent guard.
function stripEchoes(messages: CoreMessage[]): CoreMessage[] {
    for (const m of messages) {
        if (m.role === "assistant" && m.contentType === "text" && m.text !== undefined && m.text.includes("\x3cacp")) {
            m.text = stripAcpTags(m.text);
        }
    }
    return messages;
}

// plugin-mode carrier rule (server.ts stripKernelSummaries): drop every
// acp_summary_* whose block's compressCallId is already carried by a
// tool-call present in view — opencode's transcript holds the call, so the
// summary carrier would be a duplicate.
export function stripCarriedSummaries(messages: CoreMessage[], state: CompressionState): CoreMessage[] {
    const carried = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active || !b.compressCallId) continue;
        if (messages.some((m) => m.contentType === "tool-call" && m.toolCallId === b.compressCallId)) {
            carried.add(`acp_summary_${b.blockId}`);
        }
    }
    return messages.filter((m) => !(m.id ?? "").startsWith("acp_summary_") || !carried.has(m.id));
}

// Last assistant message with provider tokens = the real context size the
// previous request saw (v1 formula). Accepts input-only samples (aborted
// turns report output 0 but a real prompt size).
export function deriveTokenCount(messages: OcMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "assistant") continue;
        const t = msg.tokens;
        if (!t) continue;
        const input = t.input ?? 0;
        const output = t.output ?? 0;
        if (input <= 0 && output <= 0) continue;
        return input + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + output + (t.reasoning ?? 0);
    }
    return 0;
}

function estimateFallback(messages: CoreMessage[]): number {
    let total = 0;
    for (const m of messages) total += estimateTokensFast(m.text ?? "");
    return total;
}

export function coreToOpencode(view: CoreMessage[], originals: OcMessage[]): OcMessage[] {
    const partsByMsg = new Map<string, OcPart[]>();
    for (const msg of originals) {
        const key = msg.id ?? "";
        if (!partsByMsg.has(key)) partsByMsg.set(key, Array.isArray(msg.content) ? msg.content : []);
    }
    // tool-result parts keyed by call id (v2: the carrying message has no id)
    const toolPartByCall = new Map<string, OcPart>();
    const toolMsgByCall = new Map<string, OcMessage>();
    for (const msg of originals) {
        if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
        for (const p of msg.content) {
            if (p.type === "tool-result" && typeof p.id === "string" && !toolPartByCall.has(p.id)) {
                toolPartByCall.set(p.id, p);
                toolMsgByCall.set(p.id, msg);
            }
        }
    }
    const out: OcMessage[] = [];
    let i = 0;
    while (i < view.length) {
        const core = view[i];
        if (core.id.startsWith("acp_summary_")) {
            out.push({ id: core.id, role: "user", content: [{ type: "text", text: core.text ?? "" }] });
            i++;
            continue;
        }
        if (core.id.startsWith("tr_")) {
            const callId = core.id.slice(3);
            const part = toolPartByCall.get(callId);
            const msg = toolMsgByCall.get(callId);
            if (part !== undefined && msg !== undefined) out.push({ ...msg, content: [part] });
            i++;
            continue;
        }
        const msgId = core.id.slice(0, core.id.lastIndexOf(":"));
        const parts = partsByMsg.get(msgId) ?? [];
        const group: CoreMessage[] = [];
        let j = i;
        while (j < view.length && !view[j].id.startsWith("acp_summary_") && view[j].id.slice(0, view[j].id.lastIndexOf(":")) === msgId) {
            group.push(view[j]);
            j++;
        }
        const alive = new Set(group.map((g) => g.id));
        const newParts: OcPart[] = [];
        parts.forEach((p, idx) => {
            const pid = `${msgId}:${idx}`;
            if (!alive.has(pid)) return;
            if (p.type === "text") {
                const c = group.find((g) => g.id === pid);
                newParts.push({ ...p, text: c?.text ?? textOfPart(p) });
            } else {
                newParts.push(p);
            }
        });
        const orig = originals.find((m) => m.id === msgId);
        if (newParts.length > 0 && orig) out.push({ ...orig, content: newParts });
        i = j;
    }
    return out;
}

function isInternalAgent(e: V2ContextEvent): boolean {
    const messages = e.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== "user") continue;
        const agent = messages[i].info?.agent;
        if (typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)) return true;
        break;
    }
    const sys = (e.system ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
    return INTERNAL_AGENT_SIGNATURES.some((sig) => sys.includes(sig));
}

const core: CompressionCore = createCore();
const configCache = new Map<number, Config>();
const memory = new Map<string, LocalMemory>();
let nudgeCounter = 0;

function configFor(window: number): Config {
    const hit = configCache.get(window);
    if (hit) return hit;
    const cfg = defaultConfig(window);
    configCache.set(window, cfg);
    return cfg;
}

function resolveWindow(e: V2ContextEvent, explicit: number | undefined, mem: LocalMemory | undefined): number {
    if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
    return mem?.window ?? FALLBACK_WINDOW;
}

function logLine(msg: string): void {
    console.log(`[bili-oc-local] ${msg}`);
}

function logLineFor(sid: string): (level: string, msg: string) => void {
    return (level: string, msg: string): void => {
        if (level === "error") console.error(`[bili-oc-local] ${msg}`);
        else console.log(`[bili-oc-local] [${sid}] ${msg}`);
    };
}

export function createOpencodeLocalHost(): OpencodeLocalHost {
    return {
        async onContext(e: V2ContextEvent, window?: number): Promise<void> {
            const sid = typeof e.sessionID === "string" ? e.sessionID : "";
            const messages = e.messages;
            if (!sid || !Array.isArray(messages) || messages.length === 0) return;
            if (isInternalAgent(e)) return;
            const session = getSession(sid, { label: "opencode-local" });
            const prev = memory.get(sid);
            const win = resolveWindow(e, window, prev);
            const config = configFor(win);
            const sysText = (e.system ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
            const systemTokens = sysText.length > 0 ? defaultCountTokens(sysText) : 0;

            await withSessionLock(session, async () => {
                const msgs = stripEchoes(opencodeToCore(messages));
                const measured = deriveTokenCount(messages);
                const tokenCount = measured > 0 ? measured : estimateFallback(msgs);
                session.stats.lastInputTokens = tokenCount > 0 ? tokenCount : session.stats.lastInputTokens;
                session.metadata.systemPromptTokens = systemTokens;
                session.metadata.pluginAgent = "opencode-local";

                const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
                const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
                session.state = turn.state;
                session.stats.compressCreditTokens = 0;
                const nudge = turn.nudge !== undefined
                    ? { ...turn.nudge, compressibleRanges: viableRanges(turn.nudge.compressibleRanges) }
                    : undefined;
                const view = stripCarriedSummaries(turn.messages, turn.state);
                memory.set(sid, { view, msgs, config, window: win, nudge, systemTokens });
                snapshotMessages(session, msgs);
                applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), logLineFor(session.id));
                markDirty(session);
            });

            const mem = memory.get(sid);
            if (mem === undefined) return;
            const rebuilt = coreToOpencode(mem.view, messages);
            if (mem.nudge !== undefined && mem.nudge.shouldInject) {
                const rendered = renderNudgeText(mem.nudge);
                rebuilt.push({
                    id: `msg_acp_nudge_${++nudgeCounter}`,
                    role: "user",
                    content: [{ type: "text", text: withMarkerIntegrityNote(withStagedCompressGuidance(rendered.text)) }],
                });
            }
            e.messages = rebuilt;
            const sys = e.system;
            if (Array.isArray(sys)) {
                const prompt = withLocalTagFormatNote(withConversationIdNote(withMarkerIntegrityNote(buildCompressSystemPrompt(defaultPrompts)), ensureCanonicalId(session)));
                // Replace-style, never in-place push: if the host ever reuses
                // the same system array across requests (or fires the hook twice
                // per request, e.g. provider fallback), a push would append one
                // full copy of the compress prompt per request and grow the
                // window linearly. Only this host touches e.system in the repo,
                // so the array identity guarantee is ours to make.
                e.system = [...sys, { type: "text", text: prompt }];
            }
        },

        async executeTool(name: string, args: Record<string, unknown>, sessionID: string, callId?: string): Promise<string> {
            const mem = memory.get(sessionID);
            const session = getSession(sessionID, { label: "opencode-local" });
            if (mem === undefined) {
                return "bili: no ACP state for this session yet — send one model message first; ACP activates automatically once a request flows.";
            }
            return withSessionLock(session, async () => {
                const ctx: RewriteCtx = {
                    core,
                    config: mem.config,
                    messages: mem.view,
                    compressMessages: mem.msgs,
                    session,
                    hostLabel: `billion-context-opencode-local ${VERSION}`,
                    log: logLine,
                };
                let result: string;
                if (name === COMPRESS_TOOL_NAME) {
                    result = applyRanges(parseCompressInput(args, callId), ctx);
                } else if (name === "decompress") {
                    result = resolveDecompress(args, ctx);
                } else if (name === "search_context") {
                    result = executeSearchContext(args, core, session.state);
                } else if (name === "acp_status") {
                    result = handleAcpStatus(args, ctx);
                    // Default (no drilldown args) renders the panel first — the
                    // same panel /acp shows — then the structured report the
                    // model needs. Drilldown queries (scope/view/tool/sort/limit)
                    // return the report alone.
                    const drilldown = typeof args.scope === "string" || typeof args.view === "string"
                        || typeof args.tool === "string" || typeof args.sort === "string" || typeof args.limit === "number";
                    if (!drilldown) {
                        const turn = core.processTurn({
                            messages: mem.view,
                            state: session.state,
                            config: mem.config,
                            tokenCount: session.stats.lastInputTokens,
                            renderTags: "none",
                        });
                        result = buildStatusPanel({
                            version: `billion-context-opencode-local@${VERSION}`,
                            tokenCount: session.stats.lastInputTokens,
                            systemPromptTokens: mem.systemTokens,
                            state: session.state,
                            nudge: turn.nudge,
                            modelContextLimit: mem.window,
                        }) + "\n\n" + result;
                    }
                } else {
                    const absorb = effectiveAbsorbConfig(session, mem.config);
                    if (absorb?.enabled === true && name === (absorb.toolName ?? ABSORB_TOOL_NAME)) {
                        result = executeAbsorb(args, undefined, absorb, ctx);
                    } else {
                        result = `[Unknown proxy tool: ${name}]`;
                    }
                }
                markDirty(session);
                return result;
            });
        },

        async renderStatus(sessionID: string): Promise<string> {
            const mem = memory.get(sessionID);
            const session = getSession(sessionID, { label: "opencode-local" });
            if (mem === undefined) {
                return `billion-context@${VERSION} — local kernel active, no ACP session yet. Send a model request, then run /acp again.`;
            }
            return buildStatusPanel({
                version: `billion-context-opencode-local@${VERSION}`,
                tokenCount: session.stats.lastInputTokens,
                systemPromptTokens: mem.systemTokens,
                state: session.state,
                nudge: mem.nudge,
                modelContextLimit: mem.window,
            });
        },

        markCompaction(sessionID: string): void {
            const session = getSession(sessionID, { label: "opencode-local" });
            markCompactionBoundary(session);
        },
    };
}

// ——— V2 plugin surface ————————————————————————————————————————————————————
// Pure-local deployment: `bili plugin install opencode-local` writes a plugin
// dir re-exporting this file's default. No proxy is spawned or contacted —
// the kernel runs in this process, tools execute in-process, /acp renders
// from local state. Registration mirrors createOpencodeV2Setup (same seams,
// same inert-safe optional chaining) so the two deployments cannot drift in
// shape, but every handler is local.

import { refreshWindows, V2_BILI_TOOLS, V2Registration, V2_SYNTHETIC_VISIBLE_MAX, type V2HttpRequestEvent, type V2PluginContext, type V2State } from "./opencode-v2.js";
import { V2_SYNTHETIC_TEXT } from "./shared.js";

const pluginDisabled = (): boolean => process.env.BILLION_CONTEXT_PLUGIN === "0";

export function createOpencodeLocalSetup(): (ctx: V2PluginContext) => Promise<() => void> {
    return async (ctx: V2PluginContext): Promise<() => void> => {
        const ac = new AbortController();
        const host = createOpencodeLocalHost();
        const state: V2State = {};
        const registrations: V2Registration[] = [];

        // Wire seam: the ONLY compression path. Fires per outgoing model
        // request (including internal agents — filtered inside onContext).
        const contextHook = async (e: V2HttpRequestEvent): Promise<void> => {
            if (pluginDisabled()) return;
            refreshWindows(ctx, state);
            const model = e.model;
            const window = model && typeof model.providerID === "string" && typeof model.id === "string"
                ? state.windows?.get(`${model.providerID}/${model.id}`)
                : undefined;
            await host.onContext(e as V2ContextEvent, window);
        };
        const contextReg = await ctx.session?.hook?.("context", contextHook);
        if (contextReg) registrations.push(contextReg);

        const toolReg = await ctx.tool?.transform?.((editor) => {
            for (const t of V2_BILI_TOOLS) {
                editor.add({
                    name: t.name,
                    description: t.description,
                    input: t.input,
                    options: { codemode: false, permission: "allow" },
                    execute: async (args, tctx) => {
                        if (pluginDisabled()) return { content: "bili: disabled (BILLION_CONTEXT_PLUGIN=0)" };
                        const callId = typeof (tctx as { toolCallID?: unknown }).toolCallID === "string" ? (tctx as { toolCallID?: string }).toolCallID : undefined;
                        return { content: await host.executeTool(t.name, args, tctx.sessionID, callId) };
                    },
                });
            }
        });
        if (toolReg) registrations.push(toolReg);

        try {
            const commandReg = await ctx.command?.transform?.((editor) => {
                editor.add({
                    name: "acp",
                    description: "Show ACP status (billion-context local kernel)",
                    execute: async (input) => {
                        const sid = typeof input.sessionID === "string" ? input.sessionID : "";
                        if (!sid) {
                            console.warn("[bili-opencode-local] /acp invoked without a sessionID; cannot render ACP status");
                            return;
                        }
                        const text = pluginDisabled()
                            ? "bili: disabled (BILLION_CONTEXT_PLUGIN=0)"
                            : await host.renderStatus(sid);
                        try {
                            // resume:false — steer/wake defaults would start a
                            // model turn per invocation (#880 cap: see shared).
                            const description = text.length > V2_SYNTHETIC_VISIBLE_MAX
                                ? text.slice(0, V2_SYNTHETIC_VISIBLE_MAX - 20) + "\n\n[panel truncated]"
                                : text;
                            await ctx.session?.synthetic?.({ sessionID: sid, text: V2_SYNTHETIC_TEXT, description, resume: false });
                        } catch (err) {
                            console.error(`[bili-opencode-local] /acp render failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                });
            });
            if (commandReg) registrations.push(commandReg);
        } catch (err) {
            console.warn(`[bili-opencode-local] /acp command registration unavailable; continuing without it: ${err instanceof Error ? err.message : String(err)}`);
        }

        // opencode native /compact (#421 semantics): archive ACP blocks whose
        // raw ids left the compacted transcript on the next context event.
        const subscription = ctx.event?.subscribe?.({ signal: ac.signal });
        if (subscription && typeof subscription[Symbol.asyncIterator] === "function") {
            void (async () => {
                try {
                    for await (const evt of subscription) {
                        if (evt?.type !== "session.compaction.ended" || pluginDisabled()) continue;
                        const cid = evt.data && typeof evt.data.sessionID === "string" ? evt.data.sessionID : "";
                        if (cid) host.markCompaction(cid);
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
            state.windows = undefined;
            state.windowsAt = undefined;
        };
    };
}

export default { id: "billion-context-opencode-local", setup: createOpencodeLocalSetup() };
