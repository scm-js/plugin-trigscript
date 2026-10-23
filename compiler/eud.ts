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
import { HEAP_CELLS, STACK_DEPTH, bodiesOf, declarations, eachCall, heapCells, stackDepth, isTextExpr, isUnitExpr, mapText, mapTextOperands, mapTextParts, programDeclarations, type ArrayDecl, type At, type BoolExpr, type Call, type FuncDecl, type NumExpr, type Program, type Stmt, type TextExpr, type TextMap, type UnitExpr, type VarDecl } from "./ir";
import type { LineHint, ScriptString } from "./compiler";
import type { InputPlan } from "./input";

export interface ProgramDiagnostic { at: At; message: string }

/** A program's faults, each with the node it is at, and what its lines are worth a word about. */
export function checkProgram(program: Program): { errors: ProgramDiagnostic[]; hints: LineHint[] } {
  const errors: ProgramDiagnostic[] = [];
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));
  const decls = new Map(programDeclarations(program).map((d) => [d.id, d]));
  const hints: LineHint[] = [];
  // The program's body, then the body of every function that is called: each is checked as the statements it is.
  for (const body of bodiesOf(program)) {
    WINDOWS = new Map((program.arrays ?? []).flatMap((a) => (a.slice ? [[a.id, a.slice.of] as const] : [])));
    checkSleeps(body, errors, functions);
    checkDivisions(body, errors);
    checkWidths(body, errors, decls, new Map((program.arrays ?? []).map((a) => [a.id, a])));
    checkUnitLoops(body, errors);
    checkTextLoops(body, errors);
    remarks(body, hints);
  }
  scans(program, hints);
  return { errors, hints };
}

/** Every expression of a statement list, calls' bodies included. */
function expressions(body: Stmt[], visit: (e: NumExpr | BoolExpr) => void, pick?: (u: UnitExpr & { kind: "pick" }) => void) {
  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); else if (u.kind === "pick") pick?.(u); else if (u.kind === "unitAt") { expr(u.ptr); expr(u.epd); expr(u.uid); } };
  const any = (e: NumExpr | BoolExpr | UnitExpr | TextExpr) => (isTextExpr(e) ? text(e) : isUnitExpr(e) ? unit(e) : expr(e));
  const looks: TextMap = { num: (e) => { expr(e); return e; }, bool: (e) => { expr(e); return e; }, call: (c) => { call(c); return c; } };
  const text = (t: TextExpr) => { mapText(t, looks); };
  const expr = (e: NumExpr | BoolExpr) => {
    visit(e);
    if (mapTextOperands(e, looks)) return;
    switch (e.kind) {
      case "unitField": case "unitPart": case "unitAlive": case "unitFlag": unit(e.unit); break;
      case "unitSame": unit(e.left); unit(e.right); break;
      case "unary": case "cast": expr(e.expr); break;
      case "element": expr(e.index); break;
      case "binary": case "compare": expr(e.left); expr(e.right); break;
      case "ternary": expr(e.cond); expr(e.whenTrue); expr(e.whenFalse); break;
      case "intrinsic": e.args.forEach(expr); break;
      case "randomInt": expr(e.bound); break;
      case "and": case "or": e.items.forEach(expr); break;
      case "not": expr(e.expr); break;
      case "test": expr(e.expr); break;
      case "edge": expr(e.cond); break;
      case "running": expr(e.task); break;
      case "call": call(e.call); break;
      default: break;
    }
  };
  const call = (c: Call) => { for (const p of c.params) any(p.init); c.body.forEach(stmt); };
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": if (!s.failed) any(s.init); break;
      case "assign": case "assignBool": expr(s.value); break;
      case "declareArray": s.init?.forEach(expr); if (s.fill) expr(s.fill); break;
      case "store": expr(s.index); expr(s.value); break;
      case "push": expr(s.value); break;
      case "setLength": expr(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "assignText": text(s.value); break;
      case "storeText": expr(s.index); text(s.value); break;
      case "releaseText": expr(s.index); break;
      case "textLoop": text(s.of); s.body.forEach(stmt); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); expr(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "select": s.units.forEach(unit); break;
      case "tableWrite": any(s.value); break;
      case "if": expr(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) expr(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); expr(s.cond); break;
      case "for": if (s.cond) expr(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": call(s.call); break;
      case "cancel": expr(s.task); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) any(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); if (s.text) text(s.text); break;
      case "centerLocation": expr(s.x); expr(s.y); if (s.size) { expr(s.size.width); expr(s.size.height); } break;
      case "syncSend": expr(s.value); break;
      case "print": case "buildText": mapTextParts(s.parts, looks); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** Every statement of a list, nested ones and calls' bodies (as statements) included; a started task's body unless `tasks` is false. */
function statements(body: Stmt[], visit: (s: Stmt) => void, tasks = true) {
  const stmt = (s: Stmt) => {
    visit(s);
    switch (s.kind) {
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "do": case "unitLoop": case "textLoop": s.body.forEach(stmt); break;
      case "for": s.body.forEach(stmt); s.update.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": if (tasks) s.call.body.forEach(stmt); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
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
      if (inner.kind === "parallel") out.push({ at: inner.at, message: "await inside a loop over units: the loop looks at the game's units as they are in one frame and cannot be left half way. Collect the units into an array first, and await in a loop over that array." });
      if (inner.kind === "sleep") out.push({ at: inner.at, message: "sleep() inside a loop over units: the loop looks at the game's units as they are in one frame and cannot be left half way. To do something to one unit at a time, find it again after each sleep: while (true) { const u = first(…); if (!u) break; u.kill(); sleep(seconds(1)); }" });
    }, false);
  });
}

