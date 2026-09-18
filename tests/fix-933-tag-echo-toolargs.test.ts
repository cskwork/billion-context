import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { findAcpLikeTagSnippetsDeep, stripAcpTagsDeep } from "../src/loop/tag-echo-filter.ts";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";

// Render-tag pieces are assembled from hex escapes so no literal tag sequence
// appears in this file's source.
const LT = "\x3c";
const GT = "\x3e";
const TAG = (id: string) => `${LT}acp tokens="247" type="text"${GT}${id}${LT}/acp${GT}`;
const OPEN_MARK = `${LT}acp `;
const CLOSE_MARK = `${LT}/acp${GT}`;

function makeSession(): Session {
    return {
        id: "sess933",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function dataLines(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const block of text.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const s = line.slice(5).replace(/^ /, "").trim();
        if (!s || s === "[DONE]") continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            continue;
        }
    }
    return out;
}

function assertNoTagsDeep(label: string, v: unknown): void {
    const hits = findAcpLikeTagSnippetsDeep(v);
    assert.deepEqual(hits, [], `${label}: ACP-like tag survived: ${JSON.stringify(hits)}`);
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function asObj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function openaiToolArgs(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        for (const ch of asArr(ev["choices"])) {
            const d = asObj(ch["delta"]);
            for (const tc of asArr(d["tool_calls"])) {
                out += asString(asObj(tc["function"])["arguments"]);
            }
        }
    }
    return out;
}

function anthropicInput(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] !== "content_block_delta") continue;
        const d = asObj(ev["delta"]);
        if (d["type"] === "input_json_delta") out += asString(d["partial_json"]);
    }
    return out;
}

function responsesArgs(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] === "response.function_call_arguments.delta") out += asString(ev["delta"]);
    }
    return out;
}

test("#933 invariant: deep scan finds planted tags in every carrier field, clean objects report none", () => {
    const tag = TAG("m00042");
    const openaiBody = {
        choices: [
            {
                message: {
                    role: "assistant",
                    content: `prose ${tag} here`,
                    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: `{"n": "x${tag}y"}` } }],
                },
            },
        ],
    };
    const anthropicBody = {
        content: [
            { type: "text", text: `head ${tag}` },
            { type: "thinking", thinking: `think ${tag}` },
            { type: "tool_use", id: "t1", name: "f", input: { n: `x${tag}y`, list: [`a${tag}b`] } },
        ],
    };
    const responsesBody = {
        output: [
            { type: "message", content: [{ type: "output_text", text: `say ${tag}` }] },
            { type: "function_call", id: "fc1", call_id: "c1", name: "f", arguments: `{"n": "${tag}"}` },
            { type: "reasoning", summary: [{ type: "summary_text", text: `sum ${tag}` }] },
        ],
    };
    for (const [label, body] of [
        ["openai", openaiBody],
        ["anthropic", anthropicBody],
        ["responses", responsesBody],
    ] as const) {
        const hits = findAcpLikeTagSnippetsDeep(body);
        assert.ok(hits.length >= 2, `${label}: expected planted tags to be found, got ${JSON.stringify(hits)}`);
        const cleaned = stripAcpTagsDeep(body);
        assertNoTagsDeep(`${label} after stripAcpTagsDeep`, cleaned);
    }
    assertNoTagsDeep("clean object", { choices: [{ message: { content: "5 < 6 holds", tool_calls: [] } }], meta: { a: [1, null, { b: "" }] } });
});

test("#933 openai chat: render tag echoed into tool_calls function.arguments is stripped (split mid-tag)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: "Sure, checking " }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_report", arguments: '{"note": "see ' } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: TAG("m00042").slice(0, 30) } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: TAG("m00042").slice(30) + ' "x"}' } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
    await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    const text = out.join("");
    assert.ok(!text.includes(OPEN_MARK), "client stream leaked a render open tag");
    assert.ok(!text.includes(CLOSE_MARK), "client stream leaked a render close tag");
    assert.ok(!text.includes("m00042"), "tag ref leaked into client stream");
    const parsed = dataLines(text);
    assert.equal(openaiToolArgs(parsed), '{"note": "see  "x"}', "assembled arguments equal original minus tag");
    assert.ok(text.includes("Sure, checking "), "prose chunk survives");
    assert.ok(text.includes("[DONE]"), "[DONE] forwarded");
});

