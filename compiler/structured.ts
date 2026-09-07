/**
 * The structured level's front end: walks a `program(() => { … })` body — `let`
 * variables, assignments, `if` / `while` / `do` / `for`, `break` / `continue`, action
 * statements, calls to functions declared in the body — and drives the trigger machine
 * in `lower.ts`.
 *
 * What the language means, in the game's terms:
 *
 * - A `let` holding a number is a death counter (unsigned 32-bit, `-=` stops at 0); a
 *   `let` holding a boolean is a switch. A `const` is computed when the script is built
 *   when it can be, and is a variable like a `let` (one the checker keeps from being
 *   reassigned) when its value needs the program's variables.
 * - Statements run in order within one trigger cycle; a loop's back edge waits for the
 *   next cycle, so `while (true) { … }` is a game loop running once per cycle.
 * - `if (bring(…) && x >= 3 || !flag)`: conditions are trigger conditions, comparisons
 *   of variables with constants, comparisons between variables (costly — see `lower.ts`),
 *   `&&`, `||`, `!`, and `random()`.
 * - `x = y + 3`, `x += y`, `x++`: linear arithmetic only; there is no multiplication
 *   between variables because the game has no instruction for it.
 * - Functions declared in the body are inlined at each call. Arguments pass by value, as
 *   in TypeScript: a parameter bound to a build-time value is that value, one bound to a
 *   variable reads that variable directly when the function never assigns it (free) and
 *   is a copy when it does. No recursion, no return values.
 * - `if (false) …` and `while (false) …` are pruned: what is inside never runs, when the
 *   script is built or in the game.
 *
 * Everything the body reads from outside — the library's conditions and actions, the
 * script's constants and helpers — arrives as *hoisted values* (`hoist.ts`): the plan
 * numbers those expressions and the run handed back a thunk for each, called when the
 * walk reaches the expression, so where the source says `bring(P1, units.Marine, base,
 * ">=", 1)` this walker sees a condition record. A thunk that throws is reported at the
 * expression, with a note that it ran when the script was built.
 */
import type * as TS from "typescript";
import { ActionType, SwitchAction } from "../vendor/triggers";
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import type { ProgramPlan } from "./hoist";
import { declarationOf, libraryCallName } from "./hoist";
import { isAction, isCondition, isDuration, isTrigger } from "./runtime";
import { Scope, type Binding } from "./scope";
import {
  and, boolCondition, compareConst, cond, FALSE, flipOp, LowerError, Machine, not, or, setBool, setSwitch, switchCondition, TRUE,
  type Bool, type BoolVar, type CompareOp, type DcVar, type Linear,
} from "./lower";

export interface StructuredContext {
  ts: typeof TS;
  checker: TS.TypeChecker;
  sf: TS.SourceFile;
  plan: ProgramPlan;
  /** The hoisted expressions' thunks, by the plan's index; each is called once, when the walk reaches the expression. */
  hoisted: (() => unknown)[];
  machine: Machine;
  /** How many trigger cycles a second is, for `sleep(seconds(n))`: twelve with hyper triggers, a half without. */
  cyclesPerSecond: number;
  error(node: TS.Node, message: string, source?: "compiler" | "script"): void;
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
  /** Inside an inlined function: where `return` goes. */
  fn?: { end: () => number };
}

const MAX_INLINE_DEPTH = 16;
const LABEL_LENGTH = 48;

/** A value the run computed for a hoisted expression (or a parameter bound to one). */
interface Hoisted { value: unknown }

function describe(v: unknown): string {
  if (isCondition(v)) return "a condition";
  if (isAction(v)) return "an action";
  if (isTrigger(v)) return "a trigger";
  if (isDuration(v)) return "a duration";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return "text";
  if (typeof v === "function") return "a function";
  if (v === null || v === undefined) return String(v);
  return typeof v === "object" ? "an object" : `${typeof v} ${String(v)}`;
}

