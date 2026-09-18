// #920: acp bridge — package probing, store-dir mirroring, hook gating,
// graceful degradation. Hermetic: fake package trees under os.tmpdir(),
// XDG_* env vars saved/restored per test.

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { acpStoreDir, createAcpBridge, resolveAcpPackage } from "../src/agent/acp-bridge.js";

const ENV_KEYS = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "BILI_OPENCODE_ACP_SPEC", "OPENCODE_CONFIG_DIR", "BILLION_CONTEXT_PROXY"] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const restore = (): void => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    };
    return Promise.resolve(fn()).finally(restore);
}

function makePkg(base: string, version: string, opts?: { dist?: boolean; body?: string }): string {
    const pkgPath = path.join(base, "opencode-acp");
    fs.mkdirSync(path.join(pkgPath, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgPath, "package.json"), JSON.stringify({ name: "opencode-acp", version }));
    if (opts?.dist !== false) {
        fs.writeFileSync(path.join(pkgPath, "dist", "index.js"), opts?.body ?? "export default async () => ({});");
    }
    return pkgPath;
}

const FAKE_ACP_BODY = `
globalThis.__acp = globalThis.__acp || {};
const r = globalThis.__acp;
r.initProxyEnv = process.env.BILLION_CONTEXT_PROXY ?? null;
export default async (ctx) => {
    r.initDirectory = ctx.directory;
    const rec = (key) => (...args) => { r[key] = args; };
    return {
        "experimental.chat.system.transform": rec("system"),
        "experimental.chat.messages.transform": rec("messages"),
        "experimental.text.complete": rec("textComplete"),
        "command.execute.before": rec("commandBefore"),
        event: rec("event"),
        config: rec("config"),
        tool: {
            compress: { description: "dcp compress", execute: rec("toolCompress") },
            decompress: { description: "dcp decompress", execute: rec("toolDecompress") },
        },
    };
};
`;

function userMsg(sessionID: string, opts?: { id?: string; parts?: unknown[] }): Record<string, unknown> {
    return {
        info: { role: "user", id: opts?.id ?? "msg_real_1", sessionID },
        parts: opts?.parts ?? [{ type: "text", text: "hi" }],
    };
}

test("resolveAcpPackage: probe order and validity rules", () => withEnv({ XDG_CACHE_HOME: undefined, XDG_CONFIG_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined }, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-resolve-"));
    try {
        const cache = path.join(base, "cache");
        const config = path.join(base, "config");
        const proj = path.join(base, "proj");
        process.env.XDG_CACHE_HOME = cache;
        process.env.XDG_CONFIG_HOME = config;
        makePkg(path.join(cache, "opencode", "packages", "opencode-acp@latest", "node_modules"), "1.2.0");
        makePkg(path.join(proj, "node_modules"), "1.5.0");
        makePkg(path.join(config, "opencode", "node_modules"), "1.1.0");
        // highest version wins across probes
        assert.equal(resolveAcpPackage(proj), path.join(proj, "node_modules", "opencode-acp"));
        // launcher-stripped spec is authoritative even over a newer copy
        process.env.BILI_OPENCODE_ACP_SPEC = "opencode-acp@latest";
        assert.equal(resolveAcpPackage(proj), path.join(cache, "opencode", "packages", "opencode-acp@latest", "node_modules", "opencode-acp"));
        // broken spec'd slot (major 2) falls through to generic probes
        const brokenSlot = makePkg(path.join(cache, "opencode", "packages", "opencode-acp-broken", "node_modules"), "1.0.0");
        fs.writeFileSync(path.join(brokenSlot, "package.json"), JSON.stringify({ name: "opencode-acp", version: "2.0.0" }));
        process.env.BILI_OPENCODE_ACP_SPEC = "opencode-acp-broken";
        assert.equal(resolveAcpPackage(proj), path.join(proj, "node_modules", "opencode-acp"));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}));

