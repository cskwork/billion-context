// Thin opencode plugin for the billion-context proxy (`bili opencode`).
//
// Activates ONLY when BILLION_CONTEXT_PROXY is set (the launcher sets it);
// otherwise it is a no-op so shipping it inside the package is harmless.
// Mirrors the pi/omp plugin (src/agent/pi.ts):
//   - registers the /acp command (config hook + command.execute.before)
//   - binds the opencode session id to the proxy session via the
//     pending-register queue (POST /__bili/plugin/register on session.created)
//   - renders the proxy's buildStatusPanel via an ignored chat message
//
// OpenCode 2.x (V2 plugin API) loads `{ id, setup }` instead of `.server()` —
// setup comes from the shared factory src/agent/opencode-v2.ts, which the
// native npm entry (opencode-native.ts) reuses so both deployment modes share
// one protocol implementation. The V2 runtime-API facts live in that file.
//
// The /acp command hooks themselves live in src/agent/opencode-acp-command.ts
// and are shared with the native V1 entry (opencode-native.ts).

import { createAcpCommandHooks } from "./opencode-acp-command.js";
import { createOpencodeV2Setup } from "./opencode-v2.js";

export { showAcpText } from "./opencode-acp-command.js";
export type {
    OpencodeCommandConfig,
    OpencodeConfig,
    OpencodePromptPart,
    OpencodeClient,
    OpencodeCommandInput,
    OpencodeAcpHooks,
} from "./opencode-acp-command.js";

interface OpencodeSessionInfo {
    id?: unknown;
}

interface OpencodeEvent {
    type?: string;
    properties?: { info?: OpencodeSessionInfo; [key: string]: unknown };
}

interface OpencodeEventInput {
    event?: OpencodeEvent;
}

interface OpencodePluginContext {
    client?: import("./opencode-acp-command.js").OpencodeClient;
}

interface OpencodeHooks {
    config?: (input: import("./opencode-acp-command.js").OpencodeConfig) => Promise<void>;
    event?: (input: OpencodeEventInput) => Promise<void>;
    "command.execute.before"?: (input: import("./opencode-acp-command.js").OpencodeCommandInput, output: { parts: unknown[] }) => Promise<void>;
}

const proxyBase = process.env.BILLION_CONTEXT_PROXY ?? "";

const server = async (ctx: OpencodePluginContext): Promise<OpencodeHooks> => {
    if (!proxyBase) return {};
    console.log("[bili-opencode] plugin active (proxy " + proxyBase + ")");
    return {
        ...createAcpCommandHooks(() => proxyBase, ctx),
    };
};

const setup = createOpencodeV2Setup();

export default { id: "billion-context-opencode", setup, server };
