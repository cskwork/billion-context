import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyOpencodePluginEntry,
    isNpmInstallForm,
    OPENCODE_NPM_ENTRY,
    pluginInstall,
    pluginRemove,
    pluginStatusAll,
    selfPackageRoot,
} from "../src/plugin-install.ts";

const NPM_ROOT = "/usr/local/lib/node_modules/billion-context";

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entryArgs(root: string, base: string): { data: Record<string, unknown>; root: string; shimDir: string; agentJs: string } {
    const shimDir = path.join(base, "opencode", "plugins", "billion-context");
    return { data: {}, root, shimDir, agentJs: path.join(root, "dist", "agent", "opencode-native.js") };
}

test("isNpmInstallForm: npm/pnpm/yarn roots are npm form, checkouts are not", () => {
    assert.equal(isNpmInstallForm("/usr/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/usr/local/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/.npm-global/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/proj/node_modules/.pnpm/billion-context@0.1.118/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/checkouts/billion-context"), false);
    assert.equal(isNpmInstallForm("/opt/bili"), false);
    assert.equal(isNpmInstallForm("/srv/node_modules"), false);
});

test("applyOpencodePluginEntry: npm form writes the bare package name only", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-npm-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
    assert.deepEqual(notes, [`plugin -> ${OPENCODE_NPM_ENTRY}`]);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form migrates a legacy dev shim to the bare name and deletes the dir", () => {
    const base = tempDir("bili-oc-migrate-");
    const args = entryArgs(NPM_ROOT, base);
    fs.mkdirSync(args.shimDir, { recursive: true });
    fs.writeFileSync(path.join(args.shimDir, "index.js"), 'export { default } from "/opt/old/dist/agent/opencode-native.js";\n');
    args.data.plugin = ["other-pkg", args.shimDir];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, ["other-pkg", OPENCODE_NPM_ENTRY]);
    assert.equal(notes[0], `plugin -> ${OPENCODE_NPM_ENTRY} (replaced ${args.shimDir})`);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form is idempotent", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-idem-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    assert.deepEqual(applyOpencodePluginEntry(args), ["plugin present"]);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
});

test("applyOpencodePluginEntry: dev form writes a local shim and warns it is not portable", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir}`);
    assert.match(notes[1], /not portable across machines/);
    const shim = fs.readFileSync(path.join(args.shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(args.agentJs)};\n`);
});

test("applyOpencodePluginEntry: dev form replaces an existing bare-name entry with the shim", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-replace-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir} (replaced ${OPENCODE_NPM_ENTRY})`);
    assert.match(notes[1], /not portable across machines/);
});

test("applyOpencodePluginEntry: non-string plugin entries are ignored (pre-existing filter behavior)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-nonstr-"));
    args.data.plugin = [42, null, "other-pkg"];
    applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, ["other-pkg", OPENCODE_NPM_ENTRY]);
});

type OcCfg = { plugin?: unknown; compaction?: { auto?: boolean } & Record<string, unknown>; mcp?: unknown };

test("pluginInstall/remove/status opencode end-to-end (dev form under tsx)", (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevMcp = process.env.BILI_MCP_PROXY;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.BILI_MCP_PROXY;
    const xdg = tempDir("bili-oc-xdg-");
    const state = tempDir("bili-oc-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        if (prevMcp === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevMcp;
        fs.rmSync(xdg, { recursive: true, force: true });
        fs.rmSync(state, { recursive: true, force: true });
    });

    const file = path.join(xdg, "opencode", "opencode.json");
    const shimDir = path.join(xdg, "opencode", "plugins", "billion-context");
    const readCfg = (): OcCfg => JSON.parse(fs.readFileSync(file, "utf8")) as OcCfg;
    const ocStatus = () => pluginStatusAll().find((r) => r.agent === "opencode")?.status;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude", plugin: ["some-other"], compaction: { auto: true } }, null, 2));

    assert.equal(ocStatus(), "not installed");

    const out = pluginInstall("opencode");
    assert.ok(out.startsWith(`opencode: installed -> ${file}`), out);
    assert.match(out, /plugin -> .+plugins[\\/]billion-context/);
    assert.match(out, /machine-local shim, not portable across machines/);
    let cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other", shimDir]);
    assert.equal(cfg.compaction?.auto, false);
    assert.equal(cfg.mcp, undefined);
    const shim = fs.readFileSync(path.join(shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(path.join(selfPackageRoot(), "dist", "agent", "opencode-native.js"))};\n`);
    assert.equal(ocStatus(), "installed");

    const again = pluginInstall("opencode");
    assert.match(again, /plugin present/);
    assert.deepEqual(readCfg().plugin, ["some-other", shimDir]);

    const rem = pluginRemove("opencode");
    assert.match(rem, /^opencode: removed from /);
    assert.match(rem, /plugin removed \(/);
    cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other"]);
    assert.equal(cfg.compaction?.auto, true);
    assert.equal(fs.existsSync(shimDir), false);
    assert.equal(ocStatus(), "not installed");

    assert.match(pluginRemove("opencode"), /not installed/);
});
