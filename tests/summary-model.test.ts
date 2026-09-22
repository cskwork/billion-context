import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";

process.env.NODE_ENV = "test";

import { assignRefs, createCore, createInitialState, defaultConfig, defaultPrompts, emptyRefMap, type CoreMessage } from "acp-kernel";
import { effectiveDelegateSummary, effectiveSummaryModel, mergeCompress } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";
import { delegatedCompressTools, fillDelegatedSummaries, withDelegatedSummaryNote } from "../src/delegate-summary.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES } from "../src/compress-tool.ts";
import { extractSummaryFlags, parseArgs } from "../src/cli.ts";
import { ensureProxyRunning, type SpawnFn, type SpawnChild } from "../src/launcher.ts";
import { launcherSummaryConfig, type ProxyInstanceFile } from "../src/instance.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated fixture output is disposable.";

afterEach(() => {
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

// ---- settings: merge + validation + env precedence -------------------------

test("summaryModel/delegateSummary merge deepest-wins across global → provider → model", () => {
    const merged = mergeCompress({ summaryModel: "g-mini", delegateSummary: false }, { summaryModel: "p-mini" }, { delegateSummary: true });
    assert.equal(merged.summaryModel, "p-mini");
    assert.equal(merged.delegateSummary, true);
    const unset = mergeCompress({}, undefined, undefined);
    assert.equal(unset.summaryModel, undefined);
    assert.equal(unset.delegateSummary, undefined);
});

test("parseCompressSettings validates summaryModel (non-empty string) and delegateSummary (boolean)", () => {
    assert.deepEqual(parseCompressSettings({ summaryModel: "  mini  ", delegateSummary: true }), { summaryModel: "mini", delegateSummary: true });
    assert.equal(parseCompressSettings({ summaryModel: "" }), undefined, "blank model rejects the block");
    assert.equal(parseCompressSettings({ summaryModel: 42 }), undefined, "non-string model rejects the block");
    assert.equal(parseCompressSettings({ delegateSummary: "yes" }), undefined, "non-boolean switch rejects the block");
});

test("effectiveSummaryModel: env BILI_COMPACT_MODEL wins over every config level", () => {
    assert.equal(effectiveSummaryModel({}, {}), undefined);
    assert.equal(effectiveSummaryModel({ summaryModel: "cfg" }, {}), "cfg");
    assert.equal(effectiveSummaryModel({ summaryModel: "cfg" }, { BILI_COMPACT_MODEL: " env " }), "env");
    assert.equal(effectiveSummaryModel({ summaryModel: "cfg" }, { BILI_COMPACT_MODEL: "  " }), "cfg", "blank env is unset");
});

test("effectiveDelegateSummary: requires a summary model; env 1/0 wins over config", () => {
    assert.equal(effectiveDelegateSummary({ delegateSummary: true }, {}), false, "no summary model → ignored");
    assert.equal(effectiveDelegateSummary({ delegateSummary: true, summaryModel: "m" }, {}), true);
    assert.equal(effectiveDelegateSummary({ delegateSummary: true, summaryModel: "m" }, { BILI_DELEGATE_SUMMARY: "0" }), false);
    assert.equal(effectiveDelegateSummary({}, { BILI_DELEGATE_SUMMARY: "1", BILI_COMPACT_MODEL: "m" }), true);
});

// ---- preflight: summary payload model + 4xx fallback ------------------------

type SummaryServer = { url: string; bodies: Record<string, unknown>[]; close: () => Promise<void> };

async function summaryServer(reject: (model: unknown) => boolean): Promise<SummaryServer> {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            bodies.push(body);
            if (reject(body.model)) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `model ${String(body.model)} does not exist` } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        bodies,
        close: async () => {
            server.close();
            await once(server, "close");
        },
    };
}

