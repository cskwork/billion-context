// #1112: a fresh session whose visible content is below compress.minCompressRange
// must not be exposed to the ACP compression surface (tools + philosophy prompt) —
// every compress call there is guaranteed to fail, and the model burned rounds on
// acp_status/search_context after the guaranteed failure. The surface arms once the
// conversation crosses the floor and stays armed (sticky).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { armAcpSurface, startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { Session } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("#1112: surface stays withheld below minCompressRange", () => {
    const session = makeSession("arm-withhold");
    const logs: string[] = [];
    const log = (_level: string, msg: string) => { logs.push(msg); };
    const small = [{ role: "user", text: "hello" }] as CoreMessage[];
    assert.equal(armAcpSurface(session, small, 5000, log), false);
    assert.equal("acpArmed" in session.metadata, false, "must not arm below the floor");
    assert.equal(logs.length, 0, "no arming log below the floor");
});

test("#1112: surface arms at the floor and stays armed (sticky)", () => {
    const session = makeSession("arm-sticky");
    const logs: string[] = [];
    const log = (_level: string, msg: string) => { logs.push(msg); };
    const atFloor = [{ role: "user", text: "x".repeat(5000) }] as CoreMessage[];
    assert.equal(armAcpSurface(session, atFloor, 5000, log), true);
    assert.equal(session.metadata.acpArmed, true);
    assert.ok(logs.some((l) => l.includes("ACP surface armed")), `arming logged: ${logs.join(" | ")}`);
    const shrunken = [{ role: "user", text: "hi" }] as CoreMessage[];
    assert.equal(armAcpSurface(session, shrunken, 5000, log), true, "sticky after history shrinks");
});

test("#1112: minCompressRange <= 0 restores legacy always-on", () => {
    const session = makeSession("arm-legacy");
    assert.equal(armAcpSurface(session, [], 0, () => {}), true);
    assert.equal(armAcpSurface(session, [], -1, () => {}), true);
});

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: "fix-1112-verdict",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function seedTurn(ctx: Ctx, turns: Array<[string, string]>): void {
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

const LONG_SUMMARY = "summary of a tiny conversation used by the zero-floor control case";

test("#1112: sub-floor conversation gets a conclusive verdict, not retry advice", () => {
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx);
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("Total compressible content too small"), `kernel reason preserved: ${out}`);
    assert.ok(out.includes("do not retry compress or call acp_status/search_context"), `conclusive verdict present: ${out}`);
});

test("#1112: verdict only when NO range can succeed; a viable larger range keeps generic advice", () => {
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi"], ["user", "x".repeat(6000)]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx);
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("Combine more messages"), `generic advice kept: ${out}`);
    assert.ok(!out.includes("do not retry compress"), `no conclusive verdict while a range could succeed: ${out}`);
});

test("#1112: minCompressRange 0 keeps legacy behavior (tiny compress is not size-rejected)", () => {
    const ctx = makeCtx();
    ctx.config.compress.minCompressRange = 0;
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx);
    assert.ok(!out.includes("Total compressible content too small"), out);
    assert.ok(!out.includes("do not retry compress"), out);
});

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: { body: string }[];
    close(): Promise<void>;
}

function simpleScript(): string[] {
    return [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_arm_1", role: "assistant", usage: { input_tokens: 10 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
}

async function startHarness(scripts: string[][]): Promise<Harness> {
    const captured: { body: string }[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString() });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

interface WireMessage {
    role: string;
    content: string;
}

async function callAnthropic(h: Harness, messages: WireMessage[]): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "fix-1112-arm" },
        body: JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: true,
            system: "You are a test assistant.",
            messages,
        }),
    });
    assert.equal(resp.status, 200);
    for await (const _chunk of resp.body) { /* drain */ }
}

function toolNames(body: { tools?: Array<{ name?: string }> }): string[] {
    return (body.tools ?? []).map((t) => t.name ?? "");
}

test("#1112: fresh sub-floor session exposes no compress tooling; arming is sticky across turns", async () => {
    const h = await startHarness([simpleScript(), simpleScript(), simpleScript()]);
    try {
        await callAnthropic(h, [{ role: "user", content: "hello" }]);
        const first = JSON.parse(h.captured[0]!.body) as { tools?: Array<{ name?: string }>; system?: unknown };
        assert.ok(!toolNames(first).includes("compress"), `compress exposed on sub-floor session: ${toolNames(first).join(",")}`);
        assert.ok(!JSON.stringify(first.system ?? "").includes("Compression Philosophy"), "philosophy prompt leaked pre-arm");

        await callAnthropic(h, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "x".repeat(5000) },
        ]);
        const second = JSON.parse(h.captured[1]!.body) as { tools?: Array<{ name?: string }>; system?: unknown };
        assert.ok(toolNames(second).includes("compress"), "compress tool missing after crossing the floor");
        assert.ok(JSON.stringify(second.system ?? "").includes("Compression Philosophy"), "philosophy prompt missing after arming");

        await callAnthropic(h, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "and a little more" },
        ]);
        const third = JSON.parse(h.captured[2]!.body) as { tools?: Array<{ name?: string }> };
        assert.ok(toolNames(third).includes("compress"), "surface un-armed mid-session (sticky violated)");
    } finally {
        await h.close();
    }
});