/** A loop over a text walks it once, within the frame: where it has got to is not something a sleep can keep. */
function checkTextLoops(body: Stmt[], out: ProgramDiagnostic[]) {
  statements(body, (s) => {
    if (s.kind !== "textLoop") return;
    statements(s.body, (inner) => {
      if (inner.kind === "parallel") out.push({ at: inner.at, message: "await inside a for…of over a text: the loop walks the text once, within the frame. A loop over its places can wait between turns: for (let i = 0; i < s.length; i++) { … }" });
      if (inner.kind === "sleep") out.push({ at: inner.at, message: "sleep() inside a for…of over a text: the loop walks the text once, within the frame. A loop over its places can sleep between turns: for (let i = 0; i < s.length; i++) { const ch = s[i]; … sleep(frames(2)); }" });
    }, false);
  });
}

/** What a loop over units, or a pick, costs: a word at the end of the line. */
function scans(program: Program, out: LineHint[]) {
  const SLOTS = "every unit on the map (the game's unit table, as far as the units in use reach)";
  const each = program.perPlayer ? ", once for each player the program runs for" : "";
  const seen = new Set<string>();
  const hint = (at: At, label: string, note: string) => {
    const key = `${at.file}:${at.line}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: at.file, line: at.line, label, note });
  };
  for (const body of bodiesOf(program)) statements(body, (s) => { if (s.kind === "for" && s.sorts) hint(s.at, "sorts in the frame", `${s.sorts} is sorted where it stands, within the frame: each item is taken in hand and the ones that go after it moved up. Nearly in order already, that is a pass over the list; in no order it is the length squared — a few dozen items are nothing, a few hundred every frame will be felt.`); });
  // A call that stands in an expression (`unitsOf(P1).some(…)` in an if) has statements of its own, which the walk over statements does not reach.
  const everywhere = (body: Stmt[], visit: (s: Stmt) => void) => { statements(body, visit); expressions(body, (e) => { if (e.kind === "call") statements(e.call.body, visit); }); };
  // on.order() / on.morphed(): the frame's events pass looks at every unit on the map, for as long as the game runs.
  for (const body of bodiesOf(program)) everywhere(body, (s) => { if (s.kind === "unitLoop" && (s.source === "ordered" || s.source === "morphed")) hint(s.at, "watches every unit", `Every frame, for the rest of the game, each unit on the map has its ${s.source === "ordered" ? "order" : "type"} looked at: about 100 conditions and actions a unit (on.order() and on.morphed() together, about 140), so 200 units cost about 20,000 a frame of Remastered's 500,000. Paid once however many listeners there are.`); });
  for (const body of bodiesOf(program)) everywhere(body, (s) => { if (s.kind === "unitLoop" && !s.source) hint(s.at, "scans units", `Looks at ${SLOTS} every time the line runs${each}, and runs the body for the ones that match. Fine once or a few times a second; inside a loop that runs every frame, ask whether it needs to.`); });
  for (const body of bodiesOf(program)) expressions(body, () => {}, (u) => hint(u.at, u.by === "random" ? "scans units ×2" : "scans units", u.by === "random"
    ? `Looks at ${SLOTS} twice every time the line runs${each}: once to count the units that match, once to take the one drawn.`
    : `Looks at ${SLOTS} every time the line runs${each}. Keep the unit in a variable when several lines need it.`));
}

/** A divisor known when the script is built has to be a whole number other than 0; a variable that is 0 in the game gives 0. */
function checkDivisions(body: Stmt[], out: ProgramDiagnostic[]) {
  expressions(body, (e) => {
    if (e.kind !== "binary" || (e.op !== "/" && e.op !== "%") || e.right.kind !== "const") return;
    const d = e.right.value;
    if (!Number.isInteger(d) || d === 0) out.push({ at: e.at, message: `Divide by a whole number other than 0, not ${d}.` });
  });
}

/**
 * A constant put into a `u8` / `u16` has to fit: the game would stop it at the top without a word. A cell of a `u8[]` /
 * `u16[]` as much as a variable — stored, pushed or declared with.
 */
function checkWidths(body: Stmt[], out: ProgramDiagnostic[], decls: Map<string, VarDecl>, arrays: Map<string, ArrayDecl>) {
  const fits = (id: string, value: NumExpr | BoolExpr | UnitExpr | TextExpr, at: At) => {
    const d = decls.get(id);
    if (!d?.bits || value.kind !== "const" || typeof value.value !== "number") return;
    const max = 2 ** d.bits - 1;
    if (value.value > max || value.value < 0) out.push({ at, message: `${d.name} is a u${d.bits} and holds 0 … ${max}, not ${value.value}.` });
  };
  const cell = (id: string, value: NumExpr | BoolExpr | undefined, at: At) => {
    const a = arrays.get(id);
    if (!a?.bits || !value || value.kind !== "const" || typeof value.value !== "number") return;
    const max = 2 ** a.bits - 1;
    if (value.value > max || value.value < 0) out.push({ at, message: `${a.name} is an array of u${a.bits} and each cell holds 0 … ${max}, not ${value.value}.` });
  };
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": if (!s.failed) fits(s.decl.id, s.init, s.at); break;
      case "assign": fits(s.target, s.value, s.at); break;
      case "store": case "push": cell(s.array, s.value, s.at); break;
      case "declareArray": for (const v of s.init ?? []) cell(s.array, v, s.at); cell(s.array, s.fill, s.at); break;
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "do": case "unitLoop": case "textLoop": s.body.forEach(stmt); break;
      case "for": s.body.forEach(stmt); s.update.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": for (const p of s.call.params) fits(p.decl.id, p.init, s.call.at); s.call.body.forEach(stmt); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": for (const p of s.call.params) fits(p.decl.id, p.init, s.call.at); s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
      default: break;
    }
  };
  body.forEach(stmt);
}

