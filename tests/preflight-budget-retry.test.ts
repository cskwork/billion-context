import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

const GOOD_SUMMARY = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated filler output is disposable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
});

function fixture(url: string) {
    const logs: string[] = [];
    const session = getSession(`budget-${randomUUID()}`);
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const deps: PreflightDeps = {
        core: createCore(), session,
        config: defaultConfig(6000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
        prompts: defaultPrompts, protocol: "openai", url,
        headers: {}, model: "test-model",
        log: (_level, message) => { logs.push(message); },
    };
    return { deps, messages, logs, session };
}

async function withUpstream(handler: (res: http.ServerResponse, attempt: number) => void,
    run: (url: string, attempts: () => number, bodies: () => Array<Record<string, unknown>>) => Promise<void>) {
    let count = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => { data += c; });
        req.on("end", () => {
            count++;
            try { bodies.push(JSON.parse(data)); } catch { bodies.push({}); }
            handler(res, count);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/chat/completions`, () => count, () => bodies);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
}

// #853: a thinking-on-by-default model can spend its whole summary output budget
// on chain-of-thought and return content:"" + finish_reason:"length". Chunk-splitting
// cannot recover these (the thinking overhead is per-call), so preflight must retry
// ONCE with a doubled max_tokens and succeed when the larger budget yields a summary.
test("#853 preflight retries once with a raised budget when thinking exhausts the output budget", async () => {
    await withUpstream((res, attempt) => {
        res.writeHead(200, { "content-type": "application/json" });
        if (attempt === 1) {
            res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "the model reasoned here before running out of its output budget" } }] }));
        } else {
            res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: GOOD_SUMMARY } }] }));
        }
    }, async (url, attempts, bodies) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(result.fitsWindow, true, result.failure?.detail);
        assert.equal(result.compressedRanges, 1, result.failure?.detail);
        assert.equal(attempts(), 2, "one original call plus exactly one budget retry");
        assert.ok(JSON.stringify(f.session.state.blocks).includes(GOOD_SUMMARY), "the retried summary is applied");
        assert.equal(bodies()[0].max_tokens, 8192, "first attempt uses the normal cap");
        assert.equal(bodies()[1].max_tokens, 16384, "retry escalates to the doubled cap");
        assert.match(f.logs.join("\n"), /budget-insufficient retry \(#853\)/);
    });
});

// #853: if the doubled budget STILL comes back reasoning-exhausted, preflight must
// not loop — it gives up after exactly two calls and reports the exhaustion cause.
test("#853 preflight stops after one budget retry when the raised budget still exhausts", async () => {
    await withUpstream((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "still only reasoning, no answer" } }] }));
    }, async (url, attempts, bodies) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(result.fitsWindow, false);
        assert.equal(attempts(), 2, "exactly one escalation, then give up — no unbounded retry");
        assert.equal(f.session.state.blocks.length, 0, "no partial/exhausted summary is applied");
        assert.equal(bodies()[1].max_tokens, 16384, "the single retry did escalate");
        assert.match(f.logs.join("\n"), /budget-insufficient retry \(#853\)/);
        assert.match(f.logs.join("\n"), /spent its output budget on reasoning\/thinking/);
    });
});
