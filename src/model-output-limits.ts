import snapshot from "./models-dev-snapshot.json" with { type: "json" };

/** Slim models.dev table (see scripts/update-models-dev-snapshot.mjs):
 *  per-model output-token limits strictly below MAX_SUMMARY_OUTPUT_TOKENS
 *  (src/preflight.ts). Caps at or above the summary default are omitted —
 *  they can never affect the clamp. Ids appear in both bare ("glm-5.2") and
 *  namespaced ("deepseek/deepseek-v3.1") forms depending on the provider. */
interface ModelsDevSnapshot {
    source: string;
    fetchedAt: string;
    count: number;
    limits: Record<string, number>;
}

const LIMITS: Record<string, number> = (snapshot as ModelsDevSnapshot).limits;

/** #853: the known output-token ceiling for a model id, or null when unknown.
 *  Exact match first; then a single namespaced-suffix retry
 *  ("deepseek/deepseek-v3.1" → "deepseek-v3.1") for provider-prefixed ids —
 *  the same two-step resolution codex-models.ts uses for window lookup.
 *  Unknown ⇒ null ⇒ the caller keeps its default cap. */
export function modelOutputLimit(model: string): number | null {
    const direct = LIMITS[model];
    if (direct !== undefined) return direct;
    const slash = model.indexOf("/");
    if (slash > 0) {
        const suffix = model.slice(slash + 1);
        if (suffix && !suffix.includes("/")) {
            const stripped = LIMITS[suffix];
            if (stripped !== undefined) return stripped;
        }
    }
    return null;
}
