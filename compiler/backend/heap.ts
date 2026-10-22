/**
 * Arrays that grow, on the heap (TrigScript 4, the backend: step 9 of the way off eudplib). A map of our own keeps the
 * cells of every growing array in one array of a fixed length that the emitter already lays out — a region of cell
 * triggers, `@heap`, as long as the heap the script's settings give — and each growing array as four numbers of the
 * program's: where its block starts among the heap's cells (0: it has none), how many cells are in use, how many the
 * block has room for, and the block's size class (room 4 is class 0, 8 class 1, …). `growingArrays` rewrites a
 * program's IR so, before the emitter sees it: a read is a cell of the heap under a test of the index against the
 * length, a push a store at the end and an addition, and what needs more room calls the run time's `grow`.
 *
 * Blocks are handed out as the simulator counts them (`simulateIr.ts`, `heap`): a power of two of cells, four at the
 * least; one given back waits in its class's list for the next array that wants that size — the list threaded through
 * the first cell of each block in it, its head a cell of `@heap.free` — and new ground is taken from the bottom up,
 * from cell 1, to the heap's end. So an array runs out at the same push in both, and says so once, as the Python side
 * does. (A made text of a map of our own has a block of its own, `texts.ts`, and takes nothing from the heap.)
 *
 * What it does not take — an array that grows inside another, one of texts, a task's, one a function that calls itself
 * keeps — it leaves as it was, for the emitter to refuse.
 */
import { HEAP_CELLS, HEAP_SMALLEST, heapCells, type ArrayDecl, type At, type BoolExpr, type Call, type CompareOp, type FuncDecl, type NumExpr, type Program, type Stmt, type VarDecl } from "../ir";

/**
 * The numbers a growing array is kept as: where its block is, its length, its room, its block's class — and where its
 * next cell goes (`e`, the block's start plus the length), which a push stores at and a pop reads at, so that neither
 * works an index out.
 */
interface Handle { p: string; n: string; r: string; k: string; e: string; decl: ArrayDecl; through?: NonNullable<ArrayDecl["through"]> }

const k = (value: number): NumExpr => ({ kind: "const", value });
const V = (id: string): NumExpr => ({ kind: "var", id });

/** Whether an expression may do something, or give another value, each time it is worked out: a call, a draw, a pop. */
function impure(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(impure);
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: string };
  // (A cell read by the heap's own functions does nothing: it is a value as a variable is.)
  if (o.kind === "call" && PURE.test((o as { call?: { fn?: string } }).call?.fn ?? "")) return impure((o as { call: Call }).call.params.map((p) => p.init));
  if (o.kind === "call" || o.kind === "pop" || o.kind === "randomInt" || o.kind === "random" || o.kind === "input" || o.kind === "read" || o.kind === "cond") return true;
  return Object.values(o).some((v) => v && typeof v === "object" && impure(v));
}
/** Whether a variable is read or written anywhere in `x`. */
function mentions(x: unknown, id: string): boolean {
  if (Array.isArray(x)) return x.some((y) => mentions(y, id));
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if ((o.kind === "var" && o.id === id) || o.target === id) return true;
  return Object.values(o).some((v) => v && typeof v === "object" && mentions(v, id));
}
/** A statement with every read and write of a variable one of another's. */
function renamed(x: unknown, from: string, to: string): unknown {
  if (Array.isArray(x)) return x.map((y) => renamed(y, from, to));
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  const out = Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? renamed(v, from, to) : v]));
  if (o.kind === "var" && o.id === from) out.id = to;
  if ((o.kind === "assign" || o.kind === "assignBool") && o.target === from) out.target = to;
  return out;
}
/** The heap's functions that only read a cell. */
const PURE = /^@heap\.(get|read|rowRead)\./;

/** The heap's cells and its list of blocks given back: one each for the whole map. */
export const HEAP = "@heap", FREE = "@heap.free";
const HEAP_TOP = "@heap.top", HEAP_SAID = "@heap.said";
/**
 * The map's own variables of the heap (`HEAP_TOP`, `HEAP_SAID`): no program declares them, so no run's start sets them
 * again; each is kept in one cell (`routed`) and read where it is used, so that what one run writes the next reads.
 */
export const HEAP_GLOBALS: readonly VarDecl[] = [HEAP_TOP, HEAP_SAID].map((id) => ({ id, name: "(heap)", kind: "number", shared: true, routed: true, global: true, at: { file: "", line: 0, column: 0 } }));
/** Whether an id is the map's own, the same in every run (the heap's). */
export const isHeapGlobal = (id: string): boolean => id === HEAP || id === FREE || id === HEAP_TOP || id === HEAP_SAID;