function overflowMessages(): CoreMessage[] {
    return [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(60000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
}

function preflightDeps(url: string, summaryModel: string | undefined, logs: string[]): PreflightDeps {
    return {
        core: createCore(),
        session: getSession(`summary-model-${randomUUID()}`),
        config: defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
        prompts: defaultPrompts,
        protocol: "openai",
        url,
        headers: {},
        model: "main-model",
        ...(summaryModel ? { summaryModel } : {}),
        log: (level, msg) => logs.push(`${level} ${msg}`),
    };
}

test("preflight: unset summaryModel → summary calls use the request model", async () => {
    const srv = await summaryServer(() => false);
    const logs: string[] = [];
    try {
        const result = await preflightCompress(preflightDeps(srv.url, undefined, logs), overflowMessages());
        assert.ok(result.compressedRanges > 0);
        assert.ok(srv.bodies.length >= 1);
        for (const b of srv.bodies) assert.equal(b.model, "main-model");
        assert.ok(!logs.some((l) => l.includes("[summary-model]")), "no summary-model log when unset");
    } finally {
        await srv.close();
    }
});

test("preflight: summaryModel set → summary payload carries the override model, logged once", async () => {
    const srv = await summaryServer(() => false);
    const logs: string[] = [];
    try {
        const result = await preflightCompress(preflightDeps(srv.url, "summary-mini", logs), overflowMessages());
        assert.ok(result.compressedRanges > 0);
        assert.ok(srv.bodies.length >= 1);
        for (const b of srv.bodies) assert.equal(b.model, "summary-mini");
        assert.equal(logs.filter((l) => l.includes("summaries use model=summary-mini")).length, 1);
    } finally {
        await srv.close();
    }
});

test("preflight: override model rejected with 404 → falls back to the request model and still compresses", async () => {
    const srv = await summaryServer((model) => model === "missing-mini");
    const logs: string[] = [];
    try {
        const result = await preflightCompress(preflightDeps(srv.url, "missing-mini", logs), overflowMessages());
        assert.ok(result.compressedRanges > 0, "the turn is not broken by the bad override");
        assert.equal(result.failure, undefined);
        assert.equal(srv.bodies[0]?.model, "missing-mini", "override tried first");
        assert.equal(srv.bodies[1]?.model, "main-model", "fallback to the request model");
        assert.equal(srv.bodies.filter((b) => b.model === "missing-mini").length, 1, "rejected override is not retried for later calls");
        assert.ok(logs.some((l) => l.startsWith("warn") && l.includes("missing-mini rejected") && l.includes("HTTP 404")));
    } finally {
        await srv.close();
    }
});

// ---- delegated summaries ----------------------------------------------------

test("delegatedCompressTools rewrites compress in every wire shape, summary no longer required", () => {
    for (const tools of [BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES] as unknown[][]) {
        assert.deepEqual(delegatedCompressTools(tools, false), tools, "off → untouched");
        const out = delegatedCompressTools(tools, true) as Record<string, unknown>[];
        assert.equal(out.length, tools.length);
        const compress = out.find((t) => (t.name ?? (t.function as { name?: string } | undefined)?.name) === "compress")!;
        const fn = compress.function as Record<string, unknown> | undefined;
        const schema = (fn?.parameters ?? compress.input_schema ?? compress.parameters) as { properties: { content: { items: { anyOf: { required?: string[] }[] } } } };
        const objectForm = schema.properties.content.items.anyOf.find((v) => Array.isArray(v.required))!;
        assert.deepEqual(objectForm.required, ["startId", "endId"]);
        assert.match(String(fn?.description ?? compress.description), /do NOT write summaries/);
        const others = out.filter((t) => t !== compress);
        assert.deepEqual(others, tools.filter((t) => ((t as { name?: string }).name ?? (t as { function?: { name?: string } }).function?.name) !== "compress"));
    }
    assert.equal(withDelegatedSummaryNote("base", false), "base");
    assert.match(withDelegatedSummaryNote("base", true), /^base\n\n\[Delegated summaries:/);
});

function bigSession(): { session: Session; messages: CoreMessage[] } {
    const messages: CoreMessage[] = [
        { id: "a", role: "user", contentType: "text", text: "Start: " + "alpha ".repeat(1200) },
        { id: "b", role: "assistant", contentType: "text", text: "Reply: " + "beta ".repeat(1200) },
        { id: "c", role: "user", contentType: "text", text: "Next question." },
    ];
    const session: Session = {
        id: `delegate-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return { session, messages };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function compressCall(args: unknown): string {
    const a = JSON.stringify(args);
    return [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: "fc_c", delta: a }),
        sse("response.output_item.done", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: a }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
}

// Global fetch serves both legs: the summary call (non-stream, no tools) and
// the loop's post-tool re-request (stream).
function patchFetch(summary: (body: Record<string, unknown>) => Response): { summaryBodies: Record<string, unknown>[]; restore: () => void } {
    const summaryBodies: Record<string, unknown>[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.stream === false && body.tools === undefined) {
            summaryBodies.push(body);
            return summary(body);
        }
        return new Response(sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [] } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { summaryBodies, restore: () => { globalThis.fetch = orig; } };
}

async function runDelegatedLoop(args: unknown, fetchSummary: (body: Record<string, unknown>) => Response): Promise<{ out: string; session: Session; summaryBodies: Record<string, unknown>[] }> {
    const { session, messages } = bigSession();
    const core = createCore();
    const config = defaultConfig(200_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const probe = patchFetch(fetchSummary);
    const chunks: Buffer[] = [];
    try {
        const loop = runCompressLoop(
            new Response(compressCall(args), { status: 200 }).body!,
            {
                core, config, messages, session, log: () => {}, protocol: "responses",
                fillCompressSummaries: (a) => fillDelegatedSummaries(a, messages, {
                    core, session, config, prompts: defaultPrompts, protocol: "responses",
                    url: "http://mock/v1/responses", headers: {}, model: "main-model", summaryModel: "summary-mini", log: () => {},
                }),
            },
            { model: "main-model", input: [], stream: true },
            { url: "http://mock/v1/responses", headers: {} },
            createResponsesAdapter(),
            buildCompressSystemPrompt(),
        );
        for await (const c of loop) chunks.push(c);
    } finally {
        probe.restore();
    }
    return { out: Buffer.concat(chunks).toString("utf8"), session, summaryBodies: probe.summaryBodies };
}

const okResponsesSummary = (): Response => new Response(JSON.stringify({ output_text: SUMMARY }), { status: 200, headers: { "content-type": "application/json" } });

test("delegated compress: ranges without summaries are filled by the summary model and folded", async () => {
    const { session, summaryBodies } = await runDelegatedLoop({ content: [{ startId: "m00001", endId: "m00002", topic: "setup" }] }, okResponsesSummary);
    assert.equal(summaryBodies.length, 1);
    assert.equal(summaryBodies[0]!.model, "summary-mini");
    assert.match(String(summaryBodies[0]!.instructions), /delegated the summary to you/);
    const blocks = session.state.blocks.filter((b) => b.active);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.summary, SUMMARY);
});

test("delegated compress: bare one-line header string is filled too", async () => {
    const { session, summaryBodies } = await runDelegatedLoop({ content: ["m00001–m00002 setup"] }, okResponsesSummary);
    assert.equal(summaryBodies.length, 1);
    assert.equal(session.state.blocks.filter((b) => b.active)[0]?.summary, SUMMARY);
});

test("delegated compress: a model-provided summary is kept (no summary call)", async () => {
    const own = "OWN SUMMARY written by the main model, long enough to pass the kernel minimum summary length check.";
    const { session, summaryBodies } = await runDelegatedLoop({ content: [{ startId: "m00001", endId: "m00002", summary: own }] }, okResponsesSummary);
    assert.equal(summaryBodies.length, 0);
    assert.equal(session.state.blocks.filter((b) => b.active)[0]?.summary, own);
});

test("delegated compress: summary call failure → Compression FAILED tool result, nothing folded", async () => {
    const { out, session, summaryBodies } = await runDelegatedLoop(
        { content: [{ startId: "m00001", endId: "m00002" }] },
        () => new Response(JSON.stringify({ output_text: "" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    assert.ok(summaryBodies.length >= 1);
    assert.equal(session.state.blocks.length, 0, "no block created");
    assert.match(out, /FAILED/);
});

// ---- delegated mode wiring through the proxy (proxy vs plugin mode) --------

test("proxy: delegateSummary rewrites the injected compress tool + system prompt for streaming requests only", async () => {
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            forwarded.push(body);
            if (body.stream === true) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(
                    sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 10 } } }) +
                    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
                    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
                    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
                    sse("message_stop", { type: "message_stop" }),
                );
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, summaryModel: "summary-mini", delegateSummary: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const send = async (stream: boolean): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": `delegate-wire-${stream}` },
            body: JSON.stringify({ model: "main-model", max_tokens: 1024, stream, messages: [{ role: "user", content: "hello" }] }),
        });
        await r.text();
    };
    const compressOf = (body: Record<string, unknown>): { description: string; input_schema: { properties: { content: { items: { anyOf: { required?: string[] }[] } } } } } =>
        (body.tools as { name: string }[]).find((t) => t.name === "compress") as never;
    try {
        await send(true);
        await send(false);
        const streamedBody = forwarded.find((b) => b.stream === true)!;
        const plainBody = forwarded.find((b) => b.stream !== true)!;
        assert.equal(forwarded.length, 2);
        const streamed = compressOf(streamedBody);
        assert.match(streamed.description, /do NOT write summaries/);
        assert.deepEqual(streamed.input_schema.properties.content.items.anyOf.find((v) => v.required)?.required, ["startId", "endId"]);
        assert.match(JSON.stringify(streamedBody.system), /Delegated summaries/);
        const plain = compressOf(plainBody);
        assert.doesNotMatch(plain.description, /do NOT write summaries/, "non-streaming keeps the model-written contract");
        assert.doesNotMatch(JSON.stringify(plainBody.system), /Delegated summaries/);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

// ---- launcher flags ---------------------------------------------------------

test("parseArgs: --compact-model / --delegate-summary before the client set the env overrides", () => {
    const r = parseArgs(["--compact-model", "mini", "--delegate-summary", "claude"]);
    assert.equal(r.client, "claude");
    assert.equal(r.overrides.BILI_COMPACT_MODEL, "mini");
    assert.equal(r.overrides.BILI_DELEGATE_SUMMARY, "1");
    assert.deepEqual(r.clientArgs, []);
    assert.equal(parseArgs(["--compact-model=mini2", "codex"]).overrides.BILI_COMPACT_MODEL, "mini2");
});

test("parseArgs: summary flags after the client are consumed and stripped from client args", () => {
    const r = parseArgs(["claude", "--compact-model", "mini", "-p", "hi", "--delegate-summary"]);
    assert.equal(r.overrides.BILI_COMPACT_MODEL, "mini");
    assert.equal(r.overrides.BILI_DELEGATE_SUMMARY, "1");
    assert.deepEqual(r.clientArgs, ["-p", "hi"]);
    const c = parseArgs(["codex", "--compact-model=gpt-mini", "exec", "task"]);
    assert.equal(c.overrides.BILI_COMPACT_MODEL, "gpt-mini");
    assert.deepEqual(c.clientArgs, ["exec", "task"]);
});

test("parseArgs: summary flags after an explicit -- are forwarded to the client verbatim", () => {
    const lead = parseArgs(["claude", "--", "--compact-model", "x"]);
    assert.equal(lead.overrides.BILI_COMPACT_MODEL, undefined);
    assert.deepEqual(lead.clientArgs, ["--compact-model", "x"]);
    const overrides: Record<string, string | undefined> = {};
    assert.deepEqual(extractSummaryFlags(["-p", "--", "--delegate-summary"], overrides), ["-p", "--", "--delegate-summary"]);
    assert.equal(overrides.BILI_DELEGATE_SUMMARY, undefined);
});

function fakeChild(pid: number): SpawnChild {
    return { pid, unref() {}, kill() { return true; }, on() {} };
}

function instance(over: Partial<ProxyInstanceFile> = {}): ProxyInstanceFile {
    return { origin: "http://127.0.0.1:8787", instanceId: "inst-1", pid: process.pid, startedAt: Date.now(), host: "127.0.0.1", port: 8787, passthrough: false, mitmDomains: [], modelWindows: {}, ...over };
}

test("ensureProxyRunning: summary config reaches the spawned proxy env and gates attach", async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (_cmd, _args, opts) => {
        envs.push((opts as { env?: NodeJS.ProcessEnv } | undefined)?.env);
        return fakeChild(0);
    };
    let reads = 0;
    const spawned = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, ...launcherSummaryConfig({ BILI_COMPACT_MODEL: "mini", BILI_DELEGATE_SUMMARY: "1" }) },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
            readInstanceFile: () => (reads++ === 0 ? instance() : undefined),
            sleep: () => Promise.resolve(),
        },
    );
    assert.equal(spawned.attached, undefined, "a proxy without the summary config is not attached");
    assert.equal(envs[0]?.BILI_COMPACT_MODEL, "mini");
    assert.equal(envs[0]?.BILI_DELEGATE_SUMMARY, "1");

    const attached = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, compactModel: "mini" },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
            readInstanceFile: () => instance({ compactModel: "mini" }),
        },
    );
    assert.equal(attached.attached, true, "same summary config → shared proxy");
});
