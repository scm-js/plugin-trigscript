/**
 * The classic backend: lowers the IR (`ir.ts`) to the trigger machine in `lower.ts` —
 * death counters and switches, one trigger cycle per loop iteration, everything the
 * game before Remastered can run. What it does with each construct, and what each
 * costs, is documented at `Machine`; this file is the walk from the IR to those calls.
 *
 * Errors it raises are the target's own — no death counter free, a division by a
 * variable, a condition that expands to too many cases — and are reported at the IR
 * node, which the emitter maps back to the source.
 */
import { Comparison, SetModifier, SwitchAction } from "../vendor/triggers";
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import type { BoolExpr, Call, CompareOp, NumExpr, Program, Stmt, VarDecl } from "./ir";
import {
  and, bitLength, bitsOf, boolCondition, compareConst, cond, deathsCondition, FALSE, flipOp, LowerError, Machine, maxOf, not, or, setBool, setDeaths, setSwitch, switchCondition, TRUE, U32_MAX, widthOf,
  type Bool, type BoolVar, type DcVar, type Linear, type Var,
} from "./lower";
import { compareNumbers } from "./structured";

export interface ClassicContext {
  machine: Machine;
  program: Program;
  /** Report a problem at an IR node (the emitter maps it back to the source). */
  error(node: object, message: string): void;
  /** Collects the map's records the body puts in the output — conditions tested, actions run — for the allocator to keep clear of. */
  touched?: (ConditionRecord | ActionRecord)[];
}

interface Ctx {
  breakTo?: () => number;
  continueTo?: () => number;
  /** Inside an inlined function: where `return` goes, and what it returns into. */
  fn?: { end: () => number; kind: "number" | "boolean" | "void"; result?: DcVar };
}

const sameCell = (a: DcVar, b: DcVar) => a.player === b.player && a.unit === b.unit;

/** `k` times a linear expression. */
function scale(l: Linear, k: number): Linear {
  if (k === 0) return { c: 0, terms: [] };
  return { c: l.c * k, terms: l.terms.map((t) => ({ v: t.v, k: t.k * k })) };
}

/** `l + r`, terms of one variable merged, zero terms dropped. */
function merge(l: Linear, r: Linear): Linear {
  const terms: Linear["terms"] = [];
  for (const t of [...l.terms, ...r.terms]) {
    const hit = terms.find((x) => sameCell(x.v, t.v));
    if (hit) hit.k += t.k;
    else terms.push({ v: t.v, k: t.k });
  }
  return { c: l.c + r.c, terms: terms.filter((t) => t.k !== 0) };
}

const isConst = (l: Linear) => l.terms.length === 0;
const single = (l: Linear): DcVar | null => (l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1 ? l.terms[0].v : null);
const ofVar = (v: DcVar): Linear => ({ c: 0, terms: [{ v, k: 1 }] });

export class Classic {
  private readonly c: ClassicContext;
  private readonly m: Machine;
  private readonly vars = new Map<string, Var>();
  /** After `break` / `continue` / `return` / an endless loop: the next statement needs a state of its own. */
  private dead = false;
  private scratchUsed = 0;
  /** The statement being lowered, where an error with no node of its own lands. */
  private current: object;

  constructor(c: ClassicContext) {
    this.c = c;
    this.m = c.machine;
    this.current = c.program;
    this.m.file = c.program.at.file;
  }

  run() {
    const { body } = this.c.program;
    try {
      this.block(body, {});
      if (!this.dead) this.m.jump(this.m.halt, this.lastLine(body), "end of program");
    } catch (err) {
      if (!(err instanceof LowerError)) throw err;
      this.c.error(body[body.length - 1] ?? this.c.program, err.message);
    }
  }

  private lastLine(body: Stmt[]): number {
    const last = body[body.length - 1];
    return last ? last.at.line : this.c.program.at.line;
  }

  private live() {
    if (this.dead) { this.m.enter(this.m.fresh()); this.dead = false; }
  }

  private error(node: object | undefined, message: string) {
    this.c.error(node ?? this.current, message);
  }

  private dc(id: string, node?: object): DcVar | null {
    const v = this.vars.get(id);
    if (!v) { this.error(node, "A variable was used before it was declared."); return null; }
    if (v.kind !== "dc") { this.error(node, `${v.name} is a boolean.`); return null; }
    return v;
  }

  private boolVar(id: string, node?: object): BoolVar | DcVar | null {
    const v = this.vars.get(id);
    if (!v) { this.error(node, "A variable was used before it was declared."); return null; }
    return v;
  }

