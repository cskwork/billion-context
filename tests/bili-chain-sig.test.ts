import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER, BILI_SIG_HEADER } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { detectAcpArtifacts, stampChainSig, verifyChainSig } from "../src/server/chain-sig.ts";

/** #1078: chain integrity beyond x-bili-hop (#300). A processing bili stamps
 *  x-bili-sig = sha256 of the exact emitted bytes; the receiving bili verifies
 *  it over the raw inbound buffer before any processing. A mismatch (a relay
 *  rewrote the request) or ACP artifacts in a header-less body (a relay
 *  stripped bili's headers) force the same outcome as the hop marker: skip ALL
 *  processing, forward verbatim, warn loudly. Covers: unit round-trip of
 *  stamp/verify/detect, the clean A→B chain (digest must match received bytes),
 *  rewriting relays, header-stripping relays, legacy marker-only chains, and
 *  the plain-client control (no false positives). */

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string): ProxyOptions {
    return {
        port,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
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

interface RelayBehavior {
    dropHeaders?: string[];
    rewrite?: (json: Record<string, unknown>) => void;
}

type RelaySeen = { url: string; headers: http.IncomingHttpHeaders; body: string };

// An indifferent middlebox: forwards to `target`, optionally dropping named
// headers and/or mutating the JSON body (re-serialization alone changes bytes).
function makeRelay(target: string, behavior: RelayBehavior, seen: RelaySeen[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            let raw = Buffer.concat(chunks);
            if (behavior.rewrite) {
                const json = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
                behavior.rewrite(json);
                raw = Buffer.from(JSON.stringify(json), "utf8");
            }
            seen.push({ url: req.url ?? "", headers: req.headers, body: raw.toString("utf8") });
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
                if (v === undefined) continue;
                const lk = k.toLowerCase();
                if (lk === "host" || lk === "content-length" || lk === "connection") continue;
                if (behavior.dropHeaders?.some((d) => d.toLowerCase() === lk)) continue;
                headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            const upstreamRes = await fetch(target + (req.url ?? "/"), {
                method: req.method ?? "GET",
                headers,
                body: (req.method === "GET" || req.method === "HEAD") ? undefined : raw,
                redirect: "manual",
            });
            res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
            Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(res);
        });
    });
}

function sha256Hex(s: string | Buffer): string {
    return createHash("sha256").update(s).digest("hex");
}

type LogEntry = { level: string; msg: string };

function chainWarns(logs: LogEntry[]): LogEntry[] {
    return logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]"));
}

test("#1078 S3 unit: stampChainSig/verifyChainSig round-trip", () => {
    const h: Record<string, string> = {};
    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
    stampChainSig(h, body);
    assert.equal(h[BILI_SIG_HEADER], `sha256:${sha256Hex(body)}`);
    assert.equal(verifyChainSig(h[BILI_SIG_HEADER], Buffer.from(body, "utf8")), "verified");
    assert.equal(verifyChainSig(h[BILI_SIG_HEADER], Buffer.from(body + " ", "utf8")), "mismatch");
    assert.equal(verifyChainSig(undefined, Buffer.from(body, "utf8")), "absent");
    assert.equal(verifyChainSig(`sha256:${"f".repeat(64)}`, Buffer.from(body, "utf8")), "mismatch");
    assert.equal(verifyChainSig("md5:deadbeef", Buffer.from(body, "utf8")), "mismatch");
    assert.equal(verifyChainSig("garbage", Buffer.from(body, "utf8")), "mismatch");
});

test("#1078 S2 unit: detectAcpArtifacts recognizes rendered payloads only", () => {
    const chat = (content: string, extra: Record<string, unknown> = {}): Buffer =>
        Buffer.from(JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content }], ...extra }), "utf8");
    // Full tag shape as emitted by the kernel renderer (JSON-escaped quotes in
    // the raw body — exactly what a chained bili receives).
    assert.equal(detectAcpArtifacts(chat('x <acp tokens="3" type="text">m00001</acp> y')), true);
    assert.equal(detectAcpArtifacts(chat('x <acp tokens="2.1K" type="tool:bash">m00175</acp> y')), true);
    assert.equal(detectAcpArtifacts(chat('x <acp tokens="12K" type="text">m01234</acp> y')), true);
    // Partial imitation in prose must NOT trip it (full open→ref→close required).
    assert.equal(detectAcpArtifacts(chat('the tag <acp tokens="2" looks odd')), false);
    assert.equal(detectAcpArtifacts(chat("hello world")), false);
    assert.equal(detectAcpArtifacts(Buffer.alloc(0)), false);
    // Tool-name seed: both distinctive names together, never one alone.
    const tools = (names: string[]) => ({ tools: names.map((name) => ({ type: "function", function: { name } })) });
    assert.equal(detectAcpArtifacts(chat("hi", tools(["acp_status", "search_context"]))), true);
    assert.equal(detectAcpArtifacts(chat("hi", tools(["acp_status"]))), false);
    assert.equal(detectAcpArtifacts(chat("hi", tools(["compress", "decompress"]))), false);
});

