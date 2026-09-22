import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    activateZcodePluginMode,
    bootstrapZcodeNative,
    planNativeZcode,
    probeProxyHealth,
    restoreZcodeBackup,
    routeZcodeConfig,
    unrouteZcode,
} from "../src/zcode/native.ts";
import { zcodeStoreFile } from "../src/zcode/json-edit.ts";

// #1145: the per-session bootstrap lifecycle — plan decision table, health
// probe, routing with #1002 snapshot discipline, stamp, unroute, restore.
// Ports always come from listen(0) so the suite stays deterministic (#360).

const UPSTREAM = "https://open.bigmodel.cn/api/anthropic";

function dataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    writeFileSync(
        zcodeStoreFile(dir, "legacy"),
        JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } } } }) + "\n",
    );
    return dir;
}

async function withHealthServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
        return await fn(`http://127.0.0.1:${addr.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    }
}

async function deadOrigin(): Promise<string> {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    await new Promise<void>((r) => server.close(() => r()));
    return `http://127.0.0.1:${addr.port}`;
}

test("planNativeZcode resolves kill-switches > attach > spawn", () => {
    assert.deepEqual(planNativeZcode({}), { mode: "spawn" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILI_NATIVE_ZCODE: "0" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILI_PROVIDER_REWRITES: "" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:9999" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_PROXY: "https://127.0.0.1:8787" }), { mode: "attach", attachOrigin: "https://127.0.0.1:8787" });
    assert.deepEqual(
        planNativeZcode({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999", BILLION_CONTEXT_PROXY: "https://127.0.0.1:8787" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:9999" },
    );
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_ATTACH: "not-a-url" }), { mode: "spawn" });
});

test("probeProxyHealth accepts any live proxy answer and rejects failures", async () => {
    await withHealthServer(async (origin) => {
        assert.equal(await probeProxyHealth(origin), true);
    });
    assert.equal(await probeProxyHealth(await deadOrigin()), false);
    const bad = http.createServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const badAddr = bad.address();
    if (badAddr === null || typeof badAddr === "string") throw new Error("no port");
    try {
        assert.equal(await probeProxyHealth(`http://127.0.0.1:${badAddr.port}`), false);
    } finally {
        bad.closeAllConnections();
        await new Promise<void>((r) => bad.close(() => r()));
    }
});

test("routeZcodeConfig wraps the store and snapshots pre-bili state once", async () => {
    const dir = dataDir();
    try {
        const original = readFileSync(zcodeStoreFile(dir, "legacy"), "utf8");
        const logs: string[] = [];
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: (m) => logs.push(m) });
        assert.ok(applied);
        assert.equal(applied.kind, "legacy");
        assert.equal(applied.port, 18787);
        assert.equal(applied.upstream, UPSTREAM);
        assert.deepEqual(applied.wrapped, [{ id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM }]);
        assert.match(readFileSync(applied.file, "utf8"), /http:\/\/127\.0\.0\.1:18787\/bili\//);
        assert.equal(readFileSync(`${applied.file}.bili-bak`, "utf8"), original);

        const rerouted = await routeZcodeConfig({ origin: "http://127.0.0.1:28787", dataDir: dir, log: (m) => logs.push(m) });
        assert.ok(rerouted);
        assert.match(readFileSync(rerouted.file, "utf8"), /http:\/\/127\.0\.0\.1:28787\/bili\//);
        assert.equal(readFileSync(`${rerouted.file}.bili-bak`, "utf8"), original);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("routeZcodeConfig re-snapshots user edits made while native mode is active", async () => {
    const dir = dataDir();
    try {
        const file = zcodeStoreFile(dir, "legacy");
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        const userEdited = JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: {} }, note: "user edit" } }) + "\n";
        writeFileSync(file, userEdited);
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        assert.equal(readFileSync(`${file}.bili-bak`, "utf8"), userEdited);
        const restored = restoreZcodeBackup({ dataDir: dir, log: () => {} });
        assert.deepEqual(restored, { restored: true });
        assert.equal(readFileSync(file, "utf8"), userEdited);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("routeZcodeConfig reports why it cannot route instead of guessing", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "zcode-native-empty-"));
    try {
        const logs: string[] = [];
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: empty, log: (m) => logs.push(m) }), undefined);
        assert.match(logs[0], /nothing to route/);
        mkdirSync(path.join(empty, "v2"), { recursive: true });
        logs.length = 0;
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: empty, log: (m) => logs.push(m) }), undefined);
        assert.match(logs[0], /nothing to route/);
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
    await assert.rejects(routeZcodeConfig({ origin: "http://127.0.0.1", dataDir: dataDir(), log: () => {} }), /cannot derive a port/);
});

test("activateZcodePluginMode stamps the header into the routed entries", async () => {
    const dir = dataDir();
    try {
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        assert.ok(applied);
        await activateZcodePluginMode(applied, { dataDir: dir, log: () => {} });
        const parsed = JSON.parse(readFileSync(applied.file, "utf8")) as { provider: Record<string, { options: { headers?: Record<string, string> } }> };
        assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.headers?.["x-bili-plugin"], "zcode");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("unrouteZcode strips wrappers in place and drops snapshots", async () => {
    const dir = dataDir();
    try {
        const file = zcodeStoreFile(dir, "legacy");
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        unrouteZcode({ dataDir: dir, log: () => {} });
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { provider: Record<string, { options: { baseURL: string } }> };
        assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, UPSTREAM);
        assert.equal(existsSync(`${file}.bili-bak`), false);
        assert.equal(existsSync(`${file}.bili-last`), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bootstrapZcodeNative honors the off plan without touching the proxy", async () => {
    const dir = dataDir();
    try {
        let called = false;
        const out = await bootstrapZcodeNative({
            env: { BILI_NATIVE_ZCODE: "0" },
            dataDir: dir,
            ensureProxy: async () => {
                called = true;
                return { origin: "http://127.0.0.1:1", attached: false };
            },
        });
        assert.deepEqual(out, { mode: "off" });
        assert.equal(called, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bootstrapZcodeNative attaches to a healthy proxy and routes", async () => {
    const dir = dataDir();
    try {
        await withHealthServer(async (origin) => {
            const out = await bootstrapZcodeNative({ env: { BILLION_CONTEXT_ATTACH: origin }, dataDir: dir, log: () => {} });
            assert.equal(out.mode, "active");
            if (out.mode !== "active") return;
            assert.equal(out.attached, true);
            assert.ok(out.routed);
            assert.equal(out.routed.origin, origin);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bootstrapZcodeNative fails closed on an unhealthy attach target", async () => {
    const dir = dataDir();
    try {
        const origin = await deadOrigin();
        await assert.rejects(
            bootstrapZcodeNative({ env: { BILLION_CONTEXT_ATTACH: origin }, dataDir: dir, log: () => {}, healthDeadlineMs: 300 }),
            /not healthy/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bootstrapZcodeNative spawns through the injected ensureProxy seam", async () => {
    const dir = dataDir();
    try {
        await withHealthServer(async (origin) => {
            const out = await bootstrapZcodeNative({
                env: {},
                dataDir: dir,
                log: () => {},
                ensureProxy: async () => ({ origin, attached: false }),
            });
            assert.equal(out.mode, "active");
            if (out.mode !== "active") return;
            assert.equal(out.attached, false);
            assert.ok(out.routed);
            assert.equal(out.routed.origin, origin);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
