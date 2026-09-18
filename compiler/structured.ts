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
 * - Functions declared in the body, and `game()` functions, are inlined at each call.
 *   Arguments pass by value, as in TypeScript: a parameter bound to a build-time value
 *   is that value, one bound to a variable reads that variable directly when the
 *   function never assigns it (free) and is a copy when it does. A function may return a
 *   number or a boolean, through a temp. No recursion.
 * - `if (false) …` and `while (false) …` are pruned: what is inside never runs, when the
 *   script is built or in the game.
 * - The amount of `setResources` / `setDeaths` / `setScore` / `setCountdownTimer` and the
 *   unit count of `createUnit` / `killUnitAt` / `removeUnitAt` / `giveUnits` may be a
 *   variable.
 *
 * Everything the body reads from outside — the library's conditions and actions, the
 * script's constants and helpers — arrives as *hoisted values* (`hoist.ts`): the plan
 * numbers those expressions and the run handed back a thunk for each, called when the
 * walk reaches the expression, so where the source says `bring(P1, units.Marine, base,
 * ">=", 1)` this walker sees a condition record. A thunk that throws is reported at the
 * expression, with a note that it ran when the script was built.
 */
import type * as TS from "typescript";
import { ActionType } from "../vendor/triggers";
import type { ActionRecord } from "../vendor/triggers";
import type { HoistedThunks, ProgramPlan } from "./hoist";
import { declarationOf, libraryCallName } from "./hoist";
import { scriptParams } from "./api";
import { isAction, isBuilder, isCondition, isDuration, isGameFunction, isTrigger, type GameFunctionValue } from "./runtime";
import { Scope, type Binding } from "./scope";
import { ACTIONS_WITH_MODIFIER, LowerError } from "./lower";
import { IR_VERSION, type At, type BoolExpr, type Call, type CompareOp, type NumExpr, type Program, type Stmt, type VarDecl } from "./ir";

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
  fn?: { kind: "number" | "boolean" | "void" };
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

