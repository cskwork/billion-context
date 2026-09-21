import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, _resetChainWarningsForTest } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { artifactSeedHit, detectAcpArtifacts } from "../src/server/chain-artifacts.ts";

// #1086: the v0.1.133 chain-detection content fallback judged bili's OWN
// injected ACP artifacts (render tags re-sent by the client, ACP tool names
// in the tools array) as evidence of an upstream bili instance, so a
// single-instance setup passed EVERY turn through unprocessed and the
// compression kernel never ran again. Layers under test:
//   1. detectAcpArtifacts — structural detection (declarations alone are not
//      artifacts; historical tool calls are; real tags are; placeholders aren't).
//   2. self-state exemption — artifacts + local processed state ⇒ processed.
//   3. fresh plugin-mode session (declarations only) ⇒ processed, no warn.
//   4. foreign artifacts without local state ⇒ byte-identical passthrough,
//      exactly one warn per session, no session record created.
//   5. escape valve chainContentDetection=false disables the fallback.
//   6. liveness guard — a plain-client chat-wire session still compresses
//      as it grows (the #1086 failure mode was silent non-compression).

const MODEL = "gpt-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function toolDecl(name: string): Record<string, unknown> {
    return { type: "function", function: { name, description: `${name} test tool`, parameters: { type: "object", properties: {} } } };
}

function historyCall(name: string, id: string): Record<string, unknown> {
    return { id, type: "function", function: { name, arguments: "{}" } };
}

test("#1086 detector: tools declarations alone are NOT artifacts (group E — the #1086 repro)", () => {
    const parsed = { model: MODEL, tools: [toolDecl("acp_status"), toolDecl("search_context")], messages: [{ role: "user", content: "hello world" }] };
    const b = Buffer.from(JSON.stringify(parsed));
    assert.ok(artifactSeedHit(b), "byte pre-filter may hit on declarations");
    assert.equal(detectAcpArtifacts(b, parsed), null, "declarations without historical calls must not be a chain signal");
});

test("#1086 detector: ACP tool names invoked in HISTORY are artifacts (all wire shapes)", () => {
    const openai = { model: MODEL, messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1"), historyCall("search_context", "call_2")] },
        { role: "user", content: "next question" },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(openai)), openai), "tool-history");

    const anthropic = { model: MODEL, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "acp_status", input: {} }, { type: "tool_use", id: "u2", name: "search_context", input: {} }] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(anthropic)), anthropic), "tool-history");

    const responses = { model: MODEL, input: [
        { type: "function_call", call_id: "c1", name: "acp_status", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "search_context", arguments: "{}" },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(responses)), responses), "tool-history");

    const gemini = { model: MODEL, contents: [
        { parts: [{ functionCall: { name: "acp_status" } }, { functionCall: { name: "search_context" } }] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(gemini)), gemini), "tool-history");
});

test("#1086 detector: real render tag is an artifact; placeholder tag and prose are not", () => {
    const realTag = "\x3cacp tokens=\"1.2K\" type=\"text\"\x3em00042\x3c/acp\x3e";
    const tagged = { model: MODEL, messages: [{ role: "user", content: `history ${realTag}` }] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(tagged)), tagged), "tags");
    const fullTagged = JSON.stringify(tagged);
    const unparseable = Buffer.from(fullTagged.slice(0, fullTagged.length - 4));
    assert.equal(detectAcpArtifacts(unparseable, null), "tags", "tag family must fire even when the body is unparseable (wire-escaped tag bytes intact)");

    const placeholder = "\x3cacp tokens=\"N\" type=\"text\"\x3em00042\x3c/acp\x3e";
    const ph = { model: MODEL, messages: [{ role: "user", content: placeholder }] };
    assert.ok(artifactSeedHit(Buffer.from(JSON.stringify(ph))));
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(ph)), ph), null, "placeholder tag (tokens=\"N\") is not a kernel artifact");

    const prose = { model: MODEL, messages: [{ role: "user", content: 'I called "acp_status" and "search_context" earlier' }] };
    const proseBuf = Buffer.from(JSON.stringify(prose));
    assert.equal(artifactSeedHit(proseBuf), false, "JSON-escaped prose quotes never hit the byte pre-filter");
    assert.equal(detectAcpArtifacts(proseBuf, prose), null, "prose mentioning the names is not a tool invocation");

    const renamed = { model: MODEL, tools: [toolDecl("ctx_status"), toolDecl("ctx_search")], messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("ctx_status", "call_1"), historyCall("ctx_search", "call_2")] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(renamed)), renamed), null, "renamed lookalike tools (group D) are not bili artifacts");

    const oneOnly = { model: MODEL, messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1")] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(oneOnly)), oneOnly), null, "one of the two ACP tools called is not sufficient");
});

