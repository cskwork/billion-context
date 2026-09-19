import { markDirty, type Session } from "./session.js";
import { log as loggerLog } from "./logger.js";

/**
 * #498: weak overflow signals. A 400 with a parseable window is a STRONG
 * overflow signal (server.ts learns from it directly). But an upstream that
 * dies mid-stream instead — truncation, timeout — fails NON-400, and on
 * sglang-style backends an oversized input manifests exactly this way: the
 * prompt is accepted, then the stream cuts with no completion event. Those
 * failures carry no window number, so they can never teach the proxy
 * anything on their own. What we CAN observe: the failure kept happening at
 * or above demonstrated capability. A single truncation is indistinguishable
 * from network noise (that is why the loop retries it once, #413); three
 * such truncations inside a quarter hour are a pattern.
 *
 * #901: "demonstrated capability" — NOT the trusted window. The counting
 * baseline is the largest input a recent successful turn actually got through
 * (recordProvenInput on genuine completions only). A failure at or below that
 * level cannot be a window overflow: the upstream demonstrably accepts larger
 * payloads, so the cut is instability noise and is dropped. With no success
 * sample yet, capability is unknown and the failure counts — an oversized
 * FIRST request under an inflated trusted window must still be learnable,
 * which the old ≥90%-of-trusted gate made structurally impossible (every
 * overflow failure landed below the gate, so the learner starved exactly
 * where the deployment was broken).
 *
 * When the pattern fires we learn NOTHING about the window (#969): the
 * failing input's size is a guess, and a persisted guess kept throttling
 * sessions far below their real window (9router: 18320 → 16161 learned from
 * non-window failures, unretractable because preflight never forwards the
 * over-window payload that would have produced a contradicting success).
 * The upstream states the real window itself when it rejects with one —
 * that path (server.ts inspectContextOverflow → confirmedContextLimits) is
 * the ONLY source of a learned window. What the weak pattern still does:
 * arm the emergency shrink so the next turn compresses below the failing
 * size (a one-shot action, no persisted limit). This unblocks the
 * #351/#499 failure family (oversized requests never succeed, never cache)
 * without letting mid-stream noise shrink the declared window.
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

// #901: how many recent successful turns feed the capability baseline per
// model/scalar. A bounded ring (not a sticky max) so a mid-life upstream
// resize drains out within PROVEN_MAX_SAMPLES smaller successes.
const PROVEN_MAX_SAMPLES = 100;
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

/** #969: the ONLY learned-window store is confirmedContextLimits — windows
 * the upstream itself stated in an overflow rejection. Legacy speculative
 * values (written by pre-#969 builds) are ignored everywhere; retraction
 * still deletes them so stale state drains. */
