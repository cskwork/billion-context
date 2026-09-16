import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { cacheBlockContent, type Session } from "../src/session.ts";
import { renderHandoff } from "../src/export.ts";
import { createInitialState } from "acp-kernel";

// #841: bili export must guarantee every active block's summary appears in the
// handoff doc even when the persisted folded snapshot was truncated by
// BILI_PERSIST_TAIL_TOKENS and no longer carries that block's summary.

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://up:1", title: "export summaries" },
        stats: { requests: 5, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, cacheSamples: 0, lastInputTokens: 10, contextTokens: 5000 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function withBlock(s: Session, summary: string): void {
    s.state.blocks.push({
        blockId: "b0", runId: "r0", tier: 1, topic: "old design decision",
        summary,
        directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 900, createdAt: Date.now() - 5000, survivedCount: 2, generation: 1, active: true,
    });
    cacheBlockContent(s, "b0", {
        one: null,
        full: { text: "user: why did we drop plan A\nassistant: prefix cache breakage", count: 2 },
    });
}

async function persistAndRestore(s: Session, dir: string): Promise<Session> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    await store.writeNow(s);
    const restored = (await store.loadAll()).get(s.id);
    assert.ok(restored, "session not restored");
    return restored!;
}

async function withTailEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.BILI_PERSIST_TAIL_TOKENS;
    if (value === undefined) delete process.env.BILI_PERSIST_TAIL_TOKENS;
    else process.env.BILI_PERSIST_TAIL_TOKENS = value;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_PERSIST_TAIL_TOKENS;
        else process.env.BILI_PERSIST_TAIL_TOKENS = prev;
    }
}

test("#841 truncated snapshot: export renders the active block summary missing from the tail", async () => {
    const MARKER = "TRUNCATED-TAIL-SUMMARY-MARKER";
    await withTailEnv("40", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-export-sum-"));
        try {
            const s = makeSession("sum-truncated");
            withBlock(s, `${MARKER}: plan A was abandoned because it broke the prefix cache and forced a full re-tokenize on every request, which made latency unacceptable for the interactive loop.`);
            const filler = (t: string) => `${t} ${"x".repeat(300)}`;
            s.lastMessages = [
                { id: "m0", role: "user", contentType: "text", text: filler("opening question") },
                { id: "m1", role: "user", contentType: "text", text: filler("covered q1") },
                { id: "m2", role: "assistant", contentType: "text", text: filler("covered a1") },
                { id: "m3", role: "user", contentType: "text", text: filler("mid question") },
                { id: "m4", role: "assistant", contentType: "text", text: filler("mid answer") },
                { id: "m5", role: "user", contentType: "text", text: filler("recent question") },
                { id: "m6", role: "assistant", contentType: "text", text: filler("recent answer") },
            ];
            const restored = await persistAndRestore(s, dir);
            assert.equal(restored.lastMessagesFolded, true);
            assert.ok(!JSON.stringify(restored.lastMessages).includes(MARKER), "precondition: summary truncated out of the persisted snapshot");

            const md = renderHandoff(restored, false);
            assert.match(md, /## Compressed block summaries/);
            assert.match(md, new RegExp(MARKER), "summary missing from plain export of a truncated-snapshot session");
            assert.match(md, /### Block b0 — old design decision/);
            assert.match(md, /tier 1 · ~900 tokens compressed/);
            assert.doesNotMatch(md, /prefix cache breakage/, "plain export must not leak compressed originals");

            const full = renderHandoff(restored, true);
            assert.match(full, new RegExp(MARKER));
            assert.match(full, /Original messages \(2\)/);
            assert.match(full, /prefix cache breakage/, "--full must recover the block originals");
            assert.equal(full.match(new RegExp(MARKER, "g"))!.length, 1, "summary duplicated in --full export");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#841 untruncated snapshot: summary already in the view is not repeated", async () => {
    const MARKER = "IN-TAIL-SUMMARY-MARKER";
    await withTailEnv(undefined, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-export-sum-"));
        try {
            const s = makeSession("sum-intail");
            withBlock(s, `${MARKER}: covered early messages about the old work.`);
            s.lastMessages = [
                { id: "m1", role: "user", contentType: "text", text: "OLD-ORIGINAL-one" },
                { id: "m2", role: "assistant", contentType: "text", text: "OLD-ORIGINAL-two" },
                { id: "m3", role: "user", contentType: "text", text: "TAIL-QUESTION" },
            ];
            const restored = await persistAndRestore(s, dir);
            assert.equal(restored.lastMessagesFolded, true);

            const md = renderHandoff(restored, false);
            assert.equal(md.match(new RegExp(MARKER, "g"))!.length, 1, "inline snapshot summary must not be duplicated by the block section");

            const full = renderHandoff(restored, true);
            assert.equal(full.match(new RegExp(MARKER, "g"))!.length, 1, "--full entry must keep the single inline copy, not re-print the body");
            assert.match(full, /Original messages \(2\)/);
            assert.match(full, /prefix cache breakage/, "--full entry must still recover the dropped covered original");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#841 live non-folded session: prune-injected summaries stay single, no extra section", () => {
    const MARKER = "LIVE-SUMMARY-MARKER";
    const s = makeSession("sum-live");
    withBlock(s, `${MARKER}: early exchange about the design decision.`);
    s.lastMessages = [
        { id: "m1", role: "user", contentType: "text", text: "early question" },
        { id: "m2", role: "assistant", contentType: "text", text: "early answer" },
        { id: "m3", role: "user", contentType: "text", text: "later question" },
        { id: "m4", role: "assistant", contentType: "text", text: "later answer" },
    ];

    const md = renderHandoff(s, false);
    assert.equal(md.match(new RegExp(MARKER, "g"))!.length, 1, "prune already injects the summary into the folded view");
    assert.doesNotMatch(md, /## Compressed block summaries/, "nothing missing from the view — no section needed");

    const full = renderHandoff(s, true);
    assert.equal(full.match(new RegExp(MARKER, "g"))!.length, 1, "--full shows raw history plus exactly one summary copy");
    assert.doesNotMatch(full, /Original messages \(/, "non-folded history already carries the originals — no recovery section");
});
