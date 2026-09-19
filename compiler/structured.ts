/**
 * The structured level's front end: walks a `program(() => { … })` body — `let`
 * variables and records, assignments, `if` / `while` / `do` / `for` / `switch`,
 * `break` / `continue`, action statements, calls to functions declared in the body and
 * to `game()` functions from any file — and emits the IR (`ir.ts`), which
 * `python/trigscript.py` lowers to eudplib when the map is saved.
 *
 * What the language means, in the game's terms:
 *
 * - A `let` holding a number is a counter (unsigned 32-bit, `-=` stops at 0); a `let`
 *   holding a boolean is a flag; a `let` holding an object literal is a record, each
 *   field a variable of its own. A `const` is computed when the script is built when it
 *   can be, and is a variable like a `let` (one the checker keeps from being reassigned)
 *   when its value needs the program's variables.
 * - Statements run in order, within one frame, until a `sleep()` or the end of the body;
 *   `while (true) { …; sleep(frames(1)); }` is a game loop running once per frame. A `for`
 *   whose start, bound and step are known when the script is built is unrolled, the loop
 *   variable a value and not a variable of the program.
 * - `if (bring(…) && x >= 3 || !flag)`: conditions are trigger conditions, comparisons
 *   of variables with constants, comparisons between variables, `&&`, `||`, `!`,
 *   `random()`, `rose()`, `once()`. `&&` and `||` short-circuit: when the right side has
 *   an effect (an edge, a call of a game function), it is lowered as control flow and
 *   only runs when the left side has not decided.
 * - `x = y + 3`, `x += y`, `x++`, `x = y * 3`, `x = y / 4`, `y % 4`, `Math.min`, `Math.max`,
 *   `Math.abs`, `clamp()`, `c ? a : b`: arithmetic over variables, each one call of
 *   eudplib's underneath.
 * - Functions declared in the body, and `game()` functions, are inlined at a call.
 *   Arguments pass by value, as in TypeScript: a parameter bound to a build-time value
 *   is that value, one bound to a variable reads that variable directly when the
 *   function never assigns it (free) and is a copy when it does. A function may return a
 *   number, a boolean or a unit, through a temp.
 * - A function met a second time is *called* instead, when it can be: one body in the
 *   built map (`Program.functions`) whose parameters are variables every call sets. It
 *   can be when it never sleeps, keeps no edge of its own (`rose` / `once`) and compiles
 *   with every parameter a variable — a parameter that reaches a field only a build-time
 *   value can fill keeps it inlined. An array reaches a function as itself, so a function
 *   that takes one is a copy an array passed. See `inline` and `settleFunctions`.
 * - A function that calls itself is a called one from the call inside itself on, whether
 *   or not anything else calls it twice (`recursion.ts` is what makes that safe). One
 *   that cannot be called — it sleeps, a parameter reaches a build-time-only field — can
 *   only be copies inside copies, which is an error sixteen deep.
 * - `if (false) …` and `while (false) …` are pruned: what is inside never runs, when the
 *   script is built or in the game.
 * - The amount of `setResources` / `setDeaths` / `setScore` / `setCountdownTimer`, the
 *   unit count of `createUnit` / `killUnitAt` / `removeUnitAt` / `giveUnits` and an
 *   action's unit type may be variables.
 * - What the players do — `keyPressed`, `clicked`, `mouse`, `chatted` — is an `input`
 *   expression; `const m = chatted(…)` and `const at = mouse(…)` are records of the
 *   program's numbers taken when the line runs (`input.ts` has what carries them).
 *
 * Everything the body reads from outside — the library's conditions and actions, the
 * script's constants and helpers — arrives as *hoisted values* (`hoist.ts`): the plan
 * numbers those expressions and the run handed back a thunk for each, called when the
 * walk reaches the expression, so where the source says `bring(P1, units.Marine, base,
 * ">=", 1)` this walker sees a condition record. A thunk that throws is reported at the
 * expression, with a note that it ran when the script was built.
 */
import type * as TS from "typescript";
import { ActionType, PlayerGroup } from "../vendor/triggers";
import type { ActionRecord } from "../vendor/triggers";
import type { HoistedThunks, ProgramPlan } from "./hoist";
import { declarationOf, libraryCallName } from "./hoist";
import { scriptParams } from "./api";
import { hasTextMark, isAction, isBuilder, isChat, isCondition, isDuration, isGameFunction, isGameValue, isInput, isMouse, isPrint, isRead, isReader, isTable, isTrigger, isUnitPick, isUnitQuery, playerColor, READ_ARITY, textParts, type GameFunctionValue, type InputValue, type ReadValue, type ScriptString, type TableValue, type UnitPickValue } from "./runtime";
import { cellMax } from "./tables";
import { HANDLE_PARTS, Scope, TEXT_PARTS, THIS, UNIT_PARTS, type Binding, type Place, type RowField, type RowShape } from "./scope";
import { ACTIONS_WITH_MODIFIER, LowerError } from "./lower";
import { I32_MAX, I32_MIN, IR_VERSION, TEXT_BYTES, U32_MAX, UNIT_FLAGS, UNIT_NUM_FIELDS, UNIT_WRITABLE, eachCall, textHasId, type ActionVariable, type ArithOp, type ArrayDecl, type At, type BoolExpr, type Call, type CompareOp, type FuncDecl, type NumExpr, type Program, type Stmt, type TextExpr, type TextPart, type UnitExpr, type UnitFlag, type UnitNumField, type UnitVerb, type VarDecl } from "./ir";

/** The outcome of a thunk, kept so it runs once whatever asks. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** A body the walker can be in: a program's, or a `game()` function's from any file. */
export interface Body {
  plan: ProgramPlan;
  sf: TS.SourceFile;
  values: HoistedThunks;
  memo: Map<number, Outcome>;
  constMemo: Map<number, Outcome>;
  /** The function's name, for labels; unset for a program. */
  name?: string;
}

export function newBody(plan: ProgramPlan, sf: TS.SourceFile, values: HoistedThunks, name?: string): Body {
  return { plan, sf, values, memo: new Map(), constMemo: new Map(), ...(name ? { name } : {}) };
}

export interface StructuredContext {
  ts: typeof TS;
  checker: TS.TypeChecker;
  body: Body;
  owner: number;
  owners: readonly number[];
  perPlayer: boolean;
  /** The run's strings, by the local id a record's text holds: a text with name() or color() in it becomes a print. */
  strings: readonly ScriptString[];
  error(node: TS.Node, message: string, source?: "compiler" | "script"): void;
  /** The body of a `game()` function, from the value the run made for it; undefined when the compiler cannot place it. */
  resolve(fn: GameFunctionValue): Body | undefined;
}

/** A hoisted expression threw when it was evaluated: reported at the expression, as the script's own error. */
class ValueError extends LowerError {
  readonly node: TS.Node;
  constructor(node: TS.Node, message: string) {
    super(message);
    this.node = node;
  }
}

interface Ctx {
  /** Inside a loop (or, for `break`, a switch): what the jump statements may do here. */
  canBreak?: boolean;
  canContinue?: boolean;
  /** Inside an inlined function: what it returns. `instance`: it returns an instance — which one is settled as its body is walked, and kept here. */
  fn?: { kind: Kind | "text" | "void"; instance?: { name: string; made?: Binding } };
}

/** What a variable of a program holds. */
type Kind = "number" | "boolean" | "unit";

const MAX_INLINE_DEPTH = 16;
const LABEL_LENGTH = 48;
/** The most iterations a `for` is unrolled to. */
export const MAX_UNROLL = 256;
/** Actions whose unit count may be a variable: doing them with n is doing them bit by bit. */
/** The actions whose text may be one made while the map is played: played 2026-09-19, each shows a string written over just before it runs. */
const MADE_TEXT_ACTIONS: ReadonlySet<number> = new Set([ActionType.SetMissionObjectives, ActionType.Transmission, ActionType.LeaderboardControl, ActionType.LeaderboardControlAt, ActionType.LeaderboardResources, ActionType.LeaderboardKills, ActionType.LeaderboardPoints, ActionType.LeaderboardGoalControl, ActionType.LeaderboardGoalControlAt, ActionType.LeaderboardGoalResources, ActionType.LeaderboardGoalKills, ActionType.LeaderboardGoalPoints, ActionType.LeaderboardGreed]);
const COUNT_ACTIONS: ReadonlySet<number> = new Set([ActionType.CreateUnit, ActionType.CreateUnitWithProperties, ActionType.KillUnitAt, ActionType.RemoveUnitAt, ActionType.GiveUnits]);

/** A value the run computed for a hoisted expression (or a parameter bound to one). */
interface Hoisted { value: unknown }

function describe(v: unknown): string {
  if (isCondition(v)) return "a condition";
  if (isAction(v)) return "an action";
  if (isTrigger(v)) return "a trigger";
  if (isDuration(v)) return "a duration";
  if (isRead(v)) return `a value the game holds (${v.ident}())`;
  if (isTable(v)) return `a value the game holds (${v.ident})`;
  if (isUnitQuery(v)) return `the units of the game (${v.ident}())`;
  if (isUnitPick(v)) return `a unit of the game (${v.ident}())`;
  if (isInput(v)) return `what a player does in the game (${v.ident})`;
  if (isMouse(v)) return "where a player's mouse is (mouse())";
  if (isChat(v)) return "what a player typed (chatted())";
  if (isPrint(v)) return "a print()";
  if (isGameFunction(v)) return "a game function";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return "text";
  if (typeof v === "function") return "a function";
  if (v === null || v === undefined) return String(v);
  return typeof v === "object" ? "an object" : `${typeof v} ${String(v)}`;
}

/** The player a trigger is running for, as a player number. */
const CURRENT_PLAYER = 13;

/** Neighbouring pieces of written text as one. */
function mergeText(parts: TextPart[]): TextPart[] {
  const out: TextPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.kind === "text" && last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + p.text };
    else out.push(p);
  }
  return out;
}

/** How many ids of a kind the game has: what a table keyed by that kind has a cell for. */
const KEY_DOMAINS: Record<string, { size: number; what: string }> = {
  player: { size: 12, what: "a player, P1 … P12" },
  unit: { size: 228, what: "a unit type" },
  location: { size: 256, what: "a location" },
  switch: { size: 256, what: "a switch" },
  weapon: { size: 130, what: "a weapon" },
  upgrade: { size: 61, what: "an upgrade" },
  tech: { size: 44, what: "a technology" },
};
type Keyed = Extract<Binding, { kind: "keyed" }>;
type Records = Extract<Binding, { kind: "records" }>;
type Hash = Extract<Binding, { kind: "hash" }>;
/** The slots a Map or a Set over any number starts with: a power of two, as every size of it is. */
const HASH_START = 8;
/** What a row is given: a value a column, and what fills the arrays it holds once the row is there. */
interface RowValues { cells: Map<string, NumExpr | BoolExpr>; fill: ((of: Records, index: NumExpr) => boolean)[] }
/** Where a field's value comes from: the script has it, it is written there, or it is something of the program's. */
type FieldSource = { value: unknown } | { expr: TS.Expression } | { binding: Binding };
/** A record — and, with `cls`, an instance of a class of the program. */
type Instance = Extract<Binding, { kind: "record" }>;

/** The most cells an array of a program has: each is four bytes of the built map, twelve times over in a per-player program. */
const MAX_ARRAY = 4096;
const TRUE: BoolExpr = { kind: "const", value: true };
const FALSE: BoolExpr = { kind: "const", value: false };
const num = (value: number): NumExpr => ({ kind: "const", value });
const varRef = (v: VarDecl): NumExpr => ({ kind: "var", id: v.id });
const boolRef = (v: VarDecl): BoolExpr => ({ kind: "var", id: v.id });
const unitRef = (v: VarDecl): UnitExpr => ({ kind: "unitVar", id: v.id });
/** A variable as the value it holds, whatever that is. */
const refOf = (v: VarDecl): NumExpr | BoolExpr | UnitExpr | TextExpr => (v.kind === "number" ? varRef(v) : v.kind === "unit" ? unitRef(v) : v.kind === "text" ? { kind: "textVar", id: v.id } : boolRef(v));
const NO_UNIT: UnitExpr = { kind: "unitNull" };
const ORDERS: readonly string[] = ["move", "patrol", "attack"];

/** A list of the program: an array, an array of records, an array of units. */
type List = Extract<Binding, { kind: "array" | "records" | "units" }>;
type Grid = Extract<Binding, { kind: "grid" }>;
type Row = Extract<Binding, { kind: "row" }>;
type Lists = Extract<Binding, { kind: "lists" }>;
/** What a method that takes a function runs over: a list of the program, the units of the game (`unitsOf(…)`), or a list the script has. */
type Over = List | Grid | Lists | { kind: "query"; name: string; filter: Extract<Stmt, { kind: "unitLoop" }>["filter"] } | { kind: "values"; name: string; items: unknown[] };
/** The methods that give a list: a new one, or (`sort`, `reverse`) the one they were called on. */
const LIST_MAKERS = new Set(["map", "filter", "sort", "reverse"]);
/** The methods that take a function and give a value. */
const SEARCHES = new Set(["some", "every", "find", "findLast", "findIndex", "findLastIndex", "reduce"]);

/** What a call passes for a parameter: the value a parameter that is a variable is set to, or the array (the record) the parameter stands for. */
type CallArgument = { init: NumExpr | BoolExpr | UnitExpr; label: string } | { binding: Binding };

/** What a call that is not written as one hands `inline`: a method's instance, and — for `new`, a getter, a setter — the arguments, that nothing comes back, and what runs first in the body. */
interface MethodCall { self?: Binding; args?: readonly TS.Expression[]; nothing?: boolean; first?: (scope: Scope) => void; /** The call gives an instance: where the one it returns is kept, and the name one it makes is declared under. */ instance?: { name: string; made?: Binding }; /** What runs before the body, inside the call: the calls before this one in a chain (`v.add(w).scale(2)`), so that they run where the expression does. */ before?: Stmt[] }

/** A function at one set of arrays passed: inlined where it was first met, called from then on (`fn`), or never to be (`never` says why). */
interface FunctionSite {
  first?: { call: Call; args: CallArgument[] };
  fn?: FuncDecl;
  never?: string;
  /** Being tried as a called function right now. */
  busy?: boolean;
  /** The function that attempt is making: a call of itself met inside its body is a call of this — recursion. */
  making?: FuncDecl;
  /** How many inlined copies of the body are being walked right now: above zero, a call met is the function inside itself. */
  walking?: number;
}

/** Whether a node of this kind is anywhere in a piece of IR. */
function mentions(root: unknown, kind: string): boolean {
  if (Array.isArray(root)) return root.some((x) => mentions(x, kind));
  if (!root || typeof root !== "object") return false;
  const o = root as Record<string, unknown>;
  if (o.kind === kind) return true;
  return Object.values(o).some((v) => !!v && typeof v === "object" && mentions(v, kind));
}

/** What `run()` hands back: the IR, and the way back from any of its nodes to the source, for diagnostics a backend raises. */
export interface Emitted {
  program: Program;
  nodeOf(node: object): TS.Node | undefined;
}

export class Structured {
  private readonly c: StructuredContext;
  private readonly ts: typeof TS;
  /** The body being walked: the program's, or the game function being inlined. */
  private body: Body;
  private inlineDepth = 0;
  private scope: Scope = new Scope(null);
  /** The program's outermost scope: what an inlined function of the body closes over. */
  private readonly topScope = this.scope;
  /** The statement list being filled. */
  private out: Stmt[] = [];
  private readonly nodes = new WeakMap<object, TS.Node>();
  private nextId = 0;
  /** The functions that are called, and what is known of each function at each set of arrays passed to it. */
  private readonly functions: FuncDecl[] = [];
  private readonly sites = new Map<string, FunctionSite>();
  /** Which function of the source a call, inlined or not, is of — and why one stays inlined, for the hint on its line. */
  private readonly callees = new WeakMap<Call, TS.Node>();
  private readonly inlinedBecause = new Map<TS.Node, { why: string; name: string; at: At }>();
  private readonly declared = new Map<FuncDecl, TS.Node>();
  /** How many inlined copies of each function's body are being walked right now: how a call finds that it is inside its own function. */
  private readonly walkingBodies = new Map<TS.Node, number>();
  private readonly identities = new WeakMap<object, number>();
  private lastIdentity = 0;

  constructor(c: StructuredContext) {
    this.c = c;
    this.ts = c.ts;
    this.body = c.body;
  }

  run(): Emitted {
    const statements = this.body.plan.body.statements;
    const at = this.at(this.body.plan.body);
    const program: Program = { version: IR_VERSION, ...(this.body.name ? { name: this.body.name } : {}), owner: this.c.owner, owners: [...this.c.owners], perPlayer: this.c.perPlayer, arrays: this.arrays, body: [], at };
    this.nodes.set(program, this.body.plan.body);
    this.out = program.body;
    try {
      this.block(statements, {}, this.topScope);
    } catch (err) {
      if (!(err instanceof LowerError)) throw err;
      this.c.error(statements[statements.length - 1] ?? this.body.plan.body, err.message);
    }
    this.settleFunctions(program);
    return { program, nodeOf: (node) => this.nodes.get(node) };
  }

  private lineOf(node: TS.Node): number {
    return this.body.sf.getLineAndCharacterOfPosition(node.getStart(this.body.sf)).line + 1;
  }

  /** "L12: while (x < 3)" — the comment a generated trigger carries; "waves.ts L12: …" inside a game function from another file. */
  private label(node: TS.Node): string {
    let text = node.getText(this.body.sf).replace(/\s+/g, " ").trim();
    const brace = text.indexOf("{");
    if (brace > 0) text = text.slice(0, brace).trim();
    if (text.length > LABEL_LENGTH) text = `${text.slice(0, LABEL_LENGTH - 1)}…`;
    const file = this.body.sf === this.c.body.sf ? "" : `${this.body.sf.fileName} `;
    return `${file}L${this.lineOf(node)}: ${text}`;
  }

  private line(node: TS.Node): number {
    return this.lineOf(node);
  }

  /** Where a node is, for the IR. */
  private at(node: TS.Node): At {
    return this.sourceOf(node);
  }

  /** Remember which source node an IR node came from, and hand the IR node back. */
  private mark<T extends object>(ir: T, node: TS.Node): T {
    this.nodes.set(ir, node);
    return ir;
  }

  private emit<T extends Stmt>(s: T, node: TS.Node): T {
    this.out.push(this.mark(s, node));
    return s;
  }

  /** A statement list filled by `fill`, handed back. */
  private collect(fill: () => void): Stmt[] {
    const saved = this.out;
    const list: Stmt[] = [];
    this.out = list;
    try { fill(); } finally { this.out = saved; }
    return list;
  }

  /** Every array of the program, in the order they were met; tables (lists known at build time) once per list. */
  private readonly arrays: ArrayDecl[] = [];
  private readonly tables = new Map<unknown, ArrayDecl>();
  /** A keyed object of the script as the list with gaps it is looked up in, and a Map or a Set of the script as the tables it became: once each. */
  private readonly objects = new Map<object, unknown[]>();
  private readonly collections = new Map<object, Keyed>();
  private readonly recordLists = new Map<object, Extract<Binding, { kind: "records" }>>();

  private newArray(name: string, kind: "number" | "boolean", length: number, at: At, extra: { shared?: boolean; bits?: 8 | 16; unsigned?: boolean; values?: number[] } = {}): ArrayDecl {
    const a: ArrayDecl = { id: `${name}#${this.nextId++}`, name, kind, length, shared: extra.shared ?? false, ...(extra.bits ? { bits: extra.bits } : {}), ...(extra.unsigned ? { unsigned: true } : {}), ...(extra.values ? { values: extra.values } : {}), at };
    this.arrays.push(a);
    return a;
  }

  private newVar(name: string, kind: VarDecl["kind"], at: At, extra: { shared?: boolean; bits?: 8 | 16; unsigned?: boolean; temp?: boolean; text?: "id" | "made" } = {}): VarDecl {
    const v: VarDecl = { id: `${name}#${this.nextId++}`, name, kind, shared: extra.shared ?? false, ...(extra.bits ? { bits: extra.bits } : {}), ...(extra.unsigned ? { unsigned: true } : {}), ...(extra.temp ? { temp: true } : {}), ...(kind === "text" ? { text: extra.text ?? "made" } : {}), at };
    if (kind === "text") this.textKinds.set(v.id, v.text ?? "made");
    return v;
  }

  /* ── Values and bindings ── */

  /** Strip parentheses, `as`, `satisfies`, `!` — the wrappers that change nothing. */
  private unwrap(expr: TS.Expression): TS.Expression {
    const { ts } = this;
    for (;;) {
      if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
      else return expr;
    }
  }

  /** The declaration of an identifier when it is one of the body's own (a let, a parameter, a function). */
  private gameDeclaration(id: TS.Identifier): TS.Node | undefined {
    const { ts } = this;
    let decl: TS.Node | undefined = declarationOf(ts, this.c.checker, id);
    while (decl && (ts.isBindingElement(decl) || ts.isArrayBindingPattern(decl) || ts.isObjectBindingPattern(decl))) decl = decl.parent;
    return decl && this.body.plan.game.has(decl) ? decl : undefined;
  }

  /** What an identifier, or a field of a record (`p.lives`, `p["lives"]`), is bound to. */
  private bindingOf(expr: TS.Expression): Binding | undefined {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (ts.isIdentifier(e)) {
      // A name taken out of a pattern (`for (const [k, v] of lost)`) is bound by its own element, not by the declaration it is part of.
      const raw = declarationOf(ts, this.c.checker, e);
      if (raw && ts.isBindingElement(raw)) { const own = this.scope.lookup(raw); if (own) return own; }
      const decl = this.gameDeclaration(e);
      return decl ? this.scope.lookup(decl) : undefined;
    }
    // `this` inside a method, a getter, a constructor: the instance it was called on.
    if (e.kind === ts.SyntaxKind.ThisKeyword) return this.scope.lookup(THIS);
    if (ts.isPropertyAccessExpression(e) && (ts.isIdentifier(e.name) || ts.isPrivateIdentifier(e.name))) {
      // `Squad.count`: a static field, which is a variable of the program's.
      const cls = this.classOf(e.expression);
      if (cls) { const field = this.memberOf(cls, (m) => ts.isPropertyDeclaration(m) && this.isStatic(m) && this.memberKey(m.name) === e.name.text); return field ? this.statics.get(field) : undefined; }
      const obj = this.bindingOf(e.expression);
      return obj?.kind === "record" ? obj.fields.get(e.name.text) : undefined;
    }
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      const obj = this.bindingOf(e.expression);
      return obj?.kind === "record" ? obj.fields.get(e.argumentExpression.text) : undefined;
    }
    if (ts.isElementAccessExpression(e)) {
      // `waves[i]` of an array of records: a record whose fields are the cells at i.
      const obj = this.bindingOf(e.expression) ?? this.recordTables(e);
      // `grid[y]`: a row of it, which costs nothing until something needs it as an array.
      if (obj?.kind === "grid") return this.partOf(obj, e.argumentExpression, e);
      if (obj?.kind === "lists") {
        const h = this.evaluate(e.argumentExpression);
        const i = h ? this.asInteger(h, e.argumentExpression) : null;
        if (h && i === null) return undefined;
        if (i !== null && (i < 0 || (!obj.ptr.dynamic && i >= obj.ptr.length))) { this.c.error(e.argumentExpression, `${obj.name} has ${obj.ptr.length} row${obj.ptr.length === 1 ? "" : "s"}, 0 … ${obj.ptr.length - 1}; there is no ${obj.name}[${i}].`); return undefined; }
        const index = i !== null ? num(i) : this.num(e.argumentExpression);
        return index ? { kind: "inner", lists: obj, index } : undefined;
      }
      if (obj?.kind !== "records") return undefined;
      const index = this.rowIndex(obj, e.argumentExpression);
      return index ? this.rowOf(obj, index) : undefined;
    }
    return undefined;
  }

  private varOf(expr: TS.Expression): VarDecl | undefined {
    const b = this.bindingOf(expr);
    return b?.kind === "var" ? b.v : undefined;
  }

  /**
   * The build-time value of an expression, when it has one: a hoisted expression's, a
   * parameter's bound to one, or — so that `createUnit(p, units.Zergling, count, at)`
   * works inside a function whose `p` and `count` were bound at the call — a call,
   * member access, arithmetic or template over such values, evaluated now. Undefined
   * when a variable of the program is involved, or a game function is called.
   */
  private evaluate(expr: TS.Expression, depth = 0): Hoisted | undefined {
    const { ts } = this;
    let e = expr;
    for (;;) {
      const k = this.body.plan.index.get(e);
      if (k !== undefined) return { value: this.hoistedValue(k, e) };
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
      else break;
    }
    if (depth > 32) return undefined;
    const sub = (x: TS.Expression) => this.evaluate(x, depth + 1);
    if (ts.isIdentifier(e)) {
      const b = this.bindingOf(e);
      return b?.kind === "value" ? { value: b.value } : undefined;
    }
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { value: null };
    if (ts.isNumericLiteral(e)) return { value: Number(e.text) };
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { value: e.text };
    if (ts.isPropertyAccessExpression(e)) {
      const obj = sub(e.expression);
      if (!obj || obj.value === null || obj.value === undefined) return undefined;
      return { value: (obj.value as Record<string, unknown>)[e.name.text] };
    }
    if (ts.isElementAccessExpression(e)) {
      const obj = sub(e.expression);
      const key = sub(e.argumentExpression);
      if (!obj || !key || obj.value === null || obj.value === undefined) return undefined;
      return { value: (obj.value as Record<string, unknown>)[String(key.value)] };
    }
    if (ts.isCallExpression(e)) {
      const callee = sub(e.expression);
      if (!callee || typeof callee.value !== "function" || isGameFunction(callee.value)) return undefined;
      const self = ts.isPropertyAccessExpression(e.expression) ? sub(e.expression.expression)?.value : undefined;
      const args: unknown[] = [];
      for (const a of e.arguments) {
        if (ts.isSpreadElement(a)) { const v = sub(a.expression); if (!v || !Array.isArray(v.value)) return undefined; args.push(...(v.value as unknown[])); continue; }
        const v = sub(a);
        // A read among the arguments makes the call the program's: an action with that amount, a function inlined.
        if (!v || isGameValue(v.value)) return undefined;
        args.push(v.value);
      }
      // stats(x): a table's index is a plain number when the script runs; its type says which table.
      if (this.isLibraryCall(e, "stats") && e.arguments.length === 1) args.push(this.brandOf(e.arguments[0]));
      try {
        return { value: (callee.value as (...a: unknown[]) => unknown).apply(self, args) };
      } catch (err) {
        throw new LowerError(err instanceof Error ? err.message : String(err));
      }
    }
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const v = sub(span.expression);
        if (!v || isGameValue(v.value)) return undefined;
        out += String(v.value) + span.literal.text;
      }
      return { value: out };
    }
    if (ts.isArrayLiteralExpression(e)) {
      const out: unknown[] = [];
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) { const v = sub(el.expression); if (!v || !Array.isArray(v.value)) return undefined; out.push(...(v.value as unknown[])); continue; }
        if (ts.isOmittedExpression(el)) { out.push(undefined); continue; }
        const v = sub(el);
        if (!v) return undefined;
        out.push(v.value);
      }
      return { value: out };
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const v = sub(e.operand);
      // A read has no value yet: arithmetic over it is the program's, not the script's.
      if (!v || isGameValue(v.value)) return undefined;
      switch (e.operator) {
        case ts.SyntaxKind.MinusToken: return { value: -(v.value as number) };
        case ts.SyntaxKind.PlusToken: return { value: +(v.value as number) };
        case ts.SyntaxKind.TildeToken: return { value: ~(v.value as number) };
        default: return undefined;
      }
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      // The class of every instance is known when the script is built, so this is a question the script answers.
      const b = this.bindingOf(e.left);
      const cls = this.classOf(e.right);
      return b?.kind === "record" && b.cls && cls ? { value: this.chainOf(b.cls).includes(cls) } : undefined;
    }
    if (ts.isBinaryExpression(e)) {
      const l = sub(e.left);
      const r = sub(e.right);
      if (!l || !r || isGameValue(l.value) || isGameValue(r.value)) return undefined;
      const a = l.value as number;
      const b = r.value as number;
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return { value: (a as unknown as string) + (b as unknown as string) };
        case ts.SyntaxKind.MinusToken: return { value: a - b };
        case ts.SyntaxKind.AsteriskToken: return { value: a * b };
        case ts.SyntaxKind.SlashToken: return { value: a / b };
        case ts.SyntaxKind.PercentToken: return { value: a % b };
        case ts.SyntaxKind.AsteriskAsteriskToken: return { value: a ** b };
        case ts.SyntaxKind.LessThanLessThanToken: return { value: a << b };
        case ts.SyntaxKind.GreaterThanGreaterThanToken: return { value: a >> b };
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return { value: a >>> b };
        case ts.SyntaxKind.AmpersandToken: return { value: a & b };
        case ts.SyntaxKind.BarToken: return { value: a | b };
        case ts.SyntaxKind.CaretToken: return { value: a ^ b };
        default: return undefined;
      }
    }
    if (ts.isConditionalExpression(e)) {
      const c = sub(e.condition);
      if (!c || isGameValue(c.value)) return undefined;
      return c.value ? sub(e.whenTrue) : sub(e.whenFalse);
    }
    return undefined;
  }

  /** A thunk's outcome, computed the first time and kept — an error is thrown again at every use. */
  private force(memo: Map<number, Outcome>, k: number, thunk: () => unknown, at: TS.Node): unknown {
    let o = memo.get(k);
    if (!o) {
      try { o = { ok: true, value: thunk() }; } catch (error) { o = { ok: false, error }; }
      memo.set(k, o);
    }
    if (o.ok) return o.value;
    const err = o.error;
    const message = err instanceof Error ? err.message : String(err);
    const i = (err as { __trigscriptConst?: number } | null)?.__trigscriptConst;
    const decl = i !== undefined ? this.body.plan.constList[i] : undefined;
    if (decl?.initializer) throw new ValueError(decl.initializer, `${message} — this constant is computed when the script is built, not in the game.`);
    throw new ValueError(at, `${message} — this expression is computed when the script is built, not in the game.`);
  }

  /** A hoisted expression's value: its thunk, called the first time the walk reaches it. */
  private hoistedValue(k: number, at: TS.Node): unknown {
    return this.force(this.body.memo, k, this.body.values.h[k], at);
  }

  /** A build-time constant of the body, computed now if nothing needed it before. */
  private constValue(decl: TS.VariableDeclaration): unknown {
    const i = this.body.plan.consts.get(decl)!;
    return this.force(this.body.constMemo, i, this.body.values.c[i], decl.initializer!);
  }

  private isLibraryCall(e: TS.Expression, name: string): boolean {
    const { ts } = this;
    return ts.isCallExpression(e) && libraryCallName(ts, this.c.checker, e) === name;
  }

  /** The variable an expression that could not be hoisted depends on — for the message. */
  private blamedVariable(expr: TS.Node): string | null {
    const { ts } = this;
    let found: string | null = null;
    const walk = (n: TS.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && this.gameDeclaration(n) && this.bindingOf(n)?.kind !== "value") { found = n.text; return; }
      ts.forEachChild(n, walk);
    };
    walk(expr);
    return found;
  }

  private notConstant(expr: TS.Expression, what: string) {
    const v = this.blamedVariable(expr);
    this.c.error(expr, v
      ? `${what} must be known when the script is built, but ${v} is a variable of the program. Compare or assign variables in the program's own statements instead.`
      : `${what} must be known when the script is built.`);
  }

  /* ── Statements ── */

  private block(statements: readonly TS.Statement[], ctx: Ctx, scope = new Scope(this.scope)) {
    const outer = this.scope;
    this.scope = scope;
    for (const s of statements) {
      try {
        this.statement(s, ctx);
      } catch (err) {
        if (!(err instanceof LowerError)) throw err;
        if (err instanceof ValueError) this.c.error(err.node, err.message, "script");
        else this.c.error(s, err.message);
      }
    }
    this.scope = outer;
  }

  /** A statement's IR, as a list of its own (a block a backend scopes). */
  private sub(s: TS.Statement, ctx: Ctx): Stmt[] {
    return this.collect(() => this.statement(s, ctx));
  }

  private statement(s: TS.Statement, ctx: Ctx) {
    const { ts } = this;
    if (ts.isEmptyStatement(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isFunctionDeclaration(s)) return;
    if (ts.isClassDeclaration(s)) { this.declareClass(s); return; }
    if (ts.isVariableStatement(s)) { this.declare(s.declarationList); return; }
    if (ts.isBlock(s)) { const body = this.collect(() => this.block(s.statements, ctx)); this.emit({ kind: "block", body, at: this.at(s) }, s); return; }
    if (ts.isExpressionStatement(s)) { this.expressionStatement(s.expression); return; }
    if (ts.isIfStatement(s)) { this.ifStatement(s, ctx); return; }
    if (ts.isWhileStatement(s)) { this.whileStatement(s, ctx); return; }
    if (ts.isDoStatement(s)) { this.doStatement(s, ctx); return; }
    if (ts.isForStatement(s)) { this.forStatement(s, ctx); return; }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      if (s.label) { this.c.error(s, "Labelled break / continue is not supported."); return; }
      if (ts.isBreakStatement(s) ? !ctx.canBreak : !ctx.canContinue) { this.c.error(s, `${ts.isBreakStatement(s) ? "break" : "continue"} outside a loop.`); return; }
      this.emit({ kind: ts.isBreakStatement(s) ? "break" : "continue", at: this.at(s), label: this.label(s) }, s);
      return;
    }
    if (ts.isReturnStatement(s)) { this.returnStatement(s, ctx); return; }
    if (ts.isSwitchStatement(s)) { this.switchStatement(s, ctx); return; }
    if (ts.isForOfStatement(s)) { this.forOfStatement(s, ctx); return; }
    if (ts.isForInStatement(s)) { this.c.error(s, "for…in is not supported in a program; for…of over a list known when the script is built is unrolled."); return; }
    if (ts.isThrowStatement(s) || ts.isTryStatement(s)) { this.c.error(s, "The game has no exceptions."); return; }
    this.c.error(s, "This statement is not supported in a program.");
  }

  private returnStatement(s: TS.ReturnStatement, ctx: Ctx) {
    if (!ctx.fn) { this.c.error(s, "return outside a function."); return; }
    const { fn } = ctx;
    if (fn.instance || (fn.kind === "void" && s.expression && this.classOfType(this.c.checker.getTypeAtLocation(s.expression)))) {
      // `return this`, `return new Wave(n)`, `return other`: which instance the call gives, settled here. A call that does nothing with it only leaves.
      if (fn.instance && s.expression) {
        const given = this.unwrap(s.expression);
        const made = this.ts.isNewExpression(given) && this.classOf(given.expression) ? this.instantiate(given, fn.instance.name) : this.ts.isCallExpression(given) ? this.instanceCall(given, fn.instance.name) : this.bindingOf(given);
        if (made?.kind !== "record") { if (made !== null) this.c.error(s.expression, "A function gives an instance it made (return new Wave(…)), itself (return this), or one it was handed."); return; }
        if (fn.instance.made && fn.instance.made !== made) { this.c.error(s, "Every return of this function has to give the same instance: which one a call gives is settled when the script is built. Give the place of a row of an array instead, and let the caller take the row."); return; }
        fn.instance.made = made;
      }
      this.emit({ kind: "return", at: this.at(s), label: this.label(s) }, s);
      return;
    }
    if (fn.kind === "void") {
      if (s.expression) {
        // An expression-bodied game function returning an action: the action runs.
        const h = this.evaluate(s.expression);
        if (h && (isAction(h.value) || (Array.isArray(h.value) && h.value.every(isAction)))) this.hoistedStatement(this.unwrap(s.expression), h);
        else { this.c.error(s.expression, "This function returns nothing the game can hold: a function returns a number or a boolean."); return; }
      }
      this.emit({ kind: "return", at: this.at(s), label: this.label(s) }, s);
      return;
    }
    if (!s.expression) {
      this.c.error(s, `The function returns a ${fn.kind}; return one here.`);
      return;
    }
    if (fn.kind === "number") {
      const value = this.num(s.expression);
      if (!value) return;
      this.emit({ kind: "return", value, at: this.at(s), label: this.label(s) }, s);
    } else if (fn.kind === "unit") {
      const value = this.unitExpr(s.expression);
      if (value) this.emit({ kind: "return", value, at: this.at(s), label: this.label(s) }, s);
    } else if (fn.kind === "text") {
      const value = this.text(s.expression);
      if (value) this.emit({ kind: "return", value, at: this.at(s), label: this.label(s) }, s);
    } else {
      const value = this.boolValue(s.expression);
      this.emit({ kind: "return", value, at: this.at(s), label: this.label(s) }, s);
    }
  }

  private declare(list: TS.VariableDeclarationList) {
    const { ts } = this;
    for (const d of list.declarations) {
      // Computed when the script is built — now, so a helper it calls runs where the source has it — and its uses are hoisted expressions.
      if (this.body.plan.consts.has(d)) { this.constValue(d); continue; }
      if (!ts.isIdentifier(d.name)) {
        // `const { x, y } = mouse(P1)`, `const [a, b] = pair`: every name a variable of its own.
        if (!d.initializer) { this.c.error(d, "A pattern is taken from something: const { x, y } = p."); continue; }
        const from = this.patternSource(d.initializer, d);
        if (from) this.bindPattern(d.name, d, from, this.scope);
        continue;
      }
      if (!d.initializer) { this.c.error(d, `Give ${d.name.text} an initial value: let ${d.name.text} = 0 or = false.`); continue; }
      const init = this.unwrap(d.initializer);
      if (ts.isObjectLiteralExpression(init) && !this.keyedForm(init, this.c.checker.getTypeAtLocation(d.name))) {
        const record = this.declareRecord(d.name.text, init, this.c.checker.getTypeAtLocation(d.name), d);
        if (record) this.scope.bind(d, record);
        continue;
      }
      // `const s = new Squad(P1)`: an instance, which is a record whose class is known.
      if (ts.isNewExpression(init) && this.classOf(init.expression)) {
        const instance = this.instantiate(init, d.name.text);
        if (instance) this.scope.bind(d, instance);
        continue;
      }
      // `const w = make(3)`, `const sum = v.add(w)`: the instance the call gives, under this name when the call makes it.
      if (ts.isCallExpression(init)) {
        const given = this.instanceCall(init, d.name.text);
        if (given !== undefined) { if (given) this.scope.bind(d, given); continue; }
      }
      // `const boss = s`, `const p = this.pos`: another name for the same instance, as it is for an object.
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || init.kind === ts.SyntaxKind.ThisKeyword) {
        const same = this.bindingOf(init);
        if (same?.kind === "inner" || same?.kind === "innerUnits") { this.scope.bind(d, this.takenCopy(same, d.name.text, d)); continue; }
        if (same?.kind === "record" && !same.truth) {
          if (!(list.flags & ts.NodeFlags.Const) && this.assigns(this.body.plan.body, d)) { this.c.error(d, `${d.name.text} is another name for a record, and a record is not assigned whole: declare it with const, or copy the fields it needs.`); continue; }
          this.scope.bind(d, same);
          continue;
        }
      }
      if (ts.isCallExpression(init) && (this.isLibraryCall(init, "mouse") || this.isLibraryCall(init, "chatted"))) {
        const record = this.declareInput(d.name.text, init, d);
        if (record) this.scope.bind(d, record);
        continue;
      }
      // `let big = hp.filter((h) => h > 100)`: the list the method makes, under the declaration's name.
      if (ts.isCallExpression(init) && this.makesList(init)) {
        const made = this.madeList(init, d.name.text, d);
        if (made) this.scope.bind(d, made);
        continue;
      }
      // `const rest = xs.slice(1)`, `const ks = [...m.keys()]` is below; `Array.from(m.values())`: a copy, under the declaration's name.
      if (ts.isCallExpression(init) && this.copiesList(init)) {
        const made = this.copiedList(init, d.name.text, d);
        if (made) this.scope.bind(d, made);
        continue;
      }
      const type = this.c.checker.getTypeAtLocation(d.name);
      // `const row = grid[y]`: the row as it is now — where it starts is taken once, so moving `y` afterwards does not move `row`.
      if (ts.isElementAccessExpression(init)) {
        const part = this.bindingOf(init);
        if (part?.kind === "row") { this.scope.bind(d, { kind: "array", a: this.windowOf({ ...part, name: d.name.text }, d) }); continue; }
        if (part?.kind === "inner") { this.scope.bind(d, { kind: "array", a: this.innerOf(part.lists, part.index, d, d.name.text) }); continue; }
        if (part?.kind === "grid") { this.scope.bind(d, { ...part, name: d.name.text, offset: part.offset ? this.temp(part.offset, d, true) : null }); continue; }
      }
      const gridShape = this.gridType(type);
      if (gridShape && !this.bindingOf(init)) {
        // Every row one length and none of them growing is one flat array; anything else is rows that grow, a handle each.
        const grid = this.innerGrows(d) ? undefined : this.declareGrid(d.name.text, d.initializer, gridShape, d);
        const held = grid === undefined ? this.declareLists(d.name.text, d.initializer, gridShape, d) : grid;
        if (held) this.scope.bind(d, held);
        continue;
      }
      // `const w = waves[i]`: the record at i, as it is now — the index is taken once, so moving `i` afterwards does not move `w`.
      if (ts.isElementAccessExpression(init)) {
        const of = this.bindingOf(init.expression);
        if (of?.kind === "records") {
          const index = this.rowIndex(of, init.argumentExpression);
          if (!index) continue;
          if (!(list.flags & ts.NodeFlags.Const) && this.assigns(this.body.plan.body, d)) {
            // `let cur = waves[0]; … cur = waves[i]`: which row it is is a variable, and giving it another row of the array sets that.
            const place = this.newVar(`${d.name.text} (row of ${of.name})`, "number", this.sourceOf(d.name));
            this.emit({ kind: "declare", decl: place, init: index, at: this.at(d), label: this.label(d) }, d);
            const row = this.rowOf(of, varRef(place));
            this.rowVars.set(row, { of, place });
            this.scope.bind(d, row);
            continue;
          }
          this.scope.bind(d, this.rowOf(of, this.temp(index, d, true)));
          continue;
        }
      }
      if ((this.c.checker.isArrayType(type) || this.c.checker.isTupleType(type)) && this.kindOf(this.c.checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? type) === "unit") {
        const squad = this.declareUnits(d.name.text, init, d);
        if (squad) this.scope.bind(d, squad);
        continue;
      }
      const rowClass = this.rowClass(type, d);
      if (rowClass === null) continue;
      const why: string[] = [];
      const recordsOf = rowClass ? this.shapeOf(this.instanceType(rowClass), why) : this.recordFields(type, why);
      if (!recordsOf && why.length) { this.c.error(d, `${d.name.text} cannot be an array of ${rowClass ? `${this.className(rowClass)}s` : "records"}: ${why[0]}. A row holds numbers, booleans, units, arrays of those, and records or instances of the same.`); continue; }
      if (recordsOf) {
        const records = this.declareRecords(d.name.text, init, recordsOf, d, rowClass);
        if (records) this.scope.bind(d, records);
        continue;
      }
      const keyedAs = this.keyedForm(init, type);
      if (keyedAs && keyedAs !== "record" && this.anyNumberKeys(type)) {
        const hash = this.declareHash(d.name.text, keyedAs, init, type, d);
        if (hash) this.scope.bind(d, hash);
        continue;
      }
      if (keyedAs) {
        const keyed = this.declareKeyed(d.name.text, keyedAs, init, type, d);
        if (keyed) this.scope.bind(d, keyed);
        continue;
      }
      if (this.c.checker.isArrayType(type) || this.c.checker.isTupleType(type)) {
        const a = this.declareArray(d.name.text, d.initializer, type, d);
        if (a) this.scope.bind(d, { kind: "array", a });
        continue;
      }
      if (this.isTextType(type)) {
        if (ts.isCallExpression(init) && this.isLibraryCall(init, "shared")) { this.c.error(init, "shared() holds a number or a boolean."); continue; }
        const v = this.declareText(d.name.text, d.initializer, this.textKept(d.initializer, (left) => ts.isIdentifier(left) && declarationOf(ts, this.c.checker, left) === d), this.sourceOf(d.name), d);
        this.scope.bind(d, { kind: "var", v });
        continue;
      }
      const kind = this.kindOf(type);
      // `const x = xs.find(…)` would be a number or undefined: searchCall says what to write instead.
      if (!kind && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && (init.expression.name.text === "find" || init.expression.name.text === "findLast")) {
        const over = this.overOf(init.expression.expression);
        if (over) { this.searchCall(init, over, init.expression.name.text, over.kind === "array" ? over.a.kind : "number"); continue; }
      }
      if (!kind) { this.c.error(d, `Variables hold numbers, booleans, texts, units of the game or records of them ({ lives: 3 }); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
      // `let total = shared(0)`: one cell for every player of a per-player program, initialised with the argument.
      const shared = ts.isCallExpression(init) && this.isLibraryCall(init, "shared") ? init : null;
      if (shared && shared.arguments.length !== 1) { this.c.error(init, "shared() takes the initial value: shared(0) or shared(false)."); continue; }
      if (shared && kind === "unit") { this.c.error(init, "shared() holds a number or a boolean."); continue; }
      const initializer = shared ? shared.arguments[0] : d.initializer;
      const v = this.newVar(d.name.text, kind, this.sourceOf(d.name), { shared: !!shared, ...(kind === "number" ? this.widthOf(type) : {}) });
      this.emitDeclare(v, initializer, d);
      // Bound after the initialiser: `let x = x` is the checker's error, not a self-reference here.
      this.scope.bind(d, { kind: "var", v });
    }
  }

  /** `declare` with its initial value; a number's that fails to compile still declares the variable (as before, the cell is taken). */
  private emitDeclare(v: VarDecl, initializer: TS.Expression, at: TS.Node) {
    if (v.kind === "number") {
      const value = this.num(initializer);
      this.emit({ kind: "declare", decl: v, init: value ?? num(0), ...(value ? {} : { failed: true }), at: this.at(at), label: this.label(at) }, at);
    } else if (v.kind === "unit") {
      const value = this.unitExpr(initializer);
      this.emit({ kind: "declare", decl: v, init: value ?? NO_UNIT, ...(value ? {} : { failed: true }), at: this.at(at), label: this.label(at) }, at);
    } else {
      this.emit({ kind: "declare", decl: v, init: this.boolValue(initializer), at: this.at(at), label: this.label(at) }, at);
    }
  }

  /** The three arrays of an array of units, in the order a unit's parts are kept. */
  private unitArrays(of: Extract<Binding, { kind: "units" }>): [ArrayDecl, "ptr" | "epd" | "uid"][] {
    return [[of.ptr, "ptr"], [of.epd, "epd"], [of.uid, "uid"]];
  }

  /** A unit as something whose three parts can be taken without finding it three times: a variable as it is, anything else into a temporary. */
  private unitTemp(unit: UnitExpr, at: TS.Node): UnitExpr {
    if (unit.kind === "unitVar" || unit.kind === "unitNull") return unit;
    const t = this.newVar("(unit)", "unit", this.at(at), { temp: true });
    this.emit({ kind: "declare", decl: t, init: unit, at: this.at(at), label: this.label(at) }, at);
    return unitRef(t);
  }

  /** `let squad: Unit[] = []`, `let pair = [first(a), first(b)]`: three arrays of numbers, a unit a cell of each. */
  private declareUnits(name: string, initializer: TS.Expression, at: TS.Node): Binding | null {
    const { ts } = this;
    const init = this.unwrap(initializer);
    if (!ts.isArrayLiteralExpression(init) || init.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) { this.c.error(init, `${name} is written out unit by unit ([first(…), nearest(…)]), or starts empty and is pushed to.`); return null; }
    // Written empty, it can only be one that grows — pushed to here, or by a function it is handed to.
    const dynamic = this.body.plan.grows.has(at) || init.elements.length === 0;
    if (init.elements.length < (dynamic ? 0 : 1) || init.elements.length > MAX_ARRAY) { this.c.error(init, dynamic ? `An array of a program starts with at most ${MAX_ARRAY} units.` : `An array of a program has 1 to ${MAX_ARRAY} units; one that starts empty is one something pushes to.`); return null; }
    const units: UnitExpr[] = [];
    for (const x of init.elements) { const u = this.unitExpr(x); if (!u) return null; units.push(this.unitTemp(u, x)); }
    const make = (part: string) => { const a = this.newArray(`${name} (${part})`, "number", units.length, this.sourceOf(at), { unsigned: true }); if (dynamic) a.dynamic = true; return a; };
    const squad = { kind: "units" as const, name, ptr: make("ptr"), epd: make("epd"), uid: make("uid") };
    for (const [a, part] of this.unitArrays(squad)) this.emit({ kind: "declareArray", array: a.id, init: units.map((unit): NumExpr => ({ kind: "unitPart", unit, part, at: this.at(at) })), at: this.at(at), label: this.label(at) }, at);
    return squad;
  }

  /** `squad[i]` as a unit: the three numbers at i. An index that is more than a constant or a variable is worked out once. */
  private unitAtIndex(of: Extract<Binding, { kind: "units" }>, index: NumExpr, at: TS.Node): UnitExpr {
    const i = this.temp(index, at);
    const cell = (a: ArrayDecl): NumExpr => ({ kind: "element", array: a.id, index: i, at: this.at(at) });
    return this.mark<UnitExpr>({ kind: "unitAt", ptr: cell(of.ptr), epd: cell(of.epd), uid: cell(of.uid), at: this.at(at) }, at);
  }

  /** `squad.push(u)`, `squad.pop()` standing on their own; the three arrays move together. */
  private unitsCall(e: TS.CallExpression, of: Extract<Binding, { kind: "units" }>, method: string) {
    const at = this.at(e);
    const label = this.label(e);
    if (method === "push" && e.arguments.length > 0) {
      for (const arg of e.arguments) {
        const found = this.unitExpr(arg);
        if (!found) return;
        const unit = this.unitTemp(found, arg);
        for (const [a, part] of this.unitArrays(of)) { a.dynamic = true; this.emit({ kind: "push", array: a.id, value: { kind: "unitPart", unit, part, at }, at, label }, e); }
      }
      return;
    }
    if (method === "pop" && e.arguments.length === 0) {
      for (const [a] of this.unitArrays(of)) { a.dynamic = true; this.emit({ kind: "pop", array: a.id, at, label }, e); }
      return;
    }
    this.c.error(e, `An array of units has push(unit), pop(), length, for…of, and forEach, filter, some, every, find, findIndex, sort and reverse; ${method}() is not one of them.`);
  }

  /** A number of the program as something that can be read twice without being worked out twice: itself when it is a constant or a variable, else a temporary holding it. */
  private temp(value: NumExpr, at: TS.Node, keep = false): NumExpr {
    // `keep`: the value as it is now, for good — a variable is copied too, since it may move afterwards.
    if (value.kind === "const" || (value.kind === "var" && !keep)) return value;
    const t = this.newVar("(index)", "number", this.at(at), { temp: true });
    this.emit({ kind: "declare", decl: t, init: value, at: this.at(at), label: this.label(at) }, at);
    return varRef(t);
  }

  /** What a row of an array of records holds, when a type is such an array. Null — with `why` filled in when a field is what stops it — otherwise. */
  private recordFields(type: TS.Type, why?: string[]): RowShape | null {
    const { ts } = this;
    const checker = this.c.checker;
    if (!checker.isArrayType(type) && !checker.isTupleType(type)) return null;
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!element || this.kindOf(element) || !(element.flags & ts.TypeFlags.Object) || checker.isArrayType(element) || checker.isTupleType(element)) return null;
    return this.shapeOf(element, why);
  }

  /**
   * The fields of a record type, or of a class's instances — its methods and accessors are no fields, and a static is
   * the class's. A number, a boolean, a unit, an array of those (which a row keeps as one that grows), a record or an
   * instance of the same.
   */
  private shapeOf(element: TS.Type, why?: string[], depth = 0): RowShape | null {
    const { ts } = this;
    const checker = this.c.checker;
    const fields: RowShape = new Map();
    const no = (what: string) => { why?.push(what); return null; };
    if (depth > 4) return no("it holds itself, and a row has every one of its cells when the script is built");
    for (const p of checker.getPropertiesOfType(element)) {
      const d = p.valueDeclaration;
      if (d && (ts.isMethodDeclaration(d) || ts.isAccessor(d))) continue;
      const t = checker.getTypeOfSymbol(p);
      // `#hp` is kept under the name it is written with, not the one the checker makes of it.
      const key = d && (ts.isPropertyDeclaration(d) || ts.isParameter(d)) ? this.memberKey(d.name as TS.PropertyName) ?? p.name : p.name;
      const kind = this.kindOf(t);
      if (kind === "number" || kind === "boolean") { fields.set(key, { kind, width: kind === "number" ? this.widthOf(t) : {} }); continue; }
      if (kind === "unit") { fields.set(key, { kind: "unit" }); continue; }
      if (this.isTextType(t)) { fields.set(key, { kind: "text" }); continue; }
      if (checker.isArrayType(t) || checker.isTupleType(t)) {
        const el = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
        const of = el ? this.kindOf(el) : null;
        if (of === "unit") fields.set(key, { kind: "squad" });
        else if (of) fields.set(key, { kind: "list", of, width: of === "number" && el ? this.widthOf(el) : {} });
        else return no(`${key} is an array of something other than numbers, booleans or units`);
        continue;
      }
      if (!(t.flags & ts.TypeFlags.Object)) return no(`${key} is ${checker.typeToString(t)}`);
      const inner = this.shapeOf(t, why, depth + 1);
      if (!inner) return null;
      const cls = this.classOfType(t);
      fields.set(key, { kind: "record", shape: inner, ...(cls ? { cls } : {}) });
    }
    return fields.size ? fields : no("it has no fields");
  }

  /** A row's shape: what the binding says, or — of an array whose every field is a number or a boolean — read off its arrays. */
  private rowShape(of: Records): RowShape {
    return of.shape ?? new Map([...of.fields].map(([f, a]) => [f, { kind: a.kind, width: {} }]));
  }

  /** The plain arrays a shape is kept in, by the key of each. */
  private columnsOf(shape: RowShape, prefix = ""): { key: string; kind: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }[] {
    const handle = (key: string) => HANDLE_PARTS.map((part) => ({ key: `${key} ${part}`, kind: "number" as const, width: { unsigned: true } }));
    return [...shape].flatMap(([name, f]) => {
      const key = prefix + name;
      switch (f.kind) {
        case "unit": return UNIT_PARTS.map((part) => ({ key: `${key} ${part}`, kind: "number" as const, width: { unsigned: true } }));
        case "list": return handle(key);
        case "text": return TEXT_PARTS.map((part) => ({ key: `${key} ${part}`, kind: "number" as const, width: { unsigned: true } }));
        case "squad": return UNIT_PARTS.flatMap((part) => handle(`${key} ${part}`));
        case "record": return this.columnsOf(f.shape, `${key} `);
        default: return [{ key, kind: f.kind, width: f.width }];
      }
    });
  }

  /** An array that grows inside a row, as the array of arrays that grow its four columns are. */
  private listsAt(of: Records, key: string, f: { of: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }): Lists {
    const [ptr, len, room, k] = HANDLE_PARTS.map((part) => of.fields.get(`${key} ${part}`)!);
    return { kind: "lists", name: `${of.name}[…].${key.replace(/ /g, ".")}`, ptr, len, room, k, of: f.of, ...f.width };
  }

  /** Every array of arrays that grow a row's shape holds: what a row that goes has to give back. */
  private ownedLists(of: Records, shape = of.shape, prefix = ""): Lists[] {
    if (!shape) return [];
    return [...shape].flatMap(([name, f]): Lists[] => {
      const key = prefix + name;
      if (f.kind === "list") return [this.listsAt(of, key, f)];
      if (f.kind === "squad") return UNIT_PARTS.map((part) => this.listsAt(of, `${key} ${part}`, { of: "number", width: { unsigned: true } }));
      return f.kind === "record" ? this.ownedLists(of, f.shape, `${key} `) : [];
    });
  }

  /** Every text a row's shape holds, as the three columns each is kept in. */
  private ownedTexts(of: Records, shape = of.shape, prefix = ""): Extract<Binding, { kind: "textAt" }>[] {
    if (!shape) return [];
    return [...shape].flatMap(([name, f]) => {
      const key = prefix + name;
      if (f.kind === "text") return [this.textCells(of, key, num(0))];
      return f.kind === "record" ? this.ownedTexts(of, f.shape, `${key} `) : [];
    });
  }

  private textCells(of: Records, key: string, index: NumExpr): Extract<Binding, { kind: "textAt" }> {
    const [addr, block, chars] = TEXT_PARTS.map((part) => of.fields.get(`${key} ${part}`)!);
    return { kind: "textAt", addr, block, chars, index };
  }

  /** Whether a row owns blocks of the heap — arrays that grow, texts — which it gives back when it goes, and which a copy of it has to have its own of. */
  private owns(of: Records): boolean {
    return this.ownedLists(of).length + this.ownedTexts(of).length > 0;
  }

  /** The row at `index` gives back the blocks of the arrays and the texts it holds. */
  private releaseRow(of: Records, index: NumExpr, node: TS.Node) {
    if (!this.owns(of)) return;
    const i = this.temp(index, node);
    for (const l of this.ownedLists(of)) this.emit({ kind: "declareArray", array: this.innerOf(l, i, node).id, init: [], at: this.at(node), label: this.label(node) }, node);
    for (const t of this.ownedTexts(of)) this.emit({ kind: "releaseText", block: t.block.id, index: i, at: this.at(node), label: this.label(node) }, node);
  }

  /** The rows from `from` on give their blocks back: they are about to go. */
  private releaseFrom(of: Records, from: NumExpr, node: TS.Node) {
    for (const l of this.ownedLists(of)) this.releaseRows(l, from, node);
    const texts = this.ownedTexts(of);
    if (!texts.length) return;
    const at = this.at(node);
    const label = this.label(node);
    const i = this.newVar(`(row of ${of.name})`, "number", at, { temp: true });
    this.emit({ kind: "declare", decl: i, init: from, at, label }, node);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: texts[0].block.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }],
      body: texts.map((t): Stmt => ({ kind: "releaseText", block: t.block.id, index: varRef(i), at, label })), at, label }, node);
  }

  /** A text kept in cells, as the text it is. */
  private textAtCells(b: Extract<Binding, { kind: "textAt" }>, at: TS.Node): TextExpr {
    return this.mark<TextExpr>({ kind: "textAt", addr: b.addr.id, block: b.block.id, chars: b.chars.id, index: b.index, at: this.at(at) }, at);
  }

  private storeTextAt(b: Extract<Binding, { kind: "textAt" }>, value: TextExpr, node: TS.Node) {
    this.emit({ kind: "storeText", addr: b.addr.id, block: b.block.id, chars: b.chars.id, index: b.index, value, at: this.at(node), label: this.label(node) }, node);
  }

  /**
   * The class an array of instances holds. Every instance's class is known when the script is built and a row has the
   * fields of one class, so an array declared of a class that others extend holds what is put into it — every `new`
   * written into its first value, pushed to it or stored in it, which have to be of one class. Undefined when the
   * elements are not instances; null, with a diagnostic, when they are of two classes.
   */
  private rowClass(type: TS.Type, d: TS.VariableDeclaration | TS.PropertyDeclaration): TS.ClassDeclaration | null | undefined {
    const { ts } = this;
    if (!this.c.checker.isArrayType(type) && !this.c.checker.isTupleType(type)) return undefined;
    const element = this.c.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const declared = element && this.classOfType(element);
    if (!declared) return undefined;
    const made = new Set<TS.ClassDeclaration>();
    const take = (x: TS.Expression) => { const n = this.unwrap(x); const c = ts.isNewExpression(n) ? this.classOf(n.expression) : undefined; if (c) made.add(c); };
    const mine = (x: TS.Expression): boolean => {
      const e = this.unwrap(x);
      if (ts.isIdentifier(e)) return declarationOf(ts, this.c.checker, e) === d;
      return ts.isPropertyAccessExpression(e) && this.c.checker.getSymbolAtLocation(e.name)?.valueDeclaration === d;
    };
    const walk = (n: TS.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && mine(n.expression.expression)) n.arguments.forEach(take);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left) && mine(n.left.expression)) take(n.right);
      ts.forEachChild(n, walk);
    };
    walk(this.body.plan.arrow.body);
    const init = d.initializer && this.unwrap(d.initializer);
    if (init && ts.isArrayLiteralExpression(init)) init.elements.forEach(take);
    if (made.size > 1) { this.c.error(d, `${d.name.getText(this.body.sf)} would hold ${[...made].map((c) => this.className(c)).join(" and ")}: an array of instances holds one class, since a row has the fields of one. Keep an array for each.`); return null; }
    return [...made][0] ?? declared;
  }

  /** The type of a class's instances. */
  private instanceType(cls: TS.ClassDeclaration): TS.Type {
    return this.c.checker.getDeclaredTypeOfSymbol(this.c.checker.getSymbolAtLocation(cls.name ?? cls)!);
  }

  /**
   * A row of an array of instances from `new Wave(3, 40)`: a row of nothing, and the constructor run on it — the row is
   * `this`, so what the class declares and what the constructor assigns go straight into its cells. When what `new` is
   * handed may read the array itself (`waves.push(new Wave(waves.length))`, a call among the arguments), the row is not
   * there yet in JavaScript while they are worked out: then the instance is made on its own and copied in. Null with a diagnostic.
   */
  private newRow(of: { name: string; cls?: TS.ClassDeclaration }, made: TS.NewExpression, shape: RowShape, held?: Records): RowValues | null {
    const { ts } = this;
    const cls = this.classOf(made.expression);
    if (!of.cls || cls !== of.cls) { this.c.error(made, of.cls ? `${of.name} holds instances of ${this.className(of.cls)}, and a row has the fields of that class; this is ${cls ? `a ${this.className(cls)}` : "something else"}.` : `${of.name} holds records written out: { … }.`); return null; }
    let reads = false;
    const look = (n: TS.Node) => {
      if (reads) return;
      if (ts.isCallExpression(n)) { reads = true; return; }
      if (held && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || n.kind === ts.SyntaxKind.ThisKeyword) && this.bindingOf(n as TS.Expression) === held) { reads = true; return; }
      ts.forEachChild(n, look);
    };
    for (const arg of made.arguments ?? []) if (!this.evaluate(arg)) look(arg);
    if (reads) return this.copiedRow(of, made, shape, cls);
    const out: RowValues = { cells: new Map(this.columnsOf(shape).map(({ key, kind }) => [key, kind === "number" ? num(0) : FALSE])), fill: [] };
    out.fill.push((records, index) => {
      const self = this.rowOf(records, index) as Instance;
      this.onRow.set(self, { of: records, index, shape });
      return this.construct(cls, made.arguments ?? [], self, made, `${of.name}[…]`);
    });
    return out;
  }

  /** The variables that are a row of an array and may be given another: which array, and the variable that says which row. */
  private readonly rowVars = new WeakMap<Binding, { of: Records; place: VarDecl }>();

  /** The rows a constructor is running on, by the instance each is: where a field's first value goes. */
  private readonly onRow = new WeakMap<Instance, { of: Records; index: NumExpr; shape: RowShape }>();

  /** A field of a row given a value while its constructor runs: what the class declares it with, or the constructor's parameter that declares it. */
  private rowFieldGiven(self: Instance, key: string, src: FieldSource, at: TS.Node): boolean {
    const row = this.onRow.get(self)!;
    const f = row.shape.get(key);
    if (!f) { this.c.error(at, `${row.of.name} has no ${key} in its rows.`); return false; }
    const out: RowValues = { cells: new Map(), fill: [] };
    if (!this.rowField(row.of.name, key, f, src, out, at)) return false;
    // An array's handle and a text's cells are nothing in a new row, and are filled below: only what is a value is stored.
    if (f.kind !== "list" && f.kind !== "squad" && f.kind !== "text") for (const [column, value] of out.cells) this.emit({ kind: "store", array: row.of.fields.get(column)!.id, index: row.index, value, at: this.at(at), label: this.label(at) }, at);
    return out.fill.every((fill) => fill(row.of, row.index));
  }

  /** The instance made in variables of its own, and its fields the row's values. */
  private copiedRow(of: { name: string }, made: TS.NewExpression, shape: RowShape, cls: TS.ClassDeclaration): RowValues | null {
    const instance = this.instantiate(made, `(new ${this.className(cls)})`);
    if (!instance) return null;
    const out: RowValues = { cells: new Map(), fill: [] };
    for (const [field, f] of shape) if (!this.rowField(of.name, field, f, instance.fields.has(field) ? { binding: instance.fields.get(field)! } : undefined, out, made)) return null;
    // The instance was only made to be the row: the arrays it held were copied into the row's, and give their blocks back.
    out.fill.push(() => { this.releaseHeld(instance, made); return true; });
    return out;
  }

  /** The arrays that grow of a record nothing reaches any more give their blocks back. */
  private releaseHeld(b: Binding, node: TS.Node) {
    const free = (a: ArrayDecl) => { if (a.dynamic && !a.through && !a.slice) this.emit({ kind: "declareArray", array: a.id, init: [], at: this.at(node), label: this.label(node) }, node); };
    if (b.kind === "var" && b.v.kind === "text" && b.v.text === "made") this.emit({ kind: "assignText", target: b.v.id, value: { kind: "text", text: "" }, at: this.at(node), label: this.label(node) }, node);
    else if (b.kind === "array") free(b.a);
    else if (b.kind === "units") [b.ptr, b.epd, b.uid].forEach(free);
    else if (b.kind === "record") for (const inner of b.fields.values()) this.releaseHeld(inner, node);
  }

  /**
   * One field of a row from what it is given — a value the script has, an expression, or something of the program's —
   * as the values of its columns; an array it holds is filled once the row is there (`fill`), since it is reached
   * through the row. False with a diagnostic.
   */
  private rowField(name: string, key: string, f: RowField, src: FieldSource | undefined, out: RowValues, at: TS.Node): boolean {
    const { ts } = this;
    const field = key.replace(/ /g, ".");
    if (!src) { this.c.error(at, `${name}: ${field} is missing.`); return false; }
    const where = "expr" in src ? src.expr : at;
    const zero = (k: string) => HANDLE_PARTS.forEach((part) => out.cells.set(`${k} ${part}`, num(0)));
    switch (f.kind) {
      case "number": case "boolean": {
        let v: NumExpr | BoolExpr | null;
        if ("value" in src) {
          if (f.kind === "boolean") { if (typeof src.value !== "boolean") { this.c.error(where, `${name}: ${field} is true or false, got ${describe(src.value)}.`); return false; } v = { kind: "const", value: src.value }; }
          else { const n = this.asInteger({ value: src.value }, where); v = n === null ? null : num(n); }
        } else if ("expr" in src) v = f.kind === "number" ? this.num(src.expr) : this.boolValue(src.expr);
        else v = src.binding.kind === "record" ? null : (this.valueOf(src.binding, f.kind, where) as NumExpr | BoolExpr | null);
        if (!v) return false;
        out.cells.set(key, v);
        return true;
      }
      case "unit": {
        let u: UnitExpr | null;
        if ("value" in src) { if (src.value !== null && src.value !== undefined) { this.c.error(where, `${name}: ${field} is a unit of the game, got ${describe(src.value)}.`); return false; } u = NO_UNIT; }
        else u = "expr" in src ? this.unitExpr(src.expr) : (this.valueOf(src.binding, "unit", where) as UnitExpr | null);
        if (!u) return false;
        const unit = this.unitTemp(u, where);
        for (const part of UNIT_PARTS) out.cells.set(`${key} ${part}`, { kind: "unitPart", unit, part, at: this.at(where) });
        return true;
      }
      case "text": {
        for (const part of TEXT_PARTS) out.cells.set(`${key} ${part}`, num(0));
        out.fill.push((of, index) => {
          let value: TextExpr | null;
          if ("value" in src) { if (typeof src.value !== "string") { this.c.error(where, `${name}: ${field} is a text, got ${describe(src.value)}.`); return false; } value = this.literalText(src.value, where); }
          else if ("expr" in src) value = this.text(src.expr);
          else if (src.binding.kind === "value" && typeof src.binding.value === "string") value = this.literalText(src.binding.value, where);
          else value = src.binding.kind === "var" && src.binding.v.kind === "text" ? { kind: "textVar", id: src.binding.v.id } : src.binding.kind === "textAt" ? this.textAtCells(src.binding, where) : null;
          if (!value) { if (!("expr" in src)) this.c.error(where, `${name}: ${field} is a text.`); return false; }
          this.storeTextAt(this.textCells(of, key, index), value, where);
          return true;
        });
        return true;
      }
      case "list": {
        zero(key);
        out.fill.push((of, index) => {
          const into = () => this.innerOf(this.listsAt(of, key, f), index, where);
          if ("value" in src) {
            if (!Array.isArray(src.value)) { this.c.error(where, `${name}: ${field} is an array, got ${describe(src.value)}.`); return false; }
            if (src.value.length === 0) return true;
            const inner = into();
            for (const v of src.value as unknown[]) {
              const n = f.of === "boolean" ? (typeof v === "boolean" ? v : null) : this.asInteger({ value: v }, where);
              if (n === null) { if (f.of === "boolean") this.c.error(where, `Expected true or false, got ${describe(v)}.`); return false; }
              this.emit({ kind: "push", array: inner.id, value: typeof n === "boolean" ? { kind: "const", value: n } : num(n), at: this.at(where), label: this.label(where) }, where);
            }
            return true;
          }
          if ("expr" in src) { const e = this.unwrap(src.expr); return ts.isArrayLiteralExpression(e) && e.elements.length === 0 ? true : this.fillInner(into(), f.of, src.expr); }
          const b = src.binding.kind === "inner" ? { kind: "array" as const, a: this.innerOf(src.binding.lists, src.binding.index, where) } : src.binding.kind === "row" ? { kind: "array" as const, a: this.windowOf(src.binding, where) } : src.binding;
          if (b.kind !== "array" || b.a.kind !== f.of) { this.c.error(where, `${name}: ${field} is an array of ${f.of}s.`); return false; }
          this.copyCells(into(), b.a, where);
          return true;
        });
        return true;
      }
      case "squad": {
        for (const part of UNIT_PARTS) zero(`${key} ${part}`);
        out.fill.push((of, index) => {
          const i = this.temp(index, where, true);
          const inners = () => UNIT_PARTS.map((part) => [this.innerOf(this.listsAt(of, `${key} ${part}`, { of: "number", width: { unsigned: true } }), i, where), part] as const);
          if ("value" in src) { if (Array.isArray(src.value) && src.value.length === 0) return true; this.c.error(where, `${name}: ${field} is an array of units, which starts empty or with units of the game.`); return false; }
          const e = "expr" in src ? this.unwrap(src.expr) : undefined;
          if (e && ts.isArrayLiteralExpression(e)) {
            if (e.elements.length === 0) return true;
            const into = inners();
            for (const x of e.elements) {
              const found = ts.isSpreadElement(x) || ts.isOmittedExpression(x) ? null : this.unitExpr(x);
              if (!found) { if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) this.c.error(x, `${field} is written out unit by unit.`); return false; }
              const unit = this.unitTemp(found, x);
              for (const [a, part] of into) this.emit({ kind: "push", array: a.id, value: { kind: "unitPart", unit, part, at: this.at(x) }, at: this.at(x), label: this.label(x) }, x);
            }
            return true;
          }
          const b = e ? this.listOf(e) : "binding" in src ? this.unitsOf(src.binding, where) : undefined;
          if (b?.kind !== "units") { this.c.error(where, `${name}: ${field} is an array of units.`); return false; }
          const from = { ptr: b.ptr, epd: b.epd, uid: b.uid };
          for (const [a, part] of inners()) this.copyCells(a, from[part], where);
          return true;
        });
        return true;
      }
      case "record": {
        let get: (sub: string) => FieldSource | undefined;
        if ("value" in src) {
          const o = src.value;
          if (!o || typeof o !== "object" || Array.isArray(o)) { this.c.error(where, `${name}: ${field} is a record, got ${describe(o)}.`); return false; }
          get = (sub) => (sub in o ? { value: (o as Record<string, unknown>)[sub] } : undefined);
        } else {
          let b: Binding | null | undefined = "binding" in src ? src.binding : undefined;
          if ("expr" in src) {
            const e = this.unwrap(src.expr);
            if (ts.isObjectLiteralExpression(e)) { const from = this.literalSource(e); if (!from) return false; get = from; b = null; }
            else b = ts.isNewExpression(e) && this.classOf(e.expression) ? this.instantiate(e, `(new ${field})`) : this.bindingOf(e);
          }
          if (b !== null) {
            if (b?.kind !== "record") { if (b !== null) this.c.error(where, `${name}: ${field} is a record: { … }${f.cls ? `, or new ${this.className(f.cls)}(…)` : ""}.`); return false; }
            if (f.cls && b.cls !== f.cls) { this.c.error(where, `${name}: ${field} is a ${this.className(f.cls)} in every row, since a row has the fields of one class${b.cls ? `; this is a ${this.className(b.cls)}` : ""}.`); return false; }
            const fields = b.fields;
            get = (sub) => (fields.has(sub) ? { binding: fields.get(sub)! } : undefined);
          }
        }
        for (const [sub, inner] of f.shape) if (!this.rowField(name, `${key} ${sub}`, inner, get!(sub), out, where)) return false;
        return true;
      }
    }
  }

  /** What `{ count: 4, ...w }` gives each field: the last to say what it is wins, as in JavaScript. Null with a diagnostic. */
  private literalSource(literal: TS.ObjectLiteralExpression): ((field: string) => FieldSource | undefined) | null {
    const { ts } = this;
    const whole = this.evaluate(literal)?.value;
    if (whole && typeof whole === "object") return (field) => (field in whole ? { value: (whole as Record<string, unknown>)[field] } : undefined);
    const spreads = new Map<TS.SpreadAssignment, Map<string, Binding>>();
    for (const x of literal.properties) if (ts.isSpreadAssignment(x)) { const from = this.spreadFields(x.expression); if (!from) return null; spreads.set(x, from); }
    return (field) => {
      for (const x of [...literal.properties].reverse()) {
        if ((ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && (ts.isIdentifier(x.name) || ts.isStringLiteralLike(x.name)) && x.name.text === field) return { expr: ts.isPropertyAssignment(x) ? x.initializer : x.name };
        const b = ts.isSpreadAssignment(x) ? spreads.get(x)?.get(field) : undefined;
        if (b) return b.kind === "value" ? { value: b.value } : { binding: b };
      }
      return undefined;
    };
  }

  /** Every cell of `from` pushed to `into`: what a copy of an array is. */
  private copyCells(into: ArrayDecl, from: ArrayDecl, node: TS.Node) {
    const at = this.at(node);
    const label = this.label(node);
    const i = this.newVar(`(index of ${from.name})`, "number", at, { temp: true });
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, node);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: from.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "push", array: into.id, value: { kind: "element", array: from.id, index: varRef(i), at }, at, label }], at, label }, node);
  }

  /** A binding as the array of units it is, a row's made one where it is used. */
  private unitsOf(b: Binding, node: TS.Node): Binding {
    if (b.kind !== "innerUnits") return b;
    const i = this.temp(b.index, node, true);
    return { kind: "units", name: b.name, ptr: this.innerOf(b.ptr, i, node, `${b.name} (ptr)`), epd: this.innerOf(b.epd, i, node, `${b.name} (epd)`), uid: this.innerOf(b.uid, i, node, `${b.name} (uid)`) };
  }

  /**
   * `waves[i]` where `waves` is a list of records the script made when it was built — the wave table written above the
   * program — and `i` a value of the program: a table a field, in the map once, which nothing writes.
   */
  private recordTables(e: TS.ElementAccessExpression): Extract<Binding, { kind: "records" }> | undefined {
    if (this.evaluate(e.argumentExpression)) return undefined;
    const list = this.evaluate(e.expression)?.value;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ARRAY || !list.every((x) => x && typeof x === "object" && !Array.isArray(x))) return undefined;
    const known = this.recordLists.get(list);
    if (known) return known;
    const name = e.expression.getText(this.body.sf).replace(/\s+/g, " ");
    const fields = new Map<string, ArrayDecl>();
    for (const field of Object.keys(list[0] as object)) {
      const column = (list as Record<string, unknown>[]).map((row) => row[field]);
      const booleans = column.every((v) => typeof v === "boolean");
      // A field that is not a whole number or a boolean in every record (a name, a location's text) is not one a program can look up.
      if (!booleans && !column.every((v) => typeof v === "number" && Number.isInteger(v))) continue;
      const values = column.map((v) => (booleans ? (v ? 1 : 0) : (v as number)));
      fields.set(field, this.newArray(`${name}.${field}`, booleans ? "boolean" : "number", values.length, this.at(e.expression), { shared: true, values, ...(values.some((v) => v > I32_MAX) ? { unsigned: true } : {}) }));
    }
    if (fields.size === 0) return undefined;
    const records = { kind: "records" as const, name, fields };
    this.recordLists.set(list, records);
    return records;
  }

  private rowIndex(of: Extract<Binding, { kind: "records" }>, e: TS.Expression): NumExpr | null {
    const h = this.evaluate(e);
    if (!h) return this.num(e);
    const i = this.asInteger(h, e);
    if (i === null) return null;
    const first = [...of.fields.values()][0];
    if (!first.dynamic && (i < 0 || i >= first.length)) { this.c.error(e, `${of.name} has ${first.length} record${first.length === 1 ? "" : "s"}, 0 … ${first.length - 1}; there is no ${of.name}[${i}].`); return null; }
    return num(i);
  }

  private rowOf(of: Records, index: NumExpr): Binding {
    const place = (key: string): Place => ({ a: of.fields.get(key)!, index });
    const build = (shape: RowShape, prefix: string): Map<string, Binding> => new Map([...shape].map(([name, f]): [string, Binding] => {
      const key = prefix + name;
      switch (f.kind) {
        case "unit": return [name, { kind: "unitAt", ptr: place(`${key} ptr`), epd: place(`${key} epd`), uid: place(`${key} uid`) }];
        case "list": return [name, { kind: "inner", lists: this.listsAt(of, key, f), index }];
        case "text": return [name, this.textCells(of, key, index)];
        case "squad": { const [ptr, epd, uid] = UNIT_PARTS.map((part) => this.listsAt(of, `${key} ${part}`, { of: "number", width: { unsigned: true } })); return [name, { kind: "innerUnits", name: `${of.name}[…].${key.replace(/ /g, ".")}`, ptr, epd, uid, index }]; }
        case "record": return [name, { kind: "record", fields: build(f.shape, `${key} `), ...(f.cls ? { cls: f.cls } : {}) }];
        default: return [name, { kind: "cell", a: of.fields.get(key)!, index }];
      }
    }));
    return { kind: "record", fields: build(this.rowShape(of), ""), ...(of.cls ? { cls: of.cls } : {}) };
  }

  /**
   * `let waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]`, `let log: Hit[] = []`: an array a column, all of
   * one length. The fields are the element type's; a record of the list gives each its value. Declared again, the rows
   * it had give the blocks of their arrays back first.
   */
  private declareRecords(name: string, initializer: TS.Expression, shape: RowShape, at: TS.Node, cls?: TS.ClassDeclaration): Binding | null {
    const { ts } = this;
    const init = this.unwrap(initializer);
    const grows = this.body.plan.grows.has(at);
    const rows: RowValues[] = [];
    const whole = this.evaluate(init);
    const items: (FieldSource | TS.Expression)[] = [];
    if (whole) {
      if (!Array.isArray(whole.value)) { this.c.error(init, `Expected a list of records to start ${name} with, got ${describe(whole.value)}.`); return null; }
      items.push(...(whole.value as unknown[]).map((value) => ({ value })));
    } else if (ts.isArrayLiteralExpression(init)) items.push(...init.elements);
    else { this.c.error(init, `${name}'s records have to be written out ([{ … }, { … }]), or it starts empty and is pushed to.`); return null; }
    for (const item of items) {
      if ("value" in item) {
        const row: RowValues = { cells: new Map(), fill: [] };
        const o = item.value as Record<string, unknown> | null;
        for (const [field, f] of shape) if (!this.rowField(name, field, f, o && typeof o === "object" && field in o ? { value: o[field] } : { value: undefined }, row, init)) return null;
        rows.push(row);
        continue;
      }
      const literal = this.unwrap(item as TS.Expression);
      if (!ts.isNewExpression(literal) && !ts.isObjectLiteralExpression(literal)) { this.c.error(item as TS.Expression, `${name} is written out record by record: [{ … }, { … }].`); return null; }
      const row = ts.isNewExpression(literal) ? this.newRow({ name, cls }, literal, shape) : this.rowValues(name, literal, shape);
      if (!row) return null;
      rows.push(row);
    }
    // Written empty, it can only be one that grows — pushed to here, or by a function it is handed to.
    const dynamic = grows || rows.length === 0;
    if (rows.length < (dynamic ? 0 : 1) || rows.length > MAX_ARRAY) { this.c.error(init, dynamic ? `An array of a program starts with at most ${MAX_ARRAY} records.` : `An array of a program has 1 to ${MAX_ARRAY} records (got ${rows.length}); one that starts empty is one something pushes to.`); return null; }
    const fields = new Map<string, ArrayDecl>();
    for (const { key, kind, width } of this.columnsOf(shape)) {
      const a = this.newArray(`${name}.${key.replace(/ /g, ".")}`, kind, rows.length, this.sourceOf(at), width);
      if (dynamic) a.dynamic = true;
      fields.set(key, a);
    }
    const plain = [...shape.values()].every((f) => f.kind === "number" || f.kind === "boolean");
    const records: Records = { kind: "records", name, fields, ...(cls ? { cls } : {}), ...(plain ? {} : { shape }) };
    if (!plain) this.emit({ kind: "remark", short: `rows of ${fields.size} cells`, text: `Each row of ${name} is ${fields.size} cells, one in each of ${fields.size} arrays that move together: a number or a boolean is one, a unit three, a text three (where it is, its block, its length), an array that grows four (its block, its length, its room, its size) and an array of units twelve. The row owns the blocks of its arrays and its made texts: they go back when the row does.`, at: this.at(at) }, at);
    this.releaseFrom(records, num(0), at);
    for (const [key, a] of fields) this.emit({ kind: "declareArray", array: a.id, init: rows.map((r) => r.cells.get(key)!), at: this.at(at), label: this.label(at) }, at);
    for (const [k, row] of rows.entries()) for (const fill of row.fill) if (!fill(records, num(k))) return null;
    return records;
  }

  /** The values of `{ count: 4, delay: d }` by column, every field of the shape given and no other. */
  private rowValues(name: string, literal: TS.ObjectLiteralExpression, shape: RowShape): RowValues | null {
    const from = this.literalSource(literal);
    if (!from) return null;
    const out: RowValues = { cells: new Map(), fill: [] };
    for (const [field, f] of shape) {
      const src = from(field);
      if (!src) { this.c.error(literal, `${name}: a record has ${[...shape.keys()].join(", ")}; ${field} is missing.`); return null; }
      if (!this.rowField(name, field, f, src, out, literal)) return null;
    }
    return out;
  }

  /**
   * `this.members = []`, `squads[i].seen = [a, b]`, `s.path = other`: an array a record's field leads to starts over
   * with what it is given, copied — the field stays the array it is, so this is what assigning one comes to. One of a
   * fixed length takes as many cells as it has.
   */
  private assignList(e: TS.BinaryExpression, field: Binding, op: TS.SyntaxKind) {
    const { ts } = this;
    const at = this.at(e);
    const label = this.label(e);
    if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array takes = only."); return; }
    const given = this.unwrap(e.right);
    const empty = ts.isArrayLiteralExpression(given) && given.elements.length === 0;
    const b = field.kind === "inner" ? { kind: "array" as const, a: this.innerOf(field.lists, field.index, e) } : this.unitsOf(field, e);
    if (b.kind === "array") {
      if (!b.a.dynamic && !b.a.through) { this.c.error(e.left, `${b.a.name} has ${b.a.length} cells for good; assign them one by one, or declare it empty ([]) and push to it, and it is one that can start over.`); return; }
      this.emit({ kind: "declareArray", array: b.a.id, init: [], at, label }, e);
      if (!empty) this.fillInner(b.a, b.a.kind, e.right);
      return;
    }
    if (b.kind !== "units") return;
    if (!b.ptr.dynamic) { this.c.error(e.left, `${b.name} has ${b.ptr.length} units for good; assign them one by one, or declare it empty ([]) and push to it.`); return; }
    const from = empty ? undefined : this.listOf(e.right);
    if (!empty && from?.kind !== "units") { this.c.error(e.right, `${b.name} starts over empty ([]), or as a copy of another array of units.`); return; }
    for (const [a, part] of this.unitArrays(b as Extract<Binding, { kind: "units" }>)) {
      this.emit({ kind: "declareArray", array: a.id, init: [], at, label }, e);
      if (from?.kind === "units") this.copyCells(a, from[part], e);
    }
  }

  /** `waves[i] = { count: 1, delay: 2 }`: every field of the record at i. What the row held of arrays goes back first. */
  private storeRow(e: TS.BinaryExpression, op: TS.SyntaxKind) {
    const { ts } = this;
    const left = this.unwrap(e.left);
    const of = ts.isElementAccessExpression(left) ? this.bindingOf(left.expression) : undefined;
    const literal = this.unwrap(e.right);
    if (of?.kind !== "records" || !ts.isElementAccessExpression(left)) { this.c.error(e.left, "An array of records is assigned record by record: waves[i] = { … }."); return; }
    if (op !== ts.SyntaxKind.EqualsToken || !(ts.isObjectLiteralExpression(literal) || ts.isNewExpression(literal))) { this.c.error(e, `A record of ${of.name} is given whole, ${of.name}[i] = ${of.cls ? `new ${this.className(of.cls)}(…)` : "{ … }"}, or field by field, ${of.name}[i].${[...this.rowShape(of).keys()][0]} = 1.`); return; }
    const shape = this.rowShape(of);
    const row = ts.isNewExpression(literal) ? this.newRow(of, literal, shape, of) : this.rowValues(of.name, literal, shape);
    const index = this.rowIndex(of, left.argumentExpression);
    if (!row || !index) return;
    const i = this.temp(index, e, row.fill.length > 0 || this.owns(of));
    this.releaseRow(of, i, e);
    for (const [key, a] of of.fields) this.emit({ kind: "store", array: a.id, index: i, value: row.cells.get(key)!, at: this.at(e), label: this.label(e) }, e);
    for (const fill of row.fill) if (!fill(of, i)) return;
  }

  /** `waves.push({ … })`, `waves.pop()`: every column moves together, and a row that goes gives the blocks of its arrays back. */
  private recordsCall(e: TS.CallExpression, of: Records, method: string) {
    const { ts } = this;
    const at = this.at(e);
    const label = this.label(e);
    if (method === "push") {
      if (e.arguments.length === 0) { this.c.error(e, "push() takes the record to add."); return; }
      for (const arg of e.arguments) {
        const literal = this.unwrap(arg);
        if (!ts.isObjectLiteralExpression(literal) && !ts.isNewExpression(literal)) { this.c.error(arg, of.cls ? `${of.name}.push(new ${this.className(of.cls)}(…)) takes an instance made there: a row is the instance, so one kept in a variable would be copied, and changing it afterwards would not change the row.` : `${of.name}.push({ … }) takes a record written out.`); return; }
        const shape = this.rowShape(of);
        const row = ts.isNewExpression(literal) ? this.newRow(of, literal, shape, of) : this.rowValues(of.name, literal, shape);
        if (!row) return;
        const place = row.fill.length ? this.newVar(`(row of ${of.name})`, "number", at, { temp: true }) : undefined;
        if (place) this.emit({ kind: "declare", decl: place, init: { kind: "length", array: [...of.fields.values()][0].id, at }, at, label }, e);
        for (const [key, a] of of.fields) { a.dynamic = true; this.emit({ kind: "push", array: a.id, value: row.cells.get(key)!, at, label }, e); }
        for (const fill of row.fill) if (!fill(of, varRef(place!))) return;
      }
      return;
    }
    if (method === "pop" && e.arguments.length === 0) {
      const first = [...of.fields.values()][0];
      const pops = this.collect(() => {
        if (of.shape) this.releaseRow(of, { kind: "binary", op: "-", left: { kind: "length", array: first.id, at }, right: num(1), at, label }, e);
        for (const a of of.fields.values()) { a.dynamic = true; this.emit({ kind: "pop", array: a.id, at, label }, e); }
      });
      if (this.owns(of)) this.emit({ kind: "if", cond: { kind: "compare", op: ">", left: { kind: "length", array: first.id, at }, right: num(0), at, label }, then: pops, at, label }, e);
      else this.out.push(...pops);
      return;
    }
    this.c.error(e, `An array of records has push({ … }), pop(), length, for…of, and forEach, filter, some, every, findIndex, reduce, sort and reverse; ${method}() is not one of them. (pop() stands on its own: read ${of.name}[${of.name}.length - 1] first for what it takes off.)`);
  }

  /** The `__kind` a branded type of the library carries ("unit", "player", …), if it carries one. */
  private brandOfType(type: TS.Type): string | undefined {
    for (const t of type.isUnion() ? type.types : [type]) {
      for (const part of t.isIntersection() ? t.types : [t]) {
        const p = part.getProperty("__kind");
        if (!p) continue;
        const pt = this.c.checker.getTypeOfSymbol(p);
        const name = (pt.isUnion() ? pt.types : [pt]).find((x): x is TS.StringLiteralType => x.isStringLiteral());
        if (name) return name.value;
      }
    }
    return undefined;
  }

  /** Whether a Map's or a Set's keys are any number — no id of the game, which has a cell for every one. */
  private anyNumberKeys(type: TS.Type): boolean {
    const keyType = this.c.checker.getTypeArguments(type as TS.TypeReference)[0];
    if (!keyType) return false;
    const brand = this.brandOfType(keyType);
    return !(brand && KEY_DOMAINS[brand]) && this.kindOf(keyType) === "number";
  }

  /** Whether a declaration is a table keyed by an id of the game: `new Map<K, V>(…)`, `new Set<K>(…)`, or an object literal typed `Record<K, V>`. */
  private keyedForm(init: TS.Expression, type: TS.Type): Keyed["as"] | null {
    const { ts } = this;
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && (init.expression.text === "Map" || init.expression.text === "Set")) return init.expression.text === "Map" ? "map" : "set";
    if (ts.isObjectLiteralExpression(init) && this.c.checker.getIndexInfosOfType(type).some((i) => this.brandOfType(i.keyType) !== undefined)) return "record";
    return null;
  }

  /**
   * `const price: Record<UnitType, number> = { [units.TerranMarine]: 50 }`, `new Map<Player, number>()`, `new Set<UnitType>()`:
   * an array with a cell for every id of the key's kind — and, for a Map or a Set, one of booleans beside it that says
   * which keys were set, and a count — so a key of the game (`u.type`, `u.owner`) is one read. Nothing new reaches a backend.
   */
  private declareKeyed(name: string, as: Keyed["as"], init: TS.Expression, type: TS.Type, at: TS.Node): Keyed | null {
    const { ts } = this;
    const checker = this.c.checker;
    const args = as === "record" ? [] : checker.getTypeArguments(type as TS.TypeReference);
    const keyType = as === "record" ? checker.getIndexInfosOfType(type).find((i) => this.brandOfType(i.keyType))?.keyType : args[0];
    const valueType = as === "record" ? checker.getIndexInfosOfType(type).find((i) => this.brandOfType(i.keyType))?.type : as === "map" ? args[1] : undefined;
    const key = keyType ? this.brandOfType(keyType) : undefined;
    const domain = key ? KEY_DOMAINS[key] : undefined;
    if (!key || !domain) {
      this.c.error(at, `${name}'s keys have to be numbers, or ids of the game — UnitType, Player, Location, Switch, Weapon, Upgrade or Tech: ${as === "set" ? "new Set<UnitType>()" : as === "map" ? "new Map<UnitType, number>()" : "Record<UnitType, number>"}. For numbers of your own, an array does it.`);
      return null;
    }
    const kind = valueType ? this.kindOf(valueType) : null;
    if (as !== "set" && kind !== "number" && kind !== "boolean") { this.c.error(at, `${name} holds numbers or booleans.`); return null; }
    const where = this.sourceOf(at);
    const atIr = this.at(at);
    const label = this.label(at);
    const values = as === "set" ? undefined : this.newArray(name, kind as "number" | "boolean", domain.size, where, kind === "number" ? this.widthOf(valueType!) : {});
    const present = as === "record" ? undefined : this.newArray(`${name} (has)`, "boolean", domain.size, where);
    const size = as === "record" ? undefined : this.newVar(`${name}.size`, "number", where);
    const keyed: Keyed = { kind: "keyed", as, name, domain: domain.size, key, ...(values ? { values } : {}), ...(present ? { present } : {}), ...(size ? { size } : {}) };
    if (values) this.emit({ kind: "declareArray", array: values.id, fill: values.kind === "number" ? num(0) : FALSE, at: atIr, label }, at);
    if (present) this.emit({ kind: "declareArray", array: present.id, fill: FALSE, at: atIr, label }, at);
    if (size) this.emit({ kind: "declare", decl: size, init: num(0), at: atIr, label }, at);
    // What it starts with. An initialiser with nothing of the program in it was worked out whole when the script was built.
    const whole = this.evaluate(init)?.value;
    const start = (entries: [unknown, unknown][]) => {
      const seen = new Set<number>();
      for (const [k, v] of entries) {
        const index = this.keyConstant(keyed, typeof k === "string" && /^\d+$/.test(k) ? Number(k) : k, init);
        if (index === null) continue;
        if (values) {
          const value: NumExpr | BoolExpr | null = values.kind === "boolean" ? (typeof v === "boolean" ? { kind: "const", value: v } : null) : (() => { const n = this.asInteger({ value: v }, init); return n === null ? null : num(n); })();
          if (!value) { if (values.kind === "boolean") this.c.error(init, `Expected true or false, got ${describe(v)}.`); continue; }
          this.emit({ kind: "store", array: values.id, index: num(index), value, at: atIr, label }, at);
        }
        if (present) this.emit({ kind: "store", array: present.id, index: num(index), value: TRUE, at: atIr, label }, at);
        seen.add(index);
      }
      if (size && seen.size) this.emit({ kind: "assign", target: size.id, value: num(seen.size), at: atIr, label }, at);
    };
    if (whole instanceof Map) { start([...whole.entries()]); return keyed; }
    if (whole instanceof Set) { start([...whole.values()].map((k) => [k, true])); return keyed; }
    if (whole && typeof whole === "object") { start(Object.entries(whole)); return keyed; }
    if (as === "record") {
      for (const p of (init as TS.ObjectLiteralExpression).properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isComputedPropertyName(p.name)) { this.c.error(p, `${name}'s keys are ids of the game, written [units.TerranMarine]: 50.`); continue; }
        const index = this.keyIndex(keyed, p.name.expression);
        const value = values!.kind === "number" ? this.num(p.initializer) : this.boolValue(p.initializer);
        if (index && value) this.emit({ kind: "store", array: values!.id, index, value, at: this.at(p), label: this.label(p) }, p);
      }
      return keyed;
    }
    const first = (init as TS.NewExpression).arguments?.[0];
    if (first) {
      const h = this.evaluate(first);
      let entries: unknown[];
      try {
        if (!h || typeof h.value !== "object" || h.value === null || !(Symbol.iterator in h.value)) throw new Error("not a list");
        entries = Array.from(h.value as Iterable<unknown>);
      } catch {
        this.c.error(first, `What ${name} starts with has to be known when the script is built: ${as === "map" ? "new Map([[units.TerranMarine, 50]])" : "new Set([units.TerranMarine])"}. Add the rest with ${as === "map" ? "set()" : "add()"}.`);
        return keyed;
      }
      start(entries.map((entry) => (as === "map" ? [(entry as unknown[])?.[0], (entry as unknown[])?.[1]] : [entry, true]) as [unknown, unknown]));
    }
    return keyed;
  }

  /**
   * A Map or a Set the script made when it was built (`const price = new Map([[units.TerranMarine, 50]])`), asked with a key of
   * the program: the tables it is looked up in, which nothing writes. Undefined when the expression is not one.
   */
  private collectionOf(e: TS.Expression): Keyed | undefined {
    const value = this.evaluate(e)?.value;
    if (!(value instanceof Map) && !(value instanceof Set)) return undefined;
    const known = this.collections.get(value);
    if (known) return known;
    const name = e.getText(this.body.sf).replace(/\s+/g, " ");
    const entries: [unknown, unknown][] = value instanceof Map ? [...value.entries()] : [...value.values()].map((k) => [k, true]);
    if (entries.length === 0 || !entries.every(([k]) => typeof k === "number" && Number.isInteger(k) && k >= 0 && k < MAX_ARRAY)) { this.c.error(e, `${name}'s keys have to be ids of the game (whole numbers from 0) for a program to look one up.`); return undefined; }
    const length = Math.max(...entries.map(([k]) => k as number)) + 1;
    const booleans = entries.every(([, v]) => typeof v === "boolean");
    const cells = new Array<number>(length).fill(0);
    const has = new Array<number>(length).fill(0);
    for (const [k, v] of entries) {
      const n = booleans ? (v ? 1 : 0) : this.asInteger({ value: v }, e);
      if (n === null) return undefined;
      cells[k as number] = n;
      has[k as number] = 1;
    }
    const at = this.at(e);
    const as = value instanceof Map ? "map" : "set";
    const keyed: Keyed = {
      kind: "keyed", as, name, domain: length, key: "unit",
      ...(as === "map" ? { values: this.newArray(name, booleans ? "boolean" : "number", length, at, { shared: true, values: cells, ...(cells.some((v) => v > I32_MAX) ? { unsigned: true } : {}) }) } : {}),
      present: this.newArray(`${name} (has)`, "boolean", length, at, { shared: true, values: has }),
    };
    this.collections.set(value, keyed);
    return keyed;
  }

  /** A key known when the script is built, as a cell's number; null, with a diagnostic, when it is not one of the kind's ids. */
  private keyConstant(b: Keyed, value: unknown, at: TS.Node): number | null {
    const what = KEY_DOMAINS[b.key].what;
    if (typeof value !== "number" || !Number.isInteger(value)) { this.c.error(at, `${b.name}'s keys are ${what}; got ${describe(value)}.`); return null; }
    if (b.key === "player" && value === PlayerGroup.CurrentPlayer) { this.c.error(at, `CurrentPlayer is not a key of ${b.name}: it would be one cell for everybody. In a program of every player a plain variable is already one per player.`); return null; }
    if (value < 0 || value >= b.domain) { this.c.error(at, `${b.name}'s keys are ${what} (0 … ${b.domain - 1}); got ${value}.`); return null; }
    return value;
  }

  /** A key as the index of its cell: a constant checked here, or a number of the program (`u.type`, `u.owner`), which the array's own ends bound. */
  private keyIndex(b: Keyed, e: TS.Expression): NumExpr | null {
    const h = this.evaluate(e);
    if (h && !isGameValue(h.value)) { const k = this.keyConstant(b, h.value, e); return k === null ? null : num(k); }
    return this.num(e);
  }

  /**
   * A method of a keyed table: `get`, `set`, `has`, `delete`, `clear` of a Map; `add`, `has`, `delete`, `clear` of a Set.
   * What comes back is as `arrayCall`'s. A key that is more than a constant or a variable is worked out once, into a temporary.
   */
  private keyedCall(e: TS.CallExpression, b: Keyed, method: string, as: "statement" | "number" | "boolean"): NumExpr | BoolExpr | true | null {
    const at = this.at(e);
    const label = this.label(e);
    const wrong = (what: string) => { this.c.error(e, what); return null; };
    if (b.as === "record") return wrong(`${b.name} is read and written by its keys: ${b.name}[key].`);
    if (b.present?.values && method !== "get" && method !== "has") return wrong(`${b.name} was made when the script was built and is only read in a program; make it inside the program to change it.`);
    const cell = (a: ArrayDecl, index: NumExpr) => ({ kind: "element" as const, array: a.id, index, at });
    const key = (): NumExpr | null => {
      if (e.arguments.length < 1) { this.c.error(e, `${method}() takes a key.`); return null; }
      const index = this.keyIndex(b, e.arguments[0]);
      if (!index || index.kind === "const" || index.kind === "var" || as !== "statement") return index;
      const t = this.newVar(`(key of ${b.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: t, init: index, at, label }, e);
      return varRef(t);
    };
    const present = b.present!;
    const size = b.size!;
    const bump = (by: "+" | "-"): Stmt => ({ kind: "assign", target: size.id, value: { kind: "binary", op: by, left: varRef(size), right: num(1), at, label }, at, label });
    switch (method) {
      case "has": {
        if (as !== "boolean") return wrong(`${b.name}.has(…) is true or false.`);
        const index = key();
        return index ? this.mark<BoolExpr>(cell(present, index), e) : null;
      }
      case "get": {
        if (b.as !== "map" || !b.values) return wrong("A Set has has(), add() and delete().");
        if (as === "statement") return wrong(`${b.name}.get(…) is a value: use it or store it.`);
        if ((as === "number") !== (b.values.kind === "number")) return wrong(`${b.name} holds ${b.values.kind}s.`);
        const index = key();
        return index ? this.mark<NumExpr | BoolExpr>(cell(b.values, index), e) : null;
      }
      case "set": case "add": {
        if ((method === "set") !== (b.as === "map")) return wrong(b.as === "map" ? "A Map takes set(key, value)." : "A Set takes add(key).");
        if (as !== "statement") return wrong(`${b.name}.${method}(…) stands on its own.`);
        if (e.arguments.length !== (b.as === "map" ? 2 : 1)) return wrong(b.as === "map" ? "set() takes a key and a value." : "add() takes a key.");
        const index = key();
        if (!index) return null;
        const value = b.values ? (b.values.kind === "number" ? this.num(e.arguments[1]) : this.boolValue(e.arguments[1])) : null;
        if (b.values && !value) return null;
        if (b.values) this.emit({ kind: "store", array: b.values.id, index, value: value!, at, label }, e);
        this.emit({ kind: "if", cond: { kind: "not", expr: cell(present, index) }, then: [bump("+"), { kind: "store", array: present.id, index, value: TRUE, at, label }], at, label }, e);
        return true;
      }
      case "delete": {
        if (as !== "statement") return wrong(`${b.name}.delete(…) stands on its own; ask has() first for whether it was there.`);
        const index = key();
        if (!index) return null;
        const then: Stmt[] = [bump("-"), { kind: "store", array: present.id, index, value: FALSE, at, label }];
        if (b.values) then.push({ kind: "store", array: b.values.id, index, value: b.values.kind === "number" ? num(0) : FALSE, at, label });
        this.emit({ kind: "if", cond: cell(present, index), then, at, label }, e);
        return true;
      }
      case "clear": {
        if (as !== "statement" || e.arguments.length) return wrong(`${b.name}.clear() stands on its own and takes nothing.`);
        if (b.values) this.emit({ kind: "declareArray", array: b.values.id, fill: b.values.kind === "number" ? num(0) : FALSE, at, label }, e);
        this.emit({ kind: "declareArray", array: present.id, fill: FALSE, at, label }, e);
        this.emit({ kind: "assign", target: size.id, value: num(0), at, label }, e);
        return true;
      }
      default:
        return wrong(`${b.as === "map" ? "A Map of a program has get, set, has, delete, clear and size" : "A Set of a program has add, has, delete, clear and size"}; ${method}() is not one of them.`);
    }
  }

  /** An array something pushes to, pops from or sets the length of grows. One met through a parameter is found here; a list computed when the script was built cannot. */
  private grows(a: ArrayDecl, at: TS.Node): boolean {
    if (a.slice) { this.c.error(at, `${a.name} is a row of an array of arrays, which is one flat array: every row has its ${a.length} cells, and whole rows are pushed to the outer array.`); return false; }
    if (a.values) { this.c.error(at, `${a.name} was computed when the script was built and is only read in a program; declare it with let inside the program to change it.`); return false; }
    a.dynamic = true;
    return true;
  }

  /**
   * A method of an array: `push`, `pop`, `fill`, `includes`, `indexOf`. `as` is where the call stands — a statement,
   * a number or a boolean — and what comes back is the expression (true for a statement), or null with a diagnostic.
   * `includes` and `indexOf` are a function of the compiler's own, inlined as any function is: a loop over the cells.
   */
  private arrayCall(e: TS.CallExpression, a: ArrayDecl, method: string, as: "statement" | "number" | "boolean"): NumExpr | BoolExpr | true | null {
    const at = this.at(e);
    const label = this.label(e);
    const one = (x: TS.Expression): NumExpr | BoolExpr | null => (a.kind === "number" ? this.num(x) : this.boolValue(x));
    const wrong = (what: string) => { this.c.error(e, what); return null; };
    switch (method) {
      case "push": {
        if (as !== "statement") return wrong(`${a.name}.push(…) stands on its own; the new length is ${a.name}.length.`);
        if (e.arguments.length === 0) return wrong("push() takes what to add.");
        if (!this.grows(a, e)) return null;
        for (const x of e.arguments) { const value = one(x); if (!value) return null; this.emit({ kind: "push", array: a.id, value, at, label }, e); }
        return true;
      }
      case "pop": {
        if (e.arguments.length) return wrong("pop() takes no argument.");
        if (!this.grows(a, e)) return null;
        if (as === "statement") { this.emit({ kind: "pop", array: a.id, at, label }, e); return true; }
        if ((as === "number") !== (a.kind === "number")) return wrong(`${a.name} holds ${a.kind}s.`);
        return this.mark<NumExpr | BoolExpr>({ kind: "pop", array: a.id, at }, e);
      }
      case "fill": {
        if (as !== "statement" || e.arguments.length !== 1) return wrong(`${a.name}.fill(value) stands on its own and takes one value.`);
        if (a.values) return wrong(`${a.name} was computed when the script was built and is only read in a program.`);
        const value = one(e.arguments[0]);
        if (!value) return null;
        // The value once, then every cell: a loop the game runs, as for…of is.
        const v = this.newVar(`(fill of ${a.name})`, a.kind, at, { temp: true, ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) });
        const i = this.newVar(`(index of ${a.name})`, "number", at, { temp: true });
        this.emit({ kind: "declare", decl: v, init: value, at, label }, e);
        this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
        this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }],
          body: [{ kind: "store", array: a.id, index: varRef(i), value: a.kind === "number" ? varRef(v) : boolRef(v), at, label }], at, label }, e);
        return true;
      }
      case "includes": case "indexOf": {
        if (e.arguments.length !== 1) return wrong(`${method}() takes the value to look for.`);
        if (as === "statement") return wrong(`${a.name}.${method}(…) is a value: use it in an if or store it.`);
        if ((method === "includes") !== (as === "boolean")) return wrong(method === "includes" ? `${a.name}.includes(…) is true or false.` : `${a.name}.indexOf(…) is a number: the place of the value, or -1.`);
        const wanted = one(e.arguments[0]);
        if (!wanted) return null;
        const w = this.newVar(`(${method} of ${a.name})`, a.kind, at, { temp: true });
        const i = this.newVar(`(index of ${a.name})`, "number", at, { temp: true });
        const result = this.newVar(`(${a.name}.${method} result)`, method === "includes" ? "boolean" : "number", at, { temp: true });
        const cell = { kind: "element" as const, array: a.id, index: varRef(i), at };
        const same: BoolExpr = a.kind === "number"
          ? { kind: "compare", op: "==", left: cell, right: varRef(w), at, label }
          : { kind: "or", items: [{ kind: "and", items: [cell, boolRef(w)] }, { kind: "and", items: [{ kind: "not", expr: cell }, { kind: "not", expr: boolRef(w) }] }] };
        const found: Stmt[] = [{ kind: "return", value: method === "includes" ? TRUE : varRef(i), at, label }];
        const call: Call = {
          name: `${a.name}.${method}`, at, label, params: [{ decl: w, init: wanted, label }], result: { decl: result, kind: method === "includes" ? "boolean" : "number" },
          body: [
            { kind: "declare", decl: i, init: num(0), at, label },
            { kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "if", cond: same, then: found, at, label }], at, label },
            { kind: "return", value: method === "includes" ? FALSE : num(-1), at, label },
          ],
        };
        return this.mark<NumExpr | BoolExpr>({ kind: "call", call }, e);
      }
      default:
        return wrong(`An array of a program has push, pop, fill, includes, indexOf, length, for…of, and the methods that take a function (forEach, map, filter, some, every, find, findIndex, reduce, sort) with reverse; ${method}() is not one of them.`);
    }
  }

  /* ── Arrays of arrays of a fixed shape ── */

  /** `index * by + plus`, with what the script knows worked out. */
  private scaled(index: NumExpr, by: number, plus: NumExpr | null, node: TS.Node): NumExpr {
    const at = this.at(node);
    const label = this.label(node);
    if (index.kind === "const" && (!plus || plus.kind === "const")) return num(index.value * by + (plus ? plus.value : 0));
    const times: NumExpr = by === 1 ? index : index.kind === "const" ? num(index.value * by) : { kind: "binary", op: "*", left: index, right: num(by), at, label };
    if (!plus || (plus.kind === "const" && plus.value === 0)) return times;
    return { kind: "binary", op: "+", left: plus, right: times, at, label };
  }

  /** `grid[i]`: a row of it — or, of a deeper one, the grid inside. A constant past a known end is an error, as it is for an array. */
  private partOf(grid: Grid, e: TS.Expression, node: TS.Node): Binding | undefined {
    const h = this.evaluate(e);
    let index: NumExpr | null;
    if (h) {
      const i = this.asInteger(h, e);
      if (i === null) return undefined;
      if (i < 0 || (grid.dims[0] > 0 && i >= grid.dims[0])) { this.c.error(e, `${grid.name} has ${grid.dims[0]} row${grid.dims[0] === 1 ? "" : "s"}, 0 … ${grid.dims[0] - 1}; there is no ${grid.name}[${i}].`); return undefined; }
      index = num(i);
    } else index = this.num(e);
    return index ? this.partAt(grid, index, node) : undefined;
  }

  private partAt(grid: Grid, index: NumExpr, node: TS.Node): Binding {
    const stride = grid.dims.slice(1).reduce((n, d) => n * d, 1);
    const offset = this.scaled(index, stride, grid.offset, node);
    const name = `${grid.name}[${index.kind === "const" ? index.value : "…"}]`;
    return grid.dims.length === 2 ? { kind: "row", name, a: grid.a, offset, length: grid.dims[1] } : { kind: "grid", name, a: grid.a, dims: grid.dims.slice(1), offset };
  }

  /**
   * `row[x]` as a cell of the flat array. Past the row's end the index is -1 — which reads 0 and stores nothing, as past
   * the end of any array — so a row never reaches into the next one. Null, with a diagnostic, for a constant that is.
   */
  private rowCell(row: Row, e: TS.Expression, node: TS.Node): { a: ArrayDecl; index: NumExpr } | null {
    const at = this.at(node);
    const label = this.label(node);
    const h = this.evaluate(e);
    if (h) {
      const x = this.asInteger(h, e);
      if (x === null) return null;
      if (x < 0 || x >= row.length) { this.c.error(e, `${row.name} has ${row.length} cell${row.length === 1 ? "" : "s"}, 0 … ${row.length - 1}; there is no ${row.name}[${x}].`); return null; }
      return { a: row.a, index: this.scaled(num(x), 1, row.offset, node) };
    }
    const given = this.num(e);
    if (!given) return null;
    const x = this.temp(given, node);
    const inside: BoolExpr = { kind: "compare", op: "<", left: x, right: num(row.length), unsigned: true, at, label };
    return { a: row.a, index: { kind: "ternary", cond: inside, whenTrue: this.scaled(x, 1, row.offset, node), whenFalse: num(-1), at, label } };
  }

  /** A row as an array in its own right — for a loop, a method, a function it is handed to: a window on the flat array, from where the row starts now. */
  private windowOf(row: Row, node: TS.Node): ArrayDecl {
    const at = this.at(node);
    const start = this.newVar(`(start of ${row.name})`, "number", at, { temp: true });
    this.emit({ kind: "declare", decl: start, init: row.offset, at, label: this.label(node) }, node);
    const a = this.newArray(row.name, row.a.kind, row.length, this.sourceOf(node), { ...(row.a.bits ? { bits: row.a.bits } : {}), ...(row.a.unsigned ? { unsigned: true } : {}) });
    a.slice = { of: row.a.id, offset: start.id };
    return a;
  }

  /** What the binding of an expression is once a row has to be an array: the row's window, anything else as it is. */
  private arrayOf(expr: TS.Expression): Binding | undefined {
    const b = this.bindingOf(expr);
    if (b?.kind === "inner") return { kind: "array", a: this.innerOf(b.lists, b.index, expr) };
    if (b?.kind === "innerUnits") return this.unitsOf(b, expr);
    return b?.kind === "row" ? { kind: "array", a: this.windowOf(b, expr) } : b;
  }

  /** How many rows a grid has: a constant, or — when the outer array grows — its cells by the cells of a row. */
  private rowsOf(grid: Grid, node: TS.Node): NumExpr {
    if (grid.dims[0] > 0) return num(grid.dims[0]);
    const stride = grid.dims.slice(1).reduce((n, d) => n * d, 1);
    const cells: NumExpr = { kind: "length", array: grid.a.id, at: this.at(node) };
    return stride === 1 ? cells : { kind: "binary", op: "/", left: cells, right: num(stride), at: this.at(node), label: this.label(node) };
  }

  /** The kind a type's cells are and how deep its arrays go, when it is an array of arrays (of arrays…) of numbers or of booleans. */
  private gridType(type: TS.Type): { kind: "number" | "boolean"; depth: number; leaf: TS.Type } | null {
    const { ts } = this;
    let depth = 0;
    let t = type;
    while (this.c.checker.isArrayType(t) || this.c.checker.isTupleType(t)) {
      const inner = this.c.checker.getIndexTypeOfType(t, ts.IndexKind.Number);
      if (!inner) return null;
      t = inner;
      depth++;
    }
    const kind = this.kindOf(t);
    return depth >= 2 && (kind === "number" || kind === "boolean") ? { kind, depth, leaf: t } : null;
  }

  /** Whether something pushes to, pops from or sets the length of a *row* of a declaration (`buckets[i].push(v)`): then its rows grow, whatever lengths they start with. */
  private innerGrows(decl: TS.Node): boolean {
    const { ts } = this;
    let found = false;
    const rowOfDecl = (x: TS.Expression): boolean => { const u = this.unwrap(x); return ts.isElementAccessExpression(u) && ts.isIdentifier(this.unwrap(u.expression)) && declarationOf(ts, this.c.checker, this.unwrap(u.expression) as TS.Identifier) === decl; };
    const walk = (n: TS.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && (n.expression.name.text === "push" || n.expression.name.text === "pop") && rowOfDecl(n.expression.expression)) found = true;
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === "length" && rowOfDecl(n.left.expression)) found = true;
      else ts.forEachChild(n, walk);
    };
    walk(this.body.plan.arrow.body);
    return found;
  }

  /** The length of every row literal something pushes to a declaration: what says how wide a grid that starts empty is. */
  private pushedWidths(decl: TS.Node): number[] {
    const { ts } = this;
    const out: number[] = [];
    const walk = (n: TS.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && ts.isIdentifier(n.expression.expression) && declarationOf(ts, this.c.checker, n.expression.expression) === decl) {
        for (const x of n.arguments) { const row = this.unwrap(x); out.push(ts.isArrayLiteralExpression(row) && !row.elements.some((y) => ts.isSpreadElement(y)) ? row.elements.length : -1); }
      }
      ts.forEachChild(n, walk);
    };
    walk(this.body.plan.arrow.body);
    return out;
  }

  /**
   * `let grid = [[0, 0, 0], [0, 0, 0]]`, `new Array(8).fill(0).map(() => new Array(8).fill(0))`, `let path: number[][] = []`
   * that only whole rows of one width are pushed to: every row the same length, so the whole is one flat array read at
   * `y * width + x`. Undefined when the shape is not of that kind (rows of different lengths, a row that grows) — that
   * is an array of arrays that grow, which is another thing; null with a diagnostic.
   */
  private declareGrid(name: string, initializer: TS.Expression, shape: NonNullable<ReturnType<Structured["gridType"]>>, at: TS.Node): Binding | null | undefined {
    const { ts } = this;
    const init = this.unwrap(initializer);
    const cells: (NumExpr | BoolExpr)[] = [];
    const dims: number[] = [];
    let ragged = false;
    const size = (depth: number, n: number) => { if (dims[depth] === undefined) dims[depth] = n; else if (dims[depth] !== n) ragged = true; };
    const constant = (v: unknown, where: TS.Node): boolean => {
      if (shape.kind === "boolean") { if (typeof v !== "boolean") { this.c.error(where, `Expected true or false, got ${describe(v)}.`); return false; } cells.push({ kind: "const", value: v }); return true; }
      const n = this.asInteger({ value: v }, where);
      if (n === null) return false;
      cells.push(num(n));
      return true;
    };
    const known = (v: unknown, depth: number, where: TS.Node): boolean => {
      if (depth === shape.depth) return constant(v, where);
      if (!Array.isArray(v)) { this.c.error(where, `Expected a list here, got ${describe(v)}.`); return false; }
      size(depth, v.length);
      return v.every((x) => known(x, depth + 1, where));
    };
    const written = (e: TS.Expression, depth: number): boolean => {
      const h = this.evaluate(e);
      if (h) return known(h.value, depth, e);
      if (depth === shape.depth) { const v = shape.kind === "number" ? this.num(e) : this.boolValue(e); if (!v) return false; cells.push(v); return true; }
      const list = this.unwrap(e);
      if (!ts.isArrayLiteralExpression(list) || list.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) { ragged = true; return true; }
      size(depth, list.elements.length);
      return list.elements.every((x) => written(x, depth + 1));
    };
    if (!written(init, 0)) return null;
    // Started empty, how wide a row is comes from the rows that are pushed; one width, or it is not a grid.
    const grows = this.body.plan.grows.has(at);
    if (shape.depth === 2 && dims[0] === 0 && dims[1] === undefined) {
      const widths = this.pushedWidths(at);
      if (widths.length && widths.every((w) => w === widths[0] && w > 0)) dims[1] = widths[0];
    } else if (grows && shape.depth === 2 && this.pushedWidths(at).some((w) => w !== dims[1])) ragged = true;
    if (ragged || dims.length !== shape.depth || dims.slice(1).some((d) => !d) || (!grows && !dims[0])) return undefined;
    const total = dims.reduce((n, d) => n * d, 1);
    if (total > MAX_ARRAY) { this.c.error(init, `An array of a program starts with at most ${MAX_ARRAY} cells (this is ${dims.join(" × ")}, ${total}).`); return null; }
    const a = this.newArray(name, shape.kind, total, this.sourceOf(at), shape.kind === "number" ? this.widthOf(shape.leaf) : {});
    if (grows) a.dynamic = true;
    const same = cells.length > 4 && cells.every((v) => v.kind === "const" && v.value === (cells[0] as { value: unknown }).value);
    this.emit({ kind: "remark", text: `One flat array, ${name}[y][x] read at y × ${dims.slice(1).reduce((n, d) => n * d, 1)} + x: every row has ${dims[1]} cells and none of them grows${grows ? "; whole rows are pushed and popped" : ""}. A row past its own end reads 0.`, short: `flat, ${grows ? "rows" : dims[0]} × ${dims.slice(1).join(" × ")}`, at: this.at(at) }, at);
    this.emit({ kind: "declareArray", array: a.id, ...(same ? { fill: cells[0] } : { init: cells }), at: this.at(at), label: this.label(at) }, at);
    return { kind: "grid", name, a, dims: grows ? [0, ...dims.slice(1)] : dims, offset: null };
  }

  /** The cells of a row given to a grid — `grid.push([x, y])`, `grid[i] = [0, 0, 0]`: written out, and as many as a row has. */
  private rowCells(grid: Grid, e: TS.Expression): (NumExpr | BoolExpr)[] | null {
    const { ts } = this;
    const width = grid.dims.slice(1).reduce((n, d) => n * d, 1);
    const out: (NumExpr | BoolExpr)[] = [];
    const take = (x: TS.Expression, depth: number): boolean => {
      if (depth === grid.dims.length) { const v = grid.a.kind === "number" ? this.num(x) : this.boolValue(x); if (!v) return false; out.push(v); return true; }
      const list = this.unwrap(x);
      if (ts.isArrayLiteralExpression(list) && !list.elements.some((y) => ts.isSpreadElement(y) || ts.isOmittedExpression(y))) {
        if (list.elements.length !== grid.dims[depth]) { this.c.error(x, `A row of ${grid.name} has ${grid.dims[depth]} cell${grid.dims[depth] === 1 ? "" : "s"}; this one has ${list.elements.length}.`); return false; }
        return list.elements.every((y) => take(y, depth + 1));
      }
      const b = this.arrayOf(x);
      if (depth === grid.dims.length - 1 && b?.kind === "array" && !b.a.dynamic && b.a.length === grid.dims[depth] && b.a.kind === grid.a.kind) { for (let k = 0; k < b.a.length; k++) out.push({ kind: "element", array: b.a.id, index: num(k), at: this.at(x) }); return true; }
      this.c.error(x, `A row of ${grid.name} is written out — [a, b] — or is an array of the same ${grid.dims[depth]} cells.`);
      return false;
    };
    return take(e, 1) && out.length === width ? out : null;
  }

  /** `grid.push([x, y])`, `grid.pop()` on their own: whole rows, which is what keeps it a grid. */
  private gridCall(e: TS.CallExpression, grid: Grid, method: string) {
    const at = this.at(e);
    const label = this.label(e);
    const width = grid.dims.slice(1).reduce((n, d) => n * d, 1);
    if (grid.offset) { this.c.error(e, `${grid.name} is a part of a larger array of arrays; rows are pushed to the whole.`); return; }
    if (method === "push" && e.arguments.length > 0) {
      if (!this.grows(grid.a, e)) return;
      for (const arg of e.arguments) { const cells = this.rowCells(grid, arg); if (!cells) return; const held = cells.map((v) => (v.kind === "const" || v.kind === "var" ? v : null)); for (const [k, v] of cells.entries()) this.emit({ kind: "push", array: grid.a.id, value: held[k] ?? v, at, label }, e); }
      return;
    }
    if (method === "pop" && e.arguments.length === 0) {
      if (!this.grows(grid.a, e)) return;
      this.emit({ kind: "setLength", array: grid.a.id, value: { kind: "binary", op: "-", left: { kind: "length", array: grid.a.id, at }, right: num(width), at, label }, at, label }, e);
      return;
    }
    this.c.error(e, `An array of arrays has push([…]), pop(), length, for…of, forEach, some, every, findIndex, reduce and map; ${method}() is not one of them.`);
  }

  /* ── Arrays that grow, inside an array ── */

  /** The four arrays an array of arrays that grow is: a handle a row. */
  private handlesOf(l: Lists): ArrayDecl[] {
    return [l.ptr, l.len, l.room, l.k];
  }

  /**
   * `buckets[i]` as the growing array it is: reached through cell i of the four. Where `i` stands now is taken into a
   * variable of its own, so what is made here stays that row whatever happens to `i` after.
   */
  private innerOf(l: Lists, index: NumExpr, node: TS.Node, name?: string): ArrayDecl {
    const at = this.at(node);
    const i = this.newVar(`(row of ${l.name})`, "number", at, { temp: true });
    this.emit({ kind: "declare", decl: i, init: index, at, label: this.label(node) }, node);
    return this.innerAt(l, i, node, name);
  }

  private innerAt(l: Lists, i: VarDecl, node: TS.Node, name?: string): ArrayDecl {
    const a = this.newArray(name ?? `${l.name}[…]`, l.of, 0, this.sourceOf(node), { ...(l.bits ? { bits: l.bits } : {}), ...(l.unsigned ? { unsigned: true } : {}) });
    a.dynamic = true;
    a.through = { ptr: l.ptr.id, len: l.len.id, room: l.room.id, k: l.k.id, index: i.id };
    return a;
  }

  /** The rows from `from` on give their blocks back: what holds a handle owns the block, and these rows are about to go. */
  private releaseRows(l: Lists, from: NumExpr, node: TS.Node) {
    const at = this.at(node);
    const label = this.label(node);
    const i = this.newVar(`(row of ${l.name})`, "number", at, { temp: true });
    const row = this.innerAt(l, i, node);
    this.emit({ kind: "declare", decl: i, init: from, at, label }, node);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: l.ptr.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }],
      body: [{ kind: "declareArray", array: row.id, init: [], at, label }], at, label }, node);
  }

  /** The cells a row is given — `[a, b]`, `[]`, or an array of the program, copied. Pushed into `into`. False with a diagnostic. */
  private fillInner(into: ArrayDecl, of: "number" | "boolean", e: TS.Expression): boolean {
    const { ts } = this;
    const at = this.at(e);
    const label = this.label(e);
    const h = this.evaluate(e);
    if (h) {
      if (!Array.isArray(h.value)) { this.c.error(e, `Expected a list here, got ${describe(h.value)}.`); return false; }
      for (const v of h.value as unknown[]) {
        if (of === "boolean") { if (typeof v !== "boolean") { this.c.error(e, `Expected true or false, got ${describe(v)}.`); return false; } this.emit({ kind: "push", array: into.id, value: { kind: "const", value: v }, at, label }, e); }
        else { const n = this.asInteger({ value: v }, e); if (n === null) return false; this.emit({ kind: "push", array: into.id, value: num(n), at, label }, e); }
      }
      return true;
    }
    const list = this.unwrap(e);
    if (ts.isArrayLiteralExpression(list) && !list.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) {
      for (const x of list.elements) { const v = of === "number" ? this.num(x) : this.boolValue(x); if (!v) return false; this.emit({ kind: "push", array: into.id, value: v, at, label }, e); }
      return true;
    }
    const b = this.listOf(e);
    if (b?.kind === "array" && b.a.kind === of) {
      const i = this.newVar(`(index of ${b.a.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: b.a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "push", array: into.id, value: { kind: "element", array: b.a.id, index: varRef(i), at }, at, label }], at, label }, e);
      return true;
    }
    this.c.error(e, `A row is written out — [a, b], [] — or is an array of ${of}s, whose cells are copied.`);
    return false;
  }

  /**
   * `let buckets: number[][] = [[], [], []]`, `let rows = [[1, 2], [3]]`: an array of arrays that grow — four arrays, a
   * handle a row, each row a block of the heap once something is pushed to it. Declared again, the rows it had give
   * their blocks back first.
   */
  private declareLists(name: string, initializer: TS.Expression, shape: NonNullable<ReturnType<Structured["gridType"]>>, at: TS.Node): Lists | null {
    const { ts } = this;
    if (shape.depth !== 2) { this.c.error(at, `${name} is arrays three deep whose rows are not all one length; an array that grows inside one that grows inside another is not supported. Two deep is, and so is any depth of one shape.`); return null; }
    const init = this.unwrap(initializer);
    const h = this.evaluate(init);
    const rows: (TS.Expression | unknown[])[] = [];
    if (h) {
      if (!Array.isArray(h.value) || !(h.value as unknown[]).every((r) => Array.isArray(r))) { this.c.error(init, `Expected a list of lists to start ${name} with, got ${describe(h.value)}.`); return null; }
      rows.push(...(h.value as unknown[][]));
    } else if (ts.isArrayLiteralExpression(init) && !init.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) rows.push(...init.elements);
    else { this.c.error(init, `${name} is written out row by row ([[a, b], []]), or starts empty and is pushed to.`); return null; }
    const dynamic = this.body.plan.grows.has(at) || rows.length === 0;
    if (rows.length > MAX_ARRAY) { this.c.error(init, `An array of a program starts with at most ${MAX_ARRAY} rows.`); return null; }
    const make = (part: string) => { const a = this.newArray(`${name} (${part})`, "number", rows.length, this.sourceOf(at), { unsigned: true }); if (dynamic) a.dynamic = true; return a; };
    const lists: Lists = { kind: "lists", name, ptr: make("block"), len: make("length"), room: make("room"), k: make("size"), of: shape.kind, ...(shape.kind === "number" ? this.widthOf(shape.leaf) : {}) };
    this.emit({ kind: "remark", text: `Rows that grow: each row of ${name} is a block of the heap of its own, found through the outer array — a few more triggers a read than one flat array, which is what it would be with every row one length and nothing pushed to a row.`, short: "rows that grow", at: this.at(at) }, at);
    this.releaseRows(lists, num(0), at);
    for (const a of this.handlesOf(lists)) this.emit({ kind: "declareArray", array: a.id, ...(rows.length > 4 ? { fill: num(0) } : { init: rows.map(() => num(0)) }), at: this.at(at), label: this.label(at) }, at);
    for (const [r, row] of rows.entries()) {
      if (Array.isArray(row) ? row.length === 0 : ts.isArrayLiteralExpression(this.unwrap(row)) && (this.unwrap(row) as TS.ArrayLiteralExpression).elements.length === 0) continue;
      const inner = this.innerOf(lists, num(r), at, `${name}[${r}]`);
      if (Array.isArray(row)) {
        for (const v of row) {
          if (shape.kind === "boolean") { if (typeof v !== "boolean") { this.c.error(init, `Expected true or false, got ${describe(v)}.`); return null; } this.emit({ kind: "push", array: inner.id, value: { kind: "const", value: v }, at: this.at(at), label: this.label(at) }, at); }
          else { const n = this.asInteger({ value: v }, init); if (n === null) return null; this.emit({ kind: "push", array: inner.id, value: num(n), at: this.at(at), label: this.label(at) }, at); }
        }
      } else if (!this.fillInner(inner, shape.kind, row)) return null;
    }
    return lists;
  }

  /** `buckets.push([1, 2])`, `buckets.push([])`, `buckets.pop()` on their own; the four arrays move together, and a row that goes gives its block back. */
  private listsCall(e: TS.CallExpression, l: Lists, method: string) {
    const at = this.at(e);
    const label = this.label(e);
    if (method === "push" && e.arguments.length > 0) {
      for (const a of this.handlesOf(l)) if (!this.grows(a, e)) return;
      for (const arg of e.arguments) {
        const place = this.newVar(`(row of ${l.name})`, "number", at, { temp: true });
        this.emit({ kind: "declare", decl: place, init: { kind: "length", array: l.ptr.id, at }, at, label }, e);
        for (const a of this.handlesOf(l)) this.emit({ kind: "push", array: a.id, value: num(0), at, label }, e);
        if (!this.fillInner(this.innerAt(l, place, arg), l.of, arg)) return;
      }
      return;
    }
    if (method === "pop" && e.arguments.length === 0) {
      for (const a of this.handlesOf(l)) if (!this.grows(a, e)) return;
      const last: NumExpr = { kind: "binary", op: "-", left: { kind: "length", array: l.ptr.id, at }, right: num(1), at, label };
      const body = this.collect(() => {
        this.emit({ kind: "declareArray", array: this.innerOf(l, last, e).id, init: [], at, label }, e);
        for (const a of this.handlesOf(l)) this.emit({ kind: "pop", array: a.id, at, label }, e);
      });
      this.emit({ kind: "if", cond: { kind: "compare", op: ">", left: { kind: "length", array: l.ptr.id, at }, right: num(0), at, label }, then: body, at, label }, e);
      return;
    }
    this.c.error(e, `An array of arrays that grow has push([…]), pop() on its own, length, for…of, forEach, some, every, findIndex, reduce and map; ${method}() is not one of them.`);
  }

  /* ── Destructuring and spread ── */

  /**
   * What a pattern takes its values from: a record, a list, a value the script has — or, for `[a, b] = [b, a + 1]`, the
   * items of an array written out, each worked out into a temporary first, so that a swap is one. Null with a diagnostic.
   */
  private patternSource(init: TS.Expression, at: TS.Node): Binding | Binding[] | null {
    const { ts } = this;
    const e = this.unwrap(init);
    const h = this.evaluate(init);
    if (h) return { kind: "value", value: h.value };
    if (ts.isArrayLiteralExpression(e)) {
      const items: Binding[] = [];
      for (const x of e.elements) {
        if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) { this.c.error(x, "An array that is taken apart where it is written has its items written out: [a, b] = [b, a]."); return null; }
        const known = this.evaluate(x);
        if (known) { items.push({ kind: "value", value: known.value }); continue; }
        const held = this.bindingOf(x);
        if (held && held.kind !== "var" && held.kind !== "cell") { items.push(held); continue; }
        if (this.isTextTyped(x)) {
          // A text: a copy of its own, made before anything is stored — which is the whole of `[a, b] = [b, a]`.
          const given = this.text(x);
          if (!given) return null;
          const copy = this.newVar("(taken)", "text", this.at(x), { temp: true, text: "made" });
          this.emit({ kind: "declare", decl: copy, init: given, at: this.at(x), label: this.label(x) }, x);
          items.push({ kind: "var", v: copy });
          continue;
        }
        const kind = this.kindOf(this.c.checker.getTypeAtLocation(x));
        if (!kind) { this.c.error(x, `This is ${this.c.checker.typeToString(this.c.checker.getTypeAtLocation(x))}; a pattern takes numbers, booleans, texts, units and records.`); return null; }
        const v = this.newVar("(taken)", kind, this.at(x), { temp: true, ...(kind === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(x)) : {}) });
        this.emitDeclare(v, x, x);
        items.push({ kind: "var", v });
      }
      return items;
    }
    if (ts.isObjectLiteralExpression(e)) return this.declareRecord("(taken)", e, this.c.checker.getTypeAtLocation(e), at);
    if (ts.isCallExpression(e) && (this.isLibraryCall(e, "mouse") || this.isLibraryCall(e, "chatted"))) return this.declareInput("(taken)", e, at);
    const b = this.listOf(init);
    if (b) return b;
    this.c.error(init, "Only a record, an array, or what mouse() and chatted() give can be taken apart in a program.");
    return null;
  }

  /** The fields `...p` spreads: a record's, or those of an object the script has. Null with a diagnostic. */
  private spreadFields(expr: TS.Expression): Map<string, Binding> | null {
    const b = this.bindingOf(expr);
    if (b?.kind === "record") return b.fields;
    const h = b ? undefined : this.evaluate(expr);
    if (h && typeof h.value === "object" && h.value !== null) return new Map(Object.entries(h.value as Record<string, unknown>).map(([k, value]) => [k, { kind: "value", value } as Binding]));
    this.c.error(expr, "... inside { } spreads a record.");
    return null;
  }

  /** A field of a record of the program from whatever a spread gave it: always a variable of its own, since a field can be assigned. */
  private fieldCopy(b: Binding, name: string, at: TS.Node): Binding {
    if (b.kind === "record") return { kind: "record", fields: new Map([...b.fields].map(([field, inner]) => [field, this.fieldCopy(inner, `${name}.${field}`, at)])) };
    if (b.kind !== "value") return this.takenCopy(b, name, at);
    const kind: Kind = typeof b.value === "boolean" ? "boolean" : "number";
    const v = this.newVar(name, kind, this.sourceOf(at));
    const n = kind === "number" ? this.asInteger({ value: b.value }, at) : null;
    this.emit({ kind: "declare", decl: v, init: kind === "boolean" ? { kind: "const", value: b.value as boolean } : num(n ?? 0), at: this.at(at), label: this.label(at) }, at);
    return { kind: "var", v };
  }

  /** A copy of what a binding holds, under a name of its own — what a name in a pattern is, since numbers are copied; a record or a list stays itself, as an object does. */
  private takenCopy(from: Binding, name: string, at: TS.Node): Binding {
    // A row is itself, as an array is — the one it is now, whatever its index becomes.
    if (from.kind === "row") return { kind: "array", a: this.windowOf({ ...from, name }, at) };
    if (from.kind === "inner") return { kind: "array", a: this.innerOf(from.lists, from.index, at, name) };
    if (from.kind === "innerUnits") return this.unitsOf({ ...from, name }, at);
    if (from.kind === "textAt") {
      const v = this.newVar(name, "text", this.sourceOf(at), { text: "made" });
      this.emit({ kind: "declare", decl: v, init: this.textAtCells(from, at), at: this.at(at), label: this.label(at) }, at);
      return { kind: "var", v };
    }
    if (from.kind === "unitAt") {
      const v = this.newVar(name, "unit", this.sourceOf(at));
      this.emit({ kind: "declare", decl: v, init: this.unitAtPlaces(from, at), at: this.at(at), label: this.label(at) }, at);
      return { kind: "var", v };
    }
    if (from.kind !== "var" && from.kind !== "cell") return from;
    const like = from.kind === "var" ? from.v : from.a;
    const v = this.newVar(name, like.kind, this.sourceOf(at), { ...(like.bits ? { bits: like.bits } : {}), ...(like.unsigned ? { unsigned: true } : {}) });
    const init: NumExpr | BoolExpr | UnitExpr | TextExpr = from.kind === "cell" ? { kind: "element", array: from.a.id, index: from.index, at: this.at(at) } : refOf(from.v);
    this.emit({ kind: "declare", decl: v, init, at: this.at(at), label: this.label(at) }, at);
    return { kind: "var", v };
  }

  /** What a pattern's name is when what it is taken from has nothing there: its default, a value of the script or of the program. */
  private patternDefault(el: TS.BindingElement, what: string): Binding | null {
    const { ts } = this;
    const name = ts.isIdentifier(el.name) ? el.name.text : "(taken)";
    if (!el.initializer) { this.c.error(el, `${what}, and ${name} has no default: it would be undefined, which does not exist when the map is played.`); return null; }
    const h = this.evaluate(el.initializer);
    if (h) return { kind: "value", value: h.value };
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(el.initializer));
    if (!kind) { this.c.error(el.initializer, "A default is a number, a boolean or a unit."); return null; }
    const v = this.newVar(name, kind, this.sourceOf(el.name), kind === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(el.initializer)) : {});
    this.emitDeclare(v, el.initializer, el);
    return { kind: "var", v };
  }

  /**
   * `const { x, y: py, ...rest } = p`, `const [a, , b = 0, ...tail] = xs`, as deep as it is written: every name bound in
   * `scope` to a copy of what it names (a record or a list inside stays itself). A default is for what is not there — a
   * field the record has not got, a place past a fixed array's end — since nothing that is there is ever undefined.
   */
  private bindPattern(pattern: TS.BindingName, key: TS.Node, from: Binding | Binding[], scope: Scope): boolean {
    const { ts } = this;
    if (ts.isIdentifier(pattern)) {
      if (Array.isArray(from)) { this.c.error(pattern, `${pattern.text} would be an array written out where it is used; give it a declaration of its own: let ${pattern.text} = [a, b].`); return false; }
      scope.bind(key, this.takenCopy(from, pattern.text, pattern));
      return true;
    }
    let ok = true;
    if (ts.isObjectBindingPattern(pattern)) {
      const fields: Map<string, Binding> | null = !Array.isArray(from) && from.kind === "record" ? from.fields
        : !Array.isArray(from) && from.kind === "value" && typeof from.value === "object" && from.value !== null ? new Map(Object.entries(from.value as Record<string, unknown>).map(([k, value]) => [k, { kind: "value", value } as Binding]))
        : null;
      if (!fields) { this.c.error(pattern, "{ … } takes the fields of a record."); return false; }
      const taken = new Set<string>();
      for (const el of pattern.elements) {
        if (el.dotDotDotToken) {
          // The rest: a record of its own, of copies, as JavaScript makes one.
          const rest = new Map<string, Binding>();
          for (const [field, b] of fields) if (!taken.has(field)) rest.set(field, this.takenCopy(b, `${ts.isIdentifier(el.name) ? el.name.text : "rest"}.${field}`, el));
          scope.bind(el, { kind: "record", fields: rest });
          continue;
        }
        const prop = el.propertyName ?? el.name;
        const field = ts.isIdentifier(prop) || ts.isStringLiteralLike(prop) ? prop.text : ts.isComputedPropertyName(prop) ? String(this.evaluate(prop.expression)?.value ?? "") : "";
        if (!field) { this.c.error(el, "The name of a field in a pattern is written out, or known when the script is built."); ok = false; continue; }
        taken.add(field);
        const b = fields.get(field);
        const present = b && !(b.kind === "value" && b.value === undefined) ? b : this.patternDefault(el, `There is no ${field} here`);
        if (!present || !this.bindPattern(el.name, el, present, scope)) ok = false;
      }
      return ok;
    }
    // [a, b, ...tail]
    const at = (i: number): Binding | undefined => {
      if (Array.isArray(from)) return from[i];
      if (from.kind === "value") return Array.isArray(from.value) && i < from.value.length ? { kind: "value", value: (from.value as unknown[])[i] } : undefined;
      if (from.kind === "array") return from.a.dynamic || i < from.a.length ? { kind: "cell", a: from.a, index: num(i) } : undefined;
      if (from.kind === "records") return this.rowOf(from, num(i));
      if (from.kind === "grid") return from.dims[0] === 0 || i < from.dims[0] ? this.partAt(from, num(i), pattern) : undefined;
      if (from.kind === "lists") return from.ptr.dynamic || i < from.ptr.length ? { kind: "inner", lists: from, index: num(i) } : undefined;
      return undefined;
    };
    if (!Array.isArray(from) && from.kind !== "value" && from.kind !== "array" && from.kind !== "records" && from.kind !== "units" && from.kind !== "grid" && from.kind !== "lists") { this.c.error(pattern, "[ … ] takes the items of an array."); return false; }
    pattern.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      if (el.dotDotDotToken) {
        const rest = this.restOf(from, i, ts.isIdentifier(el.name) ? el.name.text : "rest", el);
        if (!rest || !this.bindPattern(el.name, el, rest, scope)) ok = false;
        return;
      }
      if (!Array.isArray(from) && from.kind === "units") {
        const v = this.newVar(ts.isIdentifier(el.name) ? el.name.text : "(taken)", "unit", this.sourceOf(el.name));
        this.emit({ kind: "declare", decl: v, init: this.unitAtIndex(from, num(i), el), at: this.at(el), label: this.label(el) }, el);
        scope.bind(el, { kind: "var", v });
        return;
      }
      const b = at(i);
      const present = b && !(b.kind === "value" && b.value === undefined) ? b : this.patternDefault(el, `There is no item ${i} here`);
      if (!present || !this.bindPattern(el.name, el, present, scope)) ok = false;
    });
    return ok;
  }

  /**
   * The left of `[a, hp[i], { x }] = …`: what each target is to be given is copied out now, and `stores` collects what
   * writes them — run by the caller after every copy is made, which is what makes `[a, b] = [b, a]` a swap.
   */
  private assignPattern(left: TS.Expression, from: Binding | Binding[], stores: (() => void)[]): boolean {
    const { ts } = this;
    const target = this.unwrap(left);
    if (ts.isArrayLiteralExpression(target)) {
      if (!Array.isArray(from) && from.kind !== "value" && from.kind !== "array" && from.kind !== "records") { this.c.error(target, "[ … ] takes the items of an array."); return false; }
      let ok = true;
      target.elements.forEach((x, i) => {
        if (ts.isOmittedExpression(x)) return;
        if (ts.isSpreadElement(x)) { this.c.error(x, "...rest makes an array, which is declared, not assigned: const [first, ...rest] = xs."); ok = false; return; }
        const item: Binding | undefined = Array.isArray(from) ? from[i]
          : from.kind === "value" ? (Array.isArray(from.value) && i < from.value.length ? { kind: "value", value: (from.value as unknown[])[i] } : undefined)
          : from.kind === "array" ? (from.a.dynamic || i < from.a.length ? { kind: "cell", a: from.a, index: num(i) } : undefined)
          : from.kind === "records" ? this.rowOf(from, num(i)) : undefined;
        if (!item) { this.c.error(x, `There is no item ${i} to give it.`); ok = false; return; }
        if (!this.assignPattern(x, item, stores)) ok = false;
      });
      return ok;
    }
    if (ts.isObjectLiteralExpression(target)) {
      const fields = !Array.isArray(from) && from.kind === "record" ? from.fields : !Array.isArray(from) && from.kind === "value" && typeof from.value === "object" && from.value !== null ? new Map(Object.entries(from.value as Record<string, unknown>).map(([k, value]) => [k, { kind: "value", value } as Binding])) : null;
      if (!fields) { this.c.error(target, "{ … } takes the fields of a record."); return false; }
      let ok = true;
      for (const p of target.properties) {
        const to = ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.initializer : null;
        const item = to && fields.get((p.name as TS.Identifier).text);
        if (!to || !item) { this.c.error(p, to ? `There is no ${(p.name as TS.Identifier).text} to give it.` : "In a pattern that is assigned, a field is written out: ({ x, y: py } = p)."); ok = false; continue; }
        if (!this.assignPattern(to, item, stores)) ok = false;
      }
      return ok;
    }
    if (Array.isArray(from) || (from.kind !== "var" && from.kind !== "cell" && from.kind !== "value")) { this.c.error(target, "A record or an array is assigned field by field, cell by cell: take it apart further."); return false; }
    // Where it goes: a variable, or a cell (`hp[i]`, `p.x`, `waves[i].count`).
    const to = this.bindingOf(target);
    const el = !to && ts.isElementAccessExpression(target) ? this.elementOf(target) : undefined;
    if (el === null) return false;
    const kind = to?.kind === "var" ? to.v.kind : to?.kind === "cell" ? to.a.kind : el ? el.a.kind : undefined;
    if (!kind) { this.c.error(target, "A pattern assigns to the program's variables, cells and fields."); return false; }
    if (kind === "text") {
      // A text is copied as any value is: taken first, stored once every other has been taken.
      const given = from.kind === "var" && from.v.kind === "text" ? refOf(from.v) as TextExpr : from.kind === "value" && typeof from.value === "string" ? this.literalText(from.value, target) : null;
      if (!given || to?.kind !== "var") { this.c.error(target, "Expected a text here."); return false; }
      // Out of an array written out it is a copy already; out of a record it is the field itself, which a store made earlier in the same pattern may change — so a copy here too.
      const held = from.kind === "var" && from.v.temp ? given : this.textTemp(given.kind === "textVar" ? this.mark<TextExpr>({ kind: "template", parts: [{ kind: "value", text: given }], at: this.at(target), label: this.label(target) }, target) : given, target);
      const at = this.at(target), label = this.label(target);
      stores.push(() => this.emit({ kind: "assignText", target: to.v.id, value: held, at, label }, target));
      return true;
    }
    const held = this.takenCopy(from, "(taken)", target);
    const value = this.valueOf(held, kind, target);
    if (!value) return false;
    const at = this.at(target);
    const label = this.label(target);
    stores.push(() => {
      if (to?.kind === "var") this.emit(kind === "number" ? { kind: "assign", target: to.v.id, value: value as NumExpr, at, label } : kind === "unit" ? { kind: "assignUnit", target: to.v.id, value: value as UnitExpr, at, label } : { kind: "assignBool", target: to.v.id, value: value as BoolExpr, at, label }, target);
      else if (to?.kind === "cell") this.emit({ kind: "store", array: to.a.id, index: to.index, value: value as NumExpr | BoolExpr, at, label }, target);
      else if (el) this.emit({ kind: "store", array: el.a.id, index: el.index, value: value as NumExpr | BoolExpr, at, label }, target);
    });
    return true;
  }

  /** `...tail`: what is left from place `start` on, in an array of its own. */
  private restOf(of: Binding | Binding[], start: number, name: string, el: TS.Node): Binding | null {
    const at = this.at(el);
    const label = this.label(el);
    if (!Array.isArray(of) && of.kind === "value") return { kind: "value", value: Array.isArray(of.value) ? (of.value as unknown[]).slice(start) : [] };
    if (!Array.isArray(of) && of.kind === "array") {
      const a = of.a;
      const left = a.length - start;
      const tail = this.newArray(name, a.kind, a.dynamic || left < 1 ? 0 : left, this.sourceOf(el), { ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) });
      if (!a.dynamic && left >= 1) {
        this.emit({ kind: "declareArray", array: tail.id, init: Array.from({ length: left }, (_, k): NumExpr => ({ kind: "element", array: a.id, index: num(start + k), at })), at, label }, el);
        return { kind: "array", a: tail };
      }
      tail.dynamic = true;
      this.emit({ kind: "declareArray", array: tail.id, init: [], at, label }, el);
      const i = this.newVar(`(index of ${a.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: i, init: num(start), at, label }, el);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "push", array: tail.id, value: { kind: "element", array: a.id, index: varRef(i), at }, at, label }], at, label }, el);
      return { kind: "array", a: tail };
    }
    this.c.error(el, "...rest takes the tail of an array of numbers or booleans.");
    return null;
  }

  /* ── Methods that take a function ── */

  /** How deep the walk is inside a function given to such a method: nothing in there may sleep. */
  private inCallback = 0;
  /** How deep the walk is inside the condition of a loop, which is worked out again every turn: an array cannot be made there. */
  private inLoopCondition = 0;

  /** The array whose length is the list's. */
  private lengthArray(list: List): ArrayDecl {
    return list.kind === "array" ? list.a : list.kind === "units" ? list.ptr : [...list.fields.values()][0];
  }

  /** Every array of a list: one, an array a field, or a unit's three. */
  private arraysOf(list: List): ArrayDecl[] {
    return list.kind === "array" ? [list.a] : list.kind === "units" ? [list.ptr, list.epd, list.uid] : [...list.fields.values()];
  }

  /** A list, or what makes one: `xs`, `xs.filter(…)`, `xs.map(…).sort(…)`. Making one emits the statements that fill it, so ask once. */
  private listOf(expr: TS.Expression): Binding | undefined {
    const { ts } = this;
    const b = this.arrayOf(expr);
    if (b) return b;
    const e = this.unwrap(expr);
    if (ts.isCallExpression(e) && this.makesList(e)) {
      // Refused, and said so: an array of nothing stands in, so the one mistake is the one message.
      return this.madeList(e, undefined, e) ?? { kind: "array", a: this.newArray("(not made)", "number", 1, this.sourceOf(e)) };
    }
    if (ts.isCallExpression(e) && this.copiesList(e)) return this.copiedList(e, undefined, e) ?? { kind: "array", a: this.newArray("(not made)", "number", 1, this.sourceOf(e)) };
    return undefined;
  }

  /** The methods that give a copy: a new array with what another holds, or a Map's keys or values as one. */
  private static readonly COPIERS = new Set(["slice", "concat", "toSorted", "toReversed", "keys", "values"]);

  /** Whether a call gives a copy of a list of the program: `xs.slice(1)`, `xs.concat(ys)`, `xs.toSorted(f)`, `xs.toReversed()`, `m.keys()`, `m.values()`, `Array.from(…)` of any of those. */
  private copiesList(e: TS.CallExpression): boolean {
    const { ts } = this;
    if (this.body.plan.index.has(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
    const method = e.expression.name.text;
    const receiver = this.unwrap(e.expression.expression);
    if (method === "from" && ts.isIdentifier(receiver) && receiver.text === "Array" && e.arguments.length === 1) { const b = this.peek(e.arguments[0]); return !!b; }
    if (!Structured.COPIERS.has(method)) return false;
    const b = this.peek(receiver);
    if (method === "keys" || method === "values") return b === "hash";
    return b === "array" || b === "units";
  }

  /** What kind of list an expression is, without making anything: for deciding what a call is before it is compiled. */
  private peek(expr: TS.Expression): Binding["kind"] | undefined {
    const { ts } = this;
    const e = this.unwrap(expr);
    const b = this.bindingOf(e);
    if (b && b.kind !== "value") return b.kind === "inner" || b.kind === "row" ? "array" : b.kind === "innerUnits" ? "units" : b.kind;
    // A list the script has is an array a program may copy.
    let h: Hoisted | undefined;
    try { h = this.evaluate(e); } catch { return undefined; }
    if (h) return this.isPlainList(h.value) ? "array" : undefined;
    if (!ts.isCallExpression(e)) return undefined;
    if (this.copiesList(e)) return ts.isPropertyAccessExpression(e.expression) && this.peek(e.expression.expression) === "units" ? "units" : "array";
    if (this.makesList(e)) return "array";
    return undefined;
  }

  private isPlainList(v: unknown): v is (number | boolean)[] {
    return Array.isArray(v) && v.length > 0 && v.length <= MAX_ARRAY && (v.every((x) => typeof x === "number" && Number.isInteger(x)) || v.every((x) => typeof x === "boolean"));
  }

  /** A list the script has, as the array nothing writes that a program reads it through: once a list. */
  private scriptList(expr: TS.Expression): Extract<Binding, { kind: "array" }> | undefined {
    const list = this.evaluate(expr)?.value;
    if (!this.isPlainList(list)) return undefined;
    let a = this.tables.get(list);
    if (!a) {
      const booleans = typeof list[0] === "boolean";
      const values = list.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
      a = this.newArray(expr.getText(this.body.sf).replace(/\s+/g, " "), booleans ? "boolean" : "number", values.length, this.at(expr), { shared: true, values, ...(values.some((v) => v > I32_MAX) ? { unsigned: true } : {}) });
      this.tables.set(list, a);
    }
    return { kind: "array", a };
  }

  /** The keys or the values of a Map or a Set over any number, as an array of their own: in the order they went in. */
  private hashList(h: Hash, what: "keys" | "values", name: string | undefined, where: TS.Node): Binding {
    const from = what === "values" && h.values ? h.values : h.keys;
    const a = this.newArray(name ?? `(${h.name}.${what})`, from.kind, 0, this.sourceOf(where), { ...(from.bits ? { bits: from.bits } : {}), ...(from.unsigned ? { unsigned: true } : {}) });
    a.dynamic = true;
    this.emit({ kind: "declareArray", array: a.id, init: [], at: this.at(where), label: this.label(where) }, where);
    this.hashLoop(h, where, (key, value) => { const v = what === "values" && value ? value : key; this.emit({ kind: "push", array: a.id, value: v.kind === "number" ? varRef(v) : boolRef(v), at: this.at(where), label: this.label(where) }, where); });
    return { kind: "array", a };
  }

  /** A new list that grows, of the kind `like` is, with nothing in it. */
  private emptyLike(like: Extract<Binding, { kind: "array" | "units" }>, name: string, where: TS.Node): Extract<Binding, { kind: "array" | "units" }> {
    const grow = (n: string, of: ArrayDecl) => { const a = this.newArray(n, of.kind, 0, this.sourceOf(where), { ...(of.bits ? { bits: of.bits } : {}), ...(of.unsigned ? { unsigned: true } : {}) }); a.dynamic = true; this.emit({ kind: "declareArray", array: a.id, init: [], at: this.at(where), label: this.label(where) }, where); return a; };
    return like.kind === "array" ? { kind: "array", a: grow(name, like.a) } : { kind: "units", name, ptr: grow(`${name} (ptr)`, like.ptr), epd: grow(`${name} (epd)`, like.epd), uid: grow(`${name} (uid)`, like.uid) };
  }

  /** The cells of `from` — all of them, or those from `start` up to `end` — pushed to `into`, every array of the list together. */
  private appendList(into: Extract<Binding, { kind: "array" | "units" }>, from: Extract<Binding, { kind: "array" | "units" }>, where: TS.Node, start?: NumExpr, end?: NumExpr) {
    const at = this.at(where);
    const label = this.label(where);
    const pairs = into.kind === "array" && from.kind === "array" ? [[into.a, from.a]] : into.kind === "units" && from.kind === "units" ? [[into.ptr, from.ptr], [into.epd, from.epd], [into.uid, from.uid]] : [];
    const i = this.newVar("(index)", "number", at, { temp: true });
    const stop = end ?? ({ kind: "length", array: pairs[0][1].id, at } as NumExpr);
    this.emit({ kind: "declare", decl: i, init: start ?? num(0), at, label }, where);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: stop, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }],
      body: pairs.map(([to, of]): Stmt => ({ kind: "push", array: to.id, value: { kind: "element", array: of.id, index: varRef(i), at }, at, label })), at, label }, where);
  }

  /** A place a `slice` is given, as JavaScript reads it: below zero it counts from the end, and it stays inside 0 … length. */
  private sliceEnd(given: TS.Expression, length: NumExpr, where: TS.Node): NumExpr | null {
    const n = this.num(given);
    if (!n) return null;
    const at = this.at(where);
    const label = this.label(where);
    if (n.kind === "const" && n.value >= 0) return this.temp({ kind: "intrinsic", name: "min", args: [n, length], at, label }, where, true);
    const v = this.temp(n, where, true);
    const fromEnd: NumExpr = { kind: "intrinsic", name: "max", args: [{ kind: "binary", op: "+", left: length, right: v, at, label }, num(0)], at, label };
    return this.temp({ kind: "ternary", cond: { kind: "compare", op: "<", left: v, right: num(0), at, label }, whenTrue: fromEnd, whenFalse: { kind: "intrinsic", name: "min", args: [v, length], at, label }, at, label }, where, true);
  }

  /** The copy such a call gives, under `name` or a temporary's. Null with a diagnostic. */
  private copiedList(e: TS.CallExpression, name: string | undefined, where: TS.Node): Binding | null {
    const { ts } = this;
    if (!ts.isPropertyAccessExpression(e.expression)) return null;
    if (this.inLoopCondition > 0) { this.c.error(e, "This makes an array, and a loop's condition is worked out again every turn: make it before the loop, or inside it."); return null; }
    const method = e.expression.name.text;
    const source = method === "from" ? e.arguments[0] : e.expression.expression;
    const held = this.bindingOf(source);
    if (held?.kind === "hash") return this.hashList(held, method === "values" ? "values" : "keys", name, where);
    // `Array.from(m.keys())`, `Array.from(xs.slice(1))`: what is inside makes the array already, under the name.
    const inner = this.unwrap(source);
    if (method === "from" && ts.isCallExpression(inner) && (this.copiesList(inner) || this.makesList(inner))) return this.copiesList(inner) ? this.copiedList(inner, name, where) : this.madeList(inner, name, where);
    const from = this.listOf(source) ?? this.scriptList(source);
    if (from?.kind !== "array" && from?.kind !== "units") { this.c.error(source, `${method}() copies an array of numbers, of booleans or of units here; for rows, filter(() => true) gives each its own.`); return null; }
    const given = name ?? `(${from.kind === "array" ? from.a.name : from.name}.${method})`;
    const length: NumExpr = { kind: "length", array: (from.kind === "array" ? from.a : from.ptr).id, at: this.at(e) };
    switch (method) {
      case "slice": {
        if (e.arguments.length > 2) { this.c.error(e, "slice() takes where to start and where to stop."); return null; }
        const start = e.arguments[0] ? this.sliceEnd(e.arguments[0], length, e) : num(0);
        const end = e.arguments[1] ? this.sliceEnd(e.arguments[1], length, e) : undefined;
        if (!start || end === null) return null;
        const made = this.emptyLike(from, given, where);
        this.appendList(made, from, e, start, end);
        return made;
      }
      case "concat": {
        const made = this.emptyLike(from, given, where);
        this.appendList(made, from, e);
        for (const arg of e.arguments) {
          const more = this.listOf(arg) ?? this.scriptList(arg);
          if (more?.kind === from.kind && (more.kind === "array" || more.kind === "units")) { this.appendList(made, more, arg); continue; }
          const written = this.unwrap(arg);
          if (made.kind === "array" && ts.isArrayLiteralExpression(written) && !written.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) {
            // `[n, 8]` written there: its items, worked out where they stand.
            for (const x of written.elements) { const v = made.a.kind === "number" ? this.num(x) : this.boolValue(x); if (!v) return null; this.emit({ kind: "push", array: made.a.id, value: v, at: this.at(x), label: this.label(x) }, x); }
            continue;
          }
          if (made.kind === "units") { const found = this.unitExpr(arg); if (!found) return null; const unit = this.unitTemp(found, arg); for (const [a, part] of this.unitArrays(made)) this.emit({ kind: "push", array: a.id, value: { kind: "unitPart", unit, part, at: this.at(arg) }, at: this.at(arg), label: this.label(arg) }, arg); continue; }
          const value = made.a.kind === "number" ? this.num(arg) : this.boolValue(arg);
          if (!value) return null;
          this.emit({ kind: "push", array: made.a.id, value, at: this.at(arg), label: this.label(arg) }, arg);
        }
        return made;
      }
      case "from": case "toReversed": case "toSorted": {
        const made = this.emptyLike(from, given, where);
        this.appendList(made, from, e);
        if (method === "toReversed" && !this.reverseList(e, made)) return null;
        if (method === "toSorted" && !this.sortList(e, made)) return null;
        return made;
      }
      default:
        return null;
    }
  }

  /** What a method that takes a function runs over: a list of the program, the units of the game, or a list the script has. */
  private overOf(expr: TS.Expression): Over | undefined {
    const b = this.listOf(expr);
    if (b?.kind === "array" || b?.kind === "records" || b?.kind === "units" || b?.kind === "grid" || b?.kind === "lists") return b;
    if (b) return undefined;
    const h = this.evaluate(expr);
    if (!h) return undefined;
    if (isUnitQuery(h.value)) return { kind: "query", name: `${h.value.ident}(…)`, filter: { ...h.value.filter } };
    if (Array.isArray(h.value)) return { kind: "values", name: expr.getText(this.body.sf).replace(/\s+/g, " ").slice(0, 40), items: h.value as unknown[] };
    return undefined;
  }

  private overName(over: Over): string {
    return over.kind === "array" ? over.a.name : over.name;
  }

  /** Whether a call is of a method that gives a list — `map`, `filter`, or `sort` / `reverse`, which give their own — on something such a method runs over. */
  private makesList(e: TS.CallExpression): boolean {
    const { ts } = this;
    if (!ts.isPropertyAccessExpression(e.expression) || !LIST_MAKERS.has(e.expression.name.text) || this.body.plan.index.has(e)) return false;
    const receiver = this.unwrap(e.expression.expression);
    if (this.bindingOf(receiver)) { const b = this.bindingOf(receiver)!; return b.kind === "array" || b.kind === "records" || b.kind === "units" || b.kind === "grid" || b.kind === "row" || b.kind === "lists" || b.kind === "inner"; }
    if (ts.isCallExpression(receiver) && (this.makesList(receiver) || this.copiesList(receiver))) return true;
    const h = this.evaluate(receiver);
    return !!h && (isUnitQuery(h.value) || Array.isArray(h.value));
  }

  /** The function a method is given: written there, or the name of one declared in the body. */
  private functionOf(arg: TS.Expression | undefined, method: string, e: TS.Node): { parameters: readonly TS.ParameterDeclaration[]; body: TS.Block | TS.Expression; closure: Scope | null; name?: string } | null {
    const { ts } = this;
    if (!arg) { this.c.error(e, `${method}() takes a function: xs.${method}((x) => …).`); return null; }
    const fn = this.unwrap(arg);
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      if (fn.asteriskToken || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) { this.c.error(fn, "Generators and async functions are not supported in a program."); return null; }
      return { parameters: fn.parameters, body: fn.body, closure: this.scope };
    }
    if (ts.isIdentifier(fn)) {
      const decl = this.gameDeclaration(fn);
      if (decl && ts.isFunctionDeclaration(decl) && decl.body) return { parameters: decl.parameters, body: decl.body, closure: this.body === this.c.body ? this.topScope : null, name: decl.name?.text };
    }
    this.c.error(arg, `A function is not a value when the map is played: write it where it is used — xs.${method}((x) => …) — or name one declared with function in the program.`);
    return null;
  }

  /**
   * The function given to a method, inlined with its parameters bound to what the method hands it — the item of the turn,
   * its place, the list. A variable it uses from outside is the program's own cell, so nothing is captured and nothing
   * is made when the map is played. `kind` is what it has to give back; "any" takes what it says it returns.
   */
  private callback(arg: TS.Expression | undefined, method: string, bound: Binding[], kind: Kind | "void" | "any", e: TS.CallExpression): Call | undefined {
    const { ts } = this;
    const fn = this.functionOf(arg, method, e);
    if (!fn) return undefined;
    if (kind === "any") {
      const signature = this.c.checker.getSignaturesOfType(this.c.checker.getTypeAtLocation(arg!), ts.SignatureKind.Call)[0];
      kind = (signature && this.kindOf(this.c.checker.getReturnTypeOfSignature(signature))) ?? "void";
    }
    const at = this.at(arg!);
    const label = this.label(e);
    const out: Call = { name: fn.name ?? `${method}'s function`, at, label, params: [], body: [] };
    if (kind !== "void") out.result = { decl: this.newVar(`(${method}'s function result)`, kind, at, { temp: true }), kind };
    this.mark(out, arg!);
    const scope = new Scope(fn.closure);
    let ok = true;
    // `waves.forEach(({ count, delay }) => …)`: taken apart when the function starts, inside its body, where a turn's copies belong.
    const patterns: (() => void)[] = [];
    fn.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) { this.c.error(p, "A function given to an array method is handed the item, its place and the array; there is no rest of them."); ok = false; return; }
      if (!ts.isIdentifier(p.name)) {
        const from = bound[i];
        if (!from) { this.c.error(p, `${method}() hands its function ${bound.length} value${bound.length === 1 ? "" : "s"}; there is nothing here to take apart.`); ok = false; return; }
        const pattern = p.name;
        patterns.push(() => { this.bindPattern(pattern, p, from, scope); });
        return;
      }
      const b = bound[i];
      if (!b) {
        const h = p.initializer ? this.evaluate(p.initializer) : undefined;
        if (h) { scope.bind(p, { kind: "value", value: h.value }); return; }
        this.c.error(p, `${method}() hands its function ${bound.length} value${bound.length === 1 ? "" : "s"}; ${p.name.text} would be undefined.`);
        ok = false;
        return;
      }
      // By value, as TypeScript has it: a parameter the function assigns is a variable of its own that starts from what it was handed.
      if (b.kind === "var" && this.assigns(fn.body, p)) {
        const copy = this.newVar(p.name.text, b.v.kind, this.sourceOf(p.name), { ...(b.v.bits ? { bits: b.v.bits } : {}), ...(b.v.unsigned ? { unsigned: true } : {}) });
        out.params.push({ decl: copy, init: refOf(b.v), label });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      if (b.kind === "value" && this.assigns(fn.body, p)) { this.c.error(p, `${p.name.text} is a value the script has here, not a variable: keep it in a let of the function's own to change it.`); ok = false; return; }
      scope.bind(p, b);
    });
    if (!ok) return undefined;
    this.inCallback++;
    try { out.body = this.walkFunction(fn.body, kind, this.body, scope, () => patterns.forEach((take) => take())); } finally { this.inCallback--; }
    return out;
  }

  /** The function's answer as a condition: what it returns, a number being true when it is not 0. */
  private predicate(arg: TS.Expression | undefined, method: string, bound: Binding[], e: TS.CallExpression): BoolExpr | null {
    const call = this.callback(arg, method, bound, "any", e);
    if (!call) return null;
    if (call.result?.kind === "boolean") return this.mark<BoolExpr>({ kind: "call", call }, e);
    if (call.result?.kind === "number") return this.mark<BoolExpr>({ kind: "test", expr: this.mark<NumExpr>({ kind: "call", call }, e), at: this.at(e), label: this.label(e) }, e);
    this.c.error(arg ?? e, `${method}()'s function answers true or false.`);
    return null;
  }

  /** `xs.find(…) ?? 0`: what was found, or the value to the right when nothing was. Undefined when the expression is not that. */
  private findOr(e: TS.BinaryExpression, as: "number" | "boolean"): NumExpr | BoolExpr | null | undefined {
    const { ts } = this;
    const left = this.unwrap(e.left);
    if (!ts.isCallExpression(left) || !ts.isPropertyAccessExpression(left.expression) || (left.expression.name.text !== "find" && left.expression.name.text !== "findLast")) return undefined;
    const over = this.overOf(left.expression.expression);
    return over ? (this.searchCall(left, over, left.expression.name.text, as, e.right) as NumExpr | BoolExpr | null) : undefined;
  }

  /** A number where it is kept, read. */
  private placeRead(p: Place, at: TS.Node): NumExpr {
    return "v" in p ? varRef(p.v) : { kind: "element", array: p.a.id, index: p.index, at: this.at(at) };
  }

  /** A unit kept as three numbers, as the unit it is. */
  private unitAtPlaces(b: Extract<Binding, { kind: "unitAt" }>, at: TS.Node): UnitExpr {
    return this.mark<UnitExpr>({ kind: "unitAt", ptr: this.placeRead(b.ptr, at), epd: this.placeRead(b.epd, at), uid: this.placeRead(b.uid, at), at: this.at(at) }, at);
  }

  /** `squads[i].leader = u`: the unit's three numbers, each stored where it is kept. */
  private storeUnitAt(b: Extract<Binding, { kind: "unitAt" }>, value: UnitExpr, e: TS.Node) {
    const unit = this.unitTemp(value, e);
    const at = this.at(e);
    const label = this.label(e);
    for (const part of UNIT_PARTS) {
      const p = b[part];
      const v: NumExpr = { kind: "unitPart", unit, part, at };
      if ("v" in p) this.emit({ kind: "assign", target: p.v.id, value: v, at, label }, e);
      else this.emit({ kind: "store", array: p.a.id, index: p.index, value: v, at, label }, e);
    }
  }

  /** What a binding is as a value of `kind`, where a method stores or returns the item or its place. */
  private valueOf(b: Binding, kind: Kind, at: TS.Node): NumExpr | BoolExpr | UnitExpr | null {
    if (b.kind === "var" && b.v.kind === kind) return kind === "number" ? varRef(b.v) : kind === "unit" ? unitRef(b.v) : boolRef(b.v);
    if (b.kind === "cell" && b.a.kind === kind) return { kind: "element", array: b.a.id, index: b.index, at: this.at(at) };
    if (b.kind === "unitAt" && kind === "unit") return this.unitAtPlaces(b, at);
    if (b.kind === "value") {
      if (kind === "boolean" && typeof b.value === "boolean") return { kind: "const", value: b.value };
      if (kind === "number") { const n = this.asInteger({ value: b.value }, at); return n === null ? null : num(n); }
    }
    this.c.error(at, `Expected a ${kind} here.`);
    return null;
  }

  /**
   * The loop a method is: `turn` is called with the item and its place where the loop's body goes. A list of the
   * program is a loop the game runs, the item what `for…of` would have; the units of the game are the loop over units,
   * which come in no order and so have no place; a list the script has is unrolled, `turn` called once an item.
   */
  private loopOver(over: Over, e: TS.CallExpression, turn: (item: Binding, index: Binding | undefined) => void, reverse = false) {
    const { ts } = this;
    const given = e.arguments[0] && this.unwrap(e.arguments[0]);
    const first = given && (ts.isArrowFunction(given) || ts.isFunctionExpression(given)) ? given.parameters[0] : undefined;
    this.loopOf(over, e, first && ts.isIdentifier(first.name) ? first.name.text : `(item of ${this.overName(over)})`, turn, reverse);
  }

  /** The loop itself, for whatever statement wants one: a method's call, or a `for…of` whose variable is a pattern. */
  private loopOf(over: Over, e: TS.Node, itemName: string, turn: (item: Binding, index: Binding | undefined) => void, reverse = false) {
    const at = this.at(e);
    const label = this.label(e);
    if (over.kind === "values") {
      const items = over.items.map((value, i) => [value, i] as const);
      for (const [value, i] of reverse ? items.reverse() : items) turn({ kind: "value", value }, { kind: "value", value: i });
      return;
    }
    if (over.kind === "query") {
      const v = this.newVar(itemName, "unit", at, { temp: true });
      const body = this.collect(() => turn({ kind: "var", v }, undefined));
      this.emit({ kind: "unitLoop", decl: v, filter: { ...over.filter }, body, at, label }, e);
      return;
    }
    if (over.kind === "lists") {
      // The rows of an array of arrays that grow, each reached through its handle. As many as there are when the loop starts.
      const y = this.newVar(`(row of ${over.name})`, "number", at, { temp: true });
      const rows = this.temp({ kind: "length", array: over.ptr.id, at }, e, true);
      const body = this.collect(() => turn({ kind: "array", a: this.innerOf(over, varRef(y), e) }, { kind: "var", v: y }));
      const by = (op: "+" | "-"): Stmt => ({ kind: "assign", target: y.id, value: { kind: "binary", op, left: varRef(y), right: num(1), at, label }, at, label });
      this.emit({ kind: "declare", decl: y, init: reverse ? { kind: "binary", op: "-", left: rows, right: num(1), at, label } : num(0), at, label }, e);
      this.emit({ kind: "for", cond: reverse ? { kind: "compare", op: ">=", left: varRef(y), right: num(0), at, label } : { kind: "compare", op: "<", left: varRef(y), right: rows, at, label }, update: [by(reverse ? "-" : "+")], body, at, label }, e);
      return;
    }
    if (over.kind === "grid") {
      // The rows of an array of arrays, each a window on the flat array (or, of a deeper one, the grid inside).
      const y = this.newVar(`(row of ${over.name})`, "number", at, { temp: true });
      const rows = this.temp(this.rowsOf(over, e), e);
      const body = this.collect(() => { const part = this.partAt(over, varRef(y), e); turn(part.kind === "row" ? { kind: "array", a: this.windowOf(part, e) } : part, { kind: "var", v: y }); });
      const by = (op: "+" | "-"): Stmt => ({ kind: "assign", target: y.id, value: { kind: "binary", op, left: varRef(y), right: num(1), at, label }, at, label });
      this.emit({ kind: "declare", decl: y, init: reverse ? { kind: "binary", op: "-", left: rows, right: num(1), at, label } : num(0), at, label }, e);
      this.emit({ kind: "for", cond: reverse ? { kind: "compare", op: ">=", left: varRef(y), right: num(0), at, label } : { kind: "compare", op: "<", left: varRef(y), right: rows, at, label }, update: [by(reverse ? "-" : "+")], body, at, label }, e);
      return;
    }
    const i = this.newVar(`(index of ${this.overName(over)})`, "number", at, { temp: true });
    const length: NumExpr = { kind: "length", array: this.lengthArray(over).id, at };
    const body = this.collect(() => {
      let item: Binding;
      if (over.kind === "records") item = this.rowOf(over, varRef(i));
      else {
        const v = over.kind === "units" ? this.newVar(itemName, "unit", at, { temp: true }) : this.newVar(itemName, over.a.kind, at, { temp: true, ...(over.a.bits ? { bits: over.a.bits } : {}), ...(over.a.unsigned ? { unsigned: true } : {}) });
        this.emit({ kind: "declare", decl: v, init: over.kind === "units" ? this.unitAtIndex(over, varRef(i), e) : { kind: "element", array: over.a.id, index: varRef(i), at }, at, label }, e);
        item = { kind: "var", v };
      }
      turn(item, { kind: "var", v: i });
    });
    const step = (by: "+" | "-"): Stmt => ({ kind: "assign", target: i.id, value: { kind: "binary", op: by, left: varRef(i), right: num(1), at, label }, at, label });
    if (reverse) {
      this.emit({ kind: "declare", decl: i, init: { kind: "binary", op: "-", left: length, right: num(1), at, label }, at, label }, e);
      this.emit({ kind: "for", cond: { kind: "compare", op: ">=", left: varRef(i), right: num(0), at, label }, update: [step("-")], body, at, label }, e);
      return;
    }
    // JavaScript takes the length once, before the first turn: what the function pushes is not visited.
    let end: NumExpr = length;
    if (this.arraysOf(over).some((a) => a.dynamic)) {
      const n = this.newVar(`(length of ${this.overName(over)})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: n, init: length, at, label }, e);
      end = varRef(n);
    }
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: end, at, label }, update: [step("+")], body, at, label }, e);
  }

  /** What `turn` is handed, as the arguments of the function: the item, its place where there is one, the list where it is the program's. */
  private handed(over: Over, item: Binding, index: Binding | undefined): Binding[] {
    return [item, ...(index ? [index, ...(over.kind === "values" || over.kind === "query" ? [] : [over as Binding])] : [])];
  }

  /**
   * A method that takes a function and gives a value — `some`, `every`, `findIndex`, `find`, `reduce` — as a function of
   * the compiler's own, as `includes` is: the loop inside it, `return` leaving it. Everything is inside the call, so it
   * is worked out again wherever the expression is, a loop's condition included. `otherwise` is what `find` gives when
   * nothing is found (`xs.find(…) ?? 0`).
   */
  private searchCall(e: TS.CallExpression, over: Over, method: string, as: Kind, otherwise?: TS.Expression): NumExpr | BoolExpr | UnitExpr | null {
    const at = this.at(e);
    const label = this.label(e);
    const name = `${this.overName(over)}.${method}`;
    const wrong = (what: string) => { this.c.error(e, what); return null; };
    const fn = e.arguments[0];
    let ok = true;
    const ret = (value: NumExpr | BoolExpr | UnitExpr | null): Stmt[] => { if (!value) { ok = false; return []; } return [{ kind: "return", value, at, label } as Stmt]; };
    let kind: Kind;
    let body: Stmt[];
    switch (method) {
      case "some": case "every": {
        if (as !== "boolean") return wrong(`${name}(…) is true or false.`);
        kind = "boolean";
        const some = method === "some";
        body = this.collect(() => {
          this.loopOver(over, e, (item, index) => {
            const p = this.predicate(fn, method, this.handed(over, item, index), e);
            if (!p) { ok = false; return; }
            this.emit({ kind: "if", cond: some ? p : { kind: "not", expr: p }, then: ret(some ? TRUE : FALSE), at, label }, e);
          });
          this.out.push(...ret(some ? FALSE : TRUE));
        });
        break;
      }
      case "findIndex": case "findLastIndex": {
        if (as !== "number") return wrong(`${name}(…) is a number: the place of what was found, or -1.`);
        if (over.kind === "query") return wrong("The units of the game come in no order, so none has a place; find() gives the unit.");
        kind = "number";
        body = this.collect(() => {
          this.loopOver(over, e, (item, index) => {
            const p = this.predicate(fn, method, this.handed(over, item, index), e);
            if (!p) { ok = false; return; }
            this.emit({ kind: "if", cond: p, then: ret(this.valueOf(index!, "number", e)), at, label }, e);
          }, method === "findLastIndex");
          this.out.push(...ret(num(-1)));
        });
        break;
      }
      case "find": case "findLast": {
        if (over.kind === "grid" || over.kind === "lists") return wrong(`${name}(…) would be a row or undefined, and there is no undefined when the map is played: take its place with ${method === "find" ? "findIndex" : "findLastIndex"}(…), which is -1 when nothing is found, and read ${over.name}[i].`);
        if (over.kind === "records") return wrong(`${name}(…) would be a record or undefined, and there is no undefined when the map is played: take its place with ${method === "find" ? "findIndex" : "findLastIndex"}(…), which is -1 when nothing is found, and read ${this.overName(over)}[i].`);
        if (over.kind === "query" && method === "findLast") return wrong("The units of the game come in no order: find() gives one that matches.");
        const holds: Kind = over.kind === "units" || over.kind === "query" ? "unit" : over.kind === "array" ? over.a.kind : as;
        if (as !== holds) return wrong(`${name}(…) gives what ${this.overName(over)} holds: a ${holds}.`);
        // A unit that was not found is no unit, as first() gives; a number has nothing of the kind.
        let none: NumExpr | BoolExpr | UnitExpr | null = holds === "unit" ? NO_UNIT : null;
        if (holds !== "unit") {
          if (!otherwise) return wrong(`${name}(…) is undefined when nothing is found, and there is no undefined when the map is played: say what it is then — ${name}(…) ?? 0 — or take the place with ${method === "find" ? "findIndex" : "findLastIndex"}(…), which is -1.`);
          none = holds === "number" ? this.num(otherwise) : this.boolValue(otherwise);
          if (!none) return null;
        }
        kind = holds;
        body = this.collect(() => {
          this.loopOver(over, e, (item, index) => {
            const p = this.predicate(fn, method, this.handed(over, item, index), e);
            if (!p) { ok = false; return; }
            this.emit({ kind: "if", cond: p, then: ret(this.valueOf(item, holds, e)), at, label }, e);
          }, method === "findLast");
          this.out.push(...ret(none));
        });
        break;
      }
      case "reduce": {
        if (as === "unit") return wrong(`${name}(…) adds up to a number or a boolean.`);
        if (e.arguments.length < 2) return wrong(`${name}() wants what it starts from — ${this.overName(over)}.reduce((sum, x) => sum + x, 0): without it JavaScript throws on an empty array.`);
        kind = as;
        const start = as === "number" ? this.num(e.arguments[1]) : this.boolValue(e.arguments[1]);
        if (!start) return null;
        const acc = this.newVar(`(${name} so far)`, as, at, { temp: true, ...(as === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(e)) : {}) });
        body = this.collect(() => {
          this.emit({ kind: "declare", decl: acc, init: start, at, label }, e);
          this.loopOver(over, e, (item, index) => {
            const call = this.callback(fn, method, [{ kind: "var", v: acc }, ...this.handed(over, item, index)], as, e);
            if (!call) { ok = false; return; }
            if (as === "number") this.emit({ kind: "assign", target: acc.id, value: this.mark<NumExpr>({ kind: "call", call }, e), at, label }, e);
            else this.emit({ kind: "assignBool", target: acc.id, value: this.mark<BoolExpr>({ kind: "call", call }, e), at, label }, e);
          });
          this.out.push(...ret(as === "number" ? varRef(acc) : boolRef(acc)));
        });
        break;
      }
      default:
        return wrong(`${method}() is not a method of ${this.overName(over)} that gives a value.`);
    }
    if (!ok) return null;
    const result = this.newVar(`(${name} result)`, kind, at, { temp: true, ...(kind === "number" && over.kind === "array" && method !== "reduce" && !method.endsWith("Index") ? { ...(over.a.bits ? { bits: over.a.bits } : {}), ...(over.a.unsigned ? { unsigned: true } : {}) } : {}) });
    const call: Call = { name, at, label, params: [], result: { decl: result, kind }, body };
    return this.mark<NumExpr | BoolExpr | UnitExpr>({ kind: "call", call }, e);
  }

  /** `xs.forEach((x) => …)`: the loop, the function its body. */
  private forEachCall(e: TS.CallExpression, over: Over) {
    if (e.arguments.length > 1) { this.c.error(e.arguments[1], "forEach() takes the function alone; there is no this in a program."); return; }
    this.loopOver(over, e, (item, index) => {
      const call = this.callback(e.arguments[0], "forEach", this.handed(over, item, index), "void", e);
      if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e);
    });
  }

  /**
   * `xs.map(…)`, `xs.filter(…)`: a new list, named by the declaration it is for or a temporary's. `map` has the length of
   * what it runs over — fixed when that is, else one that grows; `filter` always grows. `sort` and `reverse` give the list
   * they were called on, changed in place, as they do in JavaScript. Null with a diagnostic.
   */
  private madeList(e: TS.CallExpression, name: string | undefined, where: TS.Node): Binding | null {
    const { ts } = this;
    if (!ts.isPropertyAccessExpression(e.expression)) return null;
    const method = e.expression.name.text;
    const at = this.at(e);
    const label = this.label(e);
    const over = this.overOf(e.expression.expression);
    if (!over) { this.notConstant(e.expression.expression, `What ${method}() runs over`); return null; }
    if (method === "sort" || method === "reverse") {
      if (over.kind === "grid" || over.kind === "lists") return (method === "sort" ? this.sortList(e, over) : this.reverseList(e, over)) ? over : null;
      if (over.kind === "values" || over.kind === "query") { this.c.error(e, over.kind === "query" ? "The units of the game come in no order; keep them in an array first: unitsOf(…).filter(() => true)." : `${over.name} is a list the script has; ${method}() changes a list in place, which takes an array of the program.`); return null; }
      if (this.arraysOf(over).some((a) => a.values)) { this.c.error(e, `${this.overName(over)} was computed when the script was built and is only read in a program.`); return null; }
      return (method === "sort" ? this.sortList(e, over) : this.reverseList(e, over)) ? over : null;
    }
    if (this.inLoopCondition > 0) { this.c.error(e, `${method}() makes an array, and a loop's condition is worked out again every turn: make it before the loop, or inside it.`); return null; }
    if (e.arguments.length > 1) { this.c.error(e.arguments[1], `${method}() takes the function alone; there is no this in a program.`); return null; }
    const given = name ?? `(${this.overName(over)}.${method})`;
    const source = this.sourceOf(where);
    let ok = true;
    if (method === "map") {
      const signature = e.arguments[0] ? this.c.checker.getSignaturesOfType(this.c.checker.getTypeAtLocation(e.arguments[0]), ts.SignatureKind.Call)[0] : undefined;
      const returns = signature ? this.c.checker.getReturnTypeOfSignature(signature) : undefined;
      const kind = returns ? this.kindOf(returns) : null;
      if (kind !== "number" && kind !== "boolean") { this.c.error(e, `map() makes an array of numbers or of booleans here${returns ? `; this one would hold ${this.c.checker.typeToString(returns)}` : ""}. For units or records, push to an array in a for…of.`); return null; }
      const fixed = over.kind === "values" ? over.items.length : over.kind === "grid" ? over.dims[0] || null : over.kind === "lists" ? (over.ptr.dynamic ? null : over.ptr.length) : over.kind === "query" || this.arraysOf(over).some((a) => a.dynamic) ? null : this.lengthArray(over).length;
      if (fixed !== null && (fixed < 1 || fixed > MAX_ARRAY)) { this.c.error(e, `An array of a program has 1 to ${MAX_ARRAY} cells (this would have ${fixed}).`); return null; }
      const a = this.newArray(given, kind, fixed ?? 0, source, kind === "number" && returns ? this.widthOf(returns) : {});
      if (fixed === null) a.dynamic = true;
      this.emit({ kind: "declareArray", array: a.id, ...(fixed === null ? { init: [] } : { fill: kind === "number" ? num(0) : FALSE }), at, label }, e);
      this.loopOver(over, e, (item, index) => {
        const call = this.callback(e.arguments[0], "map", this.handed(over, item, index), kind, e);
        if (!call) { ok = false; return; }
        const value = this.mark<NumExpr | BoolExpr>({ kind: "call", call }, e);
        if (fixed === null) this.emit({ kind: "push", array: a.id, value, at, label }, e);
        else this.emit({ kind: "store", array: a.id, index: this.valueOf(index!, "number", e) as NumExpr, value, at, label }, e);
      });
      return ok ? { kind: "array", a } : null;
    }
    // filter: what it runs over, fewer of them.
    const grow = (n: string, from: { kind: "number" | "boolean"; bits?: 8 | 16; unsigned?: boolean }) => {
      const a = this.newArray(n, from.kind, 0, source, { ...(from.bits ? { bits: from.bits } : {}), ...(from.unsigned ? { unsigned: true } : {}) });
      a.dynamic = true;
      this.emit({ kind: "declareArray", array: a.id, init: [], at, label }, e);
      return a;
    };
    let made: List;
    if (over.kind === "grid" || over.kind === "lists") return this.filterRows(e, over, given, where);
    if (over.kind === "units" || over.kind === "query") made = { kind: "units", name: given, ptr: grow(`${given} (ptr)`, { kind: "number", unsigned: true }), epd: grow(`${given} (epd)`, { kind: "number", unsigned: true }), uid: grow(`${given} (uid)`, { kind: "number", unsigned: true }) };
    else if (over.kind === "records") {
      // The columns first, so that — made again, in a loop — the rows it had give the blocks of their arrays back before it starts over.
      const columns = new Map([...over.fields].map(([field, a]) => { const c = this.newArray(`${given}.${field.replace(/ /g, ".")}`, a.kind, 0, source, { ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) }); c.dynamic = true; return [field, c] as const; }));
      made = { kind: "records", name: given, fields: columns, ...(over.cls ? { cls: over.cls } : {}), ...(over.shape ? { shape: over.shape } : {}) };
      this.releaseFrom(made, num(0), e);
      for (const c of columns.values()) this.emit({ kind: "declareArray", array: c.id, init: [], at, label }, e);
    }
    else if (over.kind === "array") made = { kind: "array", a: grow(given, over.a) };
    else {
      const kinds = new Set(over.items.map((v) => typeof v));
      if (kinds.size !== 1 || !(kinds.has("number") || kinds.has("boolean"))) { this.c.error(e, `filter() of a list the script has makes an array of numbers or of booleans; ${over.name} holds something else. A for…of over it runs the same turns.`); return null; }
      made = { kind: "array", a: grow(given, { kind: kinds.has("number") ? "number" : "boolean" }) };
    }
    this.loopOver(over, e, (item, index) => {
      const p = this.predicate(e.arguments[0], "filter", this.handed(over, item, index), e);
      if (!p) { ok = false; return; }
      const keep = this.collect(() => {
        if (made.kind === "units") {
          const unit = this.valueOf(item, "unit", e) as UnitExpr | null;
          if (!unit) { ok = false; return; }
          for (const [a, part] of this.unitArrays(made)) this.emit({ kind: "push", array: a.id, value: { kind: "unitPart", unit, part, at }, at, label }, e);
        } else if (made.kind === "records" && over.kind === "records" && index?.kind === "var") {
          const owned = this.ownedLists(made);
          const place = this.owns(made) ? this.newVar(`(row of ${made.name})`, "number", at, { temp: true }) : undefined;
          if (place) this.emit({ kind: "declare", decl: place, init: { kind: "length", array: [...made.fields.values()][0].id, at }, at, label }, e);
          for (const [field, a] of made.fields) this.emit({ kind: "push", array: a.id, value: { kind: "element", array: over.fields.get(field)!.id, index: varRef(index.v), at }, at, label }, e);
          // A row owns the arrays it holds, so the new row gets arrays of its own with the same cells: its handles start over, and are filled.
          const theirs = this.ownedLists(over);
          owned.forEach((l, k) => {
            for (const a of this.handlesOf(l)) this.emit({ kind: "store", array: a.id, index: varRef(place!), value: num(0), at, label }, e);
            this.copyCells(this.innerAt(l, place!, e), this.innerOf(theirs[k], varRef(index.v), e), e);
          });
          const texts = this.ownedTexts(over);
          this.ownedTexts(made).forEach((t, k) => {
            for (const a of [t.addr, t.block, t.chars]) this.emit({ kind: "store", array: a.id, index: varRef(place!), value: num(0), at, label }, e);
            this.storeTextAt({ ...t, index: varRef(place!) }, this.textAtCells({ ...texts[k], index: varRef(index.v) }, e), e);
          });
        } else if (made.kind === "array") {
          const value = this.valueOf(item, made.a.kind, e) as NumExpr | BoolExpr | null;
          if (!value) { ok = false; return; }
          this.emit({ kind: "push", array: made.a.id, value, at, label }, e);
        }
      });
      this.emit({ kind: "if", cond: p, then: keep, at, label }, e);
    });
    return ok ? made : null;
  }

  /** `grid.filter(…)`, `buckets.filter(…)`: the rows the function keeps, each a copy of its own — of a grid whole rows of one flat array, of rows that grow a block each. */
  private filterRows(e: TS.CallExpression, over: Grid | Lists, given: string, where: TS.Node): Binding | null {
    const at = this.at(e);
    const label = this.label(e);
    const source = this.sourceOf(where);
    let ok = true;
    if (over.kind === "grid") {
      if (over.dims.length !== 2 || over.offset) { this.c.error(e, `${over.name} is arrays more than two deep, or a part of one; filter() takes rows two deep.`); return null; }
      const w = over.dims[1];
      const flat = this.newArray(given, over.a.kind, 0, source, { ...(over.a.bits ? { bits: over.a.bits } : {}), ...(over.a.unsigned ? { unsigned: true } : {}) });
      flat.dynamic = true;
      this.emit({ kind: "declareArray", array: flat.id, init: [], at, label }, e);
      this.loopOver(over, e, (item, index) => {
        const p = this.predicate(e.arguments[0], "filter", this.handed(over, item, index), e);
        if (!p || index?.kind !== "var") { ok = false; return; }
        const keep = Array.from({ length: w }, (_, k): Stmt => ({ kind: "push", array: flat.id, value: { kind: "element", array: over.a.id, index: this.scaled(varRef(index.v), w, num(k), e), at }, at, label }));
        this.emit({ kind: "if", cond: p, then: keep, at, label }, e);
      });
      return ok ? { kind: "grid", name: given, a: flat, dims: [0, w], offset: null } : null;
    }
    const make = (part: string) => { const a = this.newArray(`${given} (${part})`, "number", 0, source, { unsigned: true }); a.dynamic = true; return a; };
    const made: Lists = { kind: "lists", name: given, ptr: make("block"), len: make("length"), room: make("room"), k: make("size"), of: over.of, ...(over.bits ? { bits: over.bits } : {}), ...(over.unsigned ? { unsigned: true } : {}) };
    // Made again, in a loop, the rows it had give their blocks back first.
    this.releaseRows(made, num(0), e);
    for (const a of this.handlesOf(made)) this.emit({ kind: "declareArray", array: a.id, init: [], at, label }, e);
    this.loopOver(over, e, (item, index) => {
      const p = this.predicate(e.arguments[0], "filter", this.handed(over, item, index), e);
      if (!p || item.kind !== "array") { ok = false; return; }
      const keep = this.collect(() => {
        const place = this.newVar(`(row of ${given})`, "number", at, { temp: true });
        this.emit({ kind: "declare", decl: place, init: { kind: "length", array: made.ptr.id, at }, at, label }, e);
        for (const a of this.handlesOf(made)) this.emit({ kind: "push", array: a.id, value: num(0), at, label }, e);
        this.copyCells(this.innerAt(made, place, e), item.a, e);
      });
      this.emit({ kind: "if", cond: p, then: keep, at, label }, e);
    });
    return ok ? made : null;
  }

  /** `a[i] = b[j]` over every array of a list, a row moved as one. */
  private moveRow(list: List, to: NumExpr, from: NumExpr, e: TS.Node): Stmt[] {
    const at = this.at(e);
    const label = this.label(e);
    return this.arraysOf(list).map((a): Stmt => ({ kind: "store", array: a.id, index: to, value: { kind: "element", array: a.id, index: from, at }, at, label }));
  }

  /** A row taken out into temporaries — what a sort holds in its hand, what a swap needs — with what puts it back at a place. */
  private heldRow(list: List, index: NumExpr, e: TS.Node): { binding: Binding; put: (to: NumExpr) => Stmt[] } {
    const at = this.at(e);
    const label = this.label(e);
    if (list.kind === "units") {
      const v = this.newVar(`(held of ${list.name})`, "unit", at, { temp: true });
      this.emit({ kind: "declare", decl: v, init: this.unitAtIndex(list, index, e), at, label }, e);
      return { binding: { kind: "var", v }, put: (to) => this.unitArrays(list).map(([a, part]): Stmt => ({ kind: "store", array: a.id, index: to, value: { kind: "unitPart", unit: unitRef(v), part, at }, at, label })) };
    }
    const hold = (a: ArrayDecl) => {
      const v = this.newVar(`(held of ${a.name})`, a.kind, at, { temp: true, ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) });
      this.emit({ kind: "declare", decl: v, init: { kind: "element", array: a.id, index, at }, at, label }, e);
      return v;
    };
    if (list.kind === "records" && this.owns(list)) {
      // A row that holds arrays is reached through a row, so the hand is one: a row past the end, which goes again when the row is put back.
      const columns = [...list.fields.values()];
      const place = this.newVar(`(held of ${list.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: place, init: { kind: "length", array: columns[0].id, at }, at, label }, e);
      for (const a of columns) { a.dynamic = true; this.emit({ kind: "push", array: a.id, value: { kind: "element", array: a.id, index, at }, at, label }, e); }
      return { binding: this.rowOf(list, varRef(place)), put: (to) => [...columns.map((a): Stmt => ({ kind: "store", array: a.id, index: to, value: { kind: "element", array: a.id, index: varRef(place), at }, at, label })), ...columns.map((a): Stmt => ({ kind: "pop", array: a.id, at, label }))] };
    }
    const back = (a: ArrayDecl, v: VarDecl, to: NumExpr): Stmt => ({ kind: "store", array: a.id, index: to, value: a.kind === "number" ? varRef(v) : boolRef(v), at, label });
    if (list.kind === "array") { const v = hold(list.a); return { binding: { kind: "var", v }, put: (to) => [back(list.a, v, to)] }; }
    const held = [...list.fields].map(([field, a]) => [field, a, hold(a)] as const);
    const kept = new Map(held.map(([key, , v]) => [key, v]));
    // The row in the hand, by its shape: a unit is its three numbers; an array it holds is reached through a row, and this is none.
    const build = (shape: RowShape, prefix: string): Map<string, Binding> => new Map([...shape].flatMap(([name, f]): [string, Binding][] => {
      const key = prefix + name;
      if (f.kind === "unit") return [[name, { kind: "unitAt", ptr: { v: kept.get(`${key} ptr`)! }, epd: { v: kept.get(`${key} epd`)! }, uid: { v: kept.get(`${key} uid`)! } }]];
      if (f.kind === "record") return [[name, { kind: "record", fields: build(f.shape, `${key} `), ...(f.cls ? { cls: f.cls } : {}) }]];
      return f.kind === "list" || f.kind === "squad" || f.kind === "text" ? [] : [[name, { kind: "var", v: kept.get(key)! }]];
    }));
    return { binding: { kind: "record", fields: build(this.rowShape(list), ""), ...(list.cls ? { cls: list.cls } : {}) }, put: (to) => held.map(([, a, v]) => back(a, v, to)) };
  }

  /**
   * What a sort and a reverse need of a list, whatever its rows are: how many, the row at a place, one row moved onto
   * another, and a row taken in hand with what puts it back. An array of arrays that grow is its four arrays of handles
   * seen as an array of records with one field; a grid's rows are runs of its flat array, the hand a run past its end.
   */
  private rowOps(list: List | Grid | Lists, e: TS.CallExpression): { length: NumExpr; row: (i: NumExpr) => Binding; move: (to: NumExpr, from: NumExpr) => Stmt[]; hold: (i: NumExpr) => { binding: Binding; put: (to: NumExpr) => Stmt[] } } | null {
    const at = this.at(e);
    const label = this.label(e);
    if (list.kind === "lists") {
      const view: Records = { kind: "records", name: list.name, fields: new Map(HANDLE_PARTS.map((part, k) => [`row ${part}`, this.handlesOf(list)[k]])), shape: new Map([["row", { kind: "list", of: list.of, width: { ...(list.bits ? { bits: list.bits } : {}), ...(list.unsigned ? { unsigned: true } : {}) } }]]) };
      const inner = (b: Binding): Binding => (b.kind === "record" ? b.fields.get("row")! : b);
      return { length: { kind: "length", array: list.ptr.id, at }, row: (i) => inner(this.rowOf(view, i)), move: (to, from) => this.moveRow(view, to, from, e), hold: (i) => { const held = this.heldRow(view, i, e); return { binding: inner(held.binding), put: held.put }; } };
    }
    if (list.kind === "grid") {
      if (list.dims.length !== 2 || list.offset) { this.c.error(e, `${list.name} is arrays more than two deep, or a part of one; its rows are sorted and reversed two deep.`); return null; }
      if (list.a.values) { this.c.error(e, `${list.name} was computed when the script was built and is only read in a program.`); return null; }
      const w = list.dims[1];
      const cellAt = (row: NumExpr, k: number): NumExpr => this.scaled(row, w, num(k), e);
      const window = (offset: NumExpr): Binding => ({ kind: "array", a: this.windowOf({ kind: "row", name: `${list.name}[…]`, a: list.a, offset, length: w }, e) });
      return {
        length: this.rowsOf(list, e),
        row: (i) => window(this.scaled(i, w, null, e)),
        move: (to, from) => Array.from({ length: w }, (_, k): Stmt => ({ kind: "store", array: list.a.id, index: cellAt(to, k), value: { kind: "element", array: list.a.id, index: cellAt(from, k), at }, at, label })),
        hold: (i) => {
          // The hand is a row past the end, so that what is asked of it — `a[0] - b[0]` — is asked of a row.
          list.a.dynamic = true;
          const place = this.newVar(`(held of ${list.name})`, "number", at, { temp: true });
          this.emit({ kind: "declare", decl: place, init: { kind: "length", array: list.a.id, at }, at, label }, e);
          for (let k = 0; k < w; k++) this.emit({ kind: "push", array: list.a.id, value: { kind: "element", array: list.a.id, index: cellAt(i, k), at }, at, label }, e);
          return { binding: window(varRef(place)), put: (to) => [...Array.from({ length: w }, (_, k): Stmt => ({ kind: "store", array: list.a.id, index: cellAt(to, k), value: { kind: "element", array: list.a.id, index: { kind: "binary", op: "+", left: varRef(place), right: num(k), at, label }, at }, at, label })), ...Array.from({ length: w }, (): Stmt => ({ kind: "pop", array: list.a.id, at, label }))] };
        },
      };
    }
    return {
      length: { kind: "length", array: this.lengthArray(list).id, at },
      row: (i) => {
        if (list.kind === "records") return this.rowOf(list, i);
        const v = list.kind === "units" ? this.newVar("(before)", "unit", at, { temp: true }) : this.newVar("(before)", list.a.kind, at, { temp: true, ...(list.a.bits ? { bits: list.a.bits } : {}), ...(list.a.unsigned ? { unsigned: true } : {}) });
        this.emit({ kind: "declare", decl: v, init: list.kind === "units" ? this.unitAtIndex(list, i, e) : { kind: "element", array: list.a.id, index: i, at }, at, label }, e);
        return { kind: "var", v };
      },
      move: (to, from) => this.moveRow(list, to, from, e),
      hold: (i) => this.heldRow(list, i, e),
    };
  }

  /** `xs.reverse()`: the two ends exchanged, inwards, within the frame. */
  private reverseList(e: TS.CallExpression, list: List | Grid | Lists): boolean {
    const at = this.at(e);
    const label = this.label(e);
    if (e.arguments.length) { this.c.error(e, "reverse() takes no argument."); return false; }
    const ops = this.rowOps(list, e);
    if (!ops) return false;
    const i = this.newVar(`(front of ${this.overName(list)})`, "number", at, { temp: true });
    const j = this.newVar(`(back of ${this.overName(list)})`, "number", at, { temp: true });
    const step = (v: VarDecl, by: "+" | "-"): Stmt => ({ kind: "assign", target: v.id, value: { kind: "binary", op: by, left: varRef(v), right: num(1), at, label }, at, label });
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
    this.emit({ kind: "declare", decl: j, init: { kind: "binary", op: "-", left: ops.length, right: num(1), at, label }, at, label }, e);
    const body = this.collect(() => {
      const held = ops.hold(varRef(i));
      this.out.push(...ops.move(varRef(i), varRef(j)), ...held.put(varRef(j)), step(i, "+"), step(j, "-"));
    });
    this.emit({ kind: "while", cond: { kind: "compare", op: "<", left: varRef(i), right: varRef(j), at, label }, body, at, label }, e);
    return true;
  }

  /**
   * `xs.sort((a, b) => a - b)`: an insertion sort within the frame — each item taken in hand and the larger ones before
   * it moved up one. It keeps the order of equals, as JavaScript's sort does, and is quick on a list nearly in order;
   * a list in no order costs its length squared, which is what the hint is about.
   */
  private sortList(e: TS.CallExpression, list: List | Grid | Lists): boolean {
    const at = this.at(e);
    const label = this.label(e);
    const name = this.overName(list);
    if (!e.arguments[0]) { this.c.error(e, `sort() wants its function — ${name}.sort((a, b) => a - b): without one JavaScript sorts numbers as text, 10 before 9.`); return false; }
    const ops = this.rowOps(list, e);
    if (!ops) return false;
    const i = this.newVar(`(index of ${name})`, "number", at, { temp: true });
    const j = this.newVar(`(place in ${name})`, "number", at, { temp: true });
    const next: NumExpr = { kind: "binary", op: "+", left: varRef(j), right: num(1), at, label };
    let ok = true;
    const body = this.collect(() => {
      const held = ops.hold(varRef(i));
      this.emit({ kind: "declare", decl: j, init: { kind: "binary", op: "-", left: varRef(i), right: num(1), at, label }, at, label }, e);
      const inner = this.collect(() => {
        const before = ops.row(varRef(j));
        const call = this.callback(e.arguments[0], "sort", [before, held.binding], "any", e);
        if (!call) { ok = false; return; }
        if (call.result?.kind !== "number") { this.c.error(e.arguments[0], "sort()'s function gives a number — below 0 when a goes first, above when b does: (a, b) => a - b."); ok = false; return; }
        const after: BoolExpr = { kind: "compare", op: ">", left: this.mark<NumExpr>({ kind: "call", call }, e), right: num(0), at, label };
        this.emit({ kind: "if", cond: { kind: "not", expr: after }, then: [{ kind: "break", at, label }], at, label }, e);
        this.out.push(...ops.move(next, varRef(j)), { kind: "assign", target: j.id, value: { kind: "binary", op: "-", left: varRef(j), right: num(1), at, label }, at, label });
      });
      this.emit({ kind: "while", cond: { kind: "compare", op: ">=", left: varRef(j), right: num(0), at, label }, body: inner, at, label }, e);
      this.out.push(...held.put(next));
    });
    if (!ok) return false;
    this.emit({ kind: "declare", decl: i, init: num(1), at, label }, e);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: ops.length, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body, at, label, sorts: name }, e);
    return true;
  }

  /** `hp[i] = v`, `hp[i] += v`: a store into a cell. An index that holds a call is evaluated once for the read and once for the store, as two reads of `i` would be. */
  private storeElement(e: TS.BinaryExpression, el: { a: ArrayDecl; index: NumExpr }, op: TS.SyntaxKind) {
    const { ts } = this;
    const { a, index } = el;
    if (a.values) { this.c.error(e.left, `${a.name} was computed when the script was built and is only read in a program; declare it with let inside the program to write to it.`); return; }
    const emit = (value: NumExpr | BoolExpr) => this.emit({ kind: "store", array: a.id, index, value, at: this.at(e), label: this.label(e) }, e);
    if (a.kind === "boolean") {
      if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "Booleans take = only."); return; }
      emit(this.boolValue(e.right));
      return;
    }
    const rhs = this.num(e.right);
    if (!rhs) return;
    if (op === ts.SyntaxKind.EqualsToken) { emit(rhs); return; }
    const arith = compoundOp(ts, op);
    if (!arith) { this.c.error(e, "Only = += -= *= /= %= &= |= ^= <<= >>= >>>= assign a number."); return; }
    emit(this.mark<NumExpr>({ kind: "binary", op: arith, left: { kind: "element", array: a.id, index, at: this.at(e) }, right: rhs, at: this.at(e), label: this.label(e) }, e));
  }

  /**
   * `let hp = [0, 0, 0]`, `let lives: u8[] = new Array(12).fill(3)`, `let seen = [a, b, false]`: an array of the
   * program. Its length is known when the script is built — from the list when the whole initialiser is, from the
   * literal's elements, or from `new Array(n).fill(v)` with a value of the program — and its cells are set here.
   */
  private declareArray(name: string, initializer: TS.Expression, type: TS.Type, at: TS.Node): ArrayDecl | null {
    const { ts } = this;
    const element = this.c.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    let kind = element ? this.kindOf(element) : null;
    // `let xs = []` says nothing of what it holds, and TypeScript works it out from the pushes; a program wants it said.
    if (element && !kind && element.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never) && ts.isArrayLiteralExpression(this.unwrap(initializer)) && (this.unwrap(initializer) as TS.ArrayLiteralExpression).elements.length === 0) {
      this.c.error(at, `Say what ${name} holds: let ${name}: number[] = [] (or boolean[]).`);
      return null;
    }
    // `new Array(12).fill(0)` is an any[] to TypeScript: what it is filled with says what it holds.
    if (element && !kind && element.flags & ts.TypeFlags.Any) {
      const made = this.unwrap(initializer);
      const filled = ts.isCallExpression(made) && ts.isPropertyAccessExpression(made.expression) && made.expression.name.text === "fill" && made.arguments.length === 1 ? made.arguments[0] : undefined;
      if (filled) kind = this.kindOf(this.c.checker.getTypeAtLocation(filled));
    }
    if (element && !kind && this.isTextType(element)) {
      this.c.error(at, `${name} is an array of texts, which a program cannot fill yet. A list of texts the script has can be looked up with a number of the program — const titles = ["Easy", "Hard"] outside the program, titles[level] inside it — and a text a program makes is kept in a variable or a record's field.`);
      return null;
    }
    if (!element || (kind !== "number" && kind !== "boolean")) {
      this.c.error(at, `An array of a program holds numbers or booleans; ${name} is ${this.c.checker.typeToString(type)}.`);
      return null;
    }
    const shared = ts.isCallExpression(this.unwrap(initializer)) && this.isLibraryCall(this.unwrap(initializer) as TS.CallExpression, "shared") ? (this.unwrap(initializer) as TS.CallExpression) : null;
    if (shared && shared.arguments.length !== 1) { this.c.error(initializer, "shared() takes the initial value: shared([0, 0, 0])."); return null; }
    const init = this.unwrap(shared ? shared.arguments[0] : initializer);
    const width = kind === "number" ? this.widthOf(element) : {};
    const grows = this.body.plan.grows.has(at);
    const make = (length: number) => {
      // Written empty, it can only be one that grows — pushed to here, or by a function it is handed to.
      const dynamic = grows || length === 0;
      if (length < (dynamic ? 0 : 1) || length > MAX_ARRAY) { this.c.error(init, dynamic ? `An array of a program starts with at most ${MAX_ARRAY} cells (got ${length}).` : `An array of a program has 1 to ${MAX_ARRAY} cells (got ${length}); one that starts empty is one something pushes to.`); return null; }
      const a = this.newArray(name, kind, length, this.sourceOf(at), { shared: !!shared, ...width });
      if (dynamic) a.dynamic = true;
      return a;
    };
    const constant = (v: unknown, where: TS.Node): NumExpr | BoolExpr | null => {
      if (kind === "boolean") { if (typeof v === "boolean") return { kind: "const", value: v }; this.c.error(where, `Expected true or false, got ${describe(v)}.`); return null; }
      const n = this.asInteger({ value: v }, where);
      return n === null ? null : num(n);
    };
    const h = this.evaluate(init);
    if (h) {
      // The whole list was known when the script was built.
      if (!Array.isArray(h.value)) { this.c.error(init, `Expected a list to start the array with, got ${describe(h.value)}.`); return null; }
      const values: (NumExpr | BoolExpr)[] = [];
      for (const v of h.value as unknown[]) { const c = constant(v, init); if (!c) return null; values.push(c); }
      const a = make(values.length);
      if (!a) return null;
      const same = values.length > 4 && values.every((v) => (v as { value: unknown }).value === (values[0] as { value: unknown }).value);
      this.emit({ kind: "declareArray", array: a.id, ...(same ? { fill: values[0] } : { init: values }), at: this.at(at), label: this.label(at) }, at);
      return a;
    }
    const one = (e: TS.Expression): NumExpr | BoolExpr | null => (kind === "number" ? this.num(e) : this.boolValue(e));
    if (ts.isArrayLiteralExpression(init) && init.elements.some((x) => ts.isSpreadElement(x))) return this.spreadArray(name, init, kind, width, !!shared, at);
    if (ts.isArrayLiteralExpression(init)) {
      if (init.elements.some((x) => ts.isOmittedExpression(x))) { this.c.error(init, "An array of a program is written out value by value: [a, b, 0]."); return null; }
      const values: (NumExpr | BoolExpr)[] = [];
      for (const x of init.elements) { const v = one(x); if (!v) return null; values.push(v); }
      const a = make(values.length);
      if (a) this.emit({ kind: "declareArray", array: a.id, init: values, at: this.at(at), label: this.label(at) }, at);
      return a;
    }
    // new Array(n).fill(v) / Array(n).fill(v) with a value of the program.
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === "fill" && init.arguments.length === 1) {
      const made = this.unwrap(init.expression.expression);
      if ((ts.isNewExpression(made) || ts.isCallExpression(made)) && made.arguments?.length === 1) {
        const n = this.evaluate(made.arguments[0]);
        if (n && typeof n.value === "number" && Number.isInteger(n.value)) {
          const fill = one(init.arguments[0]);
          const a = fill ? make(n.value) : null;
          if (a && fill) this.emit({ kind: "declareArray", array: a.id, fill, at: this.at(at), label: this.label(at) }, at);
          return a;
        }
      }
    }
    this.c.error(init, "An array's length has to be known when the script is built: write its values out ([a, b, 0]) or give it a size (new Array(12).fill(0)).");
    return null;
  }

  /**
   * `[...xs, v, ...ys]`: the cells copied one by one. Of fixed arrays it is a fixed array, every value read before any is
   * stored; with one that grows among them it grows, filled by pushes and a loop an array.
   */
  private spreadArray(name: string, init: TS.ArrayLiteralExpression, kind: "number" | "boolean", width: { bits?: 8 | 16; unsigned?: boolean }, shared: boolean, where: TS.Node): ArrayDecl | null {
    const { ts } = this;
    const at = this.at(where);
    const label = this.label(where);
    type Part = { a: ArrayDecl } | { value: NumExpr | BoolExpr };
    const parts: Part[] = [];
    for (const x of init.elements) {
      if (ts.isOmittedExpression(x)) { this.c.error(x, "An array of a program has no holes."); return null; }
      if (!ts.isSpreadElement(x)) { const value = kind === "number" ? this.num(x) : this.boolValue(x); if (!value) return null; parts.push({ value }); continue; }
      const h = this.evaluate(x.expression);
      if (h) {
        if (!Array.isArray(h.value)) { this.c.error(x, `... spreads a list, got ${describe(h.value)}.`); return null; }
        for (const v of h.value as unknown[]) {
          if (kind === "boolean") { if (typeof v !== "boolean") { this.c.error(x, `Expected true or false, got ${describe(v)}.`); return null; } parts.push({ value: { kind: "const", value: v } }); }
          else { const n = this.asInteger({ value: v }, x); if (n === null) return null; parts.push({ value: num(n) }); }
        }
        continue;
      }
      const spread = this.listOf(x.expression);
      const b = spread?.kind === "hash" ? this.hashList(spread, "keys", undefined, x) : spread;
      if (b?.kind !== "array") { this.c.error(x, "... inside [ ] spreads an array of numbers or of booleans."); return null; }
      if (b.a.kind !== kind) { this.c.error(x, `${b.a.name} holds ${b.a.kind}s, and ${name} ${kind}s.`); return null; }
      parts.push({ a: b.a });
    }
    const grows = this.body.plan.grows.has(where) || parts.some((p) => "a" in p && p.a.dynamic);
    const length = parts.reduce((n, p) => n + ("a" in p ? p.a.length : 1), 0);
    if (length > MAX_ARRAY) { this.c.error(init, `An array of a program starts with at most ${MAX_ARRAY} cells (got ${length}).`); return null; }
    if (!grows && length < 1) { this.c.error(init, `${name} would be empty, and nothing pushes to it.`); return null; }
    const made = this.newArray(name, kind, grows ? 0 : length, this.sourceOf(where), { shared, ...width });
    if (!grows) {
      const values = parts.flatMap((p): (NumExpr | BoolExpr)[] => ("a" in p ? Array.from({ length: p.a.length }, (_, k) => ({ kind: "element" as const, array: p.a.id, index: num(k), at })) : [p.value]));
      this.emit({ kind: "declareArray", array: made.id, init: values, at, label }, where);
      return made;
    }
    made.dynamic = true;
    // What is written out is worked out before the array is made again: `xs = [...xs, v]` in a loop reads the old xs.
    const held = parts.map((p): Part => { if ("a" in p || p.value.kind === "const") return p; const t = this.newVar("(spread)", kind, at, { temp: true, ...width }); this.emit({ kind: "declare", decl: t, init: p.value, at, label }, where); return { value: kind === "number" ? varRef(t) : boolRef(t) }; });
    this.emit({ kind: "declareArray", array: made.id, init: [], at, label }, where);
    for (const p of held) {
      if (!("a" in p)) { this.emit({ kind: "push", array: made.id, value: p.value, at, label }, where); continue; }
      const i = this.newVar(`(index of ${p.a.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: i, init: num(0), at, label }, where);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: p.a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "push", array: made.id, value: { kind: "element", array: p.a.id, index: varRef(i), at }, at, label }], at, label }, where);
    }
    return made;
  }

  /**
   * `hp[i]`: the array and the index — a game array by its binding, or a list known when the script was built
   * (`const price = [50, 100, 150]`) indexed by a value of the program, which becomes an array nothing writes.
   * Undefined when the expression is neither; null, with a diagnostic, when it is one and cannot compile.
   */
  private elementOf(e: TS.ElementAccessExpression): { a: ArrayDecl; index: NumExpr } | null | undefined {
    // `grid[y][x]`: straight to the cell of the flat array.
    const row = this.bindingOf(e.expression);
    if (row?.kind === "row") return this.rowCell(row, e.argumentExpression, e);
    const b = row && row.kind !== "inner" ? row : this.listOf(e.expression);
    if (b?.kind === "keyed") {
      if (b.as !== "record" || !b.values) { this.c.error(e, `${b.name} is read with ${b.as === "map" ? "get(key)" : "has(key)"}, as a ${b.as === "map" ? "Map" : "Set"} is.`); return null; }
      const index = this.keyIndex(b, e.argumentExpression);
      return index ? { a: b.values, index } : null;
    }
    let a = b?.kind === "array" ? b.a : undefined;
    if (!a) {
      let list = this.evaluate(e.expression)?.value;
      if (this.evaluate(e.argumentExpression)) return undefined;
      // `const price: Record<UnitType, number> = { [units.TerranMarine]: 50 }` outside the program: a list with gaps, 0 where nothing was written.
      if (list && typeof list === "object" && !Array.isArray(list) && !(list instanceof Map) && !(list instanceof Set)) {
        const keys = Object.keys(list);
        if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) return undefined;
        let dense = this.objects.get(list);
        if (!dense) {
          const booleans = Object.values(list).every((v) => typeof v === "boolean");
          dense = new Array<unknown>(Math.max(...keys.map(Number)) + 1).fill(booleans ? false : 0);
          for (const k of keys) dense[Number(k)] = (list as Record<string, unknown>)[k];
          this.objects.set(list, dense);
        }
        list = this.objects.get(list as object) ?? list;
      }
      if (!Array.isArray(list)) return undefined;
      a = this.tables.get(list);
      if (!a) {
        const booleans = list.length > 0 && list.every((v) => typeof v === "boolean");
        const values: number[] = [];
        for (const v of list as unknown[]) {
          const n = booleans ? (v ? 1 : 0) : this.asInteger({ value: v }, e.expression);
          if (n === null) return null;
          values.push(n);
        }
        if (values.length < 1 || values.length > MAX_ARRAY) { this.c.error(e.expression, `A list a program looks a value up in has 1 to ${MAX_ARRAY} entries (got ${values.length}).`); return null; }
        const name = e.expression.getText(this.body.sf).replace(/\s+/g, " ");
        a = this.newArray(name, booleans ? "boolean" : "number", values.length, this.at(e.expression), { shared: true, values, ...(values.some((v) => v > I32_MAX) ? { unsigned: true } : {}) });
        this.tables.set(list, a);
      }
    }
    const h = this.evaluate(e.argumentExpression);
    if (h) {
      const i = this.asInteger(h, e.argumentExpression);
      if (i === null) return null;
      if (!a.dynamic && (i < 0 || i >= a.length)) { this.c.error(e.argumentExpression, `${a.name} has ${a.length} cell${a.length === 1 ? "" : "s"}, 0 … ${a.length - 1}; there is no ${a.name}[${i}].`); return null; }
      return { a, index: num(i) };
    }
    const index = this.num(e.argumentExpression);
    return index ? { a, index } : null;
  }

  /** `let p = { lives: 3, alive: true, pos: { x: 0, y: 0 } }`: a variable per field, the record a binding over them. */
  private declareRecord(name: string, literal: TS.ObjectLiteralExpression, type: TS.Type, at: TS.Node): Binding | null {
    const { ts } = this;
    const fields = new Map<string, Binding>();
    let ok = true;
    for (const p of literal.properties) {
      let key: string;
      let init: TS.Expression;
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) { key = p.name.text; init = p.initializer; }
      else if (ts.isShorthandPropertyAssignment(p)) { key = p.name.text; init = p.name; }
      else if (ts.isSpreadAssignment(p)) {
        // `{ ...p, y: 9 }`: every field of p copied, as JavaScript copies them; what is written after it replaces its own.
        const from = this.spreadFields(p.expression);
        if (!from) { ok = false; continue; }
        for (const [field, b] of from) fields.set(field, this.fieldCopy(b, `${name}.${field}`, p));
        continue;
      }
      else { this.c.error(p, "A record's fields are plain values: { lives: 3, alive: true }."); ok = false; continue; }
      const prop = type.getProperty(key);
      const ft = prop ? this.c.checker.getTypeOfSymbol(prop) : this.c.checker.getTypeAtLocation(init);
      const held = this.declareField(`${name}.${key}`, init, ft, prop, p, p.name, at);
      if (held) fields.set(key, held);
      else ok = false;
    }
    return ok ? { kind: "record", fields } : null;
  }

  /**
   * One field of a record, or of an instance: a variable under the record's name, or what that name leads to — a record
   * inside it, an instance, an array. `init` is absent for a field of a class that is declared without a value
   * (`hp: number;`), which starts at 0, false, no unit or no text, as the constructor then finds it.
   */
  private declareField(full: string, init: TS.Expression | undefined, ft: TS.Type, prop: TS.Symbol | undefined, p: TS.Node, nameNode: TS.Node, at: TS.Node): Binding | null {
    const { ts } = this;
    const inner = init && this.unwrap(init);
    if (inner && ts.isObjectLiteralExpression(inner)) return this.declareRecord(full, inner, ft, p);
    if (inner && ts.isNewExpression(inner) && this.classOf(inner.expression)) return this.instantiate(inner, full);
    // `counts = new Map<number, number>()`: a table the record's name leads to.
    const keyedAs = inner ? this.keyedForm(inner, ft) : null;
    if (inner && keyedAs && keyedAs !== "record") return this.anyNumberKeys(ft) ? this.declareHash(full, keyedAs, inner, ft, p) : this.declareKeyed(full, keyedAs, inner, ft, p);
    // `path: [0, 0, 0]`, `seen: [] as number[]`, `squad: [] as Unit[]`, `grid: [[0, 0], [0, 0]]`: an array the record's name leads to.
    if (this.c.checker.isArrayType(ft) || this.c.checker.isTupleType(ft)) {
      if (!init) { this.c.error(p, `${full} is an array: give it its first value where it is declared — ${full.split(".").pop()} = [] — so that there is an array for the constructor to fill.`); return null; }
      const element = this.c.checker.getIndexTypeOfType(ft, ts.IndexKind.Number);
      const gridShape = this.gridType(ft);
      if (gridShape) return this.declareGrid(full, init, gridShape, p) ?? this.declareLists(full, init, gridShape, p) ?? null;
      if (element && this.kindOf(element) === "unit") return this.declareUnits(full, init, p);
      const a = this.declareArray(full, init, ft, p);
      return a ? { kind: "array", a } : null;
    }
    if (this.isTextType(ft)) {
      // `name: "Boss"`: a text variable the record's name leads to, kept by what `p.name = …` anywhere gives it.
      const keptAs = prop ? this.textKept(init, (left) => ts.isPropertyAccessExpression(left) && this.c.checker.getSymbolAtLocation(left.name) === prop) : "made";
      if (init) return { kind: "var", v: this.declareText(full, init, keptAs, this.sourceOf(nameNode), at) };
      const v = this.newVar(full, "text", this.sourceOf(nameNode), { text: keptAs });
      this.emit({ kind: "declare", decl: v, init: { kind: "text", text: "" }, at: this.at(at), label: this.label(at) }, at);
      return { kind: "var", v };
    }
    const kind = this.kindOf(ft);
    if (!kind) { this.c.error(p, `A record's fields hold numbers, booleans, texts, units, arrays of them, records or instances; ${full} is ${this.c.checker.typeToString(ft)}${init ? "" : " and has no first value"}.`); return null; }
    const v = this.newVar(full, kind, this.sourceOf(nameNode), kind === "number" ? this.widthOf(ft) : {});
    if (init) this.emitDeclare(v, init, at);
    else this.emit({ kind: "declare", decl: v, init: kind === "number" ? num(0) : kind === "unit" ? NO_UNIT : FALSE, at: this.at(at), label: this.label(at) }, at);
    return { kind: "var", v };
  }

  /**
   * `const at = mouse(p)`, `const m = chatted(p, "-give {n}")`: what the player did, taken when the
   * line runs and kept — a record of numbers, and for a typed line the boolean `if (m)` asks.
   */
  private declareInput(name: string, call: TS.CallExpression, at: TS.Node): Binding | null {
    const h = this.evaluate(call);
    if (!h) { this.notConstant(call, "Which player, and what to look for,"); return null; }
    const fields = new Map<string, Binding>();
    const keep = (field: string, value: InputValue) => {
      const v = this.newVar(`${name}.${field}`, "number", this.sourceOf(at));
      this.emit({ kind: "declare", decl: v, init: this.inputValue(value, call), at: this.at(at), label: this.label(at) }, at);
      fields.set(field, { kind: "var", v });
    };
    if (isMouse(h.value)) {
      keep("x", h.value.x);
      keep("y", h.value.y);
      return { kind: "record", fields };
    }
    if (isChat(h.value)) {
      const truth = this.newVar(name, "boolean", this.sourceOf(at));
      this.emit({ kind: "declare", decl: truth, init: this.inputBool(h.value.matched, call), at: this.at(at), label: this.label(at) }, at);
      for (const [field, value] of Object.entries(h.value.values)) keep(field, value);
      return { kind: "record", fields, truth };
    }
    this.c.error(call, `Expected mouse() or chatted(), got ${describe(h.value)}.`);
    return null;
  }

  /** What a player did, as a number of the program: a key or a click counts 1 or 0. */
  private inputValue(v: InputValue, at: TS.Node): NumExpr {
    return this.mark<NumExpr>({ kind: "input", input: { ...v.input }, at: this.at(at), label: this.label(at) }, at);
  }

  private inputBool(v: InputValue, at: TS.Node): BoolExpr {
    return this.mark<BoolExpr>({ kind: "test", expr: this.inputValue(v, at), at: this.at(at), label: this.label(at) }, at);
  }

  /** Where a declaration's name is, for the editor's hover. */
  private sourceOf(node: TS.Node): { file: string; line: number; column: number } {
    const p = this.body.sf.getLineAndCharacterOfPosition(node.getStart(this.body.sf));
    return { file: this.body.sf.fileName, line: p.line + 1, column: p.character + 1 };
  }

  /** What a `u8` / `u16` / `u32` annotation declares, read off the brand in the type; nothing for a plain number, which is signed. */
  private widthOf(type: TS.Type): { bits?: 8 | 16; unsigned?: boolean } {
    for (const t of type.isIntersection() ? type.types : [type]) {
      const p = t.getProperty("__kind");
      if (!p) continue;
      const pt = this.c.checker.getTypeOfSymbol(p);
      const names = (pt.isUnion() ? pt.types : [pt]).filter((x): x is TS.StringLiteralType => x.isStringLiteral()).map((x) => x.value);
      if (names.includes("u8")) return { bits: 8 };
      if (names.includes("u16")) return { bits: 16 };
      if (names.includes("u32")) return { unsigned: true };
    }
    return {};
  }

  private kindOf(type: TS.Type): Kind | null {
    const { ts } = this;
    // `c ? 1 : 0` is `0 | 1`: a union of numbers is a number.
    const isNumber = (t: TS.Type): boolean => (t.flags & ts.TypeFlags.NumberLike) !== 0 || (t.isIntersection() && t.types.some(isNumber)) || (t.isUnion() && t.types.every(isNumber));
    if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
    if (isNumber(type)) return "number";
    // `Unit | null`: a unit of the game, or none.
    const bare = (type.isUnion() ? type.types : [type]).filter((t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0);
    if (bare.length > 0 && bare.every((t) => !!t.getProperty("__unit"))) return "unit";
    return null;
  }

  private isUnitTyped(e: TS.Expression): boolean {
    return this.kindOf(this.c.checker.getTypeAtLocation(e)) === "unit";
  }

  /** The `__kind` brand of an expression's type (`"unit"`, `"player"`, …): what tells `stats(units.X)` from `stats(P3)`. */
  private brandOf(e: TS.Expression): string | undefined {
    const type = this.c.checker.getTypeAtLocation(e);
    for (const t of type.isIntersection() ? type.types : [type]) {
      const p = t.getProperty("__kind");
      if (!p) continue;
      const pt = this.c.checker.getTypeOfSymbol(p);
      const name = (pt.isUnion() ? pt.types : [pt]).find((x): x is TS.StringLiteralType => x.isStringLiteral());
      if (name) return name.value;
    }
    return undefined;
  }

  /** An expression statement whose value was computed at build time: actions run, nothing else does anything. */
  private hoistedStatement(expr: TS.Expression, h: Hoisted) {
    const v = h.value;
    if (v === undefined || v === null) return;
    if (isDuration(v)) { this.c.error(expr, "A duration does nothing on its own; sleep(seconds(2)) pauses the program."); return; }
    if (isAction(v)) { this.emitAction(v.record, expr); return; }
    if (isPrint(v)) { this.emitPrint(textParts(v.text), v.to, v.position, expr); return; }
    if (isRead(v)) { this.c.error(expr, `${v.ident}() reads a value and does nothing on its own: assign it to a variable, or compare it in an if.`); return; }
    if (isTable(v)) { this.c.error(expr, `${v.ident} reads a value and does nothing on its own: assign to it, or compare it in an if.`); return; }
    if (isUnitPick(v)) { this.c.error(expr, `${v.ident}() finds a unit and does nothing on its own: const u = ${v.ident}(…); if (u) u.kill();`); return; }
    if (isUnitQuery(v)) { this.c.error(expr, `${v.ident}() names units and does nothing on its own: for (const u of ${v.ident}(…)) { … }`); return; }
    if (isInput(v) || isMouse(v) || isChat(v)) { this.c.error(expr, "This asks what a player did and does nothing on its own: test it in an if, or keep it in a const."); return; }
    if (Array.isArray(v) && v.length > 0 && v.every(isAction)) { for (const a of v) this.emitAction(a.record, expr); return; }
    if (Array.isArray(v) && v.length === 0) return;
    if (isCondition(v)) { this.c.error(expr, "This is a condition; test it in an if or a while."); return; }
    this.c.error(expr, `This statement produces ${describe(v)}, which does nothing in the game. A statement here is an action, an assignment or a call.`);
  }

  private emitAction(a: ActionRecord, at: TS.Node) {
    if (a.type === ActionType.PreserveTrigger) return; // Every generated trigger is preserved already.
    const s = a.text > 0 ? this.c.strings[a.text - 1] : undefined;
    if (s && "text" in s && hasTextMark(s.text)) {
      // name() or color() in the text: only displayText has a form the game fills in.
      if (a.type !== ActionType.DisplayText) { this.c.error(at, "name() and color() are filled in while the game runs, which displayText() and print() can do; this action's text is fixed when the script is built."); return; }
      this.emitPrint(textParts(s.text), CURRENT_PLAYER, "chat", at);
      return;
    }
    this.emit({ kind: "action", record: { ...a }, at: this.at(at), label: this.label(at) }, at);
  }

  private emitPrint(parts: TextPart[], to: number, position: "chat" | "center", at: TS.Node) {
    if (!parts.length) return;
    this.emit({ kind: "print", parts: mergeText(parts), to, position, at: this.at(at), label: this.label(at) }, at);
  }

  /* ── Texts ── */

  /** Whether a type is a string's: `string`, a text written out, a union of those (`undefined` beside it is what `at()` adds, and is nothing here). */
  private isTextType(type: TS.Type): boolean {
    const { ts } = this;
    const bare = (type.isUnion() ? type.types : [type]).filter((t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0);
    return bare.length > 0 && bare.every((t) => (t.flags & ts.TypeFlags.StringLike) !== 0);
  }

  private isTextTyped(e: TS.Expression): boolean {
    return this.isTextType(this.c.checker.getTypeAtLocation(e));
  }

  /** A text the script has, as the program's: one of the table, or — with name() or color() in it — one the game fills in. */
  private literalText(value: string, at: TS.Node): TextExpr {
    if (hasTextMark(value)) return this.mark<TextExpr>({ kind: "template", parts: mergeText(textParts(value)), at: this.at(at), label: this.label(at) }, at);
    // A character past U+FFFF is two of JavaScript's and one here, and the game draws a dark square for each (played 2026-09-19).
    if ([...value].some((ch) => ch.codePointAt(0)! > 0xffff)) this.emit({ kind: "remark", short: "a character the game cannot draw", text: "This text holds a character past U+FFFF (an emoji, a rare ideograph). StarCraft draws a dark square in its place, and where JavaScript counts it as two characters a program counts it as one.", at: this.at(at) }, at);
    return { kind: "text", text: value };
  }

  /** Parts as the text they are: one written out when nothing of the program is in them, the text itself when it is the only part. */
  private textFrom(parts: TextPart[], at: TS.Node): TextExpr {
    const merged = mergeText(parts);
    if (merged.length === 0) return { kind: "text", text: "" };
    if (merged.length === 1 && merged[0].kind === "text") return { kind: "text", text: merged[0].text };
    if (merged.length === 1 && merged[0].kind === "value") return merged[0].text;
    return this.mark<TextExpr>({ kind: "template", parts: merged, at: this.at(at), label: this.label(at) }, at);
  }

  /** A text as the parts of a larger one. */
  private partsOf(t: TextExpr): TextPart[] {
    return t.kind === "text" ? (t.text ? [{ kind: "text", text: t.text }] : []) : t.kind === "template" ? t.parts : [{ kind: "value", text: t }];
  }

  /** How each text variable met so far is kept, for `textHasId`. */
  private readonly textKinds = new Map<string, "id" | "made">();
  private keptAs = (id: string) => this.textKinds.get(id);

  /** A list of texts the script has, as the table a program looks one up in: once a list. */
  private textTable(list: unknown[], at: TS.Expression): ArrayDecl | null {
    let a = this.tables.get(list);
    if (a) return a;
    if (list.length < 1 || list.length > MAX_ARRAY) { this.c.error(at, `A list a program looks a text up in has 1 to ${MAX_ARRAY} entries (got ${list.length}).`); return null; }
    const texts = list as string[];
    if (texts.some((t) => hasTextMark(t))) { this.c.error(at, "A text in this list has name() or color() in it, which the game fills in when it is shown: such a text is written where it is used, not looked up."); return null; }
    a = this.newArray(at.getText(this.body.sf).replace(/\s+/g, " "), "number", texts.length, this.at(at), { shared: true, values: texts.map((_, i) => i) });
    a.texts = texts;
    this.tables.set(list, a);
    return a;
  }

  /** Whether a text will have an id whatever happens in the game: written out, picked between two that are, looked up in a list the script has, or a variable kept that way. */
  private hasId(expr: TS.Expression): boolean {
    const { ts } = this;
    const e = this.unwrap(expr);
    let h: Hoisted | undefined;
    // Asked before the walk reaches the expression: one that cannot be worked out yet is simply not known to have an id.
    try { h = this.evaluate(e); } catch { return false; }
    if (h) return !isGameValue(h.value) && (typeof h.value === "number" || typeof h.value === "boolean" || (typeof h.value === "string" && !hasTextMark(h.value)));
    if (ts.isConditionalExpression(e)) return this.hasId(e.whenTrue) && this.hasId(e.whenFalse);
    if (ts.isElementAccessExpression(e)) {
      let list: Hoisted | undefined;
      try { list = this.evaluate(e.expression); } catch { return false; }
      return !!list && Array.isArray(list.value) && list.value.length > 0 && list.value.every((v) => typeof v === "string" && !hasTextMark(v));
    }
    const b = this.bindingOf(e);
    return b?.kind === "var" && b.v.kind === "text" && b.v.text === "id";
  }

  /**
   * How a text variable is kept: as the id of a text of the built map's table when everything it is ever given has one —
   * its first value and every `=` in the body — and as a text that is made otherwise (`+=` makes one). `isTarget` says
   * whether the left of an assignment is this variable.
   */
  private textKept(initializer: TS.Expression | undefined, isTarget: (left: TS.Expression) => boolean): "id" | "made" {
    const { ts } = this;
    if (initializer && !this.hasId(initializer)) return "made";
    let made = false;
    const walk = (n: TS.Node) => {
      if (made) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isTarget(this.unwrap(n.left))) {
        if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !this.hasId(n.right)) made = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(this.body.plan.body);
    return made ? "made" : "id";
  }

  /** A text variable with its first value. */
  private declareText(name: string, initializer: TS.Expression, keptAs: "id" | "made", where: At, at: TS.Node, extra: { temp?: boolean } = {}): VarDecl {
    const v = this.newVar(name, "text", where, { text: keptAs, ...extra });
    const value = this.text(initializer);
    const fits = !value || keptAs === "made" || textHasId(value, this.keptAs);
    if (!fits) this.c.error(initializer, `${name} was taken for a variable that only ever holds texts written in the script, and this one is made while the map is played. Give it such a text where it is declared — let ${name} = String(…) — and it is kept the other way.`);
    this.emit({ kind: "declare", decl: v, init: value && fits ? value : { kind: "text", text: "" }, ...(value && fits ? {} : { failed: true }), at: this.at(at), label: this.label(at) }, at);
    if (!extra.temp) this.emit({ kind: "remark", short: keptAs === "id" ? "a text of the map" : "a text that is made", text: keptAs === "id"
      ? `${name} only ever holds texts written in the script, so it is kept as the text's number in the built map's string table: assigning it and comparing it cost what a number's do, and any action's text takes it.`
      : `${name} holds a text made while the map is played: its characters are in a block of the memory the programs' arrays and texts share, which ${name} owns — assigning it copies them, and what it held before goes back. At most ${TEXT_BYTES.toLocaleString("en-US")} bytes.`, at: this.at(at) }, at);
    return v;
  }

  /** A number where a text's characters are counted from: inside 0 … the text's length, a place below zero counted from the end when `fromEnd`. */
  private placeIn(of: TextExpr, index: NumExpr, fromEnd: boolean, at: TS.Node): NumExpr {
    const length: NumExpr = this.mark<NumExpr>({ kind: "textLength", of, at: this.at(at), label: this.label(at) }, at);
    if (index.kind === "const") {
      if (index.value >= 0) return index;
      if (!fromEnd) return num(0);
      return this.mark<NumExpr>({ kind: "intrinsic", name: "max", args: [this.mark<NumExpr>({ kind: "binary", op: "+", left: length, right: index, at: this.at(at), label: this.label(at) }, at), num(0)], at: this.at(at), label: this.label(at) }, at);
    }
    const i = this.temp(index, at);
    const clamped = this.mark<NumExpr>({ kind: "intrinsic", name: "max", args: [i, num(0)], at: this.at(at), label: this.label(at) }, at);
    if (!fromEnd) return clamped;
    const back = this.mark<NumExpr>({ kind: "intrinsic", name: "max", args: [this.mark<NumExpr>({ kind: "binary", op: "+", left: length, right: i, at: this.at(at), label: this.label(at) }, at), num(0)], at: this.at(at), label: this.label(at) }, at);
    return this.mark<NumExpr>({ kind: "ternary", cond: { kind: "compare", op: "<", left: i, right: num(0), at: this.at(at), label: this.label(at) }, whenTrue: back, whenFalse: clamped, at: this.at(at), label: this.label(at) }, at);
  }

  /** A text that is looked at more than once while one value is worked out: itself when that costs nothing, else a temporary holding it. */
  private textTemp(t: TextExpr, at: TS.Node): TextExpr {
    if (t.kind === "text" || t.kind === "textVar") return t;
    // What is kept here is kept once, where the statement stands — and a loop's condition is worked out again every turn.
    if (this.inLoopCondition > 0) this.c.error(at, "This text is worked out through a value kept on the side, and a loop's condition is worked out again every turn: work it out in the loop's body (or before the loop) into a variable, and test that.");
    const v = this.newVar("(text)", "text", this.at(at), { temp: true, text: "made" });
    this.textKinds.set(v.id, "made");
    this.emit({ kind: "declare", decl: v, init: t, at: this.at(at), label: this.label(at) }, at);
    return { kind: "textVar", id: v.id };
  }

  /** The one character at a place, or nothing past either end: `s[i]`, `s.charAt(i)`, `s.at(i)`. */
  private characterAt(of: TextExpr, index: TS.Expression, fromEnd: boolean, at: TS.Node): TextExpr | null {
    const given = this.num(index);
    if (!given) return null;
    const held = this.textTemp(of, at);
    // A place below zero that is not counted from the end is past the start: nothing.
    if (!fromEnd && given.kind === "const" && given.value < 0) return { kind: "text", text: "" };
    const i = this.temp(given, at);
    const slice = (start: NumExpr): TextExpr => this.mark<TextExpr>({ kind: "textSlice", of: held, start, end: this.mark<NumExpr>({ kind: "binary", op: "+", left: start, right: num(1), at: this.at(at), label: this.label(at) }, at), at: this.at(at), label: this.label(at) }, at);
    if (i.kind === "const") return slice(i);
    if (fromEnd) return slice(this.temp(this.placeInSigned(held, i, at), at));
    return this.mark<TextExpr>({ kind: "textTernary", cond: { kind: "compare", op: "<", left: i, right: num(0), at: this.at(at), label: this.label(at) }, whenTrue: { kind: "text", text: "" }, whenFalse: slice(i), at: this.at(at), label: this.label(at) }, at);
  }

  /** `at(i)`'s place: counted from the end when below zero, and past the end (so: nothing) when that is still below zero. */
  private placeInSigned(of: TextExpr, i: NumExpr, at: TS.Node): NumExpr {
    const length = this.mark<NumExpr>({ kind: "textLength", of, at: this.at(at), label: this.label(at) }, at);
    const back = this.mark<NumExpr>({ kind: "binary", op: "+", left: length, right: i, at: this.at(at), label: this.label(at) }, at);
    const whenBelow = this.mark<NumExpr>({ kind: "ternary", cond: { kind: "compare", op: "<", left: back, right: num(0), at: this.at(at), label: this.label(at) }, whenTrue: length, whenFalse: back, at: this.at(at), label: this.label(at) }, at);
    return this.mark<NumExpr>({ kind: "ternary", cond: { kind: "compare", op: "<", left: i, right: num(0), at: this.at(at), label: this.label(at) }, whenTrue: whenBelow, whenFalse: i, at: this.at(at), label: this.label(at) }, at);
  }

  private static readonly TEXT_METHODS = "slice, substring, at, charAt, indexOf, includes, startsWith, endsWith, padStart, padEnd, repeat, concat, codePointAt, toString and length";

  /** A method of a text that gives a text. Null with a diagnostic. */
  private textCall(e: TS.CallExpression, receiver: TS.Expression, method: string): TextExpr | null {
    const args = e.arguments;
    const wants = (min: number, max: number, how: string): boolean => {
      if (args.length >= min && args.length <= max && !args.some((a) => this.ts.isSpreadElement(a))) return true;
      this.c.error(e, `${method}() takes ${how}.`);
      return false;
    };
    switch (method) {
      case "toString": case "valueOf": return wants(0, 0, "nothing") ? this.text(receiver) : null;
      case "concat": {
        const parts: TextPart[] = [];
        for (const x of [receiver, ...args]) { const p = this.textOf(x); if (!p) return null; parts.push(...p); }
        return this.textFrom(parts, e);
      }
      case "charAt": case "at": {
        if (!wants(1, 1, "the character's place")) return null;
        const of = this.text(receiver);
        return of ? this.characterAt(of, args[0], method === "at", e) : null;
      }
      case "slice": case "substring": {
        if (!wants(0, 2, "where to start and, optionally, where to stop")) return null;
        const given = this.text(receiver);
        if (!given) return null;
        if (args.length === 0) return given;
        const of = this.textTemp(given, e);
        const fromEnd = method === "slice";
        const a = this.num(args[0]);
        const b = args[1] ? this.num(args[1]) : undefined;
        if (!a || b === null) return null;
        let start = this.placeIn(of, a, fromEnd, e);
        let end = b ? this.placeIn(of, b, fromEnd, e) : undefined;
        if (method === "substring" && end) {
          // substring(5, 2) is substring(2, 5).
          const s = this.temp(start, e), t = this.temp(end, e);
          start = this.mark<NumExpr>({ kind: "intrinsic", name: "min", args: [s, t], at: this.at(e), label: this.label(e) }, e);
          end = this.mark<NumExpr>({ kind: "intrinsic", name: "max", args: [s, t], at: this.at(e), label: this.label(e) }, e);
        }
        return this.mark<TextExpr>({ kind: "textSlice", of, start, ...(end ? { end } : {}), at: this.at(e), label: this.label(e) }, e);
      }
      case "padStart": case "padEnd": {
        if (!wants(1, 2, "the length and, optionally, what to fill with")) return null;
        const of = this.text(receiver);
        const width = this.num(args[0]);
        const fill = args[1] ? this.text(args[1]) : ({ kind: "text", text: " " } as TextExpr);
        if (!of || !width || !fill) return null;
        return this.mark<TextExpr>({ kind: "textPad", of, side: method === "padStart" ? "start" : "end", width, with: fill, at: this.at(e), label: this.label(e) }, e);
      }
      case "repeat": {
        if (!wants(1, 1, "how many times")) return null;
        const of = this.text(receiver);
        const count = this.num(args[0]);
        return of && count ? this.mark<TextExpr>({ kind: "textRepeat", of, count, at: this.at(e), label: this.label(e) }, e) : null;
      }
      default:
        this.c.error(e, `${method}() is not something a text of a program does; it has ${Structured.TEXT_METHODS}. A text the script has (nothing of the program in it) takes any method JavaScript has.`);
        return null;
    }
  }

  /**
   * A text of the program: one written out, a variable, a template or texts joined with `+`, `c ? a : b`, a method that
   * gives a text, `String(n)`, a function's result, a text looked up in a list the script has. Null, with a diagnostic.
   */
  private text(expr: TS.Expression): TextExpr | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h && !isGameValue(h.value)) {
      const v = h.value;
      if (typeof v === "string") return this.literalText(v, e);
      if (typeof v === "number" || typeof v === "boolean") return { kind: "text", text: String(v) };
      this.c.error(e, `Expected a text, got ${describe(v)}.`);
      return null;
    }
    const got = ts.isCallExpression(e) ? this.methodCall(e) : this.getterCall(e);
    if (got !== undefined) {
      if (got && got.result?.kind !== "text") { const parts = this.textOf(e); return parts ? this.textFrom(parts, e) : null; }
      return got ? this.mark<TextExpr>({ kind: "textCall", call: got }, e) : null;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "textAt") return this.textAtCells(b, e);
      if (b?.kind === "var" && b.v.kind === "text") return { kind: "textVar", id: b.v.id };
      if (b?.kind === "var") { const parts = this.textOf(e); return parts ? this.textFrom(parts, e) : null; }
    }
    if (ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const parts = this.textOf(e);
      return parts ? this.textFrom(parts, e) : null;
    }
    if (ts.isConditionalExpression(e)) {
      const cond = this.bool(e.condition);
      const whenTrue = this.text(e.whenTrue);
      const whenFalse = this.text(e.whenFalse);
      return whenTrue && whenFalse ? this.mark<TextExpr>({ kind: "textTernary", cond, whenTrue, whenFalse, at: this.at(e), label: this.label(e) }, e) : null;
    }
    if (ts.isElementAccessExpression(e)) {
      // `titles[level]`: a list of texts the script has, the place the program's.
      const list = this.evaluate(e.expression);
      if (list && Array.isArray(list.value)) {
        if (!list.value.every((v) => typeof v === "string")) { this.c.error(e.expression, "A list a program looks a text up in holds texts only."); return null; }
        const table = this.textTable(list.value, e.expression);
        const index = table ? this.num(e.argumentExpression) : null;
        return table && index ? this.mark<TextExpr>({ kind: "textOf", array: table.id, index, at: this.at(e) }, e) : null;
      }
      if (this.isTextTyped(e.expression)) {
        const of = this.text(e.expression);
        return of ? this.characterAt(of, e.argumentExpression, false, e) : null;
      }
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression) && e.expression.text === "String" && !this.gameDeclaration(e.expression)) {
        if (e.arguments.length !== 1) { this.c.error(e, "String() takes the value to write out."); return null; }
        const parts = this.textOf(e.arguments[0]);
        return parts ? this.textFrom(parts, e) : null;
      }
      if (ts.isPropertyAccessExpression(e.expression)) {
        const receiver = e.expression.expression;
        if (this.isTextTyped(receiver)) return this.textCall(e, receiver, e.expression.name.text);
        // `n.toString()`: the number's digits.
        if (e.expression.name.text === "toString" && e.arguments.length === 0) { const parts = this.textOf(receiver); return parts ? this.textFrom(parts, e) : null; }
      }
      let call: Call | undefined;
      if (ts.isIdentifier(e.expression)) {
        const decl = this.gameDeclaration(e.expression);
        if (decl && ts.isFunctionDeclaration(decl)) call = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl);
      }
      if (!call) {
        const callee = this.evaluate(e.expression)?.value;
        if (isGameFunction(callee)) call = this.gameCall(e, callee);
        else if (!ts.isIdentifier(e.expression) || !this.gameDeclaration(e.expression)) { this.notConstant(e, "A call's arguments"); return null; }
      }
      if (!call) return null;
      if (call.result?.kind !== "text") { this.c.error(e, "This function does not return a text."); return null; }
      return this.mark<TextExpr>({ kind: "textCall", call }, e);
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      // `s.at(i) ?? other`: what TypeScript asks for, since at() past either end is undefined there. Any other text is never undefined.
      const left = this.unwrap(e.left);
      if (ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "at" && left.arguments.length === 1 && this.isTextTyped(left.expression.expression)) {
        const given = this.text(left.expression.expression);
        const index = this.num(left.arguments[0]);
        if (!given || !index) return null;
        const of = this.textTemp(given, e);
        const i = this.temp(index, e, true);
        const place = this.temp(this.mark<NumExpr>({ kind: "ternary", cond: { kind: "compare", op: "<", left: i, right: num(0), at: this.at(e), label: this.label(e) }, whenTrue: this.mark<NumExpr>({ kind: "binary", op: "+", left: this.mark<NumExpr>({ kind: "textLength", of, at: this.at(e), label: this.label(e) }, e), right: i, at: this.at(e), label: this.label(e) }, e), whenFalse: i, at: this.at(e), label: this.label(e) }, e), e, true);
        const inside: BoolExpr = { kind: "and", items: [{ kind: "compare", op: ">=", left: place, right: num(0), at: this.at(e), label: this.label(e) }, { kind: "compare", op: "<", left: place, right: this.mark<NumExpr>({ kind: "textLength", of, at: this.at(e), label: this.label(e) }, e), at: this.at(e), label: this.label(e) }] };
        const other = this.text(e.right);
        if (!other) return null;
        const one = this.mark<TextExpr>({ kind: "textSlice", of, start: place, end: this.mark<NumExpr>({ kind: "binary", op: "+", left: place, right: num(1), at: this.at(e), label: this.label(e) }, e), at: this.at(e), label: this.label(e) }, e);
        return this.mark<TextExpr>({ kind: "textTernary", cond: inside, whenTrue: one, whenFalse: other, at: this.at(e), label: this.label(e) }, e);
      }
      return this.text(e.left);
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      // `s || "none"`: the other text when this one is empty.
      const given = this.text(e.left);
      const other = this.text(e.right);
      if (!given || !other) return null;
      const of = this.textTemp(given, e);
      return this.mark<TextExpr>({ kind: "textTernary", cond: { kind: "textCompare", op: "!=", left: of, right: { kind: "text", text: "" }, at: this.at(e), label: this.label(e) }, whenTrue: of, whenFalse: other, at: this.at(e), label: this.label(e) }, e);
    }
    this.c.error(e, "Expected a text: one written out, a text variable, a template, or a method of one.");
    return null;
  }

  /** `s = value`, `s += more` for a text variable. */
  private assignText(e: TS.BinaryExpression, target: VarDecl, op: TS.SyntaxKind) {
    const { ts } = this;
    let value: TextExpr | null;
    if (op === ts.SyntaxKind.EqualsToken) value = this.text(e.right);
    else if (op === ts.SyntaxKind.PlusEqualsToken) { const more = this.textOf(e.right); value = more ? this.textFrom([{ kind: "value", text: { kind: "textVar", id: target.id } }, ...more], e) : null; }
    else { this.c.error(e, "A text takes = and += only."); return; }
    if (!value) return;
    if (target.text === "id" && !textHasId(value, this.keptAs)) { this.c.error(e.right, `${target.name} was taken for a variable that only ever holds texts written in the script, and this one is made while the map is played. Declare it with a made text — let ${target.name} = String(…) — and it is kept the other way.`); return; }
    this.emit({ kind: "assignText", target: target.id, value, at: this.at(e), label: this.label(e) }, e);
  }

  /** A method of a text that gives a number: `indexOf`, `codePointAt`. Undefined when the call is not one. */
  private textNumber(e: TS.CallExpression): NumExpr | null | undefined {
    const { ts } = this;
    if (!ts.isPropertyAccessExpression(e.expression) || !this.isTextTyped(e.expression.expression)) return undefined;
    const method = e.expression.name.text;
    if (method !== "indexOf" && method !== "codePointAt" && method !== "charCodeAt") return undefined;
    const of = this.text(e.expression.expression);
    if (!of) return null;
    if (method === "indexOf") {
      if (e.arguments.length < 1 || e.arguments.length > 2) { this.c.error(e, "indexOf() takes the text to find and, optionally, where to start."); return null; }
      const find = this.text(e.arguments[0]);
      const from = e.arguments[1] ? this.num(e.arguments[1]) : undefined;
      if (!find || from === null) return null;
      return this.mark<NumExpr>({ kind: "textIndexOf", of, find, ...(from ? { from: this.mark<NumExpr>({ kind: "intrinsic", name: "max", args: [from, num(0)], at: this.at(e), label: this.label(e) }, e) } : {}), at: this.at(e), label: this.label(e) }, e);
    }
    if (e.arguments.length !== 1) { this.c.error(e, `${method}() takes the character's place.`); return null; }
    const index = this.num(e.arguments[0]);
    return index ? this.mark<NumExpr>({ kind: "textCode", of, index, at: this.at(e), label: this.label(e) }, e) : null;
  }

  /** A condition over texts: two compared, `startsWith` / `endsWith` / `includes`, a text tested as one (it is not empty). Undefined when the expression is none of those. */
  private textCondition(e: TS.Expression): BoolExpr | undefined {
    const { ts } = this;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && this.isTextTyped(e.expression.expression)) {
      const test = e.expression.name.text;
      if (test !== "startsWith" && test !== "endsWith" && test !== "includes") return undefined;
      if (e.arguments.length !== 1) { this.c.error(e, `${test}() takes the text to look for.`); return FALSE; }
      const of = this.text(e.expression.expression);
      const find = this.text(e.arguments[0]);
      return of && find ? this.mark<BoolExpr>({ kind: "textTest", test, of, find, at: this.at(e), label: this.label(e) }, e) : FALSE;
    }
    if (this.isTextTyped(e) && !ts.isBinaryExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && this.isTextTyped(e))) {
      // `if (s)`: the text is not empty.
      const of = this.text(e);
      return of ? this.mark<BoolExpr>({ kind: "textCompare", op: "!=", left: of, right: { kind: "text", text: "" }, at: this.at(e), label: this.label(e) }, e) : FALSE;
    }
    return undefined;
  }

  /**
   * A text with the program's values in it, as parts: a template literal, texts joined with +,
   * and in them numbers of the program (their digits), name(p), color(p) and anything known
   * when the script is built. Null, with a diagnostic, when a piece is none of those.
   */
  private textOf(expr: TS.Expression): TextPart[] | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h && !isGameValue(h.value)) {
      const v = h.value;
      if (typeof v === "string") return textParts(v);
      if (typeof v === "number" || typeof v === "boolean") return [{ kind: "text", text: String(v) }];
      this.c.error(e, `Expected text or a number, got ${describe(v)}.`);
      return null;
    }
    if (ts.isTemplateExpression(e)) {
      const out: TextPart[] = e.head.text ? [{ kind: "text", text: e.head.text }] : [];
      for (const span of e.templateSpans) {
        const part = this.textOf(span.expression);
        if (!part) return null;
        out.push(...part);
        if (span.literal.text) out.push({ kind: "text", text: span.literal.text });
      }
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && this.isText(e)) {
      const l = this.textOf(e.left);
      const r = this.textOf(e.right);
      return l && r ? [...l, ...r] : null;
    }
    if (this.isTextTyped(e)) { const t = this.text(e); return t ? this.partsOf(t) : null; }
    if (this.kindOf(this.c.checker.getTypeAtLocation(e)) === "boolean") { this.c.error(e, "A boolean has no text of its own: write flag ? \"yes\" : \"no\" with both texts known when the script is built, or show a number."); return null; }
    const value = this.num(e);
    return value ? [{ kind: "number", expr: value }] : null;
  }

  private isText(e: TS.Expression): boolean {
    return this.isTextTyped(e);
  }

  /** `print(text, { to: P2, position: "center" })` with the program's values in the text. */
  private printStatement(e: TS.CallExpression) {
    if (e.arguments.length < 1 || e.arguments.length > 2) { this.c.error(e, "print() takes the text and, optionally, { to, position }."); return; }
    let to = CURRENT_PLAYER;
    let position: "chat" | "center" = "chat";
    if (e.arguments[1]) {
      const h = this.evaluate(e.arguments[1]);
      if (!h) { this.notConstant(e.arguments[1], "print()'s options"); return; }
      // The library checks the options: print("", options) is the same call without the text.
      const probe = (this.evaluate(e.expression)!.value as (...a: unknown[]) => unknown)("", h.value);
      if (!isPrint(probe)) return;
      to = probe.to;
      position = probe.position;
    }
    const parts = this.textOf(e.arguments[0]);
    if (parts) this.emitPrint(parts, to, position, e);
  }

  /** `centerLocation(locations.Cursor, at.x, at.y)`: the location known when the script is built, the point the program's. */
  private centerLocation(e: TS.CallExpression) {
    if (e.arguments.length !== 3) { this.c.error(e, "centerLocation() takes the location and the point: centerLocation(locations.Cursor, x, y)."); return; }
    const h = this.evaluate(e.arguments[0]);
    if (!h || isGameValue(h.value)) { this.notConstant(e.arguments[0], "The location"); return; }
    const location = h.value;
    if (typeof location !== "number" || !Number.isInteger(location) || location < 1 || location > 255 || location === 64) { this.c.error(e.arguments[0], "centerLocation() takes one of locations.*, which is moved (not Anywhere)."); return; }
    const x = this.num(e.arguments[1]);
    const y = this.num(e.arguments[2]);
    if (x && y) this.emit({ kind: "centerLocation", location, x, y, at: this.at(e), label: this.label(e) }, e);
  }

  /** `sleep(seconds(2))`: the duration is a build-time value; what it makes of it is the target's. */
  private sleepStatement(call: TS.CallExpression) {
    if (this.inCallback > 0) { this.c.error(call, "sleep() inside a function given to an array method: the method is one loop within the frame. A for…of over the same list can sleep between its turns."); return; }
    if (call.arguments.length !== 1) { this.c.error(call, "sleep() takes one duration: sleep(seconds(2)), sleep(minutes(1)) or sleep(frames(5))."); return; }
    const h = this.evaluate(call.arguments[0]);
    if (!h) { this.notConstant(call.arguments[0], "A duration"); return; }
    if (!isDuration(h.value)) { this.c.error(call.arguments[0], `sleep() takes a duration from seconds(), minutes() or frames(), got ${describe(h.value)}.`); return; }
    const d = h.value;
    this.emit({ kind: "sleep", ...(d.cycles !== undefined ? { cycles: d.cycles } : {}), ...(d.ms !== undefined ? { ms: d.ms } : {}), at: this.at(call), label: this.label(call) }, call);
  }

  private expressionStatement(expr: TS.Expression) {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) { this.hoistedStatement(e, h); return; }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken && (ts.isArrayLiteralExpression(this.unwrap(e.left)) || ts.isObjectLiteralExpression(this.unwrap(e.left)))) {
        // `[a, b] = [b, a]`, `({ x, y } = p)`: every value taken first, then every store.
        const from = this.patternSource(e.right, e);
        if (!from) return;
        const stores: (() => void)[] = [];
        if (this.assignPattern(this.unwrap(e.left), from, stores)) stores.forEach((store) => store());
        return;
      }
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        const member = this.unitMember(e.left);
        if (member) { this.unitAssign(e, member, op); return; }
        const cell = this.evaluate(e.left)?.value;
        if (isTable(cell)) { this.tableAssign(e, cell, op); return; }
        const left = this.unwrap(e.left);
        if (ts.isPropertyAccessExpression(left) && left.name.text === "length") {
          const b = this.arrayOf(left.expression);
          if (b?.kind === "lists") {
            // The rows that go give their blocks back first.
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array's length takes = only: xs.length = 0 empties it."); return; }
            for (const a of this.handlesOf(b)) if (!this.grows(a, e.left)) return;
            const given = this.num(e.right);
            if (!given) return;
            const n = this.temp(given, e, true);
            this.releaseRows(b, n, e);
            for (const a of this.handlesOf(b)) this.emit({ kind: "setLength", array: a.id, value: n, at: this.at(e), label: this.label(e) }, e);
            return;
          }
          if (b?.kind === "grid") {
            // Whole rows: the flat array's length is the rows' by the cells of a row.
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array's length takes = only: xs.length = 0 empties it."); return; }
            if (b.offset) { this.c.error(e, `${b.name} is a part of a larger array of arrays; its length is the whole's to set.`); return; }
            if (!this.grows(b.a, e.left)) return;
            const rows = this.num(e.right);
            if (rows) this.emit({ kind: "setLength", array: b.a.id, value: this.scaled(rows, b.dims.slice(1).reduce((n, d) => n * d, 1), null, e), at: this.at(e), label: this.label(e) }, e);
            return;
          }
          if (b?.kind === "records" || b?.kind === "units") {
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array's length takes = only: xs.length = 0 empties it."); return; }
            const value = this.num(e.right);
            if (!value) return;
            const n = this.temp(value, e, b.kind === "records" && !!b.shape);
            if (b.kind === "records") this.releaseFrom(b, n, e);
            for (const a of b.kind === "units" ? [b.ptr, b.epd, b.uid] : b.fields.values()) { a.dynamic = true; this.emit({ kind: "setLength", array: a.id, value: n, at: this.at(e), label: this.label(e) }, e); }
            return;
          }
          if (b?.kind === "array") {
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array's length takes = only: xs.length = 0 empties it."); return; }
            if (!this.grows(b.a, e.left)) return;
            const value = this.num(e.right);
            if (value) this.emit({ kind: "setLength", array: b.a.id, value, at: this.at(e), label: this.label(e) }, e);
            return;
          }
        }
        if (ts.isElementAccessExpression(left)) {
          // `grid[y] = [0, 0, 0]`: the row's cells, every one read before any is stored.
          const row = this.bindingOf(left);
          if (row?.kind === "inner") {
            // `buckets[i] = [a, b]`: the row starts over with these — what it held goes back first. (Worked out before that, so `[...]` of its own cells would be lost: a row is not assigned from itself.)
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "A row takes = only."); return; }
            const inner = this.innerOf(row.lists, row.index, e);
            this.emit({ kind: "declareArray", array: inner.id, init: [], at: this.at(e), label: this.label(e) }, e);
            this.fillInner(inner, row.lists.of, e.right);
            return;
          }
          if (row?.kind === "row") {
            const grid = this.bindingOf(left.expression);
            const cells = op === ts.SyntaxKind.EqualsToken && grid?.kind === "grid" ? this.rowCells(grid, e.right) : null;
            if (op !== ts.SyntaxKind.EqualsToken) this.c.error(e, "A row takes = only.");
            if (!cells) return;
            const start = this.temp(row.offset, e);
            const held = cells.map((v) => (v.kind === "const" ? v : (() => { const t = this.newVar("(cell)", row.a.kind, this.at(e), { temp: true }); this.emit({ kind: "declare", decl: t, init: v, at: this.at(e), label: this.label(e) }, e); return row.a.kind === "number" ? varRef(t) : boolRef(t); })()));
            held.forEach((v, k) => this.emit({ kind: "store", array: row.a.id, index: this.scaled(num(k), 1, start, e), value: v, at: this.at(e), label: this.label(e) }, e));
            return;
          }
          const el = this.elementOf(left);
          if (el === null) return;
          if (el) { this.storeElement(e, el, op); return; }
        }
        if (ts.isElementAccessExpression(left)) {
          const squad = this.arrayOf(left.expression);
          if (squad?.kind === "units") {
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "A unit takes = only."); return; }
            const found = this.unitExpr(e.right);
            const at = this.evaluate(left.argumentExpression);
            const index = at ? (() => { const i = this.asInteger(at, left.argumentExpression); return i === null ? null : num(i); })() : this.num(left.argumentExpression);
            if (!found || !index) return;
            const unit = this.unitTemp(found, e.right);
            const i = this.temp(index, e);
            for (const [a, part] of this.unitArrays(squad)) this.emit({ kind: "store", array: a.id, index: i, value: { kind: "unitPart", unit, part, at: this.at(e) }, at: this.at(e), label: this.label(e) }, e);
            return;
          }
        }
        if (this.setterCall(e, op)) return;
        const field = this.bindingOf(e.left);
        if (field?.kind === "textAt") {
          // `waves[i].name = …`, `+= …`: the text worked out — from what the cells hold, for `+=` — and stored, the cells' old block going back.
          if (op !== ts.SyntaxKind.EqualsToken && op !== ts.SyntaxKind.PlusEqualsToken) { this.c.error(e, "A text takes = and +=."); return; }
          const given = op === ts.SyntaxKind.EqualsToken ? this.text(e.right) : (() => { const more = this.textOf(e.right); return more ? this.textFrom([{ kind: "value", text: this.textAtCells(field, e.left) }, ...more], e) : null; })();
          if (given) this.storeTextAt({ ...field, index: this.temp(field.index, e) }, given, e);
          return;
        }
        if (field?.kind === "unitAt") {
          if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "A unit takes = only."); return; }
          const value = this.unitExpr(e.right);
          if (value) this.storeUnitAt(field, value, e);
          return;
        }
        if (field && (field.kind === "inner" || field.kind === "innerUnits" || ((field.kind === "array" || field.kind === "units") && ts.isPropertyAccessExpression(left)))) { this.assignList(e, field, op); return; }
        if (field?.kind === "cell") { this.storeElement(e, { a: field.a, index: field.index }, op); return; }
        if (field?.kind === "records" || (ts.isElementAccessExpression(left) && this.bindingOf(left.expression)?.kind === "records")) { this.storeRow(e, op); return; }
        const target = this.varOf(e.left);
        const rowVar = target ? undefined : (() => { const b = this.bindingOf(e.left); return b ? this.rowVars.get(b) : undefined; })();
        if (rowVar) {
          // Another row of the same array: the class of an instance is settled when the script is built, and so is the array a row is of.
          const given = this.unwrap(e.right);
          const from = ts.isElementAccessExpression(given) && this.bindingOf(given.expression) === rowVar.of ? this.rowIndex(rowVar.of, given.argumentExpression) : (() => { const other = this.bindingOf(given); const r = other ? this.rowVars.get(other) : undefined; return r?.of === rowVar.of ? varRef(r.place) : undefined; })();
          if (op !== ts.SyntaxKind.EqualsToken || from === undefined) { this.c.error(e, `This is a row of ${rowVar.of.name}, and can be given another row of it: = ${rowVar.of.name}[i]. Which array a row is of, and which class an instance is, are settled when the script is built.`); return; }
          if (from) this.emit({ kind: "assign", target: rowVar.place.id, value: from, at: this.at(e), label: this.label(e) }, e);
          return;
        }
        if (!target) {
          const b = this.bindingOf(e.left);
          if (b?.kind === "array") { this.c.error(e.left, `An array is assigned cell by cell: ${b.a.name}[i] = 3.`); return; }
          if (b?.kind === "record") this.c.error(e.left, "A record is assigned field by field: p.lives = 3.");
          else if ((ts.isPropertyAccessExpression(this.unwrap(e.left)) || ts.isElementAccessExpression(this.unwrap(e.left))) && this.evaluate(e.left)) this.c.error(e.left, "This object is computed when the script is built. Declare it with let inside the program to make it a record of variables.");
          else this.c.error(e.left, "Only the program's let variables can be assigned.");
          return;
        }
        if (target.kind === "unit") {
          if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "A unit takes = only."); return; }
          const value = this.unitExpr(e.right);
          if (value) this.emit({ kind: "assignUnit", target: target.id, value, at: this.at(e), label: this.label(e) }, e);
          return;
        }
        if (target.kind === "text") { this.assignText(e, target, op); return; }
        if (target.kind !== "number") {
          if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "Booleans take = only."); return; }
          this.emit({ kind: "assignBool", target: target.id, value: this.boolValue(e.right), at: this.at(e), label: this.label(e) }, e);
          return;
        }
        if (op === ts.SyntaxKind.EqualsToken) {
          const value = this.num(e.right);
          if (value) this.emit({ kind: "assign", target: target.id, value, at: this.at(e), label: this.label(e) }, e);
          return;
        }
        const arith = compoundOp(ts, op);
        if (!arith) { this.c.error(e, "Only = += -= *= /= %= &= |= ^= <<= >>= >>>= assign a number."); return; }
        const rhs = this.num(e.right);
        if (!rhs) return;
        this.emit({ kind: "assign", target: target.id, value: this.mark({ kind: "binary", op: arith, left: varRef(target), right: rhs, at: this.at(e), label: this.label(e) }, e), at: this.at(e), label: this.label(e) }, e);
        return;
      }
      this.c.error(e, "Only assignments and calls can stand as statements.");
      return;
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
      const op = e.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
      const member = this.unitMember(e.operand);
      const cell = member ? undefined : this.evaluate(e.operand)?.value;
      if (member || isTable(cell)) {
        // u.kills++, stats(units.TerranMarine).minerals--: the field read, moved by one, written back.
        const now = this.num(e.operand);
        if (!now) return;
        const value = this.mark<NumExpr>({ kind: "binary", op, left: now, right: num(1), at: this.at(e), label: this.label(e) }, e);
        if (member) this.unitWrite(e, member, value);
        else this.tableWrite(e, cell as TableValue, value);
        return;
      }
      const operand = this.unwrap(e.operand);
      const fieldCell = this.bindingOf(operand);
      const el = fieldCell?.kind === "cell" ? { a: fieldCell.a, index: fieldCell.index } : ts.isElementAccessExpression(operand) ? this.elementOf(operand) : undefined;
      if (el === null) return;
      if (el) {
        if (el.a.kind !== "number") { this.c.error(e, "++ / -- apply to numbers."); return; }
        if (el.a.values) { this.c.error(e, `${el.a.name} was computed when the script was built and is only read in a program; declare it with let inside the program to write to it.`); return; }
        const now: NumExpr = { kind: "element", array: el.a.id, index: el.index, at: this.at(e) };
        this.emit({ kind: "store", array: el.a.id, index: el.index, value: this.mark<NumExpr>({ kind: "binary", op, left: now, right: num(1), at: this.at(e), label: this.label(e) }, e), at: this.at(e), label: this.label(e) }, e);
        return;
      }
      const target = this.varOf(e.operand);
      if (!target || target.kind !== "number") { this.c.error(e, "++ / -- apply to number variables."); return; }
      const value = this.mark<NumExpr>({ kind: "binary", op: e.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", left: varRef(target), right: num(1), at: this.at(e), label: this.label(e) }, e);
      this.emit({ kind: "assign", target: target.id, value, at: this.at(e), label: this.label(e) }, e);
      return;
    }
    if (ts.isCallExpression(e)) { this.callStatement(e); return; }
    this.c.error(e, "Only assignments and calls can stand as statements.");
  }

  /** A call standing as a statement: a function of the body, a game function, an action with a variable amount, or a game call. */
  private callStatement(e: TS.CallExpression) {
    const { ts } = this;
    if (e.expression.kind === ts.SyntaxKind.SuperKeyword) { this.superCall(e); return; }
    const method = this.methodCall(e);
    if (method !== undefined) { if (method) this.emit({ kind: "call", call: method, at: method.at, label: method.label }, e); return; }
    if (ts.isIdentifier(e.expression)) {
      const decl = this.gameDeclaration(e.expression);
      if (decl) {
        if (ts.isFunctionDeclaration(decl)) { const call = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl); if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e); return; }
        this.c.error(e, `${e.expression.text} is not a function.`);
        return;
      }
    }
    if (ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      if (method === "forEach" || SEARCHES.has(method)) {
        const over = this.overOf(e.expression.expression);
        if (over && method === "forEach") { this.forEachCall(e, over); return; }
        if (over) { this.c.error(e, `${this.overName(over)}.${method}(…) is a value: use it in an if or store it.`); return; }
      }
      if (LIST_MAKERS.has(method) && this.makesList(e)) { this.madeList(e, undefined, e); return; }
      const list = this.arrayOf(e.expression.expression);
      if (list?.kind === "grid") { this.gridCall(e, list, method); return; }
      if (list?.kind === "lists") { this.listsCall(e, list, method); return; }
      if (list?.kind === "array") { this.arrayCall(e, list.a, e.expression.name.text, "statement"); return; }
      if (list?.kind === "records") { this.recordsCall(e, list, e.expression.name.text); return; }
      if (list?.kind === "units") { this.unitsCall(e, list, e.expression.name.text); return; }
      if (list?.kind === "hash") {
        if (method === "forEach") { this.hashForEach(e, list); return; }
        this.hashMethod(e, list, method, "statement");
        return;
      }
      const made = list?.kind === "keyed" ? list : !list && e.arguments.length && !this.evaluate(e.arguments[0]) ? this.collectionOf(e.expression.expression) : undefined;
      if (made) { this.keyedCall(e, made, e.expression.name.text, "statement"); return; }
      const member = this.unitMember(e.expression);
      if (member) { this.unitCall(e, member); return; }
    }
    if (this.isLibraryCall(e, "random")) { this.c.error(e, "random() does nothing on its own; test it in an if, or assign it to a variable."); return; }
    if (this.isLibraryCall(e, "sleep")) { this.sleepStatement(e); return; }
    if (this.isLibraryCall(e, "rose") || this.isLibraryCall(e, "once")) { this.c.error(e, "rose() / once() are conditions: test them in an if."); return; }
    if (this.isLibraryCall(e, "shared")) { this.c.error(e, "shared() goes on a declaration: let total = shared(0)."); return; }
    if (this.isLibraryCall(e, "print")) { this.printStatement(e); return; }
    if (this.isLibraryCall(e, "centerLocation")) { this.centerLocation(e); return; }
    if (this.isLibraryCall(e, "keyPressed") || this.isLibraryCall(e, "clicked") || this.isLibraryCall(e, "mouse") || this.isLibraryCall(e, "chatted")) { this.c.error(e, "This asks what a player did and does nothing on its own: test it in an if, or keep it in a const."); return; }
    const callee = this.evaluate(e.expression)?.value;
    if (isGameFunction(callee)) { const call = this.gameCall(e, callee); if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e); return; }
    if (isReader(callee) || (isBuilder(callee) && callee.kind === "condition" && READ_ARITY.get(callee.ident) === e.arguments.length)) { this.c.error(e, "This reads a value and does nothing on its own: assign it to a variable, or compare it in an if."); return; }
    if (isBuilder(callee)) {
      if (callee.kind === "action" && callee.def.type === ActionType.DisplayText && e.arguments[0] && !this.evaluate(e.arguments[0])) {
        // displayText(`${gold} gold`): the text has the program's values in it, so it is printed, for the current player as displayText is.
        const parts = this.textOf(e.arguments[0]);
        if (parts) this.emitPrint(parts, CURRENT_PLAYER, "chat", e);
        return;
      }
      if (callee.kind === "action") { this.actionWithVars(e, callee.ident, callee.def as Parameters<typeof scriptParams>[0]); return; }
      this.c.error(e, "This is a condition; test it in an if or a while.");
      return;
    }
    this.notConstant(e, "A call's arguments");
  }

  /* ── Control flow ── */

  /** A condition known when the script is built (a hoisted boolean, number or text): true, false, or undefined when it must be tested in the game. */
  private knownCondition(expr: TS.Expression): boolean | undefined {
    const h = this.evaluate(expr);
    if (!h) return undefined;
    const v = h.value;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v !== "";
    return undefined;
  }

  private ifStatement(s: TS.IfStatement, ctx: Ctx) {
    const known = this.knownCondition(s.expression);
    if (known !== undefined) {
      // Known when the script is built: only the side that runs is compiled, and the other is never evaluated either.
      const live = known ? s.thenStatement : s.elseStatement;
      if (live) this.statement(live, ctx);
      return;
    }
    const cond = this.bool(s.expression);
    if (cond.kind === "const" && !cond.value) {
      // The condition failed to compile: as before, the then side is not walked and the else side is what remains.
      if (s.elseStatement) this.statement(s.elseStatement, ctx);
      return;
    }
    const then = this.sub(s.thenStatement, ctx);
    const otherwise = s.elseStatement ? this.sub(s.elseStatement, ctx) : undefined;
    this.emit({ kind: "if", cond, then, ...(otherwise ? { else: otherwise } : {}), at: this.at(s), label: this.label(s) }, s);
  }

  /** A loop condition known false when the script is built: the loop is not compiled at all. */
  private neverRuns(condition: TS.Expression | undefined): boolean {
    if (!condition) return false;
    const h = this.evaluate(condition);
    return !!h && !h.value && !isCondition(h.value);
  }

  /** A loop's test: absent for `while (true)` and any condition known true when the script is built. */
  private loopCondition(condition: TS.Expression | undefined): BoolExpr | undefined {
    if (!condition) return undefined;
    const known = this.knownCondition(condition);
    if (known === true) return undefined;
    this.inLoopCondition++;
    try { return this.bool(condition); } finally { this.inLoopCondition--; }
  }

  private whileStatement(s: TS.WhileStatement, ctx: Ctx) {
    if (this.neverRuns(s.expression)) return;
    const cond = this.loopCondition(s.expression);
    const body = this.sub(s.statement, { fn: ctx.fn, canBreak: true, canContinue: true });
    this.emit({ kind: "while", ...(cond ? { cond } : {}), body, at: this.at(s), label: this.label(s) }, s);
  }

  private doStatement(s: TS.DoStatement, ctx: Ctx) {
    const body = this.sub(s.statement, { fn: ctx.fn, canBreak: true, canContinue: true });
    this.inLoopCondition++;
    let cond: BoolExpr;
    try { cond = this.bool(s.expression); } finally { this.inLoopCondition--; }
    const condLabel = `L${this.line(s)}: while (${s.expression.getText(this.body.sf).replace(/\s+/g, " ")})`;
    this.emit({ kind: "do", body, cond, at: this.at(s), label: this.label(s), condLabel }, s);
  }

  /**
   * `for (let i = 0; i < 3; i++)` with the start, the bound and the step known when the
   * script is built, and `i` never assigned in the body: unrolled like a `for…of`, `i`
   * bound to each value in turn — the loop runs in the cycle it is reached in, as the
   * source reads, and `i` is no variable of the program. Null when the loop is not of that form.
   */
  private unrollable(s: TS.ForStatement): { decl: TS.VariableDeclaration; values: number[] } | null {
    const { ts } = this;
    if (!s.initializer || !ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1 || !s.condition || !s.incrementor) return null;
    const decl = s.initializer.declarations[0];
    if (!ts.isIdentifier(decl.name) || !decl.initializer) return null;
    const isVar = (e: TS.Expression) => { const u = this.unwrap(e); return ts.isIdentifier(u) && declarationOf(ts, this.c.checker, u) === decl; };
    const integer = (e: TS.Expression): number | null => { const h = this.evaluate(e); return h && typeof h.value === "number" && Number.isInteger(h.value) ? h.value : null; };
    const start = integer(decl.initializer);
    if (start === null) return null;
    const cond = this.unwrap(s.condition);
    if (!ts.isBinaryExpression(cond)) return null;
    let op = compareOp(ts, cond.operatorToken.kind);
    if (!op) return null;
    let bound: number | null;
    if (isVar(cond.left)) bound = integer(cond.right);
    else if (isVar(cond.right)) { bound = integer(cond.left); op = flipOp(op); }
    else return null;
    if (bound === null) return null;
    const inc = this.unwrap(s.incrementor);
    let step: number | null = null;
    if ((ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) && isVar(inc.operand)) step = inc.operator === ts.SyntaxKind.PlusPlusToken ? 1 : inc.operator === ts.SyntaxKind.MinusMinusToken ? -1 : null;
    else if (ts.isBinaryExpression(inc) && isVar(inc.left) && (inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || inc.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)) {
      const k = integer(inc.right);
      if (k !== null) step = inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? k : -k;
    }
    if (step === null || step === 0) return null;
    if (this.assigns(s.statement, decl)) return null;
    const values: number[] = [];
    for (let i = start; compareNumbers(i, op, bound); i += step) {
      values.push(i);
      if (values.length > MAX_UNROLL) throw new LowerError(`This for loop unrolls to more than ${MAX_UNROLL} iterations. Loop over a variable instead — let i = 0; while (i < ${bound}) { …; i++ } is a loop in the game, not ${MAX_UNROLL} copies of its body — or make the bound smaller.`);
    }
    return { decl, values };
  }

  private forStatement(s: TS.ForStatement, ctx: Ctx) {
    const { ts } = this;
    const unrolled = this.unrollable(s);
    if (unrolled) {
      this.emit({ kind: "remark", text: `Unrolled: ${unrolled.values.length} iteration${unrolled.values.length === 1 ? "" : "s"}, the loop variable a value known when the script is built.`, short: `unrolled ×${unrolled.values.length}`, at: this.at(s) }, s);
      this.unrolledLoop(unrolled.decl, unrolled.values, s.statement, s, ctx);
      return;
    }
    const outer = this.scope;
    this.scope = new Scope(outer);
    if (s.initializer) {
      if (ts.isVariableDeclarationList(s.initializer)) this.declare(s.initializer);
      else this.expressionStatement(s.initializer);
    }
    if (this.neverRuns(s.condition)) { this.scope = outer; return; }
    const cond = this.loopCondition(s.condition);
    const body = this.sub(s.statement, { fn: ctx.fn, canBreak: true, canContinue: true });
    const update = s.incrementor ? this.collect(() => this.expressionStatement(s.incrementor!)) : [];
    this.scope = outer;
    this.emit({ kind: "for", ...(cond ? { cond } : {}), update, body, at: this.at(s), label: this.label(s) }, s);
  }

  /** The body compiled once per value, the declaration bound to that value; `break` leaves, `continue` goes on with the next. */
  private unrolledLoop(decl: TS.Node, values: unknown[], body: TS.Statement, s: TS.Node, ctx: Ctx) {
    const iterations: Stmt[][] = [];
    for (const item of values) {
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "value", value: item });
      iterations.push(this.collect(() => this.block([body], { fn: ctx.fn, canBreak: true, canContinue: true }, scope)));
    }
    this.emit({ kind: "unrolled", iterations, at: this.at(s), label: this.label(s) }, s);
  }

  /**
   * `for (const w of waves)` over a list known when the script is built: unrolled, the body
   * compiled once per element with `w` bound to that element's value.
   */
  /**
   * `for (const k of seen)`, `for (const [k, v] of lost)`, `for (const k of lost.keys())`: every id there is, in order, the
   * body for those that are present — k and v copies, as they are in TypeScript, so the body may set and delete as it goes.
   * False when the loop is not over a Map or a Set.
   */
  private keyedLoop(s: TS.ForOfStatement, decl: TS.VariableDeclaration, ctx: Ctx): boolean {
    const { ts } = this;
    let source = this.unwrap(s.expression);
    let part: "keys" | "values" | "entries" | undefined;
    if (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression) && source.arguments.length === 0 && ["keys", "values", "entries"].includes(source.expression.name.text)) {
      part = source.expression.name.text as "keys" | "values" | "entries";
      source = this.unwrap(source.expression.expression);
    }
    const bound = this.bindingOf(source);
    if (bound?.kind === "hash") {
      // A Map or a Set over any number: its entries in the order they went in.
      const h = bound;
      const what = part ?? (h.as === "map" ? "entries" : "keys");
      const keysOnly = h.as === "set" || what === "keys";
      const scope = new Scope(this.scope);
      const names: { node: TS.Node; of: "key" | "value" }[] = [];
      if (ts.isIdentifier(decl.name)) {
        if (what === "entries" && h.as === "map") { this.c.error(decl.name, `A Map gives a key and a value a turn: for (const [key, value] of ${h.name}).`); return true; }
        names.push({ node: decl, of: keysOnly ? "key" : "value" });
      } else if (ts.isArrayBindingPattern(decl.name) && what === "entries") {
        const [k, v] = decl.name.elements;
        if (k && ts.isBindingElement(k) && ts.isIdentifier(k.name)) names.push({ node: k, of: "key" });
        if (v && ts.isBindingElement(v) && ts.isIdentifier(v.name)) names.push({ node: v, of: h.as === "map" ? "value" : "key" });
      } else { this.c.error(decl.name, `for…of over ${h.name} takes ${h.as === "map" ? "[key, value]" : "one variable"}.`); return true; }
      this.hashLoop(h, s, (key, value) => {
        for (const n of names) scope.bind(n.node, { kind: "var", v: n.of === "key" || !value ? key : value });
        this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope);
      });
      return true;
    }
    const table = bound?.kind === "keyed" ? bound : undefined;
    if (!table) return false;
    if (table.as === "record" || !table.present) { this.c.error(s.expression, `${table.name} is a Record: it has a value for every key, so there is nothing to go through. A Map or a Set knows which keys it has.`); return true; }
    part ??= table.as === "map" ? "entries" : "keys";
    if ((part !== "keys" && table.as === "set") || (part !== "keys" && !table.values)) part = "keys";
    const at = this.at(s);
    const label = this.label(s);
    const i = this.newVar(`(key of ${table.name})`, "number", at, { temp: true });
    const scope = new Scope(this.scope);
    const declared: Stmt[] = [];
    const bindKey = (node: TS.Node, name: string) => { const k = this.newVar(name, "number", this.sourceOf(node)); declared.push({ kind: "declare", decl: k, init: varRef(i), at, label }); scope.bind(node, { kind: "var", v: k }); };
    const bindValue = (node: TS.Node, name: string) => {
      const a = table.values!;
      const v = this.newVar(name, a.kind, this.sourceOf(node), { ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) });
      declared.push({ kind: "declare", decl: v, init: { kind: "element", array: a.id, index: varRef(i), at }, at, label });
      scope.bind(node, { kind: "var", v });
    };
    if (ts.isIdentifier(decl.name)) {
      if (part === "entries") { this.c.error(decl.name, `A Map gives a key and a value a turn: for (const [key, value] of ${table.name}).`); return true; }
      if (part === "keys") bindKey(decl, decl.name.text); else bindValue(decl, decl.name.text);
    } else if (ts.isArrayBindingPattern(decl.name) && part === "entries") {
      const [k, v] = decl.name.elements;
      if (k && ts.isBindingElement(k) && ts.isIdentifier(k.name)) bindKey(k, k.name.text);
      if (v && ts.isBindingElement(v) && ts.isIdentifier(v.name)) bindValue(v, v.name.text);
    } else {
      this.c.error(decl.name, `for…of over ${table.name} takes ${table.as === "map" ? "[key, value]" : "one variable"}.`);
      return true;
    }
    const inner = this.collect(() => { for (const d of declared) this.emit(d, s); this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope); });
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, s);
    this.emit({ kind: "remark", text: `goes through ${table.domain} keys`, short: `${table.domain} keys`, at, label } as Stmt, s);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: num(table.domain), at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }],
      body: [{ kind: "if", cond: { kind: "element", array: table.present.id, index: varRef(i), at }, then: inner, at, label }], at, label }, s);
    return true;
  }

  private forOfStatement(s: TS.ForOfStatement, ctx: Ctx) {
    const { ts } = this;
    if (s.awaitModifier) { this.c.error(s, "for await is not supported in a program."); return; }
    const decl = ts.isVariableDeclarationList(s.initializer) && s.initializer.declarations.length === 1 ? s.initializer.declarations[0] : undefined;
    if (decl && this.keyedLoop(s, decl, ctx)) return;
    if (!decl) { this.c.error(s.initializer, "for…of takes one variable: for (const w of waves) { … }."); return; }
    if (!ts.isIdentifier(decl.name)) {
      // `for (const { count, delay } of waves)`: the loop forEach would be, the item taken apart at the top of each turn.
      const pattern = decl.name;
      const list = this.overOf(s.expression);
      if (!list) { this.notConstant(s.expression, "What a for…of loop runs over"); return; }
      const scope = new Scope(this.scope);
      this.loopOf(list, s, "(item)", (item) => {
        const outer = this.scope;
        this.scope = scope;
        try { if (this.bindPattern(pattern, decl, item, scope)) this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, new Scope(scope)); } finally { this.scope = outer; }
      });
      return;
    }
    if (this.isTextTyped(s.expression) && !this.evaluate(s.expression)) {
      // `for (const ch of s)`: the text walked once, a character a turn.
      const of = this.text(s.expression);
      if (!of) return;
      const v = this.newVar(decl.name.text, "text", this.sourceOf(decl.name), { text: "made" });
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "var", v });
      const body = this.collect(() => this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope));
      this.emit({ kind: "textLoop", decl: v, of, body, at: this.at(s), label: this.label(s) }, s);
      return;
    }
    const over = this.listOf(s.expression);
    if (over?.kind === "grid" || over?.kind === "lists") {
      const scope = new Scope(this.scope);
      this.loopOf(over, s, decl.name.text, (row) => { scope.bind(decl, row); this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope); });
      return;
    }
    if (over?.kind === "units") {
      // The unit of the turn is a variable of its own, taken from the three cells: a unit is a reference whichever way it is held.
      const i = this.newVar(`(index of ${over.name})`, "number", this.at(s), { temp: true });
      const v = this.newVar(decl.name.text, "unit", this.sourceOf(decl.name));
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "var", v });
      const at = this.at(s);
      const label = this.label(s);
      const body = this.collect(() => {
        this.emit({ kind: "declare", decl: v, init: this.unitAtIndex(over, varRef(i), s), at, label }, s);
        this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope);
      });
      this.emit({ kind: "declare", decl: i, init: num(0), at, label }, s);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: over.ptr.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body, at, label }, s);
      return;
    }
    if (over?.kind === "records") {
      // The record of the turn is the array's own, as an object of a TypeScript array is: what the body writes through it stays.
      const first = [...over.fields.values()][0];
      const i = this.newVar(`(index of ${over.name})`, "number", this.at(s), { temp: true });
      const scope = new Scope(this.scope);
      scope.bind(decl, this.rowOf(over, varRef(i)));
      const at = this.at(s);
      const label = this.label(s);
      const body = this.collect(() => this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope));
      this.emit({ kind: "declare", decl: i, init: num(0), at, label }, s);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: first.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body, at, label }, s);
      return;
    }
    if (over?.kind === "array") {
      // An array of the program: a loop the game runs, the variable a copy of the cell of the turn, as TypeScript's is.
      const a = over.a;
      const i = this.newVar(`(index of ${a.name})`, "number", this.at(s), { temp: true });
      const v = this.newVar(decl.name.text, a.kind, this.sourceOf(decl.name), { ...(a.bits ? { bits: a.bits } : {}), ...(a.unsigned ? { unsigned: true } : {}) });
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "var", v });
      const at = this.at(s);
      const label = this.label(s);
      const cell = { kind: "element" as const, array: a.id, index: varRef(i), at };
      const body = this.collect(() => {
        this.emit({ kind: "declare", decl: v, init: cell, at, label }, s);
        this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope);
      });
      this.emit({ kind: "declare", decl: i, init: num(0), at, label }, s);
      this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: a.id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body, at, label }, s);
      return;
    }
    const h = this.evaluate(s.expression);
    if (!h) { this.notConstant(s.expression, "What a for…of loop runs over"); return; }
    if (isUnitQuery(h.value)) {
      // The units of the game: a loop the game runs, the variable the unit of the turn.
      const v = this.newVar(decl.name.text, "unit", this.sourceOf(decl.name));
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "var", v });
      const body = this.collect(() => this.block([s.statement], { fn: ctx.fn, canBreak: true, canContinue: true }, scope));
      this.emit({ kind: "unitLoop", decl: v, filter: { ...h.value.filter }, body, at: this.at(s), label: this.label(s) }, s);
      return;
    }
    let items: unknown[];
    try {
      const iterable = typeof h.value === "string" || (typeof h.value === "object" && h.value !== null && Symbol.iterator in h.value);
      if (!iterable) { this.c.error(s.expression, `for…of runs over a list, got ${describe(h.value)}.`); return; }
      items = Array.from(h.value as Iterable<unknown>);
    } catch (err) {
      this.c.error(s.expression, `for…of: ${(err as Error).message}`);
      return;
    }
    this.unrolledLoop(decl, items, s.statement, s, ctx);
  }

  /**
   * `switch (x) { case 1: … break; case 2: … default: … }` over a number: the cases
   * tested in order, then the bodies in source order — a body without `break` falls
   * through to the next, as in TypeScript. Case values are known when the script is built.
   */
  private switchStatement(s: TS.SwitchStatement, ctx: Ctx) {
    const { ts } = this;
    if (this.isTextTyped(s.expression) && !this.evaluate(s.expression)) { this.textSwitch(s, ctx); return; }
    const value = this.num(s.expression);
    if (!value) return;
    if (value.kind === "const") { this.c.error(s.expression, "switch over a value known when the script is built: write the case that applies."); return; }
    const clauses = s.caseBlock.clauses;
    // A case whose value could not be read keeps its body (it can be fallen into) but no test: NaN stands for that.
    const values: (number | null)[] = clauses.map((c) => {
      if (ts.isDefaultClause(c)) return null;
      const h = this.evaluate(c.expression);
      if (!h) { this.notConstant(c.expression, "A case value"); return Number.NaN; }
      const n = this.asInteger(h, c.expression);
      return n === null ? Number.NaN : n;
    });
    const scope = new Scope(this.scope);
    const cases = clauses.map((c, i) => ({ value: values[i], body: this.collect(() => this.block(c.statements, { fn: ctx.fn, canBreak: true, canContinue: ctx.canContinue }, scope)) }));
    this.emit({ kind: "switch", value, cases, at: this.at(s), label: this.label(s) }, s);
  }

  /** `switch (s)` over a text: which case it is — the first whose text it equals — is worked out as a number, and the switch is over that. */
  private textSwitch(s: TS.SwitchStatement, ctx: Ctx) {
    const { ts } = this;
    const given = this.text(s.expression);
    if (!given) return;
    const of = this.textTemp(given, s.expression);
    const clauses = s.caseBlock.clauses;
    const at = this.at(s), label = this.label(s);
    let which: NumExpr = num(-1);
    const values: (number | null)[] = clauses.map((c, i) => (ts.isDefaultClause(c) ? null : i));
    for (let i = clauses.length - 1; i >= 0; i--) {
      const c = clauses[i];
      if (ts.isDefaultClause(c)) continue;
      const h = this.evaluate(c.expression);
      if (!h || typeof h.value !== "string" || hasTextMark(h.value)) { this.notConstant(c.expression, "A case's text"); values[i] = Number.NaN; continue; }
      which = { kind: "ternary", cond: { kind: "textCompare", op: "==", left: of, right: { kind: "text", text: h.value }, at, label }, whenTrue: num(i), whenFalse: which, at, label };
    }
    const scope = new Scope(this.scope);
    const cases = clauses.map((c, i) => ({ value: values[i], body: this.collect(() => this.block(c.statements, { fn: ctx.fn, canBreak: true, canContinue: ctx.canContinue }, scope)) }));
    this.emit({ kind: "switch", value: which, cases, at, label }, s);
  }

  /* ── A Map and a Set over any number ── */

  /** Where each such table was declared: where its functions say they are from. */
  private readonly hashNodes = new WeakMap<Hash, TS.Node>();

  /**
   * `new Map<number, number>()`, `new Set<number>()`: keys that are any number, where a table keyed by ids of the game has
   * a cell for every id there is. The entries are kept in the order they went in — three arrays that grow, a key, a
   * value and whether it is still there — which is the order JavaScript goes through a Map in: a key set again stays
   * where it was, one deleted and set again goes to the end, one added while a loop goes through is reached by it. A
   * key is found through `slots`, open addressing over a power of two of cells, made again at twice the size when three
   * quarters of it is taken. The work is in functions of the table's own (`hashFunction`), called where it is used.
   */
  private declareHash(name: string, as: "map" | "set", init: TS.Expression, type: TS.Type, at: TS.Node): Hash | null {
    const { ts } = this;
    const args = this.c.checker.getTypeArguments(type as TS.TypeReference);
    const valueType = as === "map" ? args[1] : undefined;
    const kind = valueType ? this.kindOf(valueType) : null;
    if (as === "map" && kind !== "number" && kind !== "boolean") { this.c.error(at, `${name} holds numbers or booleans; for anything more, keep the place of a row of an array of records in it.`); return null; }
    const where = this.sourceOf(at);
    const atIr = this.at(at);
    const label = this.label(at);
    const grown = (n: string, k: "number" | "boolean", width: { bits?: 8 | 16; unsigned?: boolean } = {}) => { const a = this.newArray(n, k, 0, where, width); a.dynamic = true; return a; };
    const slots = this.newArray(`${name} (slots)`, "number", HASH_START, where);
    slots.dynamic = true;
    const counter = (n: string) => this.newVar(n, "number", where);
    const h: Hash = {
      kind: "hash", as, name, slots, keys: grown(`${name} (keys)`, "number"), ...(as === "map" ? { values: grown(`${name} (values)`, kind as "number" | "boolean", kind === "number" ? this.widthOf(valueType!) : {}) } : {}), live: grown(`${name} (has)`, "boolean"),
      size: counter(`${name}.size`), mask: counter(`${name} (mask)`), used: counter(`${name} (slots taken)`), dead: counter(`${name} (deleted)`), walking: counter(`${name} (loops)`), fns: {},
    };
    this.hashNodes.set(h, at);
    this.emit({ kind: "remark", short: as === "map" ? "a Map over any number" : "a Set over any number", text: `${name}'s keys are any number, so a key is looked for: a few steps to find, set or delete one, where a table keyed by ids of the game (a UnitType, a Player) is one read. It keeps the order its keys went in, as JavaScript does, in arrays that grow out of the memory the programs' arrays share.`, at: atIr }, at);
    this.emit({ kind: "declareArray", array: slots.id, fill: num(0), at: atIr, label }, at);
    for (const a of [h.keys, ...(h.values ? [h.values] : []), h.live]) this.emit({ kind: "declareArray", array: a.id, init: [], at: atIr, label }, at);
    for (const [v, first] of [[h.size, 0], [h.mask, HASH_START - 1], [h.used, 0], [h.dead, 0], [h.walking, 0]] as const) this.emit({ kind: "declare", decl: v, init: num(first), at: atIr, label }, at);
    // What it starts with: worked out whole when nothing of the program is in it, else the pairs as they are written.
    const whole = this.evaluate(init)?.value;
    const constant = (v: unknown): NumExpr | BoolExpr | null => (h.values?.kind === "boolean" ? (typeof v === "boolean" ? { kind: "const", value: v } : null) : (() => { const n = this.asInteger({ value: v }, init); return n === null ? null : num(n); })());
    if (whole instanceof Map || whole instanceof Set) {
      for (const [k, v] of whole instanceof Map ? whole.entries() : [...whole.values()].map((x) => [x, true] as const)) {
        const key = this.asInteger({ value: k }, init);
        const value = h.values ? constant(v) : undefined;
        if (key === null || value === null) { if (value === null) this.c.error(init, `${name} holds ${h.values!.kind}s, got ${describe(v)}.`); return null; }
        this.hashPut(h, num(key), value, at);
      }
      return h;
    }
    const given = ts.isNewExpression(init) ? init.arguments?.[0] : undefined;
    if (!given) return h;
    const list = this.unwrap(given);
    if (!ts.isArrayLiteralExpression(list)) { this.c.error(given, `${name} starts empty, or with what is written out: ${as === "map" ? "new Map([[1, 10], [2, 20]])" : "new Set([1, 2, 3])"}.`); return null; }
    for (const item of list.elements) {
      const pair = this.unwrap(item);
      if (as === "map" && (!ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2)) { this.c.error(item, "A Map starts with [key, value] pairs."); return null; }
      const key = this.num(as === "map" ? (pair as TS.ArrayLiteralExpression).elements[0] : item);
      const value = h.values ? (h.values.kind === "number" ? this.num((pair as TS.ArrayLiteralExpression).elements[1]) : this.boolValue((pair as TS.ArrayLiteralExpression).elements[1])) : undefined;
      if (!key || value === null) return null;
      this.hashPut(h, key, value, item);
    }
    return h;
  }

  /** A call of one of a table's functions, as an expression. */
  private hashCall(h: Hash, which: keyof Hash["fns"], args: (NumExpr | BoolExpr)[], node: TS.Node): Call {
    const fn = this.hashFunction(h, which);
    const at = this.at(node);
    const label = this.label(node);
    const call: Call = { name: fn.name, fn: fn.id, at, label, params: fn.params.map((decl, k) => ({ decl, init: args[k], label })), body: [] };
    if (fn.result) call.result = { decl: this.newVar(`(${fn.name} result)`, fn.result.kind === "boolean" ? "boolean" : "number", at, { temp: true }), kind: fn.result.kind };
    return this.mark(call, node);
  }

  private hashPut(h: Hash, key: NumExpr, value: NumExpr | BoolExpr | undefined, node: TS.Node) {
    const call = this.hashCall(h, "put", value === undefined ? [key] : [key, value], node);
    this.emit({ kind: "call", call, at: call.at, label: call.label }, node);
  }

  /**
   * One of a table's functions, made the first time something needs it: `find` (the place of a key's entry, −1 when it
   * has none), `place` (an entry into the slots), `grow` (the slots made again: without the deleted entries when no loop
   * is going through them, and twice the size when more than half would be taken), `put` and `drop`.
   */
  private hashFunction(h: Hash, which: keyof Hash["fns"]): FuncDecl {
    const made = h.fns[which];
    if (made) return made;
    const node = this.hashNodes.get(h)!;
    const at = this.at(node);
    const label = this.label(node);
    const name = `${h.name}.${which === "put" ? (h.as === "map" ? "set" : "add") : which === "drop" ? "delete" : `(${which})`}`;
    const local = (n: string, kind: "number" | "boolean" = "number") => this.newVar(`(${n} of ${h.name})`, kind, at, { temp: true });
    const fn: FuncDecl = { id: `${name}#${this.nextId++}`, name, params: [], body: [], at };
    h.fns[which] = fn;
    const bin = (op: ArithOp, left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, at, label });
    const cmp = (op: CompareOp, left: NumExpr, right: NumExpr): BoolExpr => ({ kind: "compare", op, left, right, at, label });
    const cell = (a: ArrayDecl, index: NumExpr) => ({ kind: "element" as const, array: a.id, index, at });
    const set = (v: VarDecl, value: NumExpr): Stmt => ({ kind: "assign", target: v.id, value, at, label });
    const let_ = (v: VarDecl, init: NumExpr | BoolExpr): Stmt => ({ kind: "declare", decl: v, init, at, label });
    const store = (a: ArrayDecl, index: NumExpr, value: NumExpr | BoolExpr): Stmt => ({ kind: "store", array: a.id, index, value, at, label });
    const push = (a: ArrayDecl, value: NumExpr | BoolExpr): Stmt => ({ kind: "push", array: a.id, value, at, label });
    const when = (cond: BoolExpr, then: Stmt[], otherwise?: Stmt[]): Stmt => ({ kind: "if", cond, then, ...(otherwise ? { else: otherwise } : {}), at, label });
    const give = (value?: NumExpr | BoolExpr): Stmt => ({ kind: "return", ...(value ? { value } : {}), at, label });
    const loop = (i: VarDecl, until: NumExpr, body: Stmt[]): Stmt => ({ kind: "for", cond: cmp("<", varRef(i), until), update: [set(i, bin("+", varRef(i), num(1)))], body, at, label });
    const run = (f: keyof Hash["fns"], args: (NumExpr | BoolExpr)[]): Call => this.hashCall(h, f, args, node);
    const statement = (call: Call): Stmt => ({ kind: "call", call, at, label });
    // Where a key's search starts: its two halves folded together, so that keys alike in their low bits (a place packed as x + y * 65536) spread out.
    const start = (key: NumExpr): NumExpr => bin("&", bin("^", key, bin(">>>", key, num(16))), varRef(h.mask));
    const next = (s: VarDecl): Stmt => set(s, bin("&", bin("+", varRef(s), num(1)), varRef(h.mask)));
    const length: NumExpr = { kind: "length", array: h.keys.id, at };
    switch (which) {
      case "find": {
        const key = local("key"), s = local("slot"), e = local("entry");
        fn.params = [key];
        fn.result = { decl: local("found"), kind: "number" };
        fn.body = [
          let_(s, start(varRef(key))),
          let_(e, cell(h.slots, varRef(s))),
          { kind: "while", cond: cmp("!=", varRef(e), num(0)), body: [
            // An entry that was deleted still holds its slot, so that what was put in after it is still found.
            when({ kind: "and", items: [cmp("==", cell(h.keys, bin("-", varRef(e), num(1))), varRef(key)), cell(h.live, bin("-", varRef(e), num(1)))] }, [give(bin("-", varRef(e), num(1)))]),
            next(s),
            set(e, cell(h.slots, varRef(s))),
          ], at, label },
          give(num(-1)),
        ];
        break;
      }
      case "place": {
        const i = local("entry"), s = local("slot");
        fn.params = [i];
        fn.body = [
          let_(s, start(cell(h.keys, varRef(i)))),
          { kind: "while", cond: cmp("!=", cell(h.slots, varRef(s)), num(0)), body: [next(s)], at, label },
          store(h.slots, varRef(s), bin("+", varRef(i), num(1))),
          set(h.used, bin("+", varRef(h.used), num(1))),
        ];
        break;
      }
      case "grow": {
        const i = local("entry"), j = local("kept"), room = local("room"), n = local("slot"), again = local("entry");
        const columns = [h.keys, ...(h.values ? [h.values] : []), h.live];
        fn.body = [
          // The deleted entries go, the rest closing up in their order — unless a loop is going through them, whose place would move.
          when({ kind: "and", items: [cmp("==", varRef(h.walking), num(0)), cmp(">", varRef(h.dead), num(0))] }, [
            let_(j, num(0)),
            let_(i, num(0)),
            loop(i, length, [when(cell(h.live, varRef(i)), [...columns.map((a) => store(a, varRef(j), cell(a, varRef(i)))), set(j, bin("+", varRef(j), num(1)))])]),
            ...columns.map((a): Stmt => ({ kind: "setLength", array: a.id, value: varRef(j), at, label })),
            set(h.dead, num(0)),
          ]),
          let_(room, bin("+", varRef(h.mask), num(1))),
          { kind: "while", cond: cmp(">", bin("*", bin("+", length, num(1)), num(2)), varRef(room)), body: [set(room, bin("*", varRef(room), num(2)))], at, label },
          set(h.mask, bin("-", varRef(room), num(1))),
          { kind: "setLength", array: h.slots.id, value: varRef(room), at, label },
          let_(n, num(0)),
          loop(n, varRef(room), [store(h.slots, varRef(n), num(0))]),
          set(h.used, num(0)),
          let_(again, num(0)),
          loop(again, length, [when(cell(h.live, varRef(again)), [statement(run("place", [varRef(again)]))])]),
        ];
        break;
      }
      case "put": {
        const key = local("key"), i = local("entry");
        const value = h.values ? local("value", h.values.kind) : undefined;
        if (value && h.values) { if (h.values.bits) value.bits = h.values.bits; if (h.values.unsigned) value.unsigned = true; }
        fn.params = value ? [key, value] : [key];
        const held = value ? (value.kind === "number" ? varRef(value) : boolRef(value)) : undefined;
        fn.body = [
          let_(i, { kind: "call", call: run("find", [varRef(key)]) }),
          // A key it has keeps its place, as it does in JavaScript: only the value changes.
          when(cmp(">=", varRef(i), num(0)), [...(held ? [store(h.values!, varRef(i), held)] : []), give()]),
          when(cmp(">", bin("*", bin("+", varRef(h.used), num(1)), num(4)), bin("*", bin("+", varRef(h.mask), num(1)), num(3))), [statement(run("grow", []))]),
          push(h.keys, varRef(key)),
          ...(held ? [push(h.values!, held)] : []),
          push(h.live, TRUE),
          statement(run("place", [bin("-", length, num(1))])),
          set(h.size, bin("+", varRef(h.size), num(1))),
        ];
        break;
      }
      case "drop": {
        const key = local("key"), i = local("entry");
        fn.params = [key];
        fn.result = { decl: local("deleted", "boolean"), kind: "boolean" };
        fn.body = [
          let_(i, { kind: "call", call: run("find", [varRef(key)]) }),
          when(cmp("<", varRef(i), num(0)), [give(FALSE)]),
          store(h.live, varRef(i), FALSE),
          set(h.size, bin("-", varRef(h.size), num(1))),
          set(h.dead, bin("+", varRef(h.dead), num(1))),
          give(TRUE),
        ];
        break;
      }
    }
    this.mark(fn, node);
    this.functions.push(fn);
    return fn;
  }

  /**
   * A method of such a table: `get`, `set`, `has`, `delete`, `clear` of a Map; `add`, `has`, `delete`, `clear` of a
   * Set. `as` is where the call stands, and what comes back is as `arrayCall`'s. `other` is the right of `get(k) ?? other`.
   */
  private hashMethod(e: TS.CallExpression, h: Hash, method: string, as: "statement" | "number" | "boolean", other?: TS.Expression): NumExpr | BoolExpr | true | null {
    const at = this.at(e);
    const label = this.label(e);
    const wrong = (what: string) => { this.c.error(e, what); return null; };
    const key = (): NumExpr | null => {
      if (e.arguments.length < 1) { this.c.error(e, `${method}() takes a key.`); return null; }
      return this.num(e.arguments[0]);
    };
    switch (method) {
      case "has": {
        if (as !== "boolean") return wrong(`${h.name}.has(…) is true or false.`);
        const k = key();
        return k ? this.mark<BoolExpr>({ kind: "compare", op: ">=", left: { kind: "call", call: this.hashCall(h, "find", [k], e) }, right: num(0), at, label }, e) : null;
      }
      case "get": {
        if (h.as !== "map" || !h.values) return wrong("A Set has has(), add() and delete().");
        if (as === "statement") return wrong(`${h.name}.get(…) is a value: use it or store it.`);
        if ((as === "number") !== (h.values.kind === "number")) return wrong(`${h.name} holds ${h.values.kind}s.`);
        const k = key();
        if (!k) return null;
        // The entry's value, or — for a key it has not got — what `??` names, else 0 or false: there is no undefined when the map is played.
        const i = this.newVar(`(entry of ${h.name})`, "number", at, { temp: true });
        const otherwise = other ? (h.values.kind === "number" ? this.num(other) : this.boolValue(other)) : h.values.kind === "number" ? num(0) : FALSE;
        if (!otherwise) return null;
        const call: Call = {
          name: `${h.name}.get`, at, label, params: [], result: { decl: this.newVar(`(${h.name}.get result)`, h.values.kind, at, { temp: true, ...(h.values.bits ? { bits: h.values.bits } : {}), ...(h.values.unsigned ? { unsigned: true } : {}) }), kind: h.values.kind },
          body: [
            { kind: "declare", decl: i, init: { kind: "call", call: this.hashCall(h, "find", [k], e) }, at, label },
            { kind: "if", cond: { kind: "compare", op: ">=", left: varRef(i), right: num(0), at, label }, then: [{ kind: "return", value: { kind: "element", array: h.values.id, index: varRef(i), at }, at, label }], at, label },
            { kind: "return", value: otherwise, at, label },
          ],
        };
        return this.mark<NumExpr | BoolExpr>({ kind: "call", call }, e);
      }
      case "set": case "add": {
        if ((method === "set") !== (h.as === "map")) return wrong(h.as === "map" ? "A Map takes set(key, value)." : "A Set takes add(key).");
        if (as !== "statement") return wrong(`${h.name}.${method}(…) stands on its own.`);
        if (e.arguments.length !== (h.as === "map" ? 2 : 1)) return wrong(h.as === "map" ? "set() takes a key and a value." : "add() takes a key.");
        const k = key();
        const value = h.values ? (h.values.kind === "number" ? this.num(e.arguments[1]) : this.boolValue(e.arguments[1])) : undefined;
        if (!k || value === null) return null;
        this.hashPut(h, k, value, e);
        return true;
      }
      case "delete": {
        const k = key();
        if (!k) return null;
        const call = this.hashCall(h, "drop", [k], e);
        if (as === "statement") { this.emit({ kind: "call", call, at, label }, e); return true; }
        if (as !== "boolean") return wrong(`${h.name}.delete(…) is true when the key was there.`);
        return this.mark<BoolExpr>({ kind: "call", call }, e);
      }
      case "clear": {
        if (as !== "statement" || e.arguments.length) return wrong(`${h.name}.clear() stands on its own and takes nothing.`);
        const i = this.newVar(`(slot of ${h.name})`, "number", at, { temp: true });
        for (const a of [h.keys, ...(h.values ? [h.values] : []), h.live]) this.emit({ kind: "setLength", array: a.id, value: num(0), at, label }, e);
        this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
        this.emit({ kind: "for", cond: { kind: "compare", op: "<=", left: varRef(i), right: varRef(h.mask), at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body: [{ kind: "store", array: h.slots.id, index: varRef(i), value: num(0), at, label }], at, label }, e);
        for (const v of [h.size, h.used, h.dead]) this.emit({ kind: "assign", target: v.id, value: num(0), at, label }, e);
        return true;
      }
      default:
        return wrong(`${h.as === "map" ? "A Map of a program has get, set, has, delete, clear, size, forEach and for…of (with keys(), values() and entries())" : "A Set of a program has add, has, delete, clear, size, forEach and for…of"}; ${method}() is not one of them.`);
    }
  }

  /** `m.forEach((value, key) => …)`, `s.forEach((key) => …)`: the loop, the function its body. */
  private hashForEach(e: TS.CallExpression, h: Hash) {
    if (e.arguments.length > 1) { this.c.error(e.arguments[1], "forEach() takes the function alone; there is no this in a program."); return; }
    this.hashLoop(h, e, (key, value) => {
      const k: Binding = { kind: "var", v: key };
      const call = this.callback(e.arguments[0], "forEach", [value ? { kind: "var", v: value } : k, k, h], "void", e);
      if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e);
    });
  }

  /**
   * A loop through such a table, in the order its keys went in: `turn` is called, where the loop's body goes, with the
   * key and the value of each entry that is still there. What the body adds is reached, what it deletes is not, as in
   * JavaScript; while the loop runs the deleted entries stay where they are (`walking`), so that its place holds.
   */
  private hashLoop(h: Hash, node: TS.Node, turn: (key: VarDecl, value: VarDecl | undefined) => void) {
    const at = this.at(node);
    const label = this.label(node);
    const i = this.newVar(`(entry of ${h.name})`, "number", at, { temp: true });
    const step = (v: VarDecl, by: "+" | "-"): Stmt => ({ kind: "assign", target: v.id, value: { kind: "binary", op: by, left: varRef(v), right: num(1), at, label }, at, label });
    const body = this.collect(() => {
      const key = this.newVar(`(key of ${h.name})`, "number", at, { temp: true });
      this.emit({ kind: "declare", decl: key, init: { kind: "element", array: h.keys.id, index: varRef(i), at }, at, label }, node);
      let value: VarDecl | undefined;
      if (h.values) {
        value = this.newVar(`(value of ${h.name})`, h.values.kind, at, { temp: true, ...(h.values.bits ? { bits: h.values.bits } : {}), ...(h.values.unsigned ? { unsigned: true } : {}) });
        this.emit({ kind: "declare", decl: value, init: { kind: "element", array: h.values.id, index: varRef(i), at }, at, label }, node);
      }
      turn(key, value);
    });
    // A `return` in the body leaves the loop without reaching its end: the loop is counted out before it.
    const leaving = (list: Stmt[]): Stmt[] => list.flatMap((st): Stmt[] => {
      switch (st.kind) {
        case "return": return [step(h.walking, "-"), st];
        case "if": return [{ ...st, then: leaving(st.then), ...(st.else ? { else: leaving(st.else) } : {}) }];
        case "while": case "do": case "block": case "unitLoop": case "textLoop": return [{ ...st, body: leaving(st.body) }];
        case "for": return [{ ...st, body: leaving(st.body), update: leaving(st.update) }];
        case "unrolled": return [{ ...st, iterations: st.iterations.map(leaving) }];
        case "switch": return [{ ...st, cases: st.cases.map((c) => ({ ...c, body: leaving(c.body) })) }];
        default: return [st];
      }
    });
    this.emit(step(h.walking, "+"), node);
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, node);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: h.keys.id, at }, at, label }, update: [step(i, "+")], body: [{ kind: "if", cond: { kind: "element", array: h.live.id, index: varRef(i), at }, then: leaving(body), at, label }], at, label }, node);
    this.emit(step(h.walking, "-"), node);
  }

  /* ── Classes ── */

  /**
   * A class declared in the body is the program's: an instance is a record — a variable a field — whose class is known
   * when the script is built, and a method is a function that takes the instance first. So whether a method is called or
   * inlined is `inline`'s rule and nothing of its own; an overridden method, `super` and `instanceof` are settled here,
   * by the class the binding carries; and nothing of a class is left when the map is played.
   */
  private readonly statics = new Map<TS.Node, Binding>();
  /** The body each class was declared in: where its methods are walked. */
  private readonly classBodies = new Map<TS.ClassDeclaration, Body>();
  /** The constructors being walked, innermost last: whose `super(…)` a call of it is, the instance, and the name its fields are declared under. */
  private readonly constructing: { cls: TS.ClassDeclaration; self: Instance; name: string }[] = [];

  /** The class an expression names, when it is one declared in the body. */
  private classOf(expr: TS.Expression): TS.ClassDeclaration | undefined {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (!ts.isIdentifier(e)) return undefined;
    const decl = declarationOf(ts, this.c.checker, e);
    return decl && ts.isClassDeclaration(decl) && this.body.plan.game.has(decl) ? decl : undefined;
  }

  /** The class a type is an instance of, when it is one declared in the body. */
  private classOfType(type: TS.Type): TS.ClassDeclaration | undefined {
    const { ts } = this;
    const decl = type.getSymbol()?.valueDeclaration;
    return decl && ts.isClassDeclaration(decl) && this.body.plan.game.has(decl) ? decl : undefined;
  }

  /** What a class extends: a class of the body, null when it extends nothing, undefined — with a diagnostic — when it extends anything else. */
  private baseOf(cls: TS.ClassDeclaration): TS.ClassDeclaration | null | undefined {
    const { ts } = this;
    const clause = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (!clause) return null;
    const base = this.classOf(clause.expression);
    if (!base) this.c.error(clause, `${this.className(cls)} extends ${clause.expression.getText(this.body.sf)}, which is not a class declared in this program: a class of a program extends another one of it.`);
    return base;
  }

  /** A class and what it extends, itself first. */
  private chainOf(cls: TS.ClassDeclaration): TS.ClassDeclaration[] {
    const chain: TS.ClassDeclaration[] = [];
    for (let c: TS.ClassDeclaration | null | undefined = cls; c && !chain.includes(c); c = this.baseOf(c)) chain.push(c);
    return chain;
  }

  private className(cls: TS.ClassDeclaration): string {
    return cls.name?.text ?? "(class)";
  }

  private isStatic(m: TS.ClassElement): boolean {
    const { ts } = this;
    return ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
  }

  /** A member's name as the key its field is kept under: `hp`, `#hp`. */
  private memberKey(name: TS.PropertyName | undefined): string | null {
    const { ts } = this;
    return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
  }

  /** The first member that `pick` takes, in the class or — the way a lookup goes — in what it extends. */
  private memberOf(cls: TS.ClassDeclaration, pick: (m: TS.ClassElement) => boolean, from = 0): TS.ClassElement | undefined {
    for (const c of this.chainOf(cls).slice(from)) { const m = c.members.find(pick); if (m) return m; }
    return undefined;
  }

  /** The class whose body a node is written in. */
  private enclosingClass(node: TS.Node): TS.ClassDeclaration | undefined {
    const { ts } = this;
    for (let n: TS.Node | undefined = node.parent; n; n = n.parent) if (ts.isClassDeclaration(n)) return n;
    return undefined;
  }

  /** `class Squad { static count = 0; … }` where it stands: its static fields are variables of the program from here on. The rest waits for `new`. */
  private declareClass(cls: TS.ClassDeclaration) {
    const { ts } = this;
    this.classBodies.set(cls, this.body);
    if (cls.typeParameters?.length) this.c.error(cls.typeParameters[0], "A class of a program takes no type parameters: what each field holds has to be known when the script is built.");
    for (const m of cls.members) {
      if (ts.isClassStaticBlockDeclaration(m)) { this.c.error(m, "A static block is not supported in a program; give the static fields their values where they are declared."); continue; }
      if (ts.isMethodDeclaration(m) && (m.asteriskToken || ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword))) this.c.error(m, "Generators and async functions are not supported in a program.");
      if (!ts.isPropertyDeclaration(m) || !this.isStatic(m)) continue;
      const key = this.memberKey(m.name);
      if (!key) { this.c.error(m.name, "A field's name is written out."); continue; }
      const held = this.declareField(`${this.className(cls)}.${key}`, m.initializer, this.c.checker.getTypeAtLocation(m.name), this.c.checker.getSymbolAtLocation(m.name), m, m.name, m);
      if (held) this.statics.set(m, held);
    }
  }

  /** `new Squad(P1, 12)`: the fields declared under `name`, their first values and the constructor run — what it extends first, as JavaScript runs them. */
  private instantiate(e: TS.NewExpression, name: string): Instance | null {
    const cls = this.classOf(e.expression);
    if (!cls) { this.c.error(e.expression, "new makes an instance of a class declared in the program."); return null; }
    if (this.constructing.length >= MAX_INLINE_DEPTH) { this.c.error(e, `${this.className(cls)} makes another instance while it is being made, sixteen deep: an instance is a set of variables of its own, made when the script is built, so this would have no end.`); return null; }
    const self: Instance = { kind: "record", fields: new Map(), cls };
    return this.construct(cls, e.arguments ?? [], self, e, name) ? self : null;
  }

  private construct(cls: TS.ClassDeclaration, args: readonly TS.Expression[], self: Instance, at: TS.Expression, name: string): boolean {
    const { ts } = this;
    const base = this.baseOf(cls);
    if (base === undefined) return false;
    if (ts.getModifiers(cls)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) && self.cls === cls) { this.c.error(at, `${this.className(cls)} is abstract.`); return false; }
    const target = this.classBodies.get(cls) ?? this.body;
    const ctor = cls.members.find((m): m is TS.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
    if (!ctor) {
      // No constructor of its own: what it extends is made from the same arguments, then its own fields get their values.
      if (base) { if (!this.construct(base, args, self, at, name)) return false; }
      else if (args.length) { this.c.error(at, `${this.className(cls)} has no constructor, so new ${this.className(cls)}() takes nothing.`); return false; }
      const scope = new Scope(target === this.c.body ? this.topScope : null);
      scope.bind(THIS, self);
      const saved = this.enterBody(target);
      const outer = this.scope;
      this.scope = scope;
      try { this.declareFields(cls, self, name); } finally { this.scope = outer; this.leaveBody(saved); }
      return true;
    }
    this.constructing.push({ cls, self, name });
    try {
      const call = this.inline(at, ctor.parameters, ctor.body, target, `new ${this.className(cls)}`, ctor, {
        self, args, nothing: true,
        first: (scope) => {
          // `constructor(public owner: Player)`: a field that starts as what was handed over.
          for (const p of ctor.parameters) {
            if (!ts.getModifiers(p)?.length || !ts.isIdentifier(p.name)) continue;
            const from = scope.lookup(p);
            if (from && this.onRow.has(self)) { this.rowFieldGiven(self, p.name.text, from.kind === "value" ? { value: from.value } : { binding: from }, p); continue; }
            const field = from && this.parameterField(from, `${name}.${p.name.text}`, p);
            if (field) self.fields.set(p.name.text, field);
          }
          // A class that extends another gets its fields' values when `super(…)` comes back; one that does not, before its constructor's first line.
          if (!base) this.declareFields(cls, self, name);
        },
      });
      if (!call) return false;
      this.emit({ kind: "call", call, at: call.at, label: call.label }, at);
      if (base && !this.superCalled.delete(ctor)) this.c.error(ctor, `${this.className(cls)} extends ${this.className(base)}, so its constructor calls super(…) before anything else.`);
      return true;
    } finally {
      this.constructing.pop();
    }
  }

  private readonly superCalled = new Set<TS.Node>();

  /** `super(…)` inside a constructor: what the class extends is made on the same instance, and then the class's own fields get their values. */
  private superCall(e: TS.CallExpression) {
    const top = this.constructing[this.constructing.length - 1];
    const cls = this.enclosingClass(e);
    const base = cls && this.baseOf(cls);
    if (!top || !cls || top.cls !== cls || !base) { this.c.error(e, "super(…) is the first thing the constructor of a class that extends another does."); return; }
    const ctor = cls.members.find((m) => this.ts.isConstructorDeclaration(m) && !!m.body);
    if (ctor) this.superCalled.add(ctor);
    if (this.construct(base, e.arguments, top.self, e, top.name)) this.declareFields(cls, top.self, top.name);
  }

  /** A class's own fields, each with the value it is declared with — or 0, false, no unit, no text. `this` is bound where this runs. */
  private declareFields(cls: TS.ClassDeclaration, self: Instance, name: string) {
    const { ts } = this;
    for (const m of cls.members) {
      if (!ts.isPropertyDeclaration(m) || this.isStatic(m)) continue;
      const key = this.memberKey(m.name);
      if (!key) { this.c.error(m.name, "A field's name is written out."); continue; }
      // `declare hp: number`, or a field what the class extends already made and this one only types again.
      if (!m.initializer && self.fields.has(key)) continue;
      // On a row the cells are there already, and nothing: the field's first value is stored into them.
      if (this.onRow.has(self)) { if (m.initializer) this.rowFieldGiven(self, key, { expr: m.initializer }, m); continue; }
      const held = this.declareField(`${name}.${key}`, m.initializer, this.c.checker.getTypeAtLocation(m.name), this.c.checker.getSymbolAtLocation(m.name), m, m.name, m);
      if (held) self.fields.set(key, held);
    }
  }

  /** A field that a constructor's parameter declares (`public owner: Player`): a variable of its own that starts as the argument — an array, a record or an instance handed over is itself. */
  private parameterField(from: Binding, full: string, p: TS.ParameterDeclaration): Binding | null {
    if (from.kind !== "value") return this.takenCopy(from, full, p);
    const type = this.c.checker.getTypeAtLocation(p.name);
    if (typeof from.value === "string" && this.isTextType(type)) {
      const [, prop] = this.c.checker.getSymbolsOfParameterPropertyDeclaration(p, (p.name as TS.Identifier).text);
      const keptAs = hasTextMark(from.value) || !prop ? "made" : this.textKept(undefined, (left) => this.ts.isPropertyAccessExpression(left) && this.c.checker.getSymbolAtLocation(left.name) === prop);
      const v = this.newVar(full, "text", this.sourceOf(p.name), { text: keptAs });
      this.emit({ kind: "declare", decl: v, init: this.literalText(from.value, p), at: this.at(p), label: this.label(p) }, p);
      return { kind: "var", v };
    }
    const kind = this.kindOf(type);
    if (kind === "unit" && (from.value === null || from.value === undefined)) {
      const v = this.newVar(full, "unit", this.sourceOf(p.name));
      this.emit({ kind: "declare", decl: v, init: NO_UNIT, at: this.at(p), label: this.label(p) }, p);
      return { kind: "var", v };
    }
    if ((kind === "number" && typeof from.value === "number") || (kind === "boolean" && typeof from.value === "boolean")) return this.fieldCopy(from, full, p);
    this.c.error(p, `${full} would hold ${describe(from.value)}, which only the script has: a field holds a number, a boolean, a text, a unit, an array or a record.`);
    return null;
  }

  /**
   * A call of a method — `s.add(u)`, `super.hit(n)`, `Squad.make()` — as the call of a function it is, the instance
   * bound to `this`. Undefined when the call is not of a method of a class of the program; null, with a diagnostic, when
   * it is and cannot be made.
   */
  private methodCall(e: TS.CallExpression): Call | null | undefined {
    const { ts } = this;
    const callee = this.unwrap(e.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const found = this.memberAt(callee, (m, name) => ts.isMethodDeclaration(m) && this.memberKey(m.name) === name);
    if (!found) return found;
    const method = found.member as TS.MethodDeclaration;
    if (!method.body) { this.c.error(e, `${found.name} has no body here: it is abstract, and what this instance is does not give it one.`); return null; }
    return this.inline(e, method.parameters, method.body, this.classBodies.get(method.parent as TS.ClassDeclaration) ?? this.body, found.name, method, { ...(found.self ? { self: found.self } : {}), ...(found.before ? { before: found.before } : {}) }) ?? null;
  }

  /** `s.size` where `size` is a getter: the call it is. Undefined when it is not one. */
  private getterCall(expr: TS.Expression): Call | null | undefined {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const found = this.memberAt(e, (m, name) => ts.isGetAccessorDeclaration(m) && this.memberKey(m.name) === name, true);
    if (!found) return found;
    const getter = found.member as TS.GetAccessorDeclaration;
    return this.inline(e, [], getter.body, this.classBodies.get(getter.parent as TS.ClassDeclaration) ?? this.body, found.name, getter, { self: found.self, args: [], ...(found.before ? { before: found.before } : {}) }) ?? null;
  }

  /** `s.hp = 5` where `hp` is a setter: the call it is, emitted. False when it is not one. */
  private setterCall(e: TS.BinaryExpression, op: TS.SyntaxKind): boolean {
    const { ts } = this;
    const left = this.unwrap(e.left);
    if (!ts.isPropertyAccessExpression(left)) return false;
    const found = this.memberAt(left, (m, name) => ts.isSetAccessorDeclaration(m) && this.memberKey(m.name) === name, true);
    if (found === undefined) return false;
    if (!found) return true;
    if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, `${found.name} is a setter, which takes = only: read it, work the value out, and assign that.`); return true; }
    const setter = found.member as TS.SetAccessorDeclaration;
    const call = this.inline(e, setter.parameters, setter.body, this.classBodies.get(setter.parent as TS.ClassDeclaration) ?? this.body, found.name, setter, { self: found.self, args: [e.right], nothing: true, ...(found.before ? { before: found.before } : {}) });
    if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e);
    return true;
  }

  /**
   * A call that gives an instance — `make(3)`, `v.add(w)` where `add` returns `this`: the call made, as a statement, and
   * the instance it settled on. Undefined when the call gives no instance of a class of the program; null with a diagnostic.
   */
  private instanceCall(e: TS.CallExpression, name: string, into?: Stmt[]): Binding | null | undefined {
    const { ts } = this;
    if (!this.classOfType(this.c.checker.getTypeAtLocation(e))) return undefined;
    const instance: { name: string; made?: Binding } = { name };
    let call: Call | undefined;
    const callee = this.unwrap(e.expression);
    if (ts.isIdentifier(callee)) {
      const decl = this.gameDeclaration(callee);
      if (!decl || !ts.isFunctionDeclaration(decl)) { this.c.error(e, "A function that gives an instance is one declared in the program."); return null; }
      call = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl, { instance });
    } else if (ts.isPropertyAccessExpression(callee)) {
      const found = this.memberAt(callee, (m, n) => ts.isMethodDeclaration(m) && this.memberKey(m.name) === n);
      if (!found) return null;
      const method = found.member as TS.MethodDeclaration;
      call = this.inline(e, method.parameters, method.body, this.classBodies.get(method.parent as TS.ClassDeclaration) ?? this.body, found.name, method, { ...(found.self ? { self: found.self } : {}), ...(found.before ? { before: found.before } : {}), instance });
    }
    if (!call) return null;
    // `into`: the call is part of a larger one's chain, and runs inside it; else it runs here.
    if (into) into.push(this.mark({ kind: "call", call, at: call.at, label: call.label }, e)); else this.emit({ kind: "call", call, at: call.at, label: call.label }, e);
    if (!instance.made) { this.c.error(e, "This call gave no instance: every way through the function has to return one."); return null; }
    return instance.made;
  }

  /**
   * The member of a class that `obj.name` reaches: through an instance (by the class it is, so an overridden method is
   * the one found), through `super` (from what the enclosing class extends on), or — a static one — through the class's
   * name. `quiet`: a name that is no such member is simply not one (a field, read as any field is).
   */
  private memberAt(e: TS.PropertyAccessExpression, pick: (m: TS.ClassElement, name: string) => boolean, quiet = false): { member: TS.ClassElement; self?: Binding; name: string; before?: Stmt[] } | null | undefined {
    const { ts } = this;
    const name = e.name.text;
    const obj = this.unwrap(e.expression);
    if (obj.kind === ts.SyntaxKind.SuperKeyword) {
      const cls = this.enclosingClass(e);
      const self = this.scope.lookup(THIS);
      if (!cls || !self) { this.c.error(e, "super is for a method of a class that extends another."); return null; }
      const member = this.memberOf(cls, (m) => !this.isStatic(m) && pick(m, name), 1);
      if (!member) { if (quiet) return undefined; this.c.error(e, `What ${this.className(cls)} extends has no ${name}().`); return null; }
      return { member, self, name: `${this.className(member.parent as TS.ClassDeclaration)}.${name}` };
    }
    const named = this.classOf(obj);
    if (named) {
      const member = this.memberOf(named, (m) => this.isStatic(m) && pick(m, name));
      if (!member) { if (quiet) return undefined; this.c.error(e, `${this.className(named)} has no static ${name}().`); return null; }
      return { member, name: `${this.className(named)}.${name}` };
    }
    // `v.add(w).scale(2)`: what the call before gives is what this one is called on.
    const before: Stmt[] = [];
    const self = ts.isCallExpression(obj) ? this.instanceCall(obj, "(made)", before) ?? undefined : this.bindingOf(obj);
    if (self?.kind !== "record" || !self.cls) return undefined;
    const member = this.memberOf(self.cls, (m) => !this.isStatic(m) && pick(m, name));
    if (!member) { if (quiet || self.fields.has(name)) return undefined; this.c.error(e, `${this.className(self.cls)} has no method ${name}().`); return null; }
    return { member, self, name: `${this.className(self.cls)}.${name}`, ...(before.length ? { before } : {}) };
  }

  /* ── Functions ── */

  /** A call of a `game()` function: inlined from its own body, wherever that file is. */
  private gameCall(call: TS.CallExpression, fn: GameFunctionValue): Call | undefined {
    const target = this.c.resolve(fn);
    if (!target) { this.c.error(call, "This game function's body could not be found again."); return undefined; }
    const arrow = target.plan.arrow;
    return this.inline(call, arrow.parameters, target.plan.expression ?? (arrow.body as TS.Block), target, target.name, arrow);
  }

  /**
   * A function at a call. Inlined — parameters bound, the body walked, `return` leaving it — the first time a function
   * is met, and every time when it has to be; from the second time on it is *called* when it can be (`callable`), the
   * first call changed to match. The result — a number, a boolean or a unit the checker says the call has — comes back
   * in a variable of the call's own that dies with the statement.
   */
  private inline(call: TS.Expression, parameters: readonly TS.ParameterDeclaration[], body: TS.Block | TS.Expression | undefined, target: Body, name: string | undefined, decl: TS.Node, as: MethodCall = {}): Call | undefined {
    const { ts } = this;
    // What is handed over: a call's arguments — or, where `call` is not one (`new Squad(P1)`, a getter read, a setter's `=`), what `as` says.
    const written: readonly TS.Expression[] = as.args ?? (ts.isCallExpression(call) ? call.arguments : []);
    // `f(...xs)`: an argument a cell, when the script knows how many there are — a list it has, an array of a fixed length.
    const given: TS.Expression[] = [];
    const spread = new Map<number, Binding>();
    for (const arg of written) {
      if (!ts.isSpreadElement(arg)) { given.push(arg); continue; }
      const known = this.evaluate(arg.expression);
      const list = known ? undefined : this.listOf(arg.expression);
      const items: Binding[] | null = known ? (Array.isArray(known.value) ? (known.value as unknown[]).map((value): Binding => ({ kind: "value", value })) : null)
        : list?.kind === "array" && !list.a.dynamic ? Array.from({ length: list.a.length }, (_, k): Binding => ({ kind: "cell", a: list.a, index: num(k) }))
        : list?.kind === "units" && !list.ptr.dynamic ? Array.from({ length: list.ptr.length }, (_, k): Binding => ({ kind: "unitAt", ptr: { a: list.ptr, index: num(k) }, epd: { a: list.epd, index: num(k) }, uid: { a: list.uid, index: num(k) } })) : null;
      if (!items) { this.c.error(arg, "... in a call spreads a list the script has, or an array of a fixed length: how many arguments a call has is settled when the script is built. An array that grows is handed over as itself — f(xs)."); return undefined; }
      for (const item of items) { spread.set(given.length, item); given.push(arg); }
    }
    const what = name ?? "The function";
    if (!body) { this.c.error(call, "The function has no body."); return undefined; }
    // A copy of a body inside a copy of a body, sixteen times over: what happens from here is decided once the arguments are known.
    const deep = this.inlineDepth >= MAX_INLINE_DEPTH;
    if ((ts.isFunctionDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl) || ts.isMethodDeclaration(decl)) && (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) { this.c.error(decl, "Generators and async functions are not supported in a program."); return undefined; }
    const kind: Kind | "text" | "void" = as.nothing ? "void" : this.kindOf(this.c.checker.getTypeAtLocation(call)) ?? (this.isTextType(this.c.checker.getTypeAtLocation(call)) ? "text" : "void");
    const line = this.line(call);
    const out: Call = { ...(name ? { name } : {}), at: this.at(call), label: this.label(call), params: [], body: [] };
    if (kind !== "void") out.result = { decl: this.newVar(`(${name ?? "function"} result)`, kind, this.at(call), { temp: true, ...(kind === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(call)) : {}) }), kind };
    this.mark(out, call);
    this.callees.set(out, decl);
    // A function of the body closes over the program's variables; a game function sees only its own.
    const closure = target === this.body && target === this.c.body ? this.topScope : null;
    const scope = new Scope(closure);
    if (as.self) scope.bind(THIS, as.self);
    let ok = true;
    // The same call as a called function takes it: what each parameter is set to, or the array it stands for. Null once this call can only be inlined.
    let args: CallArgument[] | null = [];
    let why = "";
    const asCalled = (a: CallArgument | string) => {
      if (typeof a !== "string") { args?.push(a); return; }
      if (args) why = a;
      args = null;
    };
    // A text owns a block of memory, and what a called function is handed and hands back are plain cells so far.
    if (kind === "text") asCalled("it returns a text, which a function that is called cannot do yet");
    // Which instance comes back is settled where the call is: a copy of the body a call.
    if (as.instance) asCalled("it returns an instance, and which one is settled at each call");
    if (as.before?.length) asCalled("it is called on what another call gives, which runs first and inside it");
    // `function len({ x, y }: Point)`: taken apart when the function starts, inside its body — a called function's too.
    const patterns: (() => void)[] = [];
    parameters.forEach((p, i) => {
      if (p.dotDotDotToken) {
        // `function sum(...ns: number[])`: the arguments of this call, in an array made here. How many there are is the call's own, so the function stays a copy a call.
        const element = this.c.checker.getIndexTypeOfType(this.c.checker.getTypeAtLocation(p.name), ts.IndexKind.Number);
        const k = element ? this.kindOf(element) : null;
        if (!ts.isIdentifier(p.name) || (k !== "number" && k !== "boolean")) { this.c.error(p, "The rest of the arguments is an array of numbers or of booleans: ...ns: number[]."); ok = false; return; }
        const values: (NumExpr | BoolExpr)[] = [];
        for (const [j, x] of given.slice(i).entries()) {
          const item = spread.get(i + j);
          const v = item ? (this.valueOf(item, k, x) as NumExpr | BoolExpr | null) : k === "number" ? this.num(x) : this.boolValue(x);
          if (!v) { ok = false; return; }
          values.push(v);
        }
        const rest = this.newArray(p.name.text, k, values.length, this.sourceOfIn(target, p.name), k === "number" && element ? this.widthOf(element) : {});
        if (values.length === 0) rest.dynamic = true;
        this.emit({ kind: "declareArray", array: rest.id, init: values, at: this.at(call), label: this.label(call) }, call);
        scope.bind(p, { kind: "array", a: rest });
        asCalled(`${p.name.text} is the rest of a call's arguments, as many as that call has`);
        return;
      }
      if (!ts.isIdentifier(p.name)) {
        const arg = given[i] ?? p.initializer;
        if (!arg) { this.c.error(call, `Missing argument ${p.name.getText(target.sf)}.`); ok = false; return; }
        const from = this.patternSource(arg, arg);
        if (!from) { ok = false; return; }
        const pattern = p.name;
        patterns.push(() => { this.bindPattern(pattern, p, from, scope); });
        if (!Array.isArray(from) && (from.kind === "record" || from.kind === "array" || from.kind === "records" || from.kind === "units")) asCalled({ binding: from });
        else asCalled(`${p.name.getText(target.sf)} is taken from something written at the call`);
        return;
      }
      const arg = given[i];
      const label = `L${line}: ${p.name.text} = ${arg ? arg.getText(this.body.sf) : "its default"}`;
      const item = spread.get(i);
      if (item && arg) {
        // One of what `...xs` spread: a value of the script as it is, a cell or a unit into a variable of the parameter's own.
        if (item.kind === "value") { scope.bind(p, item); asCalled(this.constantArgument(item.value, label, p) ?? `${p.name.text} is ${describe(item.value)}, which only the script has`); return; }
        const k = this.kindOf(this.c.checker.getTypeAtLocation(p.name));
        const init = k ? this.valueOf(item, k, arg) : null;
        if (!k || !init) { ok = false; return; }
        const copy = this.newVar(p.name.text, k, this.sourceOfIn(target, p.name), k === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(p.name)) : {});
        out.params.push({ decl: copy, init, label });
        scope.bind(p, { kind: "var", v: copy });
        asCalled({ init, label });
        return;
      }
      if (!arg) {
        if (!p.initializer) { this.c.error(call, `Missing argument ${p.name.text}.`); ok = false; return; }
        // The default is the function's own expression: evaluated in its body.
        const saved = this.enterBody(target);
        const h = this.evaluate(p.initializer);
        this.leaveBody(saved);
        if (!h) { this.notConstant(p.initializer, "A default value"); ok = false; return; }
        scope.bind(p, { kind: "value", value: h.value });
        asCalled(this.constantArgument(h.value, label, p) ?? `${p.name.text} is ${describe(h.value)}, which only the script has`);
        return;
      }
      const h = this.evaluate(arg);
      if (this.isTextType(this.c.checker.getTypeAtLocation(p.name)) && !(h && !isGameValue(h.value) && !this.assigns(body, p))) {
        // A text of the program: the caller's own variable when the function only reads it, else a variable of the parameter's own that starts as a copy.
        asCalled(`${p.name.text} is a text, which a function that is called cannot take yet`);
        const given = this.bindingOf(arg);
        if (given?.kind === "var" && given.v.kind === "text" && !this.assigns(body, p)) { scope.bind(p, given); return; }
        const value = this.text(arg);
        if (!value) { ok = false; return; }
        const copy = this.newVar(p.name.text, "text", this.sourceOfIn(target, p.name), { text: "made" });
        out.params.push({ decl: copy, init: value, label });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      // By value: a read passed as an argument is read once, at the call, into a variable of the parameter's own.
      if (h && !isGameValue(h.value)) {
        const constant = this.constantArgument(h.value, label, p);
        const k = this.kindOf(this.c.checker.getTypeAtLocation(p.name));
        if (constant && "init" in constant && k && this.assigns(body, p)) {
          // The function assigns it (`n--`): a variable of the parameter's own that starts from the value, as one passed a variable is.
          const copy = this.newVar(p.name.text, k, this.sourceOfIn(target, p.name), k === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(p.name)) : {});
          out.params.push({ decl: copy, init: constant.init, label });
          scope.bind(p, { kind: "var", v: copy });
          asCalled(constant);
          return;
        }
        scope.bind(p, { kind: "value", value: h.value });
        asCalled(constant ?? `${p.name.text} is ${describe(h.value)}, which only the script has`);
        return;
      }
      // `hurt(new Boss(3))`: the instance made at the call, under the parameter's name.
      const fresh = this.unwrap(arg);
      if (ts.isNewExpression(fresh) && this.classOf(fresh.expression)) {
        const instance = this.instantiate(fresh, p.name.text);
        if (!instance) { ok = false; return; }
        scope.bind(p, instance);
        asCalled({ binding: instance });
        return;
      }
      if (ts.isCallExpression(fresh)) {
        const given = this.instanceCall(fresh, p.name.text);
        if (given === null) { ok = false; return; }
        if (given) { scope.bind(p, given); asCalled({ binding: given }); return; }
      }
      const binding = this.listOf(arg);
      // An array reaches a function as itself, as it does in TypeScript: what the function stores, the caller sees.
      if (binding?.kind === "array" || binding?.kind === "records" || binding?.kind === "units" || binding?.kind === "keyed" || binding?.kind === "hash" || binding?.kind === "grid" || binding?.kind === "lists") { scope.bind(p, binding); asCalled({ binding }); return; }
      if (binding?.kind === "record") {
        if (this.assigns(body, p)) { this.c.error(p, `${p.name.text} is a record; a record parameter can have its fields assigned, not be reassigned itself.`); ok = false; return; }
        scope.bind(p, binding);
        asCalled({ binding });
        return;
      }
      const variable = binding?.kind === "var" ? binding.v : undefined;
      if (variable) {
        const init = variable.kind === "number" ? varRef(variable) : variable.kind === "unit" ? unitRef(variable) : boolRef(variable);
        asCalled({ init, label });
        // By value, as in TypeScript. A parameter the function never assigns can read the caller's variable directly; one it assigns gets a copy.
        if (!this.assigns(body, p)) { scope.bind(p, { kind: "var", v: variable }); return; }
        const copy = this.newVar(p.name.text, variable.kind, this.sourceOfIn(target, p.name), { ...(variable.bits ? { bits: variable.bits } : {}), ...(variable.unsigned ? { unsigned: true } : {}) });
        out.params.push({ decl: copy, init, label });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      if (this.isUnitTyped(arg)) {
        // A unit found at the call (first(…), a function's result): found once, into a variable of the parameter's own.
        const unit = this.unitExpr(arg);
        if (!unit) { ok = false; return; }
        const copy = this.newVar(p.name.text, "unit", this.sourceOfIn(target, p.name));
        out.params.push({ decl: copy, init: unit, label });
        scope.bind(p, { kind: "var", v: copy });
        asCalled({ init: unit, label });
        return;
      }
      const value = ts.isIdentifier(this.unwrap(arg)) ? null : this.numQuietly(arg);
      if (value) {
        // An expression over variables: computed into a variable of the parameter's own.
        const copy = this.newVar(p.name.text, "number", this.sourceOfIn(target, p.name), this.widthOf(this.c.checker.getTypeAtLocation(p.name)));
        out.params.push({ decl: copy, init: value, label });
        scope.bind(p, { kind: "var", v: copy });
        asCalled({ init: value, label });
        return;
      }
      this.notConstant(arg, "An argument");
      ok = false;
    });
    // The instance a method is called on goes last: a function that is called is one copy an instance, as it is one an array.
    if (as.self) asCalled({ binding: as.self });
    if (!ok) return out;
    if (given.length > parameters.length && !parameters.some((p) => p.dotDotDotToken)) { this.c.error(call, `${what} takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"}.`); return out; }

    const at = this.sourceOfIn(target, (decl as { name?: TS.Node }).name ?? decl);
    const site = args ? this.siteOf(decl, args) : undefined;
    if (site && args) {
      if (site.fn) return this.calls(out, site.fn, args);
      // Inside the attempt to make it a function that is called: the function calls itself, and this is that call.
      if (site.making) return this.calls(out, site.making, args);
      // Met a second time, or met inside itself: one copy that every call runs, when the function can be one.
      if ((site.first || (site.walking ?? 0) > 0) && !site.never && !site.busy) {
        if (ts.isFunctionDeclaration(decl) && (closure === null || decl.parent !== this.c.body.plan.body)) site.never = "it is declared inside a block or another function, whose variables it may use";
        else if (ts.isClassDeclaration(decl.parent) && (closure === null || decl.parent.parent !== this.c.body.plan.body)) site.never = "its class is declared inside a block or a function, whose variables it may use";
        else {
          site.busy = true;
          let made: FuncDecl | string;
          try { made = this.callable(parameters, body, target, name ?? "function", decl, kind as Kind | "void" /* a text result keeps `args` null: never here */, args, closure, at, site); } finally { site.busy = false; site.making = undefined; }
          if (typeof made === "string") site.never = made;
          else {
            site.fn = made;
            if (site.first) this.calls(site.first.call, made, site.first.args);
            site.first = undefined;
            return this.calls(out, made, args);
          }
        }
      }
    }
    const because = site?.never ?? (args ? "" : why);
    if (because) this.inlinedBecause.set(decl, { why: because, name: name ?? "function", at });
    if (deep) {
      this.c.error(call, (this.walkingBodies.get(decl) ?? 0) > 0
        ? `${what} calls itself, and here it cannot be a function that is called${because ? ` — ${because}` : ""}. A call that is not one is a copy of the function's body, and these copies would have no end.`
        : "Functions nest too deeply: a call that is inlined is a copy of the function's body, and these are sixteen inside one another.");
      return undefined;
    }
    if (site) site.walking = (site.walking ?? 0) + 1;
    this.walkingBodies.set(decl, (this.walkingBodies.get(decl) ?? 0) + 1);
    try {
      out.body = this.walkFunction(body, kind, target, scope, () => { patterns.forEach((take) => take()); as.first?.(scope); }, as.instance);
      if (as.before?.length) {
        // The chain so far, then this call's own arguments, then its body: the order JavaScript works them out in.
        out.body = [...as.before, ...out.params.map((p): Stmt => ({ kind: "declare", decl: p.decl, init: p.init, at: out.at, label: p.label })), ...out.body];
        out.params = [];
      }
    } finally {
      if (site) site.walking = (site.walking ?? 1) - 1;
      this.walkingBodies.set(decl, (this.walkingBodies.get(decl) ?? 1) - 1);
    }
    // Made a function that is called while this copy of it was being walked — it calls itself: this call is one of that function too.
    if (site?.fn && args) return this.calls(out, site.fn, args);
    if (site && args && !site.first && !site.fn && !site.never) site.first = { call: out, args };
    return out;
  }

  /** A function's body walked with its parameters bound in `scope`: the statements, `return` leaving them. */
  private walkFunction(body: TS.Block | TS.Expression, kind: Kind | "text" | "void", target: Body, scope: Scope, first?: () => void, instance?: { name: string; made?: Binding }): Stmt[] {
    const { ts } = this;
    const saved = this.enterBody(target);
    const outerScope = this.scope;
    this.scope = scope;
    this.inlineDepth++;
    const fn: Ctx["fn"] = { kind, ...(instance ? { instance } : {}) };
    try {
      return this.collect(() => {
        // What the function does before its first statement: its parameters taken apart.
        first?.();
        if (ts.isBlock(body)) this.block(body.statements, { fn });
        else {
          // `game((a: number) => a + 1)`: the expression is what it returns.
          try {
            if (kind === "number") { const value = this.num(body); if (value) this.emit({ kind: "return", value, at: this.at(body), label: this.label(body) }, body); }
            else if (kind === "unit") { const value = this.unitExpr(body); if (value) this.emit({ kind: "return", value, at: this.at(body), label: this.label(body) }, body); }
            else if (kind === "boolean") this.emit({ kind: "return", value: this.boolValue(body), at: this.at(body), label: this.label(body) }, body);
            else if (kind === "text") { const value = this.text(body); if (value) this.emit({ kind: "return", value, at: this.at(body), label: this.label(body) }, body); }
            else this.expressionStatement(body);
          } catch (err) {
            if (!(err instanceof LowerError)) throw err;
            if (err instanceof ValueError) this.c.error(err.node, err.message, "script");
            else this.c.error(body, err.message);
          }
        }
      });
    } finally {
      this.inlineDepth--;
      this.scope = outerScope;
      this.leaveBody(saved);
    }
  }

  /** A value the script has, as what a parameter that is a variable is set to: a whole number or a boolean, else nothing. */
  private constantArgument(value: unknown, label: string, parameter: TS.ParameterDeclaration): CallArgument | null {
    // `hurt(null, 1)`: no unit, for a parameter that is one.
    if (value === null || value === undefined) return this.kindOf(this.c.checker.getTypeAtLocation(parameter.name)) === "unit" ? { init: NO_UNIT, label } : null;
    if (typeof value === "boolean") return { init: value ? TRUE : FALSE, label };
    if (typeof value === "number" && Number.isInteger(value) && value >= I32_MIN && value <= U32_MAX) return { init: num(value), label };
    return null;
  }

  private identity(o: object): number {
    let n = this.identities.get(o);
    if (!n) { n = ++this.lastIdentity; this.identities.set(o, n); }
    return n;
  }

  /** What is known of a function at these arrays: a function that takes an array is one copy an array passed, as a template is. */
  private siteOf(decl: TS.Node, args: CallArgument[]): FunctionSite {
    const part = (b: Binding): string => {
      switch (b.kind) {
        case "array": return `a${this.identity(b.a)}`;
        case "records": return `r${[...b.fields.values()].map((a) => this.identity(a)).join(".")}`;
        case "units": return `u${this.identity(b.ptr)}`;
        case "keyed": return `k${this.identity(b.values ?? b.present ?? b)}`;
        case "hash": return `h${this.identity(b.slots)}`;
        // A record kept in a `let` is one object the scope hands back; a row of an array of records is made anew at every use, and so never met twice.
        default: return `o${this.identity(b)}`;
      }
    };
    const key = `${this.identity(decl)}:${args.map((a) => ("binding" in a ? part(a.binding) : "")).join(",")}`;
    let site = this.sites.get(key);
    if (!site) { site = {}; this.sites.set(key, site); }
    return site;
  }

  /** `out` as a call of `fn`: the function's parameters, each with this call's argument. */
  private calls(out: Call, fn: FuncDecl, args: CallArgument[]): Call {
    out.fn = fn.id;
    out.body = [];
    out.params = [];
    let k = 0;
    for (const a of args) if ("init" in a) out.params.push({ decl: fn.params[k++], init: a.init, label: a.label });
    return out;
  }

  /**
   * The function as one that is called: every parameter a variable of its own (an array parameter the array passed),
   * the body walked once. Or, in words for the hint on its line, why it cannot be: it sleeps (the program wakes up
   * inside it, which only the lowering's own jumps can do), it keeps an edge (a latch a call), or it does not compile
   * that way — a parameter reaches a field only a value known when the script is built can fill. Nothing the attempt
   * reported is kept: the same lines compile, or fail for good, where the function is inlined.
   */
  private callable(parameters: readonly TS.ParameterDeclaration[], body: TS.Block | TS.Expression, target: Body, name: string, decl: TS.Node, kind: Kind | "void", args: CallArgument[], closure: Scope | null, at: At, site: FunctionSite): FuncDecl | string {
    const { ts } = this;
    const scope = new Scope(closure);
    const patterns: (() => void)[] = [];
    const fn: FuncDecl = { id: `${name}#${this.nextId++}`, name, params: [], body: [], at };
    for (let i = 0; i < parameters.length; i++) {
      const p = parameters[i];
      const a = args[i];
      if ("binding" in a) {
        if (ts.isIdentifier(p.name)) scope.bind(p, a.binding);
        else { const pattern = p.name; const from = a.binding; patterns.push(() => { this.bindPattern(pattern, p, from, scope); }); }
        continue;
      }
      const type = this.c.checker.getTypeAtLocation(p.name);
      const k = this.kindOf(type);
      if (!k) return `${p.name.getText(target.sf)} is not a number, a boolean or a unit`;
      const v = this.newVar(p.name.getText(target.sf), k, this.sourceOfIn(target, p.name), k === "number" ? this.widthOf(type) : {});
      fn.params.push(v);
      scope.bind(p, { kind: "var", v });
    }
    // A method's instance came last among what the call hands over.
    const self = args[parameters.length];
    if (self && "binding" in self) scope.bind(THIS, self.binding);
    if (kind !== "void") {
      const type = this.c.checker.getReturnTypeOfSignature(this.c.checker.getSignatureFromDeclaration(decl as TS.SignatureDeclaration)!);
      fn.result = { decl: this.newVar(`(${name} result)`, kind, at, { temp: true, ...(kind === "number" ? this.widthOf(type) : {}) }), kind };
    }
    const { error } = this.c;
    const caught: string[] = [];
    (this.c as { error: StructuredContext["error"] }).error = (_node, message) => { caught.push(message); };
    // From here a call of this function at these arrays, met in its own body, is a call of `fn`.
    site.making = fn;
    // Its body is a place of its own: how deep the copies around this attempt go says nothing about it.
    const depth = this.inlineDepth;
    this.inlineDepth = 0;
    try {
      fn.body = this.walkFunction(body, kind, target, scope, () => patterns.forEach((take) => take()));
    } finally {
      this.inlineDepth = depth;
      (this.c as { error: StructuredContext["error"] }).error = error;
    }
    if (caught.length) return `with its parameters as variables of the game it does not compile — ${caught[0].replace(/\.$/, "")}`;
    if (mentions(fn.body, "sleep")) return "it sleeps, and the program wakes up inside it";
    if (mentions(fn.body, "edge")) return "rose() / once() remember what they saw, a call each";
    this.mark(fn, decl);
    this.functions.push(fn);
    this.declared.set(fn, decl);
    return fn;
  }

  /**
   * Once the whole program is walked: which functions are called after all. A call the walk threw away (an attempt that
   * failed, a first call changed to a called one) no longer counts, so a function left with one call is inlined there
   * again — its parameters copies — and one with none is dropped. Then a word for the line of each function that is
   * called, or inlined more than once, and the arrays nothing reaches any more are let go.
   */
  private settleFunctions(program: Program) {
    const byId = new Map(this.functions.map((f) => [f.id, f]));
    let live: Call[] = [];
    const reached = new Set<string>();
    for (;;) {
      live = [];
      reached.clear();
      const visit = (root: unknown) => eachCall(root, (c) => {
        live.push(c);
        const f = c.fn ? byId.get(c.fn) : undefined;
        if (f && !reached.has(f.id)) { reached.add(f.id); visit(f.body); }
      });
      visit(program.body);
      const once = this.functions.find((f) => reached.has(f.id) && live.filter((c) => c.fn === f.id).length === 1);
      if (!once) break;
      const c = live.find((x) => x.fn === once.id)!;
      delete c.fn;
      c.body = once.body;
      this.functions.splice(this.functions.indexOf(once), 1);
      byId.delete(once.id);
    }
    const functions = this.functions.filter((f) => reached.has(f.id));
    if (functions.length) program.functions = functions;

    const tally = new Map<TS.Node, { inlined: number; called: number; copies: FuncDecl[] }>();
    for (const c of live) {
      const decl = this.callees.get(c);
      if (!decl) continue;
      let t = tally.get(decl);
      if (!t) { t = { inlined: 0, called: 0, copies: [] }; tally.set(decl, t); }
      if (c.fn) t.called++; else t.inlined++;
    }
    for (const f of functions) tally.get(this.declared.get(f)!)?.copies.push(f);
    const times = (n: number) => `${n} place${n === 1 ? "" : "s"}`;
    for (const [decl, t] of tally) {
      if (t.copies.length) {
        const copies = t.copies.length;
        const f = t.copies[0];
        const also = t.inlined ? ` Inlined at ${times(t.inlined)} more, where an argument is a value only the script has.` : "";
        f.body.unshift({ kind: "remark", at: f.at, short: copies > 1 ? `called ×${t.called}, ${copies} copies` : `called ×${t.called}`,
          text: copies > 1
            ? `Called from ${times(t.called)}: ${copies} copies in the built map, one for each array it is passed.${also}`
            : `Called from ${times(t.called)}: one copy in the built map, its parameters variables each call sets.${also}` });
      } else if (t.inlined > 1) {
        const b = this.inlinedBecause.get(decl);
        if (b) program.body.unshift({ kind: "remark", at: b.at, short: `inlined ×${t.inlined}`, text: `Inlined at each of its ${t.inlined} calls, a copy of its body each: ${b.why}.` });
      }
    }

    const used = new Set<string>();
    const arrays = (root: unknown) => {
      if (Array.isArray(root)) { root.forEach(arrays); return; }
      if (!root || typeof root !== "object") return;
      const o = root as Record<string, unknown>;
      if (typeof o.array === "string") used.add(o.array);
      for (const v of Object.values(o)) if (v && typeof v === "object") arrays(v);
    };
    arrays(program.body);
    arrays(functions);
    for (let i = this.arrays.length - 1; i >= 0; i--) if (!used.has(this.arrays[i].id)) this.arrays.splice(i, 1);
  }

  /** Walk another body (a game function's) until `leaveBody`: its plan, file and thunks. */
  private enterBody(target: Body): Body {
    const saved = this.body;
    this.body = target;
    return saved;
  }

  private leaveBody(saved: Body) {
    this.body = saved;
  }

  private sourceOfIn(target: Body, node: TS.Node): { file: string; line: number; column: number } {
    const p = target.sf.getLineAndCharacterOfPosition(node.getStart(target.sf));
    return { file: target.sf.fileName, line: p.line + 1, column: p.character + 1 };
  }

  /** Whether a body assigns to (or increments) a declaration anywhere. */
  private assigns(body: TS.Node, decl: TS.Node): boolean {
    const { ts } = this;
    let found = false;
    const target = (e: TS.Expression): boolean => {
      const u = this.unwrap(e);
      // `[a, b] = …`, `({ x, y: py } = …)`: every name in the pattern is assigned.
      if (ts.isArrayLiteralExpression(u)) return u.elements.some((x) => !ts.isOmittedExpression(x) && target(ts.isSpreadElement(x) ? x.expression : x));
      if (ts.isObjectLiteralExpression(u)) return u.properties.some((p) => (ts.isShorthandPropertyAssignment(p) ? target(p.name) : ts.isPropertyAssignment(p) ? target(p.initializer) : false));
      return ts.isIdentifier(u) && declarationOf(ts, this.c.checker, u) === decl;
    };
    const walk = (n: TS.Node) => {
      if (found) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(n.left)) { found = true; return; }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && target(n.operand)) { found = true; return; }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  }

  /* ── Numbers ── */

  private asInteger(h: Hoisted, at: TS.Node): number | null {
    const v = h.value;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v !== "number" || !Number.isFinite(v)) { this.c.error(at, `Expected a number, got ${describe(v)}.`); return null; }
    if (!Number.isInteger(v)) { this.c.error(at, `Only whole numbers exist in the game (got ${v}).`); return null; }
    if (v < I32_MIN || v > U32_MAX) { this.c.error(at, `A number of the game has 32 bits: −2 147 483 648 to 2 147 483 647, or up to 4 294 967 295 as a u32 (got ${v}).`); return null; }
    return v;
  }

  /** `num` without diagnostics, for a probe that may fail. */
  private numQuietly(expr: TS.Expression): NumExpr | null {
    const { error } = this.c;
    let failed = false;
    (this.c as { error: StructuredContext["error"] }).error = () => { failed = true; };
    try {
      const out = this.num(expr);
      return failed ? null : out;
    } finally {
      (this.c as { error: StructuredContext["error"] }).error = error;
    }
  }

  /** A number expression: a constant, a variable, arithmetic, an intrinsic, a call — or null, with a diagnostic. */
  private num(expr: TS.Expression): NumExpr | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) {
      if (isRead(h.value)) return this.readValue(h.value, e);
      if (isTable(h.value)) return this.tableRead(h.value, e);
      if (isUnitPick(h.value)) { this.c.error(e, `${h.value.ident}() is a unit, not a number; read one of its fields: ${h.value.ident}(…)?.hp — or keep it: const u = ${h.value.ident}(…).`); return null; }
      if (isInput(h.value)) return this.inputValue(h.value, e);
      if (isMouse(h.value)) { this.c.error(e, "mouse() is a place on the map: read its x or its y."); return null; }
      if (isChat(h.value)) { this.c.error(e, "chatted() is what a player typed: test it in an if, or read one of the values its pattern names."); return null; }
      const n = this.asInteger(h, e);
      return n === null ? null : num(n);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const member = this.unitMember(e);
      if (member) return this.unitField(e, member);
      const got = this.getterCall(e);
      if (got !== undefined) return this.numberOf(got, e);
    }
    if (ts.isElementAccessExpression(e)) {
      const el = this.elementOf(e);
      if (el === null) return null;
      if (el) {
        if (el.a.kind !== "number") { this.c.error(e, `${el.a.name} holds booleans.`); return null; }
        return this.mark<NumExpr>({ kind: "element", array: el.a.id, index: el.index, at: this.at(e) }, e);
      }
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const found = this.findOr(e, "number");
      if (found !== undefined) return found as NumExpr | null;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length" && this.isTextTyped(e.expression)) {
      const of = this.text(e.expression);
      return of ? this.mark<NumExpr>({ kind: "textLength", of, at: this.at(e), label: this.label(e) }, e) : null;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") {
      // The length of a row, or of an array of arrays, is known or worked out without making anything.
      const part = this.bindingOf(e.expression);
      if (part?.kind === "row") return num(part.length);
      if (part?.kind === "grid") return this.mark<NumExpr>(this.rowsOf(part, e), e);
      if (part?.kind === "lists") return this.mark<NumExpr>({ kind: "length", array: part.ptr.id, at: this.at(e) }, e);
      const b = part && part.kind !== "inner" && part.kind !== "innerUnits" ? part : this.listOf(e.expression);
      if (b?.kind === "array") return this.mark<NumExpr>({ kind: "length", array: b.a.id, at: this.at(e) }, e);
      if (b?.kind === "records") return this.mark<NumExpr>({ kind: "length", array: [...b.fields.values()][0].id, at: this.at(e) }, e);
      if (b?.kind === "units") return this.mark<NumExpr>({ kind: "length", array: b.ptr.id, at: this.at(e) }, e);
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "size") {
      const b = this.bindingOf(e.expression);
      if (b?.kind === "keyed" && b.size) return varRef(b.size);
      if (b?.kind === "hash") return varRef(b.size);
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "array") { this.c.error(e, `${b.a.name} is an array; read one of its cells: ${b.a.name}[i].`); return null; }
      if (b?.kind === "records") { this.c.error(e, `${b.name} is an array of records; read a field of one: ${b.name}[i].${[...b.fields.keys()][0] ?? "field"}.`); return null; }
      if (b?.kind === "cell") {
        if (b.a.kind !== "number") { this.c.error(e, "This field is a boolean."); return null; }
        return this.mark<NumExpr>({ kind: "element", array: b.a.id, index: b.index, at: this.at(e) }, e);
      }
      if (b?.kind === "var") {
        if (b.v.kind === "unit") { this.c.error(e, `${b.v.name} is a unit; use one of its fields: ${b.v.name}.hp.`); return null; }
        if (b.v.kind !== "number") { this.c.error(e, `${b.v.name} is a boolean.`); return null; }
        return varRef(b.v);
      }
      if (b?.kind === "record") { this.c.error(e, "This is a record; use one of its fields."); return null; }
      if (ts.isIdentifier(e)) this.c.error(e, `${e.text} is not a variable of the program.`);
      else this.notConstant(e, "A value");
      return null;
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const inner = this.num(e.operand);
      if (!inner) return null;
      if (e.operator === ts.SyntaxKind.PlusToken) return inner;
      if (e.operator === ts.SyntaxKind.MinusToken) return this.mark<NumExpr>({ kind: "unary", op: "-", expr: inner, at: this.at(e) }, e);
      this.c.error(e, "Only + and - apply to variables.");
      return null;
    }
    // `queue.pop() ?? 0`: what TypeScript asks for, since a pop of an empty array is undefined there. The other value when it is empty.
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = this.unwrap(e.left);
      const list = ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "pop" ? this.bindingOf(left.expression.expression) : undefined;
      const getter = ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "get" ? left.expression.expression : undefined;
      const bound = getter ? this.bindingOf(getter) : undefined;
      // `seen.get(k) ?? 100` of a Map over any number: the other value for a key it has not got.
      if (bound?.kind === "hash" && ts.isCallExpression(left)) return this.hashMethod(left, bound, "get", "number", e.right) as NumExpr | null;
      const table = bound?.kind === "keyed" ? bound : getter && !bound ? this.collectionOf(getter) : undefined;
      if (table?.kind === "keyed" && table.present && ts.isCallExpression(left) && left.arguments.length === 1) {
        // `price.get(k) ?? 100`: the other value for a key that was never set.
        const index = this.keyIndex(table, left.arguments[0]);
        const got = this.num(left);
        const other = this.num(e.right);
        if (!index || !got || !other) return null;
        const at = this.at(e);
        return this.mark<NumExpr>({ kind: "ternary", cond: { kind: "element", array: table.present.id, index, at }, whenTrue: got, whenFalse: other, at, label: this.label(e) }, e);
      }
      if (list?.kind === "array") {
        const popped = this.num(left);
        const other = this.num(e.right);
        if (!popped || !other) return null;
        const at = this.at(e);
        return this.mark<NumExpr>({ kind: "ternary", cond: { kind: "compare", op: ">", left: { kind: "length", array: list.a.id, at }, right: num(0), at, label: this.label(e) }, whenTrue: popped, whenFalse: other, at, label: this.label(e) }, e);
      }
    }
    if (ts.isBinaryExpression(e)) {
      const op = arithOp(ts, e.operatorToken.kind);
      if (!op) { this.c.error(e, "Expected a number: variables take + - * / % and the bitwise & | ^ << >> >>>."); return null; }
      const l = this.num(e.left);
      const r = this.num(e.right);
      if (!l || !r) return null;
      return this.mark<NumExpr>({ kind: "binary", op, left: l, right: r, at: this.at(e), label: this.label(e) }, e);
    }
    if (ts.isConditionalExpression(e)) {
      const cond = this.bool(e.condition);
      const whenTrue = this.num(e.whenTrue);
      const whenFalse = this.num(e.whenFalse);
      if (!whenTrue || !whenFalse) return null;
      return this.mark<NumExpr>({ kind: "ternary", cond, whenTrue, whenFalse, at: this.at(e), label: this.label(e) }, e);
    }
    if (ts.isCallExpression(e)) return this.callValue(e);
    this.c.error(e, "Expected a number: a value, a variable, or arithmetic over them.");
    return null;
  }

  /** A read as a number of the program; one that is a boolean of its own (`isHuman`) counts 1 or 0. */
  private readValue(v: ReadValue, at: TS.Node): NumExpr {
    const read = this.mark<NumExpr>({ kind: "read", read: v.read, at: this.at(at), label: this.label(at) }, at);
    if (v.equals === undefined) return read;
    const cond = this.mark<BoolExpr>({ kind: "compare", op: "==", left: read, right: num(v.equals), at: this.at(at), label: this.label(at) }, at);
    return this.mark<NumExpr>({ kind: "ternary", cond, whenTrue: num(1), whenFalse: num(0), at: this.at(at), label: this.label(at) }, at);
  }

  /** A read as a condition: `isHuman(p)` is its byte being 2, a number is tested `!= 0`. */
  private readBool(v: ReadValue, at: TS.Node): BoolExpr {
    const read = this.mark<NumExpr>({ kind: "read", read: v.read, at: this.at(at), label: this.label(at) }, at);
    if (v.equals === undefined) return this.mark<BoolExpr>({ kind: "test", expr: read, at: this.at(at), label: this.label(at) }, at);
    return this.mark<BoolExpr>({ kind: "compare", op: "==", left: read, right: num(v.equals), at: this.at(at), label: this.label(at) }, at);
  }

  /**
   * A call that reads the game — `minerals(P1)`, `deaths(P1, unit)` without its comparison — made
   * now, with its arguments, which are known when the script is built; what it returns says where
   * the value is. Undefined when the call is not one; null, with a diagnostic, when it failed.
   */
  private readCall(e: TS.CallExpression): ReadValue | null | undefined {
    const callee = this.evaluate(e.expression)?.value;
    const reads = isReader(callee) || (isBuilder(callee) && callee.kind === "condition" && READ_ARITY.get(callee.ident) === e.arguments.length);
    if (!reads) return undefined;
    const args: unknown[] = [];
    for (const a of e.arguments) {
      const h = this.evaluate(a);
      if (!h || isRead(h.value)) { this.notConstant(a, "What to read"); return null; }
      args.push(h.value);
    }
    let out: unknown;
    try { out = (callee as (...a: unknown[]) => unknown)(...args); } catch (err) { throw new ValueError(e, err instanceof Error ? err.message : String(err)); }
    if (!isRead(out)) { this.c.error(e, "Expected a read."); return null; }
    return out;
  }

  /** What a method or a getter gave, as a number. */
  private numberOf(call: Call | null, e: TS.Expression): NumExpr | null {
    if (!call) return null;
    if (call.result?.kind !== "number") { this.c.error(e, `${call.name ?? "This"} does not give a number.`); return null; }
    return this.mark<NumExpr>({ kind: "call", call }, e);
  }

  /** A call as a number: a function of the body or a game function (its result), or an intrinsic over variables. */
  private callValue(e: TS.CallExpression): NumExpr | null {
    const { ts } = this;
    const ofText = this.textNumber(e);
    if (ofText !== undefined) return ofText;
    const method = this.methodCall(e);
    if (method !== undefined) return this.numberOf(method, e);
    if (ts.isIdentifier(e.expression) && (e.expression.text === "parseInt" || e.expression.text === "Number" || e.expression.text === "parseFloat") && !this.gameDeclaration(e.expression)) {
      this.c.error(e, `${e.expression.text}() of a text of the program is not something the game can do yet: keep the number in a variable of its own, and make the text from it.`);
      return null;
    }
    if (ts.isPropertyAccessExpression(e.expression) && SEARCHES.has(e.expression.name.text)) {
      const over = this.overOf(e.expression.expression);
      if (over) return this.searchCall(e, over, e.expression.name.text, "number") as NumExpr | null;
    }
    if (ts.isPropertyAccessExpression(e.expression)) {
      const list = this.arrayOf(e.expression.expression);
      if (list?.kind === "array") {
        const out = this.arrayCall(e, list.a, e.expression.name.text, "number");
        return out && out !== true ? (out as NumExpr) : null;
      }
      if (list?.kind === "hash") {
        const out = this.hashMethod(e, list, e.expression.name.text, "number");
        return out && out !== true ? (out as NumExpr) : null;
      }
      const made = list?.kind === "keyed" ? list : !list && e.arguments.length && !this.evaluate(e.arguments[0]) ? this.collectionOf(e.expression.expression) : undefined;
      if (made) {
        const out = this.keyedCall(e, made, e.expression.name.text, "number");
        return out && out !== true ? (out as NumExpr) : null;
      }
    }
    if (ts.isIdentifier(e.expression)) {
      const decl = this.gameDeclaration(e.expression);
      if (decl && ts.isFunctionDeclaration(decl)) {
        const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
        if (kind !== "number") { this.c.error(e, `${e.expression.text} does not return a number.`); return null; }
        const call = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl);
        return call?.result ? this.mark<NumExpr>({ kind: "call", call }, e) : null;
      }
    }
    const args = (n: number, what: string): NumExpr[] | null => {
      if (e.arguments.length !== n) { this.c.error(e, `${what} takes ${n} argument${n === 1 ? "" : "s"}.`); return null; }
      const out: NumExpr[] = [];
      for (const a of e.arguments) { const l = this.num(a); if (!l) return null; out.push(l); }
      return out;
    };
    const intrinsic = (name: "min" | "max" | "abs", list: NumExpr[]): NumExpr => this.mark<NumExpr>({ kind: "intrinsic", name, args: list, at: this.at(e), label: this.label(e) }, e);
    if (this.isLibraryCall(e, "random")) {
      if (e.arguments.length !== 1) { this.c.error(e, "random() is a coin toss, a boolean; random(n) is a number from 0 to n − 1."); return null; }
      const bound = this.num(e.arguments[0]);
      return bound ? this.mark<NumExpr>({ kind: "randomInt", bound, at: this.at(e), label: this.label(e) }, e) : null;
    }
    const read = this.readCall(e);
    if (read !== undefined) return read ? this.readValue(read, e) : null;
    for (const to of ["u32", "i32"] as const) {
      if (!this.isLibraryCall(e, to)) continue;
      // The same 32 bits, read the other way: nothing is computed.
      const a = args(1, `${to}()`);
      return a ? this.mark<NumExpr>({ kind: "cast", to, expr: a[0], at: this.at(e) }, e) : null;
    }
    if (this.isLibraryCall(e, "clamp")) {
      const a = args(3, "clamp()");
      if (!a) return null;
      return intrinsic("min", [intrinsic("max", [a[0], a[1]]), a[2]]);
    }
    const callee = this.evaluate(e.expression)?.value;
    if (isGameFunction(callee)) {
      const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
      if (kind !== "number") { this.c.error(e, "This game function does not return a number."); return null; }
      const call = this.gameCall(e, callee);
      return call?.result ? this.mark<NumExpr>({ kind: "call", call }, e) : null;
    }
    if (callee === Math.floor || callee === Math.trunc || callee === Math.round || callee === Math.ceil) {
      const a = args(1, "Math rounding");
      return a ? a[0] : null; // Whole numbers already.
    }
    if (callee === Math.abs) {
      const a = args(1, "Math.abs()");
      return a ? intrinsic("abs", [a[0]]) : null;
    }
    if (callee === Math.min || callee === Math.max) {
      if (e.arguments.length === 0) { this.c.error(e, "Math.min / Math.max take at least one argument."); return null; }
      let acc: NumExpr | null = null;
      for (const a of e.arguments) {
        const l = this.num(a);
        if (!l) return null;
        acc = acc ? intrinsic(callee === Math.min ? "min" : "max", [acc, l]) : l;
      }
      return acc;
    }
    if (isBuilder(callee)) { this.c.error(e, callee.kind === "condition" ? "This is a condition; test it in an if or a while." : "This is an action; it stands as a statement."); return null; }
    if (typeof callee === "function") { this.c.error(e, "This helper is computed when the script is built and cannot take a variable of the program. Write it as a game() function to run it in the game."); return null; }
    this.notConstant(e, "A call's arguments");
    return null;
  }

  /**
   * An action with arguments from the program: `setResources(P1, "add", n, "ore")`,
   * `createUnit(P2, m.unit, count, at)`. The record is built with each such place as 0;
   * the backend does the action with the expressions' values in those fields.
   */
  private actionWithVars(e: TS.CallExpression, ident: string, def: Parameters<typeof scriptParams>[0]) {
    const params = scriptParams(def);
    const values: unknown[] = [];
    const variables: { index: number; expr: NumExpr }[] = [];
    let text: TextExpr | undefined;
    for (let i = 0; i < e.arguments.length; i++) {
      const a = e.arguments[i];
      const h = this.evaluate(a);
      // A read is the program's value, not the script's: it takes the variable's place.
      if (h && !isGameValue(h.value)) { values.push(h.value); continue; }
      const p = params[i];
      if (!p) { this.c.error(a, `${ident} takes ${params.length} argument${params.length === 1 ? "" : "s"}.`); return; }
      if (p.arg.kind === "text") {
        // The program's text: one of the map's table goes in as its id; one that was made goes through a string the build keeps for this kind of field.
        const given = this.text(a);
        if (!given) return;
        if (!textHasId(given, this.keptAs) && !MADE_TEXT_ACTIONS.has(def.type)) { this.c.error(a, `${ident}'s text is one the game looks up by number, and this text is made while the map is played. The objectives, a leaderboard's label and a transmission's text take a made text; print() and displayText() show one in the chat area; here it has to be a text written in the script.`); return; }
        text = given;
        values.push("");
        continue;
      }
      const eligible = ((p.arg.kind === "amount" || p.arg.kind === "duration") && ACTIONS_WITH_MODIFIER.has(def.type)) || (p.arg.kind === "count" && COUNT_ACTIONS.has(def.type)) || p.arg.kind === "unit";
      if (!eligible) {
        this.c.error(a, `${ident}'s ${p.name} must be known when the script is built. An amount with a modifier (setResources, setDeaths, setScore, setCountdownTimer), a unit count (createUnit, killUnitAt, removeUnitAt, giveUnits) and a unit type can be a variable of the program.`);
        return;
      }
      const expr = this.num(a);
      if (!expr) return;
      variables.push({ index: i, expr });
      // The record is built with a stand-in: a unit type any action takes, 0 elsewhere.
      values.push(0);
    }
    if (!variables.length && !text) { this.notConstant(e, "A call's arguments"); return; }
    let record: ActionRecord;
    try {
      const built = (this.evaluate(e.expression)!.value as (...a: unknown[]) => unknown)(...values);
      if (!isAction(built)) { this.c.error(e, "Expected an action."); return; }
      record = built.record;
    } catch (err) {
      throw new ValueError(e, err instanceof Error ? err.message : String(err));
    }
    const list: ActionVariable[] = variables.map((v) => {
      const p = params[v.index];
      return { field: p.arg.field as keyof ActionRecord, bits: p.arg.kind === "count" ? 8 : p.arg.kind === "unit" ? 16 : 32, name: p.name, expr: v.expr };
    });
    this.emit({ kind: "action", record: { ...record }, ...(list.length ? { variables: list } : {}), ...(text ? { text } : {}), at: this.at(e), label: this.label(e) }, e);
  }

  /* ── Units on the map, and the game's tables ── */

  /** `u.hp`, `target?.kills`: the unit and the member's name, when the object is a unit of the game. */
  private unitMember(expr: TS.Expression): { unit: UnitExpr; name: string } | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.name) || !this.isUnitTyped(e.expression)) return null;
    const unit = this.unitExpr(e.expression);
    return unit ? { unit, name: e.name.text } : null;
  }

  /** A unit of the game, or none: a variable, `null`, a pick (`first(…)`), a function's result. Null, with a diagnostic, otherwise. */
  private unitExpr(expr: TS.Expression): UnitExpr | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) {
      if (h.value === null || h.value === undefined) return NO_UNIT;
      if (isUnitPick(h.value)) return this.pick(h.value, e);
      this.c.error(e, `Expected a unit of the game, got ${describe(h.value)}.`);
      return null;
    }
    const got = ts.isCallExpression(e) ? this.methodCall(e) : this.getterCall(e);
    if (got !== undefined) {
      if (got && got.result?.kind !== "unit") { this.c.error(e, `${got.name ?? "This"} does not give a unit.`); return null; }
      return got ? this.mark<UnitExpr>({ kind: "call", call: got }, e) : null;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const kept = this.bindingOf(e);
      if (kept?.kind === "unitAt") return this.unitAtPlaces(kept, e);
    }
    if (ts.isElementAccessExpression(e)) {
      const of = this.arrayOf(e.expression);
      if (of?.kind === "units") {
        const h = this.evaluate(e.argumentExpression);
        const index = h ? (() => { const i = this.asInteger(h, e.argumentExpression); return i === null ? null : num(i); })() : this.num(e.argumentExpression);
        return index ? this.unitAtIndex(of, index, e) : null;
      }
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "pop" && e.arguments.length === 0) {
      const of = this.bindingOf(e.expression.expression);
      if (of?.kind === "units") {
        // The unit that was last, which the array then no longer has: the three numbers popped together.
        const parts = this.unitArrays(of).map(([a]) => { a.dynamic = true; return { kind: "pop" as const, array: a.id, at: this.at(e) }; });
        return this.mark<UnitExpr>({ kind: "unitAt", ptr: parts[0], epd: parts[1], uid: parts[2], at: this.at(e) }, e);
      }
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var" && b.v.kind === "unit") return unitRef(b.v);
      this.c.error(e, "Expected a unit of the game: a variable holding one, first(…), nearest(…) or randomUnit(…).");
      return null;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && (e.expression.name.text === "find" || e.expression.name.text === "findLast")) {
      // `squad.find((u) => u.hp < 50)`, `unitsOf(P1).find(…)`: the unit, or none.
      const over = this.overOf(e.expression.expression);
      if (over) return this.searchCall(e, over, e.expression.name.text, "unit") as UnitExpr | null;
    }
    if (ts.isCallExpression(e)) {
      let call: Call | undefined;
      const decl = ts.isIdentifier(e.expression) ? this.gameDeclaration(e.expression) : undefined;
      if (decl && ts.isFunctionDeclaration(decl)) call = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl);
      else {
        const callee = this.evaluate(e.expression)?.value;
        if (isGameFunction(callee)) call = this.gameCall(e, callee);
        else { this.notConstant(e, "What picks the unit (the type, the owner, the location)"); return null; }
      }
      if (!call?.result || call.result.kind !== "unit") { if (call) this.c.error(e, "This function does not return a unit."); return null; }
      return this.mark<UnitExpr>({ kind: "call", call }, e);
    }
    if (ts.isConditionalExpression(e)) { this.c.error(e, "Choose the unit with an if: let u = a; if (…) u = b;"); return null; }
    this.c.error(e, "Expected a unit of the game.");
    return null;
  }

  private pick(v: UnitPickValue, at: TS.Node): UnitExpr {
    return this.mark<UnitExpr>({ kind: "pick", by: v.by, filter: { ...v.filter }, ...(v.near !== undefined ? { near: v.near } : {}), ...(v.mouse !== undefined ? { mouse: v.mouse, within: v.within ?? 48 } : {}), at: this.at(at), label: this.label(at) }, at);
  }

  /** `u.hp` as a number. */
  private unitField(e: TS.Node, m: { unit: UnitExpr; name: string }): NumExpr | null {
    if ((UNIT_FLAGS as readonly string[]).includes(m.name)) {
      const flag = this.mark<BoolExpr>({ kind: "unitFlag", unit: m.unit, flag: m.name as UnitFlag, at: this.at(e), label: this.label(e) }, e);
      return this.mark<NumExpr>({ kind: "ternary", cond: flag, whenTrue: num(1), whenFalse: num(0), at: this.at(e), label: this.label(e) }, e);
    }
    if (!(UNIT_NUM_FIELDS as readonly string[]).includes(m.name)) { this.c.error(e, `A unit has no ${m.name} to read.`); return null; }
    return this.mark<NumExpr>({ kind: "unitField", unit: m.unit, field: m.name as UnitNumField, at: this.at(e), label: this.label(e) }, e);
  }

  private unitWrite(e: TS.Node, m: { unit: UnitExpr; name: string }, value: NumExpr | BoolExpr) {
    if (!UNIT_WRITABLE.has(m.name)) {
      const why = m.name === "x" || m.name === "y" ? "the game ends when a unit's position is written; move a unit with order(), or moveUnit()"
        : m.name === "owner" ? "give() changes the owner" : m.name === "cloaked" ? "the game showed nothing when the cloak flags were written" : "the game keeps it for itself";
      this.c.error(e, `A unit's ${m.name} is read only: ${why}.`);
      return;
    }
    this.emit({ kind: "unitWrite", unit: m.unit, field: m.name as UnitNumField | UnitFlag, value, at: this.at(e), label: this.label(e) }, e);
  }

  /** `u.hp = 40`, `u.energy += 50`, `u.invincible = true`. */
  private unitAssign(e: TS.BinaryExpression, m: { unit: UnitExpr; name: string }, op: TS.SyntaxKind) {
    const { ts } = this;
    if ((UNIT_FLAGS as readonly string[]).includes(m.name)) {
      if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "Booleans take = only."); return; }
      this.unitWrite(e, m, this.boolValue(e.right));
      return;
    }
    const rhs = this.num(e.right);
    if (!rhs) return;
    if (op === ts.SyntaxKind.EqualsToken) { this.unitWrite(e, m, rhs); return; }
    const arith = compoundOp(ts, op);
    const now = arith ? this.unitField(e.left, m) : null;
    if (!arith) { this.c.error(e, "Only = += -= *= /= %= &= |= ^= <<= >>= assign a number."); return; }
    if (now) this.unitWrite(e, m, this.mark<NumExpr>({ kind: "binary", op: arith, left: now, right: rhs, at: this.at(e), label: this.label(e) }, e));
  }

  /** `u.kill()`, `u.order("move", locations.Exit)`, `u.damage({ percent: 50 })`: what a unit is told to do. */
  private unitCall(e: TS.CallExpression, m: { unit: UnitExpr; name: string }) {
    const { ts } = this;
    const known = (i: number, what: string): unknown => {
      const a = e.arguments[i];
      if (!a) { this.c.error(e, `${m.name}() takes ${what}.`); return undefined; }
      const h = this.evaluate(a);
      if (!h || isGameValue(h.value)) { this.notConstant(a, what[0].toUpperCase() + what.slice(1)); return undefined; }
      return h.value;
    };
    const emit = (verb: UnitVerb) => { this.emit({ kind: "unitDo", unit: m.unit, verb, at: this.at(e), label: this.label(e) }, e); };
    const location = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 255;
    switch (m.name) {
      case "kill": case "remove":
        if (e.arguments.length) { this.c.error(e, `${m.name}() takes no arguments.`); return; }
        emit({ do: m.name });
        return;
      case "give": {
        const to = known(0, "the player who gets the unit");
        if (to === undefined) return;
        if (typeof to !== "number" || !Number.isInteger(to) || !((to >= 0 && to < 12) || to === CURRENT_PLAYER)) { this.c.error(e.arguments[0], "give() takes one player: P1 … P12 or CurrentPlayer."); return; }
        emit({ do: "give", to });
        return;
      }
      case "order": {
        const order = known(0, "the order: \"move\", \"patrol\" or \"attack\"");
        const target = order === undefined ? undefined : known(1, "the location to go to");
        if (order === undefined || target === undefined) return;
        if (typeof order !== "string" || !ORDERS.includes(order)) { this.c.error(e.arguments[0], `order() takes "move", "patrol" or "attack", got ${describe(order)}.`); return; }
        if (!location(target)) { this.c.error(e.arguments[1], "order() takes one of locations.* to go to."); return; }
        emit({ do: "order", order: order as "move" | "patrol" | "attack", target });
        return;
      }
      case "locate": {
        const at = known(0, "the location to centre on the unit");
        if (at === undefined) return;
        if (!location(at) || at === 64) { this.c.error(e.arguments[0], "locate() takes one of locations.*, which is moved onto the unit (not Anywhere)."); return; }
        emit({ do: "locate", location: at });
        return;
      }
      case "damage": case "heal": {
        const a = e.arguments[0];
        if (!a || e.arguments.length > 1) { this.c.error(e, `${m.name}() takes hit points, or { percent: 50 } of the type's maximum.`); return; }
        const literal = this.unwrap(a);
        let percent = false;
        let of: TS.Expression = a;
        if (ts.isObjectLiteralExpression(literal)) {
          const p = literal.properties.length === 1 ? literal.properties[0] : undefined;
          if (!p || !ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || p.name.text !== "percent") { this.c.error(a, `${m.name}() takes hit points, or { percent: 50 } of the type's maximum.`); return; }
          percent = true;
          of = p.initializer;
        }
        const amount = this.num(of);
        if (amount) emit({ do: m.name, amount, percent });
        return;
      }
      default:
        this.c.error(e.expression, `A unit has no ${m.name}().`);
    }
  }

  /** A cell of the game's tables as a number: `stats(units.TerranMarine).minerals`. */
  private tableRead(v: TableValue, at: TS.Node): NumExpr | null {
    if (v.field.writeOnly) { this.c.error(at, `${v.ident} can be set but not read: ${v.field.special === "speed" ? "a speed is four records of the game's tables" : v.field.special === "name" ? "a name is text" : "the game keeps two copies"}.`); return null; }
    return this.mark<NumExpr>({ kind: "tableRead", cell: { ...v.cell }, at: this.at(at), label: this.label(at) }, at);
  }

  private tableWrite(e: TS.Node, v: TableValue, value: NumExpr | BoolExpr | TextExpr, scaled = false) {
    if (v.field.readonly) { this.c.error(e, `${v.ident} is read only: the game took no write.`); return; }
    this.emit({ kind: "tableWrite", cell: { ...v.cell }, value, ...(scaled ? { scaled: true } : {}), ...(v.field.boolean && value.kind !== "text" ? { boolean: true } : {}), at: this.at(e), label: this.label(e) }, e);
  }

  /** `stats(units.TerranMarine).minerals = 25`, `stats(P3).color = "teal"`, `stats(weapons.GaussRifle).damage += 2`. */
  private tableAssign(e: TS.BinaryExpression, v: TableValue, op: TS.SyntaxKind) {
    const { ts } = this;
    const { field } = v;
    const plain = op === ts.SyntaxKind.EqualsToken;
    const h = this.evaluate(e.right);
    const known = h && !isGameValue(h.value) ? h.value : undefined;
    if (field.special === "name" || field.special === "color") {
      if (!plain) { this.c.error(e, `${v.ident} takes = only.`); return; }
      if (known === undefined && field.special === "name") {
        // A name made while the map is played: the build keeps a string of the table for this unit type and writes the text over it.
        const made = this.text(e.right);
        if (made) this.tableWrite(e, v, made);
        return;
      }
      if (known === undefined) { this.notConstant(e.right, "A colour"); return; }
      if (field.special === "color") {
        try { this.tableWrite(e, v, num(playerColor(known))); } catch (err) { this.c.error(e.right, err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (typeof known !== "string" || known === "" || hasTextMark(known)) { this.c.error(e.right, "A unit type's name is text known when the script is built."); return; }
      this.tableWrite(e, v, { kind: "text", text: known });
      return;
    }
    if (field.boolean) {
      if (!plain) { this.c.error(e, "Booleans take = only."); return; }
      this.tableWrite(e, v, this.boolValue(e.right));
      return;
    }
    if (plain && typeof known === "number" && Number.isFinite(known)) {
      // Known when the script is built: scaled now, so a fraction the cell can hold (1.5 seconds, a Zergling's half supply) is fine.
      const raw = Math.round(known * (field.scale ?? 1));
      const max = cellMax(field.width);
      if (known < 0 || raw > max) { this.c.error(e.right, `${v.ident} holds 0 … ${max / (field.scale ?? 1)}, not ${known}.`); return; }
      if (!field.scale && !Number.isInteger(known)) { this.c.error(e.right, `${v.ident} is a whole number (got ${known}).`); return; }
      this.tableWrite(e, v, num(raw), true);
      return;
    }
    const rhs = this.num(e.right);
    if (!rhs) return;
    if (plain) { this.tableWrite(e, v, rhs); return; }
    const arith = compoundOp(ts, op);
    if (!arith) { this.c.error(e, "Only = += -= *= /= %= &= |= ^= <<= >>= assign a number."); return; }
    const now = this.tableRead(v, e.left);
    if (now) this.tableWrite(e, v, this.mark<NumExpr>({ kind: "binary", op: arith, left: now, right: rhs, at: this.at(e), label: this.label(e) }, e));
  }

  /* ── Booleans ── */

  /** The value stored into a boolean: a constant, a coin toss, a condition tree. */
  private boolValue(expr: TS.Expression): BoolExpr {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h && typeof h.value === "boolean") return { kind: "const", value: h.value };
    if (this.isLibraryCall(e, "random") && (e as TS.CallExpression).arguments.length === 0) return this.mark<BoolExpr>({ kind: "random", at: this.at(e) }, e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = this.varOf(e.operand);
      if (v && v.kind === "boolean") return { kind: "not", expr: boolRef(v) };
    }
    return this.bool(e);
  }

  /** `rose(c)`: true on the cycle `c` becomes true; `once(c)`: true the first time it holds. */
  private edge(call: TS.CallExpression, kind: "rose" | "once"): BoolExpr {
    if (call.arguments.length !== 1) { this.c.error(call, `${kind}() takes one condition.`); return FALSE; }
    return this.mark<BoolExpr>({ kind: "edge", edge: kind, cond: this.bool(call.arguments[0]), at: this.at(call), label: this.label(call) }, call);
  }

  /** A hoisted value as a condition. */
  private hoistedBool(h: Hoisted, at: TS.Node): BoolExpr {
    const v = h.value;
    if (typeof v === "boolean") return v ? TRUE : FALSE;
    if (typeof v === "number") return v !== 0 ? TRUE : FALSE;
    if (typeof v === "string") return v !== "" ? TRUE : FALSE;
    if (isCondition(v)) return this.mark<BoolExpr>({ kind: "cond", record: { ...v.record } }, at);
    if (isRead(v)) return this.readBool(v, at);
    if (isTable(v)) { const read = this.tableRead(v, at); return read ? this.mark<BoolExpr>({ kind: "test", expr: read, at: this.at(at), label: this.label(at) }, at) : FALSE; }
    if (isInput(v)) return this.inputBool(v, at);
    if (isChat(v)) return this.inputBool(v.matched, at);
    if (isMouse(v)) { this.c.error(at, "mouse() is a place on the map, not a condition: compare its x or its y."); return FALSE; }
    if (Array.isArray(v) && v.length > 0 && v.every(isCondition)) return { kind: "and", items: v.map((c) => this.mark<BoolExpr>({ kind: "cond", record: { ...c.record } }, at)) };
    if (isAction(v)) { this.c.error(at, "This is an action, not a condition."); return FALSE; }
    this.c.error(at, `Expected a condition, got ${describe(v)}.`);
    return FALSE;
  }

  /** A condition as a `BoolExpr` tree. */
  private bool(expr: TS.Expression): BoolExpr {
    return this.boolInner(expr, 0);
  }

  private boolInner(expr: TS.Expression, depth: number): BoolExpr {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (depth > 64) { this.c.error(e, "The condition nests too deeply."); return FALSE; }
    if (this.isUnitTyped(e)) {
      // `if (target)`: there is a unit, and it is still on the map.
      const unit = this.unitExpr(e);
      return unit ? this.mark<BoolExpr>({ kind: "unitAlive", unit, at: this.at(e), label: this.label(e) }, e) : FALSE;
    }
    const h = this.evaluate(expr);
    if (h) return this.hoistedBool(h, e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return { kind: "not", expr: this.boolInner(e.operand, depth + 1) };
    if ((ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) && !this.isTextTyped(e)) {
      // `if (s.alive())`, `if (s.ready)`: a method or a getter, tested as any call is.
      const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
      const got = ts.isCallExpression(e) ? this.methodCall(e) : this.getterCall(e);
      if (got !== undefined) {
        if (got && !kind) this.c.error(e, `${got.name ?? "This"} gives nothing to test; test a variable it sets instead.`);
        return got?.result ? this.mark<BoolExpr>({ kind: "call", call: got }, e) : FALSE;
      }
    }
    const ofTexts = this.textCondition(e);
    if (ofTexts) return ofTexts;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      // `flags.get(k) ?? false` of a Map over any number: the other value for a key it has not got.
      const left = this.unwrap(e.left);
      const table = ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "get" ? this.bindingOf(left.expression.expression) : undefined;
      if (table?.kind === "hash" && ts.isCallExpression(left)) {
        const numeric = table.values?.kind === "number";
        const out = this.hashMethod(left, table, "get", numeric ? "number" : "boolean", e.right);
        if (!out || out === true) return FALSE;
        return numeric ? this.mark<BoolExpr>({ kind: "test", expr: out as NumExpr, at: this.at(e), label: this.label(e) }, e) : (out as BoolExpr);
      }
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.mark<BoolExpr>({ kind: "and", items: [this.boolInner(e.left, depth + 1), this.boolInner(e.right, depth + 1)] }, e);
      if (op === ts.SyntaxKind.BarBarToken) return this.mark<BoolExpr>({ kind: "or", items: [this.boolInner(e.left, depth + 1), this.boolInner(e.right, depth + 1)] }, e);
      const cmp = compareOp(ts, op);
      if (cmp) return this.comparison(e, cmp, depth);
      this.c.error(e, "Expected a condition.");
      return FALSE;
    }
    if (ts.isConditionalExpression(e)) {
      // `c ? p : q` as a truth value.
      const cond = this.bool(e.condition);
      const whenTrue = this.boolValue(e.whenTrue);
      const whenFalse = this.boolValue(e.whenFalse);
      return this.mark<BoolExpr>({ kind: "ternary", cond, whenTrue, whenFalse, at: this.at(e), label: this.label(e) }, e);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const member = this.unitMember(e);
      if (member) {
        if ((UNIT_FLAGS as readonly string[]).includes(member.name)) return this.mark<BoolExpr>({ kind: "unitFlag", unit: member.unit, flag: member.name as UnitFlag, at: this.at(e), label: this.label(e) }, e);
        const field = this.unitField(e, member);
        return field ? this.mark<BoolExpr>({ kind: "test", expr: field, at: this.at(e), label: this.label(e) }, e) : FALSE;
      }
    }
    if (ts.isElementAccessExpression(e)) {
      const el = this.elementOf(e);
      if (el === null) return FALSE;
      if (el) {
        const cell = { kind: "element" as const, array: el.a.id, index: el.index, at: this.at(e) };
        return el.a.kind === "boolean" ? this.mark<BoolExpr>(cell, e) : this.mark<BoolExpr>({ kind: "test", expr: cell, at: this.at(e), label: this.label(e) }, e);
      }
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") return b.v.kind !== "number" ? boolRef(b.v) : this.mark<BoolExpr>({ kind: "test", expr: varRef(b.v), at: this.at(e), label: this.label(e) }, e);
      if (b?.kind === "cell") {
        const cell = { kind: "element" as const, array: b.a.id, index: b.index, at: this.at(e) };
        return b.a.kind === "boolean" ? this.mark<BoolExpr>(cell, e) : this.mark<BoolExpr>({ kind: "test", expr: cell, at: this.at(e), label: this.label(e) }, e);
      }
      if (b?.kind === "record" && b.truth) return boolRef(b.truth);
      if (b?.kind === "record") { this.c.error(e, "This is a record; test one of its fields."); return FALSE; }
      if (ts.isIdentifier(e)) this.c.error(e, `${e.text} is not a variable of the program or a condition.`);
      else this.notConstant(e, "A condition");
      return FALSE;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && SEARCHES.has(e.expression.name.text)) {
      const over = this.overOf(e.expression.expression);
      if (over) {
        // A number (findIndex, a sum) tested as one is `!= 0`, as any number is.
        const numeric = this.kindOf(this.c.checker.getTypeAtLocation(e)) === "number";
        const out = this.searchCall(e, over, e.expression.name.text, numeric ? "number" : "boolean");
        if (!out) return FALSE;
        return numeric ? this.mark<BoolExpr>({ kind: "test", expr: out as NumExpr, at: this.at(e), label: this.label(e) }, e) : (out as BoolExpr);
      }
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const list = this.arrayOf(e.expression.expression);
      if (list?.kind === "array") {
        // A number of the array (indexOf, a pop of numbers) tested as one is `!= 0`, as any number is.
        const numeric = e.expression.name.text === "indexOf" || (e.expression.name.text === "pop" && list.a.kind === "number");
        const out = this.arrayCall(e, list.a, e.expression.name.text, numeric ? "number" : "boolean");
        if (!out || out === true) return FALSE;
        return numeric ? this.mark<BoolExpr>({ kind: "test", expr: out as NumExpr, at: this.at(e), label: this.label(e) }, e) : (out as BoolExpr);
      }
      if (list?.kind === "hash") {
        const numeric = e.expression.name.text === "get" && list.values?.kind === "number";
        const out = this.hashMethod(e, list, e.expression.name.text, numeric ? "number" : "boolean");
        if (!out || out === true) return FALSE;
        return numeric ? this.mark<BoolExpr>({ kind: "test", expr: out as NumExpr, at: this.at(e), label: this.label(e) }, e) : (out as BoolExpr);
      }
      const made = list?.kind === "keyed" ? list : !list && e.arguments.length && !this.evaluate(e.arguments[0]) ? this.collectionOf(e.expression.expression) : undefined;
      if (made) {
        // get() of a Map of numbers tested as one is `!= 0`, as any number is.
        const numeric = e.expression.name.text === "get" && made.values?.kind === "number";
        const out = this.keyedCall(e, made, e.expression.name.text, numeric ? "number" : "boolean");
        if (!out || out === true) return FALSE;
        return numeric ? this.mark<BoolExpr>({ kind: "test", expr: out as NumExpr, at: this.at(e), label: this.label(e) }, e) : (out as BoolExpr);
      }
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) {
        const decl = this.gameDeclaration(e.expression);
        if (decl && ts.isFunctionDeclaration(decl)) return this.callBool(e, () => this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl));
      }
      if (this.isLibraryCall(e, "random")) {
        if (e.arguments.length === 0) return this.mark<BoolExpr>({ kind: "random", at: this.at(e) }, e);
        const n = this.callValue(e);
        return n ? this.mark<BoolExpr>({ kind: "test", expr: n, at: this.at(e), label: this.label(e) }, e) : FALSE;
      }
      if (this.isLibraryCall(e, "rose")) return this.edge(e, "rose");
      if (this.isLibraryCall(e, "once")) return this.edge(e, "once");
      if (this.isLibraryCall(e, "sleep")) { this.c.error(e, "sleep() is a statement, not a condition."); return FALSE; }
      const read = this.readCall(e);
      if (read !== undefined) return read ? this.readBool(read, e) : FALSE;
      const callee = this.evaluate(e.expression)?.value;
      if (isGameFunction(callee)) return this.callBool(e, () => this.gameCall(e, callee));
      if (isBuilder(callee) && callee.kind === "condition") { this.c.error(e, `A condition's amount is known when the script is built. To compare with a variable of the program, read the value and compare it yourself: ${callee.ident}(…) >= x, without the comparison and the amount inside the call.`); return FALSE; }
      if (isBuilder(callee)) { this.c.error(e, "This is an action, not a condition."); return FALSE; }
      this.notConstant(e, "A condition's arguments");
      return FALSE;
    }
    this.c.error(e, "Expected a condition: a trigger condition, a comparison, a boolean variable, or a combination with && || !.");
    return FALSE;
  }

  /** A call whose result is tested: a boolean result, or a number's `!= 0`. */
  private callBool(e: TS.CallExpression, run: () => Call | undefined): BoolExpr {
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
    if (!kind) { this.c.error(e, "This function returns nothing to test; test a variable it sets instead."); return FALSE; }
    const call = run();
    return call?.result ? this.mark<BoolExpr>({ kind: "call", call }, e) : FALSE;
  }

  private comparison(e: TS.BinaryExpression, op: CompareOp, depth: number): BoolExpr {
    // Units: `target != null`, `u == target`.
    if (this.isUnitTyped(e.left) || this.isUnitTyped(e.right)) {
      if (op !== "==" && op !== "!=") { this.c.error(e, "Units compare with == and != only."); return FALSE; }
      const none = (x: TS.Expression) => { const h = this.evaluate(x); return !!h && (h.value === null || h.value === undefined); };
      const side = none(e.left) ? e.right : none(e.right) ? e.left : null;
      let same: BoolExpr;
      if (side) {
        const unit = this.unitExpr(side);
        if (!unit) return FALSE;
        // Not none is "there is one": `target != null` and `if (target)` ask the same.
        same = { kind: "not", expr: this.mark<BoolExpr>({ kind: "unitAlive", unit, at: this.at(e), label: this.label(e) }, e) };
      } else {
        const left = this.unitExpr(e.left);
        const right = this.unitExpr(e.right);
        if (!left || !right) return FALSE;
        same = this.mark<BoolExpr>({ kind: "unitSame", left, right, at: this.at(e), label: this.label(e) }, e);
      }
      return op === "==" ? same : same.kind === "not" ? same.expr : { kind: "not", expr: same };
    }
    // Texts: the same characters, or the order of them.
    if (this.isTextTyped(e.left) && this.isTextTyped(e.right)) {
      const left = this.text(e.left);
      const right = this.text(e.right);
      return left && right ? this.mark<BoolExpr>({ kind: "textCompare", op, left, right, at: this.at(e), label: this.label(e) }, e) : FALSE;
    }
    // What chatted() found, against null: `m != null` asks what `if (m)` asks.
    const found = (x: TS.Expression) => { const b = this.bindingOf(x); return b?.kind === "record" && b.truth ? b.truth : undefined; };
    const isNull = (x: TS.Expression) => { const h = this.evaluate(x); return !!h && (h.value === null || h.value === undefined); };
    const truth = isNull(e.right) ? found(e.left) : isNull(e.left) ? found(e.right) : undefined;
    if (truth) {
      if (op !== "==" && op !== "!=") { this.c.error(e, "What chatted() found compares with null by == and != only."); return FALSE; }
      return op === "!=" ? boolRef(truth) : { kind: "not", expr: boolRef(truth) };
    }
    // Boolean equality: `flag == true`, `a != b` over switches.
    const isBool = (x: TS.Expression) => {
      const h = this.evaluate(x);
      if (h) return typeof h.value === "boolean" || isCondition(h.value) || (isRead(h.value) && h.value.equals !== undefined) || (isInput(h.value) && h.value.boolean) || isChat(h.value);
      const v = this.varOf(x);
      if (v !== undefined) return v.kind !== "number";
      return this.kindOf(this.c.checker.getTypeAtLocation(x)) === "boolean";
    };
    if (isBool(e.left) || isBool(e.right)) {
      if (op !== "==" && op !== "!=") { this.c.error(e, "Booleans compare with == and != only."); return FALSE; }
      const l = this.boolInner(e.left, depth + 1);
      const r = this.boolInner(e.right, depth + 1);
      const same: BoolExpr = { kind: "or", items: [{ kind: "and", items: [l, r] }, { kind: "and", items: [{ kind: "not", expr: l }, { kind: "not", expr: r }] }] };
      return op === "==" ? same : { kind: "not", expr: same };
    }
    const l = this.num(e.left);
    const r = this.num(e.right);
    if (!l || !r) return FALSE;
    return this.mark<BoolExpr>({ kind: "compare", op, left: l, right: r, at: this.at(e), label: `L${this.line(e)}: ${e.getText(this.body.sf).replace(/\s+/g, " ")}` }, e);
  }
}

function compareOp(ts: typeof TS, kind: TS.SyntaxKind): CompareOp | null {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return "<";
    case ts.SyntaxKind.LessThanEqualsToken: return "<=";
    case ts.SyntaxKind.GreaterThanToken: return ">";
    case ts.SyntaxKind.GreaterThanEqualsToken: return ">=";
    case ts.SyntaxKind.EqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: return "==";
    case ts.SyntaxKind.ExclamationEqualsToken: case ts.SyntaxKind.ExclamationEqualsEqualsToken: return "!=";
    default: return null;
  }
}

export function flipOp(op: CompareOp): CompareOp {
  switch (op) {
    case "<": return ">";
    case "<=": return ">=";
    case ">": return "<";
    case ">=": return "<=";
    default: return op;
  }
}

function arithOp(ts: typeof TS, kind: TS.SyntaxKind): ArithOp | null {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return "+";
    case ts.SyntaxKind.MinusToken: return "-";
    case ts.SyntaxKind.AsteriskToken: return "*";
    case ts.SyntaxKind.SlashToken: return "/";
    case ts.SyntaxKind.PercentToken: return "%";
    case ts.SyntaxKind.AmpersandToken: return "&";
    case ts.SyntaxKind.BarToken: return "|";
    case ts.SyntaxKind.CaretToken: return "^";
    case ts.SyntaxKind.LessThanLessThanToken: return "<<";
    // Numbers are unsigned, so the two right shifts are one.
    case ts.SyntaxKind.GreaterThanGreaterThanToken: return ">>";
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return ">>>";
    default: return null;
  }
}

function compoundOp(ts: typeof TS, kind: TS.SyntaxKind): ArithOp | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken: return "+";
    case ts.SyntaxKind.MinusEqualsToken: return "-";
    case ts.SyntaxKind.AsteriskEqualsToken: return "*";
    case ts.SyntaxKind.SlashEqualsToken: return "/";
    case ts.SyntaxKind.PercentEqualsToken: return "%";
    case ts.SyntaxKind.AmpersandEqualsToken: return "&";
    case ts.SyntaxKind.BarEqualsToken: return "|";
    case ts.SyntaxKind.CaretEqualsToken: return "^";
    case ts.SyntaxKind.LessThanLessThanEqualsToken: return "<<";
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken: return ">>";
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken: return ">>>";
    default: return null;
  }
}

export function compareNumbers(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}
