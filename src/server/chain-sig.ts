import { createHash, timingSafeEqual } from "node:crypto";

// #1078: chain integrity digest. A bili instance that PROCESSED a request
// stamps this header with the sha256 of the exact body bytes it emits; the
// receiving bili recomputes it over the raw inbound buffer BEFORE any
// processing. Mismatch ⇒ a middlebox rewrote the request in transit ⇒ the
// receiver passes the bytes through verbatim instead of running its pipeline
// on content it did not produce. Plain digest, not HMAC/signature: the target
// is an indifferent stripping/rewriting relay, not an adversary (who could
// just run their own bili); forgery resistance would be a drop-in ed25519
// upgrade (node:crypto ships it), zero key management today.
export const BILI_SIG_HEADER = "x-bili-sig";

const SIG_FORMAT = /^sha256:([0-9a-f]{64})$/;

function sha256Hex(body: Buffer | string): string {
    return createHash("sha256").update(typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");
}

/** Stamp `headers` with the digest of the exact bytes about to be sent. Must
 *  be called at EVERY dispatch site where this instance controls the body
 *  (initial forward, compat-role retry hop, fake-completion hint retry), each
 *  over the bytes of THAT emission. */
export function stampChainSig(headers: Record<string, string>, body: Buffer | string): void {
    headers[BILI_SIG_HEADER] = `sha256:${sha256Hex(body)}`;
}

/** Verify an inbound x-bili-sig against the raw received body. "absent" = no
 *  header (older upstream bili — legacy chain behavior unchanged);
 *  "verified" = digest matches; "mismatch" = header present but unparseable or
 *  wrong (rewritten in transit, or forged). */
export function verifyChainSig(header: string | undefined, rawBody: Buffer): "absent" | "verified" | "mismatch" {
    if (header === undefined) return "absent";
    const m = SIG_FORMAT.exec(header);
    if (!m) return "mismatch";
    const expected = Buffer.from(m[1], "hex");
    const actual = createHash("sha256").update(rawBody).digest();
    return timingSafeEqual(expected, actual) ? "verified" : "mismatch";
}

// #1078 S2 fallback: when a relay strips bili's headers, the only remaining
// evidence that some bili already processed this conversation lives in the
// BODY — the per-message ACP render tags (every processed payload carries them
// from turn one — the injected ACP prompt itself embeds one literal example
// tag, and message texts gain real ones) and/or the distinctive
// context-management tool names in the tools array. Matching requires either
// the full tag shape or TWO of the most distinctive tool names together
// ("compress"/"decompress" alone are too generic to trust).
// Verified against the kernel renderer (render-refs acpTag + formatTokens):
//   <acp tokens="2.1K" type="tool:bash">m00175</acp>
// - token values are human-formatted: plain int below 1K, else "N.NK"/"NK";
// - type is a content type or "tool:<name>" (colon allowed);
// - inside a JSON body the attribute quotes are ESCAPED (\") — the pattern
//   tolerates bare or backslashed quotes; the full open→ref→close shape keeps
//   prose containing a partial imitation from tripping the detector.
const ACP_TAG_RE = /\x3cacp\s+tokens=\\?"[0-9]+(?:\.[0-9]+)?K?\\?"\s+type=\\?"[^\\"]*\\?"\s*\x3em[0-9]{1,8}\x3c\/acp\x3e/;

export function detectAcpArtifacts(body: Buffer): boolean {
    if (body.length === 0) return false;
    // Allocation-free pre-filter: ordinary client bodies miss all seeds.
    const tagSeed = body.includes("\x3cacp ");
    const toolSeed = body.includes('"acp_status"') && body.includes('"search_context"');
    if (!tagSeed && !toolSeed) return false;
    // Only reached when a seed hit — decode once for the regex pass (RegExp
    // cannot test Buffer bytes directly: it coerces to "[object ...]").
    const text = body.toString("utf8");
    if (tagSeed && ACP_TAG_RE.test(text)) return true;
    return toolSeed;
}
