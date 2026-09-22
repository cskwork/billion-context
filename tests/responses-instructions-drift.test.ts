import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { conversationHeaderSource, instructionsFingerprintApplies } from "../src/session-id.ts";

// #1102: opencode's system-context reconcile rewrites `instructions` whenever
// AGENTS.md is edited mid-session. Its conversation ids are persona-scoped
// (one session id per persona; task-tool subagents mint fresh child ids), so
// same-id + drifted instructions must NOT fork the compression namespace.
// #1106 inverts the default: the fingerprint is an allowlist (codex +
// claude-over-Responses only); everyone else keys verbatim.

test("instructionsFingerprintApplies: codex traffic keeps the fingerprint (#150)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-codex-turn-metadata": '{"thread_source":"user","thread_id":"t-1"}', "thread-id": "t-1", "session-id": "sess-150" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-codex-turn-metadata": "not-json", "session-id": "sess-150" }), true);
    assert.equal(instructionsFingerprintApplies({ "user-agent": "codex_cli_rs/0.147.0 (Ubuntu)", "session-id": "sess-150" }), true);
});

test("instructionsFingerprintApplies: claude-over-Responses keeps the fingerprint (#970)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "uuid-1" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "uuid-1", "x-session-affinity": "ses_abc" }), true);
    // only counts when the claude header WINS the walk — an outranking plugin
    // conversation id moves the request onto the verbatim default
    assert.equal(instructionsFingerprintApplies({ "x-bili-plugin": "host", "x-bili-plugin-conversation": "c-1", "x-claude-code-session-id": "uuid-1" }), false);
});

test("instructionsFingerprintApplies: everyone else keys verbatim (#1106)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-session-affinity": "ses_abc123XYZ" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-opencode-session": "zen-sess-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-session-id": "generic-relay-client-7" }), false);
    assert.equal(instructionsFingerprintApplies({ "session-id": "thread-9" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-grok-session-id": "gr-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-mavis-session-id": "mc-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "user-agent": "CherryStudio/1.0", "x-session-id": "cs-1" }), false);
    // codex UA detection stays case-sensitive (isCodexClient convention, #645)
    // so relays with "Codex"-shaped UAs are not pulled back into the fingerprint
    assert.equal(instructionsFingerprintApplies({ "user-agent": "CodeXchange/1.0", "x-session-id": "cx-1" }), false);
    assert.equal(instructionsFingerprintApplies({}), false);
});

test("instructionsFingerprintApplies: plugin declaration flag is vestigial (#1106)", () => {
    const base = { "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "c-1", "x-bili-plugin-instructions-mutable": "1" };
    assert.equal(instructionsFingerprintApplies(base), false);
    assert.equal(instructionsFingerprintApplies({ ...base, "x-bili-plugin-instructions-mutable": undefined }), false);
    assert.equal(instructionsFingerprintApplies({ "x-bili-plugin": "future-host", "x-bili-plugin-conversation": "c-2", "x-bili-plugin-instructions-mutable": "1" }), false);
});

test("conversationHeaderSource: reports the winning header with priority order intact", () => {
    assert.deepEqual(conversationHeaderSource({ "x-bili-plugin": "pi", "x-bili-plugin-conversation": "p1", "x-session-affinity": "ses_z" }), { name: "x-bili-plugin-conversation", value: "p1" });
    assert.deepEqual(conversationHeaderSource({ "x-session-affinity": " ses_a ", "x-session-id": "s-b" }), { name: "x-session-affinity", value: "ses_a" });
    assert.equal(conversationHeaderSource({ "x-bili-plugin-conversation": "orphan" }), undefined);
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", { response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } });
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

function textEvents(delta: string): string {
    return [
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: delta }] }, output_index: 0 }),
    ].join("");
}

async function withProxy(upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse, bodies: string[]) => void, fn: (url: string, statsUrl: string, bodies: string[]) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            upstreamHandler(req, res, bodies);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-drift-e2e": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, `http://127.0.0.1:${proxyPort}/__bili/stats`, bodies);
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

