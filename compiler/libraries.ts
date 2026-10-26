/**
 * Libraries of other plugins': modules written in TrigScript that a plugin provides (`trigscript.build`'s
 * `provideLibrary`) and a script imports by the library's id — `import { patrol } from "stamps/patrol"` — as it imports
 * the standard library by "trigscript/<name>". A module joins a script's files only when something imports it, under
 * the folder below, for the same reason the standard library's do: one may hold a program of its own. What the map
 * keeps of a library (its copy, `script.ts`) and where a library comes from are the plugin's business; the compiler
 * takes the modules by id.
 */

import { LIBRARY_DIR, libraryModule, resolveModule } from "./link";

export { LIBRARY_DIR } from "./link";

/** Each library's modules by id, each module's source by its path in the library ("patrol.ts", "ai/waves.tsx"). */
export type ScriptLibraries = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A library's id: what a script imports it by. Lower case, so that the id is the same on every archive and file system. */
export const LIBRARY_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** A module's path in its library: folders with `/`, ending in `.ts` or `.tsx`. */
export const LIBRARY_PATH = /^(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.]+\.tsx?$/;

/** Where a module of a library is among the script's files. */
export const libraryPath = (id: string, path: string): string => `${LIBRARY_DIR}/${id}/${path}`;

/** Why a library cannot be taken as it is, in a sentence; null when it can. */
export function libraryProblem(id: string, modules: Readonly<Record<string, string>>, reserved: readonly string[] = []): string | null {
  if (!LIBRARY_ID.test(id)) return `"${id}" is not a library id: lower-case letters, digits and "-", starting with a letter.`;
  if (reserved.includes(id)) return `"${id}" is a name TrigScript keeps for itself.`;
  const paths = Object.keys(modules);
  if (paths.length === 0) return `The library "${id}" has no modules.`;
  for (const path of paths) {
    if (!LIBRARY_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) return `"${path}" is not a module path of a library: folders with "/", ending in .ts or .tsx.`;
    if (/\.test\.ts$/i.test(path)) return `"${path}" is a test file: a library's tests stay in its own repository, since a script would run them with its own.`;
    if (typeof modules[path] !== "string") return `The module "${path}" has no source.`;
  }
  return null;
}

const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

/**
 * The library modules a set of files imports, and those they import in turn — of their own library by a relative path,
 * of another library by its id — as files of the script's by their paths there; and the ids of the libraries they are
 * of. A specifier no library has is left for TypeScript to say so.
 */
export function libraryImports(texts: Iterable<string>, libraries: ScriptLibraries): { files: Record<string, string>; used: string[] } {
  const all = new Map<string, string>();
  for (const [id, modules] of Object.entries(libraries)) for (const [path, text] of Object.entries(modules)) all.set(libraryPath(id, path), text);
  const names = new Set(all.keys());
  const files: Record<string, string> = {};
  const used = new Set<string>();
  const add = (file: string) => {
    if (file in files) return;
    files[file] = all.get(file)!;
    used.add(file.slice(LIBRARY_DIR.length + 1).split("/")[0]);
    scan(file, files[file]);
  };
  const scan = (from: string | null, text: string) => {
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1];
      const target = spec.startsWith(".") ? (from ? resolveModule(names, from, spec) : null) : libraryModule(names, spec);
      if (target) add(target);
    }
  };
  for (const text of texts) scan(null, text);
  return { files, used: [...used].sort() };
}
