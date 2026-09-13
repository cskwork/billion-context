# DESIGN — OpenCode 2.0 launcher mode

## Module shape: dual-shape default export

`src/agent/opencode.ts` keeps the existing V1 `server()` function and adds a
V2 `setup(ctx)`. The default export becomes:

```
{ id: "billion-context-opencode", setup, server }
```

Hosts ≥ 1.18.29 accept an object that is both a V1 plugin (`server`) and a
V2 plugin definition (`id` + `setup`); older hosts ignore the extra keys. One
artifact serves both generations — no separate package or entry point.

## Why static tool registration

`ctx.tool.transform(editor => editor.add(...))` must be synchronous, cheap,
and replayable; the probed 2.0 runtime has no `ctx.tool.reload()`, so tools
cannot be registered lazily after an async manifest fetch. Instead the tool
list is built at module load from the **same bundled schemas** the proxy
serves in its OpenAI manifest (`ACP_TOOLS_OPENAI` + `ABSORB_TOOL_OPENAI` from
`src/compress-tool.ts`). Parity between host-registered tools and wire-injected
tools cannot drift because both sides are the same const.

## Interception point: `http.request`, not `model.request`

Probed against the real 2.0 pre-release binary: `session.hook("model.request")`
registers successfully but never fires. `session.hook("http.request")` fires
per outgoing provider request with `e = { sessionID, agent, model, request }`
where `request` is a standard fetch `Request`; mutating `request.headers`
reaches the wire (probe-verified). The hook therefore:

1. kill-switch check (`BILLION_CONTEXT_PLUGIN === "0"`);
2. lazy proxy-base detection from `request.url` (`proxyBaseFromUrl`) falling
   back to `BILLION_CONTEXT_PROXY`;
3. refreshes the context-window map (60s throttle) from
   `ctx.catalog.model.list()`;
4. stamps `x-bili-plugin: opencode`, `x-bili-plugin-conversation: <sessionID>`,
   and — when known — `x-bili-plugin-context-window`.

Lazy detection means the same artifact works for launcher mode (baseURL
already `/bili/-wrapped`) and any manual pure-proxy setup without env vars.

## Tool execution path

Native tool `execute(input)` → `forwardTool(proxyBase, sessionID, name, args)`
→ `POST /__bili/plugin/tool` on the proxy. The proxy executes via the kernel
and returns the result text; the agent returns `{ content }`. Because the
header marks the session plugin-mode, the proxy suppresses wire-level ACP tool
injection for these sessions (existing behavior, no change) — the model sees
exactly one copy of each tool, the native one. The kill switch
(`BILLION_CONTEXT_PLUGIN=0`) gates `execute` too, alongside header stamping
and compaction reporting — fully inert, matching `detectProxyBase` semantics.

## Native compaction boundary

`ctx.event.subscribe({ signal })` async iterator; on
`session.compaction.ended` the plugin POSTs the conversation id to
`/__bili/plugin/compact` so the proxy archives its blocks at the boundary
(#421 path). Errors are swallowed — a missed report degrades to the existing
orphan-GC behavior, never breaks the host session. Cleanup aborts the signal
and disposes every registration.

## Launcher change

`prepareOpencodeHttpRewrite` merges `compaction.auto: false` into the temp
config (preserving any user-set sibling keys). Verified tolerant on V1 1.14.46
(unknown top-level key ignored), so no version detection is needed.