  /* ── Statements ── */

  private block(statements: readonly Stmt[], ctx: Ctx) {
    for (const s of statements) {
      const held = this.m.tempsHeld;
      try {
        this.statement(s, ctx);
      } catch (err) {
        if (!(err instanceof LowerError)) throw err;
        this.c.error(s, err.message);
      }
      // A statement's temps (a function's result, a quotient) die with it.
      this.m.releaseTo(held);
    }
  }

  private statement(s: Stmt, ctx: Ctx) {
    this.current = s;
    this.m.file = s.at.file;
    this.live();
    switch (s.kind) {
      case "declare": this.declare(s); return;
      case "assign": {
        const v = this.dc(s.target, s);
        if (!v) return;
        const rhs = this.linear(s.value);
        if (rhs) this.m.assign(v, rhs, s.at.line, s.label);
        return;
      }
      case "assignBool": {
        const v = this.boolVar(s.target, s);
        if (v) this.storeBool(v, s.value, s.at.line, s.label);
        return;
      }
      case "if": this.ifStatement(s, ctx); return;
      case "while": this.whileStatement(s, ctx); return;
      case "do": this.doStatement(s, ctx); return;
      case "for": this.forStatement(s, ctx); return;
      case "unrolled": this.unrolledLoop(s, ctx); return;
      case "switch": this.switchStatement(s, ctx); return;
      case "break": case "continue": {
        const target = s.kind === "break" ? ctx.breakTo : ctx.continueTo;
        if (!target) { this.error(s, `${s.kind} outside a loop.`); return; }
        this.m.jump(target(), s.at.line, s.label);
        this.dead = true;
        return;
      }
      case "return": this.returnStatement(s, ctx); return;
      case "sleep": {
        const n = s.cycles ?? Math.max(1, Math.round((s.ms ?? 0) / 1000 * this.c.program.cyclesPerSecond));
        this.m.sleep(n, s.at.line, s.label);
        return;
      }
      case "action": this.action(s); return;
      case "call": this.inline(s.call); return;
      case "block": this.block(s.body, ctx); return;
      case "remark": this.m.remark(s.at.line, s.text, s.short); return;
    }
  }

  private declare(s: Extract<Stmt, { kind: "declare" }>) {
    const { decl } = s;
    const v: Var | null = decl.kind === "number" ? (decl.shared ? this.m.shared(decl.name) : this.m.dc(decl.name)) : decl.shared ? this.m.switch(decl.name) : this.m.bool(decl.name);
    if (!v) {
      const note = this.m.perPlayer && !decl.name.includes(".") ? " (a per-player variable needs a unit with all twelve free)" : "";
      this.error(s, `No ${decl.kind === "number" ? "death counter" : "switch"} is free for ${decl.name}${note}.`);
      return;
    }
    v.at = decl.at;
    if (v.kind === "dc" && decl.bits) v.bits = decl.bits;
    if (v.kind === "dc") {
      if (!s.failed) { const rhs = this.linear(s.init as NumExpr); if (rhs) this.m.assign(v, rhs, s.at.line, s.label); }
    } else {
      this.storeBool(v, s.init as BoolExpr, s.at.line, s.label);
    }
    this.vars.set(decl.id, v);
  }

  private returnStatement(s: Extract<Stmt, { kind: "return" }>, ctx: Ctx) {
    if (!ctx.fn) { this.error(s, "return outside a function."); return; }
    const { fn } = ctx;
    if (s.value && fn.result) {
      if (fn.kind === "number") { const rhs = this.linear(s.value as NumExpr); if (rhs) this.m.assign(fn.result, rhs, s.at.line, s.label); }
      else this.storeBool(fn.result, s.value as BoolExpr, s.at.line, s.label);
    }
    if (!this.dead) this.m.jump(fn.end(), s.at.line, s.label);
    this.dead = true;
  }

