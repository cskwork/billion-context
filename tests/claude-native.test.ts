// #964 claude native posture: managed settings block (pure merge/strip),
// port resolution, installer round-trip against a fake `claude` CLI in a
// sandboxed CLAUDE_CONFIG_DIR, and the SessionStart hook's pure planner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import {
    applyClaudeManagedBlock,
    claudeNativeBaseUrl,
    claudeNativeInstalled,
    claudeSettingsFile,
    isBiliClaudeBaseUrl,
    pluginInstall,
    pluginRemove,
    stripClaudeManagedBlock,
} from "../src/plugin-install.ts";
import { CLAUDE_NATIVE_DEFAULT_PORT, resolveClaudeNativePort } from "../src/config.ts";
import { planClaudeNativeBootstrap } from "../src/claude-native-bootstrap.ts";

const HOOK_COMMAND = "/opt/bili/dist/claude-native-bootstrap.js";

function baseUrlForPort(port: number): string {
    return `http://127.0.0.1:${port}/bili/https://api.anthropic.com`;
}

// — pure merge/strip ————————————————————————————————————————————

test("applyClaudeManagedBlock: writes env + hook into empty settings", () => {
    const { data, notes } = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "1");
    const entries = (data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0] as { hooks: Array<{ type: string; command: string }> }).hooks, [{ type: "command", command: HOOK_COMMAND }]);
    assert.equal(notes.length, 3);
});

test("applyClaudeManagedBlock: idempotent — a second apply changes nothing", () => {
    const first = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const second = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.deepEqual(second.data, first.data);
    assert.equal(second.notes.length, 0);
});

test("applyClaudeManagedBlock: rewrites an older bili URL to the current port", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: baseUrlForPort(40000) } };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.ok(notes.some((n) => n.includes("ANTHROPIC_BASE_URL")));
});

test("applyClaudeManagedBlock: never clobbers foreign keys", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: "https://relay.example", DISABLE_AUTO_COMPACT: "0" }, other: true };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, "https://relay.example");
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "0");
    assert.equal((data.other as boolean), true);
    assert.ok(notes.some((n) => n.includes("foreign value") || n.includes("left untouched")));
});

test("applyClaudeManagedBlock: preserves user SessionStart entries", () => {
    const userEntry = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const first = applyClaudeManagedBlock({ hooks: { SessionStart: [userEntry] } }, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const entries = (first.data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], userEntry);
    const again = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: "/moved/dist/claude-native-bootstrap.js" });
    assert.equal((again.data.hooks as Record<string, unknown[]>).SessionStart.length, 2, "old-path entry still counts as ours");
    assert.equal(again.notes.length, 0);
});

test("stripClaudeManagedBlock: round-trip removes ours, keeps user keys", () => {
    const userEnv = { CUSTOM: "x" };
    const userEntry = { hooks: [{ type: "command", command: "echo hi" }] };
    const applied = applyClaudeManagedBlock(
        { env: { ...userEnv }, hooks: { SessionStart: [userEntry], PreCompact: [userEntry] } },
        { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND },
    );
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.deepEqual(removed.sort(), ["env.DISABLE_AUTO_COMPACT", "env.ANTHROPIC_BASE_URL", "hooks.SessionStart entry"].sort());
    assert.deepEqual(data.env, userEnv);
    assert.deepEqual((data.hooks as Record<string, unknown[]>).SessionStart, [userEntry]);
    assert.ok((data.hooks as Record<string, unknown>).PreCompact);
});

