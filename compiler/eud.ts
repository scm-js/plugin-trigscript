/**
 * What the compiler does with a program's IR before eudplib gets it: checks it
 * (`checkProgram`) and serialises it with every text written out (`serializeIr`). The
 * lowering itself is `python/trigscript.py`, run by the eudplib plugin when the map is saved.
 *
 * The rule a program has to keep: a loop that never sleeps never gives the frame back. The
 * body of a program runs to completion within the frame, so a loop whose condition never
 * moves would freeze the game. A loop with no `sleep()` on some path around it, whose
 * condition does not mention a variable the body assigns, is an error naming the loop.
 */
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import { declarations, isUnitExpr, type At, type BoolExpr, type Call, type NumExpr, type Program, type Stmt, type UnitExpr } from "./ir";
import type { LineHint, ScriptString } from "./compiler";
import type { InputPlan } from "./input";

export interface ProgramDiagnostic { at: At; message: string }

/** A program's faults, each with the node it is at, and what its lines are worth a word about. */
export function checkProgram(program: Program): { errors: ProgramDiagnostic[]; hints: LineHint[] } {
  const errors: ProgramDiagnostic[] = [];
  checkSleeps(program.body, errors);
  checkDivisions(program.body, errors);
  checkWidths(program.body, errors);
  checkUnitLoops(program.body, errors);
  const hints: LineHint[] = [];
  remarks(program.body, hints);
  scans(program, hints);
  return { errors, hints };
}

