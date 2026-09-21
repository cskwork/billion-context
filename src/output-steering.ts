import type { WireProtocol } from "./util.js";
import { log as loggerLog } from "./logger.js";

/**
 * Output-side compression (#1093): verbosity steering + effort routing.
 *
 * Ported from headroomlabs-ai/headroom (docs/proposals/output-token-reduction.md).
 * Output tokens cost more than input and are billed the instant they stream out,
 * so the only lever is at request time. Two levers, both applied at the proxy
 * forward boundary AFTER every other body mutation, on the FINAL wire body:
 *
 *   1. Verbosity steering — append a deterministic conciseness directive at the
 *      TAIL of the system prompt (levels L0–L4, default L2; L0 = none). Never
 *      prepend: prepending shifts the client's own prompt bytes and busts the
 *      prefix cache. The directive is sentinel-wrapped and re-applied idempotently,
 *      so retries never accumulate it and a level change replaces in place.
 *
 *   2. Effort routing — classify the last user turn STRUCTURALLY (block
 *      composition only, no content pattern-matching); on a mechanical
 *      continuation (clean tool result, no error) LOWER an explicitly-present
 *      effort field toward its minimum. Clamp-only: NEVER inject a field the
 *      client didn't send (models without effort support 400 on it), and NEVER
 *      toggle `thinking.type` (disabling thinking over a history that carries
 *      thinking blocks 400s and busts the cache tier).
 *
 * Default OFF. Config: billion-context.json `outputSteering` block (global, with
 * optional per-provider route overlay). Hard acceptance: no prefix-cache hit-rate
 * regression (compare `[acp-usage]` cache hit %).
 */

/** Sentinel wrapping the steering directive. Bili-owned (distinct from
 *  headroom's) so a body that passed through both proxies never collides. */
const SENTINEL = "<bili_output_steering>";
const SUFFIX = "</bili_output_steering>";

/** Conciseness directives L1–L4. BYTE-STABLE across releases: editing one is a
 *  prefix-cache bust for every session pinned at that level. Level 0 = none. */
const VERBOSITY_LEVELS: Record<number, string> = {
    1: "Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.",
    2: "Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.",
    3: "Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except) — shorten how you say it, not what you say. Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
    4: "Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except). Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
};

export function steeringText(level: number): string | null {
    const text = VERBOSITY_LEVELS[level];
    if (!text) return null;
    return `${SENTINEL}\n${text}\n${SUFFIX}`;
}

/** Idempotently place `block` in `existing`: replace the existing sentinel block
 *  in place (preserving surrounding text) if one is present, else append at the
 *  tail. Returns [updated, changed]. The slice skips PAST the old SUFFIX so a
 *  re-apply neither duplicates the closing tag nor grows the block. */
function replaceOrAppend(existing: string, block: string): [string, boolean] {
    const start = existing.indexOf(SENTINEL);
    if (start >= 0) {
        const found = existing.indexOf(SUFFIX, start);
        const end = found < 0 ? existing.length : found + SUFFIX.length;
        const prefix = existing.slice(0, start).replace(/\s+$/, "");
        const suffix = existing.slice(end).replace(/^\n+/, "");
        const parts = [prefix, block, suffix].filter((p) => p.length > 0);
        const updated = parts.join("\n\n");
        return [updated, updated !== existing];
    }
    const trimmed = existing.trim();
    const updated = trimmed.length > 0 ? `${existing.replace(/\s+$/, "")}\n\n${block}` : block;
    return [updated, updated !== existing];
}

// ---- Config ----

export type OutputSteeringConfig = {
    /** Master switch. Default OFF — both levers are inert until explicitly on. */
    enabled: boolean;
    /** Verbosity level 0–4 (0 = no steering directive), default 2. */
    verbosityLevel: number;
    /** Effort routing sub-switch, default on whenever `enabled` is. */
    effortRouting: boolean;
};

export const DEFAULT_OUTPUT_STEERING: OutputSteeringConfig = {
    enabled: false,
    verbosityLevel: 2,
    effortRouting: true,
};

