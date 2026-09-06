import type { ProviderRoutes } from "./config.js";
import { findRoute } from "./config.js";

/** A resolved wire-compat role map: source role → role name upstream accepts. */
export type CompatRoles = Record<string, string>;

/** Validate a `compat.roles`-shaped value: an object of string → string.
 *  Non-string entries are dropped (a malformed partial never breaks the
 *  proxy); returns undefined when there is nothing usable. */
export function parseCompatRoles(v: unknown): Record<string, string> | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj = v as Record<string, unknown>;
    let out: Record<string, string> | undefined;
    for (const [k, val] of Object.entries(obj)) {
        if (typeof val !== "string" || val.length === 0) continue;
        out ??= {};
        out[k] = val;
    }
    return out;
}

/** Merge the wire-compat role map for one request: global `compat.roles`
 *  (config root) overlaid by the per-provider route entry (longest-URL-prefix
 *  match, identical to the compress-settings lookup). Provider entries win
 *  per key; global keys not overridden still apply. Empty when unconfigured —
 *  the default, byte-for-byte transparent forward (#552). */
export function resolveCompatRoles(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    globalRoles: Record<string, string> | undefined,
): Record<string, string> {
    const providerRoles = findRoute(routes, upstreamUrl)?.compat?.roles;
    if (!globalRoles && !providerRoles) return {};
    return { ...globalRoles, ...providerRoles };
}

/** Apply the role map to a serialized chat-completions or Responses body.
 *  Rewrites exact-match roles only — position, content and every other field
 *  are untouched. Returns the original string (no re-stringify) when nothing
 *  matched, so the default path stays byte-identical.
 *
 *  Applied at the FINAL forward boundary on purpose: every emission site —
 *  client-sent items, bili's injected compress prompt, instructions hoisting,
 *  compress-loop items — is visible there, and the kernel already normalizes
 *  developer→system internally (session state / block IDs / prefix-cache are
 *  computed from pre-wire core messages), so only outbound bytes change. */
/** Object-level role rewrite shared by the forward boundary (string body)
 *  and the compress-retry loops (parsed body). Mutates `parsed` in place;
 *  returns the number of roles rewritten. */
export function applyCompatRolesJson(
    parsed: Record<string, unknown>,
    protocol: "openai" | "responses",
    roles: Record<string, string>,
): number {
    if (Object.keys(roles).length === 0) return 0;
    const items = protocol === "openai" ? parsed.messages : parsed.input;
    if (!Array.isArray(items)) return 0;
    let rewritten = 0;
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const msg = item as Record<string, unknown>;
        if (protocol === "responses" && msg.type !== undefined && msg.type !== "message") continue;
        const role = msg.role;
        if (typeof role !== "string") continue;
        const mapped = roles[role];
        if (mapped === undefined || mapped === role) continue;
        msg.role = mapped;
        rewritten++;
    }
    return rewritten;
}

/** Stop-words that follow "role" in prose ("Invalid role must be one…"):
 *  a captured token equal to one of these means the regex grabbed a word
 *  from the sentence, not a role name. */
const ROLE_CAPTURE_STOPWORDS = new Set([
    "must", "should", "be", "is", "one", "of", "the", "a", "an", "in", "for", "not", "was", "and", "or", "to", "only", "allowed", "supported", "valid", "value", "message", "messages",
]);

const ROLE_REJECTION_PATTERNS = [
    /(?:invalid|unknown|unsupported|unrecognized|unexpected)[a-z ]{0,24}?role\s*[:=]?\s*["'`]?([a-z][a-z0-9_-]{1,31})["'`]?/i,
    /role\s*[:=]?\s*["'`]?([a-z][a-z0-9_-]{1,31})["'`]?\s+(?:is\s+)?not\s+(?:supported|allowed|recognized|valid|accepted)/i,
];

/** Detect an upstream 400 that exists only because of a message role the
 *  provider does not support (e.g. codex ≥0.153 sends "developer";
 *  converting backends answer 400 "Invalid role: developer"). Conservative by
 *  design: status must be 400, the body must blame a role, and the captured
 *  token must look like a role name. Returns the offending role so the
 *  caller can auto-rewrite it to a supported one. */
export function detectRoleRejection(status: number, bodyText: string): { role: string } | null {
    if (status !== 400) return null;
    const head = bodyText.slice(0, 4096);
    for (const re of ROLE_REJECTION_PATTERNS) {
        const m = re.exec(head);
        if (!m) continue;
        const role = m[1].toLowerCase();
        if (ROLE_CAPTURE_STOPWORDS.has(role)) continue;
        return { role };
    }
    return null;
}

export function applyCompatRoles(
    body: string,
    protocol: "openai" | "responses",
    roles: Record<string, string>,
): { body: string; rewritten: number } {
    if (Object.keys(roles).length === 0) return { body, rewritten: 0 };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return { body, rewritten: 0 };
    }
    const rewritten = applyCompatRolesJson(parsed, protocol, roles);
    if (rewritten === 0) return { body, rewritten: 0 };
    return { body: JSON.stringify(parsed), rewritten };
}
