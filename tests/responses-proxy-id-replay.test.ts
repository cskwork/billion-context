import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponsesAdapter, normalizeResponsesMessageItems, sanitizeResponsesInputIds } from "../src/loop/adapter-responses.ts";

const proxyId = "msg-proxy-2-7d1e132ded554149";

test("replayed full assistant messages drop only proxy-generated ids", () => {
    for (const id of [proxyId, "msg-proxy-1789893725000-0", `msg-proxy-2-${"x".repeat(60)}`]) {
        for (const content of ["answer", "", [], [{ type: "output_text", text: "answer", annotations: [] }], [{ type: "refusal", refusal: "no" }]]) {
            const message: Record<string, unknown> = {
                type: "message", role: "assistant", id, content,
                status: "completed", phase: "final_answer",
            };
            const expected = structuredClone(message);
            delete expected.id;
            sanitizeResponsesInputIds([message]);
            assert.deepEqual(message, expected);
            sanitizeResponsesInputIds([message]);
            assert.deepEqual(message, expected, "cleanup is idempotent");
        }
    }
});

test("ingress normalization makes typeless assistant replay eligible", () => {
    const input = [{ role: "assistant", id: proxyId, content: "answer" }];
    assert.equal(normalizeResponsesMessageItems(input), 1);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, [{ type: "message", role: "assistant", content: "answer" }]);
});

test("native ids, references, non-assistant items and incomplete messages remain unchanged", () => {
    const input: unknown[] = [
        null, undefined, 0, "text", false,
        { type: "message", role: "assistant", id: "msg_native", content: "answer" },
        { type: "message", role: "assistant", id: "marker-123-0", content: "answer" },
        ...["user", "system", "developer"].map(role => ({ type: "message", role, id: proxyId, content: "text" })),
        ...[undefined, null, {}].map(content => ({ type: "message", role: "assistant", id: proxyId, content })),
        { type: "message", role: "assistant", id: 123, content: "answer" },
        { type: "message", role: "assistant", content: "answer" },
        { type: "item_reference", id: proxyId },
        { type: "reasoning", id: proxyId, summary: [] },
        { type: "compaction", id: proxyId, encrypted_content: "opaque" },
        { type: "function_call", id: proxyId, call_id: "call_1", name: "tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "custom_tool_call", id: proxyId, call_id: "call_2", name: "tool", input: "text" },
    ];
    const expected = structuredClone(input);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, expected);
    for (const value of [undefined, null, false, "text", {}]) {
        assert.doesNotThrow(() => sanitizeResponsesInputIds(value));
    }
});

test("existing 64-character boundary and long-id healing stay unchanged", () => {
    const input = [
        { type: "message", role: "assistant", id: "x".repeat(64), content: "answer" },
        { type: "message", role: "assistant", id: "x".repeat(65), content: "answer" },
        { type: "function_call", id: "x".repeat(65), call_id: "y".repeat(80) },
    ];
    sanitizeResponsesInputIds(input);
    assert.equal(input[0].id, "x".repeat(64));
    assert.match(input[1].id, /^msg-fix-/);
    assert.ok(input[1].id.length <= 64);
    assert.equal(input[2].id, input[1].id);
    assert.equal(input[2].call_id, "y".repeat(80));
    const expected = structuredClone(input);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, expected);
});

test("emitText lifecycle keeps its local id while the next full-message replay omits it", () => {
    const wire = createResponsesAdapter(true).emitText("answer").toString("utf8");
    const events = wire.split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const added = events.find(event => event.type === "response.output_item.added")?.item as Record<string, unknown>;
    const done = events.find(event => event.type === "response.output_item.done")?.item as Record<string, unknown>;
    assert.match(String(added.id), /^msg-proxy-\d+-\d+$/);
    assert.equal(done.id, added.id);
    for (const event of events) {
        if (event.item_id !== undefined) assert.equal(event.item_id, added.id);
    }
    const replay = structuredClone(done);
    const expected = structuredClone(done);
    delete expected.id;
    normalizeResponsesMessageItems([replay]);
    sanitizeResponsesInputIds([replay]);
    assert.deepEqual(replay, expected);
    assert.equal(done.id, added.id, "client-visible stream ids are not mutated");
});