/** Every expression of a statement list, calls' bodies included. */
function expressions(body: Stmt[], visit: (e: NumExpr | BoolExpr) => void, pick?: (u: UnitExpr & { kind: "pick" }) => void) {
  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); else if (u.kind === "pick") pick?.(u); };
  const any = (e: NumExpr | BoolExpr | UnitExpr) => (isUnitExpr(e) ? unit(e) : expr(e));
  const expr = (e: NumExpr | BoolExpr) => {
    visit(e);
    switch (e.kind) {
      case "unitField": case "unitAlive": case "unitFlag": unit(e.unit); break;
      case "unitSame": unit(e.left); unit(e.right); break;
      case "unary": expr(e.expr); break;
      case "binary": case "compare": expr(e.left); expr(e.right); break;
      case "ternary": expr(e.cond); expr(e.whenTrue); expr(e.whenFalse); break;
      case "intrinsic": e.args.forEach(expr); break;
      case "randomInt": expr(e.bound); break;
      case "and": case "or": e.items.forEach(expr); break;
      case "not": expr(e.expr); break;
      case "test": expr(e.expr); break;
      case "edge": expr(e.cond); break;
      case "call": call(e.call); break;
      default: break;
    }
  };
  const call = (c: Call) => { for (const p of c.params) any(p.init); c.body.forEach(stmt); };
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": if (!s.failed) any(s.init); break;
      case "assign": case "assignBool": expr(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); expr(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "tableWrite": if (s.value.kind !== "text") expr(s.value); break;
      case "if": expr(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) expr(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); expr(s.cond); break;
      case "for": if (s.cond) expr(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) any(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); break;
      case "centerLocation": expr(s.x); expr(s.y); break;
      case "print": for (const p of s.parts) if (p.kind === "number") expr(p.expr); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** Every statement of a list, nested ones and calls' bodies (as statements) included. */
function statements(body: Stmt[], visit: (s: Stmt) => void) {
  const stmt = (s: Stmt) => {
    visit(s);
    switch (s.kind) {
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "do": case "unitLoop": s.body.forEach(stmt); break;
      case "for": s.body.forEach(stmt); s.update.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** A loop over units runs within the frame it starts in: the unit table moves between frames, so there is no place to come back to. */
function checkUnitLoops(body: Stmt[], out: ProgramDiagnostic[]) {
  statements(body, (s) => {
    if (s.kind !== "unitLoop") return;
    statements(s.body, (inner) => {
      if (inner.kind === "sleep") out.push({ at: inner.at, message: "sleep() inside a loop over units: the loop looks at the game's units as they are in one frame and cannot be left half way. To do something to one unit at a time, find it again after each sleep: while (true) { const u = first(…); if (!u) break; u.kill(); sleep(seconds(1)); }" });
    });
  });
}

/** What a loop over units, or a pick, costs: a word at the end of the line. */
function scans(program: Program, out: LineHint[]) {
  const SLOTS = "the game's 1700 unit slots";
  const each = program.perPlayer ? ", once for each player the program runs for" : "";
  const seen = new Set<string>();
  const hint = (at: At, label: string, note: string) => {
    const key = `${at.file}:${at.line}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: at.file, line: at.line, label, note });
  };
  statements(program.body, (s) => { if (s.kind === "unitLoop") hint(s.at, "scans units", `Looks at ${SLOTS} every time the line runs${each}, and runs the body for the ones that match. Fine once or a few times a second; inside a loop that runs every frame, ask whether it needs to.`); });
  expressions(program.body, () => {}, (u) => hint(u.at, u.by === "random" ? "scans units ×2" : "scans units", u.by === "random"
    ? `Looks at ${SLOTS} twice every time the line runs${each}: once to count the units that match, once to take the one drawn.`
    : `Looks at ${SLOTS} every time the line runs${each}. Keep the unit in a variable when several lines need it.`));
}

/** A divisor known when the script is built has to be a whole number of at least 1; a variable that is 0 in the game gives 0. */
function checkDivisions(body: Stmt[], out: ProgramDiagnostic[]) {
  expressions(body, (e) => {
    if (e.kind !== "binary" || (e.op !== "/" && e.op !== "%") || e.right.kind !== "const") return;
    const d = e.right.value;
    if (!Number.isInteger(d) || d <= 0) out.push({ at: e.at, message: `Divide by a whole number of at least 1, not ${d}.` });
  });
}

/** A constant put into a `u8` / `u16` has to fit: the game would stop it at the top without a word. */
function checkWidths(body: Stmt[], out: ProgramDiagnostic[]) {
  const decls = new Map(declarations(body).map((d) => [d.id, d]));
  const fits = (id: string, value: NumExpr | BoolExpr | UnitExpr, at: At) => {
    const d = decls.get(id);
    if (!d?.bits || value.kind !== "const" || typeof value.value !== "number") return;
    const max = 2 ** d.bits - 1;
    if (value.value > max) out.push({ at, message: `${d.name} is a u${d.bits} and holds 0 … ${max}, not ${value.value}.` });
  };
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": if (!s.failed) fits(s.decl.id, s.init, s.at); break;
      case "assign": fits(s.target, s.value, s.at); break;
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "do": case "unitLoop": s.body.forEach(stmt); break;
      case "for": s.body.forEach(stmt); s.update.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** The `remark` statements, as hints for their lines. */
function remarks(body: Stmt[], out: LineHint[]) {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "remark": if (s.short) out.push({ file: s.at.file, line: s.at.line, label: s.short, note: s.text }); break;
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "do": case "unitLoop": s.body.forEach(stmt); break;
      case "for": s.body.forEach(stmt); s.update.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** The variables a statement list assigns (declares count too), by id — and `THE_GAME` when it takes an action, which may change what a read finds. */
function assigned(body: Stmt[], into = new Set<string>()): Set<string> {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "action": case "unitWrite": case "unitDo": case "tableWrite": case "centerLocation": into.add(THE_GAME); break;
      case "declare": into.add(s.decl.id); break;
      case "assign": case "assignBool": case "assignUnit": into.add(s.target); break;
      case "unitLoop": into.add(s.decl.id); s.body.forEach(stmt); break;
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

/** What stands in `reads()` for "this expression reads the game": an id no variable has. */
const THE_GAME = "(the game)";

/** The variables an expression reads, by id — and `THE_GAME` when it reads a value of the game or tests a condition. */
function reads(e: NumExpr | BoolExpr, into = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "var": into.add(e.id); break;
    case "read": case "cond": case "tableRead": into.add(THE_GAME); break;
    // What the players did is as it was when the frame began: nothing a loop does within the frame changes it.
    case "input": break;
    case "unitField": case "unitAlive": case "unitFlag": into.add(THE_GAME); if (e.unit.kind === "unitVar") into.add(e.unit.id); break;
    case "unitSame": for (const u of [e.left, e.right]) if (u.kind === "unitVar") into.add(u.id); break;
    case "randomInt": reads(e.bound, into); break;
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

function checkSleeps(body: Stmt[], out: ProgramDiagnostic[]) {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "while": case "for": case "do": {
        const moves = s.cond ? [...reads(s.cond)].some((id) => assigned(s.kind === "for" ? [...s.body, ...s.update] : s.body).has(id)) : false;
        if (!moves && !sleepsOnEveryPath(s.body)) out.push({ at: s.at, message: s.cond
          ? "This loop's condition never changes inside it, and no path around it sleeps. A program runs until it sleeps or ends, all within one frame of the game, so this loop would never give the frame back and the game would freeze. Add sleep(frames(1)) inside it, or change what it tests."
          : "A loop without an end needs a sleep() on every path around it. A program runs until it sleeps or ends, all within one frame of the game, so this loop would freeze the game. Add sleep(frames(1)) at the end of its body." });
        s.body.forEach(stmt);
        if (s.kind === "for") s.update.forEach(stmt);
        break;
      }
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "unitLoop": s.body.forEach(stmt); break;
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
 * The IR as the JSON the Python side reads. A record's text and sound fields hold the
 * compile's *local* ids; here each becomes the text itself (`strings[k - 1].text`), which
 * eudplib puts in the built map's string table, or the map's own index when the script
 * named one (`{ index }`). Nothing a program says is written into the map the user edits.
 * `input` is the compile's plan for what the players do (`input.ts`), when a program reads any.
 */
export function serializeIr(programs: Program[], strings: readonly ScriptString[], input: InputPlan | null = null): string {
  const resolve = (local: number): number | string => {
    if (local <= 0) return 0;
    const s = strings[local - 1];
    return !s ? 0 : "index" in s ? s.index : s.text;
  };
  const action = (r: ActionRecord) => ({ ...r, text: resolve(r.text), wav: resolve(r.wav) });
  const condition = (r: ConditionRecord): ConditionRecord => ({ ...r });
  // Only actions carry strings, and only inside statements — but a call's body is statements inside an expression, so expressions are walked for calls.
  const unit = (u: UnitExpr): UnitExpr => (u.kind === "call" ? { ...u, call: call(u.call) } : u);
  const any = (e: NumExpr | BoolExpr | UnitExpr): NumExpr | BoolExpr | UnitExpr => (isUnitExpr(e) ? unit(e) : expr(e));
  const expr = <E extends NumExpr | BoolExpr>(e: E): E => {
    switch (e.kind) {
      case "unitField": case "unitAlive": case "unitFlag": return { ...e, unit: unit(e.unit) };
      case "unitSame": return { ...e, left: unit(e.left), right: unit(e.right) };
      case "unary": return { ...e, expr: expr(e.expr) };
      case "binary": case "compare": return { ...e, left: expr(e.left), right: expr(e.right) };
      case "ternary": return { ...e, cond: expr(e.cond), whenTrue: expr(e.whenTrue), whenFalse: expr(e.whenFalse) } as E;
      case "intrinsic": return { ...e, args: e.args.map(expr) };
      case "randomInt": return { ...e, bound: expr(e.bound) };
      case "call": return { ...e, call: call(e.call) };
      case "cond": return { ...e, record: condition(e.record) };
      case "test": return { ...e, expr: expr(e.expr) };
      case "and": case "or": return { ...e, items: e.items.map(expr) };
      case "not": return { ...e, expr: expr(e.expr) };
      case "edge": return { ...e, cond: expr(e.cond) };
      default: return e;
    }
  };
  const call = (c: Call): Call => ({ ...c, params: c.params.map((p) => ({ ...p, init: any(p.init) })), body: c.body.map(stmt) });
  const stmt = (s: Stmt): Stmt => {
    switch (s.kind) {
      case "declare": return { ...s, init: any(s.init) };
      case "assignUnit": return { ...s, value: unit(s.value) };
      case "unitLoop": return { ...s, body: s.body.map(stmt) };
      case "unitWrite": return { ...s, unit: unit(s.unit), value: expr(s.value) };
      case "unitDo": return { ...s, unit: unit(s.unit), verb: s.verb.do === "damage" || s.verb.do === "heal" ? { ...s.verb, amount: expr(s.verb.amount) } : s.verb };
      case "tableWrite": return s.value.kind === "text" ? s : { ...s, value: expr(s.value) };
      case "assign": return { ...s, value: expr(s.value) };
      case "assignBool": return { ...s, value: expr(s.value) };
      case "if": return { ...s, cond: expr(s.cond), then: s.then.map(stmt), ...(s.else ? { else: s.else.map(stmt) } : {}) };
      case "while": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), body: s.body.map(stmt) };
      case "do": return { ...s, body: s.body.map(stmt), cond: expr(s.cond) };
      case "for": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), update: s.update.map(stmt), body: s.body.map(stmt) };
      case "unrolled": return { ...s, iterations: s.iterations.map((i) => i.map(stmt)) };
      case "switch": return { ...s, value: expr(s.value), cases: s.cases.map((c) => ({ ...c, body: c.body.map(stmt) })) };
      case "return": return s.value ? { ...s, value: any(s.value) } : s;
      case "action": return { ...s, record: action(s.record) as unknown as ActionRecord, ...(s.variables ? { variables: s.variables.map((v) => ({ ...v, expr: expr(v.expr) })) } : {}) };
      case "centerLocation": return { ...s, x: expr(s.x), y: expr(s.y) };
      case "print": return { ...s, parts: s.parts.map((p) => (p.kind === "number" ? { ...p, expr: expr(p.expr) } : p)) };
      case "call": return { ...s, call: call(s.call) };
      case "block": return { ...s, body: s.body.map(stmt) };
      default: return s;
    }
  };
  return JSON.stringify({ version: programs[0]?.version ?? 1, ...(input ? { input } : {}), programs: programs.map((p) => ({ ...p, body: p.body.map(stmt) })) });
}