test("stripClaudeManagedBlock: empty containers are dropped, foreign values survive", () => {
    const applied = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.equal(removed.length, 3);
    assert.equal("env" in data, false);
    assert.equal("hooks" in data, false);
    const foreign = stripClaudeManagedBlock({ env: { ANTHROPIC_BASE_URL: "https://relay.example" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo" }] }] } });
    assert.equal(foreign.removed.length, 0);
    assert.deepEqual(foreign.data.env, { ANTHROPIC_BASE_URL: "https://relay.example" });
});

// — URL/port helpers ————————————————————————————————————————————

test("isBiliClaudeBaseUrl: only loopback /bili/ wraps match", () => {
    assert.equal(isBiliClaudeBaseUrl(baseUrlForPort(48787)), true);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/bili/https://relay.example"), true);
    assert.equal(isBiliClaudeBaseUrl("https://api.anthropic.com"), false);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/v1"), false);
    assert.equal(isBiliClaudeBaseUrl(undefined), false);
});

test("claudeNativeBaseUrl: default wraps api.anthropic.com; BILI_CLAUDE_UPSTREAM wraps the relay", () => {
    const prev = process.env.BILI_CLAUDE_UPSTREAM;
    const prevPort = process.env.BILI_CLAUDE_NATIVE_PORT;
    try {
        delete process.env.BILI_CLAUDE_UPSTREAM;
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        assert.equal(claudeNativeBaseUrl().includes(`/bili/https://api.anthropic.com`), true);
        process.env.BILI_CLAUDE_UPSTREAM = "https://relay.example/";
        assert.equal(claudeNativeBaseUrl(), `http://127.0.0.1:${CLAUDE_NATIVE_DEFAULT_PORT}/bili/https://relay.example`);
    } finally {
        if (prev === undefined) delete process.env.BILI_CLAUDE_UPSTREAM;
        else process.env.BILI_CLAUDE_UPSTREAM = prev;
        if (prevPort === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPort;
    }
});

test("resolveClaudeNativePort: env > default; rejects junk", () => {
    assert.equal(resolveClaudeNativePort({}), CLAUDE_NATIVE_DEFAULT_PORT);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "49999" }), 49999);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "0" }), CLAUDE_NATIVE_DEFAULT_PORT);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "not-a-number" }), CLAUDE_NATIVE_DEFAULT_PORT);
});

// — hook planner ————————————————————————————————————————————

test("planClaudeNativeBootstrap: launcher-owned / opt-out / start", () => {
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:39000" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_PROVIDER_REWRITES: "x" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_NATIVE_CLAUDE: "0" }).action, "passthrough");
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PLUGIN: "0" }).action, "passthrough");
    const start = planClaudeNativeBootstrap({});
    assert.deepEqual(start, { action: "start", port: CLAUDE_NATIVE_DEFAULT_PORT });
    assert.equal(planClaudeNativeBootstrap({ BILI_CLAUDE_NATIVE_PORT: "49999" }).port, 49999);
});

// — installer round-trip (fake claude CLI + sandboxed config dir) ———————

function fakeClaude(dir: string): string {
    const isWin = process.platform === "win32";
    const script = path.join(dir, isWin ? "claude-fake.cmd" : "claude-fake");
    fs.writeFileSync(script, isWin ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWin) fs.chmodSync(script, 0o755);
    return script;
}

function sandbox(): { dir: string; settings: string; mcpJson: string; biliConfig: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    // #964: pluginInstall persists claude.nativePort into the bili config —
    // sandbox that too so tests never touch the real user config.
    const biliConfig = path.join(dir, "billion-context.json");
    process.env.BILI_CONFIG_FILE = biliConfig;
    return { dir, settings: path.join(dir, "settings.json"), mcpJson: path.join(dir, ".claude.json"), biliConfig };
}

function unsandbox(prev: string | undefined, prevCfg: string | undefined = process.env.BILI_CONFIG_FILE): void {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = prevCfg;
}

test("claudeSettingsFile: CLAUDE_CONFIG_DIR replaces the whole .claude dir", () => {
    assert.equal(claudeSettingsFile({ CLAUDE_CONFIG_DIR: "/tmp/cc" }), path.join("/tmp/cc", "settings.json"));
});

