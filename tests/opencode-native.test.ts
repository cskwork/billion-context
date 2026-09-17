import test from "node:test";
import assert from "node:assert/strict";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the module loaded dynamically.
process.env.NODE_TEST_CONTEXT = "1";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2PluginContext, V2State } from "../src/agent/opencode-v2.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";

const { shouldBootstrapNativeOpencode, createNativeRoute, planNativeOpencode } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");
const { markNativeHost, nativeAttachOrigin } = await import("../src/agent/native-bootstrap.ts");
const nativeDefault = (await import("../src/agent/opencode-native.ts")).default;

const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("shouldBootstrapNativeOpencode: true in a bare host with no bili env", () => {
    assert.equal(shouldBootstrapNativeOpencode({}), true);
});

test("shouldBootstrapNativeOpencode: false when the plugin or native mode is opted out", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), false);
});

test("shouldBootstrapNativeOpencode: false when a bili launch already owns a proxy", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }), true);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), false);
});

test("native entry exports an OpenCode 2.x plugin object", () => {
    assert.equal(nativeDefault.id, "billion-context-opencode-native");
    assert.equal(typeof nativeDefault.setup, "function");
});

// #820 coexistence: the standalone opencode-acp extension must see this marker
// at its action-time check even though our bootstrap writes BILLION_CONTEXT_PROXY
// only later (async) and its /bili/ baseUrl check never sees our rewrite.
test("module evaluation marks the process as a native opencode host", () => {
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "opencode");
});

test("markNativeHost: sets when unset, first writer wins", () => {
    const env: NodeJS.ProcessEnv = {};
    markNativeHost(env, "pi");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    markNativeHost(env, "opencode");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    const blank: NodeJS.ProcessEnv = { BILLION_CONTEXT_NATIVE: "" };
    markNativeHost(blank, "omp");
    assert.equal(blank.BILLION_CONTEXT_NATIVE, "omp");
});

test("route: healthy origin rewrites the request reference and records proxyBase", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const body = JSON.stringify({ messages: [] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_1",
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body }),
    };
    await route(e, s);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.method, "POST");
    assert.equal(out.headers.get("authorization"), "Bearer x");
    assert.equal(await out.text(), body);
    assert.equal(s.proxyBase, origin);
});

test("route: non-model-API and already-routed URLs are left untouched", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const plain = new Request("https://github.com/repos");
    const e1: V2HttpRequestEvent = { request: plain };
    await route(e1, s);
    assert.equal(e1.request, plain);
    const routed = new Request(`${origin}/bili/${MODEL_URL}`);
    const e2: V2HttpRequestEvent = { request: routed };
    await route(e2, s);
    assert.equal(e2.request, routed);
    assert.equal(s.proxyBase, undefined);
});

test("route: waits for a pending bootstrap before routing", async () => {
    let release!: (o: string) => void;
    const state: NativeInterceptState = { origin: undefined, ready: new Promise<string | undefined>((r) => (release = r)) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    const pending = route(e, s);
    release("http://127.0.0.1:4321");
    await pending;
    assert.equal((e.request as Request).url, `http://127.0.0.1:4321/bili/${MODEL_URL}`);
});

test("route: failed bootstrap sends direct with a single warning (no respawn wired)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const origError = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => {
        warnings.push(args.join(" "));
    };
    try {
        const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e1, s);
        assert.equal((e1.request as Request).url, MODEL_URL);
        const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e2, s);
        assert.equal((e2.request as Request).url, MODEL_URL);
        assert.equal(s.proxyBase, undefined);
        assert.equal(warnings.filter((w) => w.includes("bili-native-opencode")).length, 1);
    } finally {
        console.error = origError;
    }
});

test("route: dead origin respawns once and routes to the replacement", async () => {
    const dead = "http://127.0.0.1:1111";
    const live = "http://127.0.0.1:2222";
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            state.origin = live;
            return live;
        },
    };
    const route = createNativeRoute(state, { probe: async (o) => o === live });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${live}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, live);
});

test("route: failed respawn fires onGiveUp once and holds direct (cooldown suppresses re-spawn)", async () => {
    const dead = "http://127.0.0.1:1111";
    let gaveUp = 0;
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            respawns++;
            return undefined;
        },
        onGiveUp: () => {
            gaveUp++;
        },
    };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal((e1.request as Request).url, MODEL_URL);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
});

