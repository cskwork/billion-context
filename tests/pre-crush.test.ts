import test from "node:test";
import assert from "node:assert/strict";
import {
    createCore,
    createInitialState,
    defaultConfig,
    DEFAULT_ABSORB_CONFIG,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import {
    applyPreCrush,
    crushCode,
    crushJson,
    crushLog,
    resolvePreCrush,
    tryCrush,
    PRE_CRUSH_DEFAULT_MIN_REDUCTION,
    type PreCrushAwareConfig,
} from "../src/pre-crush.ts";
import { applyAbsorbView } from "../src/absorb.ts";
import { mergeCompress, applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";

const tok = (t: string): number => Math.ceil(t.length / 4);

interface RowEnv {
    __pre_crush: "rows";
    rows: number;
    const: Record<string, unknown>;
    items?: Record<string, unknown>[];
}

type AnyEnv = RowEnv | { __pre_crush: "identical-run"; count: number; item: unknown } | unknown[] | Record<string, unknown>;

function decodeValue(v: unknown): unknown {
    if (Array.isArray(v)) {
        const outArr: unknown[] = [];
        for (const e of v) {
            if (e !== null && typeof e === "object" && (e as Record<string, unknown>).__pre_crush === "identical-run") {
                const m = e as { count: number; item: unknown };
                for (let i = 0; i < m.count; i++) outArr.push(decodeValue(m.item));
            } else outArr.push(decodeValue(e));
        }
        return outArr;
    }
    if (v !== null && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.__pre_crush === "identical-run") {
            const m = o as { count: number; item: unknown };
            return Array.from({ length: m.count }, () => decodeValue(m.item));
        }
        if (o.__pre_crush === "rows") {
            const r = o as RowEnv;
            const items = r.items ?? [];
            return Array.from({ length: r.rows }, (_, i) => ({ ...(r.const as Record<string, unknown>), ...(items[i] as Record<string, unknown>) }));
        }
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(o)) out[k] = decodeValue(val);
        return out;
    }
    return v;
}

test("crushJson: constant-field hoist is lossless (rows envelope)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 7, ts: "2026-09-21T12:00:00Z", level: "INFO", name: `svc-${i}` }));
    const src = JSON.stringify(rows);
    const out = crushJson(src);
    assert.ok(out, "must crush");
    assert.ok(out!.length < src.length);
    const env = JSON.parse(out!) as RowEnv;
    assert.equal(env.__pre_crush, "rows");
    assert.equal(env.rows, 8);
    assert.equal(env.const.ts, "2026-09-21T12:00:00Z");
    assert.equal(env.const.level, "INFO");
    assert.equal((env.const as Record<string, unknown>).id, undefined, "varying field must not be hoisted");
    assert.deepEqual(decodeValue(JSON.parse(out!)), rows, "decode must reconstruct the original array");
});

test("crushJson: identical-run fold is lossless", () => {
    const arr = [...Array(5).fill({ e: "boom", code: 500 }), { e: "ok", code: 200 }, { e: "ok", code: 200 }, { e: "warn", code: 300 }, { e: "warn", code: 300 }];
    const src = JSON.stringify(arr);
    const out = crushJson(src);
    assert.ok(out, "must crush");
    assert.ok(out!.length < src.length);
    assert.deepEqual(decodeValue(JSON.parse(out!)), arr, "run expansion must reconstruct the original array");
});

test("crushJson: fully identical array collapses and decodes back", () => {
    const arr = Array.from({ length: 6 }, () => ({ status: "healthy", region: "us-east-1" }));
    const src = JSON.stringify(arr);
    const out = crushJson(src);
    assert.ok(out, "must crush");
    assert.ok(out!.length < src.length / 2);
    assert.deepEqual(decodeValue(JSON.parse(out!)), arr);
});

test("crushJson: deterministic (byte-identical across calls)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, host: `h${i}`, zone: "z1" }));
    const src = JSON.stringify(rows);
    assert.equal(crushJson(src), crushJson(src));
});

test("crushJson: nested envelopes recurse and stay lossless", () => {
    const doc = { meta: "x", logs: Array.from({ length: 6 }, (_, i) => ({ seq: i, src: "api", msg: `m${i}` })) };
    const src = JSON.stringify(doc);
    const out = crushJson(src);
    assert.ok(out, "must crush");
    const parsed = JSON.parse(out!) as { logs: AnyEnv };
    assert.equal((parsed.logs as RowEnv).__pre_crush, "rows");
    assert.deepEqual(decodeValue(parsed), doc);
});

