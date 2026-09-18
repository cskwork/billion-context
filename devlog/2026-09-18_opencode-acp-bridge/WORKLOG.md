# WORKLOG — opencode v1: keep opencode-acp legacy sessions working after switching to bili

## Date

2026-09-18

## What was done (this PR)

- `src/agent/acp-bridge.ts` (NEW, ~350 lines): library-import bridge over the
  installed opencode-acp package. `resolveAcpPackage` (env spec slot
  authoritative → project node_modules → config-dir node_modules → newest
  cache slot; major-1 + dist validation), `acpStoreDir` (mirrors acp's own
  storagePath resolution incl. jsonc parsing and walk-up project config),
  `createAcpBridge` (BILLION_CONTEXT_PROXY save/delete/restore around import +
  init; hooks shape validation; legacy gate = store-file existence on every
  wrapped hook and tool executor; event ungated by design; `config` hook
  excluded). Any failure → null with a once-per-process warning.
- `src/agent/opencode.ts`: V1 `server()` now initializes the bridge when the
  launcher env is active; merges wrapped hooks + acp's DCP tool map into the
  returned Hooks, registers `/dcp` alongside `/acp`, chains command handlers
  (acp first — its abort throw wins for legacy sessions), and adds a
  `chat.headers` hook stamping `x-bili-plugin-bypass: 1` for legacy
  sessionIDs. V2 `setup()` untouched.
- `src/server.ts`: new early-return honoring `x-bili-plugin-bypass: 1`
  (constant in src/util.ts) — raw passthrough via the existing `forward()`
  before JSON.parse / window / session binding. The three wire-tool inject
  helpers (anthropic / openai / responses) now drop same-named client tools
  before injecting bili's definitions, so upstream sees one definition per
  name in proxy mode.
- `src/launcher.ts`: `prepareOpencodeHttpRewrite` strips opencode-acp entries
  from the cloned config (all spec forms, fork-safe matcher) before appending
  the bili plugin, and exports the first stripped spec to the spawn env as
  `BILI_OPENCODE_ACP_SPEC`.
- Tests: `tests/acp-bridge.test.ts` (NEW, 5 tests — probe order/authority,
  validation rejections, store-dir resolution matrix, env save/restore around
  acp init, full gating matrix, all degradation paths),
  `tests/fix-920-bypass-drop.test.ts` (NEW, 3 tests — bypass byte-fidelity
  incl. unparseable body, proxy-mode same-name drop), `tests/launcher.test.ts`
  (updated expectations + new all-spec-forms strip test).
- Docs: README.md / README.zh-CN.md (new "OpenCode 1.x" sections + table +
  launcher lines), CONFIGURATION.md / CONFIGURATION.zh-CN.md (launcher bullet
  + bypass header note), this devlog entry.

## Verification

- `npm run typecheck`: clean.
- `npm test`: 1677 pass, 0 fail, 2 skipped (pre-existing gated skips).
- `npm run build`: success; dist sanity checked (BILI_OPENCODE_ACP_SPEC in
  dist/agent/opencode.js, x-bili-plugin-bypass in dist/index.js).
- E2E preflight (`E2E_CHECK=1 tests/e2e/e2e-codex.test.ts`): pass. Full A/B
  run NOT possible in the agent environment: the suite's zero-cost upstream
  (127.0.0.1:8199 sglang) is unreachable here — noted in the PR body.

## Ceiling notes / deferred

- The legacy gate is store-file **existence**, slightly looser than acp's own
  shape validation (`loadSessionState` returns null on malformed files). A
  corrupt legacy file therefore behaves exactly as it does under standalone
  acp — no new failure mode introduced.
- acp's `startAutoUpdate` still runs inside the imported instance (same npm
  self-update it does standalone); acceptable, unchanged surface.
- OpenCode 2.x hosts are out of scope by design (V2 plugin path already owns
  compression natively; acp there was inert via self-disable anyway).
- If opencode-acp ever ships a factory export or per-session disable API, the
  wrapper layer in acp-bridge.ts is the single place to simplify.
