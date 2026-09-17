#!/usr/bin/env node
/** Refresh src/models-dev-snapshot.json from models.dev (https://models.dev/api.json).

The snapshot is the SLIM form of models.dev's provider table — only the
per-model output-token limit bili consumes for preflight summary caps (#853):
the summary call clamps its max_tokens to min(MAX_SUMMARY_OUTPUT_TOKENS, cap)
so the raised default (32k) cannot 400 on models whose real output ceiling is
lower. Entries with a cap at or above MAX_SUMMARY_OUTPUT_TOKENS (32768) are
dropped — they can never affect the clamp — which keeps ~7.6k upstream models
down to ~1k entries. Model ids are deduped across providers (gateways re-list
the same model); when providers disagree on a cap the MAXIMUM wins, because
understating a cap re-introduces the #853 starvation while overstating it only
risks the (unobserved, diagnosable) strict-400 case.

KEEP IN SYNC: the 32768 filter below mirrors MAX_SUMMARY_OUTPUT_TOKENS in
src/preflight.ts — if the default changes, update both and re-run
    npm run models-dev:snapshot

Run manually or before a release:
    npm run models-dev:snapshot

Node's global fetch ignores http(s)_proxy env vars, so the script tries the
configured shell proxy first (undici ProxyAgent) and falls back to a direct
connection. If BOTH fail the existing snapshot is left untouched (exit 1).
*/
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "models-dev-snapshot.json");
const FILTER_BELOW = 32768; // == MAX_SUMMARY_OUTPUT_TOKENS (src/preflight.ts) — keep in sync
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

async function attempt(dispatcher) {
    const res = await fetch(SOURCE_URL, {
        ...(dispatcher ? { dispatcher } : {}),
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchFull() {
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import("undici");
            const full = await attempt(new ProxyAgent({ uri: proxyUrl }));
            console.log(`fetched models.dev via proxy ${proxyUrl}`);
            return full;
        } catch (e) {
            console.log(`proxy attempt failed (${e.message}); trying direct`);
        }
    }
    const full = await attempt(undefined);
    console.log("fetched models.dev direct");
    return full;
}

let full;
try {
    full = await fetchFull();
} catch (e) {
    console.error(`could not fetch ${SOURCE_URL}: ${e.message}`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

if (!full || typeof full !== "object") {
    console.error("unexpected upstream shape: expected { provider: { models: { ... } } }");
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const limits = {};
let scanned = 0;
let dropped = 0;
for (const provider of Object.values(full)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, m] of Object.entries(models)) {
        const output = m?.limit?.output;
        if (typeof output !== "number" || output <= 0) continue;
        scanned += 1;
        if (output >= FILTER_BELOW) {
            dropped += 1;
            continue;
        }
        // gateway re-listing: keep the max so a low claim cannot starve a model
        const prev = limits[id];
        if (prev === undefined || output > prev) limits[id] = output;
    }
}
const count = Object.keys(limits).length;
if (count === 0) {
    console.error("no usable output limits found in upstream data");
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const body = JSON.stringify({
    source: "models.dev — https://models.dev/api.json (output limits below the preflight summary default; max on cross-provider id collisions)",
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    count,
    limits,
}) + "\n";
await writeFile(OUT_FILE, body, "utf8");
console.log(`wrote ${OUT_FILE} (${count} limits from ${scanned} upstream models, ${dropped} at/above ${FILTER_BELOW} dropped, ${(body.length / 1024).toFixed(1)} KB)`);