test("crushJson: no redundancy -> null (never reformats)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i, a: `a${i}`, b: `b${i}`, c: i % 3 }));
    assert.equal(crushJson(JSON.stringify(rows)), null);
    assert.equal(crushJson('{"a":1,"b":[1,2,3]}'), null);
});

test("tryCrush: malformed JSON falls through, prose passes through untouched", () => {
    assert.equal(tryCrush("[1,2,", 0.1, tok), null, "malformed JSON must fail open");
    assert.equal(tryCrush("The quick brown fox jumps over the lazy dog. ".repeat(20), 0.1, tok), null, "prose is not a crush target");
    assert.equal(tryCrush("", 0.1, tok), null);
});

test("tryCrush: minReduction gate rejects marginal savings", () => {
    const arr = Array.from({ length: 4 }, () => "x".repeat(100));
    const src = JSON.stringify(arr);
    assert.ok(tryCrush(src, 0.5, tok), "~66% reduction passes a 0.5 gate");
    assert.equal(tryCrush(src, 0.9, tok), null, "same payload rejected at a 0.9 gate");
});

test("tryCrush: dispatches json-first, then code", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
    assert.equal(tryCrush(JSON.stringify(rows), 0.1, tok)?.strategy, "json");
    const py = ["import os", "", "def f():", "    # c1", "    # c2", "    # c3", "    # c4", "    return os.getcwd()"].join("\n");
    assert.equal(tryCrush(py, 0.1, tok)?.strategy, "code");
});

test("resolvePreCrush: lenient resolution with invalid-value fallbacks", () => {
    assert.equal(resolvePreCrush(undefined), null);
    assert.equal(resolvePreCrush(null), null);
    assert.equal(resolvePreCrush("yes"), null);
    assert.equal(resolvePreCrush({}), null);
    assert.equal(resolvePreCrush({ preCrush: { enabled: false, minReduction: 0.9 } }), null, "disabled resolves to null");
    assert.deepEqual(resolvePreCrush({ preCrush: { enabled: true } }), { enabled: true, minReduction: PRE_CRUSH_DEFAULT_MIN_REDUCTION });
    assert.deepEqual(resolvePreCrush({ preCrush: { enabled: true, minReduction: "50%" } }), { enabled: true, minReduction: 0.5 }, "percent strings resolve like the config schema");
    assert.deepEqual(resolvePreCrush({ preCrush: { enabled: true, minReduction: 0.7 } }), { enabled: true, minReduction: 0.7 });
    assert.deepEqual(resolvePreCrush({ preCrush: { enabled: true, minReduction: 0 } }), { enabled: true, minReduction: PRE_CRUSH_DEFAULT_MIN_REDUCTION }, "invalid ratio falls back to default");
    assert.deepEqual(resolvePreCrush({ preCrush: { enabled: true, minReduction: "abc" } }), { enabled: true, minReduction: PRE_CRUSH_DEFAULT_MIN_REDUCTION });
});

const PY_DOCSTRING = [
    "#!/usr/bin/env python3",
    "# module-level comment",
    "",
    "",
    "def fetch(url):",
    '    """Fetch the url.',
    "",
    "        Multi-line body.",
    '    """',
    "    import urllib.request",
    "    return urllib.request.urlopen(url).read()",
].join("\n");

test("crushCode: python docstrings/comments elided, code lines kept verbatim", () => {
    const out = crushCode(PY_DOCSTRING);
    assert.ok(out, "must crush");
    const lines = out!.split("\n");
    assert.equal(lines[0], "#!/usr/bin/env python3", "shebang kept");
    assert.ok(lines.includes("def fetch(url):"), "signature kept");
    assert.ok(lines.includes("    import urllib.request"), "body kept");
    assert.ok(lines.includes("    return urllib.request.urlopen(url).read()"), "body kept");
    assert.ok(!out!.includes("Multi-line body"), "docstring body elided");
    assert.ok(!out!.includes("module-level comment"), "comment elided");
    assert.match(out!, /\[pre-crush: elided \d+ lines?\]/);
});

test("crushCode: assigned triple-quoted string is NOT a docstring and is kept", () => {
    const src = [
        "import os",
        "# comment one", "# comment two", "# comment three", "# comment four", "# comment five",
        "",
        "def gen():",
        '    """Docstring body.',
        "        second line.",
        '    """',
        '    x = """kept string"""',
        "    return x",
    ].join("\n");
    const out = crushCode(src);
    assert.ok(out, "must still crush (comments + docstring elided)");
    assert.ok(out!.includes('x = """kept string"""'), "non-docstring triple literal must survive verbatim");
    assert.ok(!out!.includes("Docstring body"), "docstring elided");
});

