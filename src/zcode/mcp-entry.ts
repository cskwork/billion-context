// zcode native MCP entry (#1145): spawned per-session by ZCode (mcp.servers.
// bili). Bootstraps a bili proxy, routes the provider store through it,
// verifies the ACP tool manifest BEFORE stamping the plugin-mode header
// (round 1 rides wire mode), then serves the ACP tools over stdio with a
// watchdog that respawns the proxy or reverts routing on its death.

import { runMcpStdio } from "../mcp.js";
import { fetchManifest } from "../agent/shared.js";
import { nativeProxyScriptPath } from "../agent/native-bootstrap.js";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning } from "../launcher.js";
import {
    activateZcodePluginMode,
    bootstrapZcodeNative,
    defaultLog,
    probeProxyHealth,
    routeZcodeConfig,
    unrouteZcode,
    type ZcodeRouteApplied,
} from "./native.js";

const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_FAILURE_LIMIT = 3;

function startWatchdog(applied: ZcodeRouteApplied, attached: boolean, log: (msg: string) => void): void {
    const state = { origin: applied.origin, applied };
    let failures = 0;
    let busy = false;
    const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void watchdogTick().catch((err) => log(`watchdog error: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { busy = false; });

        async function watchdogTick(): Promise<void> {
            if (await probeProxyHealth(state.origin)) { failures = 0; return; }
            failures += 1;
            if (failures < WATCHDOG_FAILURE_LIMIT) return;
            if (attached) {
                log(`attached proxy ${state.origin} unhealthy — waiting for it to recover`);
                return;
            }
            const handle = await ensureProxyRunning(
                { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false },
                { scriptPath: nativeProxyScriptPath() },
            );
            if (handle.origin !== state.origin) {
                process.env.BILI_MCP_PROXY = handle.origin;
                const routed = await routeZcodeConfig({ origin: handle.origin, log });
                if (!routed) throw new Error("proxy respawned but the zcode config rewrite failed");
                await activateZcodePluginMode(routed, { log });
                state.origin = handle.origin;
                state.applied = routed;
                log(`proxy respawned at ${handle.origin} — config re-routed`);
            }
            failures = 0;
        }
    }, WATCHDOG_INTERVAL_MS);
    timer.unref?.();
}

export async function main(): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    const log = defaultLog;
    let bootstrap;
    try {
        bootstrap = await bootstrapZcodeNative({ log });
    } catch (err) {
        log(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!bootstrap || bootstrap.mode === "off") {
        unrouteZcode({ log });
        process.exit(0);
    }
    const applied = bootstrap.routed;
    if (!applied) {
        process.exit(0);
    }
    process.env.BILI_MCP_PROXY = applied.origin;
    try {
        const tools = await fetchManifest(applied.origin, "anthropic");
        if (tools.length === 0) throw new Error("manifest returned no tools");
    } catch (err) {
        log(`ACP manifest unavailable — leaving plugin mode off: ${err instanceof Error ? err.message : String(err)}`);
        unrouteZcode({ log });
        process.exit(0);
    }
    await activateZcodePluginMode(applied, { log });
    startWatchdog(applied, bootstrap.attached, log);
    runMcpStdio();
}

if (process.argv[1] && /(?:^|[\\/])mcp-entry\.(?:ts|js)$/.test(process.argv[1])) {
    main().catch((err) => {
        process.stderr.write(`[bili-zcode] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
