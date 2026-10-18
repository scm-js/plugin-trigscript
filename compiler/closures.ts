/**
 * Closures over locals (TrigScript 4). A function kept as a value that uses a variable of the function or the block it
 * was written in keeps that variable in an *environment*: a row of the pool here, one for each run of the block, the
 * variable a cell of its own array at that row. What JavaScript keeps alive with its garbage collector is kept alive
 * here by counting: every place that holds a reference — a variable, a cell of an array, a field, an environment's
 * parent — adds one, and what stops holding it takes one away. A row whose count reaches nothing is queued, and the
 * queue is emptied at the program's next wait (`sweep`), so a closure only just made, on its way to where it is kept,
 * is never let go of under it. No new kind of IR: the pool is arrays, the counting is statements, and both backends
 * run them as they run anything else.
 *
 * A reference is a number. A function that keeps nothing is `FN_BASE` plus its id, as it was before closures, only
 * moved up out of the pool's way; a row of the pool (an environment, or a closure: the function's number and the
 * environment it was made in) is its place, 1 to `CLOSURE_CAP` − 1. 0 is none.
 */
import type { ArrayDecl, At, BoolExpr, Call, FuncDecl, NumExpr, Program, Stmt, TextExpr, UnitExpr, VarDecl } from "./ir";

/** Where the numbers of functions that keep nothing start; below it a number is a row of the pool. */
export const FN_BASE = 1 << 20;
/** How many environments and closures can be alive at once in one program (row 0 is none). */
export const CLOSURE_CAP = 1024;
/**
 * Added to a row's count while it is in the queue, so that one read of the count says both: exactly `QUEUED` is a row
 * nothing holds and that is queued already. (A read of a cell at a place worked out in the game costs about seventy
 * conditions and actions; a write, fifteen; an add, which reads nothing, as little.)
 */
export const QUEUED = 1 << 24;

/** The pool of a program: its arrays, its counters, and the functions that make, let go of and sweep rows. */
export interface ClosurePool {
  /** References to each row, plus `QUEUED` while it is in the queue. */
  rc: ArrayDecl;
  /** The function a closure runs (`FN_BASE` + its id); 0 for an environment. */
  fnOf: ArrayDecl;
  /** The environment a row was made in: a closure's, or the one around an environment. */
  parent: ArrayDecl;
  /** Rows whose count reached 0, to look at again at the next wait. */
  queue: ArrayDecl;
  queueN: VarDecl;
  /** Rows given back, to be made again; `next` is the highest row ever made. */
  free: ArrayDecl;
  freeN: VarDecl;
  next: VarDecl;
  warned: VarDecl;
  /** `(fn, parent) → row`: a new row, its parent held. A closure (fn not 0) starts queued, with nothing holding it yet. */
  make: FuncDecl;
  /** `(ref)`: one reference fewer; a row of the pool that nothing holds is queued. */
  drop: FuncDecl;
  /** Every queued row that nothing holds is given back, with what it held. Filled once the program is known. */
  sweep: FuncDecl;
  /** The arrays of the variables kept in environments: of numbers and booleans (`cells`, those that hold functions let go of with the row), of texts (their blocks given back), of units. */
  cells: ArrayDecl[];
  texts: { addr: ArrayDecl; block: ArrayDecl; chars: ArrayDecl }[];
  /** The variables that hold the environment of a run of a block. */
  envVars: Set<string>;
  /**
   * References (B9): the object table's columns of numbers and booleans — a row given back has them emptied, a reference
   * among them let go of — and its arrays that grow, whose blocks a row given back gives back (`refs`: they may hold
   * references, each let go of first).
   */
  objects: ArrayDecl[];
  lists: { ptr: ArrayDecl; len: ArrayDecl; room: ArrayDecl; k: ArrayDecl; of: "number" | "boolean"; refs: boolean }[];
}

export interface PoolMaker {
  newVar(name: string, kind: VarDecl["kind"], at: At, extra?: { shared?: boolean; temp?: boolean }): VarDecl;
  newArray(name: string, kind: "number" | "boolean", length: number, at: At, extra?: { shared?: boolean }): ArrayDecl;
  fnId(name: string): string;
}

