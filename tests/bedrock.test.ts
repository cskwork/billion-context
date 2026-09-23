import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import {
    bedrockControlPlane,
    bedrockInvokePath,
    bedrockOutbound,
    bedrockResponseToSse,
    crc32,
    encodeEventStreamFrame,
    EventStreamDecoder,
    normalizeBedrockRequest,
    SseToEventStream,
} from "../src/bedrock.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { buildClaudeBedrockLaunch, claudeBedrockUpstream, readClaudeSettings } from "../src/launcher.ts";
import { listSessions } from "../src/session.ts";

// Independent AWS event-stream oracle (zlib.crc32, string headers only) so the
// codec under test is checked against the wire format, not against itself.
function oracleFrame(headers: Record<string, string>, payload: Buffer): Buffer {
    const hp: Buffer[] = [];
    for (const [k, v] of Object.entries(headers)) {
        const kb = Buffer.from(k);
        const vb = Buffer.from(v);
        hp.push(Buffer.from([kb.length]), kb, Buffer.from([7]), Buffer.from([vb.length >> 8, vb.length & 0xff]), vb);
    }
    const hb = Buffer.concat(hp);
    const prelude = Buffer.alloc(8);
    prelude.writeUInt32BE(12 + hb.length + payload.length + 4, 0);
    prelude.writeUInt32BE(hb.length, 4);
    const pcrc = Buffer.alloc(4);
    pcrc.writeUInt32BE(zlib.crc32(prelude), 0);
    const body = Buffer.concat([prelude, pcrc, hb, payload]);
    const mcrc = Buffer.alloc(4);
    mcrc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([body, mcrc]);
}

function oracleDecode(buf: Buffer): Array<{ headers: Record<string, string>; payload: string }> {
    const out: Array<{ headers: Record<string, string>; payload: string }> = [];
    let o = 0;
    while (o < buf.length) {
        const total = buf.readUInt32BE(o);
        const hl = buf.readUInt32BE(o + 4);
        assert.equal(buf.readUInt32BE(o + 8), zlib.crc32(buf.subarray(o, o + 8)), "prelude CRC");
        assert.equal(buf.readUInt32BE(o + total - 4), zlib.crc32(buf.subarray(o, o + total - 4)), "message CRC");
        const headers: Record<string, string> = {};
        let h = o + 12;
        while (h < o + 12 + hl) {
            const nl = buf[h]!;
            const name = buf.toString("utf8", h + 1, h + 1 + nl);
            assert.equal(buf[h + 1 + nl], 7, "string header");
            const vl = buf.readUInt16BE(h + 2 + nl);
            headers[name] = buf.toString("utf8", h + 4 + nl, h + 4 + nl + vl);
            h += 4 + nl + vl;
        }
        out.push({ headers, payload: buf.toString("utf8", o + 12 + hl, o + total - 4) });
        o += total;
    }
    return out;
}

