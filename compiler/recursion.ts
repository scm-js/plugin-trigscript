/**
 * Recursion. A called function's parameters, locals and temporaries are cells of the program, one of each
 * (`structured.ts`), so a function that comes back into itself — directly, or through others — would write over what
 * its outer run still needs. This pass, run over the IR once the numbers are typed, finds the functions on a cycle of
 * the call graph (`FuncDecl.recursive`) and makes each of them safe to re-enter:
 *
 * - **Every call that may come back is a statement of its own.** `fib(n - 1) + fib(n - 2)` becomes two call
 *   statements and an addition of their results. A backend computes an expression through temporaries of its own that
 *   no frame knows of, so nothing may be half computed when such a call is made. What JavaScript evaluates before the
 *   call is evaluated before it still: an operand to the left of one goes into a variable first (unless it is a
 *   constant, or a variable of the function's own, which comes back with the frame). `c ? f(x) : 0`, `a && f(x)` and a
 *   loop's condition with such a call in it become the `if`s they mean, so the call runs only when JavaScript runs it.
 * - **Such a call says what to keep** (`Call.saves`): every variable of the function it is in but the call's own
 *   result, and the handle of every array declared in it. A backend puts those on the stack before the call and takes
 *   them back after, with where the function returns to.
 * - **An array declared in a recursive function is one that grows**, whatever it was: its cells are a block of the heap
 *   reached through a handle, so a run of the function has its own by keeping four cells, not the whole array.
 *
 * A function off every cycle is left exactly as it was, and so is the program's body: only what recurses pays.
 */
import { STACK_DEPTH, UNIT_FLAGS, declarations, eachCall, type At, type BoolExpr, type Call, type FuncDecl, type NumExpr, type Program, type Stmt, type UnitExpr, type VarDecl } from "./ir";
import type { ProgramDiagnostic } from "./eud";

type Kind = "number" | "boolean" | "unit";
type Expr = NumExpr | BoolExpr | UnitExpr;

const FLAGS: ReadonlySet<string> = new Set(UNIT_FLAGS);
const CELLS: Record<Kind, number> = { number: 1, boolean: 1, unit: 3 };
const HANDLE_CELLS = 4;

/** Whether a node of this kind is anywhere in a piece of IR. */
function mentions(root: unknown, kind: string): boolean {
  if (Array.isArray(root)) return root.some((x) => mentions(x, kind));
  if (!root || typeof root !== "object") return false;
  const o = root as Record<string, unknown>;
  if (o.kind === kind) return true;
  return Object.values(o).some((v) => !!v && typeof v === "object" && mentions(v, kind));
}

/** The cells of one frame: what the call keeps, and where its function returns to. */
export function frameCells(program: Pick<Program, "body" | "functions">, saves: NonNullable<Call["saves"]>, kinds?: Map<string, Kind>): number {
  const k = kinds ?? kindsOf(program);
  return 1 + saves.arrays.length * HANDLE_CELLS + saves.vars.reduce((n, id) => n + CELLS[k.get(id) ?? "number"], 0);
}

function kindsOf(program: Pick<Program, "body" | "functions">): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const d of declarations(program.body)) out.set(d.id, d.kind);
  for (const f of program.functions ?? []) for (const d of [...f.params, ...(f.result ? [f.result.decl] : []), ...declarations(f.body)]) out.set(d.id, d.kind);
  return out;
}

/** The largest frame any of the programs has; 0 when nothing recurses. */
export function largestFrame(programs: readonly Program[]): number {
  let most = 0;
  for (const p of programs) {
    if (!p.functions?.some((f) => f.recursive)) continue;
    const kinds = kindsOf(p);
    eachCall(p.functions, (c) => { if (c.saves) most = Math.max(most, frameCells(p, c.saves, kinds)); });
  }
  return most;
}