const num = (value: number): NumExpr => ({ kind: "const", value });
const ref = (v: VarDecl): NumExpr => ({ kind: "var", id: v.id });
const el = (a: ArrayDecl, index: NumExpr, at: At): NumExpr => ({ kind: "element", array: a.id, index, at });
const plus = (left: NumExpr, right: NumExpr, at: At, label: string): NumExpr => ({ kind: "binary", op: "+", left, right, at, label });
const minus = (left: NumExpr, right: NumExpr, at: At, label: string): NumExpr => ({ kind: "binary", op: "-", left, right, at, label });
const cmp = (op: "<" | "<=" | ">" | ">=" | "==" | "!=", left: NumExpr, right: NumExpr, at: At, label: string): BoolExpr => ({ kind: "compare", op, left, right, at, label });

export function makePool(m: PoolMaker, at: At): ClosurePool {
  const label = "(closures)";
  // Each player's run of a per-player program has its own pool: what it makes it calls.
  const shared = { shared: false };
  const a = (name: string, kind: "number" | "boolean" = "number") => m.newArray(`(closures ${name})`, kind, CLOSURE_CAP, at, shared);
  const v = (name: string, kind: VarDecl["kind"] = "number") => m.newVar(`(closures ${name})`, kind, at, shared);
  const rc = a("references"), fnOf = a("function"), parent = a("parent"), queue = a("queue"), free = a("free");
  const queueN = v("queued count"), freeN = v("free count"), next = v("made"), warned = v("warned", "boolean");

  // make(fn, parent): a row from those given back, else one never made; none left, said once, and 0.
  const fn = m.newVar("(function)", "number", at), up = m.newVar("(parent)", "number", at), s = m.newVar("(row)", "number", at, { temp: true });
  const made = m.newVar("(made row)", "number", at, { temp: true });
  const make: FuncDecl = { id: m.fnId("(make an environment)"), name: "(make an environment)", params: [fn, up], result: { decl: made, kind: "number" }, body: [], at };
  const queueRow = (row: NumExpr): Stmt[] => [
    { kind: "store", array: queue.id, index: ref(queueN), value: row, at, label },
    { kind: "assign", target: queueN.id, value: plus(ref(queueN), num(1), at, label), at, label },
  ];
  make.body = [
    { kind: "declare", decl: s, init: num(0), at, label },
    { kind: "if", cond: cmp(">", ref(freeN), num(0), at, label), then: [
      { kind: "assign", target: freeN.id, value: minus(ref(freeN), num(1), at, label), at, label },
      { kind: "assign", target: s.id, value: el(free, ref(freeN), at), at, label },
    ], else: [
      { kind: "if", cond: cmp("<", ref(next), num(CLOSURE_CAP - 1), at, label), then: [
        { kind: "assign", target: next.id, value: plus(ref(next), num(1), at, label), at, label },
        { kind: "assign", target: s.id, value: ref(next), at, label },
      ], at, label },
    ], at, label },
    { kind: "if", cond: cmp("==", ref(s), num(0), at, label), then: [
      { kind: "if", cond: { kind: "not", expr: { kind: "var", id: warned.id } }, then: [
        { kind: "assignBool", target: warned.id, value: { kind: "const", value: true }, at, label },
        { kind: "print", parts: [{ kind: "text", text: `\x08TrigScript: more than ${CLOSURE_CAP - 1} closures and their variables are kept at once; a new one does nothing.` }], to: 17, position: "chat", at, label },
      ], at, label },
      { kind: "return", value: num(0), at, label },
    ], at, label },
    { kind: "store", array: fnOf.id, index: ref(s), value: ref(fn), at, label },
    { kind: "store", array: parent.id, index: ref(s), value: ref(up), at, label },
    ...hold(rc, ref(up), at, label),
    // A closure starts with nothing holding it, queued: kept by the time of the next wait, or given back then.
    { kind: "if", cond: cmp("!=", ref(fn), num(0), at, label), then: [{ kind: "store", array: rc.id, index: ref(s), value: num(QUEUED), at, label }, ...queueRow(ref(s))],
      else: [{ kind: "store", array: rc.id, index: ref(s), value: num(0), at, label }], at, label },
    { kind: "return", value: ref(s), at, label },
  ];

  // drop(ref): one fewer; nothing holding it and not queued yet (the count reaches exactly 0), queued.
  const r = m.newVar("(reference)", "number", at), n = m.newVar("(count)", "number", at, { temp: true });
  const drop: FuncDecl = { id: m.fnId("(let go of an environment)"), name: "(let go of an environment)", params: [r], body: [
    { kind: "declare", decl: n, init: minus(el(rc, ref(r), at), num(1), at, label), at, label },
    { kind: "if", cond: cmp("==", ref(n), num(0), at, label), then: [{ kind: "assign", target: n.id, value: num(QUEUED), at, label }, ...queueRow(ref(r))], at, label },
    { kind: "store", array: rc.id, index: ref(r), value: ref(n), at, label },
  ], at };

  const sweep: FuncDecl = { id: m.fnId("(sweep the environments)"), name: "(sweep the environments)", params: [], body: [], at };
  return { rc, fnOf, parent, queue, queueN, free, freeN, next, warned, make, drop, sweep, cells: [], texts: [], envVars: new Set(), objects: [], lists: [] };
}

