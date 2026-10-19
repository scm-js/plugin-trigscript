/**
 * A view of `ui.lines` is put together again only on a frame when something it reads was written (TrigScript 4, S2).
 * The structured compiler lowers the view behind a flag of the program's (`dirty`); this pass finds what the view reads —
 * the program's variables and arrays — and sets the flag after every statement that writes one of them, wherever it is:
 * the program's body, its tasks, its functions. A view that reads the game itself (units, the players' input, a random
 * number, the game's tables) cannot be followed this way and is put together every frame, as it would be without the flag.
 * A call of a function of the script's own (`thousands(score)`, `clock(t)`) is followed into the function: what it reads
 * of the program is what the view reads (its parameters and its own variables aside), and a function that reads the
 * game makes the view one that does.
 */
import type { ArrayDecl, FuncDecl, Program, Stmt } from "./ir";

/** A view as the structured compiler leaves it: its flag, and the statements that put its text together. */
export interface View { dirty: string; declare: Stmt; build: Stmt[] }

/** What a view reads that only the game knows: never followed. */
const GAME_READS: ReadonlySet<string> = new Set(["input", "randomInt", "random", "read", "tableRead", "unitField", "cond", "edge", "running", "unitAlive", "unitFlag", "pick", "pop"]);

/** The statements that hold lists of statements, by the fields that hold them. */
const LISTS = ["body", "then", "else", "update"] as const;

/** The array an array's cells are part of: a window (`slice`) is its whole's, and so on down. */
function rootOf(arrays: Map<string, ArrayDecl>, id: string): string {
  let a = arrays.get(id);
  const seen = new Set<string>();
  while (a?.slice && !seen.has(a.id)) { seen.add(a.id); a = arrays.get(a.slice.of) ?? a; if (a.id === id) break; }
  return a?.id ?? id;
}

/** What a function reads of the program, by its id: the same as a view's, its parameters left out; null when it reads the game. */
type FunctionReads = Map<string, Set<string> | null>;