const TRUE: BoolExpr = { kind: "const", value: true };
const FALSE: BoolExpr = { kind: "const", value: false };
const num = (value: number): NumExpr => ({ kind: "const", value });
const varRef = (v: VarDecl): NumExpr => ({ kind: "var", id: v.id });
const boolRef = (v: VarDecl): BoolExpr => ({ kind: "var", id: v.id });

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

  constructor(c: StructuredContext) {
    this.c = c;
    this.ts = c.ts;
    this.body = c.body;
  }

  run(): Emitted {
    const statements = this.body.plan.body.statements;
    const at = this.at(this.body.plan.body);
    const program: Program = { version: IR_VERSION, ...(this.body.name ? { name: this.body.name } : {}), owner: this.c.owner, owners: [...this.c.owners], perPlayer: this.c.perPlayer, body: [], at };
    this.nodes.set(program, this.body.plan.body);
    this.out = program.body;
    try {
      this.block(statements, {}, this.topScope);
    } catch (err) {
      if (!(err instanceof LowerError)) throw err;
      this.c.error(statements[statements.length - 1] ?? this.body.plan.body, err.message);
    }
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

  private newVar(name: string, kind: "number" | "boolean", at: At, extra: { shared?: boolean; bits?: 8 | 16; temp?: boolean } = {}): VarDecl {
    return { id: `${name}#${this.nextId++}`, name, kind, shared: extra.shared ?? false, ...(extra.bits ? { bits: extra.bits } : {}), ...(extra.temp ? { temp: true } : {}), at };
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
      if (!kind) { this.c.error(d, `Variables hold numbers, booleans or records of them ({ lives: 3 }); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
      // `let total = shared(0)`: one cell for every player of a per-player program, initialised with the argument.
      const shared = ts.isCallExpression(init) && this.isLibraryCall(init, "shared") ? init : null;
      if (shared && shared.arguments.length !== 1) { this.c.error(init, "shared() takes the initial value: shared(0) or shared(false)."); continue; }
      const initializer = shared ? shared.arguments[0] : d.initializer;
      const v = this.newVar(d.name.text, kind, this.sourceOf(d.name), { shared: !!shared, ...(kind === "number" ? { bits: this.bitsOf(type) } : {}) });
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
    } else {
      this.emit({ kind: "declare", decl: v, init: this.boolValue(initializer), at: this.at(at), label: this.label(at) }, at);
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
      const v = this.newVar(full, kind, this.sourceOf(p.name), kind === "number" ? { bits: this.bitsOf(ft) } : {});
      this.emitDeclare(v, init, at);
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
  private bitsOf(type: TS.Type): 8 | 16 | undefined {
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
    this.emit({ kind: "action", record: { ...a }, at: this.at(at), label: this.label(at) }, at);
  }

  /** `sleep(seconds(2))`: the duration is a build-time value; what it makes of it is the target's. */
  private sleepStatement(call: TS.CallExpression) {
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
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        const target = this.varOf(e.left);
        if (!target) {
          const b = this.bindingOf(e.left);
          if (b?.kind === "record") this.c.error(e.left, "A record is assigned field by field: p.lives = 3.");
          else if ((ts.isPropertyAccessExpression(this.unwrap(e.left)) || ts.isElementAccessExpression(this.unwrap(e.left))) && this.evaluate(e.left)) this.c.error(e.left, "This object is computed when the script is built. Declare it with let inside the program to make it a record of variables.");
          else this.c.error(e.left, "Only the program's let variables can be assigned.");
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
        if (!arith) { this.c.error(e, "Only = += -= *= /= %= assign a number."); return; }
        const rhs = this.num(e.right);
        if (!rhs) return;
        this.emit({ kind: "assign", target: target.id, value: this.mark({ kind: "binary", op: arith, left: varRef(target), right: rhs, at: this.at(e), label: this.label(e) }, e), at: this.at(e), label: this.label(e) }, e);
        return;
      }
      this.c.error(e, "Only assignments and calls can stand as statements.");
      return;
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
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
    if (this.isLibraryCall(e, "random")) { this.c.error(e, "random() does nothing on its own; test it in an if, or assign it to a boolean."); return; }
    if (this.isLibraryCall(e, "sleep")) { this.sleepStatement(e); return; }
    if (this.isLibraryCall(e, "rose") || this.isLibraryCall(e, "once")) { this.c.error(e, "rose() / once() are conditions: test them in an if."); return; }
    if (this.isLibraryCall(e, "shared")) { this.c.error(e, "shared() goes on a declaration: let total = shared(0)."); return; }
    const callee = this.evaluate(e.expression)?.value;
    if (isGameFunction(callee)) { const call = this.gameCall(e, callee); if (call) this.emit({ kind: "call", call, at: call.at, label: call.label }, e); return; }
    if (isBuilder(callee)) {
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
    return this.bool(condition);
  }

  private whileStatement(s: TS.WhileStatement, ctx: Ctx) {
    if (this.neverRuns(s.expression)) return;
    const cond = this.loopCondition(s.expression);
    const body = this.sub(s.statement, { fn: ctx.fn, canBreak: true, canContinue: true });
    this.emit({ kind: "while", ...(cond ? { cond } : {}), body, at: this.at(s), label: this.label(s) }, s);
  }

  private doStatement(s: TS.DoStatement, ctx: Ctx) {
    const body = this.sub(s.statement, { fn: ctx.fn, canBreak: true, canContinue: true });
    const cond = this.bool(s.expression);
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
   * Inline a function at a call: parameters bound, the body walked, `return` leaving it.
   * The result — a number or a boolean the checker says the call has — comes back in a
   * variable of the call's own that dies with the statement.
   */
  private inline(call: TS.CallExpression, parameters: readonly TS.ParameterDeclaration[], body: TS.Block | TS.Expression | undefined, target: Body, name: string | undefined, decl: TS.Node): Call | undefined {
    const { ts } = this;
    const what = name ?? "The function";
    if (!body) { this.c.error(call, "The function has no body."); return undefined; }
    if (this.inlineDepth >= MAX_INLINE_DEPTH) { this.c.error(call, "Functions nest too deeply (recursion is not possible: a call is inlined)."); return undefined; }
    if ((ts.isFunctionDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) { this.c.error(decl, "Generators and async functions are not supported in a program."); return undefined; }
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(call)) ?? "void";
    const line = this.line(call);
    const out: Call = { ...(name ? { name } : {}), at: this.at(call), label: this.label(call), params: [], body: [] };
    if (kind !== "void") out.result = { decl: this.newVar(`(${name ?? "function"} result)`, kind, this.at(call), { temp: true }), kind };
    this.mark(out, call);
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
        const copy = this.newVar(p.name.text, variable.kind, this.sourceOfIn(target, p.name), variable.bits ? { bits: variable.bits } : {});
        const label = `L${line}: ${p.name.text} = ${arg.getText(this.body.sf)}`;
        out.params.push({ decl: copy, init: variable.kind === "number" ? varRef(variable) : boolRef(variable), label });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      const value = ts.isIdentifier(this.unwrap(arg)) ? null : this.numQuietly(arg);
      if (value) {
        // An expression over variables: computed into a variable of the parameter's own.
        const copy = this.newVar(p.name.text, "number", this.sourceOfIn(target, p.name));
        out.params.push({ decl: copy, init: value, label: `L${line}: ${p.name.text} = ${arg.getText(this.body.sf)}` });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      this.notConstant(arg, "An argument");
      ok = false;
    });
    if (!ok) return out;
    if (call.arguments.length > parameters.length) { this.c.error(call, `${what} takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"}.`); return out; }
    const saved = this.enterBody(target);
    const outerScope = this.scope;
    this.scope = scope;
    this.inlineDepth++;
    const fn: Ctx["fn"] = { kind };
    try {
      out.body = this.collect(() => {
        if (ts.isBlock(body)) this.block(body.statements, { fn });
        else {
          // `game((a: number) => a + 1)`: the expression is what it returns.
          try {
            if (kind === "number") { const value = this.num(body); if (value) this.emit({ kind: "return", value, at: this.at(body), label: this.label(body) }, body); }
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
    return out;
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

  private asInteger(h: Hoisted, at: TS.Node): number | null {
    const v = h.value;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v !== "number" || !Number.isFinite(v)) { this.c.error(at, `Expected a number, got ${describe(v)}.`); return null; }
    if (!Number.isInteger(v)) { this.c.error(at, `Only whole numbers exist in the game (got ${v}).`); return null; }
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
      const n = this.asInteger(h, e);
      return n === null ? null : num(n);
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") {
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
    if (ts.isBinaryExpression(e)) {
      const op = arithOp(ts, e.operatorToken.kind);
      if (!op) { this.c.error(e, "Expected a number: variables add, subtract, multiply, divide and take the remainder."); return null; }
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

  /** A call as a number: a function of the body or a game function (its result), or an intrinsic over variables. */
  private callValue(e: TS.CallExpression): NumExpr | null {
    const { ts } = this;
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
   * An action whose argument is a variable: `setResources(P1, "add", n, "ore")`,
   * `createUnit(P2, unit, count, at)`. The record is built with the variable's place
   * as 0; the backend does the action with the expression's value in that field.
   */
  private actionWithVars(e: TS.CallExpression, ident: string, def: Parameters<typeof scriptParams>[0]) {
    const params = scriptParams(def);
    const values: unknown[] = [];
    let variable: { index: number; expr: NumExpr } | null = null;
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
      const expr = this.num(a);
      if (!expr) return;
      variable = { index: i, expr };
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
    this.emit({ kind: "action", record: { ...record }, variable: { field: p.arg.field as keyof ActionRecord, bits: p.arg.kind === "count" ? 8 : 32, name: p.name, expr: variable.expr }, at: this.at(e), label: this.label(e) }, e);
  }

  /* ── Booleans ── */

  /** The value stored into a boolean: a constant, a coin toss, a condition tree. */
  private boolValue(expr: TS.Expression): BoolExpr {
    const { ts } = this;
    const e = this.unwrap(expr);
    const h = this.evaluate(expr);
    if (h && typeof h.value === "boolean") return { kind: "const", value: h.value };
    if (this.isLibraryCall(e, "random")) return this.mark<BoolExpr>({ kind: "random", at: this.at(e) }, e);
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
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") return b.v.kind !== "number" ? boolRef(b.v) : this.mark<BoolExpr>({ kind: "test", expr: varRef(b.v), at: this.at(e), label: this.label(e) }, e);
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
      if (this.isLibraryCall(e, "random")) return this.mark<BoolExpr>({ kind: "random", at: this.at(e) }, e);
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

  /** A call whose result is tested: a boolean result, or a number's `!= 0`. */
  private callBool(e: TS.CallExpression, run: () => Call | undefined): BoolExpr {
    const kind = this.kindOf(this.c.checker.getTypeAtLocation(e));
    if (!kind) { this.c.error(e, "This function returns nothing to test; test a variable it sets instead."); return FALSE; }
    const call = run();
    return call?.result ? this.mark<BoolExpr>({ kind: "call", call }, e) : FALSE;
  }

  private comparison(e: TS.BinaryExpression, op: CompareOp, depth: number): BoolExpr {
    // Boolean equality: `flag == true`, `a != b` over switches.
    const isBool = (x: TS.Expression) => {
      const h = this.evaluate(x);
      if (h) return typeof h.value === "boolean" || isCondition(h.value);
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
