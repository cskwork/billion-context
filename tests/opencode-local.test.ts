import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import biliLocalPlugin, {
    DEFAULT_LOCAL_PORT,
    buildSpawnArgs,
    parseLocalOptions,
    resolvePackageRoot,
    rewriteToBili,
} from "../src/agent/opencode-local.ts";

type HdrStore = { set: (k: string, v: string) => void };
type HookEvent = { sessionID?: unknown; model?: unknown; request?: { url?: unknown; headers?: HdrStore } };
type HookCb = (e: HookEvent) => void | Promise<void>;
type AddedTool = { name: string; input: unknown; options?: Record<string, unknown> };

function makeLocalFakeCtx() {
    let cb: HookCb | undefined;
    const addedTools: AddedTool[] = [];
    const hookNames: string[] = [];
    const ctx = {
        session: {
            hook: async (name: string, c: HookCb) => {
                hookNames.push(name);
                cb = c;
                return { dispose: () => {} };
            },
        },
        tool: {
            transform: async (editor: (ed: { add: (t: AddedTool) => void }) => void) => {
                editor({ add: (t) => addedTools.push(t) });
                return { dispose: () => {} };
            },
        },
        catalog: {
            model: { list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }) },
        },
    };
    const fire = async (url: string, sessionID: string, model?: { providerID?: unknown; id?: unknown }): Promise<{ headers: Record<string, string>; url: string }> => {
        const store: Record<string, string> = {};
        const request = { url, headers: { set: (k: string, v: string) => { store[k] = v; } } };
        await cb!({ sessionID, model, request });
        return { headers: store, url: request.url };
    };
    return { ctx, fire, addedTools, hookNames };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

test("object export: .id/.setup for the no-launcher entry", () => {
    assert.equal(biliLocalPlugin.id, "billion-context-opencode-local");
    assert.equal(typeof biliLocalPlugin.setup, "function");
});

test("rewriteToBili prefixes absolute http(s) upstreams and is idempotent", () => {
    const base = "http://127.0.0.1:18787";
    assert.equal(rewriteToBili("http://api.openai.com/v1/chat/completions", base), `${base}/bili/http://api.openai.com/v1/chat/completions`);
    assert.equal(rewriteToBili("https://api.anthropic.com/v1/messages", base), `${base}/bili/https://api.anthropic.com/v1/messages`);
    const q = "https://up.example/v1/x?a=1&b=2 c#f";
    assert.equal(rewriteToBili(q, base), `${base}/bili/${q}`);
    const oncePrefixed = rewriteToBili("http://api.openai.com/v1", base)!;
    assert.equal(rewriteToBili(oncePrefixed, base), oncePrefixed);
});

test("rewriteToBili leaves non-http(s) URLs untouched", () => {
    const base = "http://127.0.0.1:18787";
    assert.equal(rewriteToBili("/relative/path", base), undefined);
    assert.equal(rewriteToBili("ftp://x/y", base), undefined);
});

test("parseLocalOptions defaults and validates port", () => {
    assert.deepEqual(parseLocalOptions(undefined), { proxyBase: `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`, warnings: [] });
    assert.deepEqual(parseLocalOptions({}), { proxyBase: `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`, warnings: [] });
    assert.equal(parseLocalOptions({ port: 9000 }).proxyBase, "http://127.0.0.1:9000");
    assert.equal(parseLocalOptions({ port: "9000" }).proxyBase, "http://127.0.0.1:9000");
    for (const bad of ["18787x", -1, 0, 99999, 1878.5]) {
        const r = parseLocalOptions({ port: bad });
        assert.equal(r.proxyBase, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`);
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0]!, /invalid plugin option "port"/);
    }
    assert.equal(parseLocalOptions("junk").proxyBase, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`);
});

test("buildSpawnArgs pins loopback, disables auto-update, uses the start subcommand", () => {
    const args = buildSpawnArgs("/some/root", 18787);
    assert.deepEqual(args, [path.join("/some/root", "dist", "index.js"), "start", "--port", "18787", "--host", "127.0.0.1", "--no-auto-update"]);
    assert.ok(args.includes("--no-auto-update"));
    assert.ok(args.includes("127.0.0.1"));
    assert.ok(args.includes("start"));
});

test("resolvePackageRoot is an absolute path", () => {
    assert.ok(path.isAbsolute(resolvePackageRoot()));
});

test("local mode adopts a live proxy, stamps headers, rewrites url idempotently", async () => {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocolVersion: 1, proxy: "billion-context", version: "99.0.0-test" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const fake = makeLocalFakeCtx();
    const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port });
    try {
        assert.deepEqual(fake.hookNames, ["http.request"]);
        assert.ok(fake.addedTools.length > 0, "native tools registered against the adopted proxy");
        const r1 = await fake.fire("https://api.openai.com/v1/chat/completions", "s1", { providerID: "qwen", id: "m1" });
        assert.equal(r1.headers["x-bili-plugin"], "opencode");
        assert.equal(r1.headers["x-bili-plugin-conversation"], "s1");
        assert.equal(r1.url, `http://127.0.0.1:${port}/bili/https://api.openai.com/v1/chat/completions`);
        const r2 = await fake.fire(r1.url, "s1");
        assert.equal(r2.url, r1.url);
    } finally {
        cleanup();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("local mode stands down inert when the launcher owns the proxy", async () => {
    const fake = makeLocalFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999" }, async () => {
        const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port: DEFAULT_LOCAL_PORT });
        assert.ok(typeof cleanup === "function");
        assert.deepEqual(fake.hookNames, [], "no hooks registered while standing down");
        assert.equal(fake.addedTools.length, 0, "no tools registered while standing down");
        cleanup();
    });
});

test("local mode stands down inert when the kill switch is set", async () => {
    const fake = makeLocalFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
        const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port: DEFAULT_LOCAL_PORT });
        assert.deepEqual(fake.hookNames, []);
        assert.equal(fake.addedTools.length, 0);
        cleanup();
    });
});