  private action(s: Extract<Stmt, { kind: "action" }>) {
    const line = s.at.line;
    const { label } = s;
    if (!s.variable) {
      this.c.touched?.push(s.record);
      this.m.action({ ...s.record }, line, label);
      return;
    }
    const { variable } = s;
    const fieldBits = variable.bits;
    const lin = this.linear(variable.expr);
    if (!lin) return;
    const v = single(lin);
    let src: DcVar;
    let consume: boolean;
    let bits: number;
    if (v && bitsOf(v) <= fieldBits) {
      src = v; consume = false; bits = bitsOf(v);
    } else {
      // Computed, or wider than the field takes: into a temp, saturated at what the field can hold.
      src = this.m.temp(widthOf(lin));
      this.m.evaluate(src, lin, line, label);
      if (widthOf(lin) > fieldBits) {
        this.m.step([deathsCondition(src, Comparison.AtLeast, 2 ** fieldBits)], [setDeaths(src, SetModifier.SetTo, maxOf(fieldBits))], null, line, label);
        this.m.remark(line, `A ${variable.name} larger than ${maxOf(fieldBits)} is done as ${maxOf(fieldBits)}: that is what the action's field holds.`);
      }
      consume = true;
      bits = Math.min(widthOf(lin), fieldBits);
    }
    this.c.touched?.push(s.record);
    this.m.actionWithVar(s.record, variable.field, src, bits, consume, line, label);
  }

  /* ── Conditions as control flow ── */

  /** Whether lowering an expression as a condition emits anything: an edge, a call of a function, a ternary. */
  private hasEffects(e: BoolExpr | NumExpr): boolean {
    switch (e.kind) {
      case "edge": case "call": case "ternary": return true;
      case "and": case "or": return e.items.some((i) => this.hasEffects(i));
      case "not": return this.hasEffects(e.expr);
      case "test": return this.hasEffects(e.expr);
      case "compare": case "binary": return this.hasEffects(e.left) || this.hasEffects(e.right);
      case "unary": return this.hasEffects(e.expr);
      case "intrinsic": return e.args.some((a) => this.hasEffects(a));
      default: return false;
    }
  }

  /** `a && b` / `a || b` / `!…` where a right side has effects: the DNF would run them whether or not the left side decided. */
  private shortCircuits(e: BoolExpr): boolean {
    if ((e.kind === "and" || e.kind === "or") && e.items.length === 2) return this.hasEffects(e.items[1]) || this.shortCircuits(e.items[0]) || this.shortCircuits(e.items[1]);
    if (e.kind === "not") return this.shortCircuits(e.expr);
    return false;
  }

  /**
   * End the current state with a conditional jump on an expression. `&&` and `||` with an
   * effectful right side are lowered as control flow — the left side first, the right in
   * a state only reached when the left has not decided — so `n >= 1 && once(…)` consumes
   * the edge only when `n >= 1`; everything else goes through the DNF branch.
   */
  private branchOn(e: BoolExpr, thenState: number, elseState: number, line: number, label: string) {
    if ((e.kind === "and" || e.kind === "or") && e.items.length === 2 && this.shortCircuits(e)) {
      const mid = this.m.fresh();
      if (e.kind === "and") this.branchOn(e.items[0], mid, elseState, line, label);
      else this.branchOn(e.items[0], thenState, mid, line, label);
      this.m.enter(mid);
      this.dead = false;
      this.branchOn(e.items[1], thenState, elseState, line, label);
      return;
    }
    if (e.kind === "not" && this.shortCircuits(e)) {
      this.branchOn(e.expr, elseState, thenState, line, label);
      return;
    }
    const held = this.m.tempsHeld;
    const b = this.bool(e);
    this.m.branch(b, thenState, elseState, line, label);
    this.m.releaseTo(held);
  }

  private ifStatement(s: Extract<Stmt, { kind: "if" }>, ctx: Ctx) {
    const join = this.m.fresh();
    const thenState = this.m.fresh();
    const elseState = s.else ? this.m.fresh() : join;
    if (this.shortCircuits(s.cond)) {
      this.branchOn(s.cond, thenState, elseState, s.at.line, s.label);
    } else {
      const held = this.m.tempsHeld;
      const b = this.bool(s.cond);
      if (b.kind === "const") {
        // Known once lowered: only the side that runs is compiled.
        this.m.releaseTo(held);
        const live = b.value ? s.then : s.else;
        if (live) this.block(live, ctx);
        return;
      }
      this.m.branch(b, thenState, elseState, s.at.line, s.label);
      this.m.releaseTo(held);
    }
    this.m.enter(thenState);
    this.dead = false;
    this.block(s.then, ctx);
    if (!this.dead) this.m.jump(join, s.at.line, `L${s.at.line}: end if`);
    if (s.else) {
      this.m.enter(elseState);
      this.dead = false;
      this.block(s.else, ctx);
      if (!this.dead) this.m.jump(join, s.at.line, `L${s.at.line}: end else`);
    }
    this.m.enter(join);
    this.dead = false;
  }