test("resolveAcpPackage: newest valid cache slot; invalid copies skipped", () => withEnv({ XDG_CACHE_HOME: undefined, XDG_CONFIG_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined }, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-resolve2-"));
    try {
        const cache = path.join(base, "cache");
        const config = path.join(base, "config");
        const proj = path.join(base, "proj");
        process.env.XDG_CACHE_HOME = cache;
        process.env.XDG_CONFIG_HOME = config;
        const slots = path.join(cache, "opencode", "packages");
        makePkg(path.join(slots, "opencode-acp@latest", "node_modules"), "1.2.0");
        makePkg(path.join(slots, "opencode-acp@1.0.0", "node_modules"), "1.0.0");
        makePkg(path.join(slots, "opencode-acp-old", "node_modules"), "2.3.0"); // wrong major
        makePkg(path.join(slots, "opencode-acp-nodist", "node_modules"), "1.9.0", { dist: false }); // missing dist
        makePkg(path.join(slots, "other-pkg", "node_modules"), "9.9.9"); // unrelated entry
        makePkg(path.join(slots, "my-opencode-acp-fork", "node_modules"), "9.8.0"); // fork must not match
        assert.equal(resolveAcpPackage(proj), path.join(slots, "opencode-acp@latest", "node_modules", "opencode-acp"));
        // nothing valid anywhere → undefined
        fs.rmSync(slots, { recursive: true, force: true });
        assert.equal(resolveAcpPackage(proj), undefined);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}));

test("acpStoreDir: default, XDG override, storagePath precedence and forms", () => withEnv({ XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, OPENCODE_CONFIG_DIR: undefined }, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-store-"));
    try {
        const data = path.join(base, "data");
        const config = path.join(base, "config");
        const proj = path.join(base, "proj");
        process.env.XDG_DATA_HOME = data;
        process.env.XDG_CONFIG_HOME = config;
        fs.mkdirSync(proj, { recursive: true });
        // no acp config anywhere → default dir
        assert.equal(acpStoreDir(proj), path.join(data, "opencode", "storage", "plugin", "acp"));
        // global acp.jsonc WITH COMMENTS (jsonc-parser path), absolute storagePath
        fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
        fs.writeFileSync(path.join(config, "opencode", "acp.jsonc"), "// comment\n{ /* inline */\n  \"storagePath\": \"/abs/store\"\n}\n");
        assert.equal(acpStoreDir(proj), "/abs/store");
        // project .opencode beats global
        fs.mkdirSync(path.join(proj, ".opencode"));
        fs.writeFileSync(path.join(proj, ".opencode", "acp.json"), JSON.stringify({ storagePath: "./rel-store" }));
        assert.equal(acpStoreDir(proj), path.join(proj, "rel-store"));
        // walk-up: nested cwd finds the ancestor .opencode. Like acp itself,
        // a relative storagePath resolves against the HOST directory (ctx.directory),
        // not the .opencode dir holding the config file.
        const nested = path.join(proj, "deep", "nested");
        fs.mkdirSync(nested, { recursive: true });
        assert.equal(acpStoreDir(nested), path.join(nested, "rel-store"));
        // ~ expansion
        fs.rmSync(path.join(proj, ".opencode"), { recursive: true, force: true });
        fs.writeFileSync(path.join(config, "opencode", "acp.jsonc"), JSON.stringify({ storagePath: "~/tilde-store" }));
        const home = process.env.HOME || "";
        assert.ok(acpStoreDir(proj).startsWith(home));
        assert.ok(acpStoreDir(proj).endsWith(path.join("tilde-store")));
        // malformed config → falls back to default dir (no throw)
        fs.writeFileSync(path.join(config, "opencode", "acp.jsonc"), "{ not valid json !!");
        assert.equal(acpStoreDir(proj), path.join(data, "opencode", "storage", "plugin", "acp"));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}));

