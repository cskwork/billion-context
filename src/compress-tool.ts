/**
 * ACP tool surface — thin re-export from acp-kernel (Phase K1).
 *
 * The schemas, prompt builders, text tags and parseCompressInput moved to
 * acp-kernel `src/compress-tools.ts` verbatim; this module keeps the proxy's
 * historical import paths and names stable:
 *  - PROXY_TOOL_NAMES / MUTATING_PROXY_TOOLS / READONLY_PROXY_TOOLS alias the
 *    kernel's ACP_* names ("proxy" is a misnomer once shared);
 *  - parseCompressInput wires the kernel's onWarn hook into the proxy logger
 *    and adds the #603 quote-salvage fallback (single→double quote repair)
 *    for the one malformation class the kernel ladder does not cover.
 */
import { parseCompressArgs, ABSORB_TOOL_OPENAI } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { maxShrinkPerCompress } from "./fetch-util.js";

export {
    COMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_NAME,
    SEARCH_CONTEXT_TOOL_NAME,
    ACP_STATUS_TOOL_NAME,
    ACP_TEXT_OPEN,
    ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN,
    ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN,
    ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN,
    ACP_DECOMPRESS_CLOSE,
    COMPRESS_TOOL,
    COMPRESS_TOOL_OPENAI,
    COMPRESS_TOOL_RESPONSES,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_RESPONSES,
    ACP_READONLY_TOOLS_RESPONSES,
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
    ABSORB_TOOL_NAME,
    ABSORB_TOOL,
    ABSORB_TOOL_OPENAI,
    buildAbsorbSystemPrompt,
} from "acp-kernel";
export type { ParsedRange, AbsorbConfig } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

// The kernel ships no Responses-format absorb const (the four ACP tools have
// *_RESPONSES variants; absorb is host-registered opt-in). Synthesize it in
// the same flat shape as SEARCH_CONTEXT_TOOL_RESPONSES.
export const ABSORB_TOOL_RESPONSES = {
    type: "function",
    name: ABSORB_TOOL_OPENAI.function.name,
    description: ABSORB_TOOL_OPENAI.function.description,
    parameters: ABSORB_TOOL_OPENAI.function.parameters,
};

export function parseCompressInput(input: unknown, callId?: string) {
    const first = parseCompressArgs(input, { callId });
    // #603: the kernel ladder covers fences, trailing commas, raw newlines,
    // double-stringification and truncated/prose-wrapped arrays — but not
    // single-quoted JSON (the class weak local models actually emit, omp#121).
    // Retry once with quotes normalized; keep whichever pass recovered more.
    if (first.ranges.length === 0 || first.diagnostics.invalidItems > 0) {
        const normalized = normalizeQuoteShape(input);
        if (normalized !== undefined) {
            const retry = parseCompressArgs(normalized, { callId });
            if (retry.ranges.length > first.ranges.length) {
                loggerLog("warn", `[acp-compress-input] quote-salvage: recovered ${retry.ranges.length} range(s) after single->double quote normalization (was ${first.ranges.length}, kind=${first.diagnostics.kind})`);
                return { ranges: retry.ranges, diagnostics: retry.diagnostics };
            }
        }
    }
    if (!first.diagnostics.ok && first.diagnostics.kind !== "ok") {
        loggerLog("warn", `[acp-compress-input] rejected: kind=${first.diagnostics.kind} invalidItems=${first.diagnostics.invalidItems}${first.diagnostics.keys ? ` keys=[${first.diagnostics.keys.join(",")}]` : ""}${first.diagnostics.length !== undefined ? ` len=${first.diagnostics.length}` : ""}${first.diagnostics.invalidReasons && first.diagnostics.invalidReasons.length > 0 ? ` reasons=[${first.diagnostics.invalidReasons.join(" | ")}]` : ""}`);
    }
    return { ranges: first.ranges, diagnostics: first.diagnostics };
}

// #603: quote-shape salvage. Weak models emit single-quoted JSON args
// ({'content': [...]}) or a single-quoted array as a stringified content
// value; both hard-fail strict parsing and waste the round. This is a pure
// text repair — it never invents structure, so anything it cannot make into
// valid JSON simply stays unrecovered (the existing reject path applies).
function normalizeQuoteShape(input: unknown): unknown {
    if (typeof input === "string") return normalizeSingleQuotes(input);
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
        const obj = input as Record<string, unknown>;
        if (typeof obj["content"] === "string") {
            const fixed = normalizeSingleQuotes(obj["content"]);
            if (fixed !== undefined) return { ...obj, content: fixed };
        }
    }
    return undefined;
}

// State machine that converts single-quoted strings to double-quoted ones.
// Apostrophes inside double-quoted strings are data and are copied verbatim;
// control characters inside single-quoted regions become JSON escapes.
// Returns undefined when nothing was converted (input unchanged).
function normalizeSingleQuotes(raw: string): string | undefined {
    if (!raw.includes("'") || (!raw.includes("{") && !raw.includes("["))) return undefined;
    let out = "";
    let changed = false;
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw.charAt(i);
        if (inDouble) {
            out += ch;
            if (ch === "\\" && i + 1 < raw.length) {
                out += raw.charAt(i + 1);
                i++;
            } else if (ch === '"') {
                inDouble = false;
            }
            continue;
        }
        if (inSingle) {
            if (ch === "\\" && i + 1 < raw.length) {
                const next = raw.charAt(i + 1);
                out += next === "'" ? "'" : "\\" + next;
                i++;
                continue;
            }
            if (ch === "'") {
                out += '"';
                inSingle = false;
                changed = true;
                continue;
            }
            if (ch === '"') {
                out += '\\"';
                continue;
            }
            if (ch === "\n") {
                out += "\\n";
                continue;
            }
            if (ch === "\r") {
                out += "\\r";
                continue;
            }
            if (ch === "\t") {
                out += "\\t";
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            out += ch;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            out += '"';
            changed = true;
            continue;
        }
        out += ch;
    }
    return changed ? out : undefined;
}

// #189 staged-compression / prefix-survival guidance, appended to the nudge
// text ONLY when BILI_MAX_SHRINK_PER_COMPRESS is set (the "smooth transition"
// switch). It steers the model — at the moment it is choosing the range —
// toward smaller, tail-biased folds so the stable prefix (m00001..foldPoint)
// survives for prefix caching and each round's request-shape change stays
// gentle (the sharp change is what trips provider risk-control, GLM 3007).
const STAGED_COMPRESS_GUIDANCE =
    "\n\n[Smooth-transition guidance: when you compress, prefer a SMALLER, TAIL-biased range — compress the most recent large content and keep the stable prefix (the earliest messages) intact. A large single rewrite changes the request shape sharply and can trip provider risk-control; smaller tail-biased folds keep the prefix cache alive and the transition gentle.]";

/** Append the staged-compress guidance to a rendered nudge text. Returns the
 *  input unchanged when the smooth-transition switch is off (default). */
export function withStagedCompressGuidance(text: string): string {
    if (maxShrinkPerCompress() === undefined) return text;
    return text + STAGED_COMPRESS_GUIDANCE;
}
