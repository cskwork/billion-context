// #1085: sticky head-system anchor unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSystemAnchor, ANCHOR_MAX_NOTES } from "../src/system-anchor.ts";
import type { Session } from "../src/session.ts";

const log = () => {};

function makeSession(): Session {
    return { metadata: {} } as unknown as Session;
}

test("first non-empty head is captured as the anchor", () => {
    const s = makeSession();
    const out = reconcileSystemAnchor(s, "anthropic", "HEAD-V1", "t1", log);
    assert.equal(out.outbound, "HEAD-V1");
    assert.deepEqual(out.notes, []);
    assert.equal(out.changed, false);
});

test("empty head is never anchored; a later non-empty head captures", () => {
    const s = makeSession();
    let out = reconcileSystemAnchor(s, "anthropic", "", "t1", log);
    assert.equal(out.outbound, "");
    assert.deepEqual(out.notes, []);
    out = reconcileSystemAnchor(s, "anthropic", "HEAD-V1", "t2", log);
    assert.equal(out.outbound, "HEAD-V1");
});

test("unchanged head re-injects existing notes without duplication", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "openai", "A", "t1", log);
    const changed = reconcileSystemAnchor(s, "openai", "B", "t2", log);
    assert.equal(changed.changed, true);
    const again = reconcileSystemAnchor(s, "openai", "B", "t3", log);
    assert.equal(again.changed, false);
    assert.equal(again.outbound, "A");
    assert.equal(again.notes.length, 1);
    assert.equal(again.notes[0], "[System context update] These instructions SUPERSEDE all previously loaded ambient instructions:\n\nB");
});

test("change forwards the OLD anchor byte-stable and appends one note with the full new text", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "google", "anchor-text-1", "t1", log);
    const out = reconcileSystemAnchor(s, "google", "brand-new-text-2", "t2", log);
    assert.equal(out.outbound, "anchor-text-1");
    assert.equal(out.notes.length, 1);
    assert.ok(out.notes[0].includes("brand-new-text-2"));
    // A second distinct change stacks a second note, still forwarding the original anchor.
    const out2 = reconcileSystemAnchor(s, "google", "third-text", "t3", log);
    assert.equal(out2.outbound, "anchor-text-1");
    assert.equal(out2.notes.length, 2);
});

test("removed head appends a removal note but keeps the anchor flowing", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "responses", "some-head", "t1", log);
    const out = reconcileSystemAnchor(s, "responses", "", "t2", log);
    assert.equal(out.outbound, "some-head");
    assert.equal(out.notes.length, 1);
    assert.equal(out.notes[0], "[System context update] Previously loaded ambient instructions no longer apply.");
});

test("churn guard replaces the anchor outright past the note cap", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "anthropic", "base", "t0", log);
    let out: ReturnType<typeof reconcileSystemAnchor>;
    for (let i = 1; i <= ANCHOR_MAX_NOTES; i++) {
        out = reconcileSystemAnchor(s, "anthropic", `churn-${i}`, `t${i}`, log);
    }
    assert.equal(out!.notes.length, ANCHOR_MAX_NOTES);
    assert.equal(out!.outbound, "base");
    const over = reconcileSystemAnchor(s, "anthropic", "churn-final", "tf", log);
    assert.equal(over.changed, true);
    assert.equal(over.outbound, "churn-final");
    assert.deepEqual(over.notes, []);
    // The replacement is now itself the sticky anchor.
    const steady = reconcileSystemAnchor(s, "anthropic", "churn-final", "tg", log);
    assert.equal(steady.changed, false);
    assert.equal(steady.outbound, "churn-final");
});

test("state survives a JSON persistence round-trip", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "openai", "one", "t1", log);
    reconcileSystemAnchor(s, "openai", "two", "t2", log);
    const restored = JSON.parse(JSON.stringify(s.metadata)) as Record<string, unknown>;
    const s2 = { metadata: restored } as unknown as Session;
    const out = reconcileSystemAnchor(s2, "openai", "two", "t3", log);
    assert.equal(out.outbound, "one");
    assert.equal(out.notes.length, 1);
});

test("surfaces are independent per session", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "anthropic", "A-head", "t1", log);
    const out = reconcileSystemAnchor(s, "openai", "A-head", "t1", log);
    assert.equal(out.changed, false);
    assert.equal(out.outbound, "A-head");
    assert.equal(out.notes.length, 0);
});

test("interop: a third-party client doing its own in-history updates gets zero bili injection", () => {
    // The client keeps its system prompt byte-stable and records instruction
    // changes as ordinary user messages inside the history (opencode-style).
    // The proxy only sees the constant head — it must stay completely silent.
    const s = makeSession();
    const system = "STABLE-AMBIENT-INSTRUCTIONS";
    const turns = [
        { user: "hello" },
        { user: "These instructions replace all previously loaded ambient instructions.\n\nNEW-RULES" },
        { user: "and more work" },
    ];
    for (let i = 0; i < turns.length; i++) {
        const out = reconcileSystemAnchor(s, "responses", system, `t${i}`, log);
        assert.equal(out.outbound, system);
        assert.deepEqual(out.notes, []);
        assert.equal(out.changed, false);
    }
});
