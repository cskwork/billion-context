import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { apply, planNativeDsh, shouldBootstrapNativeDsh, _resetRegisterForTest, _stateHeadersForTest } from "../src/agent/dsh-native.ts";
import { dshManagedPatchBlock, dshNativeInstalled, dshProfileDirs, mergeDshManagedPatch, stripDshManagedPatch, dshBundleInstalled, pluginInstall, pluginRemove, pluginStatusAll } from "../src/plugin-install.ts";

test("planNativeDsh: kill-switches > attach > spawn precedence (#941)", () => {
    assert.deepEqual(planNativeDsh({}), { mode: "spawn" });
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a preset BILLION_CONTEXT_PROXY (the `bili dsh` launcher) is an attach
    // target, not a stand-down
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:8787" });
    // explicit BILLION_CONTEXT_ATTACH wins over the preset proxy env
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "attach", attachOrigin: "http://127.0.0.1:9999" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "off" });
});

test("shouldBootstrapNativeDsh: spawn-gated by env shape", () => {
    assert.equal(shouldBootstrapNativeDsh({}), true);
    assert.equal(shouldBootstrapNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), false);
    assert.equal(shouldBootstrapNativeDsh({ BILI_NATIVE_DSH: "0" }), false);
});

// — patch-file text surgery —————————————————————————————————————————

const HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

// Platform-dependent by construction (win32 path shape) — mirror dshManagedPatchBlock, never hardcode a URL literal here.
const pluginUrlOf = (root: string): string => pathToFileURL(path.join(root, "dist", "agent", "dsh-native.js")).href;

test("mergeDshManagedPatch: placeholder [] is replaced, comments survive", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const merged = mergeDshManagedPatch(`${HEADER}[]\n`, block);
    assert.ok(merged.startsWith(HEADER));
    assert.ok(merged.includes(`- insert:\n    - id: bili-native\n      name: ${pluginUrlOf("/opt/bili")}\n`));
    assert.ok(merged.includes("- id: compaction-basic\n  config:\n    auto: false\n"));
    assert.ok(!merged.includes("[]"));
});

test("mergeDshManagedPatch: user entries survive before the managed block", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const user = `${HEADER}[]\n- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n`;
    const merged = mergeDshManagedPatch(user, block);
    const lines = merged.split("\n");
    const userIdx = lines.findIndex((l) => l === "- id: my-thing");
    const biliIdx = lines.findIndex((l) => l.includes("bili begin"));
    assert.ok(userIdx >= 0 && biliIdx > userIdx);
    assert.ok(merged.includes("- id: my-thing"));
});

test("mergeDshManagedPatch/stripDshManagedPatch roundtrip restores the placeholder", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const merged = mergeDshManagedPatch(`${HEADER}[]\n`, block);
    const stripped = stripDshManagedPatch(merged);
    assert.equal(stripped, HEADER);
    // strip is a no-op without the markers
    assert.equal(stripDshManagedPatch(HEADER), HEADER);
});

test("mergeDshManagedPatch is idempotent and rewrites a moved install path", () => {
    const first = mergeDshManagedPatch(`${HEADER}[]\n`, dshManagedPatchBlock("/old/root"));
    const second = mergeDshManagedPatch(first, dshManagedPatchBlock("/new/root"));
    assert.ok(second.includes(pluginUrlOf("/new/root")));
    assert.ok(!second.includes("/old/root"));
    assert.equal(second.match(/bili begin/g)?.length, 1);
    const third = mergeDshManagedPatch(second, dshManagedPatchBlock("/new/root"));
    assert.equal(third, second);
});

