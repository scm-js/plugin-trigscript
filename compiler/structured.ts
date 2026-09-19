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
import { Scope, type Binding } from "./scope";
import { ACTIONS_WITH_MODIFIER, LowerError } from "./lower";
import { I32_MAX, I32_MIN, IR_VERSION, U32_MAX, UNIT_FLAGS, UNIT_NUM_FIELDS, UNIT_WRITABLE, eachCall, type ActionVariable, type ArithOp, type ArrayDecl, type At, type BoolExpr, type Call, type CompareOp, type FuncDecl, type NumExpr, type Program, type Stmt, type TextPart, type UnitExpr, type UnitFlag, type UnitNumField, type UnitVerb, type VarDecl } from "./ir";

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
  /** Inside an inlined function: what it returns. */
  fn?: { kind: Kind | "void" };
}

/** What a variable of a program holds. */
type Kind = "number" | "boolean" | "unit";

const MAX_INLINE_DEPTH = 16;
const LABEL_LENGTH = 48;
/** The most iterations a `for` is unrolled to. */
export const MAX_UNROLL = 256;
/** Actions whose unit count may be a variable: doing them with n is doing them bit by bit. */
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

/** The most cells an array of a program has: each is four bytes of the built map, twelve times over in a per-player program. */
const MAX_ARRAY = 4096;
const TRUE: BoolExpr = { kind: "const", value: true };
const FALSE: BoolExpr = { kind: "const", value: false };
const num = (value: number): NumExpr => ({ kind: "const", value });
const varRef = (v: VarDecl): NumExpr => ({ kind: "var", id: v.id });
const boolRef = (v: VarDecl): BoolExpr => ({ kind: "var", id: v.id });
const unitRef = (v: VarDecl): UnitExpr => ({ kind: "unitVar", id: v.id });
const NO_UNIT: UnitExpr = { kind: "unitNull" };
const ORDERS: readonly string[] = ["move", "patrol", "attack"];

/** A list of the program: an array, an array of records, an array of units. */
type List = Extract<Binding, { kind: "array" | "records" | "units" }>;
/** What a method that takes a function runs over: a list of the program, the units of the game (`unitsOf(…)`), or a list the script has. */
type Over = List | { kind: "query"; name: string; filter: Extract<Stmt, { kind: "unitLoop" }>["filter"] } | { kind: "values"; name: string; items: unknown[] };
/** The methods that give a list: a new one, or (`sort`, `reverse`) the one they were called on. */
const LIST_MAKERS = new Set(["map", "filter", "sort", "reverse"]);
/** The methods that take a function and give a value. */
const SEARCHES = new Set(["some", "every", "find", "findLast", "findIndex", "findLastIndex", "reduce"]);