test("e2e #1102: opencode AGENTS.md edit (instructions drift) keeps ONE session and carries compression state", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const AFFINITY = "ses_drift_e2e";
    const INSTRUCTIONS_V1 = "You are OpenCode, the coding agent.\n\n# AGENTS.md\nBuild with npm.";
    const INSTRUCTIONS_V2 = "You are OpenCode, the coding agent.\n\n# AGENTS.md\nBuild with npm.\nUse pnpm for scripts.";
    const SEED_USER = "Kick off the working session.";
    const SEED_ASSISTANT = "Understood, starting now.";
    const TURN_1 = `DRIFT-FILLER-A ${"y".repeat(6000)}`;
    const TURN_2 = "DRIFT-FILLER-B acknowledged";
    // kernel refs are per-session snapshots assigned in render order:
    // m00001/m00002 = seed pair, m00003 = TURN_1, m00004 = TURN_2
    const REF_1 = "m00003";
    const REF_2 = "m00004";

    await withProxy((req, res, bodies) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (bodies.length === 1) {
            const compressArgs = JSON.stringify({
                content: [{ startId: REF_1, endId: REF_2, topic: "session setup", summary: "DRIFT-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
            });
            res.write(fcEvents(0, "call_d", "compress", compressArgs));
            res.write(completed(1600));
        } else {
            res.write(textEvents("post-edit answer"));
            res.write(completed(1700));
        }
        res.end();
    }, async (url, statsUrl, bodies) => {
        // The seed pair precedes the compress target because the kernel's
        // rebuildMessages pins the session's FIRST user message to the wire
        // even when covered by an active block — targeting it would leave raw
        // bytes on the wire and break the fold assertion below. Six medium
        // turns AFTER the target keep m00003/m00004 outside the kernel's
        // protected zone (last 5 messages AND last 5000 tokens), so the mock
        // compress call actually executes and folds them.
        const med = (i: number) => `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290);
        const baseInput = [
            { type: "message", role: "user", content: SEED_USER },
            { type: "message", role: "assistant", content: SEED_ASSISTANT },
            { type: "message", role: "user", content: TURN_1 },
            { type: "message", role: "assistant", content: TURN_2 },
            { type: "message", role: "user", content: med(5) },
            { type: "message", role: "assistant", content: med(6) },
            { type: "message", role: "user", content: med(7) },
            { type: "message", role: "assistant", content: med(8) },
            { type: "message", role: "user", content: med(9) },
            { type: "message", role: "assistant", content: med(10) },
        ];
        const req1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-session-affinity": AFFINITY }, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_V1, input: baseInput }) });
        assert.equal(req1.status, 200);
        await req1.text();
        assert.equal(bodies.length, 2, "original + post-compress re-request");

        const userEditsAgentsMd = "AGENTS.md edited mid-session: use pnpm for scripts (TURN-MARKER-1102)";
        const req2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-session-affinity": AFFINITY }, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_V2, input: [...baseInput, { type: "message", role: "user", content: userEditsAgentsMd }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 3);
        assert.ok(!bodies[2].includes("DRIFT-FILLER-A"), "compressed state carried across the instructions drift — no orphan re-seeding");
        assert.ok(!bodies[2].includes("DRIFT-FILLER-B"), "both folded messages are off the wire after the drift");
        assert.ok(bodies[2].includes("DRIFT-SUMMARY-SETUP"), "the folded summary renders in place of the compressed range");
        assert.ok(bodies[2].includes(userEditsAgentsMd), "the new turn is forwarded");

        const stats = await (await fetch(statsUrl)).json();
        assert.equal(stats.sessions.length, 1, "same logical conversation stays in ONE compression namespace despite instructions drift");
        assert.equal(stats.sessions[0].id, AFFINITY, "no |sub:<fp> fork");
    });
});

test("e2e #1106: plugin conversation without the mutable flag stays ONE session (flag is vestigial)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const CONVERSATION = "plg-drift-e2e";
    // no x-bili-plugin-instructions-mutable — under #1104 this forked; under
    // the #1106 allowlist default the plugin lane keys verbatim regardless
    const headers = { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": CONVERSATION };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("plugin lane answer"));
        res.write(completed(800));
        res.end();
    }, async (url, statsUrl, bodies) => {
        const input = [{ type: "message", role: "user", content: "initial turn" }];
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "persona v1", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "persona v1 with updated AGENTS.md section", input: [...input, { type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: "second turn" }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 2);
        const stats = await (await fetch(statsUrl)).json();
        assert.equal(stats.sessions.length, 1, "plugin lane keys verbatim; the mutable flag is no longer required");
        assert.equal(stats.sessions[0].id, CONVERSATION);
    });
});

test("e2e #1106: generic relay client (x-session-id) keeps ONE session across instructions drift", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const GENERIC_ID = "relay-client-conv-42";
    const headers = { "content-type": "application/json", "x-session-id": GENERIC_ID, "user-agent": "SomeRelayClient/2.3" };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("relay lane answer"));
        res.write(completed(800));
        res.end();
    }, async (url, statsUrl, bodies) => {
        const input = [{ type: "message", role: "user", content: "initial turn" }];
        // system prompt rewritten mid-conversation: software upgrade / plugin
        // install / AGENTS.md edit — the #1106 relay majority case
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "system prompt v1 (base)", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "system prompt v2 (upgraded, new plugin tools, AGENTS.md edited)", input: [...input, { type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: "second turn" }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 2);
        const stats = await (await fetch(statsUrl)).json();
        assert.equal(stats.sessions.length, 1, "generic id + instructions drift = same conversation evolving, no fork");
        assert.equal(stats.sessions[0].id, GENERIC_ID);
    });
});

test("e2e #150: codex root thread reusing a task id across personas still splits by instructions fingerprint", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const TASK_ID = "codex-task-id-9";
    const headers = {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.147.0",
        "session-id": TASK_ID,
        "x-codex-turn-metadata": JSON.stringify({ thread_source: "user", thread_id: "t-root" }),
        "thread-id": "t-root",
    };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("codex answer"));
        res.write(completed(700));
        res.end();
    }, async (url, statsUrl, _bodies) => {
        const input = [{ type: "message", role: "user", content: "task turn" }];
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "task A persona instructions", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "task B persona instructions (different task reusing the id)", input }) });
        assert.equal(req2.status, 200);
        await req2.text();

        const stats = await (await fetch(statsUrl)).json();
        assert.equal(stats.sessions.length, 2, "codex id-sharing personas stay split (#150 allowlist entry)");
        const ids = stats.sessions.map((s: { id: string }) => s.id).sort();
        assert.equal(ids[0], TASK_ID);
        assert.ok(ids[1].startsWith(`${TASK_ID}|sub:`), `forked namespace, got ${ids[1]}`);
    });
});