test("createAcpBridge: import hygiene, gating matrix, tool wrapping", async () => withEnv({ XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined, OPENCODE_CONFIG_DIR: undefined, BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999/bili" }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bridge-"));
    try {
        const data = path.join(base, "data");
        const proj = path.join(base, "proj");
        process.env.XDG_DATA_HOME = data;
        process.env.XDG_CONFIG_HOME = path.join(base, "config-empty");
        process.env.XDG_CACHE_HOME = path.join(base, "cache-empty");
        fs.mkdirSync(proj, { recursive: true });
        makePkg(path.join(proj, "node_modules"), "1.0.0", { body: FAKE_ACP_BODY });
        const storeDir = path.join(data, "opencode", "storage", "plugin", "acp");
        fs.mkdirSync(storeDir, { recursive: true });
        fs.writeFileSync(path.join(storeDir, "ses_legacy.json"), "{}");

        delete (globalThis as Record<string, unknown>).__acp;
        const bridge = await createAcpBridge({ directory: proj });
        assert.ok(bridge, "bridge must be created");
        const b = bridge;
        assert.equal(b.version, "1.0.0");
        assert.equal(b.storeDir, storeDir);
        assert.equal(b.isLegacySession("ses_legacy"), true);
        assert.equal(b.isLegacySession("ses_new"), false);
        // BILLION_CONTEXT_PROXY removed during acp init, restored afterwards
        const rec = (globalThis as Record<string, any>).__acp;
        assert.equal(rec.initProxyEnv, null);
        assert.equal(rec.initDirectory, proj);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:9999/bili");
        // config hook is never exposed
        assert.ok(!("config" in b.wrapped));

        await b.wrapped["experimental.chat.system.transform"]({ sessionID: "ses_legacy", model: {} }, { system: [] });
        assert.ok(Array.isArray(rec.system), "legacy system.transform delegated");
        rec.system = undefined;
        await b.wrapped["experimental.chat.system.transform"]({ sessionID: "ses_new", model: {} }, { system: [] });
        assert.equal(rec.system, undefined, "new-session system.transform skipped");
        await b.wrapped["experimental.chat.system.transform"]({ model: {} }, { system: [] });
        assert.equal(rec.system, undefined, "missing sessionID skipped");

        await b.wrapped["experimental.chat.messages.transform"]({}, { messages: [userMsg("ses_legacy")] });
        assert.ok(rec.messages, "legacy messages.transform delegated");
        rec.messages = undefined;
        await b.wrapped["experimental.chat.messages.transform"]({}, { messages: [userMsg("ses_new")] });
        assert.equal(rec.messages, undefined, "new-session messages.transform skipped (no adoption)");
        await b.wrapped["experimental.chat.messages.transform"]({}, { messages: [userMsg("ses_legacy", { id: "msg_dcp_summary_9" })] });
        assert.equal(rec.messages, undefined, "synthetic summary message skipped");
        await b.wrapped["experimental.chat.messages.transform"]({}, { messages: [userMsg("ses_legacy", { parts: [] })] });
        assert.equal(rec.messages, undefined, "empty-parts user message skipped");
        await b.wrapped["experimental.chat.messages.transform"]({}, { messages: [userMsg("ses_legacy", { parts: [{ ignored: true }] })] });
        assert.equal(rec.messages, undefined, "fully-ignored user message skipped");

        await b.wrapped["experimental.text.complete"]({ sessionID: "ses_legacy" }, { text: "x" });
        assert.ok(rec.textComplete, "legacy text.complete delegated");
        rec.textComplete = undefined;
        await b.wrapped["experimental.text.complete"]({ sessionID: "ses_new" }, { text: "x" });
        assert.equal(rec.textComplete, undefined, "new-session text.complete skipped");

        await b.wrapped["command.execute.before"]({ command: "acp", sessionID: "ses_legacy" }, {});
        assert.ok(rec.commandBefore, "legacy command.execute.before delegated");
        rec.commandBefore = undefined;
        await b.wrapped["command.execute.before"]({ command: "acp", sessionID: "ses_new" }, {});
        assert.equal(rec.commandBefore, undefined, "new-session command skipped");

        await b.wrapped.event({ event: { type: "message.part.updated" } });
        assert.ok(rec.event, "event handler ungated (timing bookkeeping only)");

        assert.deepEqual(Object.keys(b.tools).sort(), ["compress", "decompress"]);
        const out = await b.tools.compress.execute({}, { sessionID: "ses_new" });
        assert.equal(typeof out, "string");
        assert.match(out as string, /not available in this session/);
        assert.equal(rec.toolCompress, undefined, "non-legacy tool call never reaches acp");
        const realOut = await b.tools.compress.execute({ ranges: [] }, { sessionID: "ses_legacy" });
        assert.ok(rec.toolCompress, "legacy tool call delegated");
        assert.notEqual(realOut, out);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        delete (globalThis as Record<string, unknown>).__acp;
    }
}));

