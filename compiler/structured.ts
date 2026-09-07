/**
 * The structured level's front end: walks a `program(() => { … })` body — `let`
 * variables and records, assignments, `if` / `while` / `do` / `for` / `switch`,
 * `break` / `continue`, action statements, calls to functions declared in the body and
 * to `game()` functions from any file — and drives the trigger machine in `lower.ts`.
 *
 * What the language means, in the game's terms:
 *
 * - A `let` holding a number is a death counter (unsigned 32-bit, `-=` stops at 0); a
 *   `let` holding a boolean is a switch; a `let` holding an object literal is a record,
 *   each field a variable of its own. A `const` is computed when the script is built
 *   when it can be, and is a variable like a `let` (one the checker keeps from being
 *   reassigned) when its value needs the program's variables.
 * - Statements run in order within one trigger cycle; a `while` loop's back edge waits
 *   for the next cycle, so `while (true) { … }` is a game loop running once per cycle.
 *   A `for` whose start, bound and step are known when the script is built is unrolled
 *   and runs in the cycle it is reached in, as the source reads.
 * - `if (bring(…) && x >= 3 || !flag)`: conditions are trigger conditions, comparisons
 *   of variables with constants, comparisons between variables (costly — see `lower.ts`),
 *   `&&`, `||`, `!`, `random()`, `rose()`, `once()`. `&&` and `||` short-circuit: when
 *   the right side has an effect (an edge, a call of a game function), it is lowered as
 *   control flow and only runs when the left side has not decided.
 * - `x = y + 3`, `x += y`, `x++`, `x = y * 3`, `x = y / 4`, `y % 4`, `Math.min`, `Math.max`,
 *   `Math.abs`, `clamp()`, `c ? a : b`: linear arithmetic, constant multipliers, division
 *   by a constant, and the few intrinsics the decomposition can express. `x = a * b`
 *   between variables is possible and costly.
 * - Functions declared in the body, and `game()` functions, are inlined at each call.
 *   Arguments pass by value, as in TypeScript: a parameter bound to a build-time value
 *   is that value, one bound to a variable reads that variable directly when the
 *   function never assigns it (free) and is a copy when it does. A function may return a
 *   number or a boolean, through a temp. No recursion.
 * - `if (false) …` and `while (false) …` are pruned: what is inside never runs, when the
 *   script is built or in the game.
 * - The amount of `setResources` / `setDeaths` / `setScore` / `setCountdownTimer` and the
 *   unit count of `createUnit` / `killUnitAt` / `removeUnitAt` / `giveUnits` may be a
 *   variable: the action is done bit by bit.
 *
 * Everything the body reads from outside — the library's conditions and actions, the
 * script's constants and helpers — arrives as *hoisted values* (`hoist.ts`): the plan
 * numbers those expressions and the run handed back a thunk for each, called when the
 * walk reaches the expression, so where the source says `bring(P1, units.Marine, base,
 * ">=", 1)` this walker sees a condition record. A thunk that throws is reported at the
 * expression, with a note that it ran when the script was built.
 */
import type * as TS from "typescript";
import { ActionType, SetModifier, SwitchAction } from "../vendor/triggers";
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import type { HoistedThunks, ProgramPlan } from "./hoist";
import { declarationOf, isGameCall, libraryCallName } from "./hoist";
import { scriptParams } from "./api";
import { isAction, isBuilder, isCondition, isDuration, isGameFunction, isTrigger, type GameFunctionValue } from "./runtime";
import { Scope, type Binding } from "./scope";
import {
  ACTIONS_WITH_MODIFIER, and, bitLength, bitsOf, boolCondition, compareConst, cond, deathsCondition, FALSE, flipOp, LowerError, Machine, maxOf, not, or, setBool, setDeaths, setSwitch, switchCondition, TRUE, U32_MAX, widthOf,
  type Bool, type BoolVar, type CompareOp, type DcVar, type Linear,
} from "./lower";
import { Comparison } from "../vendor/triggers";

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
  machine: Machine;
  /** How many trigger cycles a second is, for `sleep(seconds(n))`: twelve with hyper triggers, a half without. */
  cyclesPerSecond: number;
  error(node: TS.Node, message: string, source?: "compiler" | "script"): void;
  /** The body of a `game()` function, from the value the run made for it; undefined when the compiler cannot place it. */
  resolve(fn: GameFunctionValue): Body | undefined;
  /** Collects the map's records the body puts in the output — conditions tested, actions run — for the allocator to keep clear of. */
  touched?: (ConditionRecord | ActionRecord)[];
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
  breakTo?: () => number;
  continueTo?: () => number;
  /** Inside an inlined function: where `return` goes, and what it returns into. */
  fn?: { end: () => number; kind: "number" | "boolean" | "void"; result?: DcVar };
}

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
  if (isGameFunction(v)) return "a game function";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return "text";
  if (typeof v === "function") return "a function";
  if (v === null || v === undefined) return String(v);
  return typeof v === "object" ? "an object" : `${typeof v} ${String(v)}`;
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

export class Structured {
  private readonly c: StructuredContext;
  private readonly m: Machine;
  private readonly ts: typeof TS;
  /** The body being walked: the program's, or the game function being inlined. */
  private body: Body;
  /** After `break` / `continue` / `return` / an endless loop: the next statement needs a state of its own. */
  private dead = false;
  private inlineDepth = 0;
  private scratchUsed = 0;
  private scope: Scope = new Scope(null);
  /** The program's outermost scope: what an inlined function of the body closes over. */
  private readonly topScope = this.scope;

  constructor(c: StructuredContext) {
    this.c = c;
    this.m = c.machine;
    this.ts = c.ts;
    this.body = c.body;
    this.m.file = c.body.sf.fileName;
  }

  run() {
    const statements = this.body.plan.body.statements;
    try {
      this.block(statements, {}, this.topScope);
      if (!this.dead) this.m.jump(this.m.halt, this.lastLine(statements), "end of program");
    } catch (err) {
      if (!(err instanceof LowerError)) throw err;
      this.c.error(statements[statements.length - 1] ?? this.body.plan.body, err.message);
    }
  }

  private lineOf(node: TS.Node): number {
    return this.body.sf.getLineAndCharacterOfPosition(node.getStart(this.body.sf)).line + 1;
  }

