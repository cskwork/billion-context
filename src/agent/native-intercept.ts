// Native-mode fetch interception (#519): a globalThis.fetch patch that
// silently routes model-API requests through a bili proxy that the extension
// itself spawned (see pi-native.ts). Verified end-to-end on pi 0.83.6: pi's
// provider stack (pi-stable-ai → Anthropic/OpenAI SDKs) resolves its fetch
// from the global at FIRST-request client construction, so a patch installed
// at extension load always wins. The patch is surgical — it rewrites ONLY
// model-API shaped URLs and leaves every other request untouched.

import { BILI_PASSTHROUGH_HEADER } from "../util.js";

export interface NativeInterceptState {
    /** Proxy origin ("http://127.0.0.1:PORT") once the bootstrap resolved.
     *  Written by the owner (pi-native.ts); read synchronously on each call. */
    origin: string | undefined;
    /** Resolves to the proxy origin once healthy, or undefined on failure. */
    ready: Promise<string | undefined>;
    /** Owner hook: re-run the bootstrap (proxy died → respawn). */
    respawn?: () => Promise<string | undefined>;
    /** Owner hook: fired once when a respawn attempt fails and the session
     *  degrades to direct sends for good — clear proxy-owned state (e.g. the
     *  BILLION_CONTEXT_PROXY env) so event-time ownership checks disarm with
     *  the traffic. */
    onGiveUp?: () => void;
    /** Attach mode (#809): route through a user-supplied external proxy at
     *  state.origin instead of a spawned one. Set by the host entry when a
     *  BILLION_CONTEXT_ATTACH / launcher-preset BILLION_CONTEXT_PROXY is
     *  present. Rewrites model URLs to the attach origin exactly like spawn
     *  mode (opencode V1's fetch patch and #809's probe+rewrite semantics
     *  depend on it); already-routed `/bili/` URLs still pass through except
     *  for headersFor stamping. The attached proxy is often owned by ANOTHER
     *  launcher that can exit mid-session (#1130) — hosts arm state.respawn
     *  so an observed death triggers the same runtime recovery as spawn
     *  mode; without respawn, an observed death degrades to direct sends
     *  instead of failing every request forever. */
    attach?: boolean;
    /** Optional header hook (#941): called synchronously per model-API
     *  request with the (pre-rewrite) target URL. A non-undefined return is
     *  merged into the outgoing request headers — dsh-native uses it to
     *  stamp x-bili-plugin* once its tools are registered, gating plugin
     *  mode exactly like pi.ts's before_provider_headers stamp. Returning
     *  undefined sends the request untouched (wire mode). */
    headersFor?: (url: string) => Record<string, string> | undefined;
    /** #1117: attribution gate — called synchronously per model-API request
     *  with the (pre-rewrite) target URL. Returning false means the caller is
     *  NOT the host itself (e.g. a third-party in-process plugin riding the
     *  host's LLM bridge, whose model calls hit the same URLs): the request is
     *  NOT claimed — raw URLs send direct, already-routed `/bili/` URLs are
     *  stamped with the passthrough marker instead. Undefined (hosts without
     *  an attribution signal) keeps URL-shape claiming for every caller. */
    takeoverGate?: (url: string) => boolean;
    /** How long a pre-ready model request waits for the bootstrap before
     *  falling back to a direct (uncompressed) send. */
    readyTimeoutMs?: number;
    /** Test/observability hook: every dispatched decision. */
    onDispatch?: (url: string, action: "rewrite" | "direct" | "self" | "retry") => void;
}

const INTERCEPT_FLAG = "__biliNativeFetchIntercept";

// Model-API endpoint suffixes across the wires bili proxies: Anthropic
// `/v1/messages`, OpenAI chat `/v1/chat/completions` (and legacy
// `/v1/completions`), Responses `/v1/responses`, Mistral
// `/v1/chat/completions`|`/v1/conversations`. Version segment is optional
// and unpinned (zhipuai uses `/v4/chat/completions`, bailian mounts
// `/apps/anthropic/v1/messages`), so match on the trailing shape only.
const MODEL_API_SUFFIX = /(?:^|\/)(?:v\d+\/)?(?:messages|chat\/completions|completions|responses|conversations)\/?$/;