/** One reference more: `rc[x] += 1` for a row of the pool (0 and numbers of plain functions are left alone; rc[0] is never read). */
function hold(rc: ArrayDecl, x: NumExpr, at: At, label: string): Stmt[] {
  return [{ kind: "if", cond: cmp("<", x, num(FN_BASE), at, label), then: [{ kind: "store", array: rc.id, index: x, value: plus(el(rc, x, at), num(1), at, label), at, label }], at, label }];
}

/** One reference fewer, through `drop` when `x` is a row at all. A cell is read once, into a temporary. */
function release(pool: ClosurePool, x: NumExpr, at: At, label: string, m?: PoolMaker): Stmt[] {
  const out: Stmt[] = [];
  if (x.kind !== "var" && x.kind !== "const") {
    const t = m!.newVar("(reference)", "number", at, { temp: true });
    out.push({ kind: "declare", decl: t, init: x, at, label });
    x = ref(t);
  }
  const call: Call = { name: pool.drop.name, fn: pool.drop.id, at, label, params: [{ decl: pool.drop.params[0], init: x, label }], body: [] };
  out.push({ kind: "if", cond: { kind: "and", items: [cmp(">", x, num(0), at, label), cmp("<", x, num(FN_BASE), at, label)] }, then: [{ kind: "call", call, at, label }], at, label });
  return out;
}

const isCall = (o: Record<string, unknown>): boolean => Array.isArray(o.params) && Array.isArray(o.body) && typeof o.label === "string" && "at" in o && !("kind" in o);

/**
 * The counting, once the program is walked: which variables and arrays may hold a reference (what a `make` gave, and
 * whatever was given one of those, to a fixed point), then every place that stores into one holds the new reference
 * and lets go of the old, and every wait of the program sweeps first. Parameters and a call's result are not counted:
 * they live no longer than the statement or the call that set them. Gives the problems it found, in words.
 */
