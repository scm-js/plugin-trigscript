/**
 * The emitter (TrigScript 4, the backend): a program's body lowered whole to one graph of triggers (`graph.ts`,
 * `emitBody`), which the layout (`layout.ts`) puts into the map. A statement it does not take is a refusal, said in
 * the script's words with its line, and the map is not built: there is no other backend. (Until step 17 of the way
 * off eudplib there was — the emitter took the loops it could and left the rest to a lowering in Python — and the
 * shape of the graph, places and copies, dates from then.)
 *
 * Values are written where they are used. A number has *places*: its variable's cell, the dwords that hold it plus a
 * constant for conditions to read as memory (a comparison reads its left side so, the constant making a signed order
 * an unsigned one), and every number field of a trigger that reads it — a condition's number, an action's number. A
 * write writes every place: `i += 1` with i read in four places is five actions in one trigger, where eudplib adds to
 * i's cell and then routes the cell to each reader. `x = y + z` sets each of x's places from y and adds z to each, so
 * y's places include the numbers of those actions, which y's own writes keep. A write is laid out after every write
 * that reads its variable is (they make its places); a variable in a loop of such reads — `x = y` and `y = x` — or set
 * from itself other than by adding is written into its cell alone and copied into the rest after. A place may hold any
 * constant times the variable, so a product by a constant and a shift by one cost nothing more than a sum.
 *
 * The layout is the emitter's own: a loop tests whether to leave, which fails on every turn but the last, so a turn
 * falls through one trigger whose conditions failed (13.4 ns); a branch is a trigger that sets its own next pointer to
 * where it goes, put back by an action at the place it went to.
 */
import { STACK_DEPTH, type ArrayDecl, type BoolExpr, type Call, type FuncDecl, type NumExpr, type ProgramErrors, type ReadSource, type Stmt, type TableCell, type TextPart, type VarDecl, type At } from "../ir";
import type { Range } from "../ranges";
import { PlayerGroup, type ActionRecord, type ConditionRecord } from "../../vendor/triggers";
import { actionDef } from "../../vendor/triggerDefs";
import { OVERFLOW_FN, errorLine } from "./errors";
import { AFTER_END, END, MOST_ACTS, MOST_CONDS, NOW, PASS_END, STACK, SWITCHES, TRIGGER_BYTES, TRIGGER_OFF, TRIGGER_ON, checkGraph, nextOf, type Act, type ActPart, type Compare, type Cond, type Dword, type Graph, type Num, type Region, type Trigger } from "./graph";

/** The game's tick (frames since the game started), and the fields of the trigger a map of our own wakes by. */
export const GAME_TICK = 0x57f23c;
export const WAKE_TICK = "@wake.tick", WAKE_AT = "@wake.at", WAKE_NEXT = "@wake.next";
const FRAMES_PER_SECOND = 24;
const U32 = 2 ** 32;
const SIGN = 2 ** 31;
const MAX = U32 - 1;
const u = (n: number) => ((n % U32) + U32) % U32;

/** a × b, wrapping at 32 bits, both read from 0 up. */
const mul = (a: number, b: number) => u(Math.imul(a, b));

/** a / b or a % b as the simulator has them: towards zero, the remainder with a's sign, or (`unsigned`) read from 0 up; by 0, 0. */
function quotient(op: "/" | "%", a: number, b: number, unsigned: boolean): number {
  if (u(b) === 0) return 0;
  const [x, y] = unsigned ? [u(a), u(b)] : [a | 0, b | 0];
  return op === "/" ? Math.trunc(x / y) : x % y;
}

/** A number as the emitter has it: a constant plus variables, each times a constant (read from 0 up, wrapping). */
interface Linear { c: number; terms: { id: string; k: number }[] }

function scaled(l: Linear, by: number): Linear {
  return { c: mul(l.c, by), terms: l.terms.map((t) => ({ id: t.id, k: mul(t.k, by) })) };
}

/** The same terms of one variable added together; none times 0. */
function merged(c: number, terms: { id: string; k: number }[]): Linear {
  const by = new Map<string, number>();
  for (const t of terms) by.set(t.id, u((by.get(t.id) ?? 0) + t.k));
  return { c: u(c), terms: [...by].filter(([, k]) => k !== 0).map(([id, k]) => ({ id, k })) };
}

function linear(e: NumExpr, cell?: (e: Extract<NumExpr, { kind: "element" | "binary" | "intrinsic" | "randomInt" }>, sides?: [Linear, Linear]) => string | null): Linear | null {
  switch (e.kind) {
    case "const": return e.fn ? null : { c: u(e.value), terms: [] };
    case "var": return { c: 0, terms: [{ id: e.id, k: 1 }] };
    // (A cell the caller reads into a variable of its own first, when it can.)
    case "element": {
      const id = cell?.(e);
      return id ? { c: 0, terms: [{ id, k: 1 }] } : null;
    }
    case "cast": return e.to === "fixed" ? null : linear(e.expr, cell);
    // (A random number below a bound: the caller draws it first, when it can — the bound read.)
    case "randomInt": {
      if (!cell) return null;
      const bound = linear(e.bound, cell);
      if (!bound) return null;
      const id = cell(e, [bound, { c: 0, terms: [] }]);
      return id ? { c: 0, terms: [{ id, k: 1 }] } : null;
    }
    // (A product or a quotient of numbers with a fraction: the caller works it out first, when it can — its sides read.)
    case "intrinsic": {
      // (A square root, of one value: the caller works it out first, when it can.)
      if (cell && e.name === "sqrt" && e.args.length === 1) {
        const a = linear(e.args[0], cell);
        const id = a && cell(e, [a, { c: 0, terms: [] }]);
        return id ? { c: 0, terms: [{ id, k: 1 }] } : null;
      }
      if (!cell || (e.name !== "fmul" && e.name !== "fdiv") || e.args.length !== 2) return null;
      const a = linear(e.args[0], cell), b = linear(e.args[1], cell);
      if (!a || !b) return null;
      const id = cell(e, [a, b]);
      return id ? { c: 0, terms: [{ id, k: 1 }] } : null;
    }
    case "unary": {
      const l = linear(e.expr, cell);
      return l && scaled(l, MAX);
    }
    case "binary": {
      // (A shift by 0 is the number itself; by 32 or more — the count read from 0 up, one below zero past it — `<<` and
      // `>>>` leave nothing, as TrigScript has it where JavaScript shifts by the remainder.)
      if ((e.op === ">>" || e.op === ">>>" || e.op === "<<") && e.right.kind === "const" && !e.right.fn) {
        const count = u(e.right.value);
        if (count === 0) return linear(e.left, cell);
        // (Only of a side the emitter takes: a call in it is taken out first, as anywhere.)
        if (count >= 32 && e.op !== ">>") return linear(e.left, cell) ? { c: 0, terms: [] } : null;
      }
      // (A shift right by a constant: the caller reads it into a variable of its own first, when it can.)
      if ((e.op === ">>" || e.op === ">>>") && cell) {
        const id = cell(e);
        if (id) return { c: 0, terms: [{ id, k: 1 }] };
      }
      const a = linear(e.left, cell), b = linear(e.right, cell);
      if (!a || !b) return null;
      if (e.op === "+") return merged(a.c + b.c, [...a.terms, ...b.terms]);
      if (e.op === "-") return merged(a.c - b.c, [...a.terms, ...scaled(b, MAX).terms]);
      // A product with a constant, a shift left by one: the same 32 bits as the multiplication.
      if (e.op === "*" && b.terms.length === 0) return merged(mul(a.c, b.c), scaled(a, b.c).terms);
      if (e.op === "*" && a.terms.length === 0) return merged(mul(a.c, b.c), scaled(b, a.c).terms);
      // (A shift by a count that comes to a constant, `x >> (n - n)`: by 0 the number itself, of a constant worked out,
      // by 32 or more as TrigScript has it.)
      if ((e.op === ">>" || e.op === ">>>") && b.terms.length === 0) {
        const count = u(b.c);
        if (count === 0) return a;
        if (a.terms.length === 0) return { c: u(count >= 32 ? (e.op === ">>" ? (a.c | 0) >> 31 : 0) : e.op === ">>" ? (a.c | 0) >> count : a.c >>> count), terms: [] };
        if (count >= 32 && e.op === ">>>") return { c: 0, terms: [] };
      }
      if (e.op === "<<" && b.terms.length === 0) {
        if (u(b.c) >= 32) return { c: 0, terms: [] }; // (a, read above, is one the emitter takes)
        const by = u(2 ** b.c);
        return merged(mul(a.c, by), scaled(a, by).terms);
      }
      if ((e.op === "/" || e.op === "%") && a.terms.length === 0 && b.terms.length === 0) return { c: u(quotient(e.op, a.c, b.c, !!e.unsigned)), terms: [] };
      // (A product of two values, a quotient, a remainder: the caller works it out into a variable of its own first,
      // when it can — its sides already read, so that what they read comes first.)
      if (cell && (e.op === "*" || e.op === "/" || e.op === "%" || e.op === "&" || e.op === "|" || e.op === "^" || ((e.op === "<<" || e.op === ">>" || e.op === ">>>") && b.terms.length > 0))) {
        const id = cell(e, [a, b]);
        if (id) return { c: 0, terms: [{ id, k: 1 }] };
      }
      return null;
    }
    default: return null;
  }
}

/**
 * One variable plus a constant, or a constant: what a comparison's side can be — or a variable's bits under a constant
 * mask (`x & K`), which a condition reads as they are, against a constant.
 */
type Side = { id: string; c: number; mask?: number } | { k: number };
function side(e: NumExpr): Side | null {
  if (e.kind === "binary" && e.op === "&") {
    const [v, k] = e.right.kind === "const" ? [e.left, e.right] : e.left.kind === "const" ? [e.right, e.left] : [null, null];
    const l = v && linear(v);
    if (l && k && k.kind === "const" && l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) return { id: l.terms[0].id, c: 0, mask: u(k.value) };
    return null;
  }
  const l = linear(e);
  if (!l) return null;
  if (l.terms.length === 0) return { k: l.c };
  if (l.terms.length === 1 && l.terms[0].k === 1) return { id: l.terms[0].id, c: l.c };
  return null;
}

// ── what a map of our own refuses, said ──

/** Why an array is not one a map of our own keeps (`nativeArray`), in a script's words. */
function arrayWhy(a: ArrayDecl): string | undefined {
  if (a.texts) return "an array of texts";
  if (a.dynamic || a.through) return "an array that grows";
  if (a.kind !== "number" && a.kind !== "boolean") return `an array of ${a.kind}s`;
  return undefined;
}

/**
 * The first thing in a statement a map of our own refused that its emitter never takes, in a script's words: the
 * reason a refusal gives when the checks that refused it gave none ("a product of two values", "the action Create
 * Unit"). Inner parts before the whole, in the order they are written; undefined when every part is one the emitter
 * takes somewhere, and the reason lies in how they are put together.
 */
export function unlowered(s: Stmt, decls: Map<string, VarDecl>, arrays: Map<string, ArrayDecl>): string | undefined {
  const variable = (id: string): string | undefined => {
    const d = decls.get(id);
    if (!d) return undefined;
    if (d.kind === "unit") return "a unit kept in a variable";
    // (A program with `try` or `throw` keeps the message of the error in flight: what it is refused for is the error.)
    if (d.kind === "text") return d.name === "(error message)" ? "an error thrown or caught (try, throw)" : d.name.startsWith("(") ? "a text made while the game runs" : "a text kept in a variable";
    if (d.task !== undefined) return "a variable of a task's";
    if (d.held) return "a variable a closure keeps";
    return undefined;
  };
  const array = (id: string): string | undefined => {
    const a = arrays.get(id);
    return a && arrayWhy(a);
  };
  const plainSide = (e: NumExpr): boolean => linear(e) !== null || e.kind === "element";
  const isConst = (e: NumExpr): boolean => linear(e)?.terms.length === 0;
  const binary = (e: Extract<NumExpr, { kind: "binary" }>): string | undefined => {
    if (linear(e) || !plainSide(e.left) || !plainSide(e.right)) return undefined;
    const byConst = isConst(e.right);
    switch (e.op) {
      case "<<": case ">>": case ">>>": return byConst ? `a shift by a constant (${e.op}) as a value` : undefined;
      default: return undefined;
    }
  };
  const boolOnly = new Set(["compare", "and", "or", "not", "test", "cond", "random", "running", "unitAlive", "unitSame", "unitFlag", "edge", "textCompare", "textTest"]);
  // Expressions: what each kind is, when the emitter never takes it.
  const node = (o: Record<string, unknown>): string | undefined => {
    switch (o.kind) {
      case "binary": return binary(o as Extract<NumExpr, { kind: "binary" }>);
      case "intrinsic": {
        const name = o.name as string;
        if (name === "fmul" || name === "fdiv" || name === "sqrt" || name === "sin" || name === "cos" || name === "atan2") return undefined;
        return name === "min" || name === "max" || name === "abs" ? undefined : `Math.${name}`;
      }
      case "read": {
        const r = o.read as { source: string; record?: { type: number }; fact?: string; of?: string };
        if (r.source === "condition") return undefined;
        if (r.source === "player") return undefined;
        return undefined;
      }
      case "cond": return undefined;
      case "tableRead": return (o.cell as TableCell).special ? `a read of ${(o.cell as { name: string }).name}` : undefined;
      case "input": return `the players' input (${(o.input as { source: string }).source})`;
      case "length": return array(o.array as string) ? "the length of an array that grows" : undefined;
      case "pop": return "pop()";
      case "running": return "a task's running";
      case "taskHandle": return "a task";
      case "edge": return `${o.edge as string}()`;
      case "unitField": return `a unit's ${o.field as string}`;
      case "unitPart": return "a unit's place in the game's memory";
      case "unitAlive": return "whether a unit is alive";
      case "unitSame": return "two units compared";
      case "unitFlag": return `a unit's flag ${o.flag as string}`;
      case "unitNull": case "unitVar": case "pick": case "unitAt": case "selected": return "a unit";
      case "textLength": return "a text's length";
      case "textIndexOf": return "a search in a text";
      case "textCode": return "a character's code";
      case "textCompare": return "two texts compared";
      case "textTest": return `a text's ${o.test as string}`;
      case "textSlice": return "a part of a text (slice)";
      case "textPad": return "a text padded (padStart, padEnd)";
      case "textRepeat": return "a text repeated";
      case "textTernary": return "a ?: of texts";
      case "template": return "a text made while the game runs";
      case "textCall": {
        // (A method of a text the front end writes as a function of its own — `trim()` — or a function of the script's.)
        const name = (o.call as { name: string }).name;
        if (!TEXT_METHODS.has(name.split(".").pop()!)) return `a function that gives back a text (${name})`;
        return name.includes(".") ? `${name}()` : `a text's ${name}()`;
      }
      case "textVar": case "textOf": case "textAt": case "built":
        return "a text of the program's";
      case "ternary": {
        const t = o.whenTrue as { kind: string; value?: unknown; id?: string };
        const boolean = boolOnly.has(t.kind) || typeof t.value === "boolean" || (t.kind === "var" && decls.get(t.id!)?.kind === "boolean");
        return boolean ? "a ?: of booleans" : undefined;
      }
      case "var": return typeof o.id === "string" ? variable(o.id) : undefined;
      case "element": return array(o.array as string);
      default: return undefined;
    }
  };
  // Statements: what each kind is, before what is in it.
  const statement = (t: Stmt): string | undefined => {
    switch (t.kind) {
      case "action": {
        if (gameAction(t)) return undefined;
        if (t.record.type === WAIT_ACTION) return "the action Wait (in a program it holds only its own trigger and takes the player's wait from Transmissions: a program waits with sleep())";
        if (t.record.type === SET_DEATHS_ACTION && t.record.player > LAST_GROUP) return "a write of memory (setMemory())";
        const name = `the action ${actionDef(t.record.type)?.name ?? t.record.type}`;
        return t.variables?.length ? `${name}, its fields from values` : t.text ? `${name}, its text the program's` : name;
      }
      case "tableWrite": return t.cell.special === "name" && (t.value as { kind: string }).kind !== "text" ? `a write of ${t.cell.name} made while the game runs` : undefined;
      case "centerLocation": return undefined;
      case "select": return "select()";
      case "syncSend": return "sync()";
      case "push": return "push()";
      case "pop": return "pop()";
      case "setLength": return "an array's length set";
      case "assignText": case "storeText": case "releaseText": return "a text of the program's";
      case "textLoop": return "a loop over a text";
      case "buildText": return "JSX made while the game runs";
      case "assignUnit": return "a unit kept in a variable";
      case "unitLoop": return t.source ? `units an event gives (${t.source})` : "a loop over units";
      case "unitWrite": return `a unit's ${t.field} written`;
      case "unitDo": return `a unit's verb (${t.verb.do})`;
      case "start": {
        // (`on.*` is a task that listens: say which.)
        const on = t.listen?.source ? { created: "on.created", died: "on.died", killed: "on.killed", ordered: "on.order", morphed: "on.morphed" }[t.listen.source] : t.listen?.inputs?.length ? (t.listen.inputs[0].source === "chat" ? "on.chat" : "on.key") : undefined;
        return on ? `an event handled (${on})` : "a task started";
      }
      case "cancel": return "a task cancelled";
      case "parallel": return t.mode === "race" ? "Promise.race or Promise.any" : "Promise.all";
      case "try": return "try";
      case "throw": return "throw";
      case "uncaught": return "an error nothing catches";
      case "print": return undefined;
      case "declare": case "assign": case "assignBool": return variable(t.kind === "declare" ? t.decl.id : t.target);
      case "declareArray": case "store": return array(t.array);
      default: return undefined;
    }
  };
  let found: string | undefined;
  const walk = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    // (A statement says what it is before what is in it; an expression after, so that the innermost part is named.)
    const isStmt = "label" in o && typeof o.kind === "string" && STATEMENT_KINDS.has(o.kind);
    if (isStmt) found = statement(o as unknown as Stmt);
    // (What is read of a unit says more than the unit: `u.hp` is "a unit's hp", not "a unit kept in a variable".)
    else if (typeof o.kind === "string" && UNIT_READS.has(o.kind)) found = node(o);
    for (const [k, v] of Object.entries(o)) if (k !== "at" && k !== "original" && v && typeof v === "object") walk(v);
    if (!found && !isStmt && typeof o.kind === "string") found = node(o);
  };
  walk(s);
  return found;
}

/** What is read of a unit, and what is done to a text: named before the unit or the text it is done to. */
const UNIT_READS = new Set(["unitField", "unitFlag", "unitAlive", "unitSame", "unitPart", "textLength", "textIndexOf", "textCode", "textCompare", "textTest", "textSlice", "textPad", "textRepeat", "textTernary", "textCall"]);
/** The methods of a text the front end writes as functions of its own (`textCall`). */
const TEXT_METHODS = new Set(["toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase", "trim", "trimStart", "trimEnd", "replace", "replaceAll", "split", "join", "at", "charAt", "concat", "parseInt", "Number"]);
/** Set Deaths, which `setMemory()` is when its player is past the groups (26). */
const SET_DEATHS_ACTION = 45, LAST_GROUP = 26;
const WAIT_ACTION = 4, TRANSMISSION_ACTION = 7, SWITCH_CONDITION = 11, ALWAYS_CONDITION = 22, NEVER_CONDITION = 23;
/**
 * A map of our own (TrigScript 4, step 5 of the way off eudplib): the game's conditions and actions it lays out as the
 * script wrote them — `memory()` and `setMemory()` at an address known when the map is built among them, a Deaths and
 * a Set Deaths whose player is the address's EPD; no action with a field from a value or a text the program made; not
 * Wait, which would hold the owner's whole trigger list.
 */
const gameAction = (s: Extract<Stmt, { kind: "action" }>): boolean =>
  (!s.text || (s.text.kind === "template" && MADE_TEXT.has(s.record.type)) || (s.text.kind === "text" && s.record.type === SET_DEATHS_ACTION)) && s.record.type !== WAIT_ACTION && fieldsTaken(s);
/**
 * The actions whose text may be made while the game runs (a template filled before it, as a print's): Transmission,
 * Display Text, the mission objectives and the leaderboards' labels — the game reads such a text again whenever it
 * draws, from the template the action names, one for each place in the script it is written.
 */
const MADE_TEXT = new Set([7, 9, 12, 17, 18, 19, 20, 21, 33, 34, 35, 36, 37, 40]);
/**
 * Where an action's field from a value goes (`Emitter.action`): the dword of the record its place is, by the part of
 * an action `graph.ts` names it by. The unit type, the action's kind and the count share one; a value in it is the
 * type, or the count times 2^24, or (a 32-bit unit type, `Rewriter.action`'s) both.
 */
const FIELD_PART: Partial<Record<keyof ActionRecord, ActPart>> = { location: "mask", text: "text", wav: "wav", time: "time", player: "dest", target: "value", unitId: "modifier", modifier: "modifier" };
/** Every field from a value is one a place can be, each one variable times a constant plus a constant, one a dword. */
function fieldsTaken(s: Extract<Stmt, { kind: "action" }>): boolean {
  const vs = (s.variables ?? []).filter((v) => linear(v.expr)?.terms.length !== 0);
  if (!(s.variables ?? []).every((v) => FIELD_PART[v.field] && (linear(v.expr)?.terms.length ?? 2) <= 1)) return false;
  return new Set(vs.map((v) => FIELD_PART[v.field])).size === vs.length;
}
/**
 * The actions after which Bring and Command read the counts they found before: the game keeps a table of them while the
 * queries stay of one kind (and, for Bring, one location), throwing it away at the start of a pass, at a query of the
 * other kind, and in the actions that kill or remove units — not in these (Create Unit with Properties, Move Unit,
 * Create Unit, Give Units). The Python side's `MOVES_UNITS`; its `forget_counts` covers Bring alone.
 */
const MOVES_UNITS = new Set([11, 39, 44, 48]);
/**
 * A number of the game's read into a variable (a map of our own, step 5 part 3): what a condition can be asked. Where
 * the game keeps it for one player — deaths, kills, ore, gas — the dword is read where it is; otherwise the condition
 * is asked a bit at a time from the top (`Emitter.readGame`). The Python side's `read_condition`.
 */
const DEATHS_TABLE = 0x58a364, KILLS_TABLE = 0x5878a4, ORE_TABLE = 0x57f0f0, GAS_TABLE = 0x57f120;
/** An address as the player field of a Deaths names it. */
const epdOf = (addr: number) => u((addr - DEATHS_TABLE) / 4);
const CURRENT_PLAYER = 13, DEATHS_TYPE = 15, KILL_TYPE = 5, ACCUMULATE_TYPE = 4, OPPONENTS_TYPE = 14;
const gameRead = (r: ReadSource): r is Extract<ReadSource, { source: "condition" }> => r.source === "condition";
/**
 * Where the game keeps a condition's number for one player, when it does: its address, and the bits of it the condition
 * reads (a masked Deaths, `memory()` with a mask: its location field, 'SC' in its last). A Deaths of a player past the
 * groups is `memory()`: the dword its player field is the EPD of.
 */
function tableOf(rec: ConditionRecord, owner: number | undefined): { at: number; mask: number } | undefined {
  const masked = rec.type === DEATHS_TYPE && rec.mask === MASKED_MARK;
  const mask = masked ? u(rec.location) : U32 - 1;
  if (rec.type === DEATHS_TYPE && rec.player > LAST_GROUP && rec.unitId < 228) return { at: u(DEATHS_TABLE + 4 * (rec.unitId * 12 + rec.player)), mask };
  const p = rec.player === CURRENT_PLAYER ? owner : rec.player <= 11 ? rec.player : undefined;
  if (p === undefined || (masked && rec.type !== DEATHS_TYPE)) return undefined;
  if ((rec.type === DEATHS_TYPE || rec.type === KILL_TYPE) && rec.unitId < 228) return { at: (rec.type === DEATHS_TYPE ? DEATHS_TABLE : KILLS_TABLE) + 4 * (rec.unitId * 12 + p), mask };
  if (rec.type === ACCUMULATE_TYPE && (rec.resource === 0 || rec.resource === 1)) return { at: (rec.resource === 0 ? ORE_TABLE : GAS_TABLE) + 4 * p, mask };
  return undefined;
}
/** The mark a masked condition carries in its last two bytes ('SC'), its mask in its location field. */
const MASKED_MARK = 0x4353;
/** A player's bytes (slot, race) and the supply tables, by race (36 dwords apart), as the Python side reads them. */
const PLAYER_BYTES = { slot: 0x57f1b4, race: 0x57f1c0 } as const;
const SUPPLY_TABLES = { provided: 0x582144, used: 0x582174, max: 0x5821a4 } as const;
/** A dword of memory, or its bits of a mask, read as a value: a masked Deaths whose player is the dword's EPD. */
function memoryRead(addr: number, mask: number | undefined, where: { at: At; label: string }): NumExpr {
  const record: ConditionRecord = { location: mask ?? 0, player: u((addr - DEATHS_TABLE) / 4), amount: 0, unitId: 0, comparison: 0, type: DEATHS_TYPE, resource: 0, flags: 0, mask: mask === undefined ? 0 : MASKED_MARK };
  return { kind: "read", read: { source: "condition", record }, ...where };
}

/** The conditions that read that table: Command, Bring, Command the Most (at), Command the Least (at). */
const COUNTING = new Set([2, 3, 6, 7, 16, 17]);
/**
 * What throws the table away after such an action, in its own trigger: Kill Unit of Player 12's units of type 228,
 * which no unit is (played in the lifted game, 2026-10-20: Command and Bring both count again after it, and Player 12's
 * minerals stay).
 */
const FORGET_COUNTS: ActionRecord = { location: 0, text: 0, wav: 0, time: 0, player: 11, target: 0, unitId: 228, type: 22, modifier: 0, flags: 0x10, padding: 0, mask: 0 };
/**
 * A print at the centre of the screen (`Emitter.centre`): the game's line of errors (the thirteenth of the text lines,
 * 218 bytes each), the game's first free unit (0 makes Create Unit fail with "Cannot create more units", which shows
 * that line), and the player at this computer.
 */
const CENTRE_LINE = 0x640b60 + 218 * 12, CENTRE_BYTES = 218, FIRST_FREE_UNIT = 0x628438, LOCAL_PLAYER = 0x512684;
/** The players' trigger lists: 12 bytes each, +4 the last node, +8 the first (the list's own end, ~(list + 4), when empty). */
export const TRIGGER_LISTS = 0x51a280;
/** Where the game keeps the current player: whom Display Text shows to, and what "the current player" names. */
const CURRENT_PLAYER_ADDRESS = 0x6509b0;
/** The game's unit table: its places, how far apart, where the first one is (`watch`). */
const UNIT_PLACES = 1700, UNIT_STRIDE = 336, UNIT_TABLE_ADDRESS = 0x59cca8, UNIT_TABLE_EPD = (UNIT_TABLE_ADDRESS - 0x58a364) / 4;
/** The events pass's variables the watch writes (`units.ts`'s): the record's EPD, the trigger's first condition's number, the boundary. */
const EVENT_RECORD = "@ev.e", EVENT_FIELDS = "@ev.wf", EVENT_BOUNDARY = "@ev.be";
/** The handler's word to the watch's gate (`units.ts`'s): how many units came on, whether any came on or went, and a bit for each player that had one. */
const EVENT_MADE_N = "@ev.madeN", EVENT_TOUCHED = "@ev.touch", EVENT_OWNERS = "@ev.own";
/**
 * The game's counts the gate watches (TrigScript 4, step 11's quiet frames): a dword a player (0 to 11) of units and of
 * buildings, counted as the unit is made and taken off as it starts to die or is removed — the "Units" and "Buildings"
 * of the score screen (0x488CF6 in 1.16.1: men and every other unit but an egg, a cocoon and a lurker egg in the one,
 * buildings in the other; incomplete ones counted).
 */
const UNIT_COUNTS = 0x581de4, BUILDING_COUNTS = 0x581f34, GATE_PLAYERS = 12;
/**
 * The map's player settings, as a map of our own needs them (TrigScript 4, step 7): the slots a human or a computer
 * plays (0-based, P1 to P8), and each slot's force (0 to 3). Who a program runs for, who All Players and a force are,
 * whether a player can have left.
 */
export interface MapPlayers { slots: number[]; forces: number[] }
/** With no map: the eight slots, all in the first force (a new map's settings). */
export const ANY_PLAYERS: MapPlayers = { slots: [0, 1, 2, 3, 4, 5, 6, 7], forces: [0, 0, 0, 0, 0, 0, 0, 0] };

/**
 * The players a group stands for, a slot each, as the Python side's `group_slots` has them: a player is itself; All
 * Players and a force the slots of the map a human or a computer plays (of that force). Null for anything else.
 */
export function groupSlots(group: number, players: MapPlayers): number[] | null {
  if (group >= 0 && group < 8) return [group];
  if (group === PlayerGroup.AllPlayers) return [...players.slots];
  if (group >= PlayerGroup.Force1 && group <= PlayerGroup.Force4) return players.slots.filter((p) => players.forces[p] === group - PlayerGroup.Force1);
  return null;
}

/** The players a print goes to, a slot each (a map of our own): the owner for the current player, else the group's. */
function playersOf(to: number, owner: number | undefined, players: MapPlayers = ANY_PLAYERS): number[] | null {
  if (to === PlayerGroup.CurrentPlayer) return [owner ?? 0];
  return groupSlots(to, players);
}

/** A unit type's flingy, and the flingy tables a top speed is written into (the Python side's). */
const UNITS_FLINGY = 0x6644f8, FLINGY_CONTROL = 0x6c9858, FLINGY_SPEED = 0x6c9ef8, FLINGY_ACCELERATION = 0x6c9c78, FLINGY_HALT = 0x6c9930;
/** A player's minimap colour, this far after their colour (the Python side's `MINIMAP_COLOR_OFFSET`). */
const MINIMAP_COLOR_OFFSET = 0x581dd6 - 0x581d76;
/** The game's locations in memory (MRGN): 20 bytes each — left, top, right, bottom, then the rest. */
const MRGN = 0x58dc60;
/** The condition types whose comparison is a number's at least / at most, which one condition turns around. */
const COUNTED = new Set([1, 2, 3, 4, 5, 12, 14, 15, 21]);

/**
 * A `max` or `min` against a constant that the value ranges already settle, as its other side: the front end stops an
 * action's amount and count at 0 (`max(n, 0)`), which a counter never below it does not need.
 */
function settled(e: NumExpr): NumExpr {
  if (e.kind !== "intrinsic" || (e.name !== "max" && e.name !== "min") || e.args.length !== 2 || e.unsigned) return e;
  const [x, c] = e.args;
  const r = (x as NumExpr & { range?: readonly [number, number] }).range;
  if (c.kind !== "const" || !r) return e;
  return (e.name === "max" ? r[0] >= c.value : r[1] <= c.value) ? settled(x) : e;
}

/** About the bytes a printed text's template takes (`Emitter.template`): its texts, 12 for a number and 8 more for a fraction, a char 1, and the end. */
function centreBytes(parts: TextPart[]): number {
  return parts.reduce((n, p) => n + (p.kind === "text" ? new TextEncoder().encode(p.text).length : p.kind === "number" ? 15 + (p.fixed ? 9 : 0) : 1), 1);
}

/** Statements with the blocks around them taken away, and the remarks. */
function flatten(list: Stmt[]): Stmt[] {
  return list.flatMap((t) => (t.kind === "block" ? flatten(t.body) : t.kind === "remark" ? [] : [t]));
}

/** A condition of the game's in a trigger (`Cond.game`). */
const gameCond = (r: ConditionRecord): Cond => ({ dword: { game: 0 }, compare: "atLeast", value: 0, game: r });

/**
 * The conditions that hold exactly when a condition of the game's is `when`: itself; turned around, the one condition
 * that holds when it does not — at least n against at most n − 1, a switch set against cleared — or null when there is
 * none (exactly n, Command the Most, …). Always and Never are known either way.
 */
function gameConds(r: ConditionRecord, when: boolean): Cond[] | "true" | "false" | null {
  // (A disabled one as it is: the game decides what it makes of it.)
  if (r.flags & 0x02) return when ? [gameCond(r)] : null;
  if (r.type === ALWAYS_CONDITION) return when ? "true" : "false";
  if (r.type === NEVER_CONDITION) return when ? "false" : "true";
  if (when) return [gameCond(r)];
  if (r.mask) return null;
  if (r.type === SWITCH_CONDITION && (r.comparison === 2 || r.comparison === 3)) return [gameCond({ ...r, comparison: 5 - r.comparison })];
  if (!COUNTED.has(r.type)) return null;
  const n = r.amount >>> 0;
  if (r.comparison === 0) return n === 0 ? "false" : [gameCond({ ...r, comparison: 1, amount: n - 1 })];
  if (r.comparison === 1) return n === U32 - 1 ? "false" : [gameCond({ ...r, comparison: 0, amount: n + 1 })];
  return null;
}

/** The kinds of statement, told apart from the expressions of the same name (`pop`, `call`). */
export const STATEMENT_KINDS = new Set(["declare", "assignText", "storeText", "releaseText", "textLoop", "assign", "declareArray", "store", "push", "setLength", "assignBool", "assignUnit", "unitLoop", "unitWrite", "unitDo", "tableWrite", "if", "while", "do", "for", "unrolled", "switch", "break", "continue", "return", "sleep", "parallel", "start", "cancel", "action", "syncSend", "select", "centerLocation", "print", "buildText", "block", "try", "throw", "uncaught", "remark", "watch"]);

// ── what the emitter takes ──

class Scope {
  /** Every variable a taken statement reads or writes, and those it declares. */
  read = new Set<string>();
  written = new Set<string>();
  declared = new Set<string>();
  /** Why the last statement looked at was not taken. */
  why = "";
  /** Why each statement it refuses is refused (`refuse`), and whether that is a part it never takes. */
  whyOf = new Map<Stmt, { why: string; never: boolean }>();
  /** A map of our own: the slot of the program's owner, the current player while it runs. */
  owner: number | undefined;
  /** A map of our own: the map's player settings. */
  players: MapPlayers = ANY_PLAYERS;
  /** Whether a condition taken reads the game's counts, which an action that makes or moves units leaves behind (`MOVES_UNITS`). */
  counts = false;
  readonly decls: Map<string, VarDecl>;
  constructor(decls: Map<string, VarDecl>) {
    this.decls = decls;
  }

  num(e: NumExpr): boolean {
    const l = linear(e);
    if (!l) return this.no(`a ${e.kind === "binary" ? `${e.op} ` : ""}${e.kind}`);
    for (const t of l.terms) {
      if (!this.ok(t.id)) return this.no(`the variable ${this.decls.get(t.id)?.name ?? t.id}`);
      this.read.add(t.id);
    }
    return true;
  }

  bool(e: BoolExpr): boolean {
    switch (e.kind) {
      case "const": return true;
      case "compare": {
        if (e.unsigned === "left" || e.unsigned === "right") return this.bool(plain(e));
        // (A map of our own: a cell of an array it keeps against a constant, as 32 bits — `Rewriter.cellCompare`'s.)
        if (e.left.kind === "element") {
          const t = e.right.kind === "const" && e.unsigned === true ? this.cellAt(e.left.array, e.left.index) : null;
          if (!t?.jump) return this.no("a cell compared otherwise than with a constant, as 32 bits");
          for (const x of t.index.terms) this.read.add(x.id);
          return true;
        }
        const sm = signedMask(e);
        if (sm) return this.bool(sm);
        const a = side(e.left), b = side(e.right);
        if (!a || !b) return this.no("a comparison of more than a variable and a constant");
        // (Bits under a mask, against a constant only.)
        if (("mask" in a && a.mask !== undefined && !("k" in b)) || ("mask" in b && b.mask !== undefined && !("k" in a))) return this.no("bits under a mask against a variable");
        // (A signed reading of bits under a mask that has the sign bit is not one condition.)
        if (e.unsigned !== true && e.op !== "==" && e.op !== "!=" && [a, b].some((x) => "mask" in x && x.mask !== undefined && x.mask >= SIGN)) return this.no("bits under a mask with the sign bit, ordered as signed");
        for (const x of [a, b]) if ("id" in x) {
          if (!this.ok(x.id)) return this.no(`the variable ${this.decls.get(x.id)?.name ?? x.id}`);
          this.read.add(x.id);
        }
        return true;
      }
      case "test": return this.bool(notZero(e.expr));
      case "var": return this.bool(notZero({ kind: "var", id: e.id }));
      case "and": case "or": return e.items.every((x) => this.bool(x));
      case "not": return this.bool(e.expr);
      case "cond":
        if (e.epd) {
          const l = linear(e.epd);
          if (!l || l.terms.length > 1 || !l.terms.every((t) => this.ok(t.id))) return this.no("a condition's player it does not lower");
          for (const t of l.terms) this.read.add(t.id);
        }
        if (e.amount) {
          const l = linear(e.amount.expr);
          if (!l || l.terms.length > 1 || !l.terms.every((t) => this.ok(t.id))) return this.no("a condition's amount it does not lower");
          for (const t of l.terms) this.read.add(t.id);
        }
        if (COUNTING.has(e.record.type)) this.counts = true;
        return true;
      default: return this.no(`a ${e.kind}`);
    }
  }

  no(why: string): false {
    this.why ||= why;
    return false;
  }

  ok(id: string): boolean {
    if (isTemp(id)) return true;
    const d = this.decls.get(id);
    // (A boolean is a cell holding 1 or 0, as a number is.)
    // (A `u8` / `u16` in a map of our own: every store into it stopped at its top first, `Rewriter.top`.)
    // (A task's variable in a map of our own: each slot's own, `planTasks`.)
    return !!d && (d.kind === "number" || d.kind === "boolean") && !d.held;
  }

  stmts(list: Stmt[], inLoop: boolean): boolean {
    return list.every((s) => this.stmt(s, inLoop));
  }

  /** The statements the emitter does not take (`refuse`): `emitBody` says the first of them, and why. */
  refused = new Set<Stmt>();
  functions = new Map<string, FuncDecl>();
  private named?: Set<string>;
  /** What the called functions name — their variables, parameters and results — worked out once. */
  inFunctions(): Set<string> {
    if (this.named) return this.named;
    const out = new Set<string>();
    const named = (x: unknown): void => {
      if (Array.isArray(x)) { x.forEach(named); return; }
      if (!x || typeof x !== "object") return;
      const o = x as { kind?: string; id?: string; target?: string };
      if ((o.kind === "var" && typeof o.id === "string") || (o.kind === "assign" && typeof o.target === "string")) out.add((o.id ?? o.target)!);
      for (const v of Object.values(o)) if (v && typeof v === "object") named(v);
    };
    for (const f of this.functions.values()) { named(f.body); for (const p of f.params) out.add(p.id); if (f.result) out.add(f.result.decl.id); }
    return (this.named = out);
  }
  /** The program's arrays, by id. */
  arrays = new Map<string, ArrayDecl>();
  /**
   * The statements whose value reads cells of lists known when the map is built: each cell read into a variable of
   * the emitter's own first (`reads`), the value a sum of those and the program's variables.
   */
  tables = new Map<Stmt, { reads: CellRead[]; value: Linear }>();
  /** A map of our own: the statements that set a variable to a number of the game's (`Emitter.readGame`). */
  gameReads = new Map<Stmt, { rec: ConditionRecord; shift: number; epd?: Linear }>();
  /**
   * A number of the game's as a statement's value: a read, or (a byte of memory) its bits shifted down. `epd`: of the
   * dword at a value's EPD (one variable plus a constant).
   */
  readOf(e: NumExpr): { rec: ConditionRecord; shift: number; epd?: Linear } | undefined {
    // (Or its bits moved up: times a power of two, a shift below 0 — a dword's bytes put where they go in another.)
    const up = e.kind === "binary" && e.op === "*" && e.left.kind === "read" && e.right.kind === "const" && e.right.value > 1 && 2 ** Math.round(Math.log2(e.right.value)) === e.right.value;
    const read = e.kind === "read" ? e : e.kind === "binary" && (e.op === ">>>" || up) && e.left.kind === "read" && e.right.kind === "const" ? e.left : undefined;
    if (!read || read.kind !== "read" || !gameRead(read.read)) return undefined;
    const by = read === e ? 0 : ((e as Extract<NumExpr, { kind: "binary" }>).right as { value: number }).value;
    const shift = read === e ? 0 : up ? -Math.round(Math.log2(by)) : by;
    if (up && !read.read.epd) return undefined;
    if (!read.read.epd) return { rec: read.read.record, shift };
    const epd = linear(read.read.epd);
    if (!epd || epd.terms.length > 1 || !epd.terms.every((t) => this.ok(t.id))) return undefined;
    for (const t of epd.terms) this.read.add(t.id);
    return { rec: read.read.record, shift, epd };
  }
  cells = 0;
  /** The stores into cells of the program's arrays the emitter makes: the array, the index, the value (cells first). */
  stores = new Map<Stmt, Store>();
  /**
   * The variables the plan is likely to copy into their places rather than write there: each set from more than a sum
   * (a product, a quotient, a cell, a call's result) or from itself times anything but 1. A field holding a multiple of
   * one is filled a bit at a time on each copy, so a product reads it only where it is (`Emitter.product`).
   */
  heavy = new Set<string>();
  /**
   * A map of our own: a called function's body as the emitter takes it (rewritten once, `emitBody`), and whether each
   * function met so far is taken (`walking` while its body is looked at: a call of it then is a call of itself).
   */
  bodyOf?: (id: string) => Stmt[] | undefined;
  taken = new Map<string, boolean | "walking">();
  /** What a `return` gives back where it stands: the kind of the function or inlined call around it, innermost last. */
  returning: string[] = [];
  /** Whether a call that may come back into its own function is taken: the program then keeps a stack. */
  recursion = false;
  /** A map of our own whose program throws or catches: where the error in flight is kept (`ownErrors`). */
  errors?: ProgramErrors;
  /** A map of our own: each `start`'s slots (`planTasks`), and the starts that run once — one slot, never busy. */
  slots = new Map<Stmt, TaskSlot[]>();
  once = new Set<Stmt>();

  /**
   * A call in a map of our own: its arguments written into the function's parameters, which are variables like any
   * other, and its result copied into the call's own; a called function's body looked at once, an inlined call's body
   * where it is. A call that may come back into the function it is in keeps that function's variables on the stack
   * around it (`saves`): numbers and booleans, not an array's handle.
   */
  call(c: Call): boolean {
    if (c.saves) {
      if (c.saves.arrays.length) return this.no(`a growing array declared in ${c.saves.within}, which calls itself`);
      for (const id of c.saves.vars) if (!this.ok(id)) return this.no(`the variable ${this.decls.get(id)?.name ?? id} of ${c.saves.within}, which calls itself`);
      this.recursion = true;
      // (A program that keeps errors throws a RangeError where the stack runs out: the function that sets it.)
      if (this.errors) {
        if (!this.function(OVERFLOW_FN)) return false;
        this.written.add(errorLine(this.errors));
      }
    }
    for (const p of c.params) {
      const d = p.decl;
      if (!this.ok(d.id)) return this.no(`the parameter ${d.name}, a ${d.kind}`);
      if (d.kind === "boolean" ? !this.test(p.init as BoolExpr) : !this.lowers(p.init as NumExpr)) return this.no(`the value given to ${d.name}`);
      if (d.kind !== "boolean") this.num(p.init as NumExpr);
      this.declared.add(d.id);
      this.written.add(d.id);
    }
    if (c.result) {
      if (!this.ok(c.result.decl.id)) return this.no(`a call that gives back a ${c.result.kind}`);
      this.heavy.add(c.result.decl.id);
      this.declared.add(c.result.decl.id);
      this.written.add(c.result.decl.id);
    }
    if (c.fn !== undefined) return this.function(c.fn);
    this.returning.push(c.result?.kind ?? "void");
    try {
      return this.stmts(c.body, false);
    } finally {
      this.returning.pop();
    }
  }

  /** A called function: its body, looked at once (a call of it inside that body is taken as the body is). */
  function(id: string): boolean {
    const f = this.functions.get(id), state = this.taken.get(id);
    if (state === "walking") return true;
    if (state !== undefined) return state || this.no(`a call of ${f?.name ?? id}`);
    const body = this.bodyOf?.(id);
    if (!f || !body) return this.no(`a call of ${id}`);
    // (A called function is laid out once, outside every coroutine: one that waits could not say whose turn it gives back.)
    if (this.slots.size && holdsKind(body, "sleep")) return this.no(`a call of ${f.name}, which waits, in a program with tasks`);
    this.taken.set(id, "walking");
    let ok = true;
    if (f.result) {
      if (!this.ok(f.result.decl.id)) ok = this.no(`${f.name}, which gives back a ${f.result.kind}`);
      this.declared.add(f.result.decl.id);
      this.written.add(f.result.decl.id);
    }
    this.returning.push(f.result?.kind ?? "void");
    ok = ok && this.stmts(body, false);
    this.returning.pop();
    this.taken.set(id, ok);
    return ok;
  }

  /** A task's call (a map of our own): its parameters, the slot's own variables, which the start writes; its body. */
  taskCall(c: Call): boolean {
    for (const p of c.params) {
      const d = p.decl;
      if (!this.ok(d.id)) return this.no(`the parameter ${d.name}, a ${d.kind}`);
      if (d.kind === "boolean" ? !this.test(p.init as BoolExpr) : !this.lowers(p.init as NumExpr)) return this.no(`the value given to ${d.name}`);
      if (d.kind !== "boolean") this.num(p.init as NumExpr);
      this.declared.add(d.id);
      this.written.add(d.id);
    }
    // (What a task gives back nothing reads: its `return` only ends it.)
    this.returning.push("void");
    try {
      return this.stmts(c.body, false);
    } finally {
      this.returning.pop();
    }
  }

  /**
   * A part of a printed text a map of our own takes: a text, a whole number (signed or a `u32`) the emitter lowers, a
   * byte from one (a colour code chosen as the map is played). Not yet a fixed number, a player's name or colour, a
   * text of the program's.
   */
  printed(p: TextPart): boolean {
    if (p.kind === "text") return true;
    if (p.kind === "pick") {
      if ((p.by.kind !== "var" && p.by.kind !== "const") || !p.cases.every((c) => c.when.kind === "const" && (!c.upTo || c.upTo.kind === "const")) || !this.lowers(p.by)) return this.no("a printed text picked by a value it does not lower");
      this.num(p.by);
      return true;
    }
    if (p.kind !== "number" && p.kind !== "char") return this.no(`a printed ${p.kind === "value" ? "text of the program's" : p.kind === "name" ? "player's name" : "player's colour"}`);
    if (!this.lowers(p.expr)) return this.no("a printed value it does not lower");
    this.num(p.expr);
    this.prints = true;
    return true;
  }

  /** Whether a text printed with a number in it is taken: the map then has the routine that writes one as digits. */
  prints = false;

  /** A `return` of a function or an inlined call the emitter lays out: its value one the emitter lowers. */
  returned(s: Extract<Stmt, { kind: "return" }>): boolean {
    const kind = this.returning[this.returning.length - 1];
    if (s.value === undefined || kind === "void") return true;
    if (kind === "boolean") return this.test(s.value as BoolExpr) || this.no("a value given back that it does not lower");
    if (kind !== "number" || !this.lowers(s.value as NumExpr)) return this.no("a value given back that it does not lower");
    this.num(s.value as NumExpr);
    return true;
  }

  /**
   * `fmul` / `fdiv` of numbers the emitter lowers: which of the Python side's functions (part 3) gives the same bits,
   * and its arguments. A constant side goes into the function (one above zero; below, the statement is the Python
   * side's, whose negation after is not this).
   */
  /** A number the emitter lowers with cells of lists read first; its reads noted. Null when it does not. */
  withCells(e: NumExpr): { reads: CellRead[]; value: Linear } | null {
    const reads: CellRead[] = [];
    const cell = (el: Extract<NumExpr, { kind: "element" | "binary" | "intrinsic" | "randomInt" }>, sides?: [Linear, Linear]): string | null => {
      if (el.kind === "randomInt") {
        // (A map of our own: drawn from the game's own random bits, `Emitter.randomNumber`; the bound in `a`.)
        if (!sides || !sides[0].terms.every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
        const id = `@cell${this.cells++}`;
        const ra = (el.bound as NumExpr & { range?: Range }).range;
        reads.push({ id, arith: { op: "random", a: sides[0], b: sides[1], unsigned: true, ...(ra ? { ra } : {}) } });
        return id;
      }
      if (el.kind === "intrinsic") {
        // (A map of our own: the emitter's own fixed product and quotient, `Emitter.arith`.)
        if (!sides || (el.name !== "fmul" && el.name !== "fdiv" && el.name !== "sqrt") || ![...sides[0].terms, ...sides[1].terms].every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
        const id = `@cell${this.cells++}`;
        const range = (x: NumExpr | undefined) => (x as NumExpr & { range?: Range } | undefined)?.range;
        const [ra, rb, r] = [range(el.args[0]), range(el.args[1]), range(el)];
        // (`unsigned` on a square root: of a whole number read from 0 up.)
        // (`ratio` on a quotient: the rewriter's, of a magnitude over a larger one.)
        reads.push({ id, arith: { op: el.name, a: sides[0], b: sides[1], unsigned: el.name === "sqrt" && !!el.unsigned, ...((el as { ratio?: boolean }).ratio ? { ratio: true } : {}), ...(ra ? { ra } : {}), ...(rb ? { rb } : {}), ...(r ? { r } : {}) } });
        return id;
      }
      if (el.kind === "element") {
        const t = this.table(el);
        if (!t) return null;
        const id = `@cell${this.cells++}`;
        reads.push({ id, table: t });
        return id;
      }
      if (el.op === "*" || el.op === "/" || el.op === "%" || el.op === "&" || el.op === "|" || el.op === "^" || (sides && (el.op === "<<" || el.op === ">>" || el.op === ">>>"))) {
        // (A map of our own: the emitter's own product, division and bits, `Emitter.arith`.)
        if (!sides || ![...sides[0].terms, ...sides[1].terms].every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
        const id = `@cell${this.cells++}`;
        const range = (x: NumExpr) => (x as NumExpr & { range?: Range }).range;
        const [ra, rb, r] = [range(el.left), range(el.right), range(el)];
        reads.push({ id, arith: { op: el.op, a: sides[0], b: sides[1], unsigned: !!el.unsigned, ...(ra ? { ra } : {}), ...(rb ? { rb } : {}), ...(r ? { r } : {}) } });
        return id;
      }
      // A shift right by a constant (its count & 31): in a map of our own, what it shifts read first when it is more than
      // a sum (a product shifted); by a value, `arith` above.
      const by = linear(el.right);
      if (!by || by.terms.length) return null;
      // (`>>` by 32 or more fills with the sign, as `>> 31` does.)
      const k = el.op === ">>" ? Math.min(31, by.c) : by.c;
      if (k < 1 || k > 31) return null;
      const of = linear(el.left, cell);
      if (!of || !of.terms.every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
      const id = `@cell${this.cells++}`;
      // (Value ranges: a number never below zero and at most `top` has only top's bits to test, and its >> is >>>.)
      const r = (el.left as NumExpr & { range?: [number, number] }).range;
      const top = r && r[0] >= 0 ? r[1] : undefined;
      reads.push({ id, shift: { of, by: k, signed: el.op === ">>" && top === undefined, ...(top !== undefined ? { top } : {}) } });
      return id;
    };
    const value = linear(e, cell);
    if (!value || !value.terms.every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
    for (const t of [...value.terms, ...reads.flatMap((r) => (r.table ? r.table.index.terms : r.shift ? r.shift.of.terms : [...r.arith!.a.terms, ...r.arith!.b.terms]))]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
    return { reads, value };
  }

  /** A cell of one of the program's arrays, at an index the emitter lowers (`cellAt`); null otherwise. */
  table(e: NumExpr): Table | null {
    return e.kind === "element" ? this.cellAt(e.array, e.index) : null;
  }

  /**
   * A cell of an array of a map of our own, at an index the emitter lowers: the array's region of cell triggers (a
   * window's, the array it is a window on, at its offset), a guard that the index is inside the array (a window: its
   * own length). A list known when the map is built whose values have few bits between them is read a bit at a time,
   * where it is, as in the Python side's maps. Null for an array whose cells are not a region's: one that grows, holds
   * texts, or is a task's.
   */
  cellAt(array: string, at: NumExpr): Table | null {
    const a = this.arrays.get(array);
    const index = linear(at);
    if (!a || !index || !index.terms.every((t) => this.ok(t.id)) || !nativeArray(a)) return null;
    // (What the value ranges know of the index, as the Python side has it: inside, and there is nothing to test.)
    const r = (at as NumExpr & { range?: readonly [number, number] }).range;
    const safe = !!r && r[0] >= 0 && r[1] < a.length;
    if (a.slice) {
      const of = this.arrays.get(a.slice.of);
      if (!of || !nativeArray(of) || of.slice || !this.ok(a.slice.offset)) return null;
      return { array: of, index: merged(index.c, [...index.terms, { id: a.slice.offset, k: 1 }]), jump: true, guard: index, limit: a.length, ...(safe ? { safe } : {}) };
    }
    if (a.values && readInPlace(a.values)) return { array: a, index };
    return { array: a, index, jump: true, ...(safe ? { safe } : {}) };
  }

  /**
   * A statement the emitter does not take: why, in the script's words, noted against it — what in it the emitter never
   * takes (`unlowered`), else how it is put together (`why`, from the checks since the last refusal) — and the walk
   * goes on, so that `emitBody` can say the first that holds a part never taken.
   */
  refuse(s: Stmt): true {
    const named = unlowered(s, this.decls, this.arrays);
    this.whyOf.set(s, { why: named ?? this.why, never: named !== undefined });
    this.why = "";
    this.refused.add(s);
    return true;
  }

  stmt(s: Stmt, inLoop: boolean): boolean {
    switch (s.kind) {
      case "remark": return true;
      case "textBlock":
        if (!this.ok(s.decl.id)) return this.refuse(s);
        this.declared.add(s.decl.id);
        this.written.add(s.decl.id);
        return true;
      case "showText":
        if (playersOf(s.to, this.owner, this.players) === null) return this.refuse(s);
        return true;
      case "block": return this.stmts(s.body, inLoop);
      case "declare": {
        if (!this.ok(s.decl.id)) return this.refuse(s);
        if (s.decl.kind === "boolean") {
          if (!this.test(s.init as BoolExpr)) return this.refuse(s);
          this.declared.add(s.decl.id);
          this.written.add(s.decl.id);
          return true;
        }
        const r = this.readOf(s.init as NumExpr);
        if (r) {
          this.gameReads.set(s, r);
          if (COUNTING.has(r.rec.type)) this.counts = true;
          this.declared.add(s.decl.id);
          this.written.add(s.decl.id);
          return true;
        }
        if (!this.lowers(s.init as NumExpr)) {
          const t = this.withCells(s.init as NumExpr);
          if (!t) return this.refuse(s);
          this.tables.set(s, t);
        } else this.num(s.init as NumExpr);
        this.weigh(s.decl.id, s.init as NumExpr, this.tables.get(s));
        this.declared.add(s.decl.id);
        this.written.add(s.decl.id);
        return true;
      }
      case "assign": {
        if (!this.ok(s.target)) return this.refuse(s);
        const r = this.readOf(s.value);
        if (r) {
          this.gameReads.set(s, r);
          if (COUNTING.has(r.rec.type)) this.counts = true;
          this.written.add(s.target);
          return true;
        }
        if (!this.lowers(s.value)) {
          const t = this.withCells(s.value);
          if (!t) return this.refuse(s);
          this.tables.set(s, t);
        } else this.num(s.value);
        this.weigh(s.target, s.value, this.tables.get(s));
        this.written.add(s.target);
        return true;
      }
      case "assignBool": {
        if (!this.ok(s.target) || !this.test(s.value)) return this.refuse(s);
        this.written.add(s.target);
        return true;
      }
      case "switch": {
        const v = side(s.value);
        if (!v || ("mask" in v && v.mask !== undefined) || s.cases.some((c) => c.value !== null && typeof c.value !== "number")) return this.refuse(s);
        if ("id" in v) {
          if (!this.ok(v.id)) return this.refuse(s);
          this.read.add(v.id);
        }
        // (A break inside ends the switch; a continue is the loop's around it.)
        return s.cases.every((c) => this.stmts(c.body, true));
      }
      case "unrolled": return s.iterations.every((it) => this.stmts(it, true));
      case "if": return this.test(s.cond) ? this.stmts(s.then, inLoop) && this.stmts(s.else ?? [], inLoop) : this.refuse(s);
      case "while": return (!s.cond || this.test(s.cond)) ? this.stmts(s.body, true) : this.refuse(s);
      case "do": return this.stmts(s.body, true) && this.stmts(s.before ?? [], true) && (this.test(s.cond) || this.refuse(s));
      case "for": {
        if (s.cond && !this.test(s.cond)) return this.refuse(s);
        return this.stmts(s.update, true) && this.stmts(s.body, true);
      }
      case "store": {
        const cell = this.cellAt(s.array, s.index);
        if (!cell?.jump) return this.no("a store into an array a map of our own does not keep") || this.refuse(s);
        const value: { reads: CellRead[]; value: Linear } | null = this.lowers(s.value as NumExpr) ? { reads: [], value: linear(s.value as NumExpr)! } : this.withCells(s.value as NumExpr);
        if (!value) return this.refuse(s);
        for (const t of [...cell.index.terms, ...value.value.terms]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
        this.stores.set(s, { array: cell.array, index: cell.index, ...value, ...(cell.guard ? { guard: cell.guard, limit: cell.limit } : {}), ...(cell.safe ? { safe: true } : {}) });
        return true;
      }
      case "break": case "continue": return inLoop;
      case "sleep": return true;
      case "print":
        // (Display Text shows to the current player: a text for others goes to each player of its group in turn —
        // Players 1 to 8, All Players, a force: the map's slots.)
        if (playersOf(s.to, this.owner, this.players) === null) return this.no("a text shown to a group of players other than P1 to P8, All Players and the forces") || this.refuse(s);
        if (s.position === "center" && centreBytes(s.parts) > CENTRE_BYTES) return this.no(`a text at the centre longer than its line (${CENTRE_BYTES} bytes)`) || this.refuse(s);
        if ((s.position === "chat" || s.position === "center") && s.parts.every((p) => this.printed(p))) return true;
        return this.refuse(s);
      case "call": return this.call(s.call) || this.refuse(s);
      case "action": {
        if (!gameAction(s)) return this.refuse(s);
        if (s.text?.kind === "template" && !s.text.parts.every((p) => this.printed(p))) return this.refuse(s);
        for (const v of s.variables ?? []) for (const t of linear(v.expr)!.terms) {
          if (!this.ok(t.id)) return this.refuse(s);
          this.read.add(t.id);
        }
        return true;
      }
      case "declareArray": {
        // A map of our own: the cells set from the list or the one value (`fill`), each a number the emitter lowers.
        const a = this.arrays.get(s.array);
        if (!a || !nativeArray(a) || a.slice || a.values) return this.refuse(s);
        for (const v of [...(s.init ?? []), ...(s.fill ? [s.fill] : [])]) {
          if (!this.lowers(v as NumExpr)) return this.no("a cell's value it does not lower") || this.refuse(s);
          this.num(v as NumExpr);
        }
        return true;
      }
      // (A `return` at the top of a program ends it: nothing to give back.)
      case "return": return (this.returning.length > 0 ? this.returned(s) : s.value === undefined) || this.refuse(s);
      // (A map of our own: the slots `planTasks` made — a listener's, `on.*`'s, as any other's.)
      case "start": {
        const slots = this.slots.get(s);
        return (!!slots && slots.every((slot) => this.taskCall(slot.call))) || this.refuse(s);
      }
      case "cancel": return (this.lowers(s.task) && (this.num(s.task), true)) || this.refuse(s);
      case "watch": return this.stmts(s.handler, false) || this.refuse(s);
      case "parallel": return s.branches.every((b) => this.stmts(b, false)) || this.refuse(s);
      // (Where a `throw` goes is the emitter's, `Emitter.handler`: the program keeps the error in flight.)
      case "try": return (!!this.errors && this.stmts(s.body, inLoop) && this.stmts(s.catch, inLoop)) || this.refuse(s);
      case "throw": return !!this.errors || this.refuse(s);
      default: return this.refuse(s);
    }
  }

  /**
   * A write of `target`: heavy (`heavy`) when it reads the target times anything but 1 (the plan copies it), or reads a
   * scratch cell a copy fills — a product's or a quotient's, an array's cell kept where it is — through a routed copy a
   * place (56 ns each, where a sum's or a shift's write costs 10).
   */
  weigh(target: string, value: NumExpr, t?: { reads: CellRead[] }): void {
    const l = linear(value);
    if ((l && l.terms.some((x) => x.id === target && x.k !== 1)) || t?.reads.some((r) => r.arith || r.table?.jump)) this.heavy.add(target);
  }

  /** Whether the emitter lowers this number (without noting anything). */
  lowers(e: NumExpr): boolean {
    const l = linear(e);
    return !!l && l.terms.every((t) => this.ok(t.id));
  }

  /** Whether the emitter lowers this test; its reads noted when it does. */
  test(e: BoolExpr): boolean {
    const why = this.why;
    const ok = this.bool(e);
    if (!ok) this.why = why;
    return ok;
  }
}

// ── the layout ──

/** A write of a variable, laid out where the statement was, expanded once every place of the variable is known. */
/** `cold`: written where only an error goes (`Emitter.cold`): what it reads is refreshed from its cell before it, never a place of it. */
interface Write { target: string; value: Linear; at?: At; cold?: boolean }
/** An action of an expanded write: it writes `into`; a variable it reads plus a constant is in its own number. */
interface WriteAct { into: Place; modifier: "set" | "add"; value: Num; reads?: Read }
/**
 * What an action's or a condition's number holds: the variable times `scale`, plus `add` (wrapping) — plus, with
 * `base`, the EPD of that array's first cell (a condition's player field reading a cell at an index).
 */
interface Read { id: string; scale: number; add: number; base?: string }
/**
 * A cell of an array at an index the emitter lowers: of a list known when the map is built, read a bit at a time where
 * it is; or (`jump`) of an EUDVArray, the walk sent into the cell, which writes its value out through eudplib's getter.
 */
/**
 * `guard`, `limit`: the index a window is read at is inside it when `guard` is below `limit` (unset: the array's own).
 * `safe`: the value ranges know the index is inside, and nothing is tested.
 */
interface Table { array: ArrayDecl; index: Linear; jump?: boolean; guard?: Linear; limit?: number; safe?: boolean }
/** A sum the emitter lowers shifted right by a constant: `>>` keeps the sign, `>>>` reads from 0 up. */
/** `top`: the most the shifted number can be, when value ranges know it never below zero (only its bits are tested). */
interface Shift { of: Linear; by: number; signed: boolean; top?: number }
/**
 * A product of two numbers the emitter lowers, or a quotient or a remainder of two (TrigScript 4, step 4 of the way off
 * eudplib): `unsigned` reads both sides from 0 up (`u32`), else as JavaScript's numbers, a quotient towards zero and a
 * remainder with the dividend's sign; by 0 both are 0, as the simulator has them. `ra`, `rb`, `r`: what the value
 * ranges know of each side and of the answer.
 */
interface Arith { op: "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | ">>>" | "fmul" | "fdiv" | "random" | "sqrt"; ratio?: boolean; a: Linear; b: Linear; unsigned: boolean; ra?: Range; rb?: Range; r?: Range }
/** The switch random numbers are drawn through (256, the last, 0-based): put back as it was after each draw. */
const RANDOM_SWITCH = 255;
/** A variable times a constant plus a constant: what a field holding a multiple of a sum reads. */
interface Multiple { id: string; k: number; c: number }
/**
 * The most bits a product's tested side may have for the other side's multiples to be fields of its own (`product`):
 * each one more place of that side, which its writes fill.
 */
const SCALED_BITS = 8;
/** How many bits a number of this range has, read from 0 up: 32 when it may be below zero. */
const width = (r?: Range) => (r && r[0] >= 0 ? (r[1] <= 0 ? 0 : 32 - Math.clz32(r[1])) : 32);
/** Something a value reads first, into a variable of the emitter's own: a cell, a shift, a product or a quotient. */
type CellRead = { id: string; table?: Table; shift?: Shift; arith?: Arith };
/** A store into a cell of one of the program's arrays: its index, and its value with the cells it reads first. */
interface Store { array: ArrayDecl; index: Linear; reads: CellRead[]; value: Linear; guard?: Linear; limit?: number; safe?: boolean }
/** (`at` on a copy or a call: the statement it is for, when its trigger is another's.) */
/** (`label`: every place of `target` set to where `to` is — where a function that calls itself goes back to.) */
/** (`route`: a variable's cell into these dwords, and nothing else of its places.) */
type Item = { act: Act } | { write: Write } | { fill: { temp: string; target: string; apart?: boolean; top?: number } } | { copy: string; at?: At } | { bump: { target: string; add: number } } | { label: { target: string; to: string } } | { pointer: { target: string; to: Dword } } | { route: { from: string; into: Dword[]; add?: number } };
/**
 * `keep`: an empty trigger that stays (a jump whose next pointer a place sets). `guarded`: an `if` in one trigger (its
 * conditions, its statements' actions), which may be followed by the copies of what it writes — a copy whether or not
 * the conditions held, which writes back what the places hold when they did not.
 */
/** `off`: a trigger laid out done (`Trigger.off`): a task's slot or a branch's, switched on by what starts it. */
interface Proto { label: string; conds: Cond[]; items: Item[]; next?: string; at?: At; depth?: number; keep?: boolean; guarded?: boolean; guardOf?: Stmt; cold?: boolean; off?: boolean }

/**
 * A coroutine (TrigScript 4, step 11): where its wake keeps the frame it sleeps until and where it goes on from — the
 * fields a sleep writes — the action a resume puts its wake back with, where its turn goes when it sleeps, and what its
 * end lays out. The program's wake is its run's `@wake` (`layout.ts`); a task's slot and a branch of a `Promise.all` or
 * `race` have a trigger of their own, "the count of frames has reached W: go to R", passed by while done.
 */
interface Co { tick: Dword; at: Dword; reset: Act; yieldTo: string; end: () => void }

/**
 * One of a `start`'s slots, as `emitBody` plans them: the task's call as the slot runs it (variables of its own but in
 * the first slot), its trigger in the tasks' turn, where its body starts, its generation and the number it is known by
 * while it runs (`slot | task << 8 | generation << 16`; 0 when nothing is in it).
 */
interface TaskSlot { call: Call; check: string; entry: string; gen: string; handle: string }
type StartStmt = Extract<Stmt, { kind: "start" }>;

/**
 * A place of a variable: a dword that holds it times `scale` plus `add` (wrapping) — known (its cell, a home, a
 * condition's number) or the number of an action of an expanded write, found when the triggers are cut.
 */
interface Place { dword?: Dword; act?: WriteAct; scale: number; add: number; base?: string; synced?: boolean }

/**
 * The byte a printed text's template fills where nothing goes: 0x0D, a carriage return, which StarCraft draws as
 * nothing — eudplib pads its strings to whole dwords with it, and its own prints carry it around every number.
 */
const PAD = 0x0d;

/**
 * The most bits a list's values may have between them for the emitter to read its cells where they are: a trigger a
 * bit, each 13 ns when the bit is clear and 23 when set, against about 200 ns for the Python side's read of a cell.
 */
const TABLE_BITS = 6;
/** The longest list known when built that is kept as cell triggers whatever its values (a longer one is read in place). */
const TABLE_CELLS_MOST = 16384;

/** The most cells a map of our own's stack has: a trigger of 72 bytes each (4.7 MB at this). */
const STACK_CELLS_MOST = 65536;

/** The EPD between one cell's value and the next's in a region of cell triggers (72 bytes a cell). */
const VARRAY_STRIDE_EPD = 18;

/** An array a map of our own keeps as a region of cell triggers, read by a jump into a cell (`Scope.cellAt`'s). */
function inRegion(arrays: Map<string, ArrayDecl>, id: string): boolean {
  const a = arrays.get(id);
  if (!a || !nativeArray(a)) return false;
  if (a.slice) {
    const of = arrays.get(a.slice.of);
    return !!of && nativeArray(of) && !of.slice;
  }
  if (a.values) return !readInPlace(a.values);
  return true;
}

/**
 * A list known when the map is built that is read a bit at a time where it is, not kept as a region of cell triggers:
 * one whose values have few bits between them, or one too long to keep as cells — a video's brushes for the fog,
 * hundreds of thousands of words, would be tens of megabytes of cells and pass the cells a map lays out; in place it is
 * a dword a value, and a read is a trigger a bit the values have (Bad Apple's: 18).
 */
function readInPlace(values: readonly number[]): boolean {
  return values.length > TABLE_CELLS_MOST || values.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0).toString(2).replace(/0/g, "").length <= TABLE_BITS;
}

/**
 * An array a map of our own keeps in a region of cell triggers (or reads where it is: a list of few bits): of numbers or
 * booleans, one for everyone — not one that grows, holds texts or is a task's. A window on one (a row of a grid) is the
 * array it is a window on. A `u8` / `u16` one is a cell a number, as the Python side's is: each store stopped at its
 * top first (`Rewriter.top`).
 */
function nativeArray(a: ArrayDecl): boolean {
  // (A task's: in place, its start having one slot — `planTasks`.)
  return (a.kind === "number" || a.kind === "boolean") && !a.dynamic && !a.texts && !a.through;
}

/** A constant plus an array's first cell's EPD, as an action's number. */
/** (A base `addr:<id>` is the address of an array's first cell, a trigger; any other the EPD of its first cell's value.) */
const num = (n: number, base?: string): Num => (!base ? n : base.startsWith("addr:") ? { addrOf: base.slice(5), plus: n } : { epdOf: base, plus: n });

/**
 * How many dwords a printed number's field takes: 3 (12 bytes, the most a 32-bit number and its sign need), or fewer
 * when the value ranges (`ranges.ts`) know the number never takes more characters than 4 or 8 — a `?:` of 0 and 1 is
 * one character, so a line of them stays within the game's text line.
 */
function fieldWords(p: Extract<TextPart, { kind: "number" }>): 1 | 2 | 3 {
  const range = (p.expr as NumExpr & { range?: [number, number] }).range;
  if (!range || p.fixed) return 3;
  // (An unsigned print of a value that may be below zero reads it from 0 up: ten digits.)
  if (p.unsigned && range[0] < 0) return 3;
  const chars = Math.max(String(range[0]).length, String(range[1]).length);
  return chars <= 4 ? 1 : chars <= 8 ? 2 : 3;
}

class Emitter {
  protos: Proto[] = [];
  n = 0;
  places = new Map<string, Place[]>();
  /** Every write of each variable. */
  writes = new Map<string, Write[]>();
  /** The branches to put back when the walk reaches a label: the branch, and the label it goes to otherwise. */
  restores = new Map<string, { branch: string; to: string }[]>();
  /** The runs of triggers a doubling trigger walks, each to be laid out one after another (`Graph.rows`). */
  rows: string[][] = [];
  homes = new Set<string>();
  /** A comparison's number that reads a variable: a place of it once the condition is in its trigger. */
  condReads = new Map<Cond, Read>();
  /** A condition whose player field is a place of what it reads: the index of a table's cell. */
  condPlayers = new Map<Cond, Read>();
  /** A jump into an EUDVArray's cell: its trigger's next pointer, a place of the index. */
  jumpReads = new Map<string, Read>();
  /** A store's action: its destination a place of the index, its number (when not a constant) a place of the value. */
  actPlaces = new Map<Act, Partial<Record<ActPart, Read>>>();
  /** The variables of the emitter's own (a table's index, a pinned sum): declared by no statement, a cell each all the same. */
  own = new Set<string>();
  /** The arrays whose cells are read where they are, and the EPD from one cell's value to the next's. */
  arrays = new Map<string, number>();
  loops: { cont: string; exit: string }[] = [];
  /** The statement being laid out: where its triggers say they come from (the cost of a line, the map of triggers). */
  at?: At;
  /** The variables copied whatever the plan says: a table's target with more places than a trigger has actions. */
  forced = new Set<string>();
  /** The variables of the emitter's own that stand for one of the program's in a field (`pin`): what each stands for. */
  pins = new Map<string, string>();
  /** The variables a function's result goes into: their cells take it, and a copy fills their other places. */
  results = new Set<string>();
  /** The emitter's own variables that are a function's parameter: their one place is its cell. */
  /** The table targets whose places outgrew a trigger, for the emitter to try again with them copied. */
  crowded = new Set<string>();
  /** The `if`s laid out as a branch, not in one trigger (`guarded`): those that did not fit in one, found by a build before. */
  unguarded = new Set<Stmt>();
  /** The `if`s in one trigger whose actions did not fit in it. */
  misfits = new Set<Stmt>();
  /**
   * A map of our own: the functions a call has reached, each laid out once after the program (`functions()`) — where
   * it starts, and the trigger it ends at, whose next pointer every call sets to where it goes on — and those still
   * to lay out. `depth`: the most loops around a call of it, which its triggers count as theirs.
   */
  fns = new Map<string, { entry: string; exit: string; depth: number; thrown?: string }>();
  pending: string[] = [];
  /** The loops around the function being laid out, at its deepest call. */
  depthBase = 0;
  /** The function or inlined call being laid out, innermost last: the variable its `return` writes, where it goes. */
  frames: { result?: { id: string; kind: string }; end: string }[] = [];
  /** Where an error thrown here goes: the `catch` of each `try` around, in the function being laid out, innermost last. */
  handlers: string[] = [];
  /** The variables whose cells nothing reads: a label or a pointer set for them is set at their other places only. */
  cellless = new Set<string>();
  /**
   * Inside statements only an error goes through — those that end in a `throw`, and a `catch` (a map of our own): what
   * they read of a variable is refreshed from its cell where it is read, as a routed variable's is, never a place that
   * every write of the variable keeps — a throw's message made from a parameter cost every call of the function an
   * action and a copy, for an error that seldom comes.
   */
  cold = 0;
  /** The coroutine being laid out: the program's (`emitBody`), a task's slot (`tasks()`), a branch (`parallel()`). */
  co!: Co;
  /** The starts laid out, by task number, and those whose slots' bodies are still to lay out; inside a task's body, how deep. */
  pools = new Map<number, { start: StartStmt; slots: TaskSlot[] }>();
  pendingTasks: number[] = [];
  inTask = 0;
  /** Whether a task starts one (`again`): the tasks' turn goes round again, for it to have its first turn in this frame too. */
  again = false;
  /** Where the program's turn goes when it sleeps or ends: the tasks' turn (or the run's end, with no task). */
  get tasksLabel(): string { return `${this.key}:tasks`; }
  get againVar(): string { return `${this.key}.again`; }
  /**
   * Of each function an error comes out of from a trigger of its own (`thrown`), the actions of the calls that point
   * that trigger's next pointer at where the error goes from each: where every call names the same place, the
   * trigger is given it when built, and the calls set nothing (`settleThrown`).
   */
  thrownSets = new Map<string, { items: Item[]; item: Item; to: string }[]>();
  thrownProtos = new Map<string, Proto>();
  private throwing?: Set<string>;
  /**
   * A map of our own whose functions call themselves: a stack each, by function — its id, the variable of the
   * emitter's own that holds the cells in use (`sp`: what addresses the stack — a store's destination, a cell's
   * fields, a jump into one — are places of it), the most cells a frame takes — and, for them all, how many frames
   * are on the stacks (`depth`) and how deep they may go (the script's setting). A stack apart for each function
   * keeps the places of its `sp` to its own calls: one for them all had a place at every call of every function, and
   * every call wrote them all.
   */
  stacks = new Map<string, { id: string; sp: string; frame: number }>();
  stackDepth = STACK_DEPTH;
  /** The called function being laid out (`functions()`): a frame keeps where it goes back to. */
  current?: string;
  /** Of the function being laid out: what is still to be read after each of its calls that may come back. */
  live = new Map<Call, Set<string>>();
  get depth(): string { return `${this.key}.depth`; }

  /** The stack of the function a frame is the function's. */
  stackOf(fn: string): { id: string; sp: string; frame: number } {
    let st = this.stacks.get(fn);
    if (!st) {
      this.stacks.set(fn, (st = { id: `${STACK}:${fn}`, sp: `${this.key}.sp.${fn}`, frame: 0 }));
      this.own.add(st.sp);
    }
    return st;
  }

  readonly key: string;
  readonly scope: Scope;
  constructor(key: string, scope: Scope) {
    this.key = key;
    this.scope = scope;
  }

  label(what: string): string {
    return `${this.key}.${what}${this.n++}`;
  }

  placesOf(id: string): Place[] {
    let p = this.places.get(id);
    if (!p) {
      // (Every variable's cell is the layout's, the emitter's own included, and can be copied from.)
      this.places.set(id, (p = [{ dword: { var: id }, scale: 1, add: 0 }]));
    }
    return p;
  }

  /** A dword that holds the variable plus `add`, for conditions to read as memory. */
  home(id: string, add: number): Dword {
    add = u(add);
    if (add === 0) return this.placesOf(id)[0].dword!;
    const name = `${this.key}.h.${id}.${add}`;
    if (!this.homes.has(name)) {
      this.homes.add(name);
      this.placesOf(id).push({ dword: { data: name }, scale: 1, add });
    }
    return { data: name };
  }

  push(p: Omit<Proto, "label"> & { label?: string }): Proto {
    const t: Proto = { label: p.label ?? this.label("t"), conds: p.conds, items: p.items, next: p.next, at: p.at ?? this.at, depth: this.depthBase + this.loops.length, ...(p.keep ? { keep: true } : {}), ...(p.guarded ? { guarded: true } : {}), ...(p.guardOf ? { guardOf: p.guardOf } : {}), ...(this.cold ? { cold: true } : {}), ...(p.off ? { off: true } : {}) };
    this.protos.push(t);
    return t;
  }

  /** A label the walk can be sent to, here: an empty trigger (puts-back and writes join it; dropped when it stays empty). */
  land(label: string): void {
    this.push({ label, conds: [], items: [] });
  }

  /** The last trigger, if it takes more actions (no conditions, the walk going on to what is next); or a new one. */
  open(): Proto {
    const last = this.protos[this.protos.length - 1];
    if (last && last.conds.length === 0 && last.next === undefined) {
      // (An empty trigger a label stands at takes the line of what fills it.)
      if (!last.items.length) last.at = this.at;
      return last;
    }
    return this.push({ conds: [], items: [] });
  }

  write(target: string, value: Linear, copy = true, into: Item[] = this.open().items, copies = into): void {
    const w: Write = { target, value, ...(this.at ? { at: this.at } : {}), ...(this.cold ? { cold: true } : {}) };
    // (The copy is there for a variable that turns out to need one: the rest leave it out.)
    into.push({ write: w });
    if (copy) copies.push({ copy: target, ...(this.at ? { at: this.at } : {}) });
    let list = this.writes.get(target);
    if (!list) this.writes.set(target, (list = []));
    list.push(w);
  }

  /** The walk goes to `to` from here. */
  goto(to: string): void {
    const last = this.protos[this.protos.length - 1];
    if (last && last.next === undefined && last.conds.length === 0) last.next = to;
    else this.push({ conds: [], items: [], next: to });
  }

  /** A trigger whose conditions all holding send the walk to `to`; otherwise it goes on. (`named`: its label, when its fields are places.) */
  branch(conds: Cond[], to: string, at?: At, named?: string): void {
    const label = named ?? this.label("b"), after = this.label("a");
    this.push({ label, conds, items: [{ act: { dword: { at: label, field: "next" }, modifier: "set", value: { label: to } } }], next: after, at });
    let r = this.restores.get(to);
    if (!r) this.restores.set(to, (r = []));
    r.push({ branch: label, to: after });
    this.land(after);
  }

  // ── comparisons ──

  /** The conditions that all hold exactly when `op` holds of the two sides, or null when one trigger cannot say it. */
  conds(op: CompareOp, a: Side, b: Side, unsigned: boolean): Cond[] | "true" | "false" | null {
    // (Equal or not is the same of the 32 bits signed or not: no bias, the variable's own cell.)
    const d = unsigned || op === "==" || op === "!=" ? 0 : SIGN;
    if ("k" in a && "k" in b) {
      const x = u(a.k + d), y = u(b.k + d);
      const r = op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : op === ">=" ? x >= y : op === "==" ? x === y : x !== y;
      return r ? "true" : "false";
    }
    if ("k" in a) return this.conds(FLIP[op], b, a, unsigned);
    if (a.mask !== undefined) {
      // The bits under the mask, read from 0 up, against the constant: a signed reading of them is the same when the
      // mask leaves the sign bit out (a constant below zero is then below them all).
      let k = (b as { k: number }).k;
      if (op === "==" || op === "!=") k = u(k);
      else {
        if (!unsigned && a.mask >= SIGN) return null;
        if (!unsigned && (k | 0) < 0) return (op === ">" || op === ">=") ? "true" : "false";
      }
      // (Bits the mask has not cannot match.)
      if ((op === "==" || op === "!=") && (k & ~a.mask) !== 0) return op === "!=" ? "true" : "false";
      const mem: Dword = this.home(a.id, 0);
      const one = (compare: Compare, value: number): Cond[] => [{ dword: mem, compare, value, mask: a.mask }];
      switch (op) {
        case "<": return k === 0 ? "false" : one("atMost", k - 1);
        case "<=": return one("atMost", k);
        case ">": return k === MAX ? "false" : one("atLeast", k + 1);
        case ">=": return one("atLeast", k);
        case "==": return one("exactly", k);
        case "!=": return k === 0 ? one("atLeast", 1) : null;
      }
    }
    if ("k" in b === false && (b as { mask?: number }).mask !== undefined) return null;
    const mem = this.home(a.id, a.c + d);
    if ("k" in b) {
      const k = u(b.k + d);
      const one = (compare: Compare, value: number): Cond[] => [{ dword: mem, compare, value }];
      switch (op) {
        case "<": return k === 0 ? "false" : one("atMost", k - 1);
        case "<=": return one("atMost", k);
        case ">": return k === MAX ? "false" : one("atLeast", k + 1);
        case ">=": return one("atLeast", k);
        case "==": return one("exactly", k);
        case "!=": return k === 0 ? one("atLeast", 1) : null;
      }
    }
    // Two variables: b plus a constant in the condition's number (one less for <, one more for >, with a second
    // condition keeping b off the end where that would wrap).
    const read = (compare: Compare, add: number): Cond => {
      const c: Cond = { dword: mem, compare, value: 0 };
      this.condReads.set(c, { id: b.id, scale: 1, add: u(b.c + d + add) });
      return c;
    };
    switch (op) {
      case "<=": return [read("atMost", 0)];
      case ">=": return [read("atLeast", 0)];
      case "==": return [read("exactly", 0)];
      case "<": return [read("atMost", -1), { dword: this.home(b.id, b.c + d), compare: "atLeast", value: 1 }];
      case ">": return [read("atLeast", 1), { dword: this.home(b.id, b.c + d), compare: "atMost", value: MAX - 1 }];
      case "!=": return null;
    }
  }

  /**
   * The condition that holds when a cell of an array a map of our own keeps is so against a constant, as 32 bits
   * (`Rewriter.cellCompare`): read where the index says, by its player field — the EPD of the first cell's number plus
   * 18 a cell, a place of the index. What tests the index inside the array comes before it, in its trigger or before it.
   */
  cellConds(e: Extract<BoolExpr, { kind: "compare" }>, when: boolean): Cond[] | "true" | "false" | null {
    const el = e.left as Extract<NumExpr, { kind: "element" }>;
    const t = this.scope.cellAt(el.array, el.index)!;
    this.region(t.array);
    const op = when ? e.op : INVERSE[e.op], k = u((e.right as { value: number }).value);
    if (op === "!=" && k !== 0) return null;
    const index = this.pin(t.index, "cx");
    const one = (compare: Compare, value: number): Cond[] => {
      const c: Cond = { dword: { element: t.array.id }, compare, value };
      this.condPlayers.set(c, { id: index, scale: VARRAY_STRIDE_EPD, add: 0, base: t.array.id });
      return [c];
    };
    switch (op) {
      case "<": return k === 0 ? "false" : one("atMost", k - 1);
      case "<=": return one("atMost", k);
      case ">": return k === MAX ? "false" : one("atLeast", k + 1);
      case ">=": return one("atLeast", k);
      case "==": return one("exactly", k);
      case "!=": return one("atLeast", 1);
    }
  }

  /** The conditions of one trigger that hold exactly when `e` is `when`, or null. */
  single(e: BoolExpr, when: boolean): Cond[] | "true" | "false" | null {
    if (e.kind === "const") return e.value === when ? "true" : "false";
    if (e.kind === "not") return this.single(e.expr, !when);
    if (e.kind === "test") return this.single(notZero(e.expr), when);
    if (e.kind === "var") return this.single(notZero({ kind: "var", id: e.id }), when);
    if (e.kind === "cond") return this.condsOf(e, when);
    if ((e.kind === "and" && when) || (e.kind === "or" && !when)) {
      const parts = e.items.map((x) => this.single(x, when));
      if (parts.some((p) => p === null)) return null;
      if (parts.includes("false")) return "false";
      const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
      return conds.length === 0 ? "true" : conds.length <= MOST_CONDS ? conds : null;
    }
    if (e.kind !== "compare") return null;
    if (e.unsigned === "left" || e.unsigned === "right") return this.single(plain(e), when);
    if (e.left.kind === "element") return this.cellConds(e, when);
    const sm = signedMask(e);
    if (sm) return this.single(sm, when);
    return this.conds(when ? e.op : INVERSE[e.op], side(e.left)!, side(e.right)!, e.unsigned === true);
  }

  /** The walk goes to `to` when `e` is `when`, and on otherwise. */
  jump(e: BoolExpr, when: boolean, to: string, at?: At): void {
    switch (e.kind) {
      case "const":
        if (e.value === when) this.goto(to);
        return;
      case "not": return this.jump(e.expr, !when, to, at);
      case "test": return this.jump(notZero(e.expr), when, to, at);
      case "var": return this.jump(notZero({ kind: "var", id: e.id }), when, to, at);
      case "and": case "or": {
        if ((e.kind === "and") !== when) {
          // Any item not so goes to `to`: when every item's conditions for being so fit in one trigger, that trigger
          // skips past a goto (one trigger where a branch an item would be more); else an item at a time.
          const parts = e.items.map((x) => this.single(x, !when));
          if (e.items.length > 1 && parts.every((p) => p !== null)) {
            if (parts.includes("false")) return this.goto(to);
            const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
            if (conds.length === 0) return;
            if (conds.length <= MOST_CONDS) {
              const past = this.label("p");
              this.branch(conds, past, at);
              this.goto(to);
              this.land(past);
              return;
            }
          }
          for (const x of e.items) this.jump(x, when, to, at);
          return;
        }
        // Every item must be so: one trigger when their conditions fit in one.
        const parts = e.items.map((x) => this.single(x, when));
        if (parts.every((p) => p !== null)) {
          if (parts.includes("false")) return;
          const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
          if (conds.length === 0) return this.goto(to);
          if (conds.length <= MOST_CONDS) return this.branch(conds, to, at);
        }
        const past = this.label("p");
        for (let i = 0; i < e.items.length - 1; i++) this.jump(e.items[i], !when, past, at);
        this.jump(e.items[e.items.length - 1], when, to, at);
        this.land(past);
        return;
      }
      case "compare": {
        if (e.unsigned === "left" || e.unsigned === "right") return this.jump(plain(e), when, to, at);
        const sm = signedMask(e);
        if (sm) return this.jump(sm, when, to, at);
        const c = this.single(e, when);
        if (c === "false") return;
        if (c === "true") return this.goto(to);
        if (c) return this.branch(c, to, at);
        // != when true, == when false: below, or above — of the 32 bits as they are, which is the same.
        this.jump({ ...e, op: "<", unsigned: true }, true, to, at);
        this.jump({ ...e, op: ">", unsigned: true }, true, to, at);
        return;
      }
      case "cond": {
        const c = this.condsOf(e, when);
        if (c === "false") return;
        if (c === "true") return this.goto(to);
        if (c) return this.branch(c, to, at);
        // (Not so, of a condition no other one turns around: past `to` when it holds.)
        const past = this.label("p");
        this.branch(this.condsOf(e, true) as Cond[], past, at);
        this.goto(to);
        this.land(past);
        return;
      }
      default: throw new Error(`emitter: ${e.kind}`);
    }
  }

  // ── statements ──

  stmts(list: Stmt[]): void {
    const cold = !!this.scope.errors && throwsAtEnd(list);
    if (cold) this.cold++;
    try {
      for (const s of list) this.stmt(s);
    } finally {
      if (cold) this.cold--;
    }
  }

  stmt(s: Stmt): void {
    const outer = this.at, cold = this.cold;
    if (s.at) this.at = s.at;
    // (A loop may turn many times on an error's way too: it, its test and its body, are not cold.)
    if (s.kind === "while" || s.kind === "for" || s.kind === "do") this.cold = 0;
    try {
      this.statement(s);
    } finally {
      this.at = outer;
      this.cold = cold;
    }
  }

  statement(s: Stmt): void {
    switch (s.kind) {
      case "remark": return;
      case "textBlock": {
        // The block a string of zeros among the templates; the variable its EPD, as an action writes a label's.
        this.block(s.block, s.bytes, s.text, s.data);
        const t = `${this.key}.tb${this.n++}`;
        this.open().items.push({ act: { dword: { temp: t }, modifier: "set", value: { epd: { template: s.block, word: 0 } } } }, { fill: { temp: t, target: s.decl.id } });
        return;
      }
      case "showText": {
        this.block(s.block, s.bytes);
        const show: Act = { dword: { game: 0 }, modifier: "set", value: 0, show: s.block };
        const players = playersOf(s.to, this.scope.owner, this.scope.players)!, owner = this.scope.owner ?? 0;
        const current = (p: number): Item => ({ act: { dword: { game: CURRENT_PLAYER_ADDRESS }, modifier: "set", value: p } });
        this.open().items.push(...(players.length === 1 && players[0] === owner ? [{ act: show }] : [...players.flatMap((p) => [current(p), { act: { ...show } }]), current(owner)]));
        return;
      }
      case "block": return this.stmts(s.body);
    }
    if (s.kind === "declare" && s.decl.kind === "boolean") return this.setBool(s.decl.id, s.init as BoolExpr);
    if (s.kind === "assignBool") return this.setBool(s.target, s.value);
    if (s.kind === "call") return this.call(s.call);
    if (s.kind === "action") return this.action(s);
    const read = this.scope.gameReads.get(s);
    if (read && (s.kind === "declare" || s.kind === "assign")) return read.epd ? this.readAt(s.kind === "declare" ? s.decl.id : s.target, read.rec, read.epd, s.at, read.shift) : this.readGame(s.kind === "declare" ? s.decl.id : s.target, read.rec, s.at, read.shift);
    if (s.kind === "declareArray") return this.declareArray(s);
    if (s.kind === "return") return this.ret(s);
    const store = this.scope.stores.get(s);
    if (store) return this.store(store);
    const cells = this.scope.tables.get(s);
    if (cells && (s.kind === "declare" || s.kind === "assign")) {
      const target = s.kind === "declare" ? s.decl.id : s.target;
      // (A map of our own: a value that is one cell of an array it keeps, read straight into the target.)
      const [only] = cells.reads;
      if (cells.reads.length === 1 && only.table?.jump && cells.value.c === 0 && cells.value.terms.length === 1 && cells.value.terms[0].id === only.id && cells.value.terms[0].k === 1) {
        return this.readCell(target, only.table, s.at);
      }
      // (A product or a quotient alone, worked out straight into the target.)
      if (cells.reads.length === 1 && only.arith && cells.value.c === 0 && cells.value.terms.length === 1 && cells.value.terms[0].id === only.id && cells.value.terms[0].k === 1) {
        return this.arith(target, only.arith, new Map(), s.at);
      }
      // The cells first, each into a variable of the emitter's own; then the value, a sum of them and the rest.
      const own = new Map(cells.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
      for (const r of cells.reads) {
        this.own.add(own.get(r.id)!);
        // (One a scratch cell is copied into — a product, a quotient, a cell jumped into — is heavy for what reads it.)
        if (r.arith || r.table?.jump) this.scope.heavy.add(own.get(r.id)!);
        if (r.table) this.readTable(own.get(r.id)!, r.table, s.at);
        else if (r.shift) this.readShift(own.get(r.id)!, { ...r.shift, of: { c: r.shift.of.c, terms: r.shift.of.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) } }, s.at);
        else this.arith(own.get(r.id)!, r.arith!, own, s.at);
      }
      const value = { c: cells.value.c, terms: cells.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
      return this.write(target, value);
    }
    switch (s.kind) {
      case "declare": return this.write(s.decl.id, linear(s.init as NumExpr)!);
      case "assign": return this.write(s.target, linear(s.value)!);
      case "if": {
        // (A test that is a constant — the library's `if (false)` around a branch a call never takes — lays out the side
        // it takes, alone.)
        if (s.cond.kind === "const") return this.stmts(s.cond.value ? s.then : s.else ?? []);
        // A map of our own: actions of the game's and writes that read nothing but their target, under conditions
        // that fit in one trigger — that trigger, its actions run when they hold (no branch, no puts-back); the copies
        // of what it writes after it.
        const then = flatten(s.then);
        const guard = !this.unguarded.has(s) && !s.else?.length && then.length && then.length <= MOST_ACTS / 4 && then.every((t) => this.guards(t)) ? this.single(s.cond, true) : null;
        if (guard === "false") return;
        if (Array.isArray(guard)) {
          const items: Item[] = [], copies: Item[] = [];
          for (const t of then) {
            const outer = this.at;
            if (t.at) this.at = t.at;
            if (t.kind === "action") items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, record: t.record, ...(t.at ? { at: t.at } : {}) } }, ...this.forgets(t.record));
            else if (t.kind === "assign") this.write(t.target, linear(t.value)!, true, items, copies);
            this.at = outer;
          }
          this.push({ conds: guard, items: [...items, ...copies], at: s.at, guarded: true, guardOf: s });
          return;
        }
        const other = this.label("else"), done = this.label("fi");
        this.jump(s.cond, false, s.else?.length ? other : done, s.at);
        this.stmts(s.then);
        if (s.else?.length) {
          this.goto(done);
          this.land(other);
          this.stmts(s.else);
        }
        this.land(done);
        return;
      }
      case "while": case "for": {
        const head = this.label("loop"), cont = this.label("cont"), exit = this.label("exit");
        // What of the test nothing in the loop changes is tested once, on the way in (a u32 counter against a signed
        // bound is the bound's sign and the counter's place: the sign does not change).
        // (Everything the loop may write: a boolean set from a test, what a call in it writes, all the way down.)
        // (Not in a loop that sleeps: while it sleeps, a task or a branch may write anything it reads.)
        const sleeps = holdsKind(s.body, "sleep") || (s.kind === "for" && holdsKind(s.update, "sleep"));
        const { once, every } = !s.cond ? { once: null, every: null } : sleeps ? { once: null, every: s.cond } : split(s.cond, writes({ kind: "block", body: [...s.body, ...(s.kind === "for" ? s.update : [])], at: s.at }, this.scope.functions));
        if (once) this.jump(once, false, exit, s.at);
        this.land(head);
        if (every) this.jump(every, false, exit, s.at);
        this.loops.push({ cont, exit });
        this.stmts(s.body);
        this.land(cont);
        if (s.kind === "for") this.stmts(s.update);
        this.loops.pop();
        this.goto(head);
        this.land(exit);
        return;
      }
      case "do": {
        const head = this.label("loop"), cont = this.label("cont"), exit = this.label("exit");
        this.land(head);
        this.loops.push({ cont, exit });
        this.stmts(s.body);
        this.loops.pop();
        this.land(cont);
        // (What the test needs computed first, at every turn's end — a `continue` lands here too.)
        if (s.before) this.stmts(s.before);
        this.jump(s.cond, false, exit, s.at);
        this.goto(head);
        this.land(exit);
        return;
      }
      case "switch": {
        // A test of the value against each case, in order; the bodies one after another (a case falls into the next).
        const end = this.label("swend"), at = s.at;
        const labels = s.cases.map(() => this.label("case"));
        s.cases.forEach((c, i) => {
          if (c.value !== null) this.jump({ kind: "compare", op: "==", left: s.value, right: { kind: "const", value: c.value }, at, label: s.label }, true, labels[i], at);
        });
        const fallback = s.cases.findIndex((c) => c.value === null);
        this.goto(fallback >= 0 ? labels[fallback] : end);
        const outer = this.loops[this.loops.length - 1];
        this.loops.push({ cont: outer?.cont ?? end, exit: end });
        s.cases.forEach((c, i) => {
          this.land(labels[i]);
          this.stmts(c.body);
        });
        this.loops.pop();
        this.land(end);
        return;
      }
      case "unrolled": {
        // Each turn as it is: a continue goes to the next, a break past the last.
        const end = this.label("unend");
        for (const it of s.iterations) {
          const next = this.label("unnext");
          this.loops.push({ cont: next, exit: end });
          this.stmts(it);
          this.loops.pop();
          this.land(next);
        }
        this.land(end);
        return;
      }
      case "sleep": {
        return this.sleepIn(this.co, s.cycles ?? Math.max(1, Math.round(((s.ms ?? 0) * FRAMES_PER_SECOND) / 1000)));
      }
      case "print": return this.print(s);
      case "break": return this.goto(this.loops[this.loops.length - 1].exit);
      case "continue": return this.goto(this.loops[this.loops.length - 1].cont);
      case "start": return this.start(s);
      case "watch": return this.watch(s);
      case "cancel": return this.cancel(s);
      case "parallel": return this.parallel(s);
      case "try": {
        // The body, with its `catch` as where an error thrown in it goes; the `catch` after it, reached only that way.
        // (Nothing of it is done while the game runs until an error is thrown.)
        const caught = this.label("catch"), end = this.label("tend");
        this.handlers.push(caught);
        this.stmts(s.body);
        this.handlers.pop();
        this.goto(end);
        this.land(caught);
        this.cold++;
        this.stmts(s.catch);
        this.cold--;
        this.land(end);
        return;
      }
      // (The error in flight is set by the statements before it, the line it was thrown at among them: `ownErrors`.)
      case "throw": return this.goto(this.handler());
      default: throw new Error(`emitter: a ${s.kind} it does not lower reached the lowering`);
    }
  }

  /**
   * A cell of a list known when the map is built, into `target`: the index into a variable of the emitter's own, the
   * target set to 0, and for each bit any of the values has, a trigger whose conditions are the index inside the list
   * (read from 0 up: one below zero is past the end, which reads 0) and that bit of the cell — read where it is, the
   * condition's player field the cell's EPD, a place of the index — adding the bit to every place of the target. The
   * index is tested first: the game stops at a trigger's first condition that fails, so a cell past the end is never
   * read.
   */
  readTable(target: string, t: Table, at?: At): void {
    if (t.jump) return this.readCell(target, t, at);
    // (The list's values one after another, a dword each: the layout puts them so.)
    const stride = 1;
    this.arrays.set(t.array.id, stride);
    const index = `${this.key}.i${this.n++}`;
    this.own.add(index);
    this.write(index, t.index, false);
    this.write(target, { c: 0, terms: [] }, false);
    const bits = t.array.values!.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0);
    const inside: Cond = { dword: this.home(index, 0), compare: "atMost", value: t.array.values!.length - 1 };
    for (let j = 0; j < 32; j++) {
      if (!((bits >>> j) & 1)) continue;
      const cell: Cond = { dword: { element: t.array.id }, compare: "atLeast", value: 1, mask: u(2 ** j) };
      this.condPlayers.set(cell, { id: index, scale: stride, add: 0, base: t.array.id });
      this.push({ conds: [{ ...inside }, cell], items: [{ bump: { target, add: u(2 ** j) } }], at });
    }
    this.open().items.push({ copy: target, ...(this.at ? { at: this.at } : {}) });
  }

  /**
   * A sum shifted right by a constant, into `target`: the sum into a variable of the emitter's own (or, a variable
   * alone, read in its cell), the target set to 0, and for each bit that comes down a trigger testing it and adding
   * its new place's worth to every place of the target — for `>>`, the sign bit its weight below zero. From the top,
   * eight bits a group, a group with none of its bits set is jumped over (a small number skips most), as the Python
   * side's shift does.
   */
  readShift(target: string, sh: Shift, at?: At): void {
    let home: Dword;
    if (sh.of.c === 0 && sh.of.terms.length === 1 && sh.of.terms[0].k === 1 && !this.own.has(sh.of.terms[0].id)) home = this.placesOf(sh.of.terms[0].id)[0].dword!;
    else {
      const of = `${this.key}.s${this.n++}`;
      this.own.add(of);
      this.write(of, sh.of, false);
      home = this.home(of, 0);
    }
    this.write(target, { c: 0, terms: [] }, false);
    const highest = sh.top === undefined ? 31 : Math.min(31, Math.max(0, sh.top).toString(2).length - 1);
    if (highest < sh.by) {
      // (Every bit that would come down is 0.)
      this.open().items.push({ copy: target, ...(this.at ? { at: this.at } : {}) });
      return;
    }
    for (let top = highest; top >= sh.by; top -= 8) {
      const bits = [];
      for (let j = top; j >= Math.max(sh.by, top - 7); j--) bits.push(j);
      const group = bits.reduce((m, j) => (m + 2 ** j), 0);
      const past = this.label("g");
      this.branch([{ dword: home, compare: "exactly", value: 0, mask: u(group) }], past, at);
      for (const j of bits) {
        const add = j === 31 && sh.signed ? u(-(2 ** (31 - sh.by))) : u(2 ** (j - sh.by));
        this.push({ conds: [{ dword: home, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: [{ bump: { target, add } }], at });
      }
      this.land(past);
    }
    this.open().items.push({ copy: target });
  }

  /** A boolean set from a test: 1 when it holds, 0 when not. */
  /**
   * A condition of the game's as conditions that hold exactly when it is `when` (`gameConds`); one whose amount is a
   * value (`cond.amount`) has it as a place of the value, turned around one more or one less where the value's range
   * keeps the amount inside 0 to 2^32 − 1.
   */
  condsOf(e: Extract<BoolExpr, { kind: "cond" }>, when: boolean): Cond[] | "true" | "false" | null {
    if (e.epd) {
      // (The player field a place of the value: the dword at its EPD. A condition turned around is not one.)
      const p = linear(e.epd)!;
      const c = e.amount ? this.condsOf({ ...e, epd: undefined }, when) : gameConds(e.record, when);
      if (!Array.isArray(c) || c.length !== 1) return null;
      if (p.terms.length) this.condPlayers.set(c[0], { id: p.terms[0].id, scale: p.terms[0].k, add: u(p.c) });
      else c[0].game = { ...c[0].game!, player: u(p.c) };
      return c;
    }
    if (!e.amount) return gameConds(e.record, when);
    const l = linear(e.amount.expr)!, [t] = l.terms, add = e.amount.add;
    const r = (e.amount.expr as NumExpr & { range?: readonly [number, number] }).range;
    const one = (comparison: number, more: number): Cond[] => {
      const c = gameCond({ ...e.record, comparison, amount: 0 });
      this.condReads.set(c, { id: t.id, scale: t.k, add: u(l.c + add + more) });
      return [c];
    };
    if (when) return one(e.record.comparison, 0);
    if (e.record.comparison === 0) return r && r[0] + add >= 1 ? one(1, -1) : null;
    if (e.record.comparison === 1) return r && r[1] + add <= U32 - 2 ? one(0, 1) : null;
    return null;
  }

  /** A statement an `if` may guard in its one trigger: an action of the game's, or a write that reads only its target. */
  guards(t: Stmt): boolean {
    if (this.scope.tables.has(t)) return false;
    if (t.kind === "action") return gameAction(t) && !t.variables?.length && !t.text && t.record.type !== TRANSMISSION_ACTION;
    if (t.kind !== "assign" || isTemp(t.target) || this.own.has(t.target) || this.results.has(t.target)) return false;
    const l = linear(t.value);
    return !!l && l.terms.every((x) => x.id === t.target && x.k === 1);
  }

  /**
   * An action of the game's, as the script wrote it, among the trigger's others. After one that makes or moves units,
   * in a program that asks Bring or Command, Kill Unit of no unit (`FORGET_COUNTS`), in the same trigger.
   */
  action(s: Extract<Stmt, { kind: "action" }>): void {
    // (Bring and Command counted again, written by the rewriter after a location moved: only where something counts.)
    if (s.record === FORGET_COUNTS) {
      if (this.scope.counts) this.open().items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, record: FORGET_COUNTS } });
      return;
    }
    // A field from a value is a place of its variable, kept by its writes: the action reads it where it is, and costs
    // nothing more when it runs. The record holds the rest; in the dword the type, the kind and the count share, the
    // place's constant is what is not the value. Its trigger is one of its own, the action first, so the place's index
    // holds.
    const record: ActionRecord = { ...s.record };
    const vars = (s.variables ?? []).map((v) => ({ ...v, l: linear(v.expr)! }));
    for (const v of vars) if (!v.l.terms.length) (record as unknown as Record<string, number>)[v.field] = v.l.c & (v.bits === 32 ? -1 : 2 ** v.bits - 1);
    const varied = vars.filter((v) => v.l.terms.length);
    const word = (f: string) => varied.some((v) => v.field === f);
    const places: Partial<Record<ActPart, Read>> = {};
    for (const v of varied) {
      const [t] = v.l.terms;
      let scale = 1, add = 0;
      if (v.field === "unitId" || v.field === "modifier") {
        add = u((word("unitId") ? 0 : record.unitId) + record.type * 2 ** 16 + (word("modifier") ? 0 : record.modifier) * 2 ** 24);
        if (v.field === "modifier") scale = 2 ** 24;
      }
      (record as unknown as Record<string, number>)[v.field] = 0;
      places[FIELD_PART[v.field]!] = { id: t.id, scale: mul(scale, t.k), add: u(mul(scale, v.l.c) + add) };
    }
    // (A text made while the game runs: its template filled first, the action's text field naming it.)
    const textOf = s.text?.kind === "template" ? this.template(s.text.parts) : undefined;
    // (A Set Deaths whose amount is a text's number — `Rewriter.tableWrite`'s name — the shift its mask's.)
    const amountText = s.text?.kind === "text" && record.type === SET_DEATHS_ACTION ? { text: s.text.text, shift: record.location ? 31 - Math.clz32(record.location & -record.location) : 0 } : undefined;
    const act: Act = { dword: { game: 0 }, modifier: "set", value: 0, record, ...(textOf !== undefined ? { textOf } : {}), ...(amountText ? { amountText } : {}) };
    const items: Item[] = [{ act }, ...this.forgets(record)];
    if (record.type === TRANSMISSION_ACTION) return this.transmission(act, varied.length ? places : undefined);
    if (varied.length) {
      this.actPlaces.set(act, places);
      // (Several in a row share a trigger: the indexes of their actions hold while nothing but actions is in it.)
      const last = this.protos[this.protos.length - 1];
      if (last && last === this.fielded && !last.items.some((it) => !("act" in it)) && last.items.length + items.length <= MOST_ACTS) last.items.push(...items);
      else this.fielded = this.push({ conds: [], items });
    } else this.open().items.push(...items);
  }

  /** The trigger the last action with fields from values was put in (`action`), which the next one may share. */
  fielded?: Proto;

  /**
   * A Transmission holds the rest of its trigger until its time is over — the walk goes on to the next trigger — and
   * marks itself started, so that the game steps over it the next time its trigger is reached, going on from it: every
   * other Transmission of a loop never showed (eudplib's do not). So it is the first action of a trigger of its own,
   * and the trigger after it puts its flags and the trigger's current action back, as they were before it ran: each
   * time the program reaches it, it shows. (A Transmission while another one's time runs is still held, as the game
   * holds it.)
   */
  transmission(act: Act, places?: Partial<Record<ActPart, Read>>): void {
    if (places) this.actPlaces.set(act, places);
    const tx = this.push({ conds: [], items: [{ act }] });
    this.push({ conds: [], items: [
      { act: { dword: { at: tx.label, field: { act: 0, part: "flags" } }, modifier: "set", value: act.record!.flags, mask: 0xff } },
      { act: { dword: { at: tx.label, field: "current" }, modifier: "set", value: 0, mask: 0xff000000 } },
    ] });
  }

  /**
   * A number of the game's into `target`. Kept where the game keeps it (one player's deaths, kills, ore or gas): read
   * a bit at a time from the top, where it is — a masked condition each — entered at the highest group of eight bits
   * it has, so that a number below 65 536 is read in 16 bits (eudplib's `f_dwread_epd` reads 32). Otherwise the
   * condition asked a bit at a time from the top, its amount a place of what is found so far plus the bit, so each
   * bit is one trigger whose condition holds when the bit is set (12 bits for a count of units, which never reaches
   * 4 096; 4 for the opponents; 32 otherwise, as the Python side's).
   */
  readGame(target: string, rec: ConditionRecord, at?: At, shift = 0): void {
    emitterCounts.reads++;
    const key = `${this.key}.rg${this.n++}`;
    const table = tableOf(rec, this.scope.owner);
    if (table !== undefined) {
      const out = `${key}.o`, d: Dword = { game: table.at }, whole = table.mask === U32 - 1;
      // A cell of the deaths table whose number is a player group's (12 to 26: Player 2's Ghosts, Player 1's Vultures)
      // cannot be named by its EPD — the game reads the group's cell for that player field — so it is asked as the
      // game's own Deaths condition of that player and unit, the mask in its record (step 13; found by its probe).
      const index = rec.type === DEATHS_TYPE && table.at >= DEATHS_TABLE && table.at < DEATHS_TABLE + 4 * 12 * 228 ? (table.at - DEATHS_TABLE) / 4 : -1;
      const byRecord = index >= 12 && index <= LAST_GROUP;
      const cond = (compare: Compare, value: number, mask?: number): Cond => (byRecord
        ? { dword: { game: 0 }, compare, value, game: { ...rec, player: index % 12, unitId: Math.floor(index / 12), comparison: compare === "atLeast" ? 0 : 1, amount: value, location: mask ?? 0, mask: mask === undefined ? 0 : MASKED_MARK } }
        : { dword: d, compare, value, ...(mask === undefined ? {} : { mask }) });
      this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
      // (The bits of the mask from the top, each moved down `shift`; entered at the highest group of eight from the
      // lowest that has a bit set: below 2^8, 2^16, 2^24 of the field — the masked dword at most that — from its bit 7,
      // 15 or 23.)
      const bits = Array.from({ length: 32 }, (_, b) => 31 - b).filter((b) => table.mask & 2 ** b);
      const lo = bits[bits.length - 1], cuts = [8, 16, 24].map((g) => lo + g).filter((c) => c <= bits[0]);
      const starts = new Map(cuts.map((c) => [c - 1, this.label("rgfrom")]));
      for (const c of cuts) this.branch([cond("atMost", u(2 ** c - 2 ** lo), whole ? undefined : table.mask)], starts.get(c - 1)!, at);
      for (const b of bits) {
        if (starts.has(b)) this.land(starts.get(b)!);
        this.push({ conds: [cond("atLeast", 1, u(2 ** b))], items: [{ act: { dword: { temp: out }, modifier: "add", value: u(2 ** (b - shift)) } }], at });
      }
      this.open().items.push({ fill: { temp: out, target } });
      return;
    }
    const bits = rec.type === 2 || rec.type === 3 ? 12 : rec.type === OPPONENTS_TYPE ? 4 : 32;
    const found = `${key}.f`;
    this.own.add(found);
    this.write(found, { c: 0, terms: [] }, false);
    for (let b = bits - 1; b >= 0; b--) {
      const c = gameCond({ ...rec, comparison: 0, amount: 0 });
      this.condReads.set(c, { id: found, scale: 1, add: u(2 ** b) });
      this.push({ conds: [c], items: [{ bump: { target: found, add: u(2 ** b) } }], at });
    }
    this.write(target, { c: 0, terms: [{ id: found, k: 1 }] });
  }

  /**
   * The dword at a value's EPD (a map of our own, `compiler/backend/texts.ts`), or its bits of the record's mask, into
   * `target`, each moved down `shift`: a trigger a bit, from the top, each condition's player field a place of the
   * value; entered, as `readGame` enters a table's, at the highest group of eight the masked dword reaches.
   */
  readAt(target: string, rec: ConditionRecord, epd: Linear, at?: At, shift = 0): void {
    emitterCounts.reads++;
    const key = `${this.key}.ra${this.n++}`;
    const mask = rec.mask ? rec.location >>> 0 : U32 - 1, whole = mask === U32 - 1;
    const out = `${key}.o`, d: Dword = { game: 0 };
    const placed = (c: Cond): Cond => {
      if (epd.terms.length) this.condPlayers.set(c, { id: epd.terms[0].id, scale: epd.terms[0].k, add: u(epd.c) });
      else c.dword = { game: u(DEATHS_TABLE + 4 * epd.c) };
      return c;
    };
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    const bits = Array.from({ length: 32 }, (_, b) => 31 - b).filter((b) => mask & 2 ** b);
    const lo = bits[bits.length - 1], cuts = [8, 16, 24].map((g) => lo + g).filter((c) => c <= bits[0]);
    const starts = new Map(cuts.map((c) => [c - 1, this.label("rafrom")]));
    for (const c of cuts) this.branch([placed({ dword: d, compare: "atMost", value: u(2 ** c - 2 ** lo), ...(whole ? {} : { mask }) })], starts.get(c - 1)!, at);
    for (const b of bits) {
      if (starts.has(b)) this.land(starts.get(b)!);
      // (A bit moved past the top is lost, as a product's is.)
      if (b - shift > 31) continue;
      this.push({ conds: [placed({ dword: d, compare: "atLeast", value: 1, mask: u(2 ** b) })], items: [{ act: { dword: { temp: out }, modifier: "add", value: u(2 ** (b - shift)) } }], at });
    }
    this.open().items.push({ fill: { temp: out, target } });
  }

  /** After an action that makes or moves units, in a program that asks Bring or Command: the counts thrown away. */
  forgets(r: ActionRecord): Item[] {
    return MOVES_UNITS.has(r.type) && this.scope.counts ? [{ act: { dword: { game: 0 }, modifier: "set", value: 0, record: FORGET_COUNTS } }] : [];
  }

  setBool(target: string, cond: BoolExpr): void {
    const no = this.label("bno"), done = this.label("bdone");
    this.jump(cond, false, no, this.at);
    this.write(target, { c: 1, terms: [] });
    this.goto(done);
    this.land(no);
    this.write(target, { c: 0, terms: [] });
    this.land(done);
  }

  /**
   * A call (a map of our own). The arguments are written into the function's parameters — into every place each has
   * in the function's triggers, as any write is — in order; the rewriter has already taken into variables of its own
   * any value a later argument's call could change. A called function: the trigger with the arguments also sets the
   * next pointer of the trigger the function ends at to here, and goes to the function's first; back here, the
   * function's result is copied into the call's own. An inlined call: its body where it stands, its result 0 until a
   * `return` writes it (as the Python side has it).
   */
  call(c: Call): void {
    if (!c.saves) this.arguments(c);
    if (c.fn !== undefined) {
      const f = this.scope.functions.get(c.fn)!;
      let fn = this.fns.get(c.fn);
      if (!fn) {
        this.fns.set(c.fn, (fn = { entry: this.label("fn"), exit: this.label("fx"), depth: 0 }));
        this.pending.push(c.fn);
      }
      fn.depth = Math.max(fn.depth, this.depthBase + this.loops.length);
      const back = this.label("back");
      // An error out of a function that never comes back into itself goes on from a trigger of the function's own,
      // whose next pointer the call points at where the error goes from here: nothing is looked at on the way back.
      // After a call of one that may come back, and after a call that keeps a frame — which takes it back first — the
      // error in flight is looked at.
      const throws = this.mayThrow(c.fn), routed = throws && !f.recursive;
      if (routed && !fn.thrown) fn.thrown = this.label("fthrow");
      // (A function that calls itself also keeps where it goes back to in a variable, which a frame keeps: the frame
      // of a call that may come back is the function's the call is in.)
      const ra = f.recursive ? this.returnOf(c.fn, fn.exit) : null;
      const within = c.saves && this.current !== undefined ? this.fns.get(this.current) : undefined;
      if (c.saves && !within) throw new Error(`emitter: a call of ${f.name} that keeps a frame, outside a function`);
      const kept = c.saves ? this.keep(c, this.returnOf(this.current!, within!.exit)) : null;
      if (kept) this.arguments(c);
      const items = this.open().items;
      items.push(ra ? { label: { target: ra, to: back } } : { act: { dword: nextOf(fn.exit), modifier: "set", value: { label: back } } });
      if (routed) {
        const to = kept ? back : this.handler(), item: Item = { act: { dword: nextOf(fn.thrown!), modifier: "set", value: { label: to } } };
        items.push(item);
        let sets = this.thrownSets.get(c.fn);
        if (!sets) this.thrownSets.set(c.fn, (sets = []));
        sets.push({ items, item, to });
      }
      this.goto(fn.entry);
      this.land(back);
      if (kept) this.bringBack(kept);
      if (throws && (!routed || kept)) this.jump(this.inFlight(), true, this.handler(), this.at);
      if (c.result && f.result) {
        // What the function gives back goes into its cell alone, and each call reads it from there: as places, a
        // return would write every call's, and each of those actions would be a place of what the return reads —
        // the parameters, then what every call passes them — so places would multiply from call to call.
        this.results.add(f.result.decl.id);
        this.write(c.result.decl.id, { c: 0, terms: [{ id: f.result.decl.id, k: 1 }] });
      }
      return;
    }
    const end = this.label("iend");
    if (c.result) this.write(c.result.decl.id, { c: 0, terms: [] });
    this.frames.push({ ...(c.result ? { result: { id: c.result.decl.id, kind: c.result.kind } } : {}), end });
    this.stmts(c.body);
    this.frames.pop();
    this.land(end);
  }

  /**
   * The arguments into the parameters, in order. A call that may come back into the function it is in sets that
   * function's own parameters, which a later argument may read: then every argument goes into a variable of the
   * emitter's own first.
   */
  arguments(c: Call): void {
    const set = (id: string, kind: string, value: NumExpr | BoolExpr) => (kind === "boolean" ? this.setBool(id, value as BoolExpr) : this.write(id, linear(value as NumExpr)!));
    const params = new Set(c.params.map((p) => p.decl.id));
    const crossed = c.params.some((p, i) => i > 0 && [...readIn(p.init as NumExpr | BoolExpr)].some((id) => params.has(id) && c.params.findIndex((q) => q.decl.id === id) < i));
    if (!crossed) {
      for (const p of c.params) set(p.decl.id, p.decl.kind, p.init as NumExpr | BoolExpr);
      return;
    }
    const temps = c.params.map((p) => {
      const t = `${this.key}.arg${this.n++}`;
      this.own.add(t);
      set(t, p.decl.kind, p.init as NumExpr | BoolExpr);
      return t;
    });
    c.params.forEach((p, i) => this.write(p.decl.id, { c: 0, terms: [{ id: temps[i], k: 1 }] }));
  }

  /**
   * Where a function that calls itself goes back to, as a variable whose places are the next pointer of the trigger
   * the function ends at and the number of each store that keeps it on the stack: every call of the function sets
   * them all to where it goes on (a label), and after a call that may come back a cell of the stack puts them back.
   */
  returnOf(fn: string, exit: string): string {
    const ra = `${fn}.(goes back to)`;
    if (!this.places.has(ra)) this.placesOf(ra).push({ dword: nextOf(exit), scale: 1, add: 0 });
    return ra;
  }

  /**
   * Before a call that may come back into the function it is in (a map of our own): too deep, the program says so and
   * stops for good, as the Python side's build does; otherwise the function's variables and where it goes back to
   * onto the stack — one trigger, a Set Deaths each, its destination a place of `sp`, its number a place of what it
   * keeps — and `sp` and `depth` on.
   */
  keep(c: Call, ra: string): { vars: string[]; stack: { id: string; sp: string } } {
    // (Only what is read again before it is written: `saves` lists every variable of the function.)
    const live = this.live.get(c);
    if (!live) throw new Error(`emitter: a call of ${c.name ?? "a function"} that keeps a frame, not looked at`);
    const vars = [...c.saves!.vars.filter((id) => live.has(id)), ra];
    const stack = this.stackOf(this.current!);
    stack.frame = Math.max(stack.frame, vars.length);
    this.own.add(this.depth);
    const room = this.label("room");
    this.jump({ kind: "compare", op: "<", left: { kind: "var", id: this.depth }, right: { kind: "const", value: this.stackDepth }, unsigned: true, at: this.at!, label: "" }, true, room, this.at);
    const line = this.at?.line ?? "?";
    if (this.scope.errors) {
      // A program that keeps errors throws a RangeError, as JavaScript does: where the call is, before anything of it
      // is kept.
      this.call({ fn: OVERFLOW_FN, name: "(stack overflow)", params: [], body: [], at: this.at!, label: "" });
      this.write(errorLine(this.scope.errors), { c: this.at?.line ?? 0, terms: [] });
      this.goto(this.handler());
    } else {
      this.open().items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, display: `\x06TrigScript: stack overflow in ${c.saves!.within}, line ${line} - ${this.stackDepth} calls deep. The program has stopped.` } });
      this.co.end();
    }
    this.land(room);
    // (Each variable through one of the emitter's own, written just before: a store's number is a place no refresh
    // reaches, and the variable itself may have to be read from its cell where it is used.)
    const kept = vars.map((id) => (id === ra ? id : this.pin({ c: 0, terms: [{ id, k: 1 }] }, "kv")));
    const store = this.push({ conds: [], items: [] });
    kept.forEach((id, j) => {
      const act: Act = { dword: { element: stack.id }, modifier: "set", value: 0 };
      this.actPlaces.set(act, { dest: { id: stack.sp, scale: 18, add: 18 * j, base: stack.id }, value: { id, scale: 1, add: 0 } });
      store.items.push({ act });
    });
    // (A trigger of its own after it: an action's place is its index in its trigger, which the writes of `sp` would
    // push past 64.)
    this.push({ conds: [], items: [] });
    this.write(stack.sp, { c: vars.length, terms: [{ id: stack.sp, k: 1 }] }, false);
    this.write(this.depth, { c: 1, terms: [{ id: this.depth, k: 1 }] }, false);
    return { vars, stack };
  }

  /**
   * After it: `sp` and `depth` back, and each cell of the frame into a scratch cell — a trigger that sets the scratch
   * cell to 0, points the stack cell's action at it and its next pointer back here, and goes to it (its own next
   * pointer a place of `sp`) — and the scratch cell into every place of the variable.
   */
  bringBack(kept: { vars: string[]; stack: { id: string; sp: string } }): void {
    const { id: stack, sp } = kept.stack;
    this.write(sp, { c: u(-kept.vars.length), terms: [{ id: sp, k: 1 }] }, false);
    this.write(this.depth, { c: MAX, terms: [{ id: this.depth, k: 1 }] }, false);
    kept.vars.forEach((id, j) => {
      const temp = `${this.key}.st${this.n++}`, after = this.label("got"), jump = this.label("pop");
      const point: Act = { dword: { element: stack }, modifier: "set", value: { epd: { temp } } };
      const back: Act = { dword: { element: stack }, modifier: "set", value: { label: after } };
      this.actPlaces.set(point, { dest: { id: sp, scale: 18, add: 18 * j - 1, base: stack } });
      this.actPlaces.set(back, { dest: { id: sp, scale: 18, add: 18 * j - 86, base: stack } });
      this.push({ label: jump, conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }, { act: point }, { act: back }], next: after, keep: true });
      this.jumpReads.set(jump, { id: sp, scale: 72, add: 72 * j, base: `addr:${stack}` });
      this.land(after);
      this.open().items.push({ fill: { temp, target: id } });
    });
  }

  /**
   * The routine that writes a number as digits (a map of our own), called by each print with a number in it: where
   * its two ways in are (a signed number, a `u32`), the trigger it ends at (its next pointer the call's), the variable
   * the number is handed in, and the three dwords it writes the digits into — 12 bytes, the number at their right end,
   * 0x0D (which draws nothing) before it — which the print then copies into its text.
   */
  itoa?: { signed: string; unsigned: string; exit: string; v: string; r: string; neg: string; out: string[] };
  /** The printed texts' templates (`Graph.templates`). */
  templates: { id: string; bytes: number[]; at?: number; data?: boolean }[] = [];

  /**
   * A text printed with values in it (a map of our own). Its template is laid out when the map is built: the text,
   * and for each number a field on a dword's start — 12 bytes, or 4 or 8 when the value ranges know the number never
   * takes more characters than that (`fieldWords`) — the bytes before it to the dword's start 0x0D (they draw nothing);
   * for each byte from a number (a colour code), one byte. Nothing in the text moves, however wide the number is: the
   * routine writes the number at the right end of its three dwords, 0x0D before it, and the print copies the last of
   * them into the field. A print hands each number to the routine, writes each byte where it goes (0x0D for a 0, which
   * writes nothing), and shows the template with Display Text. (The rewriter has already put the values in the order
   * JavaScript works them out.) The game's text line holds 218 bytes: a line of many numbers with 12-byte fields was cut
   * short in the lifted game (step 17's `game-lowering` probe, 24 one-digit numbers).
   */
  /**
   * A print at the centre of the screen, as eudplib's `f_eprintln`: for each player it is for, with that player the
   * current player — the game's error "Cannot create more units" raised (Create Unit for the current player with the
   * game's first free unit taken away, then put back: the line of errors shown at the centre), and on that player's
   * own computer alone the text written into that line (the template is the line itself: `template`'s `at`).
   */
  centre(s: Extract<Stmt, { kind: "print" }>): void {
    const players = playersOf(s.to, this.scope.owner, this.scope.players)!, owner = this.scope.owner ?? 0;
    const current = (p: number): Item => ({ act: { dword: { game: CURRENT_PLAYER_ADDRESS }, modifier: "set", value: p } });
    for (const p of players) {
      if (p !== owner) this.open().items.push(current(p));
      // The error raised: the first free unit read, taken away for the Create Unit, put back.
      const free = `${this.key}.free${this.n++}`;
      this.own.add(free);
      this.readGame(free, { location: 0, player: u((FIRST_FREE_UNIT - DEATHS_TABLE) / 4), amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: 0 }, s.at);
      const back: Act = { dword: { game: FIRST_FREE_UNIT }, modifier: "set", value: 0 };
      this.actPlaces.set(back, { value: { id: free, scale: 1, add: 0 } });
      const create: ActionRecord = { location: 64, text: 0, wav: 0, time: 0, player: CURRENT_PLAYER, target: 0, unitId: 0, type: 44, modifier: 1, flags: 0x10, padding: 0, mask: 0 };
      this.push({ conds: [], items: [{ act: { dword: { game: FIRST_FREE_UNIT }, modifier: "set", value: 0 } }, { act: { dword: { game: 0 }, modifier: "set", value: 0, record: create } }, { act: back }], at: s.at });
      // The text into the line, on that player's computer alone.
      const here = this.label("centre"), past = this.label("centred");
      this.branch([{ dword: { game: LOCAL_PLAYER }, compare: "exactly", value: p }], here, s.at);
      this.goto(past);
      this.land(here);
      this.template(s.parts, CENTRE_LINE);
      this.land(past);
    }
    if (players.some((p) => p !== owner)) this.open().items.push(current(owner));
  }

  print(s: Extract<Stmt, { kind: "print" }>): void {
    if (s.position === "center") return this.centre(s);
    const known = s.parts.every((p) => p.kind === "text");
    const show: Act = known
      ? { dword: { game: 0 }, modifier: "set", value: 0, display: s.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") }
      : { dword: { game: 0 }, modifier: "set", value: 0, show: this.template(s.parts) };
    // (For others than the owner: Display Text with each of them the current player in turn — it shows on the computer
    // of the player who is, and of nobody when nobody plays that slot — then the owner again.)
    const players = playersOf(s.to, this.scope.owner, this.scope.players)!;
    const owner = this.scope.owner ?? 0;
    const current = (p: number): Item => ({ act: { dword: { game: CURRENT_PLAYER_ADDRESS }, modifier: "set", value: p } });
    this.open().items.push(...(players.length === 1 && players[0] === owner ? [{ act: show }] : [...players.flatMap((p) => [current(p), { act: { ...show } }]), current(owner)]));
  }

  /**
   * A text with values in it written into a template of its own (`Graph.templates`), each value as it is now: its id.
   * `at`: the template is the game's memory there (the line of a print at the centre), its bytes written first.
   */
  /** A block of `bytes` zeros — or holding `text`, then zeros — among the templates, once (`textBlock`, `showText`). */
  block(id: string, bytes: number, text?: string, data?: boolean): void {
    if (this.templates.some((t) => t.id === id)) return;
    const content = text ? [...new TextEncoder().encode(text)] : [];
    this.templates.push({ id, bytes: [...content, ...Array(Math.max(1, 4 * Math.ceil(bytes / 4) - content.length)).fill(0)], ...(data ? { data: true } : {}) });
  }

  template(parts: TextPart[], at?: number): string {
    const id = `${this.key}.text${this.n++}`;
    const bytes: number[] = [];
    const enc = new TextEncoder();
    const values: { part: TextPart; at: number }[] = [];
    const fixedAt = new Map<TextPart, { sign: number; frac: number }>();
    for (const p of parts) {
      if (p.kind === "text") bytes.push(...enc.encode(p.text));
      else if (p.kind === "number" && p.fixed) {
        // A number with a fraction: its sign's byte, its whole part's field, and eight bytes for the point and four places.
        const sign = bytes.length;
        bytes.push(PAD);
        while (bytes.length % 4) bytes.push(PAD);
        values.push({ part: p, at: bytes.length });
        bytes.push(...Array(12).fill(PAD));
        fixedAt.set(p, { sign, frac: bytes.length });
        bytes.push(...Array(8).fill(PAD));
      } else if (p.kind === "number") {
        while (bytes.length % 4) bytes.push(PAD);
        values.push({ part: p, at: bytes.length });
        bytes.push(...Array(4 * fieldWords(p)).fill(PAD));
      } else if (p.kind === "char") {
        values.push({ part: p, at: bytes.length });
        bytes.push(PAD);
      } else if (p.kind === "pick") {
        // A field as long as its longest text, on dwords of its own, each case's text written whole into it.
        while (bytes.length % 4) bytes.push(PAD);
        values.push({ part: p, at: bytes.length });
        const most = Math.max(0, ...p.cases.map((c) => enc.encode(c.text).length));
        bytes.push(...Array(4 * Math.ceil(most / 4)).fill(PAD));
      }
    }
    bytes.push(0);
    this.templates.push({ id, bytes, ...(at !== undefined ? { at } : {}) });
    if (at !== undefined) {
      // (Every dword of it as built, the fields' padding too, before the values are written into their fields.)
      const words: Item[] = [];
      for (let w = 0; 4 * w < bytes.length; w++) words.push({ act: { dword: { template: id, word: w }, modifier: "set", value: [0, 1, 2, 3].reduce((n, k) => n + (bytes[4 * w + k] ?? 0) * 2 ** (8 * k), 0) } });
      for (let i = 0; i < words.length; i += MOST_ACTS) this.push({ conds: [], items: words.slice(i, i + MOST_ACTS) });
    }
    for (const { part, at } of values) {
      if (part.kind === "number") {
        const it = this.digits();
        const f = fixedAt.get(part);
        if (f) this.write(it.v, { c: 0, terms: [{ id: this.fixedParts(id, linear(part.expr)!, f.sign, f.frac), k: 1 }] }, false);
        else this.write(it.v, linear(part.expr)!, false);
        const back = this.label("printed");
        this.open().items.push({ act: { dword: nextOf(it.exit), modifier: "set", value: { label: back } } });
        this.goto(part.unsigned || f ? it.unsigned : it.signed);
        this.land(back);
        // (The routine's last dwords into the field: the number is at their right end.)
        const words = f ? 3 : fieldWords(part);
        it.out.slice(3 - words).forEach((from, w) => this.open().items.push({ route: { from, into: [{ template: id, word: at / 4 + w }] } }));
        continue;
      }
      if (part.kind === "pick") {
        // For each case, a test of it and then its text's dwords, the field's padding after it, set.
        const size = 4 * Math.ceil(Math.max(0, ...part.cases.map((c) => enc.encode(c.text).length)) / 4);
        for (const c of part.cases) {
          const text = [...enc.encode(c.text)];
          while (text.length < size) text.push(PAD);
          const words: Item[] = [];
          for (let w = 0; 4 * w < size; w++) words.push({ act: { dword: { template: id, word: at / 4 + w }, modifier: "set", value: text.slice(4 * w, 4 * w + 4).reduce((n, b, j) => n + b * 2 ** (8 * j), 0) } });
          const past = this.label("picked");
          const is: BoolExpr = c.upTo
            ? { kind: "and", items: [{ kind: "compare", op: ">=", left: part.by, right: c.when, at: this.at!, label: "" }, { kind: "compare", op: "<=", left: part.by, right: c.upTo, at: this.at!, label: "" }] }
            : { kind: "compare", op: "==", left: part.by, right: c.when, at: this.at!, label: "" };
          this.jump(is, false, past, this.at);
          for (let i = 0; i < words.length; i += MOST_ACTS) this.push({ conds: [], items: words.slice(i, i + MOST_ACTS) });
          this.land(past);
        }
        continue;
      }
      if (part.kind !== "char") continue;
      // The byte: the number's low eight bits into its place in the dword (a mask), a place of the number; 0x0D when
      // they are 0.
      const word: Dword = { template: id, word: at >> 2 }, shift = 2 ** (8 * (at & 3)), mask = u(0xff * shift);
      const from = this.alone(linear(part.expr)!, "ch");
      const set: Act = { dword: word, modifier: "set", value: 0, mask };
      this.actPlaces.set(set, { value: { id: from, scale: shift, add: 0 } });
      this.push({ conds: [], items: [{ act: set }] });
      this.push({ conds: [{ dword: word, compare: "exactly", value: 0, mask }], items: [{ act: { dword: word, modifier: "set", value: u(PAD * shift), mask } }] });
    }
    return id;
  }

  /**
   * A number with a fraction printed, as the simulator's `fixedText`: its magnitude's whole part (into a variable of
   * the emitter's own, which the digits routine writes into the field before), the four places below the point rounded
   * half up — the low sixteen bits times 10 000 and 32 768 over 65 536, a constant added a bit as a product by a constant
   * is (`fixedByConst`), 10 000 carried into the whole part — and the minus sign when the number is below zero and not
   * shown as 0. The places go into the eight bytes after the field as '.' and four digits, a trigger each for 8, 4, 2
   * and 1 times a digit's power of ten; the zeros at their end, and the point when there is nothing after it, 0x0D,
   * which draws nothing. Returns the whole part's variable.
   */
  fixedParts(id: string, value: Linear, signAt: number, fracAt: number): string {
    emitterCounts.fixed++;
    const key = `${this.key}.pf${this.n++}`, m = `${key}.m`, low = `${key}.l`, neg = `${key}.neg`, whole = `${key}.w`, places = `${key}.p`;
    this.own.add(whole);
    this.own.add(places);
    const at = this.at, from = this.beginFed(at);
    const byteOf = (b: number) => ({ dword: { template: id, word: b >> 2 } as Dword, shift: 2 ** (8 * (b & 3)) });
    // |v|, and whether it was below zero.
    this.push({ conds: [], items: [{ act: { dword: { temp: neg }, modifier: "set", value: 0 } }, { act: { dword: { temp: low }, modifier: "set", value: 32768 } }], at });
    this.bySign(m, this.multiple(value, "pv"), true, (minus) => {
      if (minus) this.open().items.push({ act: { dword: { temp: neg }, modifier: "set", value: 1 } });
    }, at);
    this.write(whole, { c: 0, terms: [] }, false);
    this.write(places, { c: 0, terms: [] }, false);
    for (let j = 31; j >= 16; j--) this.push({ conds: [{ dword: { temp: m }, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: [{ bump: { target: whole, add: 2 ** (j - 16) } }], at });
    for (let j = 15; j >= 0; j--) {
      const hi = Math.floor((10000 * 2 ** j) / 65536), lo = (10000 * 2 ** j) % 65536;
      this.push({ conds: [{ dword: { temp: m }, compare: "atLeast", value: 1, mask: 2 ** j }], items: [...(hi ? [{ bump: { target: places, add: hi } } as Item] : []), { act: { dword: { temp: low }, modifier: "add", value: lo } }], at });
    }
    for (let k = 20; k >= 16; k--) this.push({ conds: [{ dword: { temp: low }, compare: "atLeast", value: 1, mask: 2 ** k }], items: [{ bump: { target: places, add: 2 ** (k - 16) } }], at });
    this.push({ conds: [{ dword: this.home(places, 0), compare: "exactly", value: 10000 }], items: [{ bump: { target: whole, add: 1 } }, { bump: { target: places, add: u(-10000) } }], at });
    // The sign's byte: '-' below zero, unless what is shown is 0.
    const sign = byteOf(signAt), smask = u(0xff * sign.shift);
    this.push({ conds: [], items: [{ act: { dword: sign.dword, modifier: "set", value: u(PAD * sign.shift), mask: smask } }], at });
    for (const shown of [whole, places]) this.push({ conds: [{ dword: { temp: neg }, compare: "exactly", value: 1 }, { dword: this.home(shown, 0), compare: "atLeast", value: 1 }], items: [{ act: { dword: sign.dword, modifier: "set", value: u(0x2d * sign.shift), mask: smask } }], at });
    // The point and the places, or nothing.
    const [f0, f1] = [{ template: id, word: fracAt >> 2 } as Dword, { template: id, word: (fracAt >> 2) + 1 } as Dword];
    const none = this.label("pfnone"), done = this.label("pfdone");
    this.push({ conds: [], items: [{ act: { dword: f0, modifier: "set", value: PAD * 0x01010101 } }, { act: { dword: f1, modifier: "set", value: PAD * 0x01010101 } }], at });
    this.branch([{ dword: this.home(places, 0), compare: "exactly", value: 0 }], none, at);
    // ('.', then '0' for each place: d3 d2 d1 in the first dword after the point, d0 in the second.)
    this.push({ conds: [], items: [{ act: { dword: f0, modifier: "set", value: 0x2e + 0x30 * 0x100 + 0x30 * 0x10000 + 0x30 * 0x1000000 } }, { act: { dword: f1, modifier: "set", value: 0x30 + PAD * 0x010101 * 0x100 } }], at });
    const digit = (p: number) => (p === 0 ? { dword: f1, shift: 1 } : { dword: f0, shift: 2 ** (8 * (4 - p)) });
    for (let p = 3; p >= 0; p--) for (const k of [8, 4, 2, 1]) {
      const step = k * 10 ** p;
      if (step > 9999) continue;
      const d = digit(p);
      this.push({ conds: [{ dword: this.home(places, 0), compare: "atLeast", value: step }], items: [{ bump: { target: places, add: u(-step) } }, { act: { dword: d.dword, modifier: "add", value: k * d.shift } }], at });
    }
    // Zeros at the end, from the last place back: each one nothing when the one after it is.
    for (let p = 0; p <= 2; p++) {
      const d = digit(p), mask = u(0xff * d.shift), after = p === 0 ? [] : [{ dword: digit(p - 1).dword, compare: "exactly", value: u(PAD * digit(p - 1).shift), mask: u(0xff * digit(p - 1).shift) } as Cond];
      this.push({ conds: [...after, { dword: d.dword, compare: "exactly", value: u(0x30 * d.shift), mask }], items: [{ act: { dword: d.dword, modifier: "set", value: u(PAD * d.shift), mask } }], at });
    }
    this.goto(done);
    this.land(none);
    this.land(done);
    this.routeFed(from);
    return whole;
  }

  /** The routine that writes a number as digits: its labels and variables, made the first time a print needs it. */
  digits(): NonNullable<Emitter["itoa"]> {
    if (!this.itoa) {
      const v = (name: string) => `${this.key}.(digits ${name})`;
      this.itoa = { signed: this.label("itoa"), unsigned: this.label("itoau"), exit: this.label("itoax"), v: v("of"), r: v("left"), neg: v("minus"), out: [v("0"), v("1"), v("2")] };
      this.own.add(this.itoa.r);
      this.own.add(this.itoa.neg);
    }
    return this.itoa;
  }

  /**
   * The routine, laid out once after the program and its functions. The three dwords set to 0x0D all through; the
   * number's size into `left` (a signed one's sign apart); how many digits it has, by comparisons with powers of ten
   * (four at most); then, from that many digits down, each digit's '0' (its byte from 0x0D up to 0x30, all in the
   * trigger the comparisons go to, with the minus sign before the first digit when there is one) and its value: a
   * trigger each for 8, 4, 2 and 1 times the digit's power of ten, which takes it from `left` and adds it to the
   * digit's byte when `left` holds that much. About four triggers a digit; eudplib's build divides by ten for each.
   */
  emitDigits(): void {
    const it = this.itoa;
    if (!it) return;
    const set = (id: string, c: number, terms: { id: string; k: number }[] = []) => this.write(id, { c: u(c), terms }, false);
    this.land(it.signed);
    set(it.neg, 0);
    set(it.r, 0, [{ id: it.v, k: 1 }]);
    const go = this.label("itoago");
    this.jump({ kind: "compare", op: "<", left: { kind: "var", id: it.v }, right: { kind: "const", value: 0 }, at: this.at!, label: "" } as BoolExpr, false, go);
    set(it.r, 0, [{ id: it.v, k: MAX }]);
    set(it.neg, 1);
    this.goto(go);
    this.land(it.unsigned);
    set(it.neg, 0);
    set(it.r, 0, [{ id: it.v, k: 1 }]);
    this.land(go);
    for (const w of it.out) set(w, PAD * 0x01010101);
    // How many digits: k when `left` is at least 10^(k-1).
    const width = Array.from({ length: 11 }, (_, k) => this.label(`itoak${k}`));
    const tree = (lo: number, hi: number): void => {
      if (lo === hi) return this.goto(width[lo]);
      const mid = (lo + hi + 1) >> 1, high = this.label("itoahi");
      this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: it.r }, right: { kind: "const", value: 10 ** (mid - 1) }, unsigned: true, at: this.at!, label: "" } as BoolExpr, true, high);
      tree(lo, mid - 1);
      this.land(high);
      tree(mid, hi);
    };
    tree(1, 10);
    // The byte of digit p (of 10^p) is 11 - p: the dword (11 - p) >> 2, its byte (11 - p) & 3.
    const at = (b: number) => ({ word: b >> 2, shift: 2 ** (8 * (b & 3)) });
    const ladder = Array.from({ length: 10 }, (_, p) => this.label(`itoap${p}`));
    for (let k = 10; k >= 1; k--) {
      this.land(width[k]);
      const zeros = [0, 0, 0];
      for (let p = 0; p < k; p++) zeros[at(11 - p).word] += (0x30 - PAD) * at(11 - p).shift;
      zeros.forEach((add, w) => { if (add) this.open().items.push({ bump: { target: it.out[w], add: u(add) } }); });
      const sign = at(11 - k);
      this.push({ conds: [{ dword: this.home(it.neg, 0), compare: "atLeast", value: 1 }], items: [{ bump: { target: it.out[sign.word], add: u((0x2d - PAD) * sign.shift) } }] });
      this.goto(ladder[k - 1]);
    }
    for (let p = 9; p >= 0; p--) {
      this.land(ladder[p]);
      const { word, shift } = at(11 - p);
      for (const m of [8, 4, 2, 1]) {
        const step = m * 10 ** p;
        if (step >= U32) continue;
        this.push({ conds: [{ dword: this.home(it.r, 0), compare: "atLeast", value: step }], items: [{ bump: { target: it.r, add: u(-step) } }, { bump: { target: it.out[word], add: m * shift } }] });
      }
    }
    this.push({ label: it.exit, conds: [], items: [], keep: true });
  }

  /** A `return`: the value into the result of the function or inlined call around it, and on to its end. */
  ret(s: Extract<Stmt, { kind: "return" }>): void {
    const frame = this.frames[this.frames.length - 1];
    // At the top of the program: its end, for good.
    if (!frame) { this.goto(END); return; }
    const r = frame.result;
    if (r && r.kind === "boolean" && s.value !== undefined) this.setBool(r.id, s.value as BoolExpr);
    else if (r) this.write(r.id, s.value === undefined ? { c: 0, terms: [] } : linear(s.value as NumExpr)!);
    this.goto(frame.end);
  }

  // ── coroutines and tasks (a map of our own: TrigScript 4, step 11) ──

  /**
   * A sleep of a coroutine: the frame it wakes at — the map's count of frames now plus these, one copy — and where it
   * goes on, written into its wake; then its turn is given back. Where it goes on puts its wake back as it was, and goes
   * on to `then` when there is one.
   */
  sleepIn(co: Co, frames: number, then?: string): void {
    const resume = this.label("wake");
    this.open().items.push({ route: { from: NOW, into: [co.tick], add: frames } }, { act: { dword: co.at, modifier: "set", value: { label: resume } } });
    this.goto(co.yieldTo);
    this.push({ label: resume, conds: [], items: [{ act: co.reset }], ...(then ? { next: then } : {}) });
  }

  /**
   * The events pass's watch (`units.ts`): a trigger for each of the game's unit places, whose conditions read the
   * place's record where it is against what the trigger saw there last — its own conditions' numbers, 0 for a place
   * never handed out. They are walked from the place the game will hand out next (the entry's next pointer, moved down
   * as places are first handed out) up to place 1 699 and then to place 0: the places the game has handed out, newest
   * first. A place as it was is the one trigger: its conditions hold, and it puts the trigger before it back and goes
   * on to the next. One that changed goes to its stub — the record's EPD into `@ev.e`, the trigger's first condition's
   * number into `@ev.wf`, where to go on into `RET`, the place handed out after it into `NEXT` — and to the handler,
   * laid out once, after which the boundary's check moves the entry down when the place was the one handed out next.
   */
  watch(s: Extract<Stmt, { kind: "watch" }>): void {
    const W = (k: number) => `${this.key}:w${k}`, S = (k: number) => `${this.key}:s${k}`;
    const entry = this.label("ev"), handler = this.label("eh"), back = this.label("er"), exit = this.label("ex"), stays = this.label("eb"), move = this.label("emv");
    // The gate (`s.gate`: no orders or types watched): one trigger before the walk whose conditions hold when nothing
    // can have changed since the watch last ran — the head of the game's list of free places and the place behind it
    // (a place handed out moves one or the other: every unit made pops the head, a place freed goes in behind it), and
    // each player's counts of units and of buildings (taken off as a unit starts to die or is removed). All holding,
    // the walk passes the watch by; otherwise it goes through it, and afterwards the gate's numbers are read again
    // from the game — the head and the place behind it when a unit came on, the counts of each player the handler
    // marked, or every one of them when the gate opened and the handler found nothing (a unit given away, a morph).
    // A number wrong only costs the next frames the watch: the gate holds only when all of them are right.
    const gated = !!s.gate, skip = this.label("egs");
    const G = { head: `${this.key}.egH`, behind: `${this.key}.egQ`, next: `${this.key}.egN`, units: (p: number) => `${this.key}.egU${p}`, buildings: (p: number) => `${this.key}.egB${p}`, failed: `${this.key}.egw` };
    const players = Array.from({ length: GATE_PLAYERS }, (_, p) => p);
    // (The gate in four triggers, each a group of its numbers — the head and the place behind it; the units of players
    // 1 to 6; of 7 to 12; the buildings — so that when the handler finds nothing, the group that failed is read again
    // and no other: a place freed moves the one behind the head, three reads, where every number would be twenty-seven.)
    const groups: { label: string; conds: Cond[]; fields: [string, number, "value" | "player", number][] }[] = gated ? [
      { label: this.label("eg"), conds: [{ dword: { game: FIRST_FREE_UNIT }, compare: "exactly", value: 0 }, { dword: { game: DEATHS_TABLE }, compare: "exactly", value: 0 }], fields: [[G.head, 0, "value", 0], [G.behind, 1, "player", epdOf(4)], [G.next, 1, "value", 0]] },
      ...[players.slice(0, 6), players.slice(6)].map((ps) => ({ label: this.label("eg"), conds: ps.map((p): Cond => ({ dword: { game: UNIT_COUNTS + 4 * p }, compare: "exactly", value: 0 })), fields: ps.map((p, i): [string, number, "value" | "player", number] => [G.units(p), i, "value", 0]) })),
      { label: this.label("eg"), conds: players.map((p): Cond => ({ dword: { game: BUILDING_COUNTS + 4 * p }, compare: "exactly", value: 0 })), fields: players.map((p): [string, number, "value" | "player", number] => [G.buildings(p), p, "value", 0]) },
    ] : [];
    if (gated) {
      this.own.add(G.failed);
      groups.forEach((g, i) => {
        // Its conditions all holding go on to the next group, or past the watch; one failing says which group and goes
        // into the watch.
        const on = i + 1 < groups.length ? groups[i + 1].label : skip;
        if (i) this.land(g.label);
        this.branch(g.conds, on, this.at, i ? g.label + "t" : g.label);
        this.write(G.failed, { c: i + 1, terms: [] });
        this.goto(entry);
        // (The group's numbers as variables of the watch's own, each a place of a condition's field and nothing else.)
        for (const [id, cond, part, add] of g.fields) {
          this.own.add(id);
          this.cellless.add(id);
          this.placesOf(id).push({ dword: { at: i ? g.label + "t" : g.label, field: { cond, part } }, scale: 1, add });
        }
      });
    }
    // (Variables whose places are next pointers and numbers, their cells read by nothing: what a stub sets is the
    // places. Where the handler goes on to, and the place handed out after this one: the numbers of the two actions of
    // `move` that point the walk's start and the handler's way on at it.)
    const RET = `${this.key}.evRet`, NEXT = `${this.key}.evNext`;
    for (const v of [RET, NEXT]) this.own.add(v);
    for (const v of [RET, NEXT, EVENT_FIELDS]) this.cellless.add(v);
    this.placesOf(RET).push({ dword: nextOf(back), scale: 1, add: 0 });
    this.placesOf(NEXT).push({ dword: { at: move, field: { act: 0, part: "value" } }, scale: 1, add: 0 }, { dword: { at: move, field: { act: 1, part: "value" } }, scale: 1, add: 0 });
    // (After place k in the walk: k + 1, then 0 after 1 699, the end after 0; before it, k − 1, and 1 699 before 0.)
    const after = (k: number) => (k === 0 ? exit : k === UNIT_PLACES - 1 ? W(0) : W(k + 1));
    const before = (k: number) => (k === 0 ? UNIT_PLACES - 1 : k - 1);
    // (The place handed out after it: 1 699 after 0, then down; none after 1.)
    const handedNext = (k: number) => (k === 0 ? UNIT_PLACES - 1 : Math.max(1, k - 1));
    const putBack = (k: number): Item => ({ act: { dword: nextOf(W(k)), modifier: "set", value: { label: S(k) } } });
    // (Kept, though empty: their next pointers are written.)
    this.push({ label: entry, conds: [], items: [], next: W(0), keep: true });
    for (let k = 0; k < UNIT_PLACES; k++) {
      const record = UNIT_TABLE_ADDRESS + UNIT_STRIDE * k;
      this.push({ label: W(k), conds: s.fields.map((f): Cond => ({ dword: { game: record + 4 * f.dword }, compare: f.compare, value: 0, ...(f.mask !== undefined ? { mask: f.mask } : {}) })), items: [putBack(before(k)), { act: { dword: nextOf(W(k)), modifier: "set", value: { label: after(k) } } }], next: S(k) });
      const items: Item[] = [putBack(before(k))];
      this.write(EVENT_RECORD, { c: UNIT_TABLE_EPD + (UNIT_STRIDE / 4) * k, terms: [] }, true, items);
      items.push({ pointer: { target: EVENT_FIELDS, to: { at: W(k), field: { cond: 0 } } } }, { label: { target: RET, to: after(k) } }, { label: { target: NEXT, to: W(handedNext(k)) } });
      this.push({ label: S(k), conds: [], items, next: handler });
    }
    this.land(handler);
    this.stmts(s.handler);
    // The place the game hands out next is the boundary (`EVENT_BOUNDARY` its distance from place 0, 0 to begin with):
    // when it is handed out, the walk starts at the next one from now on, and goes on from there now — it was not
    // walked in this frame.
    const record: BoolExpr = { kind: "compare", op: "==", left: { kind: "var", id: EVENT_RECORD }, right: { kind: "binary", op: "+", left: { kind: "var", id: EVENT_BOUNDARY }, right: { kind: "const", value: UNIT_TABLE_EPD }, at: this.at!, label: "" }, at: this.at!, label: "" };
    this.jump(record, false, stays, this.at);
    this.push({ label: move, conds: [], items: [{ act: { dword: nextOf(entry), modifier: "set", value: 0 } }, { act: { dword: nextOf(back), modifier: "set", value: 0 } }] });
    const first = this.label("e0"), moved = this.label("em");
    this.jump({ kind: "compare", op: "==", left: { kind: "var", id: EVENT_RECORD }, right: { kind: "const", value: UNIT_TABLE_EPD }, at: this.at!, label: "" }, true, first, this.at);
    this.write(EVENT_BOUNDARY, { c: u(-UNIT_TABLE_EPD - UNIT_STRIDE / 4), terms: [{ id: EVENT_RECORD, k: 1 }] });
    this.goto(moved);
    this.land(first);
    this.write(EVENT_BOUNDARY, { c: (UNIT_STRIDE / 4) * (UNIT_PLACES - 1), terms: [] });
    this.land(moved);
    this.land(stays);
    this.push({ label: back, conds: [], items: [], next: W(0), keep: true });
    this.push({ label: exit, conds: [], items: [putBack(0)] });
    if (gated) {
      // The gate's numbers read again from the game, as far as this frame's changes reach.
      const WHOLE: ConditionRecord = { location: 0, player: 0, amount: 0, unitId: 0, comparison: 0, type: DEATHS_TYPE, resource: 0, flags: 0, mask: 0 };
      const COUNT: ConditionRecord = { ...WHOLE, location: 0xffff, mask: MASKED_MARK };
      const headAgain = () => {
        this.readAt(G.head, WHOLE, { c: epdOf(FIRST_FREE_UNIT), terms: [] }, this.at);
        // (The head's address over 4, into the player field with the EPD of 4 added: the EPD of its next pointer.)
        this.readAt(G.behind, WHOLE, { c: epdOf(FIRST_FREE_UNIT), terms: [] }, this.at, 2);
        this.readAt(G.next, WHOLE, { c: epdOf(4), terms: [{ id: G.behind, k: 1 }] }, this.at);
      };
      const countsAgain = (p: number) => {
        this.readAt(G.units(p), COUNT, { c: epdOf(UNIT_COUNTS + 4 * p), terms: [] }, this.at);
        this.readAt(G.buildings(p), COUNT, { c: epdOf(BUILDING_COUNTS + 4 * p), terms: [] }, this.at);
      };
      const found = this.label("egf"), rearmed = this.label("egr");
      this.branch([{ dword: { var: EVENT_TOUCHED }, compare: "atLeast", value: 1 }], found, this.at);
      // Nothing found: the group that failed, read again.
      const groupRead: (() => void)[] = [headAgain, () => players.slice(0, 6).forEach((p) => this.readAt(G.units(p), COUNT, { c: epdOf(UNIT_COUNTS + 4 * p), terms: [] }, this.at)), () => players.slice(6).forEach((p) => this.readAt(G.units(p), COUNT, { c: epdOf(UNIT_COUNTS + 4 * p), terms: [] }, this.at)), () => players.forEach((p) => this.readAt(G.buildings(p), COUNT, { c: epdOf(BUILDING_COUNTS + 4 * p), terms: [] }, this.at))];
      groupRead.forEach((read, i) => {
        const yes = this.label("egg"), no = this.label("egn");
        this.branch([{ dword: { var: G.failed }, compare: "exactly", value: i + 1 }], yes, this.at);
        this.goto(no);
        this.land(yes);
        read();
        this.land(no);
      });
      this.goto(rearmed);
      this.land(found);
      const noneMade = this.label("egm");
      this.branch([{ dword: { var: EVENT_MADE_N }, compare: "atMost", value: 0 }], noneMade, this.at);
      headAgain();
      this.land(noneMade);
      for (const p of players) {
        const other = this.label("ego");
        this.branch([{ dword: { var: EVENT_OWNERS }, compare: "atMost", value: 0, mask: 2 ** p }], other, this.at);
        countsAgain(p);
        this.land(other);
      }
      this.land(rearmed);
    }
    this.land(skip);
  }

  /** A trigger of a slot's or a branch's that says whether nothing runs in it (done) or something does. */
  private flags(check: string, on: boolean): Item {
    return { act: { dword: { at: check, field: "flags" }, modifier: "set", value: on ? TRIGGER_ON : TRIGGER_OFF } };
  }

  /**
   * A task into a free slot of its start: the arguments as they are now into the slot's parameters, its generation one
   * more, the number it is known by, and its trigger in the tasks' turn switched on, due now, at the body's start. With
   * every slot running nothing starts: the game says so once, and the number is 0, as the Python side's build does. A
   * start that runs once has one slot, which is free.
   */
  start(s: StartStmt): void {
    const slots = this.scope.slots.get(s)!;
    if (!this.pools.has(s.task)) {
      this.pools.set(s.task, { start: s, slots });
      this.pendingTasks.push(s.task);
    }
    if (this.inTask) this.again = true;
    if (this.scope.once.has(s)) {
      this.arguments(slots[0].call);
      return this.startSlot(s, slots[0], 0);
    }
    // (The arguments into variables of the emitter's own first: the slot is chosen after.)
    const temps = slots[0].call.params.map((p) => {
      const t = `${this.key}.ta${this.n++}`;
      this.own.add(t);
      if (p.decl.kind === "boolean") this.setBool(t, p.init as BoolExpr);
      else this.write(t, linear(p.init as NumExpr)!);
      return t;
    });
    const done = this.label("started"), into = slots.map(() => this.label("slot"));
    slots.forEach((slot, k) => this.branch([{ dword: { at: slot.check, field: "flags" }, compare: "atLeast", value: 8, mask: 8 }], into[k], this.at));
    const said = `${this.key}.said${s.task}`, quiet = this.label("quiet");
    this.own.add(said);
    this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: said }, right: { kind: "const", value: 1 }, unsigned: true, at: this.at!, label: "" }, true, quiet, this.at);
    this.open().items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, display: `\x06TrigScript: ${s.call.name ?? "a task"} did not start, line ${this.at?.line ?? "?"} - all ${slots.length} of this start's tasks are running.` } });
    this.write(said, { c: 1, terms: [] });
    this.land(quiet);
    if (s.handle) this.write(s.handle, { c: 0, terms: [] });
    this.goto(done);
    slots.forEach((slot, k) => {
      this.land(into[k]);
      slot.call.params.forEach((p, j) => (p.decl.kind === "boolean" ? this.setBool(p.decl.id, { kind: "var", id: temps[j] }) : this.write(p.decl.id, { c: 0, terms: [{ id: temps[j], k: 1 }] })));
      this.startSlot(s, slot, k);
      this.goto(done);
    });
    this.land(done);
  }

  private startSlot(s: StartStmt, slot: TaskSlot, k: number): void {
    // Its generation one more, from 1 again past 65 535; the number it is known by from it.
    const past = this.label("gen");
    this.jump({ kind: "compare", op: "<", left: { kind: "var", id: slot.gen }, right: { kind: "const", value: 0xffff }, unsigned: true, at: this.at!, label: "" }, true, past, this.at);
    this.write(slot.gen, { c: 0, terms: [] });
    this.land(past);
    this.write(slot.gen, { c: 1, terms: [{ id: slot.gen, k: 1 }] });
    this.write(slot.handle, { c: k + 256 * s.task, terms: [{ id: slot.gen, k: 65536 }] });
    this.open().items.push(
      { act: { dword: { at: slot.check, field: { cond: 0 } }, modifier: "set", value: 0 } },
      { act: { dword: { at: slot.check, field: { act: 0, part: "value" } }, modifier: "set", value: { label: slot.entry } } },
      this.flags(slot.check, true),
    );
    if (this.inTask) this.write(this.againVar, { c: 1, terms: [] });
    if (s.handle) this.write(s.handle, { c: 0, terms: [{ id: slot.handle, k: 1 }] });
  }

  /** `t.cancel()`: the slot whose task the number names, while that task is in it, switched off — it is not resumed again. */
  cancel(s: Extract<Stmt, { kind: "cancel" }>): void {
    const h = s.task;
    for (const slot of [...this.scope.slots.values()].flat()) {
      const past = this.label("nc");
      this.jump({ kind: "and", items: [{ kind: "compare", op: ">=", left: h, right: { kind: "const", value: 1 }, unsigned: true, at: this.at!, label: "" }, { kind: "compare", op: "==", left: h, right: { kind: "var", id: slot.handle }, at: this.at!, label: "" }] }, false, past, this.at);
      this.open().items.push(this.flags(slot.check, false));
      this.write(slot.handle, { c: 0, terms: [] });
      this.land(past);
    }
  }

  /**
   * `Promise.all` and `Promise.race`: each branch a coroutine of its own, with a trigger that wakes it, all due as the
   * statement is reached, each run in order until it sleeps; then, until all have ended (or one has, a race), the
   * coroutine around sleeps a frame at a time and runs again those still running, in order — as the simulator does. A
   * race goes on from the end of the first branch to end; the others are switched off where they are.
   */
  parallel(s: Extract<Stmt, { kind: "parallel" }>): void {
    const outer = this.co, race = s.mode === "race";
    const checks = s.branches.map(() => this.label("br")), nexts = checks.map((c) => `${c}:after`), entries = checks.map(() => this.label("bre"));
    const dispatch = this.label("disp"), test = this.label("ptest"), after = this.label("pafter");
    const items = this.open().items;
    checks.forEach((c, j) => items.push(
      { act: { dword: { at: c, field: { cond: 0 } }, modifier: "set", value: 0 } },
      { act: { dword: { at: c, field: { act: 0, part: "value" } }, modifier: "set", value: { label: entries[j] } } },
      this.flags(c, true),
    ));
    this.land(dispatch);
    checks.forEach((c, j) => {
      this.push({ label: c, conds: [{ dword: { var: NOW }, compare: "atLeast", value: 0 }], items: [{ act: { dword: nextOf(c), modifier: "set", value: { label: entries[j] } } }], next: nexts[j], off: true });
      this.push({ label: nexts[j], conds: [], items: [], next: j + 1 < checks.length ? checks[j + 1] : test });
    });
    this.land(test);
    if (!race) {
      // (All ended: on at once.)
      const wait = this.label("pwait");
      for (const c of checks) this.branch([{ dword: { at: c, field: "flags" }, compare: "atMost", value: 0, mask: 8 }], wait, this.at);
      this.goto(after);
      this.land(wait);
    }
    this.sleepIn(outer, 1, dispatch);
    s.branches.forEach((b, j) => {
      const reset: Act = { dword: nextOf(checks[j]), modifier: "set", value: { label: nexts[j] } };
      this.push({ label: entries[j], conds: [], items: [{ act: reset }] });
      this.co = { tick: { at: checks[j], field: { cond: 0 } }, at: { at: checks[j], field: { act: 0, part: "value" } }, reset, yieldTo: nexts[j], end: outer.end };
      this.stmts(b);
      this.co = outer;
      this.open().items.push(...(race ? checks : [checks[j]]).map((c) => this.flags(c, false)));
      this.goto(race ? after : nexts[j]);
    });
    this.land(after);
  }

  /**
   * Each start's slots' bodies, laid out once each after the program, as a called function's are: the task's call, its
   * coroutine the slot's — its wake the slot's trigger in the tasks' turn — and at its end the slot switched off and the
   * number it was known by 0.
   */
  tasks(): void {
    for (let task = this.pendingTasks.shift(); task !== undefined; task = this.pendingTasks.shift()) {
      for (const slot of this.pools.get(task)!.slots) {
        const after = `${slot.check}:after`;
        const reset: Act = { dword: nextOf(slot.check), modifier: "set", value: { label: after } };
        const end = () => {
          this.open().items.push(this.flags(slot.check, false));
          this.write(slot.handle, { c: 0, terms: [] });
          this.goto(after);
        };
        const outer = { co: this.co, handlers: this.handlers, cold: this.cold, loops: this.loops, frames: this.frames, current: this.current, depthBase: this.depthBase };
        this.co = { tick: { at: slot.check, field: { cond: 0 } }, at: { at: slot.check, field: { act: 0, part: "value" } }, reset, yieldTo: after, end };
        this.handlers = [];
        this.cold = 0;
        this.loops = [];
        this.frames = [];
        this.current = undefined;
        this.depthBase = 0;
        this.inTask++;
        this.push({ label: slot.entry, conds: [], items: [{ act: reset }] });
        const done = this.label("tend");
        this.frames.push({ end: done });
        this.stmts(slot.call.body);
        this.frames.pop();
        this.land(done);
        end();
        this.inTask--;
        Object.assign(this, outer);
      }
    }
  }

  /**
   * The tasks' turn, after the program's: each start's slots, in the order of the starts' numbers and then of their
   * slots — a slot that is free passed by as done, one asleep a condition that fails, one awake sent into its body — and,
   * when a task can start one, round again while one was started, for it to have its first turn in this frame too.
   * Returns where it starts.
   */
  turnOfTasks(): string | undefined {
    const slots = [...this.pools.values()].sort((a, b) => a.start.task - b.start.task).flatMap((p) => p.slots);
    const round = this.label("again");
    this.push({ label: this.tasksLabel, conds: [], items: [], next: slots.length ? slots[0].check : END });
    slots.forEach((slot, i) => {
      this.push({ label: slot.check, conds: [{ dword: { var: NOW }, compare: "atLeast", value: 0 }], items: [{ act: { dword: nextOf(slot.check), modifier: "set", value: { label: slot.entry } } }], next: `${slot.check}:after`, off: true });
      this.push({ label: `${slot.check}:after`, conds: [], items: [], next: i + 1 < slots.length ? slots[i + 1].check : this.again ? round : END });
    });
    if (this.again) {
      // (A jump is put back where it lands: not at the graph's end, which is no trigger of its own.)
      const more = this.label("more");
      this.land(round);
      this.own.add(this.againVar);
      this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: this.againVar }, right: { kind: "const", value: 1 }, unsigned: true, at: this.at!, label: "" }, true, more, this.at);
      this.goto(END);
      this.land(more);
      this.write(this.againVar, { c: 0, terms: [] });
      this.goto(this.tasksLabel);
    }
    return slots[0]?.check;
  }

  /**
   * Where an error thrown here goes: the `catch` of the nearest `try` around it, or out of the function being laid out
   * — from its trigger for errors (`thrown`), or, for one that may come back into itself, from its end, where the call
   * looks at the error in flight. (A program's body is all inside a `try` of the front end's.)
   */
  handler(): string {
    const h = this.handlers[this.handlers.length - 1];
    if (h !== undefined) return h;
    const fn = this.current !== undefined ? this.fns.get(this.current) : undefined;
    if (!fn) throw new Error("emitter: an error with nothing to go to");
    return fn.thrown ?? fn.exit;
  }

  /** Whether a variable has a cell its reads can be refreshed from where they are (a map of our own: all but a function's arguments). */
  hasCell(id: string): boolean {
    const d = this.placesOf(id)[0].dword;
    return !!d && "var" in d;
  }

  /** Whether an error is in flight: its class's code is not 0. */
  inFlight(): BoolExpr {
    return { kind: "compare", op: ">=", left: { kind: "var", id: this.scope.errors!.thrown }, right: { kind: "const", value: 1 }, unsigned: true, at: this.at!, label: "" };
  }

  /**
   * Whether an error may come out of a called function: one with a `throw` outside every `try` of its own, or a call
   * that may run out of stack, or a call of such a function — worked out for every function the program reaches at
   * once, until nothing more comes in.
   */
  mayThrow(fn: string): boolean {
    if (!this.scope.errors) return false;
    if (!this.throwing) {
      const out = new Set<string>();
      const escapes = (x: unknown): boolean => {
        if (!x || typeof x !== "object") return false;
        if (Array.isArray(x)) return x.some(escapes);
        const o = x as Record<string, unknown>;
        if (o.kind === "throw" || o.saves) return true;
        // (What the body of a `try` throws, its `catch` takes; what the `catch` throws goes on.)
        if (o.kind === "try") return escapes(o.catch);
        if (typeof o.fn === "string" && Array.isArray(o.params) && out.has(o.fn)) return true;
        return Object.values(o).some((v) => v && typeof v === "object" && escapes(v));
      };
      const ids = [...this.scope.taken.keys()];
      for (let grew = true; grew; ) {
        grew = false;
        for (const id of ids) if (!out.has(id) && escapes(this.scope.bodyOf!(id))) { out.add(id); grew = true; }
      }
      this.throwing = out;
    }
    return this.throwing.has(fn);
  }

  /**
   * A function whose calls all point its trigger for errors at the same place: that trigger goes there as built, and
   * the calls' actions go.
   */
  settleThrown(): void {
    for (const [id, sets] of this.thrownSets) {
      const proto = this.thrownProtos.get(id);
      if (!proto || new Set(sets.map((x) => x.to)).size !== 1) continue;
      for (const x of sets) x.items.splice(x.items.indexOf(x.item), 1);
      proto.next = sets[0].to;
    }
  }

  /**
   * The functions the calls reached, each laid out once after the program (which never falls into them): its body,
   * what it gives back off its end (0), and the trigger it ends at — empty, kept, its next pointer the call's. A
   * function called inside loops counts its triggers as that deep, for what weighs a variable's reads.
   */
  functions(): void {
    for (let id = this.pending.shift(); id !== undefined; id = this.pending.shift()) {
      const f = this.scope.functions.get(id)!, body = this.scope.bodyOf!(id)!, fn = this.fns.get(id)!;
      const outer = this.depthBase;
      this.depthBase = fn.depth;
      this.current = id;
      this.live = f.recursive ? liveAfterCalls(body) : new Map();
      this.land(fn.entry);
      const result = f.result ? { id: f.result.decl.id, kind: f.result.kind } : undefined;
      this.frames.push({ ...(result ? { result } : {}), end: fn.exit });
      // (No `try` of the caller's is around the function's body: an error leaves it first. Nor is it cold for its call.)
      const handlers = this.handlers, cold = this.cold;
      this.handlers = [];
      this.cold = 0;
      this.stmts(body);
      this.handlers = handlers;
      this.cold = cold;
      this.frames.pop();
      const last = body.filter((s) => s.kind !== "remark").at(-1);
      if (result && last?.kind !== "return") this.write(result.id, { c: 0, terms: [] });
      this.push({ label: fn.exit, conds: [], items: [], keep: true, at: f.at });
      // (Its trigger for errors, its next pointer the call's, as the end's is.)
      if (fn.thrown) this.thrownProtos.set(id, this.push({ label: fn.thrown, conds: [], items: [], keep: true, at: f.at }));
      this.depthBase = outer;
    }
  }

  // ── products and quotients (step 4 of the way off eudplib) ──

  /**
   * A product, a quotient or a remainder (`Arith`) into `target`; the variables of the emitter's own its sides read are
   * named in `own` (the reads before it).
   */
  arith(target: string, x: Arith, own: Map<string, string>, at?: At): void {
    const rename = (l: Linear): Linear => ({ c: l.c, terms: l.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) });
    const a = rename(x.a), b = rename(x.b);
    this.top = x.r && x.r[0] >= 0 ? x.r[1] : undefined;
    if (this.top !== undefined && this.own.has(target)) this.tops.set(target, this.top);
    // (The target read while its scratch cells are worked in — `x = x * y` — keeps them apart.)
    const apart = [...a.terms, ...b.terms].some((t) => t.id === target);
    if (x.op === "random") return this.randomNumber(target, a, x.ra, apart, at);
    if (x.op === "sqrt") return this.squareRoot(target, a, x.unsigned, x.ra, apart, at);
    if (x.op === "*") return this.product(target, a, b, x.ra, x.rb, apart, at);
    if (x.op === "fmul") return a.terms.length === 0 || b.terms.length === 0 ? this.fixedByConst(target, a.terms.length ? a : b, u(a.terms.length ? b.c : a.c), a.terms.length ? x.ra : x.rb, apart, at) : this.fixedProduct(target, a, b, x.ra, x.rb, apart, at);
    if (x.op === "fdiv" && x.ratio) return this.divide(target, "/", a, b, true, x.ra, x.rb, apart, at, "ratio");
    if (x.op === "fdiv") {
      if (b.terms.length === 0) return this.fixedOverConst(target, a, u(b.c), x.ra, apart, at);
      return this.divide(target, "/", a, b, false, x.ra, x.rb, apart, at, a.terms.length === 0 ? "constant" : "fixed");
    }
    if (x.op === "&" || x.op === "|" || x.op === "^") return this.bits(target, x.op, a, b, apart, at);
    if (x.op === "<<") return this.shiftLeft(target, a, b, x.rb, apart, at);
    if (x.op === ">>" || x.op === ">>>") return this.shiftRight(target, x.op, a, b, x.ra, apart, at);
    if (b.terms.length === 0) return this.divideByConst(target, x.op, a, b.c, x.unsigned, x.ra, apart, at);
    return this.divide(target, x.op, a, b, x.unsigned, x.ra, x.rb, apart, at);
  }

  /** A sum as a variable times a constant plus a constant, for a field to hold a multiple of: one of the emitter's own when it has more than one variable. */
  multiple(l: Linear, name: string): Multiple {
    if (l.terms.length === 1) return { id: l.terms[0].id, k: l.terms[0].k, c: l.c };
    return { id: this.alone(l, name), k: 1, c: 0 };
  }

  /**
   * An action setting, adding or taking away `by` times `m` at a dword: its number a place of m's variable, kept by its
   * writes — or, for a variable the plan copies (`Scope.heavy`), whose copies would fill such a place at every write,
   * its cell routed into the number as the routine starts (`fed`, `routeFed`: 56 ns once a use).
   */
  times(dword: Dword, m: Multiple, by: number, modifier: "set" | "add" | "subtract" = "add"): Act {
    const act: Act = { dword, modifier, value: 0 };
    if (this.scope.heavy.has(m.id) && mul(m.k, by) === 1) this.fed.set(act, { id: m.id, add: mul(m.c, by) });
    else this.actPlaces.set(act, { value: { id: m.id, scale: mul(m.k, by), add: mul(m.c, by) } });
    return act;
  }

  /** A condition comparing a dword with `m`, its number read as `times` reads one. */
  against(dword: Dword, compare: Compare, m: Multiple): Cond {
    const cond: Cond = { dword, compare, value: 0 };
    if (this.scope.heavy.has(m.id) && m.k === 1) this.fed.set(cond, { id: m.id, add: m.c });
    else this.condReads.set(cond, { id: m.id, scale: m.k, add: m.c });
    return cond;
  }

  /**
   * The most each variable of the emitter's own a product or a quotient fills can be, when value ranges know it never
   * below zero: a copy of it into a field holding a multiple goes over only those bits (`product`'s narrow sides).
   */
  tops = new Map<string, number>();
  /** The most the answer of the product or the quotient being laid out can be, when never below zero: its fill's copy's. */
  top?: number;

  /** The actions' and conditions' numbers a routine reads a heavy variable by, to route its cell into (`routeFed`). */
  fed = new Map<Act | Cond, { id: string; add: number }>();
  /** Dwords a routine sets to a heavy variable as it starts (`setTo`): its cell routed into each. */
  fedDwords: { id: string; add: number; dword: Dword }[] = [];

  /** A dword set to `m` as the routine starts: its variable's cell routed there (a heavy one, `fed`), or set from a place of it. */
  setTo(dword: Dword, m: Multiple, at?: At): void {
    if (this.scope.heavy.has(m.id) && m.k === 1) this.fedDwords.push({ id: m.id, add: m.c, dword });
    else this.push({ conds: [], items: [{ act: this.times(dword, m, 1, "set") }], at });
  }

  /**
   * A routine's start: an empty trigger, where `routeFed` puts the routes into the fields its triggers made after it
   * read heavy variables by. Returns its index among the triggers.
   */
  beginFed(at?: At): number {
    this.push({ conds: [], items: [], at });
    return this.protos.length - 1;
  }
  routeFed(from: number): void {
    const into = new Map<string, Dword[]>(), adds: Act[] = [];
    const take = (x: Act | Cond, field: Dword) => {
      const f = this.fed.get(x);
      if (!f) return;
      into.set(f.id, [...(into.get(f.id) ?? []), field]);
      if (f.add) adds.push({ dword: field, modifier: "add", value: f.add });
      this.fed.delete(x);
    };
    for (const p of this.protos.slice(from + 1)) {
      p.conds.forEach((c, k) => take(c, { at: p.label, field: { cond: k } }));
      let k = 0;
      for (const it of p.items) if ("act" in it) take(it.act, { at: p.label, field: { act: k++, part: "value" } });
    }
    for (const f of this.fedDwords.splice(0)) {
      into.set(f.id, [...(into.get(f.id) ?? []), f.dword]);
      if (f.add) adds.push({ dword: f.dword, modifier: "add", value: f.add });
    }
    this.protos[from].items.unshift(...[...into].map(([id, dwords]) => ({ route: { from: id, into: dwords } }) as Item), ...adds.map((act) => ({ act }) as Item));
  }

  /**
   * The doubling trigger of a product or a quotient: each of `cells` — its own actions' numbers, in order — added to
   * itself (an action whose number is its own destination), and its next pointer moved on a trigger, so that each time
   * it runs it goes to the step after the one it went to before: the steps are a run of triggers laid out one after
   * another, and no trigger before each says where to go.
   */
  doubler(R: string, cells: Dword[], first: string, at?: At): void {
    this.push({ label: R, conds: [], items: [...cells.map((d) => ({ act: { dword: d, modifier: "add", value: 0 } as Act })), { act: { dword: nextOf(R), modifier: "add", value: TRIGGER_BYTES } }], next: first, keep: true, at });
  }

  /**
   * Into a run of `n` steps (a doubling trigger's) at the first that matters: the doubling trigger pointed at it — it
   * moves itself on from there — and the walk sent there. From the top, a group of eight steps whose bits are all clear
   * (`atLeast(k)` the condition that the number tested has a bit at k or above) is jumped over.
   */
  enter(n: number, step: (i: number) => string, R: string, atLeast: (k: number) => Cond, at?: At): void {
    const entries: [string, number][] = [];
    let g = 0;
    for (; g + 8 < n; g += 8) {
      const e = this.label("he");
      this.branch([atLeast(n - 8 - g)], e, at);
      entries.push([e, g]);
    }
    const last = this.label("he");
    this.goto(last);
    entries.push([last, g]);
    for (const [label, i] of entries) this.push({ label, conds: [], items: [{ act: { dword: nextOf(R), modifier: "set", value: { label: step(i) } } }], next: step(i), at });
  }

  /** A trigger whose conditions holding run its actions and send the walk to `to`; otherwise it goes on. */
  branchDoing(conds: Cond[], acts: Act[], to: string, at?: At): void {
    const label = this.label("b"), after = this.label("a");
    this.push({ label, conds, items: [...acts.map((act) => ({ act })), { act: { dword: nextOf(label), modifier: "set", value: { label: to } } }], next: after, at });
    let r = this.restores.get(to);
    if (!r) this.restores.set(to, (r = []));
    r.push({ branch: label, to: after });
    this.land(after);
  }

  /**
   * What the doubling trigger's actions hold, out into scratch cells: each action pointed at its cell, set to 0 first —
   * or, when `negative` holds, to MAX with the action made a subtraction and 1 added after: the negation (without the 1,
   * `complement`: the bits flipped) — the move of
   * its next pointer pointed at a cell of no use, the trigger run once more, and all pointed back.
   */
  takeOut(R: string, advance: number | null, outs: { act: number; temp: string }[], negative: Cond[] | null, at?: At, complement = false): void {
    const field = (act: number, part: "value" | "dest" | "modifier"): Dword => ({ at: R, field: { act, part } });
    const run = (minus: boolean) => {
      const back = this.label("tb"), pre: Act[] = [], post: Act[] = [];
      for (const o of outs) {
        pre.push({ dword: { temp: o.temp }, modifier: "set", value: minus ? MAX : 0 }, { dword: field(o.act, "dest"), modifier: "set", value: { epd: { temp: o.temp } } });
        post.push({ dword: field(o.act, "dest"), modifier: "set", value: { epd: field(o.act, "value") } });
        if (minus) {
          pre.push({ dword: field(o.act, "modifier"), modifier: "set", value: 9 * 2 ** 24, mask: 0xff000000 });
          post.push({ dword: field(o.act, "modifier"), modifier: "set", value: 8 * 2 ** 24, mask: 0xff000000 });
          // (MAX less it is its bits flipped, `complement`; plus 1, its negation.)
          if (!complement) post.push({ dword: { temp: o.temp }, modifier: "add", value: 1 });
        }
      }
      if (advance !== null) pre.push({ dword: field(advance, "dest"), modifier: "set", value: { epd: { temp: `${R}.nowhere` } } });
      pre.push({ dword: nextOf(R), modifier: "set", value: { label: back } });
      if (advance !== null) post.push({ dword: field(advance, "dest"), modifier: "set", value: { epd: nextOf(R) } });
      this.push({ conds: [], items: pre.map((act) => ({ act })), next: R, at });
      this.push({ label: back, conds: [], items: post.map((act) => ({ act })), at });
    };
    if (!negative) return run(false);
    const minus = this.label("tm"), joined = this.label("tj");
    this.branch(negative, minus, at);
    run(false);
    this.goto(joined);
    this.land(minus);
    run(true);
    this.land(joined);
  }

  /**
   * a × b, wrapping at 32 bits (the same bits signed or not). The side the value ranges leave fewer bits is tested a
   * bit at a time where it is (a masked condition costs Remastered nothing over a plain one), and the other is added for
   * each bit set — one of two ways:
   * - A tested side of a few bits (`SCALED_BITS`) times one variable the plan does not copy (`Scope.heavy`): a trigger
   *   a bit, adding the variable times the bit — a field each, a place of it its writes keep (13 ns a bit, 23 set).
   * - Otherwise Horner's way: the product so far doubles in a doubling trigger (`doubler`) that walks a run of triggers,
   *   a bit each, which add the other side when the bit is set: read in a field of each (about 46 ns a bit), or, for a
   *   side the plan may copy, in one shared trigger a flag sends the walk through, so that its cell is routed into one
   *   field (56 ns) and not one a bit (about 69 ns a bit). A side below zero is taken as its magnitude and the
   *   product negated as it comes out; groups of eight leading zeros are jumped over.
   * eudplib's product routes its operand through a call twice a bit, about 95 ns.
   */
  product(target: string, a: Linear, b: Linear, ra: Range | undefined, rb: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.products++;
    const [t, s, rt] = width(rb) <= width(ra) ? [b, a, rb] : [a, b, ra];
    const signed = !rt || rt[0] < 0, w = signed ? 32 : width(rt);
    if (w === 0) return this.write(target, { c: 0, terms: [] });
    // (A variable the plan does not copy keeps its multiples where it is written; so does a scratch value a product or a
    // quotient filled whose ranges leave it few bits, its copy into them a trigger a bit it can have.)
    const sTop = s.terms.length === 1 ? this.tops.get(s.terms[0].id) : undefined;
    const clean = s.terms.length === 1 && !this.scope.heavy.has(s.terms[0].id), narrow = sTop !== undefined && width([0, sTop]) <= SCALED_BITS;
    const temp = `${this.key}.mp${this.n++}`, from = this.beginFed(at);
    const fill = () => {
      this.routeFed(from);
      this.open().items.push({ fill: { temp, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
    };
    if ((clean || narrow) && !signed && w <= SCALED_BITS) {
      const T = this.home(this.alone(t, "mt"), 0), S = this.multiple(s, "ms");
      this.open().items.push({ act: { dword: { temp }, modifier: "set", value: 0 } });
      for (let j = w - 1; j >= 0; j--) this.push({ conds: [{ dword: T, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: [{ act: this.times({ temp }, S, u(2 ** j)) }], at });
      return void fill();
    }
    const neg = `${this.key}.mn${this.n++}`;
    let T: Dword;
    if (signed) {
      // (Its magnitude: the side, or MAX less it plus 1 — read at its own scale, so that no field holds its negation.)
      const m = this.multiple(t, "mt"), mt = `${this.key}.mm${this.n++}`;
      this.setTo({ temp: mt }, m, at);
      this.push({ conds: [], items: [{ act: { dword: { temp: neg }, modifier: "set", value: 0 } }], at });
      this.push({ conds: [{ dword: { temp: mt }, compare: "atLeast", value: 1, mask: SIGN }], items: [{ act: { dword: { temp: mt }, modifier: "set", value: MAX } }, { act: this.times({ temp: mt }, m, 1, "subtract") }, { act: { dword: { temp: mt }, modifier: "add", value: 1 } }, { act: { dword: { temp: neg }, modifier: "set", value: 1 } }], at });
      T = { temp: mt };
    } else T = this.home(this.alone(t, "mt"), 0);
    const S = this.multiple(s, "ms");
    const R = this.label("hr"), A = this.label("ha"), done = this.label("hdone");
    const acc: Dword = { at: R, field: { act: 0, part: "value" } };
    const flag = `${this.key}.hf${this.n++}`, shared = !clean;
    const B = Array.from({ length: w }, () => this.label("hb"));
    this.push({ conds: [], items: [{ act: { dword: acc, modifier: "set", value: 0 } }, ...(shared ? [{ act: { dword: { temp: flag }, modifier: "set", value: 0 } } as Item, { act: { dword: nextOf(A), modifier: "set", value: { label: R } } } as Item] : [])], at });
    this.enter(w, (i) => B[i], R, (k) => ({ dword: T, compare: "atLeast", value: 2 ** k }), at);
    const bit = (label: string, i: number, next: string) => this.push({ label, conds: [{ dword: T, compare: "atLeast", value: 1, mask: u(2 ** (w - 1 - i)) }], items: [{ act: shared ? { dword: { temp: flag }, modifier: "set", value: 1 } : this.times(acc, S, 1) }], next, at });
    for (let i = 0; i + 1 < w; i++) bit(B[i], i, shared ? A : R);
    if (shared) {
      // (The last bit's place in the run points the shared addition at the end, and goes on to the last bit, laid out after.)
      const last = this.label("hlast");
      this.push({ label: B[w - 1], conds: [], items: [{ act: { dword: nextOf(A), modifier: "set", value: { label: done } } }], next: last, at });
      bit(last, w - 1, A);
      this.push({ label: A, conds: [{ dword: { temp: flag }, compare: "exactly", value: 1 }], items: [{ act: this.times(acc, S, 1) }, { act: { dword: { temp: flag }, modifier: "set", value: 0 } }], next: R, at });
    } else bit(B[w - 1], w - 1, done);
    this.rows.push(B);
    this.doubler(R, [acc], B[0], at);
    this.land(done);
    this.takeOut(R, 1, [{ act: 0, temp }], signed ? [{ dword: { temp: neg }, compare: "exactly", value: 1 }] : null, at);
    fill();
  }

  /**
   * a & b, a | b or a ^ b as a value, the left side copied into a scratch cell and changed by masked writes — the game
   * works a masked write on the bits under its mask alone, of the dword and of the number both, so a masked addition's
   * carry past its mask is lost. With a constant k: `&` k's clear bits set to 0, `|` its set bits to 1, `^` k added to
   * the even bits and to the odd bits apart (each sum's bit is the two bits' exclusive or). Of two values the same, the
   * right side being the number of the additions (`^`), or the mask of the write — a mask is a field like any number —
   * flipped first for `&` by those two additions of all ones. eudplib's own & of two variables is the same write, and
   * its ^ the same additions, through calls; a trigger a bit was 3× slower.
   */
  bits(target: string, op: "&" | "|" | "^", a: Linear, b: Linear, apart: boolean, at?: At): void {
    emitterCounts.bits++;
    const EVEN = 0x55555555, ODD = 0xaaaaaaaa;
    const from = this.beginFed(at), temp = `${this.key}.bw${this.n++}`;
    const masked = (act: Act, mask: number): Act => Object.assign(act, { mask });
    if (a.terms.length === 0 || b.terms.length === 0) {
      const [x, k] = b.terms.length === 0 ? [a, u(b.c)] : [b, u(a.c)];
      this.setTo({ temp }, this.multiple(x, "bx"), at);
      const acts: Act[] = op === "&" ? [{ dword: { temp }, modifier: "set", value: 0, mask: u(~k) }]
        : op === "|" ? [{ dword: { temp }, modifier: "set", value: k, mask: k }]
        : [{ dword: { temp }, modifier: "add", value: k, mask: EVEN }, { dword: { temp }, modifier: "add", value: k, mask: ODD }];
      this.push({ conds: [], items: acts.map((act) => ({ act })), at });
    } else {
      const B = this.multiple(b, "bb");
      this.setTo({ temp }, this.multiple(a, "ba"), at);
      if (op === "^") this.push({ conds: [], items: [{ act: masked(this.times({ temp }, B, 1, "add"), EVEN) }, { act: masked(this.times({ temp }, B, 1, "add"), ODD) }], at });
      else {
        const W = this.label("bw"), mask: Dword = { at: W, field: { act: 0, part: "mask" } };
        this.setTo(mask, B, at);
        if (op === "&") this.push({ conds: [], items: [{ act: { dword: mask, modifier: "add", value: MAX, mask: EVEN } }, { act: { dword: mask, modifier: "add", value: MAX, mask: ODD } }], at });
        this.push({ label: W, conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: op === "&" ? 0 : MAX, mask: 0 } }], at });
      }
    }
    this.routeFed(from);
    this.open().items.push({ fill: { temp, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * Runs of empty triggers a doubling trigger walks (`doubler`), one run for each bit the count can have, the run of bit
   * k 2^k triggers long and one more that leaves it: each trigger goes back to the doubling trigger, which doubles and
   * moves on to the next, so a run doubles 2^k times. The runs the count's bits are clear for are jumped over: `count`
   * doublings in all, at about 37 ns each.
   */
  doublings(R: string, count: Dword, most: number, at?: At): void {
    for (let k = Math.min(4, Math.max(0, 31 - Math.clz32(Math.max(1, most)))); k >= 0; k--) {
      const skip = this.label("ds"), run = Array.from({ length: 2 ** k + 1 }, () => this.label("dr"));
      this.branch([{ dword: count, compare: "exactly", value: 0, mask: 2 ** k }], skip, at);
      this.push({ conds: [], items: [{ act: { dword: nextOf(R), modifier: "set", value: { label: run[0] } } }], next: run[0], at });
      run.forEach((label, i) => this.push({ label, conds: [], items: [], next: i < 2 ** k ? R : skip, keep: true, at }));
      this.rows.push(run);
      this.land(skip);
    }
  }

  /**
   * a << n by a value: a in a doubling trigger, doubled (n & 31) times (`doublings`), and taken out. eudplib's left
   * shift by a value is a loop of routed additions of the number to itself, about 80 ns each.
   */
  shiftLeft(target: string, a: Linear, n: Linear, rn: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.shifts++;
    const from = this.beginFed(at), temp = `${this.key}.sl${this.n++}`, count = `${this.key}.sc${this.n++}`;
    const R = this.label("sr"), cell: Dword = { at: R, field: { act: 0, part: "value" } };
    this.setTo(cell, this.multiple(a, "sa"), at);
    this.setTo({ temp: count }, this.multiple(n, "sn"), at);
    const done = this.label("sdone");
    // (By 32 or more, read from 0 up: nothing left.)
    const small = !!rn && rn[0] >= 0 && rn[1] < 32;
    if (!small) this.branchDoing([{ dword: { temp: count }, compare: "atLeast", value: 32 }], [{ dword: cell, modifier: "set", value: 0 }], done, at);
    this.doublings(R, { temp: count }, small ? rn![1] : 31, at);
    this.goto(done);
    this.doubler(R, [cell], done, at);
    this.land(done);
    this.takeOut(R, 1, [{ act: 0, temp }], null, at);
    this.routeFed(from);
    this.open().items.push({ fill: { temp, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * a >>> n or a >> n by a value: Horner's way over a's bits from the top — the answer doubling in a doubling trigger
   * that also counts, a trigger a bit adding it when set — for the 32 − (n & 31) bits that stay: a test shared by every
   * bit ends the walk when the count says. `>>` of a number below zero works on its bits flipped and flips the answer's
   * as it comes out. About 69 ns a bit; eudplib's right shift by a value is 2^n by 32 comparisons and a division, about 7 µs.
   */
  shiftRight(target: string, op: ">>" | ">>>", a: Linear, n: Linear, ra: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.shifts++;
    const from = this.beginFed(at), A = this.multiple(a, "sa"), key = `${this.key}.s${this.n++}`;
    const temp = `${key}.o`, am = `${key}.a`, neg = `${key}.neg`;
    const R = this.label("sr"), T = this.label("st"), done = this.label("sdone");
    const cell: Dword = { at: R, field: { act: 0, part: "value" } }, count: Dword = { temp: `${key}.c` };
    const negA = op === ">>" && !(ra && ra[0] >= 0);
    this.setTo({ temp: am }, A, at);
    this.setTo(count, this.multiple(n, "sn"), at);
    this.push({ conds: [], items: [{ act: { dword: cell, modifier: "set", value: 0 } }, { act: { dword: { temp: neg }, modifier: "set", value: 0 } }], at });
    // (By 32 or more, read from 0 up: `>>` fills with the sign as by 31, `>>>` leaves nothing — no bit stays.)
    const zero = this.label("szero"), joined = this.label("sjoin");
    if (op === ">>") this.push({ conds: [{ dword: count, compare: "atLeast", value: 32 }], items: [{ act: { dword: count, modifier: "set", value: 31 } }], at });
    else this.branch([{ dword: count, compare: "atLeast", value: 32 }], zero, at);
    if (negA) {
      // (Below zero: its bits flipped, MAX less it.)
      this.push({ conds: [{ dword: { temp: am }, compare: "atLeast", value: 1, mask: SIGN }], items: [{ act: { dword: { temp: am }, modifier: "set", value: MAX } }, { act: this.times({ temp: am }, A, 1, "subtract") }, { act: { dword: { temp: neg }, modifier: "set", value: 1 } }], at });
    }
    // The bits from the top; the count, from n & 31, reaches 31 at the last bit that stays.
    const B = Array.from({ length: 32 }, () => this.label("sb"));
    this.push({ conds: [], items: [{ act: { dword: nextOf(R), modifier: "set", value: { label: B[0] } } }], next: B[0], at });
    B.forEach((label, i) => this.push({ label, conds: [{ dword: { temp: am }, compare: "atLeast", value: 1, mask: u(2 ** (31 - i)) }], items: [{ act: { dword: cell, modifier: "add", value: 1 } }], next: T, at }));
    this.rows.push(B);
    this.push({ label: T, conds: [{ dword: count, compare: "exactly", value: 31 }], items: [{ act: { dword: nextOf(T), modifier: "set", value: { label: done } } }], next: R, at });
    let r = this.restores.get(done);
    if (!r) this.restores.set(done, (r = []));
    r.push({ branch: T, to: R });
    // (The doubling trigger also counts.)
    this.push({ label: R, conds: [], items: [{ act: { dword: cell, modifier: "add", value: 0 } }, { act: { dword: count, modifier: "add", value: 1 } }, { act: { dword: nextOf(R), modifier: "add", value: TRIGGER_BYTES } }], next: B[0], keep: true, at });
    this.land(done);
    this.takeOut(R, 2, [{ act: 0, temp }], negA ? [{ dword: { temp: neg }, compare: "exactly", value: 1 }] : null, at, true);
    if (op === ">>>") {
      this.goto(joined);
      this.land(zero);
      this.push({ conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }], at });
      this.land(joined);
    }
    this.routeFed(from);
    this.open().items.push({ fill: { temp, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * a / c or a % c by a constant c: eudplib's division chain by a constant, written where it is used instead of called —
   * a trigger for each bit the quotient can have, taking c times that bit from the remainder when it fits — with only
   * as many steps as the value ranges leave the dividend, and from the top a group of eight steps that cannot take
   * anything jumped over. Read as JavaScript's numbers, the magnitude is divided, by a chain for a dividend below zero
   * and one for the rest, each gathering the answer with its sign in one scratch cell: a quotient bit by bit, plus or
   * minus; a remainder below zero as the dividend plus what the chain takes away.
   */
  divideByConst(target: string, op: "/" | "%", a: Linear, c: number, unsigned: boolean, ra: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.quotients++;
    const d = unsigned ? u(c) : Math.abs(c | 0);
    if (d === 0) return this.write(target, { c: 0, terms: [] });
    const negC = !unsigned && (c | 0) < 0, negA = !unsigned && (!ra || ra[0] < 0);
    const most = unsigned ? (ra && ra[0] >= 0 ? ra[1] : MAX) : ra ? Math.max(Math.abs(ra[0]), Math.abs(ra[1])) : SIGN;
    const from = this.beginFed(at), A = this.multiple(a, "da");
    const key = `${this.key}.d${this.n++}`, out = `${key}.o`, rem = `${key}.r`;
    let top = -1;
    while (top < 31 && d * 2 ** (top + 1) <= most) top++;
    // A map of our own: a remainder of a dividend never below zero and less than four times the divisor — a counter
    // kept inside a ring, `k = (k + 373) % 1000` — worked out in the target itself: the dividend written into every
    // place of it, then each step taken from every place where the target's cell holds that much. No scratch cell, and
    // no copy of one into the target's places after (a trigger a bit, for a place that holds a multiple of it).
    if (op === "%" && !negA && top <= 1 && !this.results.has(target)) {
      this.write(target, a);
      for (let i = top; i >= 0; i--) {
        const p = this.push({ conds: [{ dword: this.home(target, 0), compare: "atLeast", value: d * 2 ** i }], items: [], at, guarded: true });
        this.write(target, { c: u(-d * 2 ** i), terms: [{ id: target, k: 1 }] }, true, p.items);
      }
      return;
    }
    /** The chain; `minus`: the dividend below zero (its magnitude in `rem`). */
    const chain = (minus: boolean) => {
      // (The remainder of a dividend not below zero is worked in the answer's own cell.)
      const reg = op === "%" && !minus ? out : rem;
      for (let hi = top; hi >= 0; hi -= 8) {
        const lo = Math.max(0, hi - 7), past = this.label("dg");
        if (top > 7) this.branch([{ dword: { temp: reg }, compare: "atMost", value: d * 2 ** lo - 1 }], past, at);
        for (let i = hi; i >= lo; i--) {
          const x = d * 2 ** i, acts: Act[] = [{ dword: { temp: reg }, modifier: "subtract", value: x }];
          if (op === "/") acts.push({ dword: { temp: out }, modifier: "add", value: u((minus !== negC ? -1 : 1) * 2 ** i) });
          else if (minus) acts.push({ dword: { temp: out }, modifier: "add", value: x });
          this.push({ conds: [{ dword: { temp: reg }, compare: "atLeast", value: x }], items: acts.map((act) => ({ act })), at });
        }
        this.land(past);
      }
    };
    if (op === "/" || negA) this.setTo({ temp: rem }, A, at);
    if (op === "%") this.setTo({ temp: out }, A, at);
    else this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    if (!negA) chain(false);
    else {
      const below = this.label("dn"), done = this.label("dd");
      this.branch([{ dword: { temp: rem }, compare: "atLeast", value: 1, mask: SIGN }], below, at);
      chain(false);
      this.goto(done);
      this.land(below);
      // (The magnitude: MAX less the dividend, plus 1.)
      this.push({ conds: [], items: [{ act: { dword: { temp: rem }, modifier: "set", value: MAX } }, { act: this.times({ temp: rem }, A, 1, "subtract") }, { act: { dword: { temp: rem }, modifier: "add", value: 1 } }], at });
      chain(true);
      this.land(done);
    }
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * The square root of a fixed number, √(v × 65 536) rounded down (0 below zero), or `whole`, of a whole number read
   * from 0 up, √(v × 2^32) (from 2^30 up, the largest fixed number): a bit of the root a step, from the top, as the
   * Python side's `root4` — but where its remainder is compared with four times the root so far, a variable copied and
   * compared each step, here the root is kept at the place its bits end up (ρ = r × 2^(K − s) after s of K steps), so it
   * only ever gains a constant, and the remainder ψ doubles in a doubling trigger instead. Each step: the next two
   * bits of v added to ψ at half its scale (a trigger each, tested where v is), then one trigger shared by every step
   * comparing ψ with Q = ρ + 2^(K − s − 2) (its condition's number) and taking Q from it (its action's) when it fits;
   * that trigger goes on to a pair of triggers of the step's own, laid out one after the other, the second of them when
   * it took Q (it moves its own next pointer on by a trigger, and each of the pair moves it on to the next step's pair):
   * they add the step's constants to the two copies of Q and, the second, the bit to the root. Then ψ doubles. ψ stays
   * below 2^32 for every root a fixed number has. Steps whose bits of v are all clear are jumped over four at a time,
   * from the top. About 120 ns a step while v's bits come in, 100 after; eudplib's is about 280 ns a step.
   */
  squareRoot(target: string, v: Linear, whole: boolean, rv: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.fixed++;
    const from = this.beginFed(at), V = this.multiple(v, "qv");
    const key = `${this.key}.q${this.n++}`, out = `${key}.o`, vc = `${key}.v`;
    const done = this.label("qdone");
    this.setTo({ temp: vc }, V, at);
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    const known = !!rv && rv[0] >= 0, top = whole ? 2 ** 30 - 1 : 2 ** 31 - 1;
    const most = known ? Math.min(rv![1], top) : top;
    // Past what a root holds (a whole number from 2^30 up), the largest; below zero (a fixed number), or 0, 0.
    if (whole && !(known && rv![1] <= top)) this.branchDoing([{ dword: { temp: vc }, compare: "atLeast", value: 2 ** 30 }], [{ dword: { temp: out }, modifier: "set", value: 0x7fffffff }], done, at);
    if (!whole && !known) this.branch([{ dword: { temp: vc }, compare: "atLeast", value: SIGN }], done, at);
    this.branch([{ dword: { temp: vc }, compare: "exactly", value: 0 }], done, at);
    if (most >= 1) {
      // P pairs of v's bits, then (the zeros of × 65 536 or × 2^32) 8 or 16 more steps: K bits of root.
      const P = Math.ceil(width([0, most]) / 2), K = P + (whole ? 16 : 8);
      const lam = (j: number) => (j <= K ? 2 ** (K - j) : 1);
      const R = this.label("qr"), C = this.label("qc");
      const psi: Dword = { at: R, field: { act: 0, part: "value" } };
      const copies: Dword[] = [{ at: C, field: { cond: 0 } }, { at: C, field: { act: 0, part: "value" } }];
      const slots = Array.from({ length: K }, () => this.label("qs")), low = Array.from({ length: P }, () => this.label("ql"));
      const pairs = Array.from({ length: K }, () => [this.label("qn"), this.label("qt")]);
      // Into the steps at the first whose bits of v are not all clear (of a group of four), with ρ 0 so far.
      const starts: number[] = [];
      for (let j = 0; j < P; j += 4) starts.push(j);
      const entries = starts.map(() => this.label("qe"));
      for (let k = 0; k + 1 < starts.length; k++) this.branch([{ dword: { temp: vc }, compare: "atLeast", value: 4 ** (P - starts[k + 1]) }], entries[k], at);
      this.goto(entries[entries.length - 1]);
      starts.forEach((j, k) => this.push({ label: entries[k], conds: [], items: [
        { act: { dword: psi, modifier: "set", value: 0 } },
        ...copies.map((d) => ({ act: { dword: d, modifier: "set", value: lam(j + 2) } }) as Item),
        // (The doubling trigger moves its next pointer on before the walk follows it: pointed at this step's first.)
        { act: { dword: nextOf(R), modifier: "set", value: { label: slots[j] } } },
        { act: { dword: nextOf(C), modifier: "set", value: { label: pairs[j][0] } } },
      ], next: slots[j], at }));
      // The steps' first triggers, one after the other (the doubling trigger walks them): the high bit of the step's
      // pair of v, then (elsewhere) the low.
      for (let s = 0; s < K; s++) {
        if (s < P) this.push({ label: slots[s], conds: [{ dword: { temp: vc }, compare: "atLeast", value: 1, mask: u(2 ** (2 * P - 1 - 2 * s)) }], items: [{ act: { dword: psi, modifier: "add", value: lam(s + 1) } }], next: low[s], keep: true, at });
        else this.push({ label: slots[s], conds: [], items: [], next: C, keep: true, at });
      }
      for (let s = 0; s < P; s++) this.push({ label: low[s], conds: [{ dword: { temp: vc }, compare: "atLeast", value: 1, mask: 2 ** (2 * P - 2 - 2 * s) }], items: [{ act: { dword: psi, modifier: "add", value: lam(s + 2) } }], next: C, at });
      // The shared step: Q taken from ψ when it fits, and the walk on to the second of the step's pair.
      this.push({ label: C, conds: [{ dword: psi, compare: "atLeast", value: 0 }], items: [{ act: { dword: psi, modifier: "subtract", value: 0 } }, { act: { dword: nextOf(C), modifier: "add", value: TRIGGER_BYTES } }], next: pairs[0][0], keep: true, at });
      // The pairs: Q's two copies to the next step's (ρ less or more, the next 2^(K − s − 3)); the root's bit.
      for (let s = 0; s < K; s++) {
        const last = s === K - 1, d = lam(s + 3) - lam(s + 2), next = last ? done : R;
        const adds = (by: number): Item[] => (last || by === 0 ? [] : copies.map((c) => ({ act: { dword: c, modifier: "add", value: u(by) } }) as Item));
        this.push({ label: pairs[s][0], conds: [], items: [...adds(d), ...(last ? [] : [{ act: { dword: nextOf(C), modifier: "add", value: 2 * TRIGGER_BYTES } } as Item])], next, keep: true, at });
        this.push({ label: pairs[s][1], conds: [], items: [...adds(d + lam(s + 1)), { act: { dword: { temp: out }, modifier: "add", value: lam(s + 1) } }, ...(last ? [] : [{ act: { dword: nextOf(C), modifier: "add", value: TRIGGER_BYTES } } as Item])], next, keep: true, at });
      }
      // ψ doubled, and on to the next step's first trigger.
      this.push({ label: R, conds: [], items: [{ act: { dword: psi, modifier: "add", value: 0 } }, { act: { dword: nextOf(R), modifier: "add", value: TRIGGER_BYTES } }], next: slots[0], keep: true, at });
      this.rows.push(slots, pairs.flat());
    }
    this.land(done);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * random(n): a whole number from 0 to n − 1 (n read from 0 up; 0 by 0 or 1), each as likely, from the game's own
   * random numbers — Set Switch to a random state is one bit of them, the same on every player's machine, read where the
   * game keeps the switch. As many bits as n − 1 has are drawn, from the top, and drawn again when they make n or more
   * (fewer than two draws on average; a power of two never): a constant n's count of bits known when the map is built, a
   * value's found by a search of its top bit, which the bits are entered at. About 28 ns a bit. The switch (256, the
   * last) is put back as it was. eudplib's random numbers are a generator of its own seeded from a switch once, with
   * two products a draw and then a division by n.
   */
  randomNumber(target: string, n: Linear, rn: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.random++;
    if ((n.terms.length === 0 && u(n.c) <= 1) || (n.terms.length && rn && rn[0] >= 0 && rn[1] <= 1)) return this.write(target, { c: 0, terms: [] });
    const sw = RANDOM_SWITCH, word: Dword = { game: SWITCHES + 4 * (sw >> 5) }, bit = u(2 ** (sw & 31));
    const from = this.beginFed(at), key = `${this.key}.rn${this.n++}`, out = `${key}.o`, saved = `${key}.s`, nm = `${key}.m`;
    // The switch as it was.
    this.push({ conds: [], items: [{ act: { dword: { temp: saved }, modifier: "set", value: 0 } }], at });
    this.push({ conds: [{ dword: word, compare: "atLeast", value: 1, mask: bit }], items: [{ act: { dword: { temp: saved }, modifier: "set", value: 1 } }], at });
    const draw = (b: number, label?: string) => {
      this.push({ ...(label ? { label } : {}), conds: [], items: [{ act: { dword: { game: 0 }, modifier: "set", value: 0, randomize: sw } }], at });
      this.push({ conds: [{ dword: word, compare: "atLeast", value: 1, mask: bit }], items: [{ act: { dword: { temp: out }, modifier: "add", value: u(2 ** b) } }], at });
    };
    const done = this.label("rndone");
    if (n.terms.length === 0) {
      const limit = u(n.c), k = width([0, limit - 1]), again = this.label("rnagain");
      this.push({ label: again, conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
      for (let b = k - 1; b >= 0; b--) draw(b);
      if (limit & (limit - 1)) this.branch([{ dword: { temp: out }, compare: "atLeast", value: limit }], again, at);
    } else {
      // n − 1, its top bit searched; the bits from there down, and again from there when they make n or more.
      const N = this.multiple(n, "rnb"), retry = this.label("rnretry"), zero = this.label("rnzero");
      this.setTo({ temp: nm }, N, at);
      this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
      this.branch([{ dword: { temp: nm }, compare: "atMost", value: 1 }], zero, at);
      this.push({ conds: [], items: [{ act: { dword: { temp: nm }, modifier: "add", value: MAX } }], at });
      const most = rn && rn[0] >= 0 ? rn[1] - 1 : MAX, k = width([0, most]);
      const pairs = Array.from({ length: k }, () => this.label("rnbit"));
      const leaf = (t: number) => this.push({ conds: [], items: [{ act: { dword: nextOf(retry), modifier: "set", value: { label: pairs[k - 1 - t] } } }], next: pairs[k - 1 - t], at });
      const tree = (lo: number, hi: number) => {
        if (lo === hi) return void leaf(lo);
        const mid = (lo + hi + 1) >> 1, high = this.label("rnhi");
        this.branch([{ dword: { temp: nm }, compare: "atLeast", value: 2 ** mid }], high, at);
        tree(lo, mid - 1);
        this.land(high);
        tree(mid, hi);
      };
      tree(0, k - 1);
      for (let b = k - 1; b >= 0; b--) draw(b, pairs[k - 1 - b]);
      const fits = this.against({ temp: out }, "atLeast", N);
      const back = this.label("rnback");
      this.push({ label: back, conds: [fits], items: [{ act: { dword: nextOf(back), modifier: "set", value: { label: retry } } }], next: done, at });
      this.restores.set(retry, [...(this.restores.get(retry) ?? []), { branch: back, to: done }]);
      this.push({ label: retry, conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], next: pairs[0], keep: true, at });
      this.land(zero);
    }
    this.land(done);
    this.push({ conds: [{ dword: { temp: saved }, compare: "exactly", value: 1 }], items: [{ act: { dword: word, modifier: "set", value: bit, mask: bit } }], at });
    this.push({ conds: [{ dword: { temp: saved }, compare: "exactly", value: 0 }], items: [{ act: { dword: word, modifier: "set", value: 0, mask: bit } }], at });
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * The magnitude of a sum, into a scratch cell where it is tested and worked: the sum, or — read below zero — MAX less
   * it, plus 1 (read at its own scale: no field holds its negation). Each chain `body` makes is laid out twice when the
   * sum may be below zero: `minus` says which, so that a constant it adds carries the answer's sign.
   */
  bySign(cell: string, m: Multiple, below: boolean, body: (minus: boolean) => void, at?: At): void {
    this.setTo({ temp: cell }, m, at);
    if (!below) return body(false);
    const minus = this.label("fn"), done = this.label("fd");
    this.branch([{ dword: { temp: cell }, compare: "atLeast", value: 1, mask: SIGN }], minus, at);
    body(false);
    this.goto(done);
    this.land(minus);
    this.push({ conds: [], items: [{ act: { dword: { temp: cell }, modifier: "set", value: MAX } }, { act: this.times({ temp: cell }, m, 1, "subtract") }, { act: { dword: { temp: cell }, modifier: "add", value: 1 } }], at });
    body(true);
    this.land(done);
  }

  /**
   * x × c / 65 536 towards zero, of a number with a fraction and one written in the script (both raw cells): the Python
   * side's way, written where it is used. Each bit of |x| adds c times its place, split at the point — the whole part
   * into the answer, the part below it gathered apart, whose whole part is added at the end (the answer is the
   * product's, not a sum of rounded parts) — as many bits as the ranges leave |x|, groups of eight clear ones jumped over.
   */
  fixedByConst(target: string, x: Linear, c: number, rx: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.fixed++;
    const m = Math.abs(c | 0);
    if (m === 0) return this.write(target, { c: 0, terms: [] });
    const negC = (c | 0) < 0, negX = !(rx && rx[0] >= 0);
    const most = rx ? Math.max(Math.abs(rx[0]), Math.abs(rx[1])) : SIGN, top = width([0, most]) - 1;
    const parts = Array.from({ length: top + 1 }, (_, j) => [u(Number((BigInt(m) << BigInt(j)) >> 16n) % 2 ** 32), Number((BigInt(m) << BigInt(j)) & 0xffffn)]);
    const lowBits = width([0, parts.reduce((s, [, lo]) => s + lo, 0)]);
    const from = this.beginFed(at), key = `${this.key}.fm${this.n++}`, out = `${key}.o`, low = `${key}.l`, xm = `${key}.x`;
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }, { act: { dword: { temp: low }, modifier: "set", value: 0 } }], at });
    this.bySign(xm, this.multiple(x, "fx"), negX, (minus) => {
      const s = minus !== negC ? MAX : 1;
      for (let hi = top; hi >= 0; hi -= 8) {
        const bits = Array.from({ length: Math.min(8, hi + 1) }, (_, i) => hi - i), past = this.label("fg");
        if (top > 7) this.branch([{ dword: { temp: xm }, compare: "exactly", value: 0, mask: u(bits.reduce((g, j) => g + 2 ** j, 0)) }], past, at);
        for (const j of bits) {
          const [h, l] = parts[j], acts: Act[] = [];
          if (h) acts.push({ dword: { temp: out }, modifier: "add", value: mul(h, s) });
          if (l) acts.push({ dword: { temp: low }, modifier: "add", value: l });
          if (acts.length) this.push({ conds: [{ dword: { temp: xm }, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: acts.map((act) => ({ act })), at });
        }
        this.land(past);
      }
      for (let k = 16; k < lowBits; k++) this.push({ conds: [{ dword: { temp: low }, compare: "atLeast", value: 1, mask: u(2 ** k) }], items: [{ act: { dword: { temp: out }, modifier: "add", value: mul(2 ** (k - 16), s) } }], at });
    }, at);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * x × 65 536 / c towards zero, of a number with a fraction and one written in the script: the Python side's way,
   * written where it is used. Long division with c times each place compared and taken away, a constant each: the whole
   * part's quotient bits straight to their place 16 higher; then the remainder, below c, moved up as far as stays under
   * 2^32 (a bit tested, its new place added) and divided again, until the sixteen bits below the point are found.
   */
  fixedOverConst(target: string, x: Linear, c: number, rx: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.fixed++;
    const m = Math.abs(c | 0);
    if (m === 0) return this.write(target, { c: 0, terms: [] });
    const negC = (c | 0) < 0, negX = !(rx && rx[0] >= 0);
    const most = rx ? Math.max(Math.abs(rx[0]), Math.abs(rx[1])) : SIGN, top = width([0, most]) - 1;
    const cTop = width([0, m]) - 1, chunk = Math.max(1, 31 - cTop);
    const from = this.beginFed(at), key = `${this.key}.fq${this.n++}`, out = `${key}.o`, rem = `${key}.r`;
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    this.bySign(rem, this.multiple(x, "fx"), negX, (minus) => {
      const s = minus !== negC ? MAX : 1;
      const step = (i: number, weight: number) => {
        const acts: Act[] = [{ dword: { temp: rem }, modifier: "subtract", value: m * 2 ** i }];
        if (u(weight)) acts.push({ dword: { temp: out }, modifier: "add", value: mul(u(weight), s) });
        this.push({ conds: [{ dword: { temp: rem }, compare: "atLeast", value: m * 2 ** i }], items: acts.map((act) => ({ act })), at });
      };
      // The whole part, from the highest multiple of c |x| can reach.
      const wholeTop = top >= cTop ? Math.min(31 - cTop, top - cTop) : -1;
      for (let hi = wholeTop; hi >= 0; hi -= 8) {
        const lo = Math.max(0, hi - 7), past = this.label("fg");
        if (wholeTop > 7) this.branch([{ dword: { temp: rem }, compare: "atMost", value: m * 2 ** lo - 1 }], past, at);
        for (let i = hi; i >= lo; i--) step(i, 2 ** (i + 16));
        this.land(past);
      }
      // Below the point: the remainder, below c, moved up k places at a time (a bit from its top down, each landing
      // where nothing is yet), and divided again.
      for (let done = 0; done < 16;) {
        const k = Math.min(chunk, 16 - done);
        for (let bit = cTop; bit >= 0; bit--) this.push({ conds: [{ dword: { temp: rem }, compare: "atLeast", value: 1, mask: u(2 ** bit) }], items: [{ act: { dword: { temp: rem }, modifier: "add", value: u(2 ** (bit + k) - 2 ** bit) } }], at });
        done += k;
        for (let i = k - 1; i >= 0; i--) step(i, 2 ** (i + 16 - done));
      }
    }, at);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * a × b / 65 536 towards zero, of two numbers with a fraction. With t the side the ranges leave fewer bits and s the
   * other, of the magnitudes, t × s / 65 536 is th × s + tl × sh plus tl × sl / 65 536 (h and l the halves above and
   * below the point): one loop of as many steps as tl has bits (sixteen at most) reads a bit of th and the same bit of
   * tl at once — t doubled a step in a doubling trigger, bits 31 and 15 tested where they now are — and doubles two sums
   * there, w gathering th × s + tl × sh and z gathering tl × sl, whose bits from 16 up are added to w at the end. The
   * Python side's loop, with s, sh and sl set into the two triggers that add them and nothing routed a step.
   */
  fixedProduct(target: string, a: Linear, b: Linear, ra: Range | undefined, rb: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.fixed++;
    const bitsOf = (r?: Range) => (r ? width([0, Math.max(Math.abs(r[0]), Math.abs(r[1]))]) : 32);
    const [t, s, rt, rs] = bitsOf(rb) <= bitsOf(ra) ? [b, a, rb, ra] : [a, b, ra, rb];
    const wt = bitsOf(rt), ws = bitsOf(rs), steps = Math.min(16, Math.max(1, wt));
    const negT = !(rt && rt[0] >= 0), negS = !(rs && rs[0] >= 0);
    const from = this.beginFed(at), T = this.multiple(t, "ft"), S = this.multiple(s, "fs");
    const key = `${this.key}.fp${this.n++}`, out = `${key}.o`, neg = `${key}.neg`, count = `${key}.c`;
    const R = this.label("fr"), SA = this.label("fa"), SB = this.label("fb"), E = this.label("fe"), done = this.label("fdone");
    const w: Dword = { at: R, field: { act: 0, part: "value" } }, z: Dword = { at: R, field: { act: 1, part: "value" } }, x: Dword = { at: R, field: { act: 2, part: "value" } };
    const high = wt > 16, sHasHigh = ws > 16, head = high ? SA : SB;
    // (SB adds sh to w only when s can have bits from 16 up; sl to z always.)
    const sAll: Dword = { at: SA, field: { act: 0, part: "value" } }, sHigh: Dword = { at: SB, field: { act: 0, part: "value" } }, sLow: Dword = { at: SB, field: { act: sHasHigh ? 1 : 0, part: "value" } };
    // |t| into the doubling trigger's cell, |s| into the triggers that add it (sl masked; sh from |s|'s bits from 16 up).
    this.setTo(x, T, at);
    const sTo = high ? sAll : sLow;
    this.setTo(sTo, S, at);
    if (high) this.setTo(sLow, S, at);
    this.push({ conds: [], items: [{ act: { dword: w, modifier: "set", value: 0 } }, { act: { dword: z, modifier: "set", value: 0 } }, ...(sHasHigh ? [{ act: { dword: sHigh, modifier: "set", value: 0 } } as Item] : []), { act: { dword: { temp: count }, modifier: "set", value: 0 } }, { act: { dword: { temp: neg }, modifier: "set", value: 0 } }, { act: { dword: nextOf(R), modifier: "set", value: { label: head } } }], at });
    const negate = (d: Dword, m: Multiple, flag: number) => this.push({ conds: [{ dword: d, compare: "atLeast", value: 1, mask: SIGN }], items: [{ act: { dword: d, modifier: "set", value: MAX } }, { act: this.times(d, m, 1, "subtract") }, { act: { dword: d, modifier: "add", value: 1 } }, { act: { dword: { temp: neg }, modifier: "add", value: flag } }], at });
    if (negT) negate(x, T, 1);
    if (negS) {
      // (Its sign tested once, in the first field: the other's negation goes with it.)
      const pos = this.label("fsp");
      this.branch([{ dword: sTo, compare: "atMost", value: SIGN - 1 }], pos, at);
      this.push({ conds: [], items: [...(high ? [sAll, sLow] : [sLow]).flatMap((d) => [{ act: { dword: d, modifier: "set", value: MAX } } as Item, { act: this.times(d, S, 1, "subtract") } as Item, { act: { dword: d, modifier: "add", value: 1 } } as Item]), { act: { dword: { temp: neg }, modifier: "add", value: 2 } }], at });
      this.land(pos);
    }
    if (sHasHigh) for (let k = Math.min(31, ws - 1); k >= 16; k--) this.push({ conds: [{ dword: sTo, compare: "atLeast", value: 1, mask: u(2 ** k) }], items: [{ act: { dword: sHigh, modifier: "add", value: 2 ** (k - 16) } }], at });
    this.push({ conds: [], items: [{ act: { dword: sLow, modifier: "set", value: 0, mask: 0xffff0000 } }], next: head, at });
    // The loop: the adds for the bits now at the top of tl (and of th), the end, the doublings.
    const lowBit = 2 ** (Math.min(16, Math.max(1, wt)) - 1);
    if (high) this.push({ label: SA, conds: [{ dword: x, compare: "atLeast", value: 1, mask: SIGN }], items: [{ act: { dword: w, modifier: "add", value: 0 } }], next: SB, at });
    this.push({ label: SB, conds: [{ dword: x, compare: "atLeast", value: 1, mask: u(lowBit) }], items: [...(sHasHigh ? [{ act: { dword: w, modifier: "add", value: 0 } } as Item] : []), { act: { dword: z, modifier: "add", value: 0 } }], next: E, at });
    this.push({ label: E, conds: [{ dword: { temp: count }, compare: "exactly", value: steps - 1 }], items: [{ act: { dword: nextOf(E), modifier: "set", value: { label: done } } }], next: R, at });
    let r = this.restores.get(done);
    if (!r) this.restores.set(done, (r = []));
    r.push({ branch: E, to: R });
    this.push({ label: R, conds: [], items: [{ act: { dword: w, modifier: "add", value: 0 } }, { act: { dword: z, modifier: "add", value: 0 } }, { act: { dword: x, modifier: "add", value: 0 } }, { act: { dword: { temp: count }, modifier: "add", value: 1 } }], next: head, keep: true, at });
    // z's bits from 16 up into w; w out, negated when one side was below zero.
    this.land(done);
    for (let k = 31; k >= 16; k--) this.push({ conds: [{ dword: z, compare: "atLeast", value: 1, mask: u(2 ** k) }], items: [{ act: { dword: w, modifier: "add", value: 2 ** (k - 16) } }], at });
    // (The doubling trigger moves no next pointer of its own: its count adds 1 while w comes out, which nothing reads.)
    this.takeOut(R, null, [{ act: 0, temp: out }], negT || negS ? [{ dword: { temp: neg }, compare: "atLeast", value: 1 }, { dword: { temp: neg }, compare: "atMost", value: 2 }] : null, at);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * a / b or a % b of two values: long division with the remainder doubling (`doubler`, which also doubles the
   * quotient) — a step a bit of the dividend's magnitude: the bit added to the remainder, then one trigger shared by
   * every step taking b from it when it fits and adding 1 to the quotient. b's magnitude is set into that trigger's two
   * fields before the steps — two, whatever the number of steps, no place of b in each. A dividend below zero is read as itself less 1, whose clear bits are its magnitude's set ones (a run of
   * steps of its own); the answer is negated as it comes out. Groups of eight leading zeros are jumped over. About 80 ns
   * a step, and only as many steps as the dividend has bits; eudplib's division routes the divisor into two fields of
   * each of 32 steps first, doubling it each time, whatever the numbers: about 6.5 µs.
   */
  divide(target: string, op: "/" | "%", a: Linear, b: Linear, unsigned: boolean, ra: Range | undefined, rb: Range | undefined, apart: boolean, at?: At, dividend: "value" | "fixed" | "constant" | "ratio" = "value"): void {
    emitterCounts.quotients++;
    // (`fixed`: a × 65 536 / b of numbers with a fraction — the dividend's bits, then sixteen clear ones; `constant`: of
    // a constant over a value, the constant's bits, known; `ratio`: a × 65 536 / b of two numbers from 0 up, a at most
    // b — a step for the whole of a, its remainder a or 0, then the sixteen clear ones: 17 steps.)
    const D = dividend === "constant" ? BigInt(Math.abs(a.c | 0)) << 16n : 0n;
    if (dividend === "constant" && D === 0n) return this.write(target, { c: 0, terms: [] });
    const signed = !unsigned, negA = signed && dividend !== "constant" && (!ra || ra[0] < 0), negB = signed && (!rb || rb[0] < 0);
    const from = this.beginFed(at), Am: Multiple = dividend === "constant" ? { id: "", k: 0, c: 0 } : this.multiple(a, "va"), Bm = this.multiple(b, "vb");
    const key = `${this.key}.v${this.n++}`, out = `${key}.o`, neg = `${key}.neg`, am = `${key}.a`;
    const R = this.label("vr"), T = this.label("vt"), done = this.label("vdone"), joined = this.label("vout");
    const rem: Dword = { at: R, field: { act: 0, part: "value" } }, q: Dword = { at: R, field: { act: 1, part: "value" } };
    const cells = op === "/" ? [rem, q] : [rem];
    // b straight into the shared step's two fields (and tested there), a into the cell its bits are tested in.
    const divisor: Dword[] = [{ at: T, field: { cond: 0 } }, { at: T, field: { act: 0, part: "value" } }];
    for (const f of divisor) this.setTo(f, Bm, at);
    if (dividend !== "constant" && dividend !== "ratio") this.setTo({ temp: am }, Am, at);
    // (The shared step goes back to the doubling trigger until the last step points it at the end.)
    this.push({ conds: [], items: [{ act: { dword: { temp: neg }, modifier: "set", value: dividend === "constant" && (a.c | 0) < 0 ? 1 : 0 } }, { act: { dword: nextOf(T), modifier: "set", value: { label: R } } }, ...cells.map((d) => ({ act: { dword: d, modifier: "set", value: 0 } as Act }))], at });
    // By 0, 0; read from 0 up, a divisor past 2^31 fits once at most (and doubling the remainder could pass 32 bits);
    // below zero, its magnitude.
    const zero = this.label("vz"), big = this.label("vbig");
    this.branch([{ dword: divisor[0], compare: "exactly", value: 0 }], zero, at);
    if (unsigned && !(rb && rb[0] >= 0)) this.branch([{ dword: divisor[0], compare: "atLeast", value: SIGN + 1 }], big, at);
    if (negB) {
      const bdone = this.label("vbd");
      this.branch([{ dword: divisor[0], compare: "atMost", value: SIGN - 1 }], bdone, at);
      this.push({ conds: [], items: [...divisor.flatMap((f) => [{ act: { dword: f, modifier: "set", value: MAX } as Act }, { act: this.times(f, Bm, 1, "subtract") }, { act: { dword: f, modifier: "add", value: 1 } as Act }]), { act: { dword: { temp: neg }, modifier: "add", value: 2 } }], at });
      this.land(bdone);
    }
    // The dividend's bits, and into the steps: n of a, and of a fixed quotient sixteen more, all N of the steps.
    const most = unsigned ? (ra && ra[0] >= 0 ? ra[1] : MAX) : ra ? Math.max(Math.abs(ra[0]), Math.abs(ra[1])) : SIGN;
    const n = dividend === "constant" ? D.toString(2).length : dividend === "ratio" ? 1 : Math.max(1, width([0, most]));
    const N = n + (dividend === "fixed" || dividend === "ratio" ? 16 : 0);
    const plus = Array.from({ length: N }, () => this.label("vb")), minus = negA ? Array.from({ length: N }, () => this.label("vbm")) : [];
    if (dividend === "constant") {
      // Where the divisor first fits: steps before i (2^i ≤ |b|, a group of four of its bits at a time) take nothing, so
      // the remainder starts as the constant's first i bits.
      const zeroQ = this.label("vzq");
      for (let g = 7; g >= 0; g--) {
        const e = this.label("ve"), i = 4 * g;
        this.branch([{ dword: divisor[0], compare: "atLeast", value: 2 ** i }], e, at);
        const after = this.label("va");
        this.goto(after);
        if (i >= N) this.push({ label: e, conds: [], items: [], next: zeroQ, keep: true, at });
        // (The steps are entered at their bit, past the doubling before it: the remainder twice the first i bits.)
        else this.push({ label: e, conds: [], items: [{ act: { dword: rem, modifier: "set", value: Number(D >> BigInt(N - i)) * 2 } }, { act: { dword: nextOf(R), modifier: "set", value: { label: plus[i] } } }], next: plus[i], at });
        this.land(after);
      }
      this.goto(zero);
      this.land(zeroQ);
      this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], next: joined, at });
    } else if (dividend === "ratio") {
      // (a into the remainder, and straight to the shared step: the doubling trigger, pointed at the first step's place,
      // moves on to the second.)
      this.setTo(rem, Am, at);
      this.push({ conds: [], items: [{ act: { dword: nextOf(R), modifier: "set", value: { label: plus[0] } } }], next: T, at });
    } else if (negA) {
      const below = this.label("van");
      this.branch([{ dword: { temp: am }, compare: "atLeast", value: 1, mask: SIGN }], below, at);
      this.enter(n, (i) => plus[i], R, (k) => ({ dword: { temp: am }, compare: "atLeast", value: 2 ** k }), at);
      this.land(below);
      this.push({ conds: [], items: [{ act: { dword: { temp: am }, modifier: "subtract", value: 1 } }, { act: { dword: { temp: neg }, modifier: "add", value: 1 } }], at });
      this.enter(n, (i) => minus[i], R, (k) => ({ dword: { temp: am }, compare: "atMost", value: MAX - 2 ** k }), at);
    } else this.enter(n, (i) => plus[i], R, (k) => ({ dword: { temp: am }, compare: "atLeast", value: 2 ** k }), at);
    // A step's bit, in its run; the last step's place in the run is a trigger pointing the shared step at the end, which
    // goes on to the last bit, laid out after.
    const lastBits: [string, boolean][] = [];
    const bit = (label: string, set: boolean, i: number): Proto => {
      // (A known bit: 1 added, or nothing; past a's bits, a fixed quotient's sixteen clear ones: nothing.)
      if (dividend === "constant" || dividend === "ratio" || i >= n) {
        const one = dividend === "constant" && ((D >> BigInt(N - 1 - i)) & 1n) === 1n;
        return this.push({ label, conds: [], items: one ? [{ act: { dword: rem, modifier: "add", value: 1 } }] : [], next: T, keep: true, at });
      }
      return this.push({
        label, conds: [{ dword: { temp: am }, compare: set ? "atLeast" : "exactly", value: set ? 1 : 0, mask: u(2 ** (n - 1 - i)) }],
        items: [{ act: { dword: rem, modifier: "add", value: 1 } }], next: T, at,
      });
    };
    for (const [list, set] of [[plus, true], [minus, false]] as const) list.forEach((label, i) => {
      if (i + 1 < N) return void bit(label, set, i);
      const last = this.label("vlast");
      this.push({ label, conds: [], items: [{ act: { dword: nextOf(T), modifier: "set", value: { label: done } } }], next: last, at });
      lastBits.push([last, set]);
    });
    for (const [label, set] of lastBits) bit(label, set, N - 1);
    this.rows.push(...[plus, minus].filter((r) => r.length));
    this.push({ label: T, conds: [{ dword: rem, compare: "atLeast", value: 0 }], items: [{ act: { dword: rem, modifier: "subtract", value: 0 } }, ...(op === "/" ? [{ act: { dword: q, modifier: "add", value: 1 } } as Item] : [])], next: R, at });
    this.doubler(R, cells, plus[0], at);
    this.land(done);
    const negative: Cond[] = op === "/" ? [{ dword: { temp: neg }, compare: "atLeast", value: 1 }, { dword: { temp: neg }, compare: "atMost", value: 2 }] : [{ dword: { temp: neg }, compare: "atLeast", value: 1, mask: 1 }];
    this.takeOut(R, cells.length, [{ act: op === "/" ? 1 : 0, temp: out }], signed ? negative : null, at);
    this.goto(joined);
    if (unsigned && !(rb && rb[0] >= 0)) {
      // (Read from 0 up: the quotient 1 when b fits, the remainder a less b then.)
      this.land(big);
      this.push({ conds: [], items: [{ act: op === "/" ? { dword: { temp: out }, modifier: "set", value: 0 } : this.times({ temp: out }, Am, 1, "set") }], at });
      const fits = this.against({ temp: am }, "atLeast", Bm);
      this.push({ conds: [fits], items: [{ act: op === "/" ? { dword: { temp: out }, modifier: "set", value: 1 } : this.times({ temp: out }, Bm, 1, "subtract") }], at });
      this.goto(joined);
    }
    this.land(zero);
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    this.land(joined);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /** A map of our own's regions of cell triggers for its arrays, by id: one for each array a statement reaches. */
  regions = new Map<string, Region>();
  region(a: ArrayDecl): void {
    if (!this.regions.has(a.id)) this.regions.set(a.id, { id: a.id, cells: Math.max(1, a.length), ...(a.values ? { values: a.values.map(u) } : {}) });
  }

  /** A sum as one variable: itself when it is one, else a variable of the emitter's own it is written into. */
  alone(l: Linear, name: string): string {
    if (l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) return l.terms[0].id;
    const id = `${this.key}.${name}${this.n++}`;
    this.own.add(id);
    this.write(id, l, false);
    return id;
  }

  /**
   * A sum as one variable whose places will be fields no refresh reaches — a store's destination or number, a jump's
   * next pointer, a frame's cell: `alone`'s on the Python side; in a map of our own always a variable of the emitter's
   * own, written just before. Where that stands for a variable of the program's, the graph puts the variable itself
   * back in the fields (`fuse`) unless the plan copies it: the variable of the emitter's own is there for the few whose
   * places would run into the thousands, which the plan copies and so reads where they are used.
   */
  pin(l: Linear, name: string): string {
    const id = `${this.key}.${name}${this.n++}`;
    this.own.add(id);
    this.write(id, l, false);
    if (l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) this.pins.set(id, l.terms[0].id);
    return id;
  }

  /** A variable of the emitter's own (`pin`) replaced by the variable it stands for, everywhere: its places, its write gone. */
  fuse(own: string, by: string, pinned: Set<string>): void {
    const was = this.placesOf(own), home = was[0].dword!, to = this.placesOf(by);
    to.push(...was.slice(1));
    this.places.delete(own);
    const key = JSON.stringify(home);
    for (const p of this.protos) {
      p.conds = p.conds.map((c) => (JSON.stringify(c.dword) === key ? { ...c, dword: to[0].dword! } : c));
      p.items = p.items.filter((it) => !("write" in it && it.write.target === own));
    }
    this.writes.delete(own);
    const rename = <R extends { id: string }>(r: R | undefined): R | undefined => (r && r.id === own ? { ...r, id: by } : r);
    for (const [label, r] of this.jumpReads) this.jumpReads.set(label, rename(r)!);
    for (const [act, ap] of this.actPlaces) this.actPlaces.set(act, Object.fromEntries(Object.entries(ap).map(([part, r]) => [part, rename(r)])));
    for (const [c, r] of this.condReads) this.condReads.set(c, rename(r)!);
    for (const [c, r] of this.condPlayers) this.condPlayers.set(c, rename(r)!);
    this.own.delete(own);
    pinned.delete(own);
    pinned.add(by);
  }

  /**
   * A cell of an array a map of our own keeps, into `target`: a trigger that sets a scratch cell to 0, points the cell
   * trigger's action at it and its next pointer back here, and goes to it — the three a place of the index (its
   * destination and next pointer 18 EPD a cell apart, the cell 72 bytes) — and then the scratch cell into every place
   * of the target (`graph` reads the cell straight into the target instead when its cell is its only place). An index
   * outside the array (read from 0 up; a window's own index against its own length) reads 0; one the value ranges know
   * is inside is not tested.
   */
  readCell(target: string, t: Table, at?: At): void {
    const a = t.array;
    this.region(a);
    const index = this.pin(t.index, "ci");
    const temp = `${this.key}.ct${this.n++}`, after = this.label("cget"), out = this.label("cout"), jump = this.label("cjmp");
    if (!t.safe) {
      const guard = t.guard ? this.alone(t.guard, "cg") : index;
      this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: guard }, right: { kind: "const", value: t.limit ?? a.length }, unsigned: true, at: at!, label: "" } as BoolExpr, true, out, at);
    }
    const point: Act = { dword: { element: a.id }, modifier: "set", value: { epd: { temp } } };
    const back: Act = { dword: { element: a.id }, modifier: "set", value: { label: after } };
    this.actPlaces.set(point, { dest: { id: index, scale: VARRAY_STRIDE_EPD, add: -1, base: a.id } });
    this.actPlaces.set(back, { dest: { id: index, scale: VARRAY_STRIDE_EPD, add: -86, base: a.id } });
    this.push({ label: jump, conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }, { act: point }, { act: back }], next: after, keep: true, at });
    this.jumpReads.set(jump, { id: index, scale: 72, add: 0, base: `addr:${a.id}` });
    if (!t.safe) {
      this.land(out);
      this.push({ conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }], next: after, at });
    }
    this.land(after);
    this.open().items.push({ fill: { temp, target } });
  }

  /**
   * An array declared (a map of our own): each cell set to its value from the list, or all to the one value (`fill`) —
   * a constant as it is, anything else into a variable of the emitter's own whose places the cells' actions are. 64 to
   * a trigger, each trigger of them alone: an action's place is its index in its trigger.
   */
  declareArray(s: Extract<Stmt, { kind: "declareArray" }>): void {
    const a = this.scope.arrays.get(s.array)!;
    this.region(a);
    const fill = s.fill !== undefined ? linear(s.fill as NumExpr)! : null;
    const fillFrom = fill && fill.terms.length ? this.pin(fill, "fv") : null;
    const acts: Act[] = [];
    for (let i = 0; i < a.length; i++) {
      const v = fill ?? (s.init?.[i] !== undefined ? linear(s.init[i] as NumExpr)! : { c: 0, terms: [] });
      const from = fill ? fillFrom : v.terms.length ? this.pin(v, "iv") : null;
      const act: Act = { dword: { cell: a.id, index: i }, modifier: "set", value: from ? 0 : v.c };
      if (from) this.actPlaces.set(act, { value: { id: from, scale: 1, add: 0 } });
      acts.push(act);
    }
    for (let i = 0; i < acts.length; i += MOST_ACTS) this.push({ conds: [], items: acts.slice(i, i + MOST_ACTS).map((act) => ({ act })) });
    this.push({ conds: [], items: [] });
  }

  /**
   * A store into a cell of an array: one trigger, its condition the index inside the array (read from 0 up: one below
   * zero is past the end, where a store does nothing), its action setting the cell — the action's destination a place
   * of the index (the EPD of the first cell's value, plus the index times the EPD between cells), its number a place
   * of the value. An index or a value that is more than a variable goes into a variable of the emitter's own first.
   */
  store(st: Store): void {
    const stride = VARRAY_STRIDE_EPD;
    this.region(st.array);
    const index = this.pin(st.index, "si");
    // A map of our own: the cell itself plus a constant or a variable — `xs[i] += 1`, `hp[i] -= damage` — is that added
    // to the cell where it is: one action, the cell not read.
    const same = (a: Linear, b: Linear) => u(a.c) === u(b.c) && a.terms.length === b.terms.length && a.terms.every((t) => b.terms.some((x) => x.id === t.id && u(x.k) === u(t.k)));
    // (And another cell — `q.x += q.dx`, a field of a record and another's — read first, straight into the addition.)
    const self = st.reads.find((r) => r.table?.jump && !r.table.guard && r.table.array.id === st.array.id && same(r.table.index, st.index));
    const rest = self && st.reads.length <= 2 && st.value.terms.filter((t) => t.id === self.id).length === 1 && st.value.terms.find((t) => t.id === self.id)!.k === 1 ? { c: st.value.c, terms: st.value.terms.filter((t) => t.id !== self.id) } : undefined;
    const other = st.reads.find((r) => r !== self);
    if (self && rest && rest.terms.length <= 1 && (!other || (rest.terms.length === 1 && rest.terms[0].id === other.id && !!other.table))) {
      let by = rest.terms[0];
      if (other) {
        const id = `${this.key}.${other.id.slice(1)}`;
        this.own.add(id);
        if (other.table!.jump) this.scope.heavy.add(id);
        this.readTable(id, other.table!, this.at);
        by = { id, k: by.k };
      }
      const from = by ? this.pin({ c: 0, terms: [{ id: by.id, k: 1 }] }, "sv") : null;
      const act: Act = { dword: { element: st.array.id }, modifier: "add", value: from ? 0 : rest.c };
      this.actPlaces.set(act, { dest: { id: index, scale: stride, add: 0, base: st.array.id }, ...(from ? { value: { id: from, scale: by.k, add: rest.c } } : {}) });
      if (st.safe) { this.push({ conds: [], items: [{ act }] }); return; }
      const g = st.guard ? this.alone(st.guard, "sg") : index;
      this.push({ conds: [{ dword: this.home(g, 0), compare: "atMost", value: (st.limit ?? st.array.length) - 1 }], items: [{ act }] });
      return;
    }
    const own = new Map(st.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
    for (const r of st.reads) {
      this.own.add(own.get(r.id)!);
      if (r.arith || r.table?.jump) this.scope.heavy.add(own.get(r.id)!);
      if (r.table) this.readTable(own.get(r.id)!, r.table, this.at);
      else if (r.shift) this.readShift(own.get(r.id)!, { ...r.shift, of: { c: r.shift.of.c, terms: r.shift.of.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) } }, this.at);
      else this.arith(own.get(r.id)!, r.arith!, own, this.at);
    }
    const value: Linear = { c: st.value.c, terms: st.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
    let from: string | null = null, plus = 0;
    // (One variable once and a constant, in a map of our own: the store's number a place of the variable, plus the
    // constant — no variable of its own for the sum.)
    if (value.terms.length === 1 && value.terms[0].k === 1) { from = this.pin({ c: 0, terms: value.terms }, "sv"); plus = value.c; }
    else if (value.terms.length) from = this.pin(value, "sv");
    const act: Act = { dword: { element: st.array.id }, modifier: "set", value: from ? 0 : value.c };
    this.actPlaces.set(act, { dest: { id: index, scale: stride, add: 0, base: st.array.id }, ...(from ? { value: { id: from, scale: 1, add: plus } } : {}) });
    // (A window's guard is its own index against its own length. One the value ranges know is inside tests nothing,
    // and the writes after it go in its trigger.)
    if (st.safe) { this.push({ conds: [], items: [{ act }] }); return; }
    const guard = st.guard ? this.alone(st.guard, "sg") : index;
    this.push({ conds: [{ dword: this.home(guard, 0), compare: "atMost", value: (st.limit ?? st.array.length) - 1 }], items: [{ act }] });
  }

  // ── the writes, once every place is known ──

  /**
   * The variables that are copied into their places after each write, and the order the others' writes are expanded
   * in. A write of x reads y into an action for each place of x, and each of those is a place of y: so y's writes are
   * expanded after x's. Where that goes round — x set from itself other than by adding, x and y reading each other —
   * the variables of the loop are copied instead: their writes go to their cells alone, and a copy after each write
   * fills the rest of their places (a routed read each, as eudplib's every read is).
   */
  plan(pinned = new Set<string>()): { copied: Set<string>; order: string[] } {
    const readers = new Map<string, Set<string>>(); // v → the targets whose writes read v
    const copied = new Set<string>([...this.forced, ...this.results, ...[...this.scope.decls.values()].filter((d) => d.routed).map((d) => d.id)]);
    for (const [target, ws] of this.writes) for (const w of ws) {
      const self = w.value.terms.filter((t) => t.id === target);
      if (self.length && self[0].k !== 1) copied.add(target);
      for (const t of w.value.terms) {
        // (A write only an error goes through reads its values from their cells: no place of them, `cold`.)
        if (t.id === target || (w.cold && this.hasCell(t.id))) continue;
        if (!readers.has(t.id)) readers.set(t.id, new Set());
        readers.get(t.id)!.add(target);
      }
    }
    // Every loop of the graph of reads (Tarjan's strongly connected parts of more than one variable) broken by copies.
    // The Python side's loops copy every variable of a part (a copy there is a routed read a place). A map of our own
    // copies as few as it can — a copy there is a trigger a bit — the variable whose writes are fewest, each weighed by
    // the loops around it, and then the part again without it: calls make such loops whenever what a function gives
    // back reaches its own parameters (`pick(a, pick(b, c))`, `i = next(i)`), and one copy breaks each.
    const strong = (nodes: Set<string>): string[][] => {
      const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out: string[][] = [];
      let n = 0;
      const connect = (v: string): void => {
        index.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
        for (const w of readers.get(v) ?? []) {
          if (!nodes.has(w)) continue;
          if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        if (low.get(v) === index.get(v)) {
          const part: string[] = [];
          for (let w = stack.pop()!; ; w = stack.pop()!) { on.delete(w); part.push(w); if (w === v) break; }
          out.push(part);
        }
      };
      for (const v of nodes) if (!index.has(v)) connect(v);
      return out;
    };
    const weight = new Map<string, number>();
    for (const p of this.protos) for (const it of p.items) if ("write" in it) weight.set(it.write.target, (weight.get(it.write.target) ?? 0) + 4 ** (p.depth ?? 0));
    const breakUp = (nodes: Set<string>): void => {
      for (const part of strong(nodes)) {
        if (part.length < 2) continue;
        // (Copying the program's variables of a loop breaks it: the emitter's own have no cell to copy from.)
        const real = part.filter((x) => !this.own.has(x) && !isTemp(x));
        const candidates = real.length ? real : part;
        const pick = candidates.reduce((a, b) => ((weight.get(b) ?? 0) < (weight.get(a) ?? 0) ? b : a));
        copied.add(pick);
        breakUp(new Set(part.filter((x) => x !== pick)));
      }
    };
    breakUp(new Set([...this.writes.keys(), ...readers.keys()].filter((v) => !copied.has(v))));
    // The rest in order: a variable after every target whose writes read it, the copied ones being no target (their
    // writes have one place each, whatever their places are).
    const out: string[] = [...copied].filter((v) => this.writes.has(v)), done = new Set<string>(out);
    const visit = (v: string): void => {
      if (done.has(v)) return;
      done.add(v);
      for (const t of readers.get(v) ?? []) if (!copied.has(t)) visit(t);
      out.push(v);
    };
    for (const v of this.writes.keys()) visit(v);
    // A map of our own: places counted in that order — a variable's own, and for each write that reads it, one for
    // each place of the target (one, a target that is copied) — and a variable that would have more than a trigger's
    // worth copied instead, so that it is read where it is used (routed). Every place of a target that reads it is a
    // place of it, so along a run of variables each set from the one before, places multiply; arrays and the values
    // functions give back make such runs, which reached thousands of places before. (Not a variable a store's or a
    // jump's fields hold: those are never refreshed where they are read.)
    {
      const count = new Map<string, number>();
      for (const v of out) {
        let n = this.places.get(v)?.length ?? 1;
        for (const t of readers.get(v) ?? []) for (const w of this.writes.get(t) ?? []) {
          const k = w.value.terms.filter((x) => x.id === v).length;
          n += copied.has(t) ? k : k * (count.get(t) ?? 1);
        }
        count.set(v, n);
        if (n > MOST_ACTS && !pinned.has(v) && !this.scope.decls.get(v)?.everywhere) copied.add(v);
      }
      // A variable written in a loop and read only outside it — a sum a loop adds to and a print reads once after it — is
      // kept in its cell alone and read where it is used (graph(): routed): each write one action, not one for each
      // place, and a value read from a cell into it no copy into each. Its writes against what refreshing its places
      // where they are read would cost, each weighed by how deep in the loops it is (four turns of the loop outside
      // for one inside), in actions: a write is one a place; a refresh of a place about five (a trigger pointing the cell,
      // the cell's own, one back), of a place that holds a multiple of it about forty (a trigger a bit it can have).
      const protoBy = new Map(this.protos.map((p) => [p.label, p]));
      const depth = (label: string) => 4 ** (protoBy.get(label)?.depth ?? 0);
      // (Not what a called function names: its body is laid out outside the loops it is called from, so its reads look
      // fewer than they are — its parameters', its result's, and the program's variables it reads.)
      const inFunctions = this.scope.inFunctions();
      const writesAt = new Map<Write, number>();
      for (const p of this.protos) for (const it of p.items) if ("write" in it) writesAt.set(it.write, 4 ** (p.depth ?? 0));
      for (const v of out) {
        // (Only the program's own variables: what the emitter makes for itself — a routine's working cells — it lays out
        // as it needs them.)
        if (copied.has(v) || pinned.has(v) || this.own.has(v) || isTemp(v) || !this.scope.decls.has(v) || inFunctions.has(v) || this.scope.decls.get(v)?.everywhere) continue;
        const ps = this.places.get(v) ?? [];
        const n = count.get(v) ?? 1;
        if (n <= 2) continue;
        let read = 0, deepestRead = 0;
        for (const pl of ps.slice(1)) {
          const d = pl.dword && "at" in pl.dword ? depth(pl.dword.at) : 1;
          deepestRead = Math.max(deepestRead, d);
          read += d * (pl.scale === 1 ? 5 : 40);
        }
        // (Read in another's write, it is refreshed into each place of that one — its cell alone, when that one is copied
        // — at that one's multiple of it.)
        for (const t of readers.get(v) ?? []) for (const w of this.writes.get(t) ?? []) {
          const k = w.value.terms.filter((x) => x.id === v);
          if (!k.length) continue;
          deepestRead = Math.max(deepestRead, writesAt.get(w) ?? 1);
          const into = copied.has(t) ? [{ scale: 1 }] : this.places.get(t) ?? [{ scale: 1 }];
          for (const pl of into) for (const x of k) read += (writesAt.get(w) ?? 1) * (u(pl.scale * x.k) === 1 ? 5 : 40);
        }
        // (Only when every read is outside the deepest loop it is written in, as a sum's is: one written and read in the
        // same loop pays a refresh at each turn for each write it saves.)
        const deepestWrite = Math.max(0, ...(this.writes.get(v) ?? []).map((w) => writesAt.get(w) ?? 1));
        if (deepestRead < deepestWrite && read < (weight.get(v) ?? 0) * (n - 1)) copied.add(v);
      }
    }
    return { copied, order: out };
  }

  /**
   * A write expanded: for every place of the target, the actions that make it the new value — the place's multiple of
   * each part. Only adds and sets: the game's subtract stops at 0, so a part taken away is its negation added.
   */
  expand(w: Write, copied: boolean): WriteAct[] {
    const out: WriteAct[] = [];
    // x = x + …: added where it is. (A copied x may read itself otherwise: its write has its cell alone, and the
    // places it reads x from are filled by the copy after.)
    const inPlace = w.value.terms.some((t) => t.id === w.target && t.k === 1);
    const terms = inPlace ? w.value.terms.filter((t) => t.id !== w.target) : w.value.terms;
    for (const into of copied ? this.placesOf(w.target).slice(0, 1) : this.placesOf(w.target)) {
      const c = mul(into.scale, w.value.c);
      const parts = terms.map((t) => ({ id: t.id, scale: mul(into.scale, t.k) })).filter((t) => t.scale !== 0);
      if (inPlace) {
        if (c) out.push({ into, modifier: "add", value: c });
      } else if (parts.length) {
        const first = parts.shift()!;
        out.push({ into, modifier: "set", value: 0, reads: { id: first.id, scale: first.scale, add: u(c + into.add), ...(into.base ? { base: into.base } : {}) } });
      } else out.push({ into, modifier: "set", value: num(u(c + into.add), into.base) });
      for (const t of parts) out.push({ into, modifier: "add", value: 0, reads: { id: t.id, scale: t.scale, add: 0 } });
    }
    return out;
  }

  graph(entries: string[]): Graph | string {
    // A comparison's number is a place of what it reads: its trigger keeps its label and the condition its index.
    // (In a trigger only an error goes through, refreshed from the variable's cell before it instead: `coldConds`.)
    const coldConds = new Map<string, Map<string, Place[]>>();
    for (const p of this.protos) p.conds.forEach((c, k) => {
      const r = this.condReads.get(c);
      if (r && p.cold && this.hasCell(r.id)) {
        const of = coldConds.get(p.label) ?? new Map<string, Place[]>();
        coldConds.set(p.label, of.set(r.id, [...(of.get(r.id) ?? []), { dword: { at: p.label, field: { cond: k } }, scale: r.scale, add: r.add }]));
      } else if (r) this.placesOf(r.id).push({ dword: { at: p.label, field: { cond: k } }, scale: r.scale, add: r.add });
      const q = this.condPlayers.get(c);
      if (q) this.placesOf(q.id).push({ dword: { at: p.label, field: { cond: k, part: "player" } }, scale: q.scale, add: q.add, base: q.base });
    });
    // A store's destination and number are places of its index and value: its trigger keeps its label (it has a
    // condition), its actions follow the puts-back that land there. A jump's next pointer is a place of its index.
    const pinned = new Set<string>();
    for (const [label, r] of this.jumpReads) {
      this.placesOf(r.id).push({ dword: { at: label, field: "next" }, scale: r.scale, add: r.add, base: r.base });
      pinned.add(r.id);
    }
    for (const p of this.protos) {
      let k = this.restores.get(p.label)?.length ?? 0;
      for (const it of p.items) {
        if (!("act" in it)) continue;
        const ap = this.actPlaces.get(it.act);
        if (ap) {
          for (const [part, r] of Object.entries(ap) as [ActPart, Read][]) {
            this.placesOf(r.id).push({ dword: { at: p.label, field: { act: k, part } }, scale: r.scale, add: r.add, ...(r.base ? { base: r.base } : {}) });
            pinned.add(r.id);
          }
        }
        k++;
      }
    }
    // The variables of the emitter's own standing for one of the program's in a field, the variable itself there
    // instead, unless the plan copies it.
    const first = this.plan(pinned);
    let fused = false;
    for (const [own, by] of this.pins) {
      if (first.copied.has(by) || first.copied.has(own) || !this.writes.has(own)) continue;
      this.fuse(own, by, pinned);
      fused = true;
    }
    const { copied, order } = fused ? this.plan(pinned) : first;
    // Each target's writes expanded once all its places are known — the writes that read it come first in the
    // order, and each action that reads a variable is a place of it.
    const expanded = new Map<Write, WriteAct[]>();
    /** The actions of writes only an error goes through that read a variable: refreshed from its cell before them. */
    const coldActs = new Set<WriteAct>();
    for (const v of order) for (const w of this.writes.get(v) ?? []) {
      const acts = this.expand(w, copied.has(v));
      expanded.set(w, acts);
      for (const a of acts) {
        if (!a.reads) continue;
        if (w.cold && this.hasCell(a.reads.id)) coldActs.add(a);
        else this.placesOf(a.reads.id).push({ act: a, scale: a.reads.scale, add: a.reads.add, ...(a.reads.base ? { base: a.reads.base } : {}) });
      }
    }
    // Every fall-through said, so that dropping a trigger leaves the one before it going where it went.
    this.protos.forEach((p, i) => { if (p.next === undefined) p.next = this.protos[i + 1]?.label ?? END; });
    // Empty triggers dropped: their labels stand for where they went. (Not the first when it goes elsewhere than the
    // trigger after it — the walk comes into the graph at its first trigger, so the jump would be lost: `let done =
    // false` as a program's first statement set it true.)
    const alias = new Map<string, string>();
    const kept: Proto[] = [];
    for (const [i, p] of this.protos.entries()) {
      const entry = i === 0 && p.next !== this.protos[1]?.label;
      if (p.conds.length === 0 && p.items.length === 0 && !p.keep && !entry && !this.restores.get(p.label)?.length) alias.set(p.label, p.next!);
      else kept.push(p);
    }
    const resolve = (l: string): string => {
      while (alias.has(l)) l = alias.get(l)!;
      return l;
    };
    // Routed variables: a variable whose writes would each be copied into its places (a call's result, one an island
    // writes, one copied for a loop of reads) is instead read where it is used — the dwords a trigger is about to read
    // refreshed from its cell just before it — when that is cheaper: its reads against its writes times its places,
    // each weighed by how deep in the graph's loops it is (a loop inside counted as four turns of the one outside).
    const protoOf = new Map<Write, Proto>(), protoBy = new Map(this.protos.map((p) => [p.label, p]));
    for (const p of this.protos) for (const it of p.items) if ("write" in it) protoOf.set(it.write, p);
    const writeOf = new Map<WriteAct, Write>();
    for (const [w, acts] of expanded) for (const a of acts) writeOf.set(a, w);
    const weight = (p?: Proto) => 4 ** (p?.depth ?? 0);
    const written = new Map<string, number>();
    const wrote = (id: string, by: number) => written.set(id, (written.get(id) ?? 0) + by);
    for (const p of this.protos) for (const it of p.items) {
      if ("copy" in it && copied.has(it.copy)) wrote(it.copy, weight(p));
    }
    const routed = new Set<string>();
    for (const [id, w] of written) {
      const ps = this.places.get(id) ?? [];
      if (ps.length <= 1 || pinned.has(id) || ps.some((p) => p.synced)) continue;
      let read = 0;
      for (const p of ps.slice(1)) {
        if (p.act) read += weight(protoOf.get(writeOf.get(p.act)!));
        else if (p.dword && "at" in p.dword) read += weight(protoBy.get(p.dword.at));
        else if (p.dword && "data" in p.dword) for (const q of this.protos) if (q.conds.some((c) => "data" in c.dword && c.dword.data === (p.dword as { data: string }).data)) read += weight(q);
      }
      if (read < w * (ps.length - 1) || this.scope.decls.get(id)?.routed) routed.add(id);
    }
    // What a trigger's conditions read of routed variables: the places refreshed before it.
    const condReads = (p: Proto): Map<string, Place[]> => {
      const out = new Map<string, Place[]>(coldConds.get(p.label) ?? []);
      for (const id of routed) for (const pl of this.places.get(id)!.slice(1)) {
        const d = pl.dword;
        const here = d && (("at" in d && d.at === p.label && typeof d.field === "object" && "cond" in d.field) || ("data" in d && p.conds.some((c) => "data" in c.dword && c.dword.data === d.data)));
        if (here) out.set(id, [...(out.get(id) ?? []), pl]);
      }
      return out;
    };
    // A trigger with conditions that reads routed variables is entered through its refreshes: what goes to it goes to them.
    const entry = new Map<string, string>();
    for (const p of kept) if (p.conds.length && condReads(p).size) entry.set(p.label, `${p.label}.in`);
    const to = (l: string): string => {
      const r = resolve(l);
      return entry.get(r) ?? r;
    };
    const cellOf = new Map<Place, string>();
    for (const [id, ps] of this.places) cellOf.set(ps[0], id);
    // The triggers: puts-back and actions in order, cut at 64 and around the copies.
    const triggers: Trigger[] = [];
    const at = new Map<WriteAct, Dword>();
    const later: { t: Trigger; k: number; w: WriteAct }[] = [];
    const copies: { t: Trigger; id: string }[] = [];
    const refreshes: { t: Trigger; places: (Place | WriteAct)[] }[] = [];
    const fills: { t: Trigger; target: string; apart?: boolean }[] = [];
    /** The copies into dwords of their own (`route`): their `into` is theirs, not the variable's places. */
    const routes = new Set<Trigger>();
    /** The actions whose fields are places (a store's): their trigger is the one the proto's label names. */
    const fixed = new Set<Act>();
    let n = 0;
    for (const p of kept) {
      type Piece = { acts: (Act | WriteAct)[] } | { fill: { temp: string; target: string; apart?: boolean; top?: number } } | { copy: string; at?: At; top?: number } | { refresh: string; places: (Place | WriteAct)[] } | { route: { from: string; into: Dword[]; add?: number } };
      const pieces: Piece[] = [{ acts: [] }];
      const acts = () => {
        const last = pieces[pieces.length - 1];
        if ("acts" in last) return last.acts;
        const fresh = { acts: [] };
        pieces.push(fresh);
        return fresh.acts;
      };
      for (const r of this.restores.get(p.label) ?? []) acts().push({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) } });
      for (const it of p.items) {
        if ("act" in it) {
          const a: Act = { ...it.act, value: typeof it.act.value === "object" && "label" in it.act.value ? { label: to(it.act.value.label) } : it.act.value };
          if (this.actPlaces.has(it.act)) fixed.add(a);
          acts().push(a);
        }
        else if ("write" in it) acts().push(...expanded.get(it.write)!);
        else if ("bump" in it) {
          const ps = this.placesOf(it.bump.target);
          if (!copied.has(it.bump.target) && ps.length > MOST_ACTS - 1) this.crowded.add(it.bump.target);
          for (const into of copied.has(it.bump.target) ? ps.slice(0, 1) : ps) acts().push({ into, modifier: "add", value: mul(into.scale, it.bump.add) } as WriteAct);
        }
        else if ("fill" in it) pieces.push({ fill: it.fill });
        else if ("route" in it) pieces.push({ route: it.route });
        else if ("label" in it) {
          for (const pl of this.placesOf(it.label.target).slice(this.cellless.has(it.label.target) ? 1 : 0)) {
            if (!pl.dword || pl.scale !== 1 || pl.add !== 0) throw new Error(`emitter: a place of ${it.label.target} that is no dword of its own`);
            acts().push({ dword: pl.dword, modifier: "set", value: { label: to(it.label.to) } });
          }
        }
        else if ("pointer" in it) {
          // (Every place of a variable set to a dword's EPD: the events pass's, `watch`.)
          for (const pl of this.placesOf(it.pointer.target).slice(this.cellless.has(it.pointer.target) ? 1 : 0)) {
            if (!pl.dword || pl.scale !== 1 || pl.add !== 0) throw new Error(`emitter: a place of ${it.pointer.target} that is no dword of its own`);
            acts().push({ dword: pl.dword, modifier: "set", value: { epd: it.pointer.to } });
          }
        }
        else if ("copy" in it) {
          // (A variable never below zero and at most its `top`: only the bits it can have.)
          const top = this.scope.decls.get(it.copy)?.top;
          if (copied.has(it.copy) && !routed.has(it.copy)) pieces.push({ copy: it.copy, ...(top !== undefined ? { top } : {}), ...(it.at ? { at: it.at } : {}) });
        }
      }
      if (p.conds.length && (pieces.slice(1).some((x) => !(p.guarded && "copy" in x)) || !("acts" in pieces[0]) || pieces[0].acts.length > MOST_ACTS)) {
        // (An `if` in one trigger whose writes turned out to have more places than a trigger holds: once more, as a branch.)
        if (p.guardOf) this.misfits.add(p.guardOf);
        return this.crowded.size || this.misfits.size ? "crowded" : "a branch with too many actions";
      }
      // Routed variables: an action that reads one has its number refreshed from the cell just before its trigger
      // (again after a write of the variable earlier in the same run of actions); conditions likewise.
      const cut: Piece[] = [];
      if (p.conds.length) for (const [id, ps] of condReads(p)) cut.push({ refresh: id, places: ps });
      for (const piece of pieces) {
        if (!("acts" in piece) || p.conds.length) { cut.push(piece); continue; }
        let cur: (Act | WriteAct)[] = [], need = new Map<string, WriteAct[]>(), dirty = new Set<string>();
        const coldRead = new Set([...piece.acts].filter((a): a is WriteAct => coldActs.has(a as WriteAct)).map((a) => a.reads!.id));
        const flush = () => {
          for (const [id, list] of need) cut.push({ refresh: id, places: list });
          if (cur.length) cut.push({ acts: cur });
          cur = [];
          need = new Map();
          dirty = new Set();
        };
        // A write at a time: every value it reads is the one from before it (its own target's too), so what it reads
        // is refreshed before its first action, and what it writes is stale for the writes after it.
        const groups: (Act | WriteAct)[][] = [];
        for (const a of piece.acts) {
          const w = "into" in a ? writeOf.get(a as WriteAct) : undefined;
          const last = groups[groups.length - 1];
          if (w && last && last.length && writeOf.get(last[0] as WriteAct) === w) last.push(a);
          else groups.push([a]);
        }
        for (const group of groups) {
          const reads = group.filter((a): a is WriteAct => "into" in a && !!a.reads && (routed.has(a.reads.id) || coldActs.has(a as WriteAct)));
          // (A refresh is a trigger before the actions it is for: not before an action whose fields are places, which
          // keeps the label.)
          if (reads.some((a) => dirty.has(a.reads!.id)) || (reads.length && cur.some((a) => fixed.has(a as Act)))) flush();
          for (const a of reads) need.set(a.reads!.id, [...(need.get(a.reads!.id) ?? []), a]);
          cur.push(...group);
          for (const a of group) {
            const owner = "into" in a ? cellOf.get(a.into) : undefined;
            if (owner && (routed.has(owner) || coldRead.has(owner))) dirty.add(owner);
          }
        }
        flush();
      }
      if (!cut.length) cut.push({ acts: [] });
      pieces.splice(0, pieces.length, ...cut);
      // Each piece one trigger or more: the first takes the label and the conditions, each goes to the one after it.
      const made: Trigger[] = [];
      const label = () => (made.length ? `${this.key}.cut${n++}` : entry.get(p.label) ?? p.label);
      for (const piece of pieces) {
        if ("refresh" in piece) {
          const top = this.scope.decls.get(piece.refresh)?.top;
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.refresh, into: [], ...(top !== undefined ? { top } : {}) }, ...(p.at ? { at: p.at } : {}) };
          refreshes.push({ t, places: piece.places });
          made.push(t);
          continue;
        }
        if ("route" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.route.from, into: piece.route.into.map((dword) => ({ dword, add: piece.route.add ?? 0 })) }, ...(p.at ? { at: p.at } : {}) };
          routes.add(t);
          made.push(t);
          continue;
        }
        if ("fill" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: `@${piece.fill.temp}`, into: [], ...(piece.fill.top !== undefined ? { top: piece.fill.top } : {}) }, ...(p.at ? { at: p.at } : {}) };
          fills.push({ t, target: piece.fill.target, ...(piece.fill.apart ? { apart: true } : {}) });
          made.push(t);
          continue;
        }
        if ("copy" in piece) {
          const at = piece.at ?? p.at;
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.copy, into: [], ...(piece.top !== undefined ? { top: piece.top } : {}) }, ...(at ? { at } : {}) };
          made.push(t);
          continue;
        }
        for (let i = 0; i === 0 || i < piece.acts.length; i += MOST_ACTS) {
          if (i === 0 && piece.acts.length === 0 && made.length) break;
          // (A trigger with conditions keeps its own label, entered through its refreshes when it has any.)
          const t: Trigger = { label: p.conds.length && i === 0 ? p.label : label(), conds: p.conds.length && i === 0 ? p.conds.map((c) => ({ ...c })) : [], acts: [], ...(p.at ? { at: p.at } : {}), ...(p.off && p.conds.length && i === 0 ? { off: true } : {}) };
          piece.acts.slice(i, i + MOST_ACTS).forEach((a, k) => {
            if ("into" in a) {
              at.set(a, { at: t.label, field: { act: k, part: "value" } });
              later.push({ t, k, w: a });
              const from = writeOf.get(a as WriteAct)?.at;
              t.acts.push({ dword: { game: 0 }, modifier: a.modifier, value: a.value, ...(from && from !== t.at ? { at: from } : {}) });
            } else t.acts.push(a);
          });
          made.push(t);
        }
      }
      // A copy goes on to the trigger after it; the others say where they go. The last goes where the proto went.
      const last = made[made.length - 1];
      if (last.copy) made.push({ label: `${this.key}.cut${n++}`, conds: [], acts: [] });
      made.forEach((t, i) => {
        if (t.copy) { if (!routes.has(t) && !refreshes.some((r) => r.t === t) && !fills.some((f) => f.t === t)) copies.push({ t, id: t.copy.from }); }
        else t.next = i === made.length - 1 ? to(p.next!) : made[i + 1].label;
      });
      triggers.push(...made);
    }
    // Where each write's action writes, now that every place has its dword.
    const dwordOf = (p: Place): Dword => p.dword ?? at.get(p.act!)!;
    for (const { t, k, w } of later) t.acts[k].dword = dwordOf(w.into);
    // A routed variable's refreshes: the numbers and the conditions' places about to be read.
    for (const { t, places } of refreshes) for (const pl of places) {
      if ("into" in pl) t.copy!.into.push({ dword: at.get(pl)!, add: num(pl.reads!.add, pl.reads!.base), ...(pl.reads!.scale !== 1 ? { scale: pl.reads!.scale } : {}) });
      else t.copy!.into.push({ dword: dwordOf(pl), add: num(pl.add, pl.base), ...(pl.scale !== 1 ? { scale: pl.scale } : {}) });
    }
    // A scratch cell into every place of what reads it (a variable of the emitter's own: its home too); into a routed
    // variable's cell alone, which its places are refreshed from where they are read.
    // A target with no place but its cell has the array's cell read straight into it: no scratch cell, no copy.
    const scratch = new Map<string, Act[]>(), tested = new Map<string, Cond[]>(), routedInto = new Map<string, { dword: Dword }[]>();
    for (const x of triggers) {
      for (const a of x.acts) {
        const temp = "temp" in a.dword ? a.dword.temp : typeof a.value === "object" && "epd" in a.value && "temp" in a.value.epd ? a.value.epd.temp : undefined;
        if (temp !== undefined) scratch.set(temp, [...(scratch.get(temp) ?? []), a]);
      }
      // (A product's or a quotient's scratch cell is also tested as it is worked in, and a variable may be routed into it.)
      for (const c of x.conds) if ("temp" in c.dword) tested.set(c.dword.temp, [...(tested.get(c.dword.temp) ?? []), c]);
      for (const c of x.copy?.into ?? []) if ("temp" in c.dword) routedInto.set(c.dword.temp, [...(routedInto.get(c.dword.temp) ?? []), c]);
    }
    // (What reads a variable's cell where it is: a condition, an action's number pointed at it, a copy or a route of it.)
    const cellsRead = new Set<string>();
    for (const x of triggers) {
      for (const c of x.conds) cellsRead.add(JSON.stringify(c.dword));
      for (const a of x.acts) if (typeof a.value === "object" && "epd" in a.value) cellsRead.add(JSON.stringify(a.value.epd));
      if (x.copy) cellsRead.add(JSON.stringify({ var: x.copy.from }));
    }
    const plainPlace = (p: Place) => p.scale === 1 && p.add === 0 && !p.base;
    // (A map of our own: a variable of the emitter's own whose cell nothing reads — a sum a store's number is worked out
    // in — is written there for nothing: what its writes read into that cell is no place to fill. The write stays, and
    // writes what it will.)
    const homeOf = new Map<Place, string>();
    for (const [id, ps] of this.places) if (this.own.has(id) && ps[0]?.dword && !cellsRead.has(JSON.stringify(ps[0].dword))) homeOf.set(ps[0], id);
    const dead = (pl: Place) => !!pl.act && homeOf.has(pl.act.into);
    for (const { t, target, apart } of fills) {
      const ps = this.placesOf(target).filter((pl, i) => i === 0 || !dead(pl));
      // The scratch cell folded into the one dword that takes its value: the target's cell when that is its only place,
      // or — a variable of the emitter's own nothing reads at its cell — the one field that reads it (a write's number):
      // worked in where it is read, no copy. (`apart`: the scratch cell is worked in while the target is still read — a
      // product of the target — and stays one of its own.)
      // (Or a field that holds it plus a constant — a store of `xs[i] + 1` — when nothing tests the scratch cell or
      // routes into it: the scratch's 0 to start from is that constant.)
      // (A map of our own only: a cell trigger of its own adds its number in, where the Python side's reads may set it.
      // Not when a masked write works the scratch cell — `&`, `|`, `^` by a constant: a `set 0` under a mask would
      // become a set of the constant under it, and put the constant's bits there: `(v & 0xffff) − 1025` came out as
      // v's low half under −1025's high half, step 12's Open list.)
      const fromConst = (p: Place) => p.scale === 1 && !p.base && !tested.get(t.copy!.from.slice(1))?.length && !routedInto.get(t.copy!.from.slice(1))?.length && !(scratch.get(t.copy!.from.slice(1)) ?? []).some((a) => a.mask !== undefined);
      const lonePlace = !apart && ps.length === 1 && ps[0].dword && plainPlace(ps[0]) ? ps[0]
        : !apart && ps.length === 2 && (this.own.has(target) || !!this.scope.decls.get(target)?.scoped) && (plainPlace(ps[1]) || fromConst(ps[1])) && ps[0].dword && !cellsRead.has(JSON.stringify(ps[0].dword)) ? ps[1]
        : undefined;
      const lone = lonePlace ? dwordOf(lonePlace) : undefined;
      if (lone) {
        const home = lone;
        for (const a of scratch.get(t.copy!.from.slice(1)) ?? []) {
          if ("temp" in a.dword) { a.dword = home; if (lonePlace!.add && a.modifier === "set" && a.value === 0) a.value = u(lonePlace!.add); }
          else a.value = { epd: home };
        }
        for (const c of tested.get(t.copy!.from.slice(1)) ?? []) c.dword = home;
        for (const c of routedInto.get(t.copy!.from.slice(1)) ?? []) c.dword = home;
        delete t.copy;
        continue;
      }
      for (const p of routed.has(target) ? ps.slice(0, 1) : ps) t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    // A copied variable's copies: every place but its cell.
    for (const { t, id } of copies) for (const p of this.placesOf(id).slice(1)) {
      t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    // Every way out of the graph passes one trigger at its end, where the branches that went there are put back.
    const exit = `${this.key}.end`;
    for (const t of triggers) if (t.next === END) t.next = exit;
    for (const t of triggers) for (const a of t.acts) if (typeof a.value === "object" && "label" in a.value && a.value.label === END) a.value = { label: exit };
    triggers.push({ label: exit, conds: [], acts: (this.restores.get(END) ?? []).map((r) => ({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) === END ? exit : to(r.to) } })), next: END });
    // Triggers that do nothing dropped (a fill read straight into its target, the one after a copy that ends a proto):
    // what went to one goes where it went. Not the end, nor one whose fields something writes (where a function goes
    // back to).
    const fielded = new Set<string>();
    const fields = (x: unknown): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(fields); return; }
      const o = x as Record<string, unknown>;
      if (typeof o.at === "string" && "field" in o) fielded.add(o.at);
      for (const v of Object.values(o)) if (v && typeof v === "object") fields(v);
    };
    for (const t of triggers) fields([t.acts, t.conds, t.copy?.into]);
    for (const ps of this.places.values()) for (const p of ps) if (p.dword) fields(p.dword);
    // (A copy has no next pointer: it goes on to the trigger after it, so one that does nothing and goes elsewhere
    // stays after one.)
    const on = new Map<string, string>();
    let falls = false;
    // (Nor one made to stay: an empty trigger of a run a doubling trigger walks, whose place in the run is its being there.)
    const stays = new Set(this.protos.filter((p) => p.keep).map((p) => p.label));
    // (Nor the first when it goes elsewhere than the trigger after it: the walk comes into the graph there.)
    triggers.forEach((t, i) => {
      const entry = i === 0 && t.next !== undefined && t.next !== triggers[1]?.label;
      const idle = t.label !== exit && !entry && !t.conds.length && !t.acts.length && !t.copy && !fielded.has(t.label) && !stays.has(t.label);
      if (idle && (t.next === undefined || !falls)) on.set(t.label, t.next ?? triggers[i + 1].label);
      else falls = t.next === undefined;
    });
    if (on.size) {
      const past = (l: string): string => { while (on.has(l)) l = on.get(l)!; return l; };
      const left = triggers.filter((t) => !on.has(t.label));
      triggers.splice(0, triggers.length, ...left);
      for (const t of triggers) {
        if (typeof t.next === "string") t.next = past(t.next);
        for (const a of t.acts) if (typeof a.value === "object" && "label" in a.value) a.value = { label: past(a.value.label) };
      }
    }
    joinRuns(triggers, new Set([exit, triggers[0]?.label, ...stays, ...this.rows.flat()].filter((l): l is string => !!l)));
    // What the graph reads that was written before it, copied into its places on the way in.
    const graph: Graph = { entries: [], triggers, ...(this.arrays.size ? { arrays: [...this.arrays].map(([id, stride]) => ({ id, stride })) } : {}), ...(this.rows.length ? { rows: this.rows } : {}) };
    for (const id of entries) for (const p of this.placesOf(id)) {
      // (A routed variable's places are refreshed where they are read.)
      if (routed.has(id)) continue;
      const d = dwordOf(p);
      if (p.synced || ("var" in d && d.var === id && p.add === 0 && p.scale === 1 && !p.base)) continue;
      graph.entries.push({ from: id, into: d, add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    const problems = checkGraph(graph);
    return problems.length ? problems.join("; ") : graph;
  }
}

type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" } as const;
const INVERSE = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" } as const;
/** A comparison of two numbers as 32 bits. */
const compareU32 = (op: CompareOp, x: number, y: number): boolean => {
  const [a, b] = [u(x), u(y)];
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b;
};
const notZero = (e: NumExpr): BoolExpr => ({ kind: "compare", op: "!=", left: e, right: { kind: "const", value: 0 }, at: { line: 0, column: 0 } as At, label: "" });

/**
 * What is still to be read after each call that may come back, in a function's body (a map of our own keeps no more
 * of `saves` than that on the stack): the variables that some way on from the call reads before it writes them. Worked
 * backwards over the statements — a loop until nothing more comes in, a `break` from what follows its loop, a
 * `continue` from its loop's top, a `return` from its value and where it goes (an inlined call's, on after the call).
 * A call is read from (its arguments) and writes its result, and its parameters unless it is one that may come back:
 * that one takes back after it what it keeps, the parameters it sets among them. What the function it calls does to
 * this one's variables does not count otherwise: a function's variables are its own.
 */
/**
 * A map of our own: a trigger with no conditions that the walk only ever reaches by falling from the one before it —
 * which has no conditions either, and goes on to it — is that one's actions after its own, in one trigger: the walk
 * passes one where it passed two. Not when either's next pointer is written by anything (a branch, a jump into a cell,
 * where a function goes back to), nor a copy, nor `keep` (the entry, the end, a kept one, a row's);
 * a field of the one taken in is the same field of the one that takes it, its action moved on by that one's actions.
 */
function joinRuns(triggers: Trigger[], keep: Set<string>): void {
  const reached = new Map<string, number>();
  const see = (l: string) => reached.set(l, (reached.get(l) ?? 0) + 1);
  const nextWritten = new Set<string>();
  const scan = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(scan); return; }
    const o = x as Record<string, unknown>;
    if (typeof o.at === "string" && (o.field === "next" || o.field === "current")) nextWritten.add(o.at);
    if (typeof o.label === "string" && Object.keys(o).length === 1) see(o.label);
    for (const v of Object.values(o)) if (v && typeof v === "object") scan(v);
  };
  for (const t of triggers) { if (t.next !== undefined) see(t.next); scan([t.conds, t.acts, t.copy?.into]); }
  const plain = (t: Trigger) => !t.conds.length && !t.copy && !nextWritten.has(t.label);
  // (Each one taken in noted — the trigger it is now, its first action's place there — and the fields renamed after,
  // in one walk.)
  const moved = new Map<string, { into: string; shift: number }>();
  for (let i = 0; i + 1 < triggers.length;) {
    const a = triggers[i], b = triggers[i + 1];
    const falls = a.next === undefined || a.next === b.label;
    if (!falls || !plain(a) || !plain(b) || keep.has(b.label) || (reached.get(b.label) ?? 0) > (a.next === b.label ? 1 : 0) || a.acts.length + b.acts.length > MOST_ACTS) { i++; continue; }
    moved.set(b.label, { into: a.label, shift: a.acts.length });
    // (What was taken into `b` before is `a`'s now, further on.)
    for (const [l, m] of moved) if (m.into === b.label) moved.set(l, { into: a.label, shift: m.shift + a.acts.length });
    a.acts.push(...b.acts);
    a.next = b.next;
    if (b.next === undefined) delete a.next;
    triggers.splice(i + 1, 1);
  }
  if (!moved.size) return;
  const move = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(move); return; }
    const o = x as Record<string, unknown>;
    const m = typeof o.at === "string" ? moved.get(o.at) : undefined;
    if (m && o.field && typeof o.field === "object" && "act" in (o.field as object)) {
      o.at = m.into;
      o.field = { ...(o.field as { act: number; part: ActPart }), act: (o.field as { act: number }).act + m.shift };
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") move(v);
  };
  for (const t of triggers) move([t.conds, t.acts, t.copy?.into]);
}

export function liveAfterCalls(body: Stmt[]): Map<Call, Set<string>> {
  const out = new Map<Call, Set<string>>();
  /** What is live where a `break`, a `continue`, a `return` and an error go. */
  type Flow = { brk: Set<string>; cont: Set<string>; ret: Set<string>; thr: Set<string> };
  const union = (...xs: Set<string>[]) => new Set(xs.flatMap((x) => [...x]));
  const reads = (e: unknown) => (e && typeof e === "object" ? readIn(e as NumExpr) : new Set<string>());
  const seq = (list: Stmt[], after: Set<string>, flow: Flow): Set<string> => {
    let live = after;
    for (let i = list.length - 1; i >= 0; i--) live = stmt(list[i], live, flow);
    return live;
  };
  const loop = (test: BoolExpr | undefined, body: Stmt[], update: Stmt[], after: Set<string>, testFirst: boolean, flow: Flow): Set<string> => {
    // The top of a turn: (the test, then) the body, the update, and round again — until nothing more comes in.
    const tested = (top: Set<string>) => union(test ? reads(test) : new Set(), after, top);
    let top = new Set<string>();
    for (;;) {
      const cont = seq(update, testFirst ? tested(top) : tested(top), { ...flow, brk: after, cont: after });
      const next = seq(body, cont, { ...flow, brk: after, cont });
      const grown = [...next].some((id) => !top.has(id));
      top = union(top, next);
      if (!grown) return testFirst ? tested(top) : top;
    }
  };
  const stmt = (s: Stmt, after: Set<string>, flow: Flow): Set<string> => {
    switch (s.kind) {
      case "declare": case "assign": case "assignBool": {
        const target = s.kind === "declare" ? s.decl.id : s.target;
        const live = new Set(after);
        live.delete(target);
        return union(live, reads(s.kind === "declare" ? s.init : s.value));
      }
      case "store": return union(after, reads(s.index), reads(s.value));
      case "call": {
        const c = s.call;
        // (Recorded on every pass of a loop around it: the last is the one that holds.)
        // (What the `catch` it may throw into reads, too: the frame is taken back before the error goes there.)
        if (c.saves) out.set(c, union(after, flow.thr));
        let live = new Set(after);
        if (c.result) live.delete(c.result.decl.id);
        // An inlined call's body where it is: its `return` goes on to what follows the call.
        if (c.fn === undefined) live = seq(c.body, live, { brk: live, cont: live, ret: live, thr: flow.thr });
        // (A call that may come back sets parameters that are this function's own, and takes back after it what it
        // keeps: what was live after it is so before it too.)
        if (!c.saves) for (const p of c.params) live.delete(p.decl.id);
        return union(live, flow.thr, ...c.params.map((p) => reads(p.init)));
      }
      case "return": return union(reads(s.value), flow.ret);
      case "throw": return flow.thr;
      case "try": return seq(s.body, after, { ...flow, thr: seq(s.catch, after, flow) });
      case "if": return union(reads(s.cond), seq(s.then, after, flow), seq(s.else ?? [], after, flow));
      case "block": return seq(s.body, after, flow);
      case "while": return loop(s.cond, s.body, [], after, true, flow);
      case "for": return loop(s.cond, s.body, s.update, after, true, flow);
      case "do": return loop(s.cond, s.body, [], after, false, flow);
      case "break": return flow.brk;
      case "continue": return flow.cont;
      case "switch": {
        // Each case falls into the next; a break leaves the switch, a continue is the loop's around it. Any case may
        // be where it starts, or none.
        const entries: Set<string>[] = [];
        let live = after;
        for (let i = s.cases.length - 1; i >= 0; i--) entries.push((live = seq(s.cases[i].body, live, { ...flow, brk: after })));
        return union(reads(s.value), after, ...entries);
      }
      case "unrolled": {
        let live = after;
        for (let i = s.iterations.length - 1; i >= 0; i--) live = seq(s.iterations[i], live, { ...flow, brk: after, cont: live });
        return live;
      }
      // (Anything else a map of our own takes reads what it reads and writes nothing of a function's own.)
      default: return union(after, reads(s));
    }
  };
  const none = new Set<string>();
  seq(body, none, { brk: none, cont: none, ret: none, thr: none });
  return out;
}

/**
 * Every variable a statement may write: what it sets or declares, a call's result and parameters, and what the
 * functions it calls write, all the way down.
 */
function writes(s: Stmt, functions: Map<string, FuncDecl>): Set<string> {
  const out = new Set<string>(), seen = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (typeof o.target === "string") out.add(o.target);
    const d = o.decl as VarDecl | undefined;
    if (d && typeof d === "object" && typeof d.id === "string") out.add(d.id);
    if (o.was && typeof o.was === "object") out.add((o.was as VarDecl).id);
    if (typeof o.fn === "string" && !seen.has(o.fn)) { seen.add(o.fn); walk(functions.get(o.fn)?.body); }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(s);
  return out;
}

/** Whether a statement may store into an array: itself, or a function it calls, all the way down. */
function stores(s: Stmt, functions: Map<string, FuncDecl>): boolean {
  const seen = new Set<string>();
  const walk = (x: unknown): boolean => {
    if (!x || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some(walk);
    const o = x as Record<string, unknown>;
    if (o.kind === "store" || o.kind === "declareArray" || o.kind === "push" || o.kind === "pop" || o.kind === "setLength") return true;
    if (typeof o.fn === "string" && !seen.has(o.fn)) { seen.add(o.fn); if (walk(functions.get(o.fn)?.body)) return true; }
    return Object.values(o).some((v) => v && typeof v === "object" && walk(v));
  };
  return walk(s);
}

/** Whether a piece of the IR holds a statement or an expression of this kind. */
function holdsKind(x: unknown, kind: string): boolean {
  if (!x || typeof x !== "object") return false;
  if (Array.isArray(x)) return x.some((y) => holdsKind(y, kind));
  const o = x as Record<string, unknown>;
  return o.kind === kind || Object.entries(o).some(([k, v]) => k !== "original" && v && typeof v === "object" && holdsKind(v, kind));
}

/**
 * The tasks of a map of our own (TrigScript 4, step 11): each `start`'s slots — one when the start can run only once
 * (in no loop, nowhere twice, in no task of more than one slot), else as many as its `max`, each slot after the first a
 * copy of the task's call whose variables of the task's are its own (as the simulator swaps them) — and the program
 * with `running` and `taskHandle` worked out against the slots: a number is a task's while one slot's number is it.
 * Or why not. The new variables' declarations go into `known`.
 */
function planTasks(root: Stmt, key: string, known: Map<string, VarDecl>, arrays: Map<string, ArrayDecl>): { root: Stmt; slots: Map<Stmt, TaskSlot[]>; once: Set<Stmt> } | string {
  // Which starts run more than once, and which start each is inside.
  const seen = new Map<Stmt, number>(), many = new Set<Stmt>(), parent = new Map<Stmt, Stmt | null>();
  const visit = (x: unknown, looped: boolean, task: Stmt | null): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach((y) => visit(y, looped, task)); return; }
    const o = x as Record<string, unknown>;
    if (o.kind === "start" && typeof o.task === "number" && o.call) {
      const st = o as unknown as StartStmt;
      seen.set(st, (seen.get(st) ?? 0) + 1);
      if (looped || seen.get(st)! > 1) many.add(st);
      parent.set(st, task);
      visit(st.call.params, looped, task);
      visit(st.call.body, false, st);
      return;
    }
    const loop = o.kind === "while" || o.kind === "for" || o.kind === "do" || o.kind === "unitLoop" || o.kind === "textLoop";
    for (const [k, v] of Object.entries(o)) if (k !== "original" && v && typeof v === "object") visit(v, looped || loop, task);
  };
  visit(root, false, null);
  for (const [st, p] of parent) if (p && many.has(p)) return `a task started inside a task of more than one slot (line ${st.at.line})`;
  // (A slot's arrays would be its own, as its variables are: not yet.)
  for (const st of many) {
    const a = [...arrays.values()].find((x) => x.task === (st as StartStmt).task);
    if (a) return `an array of a task that runs in more than one slot at a time (${a.name}, line ${st.at.line})`;
  }
  // The slots: their numbers' variables, and for each slot after the first, the task's variables renamed.
  // (Declared as the program starts: what is worked out from them — a slot's number from its generation — is kept in
  // places, which a write sets.)
  const plans = new Map<number, { n: number; handles: string[] }>(), declares: Stmt[] = [];
  for (const st of parent.keys()) {
    const s = st as StartStmt;
    const n = many.has(st) ? s.max : 1;
    const handles = Array.from({ length: n }, (_, k) => `@slot${s.task}.${k}.id`);
    plans.set(s.task, { n, handles });
    for (let k = 0; k < n; k++) for (const id of [`@slot${s.task}.${k}.gen`, handles[k]]) {
      const decl: VarDecl = { id, name: "(task)", kind: "number", shared: false, at: s.at };
      known.set(id, decl);
      declares.push({ kind: "declare", decl, init: { kind: "const", value: 0 }, at: s.at, label: "" });
    }
  }
  const every = [...plans.values()].flatMap((p) => p.handles);
  const slots = new Map<Stmt, TaskSlot[]>(), once = new Set<Stmt>();
  // (Copied where it is rewritten: the program's IR is the simulator's too, and each run's.)
  const remake = (x: unknown, handle: NumExpr, rename: Map<string, string>): unknown => {
    if (Array.isArray(x)) return x.map((y) => remake(y, handle, rename));
    if (!x || typeof x !== "object") return typeof x === "string" && rename.has(x) ? rename.get(x) : x;
    const o = x as Record<string, unknown>;
    if (o.kind === "taskHandle") return handle;
    if (o.kind === "running") {
      const h = remake(o.task, handle, rename) as NumExpr, at = (o.at ?? { file: "", line: 0, column: 0 }) as At;
      if (!every.length) return { kind: "const", value: false };
      return { kind: "and", items: [{ kind: "compare", op: ">=", left: h, right: { kind: "const", value: 1 }, unsigned: true, at, label: "" }, { kind: "or", items: every.map((id) => ({ kind: "compare", op: "==", left: h, right: { kind: "var", id }, at, label: "" })) }] };
    }
    if (o.kind === "start" && typeof o.task === "number" && o.call) {
      const s = o as unknown as StartStmt, plan = plans.get(s.task)!;
      const calls = plan.handles.map((h, k) => {
        // (Slot k's own variables: the task's, `id~k`.)
        const own = new Map(rename);
        if (k) for (const d of declsIn(s.call)) if (d.task === s.task) own.set(d.id, `${d.id}~${k}`);
        const call = remake(s.call, { kind: "var", id: h }, own) as Call;
        for (const d of declsIn(call)) if (!known.has(d.id)) known.set(d.id, d);
        return call;
      });
      const made = { ...s, call: calls[0] } as StartStmt;
      slots.set(made, calls.map((call, k) => ({ call, check: `${key}:task${s.task}.${k}`, entry: `${key}:task${s.task}.${k}:body`, gen: `@slot${s.task}.${k}.gen`, handle: plan.handles[k] })));
      if (!many.has(s)) once.add(made);
      return made;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = remake(v, handle, rename);
    return out;
  };
  const made = remake(root, { kind: "const", value: 0 }, new Map()) as Stmt;
  return { root: declares.length ? { kind: "block", body: [...declares, made], at: made.at } : made, slots, once };
}

/** Every declaration in a piece of the IR: a `declare`'s, a loop's, a call's parameters and result. */
function declsIn(x: unknown, out: VarDecl[] = []): VarDecl[] {
  if (Array.isArray(x)) { x.forEach((y) => declsIn(y, out)); return out; }
  if (!x || typeof x !== "object") return out;
  const o = x as Record<string, unknown>;
  const d = o.decl as VarDecl | undefined;
  if (d && typeof d === "object" && typeof d.id === "string" && typeof d.kind === "string") out.push(d);
  for (const [k, v] of Object.entries(o)) if (k !== "decl" && v && typeof v === "object") declsIn(v, out);
  return out;
}

/** Whether statements end in a `throw`: all they do is on an error's way. */
function throwsAtEnd(list: Stmt[]): boolean {
  const last = list.filter((s) => s.kind !== "remark").at(-1);
  return last?.kind === "throw" || (last?.kind === "block" && throwsAtEnd(last.body));
}

/** Whether a value or a test reads a cell of an array. */
function readsCell(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  if (Array.isArray(x)) return x.some(readsCell);
  const o = x as Record<string, unknown>;
  return o.kind === "element" || Object.values(o).some((v) => v && typeof v === "object" && readsCell(v));
}

/** Every variable a test reads. */
function readIn(e: BoolExpr | NumExpr, into = new Set<string>()): Set<string> {
  if (e.kind === "var") into.add(e.id);
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && "kind" in x && readIn(x as BoolExpr, into));
    else if (v && typeof v === "object" && "kind" in v) readIn(v as BoolExpr, into);
  }
  return into;
}

/** A loop's test as what can be tested once (every part of an `and` that reads nothing the loop writes) and the rest. */
function split(cond: BoolExpr, written: Set<string>): { once: BoolExpr | null; every: BoolExpr | null } {
  const c = cond.kind === "compare" ? plain(cond) : cond;
  if (c.kind !== "and") return { once: null, every: c };
  // (A part that reads a cell of an array is tested every turn: what the loop stores is no variable it writes.)
  const fixed = c.items.filter((x) => !readsCell(x) && [...readIn(x)].every((id) => !written.has(id)));
  const rest = c.items.filter((x) => !fixed.includes(x));
  const all = (items: BoolExpr[]): BoolExpr | null => (items.length === 0 ? null : items.length === 1 ? items[0] : { kind: "and", items });
  return { once: all(fixed), every: all(rest) };
}

/**
 * A comparison of a `u32` with a signed number, as two of one reading: a signed number below zero is below every
 * `u32`, so `x < y` with x the `u32` is `y >= 0 && x < y` read from 0 up, `x > y` is `y < 0 || x > y`, and so on.
 */
function plain(e: Extract<BoolExpr, { kind: "compare" }>): BoolExpr {
  if (e.unsigned !== "left" && e.unsigned !== "right") return e;
  const signedSide = e.unsigned === "left" ? e.right : e.left;
  const zero: NumExpr = { kind: "const", value: 0 };
  const negative: BoolExpr = { ...e, op: "<", left: signedSide, right: zero, unsigned: false };
  const notNegative: BoolExpr = { ...e, op: ">=", left: signedSide, right: zero, unsigned: false };
  const asU32: BoolExpr = { ...e, unsigned: true };
  // Which way the signed side being below zero settles it: for "left" (the right side signed) the left is the larger.
  const leftLarger = e.unsigned === "left";
  const holdsWhenNegative = e.op === "!=" || (leftLarger ? e.op === ">" || e.op === ">=" : e.op === "<" || e.op === "<=");
  return holdsWhenNegative ? { kind: "or", items: [negative, asU32] } : { kind: "and", items: [notNegative, asU32] };
}

/**
 * An ordered comparison, read signed, of a variable's bits under a mask that has the sign bit, against a constant —
 * as comparisons read from 0 up: with the sign bit set the bits are below zero (a constant below zero is then compared
 * with them from 0 up, one at zero or above is above them), with it clear they are at or above zero. Null when it is
 * not one.
 */
function signedMask(e: Extract<BoolExpr, { kind: "compare" }>): BoolExpr | null {
  if (e.unsigned === true || e.unsigned === "left" || e.unsigned === "right" || e.op === "==" || e.op === "!=") return null;
  let [l, r, op] = [side(e.left), side(e.right), e.op] as [Side | null, Side | null, CompareOp];
  if (l && "k" in l && r && "mask" in r && r.mask !== undefined) [l, r, op] = [r, l, FLIP[op] as CompareOp];
  if (!l || !r || !("mask" in l) || l.mask === undefined || l.mask < SIGN || !("k" in r)) return null;
  const k = r.k | 0;
  const where = { at: e.at, label: e.label };
  const bits: NumExpr = { kind: "binary", op: "&", left: { kind: "var", id: l.id }, right: { kind: "const", value: l.mask }, at: e.at, label: "" };
  const top: NumExpr = { kind: "binary", op: "&", left: { kind: "var", id: l.id }, right: { kind: "const", value: SIGN }, at: e.at, label: "" };
  const zero: NumExpr = { kind: "const", value: 0 };
  const below: BoolExpr = { kind: "compare", op: "!=", left: top, right: zero, unsigned: true, ...where };
  const above: BoolExpr = { kind: "compare", op: "==", left: top, right: zero, unsigned: true, ...where };
  const asU32: BoolExpr = { kind: "compare", op, left: bits, right: { kind: "const", value: u(k) }, unsigned: true, ...where };
  const less = op === "<" || op === "<=";
  // With the sign bit set: a constant below zero is compared from 0 up; one at zero or above settles it.
  const neg: BoolExpr = k < 0 ? asU32 : { kind: "const", value: less };
  // With it clear: one at zero or above is compared from 0 up; one below zero settles it.
  const pos: BoolExpr = k >= 0 ? asU32 : { kind: "const", value: !less };
  return { kind: "or", items: [{ kind: "and", items: [below, neg] }, { kind: "and", items: [above, pos] }] };
}

/** A variable the rewriter made (`@t…`): the emitter's own, declared by no statement. */
const isTemp = (id: string) => id.startsWith("@t");

/** Whether a value is a test (true or false) and nothing a number could be. */
const isTest = (e: NumExpr | BoolExpr): boolean => e.kind === "compare" || e.kind === "and" || e.kind === "or" || e.kind === "not" || e.kind === "test";

/** Whether a value calls a function anywhere in it. */
function holdsCall(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  if (Array.isArray(x)) return x.some(holdsCall);
  const o = x as Record<string, unknown>;
  return o.kind === "call" || Object.values(o).some(holdsCall);
}

/**
 * A program's statements as the emitter takes them: a value that is `?:`, `Math.abs`, `Math.min` / `max` as `if` /
 * `else` of plain assignments (`x = c ? a : b` is `if (c) x = a; else x = b`; `x = abs(e)` tests e's sign; a product or
 * quotient's abs tests the result's), such a value inside a sum or a comparison's side computed first into a variable
 * of the emitter's own (`@t…`), and a loop's test that needs that computed at the top of each turn. Every expression
 * moved is pure, so computing it ahead of a test that would have skipped it changes nothing.
 *
 * A call inside an expression becomes a statement of its own ahead of it, the expression reading the call's result:
 * a value to its left that the call may change is taken into a variable of the emitter's own first (JavaScript reads
 * it before the call), and a call in a later part of `&&` / `||` runs only when the parts before it leave the answer
 * open.
 */
class Rewriter {
  n = 0;
  readonly key: string;
  readonly functions: Map<string, FuncDecl>;
  /** The program's arrays (a map of our own): which of them are kept in regions, whose cells a condition reads. */
  arrays = new Map<string, ArrayDecl>();
  /** What a `return` gives back where it stands: the kind of the function or inlined call around it, innermost last. */
  returning: string[] = [];
  /** The program's `u8` and `u16` variables (a map of our own): each one's top, 255 or 65 535. */
  bits = new Map<string, number>();
  constructor(key: string, functions = new Map<string, FuncDecl>(), result?: string) {
    this.key = key;
    this.functions = functions;
    if (result) this.returning.push(result);
  }

  /**
   * A value worked out before the statements `pre` gained from `mark` on, and read after them: taken into a variable of
   * the emitter's own at `mark` when a call among them may write what it reads.
   */
  before<E extends NumExpr | BoolExpr>(e: E, pre: Stmt[], mark: number, where: { at: At; label: string }, test = false): E {
    if (mark === pre.length || e.kind === "const") return e;
    const after: Stmt = { kind: "block", body: pre.slice(mark), at: where.at };
    const later = writes(after, this.functions);
    // (A cell it reads, when what comes after may store into an array: JavaScript reads it first.)
    if (![...readIn(e)].some((id) => later.has(id)) && !(readsCell(e) && stores(after, this.functions))) return e;
    const t = this.temp();
    pre.splice(mark, 0, test ? { kind: "assignBool", target: t, value: e as BoolExpr, ...where } : { kind: "assign", target: t, value: e as NumExpr, ...where });
    return { kind: "var", id: t } as E;
  }

  /** A call as a statement of its own, after what its arguments need (in `pre`); an inlined call's body rewritten. */
  call(c: Call, pre: Stmt[], where: { at: At; label: string }): void {
    const marks: number[] = [];
    const inits = c.params.map((p) => {
      marks.push(pre.length);
      if (p.decl.kind === "boolean") return this.cond(p.init as BoolExpr, pre, where);
      if (p.decl.kind !== "number") return p.init;
      // (More than a sum — a cell of an array — into a variable of the emitter's own first; into a `u8` or `u16`,
      // stopped at its top.)
      return this.sum(this.flat(this.top(p.init as NumExpr, p.decl.bits && 2 ** p.decl.bits - 1, where), pre, where), pre, where);
    });
    marks.push(pre.length);
    // Each argument read before what the ones after it run (from the last back: a value put in ahead of a later one's
    // statements leaves the earlier marks where they were).
    for (let i = inits.length - 2; i >= 0; i--) {
      const kind = c.params[i].decl.kind;
      if (kind === "number" || kind === "boolean") inits[i] = this.before(inits[i] as NumExpr | BoolExpr, pre, marks[i + 1], where, kind === "boolean");
    }
    this.returning.push(c.result?.kind ?? "void");
    const body = c.fn === undefined ? this.stmts(c.body) : c.body;
    this.returning.pop();
    pre.push({ kind: "call", call: { ...c, params: c.params.map((p, i) => ({ ...p, init: inits[i] })), body }, ...where });
  }

  temp(): string {
    return `@t${this.key}.${this.n++}`;
  }

  /**
   * A value stored into a `u8` or `u16` (a map of our own): stopped at the top, read from 0 up, as the simulator keeps
   * it and the Python side's `saturate` stores it — the front end has already stopped it at 0 (`max(…, 0)`). As it is
   * when its value range is inside.
   */
  top(e: NumExpr, top: number | undefined, where: { at: At; label: string }): NumExpr {
    const r = (e as NumExpr & { range?: readonly [number, number] }).range;
    if (!top || (r && r[0] >= 0 && r[1] <= top) || (e.kind === "const" && u(e.value) <= top)) return e;
    if (e.kind === "const") return { kind: "const", value: top };
    return { kind: "intrinsic", name: "min", args: [e, { kind: "const", value: top }], unsigned: true, range: [0, top], ...where } as NumExpr;
  }

  /** The top of an array's cells, when it is a `u8` or `u16` one. */
  arrayTop(id: string): number | undefined {
    const bits = this.arrays.get(id)?.bits;
    return bits ? 2 ** bits - 1 : undefined;
  }

  at(s: { at?: At; label?: string }) {
    return { at: s.at as At, label: s.label ?? "" };
  }

  /**
   * The loop being rewritten, while its body is: what it may write (its own stores and declarations, those of the
   * functions it calls), and the values computed once on the way in.
   */
  hoist: { written: Set<string>; arrays: Set<string>; out: Stmt[] } | null = null;

  /**
   * A value worth computing once, ahead of the loop, and that may be: a shift, a fixed-point product or quotient, a cell
   * of a list known when the map is built — reading nothing the loop writes, and calling nothing.
   */
  invariant(e: NumExpr): boolean {
    const h = this.hoist;
    if (!h) return false;
    const costly = (e.kind === "binary" && (e.op === ">>" || e.op === ">>>") && e.right.kind === "const") || (e.kind === "intrinsic" && (e.name === "fmul" || e.name === "fdiv")) || e.kind === "element";
    if (!costly) return false;
    let pure = true;
    const walk = (x: unknown): void => {
      if (!pure || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const o = x as Record<string, unknown>;
      if (o.kind === "var" && typeof o.id === "string" && (h.written.has(o.id) || isTemp(o.id))) pure = false;
      if (o.kind === "element" && h.arrays.has(o.array as string)) pure = false;
      if (o.kind === "call" || o.kind === "read" || o.kind === "randomInt" || o.kind === "input" || o.kind === "unitField" || o.kind === "tableRead" || o.kind === "pop") pure = false;
      Object.values(o).forEach(walk);
    };
    walk(e);
    return pure;
  }

  /** Inside a later part of `&&` or `||`, whose reads go ahead of the parts before it (`ahead`). */
  early = 0;
  ahead<X>(f: () => X): X {
    this.early++;
    try {
      return f();
    } finally {
      this.early--;
    }
  }
  /** An index as it is, or — read ahead of what decides whether it is read — without its range, so that it is tested. */
  unsure(index: NumExpr): NumExpr {
    if (!this.early || !("range" in index)) return index;
    const { range: _, ...rest } = index as NumExpr & { range?: unknown };
    return rest as NumExpr;
  }

  /** `e` with every `?:`, abs, min and max in it computed first into a variable of the emitter's own. */
  flat(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (this.invariant(e)) {
      const t = this.temp();
      // (Computed once, ahead of the loop; the rest of this rewriting sees a variable.)
      const h = this.hoist!;
      this.hoist = null;
      try {
        // (Ahead of the loop, and of any test in it that a range of an index knows from.)
        h.out.push(...this.ahead(() => this.set(t, e, where)));
      } finally {
        this.hoist = h;
      }
      return { kind: "var", id: t };
    }
    switch (e.kind) {
      case "binary": {
        const left = this.flat(e.left, pre, where), mark = pre.length;
        const right = this.flat(e.right, pre, where);
        return { ...e, left: this.before(left, pre, mark, where), right };
      }
      case "unary": case "cast": return { ...e, expr: this.flat(e.expr, pre, where) };
      case "randomInt": return { ...e, bound: this.flat(e.bound, pre, where) };
      case "tableRead": {
        if (e.cell.special) return e;
        const t = this.temp();
        pre.push(...this.set(t, e, where));
        return { kind: "var", id: t };
      }
      // (A map of our own: a number of the game's into a variable of the emitter's own, read there.)
      case "read": {
        if (!(gameRead(e.read) || this.facts(e.read))) return e;
        const t = this.temp();
        pre.push(...this.set(t, e, where));
        return { kind: "var", id: t };
      }
      case "element": {
        // (A map of our own: an index that is more than a sum — a product, a shift, a random number — worked out first
        // into a variable of the emitter's own, which the read's table then tests.)
        const index = this.flat(e.index, pre, where);
        if (linear(index)) return { ...e, index: this.unsure(index) };
        const t = this.temp();
        pre.push(...this.set(t, index, where));
        return { ...e, index: { kind: "var", id: t } };
      }
      case "call": {
        if (!e.call.result) return e;
        this.call(e.call, pre, where);
        return { kind: "var", id: e.call.result.decl.id };
      }
      case "ternary": case "intrinsic": {
        if (e.kind === "intrinsic" && e.name !== "abs" && e.name !== "min" && e.name !== "max" && !this.tabled(e)) return { ...e, args: this.each(e.args, pre, where) };
        const t = this.temp();
        pre.push(...this.set(t, e, where));
        // (What the value ranges know of it, known of the variable it is read from.)
        const range = (e as NumExpr & { range?: readonly [number, number] }).range;
        return { kind: "var", id: t, ...(range ? { range } : {}) } as NumExpr;
      }
      default: return e;
    }
  }

  /** Several values in order, each flattened: an earlier one read before a later one's calls run. */
  each(list: NumExpr[], pre: Stmt[], where: { at: At; label: string }, as = (e: NumExpr) => e): NumExpr[] {
    const marks: number[] = [];
    const out = list.map((x) => {
      marks.push(pre.length);
      return as(this.flat(x, pre, where));
    });
    marks.push(pre.length);
    for (let i = out.length - 2; i >= 0; i--) out[i] = this.before(out[i], pre, marks[i + 1], where);
    return out;
  }

  /**
   * An action of the game's with fields from values (a map of our own), as `Emitter.action` takes it: each value, in
   * JavaScript's order, one variable times a constant plus a constant — a field holds that — or into a variable of the
   * emitter's own first. A unit type stopped at 228, as the Python side's: past the table an action reads what is not
   * a unit. A unit count is that many units, 0 or below none: the action done 255 at a time while more are left, then
   * once with the rest — each half only where the count's range reaches it. A unit type and a count both from values
   * share their dword, through one variable of the emitter's own: the type plus the count times 2^24.
   */
  action(s: Extract<Stmt, { kind: "action" }>, where: { at: At; label: string }): Stmt[] {
    const pre: Stmt[] = [];
    // (A text made while the game runs: its values as a print's — in JavaScript's order, the text before the fields.)
    if (s.text?.kind === "template") {
      const parts = s.text.parts;
      const valued = parts.filter((p): p is Extract<TextPart, { kind: "number" | "char" }> => p.kind === "number" || p.kind === "char");
      const exprs = this.each(valued.map((p) => p.expr), pre, where, (x) => (linear(x) ? x : this.sum(x, pre, where)));
      let i = 0;
      s = { ...s, text: { ...s.text, parts: parts.map((p) => (p.kind === "number" || p.kind === "char" ? { ...p, expr: exprs[i++] } : p)) } };
      if (!s.variables?.length) return [...pre, s];
    }
    const one = (x: NumExpr) => (linear(x)?.terms.length ?? 2) <= 1;
    const vars = s.variables!;
    const exprs = this.each(vars.map((v) => (v.field === "unitId" ? this.top(settled(v.expr), 228, where) : settled(v.expr))), pre, where, (x) => this.single(x, pre, where));
    let fields = vars.map((v, i) => ({ ...v, expr: exprs[i] }));
    const k = fields.findIndex((v) => v.field === "modifier");
    if (k < 0) return [...pre, { ...s, variables: fields }];
    const range = (vars[k].expr as NumExpr & { range?: readonly [number, number] }).range;
    const many = !range || range[1] > 255, none = !range || range[0] < 1;
    let count = fields[k].expr;
    if (many || none || !one(count)) {
      const t = this.temp();
      pre.push({ kind: "assign", target: t, value: count, ...where });
      count = { kind: "var", id: t };
    }
    fields = fields.filter((_, i) => i !== k);
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const made = (n: NumExpr | null): Stmt[] => {
      const type = fields.find((f) => f.field === "unitId");
      if (!n) return [{ ...s, record: { ...s.record, modifier: 255 }, variables: fields }];
      if (!type) return [{ ...s, variables: [...fields, { ...vars[k], expr: n }] }];
      const w = this.temp();
      const word: NumExpr = { kind: "binary", op: "+", left: type.expr, right: { kind: "binary", op: "*", left: n, right: { kind: "const", value: 2 ** 24 }, at: where.at, label: where.label }, at: where.at, label: where.label } as NumExpr;
      return [{ kind: "assign", target: w, value: word, ...where }, { ...s, record: { ...s.record, modifier: 0 }, variables: fields.map((f) => (f === type ? { ...f, bits: 32 as const, expr: v(w) } : f)) }];
    };
    const at = { at: where.at, label: where.label };
    const c = count.kind === "var" ? count.id : "";
    if (many) {
      pre.push({ kind: "while", cond: { kind: "compare", op: ">", left: count, right: { kind: "const", value: 255 }, ...at }, body: [...made(null), { kind: "assign", target: c, value: { kind: "binary", op: "-", left: count, right: { kind: "const", value: 255 }, ...at } as NumExpr, ...where }], ...where } as Stmt);
    }
    if (none) return [...pre, { kind: "if", cond: { kind: "compare", op: ">=", left: count, right: { kind: "const", value: 1 }, ...at }, then: made(count), ...where } as Stmt];
    return [...pre, ...made(count)];
  }

  /**
   * A number of the game's compared with a constant, or with one variable times a constant plus a constant that is
   * never below zero: the condition itself, its amount the value (`cond.amount`, a place of it) — no read at all.
   * `>` and `<` are at least one more, at most one less. Null where it is not that, or the value's range would take the
   * amount past 0 or 2^32 − 1.
   */
  asked(c: Extract<BoolExpr, { kind: "compare" }>): BoolExpr | null {
    const k = [c.left, c.right].findIndex((x) => x.kind === "read" && gameRead(x.read));
    if (k < 0) return null;
    const read = (k === 0 ? c.left : c.right) as Extract<NumExpr, { kind: "read" }>, other = k === 0 ? c.right : c.left;
    const l = linear(other);
    if (!l || l.terms.length > 1 || !gameRead(read.read)) return null;
    const base = read.read.record;
    const range: readonly [number, number] | undefined = l.terms.length ? (other as NumExpr & { range?: readonly [number, number] }).range : [l.c, l.c];
    const flip = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "==": "==", "!=": "!=" } as const;
    const op = k === 0 ? c.op : flip[c.op];
    // A constant below zero, compared signed (`i32(deaths(…)) >= -10`): the numbers it holds for, from the lowest to the
    // highest, as bits — those below zero are above 2 147 483 647 as bits — one or two runs of the condition's own
    // "at least" and "at most" (as `cellCompare` reads a cell).
    if (!l.terms.length && (l.c | 0) < 0 && c.unsigned !== true && op !== "==" && op !== "!=") {
      const epd = read.read.epd ? { epd: read.read.epd } : {};
      const raw = (comparison: number, amount: number): BoolExpr => ({ kind: "cond", record: { ...base, comparison, amount: u(amount) }, ...epd });
      const all = (items: BoolExpr[]): BoolExpr => (items.length === 0 ? { kind: "const", value: true } : items.length === 1 ? items[0] : { kind: "and", items });
      const between = (lo: number, hi: number): BoolExpr => all([...(u(lo) > 0 ? [raw(0, lo)] : []), ...(u(hi) < U32 - 1 ? [raw(1, hi)] : [])]);
      const K = l.c | 0, MIN_S = -2147483648, MAX_S = 2147483647;
      const [lo, hi] = op === "<" ? [MIN_S, K - 1] : op === "<=" ? [MIN_S, K] : op === ">" ? [K + 1, MAX_S] : [K, MAX_S];
      if (lo > hi) return { kind: "const", value: false };
      return lo >= 0 || hi < 0 ? between(lo, hi) : { kind: "or", items: [between(lo, -1), between(0, hi)] };
    }
    if (!range || range[0] < 0) return null;
    const how: Record<string, [number, number]> = { ">=": [0, 0], ">": [0, 1], "<=": [1, 0], "<": [1, -1], "==": [10, 0], "!=": [10, 0] };
    const [comparison, add] = how[op];
    if (range[0] + add < 0) return op === "<" && range[1] < 1 ? { kind: "const", value: false } : null;
    if (range[1] + add > U32 - 1) return null;
    const record = { ...read.read.record, comparison, amount: l.terms.length ? 0 : u(l.c + add) };
    const epd = read.read.epd ? { epd: read.read.epd } : {};
    const cond: BoolExpr = l.terms.length ? { kind: "cond", record, amount: { expr: other, add }, ...epd } : { kind: "cond", record, ...epd };
    return op === "!=" ? { kind: "not", expr: cond } : cond;
  }

  /**
   * A location centred on a point (a map of our own): its four sides written where the game keeps them (MRGN), each a
   * Set Deaths whose amount is a place of the side — the point less half the size, the far sides the near ones plus
   * the size — after which Bring counts again (the game keeps its counts for a location whose sides are written). The
   * size kept when none is given: the sides read first, where they are. As the Python side's `center_location`.
   */
  centerLocation(s: Extract<Stmt, { kind: "centerLocation" }>, where: { at: At; label: string }): Stmt[] {
    const pre: Stmt[] = [];
    const at = { at: where.at, label: where.label };
    const base = MRGN + (s.location - 1) * 20;
    const one = (x: NumExpr) => (linear(x) ? x : this.sum(x, pre, where));
    const [x, y] = this.each([s.x, s.y], pre, where, one);
    const bin = (op: "+" | "-" | ">>>", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, ...at }) as NumExpr;
    const k = (value: number): NumExpr => ({ kind: "const", value });
    let w: NumExpr, h: NumExpr;
    if (s.size) [w, h] = this.each([s.size.width, s.size.height], pre, where, one);
    else {
      const side = (i: number) => this.sum(memoryRead(base + 4 * i, undefined, where), pre, where);
      const [l, t, r, b] = [0, 1, 2, 3].map(side);
      w = this.sum(bin("-", r, l), pre, where);
      h = this.sum(bin("-", b, t), pre, where);
    }
    const half = (e: NumExpr) => (e.kind === "const" ? k(Math.floor(u(e.value) / 2)) : this.sum(bin(">>>", e, k(1)), pre, where));
    const single = (e: NumExpr) => this.single(e, pre, where);
    const left = single(bin("-", x, half(w))), top = single(bin("-", y, half(h)));
    const right = single(bin("+", left, w)), bottom = single(bin("+", top, h));
    const write = (i: number, value: NumExpr): Stmt => {
      const record: ActionRecord = { location: 0, text: 0, wav: 0, time: 0, player: u((base + 4 * i - DEATHS_TABLE) / 4), target: 0, unitId: 0, type: SET_DEATHS_ACTION, modifier: 7, flags: 0, padding: 0, mask: 0 };
      const l = linear(value)!;
      if (!l.terms.length) return { kind: "action", record: { ...record, target: u(l.c) }, ...where };
      return { kind: "action", record, variables: [{ field: "target", bits: 32, name: "side", expr: value }], ...where };
    };
    return [...pre, write(0, left), write(1, top), write(2, right), write(3, bottom), { kind: "action", record: FORGET_COUNTS, ...where }];
  }

  /** Where a cell of the game's tables is (`TableCell`): a player's table at the current player is the owner's row. */
  cellAddress(c: TableCell): number {
    const index = c.player && c.index === CURRENT_PLAYER ? this.owner ?? 0 : c.index;
    return c.base + (c.key ?? 0) + index * c.stride;
  }

  /**
   * A cell of the game's tables read into `target` (a map of our own; the Python side's `table_read`): its bits of the
   * dword it is in — a byte, a word, a dword or one bit — moved down, read where they are; a scaled field divided by
   * its scale.
   */
  tableRead(target: string, c: TableCell, where: { at: At; label: string }): Stmt[] {
    const addr = this.cellAddress(c), sh = 8 * (addr & 3);
    const bits = c.width === "bit" ? u(2 ** (c.bit ?? 0)) : c.width === 4 ? U32 - 1 : 2 ** (8 * c.width) - 1;
    const shift = sh + (c.width === "bit" ? c.bit ?? 0 : 0);
    const at = { at: where.at, label: where.label };
    const read = memoryRead(addr & ~3, c.width === 4 ? undefined : u(bits * 2 ** sh), where);
    let value: NumExpr = shift ? ({ kind: "binary", op: ">>>", left: read, right: { kind: "const", value: shift }, ...at } as NumExpr) : read;
    if ((c.scale ?? 1) > 1) {
      const t = this.temp();
      return [{ kind: "assign", target: t, value, ...where }, { kind: "assign", target, value: { kind: "binary", op: "/", left: { kind: "var", id: t }, right: { kind: "const", value: c.scale! }, ...at } as NumExpr, ...where }];
    }
    return [{ kind: "assign", target, value, ...where }];
  }

  /**
   * A cell of the game's tables written (a map of our own; the Python side's `table_write`): a Set Deaths into the
   * dword it is in — masked for a byte, a word or a bit — its amount a place of the value, which is times the field's
   * scale (unless written so) and stopped at the field's top. A player's colour is its byte and the minimap's. A name
   * known when built is its text's number among the map's strings. A top speed is the unit type's flingy's (`speed`).
   * Null for a name made while the game runs.
   */
  tableWrite(s: Extract<Stmt, { kind: "tableWrite" }>, where: { at: At; label: string }): Stmt[] | null {
    const c = s.cell;
    const at = { at: where.at, label: where.label };
    const pre: Stmt[] = [];
    if (c.special === "name") {
      const t = s.value as { kind: string; text?: string };
      if (t.kind !== "text" || t.text === undefined) return null;
      const w = this.cellWrite(this.cellAddress(c), 2, { kind: "const", value: 0 }, where) as Extract<Stmt, { kind: "action" }>;
      return [{ ...w, text: { kind: "text", text: t.text } } as Stmt];
    }
    let value: NumExpr;
    if (s.boolean && (s.value as BoolExpr).kind === "const") value = { kind: "const", value: (s.value as Extract<BoolExpr, { kind: "const" }>).value ? 1 : 0 };
    else if (s.boolean) {
      const t = this.temp();
      pre.push({ kind: "assignBool", target: t, value: this.cond(s.value as BoolExpr, pre, where), ...where });
      value = { kind: "var", id: t };
    } else value = this.single(this.flat(s.value as NumExpr, pre, where), pre, where);
    const scale = c.scale ?? 1;
    if (scale > 1 && !s.scaled) value = this.single({ kind: "binary", op: "*", left: value, right: { kind: "const", value: scale }, ...at } as NumExpr, pre, where);
    if (c.special === "speed") return this.speed(c.index, value, pre, where);
    const width = c.width === "bit" ? "bit" : c.width;
    if (width !== 4) value = this.single(this.top(value, width === "bit" ? 1 : 2 ** (8 * width) - 1, where), pre, where);
    const addr = this.cellAddress(c);
    const out = [...pre, this.cellWrite(addr, width, value, where, c.bit)];
    if (c.special === "color") out.push(this.cellWrite(addr + MINIMAP_COLOR_OFFSET, 1, value, where));
    return out;
  }

  /**
   * A unit type's top speed (256 to a pixel a frame), as the Python side's `write_speed` and Magenta write it: the
   * flingy the type moves as switched to table control and given the speed, an acceleration of about a seventeenth of
   * it and the halting distance v² / 2a to match (each at least 1). The flingy is read where the game keeps it, so the
   * writes into its tables name their dwords by a place of it: a dword's EPD the table's plus the flingy (plus half or a
   * quarter of it for a word or a byte, whose place in its dword is the rest, chosen by a test).
   */
  speed(unit: number, value: NumExpr, pre: Stmt[], where: { at: At; label: string }): Stmt[] {
    const at = { at: where.at, label: where.label };
    const k = (n: number): NumExpr => ({ kind: "const", value: n });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const bin = (op: "+" | "*" | "/" | ">>>" | "&", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, ...at }) as NumExpr;
    const f = this.temp();
    const out: Stmt[] = [...pre, ...this.set(f, memoryRead((UNITS_FLINGY + unit) & ~3, u(0xff * 2 ** (8 * ((UNITS_FLINGY + unit) & 3))), where), where)];
    // (The byte moved down where it is not the dword's first.)
    const sh = 8 * ((UNITS_FLINGY + unit) & 3);
    if (sh) out.splice(out.length - 1, 1, { kind: "assign", target: f, value: bin(">>>", memoryRead((UNITS_FLINGY + unit) & ~3, u(0xff * 2 ** sh), where), k(sh)), ...where });
    let acceleration: NumExpr, halt: NumExpr;
    if (value.kind === "const") {
      // (Rounded as the Python side's `round` rounds: a half to the even one.)
      const even = (x: number) => (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));
      const speed = value.value, a = Math.max(1, even(speed / 17));
      acceleration = k(Math.min(a, 0xffff));
      halt = k(Math.max(1, even((speed * speed) / (2 * a))));
    } else {
      const a = this.temp(), h = this.temp();
      out.push({ kind: "assign", target: a, value: bin("/", value, k(17)), ...where });
      out.push({ kind: "if", cond: { kind: "compare", op: "==", left: v(a), right: k(0), ...at }, then: [{ kind: "assign", target: a, value: k(1), ...where }], ...where } as Stmt);
      out.push({ kind: "assign", target: h, value: bin("/", bin("*", value, value), bin("*", v(a), k(2))), ...where });
      out.push({ kind: "if", cond: { kind: "compare", op: "==", left: v(h), right: k(0), ...at }, then: [{ kind: "assign", target: h, value: k(1), ...where }], ...where } as Stmt);
      out.push({ kind: "assign", target: a, value: this.top(v(a), 0xffff, where), ...where });
      acceleration = v(a);
      halt = v(h);
    }
    // A Set Deaths of `amount` (masked by `mask`) into the dword whose EPD is `epd` plus the flingy's `part`.
    const write = (base: number, part: NumExpr, amount: NumExpr, mask = 0): Stmt => {
      const record: ActionRecord = { location: mask, text: 0, wav: 0, time: 0, player: u((base - DEATHS_TABLE) / 4), target: 0, unitId: 0, type: SET_DEATHS_ACTION, modifier: 7, flags: 0, padding: 0, mask: mask ? MASKED_MARK : 0 };
      const variables: Extract<Stmt, { kind: "action" }>["variables"] = [{ field: "player", bits: 32, name: "flingy", expr: bin("+", part, k(u((base - DEATHS_TABLE) / 4))) }];
      const l = linear(amount)!;
      if (l.terms.length) variables.push({ field: "target", bits: 32, name: "flingy", expr: amount });
      return { kind: "action", record: { ...record, player: 0, target: l.terms.length ? 0 : u(l.c) }, variables, ...where };
    };
    const quarter = this.temp(), half = this.temp(), byte = this.temp(), odd = this.temp();
    out.push({ kind: "assign", target: quarter, value: bin(">>>", v(f), k(2)), ...where }, { kind: "assign", target: byte, value: bin("&", v(f), k(3)), ...where });
    out.push({ kind: "assign", target: half, value: bin(">>>", v(f), k(1)), ...where }, { kind: "assign", target: odd, value: bin("&", v(f), k(1)), ...where });
    // The flingy's control byte 0 (table control): its byte of the dword, as the rest of the flingy says.
    for (let b = 0; b < 4; b++) out.push({ kind: "if", cond: { kind: "compare", op: "==", left: v(byte), right: k(b), ...at }, then: [write(FLINGY_CONTROL, v(quarter), k(0), u(0xff * 2 ** (8 * b)))], ...where } as Stmt);
    out.push(write(FLINGY_SPEED, v(f), value), write(FLINGY_HALT, v(f), halt));
    // The acceleration, a word: its half of the dword.
    const accel = this.single(acceleration, out, where);
    for (const h of [0, 1]) out.push({ kind: "if", cond: { kind: "compare", op: "==", left: v(odd), right: k(h), ...at }, then: [write(FLINGY_ACCELERATION, v(half), h ? this.single(bin("*", accel, k(65536)), out, where) : accel, h ? 0xffff0000 : 0xffff)], ...where } as Stmt);
    return out;
  }

  /** A Set Deaths of `value` into the cell at `addr`: the dword, or (masked) its byte, word or bit. */
  cellWrite(addr: number, width: 1 | 2 | 4 | "bit", value: NumExpr, where: { at: At; label: string }, bit = 0): Stmt {
    const sh = 8 * (addr & 3) + (width === "bit" ? bit : 0);
    const mask = width === 4 ? 0 : u((width === "bit" ? 1 : 2 ** (8 * width) - 1) * 2 ** sh);
    const record: ActionRecord = { location: mask, text: 0, wav: 0, time: 0, player: u(((addr & ~3) - DEATHS_TABLE) / 4), target: 0, unitId: 0, type: SET_DEATHS_ACTION, modifier: 7, flags: 0, padding: 0, mask: mask ? MASKED_MARK : 0 };
    const l = linear(value)!;
    if (!l.terms.length) return { kind: "action", record: { ...record, target: u(u(l.c) * 2 ** sh) }, ...where };
    const shifted: NumExpr = sh ? ({ kind: "binary", op: "*", left: value, right: { kind: "const", value: 2 ** sh }, at: where.at, label: where.label } as NumExpr) : value;
    return { kind: "action", record, variables: [{ field: "target", bits: 32, name: "cell", expr: shifted }], ...where };
  }

  /** A value as one variable times a constant plus a constant — what a field holds — or into a variable of the emitter's own first. */
  single(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if ((linear(e)?.terms.length ?? 2) <= 1) return e;
    const t = this.temp();
    pre.push(...this.set(t, e, where));
    return { kind: "var", id: t };
  }

  /** A player's race or slot, or supply, which a map of our own reads from memory (`fact`): one player, known. */
  facts(r: ReadSource): r is Extract<ReadSource, { source: "player" | "supply" }> {
    const one = r.source !== "condition" && (r.player <= 11 || (r.player === CURRENT_PLAYER && this.owner !== undefined));
    return one && (r.source === "supply" || r.source === "player");
  }

  /** The program's owner, the current player while it runs (a map of our own). */
  owner?: number;
  /** The map's player settings (a map of our own). */
  players: MapPlayers = ANY_PLAYERS;

  /** Each `rose()` and `once()`'s latch: a variable of the emitter's own, by the place in the script. */
  latches = new Map<BoolExpr, string>();

  /**
   * A player's race or slot (a byte of the player table: its bits of the dword, moved down) or supply (the race's
   * table, the player's own race read first when none is given — a slot with none has no supply — then halves, as the
   * top bar shows it, half a supply in use counting as one), as the Python side reads them. A computer's slot reads 5
   * in a Use Map Settings game and 1 in melee: both 1. (The current player is the owner.)
   */
  fact(target: string, r: Extract<ReadSource, { source: "player" | "supply" }>, where: { at: At; label: string }): Stmt[] {
    const p = r.player === CURRENT_PLAYER ? this.owner! : r.player;
    const at = { at: where.at, label: where.label };
    const k = (value: number): NumExpr => ({ kind: "const", value });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const byte = (addr: number): NumExpr => {
      const sh = 8 * (addr & 3);
      return { kind: "binary", op: ">>>", left: memoryRead(addr & ~3, u(0xff * 2 ** sh), where), right: k(sh), ...at } as NumExpr;
    };
    const eq = (x: NumExpr, n: number): BoolExpr => ({ kind: "compare", op: "==", left: x, right: k(n), ...at });
    if (r.source === "player" && r.fact === "left") {
      // Whether a player who was in the map's settings as a human or a computer is gone, as eudplib's f_playerexist
      // asks: their trigger list empty (the game empties it when they leave, and it is empty for a slot nobody took).
      // A slot the map gives nobody: 0.
      // (One condition: the list's first node, read where it is, exactly the list's end.)
      const out: Stmt[] = [{ kind: "assign", target, value: k(0), ...where }];
      if (p >= 8 || !this.players.slots.includes(p)) return out;
      const record: ConditionRecord = { location: 0, player: u((TRIGGER_LISTS + 12 * p + 8 - DEATHS_TABLE) / 4), amount: u(~(TRIGGER_LISTS + 12 * p + 4)), unitId: 0, comparison: 10, type: DEATHS_TYPE, resource: 0, flags: 0, mask: 0 };
      out.push({ kind: "if", cond: { kind: "cond", record }, then: [{ kind: "assign", target, value: k(1), ...where }], ...where } as Stmt);
      return out;
    }
    if (r.source === "player") {
      const out: Stmt[] = [{ kind: "assign", target, value: byte(PLAYER_BYTES[r.fact as "race" | "slot"] + p), ...where }];
      if (r.fact === "slot") out.push({ kind: "if", cond: eq(v(target), 5), then: [{ kind: "assign", target, value: k(1), ...where }], ...where } as Stmt);
      return out;
    }
    const table = (race: number): NumExpr => memoryRead(SUPPLY_TABLES[r.of] + 4 * (36 * race + p), undefined, where);
    const half = this.temp(), out: Stmt[] = [];
    if (r.race !== null) out.push({ kind: "assign", target: half, value: table(r.race), ...where });
    else {
      const race = this.temp();
      out.push({ kind: "assign", target: race, value: byte(PLAYER_BYTES.race + p), ...where }, { kind: "assign", target: half, value: k(0), ...where });
      for (const n of [0, 1, 2]) out.push({ kind: "if", cond: eq(v(race), n), then: [{ kind: "assign", target: half, value: table(n), ...where }], ...where } as Stmt);
    }
    const sum: NumExpr = r.of === "used" ? { kind: "binary", op: "+", left: v(half), right: k(1), ...at } as NumExpr : v(half);
    out.push({ kind: "assign", target, value: { kind: "binary", op: ">>>", left: sum, right: k(1), ...at } as NumExpr, ...where });
    return out;
  }

  /** The statements that set `target` to `e`. */
  set(target: string, e: NumExpr, where: { at: At; label: string }): Stmt[] {
    const assign = (value: NumExpr): Stmt => ({ kind: "assign", target, value, ...where });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const zero: NumExpr = { kind: "const", value: 0 };
    const pre: Stmt[] = [];
    if (e.kind === "read" && gameRead(e.read)) return [assign(e)];
    // (A byte of memory: the read moves its bits down itself, `Emitter.readGame`; or up, at a value's address.)
    if (e.kind === "binary" && e.op === ">>>" && e.left.kind === "read" && gameRead(e.left.read) && e.right.kind === "const") return [assign(e)];
    if (e.kind === "binary" && e.op === "*" && e.left.kind === "read" && gameRead(e.left.read) && e.left.read.epd && e.right.kind === "const") return [assign(e)];
    if (e.kind === "read" && this.facts(e.read)) return this.fact(target, e.read, where);
    if (e.kind === "tableRead" && !e.cell.special) return this.tableRead(target, e.cell, where);
    if (e.kind === "ternary") {
      const cond = this.cond(e.cond, pre, where);
      return [...pre, { kind: "if", cond, then: this.set(target, e.whenTrue, where), else: this.set(target, e.whenFalse, where), ...where }];
    }
    if (e.kind === "intrinsic" && e.name === "abs") {
      let a = this.flat(e.args[0], pre, where);
      // (A map of our own: anything more than a variable plus a constant into a variable of the emitter's own first, so
      // that its sign is one condition, and the target is never set from itself — a variable of the emitter's own
      // cannot be copied, which that would need.)
      a = this.side(a, pre, where);
      if (linear(a)) return [...pre, { kind: "if", cond: { kind: "compare", op: "<", left: a, right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: a, at: where.at })], else: [assign(a)], ...where }];
      // (A product or a quotient: into the target first, its sign tested there.)
      return [...pre, assign(a), { kind: "if", cond: { kind: "compare", op: "<", left: v(target), right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: v(target), at: where.at })], ...where }];
    }
    if (e.kind === "intrinsic" && this.tabled(e)) return e.name === "atan2" ? this.arcTangent(target, e, where) : this.sine(target, e, where);
    if (e.kind === "intrinsic" && (e.name === "min" || e.name === "max") && e.args.length === 2) {
      // (Compared with each other: each one variable plus a constant — bits under a mask computed first.)
      const [a, b] = this.each(e.args, pre, where, (x) => {
        const y = this.side(x, pre, where);
        return y.kind === "binary" && y.op === "&" ? this.sum(y, pre, where) : y;
      });
      const cond: BoolExpr = { kind: "compare", op: e.name === "min" ? "<" : ">", left: a, right: b, ...(e.unsigned ? { unsigned: true } : {}), ...where };
      return [...pre, { kind: "if", cond, then: [assign(a)], else: [assign(b)], ...where }];
    }
    const value = this.flat(e, pre, where);
    return [...pre, assign(value)];
  }

  /** A sine, a cosine or an arc tangent of a table the program has (a map of our own): written out as statements. */
  tabled(e: Extract<NumExpr, { kind: "intrinsic" }>): boolean {
    return (e.name === "sin" || e.name === "cos" || e.name === "atan2") && e.args.length === 2 && !!e.table && !!this.arrays.get(e.table)?.values;
  }

  /**
   * `target` = table[i] and the way to table[i + 1] that f of 2^bits is, towards zero — the simulator's `between`: the
   * difference of the two cells read once, its sign tested, and its magnitude times f (a product the emitter makes
   * cheaply: the difference is small, f below 2^bits) shifted down. Cell i + 1 past the end reads 0, as fixedMath has
   * it for the arc tangents' table and as the sine's first cell is (sin 0), the cell after its last.
   */
  between(target: string, table: string, i: string, last: number, f: string, bits: number, where: { at: At; label: string }): Stmt[] {
    const values = this.arrays.get(table)!.values!, n = values.length;
    const cell = (k: number) => (k < n ? values[k] : 0);
    let most = 0;
    for (let k = 0; k <= last; k++) most = Math.max(most, Math.abs(cell(k + 1) - values[k]));
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const [a, d] = [this.temp(), this.temp()];
    const v = (id: string, range: [number, number]): NumExpr => ({ kind: "var", id, range } as NumExpr);
    const read = (index: NumExpr): NumExpr => ({ kind: "element", array: table, index, at: where.at, range: [low, high] } as NumExpr);
    const part = (by: NumExpr): NumExpr => ({ kind: "binary", op: ">>>", right: { kind: "const", value: bits }, ...where, range: [0, most],
      left: { kind: "binary", op: "*", left: by, right: v(f, [0, 2 ** bits - 1]), ...where, range: [0, most * (2 ** bits - 1)] } } as NumExpr);
    return [
      { kind: "assign", target: a, value: read(v(i, [0, last])), ...where },
      { kind: "assign", target: d, value: { kind: "binary", op: "-", left: read({ kind: "binary", op: "+", left: v(i, [0, last]), right: { kind: "const", value: 1 }, ...where, range: [1, last + 1] } as NumExpr), right: v(a, [low, high]), ...where, range: [-most, most] } as NumExpr, ...where },
      { kind: "if", cond: { kind: "compare", op: "<", left: v(d, [-most, most]), right: { kind: "const", value: 0 }, ...where },
        then: [{ kind: "assign", target, value: { kind: "binary", op: "-", left: v(a, [low, high]), right: part({ kind: "unary", op: "-", expr: v(d, [-most, -1]), at: where.at, range: [1, most] } as NumExpr), ...where }, ...where }],
        else: [{ kind: "assign", target, value: { kind: "binary", op: "+", left: v(a, [low, high]), right: part(v(d, [0, most])), ...where }, ...where }], ...where },
    ];
  }

  /**
   * sin(x) or cos(x) of a fixed number (a map of our own), as the simulator's `fixedSin`: x times the scale (a product by
   * a constant) is the place in the table — a quarter turn on for cos — its bits 16 to 27 the cell, the sixteen below
   * the way to the next; then `between`. Statements of what the emitter makes already.
   */
  sine(target: string, e: Extract<NumExpr, { kind: "intrinsic" }>, where: { at: At; label: string }): Stmt[] {
    const pre: Stmt[] = [];
    const [x, scale] = this.each(e.args, pre, where);
    const [at, f, i] = [this.temp(), this.temp(), this.temp()];
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const k = (value: number): NumExpr => ({ kind: "const", value });
    const bin = (op: "&" | ">>>" | "+", left: NumExpr, right: NumExpr, range?: [number, number]): NumExpr => ({ kind: "binary", op, left, right, ...where, ...(range ? { range } : {}) } as NumExpr);
    const place: NumExpr = e.name === "cos" ? bin("+", v(at), k(1024 * 65536)) : v(at);
    return [
      ...pre,
      ...this.set(at, { kind: "intrinsic", name: "fmul", args: [x, scale], ...where }, where),
      { kind: "assign", target: f, value: bin("&", v(at), k(0xffff), [0, 0xffff]), ...where },
      { kind: "assign", target: i, value: bin(">>>", bin("&", place, k(0x0fff0000), [0, 0x0fff0000]), k(16), [0, 4095]), ...where },
      ...this.between(target, e.table!, i, 4095, f, 16, where),
    ];
  }

  /**
   * atan2(y, x) of fixed numbers (a map of our own), as the simulator's `fixedAtan2`: the smaller magnitude over the
   * larger (a quotient of fixed numbers; over 2^31, the magnitude of the least number, a shift), its bits from 6 up the
   * cell of the table and the six below the way to the next (`between`), then put in its octant. Of (0, 0), 0: the
   * quotient by 0 is 0, and so is the table's first cell.
   */
  arcTangent(target: string, e: Extract<NumExpr, { kind: "intrinsic" }>, where: { at: At; label: string }): Stmt[] {
    const pre: Stmt[] = [];
    const [y0, x0] = this.each(e.args, pre, where);
    const [Y, X, ay, ax, small, large, r, i, f, t] = Array.from({ length: 10 }, () => this.temp());
    const v = (id: string, range?: [number, number]): NumExpr => ({ kind: "var", id, ...(range ? { range } : {}) } as NumExpr);
    const k = (value: number): NumExpr => ({ kind: "const", value });
    const assign = (target: string, value: NumExpr): Stmt => ({ kind: "assign", target, value, ...where });
    const cmp = (op: CompareOp, left: NumExpr, right: NumExpr, unsigned = false): BoolExpr => ({ kind: "compare", op, left, right, ...(unsigned ? { unsigned: true } : {}), ...where });
    const range = (x: NumExpr) => (x as NumExpr & { range?: Range }).range;
    // (A magnitude of 2^31 — the least number's — only when a side's range has it.)
    const least = [x0, y0].some((x) => { const rx = range(x); return !rx || rx[0] <= -2147483648; });
    const ratio = (over: string, under: string): Stmt[] => {
      // (Both magnitudes below 2^31 here, the one over the other at most 1: a quotient of 17 steps, `divide`'s `ratio`.)
      const q = assign(r, { kind: "intrinsic", name: "fdiv", args: [v(over, [0, 2147483647]), v(under, [0, 2147483647])], ratio: true, ...where } as NumExpr);
      if (!least) return [q];
      return [{ kind: "if", cond: cmp("==", v(under), k(-2147483648)), then: [assign(r, { kind: "binary", op: ">>>", left: v(over), right: k(15), ...where })], else: [q], ...where }];
    };
    const HALF_PI = Math.round((Math.PI / 2) * 65536), PI = Math.round(Math.PI * 65536);
    return [
      ...pre,
      assign(Y, y0), assign(X, x0),
      ...this.set(ay, { kind: "intrinsic", name: "abs", args: [v(Y)], ...where }, where),
      ...this.set(ax, { kind: "intrinsic", name: "abs", args: [v(X)], ...where }, where),
      { kind: "if", cond: cmp("<=", v(ay), v(ax), true), then: [assign(small, v(ay)), assign(large, v(ax))], else: [assign(small, v(ax)), assign(large, v(ay))], ...where },
      ...ratio(small, large),
      assign(i, { kind: "binary", op: ">>>", left: v(r, [0, 65536]), right: k(6), ...where, range: [0, 1024] } as NumExpr),
      assign(f, { kind: "binary", op: "&", left: v(r, [0, 65536]), right: k(63), ...where, range: [0, 63] } as NumExpr),
      ...this.between(t, e.table!, i, 1024, f, 6, where),
      { kind: "if", cond: cmp(">", v(ay), v(ax), true), then: [assign(t, { kind: "binary", op: "-", left: k(HALF_PI), right: v(t), ...where })], ...where },
      { kind: "if", cond: cmp("<", v(X), k(0)), then: [assign(t, { kind: "binary", op: "-", left: k(PI), right: v(t), ...where })], ...where },
      { kind: "if", cond: cmp("<", v(Y), k(0)), then: [assign(t, { kind: "unary", op: "-", expr: v(t), at: where.at } as NumExpr)], ...where },
      assign(target, v(t)),
    ];
  }

  /** A value the emitter reads cells for as it is (a cell of a list known when the map is built, a shift): left as it is. */
  table(e: NumExpr): boolean {
    return e.kind === "element" || (e.kind === "binary" && (e.op === ">>" || e.op === ">>>") && e.right.kind === "const" && !!linear(e.left));
  }

  /** A comparison's side as a variable plus a constant: a longer sum computed first. */
  side(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (side(e)) return e;
    const t = this.temp();
    pre.push(...this.set(t, e, where));
    return { kind: "var", id: t };
  }

  /**
   * A value as a sum the emitter writes: anything more computed first into a variable of its own — `x & k` too, which
   * only a comparison with a constant reads where it is (a masked condition).
   */
  sum(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (linear(e)) return e;
    const t = this.temp();
    pre.push(...this.set(t, e, where));
    return { kind: "var", id: t };
  }

  /**
   * A cell of an array a map of our own keeps, compared with a constant, left in the test, where a condition reads it
   * at its index (`Emitter.cellConds`): as 32 bits — a signed comparison as the ranges of bits it holds for, one, or
   * two either side of the sign — after a test that the index is inside the array, unless the value ranges know it is
   * (outside, the cell reads 0). The test stays where it was written, so a range of its index known from the parts of
   * a `&&` before it holds where it is read. Null when it is not that.
   */
  cellCompare(c: Extract<BoolExpr, { kind: "compare" }>, pre: Stmt[], where: { at: At; label: string }): BoolExpr | null {
    if (c.unsigned === "left" || c.unsigned === "right") return null;
    const [el, k, op] = c.left.kind === "element" && c.right.kind === "const" ? [c.left, c.right.value, c.op]
      : c.right.kind === "element" && c.left.kind === "const" ? [c.right, c.left.value, FLIP[c.op] as CompareOp] : [null, 0, c.op];
    if (!el || !inRegion(this.arrays, el.array)) return null;
    const a = this.arrays.get(el.array)!;
    const index = this.flat(el.index, pre, where), r = (index as NumExpr & { range?: readonly [number, number] }).range;
    // (A cell is read at one variable plus a constant: an index under a mask — `xs[i & 3]`, which `side` would keep as a
    // masked side — and one of more terms — `board[y * W + x]` — are computed first.)
    const shape = side(index);
    const at = shape && "mask" in shape && shape.mask !== undefined ? this.sum(index, pre, where) : this.side(index, pre, where), cell: NumExpr = { ...el, index: at };
    const raw = (o: CompareOp, v: number): BoolExpr => ({ kind: "compare", op: o, left: cell, right: { kind: "const", value: u(v) }, unsigned: true, ...where });
    const all = (items: BoolExpr[]): BoolExpr => (items.length === 0 ? { kind: "const", value: true } : items.length === 1 ? items[0] : { kind: "and", items });
    // The bits between two numbers, ends included, read as they are.
    const between = (lo: number, hi: number): BoolExpr => all([...(u(lo) > 0 ? [raw(">=", lo)] : []), ...(u(hi) < MAX ? [raw("<=", hi)] : [])]);
    let test: BoolExpr;
    if (c.unsigned === true || op === "==" || op === "!=" || a.kind === "boolean") test = raw(op, k);
    else {
      // (Signed: the numbers it holds for, from the lowest to the highest, as bits — those below zero are above
      // 2147483647 as bits.)
      const K = k | 0, MIN_S = -2147483648, MAX_S = 2147483647;
      const [lo, hi] = op === "<" ? [MIN_S, K - 1] : op === "<=" ? [MIN_S, K] : op === ">" ? [K + 1, MAX_S] : [K, MAX_S];
      test = lo > hi ? { kind: "const", value: false } : lo >= 0 || hi < 0 ? between(lo, hi) : { kind: "or", items: [between(lo, -1), between(0, hi)] };
    }
    if (r && r[0] >= 0 && r[1] < a.length) return test;
    // (What a cell outside reads, 0, against the constant: the index outside is then enough.)
    const holds = (e: BoolExpr): boolean => e.kind === "const" ? e.value : e.kind === "and" ? e.items.every(holds) : e.kind === "or" ? e.items.some(holds)
      : e.kind === "compare" ? compareU32(e.op, 0, (e.right as { value: number }).value) : false;
    const inside: BoolExpr = { kind: "compare", op: "<", left: at, right: { kind: "const", value: a.length }, unsigned: true, ...where };
    const guarded: BoolExpr = { kind: "and", items: [inside, test] };
    return holds(test) ? { kind: "or", items: [{ ...inside, op: ">=" }, guarded] } : guarded;
  }

  cond(c: BoolExpr, pre: Stmt[], where: { at: At; label: string }): BoolExpr {
    switch (c.kind) {
      // (A map of our own: random() a bit drawn into a variable of its own first, and tested.)
      case "random": {
        const t = this.temp();
        pre.push({ kind: "assign", target: t, value: { kind: "randomInt", bound: { kind: "const", value: 2 }, at: where.at, label: where.label }, ...where });
        return { kind: "compare", op: "==", left: { kind: "var", id: t }, right: { kind: "const", value: 1 }, unsigned: true, ...where };
      }
      case "compare": {
        const asked = this.asked(c);
        if (asked) return asked;
        const cell = this.cellCompare(c, pre, where);
        if (cell) return cell;
        let [left, right] = this.each([c.left, c.right], pre, where, (x) => this.side(x, pre, where));
        // (Bits under a mask are read where they are against a constant only.)
        const masked = (x: NumExpr) => x.kind === "binary" && x.op === "&";
        if (masked(left) && right.kind !== "const") left = this.sum(left, pre, where);
        if (masked(right) && left.kind !== "const") right = this.sum(right, pre, where);
        return { ...c, left, right };
      }
      case "test": return { ...c, expr: this.side(this.flat(c.expr, pre, where), pre, where) };
      case "and": case "or": {
        if (!c.items.slice(1).some(holdsCall)) {
          // (A later part's cells are read ahead of the whole, before the parts that decide whether it is read: what a
          // range of its index knows from them does not hold there.)
          return { ...c, items: c.items.map((x, i) => (i === 0 ? this.cond(x, pre, where) : this.ahead(() => this.cond(x, pre, where)))) };
        }
        // A later part calls: it runs only when the parts before it leave the answer open. The answer so far is kept
        // in a variable of the emitter's own, each later part worked out under an `if` on it.
        const t = this.temp(), so: BoolExpr = { kind: "var", id: t };
        const first = this.cond(c.items[0], pre, where);
        pre.push({ kind: "assignBool", target: t, value: first, ...where });
        for (const x of c.items.slice(1)) {
          const inner: Stmt[] = [];
          const value = this.cond(x, inner, where);
          pre.push({ kind: "if", cond: c.kind === "and" ? so : { kind: "not", expr: so }, then: [...inner, { kind: "assignBool", target: t, value, ...where }], ...where });
        }
        return so;
      }
      case "not": return { ...c, expr: this.cond(c.expr, pre, where) };
      // (A map of our own: `rose()` and `once()` against a latch of their own — a variable of the emitter's own for each
      // place in the script, 0 when the map starts, kept from one time to the next: so when it was so, it says no; so
      // now, the latch set; not so, a rise's latch cleared.)
      case "edge": {
        let latch = this.latches.get(c);
        if (!latch) this.latches.set(c, (latch = this.temp()));
        const held = this.temp(), t = this.temp();
        const v = (id: string): BoolExpr => ({ kind: "var", id });
        pre.push({ kind: "assignBool", target: held, value: this.cond(c.cond, pre, where), ...where });
        pre.push({ kind: "assignBool", target: t, value: { kind: "and", items: [v(held), { kind: "not", expr: v(latch) }] }, ...where } as Stmt);
        pre.push({ kind: "assignBool", target: latch, value: c.edge === "rose" ? v(held) : { kind: "or", items: [v(latch), v(held)] }, ...where } as Stmt);
        return v(t);
      }
      // (A ?: of booleans, on a map of our own: the side its test picks worked out under an `if` into a variable of the
      // emitter's own — the other side is never read, as in the script.)
      case "ternary": {
        const t = this.temp();
        const test = this.cond(c.cond, pre, where);
        const side = (x: BoolExpr): Stmt[] => {
          const inner: Stmt[] = [];
          const value = this.cond(x, inner, where);
          return [...inner, { kind: "assignBool", target: t, value, ...where }];
        };
        pre.push({ kind: "if", cond: test, then: side(c.whenTrue), else: side(c.whenFalse), ...where });
        return { kind: "var", id: t };
      }
      case "call": {
        if (!c.call.result) return c;
        this.call(c.call, pre, where);
        return { kind: "var", id: c.call.result.decl.id };
      }
      // (A cell of an array of booleans, as a test: read by the condition, or into a variable of the emitter's own first.)
      case "element": {
        const cell = this.cellCompare({ kind: "compare", op: "!=", left: c as NumExpr, right: { kind: "const", value: 0 }, ...where }, pre, where);
        if (cell) return cell;
        const t = this.temp();
        pre.push(...this.set(t, { ...c, index: this.unsure(c.index) } as NumExpr, where));
        return { kind: "var", id: t };
      }
      default: return c;
    }
  }

  /** The statements as the emitter takes them; each one whose rewriting it would not take whole, as it was. */
  stmts(list: Stmt[]): Stmt[] {
    return list.flatMap((s) => this.stmt(s));
  }

  stmt(s: Stmt): Stmt[] {
    const where = this.at(s);
    // (A store into a `u8` or `u16`: the value stopped at its top first.)
    {
      if (s.kind === "assign" && this.bits.has(s.target)) s = { ...s, value: this.top(s.value, this.bits.get(s.target), where) };
      else if (s.kind === "declare" && s.decl.bits && s.init) s = { ...s, init: this.top(s.init as NumExpr, 2 ** s.decl.bits - 1, where) };
      else if (s.kind === "store" && !isTest(s.value) && this.arrayTop(s.array)) s = { ...s, value: this.top(s.value as NumExpr, this.arrayTop(s.array), where) };
      else if (s.kind === "declareArray" && this.arrayTop(s.array)) {
        const top = this.arrayTop(s.array);
        s = { ...s, ...(s.init ? { init: s.init.map((v) => (isTest(v) ? v : this.top(v as NumExpr, top, where))) } : {}), ...(s.fill !== undefined && !isTest(s.fill) ? { fill: this.top(s.fill as NumExpr, top, where) } : {}) } as Stmt;
      }
    }
    const plain = (e: NumExpr) => !!linear(e);
    switch (s.kind) {
      case "assign": return plain(s.value) ? [s] : this.set(s.target, s.value, where);
      case "declare": {
        if (s.decl.kind === "boolean") {
          const pre: Stmt[] = [];
          const init = this.cond(s.init as BoolExpr, pre, where);
          return [...pre, { ...s, init }];
        }
        const init = s.init as NumExpr;
        if (s.decl.kind !== "number" || plain(init)) return [s];
        return [{ ...s, init: { kind: "const", value: 0 } }, ...this.set(s.decl.id, init, where)];
      }
      case "block": return [{ ...s, body: this.stmts(s.body) }];
      case "store": {
        // A value the emitter does not take as it is into a variable of its own first; the index likewise. (A map of
        // our own: a test stored into an array of booleans, into a variable of its own as 1 or 0.)
        const pre: Stmt[] = [];
        if (isTest(s.value)) {
          // (The index first, as JavaScript reads it: the test may call what changes it.)
          let index = plain(s.index) ? s.index : this.sum(this.flat(s.index, pre, where), pre, where);
          const mark = pre.length, t = this.temp();
          const value = this.cond(s.value as BoolExpr, pre, where);
          pre.push({ kind: "assignBool", target: t, value, ...where });
          index = this.before(index, pre, mark, where);
          return [...pre, { ...s, index, value: { kind: "var", id: t } }];
        }
        const value = s.value as NumExpr;
        let index = plain(s.index) ? s.index : this.sum(this.flat(s.index, pre, where), pre, where);
        const mark = pre.length;
        let stored: NumExpr = value;
        // (A map of our own: a sum of cells, each at an index that is a sum, stored as it is — the store reads its cells
        // first — so that a cell read goes straight into the store's number, not into a variable of its own copied there.)
        const ofCells = !!linear(value, (x) => (x.kind === "element" && !!linear(x.index) ? "@cell" : null));
        if (!plain(value) && !this.table(value) && !ofCells) {
          const t = this.temp();
          pre.push(...this.set(t, value, where));
          stored = { kind: "var", id: t };
        }
        // (A cell at an index that is more than a sum — a `?:`, a product — read where it is, its index worked out first.)
        else if (value.kind === "element" && !linear(value.index)) stored = this.flat(value, pre, where);
        index = this.before(index, pre, mark, where);
        return pre.length ? [...pre, { ...s, index, value: stored }] : [s];
      }
      case "call": {
        const pre: Stmt[] = [];
        this.call(s.call, pre, where);
        return pre;
      }
      case "declareArray": {
        // The cells' values, in JavaScript's order; a test as 1 or 0, anything more than a sum, into variables of the
        // emitter's own first.
        const values = [...(s.init ?? []), ...(s.fill !== undefined ? [s.fill] : [])];
        if (values.every((v) => !isTest(v) && plain(v as NumExpr))) return [s];
        const pre: Stmt[] = [];
        const nums = values.map((v) => {
          if (!isTest(v)) return v as NumExpr;
          const t = this.temp();
          pre.push({ kind: "assignBool", target: t, value: this.cond(v as BoolExpr, pre, where), ...where });
          return { kind: "var", id: t } as NumExpr;
        });
        const flat = this.each(nums, pre, where, (x) => (plain(x) ? x : this.sum(x, pre, where)));
        return [...pre, { ...s, ...(s.init ? { init: flat.slice(0, s.init.length) } : {}), ...(s.fill !== undefined ? { fill: flat[flat.length - 1] } : {}) }];
      }
      case "print": {
        // The values of a printed text, as the emitter takes them and in JavaScript's order: each worked out before a
        // later one's call, a value more than a sum into a variable of the emitter's own first.
        if (s.parts.every((p) => (p.kind !== "number" && p.kind !== "char") || plain(p.expr))) return [s];
        const pre: Stmt[] = [];
        const valued = s.parts.filter((p): p is Extract<TextPart, { kind: "number" | "char" }> => p.kind === "number" || p.kind === "char");
        const exprs = this.each(valued.map((p) => p.expr), pre, where, (x) => (plain(x) ? x : this.sum(x, pre, where)));
        let i = 0;
        return [...pre, { ...s, parts: s.parts.map((p) => (p.kind === "number" || p.kind === "char" ? { ...p, expr: exprs[i++] } : p)) }];
      }
      case "return": {
        // The value given back, as the emitter takes it: a boolean's test flattened, a number into a variable of the
        // emitter's own first when it is more than a sum.
        const kind = this.returning[this.returning.length - 1];
        if (s.value === undefined || (kind !== "number" && kind !== "boolean")) return [s];
        const pre: Stmt[] = [];
        if (kind === "boolean") {
          const value = this.cond(s.value as BoolExpr, pre, where);
          return [...pre, { ...s, value }];
        }
        if (plain(s.value as NumExpr)) return [s];
        const t = this.temp();
        return [...this.set(t, s.value as NumExpr, where), { ...s, value: { kind: "var", id: t } }];
      }
      case "if": {
        const pre: Stmt[] = [];
        const cond = this.cond(s.cond, pre, where);
        const head = pre.length ? pre : null;
        // (The test as rewritten, whether or not anything comes before it: a cell compared with a constant is read by
        // the condition itself.)
        const out: Stmt = { ...s, cond, then: this.stmts(s.then), ...(s.else ? { else: this.stmts(s.else) } : {}) };
        return head ? [...head, out] : [out];
      }
      case "while": case "for": {
        const pre: Stmt[] = [];
        const cond = s.cond ? this.cond(s.cond, pre, where) : undefined;
        const body = this.stmts(s.body);
        const update = s.kind === "for" ? this.stmts(s.update) : [];
        if (!pre.length) return [s.kind === "for" ? { ...s, cond, body, update } : { ...s, cond, body }];
        // The test needs values computed first: at the top of each turn, before it.
        const leave: Stmt = { kind: "if", cond: { kind: "not", expr: cond! }, then: [{ kind: "break", ...where }], ...where };
        return [s.kind === "for" ? { ...s, cond: undefined, body: [...pre, leave, ...body], update } : { ...s, cond: undefined, body: [...pre, leave, ...body] }];
      }
      case "do": {
        // (A map of our own: the test as rewritten; what it needs computed first runs before it at every turn's end,
        // `before`, where a `continue` lands too — the emitter lays it out at the loop's continue label.)
        const pre: Stmt[] = [];
        const cond = this.cond(s.cond, pre, where);
        // (What the texts pass put before the test stays, rewritten as statements, and the test's own needs follow it.)
        const before = [...this.stmts(s.before ?? []), ...pre];
        return [{ ...s, body: this.stmts(s.body), cond, ...(before.length ? { before } : {}) }];
      }
      case "unrolled": return [{ ...s, iterations: s.iterations.map((it) => this.stmts(it)) }];
      case "try": return [{ ...s, body: this.stmts(s.body), catch: this.stmts(s.catch) }];
      // (A task's arguments as a call's, worked out where it is started; its body rewritten as an inlined call's.)
      case "start": {
        const pre: Stmt[] = [];
        this.call(s.call, pre, where);
        const made = pre.pop() as Extract<Stmt, { kind: "call" }>;
        return [...pre, { ...s, call: made.call }];
      }
      case "parallel": return [{ ...s, branches: s.branches.map((b) => this.stmts(b)) }];
      case "watch": return [{ ...s, handler: this.stmts(s.handler) }];
      case "switch": {
        const pre: Stmt[] = [];
        // (Tested against each case: one variable plus a constant — bits under a mask computed first.)
        let value = side(s.value) ? s.value : this.side(this.flat(s.value, pre, where), pre, where);
        if (value.kind === "binary" && value.op === "&") value = this.sum(value, pre, where);
        const out: Stmt = { ...s, value, cases: s.cases.map((c) => ({ ...c, body: this.stmts(c.body) })) };
        return pre.length ? [...pre, out] : [out];
      }
      case "assignBool": {
        const pre: Stmt[] = [];
        const value = this.cond(s.value, pre, where);
        return [...pre, { ...s, value }];
      }
      case "action": return s.variables?.length || s.text?.kind === "template" ? this.action(s, where) : [s];
      case "centerLocation": return this.stmts(this.centerLocation(s, where));
      case "tableWrite": {
        const out = this.tableWrite(s, where);
        return out ? this.stmts(out) : [s];
      }
      default: return [s];
    }
  }
}

/**
 * A statement with the calls of functions that are one `return` of a number put in their place, the parameters
 * replaced by the arguments: `cellAt(mapX, mapY)` is `CELLS[mapY * SIZE + mapX]`. Only where every argument is a sum
 * the emitter lowers (reading it twice is reading it once); the function itself stays, for its other calls.
 */
function inlined(x: unknown, functions: Map<string, FuncDecl>, depth = 0): unknown {
  if (Array.isArray(x)) return x.map((y) => inlined(y, functions, depth));
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  if (o.kind === "call" && !("label" in o) && depth < 4) {
    const c = (o as Extract<NumExpr, { kind: "call" }>).call;
    // A called function's body, or (a function called once) the body the call carries.
    const f = c.fn ? functions.get(c.fn) : undefined;
    const body = (f ? f.body : c.fn ? undefined : c.body)?.filter((st) => st.kind !== "remark");
    const params = f ? f.params : c.params.map((p) => p.decl);
    const ret = body?.length === 1 && body[0].kind === "return" ? body[0].value : undefined;
    if (ret && c.result?.kind === "number" && params.length === c.params.length && params.every((p) => p.kind === "number" && !p.bits) && c.params.every((p) => linear(p.init as NumExpr))) {
      const by = new Map(c.params.map((p) => [p.decl.id, p.init as NumExpr]));
      const put = (e: unknown): unknown => {
        if (Array.isArray(e)) return e.map(put);
        if (!e || typeof e !== "object") return e;
        const v = e as Record<string, unknown>;
        if (v.kind === "var" && by.has(v.id as string)) return by.get(v.id as string);
        return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, put(w)]));
      };
      return inlined(put(ret), functions, depth + 1);
    }
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, inlined(v, functions, depth)]));
}

/**
 * A function's number kept as a value (`fn` on a constant) as a plain number: in a map of our own nothing else keeps
 * the function in the map — the dispatcher's call of it lays it out.
 */
function plainFns(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(plainFns);
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  if (o.kind === "const" && "fn" in o) {
    const plain = { ...o };
    delete plain.fn;
    return plain;
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plainFns(v)]));
}

/** How often the emitter did what is worth counting, for its tests. */
export const emitterCounts = { products: 0, quotients: 0, bits: 0, shifts: 0, fixed: 0, random: 0, reads: 0 };

/** Where a refusal points, at its end: ", line N", and the file when it is not the script's entry file. */
export const refusedAt = (at?: At): string => (at ? `, line ${at.line}${at.file && at.file !== "main.ts" && at.file !== "main.tsx" ? ` of ${at.file}` : ""}` : "");

/**
 * A whole body of statements lowered to one graph: every statement must be the emitter's — a print of a known text is
 * the game's Display Text — and nothing read that the body did not write first (there is no one to copy it in; a copy
 * within the body is made of triggers by the layout). Returns the graph, or why it cannot be.
 */
export function emitBody(body: Stmt[], decls: Map<string, VarDecl>, key: string, functions = new Map<string, FuncDecl>(), arrays = new Map<string, ArrayDecl>(), stackDepth = STACK_DEPTH, owner?: number, players: MapPlayers = ANY_PLAYERS, errors?: ProgramErrors, pass?: Stmt[], after?: Stmt[]): Graph | string {
  const known = new Map(decls);
  for (const f of functions.values()) {
    for (const p of f.params) known.set(p.id, p);
    if (f.result) known.set(f.result.decl.id, f.result.decl);
  }
  const tops = new Map([...known.values()].filter((d) => d.bits).map((d) => [d.id, 2 ** d.bits! - 1]));
  // A called function's body, rewritten once, the first time a call reaches it (a call of itself meanwhile sees it as
  // it was written, and is refused).
  const bodies = new Map<string, Stmt[]>();
  const bodyOf = (id: string): Stmt[] | undefined => {
    const f = functions.get(id);
    if (!f) return undefined;
    let b = bodies.get(id);
    if (!b) {
      bodies.set(id, f.body);
      const rw = new Rewriter(`${key}.f${bodies.size}`, functions, f.result?.kind);
      rw.arrays = arrays;
      rw.owner = owner;
      rw.players = players;
      rw.bits = tops;
      b = rw.stmts(plainFns(inlined(f.body, functions)) as Stmt[]);
      bodies.set(id, b);
    }
    return b;
  };
  const rules = (scope: Scope) => {
    scope.owner = owner;
    scope.players = players;
    scope.functions = functions;
    scope.arrays = arrays;
    scope.bodyOf = bodyOf;
    scope.errors = errors;
  };
  const rw = new Rewriter(key, functions);
  rw.arrays = arrays;
  rw.owner = owner;
  rw.players = players;
  rw.bits = tops;
  const block = rw.stmt(plainFns(inlined({ kind: "block", body, at: body[0]?.at } as Stmt, functions)) as Stmt);
  // The tasks' slots, each start's planned (and the variables of a slot after the first declared).
  const planned = planTasks(block.length === 1 ? block[0] : ({ kind: "block", body: block, at: body[0]?.at } as Stmt), key, known, arrays);
  if (typeof planned === "string") return planned;
  const s = planned.root;
  // (The map's events pass, its statements as the program's: laid out apart, before the run's `@wake`.)
  const passed = pass?.length ? rw.stmt({ kind: "block", body: pass, at: pass[0].at } as Stmt) : [];
  const passStmt: Stmt | undefined = passed.length ? { kind: "block", body: passed, at: pass![0].at } : undefined;
  // (The map's send pass, the input's: laid out apart too, after the last run's end.)
  const aftered = after?.length ? rw.stmt({ kind: "block", body: after, at: after[0].at } as Stmt) : [];
  const afterStmt: Stmt | undefined = aftered.length ? { kind: "block", body: aftered, at: after![0].at } : undefined;
  const scope = new Scope(known);
  rules(scope);
  scope.slots = planned.slots;
  scope.once = planned.once;
  if (passStmt && !scope.stmt(passStmt, false)) return scope.why || "the events pass";
  if (afterStmt && !scope.stmt(afterStmt, false)) return scope.why || "the send pass";
  // (The map's own variables, which no program declares and no run's start sets: 0 as the map starts, one cell each.)
  for (const d of known.values()) if (d.global) scope.declared.add(d.id);
  if (!scope.stmt(s, false)) return scope.why || "?";
  if (scope.refused.size) {
    // (The first that holds a part the emitter never takes, before one refused for how it is put together — a print to
    // all players the front end adds, say, after a closure it cannot keep.)
    const refused = [...scope.refused];
    const first = refused.find((s) => scope.whyOf.get(s)?.never) ?? refused[0];
    return `${scope.whyOf.get(first)?.why || `a ${first.kind} it does not lower`}${refusedAt(first.at)}`;
  }
  const make = (forced: Set<string>, unguarded = new Set<Stmt>()): { e: Emitter; g: Graph | string } => {
    const e = new Emitter(key, scope);
    e.forced = forced;
    e.unguarded = unguarded;
    e.stackDepth = stackDepth;
    // Stacks: each `sp` and `depth` set at the start, which sets every place of each `sp` — the fields of its stack it
    // addresses. (Which stacks there are is known once the functions are laid out: the writes go into this trigger then.)
    const start = scope.recursion ? e.push({ conds: [], items: [] }) : null;
    // The program a coroutine whose wake is its run's `@wake`; when it sleeps or ends, the tasks have their turn.
    e.co = {
      tick: { data: WAKE_TICK },
      at: { data: WAKE_AT },
      reset: { dword: { data: WAKE_NEXT }, modifier: "set", value: { label: e.tasksLabel } },
      yieldTo: e.tasksLabel,
      // At its end the program wakes no more — unless it started tasks, which run on after it (the simulator's rule,
      // and the Python side's): its wake then comes every frame and goes straight to the tasks' turn.
      end: () => {
        if (scope.slots.size) e.open().items.push({ act: { dword: { data: WAKE_TICK }, modifier: "set", value: 0 } }, { act: { dword: { data: WAKE_AT }, modifier: "set", value: { label: e.tasksLabel } } });
        else e.open().items.push({ act: { dword: { data: WAKE_TICK }, modifier: "set", value: U32 - 1 } });
        e.goto(e.tasksLabel);
      },
    };
    e.stmt(s);
    e.co.end();
    // The functions the program calls and the tasks it starts, each of which may call and start more.
    while (true) {
      e.functions();
      e.tasks();
      if (!e.pending.length && !e.pendingTasks.length) break;
    }
    const tasks = e.turnOfTasks();
    // The events pass: in a trigger of its own, kept, which the layout sends the walk to before the run's `@wake`.
    const passAt = `${key}:pass`;
    if (passStmt) {
      e.push({ label: passAt, conds: [], items: [], keep: true });
      e.stmt(passStmt);
      e.goto(PASS_END);
    }
    const afterAt = `${key}:after`;
    if (afterStmt) {
      e.push({ label: afterAt, conds: [], items: [], keep: true });
      e.stmt(afterStmt);
      e.goto(AFTER_END);
    }
    e.settleThrown();
    e.emitDigits();
    if (start) {
      const writes: Write[] = [...[...e.stacks.values()].map((st) => st.sp), ...(e.stacks.size ? [e.depth] : [])].map((target) => ({ target, value: { c: 0, terms: [] } }));
      start.items.unshift(...writes.map((write) => ({ write })));
      for (const w of writes) e.writes.set(w.target, [...(e.writes.get(w.target) ?? []), w]);
    }
    const g = e.graph([...scope.read].filter((id) => !scope.declared.has(id) && !isTemp(id)));
    if (typeof g !== "string" && e.stacks.size) {
      const most = Math.max(...[...e.stacks.values()].map((st) => st.frame)), cells = [...e.stacks.values()].reduce((n, st) => n + st.frame * e.stackDepth, 0);
      if (most > MOST_ACTS) return { e, g: `a function that calls itself and keeps ${most - 1} variables around a call (${MOST_ACTS - 1} at the most)` };
      if (cells > STACK_CELLS_MOST) return { e, g: `stacks of ${cells} cells (${e.stackDepth} calls deep, ${cells / e.stackDepth} cells for a call of each function that calls itself), past the ${STACK_CELLS_MOST} a map of our own lays out: lower the recursion depth in the script's settings` };
      g.cells = [...(g.cells ?? []), ...[...e.stacks.values()].map((st) => ({ id: st.id, cells: st.frame * e.stackDepth }))];
    }
    if (typeof g !== "string" && e.templates.length) g.templates = e.templates;
    if (typeof g !== "string" && tasks) g.tasks = tasks;
    if (typeof g !== "string" && passStmt) g.pass = passAt;
    if (typeof g !== "string" && afterStmt) g.after = afterAt;
    if (typeof g !== "string" && e.regions.size) g.cells = [...e.regions.values(), ...(g.cells ?? [])];
    const cells = typeof g === "string" ? 0 : (g.cells ?? []).reduce((n, r) => n + r.cells, 0);
    if (cells > STACK_CELLS_MOST) return { e, g: `arrays and stacks of ${cells} cells, past the ${STACK_CELLS_MOST} a map of our own lays out (72 bytes a cell)` };
    return { e, g };
  };
  // Built again while it is crowded — a write with more places than a trigger's actions, which the next build copies
  // after its reads instead, or an `if` in one trigger that did not fit, laid out as a branch —
  // until a build finds nothing more to change.
  const forced = new Set<string>(), unguarded = new Set<Stmt>();
  let built = make(forced, unguarded);
  for (let tries = 0; built.g === "crowded" && tries < 16; tries++) {
    const before = forced.size + unguarded.size;
    for (const id of built.e.crowded) {
      if (!built.e.own.has(id) && !isTemp(id)) forced.add(id);
      else for (const [target, ws] of built.e.writes) if (ws.some((w) => w.value.terms.some((t) => t.id === id))) forced.add(target);
    }
    for (const s of built.e.misfits) unguarded.add(s);
    if (forced.size + unguarded.size === before) break;
    built = make(forced, unguarded);
  }
  const g = built.g === "crowded" ? "a branch with too many actions" : built.g;
  if (typeof g === "string") return g;
  if (g.entries.length) return `${g.entries[0].from} is read before the body writes it`;
  return g;
}
