import assert from "node:assert/strict";
import { test } from "node:test";
import { modelOutputLimit } from "../src/model-output-limits.ts";
import snapshot from "../src/models-dev-snapshot.json" with { type: "json" };

process.env.NODE_ENV = "test";

const LIMITS = (snapshot as { limits: Record<string, number> }).limits;

// Structural invariants of the slim snapshot (#853): every entry is a real
// output ceiling strictly below the preflight summary default — caps at or
// above the default are omitted by design (they can never affect the clamp).
test("#853 models-dev snapshot: every limit is in (0, 32768)", () => {
    const entries = Object.entries(LIMITS);
    assert.ok(entries.length > 500, `expected a substantial table, got ${entries.length}`);
    for (const [id, cap] of entries) {
        assert.ok(typeof cap === "number" && cap > 0 && cap < 32768, `entry ${id} has cap ${cap} outside (0, 32768)`);
    }
});

// #853: the reported model (deepseek-flash, real ceiling 384k) must NOT be in
// the table — a clamp entry for it would re-introduce the starvation bug the
// 32k default fixes. Models at/above the default are omitted by the snapshot
// generator, so a regeneration that keeps this true keeps the fix intact.
test("#853 models-dev snapshot: high-ceiling models are not clamped", () => {
    assert.equal(modelOutputLimit("deepseek-flash"), null);
    assert.equal(modelOutputLimit("gpt-5.6-sol"), null);
});

test("#853 modelOutputLimit: exact id, namespaced strip, unknown", () => {
    // Pick a live capped entry so the assertions survive snapshot regeneration.
    const [cappedId, cappedCap] = Object.entries(LIMITS).find(([id, v]) => v === 8192 && !id.includes("/")) ?? [];
    assert.ok(cappedId, "snapshot must contain at least one 8192-cap model");

    assert.equal(modelOutputLimit(cappedId), cappedCap, "exact id hits");
    assert.equal(modelOutputLimit(`some-gateway/${cappedId}`), cappedCap, "a namespaced id strips to the bare form");
    assert.equal(modelOutputLimit(`deep/${cappedId}/extra`), null, "multi-segment suffixes are not stripped");
    assert.equal(modelOutputLimit("no-such-model-anywhere"), null, "unknown model has no known ceiling");
});
