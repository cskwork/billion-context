import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatRanges } from "acp-kernel";
import {
    createOpencodeLocalHost,
    coreToOpencode,
    deriveTokenCount,
    opencodeToCore,
    type OcMessage,
    type V2ContextEvent,
} from "../src/agent/opencode-local.ts";
import { COMPRESS_TOOL_NAME } from "../src/compress-tool.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";

const BIG_TEXT = "line of build output ".repeat(1400); // ~7.4K tokens, above the nudge benefit floor

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

function transcript(sid: string, extra: OcMessage[] = []): OcMessage[] {
    return [
        {
            id: "msg_u1",
            role: "user",
            content: [{ type: "text", text: "run a big build" }],
        },
        {
            id: "msg_a1",
            role: "assistant",
            content: [
                { type: "reasoning", text: "thinking about the build" },
                { type: "tool-call", id: "call_1", name: "bash", input: { command: "npm test" } },
            ],
            tokens: { input: 1200, cache: { read: 3400, write: 800 }, output: 50, reasoning: 20 },
        },
        {
            id: "msg_t1",
            role: "tool",
            content: [{ type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: BIG_TEXT } }],
        },
        ...extra,
    ];
}

function ctxEvent(sid: string, messages: OcMessage[], system = "You are a coder."): V2ContextEvent {
    return { sessionID: sid, system: [{ type: "text", text: system }], messages, model: { providerID: "test", id: "small" } };
}

test("opencodeToCore maps parts to stable per-part ids", () => {
    const cores = opencodeToCore(transcript("s1"));
    assert.equal(cores.length, 4);
    assert.deepEqual(cores[0], { id: "msg_u1:0", role: "user", contentType: "text", text: "run a big build" });
    assert.equal(cores[1].contentType, "reasoning");
    assert.equal(cores[1].role, "assistant");
    assert.equal(cores[2].contentType, "tool-call");
    assert.equal(cores[2].toolName, "bash");
    assert.equal(cores[2].toolCallId, "call_1");
    assert.equal(cores[3].contentType, "tool-result");
    assert.equal(cores[3].toolCallId, "call_1");
    assert.ok((cores[3].text ?? "").includes("line of build output"));
});

test("deriveTokenCount uses the last assistant input+cache+output+reasoning", () => {
    assert.equal(deriveTokenCount(transcript("s1")), 1200 + 3400 + 800 + 50 + 20);
    const trailing = transcript("s1", [{ id: "msg_u2", role: "user", content: [{ type: "text", text: "thanks" }] }]);
    assert.equal(deriveTokenCount(trailing), 1200 + 3400 + 800 + 50 + 20);
    assert.equal(deriveTokenCount([{ id: "x", role: "user", content: [{ type: "text", text: "hi" }] }]), 0);
});

test("coreToOpencode passes through non-text parts and injects synthetic summaries as user messages", () => {
    const originals = transcript("s1");
    const view = [
        { id: "acp_summary_b1", role: "user" as const, contentType: "text" as const, text: "summary of the build" },
        ...opencodeToCore(originals),
    ];
    const rebuilt = coreToOpencode(view, originals);
    assert.equal(rebuilt.length, 4);
    assert.equal(rebuilt[0].role, "user");
    assert.deepEqual(rebuilt[0].content, [{ type: "text", text: "summary of the build" }]);
    // non-text parts (tool-call, tool-result) survive untouched by object identity
    assert.equal(rebuilt[2].content?.[1], originals[1].content?.[1]);
    assert.equal(rebuilt[3].content?.[0], originals[2].content?.[0]);
});

function compressContent(sid: string, summary: string): Array<{ startId: string; endId: string; summary: string }> {
    const session = peekSession(sid);
    assert.ok(session);
    const byRef = session.state.messageRefs.byRef as Record<string, string>;
    const refOf = (raw: string): string => {
        const hit = Object.entries(byRef).find(([, r]) => r === raw);
        assert.ok(hit, `no ref for raw id ${raw}`);
        return hit[0];
    };
    const start = refOf("msg_a1:1");
    const end = refOf("tr_call_1");
    return [{ startId: start, endId: end, summary }];
}

test("v2 shape: tool-result messages with NO id keep unique per-call refs and every result survives the rebuild", () => {
    // v2's context projection emits tool-result messages with id undefined;
    // positional ids collapsed them all onto "undefined:0" (#-loop bug).
    const v2shape: OcMessage[] = [
        { id: "msg_u1", role: "user", content: [{ type: "text", text: "status pls" }] },
        {
            id: "msg_a1",
            role: "assistant",
            content: [
                { type: "reasoning", text: "check status" },
                { type: "tool-call", id: "call_a", name: "acp_status", input: {} },
            ],
        },
        { role: "tool", content: [{ type: "tool-result", id: "call_a", name: "acp_status", result: { type: "text", value: "PANEL ONE" } }] },
        {
            id: "msg_a2",
            role: "assistant",
            content: [{ type: "tool-call", id: "call_b", name: "acp_status", input: {} }],
        },
        { role: "tool", content: [{ type: "tool-result", id: "call_b", name: "acp_status", result: { type: "text", value: "PANEL TWO" } }] },
    ];
    const cores = opencodeToCore(v2shape);
    const trIds = cores.filter((c) => c.contentType === "tool-result").map((c) => c.id);
    assert.deepEqual(trIds, ["tr_call_a", "tr_call_b"]);

    const rebuilt = coreToOpencode(cores, v2shape);
    const results = rebuilt
        .filter((m) => m.role === "tool")
        .map((m) => toolResultTextOf(m))
        .sort();
    assert.deepEqual(results, ["PANEL ONE", "PANEL TWO"]);
});

