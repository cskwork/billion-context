import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchSession as matchSessionKernel, renderHandoff as renderHandoffKernel } from "acp-kernel";
import type { Session } from "./session.js";
import { SessionStore } from "./persist.js";

export interface ExportOptions {
    dir?: string;
    output?: string;
    full?: boolean;
}

export interface SessionSummary {
    id: string;
    title?: string;
    label?: string;
    protocol?: string;
    upstreamOrigin?: string;
    savedAt?: number;
    contextTokens?: number;
    blocks: number;
}

function fmtDate(ms: number | undefined): string {
    return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

export async function listSessions(opts: ExportOptions = {}): Promise<SessionSummary[]> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    const sessions = [...(await store.loadAll()).values()];
    sessions.sort((a, b) => latestBlockTime(b) - latestBlockTime(a));
    return sessions.map((s) => ({
        id: s.id,
        title: s.meta.title,
        label: s.meta.label,
        protocol: s.meta.protocol,
        upstreamOrigin: s.meta.upstreamOrigin,
        savedAt: latestBlockTime(s) || undefined,
        contextTokens: s.stats.contextTokens,
        blocks: s.state.blocks.length,
    }));
}

function latestBlockTime(s: Session): number {
    let latest = 0;
    for (const b of s.state.blocks) if (b.createdAt > latest) latest = b.createdAt;
    return latest;
}

/** Unified per-block handoff section (#841): guarantees every active block's
 *  summary appears at least once in the doc. A summary already rendered inside
 *  the conversation view (a recent block that survived the persisted tail
 *  window) is not repeated; --full recovers the originals dropped from a
 *  folded snapshot under the same block entry. */
function renderBlockSection(s: Session, viewedText: string, full: boolean, folded: boolean): string[] {
    const lines: string[] = [];
    const recoverOriginals = full && folded;
    for (const b of s.state.blocks) {
        if (!b.active) continue;
        const content = s.blockContents.get(b.blockId);
        const summary = b.summary.trim();
        const summaryInView = summary.length > 0 && viewedText.includes(summary);
        if (summaryInView && !(recoverOriginals && content)) continue;
        lines.push(`### Block ${b.blockId}${b.topic ? ` — ${b.topic}` : ""}`);
        lines.push("");
        lines.push(`tier ${b.tier} · ~${b.compressedTokens} tokens compressed · ${fmtDate(b.createdAt)}`);
        lines.push("");
        if (!summaryInView) {
            lines.push(summary);
            lines.push("");
        }
        if (recoverOriginals && content) {
            lines.push(`#### Original messages (${content.full.count})`);
            lines.push("");
            lines.push(content.full.text.trim());
            lines.push("");
        }
    }
    if (lines.length === 0) return lines;
    return ["## Compressed block summaries", "", ...lines];
}

export function renderHandoff(s: Session, full: boolean): string {
    const messages = s.lastMessages;
    if (messages && messages.length > 0) {
        const folded = s.lastMessagesFolded === true;
        const kernelMd = renderHandoffKernel({
            coreMessages: messages,
            state: s.state,
            full,
            folded,
            meta: {
                title: s.meta.title,
                label: s.meta.label,
                sessionId: s.id,
                contextTokens: s.stats.contextTokens,
                extraBullets: [
                    ...(s.meta.protocol ? [`- protocol: ${s.meta.protocol}`] : []),
                    ...(s.meta.upstreamOrigin ? [`- upstream: ${s.meta.upstreamOrigin}`] : []),
                    `- requests: ${s.stats.requests}`,
                ],
            },
        });
        const section = renderBlockSection(s, kernelMd, full, folded);
        return section.length > 0 ? `${kernelMd}\n${section.join("\n")}` : kernelMd;
    }

    // v2 fallback: no snapshot persisted. Block summaries (+ originals with
    // --full from the blockContents cache) are all that is recoverable offline.
    const lines: string[] = [];
    lines.push(`# billion-context session handoff`);
    lines.push("");
    lines.push(`- title: ${s.meta.title ?? "(untitled)"}`);
    if (s.meta.label) lines.push(`- label: ${s.meta.label}`);
    lines.push(`- session id: ${s.id}`);
    if (s.meta.protocol) lines.push(`- protocol: ${s.meta.protocol}`);
    if (s.meta.upstreamOrigin) lines.push(`- upstream: ${s.meta.upstreamOrigin}`);
    lines.push(`- requests: ${s.stats.requests}`);
    if (s.stats.contextTokens) lines.push(`- last context tokens: ~${s.stats.contextTokens}`);
    lines.push(`- compression blocks: ${s.state.blocks.length} (active ${s.state.blocks.filter((b) => b.active).length})`);
    lines.push("");
    const active = s.state.blocks.filter((b) => b.active);
    if (active.length === 0) {
        lines.push("No active compression blocks and no persisted conversation snapshot (v2 session file). Original messages are only persisted when they are compressed into a block, so this session's conversation content is not available for export.");
        lines.push("");
    }
    lines.push(...renderBlockSection(s, "", full, true));
    if (active.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push("Paste the block summaries above into a new session to continue without the proxy.");
        lines.push("");
    }
    return lines.join("\n");
}

function matchSession(sessions: Session[], selector: string): Session[] {
    return matchSessionKernel(sessions, selector, (s) => s.meta.label);
}

export async function exportSession(selector: string | undefined, opts: ExportOptions = {}): Promise<string> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    const all = [...(await store.loadAll()).values()];
    if (all.length === 0) {
        return "No persisted sessions found. Sessions are written under the sessions directory once the proxy has served a request (compression state, compressed originals, and a bounded folded-view snapshot of the recent conversation).";
    }
    if (!selector) {
        const list = await listSessions(opts);
        const rows = list.map((s) =>
            `${s.id}${s.label ? `  label=${s.label}` : ""}${s.protocol ? `  [${s.protocol}]` : ""}  blocks=${s.blocks}${s.contextTokens ? `  ctx~${s.contextTokens}` : ""}  ${s.title ?? ""}`
        );
        return ["Persisted sessions:", "", ...rows.map((r) => `  ${r}`), "", "Usage: bili export <session-id|label> [--output handoff.md] [--full]"].join("\n");
    }
    const matches = matchSession(all, selector);
    if (matches.length === 0) {
        throw new Error(`no session matches "${selector}" (run "bili export" to list sessions)`);
    }
    if (matches.length > 1) {
        const ids = matches.map((s) => s.id).join(", ");
        throw new Error(`selector "${selector}" matches ${matches.length} sessions (${ids}); use the full session id`);
    }
    const markdown = renderHandoff(matches[0]!, opts.full ?? false);
    if (opts.output) {
        mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        writeFileSync(opts.output, markdown, "utf8");
        return `written to ${opts.output}`;
    }
    return markdown;
}
