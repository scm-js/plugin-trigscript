/**
 * Running the compiled script: every file was emitted as a CommonJS module, and this
 * links them with a `require` of its own — relative paths resolve against the files in
 * the map, `"trigscript"` resolves to the library the run was given, anything else is
 * an error. The library's names are also in scope as globals, so a script can use
 * `trigger` and `units` without importing them.
 *
 * An error the script throws is reported at the line that threw: the emitted JavaScript
 * carries a source map, and the stack frame of the module's `//# sourceURL` maps back
 * through it. Nothing here depends on TypeScript or the DOM.
 */

export interface RunError {
  message: string;
  /** The script file and 1-based position, when the stack could be read. */
  file?: string;
  line?: number;
  column?: number;
}

export interface LinkedFile {
  /** The emitted JavaScript. */
  js: string;
  /** Its source map (JSON), when emitted. */
  map?: string;
}

/** `./bases` from `ai/main.ts` → `ai/bases`; `../x` climbs; a bare name is left alone. */
export function resolvePath(from: string, spec: string): string {
  const base = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

/** The file a specifier names among `files`: exact, `.ts`, `.js` → `.ts`, `/index.ts`. Null when none. */
export function resolveModule(files: ReadonlySet<string>, from: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const path = resolvePath(from, spec);
  for (const candidate of [path, `${path}.ts`, path.replace(/\.js$/, ".ts"), `${path}/index.ts`]) if (files.has(candidate)) return candidate;
  return null;
}

const SOURCE_URL_PREFIX = "trigscript://";

/**
 * Run the entry module with the library in scope. Resolves to null when the script ran
 * to the end, else to the error it threw, located when possible.
 */
export function runModules(files: ReadonlyMap<string, LinkedFile>, entry: string, library: Record<string, unknown>, moduleName: string): RunError | null {
  const names = new Set(files.keys());
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const globals = Object.keys(library);
  const load = (file: string): Record<string, unknown> => {
    const hit = cache.get(file);
    if (hit) return hit.exports;
    const linked = files.get(file)!;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const require = (spec: string): unknown => {
      if (spec === moduleName) return library;
      const target = resolveModule(names, file, spec);
      if (!target) {
        throw new Error(spec.startsWith(".")
          ? `Cannot find "${spec}" from ${file}: the script's files are ${[...names].join(", ")}.`
          : `Cannot import "${spec}": a script imports its own files (./name) and "${moduleName}" only.`);
      }
      return load(target);
    };
    // `new Function` puts the body two lines down; the sourceURL names the frame for the stack.
    const body = `${linked.js}\n//# sourceURL=${SOURCE_URL_PREFIX}${file}`;
    const fn = new Function("exports", "require", "module", "__filename", ...globals, body) as (...args: unknown[]) => void;
    fn(module.exports, require, module, file, ...globals.map((g) => library[g]));
    return module.exports;
  };
  try {
    load(entry);
    return null;
  } catch (err) {
    return locate(err, files);
  }
}

/** The error's message and, from its stack, where in the script it happened. */
export function locate(err: unknown, files: ReadonlyMap<string, LinkedFile>): RunError {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? "" : "";
  for (const m of stack.matchAll(/trigscript:\/\/([^\s:)]+):(\d+):(\d+)/g)) {
    const file = m[1];
    const linked = files.get(file);
    if (!linked) continue;
    // V8 wraps a Function body as `function anonymous(…\n) {\n<body>`: the body starts on line 3.
    const line = Number(m[2]) - 2;
    const column = Number(m[3]);
    const original = linked.map ? mapPosition(linked.map, line, column) : null;
    return original ? { message, file, line: original.line, column: original.column } : { message, file, line: Math.max(1, line), column };
  }
  return { message };
}

/* ── Source maps ── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(s: string, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const digit = B64.indexOf(s[at.i++]);
    if (digit < 0) throw new Error("bad VLQ");
    result += (digit & 31) << shift;
    shift += 5;
    if ((digit & 32) === 0) break;
  }
  const negative = result & 1;
  result >>= 1;
  return negative ? -result : result;
}

/** The original 1-based position for a generated one (the nearest segment on that line at or before the column). */
export function mapPosition(mapJson: string, line: number, column: number): { line: number; column: number } | null {
  let mappings: string;
  try { mappings = (JSON.parse(mapJson) as { mappings: string }).mappings; } catch { return null; }
  const lines = mappings.split(";");
  if (line < 1 || line > lines.length) return null;
  // Original line/column are relative across the whole file; replay the lines before ours.
  let origLine = 0;
  let origCol = 0;
  let best: { line: number; column: number } | null = null;
  try {
    for (let l = 0; l < line; l++) {
      let genCol = 0;
      for (const seg of lines[l].split(",")) {
        if (!seg) continue;
        const at = { i: 0 };
        genCol += decodeVlq(seg, at);
        if (at.i >= seg.length) continue;
        decodeVlq(seg, at); // source index
        origLine += decodeVlq(seg, at);
        origCol += decodeVlq(seg, at);
        if (l === line - 1 && genCol + 1 <= column) best = { line: origLine + 1, column: origCol + 1 };
        if (l === line - 1 && best === null) best = { line: origLine + 1, column: origCol + 1 };
      }
    }
  } catch {
    return null;
  }
  return best;
}