export class Structured {
  private readonly c: StructuredContext;
  private readonly m: Machine;
  private readonly ts: typeof TS;
  /** After `break` / `continue` / `return` / an endless loop: the next statement needs a state of its own. */
  private dead = false;
  private inlineDepth = 0;
  private scratchUsed = 0;
  private readonly evaluated = new Map<number, unknown>();
  private scope: Scope = new Scope(null);
  /** The program's outermost scope: what an inlined function body closes over. */
  private readonly topScope = this.scope;

  constructor(c: StructuredContext) {
    this.c = c;
    this.m = c.machine;
    this.ts = c.ts;
  }

  run() {
    const statements = this.c.plan.body.statements;
    try {
      this.block(statements, {}, this.topScope);
      if (!this.dead) this.m.jump(this.m.halt, this.lastLine(statements), "end of program");
    } catch (err) {
      if (!(err instanceof LowerError)) throw err;
      this.c.error(statements[statements.length - 1] ?? this.c.plan.body, err.message);
    }
  }

  private lineOf(node: TS.Node): number {
    return this.c.sf.getLineAndCharacterOfPosition(node.getStart(this.c.sf)).line + 1;
  }

  private lastLine(statements: readonly TS.Statement[]): number {
    const last = statements[statements.length - 1];
    return last ? this.c.sf.getLineAndCharacterOfPosition(last.getEnd()).line + 1 : this.lineOf(this.c.plan.body);
  }