function makeOpts(upstream: string, extra?: Partial<ProxyOptions>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
        ...extra,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

type LogRec = { level: string; msg: string };
const chainWarns = (logs: LogRec[], sessionId?: string): LogRec[] =>
    logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]") && (!sessionId || l.msg.includes(sessionId)));

// The #1086 incident shape: a bili-managed client whose history contains real
// invocations of both ACP tools (the plugin surfaces them; the model used them).
function incidentBody(): string {
    return JSON.stringify({
        model: MODEL,
        stream: false,
        tools: [toolDecl("acp_status"), toolDecl("search_context")],
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world, please help me with a task" },
            { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1"), historyCall("search_context", "call_2")] },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
            { role: "tool", tool_call_id: "call_2", content: "ok" },
        ],
    });
}

test("#1086 T1: self-produced artifacts (local processed state) are processed normally", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const s = getSession("own-1", { protocol: "openai" });
        s.stats.requests = 1;
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "own-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "self-produced artifacts must go through the kernel (rebuilt body), not raw passthrough");
        assert.equal(chainWarns(logs, "own-1").length, 0, "no chain warning may fire for own-session artifacts");
        assert.equal(peekSession("own-1")?.stats.requests, 2, "kernel must have processed the request (stats advanced)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1086 T2: fresh plugin-mode session (declarations only) is processed, not judged a chain", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        // Exact #1086 startup scenario: brand-new opencode-native session,
        // first request already carries the ACP tool declarations.
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            tools: [toolDecl("acp_status"), toolDecl("search_context")],
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "user", content: "hello world, what can you do?" },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fresh-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "request must be rebuilt by the kernel, not passed through");
        assert.equal(chainWarns(logs, "fresh-1").length, 0, "declarations alone must never warn or bypass (#1086 regression)");
        assert.equal(peekSession("fresh-1")?.stats.requests, 1);
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1086 T3: foreign artifacts without local state pass through byte-identical, one warn, no state", async () => {
    // #1100: "no local state ⇒ foreign" holds only when persistence proves ownership
    // across a restart, so T3 runs an ENABLED store over an empty temp dir (truly
    // foreign). Disabled-store variant is ambiguous (own session after restart) → T6.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t3-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        for (let i = 0; i < 2; i++) {
            const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "foreign-1" },
                body: raw,
            });
            assert.equal(resp.status, 200);
            await resp.text();
        }
        assert.equal(captured.length, 2);
        assert.equal(captured[0]!.body, raw, "foreign payload must reach the LLM byte-identical (no kernel processing)");
        assert.equal(captured[1]!.body, raw);
        const warns = chainWarns(logs, "foreign-1");
        assert.equal(warns.length, 1, `exactly one warn per session (got ${warns.length}: ${JSON.stringify(warns)})`);
        assert.ok(warns[0]!.msg.includes("chainContentDetection=false"), "warning must point at the escape valve");
        assert.equal(peekSession("foreign-1"), undefined, "foreign sessions must leave no trace in this instance");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1086 T4: chainContentDetection=false disables the content fallback entirely", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, { chainContentDetection: false }));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "valve-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "valve off ⇒ artifacts ignored, kernel processes");
        assert.equal(chainWarns(logs).length, 0);
        assert.ok(peekSession("valve-1")?.stats.requests === 1);
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1100 T6: BILI_PERSIST=0 + restart ⇒ replayed own session is processed, not permanently passed through", async () => {
    // Post-restart shape: store disabled (BILI_PERSIST=0) and memory cleared, so this
    // instance cannot prove ownership of the ACP artifacts the client re-sends. Pre-#1100
    // that read as "chain" → passthrough forever (#1086 symptom); it must be processed.
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "own-restart-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "#1100: persist-off own session must be rebuilt by the kernel, NOT passed through verbatim");
        assert.equal(chainWarns(logs, "own-restart-1").length, 0, "ownership is unprovable (not confirmed-foreign), so no chain warning may fire");
        assert.equal(peekSession("own-restart-1")?.stats.requests, 1, "kernel must have processed the request (session created, stats advanced)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

async function readSseText(resp: Response): Promise<string> {
    if (!resp.body) return "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
                const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                const c = chunk.choices?.[0]?.delta?.content;
                if (typeof c === "string") out += c;
            } catch {
                // keep-alive comment line — ignore
            }
        }
    }
    return out;
}

