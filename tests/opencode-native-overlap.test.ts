import test from "node:test";
import assert from "node:assert/strict";

// #840 seam audit (opencode line): evaluate the REAL native entry under a
// `bili opencode` launch environment — the launcher owns the proxy, so the
// exported setup must carry NO route: request references stay untouched, the
// spurious "proxy unavailable" warning cannot fire, and the shared V2 setup
// degrades to launcher-mode detection (/bili/ URL or BILLION_CONTEXT_PROXY
// env). NODE_TEST_CONTEXT stays set so the bootstrap block cannot run
// regardless; the gate under test is the export shape itself.
process.env.NODE_TEST_CONTEXT = "1";
process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9999";
process.env.BILI_PROVIDER_REWRITES = '{"vllm":"http://127.0.0.1:9999/bili/http://upstream.local/v1"}';

import type { V2HttpRequestEvent, V2PluginContext } from "../src/agent/opencode-v2.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";

const nativeDefault = (await import("../src/agent/opencode-native.ts")).default;
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];

interface MockCtx {
    ctx: V2PluginContext;
    hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }>;
    tools: string[];
}

function makeCtx(): MockCtx {
    const hooks: MockCtx["hooks"] = [];
    const tools: string[] = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (name, cb) => {
                hooks.push({ name, cb });
                return { dispose() {} };
            },
        },
        tool: {
            transform: (add) => {
                add({ add: (t) => tools.push(t.name) });
                return { dispose() {} };
            },
        },
    };
    return { ctx, hooks, tools };
}

test("overlap: native entry still exports a plugin object", () => {
    assert.equal(nativeDefault.id, "billion-context-opencode-native");
    assert.equal(typeof nativeDefault.setup, "function");
});

test("overlap: evaluation marks no native host (bootstrap skipped)", () => {
    assert.notEqual(process.env.BILLION_CONTEXT_NATIVE, "opencode");
});

test("overlap: model-API request reference stays untouched and no spurious warning fires", async () => {
    const { ctx, hooks, tools } = makeCtx();
    const cleanup = await nativeDefault.setup(ctx);
    const origError = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => {
        warnings.push(args.join(" "));
    };
    try {
        assert.deepEqual(hooks.map((h) => h.name), ["http.request"]);
        assert.deepEqual(tools.sort(), [...EXPECTED_TOOLS].sort());
        for (let i = 0; i < 2; i++) {
            const req = new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
            const e: V2HttpRequestEvent = { sessionID: "ses_ov", request: req };
            await hooks[0].cb(e);
            assert.equal(e.request, req, `fire ${i}: request reference must be the original`);
        }
        assert.equal(warnings.filter((w) => w.includes("proxy unavailable")).length, 0);
        assert.equal(warnings.filter((w) => w.includes("bili-native")).length, 0);
    } finally {
        console.error = origError;
        cleanup();
    }
});

test("overlap: header stamping degrades to launcher-mode env detection", async () => {
    const { ctx, hooks } = makeCtx();
    const cleanup = await nativeDefault.setup(ctx);
    try {
        const req = new Request(MODEL_URL, { method: "POST" });
        const e: V2HttpRequestEvent = { sessionID: "ses_env", request: req };
        await hooks[0].cb(e);
        assert.equal(req.headers.get("x-bili-plugin-conversation"), "ses_env");
        assert.equal(req.headers.get("x-bili-plugin"), "opencode");
    } finally {
        cleanup();
    }
});

test("overlap: /bili/-wrapped URLs detect the proxy from the URL (HTTP provider case)", async () => {
    const { ctx, hooks } = makeCtx();
    const cleanup = await nativeDefault.setup(ctx);
    try {
        const url = "http://127.0.0.1:4321/bili/http://upstream.local/v1/chat/completions";
        const req = new Request(url, { method: "POST" });
        const e: V2HttpRequestEvent = { sessionID: "ses_bili", request: req };
        await hooks[0].cb(e);
        assert.equal(e.request, req);
        assert.equal(req.headers.get("x-bili-plugin-conversation"), "ses_bili");
        assert.equal(req.headers.get("x-bili-plugin"), "opencode");
    } finally {
        cleanup();
    }
});