/** Resolve verbosityLevel. An OMITTED field silently takes the default; a
 *  PRESENT but out-of-range value falls back WITH a warning (honest output —
 *  a valid partial config must not be accused of being malformed). */
export function resolveVerbosityLevel(v: unknown): { level: number; warning?: string } {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4) return { level: v };
    const level = DEFAULT_OUTPUT_STEERING.verbosityLevel;
    if (v === undefined) return { level };
    return { level, warning: `[config] outputSteering.verbosityLevel must be an integer 0-4; got ${JSON.stringify(v)} — falling back to ${level}` };
}

/** Validate an `outputSteering`-shaped value. Malformed fields fall back to
 *  defaults rather than breaking the proxy; returns undefined when the value is
 *  not an object (caller substitutes DEFAULT_OUTPUT_STEERING). */
export function parseOutputSteering(v: unknown): OutputSteeringConfig | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj = v as Record<string, unknown>;
    const lvl = resolveVerbosityLevel(obj.verbosityLevel);
    if (lvl.warning) loggerLog("warn", lvl.warning);
    return {
        enabled: obj.enabled === true,
        verbosityLevel: lvl.level,
        effortRouting: obj.effortRouting !== false,
    };
}

// ---- Turn classification (pure structural, no content pattern-matching) ----

export type TurnKind =
    | "new_user_ask"
    | "mechanical_continuation"
    | "error_continuation"
    | "unknown";

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Anthropic-style: a user turn's `content` is an array of typed blocks; tool
 *  results arrive as `tool_result` blocks inside the user message. */
function classifyAnthropicTurn(messages: unknown): TurnKind {
    if (!Array.isArray(messages) || messages.length === 0) return "unknown";
    const last = asRecord(messages[messages.length - 1]);
    if (!last || last.role !== "user") return "unknown";
    const content = last.content;
    if (typeof content === "string") return content.trim() ? "new_user_ask" : "unknown";
    if (!Array.isArray(content) || content.length === 0) return "unknown";
    let sawToolResult = false;
    let sawError = false;
    for (const raw of content) {
        const b = asRecord(raw);
        if (!b) return "unknown";
        const t = b.type;
        if (t === "tool_result") {
            sawToolResult = true;
            if (b.is_error === true) sawError = true;
        } else if (t === "text" || t === "image" || t === "document") {
            return "new_user_ask";
        } else {
            // Unrecognized block composition: do not classify (conservative —
            // an unknown block may carry user intent we cannot see).
            return "unknown";
        }
    }
    if (sawError) return "error_continuation";
    if (sawToolResult) return "mechanical_continuation";
    return "unknown";
}

/** OpenAI chat: tool results are separate `role:"tool"` messages (no structural
 *  error flag), so any trailing tool message is a mechanical continuation. */
function classifyOpenAiChatTurn(messages: unknown): TurnKind {
    if (!Array.isArray(messages) || messages.length === 0) return "unknown";
    const last = asRecord(messages[messages.length - 1]);
    if (!last) return "unknown";
    if (last.role === "tool") return "mechanical_continuation";
    if (last.role === "user") {
        const c = last.content;
        if (typeof c === "string") return c.trim() ? "new_user_ask" : "unknown";
        if (Array.isArray(c)) {
            for (const raw of c) {
                const b = asRecord(raw);
                if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) return "new_user_ask";
            }
            return "unknown";
        }
        return "unknown";
    }
    return "unknown";
}

const RESPONSES_OUTPUT_TYPES = new Set([
    "custom_tool_call_output",
    "function_call_output",
    "local_shell_call_output",
    "apply_patch_call_output",
]);