/** The functions on a cycle of the call graph, by id: Tarjan's strongly connected components over who calls whom. */
function cycles(functions: FuncDecl[]): Map<string, number> {
  const ids = new Set(functions.map((f) => f.id));
  const edges = new Map<string, Set<string>>();
  for (const f of functions) {
    const to = new Set<string>();
    eachCall(f.body, (c) => { if (c.fn && ids.has(c.fn)) to.add(c.fn); });
    edges.set(f.id, to);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const component = new Map<string, number>();
  let next = 0;
  let components = 0;
  // Iterative, so a long chain of functions is not a deep recursion of the compiler's own.
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; out: string[]; i: number }[] = [];
    const enter = (id: string) => { index.set(id, next); low.set(id, next); next++; stack.push(id); on.add(id); work.push({ id, out: [...edges.get(id)!], i: 0 }); };
    enter(root);
    while (work.length) {
      const w = work[work.length - 1];
      if (w.i < w.out.length) {
        const to = w.out[w.i++];
        if (!index.has(to)) enter(to);
        else if (on.has(to)) low.set(w.id, Math.min(low.get(w.id)!, index.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(w.id)!));
      if (low.get(w.id) !== index.get(w.id)) continue;
      const members: string[] = [];
      for (;;) { const id = stack.pop()!; on.delete(id); members.push(id); if (id === w.id) break; }
      if (members.length > 1 || edges.get(w.id)!.has(w.id)) { for (const id of members) component.set(id, components); components++; }
    }
  }
  return component;
}

/**
 * Which functions are on a cycle, said before anything checks the program: `recursive` on each, and a word more in the
 * hint its line carries. `settleRecursion` does the rest once the program has been checked as the script wrote it.
 */
export function markRecursion(program: Program): void {
  const functions = program.functions ?? [];
  const component = cycles(functions);
  for (const f of functions) {
    if (!component.has(f.id)) continue;
    f.recursive = true;
    const remark = f.body[0];
    if (remark?.kind !== "remark") continue;
    remark.short = `${remark.short ?? "called"}, calls itself`;
    remark.text = `${remark.text} It calls itself: around each such call its variables are kept on a stack, as deep as the script's Settings allow (${STACK_DEPTH.toLocaleString("en-US")} calls unless the map says otherwise).`;
  }
}