  /**
   * A loop's test at its header: the body state and the exit. Returns the body state,
   * which is the header itself for a condition known true (no trigger spent), or the
   * fresh state the test branched to.
   */
  private loopTest(condition: BoolExpr | undefined, header: number, exit: number, line: number, label: string): number {
    if (!condition) return header;
    if (this.shortCircuits(condition)) {
      const body = this.m.fresh();
      this.branchOn(condition, body, exit, line, label);
      this.m.enter(body);
      return body;
    }
    const held = this.m.tempsHeld;
    const b = this.bool(condition);
    let body = header;
    if (!(b.kind === "const" && b.value)) {
      body = this.m.fresh();
      this.m.branch(b, body, exit, line, label);
      this.m.enter(body);
    }
    this.m.releaseTo(held);
    return body;
  }

  private whileStatement(s: Extract<Stmt, { kind: "while" }>, ctx: Ctx) {
    const line = s.at.line;
    this.m.remark(line, "A while loop runs one iteration per trigger cycle: its back edge waits for the next pass over the triggers.", "one iteration per cycle");
    const header = this.m.loopHeader(line, s.label);
    const exit = this.m.fresh();
    let broke = false;
    const body = this.loopTest(s.cond, header, exit, line, s.label);
    this.dead = false;
    this.block(s.body, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => header });
    if (!this.dead) this.m.jump(header, line, `L${line}: loop`);
    if (body === header && !broke) { this.dead = true; return; }
    this.m.enter(exit);
    this.dead = false;
  }

  private doStatement(s: Extract<Stmt, { kind: "do" }>, ctx: Ctx) {
    const line = s.at.line;
    this.m.remark(line, "A do loop runs one iteration per trigger cycle: its back edge waits for the next pass over the triggers.", "one iteration per cycle");
    const body = this.m.loopHeader(line, s.label);
    // The condition is tested in a state of its own: a branch back to the state it runs in would fall through as well.
    const check = this.m.fresh();
    const exit = this.m.fresh();
    this.dead = false;
    this.block(s.body, { fn: ctx.fn, breakTo: () => exit, continueTo: () => check });
    if (!this.dead) this.m.jump(check, line, `L${line}: while`);
    this.m.enter(check);
    this.dead = false;
    if (this.shortCircuits(s.cond)) this.branchOn(s.cond, body, exit, line, s.condLabel);
    else {
      const held = this.m.tempsHeld;
      const b = this.bool(s.cond);
      this.m.branch(b, body, exit, line, s.condLabel);
      this.m.releaseTo(held);
    }
    this.m.enter(exit);
  }

  private forStatement(s: Extract<Stmt, { kind: "for" }>, ctx: Ctx) {
    const line = s.at.line;
    this.m.remark(line, "This for loop runs one iteration per trigger cycle: its bound or step is not known when the script is built, so it is a while over a variable.", "one iteration per cycle");
    const header = this.m.loopHeader(line, s.label);
    const exit = this.m.fresh();
    let broke = false;
    let incr: number | null = null;
    const body = this.loopTest(s.cond, header, exit, line, s.label);
    this.dead = false;
    this.block(s.body, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => (s.update.length ? (incr ??= this.m.fresh()) : header) });
    if (incr !== null) {
      if (!this.dead) this.m.jump(incr, line, `L${line}: continue`);
      this.m.enter(incr);
      this.dead = false;
    }
    if (!this.dead) {
      for (const u of s.update) {
        try { this.statement(u, ctx); } catch (err) { if (!(err instanceof LowerError)) throw err; this.c.error(u, err.message); }
      }
      this.m.jump(header, line, `L${line}: loop`);
    }
    if (body === header && !broke) { this.dead = true; return; }
    this.m.enter(exit);
    this.dead = false;
  }

  /** The body compiled once per value; `break` leaves, `continue` goes on with the next. */
  private unrolledLoop(s: Extract<Stmt, { kind: "unrolled" }>, ctx: Ctx) {
    const line = s.at.line;
    const exit = this.m.fresh();
    let broke = false;
    for (const iteration of s.iterations) {
      let next: number | null = null;
      this.block(iteration, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => (next ??= this.m.fresh()) });
      if (next !== null) {
        if (!this.dead) this.m.jump(next, line, `L${line}: continue`);
        this.m.enter(next);
        this.dead = false;
      }
      if (this.dead) break; // Nothing after a break / return in the body's straight line is reached; nor are the values after it.
    }
    if (broke) {
      if (!this.dead) this.m.jump(exit, line, `L${line}: end of loop`);
      this.m.enter(exit);
      this.dead = false;
    }
  }

  /**
   * `switch (x) { case 1: … break; case 2: … default: … }` over a number: the cases
   * tested in order, each one trigger, then the bodies in source order — a body without
   * `break` falls through to the next, as in TypeScript.
   */
  private switchStatement(s: Extract<Stmt, { kind: "switch" }>, ctx: Ctx) {
    const line = s.at.line;
    const held = this.m.tempsHeld;
    const lin = this.linear(s.value);
    if (!lin) return;
    if (isConst(lin)) { this.error(s.value as object, "switch over a value known when the script is built: write the case that applies."); return; }
    const v = single(lin) ?? (() => { const t = this.m.temp(widthOf(lin)); this.m.evaluate(t, lin, line, s.label); return t; })();
    const exit = this.m.fresh();
    const states = s.cases.map(() => this.m.fresh());
    let fallback = exit;
    s.cases.forEach((c, i) => {
      if (c.value === null) { fallback = states[i]; return; }
      const n = c.value;
      if (Number.isNaN(n) || n < 0 || n > U32_MAX) return; // Unreadable, or a value the variable can never hold.
      this.m.step([deathsCondition(v, Comparison.Exactly, n)], [], states[i], line, `L${line}: case ${n}`);
    });
    this.m.jump(fallback, line, `L${line}: ${fallback === exit ? "end switch" : "default"}`);
    this.m.releaseTo(held);
    s.cases.forEach((c, i) => {
      this.m.enter(states[i]);
      this.dead = false;
      this.block(c.body, { fn: ctx.fn, continueTo: ctx.continueTo, breakTo: () => exit });
      if (!this.dead) this.m.jump(i + 1 < states.length ? states[i + 1] : exit, line, `L${line}: fall through`);
    });
    this.m.enter(exit);
    this.dead = false;
  }

  /* ── Functions ── */

  /**
   * An inlined call: the result temp first, then the parameter copies, then the body in
   * the current state, `return` jumping to a state after it. The result comes back in a
   * temp the caller reads (0 / 1 for a boolean) and releases with its statement.
   */
  private inline(call: Call): DcVar | undefined {
    const line = call.at.line;
    const result = call.result ? this.m.temp() : undefined;
    if (result) this.m.set(result, 0, line, call.label);
    for (const p of call.params) {
      const copy: Var | null = p.decl.kind === "number" ? this.m.dc(p.decl.name) : this.m.bool(p.decl.name);
      if (!copy) { this.error(call, `No ${p.decl.kind === "number" ? "death counter" : "switch"} is free for ${p.decl.name}.`); return result; }
      copy.at = p.decl.at;
      if (copy.kind === "dc" && p.decl.bits) copy.bits = p.decl.bits;
      if (copy.kind === "dc") { const rhs = this.linear(p.init as NumExpr); if (rhs) this.m.assign(copy, rhs, line, p.label); }
      else this.storeBool(copy, p.init as BoolExpr, line, p.label);
      this.vars.set(p.decl.id, copy);
    }
    if (call.result && result) this.vars.set(call.result.decl.id, result);
    const file = this.m.file;
    let end: number | null = null;
    const fn: Ctx["fn"] = { end: () => (end ??= this.m.fresh()), kind: call.result?.kind ?? "void", result };
    this.block(call.body, { fn });
    this.m.file = file;
    if (end !== null) {
      if (!this.dead) this.m.jump(end, line, `L${line}: end of ${call.name ?? "function"}`);
      this.m.enter(end);
      this.dead = false;
    }
    return result;
  }

  /* ── Numbers ── */

  /** A variable holding a linear expression's value: the variable itself when it is one, else a temp computed now. */
  private sideVar(l: Linear, line: number, label: string): DcVar {
    const v = single(l);
    if (v) return v;
    const t = this.m.temp(widthOf(l));
    this.m.evaluate(t, l, line, label);
    return t;
  }

  /** `l op r` for `*`, `/`, `%` (and `+`, `-`) over linear expressions, emitting what needs a temp. */
  private linearOp(op: "+" | "-" | "*" | "/" | "%", l: Linear, r: Linear, at: object, line: number, label: string): Linear | null {
    switch (op) {
      case "+": return merge(l, r);
      case "-": return merge(l, scale(r, -1));
      case "*": {
        if (isConst(r)) return scale(l, r.c);
        if (isConst(l)) return scale(r, l.c);
        const a = this.sideVar(l, line, label);
        const b = this.sideVar(r, line, label);
        const t = this.m.temp(Math.min(32, bitsOf(a) + bitsOf(b)));
        this.m.set(t, 0, line, label);
        this.m.mulVar(t, a, b, line, label);
        return ofVar(t);
      }
      case "/": case "%": {
        if (!isConst(r)) { this.error(at, "Division is by a constant: the game has no instruction for dividing by a variable."); return null; }
        const d = r.c;
        if (!Number.isInteger(d) || d <= 0) { this.error(at, `Divide by a whole number of at least 1, not ${d}.`); return null; }
        if (isConst(l)) return { c: op === "/" ? Math.trunc(l.c / d) : l.c % d, terms: [] };
        const n = this.m.temp(widthOf(l));
        this.m.evaluate(n, l, line, label);
        const q = this.m.temp(Math.max(1, widthOf(l) - bitLength(d) + 1));
        this.m.set(q, 0, line, label);
        this.m.divConst(n, q, d, line, label, widthOf(l));
        return ofVar(op === "/" ? q : n);
      }
    }
  }

  /** `Math.min(a, b)` / `Math.max(a, b)`: against a constant, a copy and one guard; between variables, saturating differences. */
  private minMax(kind: "min" | "max", l: Linear, r: Linear, line: number, label: string): Linear {
    if (isConst(l) && isConst(r)) return { c: kind === "min" ? Math.min(l.c, r.c) : Math.max(l.c, r.c), terms: [] };
    if (isConst(l) || isConst(r)) {
      const c = isConst(l) ? l.c : r.c;
      const x = isConst(l) ? r : l;
      const t = this.m.temp(kind === "min" ? Math.min(widthOf(x), bitLength(Math.max(0, c))) : Math.max(widthOf(x), bitLength(Math.max(0, c))));
      if (kind === "min" && c <= 0) { this.m.set(t, 0, line, label); return ofVar(t); }
      this.m.evaluate(t, x, line, label);
      if (kind === "min") { if (c < U32_MAX) this.m.step([deathsCondition(t, Comparison.AtLeast, c + 1)], [setDeaths(t, SetModifier.SetTo, c)], null, line, label); }
      else if (c > 0) this.m.step([deathsCondition(t, Comparison.AtMost, c - 1)], [setDeaths(t, SetModifier.SetTo, Math.min(c, U32_MAX))], null, line, label);
      return ofVar(t);
    }
    // min(a, b) = a − (a −̇ b); max(a, b) = a + (b −̇ a), with the game's saturating subtraction.
    const t = this.m.temp(kind === "min" ? Math.min(widthOf(l), widthOf(r)) : Math.max(widthOf(l), widthOf(r)));
    const u = this.m.temp(kind === "min" ? widthOf(l) : widthOf(r));
    this.m.evaluate(u, kind === "min" ? merge(l, scale(r, -1)) : merge(r, scale(l, -1)), line, label);
    this.m.evaluate(t, l, line, label);
    this.m.addVar(t, u, kind === "min" ? -1 : 1, line, label, bitsOf(u), true);
    this.m.release();
    return ofVar(t);
  }

  /** `Math.abs(l)` = (l −̇ 0) + (−l −̇ 0). */
  private abs(l: Linear, line: number, label: string): Linear {
    if (isConst(l)) return { c: Math.abs(l.c), terms: [] };
    const t = this.m.temp(widthOf(l));
    const u = this.m.temp(widthOf(scale(l, -1)));
    this.m.evaluate(t, l, line, label);
    this.m.evaluate(u, scale(l, -1), line, label);
    this.m.addVar(t, u, 1, line, label, bitsOf(u), true);
    this.m.release();
    return ofVar(t);
  }

  /** `c ? a : b` as a number: a temp assigned on either side of a branch. */
  private ternary(e: Extract<NumExpr, { kind: "ternary" }>): Linear {
    const line = e.at.line;
    const { label } = e;
    const t = this.m.temp();
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.branchOn(e.cond, on, off, line, label);
    this.m.enter(on);
    this.dead = false;
    const a = this.linear(e.whenTrue);
    if (a) this.m.assign(t, a, line, label);
    this.m.jump(join, line, label);
    this.m.enter(off);
    this.dead = false;
    const b = this.linear(e.whenFalse);
    if (b) this.m.assign(t, b, line, label);
    this.m.jump(join, line, label);
    this.m.enter(join);
    this.dead = false;
    return ofVar(t);
  }

  /** `c + Σ k·v` over death counters, or null (with a diagnostic). Emits what needs a temp: a quotient, a product, a call's result. */
  private linear(e: NumExpr): Linear | null {
    switch (e.kind) {
      case "const": return { c: e.value, terms: [] };
      case "var": { const v = this.dc(e.id, e); return v ? ofVar(v) : null; }
      case "unary": { const inner = this.linear(e.expr); return inner ? scale(inner, -1) : null; }
      case "binary": {
        const l = this.linear(e.left);
        const r = this.linear(e.right);
        if (!l || !r) return null;
        return this.linearOp(e.op, l, r, e, e.at.line, e.label);
      }
      case "ternary": return this.ternary(e);
      case "intrinsic": {
        const args: Linear[] = [];
        for (const a of e.args) { const l = this.linear(a); if (!l) return null; args.push(l); }
        if (e.name === "abs") return this.abs(args[0], e.at.line, e.label);
        return this.minMax(e.name, args[0], args[1], e.at.line, e.label);
      }
      case "call": { const r = this.inline(e.call); return r ? ofVar(r) : null; }
    }
  }

  /* ── Booleans ── */

  /** `v = expr` for a boolean: a constant, a toggle, a coin toss, or a branch that sets one side and clears the other. */
  private storeBool(v: BoolVar | DcVar, e: BoolExpr, line: number, label: string) {
    if (e.kind === "const") { this.m.action(setTruth(v, e.value), line, label); return; }
    // A switch toggles and randomizes in one action; a flag (a per-player boolean) goes through a branch.
    if (v.kind === "switch" && e.kind === "not" && e.expr.kind === "var" && this.vars.get(e.expr.id) === v) { this.m.action(setSwitch(v, SwitchAction.Toggle), line, label); return; }
    if (v.kind === "switch" && e.kind === "random") { this.m.action(setSwitch(v, SwitchAction.Randomize), line, label); return; }
    if (this.shortCircuits(e)) {
      const on = this.m.fresh();
      const off = this.m.fresh();
      this.branchOn(e, on, off, line, label);
      this.storeSides(v, on, off, line, label);
      return;
    }
    const held = this.m.tempsHeld;
    const b = this.bool(e);
    if (b.kind === "const") { this.m.action(setTruth(v, b.value), line, label); this.m.releaseTo(held); return; }
    this.storeBoolTree(v, b, line, label);
    this.m.releaseTo(held);
  }

  /** `v = b` for a condition tree: branch, set on one side, clear on the other. */
  private storeBoolTree(v: BoolVar | DcVar, b: Bool, line: number, label: string) {
    const on = this.m.fresh();
    const off = this.m.fresh();
    this.m.branch(b, on, off, line, label);
    this.storeSides(v, on, off, line, label);
  }

  private storeSides(v: BoolVar | DcVar, on: number, off: number, line: number, label: string) {
    const join = this.m.fresh();
    this.m.enter(on);
    this.m.action(setTruth(v, true), line, label);
    this.m.jump(join, line, label);
    this.m.enter(off);
    this.m.action(setTruth(v, false), line, label);
    this.m.jump(join, line, label);
    this.m.enter(join);
    this.dead = false;
  }

  /**
   * `rose(c)`: true on the cycle `c` becomes true; `once(c)`: true the first time it holds.
   * A latch remembers whether `c` held last time; `fired` is what the caller tests. Five
   * triggers: the branch on `c`, two in the true state (the latch clear → fire and set the
   * latch, jumping on; else clear `fired`), one in the false state.
   */
  private edge(e: Extract<BoolExpr, { kind: "edge" }>): Bool {
    const kind = e.edge;
    const latch = this.m.bool(`(${kind} latch)`);
    const fired = this.m.bool(`(${kind} fired)`);
    if (!latch || !fired) { this.error(e, `No switch is free for ${kind}().`); return FALSE; }
    const line = e.at.line;
    const { label } = e;
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.branchOn(e.cond, on, off, line, label);
    this.m.enter(on);
    this.m.step([boolCondition(latch, false)], [setBool(fired, true), setBool(latch, true)], join, line, label);
    this.m.step([], [setBool(fired, false)], join, line, label);
    this.m.enter(off);
    if (kind === "rose") this.m.action(setBool(latch, false), line, label);
    this.m.action(setBool(fired, false), line, label);
    this.m.jump(join, line, label);
    this.m.enter(join);
    this.dead = false;
    return cond(boolCondition(fired, true));
  }

  /** A condition as a `Bool` tree; may emit steps (temps for variable comparisons, a randomize, an edge, a call). */
  private bool(e: BoolExpr): Bool {
    this.scratchUsed = 0;
    return this.boolInner(e);
  }

  private boolInner(e: BoolExpr): Bool {
    switch (e.kind) {
      case "const": return e.value ? TRUE : FALSE;
      case "cond": this.c.touched?.push(e.record); return cond(e.record);
      case "var": {
        const v = this.boolVar(e.id, e);
        if (!v) return FALSE;
        return v.kind !== "dc" ? cond(boolCondition(v, true)) : compareConst(v, ">=", 1);
      }
      case "test": {
        if (e.expr.kind === "var") { const v = this.dc(e.expr.id, e); return v ? compareConst(v, ">=", 1) : FALSE; }
        const l = this.linear(e.expr);
        if (!l) return FALSE;
        return cond(deathsCondition(this.sideVar(l, e.at.line, e.label), Comparison.AtLeast, 1));
      }
      case "not": return not(this.boolInner(e.expr));
      case "and": return and(e.items.map((i) => this.boolInner(i)));
      case "or": return or(e.items.map((i) => this.boolInner(i)));
      case "compare": return this.comparison(e);
      case "random": {
        const s = this.m.scratch(this.scratchUsed++);
        this.m.action(setSwitch(s, SwitchAction.Randomize), e.at.line, `L${e.at.line}: random()`);
        return cond(switchCondition(s, true));
      }
      case "edge": return this.edge(e);
      case "ternary": {
        // `c ? p : q` as a truth value: 0 / 1 in a temp.
        const line = e.at.line;
        const t = this.m.temp(1);
        const on = this.m.fresh();
        const off = this.m.fresh();
        this.branchOn(e.cond, on, off, line, e.label);
        const join = this.m.fresh();
        this.m.enter(on);
        this.dead = false;
        this.storeBool(t, e.whenTrue, line, e.label);
        this.m.jump(join, line, e.label);
        this.m.enter(off);
        this.dead = false;
        this.storeBool(t, e.whenFalse, line, e.label);
        this.m.jump(join, line, e.label);
        this.m.enter(join);
        this.dead = false;
        return cond(deathsCondition(t, Comparison.AtLeast, 1));
      }
      case "call": {
        // A call whose result is tested: a boolean result is `≥ 1`, a number's is `≠ 0` — both `≥ 1` on a counter.
        const r = this.inline(e.call);
        return r ? cond(deathsCondition(r, Comparison.AtLeast, 1)) : FALSE;
      }
    }
  }

  private comparison(e: Extract<BoolExpr, { kind: "compare" }>): Bool {
    const l = this.linear(e.left);
    const r = this.linear(e.right);
    if (!l || !r) return FALSE;
    // l − r  op  0
    const d = merge(l, scale(r, -1));
    if (d.terms.length === 0) return compareNumbers(d.c, e.op, 0) ? TRUE : FALSE;
    if (d.terms.length === 1) {
      const t = d.terms[0];
      return compareScaled(t.v, t.k, e.op, -d.c);
    }
    // Two sides to compute: `a + c  op  b` with the constant on whichever side keeps it non-negative.
    const line = e.at.line;
    const { label } = e;
    const left: Linear = { c: Math.max(0, d.c), terms: d.terms.filter((t) => t.k > 0) };
    const right: Linear = { c: Math.max(0, -d.c), terms: d.terms.filter((t) => t.k < 0).map((t) => ({ v: t.v, k: -t.k })) };
    const a = this.sideVar(left, line, label);
    const b = this.sideVar(right, line, label);
    return this.m.compareVars(a, e.op, b, line, label).bool;
  }
}

/** `v = on` for a switch, a flag, or a counter holding 0 / 1. */
function setTruth(v: BoolVar | DcVar, on: boolean): ActionRecord {
  return v.kind === "dc" ? setDeaths(v, SetModifier.SetTo, on ? 1 : 0) : setBool(v, on);
}

/** `k·v op n` as a test of `v` against a constant. */
function compareScaled(v: DcVar, k: number, op: CompareOp, n: number): Bool {
  if (k < 0) return compareScaled(v, -k, flipOp(op), -n);
  if (k === 1) return compareConst(v, op, n);
  switch (op) {
    case ">=": return compareConst(v, ">=", Math.ceil(n / k));
    case ">": return compareConst(v, ">=", Math.ceil((n + 1) / k));
    case "<=": return compareConst(v, "<=", Math.floor(n / k));
    case "<": return compareConst(v, "<=", Math.floor((n - 1) / k));
    case "==": return n % k === 0 ? compareConst(v, "==", n / k) : FALSE;
    case "!=": return n % k === 0 ? compareConst(v, "!=", n / k) : TRUE;
  }
}

/** A variable of the program, for what the compiler exposes (unused here, kept for backends that need the declaration list). */
export type { VarDecl };