test("crushCode: unterminated triple quote fails open", () => {
    const src = ["import os", "", "def f():", '    """unclosed docstring', "    return x"].join("\n");
    assert.equal(crushCode(src), null);
});

const JS_TPL = [
    "// top comment one",
    "// top comment two",
    "// top comment three",
    "// top comment four",
    "function greet(name) {",
    '  // build a safe url',
    '  const url = `https://x/${name.split("//")[0]}/y`;',
    "  /* block",
    "     comment line two",
    "     comment */",
    "  console.log(`hi ${url}`);",
    "  return url;",
    "}",
].join("\n");

test("crushCode: js/ts comments elided, template literals with ${} intact", () => {
    const out = crushCode(JS_TPL);
    assert.ok(out, "must crush");
    assert.ok(!out!.includes("top comment"));
    assert.ok(!out!.includes("comment */"));
    assert.ok(out!.includes('const url = `https://x/${name.split("//")[0]}/y`;'), "template literal kept verbatim");
    assert.ok(out!.includes("console.log(`hi ${url}`);"), "second template kept verbatim");
    assert.match(out!, /\/\/ \[pre-crush: elided \d+ lines?\]/);
});

test("crushCode: prose is not detected as code", () => {
    assert.equal(crushCode("This is a plain English paragraph. ".repeat(30)), null);
});

function pytestLog(): string {
    const lines: string[] = [];
    lines.push("=== test session starts ===");
    lines.push("platform linux -- Python 3.12.4, pytest-8.3.2");
    for (let i = 0; i < 40; i++) lines.push(`tests/test_api.py::test_case_${i} PASSED`);
    for (let i = 0; i < 12; i++) {
        lines.push(`___________ test_case_fail_${i} ___________`);
        lines.push(`E   AssertionError: expected status 200, got ${500 + i}`);
        lines.push(`ERROR tests/test_api.py::test_case_fail_${i}`);
        lines.push("");
    }
    for (let i = 0; i < 500; i++) lines.push("WARNING  urllib3.connectionpool:connectionpool.py:869 - Connection pool is full, discarding connection");
    for (let i = 0; i < 100; i++) lines.push(`INFO  app.api:api.py:${i} - request handled in ${i}ms`);
    lines.push("");
    lines.push("=== short test summary info ===");
    lines.push("FAILED tests/test_api.py::test_case_fail_0 - AssertionError: expected status 200, got 500");
    lines.push("======== 12 failed, 40 passed in 3.42s ========");
    return lines.join("\n");
}

