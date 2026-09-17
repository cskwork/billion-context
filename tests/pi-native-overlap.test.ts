import test from "node:test";
import assert from "node:assert/strict";

// #840 seam audit (pi line): evaluate the REAL native entry under each
// `bili pi` launch environment variant — the launcher owns the proxy, so the
// global fetch patch (the only traffic-touching seam) must NOT be installed,
// no native host marker may be written, and the plugin export stays
// unconditional (tools remain available through launcher-mode detection).
// NODE_TEST_CONTEXT stays set so the bootstrap block cannot run regardless;
// query-suffixed imports force fresh module evaluations per variant.
process.env.NODE_TEST_CONTEXT = "1";

const INTERCEPT_FLAG = "__biliNativeFetchIntercept"; // must match native-intercept.ts
const origFetch = globalThis.fetch;

async function assertOverlapSeam(importSuffix: string): Promise<void> {
    const mod = await import(`../src/agent/pi-native.ts?seam=${importSuffix}`);
    assert.equal(typeof mod.default, "function", "plugin export stays unconditional");
    assert.equal((globalThis as Record<string, unknown>)[INTERCEPT_FLAG], undefined, "fetch patch not installed");
    assert.equal(globalThis.fetch, origFetch, "globalThis.fetch untouched");
    assert.notEqual(process.env.BILLION_CONTEXT_NATIVE, "pi", "no native host marker");
}

test("overlap (BILLION_CONTEXT_PROXY): fetch unpatched, no marker", async () => {
    delete process.env.BILI_PROVIDER_REWRITES;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9999";
    try {
        await assertOverlapSeam("proxy-env");
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
    }
});

test("overlap (BILI_PROVIDER_REWRITES): fetch unpatched, no marker", async () => {
    delete process.env.BILLION_CONTEXT_PROXY;
    process.env.BILI_PROVIDER_REWRITES = '{"qwen":"http://127.0.0.1:9999/bili/http://upstream.local/v1"}';
    try {
        await assertOverlapSeam("rewrites-env");
    } finally {
        delete process.env.BILI_PROVIDER_REWRITES;
    }
});
