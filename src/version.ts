import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The proxy's own identity, read from package.json at runtime — works in both
// dev (tsx: src/version.ts → ../package.json) and bundled (tsup: dist/*.js →
// ../package.json, dist/agent/*.js → ../../package.json) deployments. Single
// source for the CLI banner, the /acp panel header, and the acp_status
// surface-meta host line.
function readPkgField(field: string, fallback: string): string {
    try {
        const here = fileURLToPath(import.meta.url);
        for (const up of ["..", "../.."]) {
            const pkg = path.join(path.dirname(here), up, "package.json");
            try {
                const parsed = JSON.parse(readFileSync(pkg, "utf8"));
                if (typeof parsed[field] === "string") return parsed[field] as string;
            } catch {
                // keep walking up
            }
        }
        return fallback;
    } catch {
        return fallback;
    }
}

export const VERSION = readPkgField("version", "dev");
export const PACKAGE_NAME = readPkgField("name", "billion-context");