function responsesUserSignal(item: Record<string, unknown>): boolean {
    if (item.role === "user") {
        const c = item.content ?? item.input;
        if (typeof c === "string") return c.trim().length > 0;
        if (Array.isArray(c)) {
            for (const raw of c) {
                const b = asRecord(raw);
                if (!b) continue;
                if (b.type === "input_file" || b.type === "input_image") return true;
                if (b.type === "input_text" && typeof b.text === "string" && b.text.trim()) return true;
            }
        }
        return false;
    }
    if (item.type === "input_text") return typeof item.text === "string" && item.text.trim().length > 0;
    if (item.type === "input_image") return true;
    return false;
}

/** Responses API: the whole `input` is a flat list of items re-sent in full on
 *  every request. Mechanical means the FINAL turn (everything after the last
 *  user signal) carries tool-output items and nothing unrecognized. */
/** Item types that may sit between the last user signal and the trailing tool
 *  outputs without breaking a mechanical continuation (assistant-side items:
 *  prose, tool calls, thinking). */
const RESPONSES_NEUTRAL_TYPES = new Set(["message", "function_call", "custom_tool_call", "local_shell_call", "apply_patch_call", "reasoning"]);

function classifyResponsesTurn(input: unknown): TurnKind {
    if (typeof input === "string") return input.trim() ? "new_user_ask" : "unknown";
    if (!Array.isArray(input) || input.length === 0) return "unknown";
    // Walk BACKWARD from the end: the final turn is everything after the LAST
    // user signal. Clients re-send full history on every request (codex does),
    // so scanning forward would hit the original ask on every turn and could
    // never classify a continuation.
    let sawToolOutput = false;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = asRecord(input[i]);
        if (!item) return "unknown";
        const it = item.type;
        if (typeof it === "string" && RESPONSES_OUTPUT_TYPES.has(it)) {
            sawToolOutput = true;
            continue;
        }
        // Hitting the last user signal: tool outputs AFTER it mean the final
        // turn is a continuation; none means the user just asked something.
        if (responsesUserSignal(item)) return sawToolOutput ? "mechanical_continuation" : "new_user_ask";
        if (typeof it === "string" && RESPONSES_NEUTRAL_TYPES.has(it)) continue;
        return "unknown";
    }
    return sawToolOutput ? "mechanical_continuation" : "unknown";
}

/** Google native: the conversation is `contents`; a mechanical continuation is a
 *  final user turn whose parts are all `functionResponse` (no text/image). */
function classifyGoogleTurn(contents: unknown): TurnKind {
    if (!Array.isArray(contents) || contents.length === 0) return "unknown";
    const last = asRecord(contents[contents.length - 1]);
    if (!last || last.role !== "user") return "unknown";
    const parts = last.parts;
    if (!Array.isArray(parts) || parts.length === 0) return "unknown";
    let sawFunctionResponse = false;
    for (const raw of parts) {
        const p = asRecord(raw);
        if (!p) return "unknown";
        if (p.functionResponse) {
            sawFunctionResponse = true;
            continue;
        }
        if (typeof p.text === "string") {
            if (p.text.trim()) return "new_user_ask";
            continue; // empty text part: neutral
        }
        if (p.inlineData || p.fileData || p.videoMetadata) return "new_user_ask";
        return "unknown"; // unrecognized part composition: do not classify
    }
    if (sawFunctionResponse) return "mechanical_continuation";
    return "unknown";
}

function classifyTurn(protocol: WireProtocol, obj: Record<string, unknown>): TurnKind {
    switch (protocol) {
        case "anthropic": return classifyAnthropicTurn(obj.messages);
        case "openai": return classifyOpenAiChatTurn(obj.messages);
        case "responses": return classifyResponsesTurn(obj.input);
        case "google": return classifyGoogleTurn(obj.contents);
    }
}

// ---- Verbosity steering (append to the tail of the system prompt) ----

function steerSystemPrompt(obj: Record<string, unknown>, protocol: WireProtocol, level: number): boolean {
    const block = steeringText(level);
    if (!block) return false;
    switch (protocol) {
        case "anthropic": return steerAnthropicSystem(obj, block);
        case "openai": return steerOpenAiSystem(obj, block);
        case "responses": return steerResponsesInstructions(obj, block);
        case "google": return steerGoogleSystem(obj, block);
    }
}

