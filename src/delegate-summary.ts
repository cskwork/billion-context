import type { CoreMessage } from "acp-kernel";
import { COMPRESS_TOOL_NAME } from "./compress-tool.js";
import { renderRangeContent, summarizeRenderedRange, type PreflightDeps } from "./preflight.js";
import { recordCompressFailure } from "./stream.js";
import { UpstreamHttpError } from "./fetch-util.js";

// Delegated summary mode (compress.delegateSummary): in proxy mode the main
// model only CHOOSES ranges; the proxy writes each summary with the
// configured summary model through the same machinery preflight uses
// (renderRangeContent + summarizeRange). Plugin mode is out of scope — the
// agent executes compress there and never reaches this module.

const DELEGATED_COMPRESS_DESCRIPTION =
    "Fold consumed conversation ranges, identified by their refs. Choose the ranges only — do NOT write summaries: the proxy writes each range's summary itself with a dedicated summary model. content = one entry per range: an object {startId, endId, topic?} or a one-line string 'm00150–m00220 optional topic'. Use when content is genuinely consumed. REQUIRED — compress without content is invalid.";

const DELEGATED_COMPRESS_SCHEMA = {
    type: "object",
    properties: {
        content: {
            type: "array",
            description: "One entry per range to fold. Object form {startId, endId, topic?} or a one-line string 'm00150–m00220 optional topic'. No summaries — the proxy writes them.",
            items: {
                anyOf: [
                    { type: "string", description: "One line: 'm00150–m00220 optional topic' (no summary)" },
                    {
                        type: "object",
                        properties: {
                            startId: { type: "string", description: "mNNNNN ref at the start of the range" },
                            endId: { type: "string", description: "mNNNNN ref at the end of the range" },
                            topic: { type: "string", description: "Optional short title for the range" },
                        },
                        required: ["startId", "endId"],
                    },
                ],
            },
        },
    },
    required: ["content"],
};

const DELEGATED_SUMMARY_NOTE =
    "\n\n[Delegated summaries: in this session you only choose WHAT to compress. Call compress with the ranges (startId/endId, optional topic) and no summary text — the proxy writes every summary itself with a dedicated summary model. Ignore any instruction above about writing summaries yourself.]";

export function withDelegatedSummaryNote(text: string, delegate: boolean | undefined): string {
    return delegate ? text + DELEGATED_SUMMARY_NOTE : text;
}

type ToolLike = { name?: unknown; function?: { name?: unknown }; input_schema?: unknown; parameters?: unknown; description?: unknown };

/** Swap the compress tool's description + schema for the ranges-only variant,
 *  in whichever wire shape it arrives (Anthropic input_schema, OpenAI chat
 *  function.parameters, Responses flat parameters). Other tools pass through
 *  untouched. Applied after pack tool-prompt overrides so the delegated
 *  wording wins. */
export function delegatedCompressTools<T>(tools: T[], delegate: boolean | undefined): T[] {
    if (!delegate) return tools;
    return tools.map((tool) => {
        const t = tool as ToolLike;
        if (t.function && t.function.name === COMPRESS_TOOL_NAME) {
            return { ...t, function: { ...t.function, description: DELEGATED_COMPRESS_DESCRIPTION, parameters: DELEGATED_COMPRESS_SCHEMA } } as T;
        }
        if (t.name !== COMPRESS_TOOL_NAME) return tool;
        if (t.input_schema !== undefined) return { ...t, description: DELEGATED_COMPRESS_DESCRIPTION, input_schema: DELEGATED_COMPRESS_SCHEMA } as T;
        return { ...t, description: DELEGATED_COMPRESS_DESCRIPTION, parameters: DELEGATED_COMPRESS_SCHEMA } as T;
    });
}

const HEADER_LINE_RE = /^(m\d+)\s*(?:–|—|-|\.\.|~)\s*(m\d+)(?:\s+(.*))?$/i;

type Pending = { index: number; startRef: string; endRef: string; topic?: string };

function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

function hasSummary(entry: Record<string, unknown>): boolean {
    return typeof entry.summary === "string" && entry.summary.trim().length > 0;
}