/** True when the URL points at a model-API endpoint worth proxying. Never
 *  true for bili's own proxy paths (`/bili/…`, `/__bili/…`) or non-HTTP(S). */
export function isModelApiUrl(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.includes("/__bili/") || url.includes("/__acp/")) return false;
    try {
        const u = new URL(url);
        const segments = u.pathname.split("/").filter((s) => s.length > 0);
        if (segments[0] === "bili") return false;
        const pathname = u.pathname.replace(/\/+$/, "");
        return MODEL_API_SUFFIX.test(pathname);
    } catch {
        return false;
    }
}

/** A URL already routed by a bili proxy in `/bili/` rewrite form
 *  (`${proxy}/bili/${upstream}`): returns the embedded upstream URL when it
 *  is model-API shaped, else undefined. The launcher's settings overlay
 *  produces these; the patch does not rewrite them (routing is already
 *  done) but DOES stamp plugin headers on them. */
export function routedBiliModelUrl(url: string): string | undefined {
    if (!/^https?:\/\//i.test(url) || url.includes("/__bili/") || url.includes("/__acp/")) return undefined;
    const m = /^https?:\/\/[^/]+\/bili\/(https?:\/.+)$/i.exec(url);
    if (m === null) return undefined;
    return isModelApiUrl(m[1]) ? m[1] : undefined;
}

function fetchUrlOf(input: string | URL | Request): string | undefined {
    try {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        if (input !== null && typeof input === "object" && typeof (input as Request).url === "string") {
            return (input as Request).url;
        }
    } catch {
        // fallthrough
    }
    return undefined;
}

/** Merge extra headers into a (input, init) pair, preserving all three
 *  init.headers forms (Headers instance, entries array, plain object) and
 *  rebuilding a Request-object input with the merged headers (its body
 *  stream passes through explicitly — undici refuses to copy a body-bearing
 *  Request without duplex). Returns the original pair unchanged when there
 *  is nothing to merge. */
function withHeaders(input: string | URL | Request, init: RequestInit | undefined, extra: Record<string, string> | undefined): { input: string | URL | Request; init: RequestInit | undefined } {
    if (extra === undefined || Object.keys(extra).length === 0) return { input, init };
    if (input instanceof Request) {
        try {
            const headers = new Headers(input.headers);
            for (const [k, v] of Object.entries(extra)) headers.set(k, v);
            const rebuilt = new Request(input.url, { method: input.method, headers, body: input.body, duplex: "half" });
            return { input: rebuilt, init };
        } catch {
            return { input, init };
        }
    }
    if (init?.headers === undefined) return { input, init: { ...init, headers: { ...extra } } };
    if (init.headers instanceof Headers) {
        const headers = new Headers(init.headers);
        for (const [k, v] of Object.entries(extra)) headers.set(k, v);
        return { input, init: { ...init, headers } };
    }
    if (Array.isArray(init.headers)) {
        return { input, init: { ...init, headers: [...init.headers, ...Object.entries(extra)] } };
    }
    if (typeof init.headers === "object" && init.headers !== null) {
        return { input, init: { ...init, headers: { ...(init.headers as Record<string, string>), ...extra } } };
    }
    return { input, init };
}

async function withTimeout(p: Promise<string | undefined>, ms: number): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } catch (err) {
        // #983: a rejected bootstrap used to vanish silently here — surface
        // the real error so a dead-spawn looks different from a slow one.
        console.error(`bili-native: proxy bootstrap failed (${err instanceof Error ? err.message : String(err)}) — falling back after timeout`);
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function readyOrigin(state: NativeInterceptState): Promise<string | undefined> {
    if (state.origin !== undefined) return state.origin;
    return withTimeout(state.ready, state.readyTimeoutMs ?? 15000);
}

// ———— Live-origin resolution (#1135) ——————————————————————————————
// Shared by BOTH OpenCode lanes (the native entry's V2 route and the
// launcher plugin's V2 route): each outgoing request resolves the LIVE proxy
// origin — fast-path the held origin through a TTL-cached health probe, and
// when it is dead drive state.respawn (cooldown-gated unless we just lost an
// origin we were actively routing to) and adopt whatever replacement lands.
// A transient blip that recovers to the SAME origin costs nothing (the
// session never migrates); a genuinely dead origin falls back to whatever the
// owner's respawn produces (a self-spawned proxy, or another healthy shared
// instance via discovery). Returns undefined when nothing is alive — callers
// MUST degrade to direct sends, not fail-closed.

const HEALTH_TIMEOUT_MS = 1500;
/** Probe-verdict trust window (#928). Far below RESPAWN_COOLDOWN_MS: that
 *  cooldown already assumes multi-second proxy stability, so a few-second
 *  detection horizon is consistent with it while removing the per-request RTT. */
const HEALTH_PROBE_TTL_MS = 2_000;
const RESPAWN_COOLDOWN_MS = 15_000;

export async function probeHealth(origin: string): Promise<boolean> {
    try {
        const res = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

/** Wrap a probe in a per-origin TTL cache (#928). Both verdicts are cached: a
 *  healthy hit skips the steady-state loopback RTT; a dead hit avoids re-paying
 *  the full HEALTH_TIMEOUT_MS on every request across the death+cooldown window.
 *  Stale entries for other origins are evicted on insert, keeping the map bounded. */
export function withProbeTtl(probe: (origin: string) => Promise<boolean>, ttlMs: number): (origin: string) => Promise<boolean> {
    const cache = new Map<string, { ok: boolean; at: number }>();
    return (origin) => {
        const now = Date.now();
        const hit = cache.get(origin);
        if (hit !== undefined && now - hit.at < ttlMs) return Promise.resolve(hit.ok);
        return probe(origin).then((ok) => {
            const t = Date.now();
            for (const [key, entry] of cache) if (t - entry.at >= ttlMs) cache.delete(key);
            cache.set(origin, { ok, at: t });
            return ok;
        });
    };
}

export interface LiveOriginResolverDeps {
    /** Injectable health probe (tests); defaults to GET /__bili/health. */
    probe?: (origin: string) => Promise<boolean>;
    /** Bootstrap retry interval when no live origin is held (tests shrink it). */
    respawnCooldownMs?: number;
    /** Probe-verdict cache TTL; defaults to HEALTH_PROBE_TTL_MS (tests shrink it). */
    probeTtlMs?: number;
}

/** Build the per-request live-origin resolver over a shared intercept state.
 *  The owner arms `state.respawn` (self-spawn for spawn mode, probe-then-
 *  fallback for attach mode — #1130/#1135); this resolver only decides WHEN
 *  to fire it and whether the result is actually alive. */
export function createLiveOriginResolver(state: NativeInterceptState, deps: LiveOriginResolverDeps = {}): () => Promise<string | undefined> {
    const probe = withProbeTtl(deps.probe ?? probeHealth, deps.probeTtlMs ?? HEALTH_PROBE_TTL_MS);
    const respawnCooldownMs = deps.respawnCooldownMs ?? RESPAWN_COOLDOWN_MS;
    let lastRespawn = 0;
    return async (): Promise<string | undefined> => {
        let ownedThenLost = false;
        if (state.origin !== undefined) {
            if (await probe(state.origin)) return state.origin;
            // Proxy died mid-session. Clearing origin first makes concurrent
            // callers share the same state.ready (dedup).
            ownedThenLost = true;
            state.origin = undefined;
        }
        // Retry bootstrap whenever no live origin is held — either just lost
        // it or the load-time bootstrap failed (the hook cannot observe send
        // failures, so nothing else would retry). Cooldown bounds attempts to
        // one per interval instead of one per request.
        if (state.respawn !== undefined && (ownedThenLost || Date.now() - lastRespawn >= respawnCooldownMs)) {
            lastRespawn = Date.now();
            state.ready = state.respawn();
        }
        const o = await readyOrigin(state);
        if (o !== undefined && (await probe(o))) return o;
        if (ownedThenLost) state.onGiveUp?.();
        return undefined;
    };
}

/** Replace the outgoing request reference with a new Request against
 *  `target`, preserving method/headers/body (a Request.url is read-only,
 *  #810 — the reference itself moves). When the body cannot be copied the
 *  original request is left untouched (it goes direct rather than dying). */
export function replaceRequestTarget(e: { request?: unknown }, target: string): void {
    const old = e.request;
    if (old == null) return;
    try {
        e.request = new Request(target, old as unknown as Request);
    } catch {
        // undici refuses to copy a body-bearing Request without explicit
        // duplex — reconstruct with the body stream passed explicitly.
        const src = old as unknown as { method?: unknown; headers?: Iterable<readonly [string, string]> | null; body?: ReadableStream<Uint8Array> | null };
        try {
            const init: RequestInit & { duplex?: "half" } = { method: typeof src.method === "string" ? src.method : "GET" };
            const pairs: [string, string][] = [];
            try {
                for (const pair of src.headers ?? []) pairs.push([pair[0], pair[1]]);
            } catch {}
            if (pairs.length > 0) init.headers = pairs;
            if (src.body != null) {
                init.body = src.body as RequestInit["body"];
                init.duplex = "half";
            }
            e.request = new Request(target, init);
        } catch {
            // replacement impossible (exotic body) — request goes direct
        }
    }
}

/** Install the global fetch patch. Idempotent: a second call is a no-op
 *  (returns false) so double-loading the entry cannot double-wrap. */
export function installNativeFetchIntercept(state: NativeInterceptState): boolean {
    const g = globalThis as Record<string, unknown>;
    if (g[INTERCEPT_FLAG] === true) return false;
    const orig = globalThis.fetch;
    let warned = false;
    // Origins verified dead-and-replaced during a runtime recovery (#1130).
    // Launcher settings overlays bake the origin into request URLs, so after
    // a replace we must reroute those pre-baked URLs before they touch the
    // network again. Only ever contains origins we ourselves observed dying.
    const replacedOrigins = new Set<string>();

    const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = fetchUrlOf(input);
        if (url === undefined) return orig(input, init);
        // Rebuild a Request-object input against a different target. A
        // caller-side defect here (already-consumed or locked body) must not
        // reach the proxy-death branch below — respawning would orphan a
        // fresh proxy for a request that can never be sent.
        const makeTarget = (target: string): string | URL | Request =>
            typeof input === "string" || input instanceof URL ? target : new Request(target, input);

        // Runtime recovery (#1130): the origin just failed against is dead.
        // Clear it first (readyOrigin must not short-circuit onto the stale
        // value), ask the owner to bring up a replacement, await it. Returns
        // the replacement origin, or undefined when nothing came up. An
        // origin that comes back as ITSELF (transient blip) is not recorded
        // as replaced — URLs baked against it stay valid.
        const recover = async (deadOrigin: string): Promise<string | undefined> => {
            if (state.respawn === undefined) return undefined;
            state.origin = undefined;
            state.ready = state.respawn();
            const again = await readyOrigin(state);
            if (again !== undefined && again !== deadOrigin) replacedOrigins.add(deadOrigin);
            return again;
        };

        // Already-routed `/bili/` model requests (launcher settings overlay):
        // routing is done, but plugin headers still decide wire vs plugin
        // mode — stamp and pass through untouched otherwise.
        const routedTarget = routedBiliModelUrl(url);
        if (routedTarget !== undefined) {
            // #1117: routing already happened (settings overlay), so an
            // unattributed caller cannot be refused here — mark it for
            // byte-untouched passthrough instead of letting it ride the
            // pipeline as an anonymous client. Its failures are not ours to
            // recover: the host's own attributed traffic drives the respawn
            // below, and once a replacement lands the pre-emptive reroute
            // carries unattributed riders along (still passthrough-marked).
            const unattributed = state.takeoverGate !== undefined && !state.takeoverGate(routedTarget);
            const routedExtra = unattributed ? { [BILI_PASSTHROUGH_HEADER]: "1" } : state.headersFor?.(routedTarget);
            if (unattributed) {
                const stamped = withHeaders(input, init, routedExtra);
                state.onDispatch?.(url, "direct");
                return orig(stamped.input, stamped.init);
            }
            let target = url;
            const baked = new URL(url);
            if (replacedOrigins.has(baked.origin)) {
                // This URL was baked against an origin we already verified
                // dead-and-replaced (#1130) — reroute it before paying
                // another connection failure.
                const fresh = await readyOrigin(state);
                if (fresh !== undefined && fresh !== baked.origin) target = `${fresh}${baked.pathname}${baked.search}`;
            }
            const stamped = withHeaders(target === url ? input : makeTarget(target), init, routedExtra);
            try {
                state.onDispatch?.(target, target === url ? "self" : "retry");
                return await orig(stamped.input, stamped.init);
            } catch (err) {
                // The overlay bakes a specific proxy origin into these URLs;
                // that proxy can die mid-session when its owning launcher
                // exits while later sessions still ride it (#1130). A
                // network-level failure (undici TypeError) triggers one
                // recovery + one retry; if no replacement comes up, degrade
                // to a direct send of the embedded upstream instead of
                // failing the request forever. Recovery re-attempts on every
                // subsequent failure — only this path can reroute the
                // overlay-baked URLs.
                if (!(err instanceof TypeError)) throw err;
                const deadOrigin = new URL(target).origin;
                const again = await recover(deadOrigin);
                if (again !== undefined && again !== deadOrigin) {
                    const u = new URL(target);
                    const retried = `${again}${u.pathname}${u.search}`;
                    const restamped = withHeaders(makeTarget(retried), init, routedExtra);
                    state.onDispatch?.(retried, "retry");
                    return await orig(restamped.input, restamped.init);
                }
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    console.error(`bili-native: no live proxy — model requests go direct (uncompressed): ${routedTarget}`);
                }
                state.onDispatch?.(routedTarget, "direct");
                return orig(makeTarget(routedTarget), init);
            }
        }
        if (!isModelApiUrl(url)) return orig(input, init);
        // #1117: URL shape alone cannot claim a request — every model call in
        // the process hits the same endpoints. When the host supplies an
        // attribution gate, an unattributed caller keeps its original URL and
        // sends direct (never touches a bili proxy).
        if (state.takeoverGate !== undefined && !state.takeoverGate(url)) {
            state.onDispatch?.(url, "direct");
            return orig(input, init);
        }

        const origin = await readyOrigin(state);
        if (origin === undefined) {
            // Bootstrap failed or timed out — NEVER break the agent: send
            // direct (uncompressed) and say so once.
            if (!warned) {
                warned = true;
                console.error(`bili-native: proxy not ready — model request goes direct (uncompressed): ${url}`);
            }
            state.onDispatch?.(url, "direct");
            return orig(input, init);
        }
        // Attach mode rewrites exactly like spawn mode (#809 semantics —
        // opencode's attach probe+rewrite; the V1 fetch patch relies on it to
        // catch providers without an explicit baseURL). For dsh under the
        // `bili dsh` launcher this is doubly safe: settings-overlay URLs are
        // already `/bili/`-shaped and take the routed branch above, and
        // rewriting a raw upstream URL to the loopback proxy bypasses the
        // MITM envs entirely (an http loopback target is never proxied).
        if (url.startsWith(`${origin}/`)) {
            state.onDispatch?.(url, "self");
            return orig(input, init);
        }
        const first = makeTarget(`${origin}/bili/${url}`);
        state.onDispatch?.(`${origin}/bili/${url}`, "rewrite");
        try {
            const stamped = withHeaders(first, init, state.headersFor?.(url));
            return await orig(stamped.input, stamped.init);
        } catch (err) {
            // The proxy can die mid-session (its parent watchdog fires when
            // the FIRST owner exits while later sessions still ride it —
            // spawned, or shared-attached via another launcher, #1130). A
            // network-level failure (undici throws TypeError) triggers one
            // recovery + one retry.
            if (err instanceof TypeError) {
                const again = await recover(origin);
                if (again !== undefined) {
                    const retried = makeTarget(`${again}/bili/${url}`);
                    state.onDispatch?.(`${again}/bili/${url}`, "retry");
                    const stamped = withHeaders(retried, init, state.headersFor?.(url));
                    return await orig(stamped.input, stamped.init);
                }
                // No replacement available — this session runs direct for its
                // lifetime. Degrade exactly like a bootstrap failure: actually
                // send the request direct, then let the owner clear proxy-owned
                // state.
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    console.error(`bili-native: proxy respawn failed — model requests go direct (uncompressed): ${url}`);
                }
                state.onDispatch?.(url, "direct");
                return orig(input, init);
            }
            throw err;
        }
    };

    globalThis.fetch = patched as typeof globalThis.fetch;
    g[INTERCEPT_FLAG] = true;
    return true;
}

/** Test-only: drop the patch guard so a suite can install again. The
 *  caller owns restoring globalThis.fetch. */
export function _resetForTest(): void {
    const g = globalThis as Record<string, unknown>;
    delete g[INTERCEPT_FLAG];
}
