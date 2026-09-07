/**
 * What inside `program(() => { … })` runs when the script is built, and what runs in
 * the game. The body is real TypeScript, but its `let` variables are death counters
 * and its `if`s are trigger conditions, so it cannot simply run. Instead:
 *
 * - A *game binding* is a `let` / `var` of the body, a parameter, a function declared in
 *   it, or a `const` whose value needs one of those. Everything else an expression can
 *   name — the script's other files, the library, a `const` of the body computed from
 *   build-time values alone — is known at build time.
 * - A *hoisted expression* is a maximal subexpression that mentions no game binding (and
 *   is not `random()`, which the game answers). The transformer emits, in the arrow's
 *   place, a function returning one thunk per hoisted expression; the structured
 *   compiler calls a thunk when its walk reaches the expression, so an expression in a
 *   branch the compiler prunes (`if (false) …`) never runs, and one that throws is
 *   reported at its own position. The value — a number, a condition, an action — then
 *   stands where the expression stood. `&&`, `||`, `!`, assignments and `++` are never
 *   hoisted whole, so `bring(…) && !alarm` decomposes into a hoisted condition and a
 *   game switch.
 * - A `const` of the body whose initialiser is hoistable is a build-time constant: the
 *   emitted function declares it as written, so hoisted expressions can refer to it.
 *   Declarations run when the program's function does, before any thunk.
 *
 * `planProgram` works out the sets and numbers the hoisted expressions in one
 * traversal; `hoistedFunction` turns the plan into the arrow the transformer emits, and
 * the structured compiler walks the same body against the same plan.
 */
import type * as TS from "typescript";
import { DECLARATIONS_FILE } from "./declarations";
import { MODULE_NAME } from "./api";

export interface PlanError { node: TS.Node; message: string }

/** What the hoisted function does, in order; blocks keep `const` scoping as written. */
export type PlanItem =
  | { kind: "const"; decl: TS.VariableDeclaration }
  | { kind: "hoist"; index: number; expr: TS.Expression }
  | { kind: "block"; items: PlanItem[] };

export interface ProgramPlan {
  arrow: TS.ArrowFunction | TS.FunctionExpression;
  body: TS.Block;
  /** Hoisted expressions by index. */
  hoisted: TS.Expression[];
  index: Map<TS.Node, number>;
  /** Declarations that live in the game: let / var of the body, parameters and functions declared in it. */
  game: Set<TS.Node>;
  /** `const` declarations of the body evaluated at build time. */
  consts: Set<TS.VariableDeclaration>;
  tree: PlanItem[];
  errors: PlanError[];
}

/** The declaration an identifier refers to, through import aliases; undefined for globals TypeScript cannot place. */
export function declarationOf(ts: typeof TS, checker: TS.TypeChecker, id: TS.Identifier): TS.Declaration | undefined {
  let sym = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/** The library name an identifier is (`trigger`, `random`, …), or null when it is not one of the library's. */
export function libraryName(ts: typeof TS, checker: TS.TypeChecker, id: TS.Identifier): string | null {
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl || decl.getSourceFile().fileName !== DECLARATIONS_FILE) return null;
  return sym!.name;
}

/**
 * The library function a call is of (`trigger(…)`, or `ts.trigger(…)` through
 * `import * as ts from "trigscript"`), or null: the callee is an identifier or a property
 * whose symbol the checker places in the declarations.
 */
export function libraryCallName(ts: typeof TS, checker: TS.TypeChecker, call: TS.CallExpression): string | null {
  const callee = call.expression;
  const id = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name : null;
  return id ? libraryName(ts, checker, id) : null;
}

/** Climb from a binding element to the declaration that owns it. */
function owningDeclaration(ts: typeof TS, decl: TS.Declaration): TS.Node {
  let d: TS.Node = decl;
  while (ts.isBindingElement(d) || ts.isArrayBindingPattern(d) || ts.isObjectBindingPattern(d)) d = d.parent;
  return d;
}

/** The library calls that must not appear inside a program body: they would run at build time, silently. */
const FORBIDDEN_INSIDE = new Set(["trigger", "program", "hyperTriggers"]);

