import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { buildClaudeEnv, type HttpRewrite } from "../src/launcher.ts";

// claude ≥ 2.1.280 sends every request through HTTPS_PROXY — the plain-http
// loopback ANTHROPIC_BASE_URL included — unless NO_PROXY excludes the host.
// Through the proxy, the /bili/ base URL arrives as an absolute-form forward
// of the proxy itself and is denied ("the bili tunnel may not target the proxy
// itself", 403), so every model call of `bili claude` failed.

function noProxyMatches(host: string, noProxy: string | undefined): boolean {
    return (noProxy ?? "").split(",").map((h) => h.trim()).filter(Boolean).some((h) => h === host || host.endsWith(h.startsWith(".") ? h : `.${h}`));
}

/** Route one request the way claude does: HTTPS_PROXY for any scheme, NO_PROXY honored. */
function claudeLikePost(url: string, env: NodeJS.ProcessEnv, body: string): Promise<{ status: number; text: string }> {
    const target = new URL(url);
    const proxy = env.HTTPS_PROXY ? new URL(env.HTTPS_PROXY) : undefined;
    const viaProxy = proxy !== undefined && !noProxyMatches(target.hostname, env.NO_PROXY ?? env.no_proxy);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: viaProxy ? proxy.hostname : target.hostname,
            port: viaProxy ? proxy.port : target.port,
            path: viaProxy ? target.toString() : target.pathname + target.search,
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-test", host: target.host },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

test("bili claude: the loopback /bili/ base URL stays off HTTPS_PROXY, so model calls reach the pipeline instead of a self-tunnel 403", async () => {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            seen.push(`${req.method} ${req.url} auth=${req.headers.authorization}`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } }));
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
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
        const rewrites: HttpRewrite[] = [{ key: "ANTHROPIC_BASE_URL", realUpstream: `http://127.0.0.1:${upstreamPort}` }];
        const env = buildClaudeEnv(origin, "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin", NO_PROXY: ".corp.example" });
        const res = await claudeLikePost(`${env.ANTHROPIC_BASE_URL}/v1/messages`, env, JSON.stringify({ model: "claude-test", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(seen, ["POST /v1/messages auth=Bearer sk-ant-oat01-test"], "reached the upstream through the pipeline, Authorization untouched");
        assert.equal(env.HTTPS_PROXY, origin, "MITM leg kept for claude's other traffic");
        assert.equal(env.NO_PROXY, ".corp.example,localhost,127.0.0.1,::1", "user exclusions kept, loopback added");
        assert.equal(env.no_proxy, env.NO_PROXY);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