/** What the growing arrays take, or why a program is left as it was. */
export function growingArrays(program: Program, cells = HEAP_CELLS): Program {
  const handles = new Map<string, Handle>();
  // (An array that grows inside another — `rows[i]` of `number[][]` — is kept as one that grows alone, its numbers taken
  // from the outer arrays' cells at the row's index before what is done to it, and put back after.)
  for (const a of program.arrays ?? []) {
    if (!a.dynamic || a.slice || a.texts || a.task !== undefined) continue;
    if (a.kind !== "number" && a.kind !== "boolean") continue;
    handles.set(a.id, { p: `${a.id}@p`, n: `${a.id}@n`, r: `${a.id}@r`, k: `${a.id}@k`, e: `${a.id}@e`, decl: a, ...(a.through ? { through: a.through } : {}) });
  }
  if (!handles.size) return program;

  const H = heapCells(cells);
  // The classes of block there can be: 4 · 2^c cells, up to the heap's length.
  let classes = 0;
  while (HEAP_SMALLEST * 2 ** classes <= H) classes++;
  // (The heap is the map's, one for every program and every player's run of one: where new ground starts — less 1, so
  // that the map's 0 is the first ground, cell 1 — and whether running out was said are cells no run declares.)
  const TOP = HEAP_TOP, SAID = HEAP_SAID;
  // The run time's operands: the array that grows as `grow` takes it, and how many cells it needs; what it gives back
  // (the new block, its room and its class, and whether there was one). An array's own numbers are written only by a
  // function of its own (`growOf`), from what `grow` gave back: never `grow`'s from the array's and the array's from
  // `grow`'s, which the emitter would keep by copying both into every place at every read.
  const G = { p: "@heap.p", n: "@heap.n", r: "@heap.r", k: "@heap.k", need: "@heap.need" };
  const S = { blk: "@heap.blk", nr: "@heap.nr", nk: "@heap.nk", j: "@heap.j", to: "@heap.to", end: "@heap.end", ok: "@heap.ok" };

  let here: At = program.at;
  let made = 0;
  const fresh = (what: string) => `@heap.${what}${made++}`;
  const bin = (op: "+" | "-", a: NumExpr, b: NumExpr): NumExpr => ({ kind: "binary", op, left: a, right: b, at: here, label: "" });
  const cmp = (op: CompareOp, a: NumExpr, b: NumExpr): BoolExpr => ({ kind: "compare", op, left: a, right: b, unsigned: true, at: here, label: "" });
  const set = (target: string, value: NumExpr): Stmt => ({ kind: "assign", target, value, at: here, label: "" });
  const add = (target: string, n: number): Stmt => set(target, bin("+", V(target), k(n)));
  const when = (cond: BoolExpr, then: Stmt[], otherwise?: Stmt[]): Stmt => ({ kind: "if", cond, then, ...(otherwise?.length ? { else: otherwise } : {}), at: here, label: "" });
  const loop = (cond: BoolExpr, body: Stmt[]): Stmt => ({ kind: "while", cond, body, at: here, label: "" });
  /**
   * `routed`: what `grow` gives back, which every array's `grow` reads — kept in one cell and read where it is used, so
   * that a write of it in `grow` is one action, not one for each place every array keeps of where its block is.
   */
  const ROUTED = new Set([S.blk, S.nr, S.nk, S.ok, G.p, G.n, G.r, G.k, G.need]);
  /** Where each array's block starts: written only when the block moves, read wherever a cell is (`everywhere`). */
  const EVERYWHERE = new Set([...handles.values()].map((h) => h.p));
  const num = (id: string, top?: number): VarDecl => ({ id, name: "(heap)", kind: "number", shared: false, at: here, temp: true, ...(top !== undefined ? { top } : {}), ...(ROUTED.has(id) ? { routed: true } : {}), ...(EVERYWHERE.has(id) ? { everywhere: true } : {}) } as VarDecl);
  const dec = (id: string, init: NumExpr, top?: number): Stmt => ({ kind: "declare", decl: num(id, top), init, at: here, label: "" });
  /** An expression with what the value ranges know of it. */
  const ranged = (e: NumExpr, lo: number, hi: number): NumExpr => ({ ...e, range: [lo, hi] }) as unknown as NumExpr;
  /** A cell of the heap (inside it: what tests it is around it). */
  const cell = (at: NumExpr): NumExpr => ({ kind: "element", array: HEAP, index: ranged(at, 0, H - 1), at: here }) as NumExpr;
  const store = (at: NumExpr, value: NumExpr): Stmt => ({ kind: "store", array: HEAP, index: ranged(at, 0, H - 1), value, at: here, label: "" }) as Stmt;
  const freeAt = (c: NumExpr): NumExpr => ({ kind: "element", array: FREE, index: ranged(c, 0, classes - 1), at: here }) as NumExpr;
  const setFree = (c: NumExpr, value: NumExpr): Stmt => ({ kind: "store", array: FREE, index: ranged(c, 0, classes - 1), value, at: here, label: "" }) as Stmt;

  // ── the run time ──
  const functions: FuncDecl[] = [];
  const call = (fn: FuncDecl, args: NumExpr[] = []): Call => ({ fn: fn.id, name: fn.name, at: here, label: "", params: fn.params.map((p, i) => ({ decl: p, init: args[i], label: "" })), body: [], ...(fn.result ? { result: { decl: num(fresh("v")), kind: fn.result.kind } } : {}) });
  const callStmt = (fn: FuncDecl, args: NumExpr[] = []): Stmt => ({ kind: "call", call: call(fn, args), at: here, label: "" }) as Stmt;
  const callExpr = (fn: FuncDecl, args: NumExpr[] = []): NumExpr => ({ kind: "call", call: call(fn, args) }) as NumExpr;
  /**
   * `grow`: room for `need` cells in the array its operands hold — a block of the smallest class that has it, from
   * its class's list or new ground, the cells in use copied over and the old block given back. When the heap has none,
   * nothing changes (`ok` 0), and the game says so once.
   */
  const grow: FuncDecl = {
    id: "@heap.grow", name: "@heap.grow", params: [], at: here,
    body: [
      set(S.ok, k(0)),
      dec(S.nr, k(HEAP_SMALLEST), H),
      dec(S.nk, k(0), classes - 1),
      when(cmp("!=", V(G.r), k(0)), [set(S.nr, V(G.r)), set(S.nk, V(G.k))]),
      loop(cmp("<", V(S.nr), V(G.need)), [set(S.nr, bin("+", V(S.nr), V(S.nr))), add(S.nk, 1)]),
      dec(S.blk, freeAt(V(S.nk)), H - 1),
      when(cmp("!=", V(S.blk), k(0)), [setFree(V(S.nk), cell(V(S.blk)))], [
        // (New ground: below the heap's end, as the simulator counts it.)
        when(cmp("<=", bin("+", V(TOP), V(S.nr)), k(H - 1)), [set(S.blk, bin("+", V(TOP), k(1))), set(TOP, bin("+", V(TOP), V(S.nr)))], [
          when(cmp("==", V(SAID), k(0)), [
            set(SAID, k(1)),
            { kind: "print", parts: [{ kind: "text", text: `\x06TrigScript: out of memory - an array could not grow (the programs' arrays share ${H} cells).` }], to: 13, position: "chat", at: here, label: "" } as Stmt,
          ]),
          { kind: "return", at: here, label: "" } as Stmt,
        ]),
      ]),
      // (Both blocks walked a cell at a time, where the next is in each: no index worked out.)
      dec(S.j, V(G.p), H), dec(S.to, V(S.blk), H), dec(S.end, bin("+", V(G.p), V(G.n)), H),
      loop(cmp("<", V(S.j), V(S.end)), [store(V(S.to), cell(V(S.j))), add(S.j, 1), add(S.to, 1)]),
      // The old block to the head of its class's list.
      when(cmp("!=", V(G.r), k(0)), [store(V(G.p), freeAt(V(G.k))), setFree(V(G.k), V(G.p))]),
      set(S.ok, k(1)),
    ],
  };
  /**
   * The array's block given back to its class's list, and the array empty with none. (Where the block was is left as it
   * was: with no room and no cells, nothing reads it, and it is written in one place, `growOf`.)
   */
  const give = (h: Handle): Stmt[] => [
    when(cmp("!=", V(h.r), k(0)), [set(G.p, V(h.p)), set(G.k, V(h.k)), callStmt(release)]),
    // (Where its next cell goes is 0 with no block: a loop over it tests that against where its first cell is, which
    // is never below. With one, it is the block's start plus the length, everywhere.)
    set(h.n, k(0)), set(h.r, k(0)), set(h.k, k(0)), set(h.e, k(0)),
  ];
  /** `release`: the block its operands name (`G.p`, of class `G.k`) to the head of its class's list. */
  const release: FuncDecl = { id: "@heap.release", name: "@heap.release", params: [], at: here, body: [store(V(G.p), freeAt(V(G.k))), setFree(V(G.k), V(G.p))] };
  functions.push(grow, release);
  /**
   * An array's own `grow`: its numbers handed to the run time's, and the block it gave taken. (Its length is in `G.n`
   * already: read once where the array's length is read for a push that has no room, not in each place of its own.)
   */
  const growers = new Map<string, FuncDecl>();
  const growOf = (h: Handle): FuncDecl => {
    let f = growers.get(h.decl.id);
    if (!f) {
      const need = num(`${h.decl.id}@need`);
      f = {
        id: `@heap.grow.${h.decl.id}`, name: `@heap.grow.${h.decl.id}`, params: [need], at: here,
        body: [
          set(G.p, V(h.p)), set(G.r, V(h.r)), set(G.k, V(h.k)), set(G.need, V(need.id)),
          callStmt(grow),
          when(cmp("!=", V(S.ok), k(0)), [set(h.p, V(S.blk)), set(h.r, V(S.nr)), set(h.k, V(S.nk)), set(h.e, bin("+", V(S.blk), V(G.n)))]),
        ],
      };
      growers.set(h.decl.id, f);
      functions.push(f);
    }
    return f;
  };
  /** Room for `need` cells (a variable or a constant): the array's `grow` when the block has less. */
  const room = (h: Handle, need: NumExpr): Stmt => when(cmp("<", V(h.r), need), [set(G.n, V(h.n)), callStmt(growOf(h), [need])]);
  /**
   * A push with no room: the array grown by one, and the cell at the end when it was. (Its length read once, into
   * `G.n`, which is read where it is used: a push that has room pays for none of this.)
   */
  const more = (h: Handle): FuncDecl => ownFn(h, "more", () => {
    const v = num(`${h.decl.id}@mv`);
    return { params: [v], body: [
      set(G.n, V(h.n)),
      when(cmp("<", V(h.r), bin("+", V(G.n), k(1))), [callStmt(growOf(h), [bin("+", V(G.n), k(1))])]),
      when(cmp("<", V(G.n), V(h.r)), atEnd(h, V(v.id))),
    ] };
  });

  /** A number as a cell keeps it: a boolean 1 or 0, a `u8` / `u16` stopped at its top (the simulator's `kept`). */
  const kept = (h: Handle, value: NumExpr | BoolExpr): NumExpr => {
    if (h.decl.kind === "boolean") {
      const b = rewriteBool(value as BoolExpr);
      return { kind: "ternary", cond: b, whenTrue: k(1), whenFalse: k(0), at: here, label: "" } as NumExpr;
    }
    const v = rewriteNum(value as NumExpr);
    const bits = h.decl.bits;
    if (!bits) return v;
    const top = 2 ** bits - 1;
    return { kind: "intrinsic", name: "min", args: [v, k(top)], unsigned: true, range: [0, top], at: here, label: "" } as NumExpr;
  };
  /** A value worked out once, ahead of what follows: into a variable of its own when working it out may do something. */
  const once = (value: NumExpr, pre: Stmt[]): NumExpr => {
    if (value.kind === "const" || value.kind === "var" || !impure(value)) return value;
    const t = fresh("t");
    pre.push(dec(t, value));
    return V(t);
  };
  /**
   * A value worked out already, for one more place it is used: a copy, each call in it with a result of its own (a
   * value `once` left as it was — a variable, a constant, or a cell read, which does nothing — may be used in several).
   */
  const again = (e: NumExpr): NumExpr => {
    const copy = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(copy);
      if (!x || typeof x !== "object") return x;
      const o = x as Record<string, unknown>;
      const out = Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? copy(v) : v]));
      if (o.kind === "call" && !("label" in o) && (o.call as Call).result) {
        const c = out.call as Call;
        out.call = { ...c, result: { ...c.result!, decl: num(fresh("v")) } };
      }
      return out;
    };
    return copy(e) as NumExpr;
  };
  /** The cell at the end: the value stored where the next cell goes, the length and the end one on. */
  const atEnd = (h: Handle, v: NumExpr): Stmt[] => [store(V(h.e), again(v)), add(h.n, 1), add(h.e, 1)];
  /**
   * A push of a value worked out already: with room, the cell at the end; without, the array's `more` — room for one
   * more, then the cell — a function of its own, so that the cell is stored at the end in one place here.
   */
  const pushed = (h: Handle, v: NumExpr): Stmt[] => [when(cmp("<", V(h.n), V(h.r)), atEnd(h, v), [callStmt(more(h), [again(v)])])];
  /**
   * A store of a value worked out already at an index worked out already: inside, the cell; at the length a push, past
   * it nothing. (Inside asked first: one condition, where whether it is at the length is two.)
   */
  const stored = (h: Handle, j: NumExpr, v: NumExpr): Stmt[] => [when(cmp("<", j, V(h.n)), [store(bin("+", V(h.p), j), again(v))], [when(cmp("==", j, V(h.n)), pushed(h, v))])];
  /**
   * A cell at an index, 0 past the length: the heap's first cell, which nothing writes, when the index is past it — so
   * the test chooses where the read goes, and what it reads goes straight to where it is used.
   */
  const read = (h: Handle, i: NumExpr): NumExpr => cell({ kind: "ternary", cond: cmp("<", i, V(h.n)), whenTrue: bin("+", V(h.p), i), whenFalse: k(0), at: here, label: "" } as NumExpr);
  /**
   * The array's functions, one of each, for what is done to it outside every loop: a read, a store and a push there is a
   * call, so that where its block is has a place only in them — each place of it a field every move of the block
   * writes, and every read inlined three of them (`hot`). In a loop, or in a function of the script's (laid out once),
   * they are written where they are used; the read there a function that is inlined.
   */
  const own = new Map<string, FuncDecl>();
  const ownFn = (h: Handle, what: string, make: () => Omit<FuncDecl, "id" | "name" | "at">): FuncDecl => {
    const id = `@heap.${what}.${h.decl.id}`;
    let f = own.get(id);
    if (!f) {
      f = { id, name: id, at: here, ...make() };
      own.set(id, f);
      functions.push(f);
    }
    return f;
  };
  const getter = (h: Handle): FuncDecl => ownFn(h, "get", () => {
    const i = num(`${h.decl.id}@i`);
    return { params: [i], result: { decl: num(`${h.decl.id}@got`), kind: "number" }, body: [{ kind: "return", value: read(h, V(i.id)), at: here, label: "" } as Stmt] };
  });
  const reader = (h: Handle): FuncDecl => ownFn(h, "read", () => {
    const i = num(`${h.decl.id}@ri`);
    // (Two statements: called, not inlined.)
    return { params: [i], result: { decl: num(`${h.decl.id}@read`), kind: "number" }, body: [
      when(cmp("<", V(i.id), V(h.n)), [{ kind: "return", value: cell(bin("+", V(h.p), V(i.id))), at: here, label: "" } as Stmt]),
      { kind: "return", value: k(0), at: here, label: "" } as Stmt,
    ] };
  });
  const pusher = (h: Handle): FuncDecl => ownFn(h, "push", () => {
    const v = num(`${h.decl.id}@pv`);
    return { params: [v], body: pushed(h, V(v.id)) };
  });
  const setter = (h: Handle): FuncDecl => ownFn(h, "set", () => {
    // (The value first, then the index: as the simulator works them out, and a call its arguments.)
    const v = num(`${h.decl.id}@sv`), i = num(`${h.decl.id}@si`);
    return { params: [v, i], body: stored(h, V(i.id), V(v.id)) };
  });
  /** `xs.pop()` as a value: the last cell, the array a cell shorter; 0 when it is empty. */
  const poppers = new Map<string, FuncDecl>();
  const popper = (h: Handle): FuncDecl => {
    let f = poppers.get(h.decl.id);
    if (!f) {
      const result = num(`${h.decl.id}@popped`), out = `${h.decl.id}@last`;
      f = {
        id: `@heap.pop.${h.decl.id}`, name: `@heap.pop.${h.decl.id}`, params: [], at: here,
        result: { decl: result, kind: "number" },
        body: [
          dec(out, k(0)),
          when(cmp("!=", V(h.n), k(0)), [add(h.n, -1), add(h.e, -1), set(out, cell(V(h.e)))]),
          { kind: "return", value: V(out), at: here, label: "" } as Stmt,
        ],
      };
      poppers.set(h.decl.id, f);
      functions.push(f);
    }
    return f;
  };

  // ── a function that calls itself ──
  /**
   * A call that may come back into the function it is in, which has arrays that grow of its own (`Call.saves.arrays`):
   * each one's numbers into variables the call keeps on the stack with the function's others, the array empty for the
   * call; after it, the block the inner run left given back, and the numbers taken back.
   */
  const aroundCall = (s: Extract<Stmt, { kind: "call" }>): Stmt[] => {
    const was = here;
    here = s.at ?? here;
    try {
      const saves = s.call.saves!;
      const mine = saves.arrays.map((id) => handles.get(id)).filter((h): h is Handle => !!h && !h.through);
      const outer = (h: Handle) => ({ p: `${h.p}@outer`, n: `${h.n}@outer`, r: `${h.r}@outer`, k: `${h.k}@outer`, e: `${h.e}@outer` });
      const before: Stmt[] = [], after: Stmt[] = [];
      for (const h of mine) {
        const o = outer(h);
        for (const [id, top] of [[o.p, H - 1], [o.n, H], [o.r, H], [o.k, classes - 1], [o.e, H]] as const) extra.set(id, top);
        before.push(set(o.p, V(h.p)), set(o.n, V(h.n)), set(o.r, V(h.r)), set(o.k, V(h.k)), set(o.e, V(h.e)), set(h.n, k(0)), set(h.r, k(0)), set(h.k, k(0)), set(h.e, k(0)));
        after.push(...give(h), set(h.p, V(o.p)), set(h.n, V(o.n)), set(h.r, V(o.r)), set(h.k, V(o.k)), set(h.e, V(o.e)));
      }
      const vars = [...saves.vars, ...mine.flatMap((h) => Object.values(outer(h)))];
      const inner = walk(s.call) as Call;
      const call: Stmt = { ...s, call: { ...inner, saves: { ...saves, vars, arrays: saves.arrays.filter((id) => !mine.some((h) => h.decl.id === id)) } } };
      return [...before, call, ...after];
    } finally {
      here = was;
    }
  };
  /** Variables of the rewriting's own, declared at the program's start, with their tops. */
  const extra = new Map<string, number>();

  // ── rows that grow ──
  /** A cell of one of the outer arrays a row's numbers are kept in, at the row's index. */
  const outer = (array: string, index: string): NumExpr => ({ kind: "element", array, index: V(index), at: here }) as NumExpr;
  /** A row's numbers from the outer arrays' cells into its own (`e` too, for a push or a pop). */
  const load = (h: Handle): Stmt[] => {
    const t = h.through!;
    return walk([set(h.p, outer(t.ptr, t.index)), set(h.n, outer(t.len, t.index)), set(h.r, outer(t.room, t.index)), set(h.k, outer(t.k, t.index)), set(h.e, bin("+", V(h.p), V(h.n)))]) as Stmt[];
  };
  /** A row's numbers back into the outer arrays' cells (only the length, when that is all that changed). */
  const putBack = (h: Handle, all: boolean): Stmt[] => {
    const t = h.through!;
    const put = (array: string, from: string): Stmt => ({ kind: "store", array, index: V(t.index), value: V(from), at: here, label: "" }) as Stmt;
    return walk(all ? [put(t.ptr, h.p), put(t.len, h.n), put(t.room, h.r), put(t.k, h.k)] : [put(t.len, h.n)]) as Stmt[];
  };
  /** A row's cell, read through the outer arrays: the heap's first cell (0) past the row's length. */
  const rowRead = (h: Handle, i: NumExpr): NumExpr => {
    const t = h.through!;
    return cell({ kind: "ternary", cond: cmp("<", i, rewriteNum(outer(t.len, t.index))), whenTrue: bin("+", rewriteNum(outer(t.ptr, t.index)), i), whenFalse: k(0), at: here, label: "" } as NumExpr);
  };
  const rowReader = (h: Handle): FuncDecl => ownFn(h, "rowRead", () => {
    const i = num(`${h.decl.id}@ri`);
    return { params: [i], result: { decl: num(`${h.decl.id}@read`), kind: "number" }, body: [{ kind: "return", value: rowRead(h, V(i.id)), at: here, label: "" } as Stmt] };
  });
  const rowPopper = (h: Handle): FuncDecl => ownFn(h, "rowPop", () => {
    const result = num(`${h.decl.id}@popped`), out = `${h.decl.id}@last`;
    return { params: [], result: { decl: result, kind: "number" }, body: [
      ...load(h),
      dec(out, k(0)),
      when(cmp("!=", V(h.n), k(0)), [add(h.n, -1), add(h.e, -1), set(out, cell(V(h.e))), ...putBack(h, false)]),
      { kind: "return", value: V(out), at: here, label: "" } as Stmt,
    ] };
  });
  /**
   * A statement on a row: what it is worked out from first (it may change the row itself), then the row's numbers taken,
   * the statement done as to an array that grows alone, and the numbers put back.
   */
  const row = (h: Handle, s: Stmt): Stmt[] => {
    const was = here;
    here = s.at ?? here;
    try {
      const pre: Stmt[] = [];
      const plain = { ...h, through: undefined };
      const hold = (e: NumExpr | BoolExpr | undefined) => (e === undefined ? undefined : once(kept(h, e), pre));
      switch (s.kind) {
        case "push": {
          const v = hold(s.value)!;
          return [...pre, ...load(h), ...pushed(plain, v), ...putBack(h, true)];
        }
        case "pop": return [...load(h), when(cmp("!=", V(h.n), k(0)), [add(h.n, -1), ...putBack(h, false)])];
        case "setLength": {
          const n = once(rewriteNum(s.value), pre);
          return [...pre, ...load(h), when(cmp("<", n, V(h.n)), [set(h.n, n), ...putBack(h, false)])];
        }
        case "store": {
          const v = hold(s.value)!;
          const i = once(rewriteNum(s.index), pre);
          const j = i.kind === "const" || i.kind === "var" ? i : V(fresh("i"));
          if (j !== i) pre.push(dec((j as { id: string }).id, i));
          return [...pre, ...load(h), ...stored(plain, j, v), ...putBack(h, true)];
        }
        case "declareArray": {
          // Given back through the outer arrays' cells, which are 0 again; what it is declared with makes a new one.
          const filled = s.fill ? hold(s.fill)! : undefined;
          const values = filled ? Array.from({ length: h.decl.length }, () => filled) : (s.init ?? []).map((e) => hold(e)!);
          const out: Stmt[] = [...pre, ...load(h), ...give(plain), set(h.e, V(h.p))];
          if (values.length) out.push(room(plain, k(values.length)), when(cmp("<=", k(values.length), V(h.r)), [
            ...values.map((v, i) => store(bin("+", V(h.p), k(i)), v)),
            set(h.n, k(values.length)),
          ]));
          out.push(...putBack(h, true));
          return out;
        }
        default: return [s];
      }
    } finally {
      here = was;
    }
  };

  // ── the rewriting ──
  const rewriteNum = (e: NumExpr): NumExpr => walk(e) as NumExpr;
  const rewriteBool = (e: BoolExpr): BoolExpr => walk(e) as BoolExpr;
  /** An expression with every read of a growing array a read of the heap. */
  const expr = (o: Record<string, unknown>): unknown => {
    const h = typeof o.array === "string" ? handles.get(o.array) : undefined;
    if (!h) return undefined;
    const at = (o.at as At | undefined) ?? here;
    const was = here;
    here = at;
    try {
      const asBool = (n: NumExpr): BoolExpr => ({ kind: "test", expr: n, at: here, label: "" }) as BoolExpr;
      if (h.through) {
        // A row's: read through the outer arrays' cells at the row's index, as they are.
        const t = h.through;
        switch (o.kind) {
          case "length": return rewriteNum(outer(t.len, t.index));
          case "element": {
            const i = once(rewriteNum(o.index as NumExpr), []);
            const got = impure(i) ? callExpr(rowReader(h), [i]) : rowRead(h, i);
            return h.decl.kind === "boolean" ? asBool(got) : got;
          }
          case "pop": {
            const got = callExpr(rowPopper(h));
            return h.decl.kind === "boolean" ? asBool(got) : got;
          }
          default: return undefined;
        }
      }
      switch (o.kind) {
        case "length": return V(h.n);
        case "element": {
          // (At a loop's index, inside the array or tested on the way in: `loops`.)
          const index = o.index as NumExpr;
          const sure = index.kind === "var" ? inside(h, index.id) : undefined;
          const at = sure ? cellAt(h, (index as { id: string }).id) : undefined;
          const got = sure === "inside" ? cell(at!)
            : sure ? cell({ kind: "ternary", cond: { kind: "var", id: sure } as BoolExpr, whenTrue: at!, whenFalse: { kind: "ternary", cond: cmp("<", index, V(h.n)), whenTrue: at!, whenFalse: k(0), at: here, label: "" } as NumExpr, at: here, label: "" } as NumExpr)
            : callExpr(hot && !cold ? getter(h) : reader(h), [rewriteNum(index)]);
          return h.decl.kind === "boolean" ? asBool(got) : got;
        }
        case "pop": {
          const got = callExpr(popper(h));
          return h.decl.kind === "boolean" ? asBool(got) : got;
        }
        default: return undefined;
      }
    } finally {
      here = was;
    }
  };
  /** A statement on a growing array as statements on the heap; undefined when it is not one. */
  const statement = (s: Stmt): Stmt[] | undefined => {
    if (s.kind === "call" && s.call.saves?.arrays.some((id) => handles.has(id))) return aroundCall(s);
    if (s.kind === "for") return overArray(s);
    if (s.kind === "while") return moved(s);
    const h = "array" in s && typeof s.array === "string" ? handles.get(s.array) : undefined;
    if (!h) return undefined;
    if (h.through) return row(h, s);
    const was = here;
    here = s.at ?? here;
    try {
      const pre: Stmt[] = [];
      switch (s.kind) {
        case "push": {
          // The value first (it may push to the array itself), then room for one more, then the cell.
          if (!hot) return [callStmt(pusher(h), [kept(h, s.value)])];
          const v = once(kept(h, s.value), pre);
          return [...pre, ...pushed(h, v)];
        }
        case "pop": return [when(cmp("!=", V(h.n), k(0)), [add(h.n, -1), add(h.e, -1)])];
        case "setLength": {
          const n = once(rewriteNum(s.value), pre);
          return [...pre, when(cmp("<", n, V(h.n)), [set(h.n, n), set(h.e, bin("+", V(h.p), n))])];
        }
        case "store": {
          // The value, then the index, as the simulator works them out; at the length it is a push. (At a loop's index,
          // inside the array or tested on the way in: `loops`.)
          const sure = s.index.kind === "var" ? inside(h, s.index.id) : undefined;
          if (sure === "inside") return [store(cellAt(h, (s.index as { id: string }).id), kept(h, s.value))];
          if (sure) {
            const v = once(kept(h, s.value), pre);
            return [...pre, when({ kind: "var", id: sure } as BoolExpr, [store(cellAt(h, (s.index as { id: string }).id), again(v))], stored(h, s.index, v))];
          }
          if (!hot || cold) return [callStmt(setter(h), [kept(h, s.value), rewriteNum(s.index)])];
          const v = once(kept(h, s.value), pre);
          const i = rewriteNum(s.index);
          const j = i.kind === "const" || i.kind === "var" ? i : V(fresh("i"));
          if (j !== i) pre.push(dec((j as { id: string }).id, i));
          return [...pre, ...stored(h, j, v)];
        }
        case "declareArray": {
          // Declared again, it gives back the block it held; what it is declared with is worked out after.
          const out = give(h);
          const values: NumExpr[] = [];
          if (s.fill) {
            const v = once(kept(h, s.fill), out);
            if (h.decl.length) {
              const j = fresh("j");
              out.push(room(h, k(h.decl.length)), when(cmp("<=", k(h.decl.length), V(h.r)), [
                dec(j, k(0)),
                loop(cmp("<", V(j), k(h.decl.length)), [store(bin("+", V(h.p), V(j)), v), add(j, 1)]),
                set(h.n, k(h.decl.length)),
                set(h.e, bin("+", V(h.p), k(h.decl.length))),
              ]));
            }
            return out;
          }
          for (const e of s.init ?? []) values.push(once(kept(h, e), out));
          // (Outside a loop, a push each: where the block is, read in one place.)
          if (values.length && !hot) {
            out.push(room(h, k(values.length)), ...values.map((v) => callStmt(pusher(h), [v])));
            return out;
          }
          if (values.length) {
            out.push(room(h, k(values.length)), when(cmp("<=", k(values.length), V(h.r)), [
              ...values.map((v, i) => store(bin("+", V(h.p), k(i)), v)),
              set(h.n, k(values.length)),
              set(h.e, bin("+", V(h.p), k(values.length))),
            ]));
          }
          return out;
        }
        default: return undefined;
      }
    } finally {
      here = was;
    }
  };
  // ── loops over an array that grows ──
  /**
   * `for (…; i < xs.length; …)` — and `for (const x of xs)`, which is that — whose body neither changes `xs`'s length
   * nor writes `i`, and calls nothing, sleeps nowhere: in the body `i` is inside `xs`, and a read or a store of `xs[i]`
   * tests nothing (a store there is never a push). Every other array that grows the body reads or writes at `i`, its
   * length not changed in the body either, is weighed against `xs`'s once on the way in (as the Python side does), into a
   * flag of its own that each of its reads and stores at `i` tests instead of the length: each field of a record.
   */
  /**
   * Each array's cell at the loop's index is kept beside the counter when the loop only adds a constant to it (`at`:
   * the block's start plus the index, moved by the same additions), so that a read or a store there works no index out:
   * eudplib's offset beside a counter.
   */
  const loops: { index: string; array: string; others: Map<string, string>; at: Map<string, string> }[] = [];
  /** The front end's own variables (`temp`): a `for…of`'s counter among them. */
  const temps = new Set<string>();
  const findTemps = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(findTemps); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { kind?: string; decl?: VarDecl };
    if (o.kind === "declare" && o.decl?.temp) temps.add(o.decl.id);
    for (const v of Object.values(o)) if (v && typeof v === "object") findTemps(v);
  };
  findTemps([program.body, program.functions ?? []]);
  const inside = (h: Handle, index: string): string | undefined => {
    for (let j = loops.length - 1; j >= 0; j--) {
      const l = loops[j];
      if (l.index !== index) continue;
      if (l.array === h.decl.id) return "inside";
      return l.others.get(h.decl.id);
    }
    return undefined;
  };
  /** Where the cell at a loop's index is, kept beside its counter, or the block's start plus the index. */
  const cellAt = (h: Handle, index: string): NumExpr => {
    for (let j = loops.length - 1; j >= 0; j--) {
      const l = loops[j];
      if (l.index !== index) continue;
      const q = l.at.get(h.decl.id);
      if (q) return V(q);
      break;
    }
    return bin("+", V(h.p), V(index));
  };
  /** Whether statements leave arrays' lengths and a variable alone: no length changed, no write of it, no call, no wait. */
  const leaves = (body: unknown, arrays: Set<string>, index: string): boolean => {
    let ok = true;
    const look = (x: unknown): void => {
      if (!ok || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(look); return; }
      const o = x as Record<string, unknown>;
      const kind = o.kind as string;
      if (kind === "call" || kind === "sleep" || kind === "start" || kind === "parallel" || kind === "pop" || kind === "return" || kind === "throw") { ok = false; return; }
      if ((kind === "push" || kind === "setLength" || kind === "declareArray") && arrays.has(o.array as string)) { ok = false; return; }
      // (A store at another index may be at the length, a push; at the loop's, never.)
      if (kind === "store" && arrays.has(o.array as string) && !((o.index as NumExpr).kind === "var" && (o.index as { id: string }).id === index)) { ok = false; return; }
      if ((kind === "assign" && o.target === index) || (kind === "declare" && (o.decl as VarDecl).id === index)) { ok = false; return; }
      for (const v of Object.values(o)) if (v && typeof v === "object") look(v);
    };
    look(body);
    return ok;
  };
  /** The arrays that grow (on their own) a body reads or writes at a variable. */
  const atIndex = (body: unknown, index: string): Set<string> => {
    const out = new Set<string>();
    const look = (x: unknown): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(look); return; }
      const o = x as Record<string, unknown>;
      if ((o.kind === "element" || o.kind === "store") && typeof o.array === "string" && handles.has(o.array) && !handles.get(o.array)!.through) {
        const i = o.index as NumExpr;
        if (i.kind === "var" && i.id === index) out.add(o.array);
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") look(v);
    };
    look(body);
    return out;
  };
  /**
   * A `for` over an array that grows, as `loops` says; undefined otherwise. With other arrays read or written at its
   * index — a record's fields — their lengths weighed against its own once on the way in: when none is shorter, the loop
   * where each of them is as sure as its own (every cell at its place kept beside the counter, nothing tested); when one
   * is, the loop with theirs tested at each read and store, as anywhere.
   */
  const overArray = (s: Extract<Stmt, { kind: "for" }>): Stmt[] | undefined => {
    const c = s.cond;
    if (!c || c.kind !== "compare" || c.op !== "<" || c.unsigned !== true || c.left.kind !== "var" || c.right.kind !== "length") return undefined;
    const h = handles.get(c.right.array);
    if (!h || h.through) return undefined;
    const index = c.left.id;
    const used = atIndex(s.body, index);
    used.delete(h.decl.id);
    if (!leaves(s.body, new Set([h.decl.id, ...used]), index)) return undefined;
    const was = here;
    here = s.at ?? here;
    try {
      // (The counter's step, when it only adds a constant: each array's cell at it kept beside it.)
      const u = s.update.length === 1 && s.update[0].kind === "assign" && s.update[0].target === index ? s.update[0].value : undefined;
      const step = u?.kind === "binary" && u.op === "+" && u.left.kind === "var" && u.left.id === index && u.right.kind === "const" ? u.right.value : undefined;
      /**
       * The loop, the arrays `sure` read and written at the counter untested. `own`: with a counter of its own, set from
       * the loop's on the way in and given back on the way out, so that its steps write only its own places (the other
       * version's are the loop's counter's).
       */
      const version = (sure: string[], own = false): Stmt[] => {
        const i = own ? `${index}@fast${made++}` : index;
        const loop = own ? (renamed(s, index, i) as Extract<Stmt, { kind: "for" }>) : s;
        const at = new Map<string, string>(), beside: Stmt[] = own ? [dec(i, V(index))] : [], moves: Stmt[] = [];
        if (step !== undefined) for (const id of sure) {
          const q = `${id}@at${made++}`;
          at.set(id, q);
          extra.set(q, H);
          // (From the loop's own counter, which the loop does not write: so its steps write no place here.)
          beside.push(set(q, bin("+", V(handles.get(id)!.p), V(index))));
          moves.push(add(q, step));
        }
        loops.push({ index: i, array: h.decl.id, others: new Map(sure.filter((id) => id !== h.decl.id).map((id) => [id, "inside"])), at });
        const wasHot = hot;
        hot = true;
        try {
          const body = walk(loop.body) as Stmt[];
          // (A body that reads its counter nowhere once its cells are read at their places — `xs[i] = xs[i] + 1`: the
          // loop tests where its own array's cell is against where the array ends — where its next cell would go — and
          // steps only the places; the counter, given back after, is where the place is less where the block starts.)
          const q = at.get(h.decl.id);
          if (own && q && !mentions(body, i)) {
            const back = temps.has(index) ? [] : [set(index, bin("-", V(q), V(h.p)))];
            return [...beside, { ...loop, cond: cmp("<", V(q), V(h.e)), update: moves, body }, ...back];
          }
          // (The loop's counter given back after it, but a counter of the front end's own — `for…of`'s — which nothing
          // reads after.)
          const back = own && !temps.has(index) ? [set(index, V(i))] : [];
          return [...beside, { ...loop, cond: walk(loop.cond) as BoolExpr, update: [...(walk(loop.update) as Stmt[]), ...moves], body }, ...back];
        } finally {
          hot = wasHot;
          loops.pop();
        }
      };
      if (!used.size) return version([h.decl.id], step !== undefined);
      const longEnough: BoolExpr = { kind: "and", items: [...used].map((id) => cmp(">=", V(handles.get(id)!.n), V(h.n))) };
      return [when(longEnough, version([h.decl.id, ...used], true), version([h.decl.id]))];
    } finally {
      here = was;
    }
  };

  // ── cells moved along an array ──
  /**
   * The library's loops that move cells along arrays that grow by a gap — `splice`, `shift`, `unshift`, a row of an
   * array of texts' three arrays at once: `while (row + gap < n) { X[row] = X[row + gap]; …; row++ }` forward, `while
   * (row >= b) { X[row] = X[row - gap]; …; row-- }` back. When every cell they touch is inside each array (asked once,
   * on the way in) they are the run time's `move`, which walks the heap's cells by where they are — three triggers a
   * cell, one function for the whole map — and the counter is left where the loop leaves it; when not, the loop as it is.
   */
  const mover = (back: boolean): FuncDecl => {
    const id = back ? "@heap.moveBack" : "@heap.move";
    let f = own.get(id);
    if (!f) {
      const from = num(`${id}@from`, H), to = num(`${id}@to`, H), count = num(`${id}@count`, H);
      const step = back ? -1 : 1;
      f = { id, name: id, at: here, params: [from, to, count], body: [
        loop(cmp("!=", V(count.id), k(0)), [store(V(to.id), cell(V(from.id))), add(from.id, step), add(to.id, step), add(count.id, -1)]),
      ] };
      own.set(id, f);
      functions.push(f);
    }
    return f;
  };
  const sameExpr = (a: unknown, b: unknown) => JSON.stringify(a, (key, v) => (key === "at" || key === "label" || key === "range" ? undefined : v)) === JSON.stringify(b, (key, v) => (key === "at" || key === "label" || key === "range" ? undefined : v));
  const moved = (s: Extract<Stmt, { kind: "while" }>): Stmt[] | undefined => {
    const body = s.body, last = body[body.length - 1];
    if (body.length < 2 || last.kind !== "assign" || last.value.kind !== "binary" || last.value.left.kind !== "var" || last.value.left.id !== last.target || last.value.right.kind !== "const" || last.value.right.value !== 1) return undefined;
    const row = last.target, back = last.value.op === "-";
    if (!back && last.value.op !== "+") return undefined;
    const stores = body.slice(0, -1);
    let gap: NumExpr | undefined;
    const arrays: Handle[] = [];
    for (const st of stores) {
      if (st.kind !== "store" || st.index.kind !== "var" || st.index.id !== row) return undefined;
      const h = handles.get(st.array);
      const v = st.value as NumExpr;
      if (!h || h.through || v.kind !== "element" || v.array !== st.array || v.index.kind !== "binary" || v.index.op !== (back ? "-" : "+") || v.index.left.kind !== "var" || v.index.left.id !== row) return undefined;
      const g = v.index.right;
      if (g.kind !== "var" && g.kind !== "const") return undefined;
      if (gap && !sameExpr(gap, g)) return undefined;
      gap = g;
      arrays.push(h);
    }
    if (!gap || (gap.kind === "var" && gap.id === row)) return undefined;
    const c = s.cond;
    if (!c || c.kind !== "compare" || impure(c)) return undefined;
    if (!back && !(c.op === "<" && c.left.kind === "binary" && c.left.op === "+" && c.left.left.kind === "var" && c.left.left.id === row && sameExpr(c.left.right, gap))) return undefined;
    if (back && !(c.op === ">=" && c.left.kind === "var" && c.left.id === row)) return undefined;
    const was = here;
    here = s.at ?? here;
    try {
      const cnt = fresh("count");
      // How many turns the loop makes: forward, the length less where it stops; back, down to its bottom.
      const count = back ? bin("+", bin("-", V(row), c.right as NumExpr), k(1)) : bin("-", c.right as NumExpr, bin("+", V(row), gap));
      // Inside each array: the cells written and read, the first and the last of each.
      const lo = back ? bin("-", bin("+", bin("-", V(row), V(cnt)), k(1)), gap) : V(row);
      const hi = back ? V(row) : bin("+", bin("+", V(row), V(cnt)), gap);
      const inside: BoolExpr = { kind: "and", items: arrays.flatMap((h) => [{ kind: "compare", op: ">=", left: lo, right: k(0), at: here, label: "" } as BoolExpr, back ? cmp("<", hi, V(h.n)) : cmp("<=", hi, V(h.n))]) };
      const fast: Stmt[] = [
        // (From where each cell is read, to where it is written: back, from the last cells down.)
        ...arrays.map((h) => callStmt(mover(back), back ? [bin("+", V(h.p), bin("-", V(row), gap)), bin("+", V(h.p), V(row)), V(cnt)] : [bin("+", V(h.p), bin("+", V(row), gap)), bin("+", V(h.p), V(row)), V(cnt)])),
        set(row, back ? bin("-", V(row), V(cnt)) : bin("+", V(row), V(cnt))),
      ];
      // (Otherwise the loop as written, its reads and stores the arrays' own functions: past an end a read is 0 and a
      // store at the length a push, as anywhere — and the loop a few triggers, where it is never expected to run.)
      const wasCold = cold;
      cold = true;
      let slow: Stmt;
      try { slow = plainWalk(s as unknown as Record<string, unknown>) as Stmt; } finally { cold = wasCold; }
      return [when(c, [dec(cnt, count), when(inside, fast, [slow])])];
    } finally {
      here = was;
    }
  };

  /** Inside a loop, or a function of the script's: what is done to an array is written where it is done. */
  let hot = false;
  /** Where nothing is expected to run (`moved`'s other way): reads and stores the arrays' own functions, all the same. */
  let cold = false;
  const isStmt = (o: unknown): o is Stmt => !!o && typeof o === "object" && "label" in o && STMT_KINDS.has((o as { kind?: string }).kind ?? "");
  /** A statement's insides rewritten, the statement itself as it is (a loop's body hot). */
  const plainWalk = (o: Record<string, unknown>): unknown => {
    const was = hot;
    if (LOOPS.has(o.kind as string)) hot = true;
    try {
      return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? walk(v) : v]));
    } finally {
      hot = was;
    }
  };
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      if (x.length && isStmt(x[0])) return x.flatMap((s) => (isStmt(s) ? (statement(s) ?? [walk(s)]) : [walk(s)]));
      return x.map(walk);
    }
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    if (!isStmt(o)) {
      const e = expr(o);
      if (e !== undefined) return e;
    }
    else {
      const out = statement(o);
      if (out !== undefined) return { kind: "block", body: out, at: o.at, label: "" };
    }
    const was = hot;
    if (isStmt(o) && LOOPS.has(o.kind as string)) hot = true;
    try {
      return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? walk(v) : v]));
    } finally {
      hot = was;
    }
  };

  const body = walk(program.body) as Stmt[];
  hot = true;
  const fns = (program.functions ?? []).map((f) => ({ ...f, body: walk(f.body) as Stmt[] }));
  here = program.at;
  const start: Stmt[] = [
    dec(G.p, k(0), H - 1), dec(G.n, k(0), H), dec(G.r, k(0), H), dec(G.k, k(0), classes - 1), dec(G.need, k(0)), dec(S.ok, k(0)),
    ...[...handles.values()].flatMap((h) => [dec(h.p, k(0), H - 1), dec(h.n, k(0), H), dec(h.r, k(0), H), dec(h.k, k(0), classes - 1), dec(h.e, k(0), H)]),
    ...[...extra].map(([id, top]) => dec(id, k(0), top)),
  ];
  const arrays: ArrayDecl[] = [
    ...(program.arrays ?? []).filter((a) => !handles.has(a.id)),
    { id: HEAP, name: "(heap)", kind: "number", length: H, shared: true, at: program.at },
    { id: FREE, name: "(heap's free blocks)", kind: "number", length: classes, shared: true, at: program.at },
  ];
  return { ...program, arrays, body: [...start, ...body], functions: [...fns, ...functions] };
}

