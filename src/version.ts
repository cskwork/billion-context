import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The proxy's own identity, read from package.json at runtime — works in both
// dev (tsx: src/version.ts → ../package.json) and bundled (tsup: dist/*.js →
// ../package.json). Single source for the CLI banner, the /acp panel header,
// and the acp_status surface-meta host line.
function readPkgField(field: string, fallback: string): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(readFileSync(pkg, "utf8"))[field] as string) ?? fallback;
    } catch {
        return fallback;
    }
}

export const VERSION = readPkgField("version", "dev");
export const PACKAGE_NAME = readPkgField("name", "billion-context");
