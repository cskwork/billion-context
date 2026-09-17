import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { z } from "zod";

import {
    createV1ServerHooks,
    jsonSchemaToZodShape,
    rewriteV1Providers,
    type V1Config,
    type V1ProviderOptions,
} from "../src/agent/opencode-native.js";

// Minimal structural stand-in for the host's zod module: only the builders
// jsonSchemaToZodShape touches. Real zod (4.1.8) is exercised implicitly by
// the shape assertions below via the actual import.
const fakeZ = {
    any: () => ({ __fake: "any" }),
    string: () => ({ __fake: "string", describe: (d: string) => ({ __fake: "string", desc: d }) }),
    number: () => ({ __fake: "number" }),
    boolean: () => ({ __fake: "boolean" }),
    array: (item: unknown) => ({ __fake: "array", item }),
    enum: (values: [string, ...string[]]) => ({ __fake: "enum", values }),
} as unknown as typeof z;

describe("jsonSchemaToZodShape", () => {
    it("maps primitive, enum, array and unknown fields", () => {
        const shape = jsonSchemaToZodShape(
            {
                type: "object",
                properties: {
                    range: { type: "string", description: "refs" },
                    limit: { type: "number" },
                    force: { type: "boolean" },
                    mode: { type: "string", enum: ["auto", "manual"] },
                    keep: { type: "array", items: { type: "string" } },
                    nested: { type: "object", properties: { x: { type: "string" } } },
                    weird: { anyOf: [{ type: "string" }, { type: "number" }] },
                },
            },
            fakeZ,
        );
        assert.equal((shape.range as { __fake: string }).__fake, "string");
        assert.equal((shape.limit as { __fake: string }).__fake, "number");
        assert.equal((shape.force as { __fake: string }).__fake, "boolean");
        assert.deepEqual((shape.mode as { values: string[] }).values, ["auto", "manual"]);
        assert.equal((shape.keep as { item: { __fake: string } }).item.__fake, "string");
        assert.equal((shape.nested as { __fake: string }).__fake, "any");
        assert.equal((shape.weird as { __fake: string }).__fake, "any");
    });

    it("tolerates non-object schemas", () => {
        assert.deepEqual(jsonSchemaToZodShape(undefined, fakeZ), {});
        assert.deepEqual(jsonSchemaToZodShape({ type: "string" }, fakeZ), {});
        assert.deepEqual(jsonSchemaToZodShape({ properties: "nope" }, fakeZ), {});
    });

    it("produces fields the real host zod accepts in z.object()", async () => {
        // The v1 registry wraps our shape with the HOST's zod: simulate with
        // the real zod dependency (4.1.8) to prove cross-instance interop.
        const real = (await import("zod")) as typeof z;
        const shape = jsonSchemaToZodShape(
            { type: "object", properties: { range: { type: "string" }, limit: { type: "number" } } },
            real,
        );
        const parsed = real.object(shape).safeParse({ range: "m1-m5", limit: 3 });
        assert.equal(parsed.success, true);
        const bad = real.object(shape).safeParse({ range: 7, limit: 3 });
        assert.equal(bad.success, false);
    });
});