test("createAcpBridge: graceful degradation paths return null", async () => {
    const cases: Array<{ name: string; setup: (pkgBase: string) => void }> = [
        { name: "import throws", setup: (pkgBase) => makePkg(pkgBase, "1.0.0", { body: "throw new Error('boom');" }) },
        { name: "no default export", setup: (pkgBase) => makePkg(pkgBase, "1.0.0", { body: "export const x = 1;" }) },
        { name: "messages.transform missing", setup: (pkgBase) => makePkg(pkgBase, "1.0.0", { body: "export default async () => ({ tool: { compress: { execute: async () => 'ok' } } });" }) },
        { name: "compress tool missing", setup: (pkgBase) => makePkg(pkgBase, "1.0.0", { body: "export default async () => ({ 'experimental.chat.messages.transform': async () => {} });" }) },
    ];
    for (const c of cases) {
        await withEnv({ XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined, OPENCODE_CONFIG_DIR: undefined, BILLION_CONTEXT_PROXY: "http://x/bili" }, async () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-degrade-"));
            try {
                const proj = path.join(base, "proj");
                process.env.XDG_DATA_HOME = path.join(base, "data");
                process.env.XDG_CONFIG_HOME = path.join(base, "config-empty");
                process.env.XDG_CACHE_HOME = path.join(base, "cache-empty");
                fs.mkdirSync(proj, { recursive: true });
                c.setup(path.join(proj, "node_modules"));
                assert.equal(await createAcpBridge({ directory: proj }), null, c.name);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        });
    }
    // no package anywhere
    await withEnv({ XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined, OPENCODE_CONFIG_DIR: undefined }, async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-none-"));
        try {
            const proj = path.join(base, "proj");
            process.env.XDG_DATA_HOME = path.join(base, "data");
            process.env.XDG_CONFIG_HOME = path.join(base, "config-empty");
            process.env.XDG_CACHE_HOME = path.join(base, "cache-empty");
            fs.mkdirSync(proj, { recursive: true });
            assert.equal(await createAcpBridge({ directory: proj }), null, "package not found");
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
    // wrong major only
    await withEnv({ XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, BILI_OPENCODE_ACP_SPEC: undefined, OPENCODE_CONFIG_DIR: undefined }, async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-major-"));
        try {
            const proj = path.join(base, "proj");
            process.env.XDG_DATA_HOME = path.join(base, "data");
            process.env.XDG_CONFIG_HOME = path.join(base, "config-empty");
            process.env.XDG_CACHE_HOME = path.join(base, "cache-empty");
            fs.mkdirSync(proj, { recursive: true });
            makePkg(path.join(proj, "node_modules"), "2.0.0", { body: FAKE_ACP_BODY });
            assert.equal(await createAcpBridge({ directory: proj }), null, "major 2 rejected");
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});