export function resolveLearnedLimit(session: Session, model?: string): number | undefined {
    return resolveConfirmedLimit(session, model) ?? resolveConfirmedLimit(session);
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
    // #857: retraction's premise is "a later turn SUCCEEDED with reported
    // input above" — only a usage-grounded measurement can prove that. An
    // estimate-derived (or legacy-unmarked) baseline exceeding a REAL
    // confirmed window is #857's poison pattern, not staleness evidence.
    if (session.stats?.lastInputTokensSource !== "usage") return false;
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

// #901: capability baseline storage (metadata persists wholesale via
// persist.ts — additive fields, no format version bump).
const PROVEN_INPUTS_KEY = "provenInputs";
const PROVEN_INPUT_KEY = "provenInput";

function pushProvenSample(arr: number[], total: number): void {
    arr.push(total);
    if (arr.length > PROVEN_MAX_SAMPLES) arr.shift();
}

/** #901: record that a completed turn got `total` input tokens through the
 *  upstream — demonstrated capability for the counting baseline. Call ONLY on
 *  genuine completions (terminal event / clean JSON), never on abort or settle
 *  paths: a truncated round's own sniffed usage would poison the baseline with
 *  the failing request's size and make `input > baseline` false for that very
 *  failure. */
export function recordProvenInput(session: Session, total: number, model?: string): void {
    if (!(total > 0)) return;
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    if (model) {
        const map = (md[PROVEN_INPUTS_KEY] ?? {}) as Record<string, number[]>;
        const arr = map[model] ?? [];
        pushProvenSample(arr, total);
        map[model] = arr;
        md[PROVEN_INPUTS_KEY] = map;
    } else {
        const arr = (md[PROVEN_INPUT_KEY] ?? []) as number[];
        pushProvenSample(arr, total);
        md[PROVEN_INPUT_KEY] = arr;
    }
    session.metadata = md;
    markDirty(session);
}

/** #901: the capability baseline — largest recent successful input for the
 *  model, falling back to the session scalar (same convention as the
 *  learned/confirmed resolvers). Undefined when no success sample exists: the
 *  caller then treats capability as unknown and counts the failure. */
export function resolveProvenBaseline(session: Session, model?: string): number | undefined {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    let samples: number[] | undefined;
    if (model) {
        const map = md[PROVEN_INPUTS_KEY] as Record<string, number[]> | undefined;
        samples = map?.[model];
    }
    if (!samples || samples.length === 0) samples = md[PROVEN_INPUT_KEY] as number[] | undefined;
    return provenMax(samples);
}

/** #901: display aid (web session page / stats endpoint) — the proven max
 *  across ALL models of the session, so the trusted-vs-demonstrated window
 *  gap is visible without knowing which model ran. */
export function sessionProvenMax(session: Session): number | undefined {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const all: number[] = [...((md[PROVEN_INPUT_KEY] as number[] | undefined) ?? [])];
    const map = md[PROVEN_INPUTS_KEY] as Record<string, number[]> | undefined;
    if (map) for (const v of Object.values(map)) all.push(...v);
    return provenMax(all);
}

function provenMax(samples: number[] | undefined): number | undefined {
    if (!samples || samples.length === 0) return undefined;
    let max = 0;
    for (const v of samples) if (typeof v === "number" && v > max) max = v;
    return max > 0 ? max : undefined;
}

/**
 * Record a non-400 stream failure (truncation / timeout) for this session.
 * Counts against the capability baseline (#901): a failure above the largest
 * recent successful input (or with no success sample yet) may be an overflow;
 * at or below it, it is instability noise. Arms the emergency shrink after
 * MIN_EVENTS counted repeats inside WINDOW_MS. `inputTokens` is the failing
 * request's input size when known (usage already sniffed), else the last known
 * input.
 */
export function noteWeakOverflow(
    session: Session,
    opts: { inputTokens?: number; model?: string; reason: string },
): void {
    const input = opts.inputTokens && opts.inputTokens > 0 ? opts.inputTokens : session.stats?.lastInputTokens ?? 0;
    if (input <= 0) return;
    // #901: see header — the trusted window no longer gates counting.
    const baseline = resolveProvenBaseline(session, opts.model);
    if (baseline !== undefined && input <= baseline) {
        loggerLog("warn", `[${session.id}] weak overflow cut below proven capability (input ${input} ≤ baseline ${baseline}, ${opts.reason}) — not counted`);
        return;
    }
    const window = resolvedWindow(session, opts.model);
    const usagePct = window > 0 ? `usage ${Math.round((input / window) * 100)}%` : "no configured window";

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
        loggerLog("warn", `[${session.id}] weak overflow signal ${state.events.length}/${MIN_EVENTS} (${usagePct}, ${opts.reason})`);
        return;
    }
    states.delete(session.id);

    const reqModel = opts.model;
    // #969: ground truth governs, and NOTHING is learned without it. While a
    // CONFIRMED window (learned from an actual upstream overflow rejection)
    // exists for this model it is untouched; without one the pattern still
    // does not write any window — the failing input's size is a guess, and a
    // persisted guess is how #969's session shrank to 16161 forever. The
    // transient emergency shrink below still unblocks the loop either way.
    const confirmed = resolveConfirmedLimit(session, reqModel);
    // A mid-stream death ABOVE a governing confirmed window cannot be a window
    // overflow (above the real window the upstream rejects outright, it does
    // not kill mid-stream) — cap the armed value at the window so #570's
    // retraction never reads this failure's size as "a later success".
    const armInput = confirmed !== undefined && confirmed > 0 ? Math.min(input, confirmed) : input;
    if (confirmed !== undefined && confirmed > 0) {
        loggerLog("warn", `[${session.id}] weak overflow pattern (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — confirmed window ${confirmed} governs (failing input ${input}); arming emergency shrink only, learned window untouched`);
    } else {
        loggerLog("warn", `[${session.id}] weak overflow pattern (${MIN_EVENTS}× high-usage failures, ${opts.reason}, input ${input}) — no confirmed window; arming emergency shrink only, no window learned (#969)`);
    }
    if (!session.stats) session.stats = { lastInputTokens: armInput, lastInputTokensSource: "estimate" } as Session["stats"];
    else if (armInput > session.stats.lastInputTokens) {
        // #857: armInput is an upper bound on the failing request's input size,
        // not an upstream usage report — tag it so evidence-grade consumers skip it.
        session.stats.lastInputTokens = armInput;
        session.stats.lastInputTokensSource = "estimate";
    }
    markDirty(session);
}

export function resetWeakOverflow(sessionId: string): void {
    states.delete(sessionId);
}
