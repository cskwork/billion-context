// #1085 e2e: sticky head-system anchor through the REAL proxy. When a client's
// head system text (ambient instructions such as AGENTS.md) changes mid-session,
// the proxy must keep forwarding the FIRST-seen head byte-stable (the provider
// prefix-cache anchor) and append one trailing user note carrying the full new
// text — instead of letting the changed head invalidate the whole cached prefix.
// Also covers the interop contract: a third-party client that already implements
// its own version (constant system + in-history update messages) must pass
// through with ZERO bili-side injection.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const MARKER = "[System context update]";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function responsesSse(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id: "resp_1", status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }));
    res.write(sseBlock("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" }));
    res.write(sseBlock("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } }));
    res.write(sseBlock("response.completed", { response: { id: "resp_1", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 10, output_tokens: 2 } } }));
    res.end();
}

type ChatMsg = { role: string; content?: unknown };

function leadingSystem(body: string): string {
    const sent = JSON.parse(body) as { messages: ChatMsg[] };
    const m = sent.messages.find((x) => x.role === "system" || x.role === "developer");
    return typeof m?.content === "string" ? m.content : "";
}

function markerMessages(body: string): string[] {
    const sent = JSON.parse(body) as { messages: ChatMsg[] };
    return sent.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter((c) => c.startsWith(MARKER));
}