describe("rewriteV1Providers", () => {
    const origin = "http://127.0.0.1:19199";

    it("rewrites http(s) baseURLs and preserves provider entries", () => {
        const cfg: V1Config = {
            provider: {
                openai: { options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-x" } },
                local: { options: { baseURL: "http://127.0.0.1:8199/v1" } },
            },
        };
        const n = rewriteV1Providers(cfg, origin);
        assert.equal(n, 2);
        const openai = (cfg.provider?.openai?.options ?? {}) as V1ProviderOptions;
        const local = (cfg.provider?.local?.options ?? {}) as V1ProviderOptions;
        assert.equal(openai.baseURL, `${origin}/bili/https://api.openai.com/v1`);
        assert.equal(local.baseURL, `${origin}/bili/http://127.0.0.1:8199/v1`);
        // untouched sibling keys
        assert.equal(openai.apiKey, "sk-x");
    });

    it("is idempotent for already-wrapped URLs", () => {
        const cfg: V1Config = {
            provider: { wrapped: { options: { baseURL: `${origin}/bili/https://api.openai.com/v1` } } },
        };
        assert.equal(rewriteV1Providers(cfg, origin), 0);
        assert.equal(cfg.provider?.wrapped?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
    });

    it("skips non-http and missing baseURLs, handles absent provider table", () => {
        const cfg: V1Config = {
            provider: {
                weird: { options: { baseURL: "file:///nope" } },
                none: { options: {} },
                empty: { options: { baseURL: "   " } },
            },
        };
        assert.equal(rewriteV1Providers(cfg, origin), 0);
        assert.deepEqual(rewriteV1Providers({}, origin), 0);
        const broken: V1Config = { provider: "not-a-table" };
        assert.equal(rewriteV1Providers(broken, origin), 0);
    });

    it("unwraps double-wrapped upstreams instead of nesting", () => {
        const cfg: V1Config = {
            provider: { x: { options: { baseURL: `http://other:1/bili/https://api.anthropic.com` } } },
        };
        const n = rewriteV1Providers(cfg, origin);
        assert.equal(n, 1);
        assert.equal(cfg.provider?.x?.options?.baseURL, `${origin}/bili/https://api.anthropic.com`);
    });

    it("disables compaction.auto while merging existing settings", () => {
        const cfg: V1Config = {
            provider: { x: { options: { baseURL: "https://api.openai.com/v1" } } },
            compaction: { threshold: 0.8 },
        };
        rewriteV1Providers(cfg, origin);
        assert.deepEqual(cfg.compaction, { threshold: 0.8, auto: false });
    });
});

describe("createV1ServerHooks", () => {
    const origin = "http://127.0.0.1:19199";

    function makeDeps() {
        const forwarded: Array<{ conversationId: string; tool: string; args: unknown }> = [];
        return {
            z: fakeZ,
            forward: async (o: string, conversationId: string, tool: string, args: unknown) => {
                forwarded.push({ conversationId, tool, args });
                assert.equal(o, origin);
                return `panel:${tool}`;
            },
            forwarded,
        };
    }

    it("registers /acp command, rewrites providers, stamps headers and tools when zod present", async () => {
        const deps = makeDeps();
        const hooks = createV1ServerHooks(origin, {}, deps);
        assert.ok(hooks.config);
        assert.ok(hooks["chat.headers"]);
        assert.ok(hooks["command.execute.before"]);
        const names = Object.keys(hooks.tool ?? {});
        assert.ok(names.includes("compress"), `tools include compress, got ${names.join(",")}`);

        const cfg: V1Config = { provider: { o: { options: { baseURL: "https://api.openai.com/v1" } } } };
        await hooks.config?.(cfg);
        assert.equal(cfg.provider?.o?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
        assert.ok(cfg.command?.acp);

        const headers: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_1" }, { headers });
        assert.equal(headers["x-bili-plugin"], "opencode");
        assert.equal(headers["x-bili-plugin-conversation"], "ses_1");

        const compress = hooks.tool?.compress;
        assert.ok(compress);
        const out = await compress.execute({ range: "m1-m2" }, { sessionID: "ses_1" });
        assert.equal(out, "panel:compress");
        assert.deepEqual(deps.forwarded, [{ conversationId: "ses_1", tool: "compress", args: { range: "m1-m2" } }]);
    });

    it("degrades to proxy mode (no headers, no tools) when zod is unavailable", async () => {
        const hooks = createV1ServerHooks(origin, {}, {});
        assert.equal(hooks["chat.headers"], undefined);
        assert.equal(hooks.tool, undefined);
        assert.ok(hooks.config);
        const cfg: V1Config = { provider: { o: { options: { baseURL: "https://api.openai.com/v1" } } } };
        await hooks.config?.(cfg);
        assert.equal(cfg.provider?.o?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
    });

    it("command.execute.before only reacts to /acp", async () => {
        const deps = makeDeps();
        const hooks = createV1ServerHooks(origin, {}, deps);
        await hooks["command.execute.before"]?.({ command: "other", sessionID: "s" });
        // /acp path throws the sentinel after rendering — assert the sentinel shape
        await assert.rejects(
            hooks["command.execute.before"]?.({ command: "acp", sessionID: "ses_x" }),
            /__BILI_ACP_HANDLED__/,
        );
    });
});
