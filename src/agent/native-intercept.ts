// Native-mode fetch interception (#519): a globalThis.fetch patch that
// silently routes model-API requests through a bili proxy that the extension
// itself spawned (see pi-native.ts). Verified end-to-end on pi 0.83.6: pi's
// provider stack (pi-stable-ai → Anthropic/OpenAI SDKs) resolves its fetch
// from the global at FIRST-request client construction, so a patch installed
// at extension load always wins. The patch is surgical — it rewrites ONLY
// model-API shaped URLs and leaves every other request untouched.

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
     *  state.origin instead of a spawned one — no respawn, fail-closed on
     *  death. Set by the host entry when BILLION_CONTEXT_ATTACH is present.
     *  In attach mode the patch NEVER rewrites the URL (the launcher's proxy
     *  envs / settings overlay own routing) — it only stamps headers. */
    attach?: boolean;
    /** Optional header hook (#941): called synchronously per model-API
     *  request with the (pre-rewrite) target URL. A non-undefined return is
     *  merged into the outgoing request headers — dsh-native uses it to
     *  stamp x-bili-plugin* once its tools are registered, gating plugin
     *  mode exactly like pi.ts's before_provider_headers stamp. Returning
     *  undefined sends the request untouched (wire mode). */
    headersFor?: (url: string) => Record<string, string> | undefined;
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
    } catch {
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function readyOrigin(state: NativeInterceptState): Promise<string | undefined> {
    if (state.origin !== undefined) return state.origin;
    return withTimeout(state.ready, state.readyTimeoutMs ?? 15000);
}

/** Install the global fetch patch. Idempotent: a second call is a no-op
 *  (returns false) so double-loading the entry cannot double-wrap. */
export function installNativeFetchIntercept(state: NativeInterceptState): boolean {
    const g = globalThis as Record<string, unknown>;
    if (g[INTERCEPT_FLAG] === true) return false;
    const orig = globalThis.fetch;
    let warned = false;

    const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = fetchUrlOf(input);
        if (url === undefined) return orig(input, init);
        // Already-routed `/bili/` model requests (launcher settings overlay):
        // routing is done, but plugin headers still decide wire vs plugin
        // mode — stamp and pass through untouched otherwise.
        const routedTarget = routedBiliModelUrl(url);
        if (routedTarget !== undefined) {
            const stamped = withHeaders(input, init, state.headersFor?.(routedTarget));
            state.onDispatch?.(url, "self");
            return orig(stamped.input, stamped.init);
        }
        if (!isModelApiUrl(url)) return orig(input, init);

        // Rebuild a Request-object input against the rewritten target. A
        // caller-side defect here (already-consumed or locked body) must not
        // reach the proxy-death branch below — respawning would orphan a
        // fresh proxy for a request that can never be sent.
        const makeTarget = (target: string): string | URL | Request =>
            typeof input === "string" || input instanceof URL ? target : new Request(target, input);

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
        // Attach mode: the launcher/user-supplied proxy owns routing (proxy
        // envs, settings overlay, MITM) — leave the URL exactly as written
        // and only stamp headers when the host says so.
        if (state.attach === true) {
            const stamped = withHeaders(input, init, state.headersFor?.(url));
            state.onDispatch?.(url, "rewrite");
            return orig(stamped.input, stamped.init);
        }
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
            // The spawned proxy can die mid-session (its parent watchdog
            // fires when the FIRST owning pi exits while later sessions
            // still ride it). A network-level failure (undici throws
            // TypeError) triggers one respawn + one retry.
            if (err instanceof TypeError && state.respawn !== undefined) {
                state.origin = undefined;
                state.ready = state.respawn();
                const again = await readyOrigin(state);
                if (again !== undefined) {
                    const retried = makeTarget(`${again}/bili/${url}`);
                    state.onDispatch?.(`${again}/bili/${url}`, "retry");
                    const stamped = withHeaders(retried, init, state.headersFor?.(url));
                    return await orig(stamped.input, stamped.init);
                }
                // Respawn failed — this session runs direct for its lifetime.
                // Degrade exactly like a bootstrap failure: actually send the
                // request direct, then let the owner clear proxy-owned state.
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