  private lastLine(statements: readonly TS.Statement[]): number {
    const last = statements[statements.length - 1];
    return last ? this.body.sf.getLineAndCharacterOfPosition(last.getEnd()).line + 1 : this.lineOf(this.body.plan.body);
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

  private live() {
    if (this.dead) { this.m.enter(this.m.fresh()); this.dead = false; }
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
    return undefined;
  }

  private varOf(expr: TS.Expression): DcVar | BoolVar | undefined {
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
        if (!v) return undefined;
        args.push(v.value);
      }
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
        if (!v) return undefined;
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
      if (!v) return undefined;
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
      if (!l || !r) return undefined;
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
      if (!c) return undefined;
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
      const held = this.m.tempsHeld;
      try {
        this.statement(s, ctx);
      } catch (err) {
        if (!(err instanceof LowerError)) throw err;
        if (err instanceof ValueError) this.c.error(err.node, err.message, "script");
        else this.c.error(s, err.message);
      }
      // A statement's temps (a function's result, a quotient) die with it.
      this.m.releaseTo(held);
    }
    this.scope = outer;
  }

  private statement(s: TS.Statement, ctx: Ctx) {
    const { ts } = this;
    if (ts.isEmptyStatement(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isFunctionDeclaration(s)) return;
    this.live();
    if (ts.isVariableStatement(s)) { this.declare(s.declarationList); return; }
    if (ts.isBlock(s)) { this.block(s.statements, ctx); return; }
    if (ts.isExpressionStatement(s)) { this.expressionStatement(s.expression); return; }
    if (ts.isIfStatement(s)) { this.ifStatement(s, ctx); return; }
    if (ts.isWhileStatement(s)) { this.whileStatement(s, ctx); return; }
    if (ts.isDoStatement(s)) { this.doStatement(s, ctx); return; }
    if (ts.isForStatement(s)) { this.forStatement(s, ctx); return; }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      if (s.label) { this.c.error(s, "Labelled break / continue is not supported."); return; }
      const target = ts.isBreakStatement(s) ? ctx.breakTo : ctx.continueTo;
      if (!target) { this.c.error(s, `${ts.isBreakStatement(s) ? "break" : "continue"} outside a loop.`); return; }
      this.m.jump(target(), this.line(s), this.label(s));
      this.dead = true;
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
    } else if (!s.expression) {
      this.c.error(s, `The function returns a ${fn.kind}; return one here.`);
      return;
    } else if (fn.kind === "number") {
      this.assignNumber(fn.result!, s.expression, s);
    } else {
      this.storeBool(fn.result!, s.expression, this.line(s), this.label(s));
    }
    if (!this.dead) this.m.jump(fn.end(), this.line(s), this.label(s));
    this.dead = true;
  }

  private declare(list: TS.VariableDeclarationList) {
    const { ts } = this;
    for (const d of list.declarations) {
      // Computed when the script is built — now, so a helper it calls runs where the source has it — and its uses are hoisted expressions.
      if (this.body.plan.consts.has(d)) { this.constValue(d); continue; }
      if (!ts.isIdentifier(d.name)) { this.c.error(d.name, "Destructuring is not supported in a program."); continue; }
      if (!d.initializer) { this.c.error(d, `Give ${d.name.text} an initial value: let ${d.name.text} = 0 or = false.`); continue; }
      const init = this.unwrap(d.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        const record = this.declareRecord(d.name.text, init, this.c.checker.getTypeAtLocation(d.name), d);
        if (record) this.scope.bind(d, record);
        continue;
      }
      const type = this.c.checker.getTypeAtLocation(d.name);
      const kind = this.kindOf(type);
      if (!kind) { this.c.error(d, `Variables hold numbers (death counters), booleans (switches) or records of them ({ lives: 3 }); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
      // `let total = shared(0)`: one cell for every player of a per-player program, initialised with the argument.
      const shared = ts.isCallExpression(init) && this.isLibraryCall(init, "shared") ? init : null;
      if (shared && shared.arguments.length !== 1) { this.c.error(init, "shared() takes the initial value: shared(0) or shared(false)."); continue; }
      const initializer = shared ? shared.arguments[0] : d.initializer;
      const v = kind === "number" ? (shared ? this.m.shared(d.name.text) : this.m.dc(d.name.text)) : shared ? this.m.switch(d.name.text) : this.m.bool(d.name.text);
      if (!v) { this.c.error(d, `No ${kind === "number" ? "death counter" : "switch"} is free for ${d.name.text}${this.m.perPlayer ? " (a per-player variable needs a unit with all twelve free)" : ""}.`); continue; }
      v.at = this.sourceOf(d.name);
      if (v.kind === "dc") { const bits = this.bitsOf(type); if (bits) v.bits = bits; }
      if (v.kind === "dc") this.assignNumber(v, initializer, d);
      else this.storeBool(v, initializer, this.line(d), this.label(d));
      // Bound after the initialiser: `let x = x` is the checker's error, not a self-reference here.
      this.scope.bind(d, { kind: "var", v });
    }
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
      if (!kind) { this.c.error(p, `A record's fields hold numbers or booleans; ${full} is ${this.c.checker.typeToString(ft)}.`); ok = false; continue; }
      const v = kind === "number" ? this.m.dc(full) : this.m.bool(full);
      if (!v) { this.c.error(p, `No ${kind === "number" ? "death counter" : "switch"} is free for ${full}.`); ok = false; continue; }
      v.at = this.sourceOf(p.name);
      if (v.kind === "dc") { const bits = this.bitsOf(ft); if (bits) v.bits = bits; }
      if (v.kind === "dc") this.assignNumber(v, init, at);
      else this.storeBool(v, init, this.line(at), this.label(at));
      fields.set(key, { kind: "var", v });
    }
    return ok ? { kind: "record", fields } : null;
  }

  /** Where a declaration's name is, for the editor's hover. */
  private sourceOf(node: TS.Node): { file: string; line: number; column: number } {
    const p = this.body.sf.getLineAndCharacterOfPosition(node.getStart(this.body.sf));
    return { file: this.body.sf.fileName, line: p.line + 1, column: p.character + 1 };
  }

  /** The width a `u8` / `u16` annotation declares, read off the brand in the type; undefined for a plain number. */
  private bitsOf(type: TS.Type): number | undefined {
    for (const t of type.isIntersection() ? type.types : [type]) {
      const p = t.getProperty("__kind");
      if (!p) continue;
      const pt = this.c.checker.getTypeOfSymbol(p);
      const names = (pt.isUnion() ? pt.types : [pt]).filter((x): x is TS.StringLiteralType => x.isStringLiteral()).map((x) => x.value);
      if (names.includes("u8")) return 8;
      if (names.includes("u16")) return 16;
    }
    return undefined;
  }

  private kindOf(type: TS.Type): "number" | "boolean" | null {
    const { ts } = this;
    const isNumber = (t: TS.Type): boolean => (t.flags & ts.TypeFlags.NumberLike) !== 0 || (t.isIntersection() && t.types.some(isNumber));
    if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
    if (isNumber(type)) return "number";
    return null;
  }

  /** An expression statement whose value was computed at build time: actions run, nothing else does anything. */
  private hoistedStatement(expr: TS.Expression, h: Hoisted) {
    const v = h.value;
    if (v === undefined || v === null) return;
    if (isDuration(v)) { this.c.error(expr, "A duration does nothing on its own; sleep(seconds(2)) pauses the program."); return; }
    if (isAction(v)) { this.emitAction(v.record, expr); return; }
    if (Array.isArray(v) && v.length > 0 && v.every(isAction)) { for (const a of v) this.emitAction(a.record, expr); return; }
    if (Array.isArray(v) && v.length === 0) return;
    if (isCondition(v)) { this.c.error(expr, "This is a condition; test it in an if or a while."); return; }
    this.c.error(expr, `This statement produces ${describe(v)}, which does nothing in the game. A statement here is an action, an assignment or a call.`);
  }

  private emitAction(a: ActionRecord, at: TS.Node) {
    if (a.type === ActionType.PreserveTrigger) return; // Every generated trigger is preserved already.
    this.c.touched?.push(a);
    this.m.action({ ...a }, this.line(at), this.label(at));
  }

  /** `sleep(seconds(2))`: the duration is a build-time value; the cycles it makes depend on the map's hyper triggers. */
  private sleepStatement(call: TS.CallExpression) {
    if (call.arguments.length !== 1) { this.c.error(call, "sleep() takes one duration: sleep(seconds(2)), sleep(minutes(1)) or sleep(cycles(5))."); return; }
    const h = this.evaluate(call.arguments[0]);
    if (!h) { this.notConstant(call.arguments[0], "A duration"); return; }
    if (!isDuration(h.value)) { this.c.error(call.arguments[0], `sleep() takes a duration from seconds(), minutes() or cycles(), got ${describe(h.value)}.`); return; }
    const d = h.value;
    const n = d.cycles ?? Math.max(1, Math.round((d.ms ?? 0) / 1000 * this.c.cyclesPerSecond));
    this.m.sleep(n, this.line(call), this.label(call));
  }

  private expressionStatement(expr: TS.Expression) {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) { this.hoistedStatement(e, h); return; }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        const target = this.varOf(e.left);
        if (!target) {
          const b = this.bindingOf(e.left);
          if (b?.kind === "record") this.c.error(e.left, "A record is assigned field by field: p.lives = 3.");
          else if ((ts.isPropertyAccessExpression(this.unwrap(e.left)) || ts.isElementAccessExpression(this.unwrap(e.left))) && this.evaluate(e.left)) this.c.error(e.left, "This object is computed when the script is built. Declare it with let inside the program to make it a record of variables.");
          else this.c.error(e.left, "Only the program's let variables can be assigned.");
          return;
        }
        if (target.kind !== "dc") {
          if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "Booleans take = only."); return; }
          this.storeBool(target, e.right, this.line(e), this.label(e));
          return;
        }
        if (op === ts.SyntaxKind.EqualsToken) { this.assignNumber(target, e.right, e); return; }
        const arith = compoundOp(ts, op);
        if (!arith) { this.c.error(e, "Only = += -= *= /= %= assign a number."); return; }
        const rhs = this.linear(e.right);
        if (!rhs) return;
        const value = this.linearOp(arith, ofVar(target), rhs, e);
        if (value) this.m.assign(target, value, this.line(e), this.label(e));
        return;
      }
      this.c.error(e, "Only assignments and calls can stand as statements.");
      return;
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = this.varOf(e.operand);
      if (!target || target.kind !== "dc") { this.c.error(e, "++ / -- apply to number variables."); return; }
      this.m.assign(target, { c: e.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1, terms: [{ v: target, k: 1 }] }, this.line(e), this.label(e));
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
        if (ts.isFunctionDeclaration(decl)) { this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl); return; }
        this.c.error(e, `${e.expression.text} is not a function.`);
        return;
      }
    }
    if (this.isLibraryCall(e, "random")) { this.c.error(e, "random() does nothing on its own; test it in an if, or assign it to a boolean."); return; }
    if (this.isLibraryCall(e, "sleep")) { this.sleepStatement(e); return; }
    if (this.isLibraryCall(e, "rose") || this.isLibraryCall(e, "once")) { this.c.error(e, "rose() / once() are conditions: test them in an if."); return; }
    if (this.isLibraryCall(e, "shared")) { this.c.error(e, "shared() goes on a declaration: let total = shared(0)."); return; }
    const callee = this.evaluate(e.expression)?.value;
    if (isGameFunction(callee)) { this.gameCall(e, callee); return; }
    if (isBuilder(callee)) {
      if (callee.kind === "action") { this.actionWithVars(e, callee.ident, callee.def as Parameters<typeof scriptParams>[0]); return; }
      this.c.error(e, "This is a condition; test it in an if or a while.");
      return;
    }
    this.notConstant(e, "A call's arguments");
  }

  /* ── Conditions as control flow ── */

  /** Whether lowering an expression as a condition emits anything: an edge, a call of a game function, a ternary. */
  private hasEffects(e: TS.Node): boolean {
    const { ts } = this;
    let found = false;
    const walk = (n: TS.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const lib = libraryCallName(ts, this.c.checker, n);
        if (lib === "rose" || lib === "once" || (ts.isIdentifier(n.expression) && !!this.gameDeclaration(n.expression)) || isGameCall(this.c.checker, n)) { found = true; return; }
      }
      if (ts.isConditionalExpression(n)) { found = true; return; }
      ts.forEachChild(n, walk);
    };
    walk(e);
    return found;
  }

  /** `a && b` / `a || b` / `!…` where a right side has effects: the DNF would run them whether or not the left side decided. */
  private shortCircuits(expr: TS.Expression): boolean {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return this.hasEffects(e.right) || this.shortCircuits(e.left) || this.shortCircuits(e.right);
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return this.shortCircuits(e.operand);
    return false;
  }

  /**
   * End the current state with a conditional jump on an expression. `&&` and `||` with an
   * effectful right side are lowered as control flow — the left side first, the right in
   * a state only reached when the left has not decided — so `n >= 1 && once(…)` consumes
   * the edge only when `n >= 1`; everything else goes through the DNF branch.
   */
  private branchOn(expr: TS.Expression, thenState: number, elseState: number, line: number, label: string) {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken) && this.shortCircuits(e)) {
      const mid = this.m.fresh();
      if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) this.branchOn(e.left, mid, elseState, line, label);
      else this.branchOn(e.left, thenState, mid, line, label);
      this.m.enter(mid);
      this.dead = false;
      this.branchOn(e.right, thenState, elseState, line, label);
      return;
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken && this.shortCircuits(e)) {
      this.branchOn(e.operand, elseState, thenState, line, label);
      return;
    }
    const held = this.m.tempsHeld;
    const b = this.bool(e);
    this.m.branch(b, thenState, elseState, line, label);
    this.m.releaseTo(held);
  }

  private ifStatement(s: TS.IfStatement, ctx: Ctx) {
    const join = this.m.fresh();
    const thenState = this.m.fresh();
    const elseState = s.elseStatement ? this.m.fresh() : join;
    if (this.shortCircuits(s.expression)) {
      this.branchOn(s.expression, thenState, elseState, this.line(s), this.label(s));
    } else {
      const held = this.m.tempsHeld;
      const b = this.bool(s.expression);
      if (b.kind === "const") {
        // Known when the script is built: only the side that runs is compiled, and the other is never evaluated either.
        this.m.releaseTo(held);
        const live = b.value ? s.thenStatement : s.elseStatement;
        if (live) this.statement(live, ctx);
        return;
      }
      this.m.branch(b, thenState, elseState, this.line(s), this.label(s));
      this.m.releaseTo(held);
    }
    this.m.enter(thenState);
    this.dead = false;
    this.statement(s.thenStatement, ctx);
    if (!this.dead) this.m.jump(join, this.line(s), `L${this.line(s)}: end if`);
    if (s.elseStatement) {
      this.m.enter(elseState);
      this.dead = false;
      this.statement(s.elseStatement, ctx);
      if (!this.dead) this.m.jump(join, this.line(s), `L${this.line(s)}: end else`);
    }
    this.m.enter(join);
    this.dead = false;
  }

  /** A loop condition known false when the script is built: the loop is not compiled at all. */
  private neverRuns(condition: TS.Expression | undefined): boolean {
    if (!condition) return false;
    const h = this.evaluate(condition);
    return !!h && !h.value && !isCondition(h.value);
  }

  /**
   * A loop's test at its header: the body state and the exit. Returns the body state,
   * which is the header itself for a condition known true (no trigger spent), or null
   * with the loop entered when the test emitted its own branch.
   */
  private loopTest(condition: TS.Expression | undefined, header: number, exit: number, at: TS.Node): number {
    if (!condition) return header;
    if (this.shortCircuits(condition)) {
      const body = this.m.fresh();
      this.branchOn(condition, body, exit, this.line(at), this.label(at));
      this.m.enter(body);
      return body;
    }
    const held = this.m.tempsHeld;
    const b = this.bool(condition);
    let body = header;
    if (!(b.kind === "const" && b.value)) {
      body = this.m.fresh();
      this.m.branch(b, body, exit, this.line(at), this.label(at));
      this.m.enter(body);
    }
    this.m.releaseTo(held);
    return body;
  }

  private whileStatement(s: TS.WhileStatement, ctx: Ctx) {
    if (this.neverRuns(s.expression)) return;
    this.m.remark(this.line(s), "A while loop runs one iteration per trigger cycle: its back edge waits for the next pass over the triggers.", "one iteration per cycle");
    const header = this.m.loopHeader(this.line(s), this.label(s));
    const exit = this.m.fresh();
    let broke = false;
    const body = this.loopTest(s.expression, header, exit, s);
    this.dead = false;
    this.statement(s.statement, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => header });
    if (!this.dead) this.m.jump(header, this.line(s), `L${this.line(s)}: loop`);
    if (body === header && !broke) { this.dead = true; return; }
    this.m.enter(exit);
    this.dead = false;
  }

  private doStatement(s: TS.DoStatement, ctx: Ctx) {
    this.m.remark(this.line(s), "A do loop runs one iteration per trigger cycle: its back edge waits for the next pass over the triggers.", "one iteration per cycle");
    const body = this.m.loopHeader(this.line(s), this.label(s));
    // The condition is tested in a state of its own: a branch back to the state it runs in would fall through as well.
    const check = this.m.fresh();
    const exit = this.m.fresh();
    this.dead = false;
    this.statement(s.statement, { fn: ctx.fn, breakTo: () => exit, continueTo: () => check });
    if (!this.dead) this.m.jump(check, this.line(s), `L${this.line(s)}: while`);
    this.m.enter(check);
    this.dead = false;
    const label = `L${this.line(s)}: while (${s.expression.getText(this.body.sf).replace(/\s+/g, " ")})`;
    if (this.shortCircuits(s.expression)) this.branchOn(s.expression, body, exit, this.line(s), label);
    else {
      const held = this.m.tempsHeld;
      const b = this.bool(s.expression);
      this.m.branch(b, body, exit, this.line(s), label);
      this.m.releaseTo(held);
    }
    this.m.enter(exit);
  }

  /**
   * `for (let i = 0; i < 3; i++)` with the start, the bound and the step known when the
   * script is built, and `i` never assigned in the body: unrolled like a `for…of`, `i`
   * bound to each value in turn — the loop runs in the cycle it is reached in, as the
   * source reads, and `i` costs no death counter. Null when the loop is not of that form.
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
      if (values.length > MAX_UNROLL) throw new LowerError(`This for loop unrolls to more than ${MAX_UNROLL} iterations. Loop over a variable instead — let i = 0; while (i < ${bound}) { …; i++ } runs one iteration per trigger cycle — or make the bound smaller.`);
    }
    return { decl, values };
  }

  private forStatement(s: TS.ForStatement, ctx: Ctx) {
    const { ts } = this;
    const unrolled = this.unrollable(s);
    if (unrolled) {
      this.m.remark(this.line(s), `Unrolled: ${unrolled.values.length} iteration${unrolled.values.length === 1 ? "" : "s"} in one trigger cycle, the loop variable a value known when the script is built.`, `unrolled ×${unrolled.values.length}`);
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
    this.m.remark(this.line(s), "This for loop runs one iteration per trigger cycle: its bound or step is not known when the script is built, so it is a while over a variable.", "one iteration per cycle");
    const header = this.m.loopHeader(this.line(s), this.label(s));
    const exit = this.m.fresh();
    let broke = false;
    let incr: number | null = null;
    const body = this.loopTest(s.condition, header, exit, s);
    this.dead = false;
    this.statement(s.statement, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => (s.incrementor ? (incr ??= this.m.fresh()) : header) });
    if (incr !== null) {
      if (!this.dead) this.m.jump(incr, this.line(s), `L${this.line(s)}: continue`);
      this.m.enter(incr);
      this.dead = false;
    }
    if (!this.dead) {
      if (s.incrementor) this.expressionStatement(s.incrementor);
      this.m.jump(header, this.line(s), `L${this.line(s)}: loop`);
    }
    this.scope = outer;
    if (body === header && !broke) { this.dead = true; return; }
    this.m.enter(exit);
    this.dead = false;
  }

  /** The body compiled once per value, the declaration bound to that value; `break` leaves, `continue` goes on with the next. */
  private unrolledLoop(decl: TS.Node, values: unknown[], body: TS.Statement, s: TS.Node, ctx: Ctx) {
    const exit = this.m.fresh();
    let broke = false;
    for (const item of values) {
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "value", value: item });
      let next: number | null = null;
      this.block([body], { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => (next ??= this.m.fresh()) }, scope);
      if (next !== null) {
        if (!this.dead) this.m.jump(next, this.line(s), `L${this.line(s)}: continue`);
        this.m.enter(next);
        this.dead = false;
      }
      if (this.dead) break; // Nothing after a break / return in the body's straight line is reached; nor are the values after it.
    }
    if (broke) {
      if (!this.dead) this.m.jump(exit, this.line(s), `L${this.line(s)}: end of loop`);
      this.m.enter(exit);
      this.dead = false;
    }
  }

  /**
   * `for (const w of waves)` over a list known when the script is built: unrolled, the body
   * compiled once per element with `w` bound to that element's value.
   */
  private forOfStatement(s: TS.ForOfStatement, ctx: Ctx) {
    const { ts } = this;
    if (s.awaitModifier) { this.c.error(s, "for await is not supported in a program."); return; }
    const decl = ts.isVariableDeclarationList(s.initializer) && s.initializer.declarations.length === 1 ? s.initializer.declarations[0] : undefined;
    if (!decl || !ts.isIdentifier(decl.name)) { this.c.error(s.initializer, "for…of takes one variable: for (const w of waves) { … }."); return; }
    const h = this.evaluate(s.expression);
    if (!h) { this.notConstant(s.expression, "What a for…of loop runs over"); return; }
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
   * tested in order, each one trigger, then the bodies in source order — a body without
   * `break` falls through to the next, as in TypeScript. Case values are known when the
   * script is built.
   */
  private switchStatement(s: TS.SwitchStatement, ctx: Ctx) {
    const { ts } = this;
    const line = this.line(s);
    const held = this.m.tempsHeld;
    const lin = this.linear(s.expression);
    if (!lin) return;
    if (isConst(lin)) { this.c.error(s.expression, "switch over a value known when the script is built: write the case that applies."); return; }
    const v = single(lin) ?? (() => { const t = this.m.temp(widthOf(lin)); this.m.evaluate(t, lin, line, this.label(s)); return t; })();
    const clauses = s.caseBlock.clauses;
    const exit = this.m.fresh();
    const states = clauses.map(() => this.m.fresh());
    let fallback = exit;
    clauses.forEach((c, i) => {
      if (ts.isDefaultClause(c)) { fallback = states[i]; return; }
      const h = this.evaluate(c.expression);
      if (!h) { this.notConstant(c.expression, "A case value"); return; }
      const n = this.asInteger(h, c.expression);
      if (n === null) return;
      if (n < 0 || n > U32_MAX) return; // A value the variable can never hold.
      this.m.step([deathsCondition(v, Comparison.Exactly, n)], [], states[i], line, `L${line}: case ${n}`);
    });
    this.m.jump(fallback, line, `L${line}: ${fallback === exit ? "end switch" : "default"}`);
    this.m.releaseTo(held);
    const scope = new Scope(this.scope);
    clauses.forEach((c, i) => {
      this.m.enter(states[i]);
      this.dead = false;
      this.block(c.statements, { fn: ctx.fn, continueTo: ctx.continueTo, breakTo: () => exit }, scope);
      if (!this.dead) this.m.jump(i + 1 < states.length ? states[i + 1] : exit, line, `L${line}: fall through`);
    });
    this.m.enter(exit);
    this.dead = false;
  }

  /* ── Functions ── */

  /** A call of a `game()` function: inlined from its own body, wherever that file is. */
  private gameCall(call: TS.CallExpression, fn: GameFunctionValue): DcVar | undefined {
    const target = this.c.resolve(fn);
    if (!target) { this.c.error(call, "This game function's body could not be found again."); return undefined; }
    const arrow = target.plan.arrow;
    return this.inline(call, arrow.parameters, target.plan.expression ?? (arrow.body as TS.Block), target, target.name, arrow);
  }

  /**
   * Inline a function at a call: parameters bound, the body walked in the current
   * state, `return` jumping to a state after it. The result — a number or a boolean the
   * checker says the call has — comes back in a temp the caller reads (0 / 1 for a
   * boolean) and releases with its statement.
   */
  private inline(call: TS.CallExpression, parameters: readonly TS.ParameterDeclaration[], body: TS.Block | TS.Expression | undefined, target: Body, name: string | undefined, decl: TS.Node): DcVar | undefined {
    const { ts } = this;
    const what = name ?? "The function";
    if (!body) { this.c.error(call, "The function has no body."); return undefined; }
    if (this.inlineDepth >= MAX_INLINE_DEPTH) { this.c.error(call, "Functions nest too deeply (recursion is not possible: a call is inlined)."); return undefined; }
    if ((ts.isFunctionDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) { this.c.error(decl, "Generators and async functions are not supported in a program."); return undefined; }
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(call)) ?? "void";
    const line = this.line(call);
    const result = kind === "void" ? undefined : this.m.temp();
    if (result) this.m.set(result, 0, line, this.label(call));
    // A function of the body closes over the program's variables; a game function sees only its own.
    const scope = new Scope(target === this.body && target === this.c.body ? this.topScope : null);
    let ok = true;
    parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) { this.c.error(p, "Destructured parameters are not supported in a program."); ok = false; return; }
      if (p.dotDotDotToken) { this.c.error(p, "Rest parameters are not supported in a program."); ok = false; return; }
      const arg = call.arguments[i];
      if (!arg) {
        if (!p.initializer) { this.c.error(call, `Missing argument ${p.name.text}.`); ok = false; return; }
        // The default is the function's own expression: evaluated in its body.
        const saved = this.enterBody(target);
        const h = this.evaluate(p.initializer);
        this.leaveBody(saved);
        if (!h) { this.notConstant(p.initializer, "A default value"); ok = false; return; }
        scope.bind(p, { kind: "value", value: h.value });
        return;
      }
      const h = this.evaluate(arg);
      if (h) { scope.bind(p, { kind: "value", value: h.value }); return; }
      const binding = this.bindingOf(arg);
      if (binding?.kind === "record") {
        if (this.assigns(body, p)) { this.c.error(p, `${p.name.text} is a record; a record parameter can have its fields assigned, not be reassigned itself.`); ok = false; return; }
        scope.bind(p, binding);
        return;
      }
      const variable = binding?.kind === "var" ? binding.v : undefined;
      if (variable) {
        // By value, as in TypeScript. A parameter the function never assigns can read the caller's variable directly; one it assigns gets a copy.
        if (!this.assigns(body, p)) { scope.bind(p, { kind: "var", v: variable }); return; }
        const copy = variable.kind === "dc" ? this.m.dc(p.name.text) : this.m.bool(p.name.text);
        if (!copy) { this.c.error(p, `No ${variable.kind === "dc" ? "death counter" : "switch"} is free for ${p.name.text}.`); ok = false; return; }
        copy.at = this.sourceOfIn(target, p.name);
        if (copy.kind === "dc" && variable.kind === "dc" && variable.bits) copy.bits = variable.bits;
        const label = `L${line}: ${p.name.text} = ${arg.getText(this.body.sf)}`;
        if (copy.kind === "dc") this.m.assign(copy, ofVar(variable as DcVar), line, label);
        else this.storeBoolTree(copy, cond(boolCondition(variable as BoolVar, true)), line, label);
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      const lin = ts.isIdentifier(this.unwrap(arg)) ? null : this.linearQuietly(arg);
      if (lin) {
        // An expression over variables: computed into a variable of the parameter's own.
        const copy = this.m.dc(p.name.text);
        if (!copy) { this.c.error(p, `No death counter is free for ${p.name.text}.`); ok = false; return; }
        copy.at = this.sourceOfIn(target, p.name);
        this.m.assign(copy, lin, line, `L${line}: ${p.name.text} = ${arg.getText(this.body.sf)}`);
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      this.notConstant(arg, "An argument");
      ok = false;
    });
    if (!ok) return result;
    if (call.arguments.length > parameters.length) { this.c.error(call, `${what} takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"}.`); return result; }
    const saved = this.enterBody(target);
    const outerScope = this.scope;
    this.scope = scope;
    this.inlineDepth++;
    let end: number | null = null;
    const fn: Ctx["fn"] = { end: () => (end ??= this.m.fresh()), kind, result };
    try {
      if (ts.isBlock(body)) this.block(body.statements, { fn });
      else {
        // `game((a: number) => a + 1)`: the expression is what it returns.
        const held = this.m.tempsHeld;
        try {
          if (kind === "number") this.assignNumber(result!, body, body);
          else if (kind === "boolean") this.storeBool(result!, body, this.line(body), this.label(body));
          else this.expressionStatement(body);
        } catch (err) {
          if (!(err instanceof LowerError)) throw err;
          if (err instanceof ValueError) this.c.error(err.node, err.message, "script");
          else this.c.error(body, err.message);
        }
        this.m.releaseTo(held);
      }
    } finally {
      this.inlineDepth--;
      this.scope = outerScope;
      this.leaveBody(saved);
    }
    if (end !== null) {
      if (!this.dead) this.m.jump(end, line, `L${line}: end of ${name ?? "function"}`);
      this.m.enter(end);
      this.dead = false;
    }
    return result;
  }

  /** Walk another body (a game function's) until `leaveBody`: its plan, file and thunks. */
  private enterBody(target: Body): Body {
    const saved = this.body;
    this.body = target;
    this.m.file = target.sf.fileName;
    return saved;
  }

  private leaveBody(saved: Body) {
    this.body = saved;
    this.m.file = saved.sf.fileName;
  }

  private sourceOfIn(target: Body, node: TS.Node): { file: string; line: number; column: number } {
    const p = target.sf.getLineAndCharacterOfPosition(node.getStart(target.sf));
    return { file: target.sf.fileName, line: p.line + 1, column: p.character + 1 };
  }

  /** Whether a body assigns to (or increments) a declaration anywhere. */
  private assigns(body: TS.Node, decl: TS.Node): boolean {
    const { ts } = this;
    let found = false;
    const target = (e: TS.Expression) => {
      const u = this.unwrap(e);
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

  private assignNumber(v: DcVar, expr: TS.Expression, at: TS.Node) {
    const rhs = this.linear(expr);
    if (rhs) this.m.assign(v, rhs, this.line(at), this.label(at));
  }

  private asInteger(h: Hoisted, at: TS.Node): number | null {
    const v = h.value;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v !== "number" || !Number.isFinite(v)) { this.c.error(at, `Expected a number, got ${describe(v)}.`); return null; }
    if (!Number.isInteger(v)) { this.c.error(at, `Only whole numbers exist in the game (got ${v}).`); return null; }
    return v;
  }

  /** `linear` without diagnostics, for a probe that may fail. */
  private linearQuietly(expr: TS.Expression): Linear | null {
    const { error } = this.c;
    let failed = false;
    (this.c as { error: StructuredContext["error"] }).error = () => { failed = true; };
    try {
      const out = this.linear(expr);
      return failed ? null : out;
    } finally {
      (this.c as { error: StructuredContext["error"] }).error = error;
    }
  }

  /** A variable holding a linear expression's value: the variable itself when it is one, else a temp computed now. */
  private sideVar(l: Linear, line: number, label: string): DcVar {
    const v = single(l);
    if (v) return v;
    const t = this.m.temp(widthOf(l));
    this.m.evaluate(t, l, line, label);
    return t;
  }

  /** `l op r` for `*`, `/`, `%` (and `+`, `-`) over linear expressions, emitting what needs a temp. */
  private linearOp(op: "+" | "-" | "*" | "/" | "%", l: Linear, r: Linear, at: TS.Node): Linear | null {
    const line = this.line(at);
    const label = this.label(at);
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
        if (!isConst(r)) { this.c.error(at, "Division is by a constant: the game has no instruction for dividing by a variable."); return null; }
        const d = r.c;
        if (!Number.isInteger(d) || d <= 0) { this.c.error(at, `Divide by a whole number of at least 1, not ${d}.`); return null; }
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
  private ternary(e: TS.ConditionalExpression): Linear {
    const line = this.line(e);
    const label = this.label(e);
    const t = this.m.temp();
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.branchOn(e.condition, on, off, line, label);
    this.m.enter(on);
    this.dead = false;
    this.assignNumber(t, e.whenTrue, e);
    this.m.jump(join, line, label);
    this.m.enter(off);
    this.dead = false;
    this.assignNumber(t, e.whenFalse, e);
    this.m.jump(join, line, label);
    this.m.enter(join);
    this.dead = false;
    return ofVar(t);
  }

  /** `c + Σ k·v` over death counters, or null (with a diagnostic). Emits what needs a temp: a quotient, a product, a call's result. */
  private linear(expr: TS.Expression): Linear | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) {
      const n = this.asInteger(h, e);
      return n === null ? null : { c: n, terms: [] };
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") {
        if (b.v.kind !== "dc") { this.c.error(e, `${b.v.name} is a boolean.`); return null; }
        return ofVar(b.v);
      }
      if (b?.kind === "record") { this.c.error(e, "This is a record; use one of its fields."); return null; }
      if (ts.isIdentifier(e)) this.c.error(e, `${e.text} is not a variable of the program.`);
      else this.notConstant(e, "A value");
      return null;
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const inner = this.linear(e.operand);
      if (!inner) return null;
      if (e.operator === ts.SyntaxKind.PlusToken) return inner;
      if (e.operator === ts.SyntaxKind.MinusToken) return scale(inner, -1);
      this.c.error(e, "Only + and - apply to variables.");
      return null;
    }
    if (ts.isBinaryExpression(e)) {
      const op = arithOp(ts, e.operatorToken.kind);
      if (!op) { this.c.error(e, "Expected a number: variables add, subtract, multiply, divide and take the remainder by a constant."); return null; }
      const l = this.linear(e.left);
      const r = this.linear(e.right);
      if (!l || !r) return null;
      return this.linearOp(op, l, r, e);
    }
    if (ts.isConditionalExpression(e)) return this.ternary(e);
    if (ts.isCallExpression(e)) return this.callValue(e);
    this.c.error(e, "Expected a number: a value, a variable, or arithmetic over them.");
    return null;
  }

  /** A call as a number: a function of the body or a game function (its result), or an intrinsic over variables. */
  private callValue(e: TS.CallExpression): Linear | null {
    const { ts } = this;
    const line = this.line(e);
    const label = this.label(e);
    if (ts.isIdentifier(e.expression)) {
      const decl = this.gameDeclaration(e.expression);
      if (decl && ts.isFunctionDeclaration(decl)) {
        const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
        if (kind !== "number") { this.c.error(e, `${e.expression.text} does not return a number.`); return null; }
        const r = this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl);
        return r ? ofVar(r) : null;
      }
    }
    const args = (n: number, what: string): Linear[] | null => {
      if (e.arguments.length !== n) { this.c.error(e, `${what} takes ${n} argument${n === 1 ? "" : "s"}.`); return null; }
      const out: Linear[] = [];
      for (const a of e.arguments) { const l = this.linear(a); if (!l) return null; out.push(l); }
      return out;
    };
    if (this.isLibraryCall(e, "clamp")) {
      const a = args(3, "clamp()");
      if (!a) return null;
      return this.minMax("min", this.minMax("max", a[0], a[1], line, label), a[2], line, label);
    }
    const callee = this.evaluate(e.expression)?.value;
    if (isGameFunction(callee)) {
      const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
      if (kind !== "number") { this.c.error(e, "This game function does not return a number."); return null; }
      const r = this.gameCall(e, callee);
      return r ? ofVar(r) : null;
    }
    if (callee === Math.floor || callee === Math.trunc || callee === Math.round || callee === Math.ceil) {
      const a = args(1, "Math rounding");
      return a ? a[0] : null; // Whole numbers already.
    }
    if (callee === Math.abs) {
      const a = args(1, "Math.abs()");
      return a ? this.abs(a[0], line, label) : null;
    }
    if (callee === Math.min || callee === Math.max) {
      if (e.arguments.length === 0) { this.c.error(e, "Math.min / Math.max take at least one argument."); return null; }
      let acc: Linear | null = null;
      for (const a of e.arguments) {
        const l = this.linear(a);
        if (!l) return null;
        acc = acc ? this.minMax(callee === Math.min ? "min" : "max", acc, l, line, label) : l;
      }
      return acc;
    }
    if (isBuilder(callee)) { this.c.error(e, callee.kind === "condition" ? "This is a condition; test it in an if or a while." : "This is an action; it stands as a statement."); return null; }
    if (typeof callee === "function") { this.c.error(e, "This helper is computed when the script is built and cannot take a variable of the program. Write it as a game() function to run it in the game."); return null; }
    this.notConstant(e, "A call's arguments");
    return null;
  }

  /**
   * An action whose argument is a variable: `setResources(P1, "add", n, "ore")`,
   * `createUnit(P2, unit, count, at)`. The record is built with the variable's place
   * as 0, then done bit by bit through `Machine.actionWithVar`.
   */
  private actionWithVars(e: TS.CallExpression, ident: string, def: Parameters<typeof scriptParams>[0]) {
    const params = scriptParams(def);
    const line = this.line(e);
    const label = this.label(e);
    const values: unknown[] = [];
    let variable: { index: number; lin: Linear } | null = null;
    for (let i = 0; i < e.arguments.length; i++) {
      const a = e.arguments[i];
      const h = this.evaluate(a);
      if (h) { values.push(h.value); continue; }
      const p = params[i];
      if (!p) { this.c.error(a, `${ident} takes ${params.length} argument${params.length === 1 ? "" : "s"}.`); return; }
      const eligible = ((p.arg.kind === "amount" || p.arg.kind === "duration") && ACTIONS_WITH_MODIFIER.has(def.type)) || (p.arg.kind === "count" && COUNT_ACTIONS.has(def.type));
      if (!eligible) {
        this.c.error(a, `${ident}'s ${p.name} must be known when the script is built. Only an amount with a modifier (setResources, setDeaths, setScore, setCountdownTimer) and a unit count (createUnit, killUnitAt, removeUnitAt, giveUnits) can be a variable of the program.`);
        return;
      }
      if (variable) { this.c.error(a, `${ident}: one argument at a time can be a variable of the program.`); return; }
      const lin = this.linear(a);
      if (!lin) return;
      variable = { index: i, lin };
      values.push(0);
    }
    if (!variable) { this.notConstant(e, "A call's arguments"); return; }
    let record: ActionRecord;
    try {
      const built = (this.evaluate(e.expression)!.value as (...a: unknown[]) => unknown)(...values);
      if (!isAction(built)) { this.c.error(e, "Expected an action."); return; }
      record = built.record;
    } catch (err) {
      throw new ValueError(e, err instanceof Error ? err.message : String(err));
    }
    const p = params[variable.index];
    const fieldBits = p.arg.kind === "count" ? 8 : 32;
    const { lin } = variable;
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
        this.m.remark(line, `A ${p.name} larger than ${maxOf(fieldBits)} is done as ${maxOf(fieldBits)}: that is what the action's field holds.`);
      }
      consume = true;
      bits = Math.min(widthOf(lin), fieldBits);
    }
    this.c.touched?.push(record);
    this.m.actionWithVar(record, p.arg.field as keyof ActionRecord, src, bits, consume, line, label);
  }

  /* ── Booleans ── */

  /** `v = expr` for a boolean: a constant, a toggle, a coin toss, or a branch that sets one side and clears the other. */
  private storeBool(v: BoolVar | DcVar, expr: TS.Expression, line: number, label: string) {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h && typeof h.value === "boolean") { this.m.action(setTruth(v, h.value), line, label); return; }
    // A switch toggles and randomizes in one action; a flag (a per-player boolean) goes through a branch.
    if (v.kind === "switch" && ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken && this.varOf(e.operand) === v) { this.m.action(setSwitch(v, SwitchAction.Toggle), line, label); return; }
    if (v.kind === "switch" && this.isLibraryCall(e, "random")) { this.m.action(setSwitch(v, SwitchAction.Randomize), line, label); return; }
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
  private edge(call: TS.CallExpression, kind: "rose" | "once"): Bool {
    if (call.arguments.length !== 1) { this.c.error(call, `${kind}() takes one condition.`); return FALSE; }
    const latch = this.m.bool(`(${kind} latch)`);
    const fired = this.m.bool(`(${kind} fired)`);
    if (!latch || !fired) { this.c.error(call, `No switch is free for ${kind}().`); return FALSE; }
    const line = this.line(call);
    const label = this.label(call);
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.branchOn(call.arguments[0], on, off, line, label);
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

  /** A hoisted value as a condition tree. */
  private hoistedBool(h: Hoisted, at: TS.Node): Bool {
    const v = h.value;
    if (typeof v === "boolean") return v ? TRUE : FALSE;
    if (typeof v === "number") return v !== 0 ? TRUE : FALSE;
    if (typeof v === "string") return v !== "" ? TRUE : FALSE;
    if (isCondition(v)) { this.c.touched?.push(v.record); return cond(v.record as ConditionRecord); }
    if (Array.isArray(v) && v.length > 0 && v.every(isCondition)) { for (const c of v) this.c.touched?.push(c.record); return and(v.map((c) => cond(c.record))); }
    if (isAction(v)) { this.c.error(at, "This is an action, not a condition."); return FALSE; }
    this.c.error(at, `Expected a condition, got ${describe(v)}.`);
    return FALSE;
  }

  /** A condition as a `Bool` tree; may emit steps (temps for variable comparisons, a randomize, an edge, a call). */
  private bool(expr: TS.Expression): Bool {
    this.scratchUsed = 0;
    return this.boolInner(expr, 0);
  }

  private boolInner(expr: TS.Expression, depth: number): Bool {
    const { ts } = this;
    const e = this.unwrap(expr);
    if (depth > 64) { this.c.error(e, "The condition nests too deeply."); return FALSE; }
    const h = this.evaluate(expr);
    if (h) return this.hoistedBool(h, e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return not(this.boolInner(e.operand, depth + 1));
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return and([this.boolInner(e.left, depth + 1), this.boolInner(e.right, depth + 1)]);
      if (op === ts.SyntaxKind.BarBarToken) return or([this.boolInner(e.left, depth + 1), this.boolInner(e.right, depth + 1)]);
      const cmp = compareOp(ts, op);
      if (cmp) return this.comparison(e, cmp, depth);
      this.c.error(e, "Expected a condition.");
      return FALSE;
    }
    if (ts.isConditionalExpression(e)) {
      // `c ? p : q` as a truth value: 0 / 1 in a temp.
      const t = this.m.temp(1);
      const on = this.m.fresh();
      const off = this.m.fresh();
      this.branchOn(e.condition, on, off, this.line(e), this.label(e));
      const join = this.m.fresh();
      this.m.enter(on);
      this.dead = false;
      this.storeBool(t, e.whenTrue, this.line(e), this.label(e));
      this.m.jump(join, this.line(e), this.label(e));
      this.m.enter(off);
      this.dead = false;
      this.storeBool(t, e.whenFalse, this.line(e), this.label(e));
      this.m.jump(join, this.line(e), this.label(e));
      this.m.enter(join);
      this.dead = false;
      return cond(deathsCondition(t, Comparison.AtLeast, 1));
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") return b.v.kind !== "dc" ? cond(boolCondition(b.v, true)) : compareConst(b.v, ">=", 1);
      if (b?.kind === "record") { this.c.error(e, "This is a record; test one of its fields."); return FALSE; }
      if (ts.isIdentifier(e)) this.c.error(e, `${e.text} is not a variable of the program or a condition.`);
      else this.notConstant(e, "A condition");
      return FALSE;
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) {
        const decl = this.gameDeclaration(e.expression);
        if (decl && ts.isFunctionDeclaration(decl)) return this.callBool(e, () => this.inline(e, decl.parameters, decl.body, this.body, decl.name?.text, decl));
      }
      if (this.isLibraryCall(e, "random")) {
        const s = this.m.scratch(this.scratchUsed++);
        this.m.action(setSwitch(s, SwitchAction.Randomize), this.line(e), `L${this.line(e)}: random()`);
        return cond(switchCondition(s, true));
      }
      if (this.isLibraryCall(e, "rose")) return this.edge(e, "rose");
      if (this.isLibraryCall(e, "once")) return this.edge(e, "once");
      if (this.isLibraryCall(e, "sleep")) { this.c.error(e, "sleep() is a statement, not a condition."); return FALSE; }
      const callee = this.evaluate(e.expression)?.value;
      if (isGameFunction(callee)) return this.callBool(e, () => this.gameCall(e, callee));
      if (isBuilder(callee) && callee.kind === "condition") { this.c.error(e, "The game cannot test a condition against a variable of the program: a condition's amount is known when the script is built. Compare variables in the program's own statements."); return FALSE; }
      if (isBuilder(callee)) { this.c.error(e, "This is an action, not a condition."); return FALSE; }
      this.notConstant(e, "A condition's arguments");
      return FALSE;
    }
    this.c.error(e, "Expected a condition: a trigger condition, a comparison, a boolean variable, or a combination with && || !.");
    return FALSE;
  }

  /** A call whose result is tested: a boolean result is `≥ 1`, a number's is `≠ 0` — both `≥ 1` on a counter. */
  private callBool(e: TS.CallExpression, run: () => DcVar | undefined): Bool {
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
    if (!kind) { this.c.error(e, "This function returns nothing to test; test a variable it sets instead."); return FALSE; }
    const r = run();
    return r ? cond(deathsCondition(r, Comparison.AtLeast, 1)) : FALSE;
  }

  private comparison(e: TS.BinaryExpression, op: CompareOp, depth: number): Bool {
    // Boolean equality: `flag == true`, `a != b` over switches.
    const isBool = (x: TS.Expression) => {
      const h = this.evaluate(x);
      if (h) return typeof h.value === "boolean" || isCondition(h.value);
      const v = this.varOf(x);
      if (v !== undefined) return v.kind !== "dc";
      return this.kindOf(this.c.checker.getTypeAtLocation(x)) === "boolean";
    };
    if (isBool(e.left) || isBool(e.right)) {
      if (op !== "==" && op !== "!=") { this.c.error(e, "Booleans compare with == and != only."); return FALSE; }
      const l = this.boolInner(e.left, depth + 1);
      const r = this.boolInner(e.right, depth + 1);
      const same = or([and([l, r]), and([not(l), not(r)])]);
      return op === "==" ? same : not(same);
    }
    const l = this.linear(e.left);
    const r = this.linear(e.right);
    if (!l || !r) return FALSE;
    // l − r  op  0
    const d = merge(l, scale(r, -1));
    if (d.terms.length === 0) return compareNumbers(d.c, op, 0) ? TRUE : FALSE;
    if (d.terms.length === 1) {
      const t = d.terms[0];
      return compareScaled(t.v, t.k, op, -d.c);
    }
    // Two sides to compute: `a + c  op  b` with the constant on whichever side keeps it non-negative.
    const line = this.line(e);
    const label = `L${line}: ${e.getText(this.body.sf).replace(/\s+/g, " ")}`;
    const left: Linear = { c: Math.max(0, d.c), terms: d.terms.filter((t) => t.k > 0) };
    const right: Linear = { c: Math.max(0, -d.c), terms: d.terms.filter((t) => t.k < 0).map((t) => ({ v: t.v, k: -t.k })) };
    const a = this.sideVar(left, line, label);
    const b = this.sideVar(right, line, label);
    return this.m.compareVars(a, op, b, line, label).bool;
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

type ArithOp = "+" | "-" | "*" | "/" | "%";

function arithOp(ts: typeof TS, kind: TS.SyntaxKind): ArithOp | null {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return "+";
    case ts.SyntaxKind.MinusToken: return "-";
    case ts.SyntaxKind.AsteriskToken: return "*";
    case ts.SyntaxKind.SlashToken: return "/";
    case ts.SyntaxKind.PercentToken: return "%";
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
    default: return null;
  }
}

function compareNumbers(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}
