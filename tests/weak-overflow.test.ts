import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { noteWeakOverflow, resetWeakOverflow, resolveConfirmedLimit, resolveLearnedLimit, retractStaleLearnedLimits } from "../src/weak-overflow.ts";
import type { Session } from "../src/session.ts";

const ids: string[] = [];

function makeSession(window: number, learned?: number): Session {
    const metadata: Record<string, unknown> = { effectiveContextLimit: window };
    if (learned !== undefined) metadata.learnedContextLimit = learned;
    const session = {
        id: `weak-${Math.random().toString(36).slice(2, 8)}`,
        metadata,
        stats: { lastInputTokens: 0 },
    } as unknown as Session;
    ids.push(session.id);
    return session;
}

beforeEach(() => {
    for (const id of ids) resetWeakOverflow(id);
    ids.length = 0;
});

test("low usage is ignored entirely", () => {
    const session = makeSession(100000);
    for (let i = 0; i < 10; i++) noteWeakOverflow(session, { inputTokens: 50000, reason: "test" });
    assert.equal(session.metadata.learnedContextLimit, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 0);
});

test("three high-usage events learn a conservative window and arm emergency", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 96000, reason: "r2" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "not before the 3rd event");
    noteWeakOverflow(session, { inputTokens: 97000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 97000, "learns the LAST failing input size");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 97000, "emergency shrink armed");
});

test("model-scoped learning lands in learnedContextLimits", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r3" });
    assert.deepEqual(session.metadata.learnedContextLimits, { qwen: 95000 });
    assert.equal(session.metadata.learnedContextLimit, undefined);
});

test("shrink-only: never grows a previously learned smaller window", () => {
    const session = makeSession(100000, 50000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 50000, "smaller learned value wins");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 95000, "emergency shrink still armed");
});

test("events older than the window do not accumulate", () => {
    const session = makeSession(100000);
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
        t += 16 * 60 * 1000;
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r2" });
        t += 1000;
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r3" });
        assert.equal(session.metadata.learnedContextLimit, undefined, "only r2+r3 are in the window — 2 < 3");
    } finally {
        Date.now = realNow;
    }
});

test("unknown window disables the signal", () => {
    const session = makeSession(0);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r" });
    assert.equal(session.metadata.learnedContextLimit, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 0);
});

test("falls back to lastInputTokens when inputTokens is absent", () => {
    const session = makeSession(100000);
    (session.stats as { lastInputTokens: number }).lastInputTokens = 92000;
    noteWeakOverflow(session, { reason: "r1" });
    noteWeakOverflow(session, { reason: "r2" });
    noteWeakOverflow(session, { reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 92000);
});

function makeSessionWithMaps(opts: {
    window?: number;
    learnedMap?: Record<string, number>;
    confirmedMap?: Record<string, number>;
    learnedScalar?: number;
    confirmedScalar?: number;
    lastInput?: number;
}): Session {
    const metadata: Record<string, unknown> = { effectiveContextLimit: opts.window ?? 140000 };
    if (opts.learnedMap) metadata.learnedContextLimits = opts.learnedMap;
    if (opts.confirmedMap) metadata.confirmedContextLimits = opts.confirmedMap;
    if (opts.learnedScalar !== undefined) metadata.learnedContextLimit = opts.learnedScalar;
    if (opts.confirmedScalar !== undefined) metadata.confirmedContextLimit = opts.confirmedScalar;
    const session = {
        id: `weak-${Math.random().toString(36).slice(2, 8)}`,
        metadata,
        stats: { lastInputTokens: opts.lastInput ?? 0 },
    } as unknown as Session;
    ids.push(session.id);
    return session;
}

test("#570: a confirmed window governs — weak confirmations never clobber it", () => {
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 } });
    for (const r of ["r1", "r2", "r3"]) {
        noteWeakOverflow(session, { inputTokens: 134000, model: "qwen", reason: r });
    }
    assert.deepEqual(session.metadata.confirmedContextLimits, { qwen: 150528 }, "confirmed window untouched");
    assert.equal(session.metadata.learnedContextLimits, undefined, "no speculative write while a confirmed value governs");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 134000, "emergency shrink still armed");
});

test("#570: weak confirmations still refine their own speculative values", () => {
    const session = makeSessionWithMaps({ learnedMap: { qwen: 130000 } });
    for (const r of ["r1", "r2", "r3"]) {
        noteWeakOverflow(session, { inputTokens: 125000, model: "qwen", reason: r });
    }
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, 125000);
});

test("#570 retraction: a successful turn above the learned window removes it", () => {
    const session = makeSessionWithMaps({ learnedMap: { qwen: 121815 }, lastInput: 126000 });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, undefined);
});

test("#570 retraction: within the margin the value survives (estimation noise)", () => {
    const session = makeSessionWithMaps({ learnedMap: { qwen: 121815 }, lastInput: 125000 });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), false);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, 121815);
});

test("#570 retraction: the armed emergency value (== learned) never retracts itself", () => {
    const session = makeSessionWithMaps({ learnedMap: { qwen: 121815 }, lastInput: 121815 });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), false);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, 121815);
});

test("#570 retraction: confirmed values retract too (resized server / KV growth)", () => {
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 }, lastInput: 160000 });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.confirmedContextLimits as Record<string, number>).qwen, undefined);
});

test("#570 retraction: other models' entries survive; stale model-unknown scalars go too", () => {
    const session = makeSessionWithMaps({
        learnedMap: { qwen: 121815, other: 90000 },
        learnedScalar: 110000,
        lastInput: 130000,
    });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).other, 90000, "other model untouched");
    assert.equal(session.metadata.learnedContextLimit, undefined, "stale scalar retracted");
});

test("#570 resolvers: confirmed > speculative, per-model > scalar", () => {
    const s = makeSessionWithMaps({
        learnedMap: { qwen: 100000 },
        confirmedMap: { qwen: 150000 },
        learnedScalar: 90000,
        confirmedScalar: 80000,
    });
    assert.equal(resolveLearnedLimit(s, "qwen"), 150000, "confirmed per-model wins");
    assert.equal(resolveLearnedLimit(s, "other"), 80000, "unknown model → confirmed scalar");
    const s2 = makeSessionWithMaps({ learnedMap: { qwen: 100000 }, learnedScalar: 90000 });
    assert.equal(resolveLearnedLimit(s2, "qwen"), 100000, "speculative per-model next");
    assert.equal(resolveLearnedLimit(s2, "other"), 90000, "falls back to the speculative scalar");
    assert.equal(resolveConfirmedLimit(s2, "other"), undefined);
});

test("#570 guard: weak confirmations under a confirmed window cap the armed value at the window", () => {
    // A mid-stream death ABOVE the confirmed window is a non-window kill mode
    // (KV pressure / OOM / reset) — arming at its size would let retraction
    // mistake the failure for "a later success" and delete the ground truth.
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 }, window: 200000 });
    for (const r of ["r1", "r2", "r3"]) {
        noteWeakOverflow(session, { inputTokens: 185000, model: "qwen", reason: r });
    }
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 150528, "armed at the confirmed window, not the failure's size");
    assert.equal(retractStaleLearnedLimits(session, "qwen"), false, "the capped arm cannot retract the governing window");
    assert.deepEqual(session.metadata.confirmedContextLimits, { qwen: 150528 }, "confirmed window intact");
});
