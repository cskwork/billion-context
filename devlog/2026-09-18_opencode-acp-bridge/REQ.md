# REQ — opencode v1: keep opencode-acp legacy sessions working after switching to bili

## Date

2026-09-18

## Background

Issue #920. Users migrating from `opencode-acp` (V1 in-process extension, DCP
protocol) to `bili plugin install opencode` lose their old sessions' compression
machinery: acp's ref space / blocks live in its own store
(`~/.local/share/opencode/storage/plugin/acp/<sessionID>.json`), bili starts a
fresh ACP-kernel ref space per conversation, and acp itself globally
self-disables when it sees `/bili/` provider baseURLs. Today `decompress` on an
old ref returns `[Block … not found]` and numbering restarts.

Requirement (user-directed design in the issue): on OpenCode 1.x, **old
sessions (acp state on disk) keep working through opencode-acp; new sessions go
through bili.**

### Constraints verified against real code before implementing

- v1 tool registry is process-global and static (`resolveTools` + permission
  only; `chat.params` cannot touch tools) — no per-request tool filtering hook.
  ⇒ acp's DCP tool definitions stay registered for every session; legacy
  gating must happen inside the executors/hooks, not via tool visibility.
- acp and bili speak different protocols (DCP ranges vs ACP tags) — tool
  definitions are not interchangeable. ⇒ the proxy keeps owning ACP wire tools
  for new sessions; same-named client tools are dropped before injection so
  upstream sees one definition per name.
- acp adopts every new session eagerly (`registry.getOrCreate` in its
  messages.transform) and self-disables globally on `/bili/` detection. ⇒ bili
  must never invoke acp's `config` hook, and every other hook is gated on
  "an acp store file exists for this session" so non-legacy sessions are never
  adopted.
- acp's package exports only `default server` — no factory hooks. ⇒ bili
  imports the installed package as a library (`await import()` around a
  temporarily unset `BILLION_CONTEXT_PROXY`) and wraps the returned hooks.
- The BILLION_CONTEXT_PROXY guard runs when `server(ctx)` is called, not at
  module evaluation — import is side-effect-free; env save/delete/restore
  around call + init suffices.
- OpenCode 1.x exposes a per-request `chat.headers` hook (verified in the live
  v1.14.46 binary: trigger sits in the LLM request path, built-ins use it for
  real wire headers) — the bridge stamps `x-bili-plugin-bypass: 1` per request
  keyed on sessionID.

## Design decisions

- **bili-side absorption, zero opencode-acp changes.** New module
  `src/agent/acp-bridge.ts` (bundled into dist/agent/opencode.js):
  - `resolveAcpPackage(directory)`: env spec slot first (authoritative — the
    copy the host would have loaded), then `<dir>/node_modules`, then
    `<XDG_CONFIG_HOME>/opencode/node_modules`, then newest valid
    `<XDG_CACHE_HOME>/opencode/packages/opencode-acp*`. Valid = package.json
    major === 1 + dist/index.js present.
  - `acpStoreDir(directory)`: mirrors acp's own resolution
    (project `.opencode/acp.jsonc|json` > `$OPENCODE_CONFIG_DIR` > global XDG
    config; jsonc-parser; `~` expansion; relative → host directory).
  - `createAcpBridge(ctx)`: import with BILLION_CONTEXT_PROXY removed, validate
    hooks shape, wrap system.transform / messages.transform / text.complete /
    command.execute.before / every tool executor behind the legacy gate
    (store-file existence); event passed through ungated (it only reacts to
    local compress tool parts, which new sessions cannot produce because the
    proxy intercepts wire compress calls); `config` hook excluded entirely.
- **Proxy bypass mode**: `x-bili-plugin-bypass: 1` → raw passthrough ahead of
  any pipeline processing (no JSON.parse, no window resolution, no session
  binding, no injection, no compression, no state written).
- **Proxy-mode tool ownership flip**: the three inject helpers now drop
  same-named client tools before injecting bili's definitions (previously
  union: client definition won). Plugin mode never calls these helpers, so it
  is unaffected.
- **Launcher**: `prepareOpencodeHttpRewrite` strips opencode-acp entries from
  the temp config clone (string / tuple / object forms; fork-safe matcher) so
  the host never loads acp armed; the first stripped spec rides along via
  `BILI_OPENCODE_ACP_SPEC` so the bridge imports exactly that copy.
- **Graceful degradation**: package not found / import fails / version ≠ 1 /
  hooks shape mismatch → exact pre-change behavior (documented in README).

## Acceptance criteria

- [x] Legacy session (store file present): acp hooks + DCP tools active,
      requests raw-passthrough, `/dcp` command available.
- [x] New session: acp never invoked (no adoption), plain proxy mode with ACP
      wire tools; upstream body contains exactly one definition per tool name.
- [x] Bypass header honored verbatim (byte-identical body forward), including
      unparseable bodies.
- [x] Launcher strips all entry forms; fork-named entries untouched; user's
      real config never modified.
- [x] Every degradation path returns null → current behavior.
- [x] Regression tests added and passing; full suite green; typecheck clean;
      build green.
