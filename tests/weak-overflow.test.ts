import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { noteWeakOverflow, resetWeakOverflow, recordProvenInput, resolveConfirmedLimit, resolveLearnedLimit, resolveProvenBaseline, retractStaleLearnedLimits, sessionProvenMax } from "../src/weak-overflow.ts";
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

// #901: the old gate counted only failures at ≥90% of the TRUSTED window. When
// the trusted window overstated reality, every overflow failure landed below
// the gate and the learner starved exactly where the deployment was broken.
// The baseline is now demonstrated capability (recordProvenInput on genuine
// completions), not the trusted window.

test("#901: failures at or below demonstrated capability are not counted", () => {
    const session = makeSession(1_000_000);
    recordProvenInput(session, 391_918, "glm");
    // The issue's 7 mid-stream cuts: inputs 60k–96k, all far below the 392k
    // success level — relay instability, not overflow.
    for (const input of [60_000, 72_000, 81_000, 88_000, 92_000, 95_000, 96_000]) {
        noteWeakOverflow(session, { inputTokens: input, model: "glm", reason: "relay cut" });
    }
    assert.equal(session.metadata.learnedContextLimit, undefined, "noise never learns a window");
    assert.equal(session.metadata.learnedContextLimits, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 0, "emergency shrink never armed by noise");
});

test("#901 regression: no success sample yet — low-usage failures count (the blind spot)", () => {
    const session = makeSession(1_000_000);
    // 40% of the trusted 1M window: under the old MIN_USAGE gate this was
    // ignored forever when the trusted window overstated reality (~370k true).
    // #969: the pattern still fires (counting is capability-based), but it
    // arms the emergency shrink WITHOUT learning a window — the failing
    // input's size is a guess, and a persisted guess is how #969's session
    // shrank to 16161 forever.
    for (const r of ["r1", "r2", "r3"]) noteWeakOverflow(session, { inputTokens: 400_000, reason: r });
    assert.equal(session.metadata.learnedContextLimit, undefined, "#969: nothing learned without an upstream-stated window");
    assert.equal(session.metadata.learnedContextLimits, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 400_000, "emergency shrink armed");
});

test("#901: filtered noise does not consume the event budget — a real overflow still fires", () => {
    const session = makeSession(1_000_000);
    recordProvenInput(session, 391_918, "glm");
    for (let i = 0; i < 10; i++) noteWeakOverflow(session, { inputTokens: 90_000, model: "glm", reason: "noise" });
    noteWeakOverflow(session, { inputTokens: 400_000, model: "glm", reason: "o1" });
    noteWeakOverflow(session, { inputTokens: 402_000, model: "glm", reason: "o2" });
    noteWeakOverflow(session, { inputTokens: 404_000, model: "glm", reason: "o3" });
    // #969: the real-overflow pattern arms at the failing size but learns nothing.
    assert.equal(session.metadata.learnedContextLimits, undefined, "#969: no window learned");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 404_000, "armed at the last failing input");
});

test("#901: the issue deployment end-to-end — inflated 1M trusted, 392k proven, 60–96k cuts are noise, 400k cutoffs learn", () => {
    const session = makeSession(1_000_000);
    recordProvenInput(session, 391_918, "z-ai/glm-5.3-flash");
    for (let i = 0; i < 7; i++) {
        noteWeakOverflow(session, { inputTokens: 60_000 + i * 5_000, model: "z-ai/glm-5.3-flash", reason: "ttft_timeout@180s" });
    }
    assert.equal(session.metadata.learnedContextLimits, undefined, "cuts below demonstrated capability never learn a window");
    for (const r of ["r1", "r2", "r3"]) {
        noteWeakOverflow(session, { inputTokens: 400_000, model: "z-ai/glm-5.3-flash", reason: "cut" });
    }
    // #969: oversized deaths above capability confirm the PATTERN (arming),
    // but only an upstream-stated window is ever learned.
    assert.equal(session.metadata.learnedContextLimits, undefined, "#969: no window learned from guessed sizes");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 400_000, "armed at the failing size");
});