export function planProgram(ts: typeof TS, checker: TS.TypeChecker, arrow: TS.ArrowFunction | TS.FunctionExpression): ProgramPlan {
  const plan: ProgramPlan = { arrow, body: ts.isBlock(arrow.body) ? arrow.body : undefined as unknown as TS.Block, hoisted: [], index: new Map(), game: new Set(), consts: new Set(), tree: [], errors: [] };
  const error = (node: TS.Node, message: string) => plan.errors.push({ node, message });
  if (!ts.isBlock(arrow.body)) {
    error(arrow.body, "program() takes an arrow with a block body: program(() => { … }).");
    plan.body = ts.factory.createBlock([]);
    return plan;
  }
  if (arrow.parameters.length) error(arrow.parameters[0], "The program's arrow takes no parameters.");
  if (arrow.asteriskToken || arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) error(arrow, "The program cannot be async or a generator.");

  /* ── Bindings ── */
  const declare = (node: TS.Node) => plan.game.add(node);
  const isFunctionValue = (n: TS.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n) || ts.isClassDeclaration(n);
  const collect = (node: TS.Node) => {
    if (isFunctionValue(node)) return;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.Const)) for (const d of node.declarations) declare(d);
    if (ts.isFunctionDeclaration(node)) { declare(node); for (const p of node.parameters) declare(p); }
    ts.forEachChild(node, collect);
  };
  collect(arrow.body);

  /* ── Hoistability ── */
  const memo = new Map<TS.Node, boolean>();
  const isGameDecl = (decl: TS.Declaration) => plan.game.has(owningDeclaration(ts, decl));
  const hoistable = (e: TS.Node): boolean => {
    const hit = memo.get(e);
    if (hit !== undefined) return hit;
    let ok = true;
    // Inside a function value the syntax is the function's own business; only what it refers to matters.
    const scan = (n: TS.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(n)) { identifier(n, n.parent); return; }
      ts.forEachChild(n, scan);
    };
    const identifier = (n: TS.Identifier, p: TS.Node) => {
      // A property name is not a value reference — unless it is the library's, reached through a namespace import (`ts.random()`).
      const property = ts.isPropertyAccessExpression(p) && p.name === n;
      if ((ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || ts.isQualifiedName(p)) return;
      const lib = libraryName(ts, checker, n);
      if (lib === "random") { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p.parent) && p.parent.expression === p && property) { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p) && p.expression === n) { ok = false; return; }
      if (property) return;
      const decl = declarationOf(ts, checker, n);
      if (decl && isGameDecl(decl)) { ok = false; return; }
    };
    const check = (n: TS.Node): void => {
      if (!ok) return;
      if (isFunctionValue(n)) { scan(n); return; }
      if (ts.isIdentifier(n)) {
        // A property name (`obj.name`, `{ name: v }`) is not a value reference.
        identifier(n, n.parent);
        return;
      }
      if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || ts.isAwaitExpression(n) || ts.isYieldExpression(n)) { ok = false; return; }
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.CommaToken || (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment)) { ok = false; return; }
      }
      if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.ExclamationToken || n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) { ok = false; return; }
      if (ts.isPostfixUnaryExpression(n)) { ok = false; return; }
      ts.forEachChild(n, check);
    };
    check(e);
    memo.set(e, ok);
    return ok;
  };

  /* ── Numbering, and the tree the hoisted function follows ── */
  const hoist = (e: TS.Expression, items: PlanItem[]) => {
    const index = plan.hoisted.length;
    plan.hoisted.push(e);
    plan.index.set(e, index);
    items.push({ kind: "hoist", index, expr: e });
  };
  const value = (e: TS.Expression | undefined, items: PlanItem[]) => {
    if (!e) return;
    if (hoistable(e)) { hoist(e, items); return; }
    descend(e, items);
  };
  const descend = (e: TS.Node, items: PlanItem[]) => {
    if (isFunctionValue(e)) { error(e, "A function written inside program() cannot use the program's variables; declare it with function so it is inlined, or move it outside."); return; }
    if (ts.isIdentifier(e)) return;
    if (ts.isPropertyAccessExpression(e)) { value(e.expression, items); return; }
    if (ts.isElementAccessExpression(e)) { value(e.expression, items); value(e.argumentExpression, items); return; }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const lib = ts.isCallExpression(e) ? libraryCallName(ts, checker, e) : null;
      if (lib && FORBIDDEN_INSIDE.has(lib)) error(e, `${lib}() defines triggers of its own and cannot be used inside program(); inside, write conditions in an if and actions as statements.`);
      // `random()` is the game's: its callee is never a value, however it is spelt (`ts.random()` through a namespace import).
      if (lib !== "random") value(e.expression, items);
      for (const a of e.arguments ?? []) value(a, items);
      return;
    }
    if (ts.isBinaryExpression(e)) { value(e.left, items); value(e.right, items); return; }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) { value(e.operand, items); return; }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSpreadElement(e) || ts.isAwaitExpression(e) || ts.isTypeOfExpression(e) || ts.isVoidExpression(e) || ts.isDeleteExpression(e)) { value(e.expression, items); return; }
    if (ts.isConditionalExpression(e)) { value(e.condition, items); value(e.whenTrue, items); value(e.whenFalse, items); return; }
    if (ts.isTemplateExpression(e)) { for (const s of e.templateSpans) value(s.expression, items); return; }
    if (ts.isArrayLiteralExpression(e)) { for (const el of e.elements) value(el, items); return; }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p)) value(p.initializer, items);
        else if (ts.isShorthandPropertyAssignment(p)) value(p.name, items);
        else if (ts.isSpreadAssignment(p)) value(p.expression, items);
      }
      return;
    }
    ts.forEachChild(e, (c) => { if (ts.isExpression(c)) value(c, items); });
  };
  const statement = (s: TS.Statement, items: PlanItem[], deferred: PlanItem[]) => {
    if (ts.isVariableStatement(s)) { declarations(s.declarationList, items); return; }
    if (ts.isExpressionStatement(s)) { value(s.expression, items); return; }
    if (ts.isBlock(s)) { items.push({ kind: "block", items: block(s.statements) }); return; }
    if (ts.isIfStatement(s)) {
      value(s.expression, items);
      items.push({ kind: "block", items: block([s.thenStatement]) });
      if (s.elseStatement) items.push({ kind: "block", items: block([s.elseStatement]) });
      return;
    }
    if (ts.isWhileStatement(s)) { value(s.expression, items); items.push({ kind: "block", items: block([s.statement]) }); return; }
    if (ts.isDoStatement(s)) { items.push({ kind: "block", items: block([s.statement]) }); value(s.expression, items); return; }
    if (ts.isForStatement(s)) {
      const inner: PlanItem[] = [];
      if (s.initializer) { if (ts.isVariableDeclarationList(s.initializer)) declarations(s.initializer, inner); else value(s.initializer, inner); }
      value(s.condition, inner);
      inner.push({ kind: "block", items: block([s.statement]) });
      value(s.incrementor, inner);
      items.push({ kind: "block", items: inner });
      return;
    }
    if (ts.isFunctionDeclaration(s)) {
      // Declared functions hoist in JavaScript: their build-time parts run after the block's constants exist.
      if (s.body) deferred.push({ kind: "block", items: block(s.body.statements) });
      return;
    }
    if (ts.isReturnStatement(s)) { value(s.expression, items); return; }
    if (ts.isSwitchStatement(s)) { value(s.expression, items); for (const c of s.caseBlock.clauses) { if (ts.isCaseClause(c)) value(c.expression, items); items.push({ kind: "block", items: block(c.statements) }); } return; }
    if (ts.isForOfStatement(s) || ts.isForInStatement(s)) { value(s.expression, items); items.push({ kind: "block", items: block([s.statement]) }); return; }
    if (ts.isLabeledStatement(s)) { statement(s.statement, items, deferred); return; }
    if (ts.isThrowStatement(s)) { value(s.expression, items); return; }
    // break / continue / empty / types: nothing runs at build time.
  };
  const declarations = (list: TS.VariableDeclarationList, items: PlanItem[]) => {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const d of list.declarations) {
      if (isConst) {
        if (!d.initializer) { error(d, "A constant needs a value."); continue; }
        if (hoistable(d.initializer)) { plan.consts.add(d); items.push({ kind: "const", decl: d }); continue; }
        if (isFunctionValue(d.initializer)) { error(d, `${ts.isIdentifier(d.name) ? d.name.text : "This constant"} is a function that uses the program's variables; declare it with function so it is inlined at each call.`); continue; }
        // A const computed from the program's variables lives in the game like a let; the checker keeps it from being reassigned.
        plan.game.add(d);
        memo.clear();
        descend(d.initializer, items);
        continue;
      }
      value(d.initializer, items);
    }
  };
  const block = (statements: readonly TS.Statement[]): PlanItem[] => {
    const items: PlanItem[] = [];
    const deferred: PlanItem[] = [];
    for (const s of statements) statement(s, items, deferred);
    items.push(...deferred);
    return items;
  };
  plan.tree = block(arrow.body.statements);
  return plan;
}

