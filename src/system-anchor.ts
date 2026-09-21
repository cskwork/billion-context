// #1085: sticky head-system anchor for upstream prefix caching. Clients embed
// ambient instructions (AGENTS.md & co.) in the HEAD of every request; when
// those files change mid-session the head bytes change and the provider's
// prefix cache misses the ENTIRE conversation. Fix: the first-seen head text
// becomes a sticky per-session anchor forwarded byte-stable forever; each
// detected change appends one trailing user note carrying the full replacement
// text (opencode's system-context reconcile, adapted for a proxy). Notes are
// wire-ephemeral like the nudge (#451): re-injected from session state every
// turn, never part of the kernel fold space, so they survive restarts and
// compaction without consuming message refs. Past ANCHOR_MAX_NOTES changes the
// anchor is replaced outright — one deliberate cache miss beats an ever-growing
// tail (opencode's Replace parity).

import type { Session } from "./session.js";

export type SystemSurface = "anthropic" | "openai" | "google" | "responses";

interface SurfaceState {
    anchor: string;
    lastSeen: string;
    notes: string[];
}

export interface AnchorOutcome {
    outbound: string;
    notes: string[];
    changed: boolean;
}

/** Volatile-head guard: beyond this many logged changes the head content is
 *  live state by nature (a client baking runtime data into its system prompt)
 *  and anchoring costs more than it saves. */
export const ANCHOR_MAX_NOTES = 8;

const UPDATE_HEADER = "[System context update] These instructions SUPERSEDE all previously loaded ambient instructions:\n\n";
const REMOVED_NOTE = "[System context update] Previously loaded ambient instructions no longer apply.";

function key(surface: SystemSurface): string {
    return `stableSystem.${surface}`;
}

function readState(metadata: Record<string, unknown>, surface: SystemSurface): SurfaceState {
    const raw = metadata[key(surface)];
    if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (typeof r.anchor === "string" && typeof r.lastSeen === "string" && Array.isArray(r.notes)) {
            return {
                anchor: r.anchor,
                lastSeen: r.lastSeen,
                notes: r.notes.filter((n): n is string => typeof n === "string"),
            };
        }
    }
    return { anchor: "", lastSeen: "", notes: [] };
}

function writeState(session: Session, surface: SystemSurface, state: SurfaceState): void {
    session.metadata[key(surface)] = state;
}

function formatNote(incoming: string): string {
    return incoming === "" ? REMOVED_NOTE : `${UPDATE_HEADER}${incoming}`;
}

/** Strict byte comparison — no normalization: prefix caching is a byte game,
 *  normalizing would desync what we forward from what we recorded. Empty heads
 *  are skipped, never anchored. A removed head keeps flowing as the anchor
 *  (stale-but-labeled beats a broken cache); consecutive repeats are no-ops.
 * State persists under session.metadata[`stableSystem.<surface>`]. */
export function reconcileSystemAnchor(
    session: Session,
    surface: SystemSurface,
    incoming: string,
    sessionId: string,
    log: (level: string, msg: string) => void,
): AnchorOutcome {
    const st = readState(session.metadata, surface);
    if (st.anchor === "" && st.lastSeen === "" && st.notes.length === 0) {
        if (incoming === "") return { outbound: "", notes: [], changed: false };
        writeState(session, surface, { anchor: incoming, lastSeen: incoming, notes: [] });
        log("info", `[${sessionId}] stable-system-anchor[${surface}] captured ${incoming.length} chars`);
        return { outbound: incoming, notes: [], changed: false };
    }
    if (incoming === st.lastSeen) {
        return { outbound: st.anchor, notes: st.notes, changed: false };
    }
    const notes = [...st.notes, formatNote(incoming)];
    if (notes.length > ANCHOR_MAX_NOTES) {
        writeState(session, surface, { anchor: incoming, lastSeen: incoming, notes: [] });
        log("warn", `[${sessionId}] stable-system-anchor[${surface}] churn guard tripped (${st.notes.length + 1} change(s) > ${ANCHOR_MAX_NOTES}) — replacing anchor outright, one deliberate cache miss`);
        return { outbound: incoming, notes: [], changed: true };
    }
    writeState(session, surface, { ...st, lastSeen: incoming, notes });
    log("info", `[${sessionId}] stable-system-anchor[${surface}] head-system change detected — forwarding ${st.anchor.length}-char anchor, appending note (${notes.length} total)`);
    return { outbound: st.anchor, notes, changed: true };
}
