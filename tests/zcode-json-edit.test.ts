import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    applyZcodeRouting,
    detectZcodeStore,
    inspectZcodeRouting,
    resolveZcodeDataDir,
    stampZcodePluginHeader,
    unrouteZcodeText,
    zcodeStoreFile,
    ZCODE_BIGMODEL_ANTHROPIC_UPSTREAM,
} from "../src/zcode/json-edit.ts";

// #1145: the provider-store surgery is the user-facing safety surface — every
// store generation, every refusal path, and the wrap/stamp/unroute roundtrip
// get direct coverage. Pure functions only; no proxy involved.

const ORIGIN_A = "http://127.0.0.1:18787";
const ORIGIN_B = "http://127.0.0.1:28787";
const UPSTREAM = ZCODE_BIGMODEL_ANTHROPIC_UPSTREAM;

function dataDir(): string {
    return mkdtempSync(path.join(tmpdir(), "zcode-json-edit-"));
}

test("resolveZcodeDataDir honors ZCODE_DATA_BASE_DIR and falls back to ~/.zcode", () => {
    assert.equal(resolveZcodeDataDir({ ZCODE_DATA_BASE_DIR: "/data" }), "/data");
    assert.equal(path.basename(resolveZcodeDataDir({})), ".zcode");
});

test("zcodeStoreFile maps kinds to their v2 paths", () => {
    assert.equal(zcodeStoreFile("/d", "legacy"), path.join("/d", "v2", "config.json"));
    assert.equal(zcodeStoreFile("/d", "new"), path.join("/d", "v2", "provider_config.json"));
});

test("detectZcodeStore prefers a valid new store and falls back to legacy", () => {
    const dir = dataDir();
    try {
        mkdirSync(path.join(dir, "v2"), { recursive: true });
        const legacy = zcodeStoreFile(dir, "legacy");
        const fresh = zcodeStoreFile(dir, "new");

        assert.deepEqual(detectZcodeStore(dir), { kind: "legacy", file: legacy });

        writeFileSync(fresh, JSON.stringify({ schemaVersion: 2, config: {} }));
        assert.equal(detectZcodeStore(dir).kind, "legacy");

        writeFileSync(fresh, "{oops");
        assert.equal(detectZcodeStore(dir).kind, "legacy");

        writeFileSync(legacy, "{}\n");
        writeFileSync(fresh, JSON.stringify({ schemaVersion: 1, config: {} }) + "\n");
        assert.deepEqual(detectZcodeStore(dir), { kind: "new", file: fresh });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("applyZcodeRouting legacy wraps plan entries and preserves everything else", () => {
    const doc = {
        theme: "dark",
        provider: {
            "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM }, name: "bigmodel" },
            "custom:mine": { options: { baseURL: "https://example.com/v1" } },
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "legacy", ORIGIN_A);
    assert.equal(out.wrapped.length, 1);
    assert.deepEqual(out.wrapped[0], { id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM });
    const parsed = JSON.parse(out.text) as typeof doc;
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, `${ORIGIN_A}/bili/${UPSTREAM}`);
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].name, "bigmodel");
    assert.equal(parsed.provider["custom:mine"].options.baseURL, "https://example.com/v1");
    assert.equal(parsed.theme, "dark");
});

test("applyZcodeRouting legacy re-wraps across sessions with different ports", () => {
    const doc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } } } };
    const once = applyZcodeRouting(JSON.stringify(doc), "legacy", ORIGIN_A);
    const twice = applyZcodeRouting(once.text, "legacy", ORIGIN_B);
    assert.equal(twice.wrapped.length, 1);
    assert.equal(twice.wrapped[0].upstream, UPSTREAM);
    const parsed = JSON.parse(twice.text) as { provider: Record<string, { options: { baseURL: string } }> };
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, `${ORIGIN_B}/bili/${UPSTREAM}`);
});

test("applyZcodeRouting legacy keeps a user-custom upstream and defaults invalid ones", () => {
    const custom = applyZcodeRouting(
        JSON.stringify({ provider: { "builtin:zai-coding-plan": { options: { baseURL: "https://my.upstream.example/api" } } } }),
        "legacy",
        ORIGIN_A,
    );
    assert.equal(custom.wrapped[0].upstream, "https://my.upstream.example/api");

    const invalid = applyZcodeRouting(
        JSON.stringify({ provider: { "builtin:bigmodel": { options: { baseURL: "not-a-url" } } } }),
        "legacy",
        ORIGIN_A,
    );
    assert.equal(invalid.wrapped[0].upstream, UPSTREAM);
});

test("applyZcodeRouting legacy creates the canonical bigmodel set when nothing exists", () => {
    const out = applyZcodeRouting("{}", "legacy", ORIGIN_A);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["builtin:bigmodel-coding-plan", "builtin:bigmodel-start-plan"],
    );
    const parsed = JSON.parse(out.text) as { provider: Record<string, { options: { baseURL: string } }> };
    for (const id of ["builtin:bigmodel-coding-plan", "builtin:bigmodel-start-plan"]) {
        assert.equal(parsed.provider[id].options.baseURL, `${ORIGIN_A}/bili/${UPSTREAM}`);
    }
});