test("installer round-trip: managed block + MCP face, then removal restores", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        assert.equal(claudeNativeInstalled(), false);

        const note = pluginInstall("claude");
        assert.ok(note.includes("managed block"), note);
        assert.ok(fs.existsSync(box.settings));
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string>; hooks?: unknown };
        assert.equal(after.env?.ANTHROPIC_BASE_URL, baseUrlForPort(CLAUDE_NATIVE_DEFAULT_PORT));
        assert.equal(after.env?.DISABLE_AUTO_COMPACT, "1");
        assert.equal(claudeNativeInstalled(), true);
        // #964: the resolved port is persisted so the SessionStart hook (which
        // does NOT inherit claude's settings.env) resolves the SAME port.
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { claude: { nativePort: CLAUDE_NATIVE_DEFAULT_PORT } });

        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("managed block removed"), removeNote);
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: unknown; hooks?: unknown };
        assert.equal(restored.env, undefined);
        assert.equal(restored.hooks, undefined);
        assert.equal(claudeNativeInstalled(), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), {}, "nativePort cleared on remove");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer preserves foreign settings.json keys end-to-end", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { THEME: "dark" } }, null, 2));
        pluginInstall("claude");
        assert.ok(fs.existsSync(`${box.settings}.bili-bak`), "pre-install snapshot of an existing settings file");
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(after.permissions, { allow: ["Bash"] });
        assert.equal(after.env?.THEME, "dark");
        pluginRemove("claude");
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(restored.permissions, { allow: ["Bash"] });
        assert.deepEqual(restored.env, { THEME: "dark" });
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer persists an env-driven port so the hook resolves the SAME port", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const prevPortEnv = process.env.BILI_CLAUDE_NATIVE_PORT;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        // Live failure shape: install with an explicit port, then claude
        // later runs the hook WITHOUT that env (claude does not inject its
        // settings.env into hook children) — the persisted config keeps
        // hook and settings.json on the same port.
        process.env.BILI_CLAUDE_NATIVE_PORT = "49999";
        pluginInstall("claude");
        const settings = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string> };
        assert.equal(settings.env?.ANTHROPIC_BASE_URL, baseUrlForPort(49999));
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { claude: { nativePort: 49999 } });
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        assert.equal(resolveClaudeNativePort(), 49999, "hook (no env) resolves the persisted port");
        assert.equal(planClaudeNativeBootstrap(process.env).port, 49999);
        pluginRemove("claude");
        assert.equal(resolveClaudeNativePort(), CLAUDE_NATIVE_DEFAULT_PORT, "remove restores the default");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
        if (prevPortEnv === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPortEnv;
    }
});

