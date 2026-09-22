import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { apply, planNativeDsh, shouldBootstrapNativeDsh, _resetRegisterForTest, _setSpawnForTest, _stateHeadersForTest, _stateRespawnForTest, _stateTakeoverGateForTest } from "../src/agent/dsh-native.ts";

import { dshNativeInstalled, isNpmInstallForm, pluginInstall, pluginRemove, pluginStatusAll, selfPackageRoot } from "../src/plugin-install.ts";
import { DSH_PATCH_BEGIN, DSH_PATCH_END, dshBundleInstalled, dshProfileDirs, planDshSpawn, stripDshManagedPatch, stripLegacyManagedBlock, _setDshRunnersForTest, type DshPlan } from "../src/dsh-channel.ts";

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

// — legacy managed-block migration (#966) ————————————————————————

const HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

// Block as written by pre-#966 installs: the markers are stable constants,
// the body is what the retired managed lane used to append.
const legacyBlockOf = (root: string): string => `${DSH_PATCH_BEGIN}\n- insert:\n    - id: bili-native\n      name: ${pathToFileURL(path.join(root, "dist", "agent", "dsh-native.js")).href}\n- id: compaction-basic\n  config:\n    auto: false\n${DSH_PATCH_END}\n`;

test("planTokens: unpacks the win32 cmd.exe wrap back to argv", () => {
    const plan = planDshSpawn("dsh", ["plugin", "--profile", "x", "add", "billion-context"], {}, "win32");
    assert.deepEqual(planTokens(plan), ["plugin", "--profile", "x", "add", "billion-context"]);
    // posix plans pass through untouched
    assert.deepEqual(planTokens({ command: "dsh", args: ["plugin", "--profile", "x", "add", "billion-context"] }), ["plugin", "--profile", "x", "add", "billion-context"]);
});

test("stripDshManagedPatch: removes only the marked span; no-op without markers", () => {
    const merged = `${HEADER}[]\n${legacyBlockOf("/opt/bili")}`;
    assert.equal(stripDshManagedPatch(merged), `${HEADER}[]\n`);
    assert.equal(stripDshManagedPatch(HEADER), HEADER);
});

test("stripLegacyManagedBlock: restores the placeholder when nothing meaningful remains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy-"));
    try {
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
        assert.equal(stripLegacyManagedBlock(dir), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("stripLegacyManagedBlock: preserves user entries; leaves non-managed files alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy2-"));
    try {
        const userEntry = '- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n';
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}${userEntry}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        assert.ok(out.includes(userEntry));
        assert.ok(!out.includes(DSH_PATCH_BEGIN));
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}[]\n`);
        assert.equal(stripLegacyManagedBlock(dir), false);
        assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("stripLegacyManagedBlock: preserves user comments when nothing meaningful remains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy3-"));
    try {
        const notes = "# my note one\n# my note two\n";
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${notes}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        assert.ok(out.startsWith(notes));
        assert.ok(out.includes("[]"));
        assert.ok(!out.includes(DSH_PATCH_BEGIN));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// — channel-driven installer roundtrip under a fake DSH_HOME ——————————

/** Recording stand-in for the real spawn: applies the manifest effect the
 *  dsh pnpm forwarder would leave behind (dep + bundle entry) so status /
 *  remove / dshNativeInstalled assertions see realistic state. On Windows the
 *  plan rides cmd.exe /d /s /c "<line>" — unpack it back to argv tokens so
 *  the same assertions hold on every platform (test tokens carry no spaces). */
function planTokens(plan: DshPlan): string[] {
    const base = path.basename(plan.command).toLowerCase();
    if (base !== "cmd.exe" && base !== "cmd") return [...plan.args];
    const line = plan.args[3] ?? "";
    const tokens = line.replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0);
    return tokens.slice(1);
}

function channelRunner(home: string, calls: string[][]): { sync: (p: DshPlan) => { stdout: string; stderr: string }; async: (p: DshPlan) => Promise<{ stdout: string; stderr: string }> } {
    const apply = (plan: DshPlan): { stdout: string; stderr: string } => {
        const tokens = planTokens(plan);
        calls.push(tokens);
        const pi = tokens.indexOf("--profile");
        const name = tokens[pi + 1];
        const action = tokens[pi + 2];
        const dir = path.join(home, "profiles", name);
        if (action === "add") {
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${name}`, dependencies: { "billion-context": "^0.1.120" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "billion-context"] } } }));
        } else if (action === "remove") {
            const m = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
            delete m.dependencies?.["billion-context"];
            if (m.dsh?.profile?.bundles) m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== "billion-context");
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(m));
        }
        return { stdout: "", stderr: "" };
    };
    return { sync: apply, async: async (p) => apply(p) };
}

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