/** The statements whose bodies run again and again. */
const LOOPS = new Set(["while", "do", "for", "unitLoop", "textLoop", "unrolled"]);
/** The kinds of statement (a `call` and a `pop` with a label: an expression of either has none). */
const STMT_KINDS = new Set(["action", "assign", "assignBool", "assignText", "assignUnit", "block", "break", "buildText", "call", "cancel", "centerLocation", "continue", "declare", "declareArray", "do", "for", "graph", "if", "parallel", "pop", "print", "push", "releaseText", "remark", "return", "select", "setLength", "sleep", "start", "store", "storeText", "switch", "syncSend", "tableWrite", "textLoop", "throw", "try", "uncaught", "unitDo", "unitLoop", "unitWrite", "unrolled", "while"]);

/**
 * The variables the closures count (`VarDecl.held`: a reference to an environment, a row of the front end's arrays — the
 * pool of 1,024): each is read by its own declare, which lets go of what it held, and so is 0 before it is ever declared.
 * In a map of our own it is declared once, 0, as the program starts, and each of its declares is an assignment.
 */
export function heldVariables(program: Program): Program {
  const held = new Map<string, VarDecl>();
  const find = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(find); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { kind?: string; decl?: VarDecl };
    if (o.kind === "declare" && o.decl?.held && o.decl.kind === "number" && o.decl.task === undefined) held.set(o.decl.id, o.decl);
    for (const v of Object.values(o)) if (v && typeof v === "object") find(v);
  };
  find([program.body, program.functions ?? []]);
  if (!held.size) return program;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    if (o.kind === "declare" && held.has((o.decl as VarDecl).id)) {
      const s = o as Extract<Stmt, { kind: "declare" }>;
      return { kind: "assign", target: s.decl.id, value: walk(s.init) as NumExpr, at: s.at, label: s.label };
    }
    return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? walk(v) : v]));
  };
  const start: Stmt[] = [...held.values()].map((d) => {
    const { held: _, ...plain } = d;
    void _;
    return { kind: "declare", decl: plain, init: k(0), at: program.at, label: "" } as Stmt;
  });
  return { ...program, body: [...start, ...(walk(program.body) as Stmt[])], ...(program.functions ? { functions: walk(program.functions) as FuncDecl[] } : {}) };
}