test("#1078 S3 e2e: clean A→B chain → digest matches received bytes at the LLM", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bUrl = `http://127.0.0.1:${(B.address() as { port: number }).port}`;

    const A = await startServer(makeOpts(0, bUrl));
    await listen(A);
    const aPort = (A.address() as { port: number }).port;

    try {
        const resp = await fetch(`http://127.0.0.1:${aPort}/bili/${bUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-clean" },
            body: JSON.stringify({
                model: MODEL,
                stream: false,
                messages: [
                    { role: "system", content: "You are a test assistant." },
                    { role: "user", content: "hello world" },
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        const markerAtLlm = atLlm.headers[BILI_HOP_HEADER];
        const sigAtLlm = atLlm.headers[BILI_SIG_HEADER];
        assert.ok(markerAtLlm, "A's x-bili-hop marker must reach the LLM (A processed the request)");
        assert.ok(typeof sigAtLlm === "string" && /^sha256:[0-9a-f]{64}$/.test(sigAtLlm),
            `A must stamp a well-formed x-bili-sig, got: ${String(sigAtLlm)}`);
        // The load-bearing assertion: the digest covers the EXACT bytes that
        // arrived — end-to-end proof nothing rewrote the request in transit.
        assert.equal(sigAtLlm, `sha256:${sha256Hex(atLlm.body)}`,
            "x-bili-sig must equal sha256 of the exact body bytes received downstream");

        // Exactly one chain warning (B's hop-marker warn); no mismatch/artifact warns.
        const warns = chainWarns(logs);
        assert.equal(warns.length, 1, `expected exactly one chain warning, got ${warns.length}: ${JSON.stringify(warns)}`);
        assert.ok(warns[0]!.msg.includes(markerAtLlm as string), "chain warning must name A's marker");
        assert.ok(!warns.some((w) => w.msg.includes("does not match")), "clean chain must not report a digest mismatch");
    } finally {
        setLogCapture(null);
        A.closeAllConnections?.();
        await close(A);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1078 S3 e2e: body-rewriting relay → mismatch warn + verbatim passthrough", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bUrl = `http://127.0.0.1:${(B.address() as { port: number }).port}`;

    const relaySeen: RelaySeen[] = [];
    const relay = makeRelay(bUrl, {
        rewrite: (json) => {
            const messages = json.messages as Array<Record<string, unknown>>;
            messages.push({ role: "user", content: "injected by relay" });
        },
    }, relaySeen);
    relay.listen(0, "127.0.0.1");
    await listen(relay);
    const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    const A = await startServer(makeOpts(0, relayUrl));
    await listen(A);
    const aPort = (A.address() as { port: number }).port;

    try {
        const resp = await fetch(`http://127.0.0.1:${aPort}/bili/${relayUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-rewrite" },
            body: JSON.stringify({
                model: MODEL,
                stream: false,
                messages: [
                    { role: "system", content: "You are a test assistant." },
                    { role: "user", content: "hello world" },
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        // B passed the RELAY'S bytes through untouched (no re-processing of
        // content B did not produce).
        assert.equal(relaySeen.length, 1);
        assert.equal(atLlm.body, relaySeen[0]!.body, "LLM must receive the relay's bytes verbatim");
        assert.ok(atLlm.body.includes("injected by relay"), "sanity: the relay's mutation is present");

        // The signature no longer matches the rewritten body → mismatch warn.
        const warns = chainWarns(logs);
        assert.ok(warns.some((w) => w.msg.includes("does not match")),
            `expected a digest-mismatch chain warning, got: ${JSON.stringify(warns)}`);
        // The stale signature propagated but is provably wrong for the new bytes.
        const sigAtLlm = atLlm.headers[BILI_SIG_HEADER];
        assert.ok(typeof sigAtLlm === "string" && sigAtLlm !== `sha256:${sha256Hex(atLlm.body)}`,
            "propagated x-bili-sig must NOT match the rewritten body");
    } finally {
        setLogCapture(null);
        A.closeAllConnections?.();
        await close(A);
        relay.closeAllConnections?.();
        await close(relay);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1078 S2 e2e: header-stripping relay → artifact warn + verbatim passthrough", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bUrl = `http://127.0.0.1:${(B.address() as { port: number }).port}`;

    const relaySeen: RelaySeen[] = [];
    const relay = makeRelay(bUrl, { dropHeaders: [BILI_HOP_HEADER, BILI_SIG_HEADER] }, relaySeen);
    relay.listen(0, "127.0.0.1");
    await listen(relay);
    const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    const A = await startServer(makeOpts(0, relayUrl));
    await listen(A);
    const aPort = (A.address() as { port: number }).port;

    try {
        const resp = await fetch(`http://127.0.0.1:${aPort}/bili/${relayUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-strip" },
            body: JSON.stringify({
                model: MODEL,
                stream: false,
                messages: [
                    { role: "system", content: "You are a test assistant." },
                    { role: "user", content: "hello world" },
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        assert.equal(relaySeen.length, 1);
        assert.equal(atLlm.body, relaySeen[0]!.body, "LLM must receive A's bytes verbatim");
        // A processed the request (tags present); B must not process again.
        assert.ok(atLlm.body.includes("\x3cacp "), "A's processed payload must carry acp tags");
        assert.equal(atLlm.headers[BILI_HOP_HEADER], undefined, "stripped hop header stays absent");
        assert.equal(atLlm.headers[BILI_SIG_HEADER], undefined, "stripped sig header stays absent");

        // No headers left ⇒ only the body-artifact fallback can detect the chain.
        const warns = chainWarns(logs);
        assert.ok(warns.some((w) => w.msg.includes("ACP compression artifacts")),
            `expected an artifact-detection chain warning, got: ${JSON.stringify(warns)}`);
    } finally {
        setLogCapture(null);
        A.closeAllConnections?.();
        await close(A);
        relay.closeAllConnections?.();
        await close(relay);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1078 S2+S3 e2e: strip+rewrite relay → artifact warn + verbatim passthrough", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bUrl = `http://127.0.0.1:${(B.address() as { port: number }).port}`;

    const relaySeen: RelaySeen[] = [];
    const relay = makeRelay(bUrl, {
        dropHeaders: [BILI_HOP_HEADER, BILI_SIG_HEADER],
        rewrite: (json) => {
            const messages = json.messages as Array<Record<string, unknown>>;
            messages.push({ role: "user", content: "injected by relay" });
        },
    }, relaySeen);
    relay.listen(0, "127.0.0.1");
    await listen(relay);
    const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    const A = await startServer(makeOpts(0, relayUrl));
    await listen(A);
    const aPort = (A.address() as { port: number }).port;

    try {
        const resp = await fetch(`http://127.0.0.1:${aPort}/bili/${relayUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-strip-rewrite" },
            body: JSON.stringify({
                model: MODEL,
                stream: false,
                messages: [
                    { role: "system", content: "You are a test assistant." },
                    { role: "user", content: "hello world" },
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        assert.equal(atLlm.body, relaySeen[0]!.body, "LLM must receive the relay's bytes verbatim");
        assert.ok(atLlm.body.includes("injected by relay"), "sanity: the relay's mutation is present");

        // Headers gone AND body mutated: the artifacts fallback still fires
        // (the injected tags survive the rewrite) and there is NO mismatch warn
        // (nothing to compare against).
        const warns = chainWarns(logs);
        assert.ok(warns.some((w) => w.msg.includes("ACP compression artifacts")),
            `expected an artifact-detection chain warning, got: ${JSON.stringify(warns)}`);
        assert.ok(!warns.some((w) => w.msg.includes("does not match")),
            "strip+rewrite must not be reported as a digest mismatch (no sig present)");
    } finally {
        setLogCapture(null);
        A.closeAllConnections?.();
        await close(A);
        relay.closeAllConnections?.();
        await close(relay);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1078 legacy e2e: marker-only chain (pre-signature bili) still passes through", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bPort = (B.address() as { port: number }).port;

    const otherMarker = randomUUID();
    const bodyJson = JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world" },
        ],
    });

    try {
        // An older bili version stamps only x-bili-hop — no x-bili-sig yet.
        const resp = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "sig-legacy",
                [BILI_HOP_HEADER]: otherMarker,
            },
            body: bodyJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, bodyJson, "legacy chain body must pass through byte-identical");
        const warns = chainWarns(logs);
        assert.equal(warns.length, 1, `expected exactly one chain warning, got ${warns.length}: ${JSON.stringify(warns)}`);
        assert.ok(warns[0]!.msg.includes(otherMarker), "warning must name the upstream marker");
        assert.ok(!warns.some((w) => w.msg.includes("does not match")), "absent sig is legacy, not a mismatch");
    } finally {
        setLogCapture(null);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1078 control e2e: plain client direct to B → processed, no chain warnings", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bPort = (B.address() as { port: number }).port;

    const bodyJson = JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world" },
        ],
    });

    try {
        const resp = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-control" },
            body: bodyJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1);
        const atLlm = captured[0]!;
        // B owns this conversation: full pipeline ran (tags + tool injection),
        // and B marks+signs its own emission exactly like A does in chains.
        assert.notEqual(atLlm.body, bodyJson, "plain client body must be transformed by B's pipeline");
        assert.ok(atLlm.body.includes("\x3cacp "), "processed payload must carry acp tags");
        assert.ok(typeof atLlm.headers[BILI_HOP_HEADER] === "string" && atLlm.headers[BILI_HOP_HEADER]!.length > 0,
            "processed emission carries B's own hop marker (a downstream bili will treat it as chained)");
        const sig = atLlm.headers[BILI_SIG_HEADER];
        assert.equal(typeof sig, "string", "processed emission must carry x-bili-sig");
        assert.equal(verifyChainSig(sig, Buffer.from(atLlm.body, "utf8")), "verified",
            "B's signature must verify against the exact bytes it emitted");
        assert.equal(chainWarns(logs).length, 0, "no chain warnings for a plain client");
    } finally {
        setLogCapture(null);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});