function steerAnthropicSystem(obj: Record<string, unknown>, block: string): boolean {
    const sys = obj.system;
    if (sys === undefined) return false; // skip-if-absent: never fabricate a system prompt
    if (typeof sys === "string") {
        const [updated, changed] = replaceOrAppend(sys, block);
        if (changed) obj.system = updated;
        return changed;
    }
    if (Array.isArray(sys)) {
        for (const raw of sys) {
            const b = asRecord(raw);
            if (!b) continue;
            const t = typeof b.text === "string" ? b.text : "";
            if (t.startsWith(SENTINEL)) {
                if (t === block) return false;
                b.text = block;
                return true;
            }
        }
        (sys as unknown[]).push({ type: "text", text: block });
        return true;
    }
    return false;
}

function steerOpenAiSystem(obj: Record<string, unknown>, block: string): boolean {
    const msgs = obj.messages;
    if (!Array.isArray(msgs)) return false;
    const arr = msgs as Record<string, unknown>[];
    let target: Record<string, unknown> | null = null;
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m && typeof m === "object" && (m.role === "system" || m.role === "developer")) {
            target = m;
            break;
        }
    }
    if (!target) return false; // skip-if-absent
    const content = target.content;
    if (content === null || content === undefined) {
        target.content = block;
        return true;
    }
    if (typeof content === "string") {
        const [updated, changed] = replaceOrAppend(content, block);
        if (changed) target.content = updated;
        return changed;
    }
    if (Array.isArray(content)) {
        for (const raw of content) {
            const b = asRecord(raw);
            if (!b) continue;
            if (b.type === "text" && typeof b.text === "string" && b.text.startsWith(SENTINEL)) {
                if (b.text === block) return false;
                b.text = block;
                return true;
            }
        }
        (content as unknown[]).push({ type: "text", text: block });
        return true;
    }
    return false;
}

function steerResponsesInstructions(obj: Record<string, unknown>, block: string): boolean {
    const ins = obj.instructions;
    if (ins === undefined) return false; // skip-if-absent
    if (typeof ins !== "string") return false;
    const [updated, changed] = replaceOrAppend(ins, block);
    if (changed) obj.instructions = updated;
    return changed;
}

function steerGoogleSystem(obj: Record<string, unknown>, block: string): boolean {
    const si = asRecord(obj.systemInstruction);
    if (!si) return false; // skip-if-absent
    const parts = si.parts;
    if (!Array.isArray(parts)) return false;
    for (const raw of parts) {
        const p = asRecord(raw);
        if (!p) continue;
        const t = typeof p.text === "string" ? p.text : "";
        if (t.startsWith(SENTINEL)) {
            if (t === block) return false;
            p.text = block;
            return true;
        }
    }
    (parts as unknown[]).push({ text: block });
    return true;
}

// ---- Effort routing (clamp-only; never inject, never toggle thinking.type) ----

/** Documented API floor for Anthropic extended-thinking budget_tokens. */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
/** Assumed Gemini thinkingBudget floor; verify per-model before relying on it. */
const GOOGLE_MIN_THINKING_BUDGET = 128;