/** The `remark` statements, as hints for their lines: those of calls inside expressions too. */
function remarks(body: Stmt[], out: LineHint[]) {
  const visit = (root: unknown): void => {
    if (Array.isArray(root)) { root.forEach(visit); return; }
    if (!root || typeof root !== "object") return;
    const o = root as Record<string, unknown>;
    if (o.kind === "remark") {
      // (A function's body inlined at several calls says the same of its line each time: once is enough.)
      const r = o as Extract<Stmt, { kind: "remark" }>;
      if (r.short && !out.some((h) => h.file === r.at.file && h.line === r.at.line && h.label === r.short)) out.push({ file: r.at.file, line: r.at.line, label: r.short, note: r.text });
      return;
    }
    Object.values(o).forEach((v) => { if (v && typeof v === "object") visit(v); });
  };
  visit(body);
}

/** The variables a statement list assigns (declares count too), by id — and `THE_GAME` when it takes an action, which may change what a read finds. */
function assigned(body: Stmt[], functions: Map<string, FuncDecl>, into = new Set<string>()): Set<string> {
  const followed = new Set<string>();
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "action": case "unitWrite": case "unitDo": case "tableWrite": case "centerLocation": case "syncSend": case "select": into.add(THE_GAME); break;
      case "declare": into.add(s.decl.id); break;
      case "assign": case "assignBool": case "assignUnit": case "assignText": into.add(s.target); break;
      case "textLoop": into.add(s.decl.id); s.body.forEach(stmt); break;
      case "store": case "declareArray": case "push": case "pop": case "setLength": into.add(whole(s.array)); break;
      case "storeText": into.add(whole(s.addr)); break;
      case "releaseText": into.add(whole(s.block)); break;
      case "unitLoop": into.add(s.decl.id); if (s.was) into.add(s.was.id); s.body.forEach(stmt); break;
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": case "for": s.body.forEach(stmt); if (s.kind === "for") s.update.forEach(stmt); break;
      case "do": s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
      default: break;
    }
  };
  // What a called function assigns — a variable of the program it closes over, an array it was passed — the call assigns.
  const call = (c: Call) => {
    for (const p of c.params) into.add(p.decl.id);
    if (c.result) into.add(c.result.decl.id);
    c.body.forEach(stmt);
    const f = c.fn ? functions.get(c.fn) : undefined;
    if (f && !followed.has(f.id)) { followed.add(f.id); f.body.forEach(stmt); pops(f.body); }
  };
  // A pop() whose value is used — `const i = queue.pop()!` — is an expression, and shortens the array as the statement
  // does; a call used as a value — `xs[n++] = 1`, whose index is the update's call — assigns what its body does.
  const pops = (stmts: Stmt[]) => expressions(stmts, (e) => { if (e.kind === "pop") into.add(whole(e.array)); else if (e.kind === "call") call(e.call); });
  body.forEach(stmt);
  pops(body);
  return into;
}