test("#901: recordProvenInput stores per-model and scalar; baseline resolves max with scalar fallback", () => {
    const session = makeSession(1_000_000);
    recordProvenInput(session, 50_000, "a");
    recordProvenInput(session, 391_918, "a");
    recordProvenInput(session, 200_000, "b");
    recordProvenInput(session, 80_000);
    assert.equal(resolveProvenBaseline(session, "a"), 391_918, "max of recent successes for the model");
    assert.equal(resolveProvenBaseline(session, "b"), 200_000);
    assert.equal(resolveProvenBaseline(session, "c"), 80_000, "model with no samples falls back to the scalar bucket");
    assert.equal(resolveProvenBaseline(session), 80_000);
    assert.equal(sessionProvenMax(session), 391_918, "display aid spans all models + scalar");
});

test("#901: the proven ring is bounded so a resized upstream drains out", () => {
    const session = makeSession(1_000_000);
    recordProvenInput(session, 999_999);
    for (let i = 1; i <= 100; i++) recordProvenInput(session, i * 1000);
    const arr = session.metadata.provenInput as number[];
    assert.equal(arr.length, 100, "ring capped at PROVEN_MAX_SAMPLES");
    assert.equal(resolveProvenBaseline(session), 100_000, "the stale giant drained out of the ring");
});

test("three high-usage events arm the emergency shrink without learning a window (#969)", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 96000, reason: "r2" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "not before the 3rd event");
    noteWeakOverflow(session, { inputTokens: 97000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "#969: the failing input's size is a guess — never learned");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 97000, "emergency shrink armed at the last failing input");
});

test("model-scoped arming writes nothing to the learned maps (#969)", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r3" });
    assert.equal(session.metadata.learnedContextLimits, undefined, "#969: nothing learned");
    assert.equal(session.metadata.learnedContextLimit, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 95000, "emergency shrink armed");
});

test("#969: a legacy speculative value is frozen, never overwritten or grown", () => {
    // Pre-#969 builds wrote speculative values here. New code ignores them
    // entirely (retraction drains them); it must not grow OR shrink them.
    const session = makeSession(100000, 50000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 50000, "legacy value untouched");
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

// #901: counting no longer requires a configured window at all — capability
// evidence (or its absence) decides, so sessions with an unknown window can
// still learn from repeated oversized deaths.
test("#901: no configured window — failures still accumulate and arm (#969: nothing learned)", () => {
    const session = makeSession(0);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 96000, reason: "r2" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "not before the 3rd event");
    noteWeakOverflow(session, { inputTokens: 97000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "#969: arms without learning even with zero configured window");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 97000, "armed");
});

test("falls back to lastInputTokens when inputTokens is absent", () => {
    const session = makeSession(100000);
    (session.stats as { lastInputTokens: number }).lastInputTokens = 92000;
    noteWeakOverflow(session, { reason: "r1" });
    noteWeakOverflow(session, { reason: "r2" });
    noteWeakOverflow(session, { reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "#969: nothing learned");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 92000, "armed from the stats fallback");
});

function makeSessionWithMaps(opts: {
    window?: number;
    learnedMap?: Record<string, number>;
    confirmedMap?: Record<string, number>;
    learnedScalar?: number;
    confirmedScalar?: number;
    lastInput?: number;
    lastInputSource?: "usage" | "estimate";
}): Session {
    const metadata: Record<string, unknown> = { effectiveContextLimit: opts.window ?? 140000 };
    if (opts.learnedMap) metadata.learnedContextLimits = opts.learnedMap;
    if (opts.confirmedMap) metadata.confirmedContextLimits = opts.confirmedMap;
    if (opts.learnedScalar !== undefined) metadata.learnedContextLimit = opts.learnedScalar;
    if (opts.confirmedScalar !== undefined) metadata.confirmedContextLimit = opts.confirmedScalar;
    const stats: Record<string, unknown> = { lastInputTokens: opts.lastInput ?? 0 };
    if (opts.lastInputSource !== undefined) stats.lastInputTokensSource = opts.lastInputSource;
    const session = {
        id: `weak-${Math.random().toString(36).slice(2, 8)}`,
        metadata,
        stats,
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

test("#969: weak confirmations refine nothing — a legacy speculative value is frozen", () => {
    // Pre-#969 behavior refined (shrank) its own speculative guesses. That
    // feedback loop is what shrank #969's session 18320 → 16161: each failure
    // taught a smaller "bound". Now nothing is written, ever.
    const session = makeSessionWithMaps({ learnedMap: { qwen: 130000 } });
    for (const r of ["r1", "r2", "r3"]) {
        noteWeakOverflow(session, { inputTokens: 125000, model: "qwen", reason: r });
    }
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, 130000, "legacy value untouched");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 125000, "armed at the failing size");
});

test("#570 retraction: a successful turn above the learned window removes it", () => {
    const session = makeSessionWithMaps({ learnedMap: { qwen: 121815 }, lastInput: 126000, lastInputSource: "usage" });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).qwen, undefined);
});