function toolResultTextOf(m: OcMessage): string {
    const p = m.content?.[0] as { result?: { value?: unknown } } | undefined;
    const v = p?.result?.value;
    return typeof v === "string" ? v : "";
}

test("local host: nudge + compress prompt injected on the wire view; compress tool executes; carrier survives, dead parts drop", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-local-st-"));
    await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        _resetSessionsForTest();
        const host = createOpencodeLocalHost();
        const sid = "ses_local_1";
        const messages = transcript(sid);
        const e = ctxEvent(sid, messages);
        // window smaller than the ~5.5K-token turn → nudge expected
        await host.onContext(e, 1000);
        const nudged = e.messages as OcMessage[];
        const last = nudged[nudged.length - 1];
    assert.equal(last.role, "user");
    assert.ok(((last.content?.[0] as { text?: string })?.text ?? "").length > 0);
    assert.notEqual(last.id, "msg_u1");

        const sys = e.system as { text?: string }[];
    assert.ok(sys.length >= 2);
    assert.match(sys[sys.length - 1]?.text ?? "", /compress/i);

        // model answers with the compress tool; opencode executes it locally
        const content = compressContent(sid, "the user asked for a big build; bash ran npm test and produced very long tool output that was folded");
        const compressCall: OcMessage = {
        id: "msg_a2",
        role: "assistant",
        content: [{ type: "tool-call", id: "call_2", name: COMPRESS_TOOL_NAME, input: { content } }],
        };
        const hostIntern = host as unknown as { executeTool: (n: string, a: Record<string, unknown>, s: string) => Promise<string> };
        const result = await hostIntern.executeTool(COMPRESS_TOOL_NAME, { content }, sid, "call_2");
    assert.match(result, /compressed/i);

        const toolResult: OcMessage = {
        id: "msg_t2",
        role: "tool",
        content: [{ type: "tool-result", id: "call_2", name: COMPRESS_TOOL_NAME, result: { type: "text", value: result } }],
        };
        const after = ctxEvent(sid, [...messages, compressCall, toolResult]);
        await host.onContext(after, 1000);
        const rebuilt = after.messages as OcMessage[];

        // the big tool result part must be gone from the wire view, the
        // compress tool-call + result must survive (carrier), and no
        // duplicate acp_summary_ user message may ride along
    const allText = JSON.stringify(rebuilt);
    assert.ok(!allText.includes(BIG_TEXT.slice(0, 40)));
    assert.ok(allText.includes(COMPRESS_TOOL_NAME));
    assert.ok(!rebuilt.some((m) => m.id.startsWith("acp_summary_")));

        const session = peekSession(sid);
        assert.ok(session);
        assert.equal(session?.metadata.pluginAgent, "opencode-local");
    });
});

test("local host: internal agent requests are untouched", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-local-st-"));
    await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        _resetSessionsForTest();
        const host = createOpencodeLocalHost();
        const messages = [{ id: "msg_i1", role: "user", content: [{ type: "text", text: "make a title" }] }];
        const e: V2ContextEvent = {
            sessionID: "ses_title",
            system: [{ type: "text", text: "You are a title generator. Reply with a short title." }],
            messages,
        };
        await host.onContext(e, 100000);
        assert.equal(e.messages, messages);
    });
});

test("local host: executeTool before any context flows returns activation guidance", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-local-st-"));
    await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        _resetSessionsForTest();
        const host = createOpencodeLocalHost();
        const out = await host.executeTool("compress", { ranges: "auto", topic: "x", summary: "y" }, "ses_fresh");
        assert.match(out, /no ACP state/);
    });
});

test("local host: markCompaction archives blocks whose raw ids left the transcript", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-local-st-"));
    await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        _resetSessionsForTest();
        const host = createOpencodeLocalHost();
        const sid = "ses_compact";
        const messages = transcript(sid);
        const e = ctxEvent(sid, messages);
        await host.onContext(e, 1000);
        const intern = host as unknown as { executeTool: (n: string, a: Record<string, unknown>, s: string) => Promise<string> };
        await intern.executeTool(COMPRESS_TOOL_NAME, { content: compressContent(sid, "the earlier build turn and its long npm test output were folded into this summary") }, sid, "call_2");

        // opencode /compact replaces the transcript with its own summary
        host.markCompaction(sid);
        const compacted: OcMessage[] = [
            { id: "msg_sum", role: "user", content: [{ type: "text", text: "[compact] earlier: build ran" }] },
            { id: "msg_u9", role: "user", content: [{ type: "text", text: "continue" }] },
        ];
        const after = ctxEvent(sid, compacted);
        await host.onContext(after, 100000);

        const session = peekSession(sid);
        assert.ok(session);
        const archive = session?.metadata.preCompactionArchive as Record<string, unknown> | undefined;
        assert.ok(archive && Object.keys(archive).length > 0);
        assert.equal((session?.metadata.compactionBoundary as { pending?: boolean } | undefined)?.pending, false);
    });
});

test("local host: renderStatus reports state after a turn", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-local-st-"));
    await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        _resetSessionsForTest();
        const host = createOpencodeLocalHost();
        const sid = "ses_status";
        const e = ctxEvent(sid, transcript(sid));
        await host.onContext(e, 1000);
        const panel = await host.renderStatus(sid);
        assert.match(panel, /billion-context-opencode-local@/);
        assert.match(panel, /Context/);
    });
});
