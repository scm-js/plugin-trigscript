/**
 * The standard library a script is checked against — TypeScript's `lib.es2022.d.ts`
 * and everything it references, concatenated into one file with the reference
 * directives stripped. `bundle/build.mjs` writes it to `dist/lib.d.ts` for the compile
 * worker to fetch; the tests build the same text from `node_modules`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const LIB_ENTRY = "lib.es2022.d.ts";

/** The concatenated library text. */
export function defaultLib() {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve("typescript"));
  const seen = new Set();
  const parts = [];
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const text = readFileSync(join(dir, name), "utf8");
    for (const m of text.matchAll(/\/\/\/ <reference lib="([^"]+)" \/>/g)) walk(`lib.${m[1]}.d.ts`);
    parts.push(`// ── ${name} ──\n${text.replace(/\/\/\/ <reference[^\n]*\n/g, "")}`);
  };
  walk(LIB_ENTRY);
  return parts.join("\n");
}
