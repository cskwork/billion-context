import type { Session } from "./session.js";
import type { OpenAIMessage } from "acp-kernel/wire";
import type { Logger } from "./logger.js";

/** [#684] Strict-echo reasoning upstreams: DeepSeek documents that
 *  thinking-mode "reasoning_content ... must be passed back to the API" —
 *  a rebuilt request whose assistant tool-call turns lost their reasoning is
 *  rejected with 400. Learned flag first (set on first 400 whose body mentions
 *  reasoning_content, see the loop's UpstreamHttpError handler), then the
 *  static host check. */
export function isStrictReasoningEcho(session: Session, upstreamOrigin: string | undefined): boolean {
    if (session.metadata.strictReasoningEcho === true) return true;
    return upstreamOrigin !== undefined && /deepseek/i.test(upstreamOrigin);
}

/** [#762] Strict-echo normalization: DeepSeek thinking mode accepts a BLANK
 *  reasoning_content echo but rejects an ABSENT field on assistant tool-call
 *  turns ("reasoning_content ... must be passed back"). The kernel round-trip
 *  drops blank echoes (an empty string carries no core message), so any
 *  rebuild can ship absent fields into a thinking session — the residual 400
 *  of #762. Inject "" on assistant tool-call messages lacking the field so the
 *  rejection class cannot reach the wire; hermes-agent PR #15527 (openclaw
 *  #71455) confirms DeepSeek accepts the blank form. Returns the input array
 *  unchanged when disabled or when nothing needed patching. */
export function normalizeStrictEchoReasoning(
    messages: OpenAIMessage[],
    enabled: boolean,
    log: Logger,
    sessionId: string,
): OpenAIMessage[] {
    if (!enabled) return messages;
    let patched = 0;
    const out = messages.map((m) => {
        if (m.role !== "assistant") return m;
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m;
        if (typeof m.reasoning_content === "string") return m;
        patched++;
        return { ...m, reasoning_content: "" };
    });
    if (patched > 0) {
        log("info", `[${sessionId}] strict-echo: injected blank reasoning_content on ${patched} assistant tool-call message(s) (#762)`);
    }
    return patched > 0 ? out : messages;
}

/** [#762] Body-level twin for outbound paths that build the body WITHOUT going
 *  through prepareOpenai (the compress-loop re-request, src/loop/core.ts): the
 *  main-path repair in prepareOpenai never sees those bodies. Returns the same
 *  body object when disabled, when there is no messages array, or when nothing
 *  needed patching. */
export function normalizeStrictEchoBody(
    body: Record<string, unknown>,
    enabled: boolean,
    log: Logger,
    sessionId: string,
): Record<string, unknown> {
    if (!enabled || !Array.isArray(body.messages)) return body;
    const patched = normalizeStrictEchoReasoning(body.messages as OpenAIMessage[], true, log, sessionId);
    return patched === body.messages ? body : { ...body, messages: patched };
}