test("e2e #1085: changed head system stays anchored; updates ride as trailing notes", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            if ((req.url ?? "").includes("/responses")) {
                responsesSse(res);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: `reply-${captured.length}` }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        stableSystemAnchor: true,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const chatUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const respUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    async function chatTurn(sessionId: string, model: string, body: Record<string, unknown>): Promise<string> {
        const res = await fetch(chatUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model, stream: false, ...body }),
        });
        if (!res.ok) throw new Error(`turn failed: HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
        return json.choices[0]?.message?.content ?? "";
    }

    try {
        // --- Session A: OpenAI wire, head system changes between turns ---
        const SYS_V1 = "AMBIENT-INSTRUCTIONS-V1 (agents.md snapshot at session start)";
        const SYS_V2 = "AMBIENT-INSTRUCTIONS-V2 (edited mid-session)";
        const histA: ChatMsg[] = [];
        let reply = await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V1 }, { role: "user", content: "hello 1" }] });
        histA.push({ role: "user", content: "hello 1" }, { role: "assistant", content: reply });
        reply = await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V2 }, ...histA, { role: "user", content: "hello 2" }] });
        histA.push({ role: "user", content: "hello 2" }, { role: "assistant", content: reply });
        await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V2 }, ...histA, { role: "user", content: "hello 3" }] });

        const [a1, a2, a3] = captured.slice(0, 3);
        assert.ok(a1 && a2 && a3, "expected 3 captured OpenAI requests");
        // Turn 1: head anchored, no notes yet.
        assert.ok(leadingSystem(a1!).includes(SYS_V1), "turn 1 head must carry the original system");
        assert.equal(markerMessages(a1!).length, 0, "turn 1 must carry no update notes");
        // Turn 2: head BYTE-STABLE (still V1, never V2), exactly one trailing note with the full V2 text.
        assert.equal(leadingSystem(a2!), leadingSystem(a1!), "head system must stay byte-identical after a detected change");
        assert.ok(!leadingSystem(a2!).includes(SYS_V2), "changed head text must NOT replace the anchor");
        const notes2 = markerMessages(a2!);
        assert.equal(notes2.length, 1, "exactly one update note after a single change");
        assert.ok(notes2[0]!.includes(SYS_V2), "note must carry the full replacement text");
        const sentA2 = JSON.parse(a2!) as { messages: ChatMsg[] };
        assert.equal(sentA2.messages[sentA2.messages.length - 1]?.role, "user", "note must trail the conversation");
        // Turn 3: unchanged head — no duplicated note.
        assert.equal(leadingSystem(a3!), leadingSystem(a1!), "head system must remain byte-identical on steady turns");
        assert.equal(markerMessages(a3!).length, 1, "steady turns must not duplicate the note");

        // --- Session B: interop — a third-party client already keeps its system
        // constant and records instruction changes as ordinary in-history user
        // messages (opencode-style). bili must add NOTHING of its own. ---
        const SYS_T = "THIRD-PARTY-CONSTANT-SYSTEM";
        const TP_UPDATE = "These instructions replace all previously loaded ambient instructions.\n\nNEW-RULES-FROM-CLIENT";
        const histB: ChatMsg[] = [];
        reply = await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, { role: "user", content: "b1" }] });
        histB.push({ role: "user", content: "b1" }, { role: "assistant", content: reply });
        reply = await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, ...histB, { role: "user", content: TP_UPDATE }, { role: "assistant", content: "understood" }, { role: "user", content: "b2" }] });
        histB.push({ role: "user", content: TP_UPDATE }, { role: "assistant", content: "understood" }, { role: "user", content: "b2" }, { role: "assistant", content: reply });
        await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, ...histB, { role: "user", content: "b3" }] });

        const [b1, b2, b3] = captured.slice(3, 6);
        assert.ok(b1 && b2 && b3, "expected 3 captured interop requests");
        for (const [i, body] of [b1!, b2!, b3!].entries()) {
            assert.equal(markerMessages(body).length, 0, `interop request ${i + 1}: bili must not inject its own update notes`);
            assert.equal(leadingSystem(body), leadingSystem(b1!), "interop head system must stay byte-identical across turns");
        }
        // Parse before substring checks: the raw body is JSON, where newlines
        // arrive as two-char \n escapes, not the real 0x0A in the constant.
        const b2Text = (JSON.parse(b2!) as { messages: ChatMsg[] }).messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("\n");
        assert.ok(b2Text.includes(TP_UPDATE), "third-party in-history update must pass through untouched");

        // --- Session C: Responses wire (codex-style instructions) ---
        const INST_V1 = "CODEX-INSTRUCTIONS-V1";
        const INST_V2 = "CODEX-INSTRUCTIONS-V2";
        const inputC: Array<Record<string, unknown>> = [];
        for (const [inst, userText] of [[INST_V1, "c1"], [INST_V2, "c2"], [INST_V2, "c3"]] as Array<[string, string]>) {
            const res = await fetch(respUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "responses-anchor-e2e" },
                body: JSON.stringify({ model: "gpt-test", stream: true, instructions: inst, input: [...inputC, { type: "message", role: "user", content: userText }] }),
            });
            if (!res.ok) throw new Error(`responses turn failed: HTTP ${res.status}`);
            await res.text();
            inputC.push({ type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: userText });
        }

        const [c1, c2, c3] = captured.slice(6, 9);
        assert.ok(c1 && c2 && c3, "expected 3 captured Responses requests");
        const devOf = (body: string): string => {
            const sent = JSON.parse(body) as { input: Array<{ role?: string; content?: unknown }> };
            const dev = sent.input.find((x) => x.role === "developer");
            return typeof dev?.content === "string" ? dev.content : JSON.stringify(dev?.content ?? "");
        };
        const markerItems = (body: string): string[] => {
            const sent = JSON.parse(body) as { input: Array<{ role?: string; content?: unknown }> };
            return sent.input
                .filter((x) => x.role === "user")
                .map((x) => (typeof x.content === "string" ? x.content : ""))
                .filter((c) => c.startsWith(MARKER));
        };
        assert.ok(devOf(c1!).includes(INST_V1), "responses turn 1 developer message must carry the original instructions");
        assert.equal(markerItems(c1!).length, 0, "responses turn 1 must carry no update notes");
        assert.equal(devOf(c2!), devOf(c1!), "responses developer message must stay byte-identical after a change");
        assert.ok(!devOf(c2!).includes(INST_V2), "changed instructions must NOT replace the anchor");
        const cnotes = markerItems(c2!);
        assert.equal(cnotes.length, 1, "exactly one responses update note after a single change");
        assert.ok(cnotes[0]!.includes(INST_V2), "responses note must carry the full replacement text");
        assert.equal(devOf(c3!), devOf(c1!), "responses developer message must remain byte-identical on steady turns");
        assert.equal(markerItems(c3!).length, 1, "steady responses turns must not duplicate the note");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