test("#1086 T5 liveness: plain-client chat session keeps compressing as it grows", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const THRESHOLD = 24 * 1024;
    const state = { bodies: [] as string[], compressCalls: 0, lastDemandBytes: Infinity, sinceDemand: 99 };
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const bytes = Buffer.byteLength(body);
            state.bodies.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            state.sinceDemand++;
            const noShrinkAfterDemand = state.sinceDemand <= 2 && bytes >= state.lastDemandBytes * 0.9;
            const shouldCompress = bytes > THRESHOLD && refIds.length >= 12 && !noShrinkAfterDemand;
            if (shouldCompress) {
                state.lastDemandBytes = bytes;
                state.sinceDemand = 0;
                state.compressCalls++;
                const from = refIds[2]!;
                const to = refIds[refIds.length - 10]!;
                res.write(sseLine({
                    id: "g1",
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{
                                index: 0,
                                id: `call_compress_${state.compressCalls}`,
                                type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{ startId: from, endId: to, topic: "liveness guard", summary: `summary covering ${from}..${to}: incremental context growth turns, per-turn overhead measurements, and periodic compression cycles; key results were recorded at each checkpoint.` }],
                                    }),
                                },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            } else {
                const text = `reply ${state.bodies.length} ` + "x".repeat(360);
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    relay.listen(0, "127.0.0.1");
    await listen(relay);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(relay.address() as { port: number }).port}`, {
        kernelConfig: defaultConfig(400_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 400, maxSummaryLength: 20000, minSummaryLength: 20 },
        }),
    }));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const TURNS = 60;
        const userText = (i: number): string => `turn ${i}: ` + "filler ".repeat(80);
        const messages: Array<{ role: string; content?: string | null }> = [{ role: "system", content: "You are a test assistant." }];
        let nonEmptyReplies = 0;
        for (let i = 0; i < TURNS; i++) {
            messages.push({ role: "user", content: userText(i) });
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "liveness-1" },
                body: JSON.stringify({ model: MODEL, stream: true, messages }),
            });
            assert.equal(resp.status, 200, `turn ${i} must succeed`);
            const text = await readSseText(resp);
            if (text.length > 0) nonEmptyReplies++;
            else assert.ok(state.bodies[state.bodies.length - 1]!.includes('"compress"'), `turn ${i}: empty reply without a pending compress round-trip`);
            messages.push({ role: "assistant", content: text });
        }
        assert.ok(state.compressCalls >= 1, `expected at least one model-driven compress round-trip, got ${state.compressCalls}`);
        const maxBytes = Math.max(...state.bodies.map((b) => Buffer.byteLength(b)));
        assert.ok(maxBytes < THRESHOLD * 2, `upstream context exceeded bound after compression: ${maxBytes} >= ${THRESHOLD * 2}`);
        assert.equal(nonEmptyReplies, TURNS, "every client turn must get a visible reply");
        assert.equal(chainWarns(logs).length, 0, "no chain warning may fire on a plain self-run session");
        assert.ok(peekSession("liveness-1")!.state.nextBlockId > 1, "kernel must have persisted compression blocks (compression actually ran)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        relay.closeAllConnections?.();
        await close(relay);
    }
}, { timeout: 120_000 });