/** The variables and arrays a view reads (arrays by their whole), or null when it reads the game or calls a function that does. */
function readsOf(build: Stmt[], arrays: Map<string, ArrayDecl>, functions: Map<string, FuncDecl> = new Map(), known: FunctionReads = new Map()): Set<string> | null {
  const reads = new Set<string>();
  const declared = new Set<string>();
  let game = false;
  /** A called function's reads, worked out once; one that calls itself, while it is being worked out, adds nothing more. */
  const ofFunction = (id: string): Set<string> | null => {
    if (known.has(id)) return known.get(id)!;
    const f = functions.get(id);
    if (!f) return null;
    known.set(id, new Set());
    const r = readsOf(f.body, arrays, functions, known);
    if (r) { for (const p of f.params) r.delete(p.id); if (f.result) r.delete(f.result.decl.id); }
    known.set(id, r);
    return r;
  };
  const visit = (o: unknown): void => {
    if (game || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    const n = o as Record<string, unknown>;
    const kind = n.kind;
    if (typeof kind === "string") {
      if (GAME_READS.has(kind)) { game = true; return; }
      const fn = (kind === "call" || kind === "textCall") ? (n.call as { fn?: string } | undefined)?.fn : undefined;
      if (fn) {
        const r = ofFunction(fn);
        if (!r) { game = true; return; }
        for (const id of r) reads.add(id);
      }
      if ((kind === "var" || kind === "textVar" || kind === "unitVar") && typeof n.id === "string") reads.add(n.id);
      if (typeof n.array === "string") reads.add(rootOf(arrays, n.array));
      for (const f of ["addr", "block", "chars"]) if (kind === "textAt" && typeof n[f] === "string") reads.add(rootOf(arrays, n[f] as string));
      if (kind === "declare" && n.decl) declared.add((n.decl as { id: string }).id);
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") visit(v);
  };
  visit(build);
  if (game) return null;
  for (const d of declared) reads.delete(d);
  return reads;
}

/** What a statement writes itself — not what the lists inside it do, which are walked on their own. */
function writes(s: Stmt, arrays: Map<string, ArrayDecl>): string[] {
  const array = (id: string) => rootOf(arrays, id);
  switch (s.kind) {
    case "declare": return [s.decl.id];
    case "assign": case "assignBool": case "assignUnit": case "assignText": return [s.target];
    case "store": case "push": case "pop": case "setLength": case "declareArray": return [array(s.array)];
    case "storeText": return [array(s.addr), array(s.block), array(s.chars)];
    case "releaseText": return [array(s.block)];
    case "textLoop": return [s.decl.id];
    case "unitLoop": return s.was ? [s.decl.id, s.was.id] : [s.decl.id];
    default: return [];
  }
}

/** Whether something inside a statement's own expressions (not its lists) takes from an array: `xs.pop()` as a value. */
function popsInside(s: Stmt, arrays: Map<string, ArrayDecl>, into: string[]): void {
  const visit = (o: unknown, top: boolean): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { if (!top) o.forEach((x) => visit(x, false)); return; }
    const n = o as Record<string, unknown>;
    if (n.kind === "pop" && typeof n.array === "string" && !top) into.push(rootOf(arrays, n.array));
    for (const [k, v] of Object.entries(n)) if (v && typeof v === "object" && !(top && (LISTS as readonly string[]).includes(k))) visit(v, false);
  };
  visit(s, true);
}

/** The flag of every view that reads what `s` writes, set after it. */
function after(s: Stmt, views: { dirty: string; reads: Set<string> }[], arrays: Map<string, ArrayDecl>): Stmt[] {
  const written = writes(s, arrays);
  popsInside(s, arrays, written);
  // A call that comes back into its function puts saved variables back when it returns.
  if (s.kind === "call" && s.call.saves) written.push(...s.call.saves.vars, ...s.call.saves.arrays.map((a) => rootOf(arrays, a)));
  if (!written.length) return [];
  return views.filter((v) => written.some((id) => v.reads.has(id))).map((v) => ({ kind: "assign", target: v.dirty, value: { kind: "const", value: 1 }, at: s.at, label: "label" in s ? s.label : "" } as Stmt));
}

/** Every list of statements in the program, the flag set after each statement that writes what a view reads. */
export function markViewWrites(program: Program, views: View[]): void {
  if (!views.length) return;
  // The flags first of all, set: a write anywhere before the ui.lines line already sets one.
  program.body.unshift(...views.map((v) => v.declare));
  const arrays = new Map(program.arrays.map((a) => [a.id, a]));
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));
  const known: FunctionReads = new Map();
  const followed = views.flatMap((v) => {
    const reads = readsOf(v.build, arrays, functions, known);
    return reads ? [{ dirty: v.dirty, reads }] : [];
  });
  // A view that reads the game is put together every frame: its flag stays set.
  for (const v of views) if (!followed.some((f) => f.dirty === v.dirty)) markAlways(v);
  if (!followed.length) return;
  const own = new Set(views.flatMap((v) => v.build));
  const list = (stmts: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (const s of stmts) {
      walk(s);
      out.push(s);
      // The view's own statements write only what they declare: nothing it reads.
      if (!own.has(s)) out.push(...after(s, followed, arrays));
    }
    return out;
  };
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const n = o as Record<string, unknown>;
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v) && (LISTS as readonly string[]).includes(k) && v.every(isStmt)) n[k] = list(v as Stmt[]);
      else if (k === "iterations" || k === "branches") n[k] = (v as Stmt[][]).map((l) => list(l));
      else if (k === "cases") for (const c of v as { body: Stmt[] }[]) c.body = list(c.body);
      else if (v && typeof v === "object") walk(v);
    }
  };
  program.body = list(program.body);
  for (const f of program.functions ?? []) f.body = list(f.body);
}

const isStmt = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string";

/** A view whose flag nothing clears: the lowering clears it before it builds, so set it again first thing in the build. */
function markAlways(v: View): void {
  v.build.unshift({ kind: "assign", target: v.dirty, value: { kind: "const", value: 1 }, at: v.build[0]?.at ?? { file: "", line: 0, column: 0 }, label: "" } as Stmt);
}