function contentArray(args: Record<string, unknown>): unknown[] | undefined {
    const content = args.content;
    if (Array.isArray(content)) return content;
    if (typeof content === "string") {
        try {
            const parsed: unknown = JSON.parse(content);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** Entries that need a proxy-written summary: objects with refs and no (or a
 *  blank) summary, and bare one-line header strings not followed by a
 *  legacy summary-only string element. Everything else is left for the
 *  kernel parser verbatim. */
function pendingEntries(entries: unknown[]): Pending[] {
    const out: Pending[] = [];
    entries.forEach((entry, index) => {
        if (typeof entry === "string") {
            const line = entry.trim();
            if (line.includes("\n")) return;
            const m = HEADER_LINE_RE.exec(line);
            if (!m) return;
            const next = entries[index + 1];
            if (typeof next === "string" && !HEADER_LINE_RE.test(next.trim().split("\n")[0] ?? "")) return;
            out.push({ index, startRef: m[1].toLowerCase(), endRef: m[2].toLowerCase(), ...(m[3] ? { topic: m[3].trim() } : {}) });
            return;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const e = entry as Record<string, unknown>;
        if (hasSummary(e) || typeof e.startId !== "string" || typeof e.endId !== "string") return;
        out.push({ index, startRef: e.startId.trim(), endRef: e.endId.trim(), ...(typeof e.topic === "string" && e.topic.trim() ? { topic: e.topic.trim() } : {}) });
    });
    return out;
}

export type DelegateDeps = Omit<PreflightDeps, "compressionTarget" | "imageFloor" | "wireOverhead" | "unknownBaseline">;

const DELEGATE_REASON = "the main model selected it for compression and delegated the summary to you";

/** Fill the missing summaries of a compress call via the summary model.
 *  Returns the rewritten args (ready for the normal kernel path), or a
 *  `[Compression FAILED …]` tool result when any delegated summary could not
 *  be produced — nothing is folded then, so no content is dropped. */
export async function fillDelegatedSummaries(
    args: Record<string, unknown>,
    messages: CoreMessage[],
    deps: DelegateDeps,
): Promise<{ args: Record<string, unknown> } | { error: string }> {
    const single = args.content === undefined && typeof args.startId === "string" && typeof args.endId === "string";
    const entries = single ? [args] : contentArray(args);
    if (!entries) return { args };
    const pending = pendingEntries(entries);
    if (pending.length === 0) return { args };
    const filled = [...entries];
    const failures: string[] = [];
    for (const p of pending) {
        const [lo, hi] = refNum(p.startRef) > refNum(p.endRef) ? [p.endRef, p.startRef] : [p.startRef, p.endRef];
        const rendered = renderRangeContent(deps.core, messages, deps.session.state, deps.config, lo, hi);
        if (!rendered.planned || rendered.content.length === 0) {
            failures.push(`${p.startRef}–${p.endRef}: ${(rendered.errors ?? []).join("; ") || "range has no compressible content"}`);
            continue;
        }
        try {
            const outcome = await summarizeRenderedRange(deps, rendered.content, lo, hi, DELEGATE_REASON);
            if ("unusable" in outcome) {
                failures.push(`${p.startRef}–${p.endRef}: summary model produced no usable summary (${outcome.unusable.slice(0, 200)})`);
                continue;
            }
            filled[p.index] = { startId: p.startRef, endId: p.endRef, summary: outcome.summary, ...(p.topic ? { topic: p.topic } : {}) };
        } catch (err) {
            deps.signal?.throwIfAborted();
            const why = err instanceof UpstreamHttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err);
            failures.push(`${p.startRef}–${p.endRef}: summary call failed (${why})`);
        }
    }
    if (failures.length > 0) {
        deps.log("warn", `[delegate-summary] ${failures.length}/${pending.length} delegated summary(ies) failed: ${failures.join(" | ")}`);
        const guard = recordCompressFailure(deps.session, `delegate:${failures.join("|")}`, "Pick a different or smaller range, or continue the task without compressing.");
        return { error: `[Compression FAILED: the proxy could not write the delegated summary for ${failures.length} of ${pending.length} range(s); nothing was compressed. ${failures.join(" | ")}${guard}]` };
    }
    deps.log("info", `[delegate-summary] wrote ${pending.length} summary(ies) for compress: ${pending.map((p) => `${p.startRef}–${p.endRef}`).join(", ")}`);
    return { args: single ? (filled[0] as Record<string, unknown>) : { ...args, content: filled } };
}
