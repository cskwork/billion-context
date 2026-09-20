import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, MESSAGES, translate } from "../src/web/i18n.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const han = /\p{Script=Han}/u;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("#1024: catalog parity — every key in every locale with matching placeholders", () => {
    const zhKeys = Object.keys(MESSAGES["zh-CN"]);
    assert.ok(zhKeys.length > 100, `expected a full catalog, got ${zhKeys.length} keys`);
    for (const locale of LOCALES) {
        for (const key of zhKeys) {
            assert.ok(key in MESSAGES[locale], `missing ${locale} value for "${key}"`);
            assert.equal(typeof MESSAGES[locale][key], "string");
        }
    }
    for (const key of zhKeys) {
        assert.deepEqual(placeholders(MESSAGES.en[key]), placeholders(MESSAGES["zh-CN"][key]), `placeholder mismatch for "${key}"`);
    }
});

test("#1024: no Chinese residue in English translations", () => {
    for (const [key, value] of Object.entries(MESSAGES.en)) {
        assert.ok(!han.test(value), `English value for "${key}" still contains Chinese: ${value}`);
    }
});

test("#1024: translate() interpolates vars and falls back to the key", () => {
    assert.equal(translate("en", "toast.connect_ok", { status: 204 }), "Connection successful, HTTP 204");
    assert.equal(translate("zh-CN", "toast.connect_ok", { status: 200 }), "连接成功，HTTP 200");
    assert.equal(translate("en", "does.not.exist"), "does.not.exist");
});

function collectRefs(): Set<string> {
    const pageSrc = readFileSync(join(here, "..", "src", "web", "page.ts"), "utf8");
    const clientSrc = readFileSync(join(here, "..", "src", "web", "client.ts"), "utf8");
    const refs = new Set<string>();
    for (const m of pageSrc.matchAll(/data-i18n(?:-ph|-title)?="([\w.]+)"/g)) refs.add(m[1]);
    for (const m of pageSrc.matchAll(/zh\("([\w.]+)"\)/g)) refs.add(m[1]);
    for (const m of clientSrc.matchAll(/\bt\("([\w.]+)"/g)) refs.add(m[1]);
    return refs;
}

test("#1024: every referenced key exists in both locales and no catalog key is dead", () => {
    const refs = collectRefs();
    assert.ok(refs.size > 100, `expected many i18n references, found ${refs.size}`);
    for (const key of refs) {
        assert.ok(key in MESSAGES["zh-CN"], `referenced key missing from zh catalog: ${key}`);
        assert.ok(key in MESSAGES.en, `referenced key missing from en catalog: ${key}`);
    }
    for (const key of Object.keys(MESSAGES["zh-CN"])) {
        assert.ok(refs.has(key), `catalog key never referenced anywhere: ${key}`);
    }
});

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Text = { text: string };
type Node = El | Text;
const isEl = (node: Node): node is El => "tag" in node;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function parseHtml(html: string): Node[] {
    const root: Node[] = [];
    let pos = 0;
    function parseAttrs(raw: string): Record<string, string> {
        const attrs: Record<string, string> = {};
        for (const m of raw.matchAll(/([\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g)) {
            if (m[1]) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
        }
        return attrs;
    }
    function parseInto(target: Node[], stopTag: string): void {
        while (pos < html.length) {
            const lt = html.indexOf("<", pos);
            if (lt === -1) { target.push({ text: html.slice(pos) }); return; }
            if (lt > pos) target.push({ text: html.slice(pos, lt) });
            if (html.startsWith("<!--", lt)) { const end = html.indexOf("-->", lt); pos = end === -1 ? html.length : end + 3; continue; }
            if (html.startsWith("<!", lt)) { const end = html.indexOf(">", lt); pos = end === -1 ? html.length : end + 1; continue; }
            if (html.startsWith("</", lt)) {
                const end = html.indexOf(">", lt);
                const name = html.slice(lt + 2, end).trim();
                pos = end + 1;
                if (name === stopTag) return;
                continue;
            }
            const gt = html.indexOf(">", lt);
            const raw = html.slice(lt + 1, gt);
            const nameMatch = raw.match(/^([a-zA-Z][\w-]*)/);
            const name = nameMatch ? nameMatch[1].toLowerCase() : "";
            pos = gt + 1;
            if (!name || VOID_TAGS.has(name)) continue;
            if (name === "script" || name === "style") {
                const closeAt = html.indexOf(`</${name}`, pos);
                const body = closeAt === -1 ? "" : html.slice(pos, closeAt);
                pos = closeAt === -1 ? html.length : html.indexOf(">", closeAt) + 1;
                target.push({ tag: name, attrs: {}, children: [{ text: body }] });
                continue;
            }
            const el: El = { tag: name, attrs: parseAttrs(raw.slice(nameMatch[1].length)), children: [] };
            target.push(el);
            parseInto(el.children, name);
        }
    }
    parseInto(root, "");
    return root;
}

const fullText = (node: Node): string => (isEl(node) ? node.children.map(fullText).join("") : node.text);

function* walk(nodes: Node[], ancestors: El[]): Generator<[El, El[]]> {
    for (const node of nodes) {
        if (!isEl(node)) continue;
        if (node.tag === "script" || node.tag === "style") continue;
        yield [node, ancestors];
        yield* walk(node.children, [...ancestors, node]);
    }
}

test("#1024: rendered page — catalog is the single source of truth and every Chinese string is marked", () => {
    const html = renderPage("http://127.0.0.1:8787", "0.0.0-test");
    let marked = 0;
    for (const [el, ancestors] of walk(parseHtml(html), [])) {
        const mark = el.attrs["data-i18n"];
        if (mark) {
            marked++;
            assert.equal(fullText(el), translate("zh-CN", mark), `data-i18n="${mark}" drifted from catalog: ${fullText(el)}`);
        }
        if (el.attrs["data-i18n-title"]) {
            assert.equal(el.attrs["title"], translate("zh-CN", el.attrs["data-i18n-title"]), `title drifted for data-i18n-title="${el.attrs["data-i18n-title"]}"`);
        }
        if (el.attrs["data-i18n-ph"]) {
            assert.equal(el.attrs["placeholder"], translate("zh-CN", el.attrs["data-i18n-ph"]), `placeholder drifted for data-i18n-ph="${el.attrs["data-i18n-ph"]}"`);
        }
        for (const attr of ["title", "placeholder"] as const) {
            const value = el.attrs[attr];
            if (value && han.test(value)) {
                assert.ok(el.attrs[attr === "title" ? "data-i18n-title" : "data-i18n-ph"], `unmarked Chinese ${attr}: ${value}`);
            }
        }
        for (const child of el.children) {
            if (!isEl(child) && han.test(child.text)) {
                const covered = [el, ...ancestors].some((e) => e.attrs["data-i18n"] || e.attrs["data-i18n-title"] || e.attrs["data-i18n-ph"]);
                assert.ok(covered, `unmarked Chinese text node: ${child.text.trim().slice(0, 40)}`);
            }
        }
    }
    assert.ok(marked > 80, `expected many marked nodes, found ${marked}`);
    assert.ok(html.includes('id="language-toggle"'), "language toggle button present");
});

test("#1024: embedded client parses and persists the language choice", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT));
    assert.match(WEB_CLIENT, /bili-language/);
    assert.match(WEB_CLIENT, /language-toggle/);
    assert.match(WEB_CLIENT, /MESSAGES=/);
});