test("#933 anthropic: render tag echoed into input_json_delta is stripped (split mid-tag)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const tag = TAG("m00007");
    const events = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 5 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Result: " } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_report" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q": "ref ' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: tag.slice(0, 20) } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: tag.slice(20) + '"}' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, "anthropic", makeSession());
    const text = out.join("");
    assert.ok(!text.includes(OPEN_MARK), "client stream leaked a render open tag");
    assert.ok(!text.includes(CLOSE_MARK), "client stream leaked a render close tag");
    assert.ok(!text.includes("m00007"), "tag ref leaked into client stream");
    const parsed = dataLines(text);
    assert.deepEqual(JSON.parse(anthropicInput(parsed)), { q: "ref " }, "assembled tool input equals original minus tag");
    assert.ok(text.includes("Result: "), "text block survives");
});

test("#933 responses: render tag echoed into function_call_arguments deltas and done payloads is stripped", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const tag = TAG("m00011");
    const dirtyArgs = `{"a": "see ${tag}"}`;
    const events = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "created" } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: "" } })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a": "see ' })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: tag.slice(0, 15) })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: tag.slice(15) + '"}' })}\n\n`,
        `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 1, summary_index: 0, delta: `thinking ${TAG("m00009")} more` })}\n\n`,
        `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: dirtyArgs })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: dirtyArgs } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: dirtyArgs }] } })}\n\n`,
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, makeSession());
    const text = out.join("");
    assert.ok(!text.includes(OPEN_MARK), "client stream leaked a render open tag");
    assert.ok(!text.includes(CLOSE_MARK), "client stream leaked a render close tag");
    assert.ok(!text.includes("m00011"), "tag ref leaked into client stream");
    assert.ok(!text.includes("m00009"), "reasoning summary tag ref leaked");
    const parsed = dataLines(text);
    assert.equal(responsesArgs(parsed), '{"a": "see "}', "delta-assembled arguments equal original minus tag");
    const done = parsed.find((e) => e["type"] === "response.function_call_arguments.done") ?? {};
    assertNoTagsDeep("function_call_arguments.done", done);
    const itemDone = parsed.find((e) => e["type"] === "response.output_item.done") ?? {};
    assertNoTagsDeep("output_item.done", itemDone);
    const completed = parsed.find((e) => e["type"] === "response.completed") ?? {};
    assertNoTagsDeep("response.completed", completed);
});

test("#933 non-streaming: pipePluginJson strips tags from tool-call argument payloads (all protocols)", async () => {
    const tag = TAG("m00031");
    const cases = [
        {
            protocol: "openai" as const,
            body: { choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: `{"n": "x${tag}y"}` } }] } }] },
        },
        {
            protocol: "anthropic" as const,
            body: { content: [{ type: "tool_use", id: "t1", name: "f", input: { n: `x${tag}y` } }] },
        },
        {
            protocol: "responses" as const,
            body: { output: [{ type: "function_call", id: "fc1", call_id: "c1", name: "f", arguments: `{"n": "x${tag}y"}` }] },
        },
    ];
    for (const c of cases) {
        const out: string[] = [];
        const res = makeRes(out);
        await pipePluginJson(streamOf([JSON.stringify(c.body)]), res, makeSession(), c.protocol);
        const text = out.join("");
        assert.ok(!text.includes(OPEN_MARK), `${c.protocol}: leaked open tag`);
        assert.ok(!text.includes(CLOSE_MARK), `${c.protocol}: leaked close tag`);
        assertNoTagsDeep(c.protocol, JSON.parse(text));
    }
});

test("#933 replay loop: assistant message rebuilt from the clean client stream carries no tags into the next request", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: "Sure, checking " }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_report", arguments: `{"note": "see ${TAG("m00042")} "x"}"` } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
    await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    const parsed = dataLines(out.join(""));
    const storedAssistant = {
        role: "assistant",
        content: parsed.flatMap((ev) => asArr(ev["choices"]).map((ch) => asString(asObj(ch["delta"])["content"]))).join(""),
        tool_calls: [
            {
                id: "call_9",
                type: "function",
                function: { name: "get_report", arguments: openaiToolArgs(parsed) },
            },
        ],
    };
    const nextRequest = { messages: [{ role: "user", content: "compress please" }, storedAssistant, { role: "user", content: "go on" }] };
    assertNoTagsDeep("replayed next-turn request", nextRequest);
});