export function countReferences(program: Pick<Program, "body">, functions: FuncDecl[], pool: ClosurePool, m: PoolMaker): { at: At; message: string }[] {
  const problems: { at: At; message: string }[] = [];
  const own = new Set([pool.make.id, pool.drop.id, pool.sweep.id]);
  const byId = new Map(functions.map((f) => [f.id, f]));
  const decls = new Map<string, VarDecl>();
  const params = new Set<string>();
  const vars = new Set<string>(pool.envVars);
  const arrays = new Set<string>([pool.parent.id]);
  const slices = new Map<string, string>();
  const bodies = [program.body, ...functions.filter((f) => !own.has(f.id)).map((f) => f.body)];

  const isRef = (e: NumExpr | BoolExpr | UnitExpr | TextExpr | undefined): boolean => {
    if (!e) return false;
    switch (e.kind) {
      case "call": return e.call.fn === pool.make.id || (!!e.call.result && vars.has(e.call.result.decl.id));
      case "var": return vars.has(e.id);
      case "element": case "pop": return arrays.has(e.array);
      case "ternary": return isRef(e.whenTrue as NumExpr) || isRef(e.whenFalse as NumExpr);
      default: return false;
    }
  };
  // What may hold a reference, to a fixed point.
  for (let changed = true; changed;) {
    changed = false;
    const addVar = (id: string) => { if (!vars.has(id)) { vars.add(id); changed = true; } };
    const addArray = (id: string) => { if (!arrays.has(id)) { arrays.add(id); changed = true; } };
    const visit = (root: unknown, result: string | undefined): void => {
      if (Array.isArray(root)) { for (const x of root) visit(x, result); return; }
      if (!root || typeof root !== "object") return;
      const o = root as Record<string, unknown>;
      if (isCall(o)) {
        const c = o as unknown as Call;
        for (const p of c.params) { decls.set(p.decl.id, p.decl); params.add(p.decl.id); if (isRef(p.init)) addVar(p.decl.id); visit(p.init, result); }
        if (c.fn) { const f = byId.get(c.fn); if (f?.result && c.result && vars.has(f.result.decl.id)) addVar(c.result.decl.id); }
        if (c.result) decls.set(c.result.decl.id, c.result.decl);
        visit(c.body, c.fn ? undefined : c.result?.decl.id);
        return;
      }
      const s = o as unknown as Stmt;
      switch (s.kind) {
        case "declare": decls.set(s.decl.id, s.decl); if (isRef(s.init)) addVar(s.decl.id); break;
        case "assign": if (isRef(s.value)) addVar(s.target); break;
        case "store": case "push": if (isRef(s.value)) addArray(s.array); break;
        case "declareArray": if (s.init?.some(isRef) || isRef(s.fill)) addArray(s.array); break;
        case "return": if (result && isRef(s.value)) addVar(result); break;
        default: break;
      }
      for (const [k, v] of Object.entries(o)) if (k !== "decl" && v && typeof v === "object") visit(v, result);
    };
    visit(program.body, undefined);
    for (const f of functions) {
      if (own.has(f.id)) continue;
      for (const p of f.params) { decls.set(p.id, p); params.add(p.id); }
      visit(f.body, f.result?.decl.id);
    }
  }
  void slices;

  // Only what a wait may come between its declaration and a use of needs counting: a wait is where rows are given back,
  // so a variable read before any (a loop's `const e = enemies[i]`, a called function's locals, which never wait) holds
  // nothing a sweep could take from it. Environments are counted always: one is given back only when let go of.
  const acrossWaits = new Set<string>();
  const parks = (root: unknown): boolean => {
    if (Array.isArray(root)) return root.some(parks);
    if (!root || typeof root !== "object") return false;
    const o = root as Record<string, unknown>;
    // A task started here may read the variable on later frames, and its own waits sweep: counted as a wait.
    if (o.kind === "sleep" || o.kind === "parallel" || o.kind === "start") return true;
    for (const v of Object.values(o)) if (v && typeof v === "object" && parks(v)) return true;
    return false;
  };
  const lists = (root: unknown): void => {
    if (!root || typeof root !== "object") return;
    if (Array.isArray(root)) {
      // A list of statements (a `call` and a `pop` stand as statements too).
      if (root.length && root.every((x) => x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string" && (isStmtKind((x as { kind: string }).kind) || (x as { kind: string }).kind === "call" || (x as { kind: string }).kind === "pop"))) {
        root.forEach((st, i) => { if ((st as Stmt).kind === "declare" && parks(root.slice(i + 1))) acrossWaits.add((st as Stmt & { kind: "declare" }).decl.id); });
      }
      for (const x of root) lists(x);
      return;
    }
    for (const v of Object.values(root as Record<string, unknown>)) if (v && typeof v === "object") lists(v);
  };
  lists(program.body);
  const counted = (id: string) => vars.has(id) && !params.has(id) && !decls.get(id)?.temp && (acrossWaits.has(id) || pool.envVars.has(id));
  const at0 = (s: { at?: At }): At => s.at ?? pool.make.at;
  const tmp = (name: string, at: At) => m.newVar(name, "number", at, { temp: true });
  const sweepCall = (at: At, label: string): Stmt => ({ kind: "if", cond: cmp(">", ref(pool.queueN), num(0), at, label), then: [{ kind: "call", call: { name: pool.sweep.name, fn: pool.sweep.id, at, label, params: [], body: [] }, at, label }], at, label });
  const rc = pool.rc;
  const lengthOf = (a: string, at: At): NumExpr => ({ kind: "length", array: a, at });
  /** Over every cell of an array in use: `do` with the cell. */
  const eachCell = (a: string, at: At, label: string, from: NumExpr, act: (cell: NumExpr) => Stmt[]): Stmt[] => {
    const k = tmp("(cell)", at);
    const cell: NumExpr = { kind: "element", array: a, index: ref(k), at };
    return [
      { kind: "declare", decl: k, init: from, at, label },
      { kind: "while", cond: cmp("<", ref(k), lengthOf(a, at), at, label), body: [...act(cell), { kind: "assign", target: k.id, value: plus(ref(k), num(1), at, label), at, label }], at, label },
    ];
  };
  /** The pops of counted arrays among a statement's own expressions (not inside the statements it holds). */
  const popsIn = (s: Stmt): string[] => {
    const found: string[] = [];
    const look = (root: unknown, top: boolean): void => {
      if (Array.isArray(root)) { for (const x of root) look(x, false); return; }
      if (!root || typeof root !== "object") return;
      const o = root as Record<string, unknown>;
      if (!top && typeof o.kind === "string" && isStmtKind(o.kind)) return;
      if (isCall(o)) { for (const p of (o as unknown as Call).params) look(p.init, false); return; }
      if (o.kind === "pop" && typeof o.array === "string" && !top && arrays.has(o.array)) found.push(o.array);
      for (const v of Object.values(o)) if (v && typeof v === "object") look(v, false);
    };
    look(s, true);
    return found;
  };

  const rewrite = (list: Stmt[], waits: boolean): Stmt[] => {
    const out: Stmt[] = [];
    for (const s of list) {
      nested(s, waits);
      const at = at0(s), label = "label" in s ? s.label : "(closures)";
      if (s.kind !== "while" && s.kind !== "do" && s.kind !== "for") {
        const pops = popsIn(s);
        const seen = new Map<string, number>();
        for (const a of pops) {
          const k = (seen.get(a) ?? 0) + 1;
          seen.set(a, k);
          out.push(...release(pool, { kind: "element", array: a, index: minus(lengthOf(a, at), num(k), at, label), at }, at, label, m));
        }
      }
      switch (s.kind) {
        case "declare": case "assign": {
          const target = s.kind === "declare" ? s.decl.id : s.target;
          if (!counted(target)) break;
          if (s.kind === "declare") s.decl.held = true;
          const t = tmp("(reference)", at);
          out.push({ kind: "declare", decl: t, init: s.kind === "declare" ? s.init : s.value, at, label }, ...hold(rc, ref(t), at, label), ...release(pool, { kind: "var", id: target }, at, label));
          out.push(s.kind === "declare" ? { ...s, init: ref(t) } : { ...s, value: ref(t) });
          continue;
        }
        case "store": {
          if (!arrays.has(s.array)) break;
          const i = tmp("(place)", at), t = tmp("(reference)", at);
          out.push({ kind: "declare", decl: i, init: s.index, at, label }, { kind: "declare", decl: t, init: s.value as NumExpr, at, label }, ...hold(rc, ref(t), at, label),
            ...release(pool, { kind: "element", array: s.array, index: ref(i), at }, at, label, m), { ...s, index: ref(i), value: ref(t) });
          continue;
        }
        case "push": {
          if (!arrays.has(s.array)) break;
          const t = tmp("(reference)", at);
          out.push({ kind: "declare", decl: t, init: s.value as NumExpr, at, label }, ...hold(rc, ref(t), at, label), { ...s, value: ref(t) });
          continue;
        }
        case "pop": {
          if (!arrays.has(s.array)) break;
          out.push(...release(pool, { kind: "element", array: s.array, index: minus(lengthOf(s.array, at), num(1), at, label), at }, at, label, m), s);
          continue;
        }
        case "setLength": {
          if (!arrays.has(s.array)) break;
          const n = tmp("(length)", at);
          out.push({ kind: "declare", decl: n, init: s.value, at, label }, ...eachCell(s.array, at, label, ref(n), (cell) => release(pool, cell, at, label, m)), { ...s, value: ref(n) });
          continue;
        }
        case "declareArray": {
          if (!arrays.has(s.array)) break;
          out.push(...eachCell(s.array, at, label, num(0), (cell) => release(pool, cell, at, label, m)), s, ...eachCell(s.array, at, label, num(0), (cell) => hold(rc, cell, at, label)));
          continue;
        }
        case "start": {
          // A closure handed to a task (its parameter, which nothing counts) is held by the program for the task's slot
          // until another task takes the slot: kept while the task runs, let go of once a later one starts there.
          const kept = s.call.params.filter((p) => isRef(p.init));
          if (!kept.length) break;
          const temps = kept.map((p) => { const t = tmp("(handed to the task)", at); out.push({ kind: "declare", decl: t, init: p.init as NumExpr, at, label }); p.init = ref(t); return t; });
          const handle = s.handle ? decls.get(s.handle) ?? m.newVar("(task)", "number", at) : m.newVar("(task)", "number", at);
          if (!s.handle) s.handle = handle.id;
          out.push(s);
          const slot = tmp("(slot)", at);
          const then: Stmt[] = [{ kind: "declare", decl: slot, init: { kind: "binary", op: "%", left: { kind: "var", id: s.handle }, right: num(256), at, label }, at, label }];
          temps.forEach((t, i) => {
            const held = m.newArray(`(closures of task ${s.task} ${i})`, "number", 256, at);
            then.push(...hold(rc, ref(t), at, label), ...release(pool, el(held, ref(slot), at), at, label, m), { kind: "store", array: held.id, index: ref(slot), value: ref(t), at, label });
          });
          out.push({ kind: "if", cond: cmp(">", { kind: "var", id: s.handle }, num(0), at, label), then, at, label });
          continue;
        }
        case "sleep": if (waits) out.push(sweepCall(at, label)); break;
        default: break;
      }
      out.push(s);
    }
    return out;
  };
  /** The statement lists a statement holds, rewritten in place; calls inside its expressions too. */
  const nested = (s: Stmt, waits: boolean): void => {
    const calls = (root: unknown): void => {
      if (Array.isArray(root)) { for (const x of root) calls(x); return; }
      if (!root || typeof root !== "object") return;
      const o = root as Record<string, unknown>;
      if (typeof o.kind === "string" && isStmtKind(o.kind) && o !== s) return;
      if (isCall(o)) { const c = o as unknown as Call; for (const p of c.params) calls(p.init); c.body = rewrite(c.body, waits); return; }
      for (const v of Object.values(o)) if (v && typeof v === "object") calls(v);
    };
    switch (s.kind) {
      case "if": s.then = rewrite(s.then, waits); if (s.else) s.else = rewrite(s.else, waits); calls(s.cond); break;
      case "while": s.body = rewrite(s.body, waits); if (s.cond) calls(s.cond); break;
      case "do": s.body = rewrite(s.body, waits); calls(s.cond); break;
      case "for": s.body = rewrite(s.body, waits); s.update = rewrite(s.update, waits); if (s.cond) calls(s.cond); break;
      case "unrolled": s.iterations = s.iterations.map((it) => rewrite(it, waits)); break;
      case "switch": for (const c of s.cases) c.body = rewrite(c.body, waits); calls(s.value); break;
      case "parallel": s.branches = s.branches.map((b) => rewrite(b, waits)); break;
      case "block": s.body = rewrite(s.body, waits); break;
      case "try": s.body = rewrite(s.body, waits); s.catch = rewrite(s.catch, waits); break;
      case "textLoop": case "unitLoop": s.body = rewrite(s.body, waits); calls(s); break;
      case "start": s.call.body = rewrite(s.call.body, true); for (const p of s.call.params) calls(p.init); break;
      default: calls(s); break;
    }
  };
  const start: Stmt[] = [
    ...[pool.queueN, pool.freeN, pool.next].map((v): Stmt => ({ kind: "declare", decl: v, init: num(0), at: pool.make.at, label: "(closures)" })),
    { kind: "declare", decl: pool.warned, init: { kind: "const", value: false }, at: pool.make.at, label: "(closures)" },
  ];
  program.body.splice(0, program.body.length, ...start, ...rewrite(program.body, true));
  for (const f of functions) if (!own.has(f.id)) f.body = rewrite(f.body, false);
  void bodies;

  // The sweep: every queued row nothing holds goes back, letting go of its parent and of the functions its variables held.
  const at = pool.sweep.at, label = "(closures)";
  const s = m.newVar("(row)", "number", at, { temp: true }), count = m.newVar("(count)", "number", at, { temp: true });
  const row = ref(s);
  pool.sweep.body = [{ kind: "while", cond: cmp(">", ref(pool.queueN), num(0), at, label), body: [
    { kind: "assign", target: pool.queueN.id, value: minus(ref(pool.queueN), num(1), at, label), at, label },
    { kind: "declare", decl: s, init: el(pool.queue, ref(pool.queueN), at), at, label },
    { kind: "declare", decl: count, init: el(pool.rc, row, at), at, label },
    { kind: "if", cond: cmp("==", ref(count), num(QUEUED), at, label), then: [
      { kind: "store", array: pool.rc.id, index: row, value: num(0), at, label },
      ...release(pool, el(pool.parent, row, at), at, label, m),
      ...pool.cells.filter((a) => arrays.has(a.id)).flatMap((a): Stmt[] => [...release(pool, el(a, row, at), at, label, m), { kind: "store", array: a.id, index: row, value: num(0), at, label }]),
      ...pool.texts.map((t): Stmt => ({ kind: "releaseText", block: t.block.id, index: row, at, label })),
      // An object's row: what it held let go of, its arrays' blocks given back, its cells emptied for the next one made there.
      ...pool.objects.flatMap((a): Stmt[] => [...(arrays.has(a.id) ? release(pool, el(a, row, at), at, label, m) : []), { kind: "store", array: a.id, index: row, value: a.kind === "boolean" ? { kind: "const", value: false } : num(0), at, label }]),
      ...pool.lists.flatMap((l): Stmt[] => {
        const inner = m.newArray(`(objects) ${l.ptr.name} (given back)`, l.of, 0, at);
        inner.dynamic = true;
        inner.through = { ptr: l.ptr.id, len: l.len.id, room: l.room.id, k: l.k.id, index: s.id };
        return [...(l.refs ? eachCell(inner.id, at, label, num(0), (cell) => release(pool, cell, at, label, m)) : []), { kind: "declareArray", array: inner.id, init: [], at, label }];
      }),
      { kind: "store", array: pool.free.id, index: ref(pool.freeN), value: row, at, label },
      { kind: "assign", target: pool.freeN.id, value: plus(ref(pool.freeN), num(1), at, label), at, label },
    ], else: [
      // Held again since it was queued: out of the queue, its count as it is.
      { kind: "store", array: pool.rc.id, index: row, value: minus(ref(count), num(QUEUED), at, label), at, label },
    ], at, label },
  ], at, label }];
  return problems;
}

const STMT_KINDS = new Set(["declare", "assignText", "storeText", "releaseText", "textLoop", "assign", "declareArray", "store", "push", "setLength", "assignBool", "assignUnit", "unitLoop", "unitWrite", "unitDo", "tableWrite", "if", "while", "do", "for", "unrolled", "switch", "break", "continue", "return", "sleep", "parallel", "start", "cancel", "action", "syncSend", "select", "centerLocation", "print", "buildText", "block", "try", "throw", "uncaught", "remark"]);
/** Whether an IR node of this kind is a statement (`pop` and `call` are both: as an expression they are walked as one). */
function isStmtKind(kind: string): boolean { return STMT_KINDS.has(kind); }
