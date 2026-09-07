import { markDirty, type Session } from "./session.js";
import { log as loggerLog } from "./logger.js";

/**
 * #498: weak overflow signals. A 400 with a parseable window is a STRONG
 * overflow signal (server.ts learns from it directly). But an upstream that
 * dies mid-stream instead — truncation, timeout — fails NON-400, and on
 * sglang-style backends an oversized input manifests exactly this way: the
 * prompt is accepted, then the stream cuts with no completion event. Those
 * failures carry no window number, so they can never teach the proxy
 * anything on their own. What we CAN observe: the request was at high usage
 * AND it kept failing. A single truncation is indistinguishable from network
 * noise (that is why the loop retries it once, #413); three high-usage
 * truncations inside a quarter hour are a pattern.
 *
 * When the pattern fires we learn the failing input size as a conservative
 * window (shrink-only, mirroring the 400-without-window path: the payload
 * was above the real window, so its size is an upper bound) and arm the
 * emergency shrink so the next turn compresses below it. This unblocks the
 * #351/#499 failure family: oversized requests never succeed, never cache,
 * and never self-heal — without this, the session loops on truncated
 * streams until the client gives up.
 *
 * #570: everything learned here is a HYPOTHESIS. A high-usage truncation
 * cannot be distinguished in-band from other mid-stream deaths (upstream KV
 * exhaustion under concurrent sessions, OOM, network reset), so a confirmed
 * pattern can be a false positive that permanently throttles the session
 * below its true window once persisted. Two guards make the mechanism
 * self-correcting:
 *   - PROVENANCE: strong evidence (an actual non-2xx overflow rejection)
 *     lives in metadata.confirmedContextLimits and takes precedence over any
 *     weak hypothesis; noteWeakOverflow never writes while a confirmed
 *     window governs, so speculation can no longer clobber ground truth.
 *   - RETRACTION: a learned/confirmed window is deleted as soon as a later
 *     turn SUCCEEDS with upstream-reported input above it (retractStaleLearnedLimits,
 *     called from server.ts handle() before self-heal resolution) — the
 *     upstream demonstrably accepted more than the "window", so the value is
 *     stale regardless of how it was learned. A true overflow can never be
 *     contradicted this way: a request above the real window cannot succeed,
 *     and failed turns cannot fake one — while a window governs, their armed
 *     lastInputTokens is capped at the governing value (a parsed overflow
 *     resets it to exactly the learned window).
 */

const MIN_USAGE = 0.9;
const WINDOW_MS = 15 * 60 * 1000;
const MIN_EVENTS = 3;
const MAX_TRACKED_SESSIONS = 512;
// #570 retraction margin: lastInputTokens is upstream-reported on success but
// estimate-netted after folds — only retract beyond this so estimation noise
// can't undo a genuinely-needed small window (a false retraction self-heals:
// the next overflow re-learns).
const RETRACT_MARGIN_PCT = 0.03;
const RETRACT_MIN_DELTA = 256;

interface WeakOverflowState {
    events: number[];
}

const states = new Map<string, WeakOverflowState>();

/** Strong evidence only: windows the upstream itself stated in an overflow
 *  rejection (or established from a rejected payload's size). Per-model entry
 *  first, then the model-unknown scalar fallback. */
export function resolveConfirmedLimit(session: Session, model?: string): number | undefined {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const map = md.confirmedContextLimits as Record<string, number> | undefined;
    return (model ? map?.[model] : undefined) ?? (md.confirmedContextLimit as number | undefined);
}

/** Weak hypotheses only: values written by noteWeakOverflow (and legacy
 *  stores, where weak and strong values share these fields). */
export function resolveSpeculativeLimit(session: Session, model?: string): number | undefined {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const map = md.learnedContextLimits as Record<string, number> | undefined;
    return (model ? map?.[model] : undefined) ?? (md.learnedContextLimit as number | undefined);
}

/** Best known limit for this session/model (#570 provenance order):
 *  confirmed per-model > speculative per-model > confirmed scalar > speculative scalar. */
export function resolveLearnedLimit(session: Session, model?: string): number | undefined {
    const perModel = model
        ? (resolveConfirmedLimit(session, model) ?? resolveSpeculativeLimit(session, model))
        : undefined;
    return perModel ?? resolveConfirmedLimit(session) ?? resolveSpeculativeLimit(session);
}

/** #570: a window that a later SUCCESSFUL turn exceeded is stale — the
 *  upstream accepted more input than the "window", so it is a false positive
 *  (KV pressure / OOM / network death counted as overflow) or the server was
 *  resized. Delete every stale value for this model (plus the model-unknown
 *  scalars) so the configured window applies again. Returns true when
 *  anything was retracted. */
