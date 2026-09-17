/**
 * The Remastered target's compiler side. The lowering itself is `python/trigscript.py`,
 * run by the eudplib plugin; here is what the compiler does before handing it the IR:
 * checks the IR against the target (`checkForTarget`) and serialises it with the map's
 * string indices in place of the compile's local ones (`serializeIr`).
 *
 * The one rule the Remastered target adds: a loop that never sleeps never gives the frame
 * back. On the classic target every back edge waits for the next trigger cycle, so a
 * `while (true)` is a game loop by construction; under eudplib the body runs to completion
 * within the frame, and a loop whose condition never moves would freeze the game. So a
 * loop with no `sleep()` on some path around it, whose condition does not mention a
 * variable the body assigns, is an error naming the loop.
 */
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import type { At, BoolExpr, Call, NumExpr, Program, Stmt } from "./ir";

export type Target = "classic" | "remastered";

export interface TargetDiagnostic { at: At; message: string }

/** What a target cannot take, each with the node it is at. Empty means the IR builds on it. */
export function checkForTarget(program: Program, target: Target): TargetDiagnostic[] {
  const out: TargetDiagnostic[] = [];
  if (target === "remastered") checkSleeps(program.body, out);
  return out;
}

/** The variables a statement list assigns (declares count too), by id. */
function assigned(body: Stmt[], into = new Set<string>()): Set<string> {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": into.add(s.decl.id); break;
      case "assign": case "assignBool": into.add(s.target); break;
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "for": s.body.forEach(stmt); if (s.kind === "for") s.update.forEach(stmt); break;
      case "do": s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  const call = (c: Call) => { for (const p of c.params) into.add(p.decl.id); if (c.result) into.add(c.result.decl.id); c.body.forEach(stmt); };
  body.forEach(stmt);
  return into;
}

/** The variables an expression reads, by id. */
function reads(e: NumExpr | BoolExpr, into = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "var": into.add(e.id); break;
    case "unary": reads(e.expr, into); break;
    case "binary": case "compare": reads(e.left, into); reads(e.right, into); break;
    case "ternary": reads(e.cond, into); reads(e.whenTrue, into); reads(e.whenFalse, into); break;
    case "intrinsic": e.args.forEach((a) => reads(a, into)); break;
    case "and": case "or": e.items.forEach((i) => reads(i, into)); break;
    case "not": reads(e.expr, into); break;
    case "test": reads(e.expr, into); break;
    case "edge": reads(e.cond, into); break;
    case "call": break;
    default: break;
  }
  return into;
}

/** Whether every way through a statement list reaches a `sleep` (or leaves the loop for good). */
function sleepsOnEveryPath(body: Stmt[]): boolean {
  for (const s of body) {
    switch (s.kind) {
      case "sleep": return true;
      case "break": case "return": return true; // Leaves the loop: no freeze on this path.
      case "continue": return false;
      case "if": if (s.else && sleepsOnEveryPath(s.then) && sleepsOnEveryPath(s.else)) return true; break;
      case "block": if (sleepsOnEveryPath(s.body)) return true; break;
      case "unrolled": if (s.iterations.some(sleepsOnEveryPath)) return true; break;
      case "switch": {
        const hasDefault = s.cases.some((c) => c.value === null);
        if (hasDefault && s.cases.every((c) => sleepsOnEveryPath(c.body))) return true;
        break;
      }
      case "while": case "do": case "for": if (sleepsOnEveryPath(s.body)) return true; break;
      case "call": if (sleepsOnEveryPath(s.call.body)) return true; break;
      default: break;
    }
  }
  return false;
}

function checkSleeps(body: Stmt[], out: TargetDiagnostic[]) {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "while": case "for": case "do": {
        const moves = s.cond ? [...reads(s.cond)].some((id) => assigned(s.kind === "for" ? [...s.body, ...s.update] : s.body).has(id)) : false;
        if (!moves && !sleepsOnEveryPath(s.body)) out.push({ at: s.at, message: s.cond
          ? "This loop's condition never changes inside it, and no path around it sleeps: on the Remastered target the body runs to completion within a frame, so this loop would never give the frame back. Add sleep(frames(1)) inside it, or change what it tests."
          : "A loop without an end needs a sleep() on every path around it: on the Remastered target the body runs to completion within a frame, so this loop would freeze the game. Add sleep(frames(1)) inside it." });
        s.body.forEach(stmt);
        if (s.kind === "for") s.update.forEach(stmt);
        break;
      }
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/**
 * The IR as the JSON the Python side reads. String and sound fields of the records hold
 * the compile's *local* ids; `resolve` maps them to the map's own indices (interning as
 * `resolveStrings` in `script.ts` does), so the built map's actions name the right text.
 */
export function serializeIr(programs: Program[], resolve: (local: number) => number): string {
  const action = (r: ActionRecord): ActionRecord => ({ ...r, text: resolve(r.text), wav: resolve(r.wav) });
  const condition = (r: ConditionRecord): ConditionRecord => ({ ...r });
  // Only actions carry strings, and only inside statements — but a call's body is statements inside an expression, so expressions are walked for calls.
  const expr = <E extends NumExpr | BoolExpr>(e: E): E => {
    switch (e.kind) {
      case "unary": return { ...e, expr: expr(e.expr) };
      case "binary": case "compare": return { ...e, left: expr(e.left), right: expr(e.right) };
      case "ternary": return { ...e, cond: expr(e.cond), whenTrue: expr(e.whenTrue), whenFalse: expr(e.whenFalse) } as E;
      case "intrinsic": return { ...e, args: e.args.map(expr) };
      case "call": return { ...e, call: call(e.call) };
      case "cond": return { ...e, record: condition(e.record) };
      case "test": return { ...e, expr: expr(e.expr) };
      case "and": case "or": return { ...e, items: e.items.map(expr) };
      case "not": return { ...e, expr: expr(e.expr) };
      case "edge": return { ...e, cond: expr(e.cond) };
      default: return e;
    }
  };
  const call = (c: Call): Call => ({ ...c, params: c.params.map((p) => ({ ...p, init: expr(p.init) })), body: c.body.map(stmt) });
  const stmt = (s: Stmt): Stmt => {
    switch (s.kind) {
      case "declare": return { ...s, init: expr(s.init) };
      case "assign": return { ...s, value: expr(s.value) };
      case "assignBool": return { ...s, value: expr(s.value) };
      case "if": return { ...s, cond: expr(s.cond), then: s.then.map(stmt), ...(s.else ? { else: s.else.map(stmt) } : {}) };
      case "while": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), body: s.body.map(stmt) };
      case "do": return { ...s, body: s.body.map(stmt), cond: expr(s.cond) };
      case "for": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), update: s.update.map(stmt), body: s.body.map(stmt) };
      case "unrolled": return { ...s, iterations: s.iterations.map((i) => i.map(stmt)) };
      case "switch": return { ...s, value: expr(s.value), cases: s.cases.map((c) => ({ ...c, body: c.body.map(stmt) })) };
      case "return": return s.value ? { ...s, value: expr(s.value) } : s;
      case "action": return { ...s, record: action(s.record), ...(s.variable ? { variable: { ...s.variable, expr: expr(s.variable.expr) } } : {}) };
      case "call": return { ...s, call: call(s.call) };
      case "block": return { ...s, body: s.body.map(stmt) };
      default: return s;
    }
  };
  return JSON.stringify({ version: programs[0]?.version ?? 1, programs: programs.map((p) => ({ ...p, body: p.body.map(stmt) })) });
}
