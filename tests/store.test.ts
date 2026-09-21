import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import {
    applyStoreView,
    effectiveStoreConfig,
    ensureStored,
    executeRetrieve,
    storeEffectiveStore,
} from "../src/store.ts";
import { RETRIEVE_TOOL_NAME } from "../src/compress-tool.ts";
import { getSession, type Session } from "../src/session.ts";

// Route every sidecar write to a throwaway dir and disable session-file
// persistence so these unit tests never touch the real data/state trees.
const STORE_TMP = mkdtempSync(path.join(tmpdir(), "bili-store-test-"));
process.env.BILI_STORE_DIR = STORE_TMP;
process.env.BILI_PERSIST = "0";

const BIG_TEXT = "line of build output ".repeat(700);

function toolResult(): CoreMessage[] {
    return [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text: BIG_TEXT },
    ];
}

// Build a session whose messageRefs map the tool-result raw id to a kernel ref,
// mirroring the live pipeline (processTurn assigns the refs we later cite).
function makeSession(withStore: boolean): { session: Session; ref: string } {
    const session = getSession(`t-store-${Math.random().toString(36).slice(2)}`);
    const core = createCore();
    const turn = core.processTurn({ messages: toolResult(), state: createInitialState(), config: defaultConfig(200000), tokenCount: 0, renderTags: "text-only" });
    session.state.messageRefs = turn.state.messageRefs;
    const ref = Object.entries(turn.state.messageRefs.byRef ?? {}).find(([, raw]) => raw === "t-res")?.[0] ?? "";
    storeEffectiveStore(session, withStore ? { enabled: true, minTokens: 500 } : { enabled: false });
    return { session, ref };
}

function findSidecar(hash: string): string | null {
    for (const d of readdirSync(STORE_TMP)) {
        const p = path.join(STORE_TMP, d, `${hash}.txt`);
        if (existsSync(p)) return p;
    }
    return null;
}

test("effectiveStoreConfig reflects the stamped policy", () => {
    assert.equal(effectiveStoreConfig(makeSession(false).session)?.enabled, false);
    assert.equal(effectiveStoreConfig(makeSession(true).session)?.enabled, true);
    assert.equal(effectiveStoreConfig(undefined), undefined);
});

test("ensureStored: stores large content once, idempotent, skips small/disabled", () => {
    const { session, ref } = makeSession(true);
    const e1 = ensureStored(session, ref, BIG_TEXT, "bash");
    assert.ok(e1 && e1.tokens > 500 && e1.bytes > 0);
    assert.equal(e1!.hash.length, 40);
    assert.equal(ensureStored(session, ref, BIG_TEXT, "bash"), e1);
    assert.equal(ensureStored(session, "m00002", "tiny", "bash"), null);
    assert.equal(ensureStored(makeSession(false).session, ref, BIG_TEXT, "bash"), null);
});

test("applyStoreView replaces the oversized tool result with a stable placeholder, pairing intact", () => {
    const { session, ref } = makeSession(true);
    const out = applyStoreView(toolResult(), session);
    const res = out.find((m) => m.id === "t-res")!;
    assert.match(res.text!, new RegExp(`stored #${ref}`));
    assert.match(res.text!, new RegExp(RETRIEVE_TOOL_NAME));
    assert.notEqual(res.text, BIG_TEXT);
    assert.equal(res.role, "tool");
    assert.equal(res.contentType, "tool-result");
    assert.equal(res.toolCallId, "call_1");
    assert.equal(out.find((m) => m.id === "a-tc")!.text, JSON.stringify({ command: "npm run build" }));
    const again = applyStoreView(toolResult(), session);
    assert.equal(again.find((m) => m.id === "t-res")!.text, res.text);
});

test("applyStoreView is a no-op when the store is disabled", () => {
    const { session } = makeSession(false);
    const out = applyStoreView(toolResult(), session);
    assert.equal(out.find((m) => m.id === "t-res")!.text, BIG_TEXT);
});

test("executeRetrieve round-trips the original; a bad ref self-corrects", () => {
    const { session, ref } = makeSession(true);
    ensureStored(session, ref, BIG_TEXT, "bash");
    const got = executeRetrieve({ ref }, session);
    assert.ok(got.includes(BIG_TEXT.slice(0, 80)));
    assert.equal(session.stats.retrieveCalls, 1);
    assert.equal(session.stats.retrieveHits, 1);
    const miss = executeRetrieve({ ref: "m99999" }, session);
    assert.match(miss, /not found/);
    assert.equal(session.stats.retrieveMisses, 1);
    assert.equal(session.stats.retrieveCalls, 2);
});

test("sidecar is written to disk under storeDir and the index lands in session.metadata", () => {
    const { session, ref } = makeSession(true);
    const e = ensureStored(session, ref, BIG_TEXT, "bash")!;
    const file = findSidecar(e.hash);
    assert.ok(file, "sidecar file was written under storeDir");
    assert.equal(readFileSync(file!, "utf8"), BIG_TEXT);
    const idx = session.metadata.storeIndex as Record<string, { hash: string }>;
    assert.equal(idx[ref].hash, e.hash);
    assert.ok(!JSON.stringify(idx).includes(BIG_TEXT.slice(0, 40)), "index holds metadata only, never payload bytes");
});
