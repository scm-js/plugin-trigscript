/**
 * References from the script to the map's things — `locations.Beacon`, `switches.Door` —
 * and what to do when the map renames one. The references themselves come from the
 * compiler (`CompileResult.refs`): resolved by the checker, so a comment, a string, a
 * parameter that shadows `locations` or `locations["Beacon"]` are told apart from the
 * real thing, and an alias or a namespace import counts. `findReferences` is the
 * textual approximation the editor's links use while typing, where a false link in a
 * comment costs nothing. Pure over strings and the names tables, so the tests need no
 * editor.
 */
import { normalizePath, type MapReference, type ScriptFiles } from "./compiler/compiler";
import type { NameTable } from "./compiler/names";

/** One `object.key` in a text, 1-based positions, the end exclusive. */
export interface Reference {
  key: string;
  line: number;
  column: number;
  endColumn: number;
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** Every `object.key` in a text by its spelling (`locations.Beacon`; not `x.locations.Beacon`, not `locations["…"]`) — for links while typing. */
export function findReferences(text: string, object: string): Reference[] {
  const out: Reference[] = [];
  const re = new RegExp(`(^|[^\\w$.])(${object.replace(/[$]/g, "\\$&")})\\.(${IDENT})`, "g");
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineOf = (offset: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1].length;
    const keyStart = start + m[2].length + 1;
    const line = lineOf(start);
    out.push({ key: m[3], line: line + 1, column: keyStart - starts[line] + 1, endColumn: keyStart - starts[line] + 1 + m[3].length });
  }
  return out;
}

/** A rename the map made: the same value, a key it went by that it no longer does, and the key to use instead. */
export interface Renamed {
  value: number;
  from: string;
  to: string;
}

/**
 * What `after` calls differently from `before`, by value: every key an entry lost, paired
 * with the key it gained in the same place (its identifier for an identifier, its display
 * name for a display name), or its first key when it gained none. A switch's `Switch5`
 * never changes; its custom name does, and that is the key the script used.
 */
export function renamedKeys(before: NameTable, after: NameTable): Renamed[] {
  const out: Renamed[] = [];
  const was = new Map(before.entries.map((e) => [e.value, e.keys]));
  for (const e of after.entries) {
    const old = was.get(e.value);
    if (!old) continue;
    const lost = old.filter((k) => !e.keys.includes(k));
    const gained = e.keys.filter((k) => !old.includes(k));
    lost.forEach((from, i) => out.push({ value: e.value, from, to: gained[i] ?? gained[0] ?? e.keys[0] }));
  }
  return out;
}

/** The renames the script actually mentions (a reference to `object.from` somewhere), so the user is asked about nothing else. */
export function renamesInUse(refs: readonly MapReference[], object: string, renames: Renamed[]): Renamed[] {
  const used = new Set<string>();
  for (const r of refs) if (r.object === object) used.add(r.key);
  return renames.filter((r) => used.has(r.from));
}

/** Every reference to `object.from` made `object.to` — a quoted key stays quoted — and the count of what changed. */
export function replaceReferences(files: ScriptFiles, refs: readonly MapReference[], object: string, renames: Renamed[]): { files: ScriptFiles; count: number } {
  const to = new Map(renames.map((r) => [r.from, r.to]));
  let count = 0;
  const out: ScriptFiles = {};
  for (const [path, text] of Object.entries(files)) {
    const here = refs.filter((r) => normalizePath(r.file) === normalizePath(path) && r.object === object && to.has(r.key));
    if (here.length === 0) { out[normalizePath(path)] = text; continue; }
    const lines = text.split("\n");
    // Right to left within a line, so earlier columns stay valid.
    for (const r of [...here].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const l = lines[r.line - 1];
      if (l === undefined || r.endLine !== r.line) continue;
      const replacement = r.quoted ? JSON.stringify(to.get(r.key)!) : to.get(r.key)!;
      lines[r.line - 1] = l.slice(0, r.column - 1) + replacement + l.slice(r.endColumn - 1);
      count++;
    }
    out[normalizePath(path)] = lines.join("\n");
  }
  return { files: out, count };
}
