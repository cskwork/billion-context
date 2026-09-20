import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Captured = { url: string; body: Buffer };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// #618 review nit: with stripImages enabled and NO bili compaction item in the
// request, prepareResponsesCompact fell back to the raw request buffer —
// historical images rode along on the /responses/compact passthrough.
test("/responses/compact passthrough forwards the post-strip body", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
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
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, stripImages: true },
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
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    try {
        const img = { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" };
        const msg = (id: string, content: unknown[]) => ({ type: "message", id, status: "completed", role: "user", content });
        const input = [
            msg("m1", [{ type: "input_text", text: "old text" }, img]),
            msg("m2", [img]),
            msg("m3", [{ type: "input_text", text: "t3" }]),
            msg("m4", [{ type: "input_text", text: "t4" }]),
            msg("m5", [{ type: "input_text", text: "t5" }]),
            msg("m6", [{ type: "input_text", text: "t6" }]),
            msg("m7", [{ type: "input_text", text: "recent" }, img]),
        ];
        const r1 = await fetch(`${base}/responses/compact`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "strip-compact-1", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: false, input }),
        });
        assert.equal(r1.status, 200);
        await r1.arrayBuffer();
        assert.equal(captured[0].url, "/responses/compact");
        const forwarded = JSON.parse(captured[0].body.toString("utf8")) as { input: Array<{ content?: unknown }> };
        assert.equal(forwarded.input.length, 7);
        assert.deepEqual(forwarded.input[0].content, [{ type: "input_text", text: "old text" }]);
        assert.deepEqual(forwarded.input[1].content, [{ type: "input_text", text: "[image]" }]);
        assert.deepEqual(forwarded.input[6].content, [{ type: "input_text", text: "recent" }, img]);
        assert.equal(forwarded.input.filter((item) => JSON.stringify(item).includes('"input_image"')).length, 1);

        const noStripInput = [msg("n1", [{ type: "input_text", text: "only recent" }, img])];
        const noStripBody = JSON.stringify({ model: "gpt-5", stream: false, input: noStripInput });
        const r2 = await fetch(`${base}/responses/compact`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "strip-compact-2", "content-type": "application/json" },
            body: noStripBody,
        });
        assert.equal(r2.status, 200);
        await r2.arrayBuffer();
        assert.equal(captured[1].body.equals(Buffer.from(noStripBody)), true);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