/** What a call passes for a parameter: the value a parameter that is a variable is set to, or the array (the record) the parameter stands for. */
type CallArgument = { init: NumExpr | BoolExpr | UnitExpr; label: string } | { binding: Binding };

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

  private newVar(name: string, kind: Kind, at: At, extra: { shared?: boolean; bits?: 8 | 16; unsigned?: boolean; temp?: boolean } = {}): VarDecl {
    return { id: `${name}#${this.nextId++}`, name, kind, shared: extra.shared ?? false, ...(extra.bits ? { bits: extra.bits } : {}), ...(extra.unsigned ? { unsigned: true } : {}), ...(extra.temp ? { temp: true } : {}), at };
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
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
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
      const type = this.c.checker.getTypeAtLocation(d.name);
      // `const w = waves[i]`: the record at i, as it is now — the index is taken once, so moving `i` afterwards does not move `w`.
      if (ts.isElementAccessExpression(init)) {
        const of = this.bindingOf(init.expression);
        if (of?.kind === "records") {
          const index = this.rowIndex(of, init.argumentExpression);
          if (index) this.scope.bind(d, this.rowOf(of, this.temp(index, d, true)));
          continue;
        }
      }
      if ((this.c.checker.isArrayType(type) || this.c.checker.isTupleType(type)) && this.kindOf(this.c.checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? type) === "unit") {
        const squad = this.declareUnits(d.name.text, init, d);
        if (squad) this.scope.bind(d, squad);
        continue;
      }
      const recordsOf = this.recordFields(type);
      if (recordsOf) {
        const records = this.declareRecords(d.name.text, init, recordsOf, d);
        if (records) this.scope.bind(d, records);
        continue;
      }
      const keyedAs = this.keyedForm(init, type);
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
      const kind = this.kindOf(type);
      // `const x = xs.find(…)` would be a number or undefined: searchCall says what to write instead.
      if (!kind && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && (init.expression.name.text === "find" || init.expression.name.text === "findLast")) {
        const over = this.overOf(init.expression.expression);
        if (over) { this.searchCall(init, over, init.expression.name.text, over.kind === "array" ? over.a.kind : "number"); continue; }
      }
      if (!kind) { this.c.error(d, `Variables hold numbers, booleans, units of the game or records of them ({ lives: 3 }); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
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

  /** The fields of an array of records, when a type is one: every property of its element a number or a boolean. */
  private recordFields(type: TS.Type): Map<string, { kind: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }> | null {
    const { ts } = this;
    const checker = this.c.checker;
    if (!checker.isArrayType(type) && !checker.isTupleType(type)) return null;
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!element || this.kindOf(element) || !(element.flags & ts.TypeFlags.Object)) return null;
    const fields = new Map<string, { kind: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }>();
    for (const p of checker.getPropertiesOfType(element)) {
      const t = checker.getTypeOfSymbol(p);
      const kind = this.kindOf(t);
      if (kind !== "number" && kind !== "boolean") return null;
      fields.set(p.name, { kind, width: kind === "number" ? this.widthOf(t) : {} });
    }
    return fields.size ? fields : null;
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

  private rowOf(of: Extract<Binding, { kind: "records" }>, index: NumExpr): Binding {
    return { kind: "record", fields: new Map([...of.fields].map(([name, a]) => [name, { kind: "cell", a, index } as Binding])) };
  }

  /**
   * `let waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]`, `let log: Hit[] = []`: an array a field, all of
   * one length. The fields are the element type's; a record of the list gives each its value.
   */
  private declareRecords(name: string, initializer: TS.Expression, shape: NonNullable<ReturnType<Structured["recordFields"]>>, at: TS.Node): Binding | null {
    const { ts } = this;
    const init = this.unwrap(initializer);
    const grows = this.body.plan.grows.has(at);
    const rows: Map<string, NumExpr | BoolExpr>[] = [];
    const whole = this.evaluate(init);
    if (whole) {
      if (!Array.isArray(whole.value)) { this.c.error(init, `Expected a list of records to start ${name} with, got ${describe(whole.value)}.`); return null; }
      for (const item of whole.value as unknown[]) {
        const row = new Map<string, NumExpr | BoolExpr>();
        for (const [field, { kind }] of shape) {
          const v = (item as Record<string, unknown> | null)?.[field];
          if (kind === "boolean") { if (typeof v !== "boolean") { this.c.error(init, `${name}: ${field} is true or false, got ${describe(v)}.`); return null; } row.set(field, { kind: "const", value: v }); }
          else { const n = this.asInteger({ value: v }, init); if (n === null) return null; row.set(field, num(n)); }
        }
        rows.push(row);
      }
    } else if (ts.isArrayLiteralExpression(init)) {
      for (const item of init.elements) {
        const literal = this.unwrap(item);
        if (!ts.isObjectLiteralExpression(literal)) { this.c.error(item, `${name} is written out record by record: [{ … }, { … }].`); return null; }
        const row = this.rowValues(name, literal, shape);
        if (!row) return null;
        rows.push(row);
      }
    } else {
      this.c.error(init, `${name}'s records have to be written out ([{ … }, { … }]), or it starts empty and is pushed to.`);
      return null;
    }
    // Written empty, it can only be one that grows — pushed to here, or by a function it is handed to.
    const dynamic = grows || rows.length === 0;
    if (rows.length < (dynamic ? 0 : 1) || rows.length > MAX_ARRAY) { this.c.error(init, dynamic ? `An array of a program starts with at most ${MAX_ARRAY} records.` : `An array of a program has 1 to ${MAX_ARRAY} records (got ${rows.length}); one that starts empty is one something pushes to.`); return null; }
    const fields = new Map<string, ArrayDecl>();
    for (const [field, { kind, width }] of shape) {
      const a = this.newArray(`${name}.${field}`, kind, rows.length, this.sourceOf(at), width);
      if (dynamic) a.dynamic = true;
      fields.set(field, a);
      this.emit({ kind: "declareArray", array: a.id, init: rows.map((r) => r.get(field)!), at: this.at(at), label: this.label(at) }, at);
    }
    return { kind: "records", name, fields };
  }

  /** The values of `{ count: 4, delay: d }` by field, every field of the shape given and no other. */
  private rowValues(name: string, literal: TS.ObjectLiteralExpression, shape: NonNullable<ReturnType<Structured["recordFields"]>>): Map<string, NumExpr | BoolExpr> | null {
    const { ts } = this;
    const row = new Map<string, NumExpr | BoolExpr>();
    const whole = this.evaluate(literal)?.value as Record<string, unknown> | undefined;
    for (const [field, { kind }] of shape) {
      if (whole && typeof whole === "object") {
        const v = whole[field];
        if (kind === "boolean") { if (typeof v !== "boolean") { this.c.error(literal, `${name}: ${field} is true or false, got ${describe(v)}.`); return null; } row.set(field, { kind: "const", value: v }); }
        else { const n = this.asInteger({ value: v }, literal); if (n === null) return null; row.set(field, num(n)); }
        continue;
      }
      // The last to say what the field is wins, as in JavaScript: `{ ...w, count: 9 }` is w with another count, `{ count: 9, ...w }` is w.
      let p: TS.ObjectLiteralElementLike | undefined;
      let spread: NumExpr | BoolExpr | undefined;
      for (const x of [...literal.properties].reverse()) {
        if ((ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === field) { p = x; break; }
        if (!ts.isSpreadAssignment(x)) continue;
        const b = this.spreadFields(x.expression)?.get(field);
        const v = b && b.kind !== "record" ? this.valueOf(b, kind, x) : null;
        if (v) { spread = v as NumExpr | BoolExpr; break; }
      }
      if (spread) { row.set(field, spread); continue; }
      if (!p) { this.c.error(literal, `${name}: a record has ${[...shape.keys()].join(", ")}; ${field} is missing.`); return null; }
      const value = ts.isPropertyAssignment(p) ? p.initializer : (p as TS.ShorthandPropertyAssignment).name;
      const v = kind === "number" ? this.num(value) : this.boolValue(value);
      if (!v) return null;
      row.set(field, v);
    }
    return row;
  }

  /** `waves[i] = { count: 1, delay: 2 }`: every field of the record at i. */
  private storeRow(e: TS.BinaryExpression, op: TS.SyntaxKind) {
    const { ts } = this;
    const left = this.unwrap(e.left);
    const of = ts.isElementAccessExpression(left) ? this.bindingOf(left.expression) : undefined;
    const literal = this.unwrap(e.right);
    if (of?.kind !== "records" || !ts.isElementAccessExpression(left)) { this.c.error(e.left, "An array of records is assigned record by record: waves[i] = { … }."); return; }
    if (op !== ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(literal)) { this.c.error(e, `A record of ${of.name} is given whole, ${of.name}[i] = { … }, or field by field, ${of.name}[i].${[...of.fields.keys()][0]} = 1.`); return; }
    const shape = new Map([...of.fields].map(([f, a]) => [f, { kind: a.kind, width: {} }]));
    const row = this.rowValues(of.name, literal, shape);
    const index = this.rowIndex(of, left.argumentExpression);
    if (!row || !index) return;
    const i = this.temp(index, e);
    for (const [field, a] of of.fields) this.emit({ kind: "store", array: a.id, index: i, value: row.get(field)!, at: this.at(e), label: this.label(e) }, e);
  }

  /** `waves.push({ … })`, `waves.pop()`: every field's array moves together. */
  private recordsCall(e: TS.CallExpression, of: Extract<Binding, { kind: "records" }>, method: string) {
    const { ts } = this;
    const at = this.at(e);
    const label = this.label(e);
    if (method === "push") {
      if (e.arguments.length === 0) { this.c.error(e, "push() takes the record to add."); return; }
      for (const arg of e.arguments) {
        const literal = this.unwrap(arg);
        if (!ts.isObjectLiteralExpression(literal)) { this.c.error(arg, `${of.name}.push({ … }) takes a record written out.`); return; }
        const shape = new Map([...of.fields].map(([f, a]) => [f, { kind: a.kind, width: {} }]));
        const row = this.rowValues(of.name, literal, shape);
        if (!row) return;
        for (const [field, a] of of.fields) { a.dynamic = true; this.emit({ kind: "push", array: a.id, value: row.get(field)!, at, label }, e); }
      }
      return;
    }
    if (method === "pop" && e.arguments.length === 0) {
      for (const a of of.fields.values()) { a.dynamic = true; this.emit({ kind: "pop", array: a.id, at, label }, e); }
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
      this.c.error(at, `${name}'s keys have to be ids of the game — UnitType, Player, Location, Switch, Weapon, Upgrade or Tech — so that there is a cell for every one: ${as === "set" ? "new Set<UnitType>()" : as === "map" ? "new Map<UnitType, number>()" : "Record<UnitType, number>"}. For numbers of your own, an array does it.`);
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
        const kind = this.kindOf(this.c.checker.getTypeAtLocation(x));
        if (!kind) { this.c.error(x, `This is ${this.c.checker.typeToString(this.c.checker.getTypeAtLocation(x))}; a pattern takes numbers, booleans, units and records.`); return null; }
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
    if (from.kind !== "var" && from.kind !== "cell") return from;
    const like = from.kind === "var" ? from.v : from.a;
    const v = this.newVar(name, like.kind, this.sourceOf(at), { ...(like.bits ? { bits: like.bits } : {}), ...(like.unsigned ? { unsigned: true } : {}) });
    const init: NumExpr | BoolExpr | UnitExpr = from.kind === "cell" ? { kind: "element", array: from.a.id, index: from.index, at: this.at(at) } : from.v.kind === "number" ? varRef(from.v) : from.v.kind === "unit" ? unitRef(from.v) : boolRef(from.v);
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
      return undefined;
    };
    if (!Array.isArray(from) && from.kind !== "value" && from.kind !== "array" && from.kind !== "records" && from.kind !== "units") { this.c.error(pattern, "[ … ] takes the items of an array."); return false; }
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
    const kind: Kind | undefined = to?.kind === "var" ? to.v.kind : to?.kind === "cell" ? to.a.kind : el ? el.a.kind : undefined;
    if (!kind) { this.c.error(target, "A pattern assigns to the program's variables, cells and fields."); return false; }
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
    const b = this.bindingOf(expr);
    if (b) return b;
    const e = this.unwrap(expr);
    if (ts.isCallExpression(e) && this.makesList(e)) {
      // Refused, and said so: an array of nothing stands in, so the one mistake is the one message.
      return this.madeList(e, undefined, e) ?? { kind: "array", a: this.newArray("(not made)", "number", 1, this.sourceOf(e)) };
    }
    return undefined;
  }

  /** What a method that takes a function runs over: a list of the program, the units of the game, or a list the script has. */
  private overOf(expr: TS.Expression): Over | undefined {
    const b = this.listOf(expr);
    if (b?.kind === "array" || b?.kind === "records" || b?.kind === "units") return b;
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
    if (this.bindingOf(receiver)) { const b = this.bindingOf(receiver)!; return b.kind === "array" || b.kind === "records" || b.kind === "units"; }
    if (ts.isCallExpression(receiver) && this.makesList(receiver)) return true;
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
        out.params.push({ decl: copy, init: b.v.kind === "number" ? varRef(b.v) : b.v.kind === "unit" ? unitRef(b.v) : boolRef(b.v), label });
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

  /** What a binding is as a value of `kind`, where a method stores or returns the item or its place. */
  private valueOf(b: Binding, kind: Kind, at: TS.Node): NumExpr | BoolExpr | UnitExpr | null {
    if (b.kind === "var" && b.v.kind === kind) return kind === "number" ? varRef(b.v) : kind === "unit" ? unitRef(b.v) : boolRef(b.v);
    if (b.kind === "cell" && b.a.kind === kind) return { kind: "element", array: b.a.id, index: b.index, at: this.at(at) };
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
      const fixed = over.kind === "values" ? over.items.length : over.kind === "query" || this.arraysOf(over).some((a) => a.dynamic) ? null : this.lengthArray(over).length;
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
    if (over.kind === "units" || over.kind === "query") made = { kind: "units", name: given, ptr: grow(`${given} (ptr)`, { kind: "number", unsigned: true }), epd: grow(`${given} (epd)`, { kind: "number", unsigned: true }), uid: grow(`${given} (uid)`, { kind: "number", unsigned: true }) };
    else if (over.kind === "records") made = { kind: "records", name: given, fields: new Map([...over.fields].map(([field, a]) => [field, grow(`${given}.${field}`, a)])) };
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
          for (const [field, a] of made.fields) this.emit({ kind: "push", array: a.id, value: { kind: "element", array: over.fields.get(field)!.id, index: varRef(index.v), at }, at, label }, e);
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
    const back = (a: ArrayDecl, v: VarDecl, to: NumExpr): Stmt => ({ kind: "store", array: a.id, index: to, value: a.kind === "number" ? varRef(v) : boolRef(v), at, label });
    if (list.kind === "array") { const v = hold(list.a); return { binding: { kind: "var", v }, put: (to) => [back(list.a, v, to)] }; }
    const held = [...list.fields].map(([field, a]) => [field, a, hold(a)] as const);
    return { binding: { kind: "record", fields: new Map(held.map(([field, , v]) => [field, { kind: "var", v } as Binding])) }, put: (to) => held.map(([, a, v]) => back(a, v, to)) };
  }

  /** `xs.reverse()`: the two ends exchanged, inwards, within the frame. */
  private reverseList(e: TS.CallExpression, list: List): boolean {
    const at = this.at(e);
    const label = this.label(e);
    if (e.arguments.length) { this.c.error(e, "reverse() takes no argument."); return false; }
    const i = this.newVar(`(front of ${this.overName(list)})`, "number", at, { temp: true });
    const j = this.newVar(`(back of ${this.overName(list)})`, "number", at, { temp: true });
    const step = (v: VarDecl, by: "+" | "-"): Stmt => ({ kind: "assign", target: v.id, value: { kind: "binary", op: by, left: varRef(v), right: num(1), at, label }, at, label });
    const body = this.collect(() => {
      const held = this.heldRow(list, varRef(i), e);
      this.out.push(...this.moveRow(list, varRef(i), varRef(j), e), ...held.put(varRef(j)), step(i, "+"), step(j, "-"));
    });
    this.emit({ kind: "declare", decl: i, init: num(0), at, label }, e);
    this.emit({ kind: "declare", decl: j, init: { kind: "binary", op: "-", left: { kind: "length", array: this.lengthArray(list).id, at }, right: num(1), at, label }, at, label }, e);
    this.emit({ kind: "while", cond: { kind: "compare", op: "<", left: varRef(i), right: varRef(j), at, label }, body, at, label }, e);
    return true;
  }

  /**
   * `xs.sort((a, b) => a - b)`: an insertion sort within the frame — each item taken in hand and the larger ones before
   * it moved up one. It keeps the order of equals, as JavaScript's sort does, and is quick on a list nearly in order;
   * a list in no order costs its length squared, which is what the hint is about.
   */
  private sortList(e: TS.CallExpression, list: List): boolean {
    const at = this.at(e);
    const label = this.label(e);
    const name = this.overName(list);
    if (!e.arguments[0]) { this.c.error(e, `sort() wants its function — ${name}.sort((a, b) => a - b): without one JavaScript sorts numbers as text, 10 before 9.`); return false; }
    const i = this.newVar(`(index of ${name})`, "number", at, { temp: true });
    const j = this.newVar(`(place in ${name})`, "number", at, { temp: true });
    const next: NumExpr = { kind: "binary", op: "+", left: varRef(j), right: num(1), at, label };
    let ok = true;
    const body = this.collect(() => {
      const held = this.heldRow(list, varRef(i), e);
      this.emit({ kind: "declare", decl: j, init: { kind: "binary", op: "-", left: varRef(i), right: num(1), at, label }, at, label }, e);
      const inner = this.collect(() => {
        let before: Binding;
        if (list.kind === "records") before = this.rowOf(list, varRef(j));
        else {
          const v = list.kind === "units" ? this.newVar("(before)", "unit", at, { temp: true }) : this.newVar("(before)", list.a.kind, at, { temp: true, ...(list.a.bits ? { bits: list.a.bits } : {}), ...(list.a.unsigned ? { unsigned: true } : {}) });
          this.emit({ kind: "declare", decl: v, init: list.kind === "units" ? this.unitAtIndex(list, varRef(j), e) : { kind: "element", array: list.a.id, index: varRef(j), at }, at, label }, e);
          before = { kind: "var", v };
        }
        const call = this.callback(e.arguments[0], "sort", [before, held.binding], "any", e);
        if (!call) { ok = false; return; }
        if (call.result?.kind !== "number") { this.c.error(e.arguments[0], "sort()'s function gives a number — below 0 when a goes first, above when b does: (a, b) => a - b."); ok = false; return; }
        const after: BoolExpr = { kind: "compare", op: ">", left: this.mark<NumExpr>({ kind: "call", call }, e), right: num(0), at, label };
        this.emit({ kind: "if", cond: { kind: "not", expr: after }, then: [{ kind: "break", at, label }], at, label }, e);
        this.out.push(...this.moveRow(list, next, varRef(j), e), { kind: "assign", target: j.id, value: { kind: "binary", op: "-", left: varRef(j), right: num(1), at, label }, at, label });
      });
      this.emit({ kind: "while", cond: { kind: "compare", op: ">=", left: varRef(j), right: num(0), at, label }, body: inner, at, label }, e);
      this.out.push(...held.put(next));
    });
    if (!ok) return false;
    this.emit({ kind: "declare", decl: i, init: num(1), at, label }, e);
    this.emit({ kind: "for", cond: { kind: "compare", op: "<", left: varRef(i), right: { kind: "length", array: this.lengthArray(list).id, at }, at, label }, update: [{ kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: varRef(i), right: num(1), at, label }, at, label }], body, at, label, sorts: name }, e);
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
      const b = this.listOf(x.expression);
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
    const b = this.listOf(e.expression);
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
      const full = `${name}.${key}`;
      const prop = type.getProperty(key);
      const ft = prop ? this.c.checker.getTypeOfSymbol(prop) : this.c.checker.getTypeAtLocation(init);
      const inner = this.unwrap(init);
      if (ts.isObjectLiteralExpression(inner)) {
        const rec = this.declareRecord(full, inner, ft, p);
        if (rec) fields.set(key, rec);
        else ok = false;
        continue;
      }
      const kind = this.kindOf(ft);
      if (!kind) { this.c.error(p, `A record's fields hold numbers, booleans or units; ${full} is ${this.c.checker.typeToString(ft)}.`); ok = false; continue; }
      const v = this.newVar(full, kind, this.sourceOf(p.name), kind === "number" ? this.widthOf(ft) : {});
      this.emitDeclare(v, init, at);
      fields.set(key, { kind: "var", v });
    }
    return ok ? { kind: "record", fields } : null;
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
    if (this.kindOf(this.c.checker.getTypeAtLocation(e)) === "boolean") { this.c.error(e, "A boolean has no text of its own: write flag ? \"yes\" : \"no\" with both texts known when the script is built, or show a number."); return null; }
    const value = this.num(e);
    return value ? [{ kind: "number", expr: value }] : null;
  }

  private isText(e: TS.Expression): boolean {
    return (this.c.checker.getTypeAtLocation(e).flags & this.ts.TypeFlags.StringLike) !== 0;
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
          const b = this.bindingOf(left.expression);
          if (b?.kind === "records" || b?.kind === "units") {
            if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "An array's length takes = only: xs.length = 0 empties it."); return; }
            const value = this.num(e.right);
            if (!value) return;
            const n = this.temp(value, e);
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
          const el = this.elementOf(left);
          if (el === null) return;
          if (el) { this.storeElement(e, el, op); return; }
        }
        if (ts.isElementAccessExpression(left)) {
          const squad = this.bindingOf(left.expression);
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
        const field = this.bindingOf(e.left);
        if (field?.kind === "cell") { this.storeElement(e, { a: field.a, index: field.index }, op); return; }
        if (field?.kind === "records" || (ts.isElementAccessExpression(left) && this.bindingOf(left.expression)?.kind === "records")) { this.storeRow(e, op); return; }
        const target = this.varOf(e.left);
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
      const list = this.bindingOf(e.expression.expression);
      if (list?.kind === "array") { this.arrayCall(e, list.a, e.expression.name.text, "statement"); return; }
      if (list?.kind === "records") { this.recordsCall(e, list, e.expression.name.text); return; }
      if (list?.kind === "units") { this.unitsCall(e, list, e.expression.name.text); return; }
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
    const over = this.listOf(s.expression);
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
  private inline(call: TS.CallExpression, parameters: readonly TS.ParameterDeclaration[], body: TS.Block | TS.Expression | undefined, target: Body, name: string | undefined, decl: TS.Node): Call | undefined {
    const { ts } = this;
    const what = name ?? "The function";
    if (!body) { this.c.error(call, "The function has no body."); return undefined; }
    // A copy of a body inside a copy of a body, sixteen times over: what happens from here is decided once the arguments are known.
    const deep = this.inlineDepth >= MAX_INLINE_DEPTH;
    if ((ts.isFunctionDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) { this.c.error(decl, "Generators and async functions are not supported in a program."); return undefined; }
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(call)) ?? "void";
    const line = this.line(call);
    const out: Call = { ...(name ? { name } : {}), at: this.at(call), label: this.label(call), params: [], body: [] };
    if (kind !== "void") out.result = { decl: this.newVar(`(${name ?? "function"} result)`, kind, this.at(call), { temp: true, ...(kind === "number" ? this.widthOf(this.c.checker.getTypeAtLocation(call)) : {}) }), kind };
    this.mark(out, call);
    this.callees.set(out, decl);
    // A function of the body closes over the program's variables; a game function sees only its own.
    const closure = target === this.body && target === this.c.body ? this.topScope : null;
    const scope = new Scope(closure);
    let ok = true;
    // The same call as a called function takes it: what each parameter is set to, or the array it stands for. Null once this call can only be inlined.
    let args: CallArgument[] | null = [];
    let why = "";
    const asCalled = (a: CallArgument | string) => {
      if (typeof a !== "string") { args?.push(a); return; }
      if (args) why = a;
      args = null;
    };
    // `function len({ x, y }: Point)`: taken apart when the function starts, inside its body — a called function's too.
    const patterns: (() => void)[] = [];
    parameters.forEach((p, i) => {
      if (p.dotDotDotToken) {
        // `function sum(...ns: number[])`: the arguments of this call, in an array made here. How many there are is the call's own, so the function stays a copy a call.
        const element = this.c.checker.getIndexTypeOfType(this.c.checker.getTypeAtLocation(p.name), ts.IndexKind.Number);
        const k = element ? this.kindOf(element) : null;
        if (!ts.isIdentifier(p.name) || (k !== "number" && k !== "boolean")) { this.c.error(p, "The rest of the arguments is an array of numbers or of booleans: ...ns: number[]."); ok = false; return; }
        const values: (NumExpr | BoolExpr)[] = [];
        for (const x of call.arguments.slice(i)) {
          if (ts.isSpreadElement(x)) { this.c.error(x, "An array is handed to a function as itself — f(xs) — not spread into its arguments."); ok = false; return; }
          const v = k === "number" ? this.num(x) : this.boolValue(x);
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
        const arg = call.arguments[i] ?? p.initializer;
        if (!arg) { this.c.error(call, `Missing argument ${p.name.getText(target.sf)}.`); ok = false; return; }
        const from = this.patternSource(arg, arg);
        if (!from) { ok = false; return; }
        const pattern = p.name;
        patterns.push(() => { this.bindPattern(pattern, p, from, scope); });
        if (!Array.isArray(from) && (from.kind === "record" || from.kind === "array" || from.kind === "records" || from.kind === "units")) asCalled({ binding: from });
        else asCalled(`${p.name.getText(target.sf)} is taken from something written at the call`);
        return;
      }
      const arg = call.arguments[i];
      const label = `L${line}: ${p.name.text} = ${arg ? arg.getText(this.body.sf) : "its default"}`;
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
      const binding = this.listOf(arg);
      // An array reaches a function as itself, as it does in TypeScript: what the function stores, the caller sees.
      if (binding?.kind === "array" || binding?.kind === "records" || binding?.kind === "units" || binding?.kind === "keyed") { scope.bind(p, binding); asCalled({ binding }); return; }
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
    if (!ok) return out;
    if (call.arguments.length > parameters.length && !parameters.some((p) => p.dotDotDotToken)) { this.c.error(call, `${what} takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"}.`); return out; }

    const at = this.sourceOfIn(target, (decl as { name?: TS.Node }).name ?? decl);
    const site = args ? this.siteOf(decl, args) : undefined;
    if (site && args) {
      if (site.fn) return this.calls(out, site.fn, args);
      // Inside the attempt to make it a function that is called: the function calls itself, and this is that call.
      if (site.making) return this.calls(out, site.making, args);
      // Met a second time, or met inside itself: one copy that every call runs, when the function can be one.
      if ((site.first || (site.walking ?? 0) > 0) && !site.never && !site.busy) {
        if (ts.isFunctionDeclaration(decl) && (closure === null || decl.parent !== this.c.body.plan.body)) site.never = "it is declared inside a block or another function, whose variables it may use";
        else {
          site.busy = true;
          let made: FuncDecl | string;
          try { made = this.callable(parameters, body, target, name ?? "function", decl, kind, args, closure, at, site); } finally { site.busy = false; site.making = undefined; }
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
      out.body = this.walkFunction(body, kind, target, scope, () => patterns.forEach((take) => take()));
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
  private walkFunction(body: TS.Block | TS.Expression, kind: Kind | "void", target: Body, scope: Scope, first?: () => void): Stmt[] {
    const { ts } = this;
    const saved = this.enterBody(target);
    const outerScope = this.scope;
    this.scope = scope;
    this.inlineDepth++;
    const fn: Ctx["fn"] = { kind };
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
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") {
      const b = this.listOf(e.expression);
      if (b?.kind === "array") return this.mark<NumExpr>({ kind: "length", array: b.a.id, at: this.at(e) }, e);
      if (b?.kind === "records") return this.mark<NumExpr>({ kind: "length", array: [...b.fields.values()][0].id, at: this.at(e) }, e);
      if (b?.kind === "units") return this.mark<NumExpr>({ kind: "length", array: b.ptr.id, at: this.at(e) }, e);
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "size") {
      const b = this.bindingOf(e.expression);
      if (b?.kind === "keyed" && b.size) return varRef(b.size);
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

  /** A call as a number: a function of the body or a game function (its result), or an intrinsic over variables. */
  private callValue(e: TS.CallExpression): NumExpr | null {
    const { ts } = this;
    if (ts.isPropertyAccessExpression(e.expression) && SEARCHES.has(e.expression.name.text)) {
      const over = this.overOf(e.expression.expression);
      if (over) return this.searchCall(e, over, e.expression.name.text, "number") as NumExpr | null;
    }
    if (ts.isPropertyAccessExpression(e.expression)) {
      const list = this.bindingOf(e.expression.expression);
      if (list?.kind === "array") {
        const out = this.arrayCall(e, list.a, e.expression.name.text, "number");
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
    for (let i = 0; i < e.arguments.length; i++) {
      const a = e.arguments[i];
      const h = this.evaluate(a);
      // A read is the program's value, not the script's: it takes the variable's place.
      if (h && !isGameValue(h.value)) { values.push(h.value); continue; }
      const p = params[i];
      if (!p) { this.c.error(a, `${ident} takes ${params.length} argument${params.length === 1 ? "" : "s"}.`); return; }
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
    if (!variables.length) { this.notConstant(e, "A call's arguments"); return; }
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
    this.emit({ kind: "action", record: { ...record }, variables: list, at: this.at(e), label: this.label(e) }, e);
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
    if (ts.isElementAccessExpression(e)) {
      const of = this.bindingOf(e.expression);
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

  private tableWrite(e: TS.Node, v: TableValue, value: NumExpr | BoolExpr | { kind: "text"; text: string }, scaled = false) {
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
      if (known === undefined) { this.notConstant(e.right, field.special === "name" ? "A name" : "A colour"); return; }
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
      const list = this.bindingOf(e.expression.expression);
      if (list?.kind === "array") {
        // A number of the array (indexOf, a pop of numbers) tested as one is `!= 0`, as any number is.
        const numeric = e.expression.name.text === "indexOf" || (e.expression.name.text === "pop" && list.a.kind === "number");
        const out = this.arrayCall(e, list.a, e.expression.name.text, numeric ? "number" : "boolean");
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