/** The arrow the transformer emits in the program's place: build-time constants as written, hoisted expressions as thunks into `__h`. */
export function hoistedFunction(ts: typeof TS, plan: ProgramPlan): TS.ArrowFunction {
  const f = ts.factory;
  const h = f.createIdentifier("__h");
  const thunk = (expr: TS.Expression) => f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), f.createParenthesizedExpression(expr));
  const emit = (items: PlanItem[]): TS.Statement[] => items.map((item): TS.Statement => {
    switch (item.kind) {
      case "const": return f.createVariableStatement(undefined, f.createVariableDeclarationList([item.decl], ts.NodeFlags.Const));
      case "hoist": return f.createExpressionStatement(f.createAssignment(f.createElementAccessExpression(h, f.createNumericLiteral(item.index)), thunk(item.expr)));
      case "block": return f.createBlock(emit(item.items), true);
    }
  });
  const body = f.createBlock([
    f.createVariableStatement(undefined, f.createVariableDeclarationList([f.createVariableDeclaration(h, undefined, undefined, f.createArrayLiteralExpression([]))], ts.NodeFlags.Const)),
    ...emit(plan.tree),
    f.createReturnStatement(h),
  ], true);
  return f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body);
}

export interface TransformContext {
  /** Index of a source file among the script's files. */
  fileIndex: (sf: TS.SourceFile) => number;
  /** The plan for a program's arrow, made before the transform. */
  planFor: (arrow: TS.ArrowFunction | TS.FunctionExpression) => ProgramPlan | undefined;
}