test("applyZcodeRouting new wraps account:* rules and leaves others alone", () => {
    const doc = {
        schemaVersion: 1,
        config: {
            providerConfigRules: {
                providerRules: [
                    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: UPSTREAM } } },
                    { providerId: "account:zai-team-coding-plan", config: { api: { type: "openai-chat-completions", baseUrl: "https://z.z.ai/api" } } },
                    { providerId: "custom:x", config: { api: { baseUrl: "https://example.com" } } },
                ],
            },
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "new", ORIGIN_A);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["account:bigmodel-individual-coding-plan", "account:zai-team-coding-plan"],
    );
    const parsed = JSON.parse(out.text) as typeof doc;
    const rules = parsed.config.providerConfigRules.providerRules as Array<{ providerId: string; config: { api: Record<string, unknown> } }>;
    assert.equal(rules[0].config.api.baseUrl, `${ORIGIN_A}/bili/${UPSTREAM}`);
    assert.equal(rules[1].config.api.type, "openai-chat-completions");
    assert.equal(rules[1].config.api.baseUrl, `${ORIGIN_A}/bili/https://z.z.ai/api`);
    assert.equal(rules[2].config.api.baseUrl, "https://example.com");
});

test("applyZcodeRouting new creates the canonical bigmodel rules when empty", () => {
    const out = applyZcodeRouting(JSON.stringify({ schemaVersion: 1, config: {} }), "new", ORIGIN_A);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["account:bigmodel-individual-coding-plan", "account:bigmodel-team-coding-plan", "account:bigmodel-start-plan"],
    );
});

test("applyZcodeRouting refuses malformed or wrong-shaped input loudly", () => {
    assert.throws(() => applyZcodeRouting("{oops", "legacy", ORIGIN_A), /not valid JSON/);
    assert.throws(() => applyZcodeRouting("[]", "legacy", ORIGIN_A), /must be a JSON object/);
    assert.throws(() => applyZcodeRouting(JSON.stringify({ schemaVersion: 1 }), "new", ORIGIN_A), /missing its config object/);
});

test("stampZcodePluginHeader stamps wrapped entries only and is byte-stable", () => {
    const doc = {
        provider: {
            "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}`, headers: { "x-foo": "bar" } } },
            "custom:mine": { options: { baseURL: "https://example.com/v1", headers: { "x-foo": "bar" } } },
        },
    };
    const text = JSON.stringify(doc);
    const stamped = stampZcodePluginHeader(text, "legacy");
    assert.notEqual(stamped, text);
    const parsed = JSON.parse(stamped) as typeof doc;
    assert.deepEqual(parsed.provider["builtin:bigmodel-coding-plan"].options.headers, { "x-foo": "bar", "x-bili-plugin": "zcode" });
    assert.deepEqual(parsed.provider["custom:mine"].options.headers, { "x-foo": "bar" });
    assert.equal(stampZcodePluginHeader(stamped, "legacy"), stamped);
    const unwrapped = JSON.stringify({ provider: { "custom:mine": { options: { baseURL: "https://example.com/v1" } } } });
    assert.equal(stampZcodePluginHeader(unwrapped, "legacy"), unwrapped);
});

test("unrouteZcodeText strips wrapper and header in place", () => {
    const doc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}`, headers: { "x-bili-plugin": "zcode", keep: "1" } } } } };
    const once = unrouteZcodeText(JSON.stringify(doc), "legacy");
    assert.equal(once.changed, true);
    const parsed = JSON.parse(once.text) as typeof doc;
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, UPSTREAM);
    assert.deepEqual(parsed.provider["builtin:bigmodel-coding-plan"].options.headers, { keep: "1" });
    const twice = unrouteZcodeText(once.text, "legacy");
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once.text);
});

test("inspectZcodeRouting reports the routed entries per store kind", () => {
    const dir = dataDir();
    try {
        mkdirSync(path.join(dir, "v2"), { recursive: true });

        assert.equal(inspectZcodeRouting(dir), undefined);

        const legacyDoc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}` } } } };
        writeFileSync(zcodeStoreFile(dir, "legacy"), JSON.stringify(legacyDoc));
        assert.deepEqual(inspectZcodeRouting(dir), {
            kind: "legacy",
            file: zcodeStoreFile(dir, "legacy"),
            wrapped: [{ id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM }],
        });

        const newDoc = {
            schemaVersion: 1,
            config: {
                providerConfigRules: {
                    providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: `${ORIGIN_B}/bili/${UPSTREAM}` } } }],
                },
            },
        };
        writeFileSync(zcodeStoreFile(dir, "new"), JSON.stringify(newDoc));
        const fresh = inspectZcodeRouting(dir);
        assert.equal(fresh?.kind, "new");
        assert.deepEqual(fresh?.wrapped, [{ id: "account:bigmodel-individual-coding-plan", upstream: UPSTREAM }]);
        assert.equal(readFileSync(zcodeStoreFile(dir, "new"), "utf8").includes("schemaVersion"), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