  /** "L12: while (x < 3)" — the comment a generated trigger carries. */
  private label(node: TS.Node): string {
    let text = node.getText(this.c.sf).replace(/\s+/g, " ").trim();
    const brace = text.indexOf("{");
    if (brace > 0) text = text.slice(0, brace).trim();
    if (text.length > LABEL_LENGTH) text = `${text.slice(0, LABEL_LENGTH - 1)}…`;
    return `L${this.lineOf(node)}: ${text}`;
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

  /** The declaration of an identifier when it is one of the program's own (a let, a parameter, a function). */
  private gameDeclaration(id: TS.Identifier): TS.Node | undefined {
    const { ts } = this;
    let decl: TS.Node | undefined = declarationOf(ts, this.c.checker, id);
    while (decl && (ts.isBindingElement(decl) || ts.isArrayBindingPattern(decl) || ts.isObjectBindingPattern(decl))) decl = decl.parent;
    return decl && this.c.plan.game.has(decl) ? decl : undefined;
  }

  private binding(expr: TS.Expression): Binding | undefined {
    const e = this.unwrap(expr);
    if (!this.ts.isIdentifier(e)) return undefined;
    const decl = this.gameDeclaration(e);
    return decl ? this.scope.lookup(decl) : undefined;
  }

  private varOf(expr: TS.Expression): DcVar | BoolVar | undefined {
    const b = this.binding(expr);
    return b?.kind === "var" ? b.v : undefined;
  }

  /**
   * The build-time value of an expression, when it has one: a hoisted expression's, a
   * parameter's bound to one, or — so that `createUnit(p, units.Zergling, count, at)`
   * works inside a function whose `p` and `count` were bound at the call — a call,
   * member access, arithmetic or template over such values, evaluated now. Undefined
   * when a variable of the program is involved.
   */
  private evaluate(expr: TS.Expression, depth = 0): Hoisted | undefined {
    const { ts } = this;
    let e = expr;
    for (;;) {
      const k = this.c.plan.index.get(e);
      if (k !== undefined) return { value: this.hoistedValue(k, e) };
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
      else break;
    }
    if (depth > 32) return undefined;
    const sub = (x: TS.Expression) => this.evaluate(x, depth + 1);
    if (ts.isIdentifier(e)) {
      const b = this.binding(e);
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
      if (!callee || typeof callee.value !== "function") return undefined;
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

  /** A hoisted expression's value: its thunk, called the first time the walk reaches it. */
  private hoistedValue(k: number, at: TS.Node): unknown {
    if (this.evaluated.has(k)) return this.evaluated.get(k);
    let value: unknown;
    try {
      value = this.c.hoisted[k]();
    } catch (err) {
      throw new ValueError(at, `${err instanceof Error ? err.message : String(err)} — this expression is computed when the script is built, not in the game.`);
    }
    this.evaluated.set(k, value);
    return value;
  }

  private isLibraryCall(e: TS.Expression, name: string): e is TS.CallExpression {
    const { ts } = this;
    return ts.isCallExpression(e) && libraryCallName(ts, this.c.checker, e) === name;
  }

  /** The variable an expression that could not be hoisted depends on — for the message. */
  private blamedVariable(expr: TS.Node): string | null {
    const { ts } = this;
    let found: string | null = null;
    const walk = (n: TS.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && this.gameDeclaration(n) && this.binding(n)?.kind !== "value") { found = n.text; return; }
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
    if (ts.isReturnStatement(s)) {
      if (!ctx.fn) { this.c.error(s, "return outside a function."); return; }
      if (s.expression) { this.c.error(s.expression, "Functions in a program cannot return values; write the result into a variable instead."); return; }
      this.m.jump(ctx.fn.end(), this.line(s), this.label(s));
      this.dead = true;
      return;
    }
    if (ts.isSwitchStatement(s)) { this.c.error(s, "switch is not supported in a program; use if / else if."); return; }
    if (ts.isForOfStatement(s)) { this.forOfStatement(s, ctx); return; }
    if (ts.isForInStatement(s)) { this.c.error(s, "for…in is not supported in a program; for…of over a list known when the script is built is unrolled."); return; }
    if (ts.isThrowStatement(s) || ts.isTryStatement(s)) { this.c.error(s, "The game has no exceptions."); return; }
    this.c.error(s, "This statement is not supported in a program.");
  }

  private declare(list: TS.VariableDeclarationList) {
    const { ts } = this;
    for (const d of list.declarations) {
      if (this.c.plan.consts.has(d)) continue; // Computed when the script is built; its uses are hoisted expressions.
      if (!ts.isIdentifier(d.name)) { this.c.error(d.name, "Destructuring is not supported in a program."); continue; }
      if (!d.initializer) { this.c.error(d, `Give ${d.name.text} an initial value: let ${d.name.text} = 0 or = false.`); continue; }
      const type = this.c.checker.getTypeAtLocation(d.name);
      const kind = this.kindOf(type);
      if (!kind) { this.c.error(d, `Variables hold numbers (death counters) or booleans (switches); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
      // `let total = shared(0)`: one cell for every player of a per-player program, initialised with the argument.
      const init = this.unwrap(d.initializer);
      const shared = this.isLibraryCall(init, "shared");
      if (shared && init.arguments.length !== 1) { this.c.error(init, "shared() takes the initial value: shared(0) or shared(false)."); continue; }
      const initializer = shared ? init.arguments[0] : d.initializer;
      const v = kind === "number" ? (shared ? this.m.shared(d.name.text) : this.m.dc(d.name.text)) : shared ? this.m.switch(d.name.text) : this.m.bool(d.name.text);
      if (!v) { this.c.error(d, `No ${kind === "number" ? "death counter" : "switch"} is free for ${d.name.text}${this.m.perPlayer ? " (a per-player variable needs a unit with all twelve free)" : ""}.`); continue; }
      v.at = this.sourceOf(d.name);
      if (v.kind === "dc") { const bits = this.bitsOf(type); if (bits) v.bits = bits; }
      if (v.kind === "dc") this.assignNumber(v, initializer, d);
      else this.assignBool(v, initializer, d);
      // Bound after the initialiser: `let x = x` is the checker's error, not a self-reference here.
      this.scope.bind(d, { kind: "var", v });
    }
  }

  /** Where a declaration's name is, for the editor's hover. */
  private sourceOf(node: TS.Node): { file: string; line: number; column: number } {
    const p = this.c.sf.getLineAndCharacterOfPosition(node.getStart(this.c.sf));
    return { file: this.c.sf.fileName, line: p.line + 1, column: p.character + 1 };
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
      const target = this.varOf(e.left);
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken || op === ts.SyntaxKind.MinusEqualsToken) {
        if (!target) { this.c.error(e.left, "Only the program's let variables can be assigned."); return; }
        if (target.kind !== "dc") {
          if (op !== ts.SyntaxKind.EqualsToken) { this.c.error(e, "Booleans take = only."); return; }
          this.assignBool(target, e.right, e);
          return;
        }
        if (op === ts.SyntaxKind.EqualsToken) { this.assignNumber(target, e.right, e); return; }
        const rhs = this.linear(e.right);
        if (!rhs) return;
        const sign = op === ts.SyntaxKind.PlusEqualsToken ? 1 : -1;
        this.m.assign(target, { c: sign * rhs.c, terms: [{ v: target, sign: 1 }, ...rhs.terms.map((t) => ({ v: t.v, sign: (t.sign * sign) as 1 | -1 }))] }, this.line(e), this.label(e));
        return;
      }
      if (op === ts.SyntaxKind.AsteriskEqualsToken || op === ts.SyntaxKind.SlashEqualsToken || op === ts.SyntaxKind.PercentEqualsToken) {
        this.c.error(e, "The game can only add and subtract: there is no multiplication or division between variables.");
        return;
      }
      this.c.error(e, "Only assignments and calls can stand as statements.");
      return;
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = this.varOf(e.operand);
      if (!target || target.kind !== "dc") { this.c.error(e, "++ / -- apply to number variables."); return; }
      this.m.addConst(target, e.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1, this.line(e), this.label(e));
      return;
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) {
        const decl = this.gameDeclaration(e.expression);
        if (decl) {
          if (ts.isFunctionDeclaration(decl)) { this.inline(e, decl); return; }
          this.c.error(e, `${e.expression.text} is not a function.`);
          return;
        }
      }
      if (this.isLibraryCall(e, "random")) { this.c.error(e, "random() does nothing on its own; test it in an if, or assign it to a boolean."); return; }
      if (this.isLibraryCall(e, "sleep")) { this.sleepStatement(e); return; }
      if (this.isLibraryCall(e, "rose") || this.isLibraryCall(e, "once")) { this.c.error(e, "rose() / once() are conditions: test them in an if."); return; }
      if (this.isLibraryCall(e, "shared")) { this.c.error(e, "shared() goes on a declaration: let total = shared(0)."); return; }
      this.notConstant(e, "A call's arguments");
      return;
    }
    this.c.error(e, "Only assignments and calls can stand as statements.");
  }

  private ifStatement(s: TS.IfStatement, ctx: Ctx) {
    const held = this.m.tempsHeld;
    const b = this.bool(s.expression);
    if (b.kind === "const") {
      // Known when the script is built: only the side that runs is compiled, and the other is never evaluated either.
      this.m.releaseTo(held);
      const live = b.value ? s.thenStatement : s.elseStatement;
      if (live) this.statement(live, ctx);
      return;
    }
    const join = this.m.fresh();
    const thenState = this.m.fresh();
    const elseState = s.elseStatement ? this.m.fresh() : join;
    this.m.branch(b, thenState, elseState, this.line(s), this.label(s));
    this.m.releaseTo(held);
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

  private whileStatement(s: TS.WhileStatement, ctx: Ctx) {
    if (this.neverRuns(s.expression)) return;
    const header = this.m.loopHeader(this.line(s), this.label(s));
    const exit = this.m.fresh();
    let broke = false;
    const held = this.m.tempsHeld;
    const b = this.bool(s.expression);
    let body: number;
    if (b.kind === "const" && b.value) body = header;
    else {
      body = this.m.fresh();
      this.m.branch(b, body, exit, this.line(s), this.label(s));
      this.m.enter(body);
    }
    this.m.releaseTo(held);
    this.dead = false;
    this.statement(s.statement, { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => header });
    if (!this.dead) this.m.jump(header, this.line(s), `L${this.line(s)}: loop`);
    if (body === header && !broke) { this.dead = true; return; }
    this.m.enter(exit);
    this.dead = false;
  }

  private doStatement(s: TS.DoStatement, ctx: Ctx) {
    const body = this.m.loopHeader(this.line(s), this.label(s));
    // The condition is tested in a state of its own: a branch back to the state it runs in would fall through as well.
    const check = this.m.fresh();
    const exit = this.m.fresh();
    this.dead = false;
    this.statement(s.statement, { fn: ctx.fn, breakTo: () => exit, continueTo: () => check });
    if (!this.dead) this.m.jump(check, this.line(s), `L${this.line(s)}: while`);
    this.m.enter(check);
    this.dead = false;
    const held = this.m.tempsHeld;
    const b = this.bool(s.expression);
    this.m.branch(b, body, exit, this.line(s), `L${this.line(s)}: while (${s.expression.getText(this.c.sf).replace(/\s+/g, " ")})`);
    this.m.releaseTo(held);
    this.m.enter(exit);
  }

  private forStatement(s: TS.ForStatement, ctx: Ctx) {
    const { ts } = this;
    const outer = this.scope;
    this.scope = new Scope(outer);
    if (s.initializer) {
      if (ts.isVariableDeclarationList(s.initializer)) this.declare(s.initializer);
      else this.expressionStatement(s.initializer);
    }
    if (this.neverRuns(s.condition)) { this.scope = outer; return; }
    const header = this.m.loopHeader(this.line(s), this.label(s));
    const exit = this.m.fresh();
    let broke = false;
    let incr: number | null = null;
    const held = this.m.tempsHeld;
    const b = s.condition ? this.bool(s.condition) : TRUE;
    let body: number;
    if (b.kind === "const" && b.value) body = header;
    else {
      body = this.m.fresh();
      this.m.branch(b, body, exit, this.line(s), this.label(s));
      this.m.enter(body);
    }
    this.m.releaseTo(held);
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

  /**
   * `for (const w of waves)` over a list known when the script is built: unrolled, the body
   * compiled once per element with `w` bound to that element's value. `break` leaves the
   * whole loop, `continue` goes on with the next element.
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
      items = typeof h.value === "string" || (typeof h.value === "object" && h.value !== null && Symbol.iterator in h.value) ? Array.from(h.value as Iterable<unknown>) : [];
      if (!(typeof h.value === "string") && !(typeof h.value === "object" && h.value !== null && Symbol.iterator in h.value)) { this.c.error(s.expression, `for…of runs over a list, got ${describe(h.value)}.`); return; }
    } catch (err) {
      this.c.error(s.expression, `for…of: ${(err as Error).message}`);
      return;
    }
    const exit = this.m.fresh();
    let broke = false;
    for (const item of items) {
      const scope = new Scope(this.scope);
      scope.bind(decl, { kind: "value", value: item });
      let next: number | null = null;
      this.block([s.statement], { fn: ctx.fn, breakTo: () => { broke = true; return exit; }, continueTo: () => (next ??= this.m.fresh()) }, scope);
      if (next !== null) {
        if (!this.dead) this.m.jump(next, this.line(s), `L${this.line(s)}: continue`);
        this.m.enter(next);
        this.dead = false;
      }
      if (this.dead) break; // Nothing after a break / return in the body's straight line is reached; nor are the elements after it.
    }
    if (broke) {
      if (!this.dead) this.m.jump(exit, this.line(s), `L${this.line(s)}: end of for…of`);
      this.m.enter(exit);
      this.dead = false;
    }
  }

  /* ── Functions ── */

  private inline(call: TS.CallExpression, decl: TS.FunctionDeclaration) {
    const { ts } = this;
    if (!decl.body) { this.c.error(call, "The function has no body."); return; }
    if (this.inlineDepth >= MAX_INLINE_DEPTH) { this.c.error(call, "Functions nest too deeply (recursion is not possible: a call is inlined)."); return; }
    if (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) { this.c.error(decl, "Generators and async functions are not supported in a program."); return; }
    const scope = new Scope(this.topScope);
    let ok = true;
    decl.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) { this.c.error(p, "Destructured parameters are not supported in a program."); ok = false; return; }
      if (p.dotDotDotToken) { this.c.error(p, "Rest parameters are not supported in a program."); ok = false; return; }
      const arg = call.arguments[i];
      if (!arg) {
        if (!p.initializer) { this.c.error(call, `Missing argument ${p.name.text}.`); ok = false; return; }
        const h = this.evaluate(p.initializer);
        if (!h) { this.notConstant(p.initializer, "A default value"); ok = false; return; }
        scope.bind(p, { kind: "value", value: h.value });
        return;
      }
      const h = this.evaluate(arg);
      if (h) { scope.bind(p, { kind: "value", value: h.value }); return; }
      const variable = this.varOf(arg);
      if (variable) {
        // By value, as in TypeScript. A parameter the function never assigns can read the caller's variable directly; one it assigns gets a copy.
        if (!this.assigns(decl.body!, p)) { scope.bind(p, { kind: "var", v: variable }); return; }
        const copy = variable.kind === "dc" ? this.m.dc(p.name.text) : this.m.bool(p.name.text);
        if (!copy) { this.c.error(p, `No ${variable.kind === "dc" ? "death counter" : "switch"} is free for ${p.name.text}.`); ok = false; return; }
        copy.at = this.sourceOf(p.name);
        if (copy.kind === "dc" && variable.kind === "dc" && variable.bits) copy.bits = variable.bits;
        const line = this.line(call);
        const label = `L${line}: ${p.name.text} = ${arg.getText(this.c.sf)}`;
        if (copy.kind === "dc") this.m.assign(copy, { c: 0, terms: [{ v: variable as DcVar, sign: 1 }] }, line, label);
        else this.storeBool(copy, cond(boolCondition(variable as BoolVar, true)), line, label);
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      this.notConstant(arg, "An argument");
      ok = false;
    });
    if (!ok) return;
    if (call.arguments.length > decl.parameters.length) { this.c.error(call, `${decl.name?.text ?? "The function"} takes ${decl.parameters.length} argument${decl.parameters.length === 1 ? "" : "s"}.`); return; }
    const saved = this.scope;
    this.scope = scope;
    this.inlineDepth++;
    let end: number | null = null;
    this.block(decl.body.statements, { fn: { end: () => (end ??= this.m.fresh()) } });
    this.inlineDepth--;
    this.scope = saved;
    if (end !== null) {
      if (!this.dead) this.m.jump(end, this.line(call), `L${this.line(call)}: end of ${decl.name?.text ?? "function"}`);
      this.m.enter(end);
      this.dead = false;
    }
  }

  /** Whether a function body assigns to (or increments) one of its parameters anywhere. */
  private assigns(body: TS.Node, param: TS.ParameterDeclaration): boolean {
    const { ts } = this;
    let found = false;
    const target = (e: TS.Expression) => {
      const u = this.unwrap(e);
      return ts.isIdentifier(u) && declarationOf(ts, this.c.checker, u) === param;
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

  /** `c + Σ ±v` over death counters, or null (with a diagnostic). */
  private linear(expr: TS.Expression): Linear | null {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h) {
      const n = this.asInteger(h, e);
      return n === null ? null : { c: n, terms: [] };
    }
    if (ts.isIdentifier(e)) {
      const b = this.binding(e);
      if (b?.kind === "var") {
        if (b.v.kind !== "dc") { this.c.error(e, `${b.v.name} is a boolean.`); return null; }
        return { c: 0, terms: [{ v: b.v, sign: 1 }] };
      }
      this.c.error(e, `${e.text} is not a variable of the program.`);
      return null;
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const inner = this.linear(e.operand);
      if (!inner) return null;
      if (e.operator === ts.SyntaxKind.PlusToken) return inner;
      if (e.operator === ts.SyntaxKind.MinusToken) return { c: -inner.c, terms: inner.terms.map((t) => ({ v: t.v, sign: -t.sign as 1 | -1 })) };
      this.c.error(e, "Only + and - apply to variables.");
      return null;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken) {
        const l = this.linear(e.left);
        const r = this.linear(e.right);
        if (!l || !r) return null;
        const sign = op === ts.SyntaxKind.PlusToken ? 1 : -1;
        return { c: l.c + sign * r.c, terms: [...l.terms, ...r.terms.map((t) => ({ v: t.v, sign: (t.sign * sign) as 1 | -1 }))] };
      }
      this.c.error(e, "The game can only add and subtract variables; * / % work on values known when the script is built.");
      return null;
    }
    if (ts.isCallExpression(e)) { this.notConstant(e, "A call's arguments"); return null; }
    this.c.error(e, "Expected a number: a value, a variable, or a sum of them.");
    return null;
  }

  /* ── Booleans ── */

  private assignBool(v: BoolVar, expr: TS.Expression, at: TS.Node) {
    const { ts } = this;
    const e = this.unwrap(expr);
    const line = this.line(at);
    const label = this.label(at);
    const h = this.evaluate(expr);
    if (h && typeof h.value === "boolean") { this.m.action(setBool(v, h.value), line, label); return; }
    // A switch toggles and randomizes in one action; a flag (a per-player boolean) goes through a branch.
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken && this.varOf(e.operand) === v && v.kind === "switch") { this.m.action(setSwitch(v, SwitchAction.Toggle), line, label); return; }
    if (this.isLibraryCall(e, "random") && v.kind === "switch") { this.m.action(setSwitch(v, SwitchAction.Randomize), line, label); return; }
    const held = this.m.tempsHeld;
    const b = this.bool(e);
    if (b.kind === "const") { this.m.action(setBool(v, b.value), line, label); this.m.releaseTo(held); return; }
    this.storeBool(v, b, line, label);
    this.m.releaseTo(held);
  }

  /** `v = b` for a condition tree: branch, set on one side, clear on the other. */
  private storeBool(v: BoolVar, b: Bool, line: number, label: string) {
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.m.branch(b, on, off, line, label);
    this.m.enter(on);
    this.m.action(setBool(v, true), line, label);
    this.m.jump(join, line, label);
    this.m.enter(off);
    this.m.action(setBool(v, false), line, label);
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
  private edge(call: TS.CallExpression, kind: "rose" | "once", depth: number): Bool {
    if (call.arguments.length !== 1) { this.c.error(call, `${kind}() takes one condition.`); return FALSE; }
    const latch = this.m.bool(`(${kind} latch)`);
    const fired = this.m.bool(`(${kind} fired)`);
    if (!latch || !fired) { this.c.error(call, `No switch is free for ${kind}().`); return FALSE; }
    const line = this.line(call);
    const label = this.label(call);
    const held = this.m.tempsHeld;
    const c = this.boolInner(call.arguments[0], depth + 1);
    const on = this.m.fresh();
    const off = this.m.fresh();
    const join = this.m.fresh();
    this.m.branch(c, on, off, line, label);
    this.m.releaseTo(held);
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
    if (isCondition(v)) return cond(v.record as ConditionRecord);
    if (Array.isArray(v) && v.length > 0 && v.every(isCondition)) return and(v.map((c) => cond(c.record)));
    if (isAction(v)) { this.c.error(at, "This is an action, not a condition."); return FALSE; }
    this.c.error(at, `Expected a condition, got ${describe(v)}.`);
    return FALSE;
  }

  /** A condition as a `Bool` tree; may emit steps (temps for variable comparisons, a randomize). */
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
    if (ts.isIdentifier(e)) {
      const b = this.binding(e);
      if (b?.kind === "var") return b.v.kind !== "dc" ? cond(boolCondition(b.v, true)) : compareConst(b.v, ">=", 1);
      this.c.error(e, `${e.text} is not a variable of the program or a condition.`);
      return FALSE;
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression) && this.gameDeclaration(e.expression)) { this.c.error(e, "Functions in a program have no return value; test a variable the function sets instead."); return FALSE; }
      if (this.isLibraryCall(e, "random")) {
        const s = this.m.scratch(this.scratchUsed++);
        this.m.action(setSwitch(s, SwitchAction.Randomize), this.line(e), `L${this.line(e)}: random()`);
        return cond(switchCondition(s, true));
      }
      if (this.isLibraryCall(e, "rose")) return this.edge(e, "rose", depth);
      if (this.isLibraryCall(e, "once")) return this.edge(e, "once", depth);
      if (this.isLibraryCall(e, "sleep")) { this.c.error(e, "sleep() is a statement, not a condition."); return FALSE; }
      this.notConstant(e, "A condition's arguments");
      return FALSE;
    }
    this.c.error(e, "Expected a condition: a trigger condition, a comparison, a boolean variable, or a combination with && || !.");
    return FALSE;
  }

  private comparison(e: TS.BinaryExpression, op: CompareOp, depth: number): Bool {
    // Boolean equality: `flag == true`, `a != b` over switches.
    const isBool = (x: TS.Expression) => {
      const h = this.evaluate(x);
      if (h) return typeof h.value === "boolean" || isCondition(h.value);
      const v = this.varOf(this.unwrap(x));
      return v !== undefined && v.kind !== "dc";
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
    const d: Linear = { c: l.c - r.c, terms: [...l.terms, ...r.terms.map((t) => ({ v: t.v, sign: -t.sign as 1 | -1 }))] };
    // Cancel a variable that appears on both sides with opposite signs.
    for (let i = 0; i < d.terms.length; i++) {
      const j = d.terms.findIndex((t, k) => k > i && t.v === d.terms[i].v && t.sign !== d.terms[i].sign);
      if (j >= 0) { d.terms.splice(j, 1); d.terms.splice(i, 1); i--; }
    }
    if (d.terms.length === 0) return compareNumbers(d.c, op, 0) ? TRUE : FALSE;
    if (d.terms.length === 1) {
      const t = d.terms[0];
      return t.sign > 0 ? compareConst(t.v, op, -d.c) : compareConst(t.v, flipOp(op), d.c);
    }
    // Two sides to compute: `a + c  op  b` with the constant on whichever side keeps it non-negative.
    const line = this.line(e);
    const label = `L${line}: ${e.getText(this.c.sf).replace(/\s+/g, " ")}`;
    const left: Linear = { c: Math.max(0, d.c), terms: d.terms.filter((t) => t.sign > 0) };
    const right: Linear = { c: Math.max(0, -d.c), terms: d.terms.filter((t) => t.sign < 0).map((t) => ({ v: t.v, sign: 1 as const })) };
    const side = (x: Linear): DcVar => {
      if (x.c === 0 && x.terms.length === 1) return x.terms[0].v;
      const t = this.m.temp();
      this.m.evaluate(t, x, line, label);
      return t;
    };
    const a = side(left);
    const b = side(right);
    return this.m.compareVars(a, op, b, line, label).bool;
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