test("installer refuses under BILI_NATIVE_CLAUDE=0", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        process.env.BILI_NATIVE_CLAUDE = "0";
        assert.throws(() => pluginInstall("claude"), /refused/);
        assert.equal(fs.existsSync(box.settings), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer refuses malformed settings.json instead of overwriting", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, "{ not json");
        assert.throws(() => pluginInstall("claude"), /not valid JSON/);
        assert.equal(fs.readFileSync(box.settings, "utf8"), "{ not json", "file untouched");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

// — hook e2e (real dist script brings up a real proxy) ——————————————————

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        const done = (ok: boolean) => {
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });
}

async function waitForPort(port: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await canConnect(port)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

function runHook(distScript: string, port: number, xdg: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [distScript], {
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: xdg.home,
                XDG_CONFIG_HOME: xdg.config,
                XDG_STATE_HOME: xdg.state,
                XDG_CACHE_HOME: xdg.cache,
                XDG_DATA_HOME: xdg.data,
                BILI_CLAUDE_NATIVE_PORT: String(port),
                NO_COLOR: "1",
                // Hermetic tmp: the hook's spawned proxy logs to
                // <tmpdir>/bili-proxy-<port>.log — pin it to the test
                // process's tmpdir (same as the XDG sandbox above).
                TMPDIR: os.tmpdir(),
            },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (c: Buffer) => {
            stderr += c.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
    });
}

test("hook e2e: an occupied stable port fails loud — never port-hops", { timeout: 120_000 }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    assert.ok(fs.existsSync(distScript), `dist script missing — run npm run build (${distScript})`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    // A foreign listener squats the stable port (a relay, another test
    // stub, anything non-bili). Without strict-port the spawned proxy
    // would EADDRINUSE-hop to port+1 and "succeed" — stranding every
    // claude model call on the dead original port (found live on the
    // host of issue #964: two test listeners on 48787/48788).
    const squatter = net.createServer();
    squatter.listen(0, "127.0.0.1");
    await once(squatter, "listening");
    const port = (squatter.address() as net.AddressInfo).port;
    try {
        const r = await runHook(distScript, port, xdg);
        assert.equal(r.code, 0, "the hook never fails claude");
        assert.match(r.stderr, /bring-up failed/);
        assert.doesNotMatch(r.stderr, /started at/);
        await new Promise((r2) => setTimeout(r2, 500));
        assert.equal(await canConnect(port + 1), false, "no port-hop proxy on port+1");
    } finally {
        squatter.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("hook e2e: a healthy proxy on ANOTHER port is never attached (static URL)", { timeout: 120_000 }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const portA = await freePort();
    const portB = await freePort();
    const instFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let pidA = 0;
    let pidB = 0;
    try {
        // Bring up a healthy proxy on portA first — its instance file is
        // exactly what a probe would attach to (this mirrors the live host:
        // another bili proxy already running when claude's hook fires).
        const rA = await runHook(distScript, portA, xdg);
        assert.equal(rA.code, 0);
        assert.ok(await waitForPort(portA, 60_000), "proxy A up");
        pidA = (JSON.parse(fs.readFileSync(instFile, "utf8")) as { pid: number }).pid;

        // SAME state dir, DIFFERENT port: claude dials a STATIC url pinned to
        // portB — attaching to A's origin would strand every request. The
        // hook must spawn its own instance on portB instead.
        const rB = await runHook(distScript, portB, xdg);
        assert.equal(rB.code, 0);
        assert.match(rB.stderr, /started at/, "spawned — not attached to A");
        assert.ok(await waitForPort(portB, 60_000), "proxy B up on its own port");
        pidB = (JSON.parse(fs.readFileSync(instFile, "utf8")) as { pid: number }).pid;
        assert.notEqual(pidB, pidA, "separate instance, not an attach");
    } finally {
        if (pidA > 0) killPid(pidA);
        if (pidB > 0) killPid(pidB);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

function killPid(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch {}
}

// CI runs `npm test` BEFORE `npm run build` (ci.yml step order) — this test
// exercises the BUILT artifact (the hook command claude actually runs), so
// build on demand when dist/ is absent (tsup ~1s; dev checkouts usually
// already have dist/ from a prior build).
function ensureDistBuilt(distScript: string): void {
    if (!fs.existsSync(distScript)) {
        const root = path.resolve(import.meta.dirname, "..");
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], { cwd: root, stdio: "pipe", timeout: 300_000 });
    }
    assert.ok(fs.existsSync(distScript), `build did not produce ${distScript}`);
}

test("hook e2e: dist script spawns a proxy on the stable port, second run attaches", { timeout: 120_000 }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    const port = await freePort();
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let proxyPid = 0;
    try {
        const r1 = await runHook(distScript, port, xdg);
        assert.equal(r1.code, 0);
        assert.match(r1.stderr, /proxy started|proxy attached/);
        assert.ok(await waitForPort(port, 60_000), "proxy listening on the stable port");
        const inst = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number; origin: string };
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);
        assert.equal(typeof inst.pid, "number");
        proxyPid = inst.pid;

        // Second hook run (claude restart): the healthy proxy is shared.
        const r2 = await runHook(distScript, port, xdg);
        assert.equal(r2.code, 0);
        assert.match(r2.stderr, /attached/);
        const inst2 = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
        assert.equal(inst2.pid, proxyPid, "same proxy instance, no double spawn");
    } finally {
        if (proxyPid > 0) killPid(proxyPid);
        // Belt and braces: sweep any leftover listener the attach assertions
        // lost track of (spawned detached, watchdog = test-runner pid).
        if (await canConnect(port)) {
            try {
                const inst = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof inst.pid === "number") killPid(inst.pid);
            } catch {}
        }
        fs.rmSync(home, { recursive: true, force: true });
    }
});
