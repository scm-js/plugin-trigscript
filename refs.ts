/**
 * References from the script to the map's things — `locations.Beacon`, `switches.Door` —
 * as text: where they are (for the editor's links and hovers), and what to do when the
 * map renames one. Pure over strings and the names tables, so the tests need no editor.
 */
import { normalizePath, type ScriptFiles } from "./compiler/compiler";
import type { NameTable } from "./compiler/names";

/** One `object.key` in a text, 1-based positions, the end exclusive. */
export interface Reference {
  key: string;
  line: number;
  column: number;
  endColumn: number;
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** Every `object.key` in a text (`locations.Beacon`; not `x.locations.Beacon`, not `locations["…"]`). */
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

/** A rename the map made: the same value, a different first key. */
export interface Renamed {
  value: number;
  from: string;
  to: string;
}

/** What `after` calls differently from `before`, by value. */
export function renamedKeys(before: NameTable, after: NameTable): Renamed[] {
  const out: Renamed[] = [];
  const was = new Map(before.entries.map((e) => [e.value, e.keys[0]]));
  for (const e of after.entries) {
    const from = was.get(e.value);
    if (from !== undefined && from !== e.keys[0]) out.push({ value: e.value, from, to: e.keys[0] });
  }
  return out;
}

/** The renames the files actually mention (`object.from` somewhere), so the user is asked about nothing else. */
export function renamesInUse(files: ScriptFiles, object: string, renames: Renamed[]): Renamed[] {
  const used = new Set<string>();
  for (const text of Object.values(files)) for (const r of findReferences(text, object)) used.add(r.key);
  return renames.filter((r) => used.has(r.from));
}

/** Every `object.from` in every file made `object.to`; the count of what changed. */
export function replaceReferences(files: ScriptFiles, object: string, renames: Renamed[]): { files: ScriptFiles; count: number } {
  const to = new Map(renames.map((r) => [r.from, r.to]));
  let count = 0;
  const out: ScriptFiles = {};
  for (const [path, text] of Object.entries(files)) {
    const refs = findReferences(text, object).filter((r) => to.has(r.key));
    if (refs.length === 0) { out[normalizePath(path)] = text; continue; }
    const lines = text.split("\n");
    // Right to left within a line, so earlier columns stay valid.
    for (const r of [...refs].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const l = lines[r.line - 1];
      lines[r.line - 1] = l.slice(0, r.column - 1) + to.get(r.key)! + l.slice(r.endColumn - 1);
      count++;
    }
    out[normalizePath(path)] = lines.join("\n");
  }
  return { files: out, count };
}