const USER_ENTRY = '- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n';

// Mirrors the production spec rule (#925): npm-form install → registry name,
// checkout/dev build → absolute path the forwarder turns into a link: dep.
const expectedSpec = (): string => (isNpmInstallForm(selfPackageRoot()) ? "billion-context" : path.resolve(selfPackageRoot()));

test("dsh install drives the dsh plugin channel per profile, no managed blocks written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-"));
    const calls: string[][] = [];
    _setDshRunnersForTest(channelRunner(home, calls));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            assert.throws(() => pluginInstall("dsh"), /run dsh once/);
            assert.equal(dshNativeInstalled(), false);

            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            // headless carries a pre-unification managed block plus a user entry (upgrade path)
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}${USER_ENTRY}${legacyBlockOf("/opt/bili")}`);

            const msg = pluginInstall("dsh");
            assert.match(msg, /2 dsh profile/);
            assert.match(msg, /headless: legacy managed block stripped/);
            assert.ok(msg.includes(`add ${expectedSpec()}`));

            assert.deepEqual(calls.map((c) => c.join(" ")).sort(), [
                `plugin --profile headless add ${expectedSpec()}`,
                `plugin --profile web add ${expectedSpec()}`,
            ].sort());

            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.includes(USER_ENTRY));
            assert.ok(!headlessTxt.includes(DSH_PATCH_BEGIN));
            // the channel owns profile state — bili wrote no patch file of its own
            assert.ok(!fs.existsSync(path.join(home, "profiles", "web", "cordis.patch.yml")));

            assert.equal(pluginStatusAll().find((r) => r.agent === "dsh")?.status, "installed (dsh bundle in all 2 profiles)");
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dsh remove uninstalls through the same channel and migrates legacy blocks", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-remove-"));
    const calls: string[][] = [];
    _setDshRunnersForTest(channelRunner(home, calls));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(
                path.join(home, "profiles", "web", "package.json"),
                JSON.stringify({ name: "dsh-profile-web", dependencies: { "billion-context": "^0.1.120" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "billion-context"] } } }),
            );
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);

            const removed = pluginRemove("dsh");
            assert.match(removed, /removed bili from 2 dsh profile/);
            assert.match(removed, /web: uninstalled via the dsh plugin channel/);
            assert.match(removed, /headless: legacy managed block stripped/);
            assert.deepEqual(calls.map((c) => c.join(" ")).sort(), [`plugin --profile web remove billion-context`]);

            assert.equal(fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
            const webManifest = JSON.parse(fs.readFileSync(path.join(home, "profiles", "web", "package.json"), "utf8")) as Record<string, unknown>;
            assert.equal((webManifest.dependencies as Record<string, string>)["billion-context"], undefined);
            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /not installed/);
            assert.equal(dshNativeInstalled(), false);

            assert.match(pluginRemove("dsh"), /nothing to remove/);
            assert.equal(calls.length, 1);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dsh install surfaces channel failures with context", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-fail-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            _setDshRunnersForTest({ sync: () => { throw Object.assign(new Error("spawn failed"), { status: 127, stderr: "pnpm not found on PATH (corepack enable pnpm)" }); } });
            assert.throws(() => pluginInstall("dsh"), /pnpm not found on PATH/);
            _setDshRunnersForTest({ sync: () => { throw Object.assign(new Error("spawn failed"), { code: "ENOENT" }); } });
            assert.throws(() => pluginInstall("dsh"), /dsh CLI not found/);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dsh status: bundle / mixed / legacy / absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-status-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "a"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "b"), { recursive: true });
            const st = (): string => pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "";
            const bundleManifest = JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } });

            assert.match(st(), /not installed/);
            fs.writeFileSync(path.join(home, "profiles", "a", "package.json"), bundleManifest);
            assert.match(st(), /installed as a dsh bundle in 1\/2 profiles/);
            fs.writeFileSync(path.join(home, "profiles", "b", "package.json"), bundleManifest);
            assert.equal(st(), "installed (dsh bundle in all 2 profiles)");

            fs.rmSync(path.join(home, "profiles", "a", "package.json"));
            fs.rmSync(path.join(home, "profiles", "b", "package.json"));
            fs.writeFileSync(path.join(home, "profiles", "a", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
            assert.match(st(), /legacy managed block in 1\/2 profiles — rerun/);
            fs.writeFileSync(path.join(home, "profiles", "b", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
            assert.match(st(), /legacy managed block — rerun 'bili plugin install dsh' to migrate/);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshNativeInstalled: true iff any profile has the bundle or a legacy managed block", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-installed-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            assert.equal(dshNativeInstalled(), false);
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), legacyBlockOf("/opt/bili"));
            assert.equal(dshNativeInstalled(), true);
            fs.rmSync(path.join(home, "profiles", "headless", "cordis.patch.yml"));
            fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));
            assert.equal(dshNativeInstalled(), true);
        });
        // no profiles root at all — nothing can be installed (keep the env
        // pointed at the sandbox: the developer's real ~/.dsh may carry an
        // install, and this must not read it)
        await withEnv({ DSH_HOME: path.join(home, "absent") }, () => {
            assert.equal(dshNativeInstalled(), false);
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

function startMockProxy(toolCalls: Array<{ conversationId: string; tool: string; args: unknown }>, statusResponder?: (url: string) => unknown | undefined): Promise<{ origin: string; close: () => void }> {
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
            const body = statusResponder === undefined ? { panel: "PANEL-OK" } : statusResponder(url);
            if (body === undefined) {
                res.writeHead(404);
                res.end("{}");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
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
    // #955 runtime-info sources: tests can attach llm/agentDefaultModel and
    // replay them through the same dynamic ctx.inject path production uses.
    let llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined = undefined;
    let agentDefaultModel: { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (deps: readonly string[], callback: (sub: unknown) => void) => {
            if (deps.includes("llm") && deps.includes("agentDefaultModel") && llm !== undefined && agentDefaultModel !== undefined) {
                callback({ llm, agentDefaultModel });
            }
        },
        setModelServices: (l: typeof llm, a: typeof agentDefaultModel) => {
            llm = l;
            agentDefaultModel = a;
        },
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
            assert.equal(ctx.registeredCommands.length, 2);
            assert.equal(ctx.registeredCommands[0].name, "acp");
            assert.equal(ctx.registeredCommands[1].name, "acp-cache");

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

test("apply() /acp-cache (#1146): forwards acp_cache bound to the initiator session, falls back to latest", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cache-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const cap = await startMockProxy(calls, (url) =>
                url.includes("fallback=latest") ? { ok: true, conversationId: "conv-latest", panel: "PANEL-OK" } : undefined);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx = mockCtx();
                apply(ctx);
                const cacheCmd = ctx.registeredCommands.find((c) => c.name === "acp-cache");
                assert.ok(cacheCmd, "acp-cache registered");

                ctx.setInitiator({ session: { id: "session-9" } });
                const bound = await cacheCmd.handler();
                assert.equal(bound.kind, "success");
                assert.deepEqual(calls, [{ conversationId: "session-9", tool: "acp_cache", args: {} }]);

                ctx.setInitiator(undefined);
                calls.length = 0;
                const latest = await cacheCmd.handler();
                assert.equal(latest.kind, "success");
                assert.deepEqual(calls, [{ conversationId: "conv-latest", tool: "acp_cache", args: {} }]);
            } finally {
                cap.close();
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp-cache (#1146): unreachable proxy reports an error", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cache-down-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            // healthy attach first (so register.base is set), then kill the
            // proxy before the handler runs — a dead preset would instead
            // trigger the #983 spawn fallback, which this test does not want
            const proxy = await startMockProxy([]);
            try {
                _resetRegisterForTest(proxy.origin);
                process.env.BILLION_CONTEXT_PROXY = proxy.origin;
                const ctx = mockCtx();
                apply(ctx);
                await waitFor(() => ctx.registeredTools.length === 1, "tool registration");
                const cacheCmd = ctx.registeredCommands.find((c) => c.name === "acp-cache");
                assert.ok(cacheCmd, "acp-cache registered");
                proxy.close();
                const out = await cacheCmd.handler();
                assert.equal(out.kind, "error");
                assert.match(out.text, /proxy not reachable/);
            } finally {
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
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

test("apply() runtime-info (#955): model services stamp model/window/max-output headers", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ri-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            ctx.setModelServices(
                {
                    resolveModelInfo: async (provider, model) => {
                        assert.equal(provider, "deepseek");
                        assert.equal(model, "qwen-ri");
                        return { context: { contextWindow: 262144 }, defaultMaxTokens: 32768 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ri" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ri)");
            ctx.setInitiator({ session: { id: "session-ri" } });
            // First stamp may fire before the async resolveModelInfo lands —
            // poll until the window header shows up.
            await waitFor(() => {
                const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
                return headers?.["x-bili-plugin-context-window"] === "262144";
            }, "model-info refresh stamped headers");
            const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            assert.equal(headers?.["x-bili-plugin"], "dsh");
            assert.equal(headers?.["x-bili-plugin-conversation"], "session-ri");
            assert.equal(headers?.["x-bili-plugin-model"], "qwen-ri");
            assert.equal(headers?.["x-bili-plugin-context-window"], "262144");
            assert.equal(headers?.["x-bili-plugin-max-output"], "32768");
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#956): a mid-resolve model switch discards the stale resolve", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-race-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // mutable live selection: A at startup, switched to B mid-resolve
            let selection = { provider: "deepseek", model: "qwen-a" };
            type ModelInfoLike = { context?: { contextWindow?: number }; defaultMaxTokens?: number };
            let releaseA: ((v: ModelInfoLike) => void) | undefined;
            const gateA = new Promise<ModelInfoLike>((r) => {
                releaseA = r;
            });
            ctx.setModelServices(
                {
                    resolveModelInfo: async (_provider, model) =>
                        model === "qwen-a" ? gateA : { context: { contextWindow: 12345 }, defaultMaxTokens: 4096 },
                },
                { currentSelection: () => selection },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (race)");
            ctx.setInitiator({ session: { id: "session-race" } });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // apply()'s inject already started A's async resolve (gated, in flight)
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            // switch the LIVE selection to B while A is still resolving
            selection = { provider: "deepseek", model: "qwen-b" };
            releaseA?.({ context: { contextWindow: 999999 }, defaultMaxTokens: 8888 });
            await new Promise((r) => setTimeout(r, 20));
            // the stale A result must NOT have been committed or stamped
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            assert.notEqual(stamp()?.["x-bili-plugin-model"], "qwen-a");
            // self-heal: the next refresh re-resolves the LIVE selection (B)
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "12345", "post-switch re-resolve stamped B");
            assert.equal(stamp()?.["x-bili-plugin-model"], "qwen-b");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "4096");
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp pre-first-request (#955): renders the runtime-table entry before any model request", async () => {
    const pre = {
        ok: true,
        conversationId: "dsh",
        phase: "pre-first-request",
        model: "qwen-ri",
        contextLimit: 262144,
        runtimeInfo: { agent: "dsh", model: "qwen-ri", contextWindow: 262144, maxOutput: 32768, source: "client-config" },
        panel: null,
    };
    // no initiator session → statusOutcome takes the fetchStatusLatest path
    // (conversationId=dsh&fallback=latest), which the proxy answers from the
    // agent-keyed runtime table pre-first-request
    const proxy = await startMockProxy([], (url) => (url.includes("conversationId=dsh&fallback=latest") ? pre : undefined));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-pre-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredCommands.length, 2);
            const out = await ctx.registeredCommands[0].handler();
            assert.equal(out.kind, "success");
            assert.match(out.text, /model=qwen-ri/);
            assert.match(out.text, /window=262144/);
            assert.match(out.text, /maxOut=32768/);
            assert.match(out.text, /client-config/);
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

// — #983: stale attach verification + spawn fallback + self-heal ——————————

test("#983 apply() attach mode: a dead preset falls back to a spawned proxy and unfreezes the env", async () => {
    const live = await startMockProxy([]);
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return forward.origin;
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983a-"));
    try {
        // port 1 on loopback: connection refused immediately — a stale preset
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "fallback tool registration");
            // the dead preset was replaced by the fallback-spawned origin…
            assert.equal(spawnCalls, 1);
            assert.match(errors.join("\n"), /not healthy — falling back/);
            // …and the env is unfrozen so a later re-apply plans spawn, not attach
            assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined);
            // tools are live against the fallback origin
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s983" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(calls, [{ conversationId: "s983", tool: "compress", args: { summary: "s" } }]);
        });
    } finally {
        console.error = origErr;
        _setSpawnForTest(undefined);
        live.close();
        forward.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("#983 apply() attach mode: a healthy preset attaches without any spawn", async () => {
    const proxy = await startMockProxy([]);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:1";
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983b-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "attach tool registration");
            assert.equal(spawnCalls, 0);
            assert.equal(process.env.BILLION_CONTEXT_PROXY, proxy.origin);
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("#983 maybeRetry self-heals a base-less register after a failed respawn", async () => {
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    const answers: Array<string | undefined> = [undefined, forward.origin];
    _setSpawnForTest(async () => answers.shift());
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983c-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            // first spawn attempt fails → fallback leaves the register base-less
            await new Promise((r) => setTimeout(r, 50));
            const headersFor = _stateHeadersForTest();
            assert.ok(headersFor !== undefined, "headersFor installed");
            // a later model request drives maybeRetry → respawn (2nd answer) → tools recover
            headersFor("https://api.anthropic.com/v1/messages");
            await waitFor(() => ctx.registeredTools.length === 1, "self-healed tool registration");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s983c" } } });
            assert.equal(out, "compressed 42 tokens");
            // once tools are ready the stamping path works again
            ctx.setInitiator({ session: { id: "s983c" } });
            headersFor("https://api.anthropic.com/v1/messages");
            // toolsReady is set asynchronously after registration; poll for the stamp
            await waitFor(() => headersFor("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
            assert.equal(headersFor("https://api.anthropic.com/v1/messages")?.["x-bili-plugin"], "dsh");
        });
    } finally {
        _setSpawnForTest(undefined);
        forward.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("#1117 apply() installs takeoverGate keyed on currentInitiator attribution", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1117-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // Settle the async attach verification before teardown (#983
            // discipline): a deferred probe hitting a closed proxy would run
            // the fallback mid-way through a LATER apply() and clobber
            // state.origin / register.base / the preset env (sequence
            // pollution exposed when #1130's suites follow this one).
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            // unattributed (background chain, third-party in-process plugin) → NOT claimed
            assert.equal(gate("https://api.anthropic.com/v1/messages"), false);
            // attributed (the host's own agent chain) → claimed
            ctx.setInitiator({ session: { id: "s1117" } });
            assert.equal(gate("https://api.anthropic.com/v1/messages"), true);
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

// — #1130: runtime death of a SHARED attach proxy re-probes + falls back ———

test("#1130 apply() attach mode: runtime death of the shared proxy re-probes and falls back to spawn", async () => {
    const shared = await startMockProxy([]);
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const fallback = await startMockProxy(calls);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return fallback.origin;
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1130-"));
    try {
        // terminal B attached to terminal A's launcher proxy at startup —
        // live preset, no spawn
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: shared.origin }, async () => {
            _resetRegisterForTest(shared.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            assert.equal(spawnCalls, 0);
            // attach mode must arm a runtime respawn seam (the interceptor's
            // death branch drives exactly this call)
            const respawn = _stateRespawnForTest();
            assert.ok(respawn !== undefined, "attach mode armed state.respawn");
            // terminal A's dsh exits → its launcher kills the shared proxy
            shared.close();
            await new Promise((r) => setTimeout(r, 50));
            const recovered = await respawn();
            assert.equal(recovered, fallback.origin);
            assert.equal(spawnCalls, 1);
            assert.match(errors.join("\n"), /not healthy — falling back/);
            // the preset env is unfrozen so a later re-apply plans spawn, not attach
            assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined);
            // registered tools read the LIVE base — they now forward to the
            // fallback origin without any re-registration
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1130" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(calls, [{ conversationId: "s1130", tool: "compress", args: { summary: "s" } }]);
            // plugin-mode header stamping keeps working against the fallback
            const headersFor = _stateHeadersForTest();
            assert.ok(headersFor !== undefined, "headersFor installed");
            ctx.setInitiator({ session: { id: "s1130" } });
            await waitFor(() => headersFor("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
            assert.equal(headersFor("https://api.anthropic.com/v1/messages")?.["x-bili-plugin"], "dsh");
        });
    } finally {
        console.error = origErr;
        _setSpawnForTest(undefined);
        fallback.close();

        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});