/**
 * The emit transformer: `trigger(…)` calls get their position appended, and
 * `program(() => { … })` calls have the arrow replaced by a descriptor — where the body
 * is and the function that computes its hoisted values — so the run can hand both to
 * the structured compiler.
 */
export function transformer(ts: typeof TS, checker: TS.TypeChecker, ctx: TransformContext): TS.TransformerFactory<TS.SourceFile> {
  return (context) => (sf) => {
    const f = ts.factory;
    const at = (node: TS.Node) => f.createArrayLiteralExpression([f.createNumericLiteral(ctx.fileIndex(sf)), f.createNumericLiteral(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)]);
    const pad = (args: readonly TS.Expression[], upTo: number) => {
      const out = [...args];
      while (out.length < upTo) out.push(f.createIdentifier("undefined"));
      return out;
    };
    const visit = (node: TS.Node): TS.Node => {
      if (ts.isCallExpression(node)) {
        const lib = libraryCallName(ts, checker, node);
        if (lib === "trigger" && node.arguments.length >= 3 && node.arguments.length <= 4) {
          const args = pad(node.arguments.map((a) => ts.visitNode(a, visit) as TS.Expression), 4);
          return f.updateCallExpression(node, node.expression, node.typeArguments, [...args, at(node)]);
        }
        if (lib === "program" && node.arguments.length >= 1 && node.arguments.length <= 2) {
          const arrow = node.arguments[0];
          const plan = ts.isArrowFunction(arrow) || ts.isFunctionExpression(arrow) ? ctx.planFor(arrow) : undefined;
          if (plan) {
            const descriptor = f.createObjectLiteralExpression([
              f.createPropertyAssignment("__trigscript", f.createStringLiteral("program")),
              f.createPropertyAssignment("at", at(node)),
              f.createPropertyAssignment("pos", f.createNumericLiteral(arrow.getStart(sf))),
              f.createPropertyAssignment("hoisted", hoistedFunction(ts, plan)),
            ], true);
            const rest = pad(node.arguments.slice(1).map((a) => ts.visitNode(a, visit) as TS.Expression), 1);
            return f.updateCallExpression(node, node.expression, node.typeArguments, [descriptor, ...rest, at(node)]);
          }
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sf, visit) as TS.SourceFile;
  };
}

export { MODULE_NAME };