// — installer roundtrip under a fake DSH_HOME ————————————————————————

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("dsh install/remove/status roundtrip under a fake DSH_HOME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            // no profiles yet → the installer says run dsh first
            assert.throws(() => pluginInstall("dsh"), /run dsh once/);
            assert.equal(dshNativeInstalled(), false);

            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}[]\n`);
            // web/ has no patch file yet — the installer materializes it

            const msg = pluginInstall("dsh");
            assert.match(msg, /2 dsh profile/);
            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.startsWith(HEADER));
            assert.ok(headlessTxt.includes("dsh-native.js"));
            assert.ok(headlessTxt.includes("auto: false"));
            const webTxt = fs.readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
            assert.ok(webTxt.includes("dsh-native.js"));

            assert.equal(pluginStatusAll().find((r) => r.agent === "dsh")?.status, "installed");
            assert.equal(dshNativeInstalled(), true);

            const removed = pluginRemove("dsh");
            assert.match(removed, /2 dsh profile/); // install wrote both files
            const after = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.equal(after, `${HEADER}[]\n`);
            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /not installed/);
            assert.equal(dshNativeInstalled(), false);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshNativeInstalled: true iff any profile carries the managed block", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-installed-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            assert.equal(dshNativeInstalled(), false);
            fs.writeFileSync(
                path.join(home, "profiles", "headless", "cordis.patch.yml"),
                mergeDshManagedPatch(`${HEADER}[]\n`, dshManagedPatchBlock(home)),
            );
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshBundleInstalled: true iff the profile manifest lists billion-context as a bundle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-bundle-"));
    try {
        fs.mkdirSync(path.join(home, "web"), { recursive: true });
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no manifest
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ name: "dsh-profile" }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no dsh block
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["something-else"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false);
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), true);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dsh install/remove/status skip bundle-installed profiles, dshNativeInstalled recognizes them", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-bundle-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}[]\n`);
            // web/ installed billion-context via `dsh plugin add` — manifest carries the bundle
            fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));

            // the bundle profile already provides bili-native
            assert.equal(dshNativeInstalled(), true);

            // install only touches the non-bundle profile and says so
            const msg = pluginInstall("dsh");
            assert.match(msg, /1 dsh profile/);
            assert.match(msg, /web: skipped \(installed as a dsh bundle/);
            assert.ok(!fs.existsSync(path.join(home, "profiles", "web", "cordis.patch.yml")));
            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.includes("dsh-native.js"));

            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /installed as a dsh bundle in 1\/2 profiles/);

            // remove also skips the bundle profile with a pointer to the dsh-side command
            const removed = pluginRemove("dsh");
            assert.match(removed, /1 dsh profile/);
            assert.match(removed, /dsh plugin --profile web remove billion-context/);
            const after = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.equal(after, `${HEADER}[]\n`);
            // web/ still counts as installed via its bundle
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshProfileDirs: skips node_modules, errors when profiles root is absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-dirs-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            assert.throws(() => dshProfileDirs(), /run dsh once/);
            fs.mkdirSync(path.join(home, "profiles", "node_modules"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            const dirs = dshProfileDirs();
            assert.equal(dirs.length, 1);
            assert.ok(dirs[0].endsWith("headless"));
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// — apply() integration against a mock proxy ——————————————————————————

type MockTool = { name: string; description?: string; inputSchema: unknown };

function startMockProxy(toolCalls: Array<{ conversationId: string; tool: string; args: unknown }>): Promise<{ origin: string; close: () => void }> {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" }, range: { type: "string" } }, required: ["summary"] },
        },
    ];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            return;
        }
        if (url.startsWith("/__bili/plugin/tool")) {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const parsed = JSON.parse(body) as { conversationId?: string; tool?: string; args?: unknown };
                toolCalls.push({ conversationId: parsed.conversationId ?? "", tool: parsed.tool ?? "", args: parsed.args });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: "compressed 42 tokens" }));
            });
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ panel: "PANEL-OK" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

/** Poll until cond() holds (10ms ticks, 5s cap) — a fixed sleep races on
 *  slow CI runners (windows loopback fetch can outlast 50ms). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
    };
}

test("apply() attach mode: registers manifest tools verbatim, gates headers, forwards with the session id", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-apply-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // under node:test the fetch patch is deliberately NOT installed
            assert.equal(ctx.registeredCommands.length, 1);
            assert.equal(ctx.registeredCommands[0].name, "acp");

            // headers gate on toolsReady — no session, no headers; and before
            // registration completes nothing is stamped
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ctx)");
            const tool = ctx.registeredTools[0];
            assert.equal(tool.name, "compress");
            // parameters pass through verbatim (the manifest's JSON Schema)
            assert.deepEqual(tool.parameters, {
                type: "object",
                properties: { summary: { type: "string" }, range: { type: "string" } },
                required: ["summary"],
            });
            assert.deepEqual(tool.output.schema, { type: "string" });

            // execute forwards with the owning agent's session id
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const proxy2 = { origin: "", close: () => {} };
            void proxy2;
            // direct execute path (fresh proxy capturing calls):
            const cap = await startMockProxy(calls);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx2 = mockCtx();
                apply(ctx2);
                await waitFor(() => ctx2.registeredTools.length === 1, "manifest tool registration (ctx2)");
                const t2 = ctx2.registeredTools[0];
                const out = await t2.execute({ summary: "s" }, { agent: { session: { id: "session-7" } } });
                assert.equal(out, "compressed 42 tokens");
                assert.deepEqual(calls, [{ conversationId: "session-7", tool: "compress", args: { summary: "s" } }]);
                // agentless execution fails loudly
                await assert.rejects(() => t2.execute({ summary: "s" }, {}), /requires an owning agent session/);
            } finally {
                cap.close();
                _resetRegisterForTest(proxy.origin);
                process.env.BILLION_CONTEXT_PROXY = proxy.origin;
            }

            // /acp prefers the initiator's session, falls back to latest
            ctx.setInitiator({ session: { id: "session-7" } });
            const ok = await ctx.registeredCommands[0].handler();
            assert.equal(ok.kind, "success");
            assert.ok(ok.text.includes("PANEL-OK") || ok.text.includes("billion-context@"));
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() inactive-context registration failure is silent and terminal (dsh 0.1.5+ teardown)", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inactive-"));
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // simulate cordis teardown: the plugin context is inactive, so
            // every service access rejects with cordis's inactive-context error
            const inactive = new Error('cannot get required service "tools" in inactive context');
            ctx.tools.register = () => {
                throw inactive;
            };
            apply(ctx);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(ctx.registeredTools.length, 0);
            // teardown noise is suppressed — no retry log, no wire-mode warning
            assert.equal(errors.length, 0);
            // a later nudge (headersFor) must not resurrect retries either
            const stamp = _stateHeadersForTest();
            stamp?.("http://example.test/v1/messages");
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(errors.length, 0);
        });
    } finally {
        console.error = origErr;
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() is a no-op under the kill switches", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-off-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PLUGIN: "0" }, () => {
            _resetRegisterForTest(undefined);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(ctx.registeredCommands.length, 0);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