/** What stands in `reads()` for "this expression reads the game": an id no variable has. */
const THE_GAME = "(the game)";

/** A window on an array (a row of a grid) is that array, for what reads and what writes it: set by `checkProgram` for the program it checks. */
let WINDOWS = new Map<string, string>();
const whole = (array: string): string => WINDOWS.get(array) ?? array;

/** The variables an expression reads, by id — and `THE_GAME` when it reads a value of the game or tests a condition. */
function reads(e: NumExpr | BoolExpr, into = new Set<string>()): Set<string> {
  // A text reads the variables it is made from; a list of texts the script has never changes.
  const texts: TextMap = { num: (x) => { reads(x, into); return x; }, bool: (x) => { reads(x, into); return x; }, call: (c) => { reads({ kind: "call", call: c }, into); return c; }, text: (t) => { if (t.kind === "textVar") into.add(t.id); if (t.kind === "textAt") into.add(whole(t.addr)); return mapText(t, texts); } };
  if (mapTextOperands(e, texts)) return into;
  switch (e.kind) {
    case "var": into.add(e.id); break;
    case "element": into.add(whole(e.array)); reads(e.index, into); break;
    case "length": case "pop": into.add(whole(e.array)); break;
    case "read": case "cond": case "tableRead": into.add(THE_GAME); break;
    // What the players did is as it was when the frame began: nothing a loop does within the frame changes it.
    case "input": break;
    case "unitField": case "unitAlive": case "unitFlag": into.add(THE_GAME); if (e.unit.kind === "unitVar") into.add(e.unit.id); break;
    case "unitSame": for (const u of [e.left, e.right]) if (u.kind === "unitVar") into.add(u.id); break;
    case "randomInt": reads(e.bound, into); break;
    case "unary": case "cast": reads(e.expr, into); break;
    case "binary": case "compare": reads(e.left, into); reads(e.right, into); break;
    case "ternary": reads(e.cond, into); reads(e.whenTrue, into); reads(e.whenFalse, into); break;
    case "intrinsic": e.args.forEach((a) => reads(a, into)); break;
    case "and": case "or": e.items.forEach((i) => reads(i, into)); break;
    case "not": reads(e.expr, into); break;
    case "test": reads(e.expr, into); break;
    case "edge": reads(e.cond, into); break;
    // A call reads what it is handed and what its body reads: `while (xs.some((x) => x > 0))` reads xs.
    case "call":
      for (const p of e.call.params) { if (isTextExpr(p.init)) texts.text!(p.init); else if (p.init.kind !== "unitVar" && p.init.kind !== "unitNull") reads(p.init as NumExpr | BoolExpr, into); }
      expressions(e.call.body, (inner) => { if (inner.kind !== "call") reads(inner, into); });
      break;
    default: break;
  }
  return into;
}

