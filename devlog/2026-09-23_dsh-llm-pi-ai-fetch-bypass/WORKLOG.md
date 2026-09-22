# WORKLOG — dsh llm-pi-ai fetch bypass: loud one-shot detection (#1158)

## Date
2026-09-23

## What was done (this commit)
- src/plugin.ts: `handlePluginTool` now distinguishes the two `!session`
  failures more precisely on the never-registered (`!entry`) branch — a tool
  call proves the model already answered, so ZERO model requests for that
  conversation id means its traffic never reached the proxy at all. First hit
  per conversation logs a one-shot actionable warn (`[plugin] NO MODEL REQUESTS
  seen for conversation …`): names both causes (SDK-injected fetch bypassing
  the intercepted global fetch — known case dsh llm-pi-ai custom providers
  under a bare profile install, fix = `bili dsh` launcher whose settings
  overlay rewrites their baseURLs; or stale id after host resume) plus the
  self-check (send a message, look for processTurn lines). The 404 error body
  gains the same guidance while keeping the exact substrings `src/mcp.ts`
  (ORPHAN_ADOPT) and `src/agent/opencode-v2.ts` match on. One-shot state lives
  in a bounded module Set (cap 4096, coarse clear) reset by
  `_resetPluginStateForTest`. The entry-exists branch keeps its legacy
  per-call warn and wording byte-for-byte.
- tests/issue1158-no-model-request-warning.test.ts: new regression suite —
  consumer substrings preserved, guidance present, warn exactly once per
  conversation, second conversation gets its own, reset re-arms, entry-exists
  branch unchanged (legacy wording, no bypass wording leak).
- README.md / README.zh-CN.md: dsh section gains the known-limitation entry
  (llm-pi-ai transport under profile install bypasses the fetch patch;
  detection signal; launcher-lane fix).
- devlog entry (this folder).

## Behavior / compatibility changes (disclosure)
- Log volume: for a NEVER-registered conversation id, the warn goes from
  every rejected tool call → once per conversation (old text
  `id never registered (stale shim session id after host resume?)` replaced by
  the richer NO MODEL REQUESTS line). Reason: the old line repeated on every
  tool call while pointing at only one of two hypotheses.
- Wire: the `/__bili/plugin/tool` 404 `error` string for unknown conversations
  grows a guidance suffix; status code, JSON shape, and both matched
  substrings are unchanged (mcp adoption + opencode-v2 recovery unaffected —
  covered by existing tests, suite green).
- No change to model-request handling, compression, config schema, or
  persistence format.

## Verification
- `npm run typecheck`: clean.
- `npm test`: 2250 pass, 0 fail, 2 skipped (pre-existing gated skips).
- `npm run build`: success.
- Full E2E not run: the change touches neither the request pipeline
  (server.ts / src/loop/* / adapters / preflight) nor any wire shape — only
  diagnostic output on an already-failing plugin-tool 404 path. Local
  repro of the original symptom is impossible here (needs Windows + dsh web
  GUI); root cause verified against the issue's pi-ai code citations
  (openai-completions.js :202/:547/:573-579) and devlog/2026-08-25_dsh-launcher
  REQ.md ("pi-ai 纯 fetch,无 proxy/CA 接口").

## Ceiling notes / deferred
- Generic interception of an arbitrary SDK-injected fetch is infeasible from
  bili's side (the function reference is private to the host module graph;
  pnpm isolation defeats cross-module patching; undici-internals patching too
  invasive). The real transport fix belongs in dsh (resolve fetch lazily from
  globalThis, or expose a middleware seam) — reported in the issue thread,
  not filed as a bili work item.
- `handlePluginCompact`'s analogous 404 wording left untouched (not part of
  the symptom; dsh-native has no compaction hook calling it).
- takeoverGate refusal stays silent by design (#1117): third-party in-process
  plugins legitimately make unattributed calls through the host bridge.