function lowerEffort(obj: Record<string, unknown>, protocol: WireProtocol): boolean {
    switch (protocol) {
        case "openai": {
            const e = obj.reasoning_effort;
            // "minimal" sits below "low" on the OpenAI scale — a client that
            // explicitly asked for it is already at/below our floor; raising it
            // would override client intent (clamp-only invariant).
            if (typeof e === "string" && e !== "low" && e !== "minimal") {
                obj.reasoning_effort = "low";
                return true;
            }
            return false;
        }
        case "responses": {
            const r = asRecord(obj.reasoning);
            if (!r) return false;
            const e = r.effort;
            // Same scale as OpenAI: "minimal" is already at/below the floor.
            if (typeof e === "string" && e !== "low" && e !== "minimal") {
                r.effort = "low";
                return true;
            }
            return false;
        }
        case "anthropic": {
            let changed = false;
            const oc = asRecord(obj.output_config);
            if (oc) {
                const e = oc.effort;
                if (typeof e === "string" && e !== "low") {
                    oc.effort = "low";
                    changed = true;
                }
            }
            const th = asRecord(obj.thinking);
            if (th && typeof th.budget_tokens === "number" && th.budget_tokens > ANTHROPIC_MIN_THINKING_BUDGET) {
                th.budget_tokens = ANTHROPIC_MIN_THINKING_BUDGET;
                changed = true;
            }
            return changed;
        }
        case "google": {
            const gc = asRecord(obj.generationConfig);
            const tc = gc ? asRecord(gc.thinkingConfig) : null;
            // -1 (dynamic) and values at/below the floor are left untouched.
            if (tc && typeof tc.thinkingBudget === "number" && tc.thinkingBudget > GOOGLE_MIN_THINKING_BUDGET) {
                tc.thinkingBudget = GOOGLE_MIN_THINKING_BUDGET;
                return true;
            }
            return false;
        }
    }
}

// ---- Entry points ----

/** Fallback wire detection when the caller has no resolved protocol (e.g. a
 *  passthrough forward where `prepared` is null): infer from the body shape. */
function detectProtocolFromBody(obj: Record<string, unknown>): WireProtocol | null {
    if (Array.isArray(obj.input)) return "responses";
    if (Array.isArray(obj.contents)) return "google";
    if (Array.isArray(obj.messages)) {
        // anthropic carries a top-level `system`; openai chat keeps it in messages
        return obj.system !== undefined ? "anthropic" : "openai";
    }
    return null;
}

export interface SteeringResult {
    body: string;
    changed: boolean;
    labels: string[];
}

/** Apply both levers to a serialized wire body. Returns the original string
 *  unchanged (no re-stringify) when nothing was mutated, so the default path
 *  stays byte-identical. Idempotent — safe to re-run on retry re-sends. */
export function applyOutputSteering(body: string, protocol: WireProtocol | null, cfg: OutputSteeringConfig): SteeringResult {
    if (!cfg.enabled) return { body, changed: false, labels: [] };
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return { body, changed: false, labels: [] };
    }
    const proto = protocol ?? detectProtocolFromBody(obj);
    if (!proto) return { body, changed: false, labels: [] };
    const labels = applyOutputSteeringJson(obj, proto, cfg);
    if (labels.length === 0) return { body, changed: false, labels: [] };
    return { body: JSON.stringify(obj), changed: true, labels };
}

/** Object-level variant shared by the forward boundary and the compress-retry
 *  re-send paths. Mutates `parsed` in place; returns the applied labels. */
export interface ApplySteeringOptions {
    /** Skip the verbosity directive while keeping effort routing. Used by the
     *  kernel's compress rounds: the L2/L3 directive ("never restate code, file
     *  contents, diffs, or tool output …") directly contradicts the compress
     *  prompt's own contract — summaries must preserve exact paths, values and
     *  commands verbatim because they are the primary carrier on decompress. */
    verbosity?: boolean;
}

export function applyOutputSteeringJson(parsed: Record<string, unknown>, protocol: WireProtocol | null, cfg: OutputSteeringConfig, opts: ApplySteeringOptions = {}): string[] {
    if (!cfg.enabled) return [];
    const proto = protocol ?? detectProtocolFromBody(parsed);
    if (!proto) return [];
    const labels: string[] = [];
    if (opts.verbosity !== false && cfg.verbosityLevel > 0 && steerSystemPrompt(parsed, proto, cfg.verbosityLevel)) {
        labels.push(`steering:L${cfg.verbosityLevel}`);
    }
    if (cfg.effortRouting && classifyTurn(proto, parsed) === "mechanical_continuation" && lowerEffort(parsed, proto)) {
        labels.push("effort:low");
    }
    return labels;
}