/** Whether every way through a statement list reaches a `sleep` (or leaves the loop for good). */
function sleepsOnEveryPath(body: Stmt[]): boolean {
  for (const s of body) {
    switch (s.kind) {
      case "sleep": return true;
      case "break": case "return": case "throw": return true; // Leaves the loop: no freeze on this path.
      case "continue": return false;
      case "if": if (s.else && sleepsOnEveryPath(s.then) && sleepsOnEveryPath(s.else)) return true; break;
      case "block": if (sleepsOnEveryPath(s.body)) return true; break;
      // A throw inside the body goes to the catch: that path sleeps when the body slept before anything that can throw, or the catch sleeps or throws on.
      case "try": if (sleepsOnEveryPath(s.body) && (sleepsBeforeThrowing(s.body) || sleepsOnEveryPath(s.catch) || s.catch.some((c) => c.kind === "throw"))) return true; break;
      case "unrolled": if (s.iterations.some(sleepsOnEveryPath)) return true; break;
      // `all` waits for every branch, so one that always sleeps is enough; `race` goes on when the first ends, so every one has to.
      case "parallel": if (s.mode === "all" ? s.branches.some(sleepsOnEveryPath) : s.branches.length > 0 && s.branches.every(sleepsOnEveryPath)) return true; break;
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

/** Whether a statement list reaches a `sleep` before anything that may throw (a `throw`, a call). */
function sleepsBeforeThrowing(body: Stmt[]): boolean {
  const mayThrow = (root: unknown): boolean => {
    if (Array.isArray(root)) return root.some(mayThrow);
    if (!root || typeof root !== "object") return false;
    const o = root as Record<string, unknown>;
    if (o.kind === "throw" || ((o.kind === "call" || o.kind === "textCall") && o.call)) return true;
    return Object.values(o).some((v) => !!v && typeof v === "object" && mayThrow(v));
  };
  for (const s of body) {
    if (s.kind === "sleep") return true;
    if (mayThrow(s)) return false;
  }
  return false;
}

/** Whether a loop's body can leave it: a `break` of its own (not of a loop or a switch inside it), or a `return`. */
function leaves(body: Stmt[]): boolean {
  // `caught`: inside the body of a try, where a throw goes to its catch and not out of the loop.
  const stmt = (s: Stmt, own: boolean, caught: boolean): boolean => {
    switch (s.kind) {
      case "break": return own;
      case "return": return true;
      case "throw": return !caught;
      case "if": return s.then.some((x) => stmt(x, own, caught)) || !!s.else?.some((x) => stmt(x, own, caught));
      case "block": return s.body.some((x) => stmt(x, own, caught));
      case "try": return s.body.some((x) => stmt(x, own, true)) || s.catch.some((x) => stmt(x, own, caught));
      case "unrolled": return s.iterations.some((i) => i.some((x) => stmt(x, own, caught)));
      case "while": case "do": case "for": return s.body.some((x) => stmt(x, false, caught));
      case "switch": return s.cases.some((c) => c.body.some((x) => stmt(x, false, caught)));
      default: return false;
    }
  };
  return body.some((s) => stmt(s, true, false));
}

function checkSleeps(body: Stmt[], out: ProgramDiagnostic[], functions: Map<string, FuncDecl>) {
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "while": case "for": case "do": {
        let moves = s.cond ? [...reads(s.cond)].some((id) => assigned(s.kind === "for" ? [...s.body, ...s.update] : s.body, functions).has(id)) : false;
        // A call in the condition that changes what is outside it may change what the condition finds: `while (move(0, 1, 0)) {}`.
        if (s.cond && !moves) eachCall(s.cond, (c) => {
          const fn = c.fn ? functions.get(c.fn) : undefined;
          const own = new Set([...declarations(fn ? fn.body : c.body), ...(fn ? fn.params : c.params.map((p) => p.decl))].map((d) => d.id));
          if (c.result) own.add(c.result.decl.id);
          if (fn?.result) own.add(fn.result.decl.id);
          if ([...assigned([{ kind: "call", call: c, at: s.at, label: s.label }], functions)].some((id) => !own.has(id))) moves = true;
        });
        if (!moves && !sleepsOnEveryPath(s.body) && !leaves(s.body) && !(s.kind === "do" && s.cond.kind === "const" && s.cond.value === false)) out.push({ at: s.at, message: s.cond
          ? "This loop's condition never changes inside it, and no path around it sleeps. A program runs until it sleeps or ends, all within one frame of the game, so this loop would never give the frame back and the game would freeze. Add sleep(frames(1)) inside it, or change what it tests."
          : "A loop without an end needs a sleep() on every path around it. A program runs until it sleeps or ends, all within one frame of the game, so this loop would freeze the game. Add sleep(frames(1)) at the end of its body." });
        s.body.forEach(stmt);
        if (s.kind === "for") s.update.forEach(stmt);
        break;
      }
      case "if": s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": s.call.body.forEach(stmt); break;
      case "switch": s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "call": s.call.body.forEach(stmt); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
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
/** A table this long or longer goes to the lowering packed (`packTable`) rather than as a list of numbers. */
export const PACK_FROM = 256;

/**
 * A table's values as the narrowest little-endian bytes that hold every one (1 to 4 a value), in base64: a video's
 * brushes are a few hundred thousand values, which as JSON numbers would outgrow the build's 4 MB of data. The
 * lowering widens them back to a dword each (`python/trigscript.py#unpack_table`).
 */
export function packTable(values: readonly number[]): { bytes: 1 | 2 | 3 | 4; data: string } {
  let top = 0;
  for (const v of values) { const u = v >>> 0; if (u > top) top = u; }
  const bytes: 1 | 2 | 3 | 4 = top < 0x100 ? 1 : top < 0x10000 ? 2 : top < 0x1000000 ? 3 : 4;
  const out = new Uint8Array(values.length * bytes);
  for (let i = 0, at = 0; i < values.length; i++) {
    const u = values[i] >>> 0;
    for (let b = 0; b < bytes; b++) out[at++] = (u >>> (8 * b)) & 0xff;
  }
  return { bytes, data: base64(out) };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const packed = (a: ArrayDecl): ArrayDecl | (Omit<ArrayDecl, "values"> & { packed: ReturnType<typeof packTable> }) => {
  if (!a.values || a.values.length < PACK_FROM) return a;
  const { values, ...rest } = a;
  return { ...rest, packed: packTable(values) };
};

export function serializeIr(programs: Program[], strings: readonly ScriptString[], input: InputPlan | null = null, settings: { heapCells?: number; stackDepth?: number } = {}): string {
  const resolve = (local: number): number | string => {
    if (local <= 0) return 0;
    const s = strings[local - 1];
    return !s ? 0 : "index" in s ? s.index : s.text;
  };
  const action = (r: ActionRecord) => ({ ...r, text: resolve(r.text), wav: resolve(r.wav) });
  const condition = (r: ConditionRecord): ConditionRecord => ({ ...r });
  // Only actions carry strings, and only inside statements — but a call's body is statements inside an expression, so expressions are walked for calls.
  const unit = (u: UnitExpr): UnitExpr => (u.kind === "call" ? { ...u, call: call(u.call) } : u.kind === "unitAt" ? { ...u, ptr: expr(u.ptr), epd: expr(u.epd), uid: expr(u.uid) } : u);
  const any = <E extends NumExpr | BoolExpr | UnitExpr | TextExpr>(e: E): E => (isTextExpr(e) ? text(e) : isUnitExpr(e) ? unit(e) : expr(e as NumExpr | BoolExpr)) as E;
  const copies: TextMap = { num: (e) => expr(e), bool: (e) => expr(e), call: (c) => call(c) };
  const text = (t: TextExpr): TextExpr => mapText(t, copies);
  const expr = <E extends NumExpr | BoolExpr>(e: E): E => {
    const ofTexts = mapTextOperands(e, copies);
    if (ofTexts) return ofTexts;
    switch (e.kind) {
      case "unitField": case "unitPart": case "unitAlive": case "unitFlag": return { ...e, unit: unit(e.unit) };
      case "unitSame": return { ...e, left: unit(e.left), right: unit(e.right) };
      case "unary": case "cast": return { ...e, expr: expr(e.expr) };
      case "element": return { ...e, index: expr(e.index) };
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
      case "running": return { ...e, task: expr(e.task) };
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
      case "select": return { ...s, units: s.units.map(unit) };
      case "unitDo": return { ...s, unit: unit(s.unit), verb: s.verb.do === "damage" || s.verb.do === "heal" ? { ...s.verb, amount: expr(s.verb.amount) } : s.verb };
      case "tableWrite": return { ...s, value: any(s.value) };
      case "assignText": return { ...s, value: text(s.value) };
      case "storeText": return { ...s, index: expr(s.index), value: text(s.value) };
      case "releaseText": return { ...s, index: expr(s.index) };
      case "textLoop": return { ...s, of: text(s.of), body: s.body.map(stmt) };
      case "assign": return { ...s, value: expr(s.value) };
      case "declareArray": return { ...s, ...(s.init ? { init: s.init.map(expr) } : {}), ...(s.fill ? { fill: expr(s.fill) } : {}) };
      case "store": return { ...s, index: expr(s.index), value: expr(s.value) };
      case "push": return { ...s, value: expr(s.value) };
      case "setLength": return { ...s, value: expr(s.value) };
      case "assignBool": return { ...s, value: expr(s.value) };
      case "if": return { ...s, cond: expr(s.cond), then: s.then.map(stmt), ...(s.else ? { else: s.else.map(stmt) } : {}) };
      case "while": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), body: s.body.map(stmt) };
      case "do": return { ...s, body: s.body.map(stmt), cond: expr(s.cond) };
      case "for": return { ...s, ...(s.cond ? { cond: expr(s.cond) } : {}), update: s.update.map(stmt), body: s.body.map(stmt) };
      case "unrolled": return { ...s, iterations: s.iterations.map((i) => i.map(stmt)) };
      case "parallel": return { ...s, branches: s.branches.map((b) => b.map(stmt)) };
      case "start": return { ...s, call: call(s.call) };
      case "cancel": return { ...s, task: expr(s.task) };
      case "switch": return { ...s, value: expr(s.value), cases: s.cases.map((c) => ({ ...c, body: c.body.map(stmt) })) };
      case "return": return s.value ? { ...s, value: any(s.value) } : s;
      case "action": return { ...s, record: action(s.record) as unknown as ActionRecord, ...(s.variables ? { variables: s.variables.map((v) => ({ ...v, expr: expr(v.expr) })) } : {}), ...(s.text ? { text: text(s.text) } : {}) };
      case "syncSend": return { ...s, value: expr(s.value) };
      case "centerLocation": return { ...s, x: expr(s.x), y: expr(s.y), ...(s.size ? { size: { width: expr(s.size.width), height: expr(s.size.height) } } : {}) };
      case "print": case "buildText": return { ...s, parts: mapTextParts(s.parts, copies) };
      case "call": return { ...s, call: call(s.call) };
      case "block": return { ...s, body: s.body.map(stmt) };
      case "try": return { ...s, body: s.body.map(stmt), catch: s.catch.map(stmt) };
      // A loop the emitter took: its islands are statements the Python side lowers, and its original one a walk reads.
      case "graph": return { ...s, original: s.original.map(stmt), graph: { ...s.graph, triggers: s.graph.triggers.map((t) => (t.island ? { ...t, island: stmt(t.island) } : t)) } };
      default: return s;
    }
  };
  // The heap's size goes along only when an array grows and the map's settings changed it: the lowering has the same default.
  const heap = settings.heapCells !== undefined && settings.heapCells !== HEAP_CELLS && programs.some((p) => p.arrays.some((a) => a.dynamic)) ? { heap: heapCells(settings.heapCells) } : {};
  // The same for how deep a function that calls itself may go: only when one does.
  const stack = settings.stackDepth !== undefined && settings.stackDepth !== STACK_DEPTH && programs.some((p) => p.functions?.some((f) => f.recursive)) ? { stack: stackDepth(settings.stackDepth) } : {};
  return JSON.stringify({ version: programs[0]?.version ?? 1, ...heap, ...stack, ...(input ? { input } : {}), programs: programs.map((p) => ({ ...p, arrays: p.arrays.map(packed), ...(p.functions ? { functions: p.functions.map((f) => ({ ...f, body: f.body.map(stmt) })) } : {}), body: p.body.map(stmt) })) });
}
