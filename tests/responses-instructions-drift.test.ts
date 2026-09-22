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
import { conversationHeaderSource, instructionsFingerprintExempt } from "../src/session-id.ts";

// #1102: opencode's system-context reconcile rewrites `instructions` whenever
// AGENTS.md is edited mid-session. Its conversation ids are persona-scoped
// (one session id per persona; task-tool subagents mint fresh child ids), so
// same-id + drifted instructions must NOT fork the compression namespace.

test("instructionsFingerprintExempt: opencode native session ids are persona-scoped", () => {
    assert.equal(instructionsFingerprintExempt({ "x-session-affinity": "ses_abc123XYZ" }), true);
    assert.equal(instructionsFingerprintExempt({ "x-session-affinity": "  ses_trimmed  " }), true);
    assert.equal(instructionsFingerprintExempt({ "x-opencode-session": "zen-sess-1" }), true);
});

test("instructionsFingerprintExempt: non-opencode senders of generic headers stay fingerprinted", () => {
    assert.equal(instructionsFingerprintExempt({ "x-session-affinity": "task-123" }), false);
    assert.equal(instructionsFingerprintExempt({ "x-session-id": "ses_looks_like_opencode" }), false);
    assert.equal(instructionsFingerprintExempt({ "session-id": "thread-9" }), false);
    assert.equal(instructionsFingerprintExempt({ "x-claude-code-session-id": "uuid-1" }), false);
    assert.equal(instructionsFingerprintExempt({}), false);
});

test("instructionsFingerprintExempt: claude header outranks affinity (shared-id subagents must stay split)", () => {
    assert.equal(instructionsFingerprintExempt({ "x-claude-code-session-id": "uuid-1", "x-session-affinity": "ses_abc" }), false);
});

test("instructionsFingerprintExempt: plugin declaration requires marker + conversation + flag", () => {
    const base = { "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "c-1", "x-bili-plugin-instructions-mutable": "1" };
    assert.equal(instructionsFingerprintExempt(base), true);
    assert.equal(instructionsFingerprintExempt({ ...base, "x-bili-plugin-instructions-mutable": undefined }), false);
    assert.equal(instructionsFingerprintExempt({ ...base, "x-bili-plugin": undefined }), false);
    assert.equal(instructionsFingerprintExempt({ ...base, "x-bili-plugin-conversation": undefined }), false);
    // the protocol honors the declaration from any cooperative plugin — the
    // contract is that only hosts with VERIFIED persona-scoped ids stamp it
    assert.equal(instructionsFingerprintExempt({ "x-bili-plugin": "future-host", "x-bili-plugin-conversation": "c-2", "x-bili-plugin-instructions-mutable": "1" }), true);
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

test("e2e #1102: plugin-declared opencode session keeps ONE session across instructions drift", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const CONVERSATION = "plg-drift-e2e";
    const headers = { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": CONVERSATION, "x-bili-plugin-instructions-mutable": "1" };

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
        assert.equal(stats.sessions.length, 1, "plugin-declared persona-scoped id must not fork on instruction drift");
        assert.equal(stats.sessions[0].id, CONVERSATION);
    });
});