export function retractStaleLearnedLimits(session: Session, model?: string): boolean {
    const x = session.stats?.lastInputTokens ?? 0;
    if (!(x > 0)) return false;
    const stale = (v: unknown): v is number =>
        typeof v === "number" && v > 0 && x - v >= Math.max(RETRACT_MIN_DELTA, v * RETRACT_MARGIN_PCT);
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const removed: string[] = [];
    const cm = md.confirmedContextLimits as Record<string, number> | undefined;
    const lm = md.learnedContextLimits as Record<string, number> | undefined;
    if (model) {
        if (cm && stale(cm[model])) { removed.push(`confirmed ${cm[model]}`); delete cm[model]; }
        if (lm && stale(lm[model])) { removed.push(`learned ${lm[model]}`); delete lm[model]; }
    }
    if (stale(md.confirmedContextLimit)) { removed.push(`confirmed ${String(md.confirmedContextLimit)}`); delete md.confirmedContextLimit; }
    if (stale(md.learnedContextLimit)) { removed.push(`learned ${String(md.learnedContextLimit)}`); delete md.learnedContextLimit; }
    if (removed.length === 0) return false;
    session.metadata = md;
    loggerLog("warn", `[${session.id}] retracted stale context window(s) [${removed.join(", ")}] for ${model ?? "(unknown model)"} — a later turn succeeded at ${x} input tokens above them; using the configured window again`);
    markDirty(session);
    return true;
}

function resolvedWindow(session: Session, model?: string): number {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const learned = resolveLearnedLimit(session, model);
    const effective = md.effectiveContextLimit as number | undefined;
    const candidates = [learned, effective].filter((v): v is number => typeof v === "number" && v > 0);
    if (candidates.length === 0) return 0;
    return Math.min(...candidates);
}

/**
 * Record a non-400 stream failure (truncation / timeout) for this session.
 * Only counts when usage was already high; arms the emergency shrink after
 * MIN_EVENTS repeats inside WINDOW_MS. `inputTokens` is the failing request's
 * input size when known (usage already sniffed), else the last known input.
 */
export function noteWeakOverflow(
    session: Session,
    opts: { inputTokens?: number; model?: string; reason: string },
): void {
    const window = resolvedWindow(session, opts.model);
    if (window <= 0) return;
    const input = opts.inputTokens && opts.inputTokens > 0 ? opts.inputTokens : session.stats?.lastInputTokens ?? 0;
    if (input <= 0) return;
    if (input / window < MIN_USAGE) return;

    if (states.size > MAX_TRACKED_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
    }
    const state = states.get(session.id) ?? { events: [] };
    const now = Date.now();
    state.events = state.events.filter((t) => now - t < WINDOW_MS);
    state.events.push(now);
    states.set(session.id, state);
    if (state.events.length < MIN_EVENTS) {
        loggerLog("warn", `[${session.id}] weak overflow signal ${state.events.length}/${MIN_EVENTS} (usage ${Math.round((input / window) * 100)}%, ${opts.reason})`);
        return;
    }
    states.delete(session.id);

    const md = ((session.metadata ?? {}) as Record<string, unknown>);
    const reqModel = opts.model;
    // #570: ground truth governs. While a CONFIRMED window (learned from an
    // actual upstream overflow rejection) exists for this model, a speculative
    // truncation count must not overwrite it with a smaller guess — that is
    // exactly how KV-pressure false positives poisoned real windows. The
    // transient emergency shrink below still unblocks the loop either way.
    const confirmed = resolveConfirmedLimit(session, reqModel);
    // A mid-stream death ABOVE a governing confirmed window cannot be a window
    // overflow (above the real window the upstream rejects outright, it does
    // not kill mid-stream) — cap the armed value at the window so #570's
    // retraction never reads this failure's size as "a later success".
    const armInput = confirmed !== undefined && confirmed > 0 ? Math.min(input, confirmed) : input;
    if (confirmed !== undefined && confirmed > 0) {
        loggerLog("warn", `[${session.id}] weak overflow confirmed (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — confirmed window ${confirmed} governs (failing input ${input}); arming emergency shrink only, learned window untouched`);
    } else {
        if (md.learnedContextLimits === undefined) md.learnedContextLimits = {};
        const learnedMap = md.learnedContextLimits as Record<string, number>;
        const prev = (reqModel ? learnedMap[reqModel] : undefined) ?? (md.learnedContextLimit as number | undefined);
        // Shrink-only: a previously learned (smaller) value is the tighter bound.
        if (prev === undefined || input < prev) {
            if (reqModel) learnedMap[reqModel] = input;
            else md.learnedContextLimit = input;
            session.metadata = md;
            loggerLog("warn", `[${session.id}] weak overflow confirmed (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — learned conservative window ${input} for ${reqModel ?? "(unknown model)"} (was ${prev ?? "unset"}); arming emergency shrink`);
        } else {
            loggerLog("warn", `[${session.id}] weak overflow confirmed (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — conservative window ${input} not below learned ${prev}; arming emergency shrink only`);
        }
    }
    if (!session.stats) session.stats = { lastInputTokens: armInput } as Session["stats"];
    else session.stats.lastInputTokens = Math.max(session.stats.lastInputTokens, armInput);
    markDirty(session);
}

export function resetWeakOverflow(sessionId: string): void {
    states.delete(sessionId);
}