export function settleRecursion(program: Program): ProgramDiagnostic[] {
  const functions = program.functions ?? [];
  const component = cycles(functions);
  if (!component.size) return [];
  const errors: ProgramDiagnostic[] = [];
  const arrays = new Map(program.arrays.map((a) => [a.id, a]));
  let nextId = 0;

  for (const f of functions) {
    const mine = component.get(f.id);
    if (mine === undefined) continue;
    f.recursive = true;

    /** The function's own variables: what a frame brings back, so a read of one needs no copy made before a call. */
    const own = new Set<string>([...f.params, ...(f.result ? [f.result.decl] : []), ...declarations(f.body)].map((d) => d.id));
    const comesBack = (c: Call): boolean => (c.fn ? component.get(c.fn) === mine : risky([c.params.map((p) => p.init), c.body]));
    const risky = (root: unknown): boolean => { let found = false; eachCall(root, (c) => { if (c.fn && component.get(c.fn) === mine) found = true; }); return found; };

    const temp = (name: string, kind: Kind, at: At): VarDecl => {
      const decl: VarDecl = { id: `(${name})#r${nextId++}`, name: `(${name})`, kind, shared: false, temp: true, at };
      own.add(decl.id);
      return decl;
    };
    const ref = (decl: VarDecl): Expr => (decl.kind === "unit" ? { kind: "unitVar", id: decl.id } : { kind: "var", id: decl.id });

    /** Where a statement made here says it is: the statement being rewritten. */
    interface Where { at: At; label: string }

    /** Whether an operand, already rewritten, reads the same after a call as before it. */
    const steady = (e: Expr): boolean => e.kind === "const" || e.kind === "unitNull" || ((e.kind === "var" || e.kind === "unitVar") && own.has(e.id));

    /** Operands in the order JavaScript evaluates them: each rewritten, and kept in a variable when a later one holds a call that may come back. */
    const operands = (items: { e: Expr; kind: Kind }[], pre: Stmt[], w: Where): Expr[] => {
      let last = -1;
      items.forEach((x, i) => { if (risky(x.e)) last = i; });
      return items.map((x, i) => {
        const e = rewrite(x.e, x.kind, pre, w);
        if (i >= last || steady(e)) return e;
        const decl = temp("kept", x.kind, w.at);
        pre.push({ kind: "declare", decl, init: e, at: w.at, label: w.label });
        return ref(decl);
      });
    };

    /** A call's arguments, and an inlined call's body. */
    const settleCall = (c: Call, pre: Stmt[], w: Where) => {
      const inits = operands(c.params.map((p) => ({ e: p.init, kind: p.decl.kind })), pre, w);
      c.params.forEach((p, i) => { p.init = inits[i]; });
      if (!c.fn) c.body = body(c.body, c.result?.kind);
    };

    /** A value worked out by an `if`: the variable it ends up in. */
    const choice = (kind: "number" | "boolean", cond: BoolExpr, whenTrue: Expr, whenFalse: Expr, pre: Stmt[], w: Where): Expr => {
      const decl = temp("chosen", kind, w.at);
      const arm = (e: Expr): Stmt[] => {
        const inner: Stmt[] = [];
        const value = rewrite(e, kind, inner, w);
        inner.push(kind === "number" ? { kind: "assign", target: decl.id, value: value as NumExpr, at: w.at, label: w.label } : { kind: "assignBool", target: decl.id, value: value as BoolExpr, at: w.at, label: w.label });
        return inner;
      };
      const c = rewrite(cond, "boolean", pre, w) as BoolExpr;
      pre.push({ kind: "declare", decl, init: kind === "number" ? { kind: "const", value: 0 } : { kind: "const", value: false }, at: w.at, label: w.label });
      pre.push({ kind: "if", cond: c, then: arm(whenTrue), else: arm(whenFalse), at: w.at, label: w.label });
      return ref(decl);
    };

    /** `a && f(x)`, `a || f(x)`: what stands before the first call that may come back is one condition; each item from there on runs only when the ones before it have not decided. */
    const chain = (e: BoolExpr & { kind: "and" | "or" }, pre: Stmt[], w: Where): BoolExpr => {
      const k = e.items.findIndex((item, i) => i >= 1 && risky(item));
      if (k < 0) return { ...e, items: operands(e.items.map((x) => ({ e: x, kind: "boolean" as const })), pre, w) as BoolExpr[] };
      const head = e.items.slice(0, k).map((x) => rewrite(x, "boolean", pre, w) as BoolExpr);
      const decl = temp("so far", "boolean", w.at);
      pre.push({ kind: "declare", decl, init: head.length === 1 ? head[0] : { kind: e.kind, items: head }, at: w.at, label: w.label });
      const undecided: BoolExpr = e.kind === "and" ? { kind: "var", id: decl.id } : { kind: "not", expr: { kind: "var", id: decl.id } };
      for (const item of e.items.slice(k)) {
        const inner: Stmt[] = [];
        const value = rewrite(item, "boolean", inner, w) as BoolExpr;
        inner.push({ kind: "assignBool", target: decl.id, value, at: w.at, label: w.label });
        pre.push({ kind: "if", cond: undecided, then: inner, at: w.at, label: w.label });
      }
      return { kind: "var", id: decl.id };
    };

    /** An expression with every call that may come back taken out of it, into `pre`. */
    const rewrite = (e: Expr, kind: Kind, pre: Stmt[], w: Where): Expr => {
      if (!risky(e)) return e;
      const one = (x: Expr, k: Kind) => rewrite(x, k, pre, w);
      switch (e.kind) {
        case "call": {
          const c = e.call;
          if (!comesBack(c)) { settleCall(c, pre, w); return e; }
          settleCall(c, pre, { at: c.at, label: c.label });
          pre.push({ kind: "call", call: c, at: c.at, label: c.label });
          return c.result ? ref(c.result.decl) : kind === "number" ? { kind: "const", value: 0 } : kind === "boolean" ? { kind: "const", value: false } : { kind: "unitNull" };
        }
        case "ternary":
          if (risky(e.whenTrue) || risky(e.whenFalse)) return choice(kind === "boolean" ? "boolean" : "number", e.cond, e.whenTrue, e.whenFalse, pre, w);
          return { ...e, cond: one(e.cond, "boolean") } as Expr;
        case "and": case "or": return chain(e, pre, w);
        case "not": return { ...e, expr: one(e.expr, "boolean") as BoolExpr };
        case "test": return { ...e, expr: one(e.expr, "number") as NumExpr };
        case "edge": return { ...e, cond: one(e.cond, "boolean") as BoolExpr };
        case "unary": case "cast": return { ...e, expr: one(e.expr, "number") as NumExpr } as Expr;
        case "element": return { ...e, index: one(e.index, "number") as NumExpr } as Expr;
        case "randomInt": return { ...e, bound: one(e.bound, "number") as NumExpr };
        case "unitField": case "unitPart": return { ...e, unit: one(e.unit, "unit") as UnitExpr } as Expr;
        case "unitAlive": case "unitFlag": return { ...e, unit: one(e.unit, "unit") as UnitExpr } as Expr;
        case "binary": case "compare": {
          const [left, right] = operands([{ e: e.left, kind: "number" }, { e: e.right, kind: "number" }], pre, w) as NumExpr[];
          return { ...e, left, right } as Expr;
        }
        case "unitSame": {
          const [left, right] = operands([{ e: e.left, kind: "unit" }, { e: e.right, kind: "unit" }], pre, w) as UnitExpr[];
          return { ...e, left, right };
        }
        case "intrinsic": return { ...e, args: operands(e.args.map((a) => ({ e: a, kind: "number" as const })), pre, w) as NumExpr[] };
        case "unitAt": {
          const [ptr, epd, uid] = operands([e.ptr, e.epd, e.uid].map((x) => ({ e: x, kind: "number" as const })), pre, w) as NumExpr[];
          return { ...e, ptr, epd, uid };
        }
        default: return e;
      }
    };

    /** A loop whose condition holds such a call: `while (true)` with the condition worked out, and left on, at the head of its body. */
    const leaveUnless = (cond: BoolExpr, w: Where): Stmt[] => {
      const pre: Stmt[] = [];
      const c = rewrite(cond, "boolean", pre, w) as BoolExpr;
      pre.push({ kind: "if", cond: { kind: "not", expr: c }, then: [{ kind: "break", at: w.at, label: w.label }], at: w.at, label: w.label });
      return pre;
    };

    const body = (statements: Stmt[], returns: Kind | undefined): Stmt[] => {
      const out: Stmt[] = [];
      for (const s of statements) {
        if (!risky(s)) { out.push(s); continue; }
        const w: Where = { at: s.at, label: "label" in s ? s.label : "" };
        const pre: Stmt[] = [];
        const value = (e: Expr, k: Kind) => rewrite(e, k, pre, w);
        const arrayKind = (id: string): Kind => arrays.get(id)?.kind ?? "number";
        switch (s.kind) {
          case "declare": s.init = value(s.init, s.decl.kind); break;
          case "assign": s.value = value(s.value, "number") as NumExpr; break;
          case "assignBool": s.value = value(s.value, "boolean") as BoolExpr; break;
          case "assignUnit": s.value = value(s.value, "unit") as UnitExpr; break;
          case "declareArray":
            if (s.init) s.init = operands(s.init.map((e) => ({ e, kind: arrayKind(s.array) })), pre, w) as (NumExpr | BoolExpr)[];
            if (s.fill) s.fill = value(s.fill, arrayKind(s.array)) as NumExpr | BoolExpr;
            break;
          case "store": {
            // The value first, then the index, as the backends take them.
            const [v, i] = operands([{ e: s.value, kind: arrayKind(s.array) }, { e: s.index, kind: "number" }], pre, w);
            s.value = v as NumExpr | BoolExpr;
            s.index = i as NumExpr;
            break;
          }
          case "push": s.value = value(s.value, arrayKind(s.array)) as NumExpr | BoolExpr; break;
          case "setLength": s.value = value(s.value, "number") as NumExpr; break;
          case "unitWrite": {
            const [u, v] = operands([{ e: s.unit, kind: "unit" }, { e: s.value, kind: FLAGS.has(s.field) ? "boolean" : "number" }], pre, w);
            s.unit = u as UnitExpr;
            s.value = v as NumExpr | BoolExpr;
            break;
          }
          case "unitDo": {
            const items: { e: Expr; kind: Kind }[] = [{ e: s.unit, kind: "unit" }];
            if (s.verb.do === "damage" || s.verb.do === "heal") items.push({ e: s.verb.amount, kind: "number" });
            const done = operands(items, pre, w);
            s.unit = done[0] as UnitExpr;
            if (s.verb.do === "damage" || s.verb.do === "heal") s.verb.amount = done[1] as NumExpr;
            break;
          }
          case "tableWrite": if (s.value.kind !== "text") s.value = value(s.value as NumExpr | BoolExpr, s.boolean ? "boolean" : "number") as NumExpr | BoolExpr; break;
          case "return": if (s.value) s.value = value(s.value, returns ?? "number"); break;
          case "action": {
            const done = operands((s.variables ?? []).map((v) => ({ e: v.expr, kind: "number" as const })), pre, w) as NumExpr[];
            s.variables?.forEach((v, i) => { v.expr = done[i]; });
            break;
          }
          case "centerLocation": [s.x, s.y] = operands([{ e: s.x, kind: "number" }, { e: s.y, kind: "number" }], pre, w) as NumExpr[]; break;
          case "print": {
            const numbers = s.parts.filter((p) => p.kind === "number");
            const done = operands(numbers.map((p) => ({ e: p.expr, kind: "number" as const })), pre, w) as NumExpr[];
            numbers.forEach((p, i) => { p.expr = done[i]; });
            break;
          }
          case "switch":
            s.value = value(s.value, "number") as NumExpr;
            for (const c of s.cases) c.body = body(c.body, returns);
            break;
          case "if":
            s.cond = value(s.cond, "boolean") as BoolExpr;
            s.then = body(s.then, returns);
            if (s.else) s.else = body(s.else, returns);
            break;
          case "while":
            s.body = body(s.body, returns);
            if (s.cond && risky(s.cond)) { s.body = [...leaveUnless(s.cond, w), ...s.body]; delete s.cond; }
            break;
          case "for":
            s.body = body(s.body, returns);
            s.update = body(s.update, returns);
            if (s.cond && risky(s.cond)) { s.body = [...leaveUnless(s.cond, w), ...s.body]; delete s.cond; }
            break;
          case "do": {
            const inner = body(s.body, returns);
            if (!risky(s.cond)) { s.body = inner; break; }
            // The condition is asked before every turn but the first; `continue` comes to the head, which is where it is asked.
            const first = temp("first turn", "boolean", s.at);
            const check: Where = { at: s.at, label: s.condLabel };
            out.push({ kind: "declare", decl: first, init: { kind: "const", value: true }, at: s.at, label: s.label });
            out.push({ kind: "while", at: s.at, label: s.label, body: [
              { kind: "if", cond: { kind: "not", expr: { kind: "var", id: first.id } }, then: leaveUnless(s.cond, check), at: s.at, label: s.condLabel },
              { kind: "assignBool", target: first.id, value: { kind: "const", value: false }, at: s.at, label: s.label },
              ...inner,
            ] });
            continue;
          }
          case "unrolled": s.iterations = s.iterations.map((i) => body(i, returns)); break;
          case "block": s.body = body(s.body, returns); break;
          case "unitLoop":
            errors.push({ at: s.at, message: `${f.name} calls itself, and this loop over units holds such a call: the loop's place among the game's units is not something a call can keep. Collect what the loop finds into an array first, and make the calls from a loop over that array.` });
            s.body = body(s.body, returns);
            break;
          case "call": settleCall(s.call, pre, w); break;
          default: break;
        }
        out.push(...pre, s);
      }
      return out;
    };

    f.body = body(f.body, f.result?.kind);

    // Every call that may come back is a statement by now, so a function with no way out is easy to see.
    const never = (statements: Stmt[]): boolean => {
      for (const s of statements) {
        if (s.kind === "call" && s.call.fn === f.id) return true;
        if (s.kind === "if" && s.else && never(s.then) && never(s.else)) return true;
        if (s.kind === "block" && never(s.body)) return true;
        // Anything else that holds a return (or is one) may be the way out.
        if (s.kind !== "remark" && mentions(s, "return")) return false;
      }
      return false;
    };
    if (never(f.body)) errors.push({ at: f.at, message: `${f.name} calls itself on every path through it, so no call of it ever returns: the stack would run out the first time it is called. Give it a way out — an if that returns before the call.` });

    // An array declared in the function is each run's own: a block of the heap, so that a frame keeps its handle.
    const local: string[] = [];
    const seen = new Set<string>();
    const find = (root: unknown) => {
      if (Array.isArray(root)) { root.forEach(find); return; }
      if (!root || typeof root !== "object") return;
      const o = root as Record<string, unknown>;
      if (o.kind === "declareArray" && typeof o.array === "string" && !seen.has(o.array)) {
        seen.add(o.array);
        const a = arrays.get(o.array);
        // A window or an array reached through another's cells has no handle of its own for a frame to keep.
        if (a && !a.values && !a.slice && !a.through) { a.dynamic = true; local.push(a.id); }
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") find(v);
    };
    find(f.body);

    // What each call that may come back keeps: everything of the function's but what the call itself is about to write.
    const all = [...f.params, ...declarations(f.body)];
    eachCall(f.body, (c) => {
      if (!c.fn || component.get(c.fn) !== mine) return;
      const result = c.result?.decl.id;
      c.saves = { vars: all.filter((d) => d.id !== result).map((d) => d.id), arrays: local, within: f.name };
    });
  }

  return errors;
}
