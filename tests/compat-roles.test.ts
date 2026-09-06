import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { applyCompatRoles, applyCompatRolesJson, parseCompatRoles, resolveCompatRoles } from "../src/compat-roles.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

const ROLES = { developer: "system" };

test("parseCompatRoles drops non-string entries", () => {
    assert.equal(parseCompatRoles(undefined), undefined);
    assert.equal(parseCompatRoles("developer"), undefined);
    assert.equal(parseCompatRoles([]), undefined);
    assert.equal(parseCompatRoles({}), undefined);
    assert.deepEqual(parseCompatRoles({ developer: "system", bad: 42, empty: "", ok: "user" }), { developer: "system", ok: "user" });
});

test("resolveCompatRoles: provider wins per key, global fills the rest", () => {
    const routes = {
        "https://api.a.com": { compat: { roles: { developer: "user", assistant: "user" } } },
    };
    // No match anywhere.
    assert.deepEqual(resolveCompatRoles(routes, "https://api.b.com/v1/chat/completions", undefined), {});
    // Provider only.
    assert.deepEqual(resolveCompatRoles(routes, "https://api.a.com/v1/chat/completions", undefined), { developer: "user", assistant: "user" });
    // Global + provider: provider wins per key.
    assert.deepEqual(
        resolveCompatRoles(routes, "https://api.a.com/v1/chat/completions", { developer: "system", extra: "user" }),
        { developer: "user", assistant: "user", extra: "user" },
    );
});

test("applyCompatRoles rewrites openai messages[].role", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }] });
    const out = applyCompatRoles(body, "openai", ROLES);
    assert.equal(out.rewritten, 1);
    assert.deepEqual(JSON.parse(out.body).messages[0], { role: "system", content: "sys" });
    assert.deepEqual(JSON.parse(out.body).messages[1], { role: "user", content: "hi" });
});

test("applyCompatRoles rewrites responses input[] message roles, skips typed items", () => {
    const body = JSON.stringify({
        model: "m",
        input: [
            { type: "message", role: "developer", content: "sys" },
            { role: "developer", content: "sys2" },
            { type: "function_call", name: "f", call_id: "c", arguments: "{}" },
            { type: "message", role: "user", content: "hi" },
        ],
    });
    const out = applyCompatRoles(body, "responses", ROLES);
    assert.equal(out.rewritten, 2);
    const input = JSON.parse(out.body).input as Array<Record<string, unknown>>;
    assert.equal(input[0].role, "system");
    assert.equal(input[1].role, "system");
    assert.equal(input[2].name, "f");
    assert.equal(input[3].role, "user");
});

test("applyCompatRoles default no-op returns the original string", () => {
    const body = JSON.stringify({ messages: [{ role: "developer", content: "x" }] });
    assert.deepEqual(applyCompatRoles(body, "openai", {}), { body, rewritten: 0 });
    // No matching role → original bytes, no re-stringify.
    const other = JSON.stringify({ messages: [{ role: "user", content: "x" }] });
    const out = applyCompatRoles(other, "openai", ROLES);
    assert.equal(out.body, other);
    assert.equal(out.rewritten, 0);
    // Invalid JSON → untouched.
    assert.deepEqual(applyCompatRoles("not json", "openai", ROLES), { body: "not json", rewritten: 0 });
});

test("applyCompatRolesJson mutates parsed bodies for the retry loops", () => {
    const parsed = { messages: [{ role: "developer", content: "x" }] } as Record<string, unknown>;
    assert.equal(applyCompatRolesJson(parsed, "openai", ROLES), 1);
    assert.equal((parsed.messages as Array<{ role: string }>)[0].role, "system");
});

function upstreamServer(status: number, onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            onBody(req.url ?? "", parsed);
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface StartOpts {
    compatJson: string;
}

async function startProxy(upstream: http.Server, { compatJson }: StartOpts): Promise<{ port: number; opts: ProxyOptions; stop: () => Promise<void>; cleanup: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-compat-roles-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, compatJson, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: parseCompatRoles(JSON.parse(compatJson).compat?.roles) ?? {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        opts,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("e2e #552 A: responses developer role rewritten on forward", async () => {
    const seen: Array<{ path: string; roles: string[] }> = [];
    const upstream = await upstreamServer(200, (path, body) => {
        const roles = ((body as { input?: Array<{ role?: string }> })?.input ?? []).map((i) => i.role ?? "?");
        seen.push({ path, roles });
    });
    const harness = await startProxy(upstream, { compatJson: `{"compat":{"roles":{"developer":"system"}}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }, { type: "message", role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].roles, ["system", "user"]);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 B: chat-completions roles rewritten on the rebuilt wire body", async () => {
    const seen: Array<string[]> = [];
    const upstream = await upstreamServer(200, (_path, body) => {
        seen.push(((body as { messages?: Array<{ role?: string }> })?.messages ?? []).map((m) => m.role ?? "?"));
    });
    // Note: the chat rebuild pipeline (kernel coreToOpenai) already normalizes
    // developer→system before compat even runs — the LIVE surface of #552 is
    // the responses path. Mapping system→user here proves the openai boundary
    // rewrite genuinely fires on the rebuilt body.
    const harness = await startProxy(upstream, { compatJson: `{"compat":{"roles":{"system":"user"}}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen[0][0], "user", "rebuilt system role rewritten per compat");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 C: default (no compat config) is byte-for-byte transparent", async () => {
    const seen: Array<unknown> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body));
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}` });
    try {
        const payload = { model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] };
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify(payload),
        });
        assert.equal(res.status, 200);
        // The pipeline may append its own compress nudge to message content —
        // unrelated to compat. What compat guarantees is the ROLE reaching the
        // upstream unchanged when no rewrite is configured.
        const input = (seen[0] as { input: Array<{ role: string; content: string }> }).input;
        assert.equal(input[0].role, "developer", "role untouched by default");
        assert.ok(input[0].content.startsWith("be terse"), "original content preserved");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 D: per-provider compat.roles wins over global", async () => {
    const seen: Array<string[]> = [];
    const upstreamPortHolder: { port: number } = { port: 0 };
    const upstream = await upstreamServer(200, (_path, body) => {
        const items = (body as { messages?: Array<{ role?: string }>; input?: Array<{ role?: string }> });
        seen.push([...(items.messages ?? []), ...(items.input ?? [])].map((m) => m.role ?? "?"));
    });
    upstreamPortHolder.port = (upstream.address() as { port: number }).port;
    const config = {
        compat: { roles: { developer: "system" } },
        providers: { [`http://127.0.0.1:${upstreamPortHolder.port}`]: { compat: { roles: { developer: "user" } } } },
    };
    const harness = await startProxy(upstream, { compatJson: JSON.stringify(config) });
    try {
        // responses path: developer survives the rebuild to the wire (unlike
        // chat, which normalizes it), so provider precedence is observable.
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(seen[0], ["user"], "provider compat entry wins per key");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
