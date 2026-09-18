// #955 runtime-info protocol: plugins report the client's OWN model config
// (model id / contextWindow / maxOutput) to the proxy — via per-request
// headers and a bootstrap POST — and the proxy prefers that truth over
// registry/table guessing in the native-window chain.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import {
    _resetPluginStateForTest,
    handlePluginRuntimeInfo,
    pluginReportedMaxOutput,
    pluginReportedModel,
    pluginRuntimeInfoFor,
    recordPluginRuntimeInfo,
} from "../src/plugin.ts";
import { extractV1Outputs } from "../src/agent/opencode-native.ts";
import { reportRuntimeInfoOnChange } from "../src/agent/shared.ts";

function mockRes(): { res: http.ServerResponse; body(): string } {
    let body = "";
    const res = {
        writeHead: () => undefined,
        end: (chunk: unknown) => {
            body = String(chunk);
        },
    } as unknown as http.ServerResponse;
    return { res, body: () => body };
}

describe("runtime-info header parsing (#955)", () => {
    it("max-output is honored only from a plugin request", () => {
        const headers = { "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "32768" };
        assert.equal(pluginReportedMaxOutput(headers), 32768);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin-max-output": "32768" }), undefined);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "nope" }), undefined);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "0" }), undefined);
    });

    it("model id is honored only from a plugin request and must be a bare token", () => {
        assert.equal(pluginReportedModel({ "x-bili-plugin": "pi", "x-bili-plugin-model": "qwen3.5-33b" }), "qwen3.5-33b");
        assert.equal(pluginReportedModel({ "x-bili-plugin-model": "qwen" }), undefined);
        assert.equal(pluginReportedModel({ "x-bili-plugin": "pi", "x-bili-plugin-model": "a b" }), undefined);
    });
});

describe("runtime-info endpoint handler (#955)", () => {
    beforeEach(() => _resetPluginStateForTest());
    afterEach(() => _resetPluginStateForTest());

    it("stores a valid report and rejects incomplete ones", () => {
        const ok = mockRes();
        handlePluginRuntimeInfo(JSON.stringify({ agent: "dsh", model: "m1", contextWindow: 262144, maxOutput: 8192, baseURL: "http://x", source: "client-config" }), ok.res);
        assert.ok(JSON.parse(ok.body()).ok);
        const entry = pluginRuntimeInfoFor("dsh", "m1");
        assert.equal(entry?.contextWindow, 262144);
        assert.equal(entry?.maxOutput, 8192);

        const bad = mockRes();
        handlePluginRuntimeInfo(JSON.stringify({ agent: "dsh" }), bad.res);
        assert.equal(JSON.parse(bad.body()).ok, false);

        const badJson = mockRes();
        handlePluginRuntimeInfo("not json", badJson.res);
        assert.equal(JSON.parse(badJson.body()).ok, false);
    });

    it("model-mismatched lookups return nothing (stale post-switch entry must not size a different model)", () => {
        recordPluginRuntimeInfo({ agent: "dsh", model: "old-model", contextWindow: 1000, source: "client-config", ts: Date.now() });
        assert.equal(pluginRuntimeInfoFor("dsh", "other-model"), undefined);
        assert.equal(pluginRuntimeInfoFor(undefined, "old-model"), undefined);
    });

    it("evicts oldest entries beyond the cap", () => {
        for (let i = 0; i < 40; i++) {
            recordPluginRuntimeInfo({ agent: `a${i}`, model: "m", source: "t", ts: Date.now() });
        }
        assert.equal(pluginRuntimeInfoFor("a0", "m"), undefined);
        assert.notEqual(pluginRuntimeInfoFor("a39", "m"), undefined);
    });
});

describe("extractV1Outputs (#955)", () => {
    it("reads limit.output from provider models", () => {
        const map = extractV1Outputs({ provider: { p1: { models: { m1: { limit: { context: 1000, output: 512 } }, m2: { limit: { context: 1000 } } } } } } as never);
        assert.equal(map.get("p1/m1"), 512);
        assert.equal(map.has("p1/m2"), false);
    });
});

describe("reportRuntimeInfoOnChange (#955)", () => {
    const originalFetch = globalThis.fetch;
    const posts: { url: string; body: unknown }[] = [];

    beforeEach(() => {
        posts.length = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            posts.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("posts once per model switch, and retries after a failure", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1", contextWindow: 1000 });
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1", contextWindow: 1000 });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.url, "http://proxy/__bili/plugin/runtime-info");

        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m2" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
        assert.equal((posts[1]?.body as { model: string }).model, "m2");

        reportRuntimeInfoOnChange(undefined, { agent: "pi", model: "m3" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
    });

    it("rolls back the dedupe key on failure so the next stamp retries", async () => {
        globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1" });
        await new Promise((r) => setTimeout(r, 10));
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            posts.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);
    });
});

// ---- E2E: the window chain prefers a matching runtime-info report ----

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: {} } },
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");

    return {
        proxyPort: proxy.address().port,
        upstreamPort,
        close: async () => {
            proxy.close();
            upstream.close();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

describe("runtime-info in the native-window chain (#955, e2e)", () => {
    let h: Harness | undefined;
    beforeEach(async () => {
        h = await startHarness();
    });
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    it("a matching bootstrap report sizes the window when no header carries one", async () => {
        const report = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 262144, maxOutput: 32768, source: "client-config" }),
        });
        assert.equal(report.status, 200);

        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-1" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);

        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-1`)).json() as { model: string | null; windowSource: string | null; runtimeInfo: { contextWindow?: number } | null };
        assert.equal(status.model, "test-model");
        assert.equal(status.windowSource, "runtime-info");
        assert.equal(status.runtimeInfo?.contextWindow, 262144);
    });

    it("a per-request window header still outranks the runtime table", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 111111, source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-2", "x-bili-plugin-context-window": "222222" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-2`)).json() as { windowSource: string | null };
        assert.equal(status.windowSource, "plugin");
    });

    it("a report for a DIFFERENT model never sizes this request", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "other-model", contextWindow: 111111, source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-3" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-3`)).json() as { windowSource: string | null };
        assert.notEqual(status.windowSource, "runtime-info");
    });
});