const CHUNK = { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" };

function chunkFrame(event: unknown): Buffer {
    return oracleFrame(CHUNK, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64"), p: "abcd" })));
}

function exceptionFrame(type: string, payload: unknown): Buffer {
    return oracleFrame({ ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" }, Buffer.from(JSON.stringify(payload)));
}

/** Client-side view: event-stream bytes → the Anthropic events a Bedrock SDK yields. */
function clientEvents(buf: Buffer): Array<Record<string, unknown>> {
    return oracleDecode(buf).map((f) => {
        if (f.headers[":message-type"] === "exception") return { exception: f.headers[":exception-type"], ...JSON.parse(f.payload) };
        if (f.headers[":event-type"] !== "chunk") return { skipped: f.headers[":event-type"] };
        return JSON.parse(Buffer.from((JSON.parse(f.payload) as { bytes: string }).bytes, "base64").toString("utf8")) as Record<string, unknown>;
    });
}

const TEXT_EVENTS = [
    { type: "message_start", message: { id: "msg_b1", type: "message", role: "assistant", content: [], usage: { input_tokens: 21, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo 🌍" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 21, outputTokenCount: 4 } },
];

test("bedrock event-stream codec: CRC32 matches zlib, frames round-trip across every split point, corruption is rejected", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    const headers = { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" };
    const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from('{"type":"ping"}').toString("base64") }));
    const encoded = encodeEventStreamFrame(headers, payload);
    assert.deepEqual(encoded, oracleFrame(headers, payload), "encoder output is byte-identical to the wire-format oracle");
    const two = Buffer.concat([encoded, oracleFrame({ ":message-type": "event", ":event-type": "x" }, Buffer.from("{}"))]);
    for (let cut = 0; cut <= two.length; cut++) {
        const d = new EventStreamDecoder();
        const frames = [...d.push(two.subarray(0, cut)), ...d.push(two.subarray(cut))];
        assert.equal(frames.length, 2, `split at ${cut}`);
        assert.deepEqual(frames[0]!.headers, headers);
        assert.deepEqual(frames[0]!.payload, payload);
        assert.equal(d.pending, 0);
    }
    const corrupt = Buffer.from(encoded);
    corrupt[20] ^= 0xff;
    assert.throws(() => new EventStreamDecoder().push(corrupt), /message CRC mismatch/);
    const badPrelude = Buffer.from(encoded);
    badPrelude[2] ^= 0x01;
    assert.throws(() => new EventStreamDecoder().push(badPrelude), /prelude CRC mismatch/);
});

test("bedrock response: event-stream chunks decode to Anthropic SSE and re-encode to the same client-visible events", async () => {
    const upstream = new Response(Buffer.concat(TEXT_EVENTS.map(chunkFrame)), {
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "r1" },
    });
    const converted = bedrockResponseToSse(upstream);
    assert.equal(converted.headers.get("content-type"), "text/event-stream");
    assert.equal(converted.headers.get("x-amzn-requestid"), "r1");
    const sse = await converted.text();
    assert.equal(sse, TEXT_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    const enc = new SseToEventStream();
    const bytes = Buffer.from(sse);
    const out = Buffer.concat([enc.push(bytes.subarray(0, 37)), enc.push(bytes.subarray(37)), enc.flush()]);
    assert.deepEqual(clientEvents(out), TEXT_EVENTS);
});

test("bedrock exception frames: never swallowed — decoded to an in-band error and restored as the same exception frame", async () => {
    const upstream = new Response(Buffer.concat([chunkFrame(TEXT_EVENTS[0]), exceptionFrame("throttlingException", { message: "Too many tokens, please wait." })]), {
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
    });
    const sse = await bedrockResponseToSse(upstream).text();
    assert.match(sse, /event: error\ndata: \{"type":"error","error":\{"type":"throttlingException","message":"Too many tokens, please wait\."\}\}\n\n$/);
    const enc = new SseToEventStream();
    const frames = oracleDecode(Buffer.concat([enc.push(sse), enc.flush()]));
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1], {
        headers: { ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" },
        payload: JSON.stringify({ message: "Too many tokens, please wait." }),
    });
    const model = await bedrockResponseToSse(new Response(exceptionFrame("modelStreamErrorException", { message: "boom", originalStatusCode: 500 }), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
    })).text();
    const again = new SseToEventStream();
    assert.deepEqual(clientEvents(Buffer.concat([again.push(model), again.flush()])), [{ exception: "modelStreamErrorException", message: "boom", originalStatusCode: 500 }]);
    const own = new SseToEventStream();
    const ownErr = { type: "error", error: { type: "server_error", code: "upstream_stream_truncated", message: "cut" } };
    assert.deepEqual(clientEvents(Buffer.concat([own.push(`event: error\ndata: ${JSON.stringify(ownErr)}\n\n: bili-preflight\n\n`), own.flush()])), [ownErr, { skipped: "bili-keepalive" }]);
    await assert.rejects(bedrockResponseToSse(new Response(chunkFrame(TEXT_EVENTS[0]).subarray(0, 30), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
    })).text(), /truncated frame/);
});

test("bedrock request normalization: inbound gains model/stream, outbound restores the exact Bedrock path and body", () => {
    const raw = { anthropic_version: "bedrock-2023-05-31", anthropic_beta: ["context-1m-2025-08-07"], max_tokens: 64, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
    const url = "http://h/bili/https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1:0/invoke-with-response-stream";
    const inv = bedrockInvokePath(new URL(url).pathname);
    assert.deepEqual(inv, { modelId: "us.anthropic.claude-opus-5-5-v1:0", stream: true });
    const norm = JSON.parse(normalizeBedrockRequest(Buffer.from(JSON.stringify(raw)), inv!)!.toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(norm, { model: "us.anthropic.claude-opus-5-5-v1:0", ...raw, stream: true });
    const upstreamUrl = "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1:0/invoke-with-response-stream";
    const out = bedrockOutbound(upstreamUrl, JSON.stringify(norm));
    assert.ok(out);
    assert.equal(out.url, upstreamUrl);
    assert.deepEqual(JSON.parse(out.body), raw);
    const arn = "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc";
    const arnUrl = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(arn)}/invoke`;
    const arnInv = bedrockInvokePath(new URL(arnUrl).pathname);
    assert.deepEqual(arnInv, { modelId: arn, stream: false });
    const arnOut = bedrockOutbound(arnUrl, normalizeBedrockRequest(Buffer.from(JSON.stringify({ messages: [] })), arnInv!));
    assert.equal(arnOut?.url, arnUrl, "an unchanged model keeps its original path segment");
    const summary = bedrockOutbound(upstreamUrl, JSON.stringify({ model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", max_tokens: 10, system: "sum", messages: [{ role: "user", content: "x" }], stream: false }));
    assert.equal(summary?.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke");
    assert.deepEqual(JSON.parse(summary!.body), { max_tokens: 10, system: "sum", messages: [{ role: "user", content: "x" }], anthropic_version: "bedrock-2023-05-31" });
    const mapped = bedrockControlPlane("https://bedrock-runtime.us-east-1.amazonaws.com/inference-profiles?maxResults=100", { host: "bedrock-runtime.us-east-1.amazonaws.com", authorization: "Bearer t" });
    assert.deepEqual(mapped, { url: "https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=100", headers: { authorization: "Bearer t", host: "bedrock.us-east-1.amazonaws.com" } });
});

test("bedrock: non-Bedrock requests and responses are left untouched", async () => {
    for (const p of ["/v1/messages", "/bili/https://api.anthropic.com/v1/messages", "/v1beta/models/gemini-2.5-pro:streamGenerateContent", "/model/m/count-tokens", "/model/m/converse-stream", "/models/m/invoke"]) {
        assert.equal(bedrockInvokePath(p), null, p);
    }
    const body = JSON.stringify({ model: "claude-x", stream: true, messages: [] });
    assert.equal(bedrockOutbound("https://api.anthropic.com/v1/messages", body), undefined);
    assert.equal(bedrockOutbound("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke", JSON.stringify({ anthropic_version: "bedrock-2023-05-31", messages: [] })), undefined, "a raw (unnormalized) Bedrock body passes verbatim");
    assert.equal(bedrockOutbound("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/count-tokens", body), undefined);
    assert.equal(bedrockOutbound("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke", "not json"), undefined);
    assert.equal(bedrockControlPlane("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke", {}), undefined);
    assert.equal(bedrockControlPlane("https://gateway.example.com/inference-profiles", {}), undefined);
    const sse = new Response("event: ping\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    assert.equal(bedrockResponseToSse(sse), sse);
    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    assert.equal(bedrockResponseToSse(json), json);
});

test("bedrock launcher: mode detection follows claude's precedence and the spawn env routes the runtime via the proxy", () => {
    assert.equal(claudeBedrockUpstream({ CLAUDE_CODE_USE_BEDROCK: "1" }, { bedrockEnv: { CLAUDE_CODE_USE_BEDROCK: "0" } }), undefined, "settings env beats the shell");
    assert.equal(claudeBedrockUpstream({}, { bedrockEnv: { CLAUDE_CODE_USE_BEDROCK: "true", AWS_REGION: "eu-west-1" } }), "https://bedrock-runtime.eu-west-1.amazonaws.com");
    assert.equal(claudeBedrockUpstream({ CLAUDE_CODE_USE_BEDROCK: "1" }, undefined), "https://bedrock-runtime.us-east-1.amazonaws.com");
    assert.equal(claudeBedrockUpstream({ BILI_CLAUDE_BEDROCK: "1", AWS_REGION: "ap-northeast-2" }, { bedrockEnv: { CLAUDE_CODE_USE_BEDROCK: "0" } }), "https://bedrock-runtime.ap-northeast-2.amazonaws.com");
    assert.equal(claudeBedrockUpstream({ BILI_CLAUDE_BEDROCK: "0", CLAUDE_CODE_USE_BEDROCK: "1" }, undefined), undefined);
    assert.equal(claudeBedrockUpstream({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:9/bili/https://gw.example.com/bedrock/" }, undefined), "https://gw.example.com/bedrock");
    assert.equal(claudeBedrockUpstream({}, undefined), undefined);

    const launch = buildClaudeBedrockLaunch("http://127.0.0.1:8787", "/ca.pem", "https://bedrock-runtime.us-east-1.amazonaws.com", { NO_PROXY: "corp.local", AWS_BEARER_TOKEN_BEDROCK: "secret" });
    assert.equal(launch.env.ANTHROPIC_BEDROCK_BASE_URL, "http://127.0.0.1:8787/bili/https://bedrock-runtime.us-east-1.amazonaws.com");
    assert.equal(launch.env.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(launch.env.NO_PROXY, "corp.local,localhost,127.0.0.1,::1");
    assert.equal(launch.env.AWS_BEARER_TOKEN_BEDROCK, "secret", "credentials pass through to claude untouched");
    assert.equal(launch.env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.deepEqual(JSON.parse(launch.settingsArg), { env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:8787/bili/https://bedrock-runtime.us-east-1.amazonaws.com" } });

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bedrock-"));
    try {
        fs.mkdirSync(path.join(home, ".claude"));
        fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2", AWS_BEARER_TOKEN_BEDROCK: "tok-secret-123" } }));
        const cfg = readClaudeSettings(home, os.tmpdir(), {});
        assert.deepEqual(cfg.bedrockEnv, { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" });
        assert.equal(cfg.bedrockBearer, true);
        assert.ok(!JSON.stringify(cfg).includes("tok-secret-123"), "the bearer token value is never captured");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// --- through the real proxy: Bedrock in, Bedrock out, Anthropic pipeline in between ---

const MODEL = "us.anthropic.claude-test-v1:0";

function compressRound(): unknown[] {
    const args = JSON.stringify({ startId: "m00001", endId: "m00002", topic: "t", summary: "bedrock compress round trip" });
    return [
        { type: "message_start", message: { id: "msg_c1", type: "message", role: "assistant", content: [], usage: { input_tokens: 55, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b1", name: "compress", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 17) } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(17) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
    ];
}

function textRound(text: string): unknown[] {
    return [
        { type: "message_start", message: { id: "msg_c2", type: "message", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
    ];
}

interface Captured { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

async function withRig(scripts: Buffer[], fn: (proxyBase: string, upstreamOrigin: string, captured: Captured[]) => Promise<void>): Promise<void> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
            if ((req.url ?? "").endsWith("/v1/messages")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(textRound("plain").map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
                return;
            }
            const script = scripts[Math.min(captured.length - 1, scripts.length - 1)]!;
            res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": `req-${captured.length}` });
            res.write(script.subarray(0, 7));
            res.end(script.subarray(7));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 400_000 }, "claude-test": { context: 400_000 } } } },
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
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`, `http://127.0.0.1:${upstreamPort}`, captured);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

function bedrockPost(base: string, body: Record<string, unknown>, session = "bedrock-e2e", extraHeaders: Record<string, string> = { "anthropic-beta": "claude-code-20250219" }): Promise<Response> {
    return fetch(`${base}/model/${MODEL}/invoke-with-response-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-bedrock-token", "x-acp-session": session, ...extraHeaders },
        body: JSON.stringify(body),
    });
}

test("bedrock through the proxy: the body's anthropic_beta context-1m sizes the window (Bedrock carries it there, not in the header)", async () => {
    await withRig([Buffer.concat(textRound("ok").map(chunkFrame))], async (base) => {
        const resp = await bedrockPost(base, { anthropic_version: "bedrock-2023-05-31", anthropic_beta: ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"], max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }, "bedrock-window");
        assert.equal(resp.status, 200);
        await resp.arrayBuffer();
        const s = listSessions().find((x) => x.metadata.effectiveContextLimit !== undefined && JSON.stringify(x).includes("bedrock-window"));
        assert.equal(s?.metadata.effectiveContextLimit, 1_000_000);
    });
});

test("bedrock through the proxy: compress loop runs on the Bedrock wire (tools injected, Bedrock shape + auth upstream, event-stream back)", async () => {
    await withRig([Buffer.concat(compressRound().map(chunkFrame)), Buffer.concat(textRound("Done after compress").map(chunkFrame))], async (base, _origin, captured) => {
        const clientBody = { anthropic_version: "bedrock-2023-05-31", anthropic_beta: ["context-1m-2025-08-07"], max_tokens: 1024, system: "You are a test assistant.", messages: [{ role: "user", content: "please compress now" }] };
        const resp = await bedrockPost(base, clientBody);
        assert.equal(resp.status, 200);
        assert.equal(resp.headers.get("content-type"), "application/vnd.amazon.eventstream");
        const events = clientEvents(Buffer.from(await resp.arrayBuffer()));

        assert.equal(captured.length, 2, "round 1 + the compress-loop re-request");
        for (const c of captured) {
            assert.equal(c.method, "POST");
            assert.equal(c.url, `/model/${MODEL}/invoke-with-response-stream`);
            assert.equal(c.headers.authorization, "Bearer test-bedrock-token", "bearer auth forwarded untouched");
            const sent = JSON.parse(c.body) as Record<string, unknown>;
            assert.equal(sent.model, undefined, "model rides the path, never the body");
            assert.equal(sent.stream, undefined);
            assert.equal(sent.anthropic_version, "bedrock-2023-05-31");
            assert.deepEqual(sent.anthropic_beta, ["context-1m-2025-08-07"]);
            const tools = (sent.tools as Array<{ name: string }> | undefined ?? []).map((t) => t.name);
            assert.ok(tools.includes("compress"), `compress tool injected on the Bedrock wire: ${JSON.stringify(tools)}`);
            assert.match(JSON.stringify(sent.system), /compress/i);
        }
        const round2 = JSON.parse(captured[1]!.body) as { messages: Array<{ content: unknown }> };
        assert.ok(JSON.stringify(round2.messages).includes('"tool_use_id":"toolu_b1"'), "re-request carries the compress tool_result");

        const text = events.filter((e) => e.type === "content_block_delta").map((e) => ((e.delta as { text?: string }).text ?? "")).join("");
        assert.match(text, /Done after compress/);
        assert.equal(events.filter((e) => e.type === "content_block_start" && (e.content_block as { name?: string }).name === "compress").length, 0, "compress tool_use never reaches the client");
        assert.equal(events.filter((e) => e.type === "message_stop").length, 1);
    });
});

test("bedrock through the proxy: an upstream exception frame reaches the client as the same exception", async () => {
    const script = Buffer.concat([chunkFrame(textRound("x")[0]), exceptionFrame("throttlingException", { message: "Too many requests, please wait before trying again." })]);
    await withRig([script], async (base, _origin, captured) => {
        const resp = await bedrockPost(base, { anthropic_version: "bedrock-2023-05-31", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
        assert.equal(resp.status, 200);
        const events = clientEvents(Buffer.from(await resp.arrayBuffer()));
        const tools = ((JSON.parse(captured[0]!.body) as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
        assert.ok(tools.includes("compress"), "the stream went through the pipeline, not a blind relay");
        assert.equal(events[0]?.type, "message_start");
        assert.deepEqual(events.find((e) => e.exception !== undefined), { exception: "throttlingException", message: "Too many requests, please wait before trying again." });
    });
});

test("bedrock through the proxy: non-Bedrock /v1/messages traffic on the same instance stays SSE", async () => {
    await withRig([], async (base, _origin, captured) => {
        const resp = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "plain-anthropic" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(resp.status, 200);
        assert.equal(resp.headers.get("content-type"), "text/event-stream");
        assert.match(await resp.text(), /^event: message_start\ndata: /);
        const sent = JSON.parse(captured[0]!.body) as Record<string, unknown>;
        assert.equal(sent.model, "claude-test");
        assert.equal(sent.stream, true);
        assert.equal(sent.anthropic_version, undefined);
    });
});