test("crushLog: errors always kept (first+last beyond budget), warnings deduped, noise dropped", () => {
    const src = pytestLog();
    const out = crushLog(src);
    assert.ok(out, "must crush");
    assert.ok(out!.length < src.length / 2, "big reduction expected");
    const errorLines = out!.split("\n").filter((l) => l.startsWith("ERROR tests/test_api.py::"));
    assert.ok(errorLines.length >= 1 && errorLines.length <= 10, `error budget respected (${errorLines.length})`);
    assert.ok(out!.includes("ERROR tests/test_api.py::test_case_fail_0"), "first error kept");
    assert.ok(out!.includes("ERROR tests/test_api.py::test_case_fail_11"), "last error kept");
    const warnCount = out!.split("\n").filter((l) => l.includes("Connection pool is full")).length;
    assert.ok(warnCount >= 1 && warnCount <= 15, `identical warnings deduped (${warnCount} of 500)`);
    const infoCount = out!.split("\n").filter((l) => l.includes("request handled in")).length;
    assert.ok(infoCount <= 15, `INFO noise dropped (${infoCount} of 100)`);
    assert.match(out!, /\[\d+ lines omitted:/, "honest omission footer present");
    assert.ok(out!.includes("=== short test summary info ==="), "summary line kept");
});

test("crushLog: deterministic (byte-identical across calls)", () => {
    const src = pytestLog();
    assert.equal(crushLog(src), crushLog(src));
});

test("crushLog: short logs pass through untouched", () => {
    const short = ["INFO start", "ERROR boom", "ERROR bang", ...Array(30).fill("INFO tick")].join("\n");
    assert.equal(short.split("\n").length, 33);
    assert.equal(crushLog(short), null, "<50 lines never crushed");
});

test("crushLog: unstructured prose never reaches the selector", () => {
    const prose = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about ordinary topics without any structure.`).join("\n");
    assert.equal(crushLog(prose), null);
    assert.equal(tryCrush(prose, 0.1, tok), null, "and tryCrush fails open on prose");
});

function jsTraceLog(): string {
    const lines: string[] = ["ERROR unhandled exception in worker pool"];
    for (let i = 0; i < 25; i++) lines.push(`    at Worker.task (/app/node_modules/pkg/dist/worker.js:${10 + i}:${i})`);
    lines.push("    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)");
    for (let i = 0; i < 40; i++) lines.push("info  heartbeat ok");
    return lines.join("\n");
}

test("crushLog: long runtime stack traces collapse to head frames + marker", () => {
    const src = jsTraceLog();
    const out = crushLog(src);
    assert.ok(out, "must crush");
    assert.ok(out!.includes("at Worker.task (/app/node_modules/pkg/dist/worker.js:10:0)"), "head frame kept");
    assert.match(out!, /\[\.\.\. \d+ frames collapsed\]/, "collapse marker present");
    assert.ok(!out!.includes("worker.js:20:10"), "middle runtime frames dropped");
    assert.ok(!out!.includes("worker.js:34:24"), "tail runtime frames dropped");
});

test("tryCrush: log-shaped payloads dispatch to the log strategy", () => {
    assert.equal(tryCrush(pytestLog(), 0.1, tok)?.strategy, "log");
});

function makeTurnWith(resultText: string, absorb: PreCrushAwareConfig["absorb"]) {
    const core = createCore();
    const msgs: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "run the job" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "job" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: resultText },
    ];
    const config: PreCrushAwareConfig = { ...defaultConfig(200000), absorb };
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config, tokenCount: 0, renderTags: "text-only" });
    return { config, turn };
}

test("applyAbsorbView: pre-crushed result below minToolTokens never reaches the model absorb path", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i * 7, ts: "2026-09-21T12:00:00Z", level: "INFO", name: `svc-${i}` }));
    const src = JSON.stringify(rows);
    assert.ok(tok(src) >= 100, "fixture must start above the absorb threshold");
    const { config, turn } = makeTurnWith(src, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100, preCrush: { enabled: true, minReduction: 0.1 } });
    const view = applyAbsorbView(turn.messages, turn.state, config, 100_000);
    const res = view.find((m) => m.id === "t-res");
    assert.ok(res, "result must remain visible (crushed, not hidden)");
    const env = JSON.parse(res!.text!) as RowEnv;
    assert.equal(env.__pre_crush, "rows", "wire carries the crushed envelope");
    assert.ok(!view.some((m) => (m.text ?? "").includes("[ACP absorb]")), "below threshold: no model absorb round-trip");
    assert.deepEqual(view.filter((m) => m.id !== "t-res").map((m) => m.text), turn.messages.filter((m) => m.id !== "t-res").map((m) => m.text), "non-result messages untouched");
});

test("applyAbsorbView: still-over-threshold result is forwarded crushed WITH the absorb prompt", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, level: "INFO", msg: `request handled with status code and correlation value ${i}` }));
    const src = JSON.stringify(rows);
    const { config, turn } = makeTurnWith(src, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100, preCrush: { enabled: true, minReduction: 0.1 } });
    const view = applyAbsorbView(turn.messages, turn.state, config, 100_000);
    const res = view.find((m) => m.id === "t-res");
    // crush ran on the payload before the kernel baked its prompt, so the
    // result is crushed-payload + freshly appended prompt.
    const markerAt = res!.text!.indexOf("[ACP absorb]");
    assert.ok(markerAt > 0, "absorb prompt re-attached on the crushed result");
    const env = JSON.parse(res!.text!.slice(0, markerAt)) as RowEnv;
    assert.equal(env.__pre_crush, "rows", "crushed before the prompt decision");
    assert.ok(tok(res!.text!.slice(0, markerAt)) >= 100, "still above threshold after crushing");
});

test("applyPreCrush: feature off (either switch) leaves messages byte-identical", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, ts: "2026-09-21T12:00:00Z", level: "INFO" }));
    const src = JSON.stringify(rows);
    const offParent = makeTurnWith(src, { ...DEFAULT_ABSORB_CONFIG, enabled: false, preCrush: { enabled: true, minReduction: 0.1 } });
    assert.deepEqual(applyPreCrush(offParent.turn.messages, offParent.turn.state, offParent.config), offParent.turn.messages, "absorb.enabled=false gates pre-crush");
    const offChild = makeTurnWith(src, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100, preCrush: { enabled: false, minReduction: 0.1 } });
    assert.deepEqual(applyPreCrush(offChild.turn.messages, offChild.turn.state, offChild.config), offChild.turn.messages, "preCrush.enabled=false is a no-op");
    const absent = makeTurnWith(src, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100 });
    assert.deepEqual(applyPreCrush(absent.turn.messages, absent.turn.state, absent.config), absent.turn.messages, "absent preCrush block is a no-op");
});

test("applyPreCrush: sub-threshold results are never touched", () => {
    const small = JSON.stringify([{ id: 1, zone: "z1" }]);
    const { config, turn } = makeTurnWith(small, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100, preCrush: { enabled: true, minReduction: 0.1 } });
    assert.deepEqual(applyPreCrush(turn.messages, turn.state, config), turn.messages, "results below minToolTokens are left alone");
});

test("applyAbsorbView: log result crushed below threshold skips the absorb round-trip", () => {
    const log = ["INFO boot ok", ...Array(55).fill("warn retry x"), "ERROR db connection lost", "ERROR transaction aborted", "Summary: 2 errors, 55 warnings"].join("\n");
    const { config, turn } = makeTurnWith(log, { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 150, preCrush: { enabled: true, minReduction: 0.1 } });
    assert.ok(tok(log) >= 150, "fixture must start above the absorb threshold");
    const view = applyAbsorbView(turn.messages, turn.state, config, 100_000);
    const res = view.find((m) => m.id === "t-res");
    assert.ok(res?.text && tok(res.text) < 150, `crushed below threshold (${tok(res!.text!)} tok)`);
    assert.ok(res!.text!.includes("ERROR db connection lost"), "errors survive the crush");
    assert.ok(!view.some((m) => (m.text ?? "").includes("[ACP absorb]")), "below threshold: no model absorb round-trip");
});

test("parseCompressSettings: absorb.preCrush validation follows whole-block convention", () => {
    const good = parseCompressSettings({ absorb: { enabled: true, minToolTokens: 100, preCrush: { enabled: true, minReduction: "50%" } } });
    assert.deepEqual(good?.absorb?.preCrush, { enabled: true, minReduction: "50%" });
    const num = parseCompressSettings({ absorb: { enabled: true, preCrush: { enabled: false, minReduction: 0.25 } } });
    assert.deepEqual(num?.absorb?.preCrush, { enabled: false, minReduction: 0.25 });
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: { enabled: true, minReduction: 0 } } }), undefined, "ratio 0 rejects the whole absorb block");
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: { enabled: true, minReduction: 1.5 } } }), undefined, "ratio > 1 rejects the whole absorb block");
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: { enabled: true, minReduction: "abc" } } }), undefined, "unparseable rejects the whole absorb block");
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: { enabled: "yes" } } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: [] } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { enabled: true, preCrush: "on" } }), undefined);
    const siblings = parseCompressSettings({ absorb: { enabled: true, minToolTokens: 200, preCrush: { enabled: true } } });
    assert.equal(siblings?.absorb?.minToolTokens, 200, "valid preCrush keeps sibling fields");
});

test("mergeCompress: preCrush sub-fields merge deepest-wins inside absorb", () => {
    const merged = mergeCompress(
        { absorb: { enabled: true, preCrush: { enabled: true } } },
        undefined,
        { absorb: { preCrush: { minReduction: "70%" } } },
    );
    assert.deepEqual(merged.absorb?.preCrush, { enabled: true, minReduction: "70%" }, "model-level minReduction must not clobber global-level enabled");
    const flat = mergeCompress(undefined, { absorb: { preCrush: { enabled: true, minReduction: 0.4 } } }, undefined);
    assert.deepEqual(flat.absorb?.preCrush, { enabled: true, minReduction: 0.4 });
    assert.equal(mergeCompress(undefined, undefined, undefined).absorb, undefined);
});

test("applyCompressSettings: maps preCrush onto resolved form with percent parse and default", () => {
    const base = defaultConfig(200000);
    const pct = applyCompressSettings(base, 200_000, { absorb: { enabled: true, preCrush: { enabled: true, minReduction: "50%" } } });
    assert.deepEqual(pct.absorb?.preCrush, { enabled: true, minReduction: 0.5 });
    const def = applyCompressSettings(base, 200_000, { absorb: { enabled: true, preCrush: { enabled: true } } });
    assert.deepEqual(def.absorb?.preCrush, { enabled: true, minReduction: PRE_CRUSH_DEFAULT_MIN_REDUCTION });
    const off = applyCompressSettings(base, 200_000, { absorb: { enabled: true, preCrush: { enabled: false } } });
    assert.equal(off.absorb?.preCrush?.enabled, false);
    const absent = applyCompressSettings(base, 200_000, { absorb: { enabled: true } });
    assert.equal(absent.absorb?.preCrush, undefined, "absent preCrush leaves no key behind");
    assert.equal(absent.absorb?.enabled, true, "kernel fields still mapped");
});