test("route: load-time bootstrap failure retries after the cooldown only", async () => {
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        respawn: async () => {
            respawns++;
            return undefined;
        },
    };
    const route = createNativeRoute(state, { probe: async () => true, respawnCooldownMs: 10 });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(respawns, 1);
    await sleep(15);
    const e3: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e3, s);
    assert.equal(respawns, 2);
});

test("setup(route): header stamping applies to the REPLACED request, tools register natively", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }> = [];
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
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    assert.deepEqual(hooks.map((h) => h.name), ["http.request"]);
    assert.deepEqual(tools.sort(), [...EXPECTED_TOOLS].sort());
    const e: V2HttpRequestEvent = {
        sessionID: "ses_abc",
        model: { providerID: "anthropic", id: "claude-x" },
        request: new Request(MODEL_URL, { method: "POST" }),
    };
    await hooks[0].cb(e);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.headers.get("x-bili-plugin-conversation"), "ses_abc");
    assert.equal(out.headers.get("x-bili-plugin"), "opencode");
    cleanup();
});

test("setup(route): kill switch keeps the hook fully inert", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<(e: V2HttpRequestEvent) => void | Promise<void>> = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (_name, cb) => {
                hooks.push(cb);
                return { dispose() {} };
            },
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    process.env.BILLION_CONTEXT_PLUGIN = "0";
    try {
        const req = new Request(MODEL_URL);
        const e: V2HttpRequestEvent = { sessionID: "ses_x", request: req };
        await hooks[0](e);
        assert.equal(e.request, req);
    } finally {
        delete process.env.BILLION_CONTEXT_PLUGIN;
        cleanup();
    }
});

test("nativeAttachOrigin: unset/blank/malformed/non-http(s) all resolve to undefined", () => {
    assert.equal(nativeAttachOrigin({}), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "   " }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "not a url" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "ftp://127.0.0.1:21" }), undefined);
});

test("nativeAttachOrigin: normalizes a valid http(s) origin (trailing slash stripped)", () => {
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787///" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "  https://proxy.example.com/ " }), "https://proxy.example.com");
});

test("planNativeOpencode: default is spawn; opt-out and /bili/ launches are off", () => {
    assert.deepEqual(planNativeOpencode({}), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), { mode: "off" });
});

test("planNativeOpencode: a preset BILLION_CONTEXT_PROXY is an attach target, not a stand-down", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    // kill switches and a /bili/ launch still win over the preset
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a garbage preset falls back to spawn (self-managed) rather than dead-off
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "garbage" }), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }), { mode: "spawn" });
});

test("planNativeOpencode: attach wins over spawn when no launcher owns the proxy", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000/" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_ATTACH: "garbage" }), { mode: "spawn" });
});

test("planNativeOpencode: explicit BILLION_CONTEXT_ATTACH wins over the env preset", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
});

test("native route: attach mode routes model traffic through the external proxy", async () => {
    const origin = "http://10.0.0.5:9000";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin,
        ready: Promise.resolve(origin),
        respawn: async () => {
            respawnCalls++;
            return undefined;
        },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const e: V2HttpRequestEvent = { sessionID: "ses_a", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, origin);
    assert.equal(respawnCalls, 0);
});

test("native route: attach mode FAILS CLOSED when the external proxy is down", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
        warns.push(a.join(" "));
    };
    try {
        const route = createNativeRoute(state, { probe: async () => false });
        await route({ sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) }, s);
        const second: V2HttpRequestEvent = { sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) };
        await route(second, s);
        assert.equal((second.request as Request).url, `${origin}/bili/${MODEL_URL}`);
        assert.ok(warns.some((w) => w.includes("unreachable")), "expected an unreachable diagnostic");
        assert.ok(warns.filter((w) => w.includes("unreachable")).length === 1, "expected exactly one warning");
    } finally {
        console.error = origErr;
    }
});

test("native route: attach mode leaves non-model requests untouched", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const req = new Request("https://api.anthropic.com/v1/models", { method: "GET" });
    const e: V2HttpRequestEvent = { sessionID: "ses_c", request: req };
    await route(e, s);
    assert.equal(e.request, req);
    assert.equal(s.proxyBase, undefined);
});
