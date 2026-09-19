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
import { ActionType } from "../vendor/triggers";
import type { ActionRecord } from "../vendor/triggers";
import type { HoistedThunks, ProgramPlan } from "./hoist";
import { declarationOf, libraryCallName } from "./hoist";
import { scriptParams } from "./api";
import { hasTextMark, isAction, isBuilder, isChat, isCondition, isDuration, isGameFunction, isGameValue, isInput, isMouse, isPrint, isRead, isReader, isTable, isTrigger, isUnitPick, isUnitQuery, playerColor, READ_ARITY, textParts, type GameFunctionValue, type InputValue, type ReadValue, type ScriptString, type TableValue, type UnitPickValue } from "./runtime";
import { cellMax } from "./tables";
import { Scope, type Binding } from "./scope";
import { ACTIONS_WITH_MODIFIER, LowerError } from "./lower";
import { IR_VERSION, UNIT_FLAGS, UNIT_NUM_FIELDS, UNIT_WRITABLE, type ActionVariable, type ArithOp, type At, type BoolExpr, type Call, type CompareOp, type NumExpr, type Program, type Stmt, type TextPart, type UnitExpr, type UnitFlag, type UnitNumField, type UnitVerb, type VarDecl } from "./ir";

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

const TRUE: BoolExpr = { kind: "const", value: true };
const FALSE: BoolExpr = { kind: "const", value: false };
const num = (value: number): NumExpr => ({ kind: "const", value });
const varRef = (v: VarDecl): NumExpr => ({ kind: "var", id: v.id });
const boolRef = (v: VarDecl): BoolExpr => ({ kind: "var", id: v.id });
const unitRef = (v: VarDecl): UnitExpr => ({ kind: "unitVar", id: v.id });
const NO_UNIT: UnitExpr = { kind: "unitNull" };
const ORDERS: readonly string[] = ["move", "patrol", "attack"];

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

  private newVar(name: string, kind: Kind, at: At, extra: { shared?: boolean; bits?: 8 | 16; temp?: boolean } = {}): VarDecl {
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
      if (!ts.isIdentifier(d.name)) { this.c.error(d.name, "Destructuring is not supported in a program."); continue; }
      if (!d.initializer) { this.c.error(d, `Give ${d.name.text} an initial value: let ${d.name.text} = 0 or = false.`); continue; }
      const init = this.unwrap(d.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        const record = this.declareRecord(d.name.text, init, this.c.checker.getTypeAtLocation(d.name), d);
        if (record) this.scope.bind(d, record);
        continue;
      }
      if (ts.isCallExpression(init) && (this.isLibraryCall(init, "mouse") || this.isLibraryCall(init, "chatted"))) {
        const record = this.declareInput(d.name.text, init, d);
        if (record) this.scope.bind(d, record);
        continue;
      }
      const type = this.c.checker.getTypeAtLocation(d.name);
      const kind = this.kindOf(type);
      if (!kind) { this.c.error(d, `Variables hold numbers, booleans, units of the game or records of them ({ lives: 3 }); ${d.name.text} is ${this.c.checker.typeToString(type)}.`); continue; }
      // `let total = shared(0)`: one cell for every player of a per-player program, initialised with the argument.
      const shared = ts.isCallExpression(init) && this.isLibraryCall(init, "shared") ? init : null;
      if (shared && shared.arguments.length !== 1) { this.c.error(init, "shared() takes the initial value: shared(0) or shared(false)."); continue; }
      if (shared && kind === "unit") { this.c.error(init, "shared() holds a number or a boolean."); continue; }
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
    } else if (v.kind === "unit") {
      const value = this.unitExpr(initializer);
      this.emit({ kind: "declare", decl: v, init: value ?? NO_UNIT, ...(value ? {} : { failed: true }), at: this.at(at), label: this.label(at) }, at);
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
      if (!kind) { this.c.error(p, `A record's fields hold numbers, booleans or units; ${full} is ${this.c.checker.typeToString(ft)}.`); ok = false; continue; }
      const v = this.newVar(full, kind, this.sourceOf(p.name), kind === "number" ? { bits: this.bitsOf(ft) } : {});
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

  private kindOf(type: TS.Type): Kind | null {
    const { ts } = this;
    const isNumber = (t: TS.Type): boolean => (t.flags & ts.TypeFlags.NumberLike) !== 0 || (t.isIntersection() && t.types.some(isNumber));
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
        const member = this.unitMember(e.left);
        if (member) { this.unitAssign(e, member, op); return; }
        const cell = this.evaluate(e.left)?.value;
        if (isTable(cell)) { this.tableAssign(e, cell, op); return; }
        const target = this.varOf(e.left);
        if (!target) {
          const b = this.bindingOf(e.left);
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
        if (!arith) { this.c.error(e, "Only = += -= *= /= %= &= |= ^= <<= >>= assign a number."); return; }
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
      // By value: a read passed as an argument is read once, at the call, into a variable of the parameter's own.
      if (h && !isGameValue(h.value)) { scope.bind(p, { kind: "value", value: h.value }); return; }
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
        out.params.push({ decl: copy, init: variable.kind === "number" ? varRef(variable) : variable.kind === "unit" ? unitRef(variable) : boolRef(variable), label });
        scope.bind(p, { kind: "var", v: copy });
        return;
      }
      if (this.isUnitTyped(arg)) {
        // A unit found at the call (first(…), a function's result): found once, into a variable of the parameter's own.
        const unit = this.unitExpr(arg);
        if (!unit) { ok = false; return; }
        const copy = this.newVar(p.name.text, "unit", this.sourceOfIn(target, p.name));
        out.params.push({ decl: copy, init: unit, label: `L${line}: ${p.name.text} = ${arg.getText(this.body.sf)}` });
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
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
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
    if (ts.isBinaryExpression(e)) {
      const op = arithOp(ts, e.operatorToken.kind);
      if (!op) { this.c.error(e, "Expected a number: variables take + - * / % and the bitwise & | ^ << >>."); return null; }
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
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var" && b.v.kind === "unit") return unitRef(b.v);
      this.c.error(e, "Expected a unit of the game: a variable holding one, first(…), nearest(…) or randomUnit(…).");
      return null;
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
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const b = this.bindingOf(e);
      if (b?.kind === "var") return b.v.kind !== "number" ? boolRef(b.v) : this.mark<BoolExpr>({ kind: "test", expr: varRef(b.v), at: this.at(e), label: this.label(e) }, e);
      if (b?.kind === "record" && b.truth) return boolRef(b.truth);
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
    case ts.SyntaxKind.GreaterThanGreaterThanToken: case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return ">>";
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
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken: case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken: return ">>";
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