test("#857 retraction: an estimate-derived baseline never retracts (poison pattern)", () => {
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 }, lastInput: 160000, lastInputSource: "estimate" });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), false);
    assert.equal((session.metadata.confirmedContextLimits as Record<string, number>).qwen, 150528, "real window survives");
});

test("#857 retraction: a legacy unmarked baseline never retracts", () => {
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 }, lastInput: 160000 });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), false);
    assert.equal((session.metadata.confirmedContextLimits as Record<string, number>).qwen, 150528, "real window survives");
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
    const session = makeSessionWithMaps({ confirmedMap: { qwen: 150528 }, lastInput: 160000, lastInputSource: "usage" });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.confirmedContextLimits as Record<string, number>).qwen, undefined);
});

test("#570 retraction: other models' entries survive; stale model-unknown scalars go too", () => {
    const session = makeSessionWithMaps({
        learnedMap: { qwen: 121815, other: 90000 },
        learnedScalar: 110000,
        lastInput: 130000,
        lastInputSource: "usage",
    });
    assert.equal(retractStaleLearnedLimits(session, "qwen"), true);
    assert.equal((session.metadata.learnedContextLimits as Record<string, number>).other, 90000, "other model untouched");
    assert.equal(session.metadata.learnedContextLimit, undefined, "stale scalar retracted");
});

test("#857 arming: noteWeakOverflow tags its baseline raise as estimate", () => {
    const session = makeSessionWithMaps({ window: 140000 });
    for (const r of ["r1", "r2", "r3"]) noteWeakOverflow(session, { inputTokens: 134000, reason: r });
    const stats = session.stats as unknown as { lastInputTokens: number; lastInputTokensSource?: string };
    assert.equal(stats.lastInputTokens, 134000, "armed");
    assert.equal(stats.lastInputTokensSource, "estimate", "estimate provenance tagged");
});

test("#570/#969 resolvers: confirmed only, per-model > scalar", () => {
    const s = makeSessionWithMaps({
        learnedMap: { qwen: 100000 },
        confirmedMap: { qwen: 150000 },
        learnedScalar: 90000,
        confirmedScalar: 80000,
    });
    assert.equal(resolveLearnedLimit(s, "qwen"), 150000, "confirmed per-model wins");
    assert.equal(resolveLearnedLimit(s, "other"), 80000, "unknown model → confirmed scalar");
    const s2 = makeSessionWithMaps({ learnedMap: { qwen: 100000 }, learnedScalar: 90000 });
    assert.equal(resolveLearnedLimit(s2, "qwen"), undefined, "#969: speculative values no longer resolve");
    assert.equal(resolveLearnedLimit(s2, "other"), undefined, "#969: speculative scalar ignored too");
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
