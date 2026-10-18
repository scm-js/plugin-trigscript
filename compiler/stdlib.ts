/**
 * The standard library: modules written in TrigScript that ship with the compiler, imported as "trigscript/<name>"
 * (TrigScript 4). A module joins a script's files only when the script imports it — it may hold a program of its own
 * (fog's canvas runs every frame) — under the folder below, where the editor finds it too, for hovers and go to
 * definition. Each is TrigScript like any script's: what it shows a map maker is how the language is used.
 */

import { STDLIB_EXTENSIONS, STDLIB_SOURCES } from "./generated/stdlib";
import { stdlibFile } from "./link";

export { STDLIB_DIR, stdlibFile } from "./link";

/** Each module's source, by its name after "trigscript/": `stdlib/<name>.ts` (or `.tsx`), embedded by `npm run embed`. */
export const STDLIB: Readonly<Record<string, string>> = STDLIB_SOURCES;
/** Each module's extension: `.tsx` for one with JSX in it. */
export const STDLIB_EXT: Readonly<Record<string, ".ts" | ".tsx">> = STDLIB_EXTENSIONS;
/** Where a module of the library is among the script's files. */
export const stdlibPath = (name: string): string => stdlibFile(name, STDLIB_EXT[name] ?? ".ts");

/** The library modules a set of files imports, and those they import in turn. */
export function stdlibImports(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/(?:from|import)\s*["']trigscript\/([A-Za-z0-9_-]+)["']/g)) {
      const name = m[1];
      if (!found.has(name) && name in STDLIB) { found.add(name); scan(STDLIB[name]); }
    }
  };
  for (const t of texts) scan(t);
  return [...found];
}