/**
 * The variables a loop's body declares that nothing outside the loop reads — `for (const v of xs)`'s `v` — marked
 * `scoped`: dead once the turn is over, so what a cell read puts into one may go straight to the one field that reads
 * it, its own cell left as it was (a map of our own's emitter, as for a variable of its own). A debugger reading cells
 * would see such a variable's cell stale.
 */
export function loopScoped(program: Program): Program {
  const scoped = new Set<string>();
  const declaredIn = (x: unknown, out: Set<string>): void => {
    if (Array.isArray(x)) { x.forEach((y) => declaredIn(y, out)); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { kind?: string; decl?: VarDecl };
    if (o.kind === "declare" && o.decl && o.decl.kind === "number" && !o.decl.shared && !o.decl.held && o.decl.task === undefined) out.add(o.decl.id);
    for (const v of Object.values(o)) if (v && typeof v === "object") declaredIn(v, out);
  };
  /** Every variable read or written in `x`, but inside `skip`. */
  const named = (x: unknown, skip: unknown, out: Set<string>): void => {
    if (x === skip || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach((y) => named(y, skip, out)); return; }
    const o = x as { kind?: string; id?: string; target?: string };
    if (o.kind === "var" && typeof o.id === "string") out.add(o.id);
    if (typeof o.target === "string") out.add(o.target);
    for (const v of Object.values(o)) if (v && typeof v === "object") named(v, skip, out);
  };
  const whole = [program.body, program.functions ?? []];
  const loops = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(loops); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.kind === "while" || o.kind === "for" || o.kind === "do") {
      const inside = new Set<string>();
      declaredIn(o.body, inside);
      if (inside.size) {
        const outside = new Set<string>();
        named(whole, o, outside);
        for (const id of inside) if (!outside.has(id)) scoped.add(id);
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") loops(v);
  };
  loops(whole);
  if (!scoped.size) return program;
  const mark = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(mark);
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    const out = Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v && typeof v === "object" ? mark(v) : v]));
    if (o.kind === "declare" && scoped.has((o.decl as VarDecl).id)) out.decl = { ...(o.decl as VarDecl), scoped: true };
    return out;
  };
  return { ...program, body: mark(program.body) as Stmt[], ...(program.functions ? { functions: mark(program.functions) as FuncDecl[] } : {}) };
}
