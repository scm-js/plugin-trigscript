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
 * - A `const` of the body whose initialiser is hoistable is a build-time constant. It is
 *   emitted as a memoised thunk too (`__c[i]`), and every reference to it in a hoisted
 *   expression or another constant's initialiser becomes a call, so a constant is
 *   computed the first time something needs it — or when the walk reaches its
 *   declaration — and one inside a pruned branch never is.
 *
 * `planProgram` works out the sets and numbers the hoisted expressions in one
 * traversal, for a `program()` body and for the arrow of a `game()` function alike
 * (whose parameters are game bindings); `hoistedFunction` turns the plan into the arrow
 * the transformer emits, and the structured compiler walks the same body against the
 * same plan.
 */
import type * as TS from "typescript";
import { DECLARATIONS_FILE } from "./declarations";
import { MODULE_NAME } from "./api";
import { INPUT_CALL_NAMES, READ_ARITY, READER_NAMES, UNIT_CALL_NAMES } from "./runtime";

export interface PlanError { node: TS.Node; message: string }

/** What the hoisted function does, in order; blocks keep `const` scoping as written. */
export type PlanItem =
  | { kind: "const"; decl: TS.VariableDeclaration }
  | { kind: "hoist"; index: number; expr: TS.Expression }
  | { kind: "block"; items: PlanItem[] };

export interface ProgramPlan {
  arrow: TS.ArrowFunction | TS.FunctionExpression;
  body: TS.Block;
  /** A `game()` function with an expression body (`game((a: number) => a + 1)`): what it returns. */
  expression?: TS.Expression;
  /** Hoisted expressions by index. */
  hoisted: TS.Expression[];
  index: Map<TS.Node, number>;
  /** Declarations that live in the game: let / var of the body, parameters and functions declared in it. */
  game: Set<TS.Node>;
  /** `const` declarations of the body evaluated at build time, by their index among the plan's constants. */
  consts: Map<TS.VariableDeclaration, number>;
  /** The same constants, by index. */
  constList: TS.VariableDeclaration[];
  tree: PlanItem[];
  errors: PlanError[];
  /** The array declarations something pushes to, pops from or sets the length of: arrays that grow. */
  grows: Set<TS.Node>;
}

export interface PlanOptions {
  /** The arrow is a `game()` function: its parameters are game bindings, and an expression body is allowed. */
  parameters?: boolean;
}

/** Whether a call is of a `game()` function — its callee's type carries the brand — so it is never a build-time value. */
export function isGameCall(checker: TS.TypeChecker, call: TS.CallExpression): boolean {
  return !!checker.getPropertyOfType(checker.getTypeAtLocation(call.expression), "__game");
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
const FORBIDDEN_INSIDE = new Set(["trigger", "program", "hyperTriggers", "game"]);
/** The library calls the game answers: never hoisted, the structured compiler lowers them. */
const GAME_CALLS = new Set(["random", "sleep", "rose", "once", "shared"]);
/**
 * Calls that read the game — `minerals(P1)`, and a comparing condition without its comparison
 * (`deaths(P1, unit)`) — or show text a program fills in (`print`). The call is never a
 * build-time value, though its callee and its arguments are: `minerals(P1) * 2` is the program's
 * arithmetic, not the script's. The same goes for the units of the game (`unitsAt(…)`, `first(…)`)
 * and the game's tables (`stats(…)`): `const u = nearest(…)` is a variable of the program. And
 * for what the players do (`keyPressed(…)`, `chatted(…)`): `const m = chatted(…)` is the program's.
 */
const READ_CALLS = new Set<string>([...READER_NAMES, ...UNIT_CALL_NAMES, ...INPUT_CALL_NAMES, "print"]);
const isReadCall = (lib: string | null, args: number) => !!lib && (READ_CALLS.has(lib) || READ_ARITY.get(lib) === args);
/**
 * The methods that take a function — `xs.map((x) => x * 2)`, `unitsOf(P1).forEach((u) => u.kill())`. Where such a call
 * is the program's, the function written in it is part of the program as a function declared in the body is: its
 * parameters are game bindings and its body is walked, since it is inlined into the loop the method becomes.
 */
export const CALLBACK_METHODS = new Set(["forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "reduce", "map", "filter", "sort"]);

/** The function written as an argument of one of those methods, when `node` is one. */
export function isCallbackArgument(ts: typeof TS, node: TS.Node): node is TS.ArrowFunction | TS.FunctionExpression {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let at: TS.Node = node;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const call = at.parent;
  return ts.isCallExpression(call) && call.arguments.includes(at as TS.Expression) && ts.isPropertyAccessExpression(call.expression) && CALLBACK_METHODS.has(call.expression.name.text);
}

export function planProgram(ts: typeof TS, checker: TS.TypeChecker, arrow: TS.ArrowFunction | TS.FunctionExpression, options: PlanOptions = {}): ProgramPlan {
  // A list a callback writes to (`xs.forEach((x) => out.push(x))`) is the program's, and that is found out after its
  // `const` was planned as a value of the script: the plan is made again knowing it. The set only grows, so this ends.
  const forced = new Set<TS.Node>();
  for (;;) {
    const before = forced.size;
    const plan = planOnce(ts, checker, arrow, options, forced);
    if (forced.size === before) return plan;
  }
}

function planOnce(ts: typeof TS, checker: TS.TypeChecker, arrow: TS.ArrowFunction | TS.FunctionExpression, options: PlanOptions, forced: Set<TS.Node>): ProgramPlan {
  const plan: ProgramPlan = { arrow, body: ts.isBlock(arrow.body) ? arrow.body : undefined as unknown as TS.Block, hoisted: [], index: new Map(), game: new Set(), consts: new Map(), constList: [], tree: [], errors: [], grows: new Set() };
  const error = (node: TS.Node, message: string) => plan.errors.push({ node, message });
  const what = options.parameters ? "game()" : "program()";
  if (!ts.isBlock(arrow.body)) {
    if (!options.parameters) {
      error(arrow.body, "program() takes an arrow with a block body: program(() => { … }).");
      plan.body = ts.factory.createBlock([]);
      return plan;
    }
    plan.expression = arrow.body;
    plan.body = ts.factory.createBlock([]);
  }
  if (arrow.parameters.length && !options.parameters) error(arrow.parameters[0], "The program's arrow takes no parameters.");
  if (arrow.asteriskToken || arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) error(arrow, `A ${what} body cannot be async or a generator.`);

  /* ── Bindings ── */
  const declare = (node: TS.Node) => plan.game.add(node);
  for (const p of arrow.parameters) {
    if (!options.parameters) break;
    if (!ts.isIdentifier(p.name)) error(p, "Destructured parameters are not supported in a game function.");
    else if (p.dotDotDotToken) error(p, "Rest parameters are not supported in a game function.");
    else declare(p);
  }
  // A class *declared* in the body is the program's, as a function declared there is (see `classItems`); one written as a value is not.
  const isFunctionValue = (n: TS.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n);
  const collect = (node: TS.Node) => {
    if (isFunctionValue(node)) return;
    // `class Squad { … }`: `new Squad()` is an instance of the program's, so the name is never a value of the script; what its
    // constructor, methods and accessors take are the game's, as a declared function's parameters are.
    if (ts.isClassDeclaration(node)) {
      declare(node);
      for (const m of node.members) if (ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m) || ts.isAccessor(m)) for (const p of m.parameters) declare(p);
    }
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.Const)) for (const d of node.declarations) declare(d);
    // The variable of a for…of is bound per iteration when the loop is unrolled, like a parameter bound to a value.
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) declare(d);
    if (ts.isFunctionDeclaration(node)) { declare(node); for (const p of node.parameters) declare(p); }
    // A Map, a Set or a Record keyed by ids of the game, made inside the body, is the program's: it is there to be written
    // while the map is played. One made outside the body is the script's, and a program only looks things up in it.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let init: TS.Expression = node.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && (init.expression.text === "Map" || init.expression.text === "Set")) declare(node);
      else if (ts.isObjectLiteralExpression(init) && checker.getIndexInfosOfType(checker.getTypeAtLocation(node.name)).length > 0) declare(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(arrow.body);
  // A `const` list the body stores into — `const hp = [0, 0, 0]; hp[i] = 5`, which TypeScript allows — is an array of the
  // program like a `let` one; a list that is only read stays a value of the script, which a program may still look up in.
  const ARRAY_WRITERS = new Set(["push", "pop", "fill"]);
  const written = (node: TS.Node) => {
    if (isFunctionValue(node)) return;
    let target: TS.Expression | undefined;
    // `[xs[0], xs[1]] = [xs[1], xs[0]]`: each place in the pattern is a store of its own.
    const left = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.left : undefined;
    if (left && (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left))) {
      const places = (e: TS.Node): void => {
        if (ts.isArrayLiteralExpression(e)) e.elements.forEach(places);
        else if (ts.isObjectLiteralExpression(e)) e.properties.forEach((p) => { if (ts.isPropertyAssignment(p)) places(p.initializer); });
        else if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) store(e);
      };
      places(left);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target = node.operand;
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ARRAY_WRITERS.has(node.expression.name.text)) target = node.expression;
    while (target && (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target))) target = target.expression;
    store(target);
    ts.forEachChild(node, written);
  };
  const store = (target: TS.Expression | undefined) => {
    // `grid[y][x] = v`, `waves[i].count++`: a store however deep is a store into the list at the root of it.
    let root: TS.Expression | undefined = target && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) ? target.expression : undefined;
    const direct = !!root && ts.isIdentifier(root);
    while (root && (ts.isElementAccessExpression(root) || ts.isPropertyAccessExpression(root) || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root))) root = root.expression;
    if (target && root && ts.isIdentifier(root) && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))) {
      const decl = declarationOf(ts, checker, root);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && inside(decl)) {
        const type = checker.getTypeAtLocation(decl.name);
        if (checker.isArrayType(type) || checker.isTupleType(type)) {
          if (plan.consts.has(decl)) forced.add(decl);
          declare(decl);
          // xs.push(v), xs.pop(), xs.length = n and xs[xs.length] = v are what make an array one that grows.
          if (!direct) return;
          const name = root.text;
          const member = ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
          const atLength = ts.isElementAccessExpression(target) && ts.isPropertyAccessExpression(target.argumentExpression) && target.argumentExpression.name.text === "length"
            && ts.isIdentifier(target.argumentExpression.expression) && target.argumentExpression.expression.text === name;
          if (member === "push" || member === "pop" || member === "length" || atLength) plan.grows.add(decl);
        }
      }
    }
  };
  const inside = (decl: TS.Node) => { for (let n: TS.Node | undefined = decl; n; n = n.parent) if (n === arrow.body) return true; return false; };
  written(arrow.body);
  for (const decl of forced) declare(decl);

  /* ── Hoistability ── */
  const gameCall = new Map<TS.Node, boolean>();
  const isGame = (call: TS.CallExpression) => {
    let hit = gameCall.get(call);
    if (hit === undefined) { hit = isGameCall(checker, call); gameCall.set(call, hit); }
    return hit;
  };
  /** Whether the function given to `forEach` calls the library: an action, a print, anything that is the game's to do. */
  const doesSomething = (fn: TS.ArrowFunction | TS.FunctionExpression): boolean => {
    let at: TS.Node = fn;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const call = at.parent as TS.CallExpression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "forEach") return false;
    let found = false;
    const look = (n: TS.Node) => { if (found) return; if (ts.isCallExpression(n) && libraryCallName(ts, checker, n)) { found = true; return; } ts.forEachChild(n, look); };
    look(fn.body);
    return found;
  };
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
      if (lib && GAME_CALLS.has(lib)) { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p.parent) && p.parent.expression === p && property) { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p) && p.expression === n) { ok = false; return; }
      if (property) return;
      const decl = declarationOf(ts, checker, n);
      if (decl && isGameDecl(decl)) { ok = false; return; }
    };
    const check = (n: TS.Node): void => {
      if (!ok) return;
      // `waves.forEach((w) => createUnit(P2, w.unit, w.count, at))`: nothing of the program is named, but forEach is there for
      // what its function does, and what this one does is the game's. Run when the script is built it would make actions
      // nobody receives, and the line would silently do nothing; it is the program's loop, unrolled.
      if (isCallbackArgument(ts, n) && doesSomething(n)) { ok = false; return; }
      if (isFunctionValue(n)) { scan(n); return; }
      if (ts.isIdentifier(n)) {
        // A property name (`obj.name`, `{ name: v }`) is not a value reference.
        identifier(n, n.parent);
        return;
      }
      if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || ts.isAwaitExpression(n) || ts.isYieldExpression(n)) { ok = false; return; }
      // A call of a game() function runs in the game, whatever its arguments are.
      if (ts.isCallExpression(n) && isGame(n)) { ok = false; return; }
      if (ts.isCallExpression(n) && isReadCall(libraryCallName(ts, checker, n), n.arguments.length)) { ok = false; return; }
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
    // `...base` is not an expression on its own: what it spreads is.
    if (ts.isSpreadElement(e)) { value(e.expression, items); return; }
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
      // `random()`, `sleep()`, … are the game's: their callee is never a value, however it is spelt (`ts.random()` through a namespace import).
      // Of a method call the object is the value, not the method: `cost.get(u.type)` has to leave `cost` — the Map — in reach, and a
      // method read off its object on its own has lost it.
      if (!lib || !GAME_CALLS.has(lib)) value(ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) ? e.expression.expression : e.expression, items);
      for (const a of e.arguments ?? []) {
        let fn: TS.Expression = a;
        while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
        if (isCallbackArgument(ts, fn)) callback(fn, items); else value(a, items);
      }
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
  // The function given to an array method of the program: its parameters and its `let`s are the game's from here on (nothing
  // outside it can name them, so nothing planned so far is wrong), and its body is planned as a declared function's is.
  const callback = (fn: TS.ArrowFunction | TS.FunctionExpression, items: PlanItem[]) => {
    for (const p of fn.parameters) declare(p);
    collect(fn.body);
    written(fn.body);
    memo.clear();
    if (ts.isBlock(fn.body)) { items.push({ kind: "block", items: block(fn.body.statements) }); return; }
    const inner: PlanItem[] = [];
    value(fn.body, inner);
    items.push({ kind: "block", items: inner });
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
    if (ts.isClassDeclaration(s)) { deferred.push({ kind: "block", items: classItems(s) }); return; }
    if (ts.isReturnStatement(s)) { value(s.expression, items); return; }
    if (ts.isSwitchStatement(s)) { value(s.expression, items); for (const c of s.caseBlock.clauses) { if (ts.isCaseClause(c)) value(c.expression, items); items.push({ kind: "block", items: block(c.statements) }); } return; }
    if (ts.isForOfStatement(s) || ts.isForInStatement(s)) { value(s.expression, items); items.push({ kind: "block", items: block([s.statement]) }); return; }
    if (ts.isLabeledStatement(s)) { statement(s.statement, items, deferred); return; }
    if (ts.isThrowStatement(s)) { value(s.expression, items); return; }
    // break / continue / empty / types: nothing runs at build time.
  };
  // What a class of the body computes when the script is built: inside a field's first value, and inside each body, as a declared function's.
  const classItems = (c: TS.ClassDeclaration): PlanItem[] => {
    const items: PlanItem[] = [];
    for (const m of c.members) {
      if (ts.isPropertyDeclaration(m)) value(m.initializer, items);
      else if ((ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m) || ts.isAccessor(m)) && m.body) items.push({ kind: "block", items: block(m.body.statements) });
    }
    return items;
  };
  const declarations = (list: TS.VariableDeclarationList, items: PlanItem[]) => {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const d of list.declarations) {
      if (isConst && plan.game.has(d)) { value(d.initializer, items); continue; }
      if (isConst) {
        if (!d.initializer) { error(d, "A constant needs a value."); continue; }
        if (hoistable(d.initializer)) { plan.consts.set(d, plan.constList.length); plan.constList.push(d); items.push({ kind: "const", decl: d }); continue; }
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
  if (plan.expression) { const items: PlanItem[] = []; value(plan.expression, items); plan.tree = items; return plan; }
  plan.tree = block(plan.body.statements);
  return plan;
}

/** What a descriptor's `hoisted()` returns: a thunk per hoisted expression, and a memoised thunk per build-time constant. */
export interface HoistedThunks { h: (() => unknown)[]; c: (() => unknown)[] }

/**
 * The arrow the transformer emits in the program's place: hoisted expressions as thunks
 * into `__h`, build-time constants as memoised thunks into `__c` (a reference to a
 * constant becomes `__c[i]()`, so nothing runs before something needs it), returned
 * together. A constant that throws marks the error with its index, so the compiler can
 * report it at the declaration.
 */
export function hoistedFunction(ts: typeof TS, checker: TS.TypeChecker, plan: ProgramPlan, context: TS.TransformationContext): TS.ArrowFunction {
  const f = ts.factory;
  const h = f.createIdentifier("__h");
  const c = f.createIdentifier("__c");
  const m = f.createIdentifier("__m");
  const arrow = (params: string[], body: TS.ConciseBody) => f.createArrowFunction(undefined, undefined, params.map((p) => f.createParameterDeclaration(undefined, undefined, p)), undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body);
  // Every reference to a build-time constant of the body becomes a call of its thunk.
  // A constant's value: its thunk called — and, for a name taken out of a pattern (`const { n, d } = waves[0]`), that name of
  // what the thunk gives, which for a pattern is an object of every name it binds.
  const constant = (id: TS.Identifier): TS.Expression | undefined => {
    const decl = declarationOf(ts, checker, id);
    if (!decl) return undefined;
    const owner = owningDeclaration(ts, decl);
    const i = ts.isVariableDeclaration(owner) ? plan.consts.get(owner) : undefined;
    if (i === undefined) return undefined;
    const call = f.createCallExpression(f.createElementAccessExpression(c, f.createNumericLiteral(i)), undefined, []);
    return ts.isBindingElement(decl) && ts.isIdentifier(decl.name) ? f.createPropertyAccessExpression(call, decl.name.text) : call;
  };
  const rewrite = (node: TS.Node): TS.Node => {
    if (ts.isTypeNode(node)) return node;
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) return constant(node) ?? node;
    if (ts.isShorthandPropertyAssignment(node)) {
      const value = constant(node.name);
      return value ? f.createPropertyAssignment(node.name, value) : node;
    }
    return ts.visitEachChild(node, rewrite, context);
  };
  const expr = (e: TS.Expression) => f.createParenthesizedExpression(ts.visitNode(e, rewrite) as TS.Expression);
  const thunk = (e: TS.Expression) => arrow([], expr(e));
  // `const { n, d: delay = 1, ...more } = waves[0]`: the pattern runs as JavaScript runs it, and what it bound comes back by name.
  const names = (pattern: TS.BindingName, into: string[] = []): string[] => {
    if (ts.isIdentifier(pattern)) into.push(pattern.text);
    else for (const el of pattern.elements) if (ts.isBindingElement(el)) names(el.name, into);
    return into;
  };
  // The names a pattern binds stay names; what it computes — a default, a computed key — may name other constants.
  const patternOf = (pattern: TS.BindingName): TS.BindingName => {
    if (ts.isIdentifier(pattern)) return pattern;
    const element = (el: TS.ArrayBindingElement): TS.ArrayBindingElement => ts.isBindingElement(el)
      ? f.updateBindingElement(el, el.dotDotDotToken, el.propertyName && ts.isComputedPropertyName(el.propertyName) ? (ts.visitNode(el.propertyName, rewrite) as TS.PropertyName) : el.propertyName, patternOf(el.name), el.initializer ? (ts.visitNode(el.initializer, rewrite) as TS.Expression) : undefined)
      : el;
    return ts.isObjectBindingPattern(pattern) ? f.updateObjectBindingPattern(pattern, pattern.elements.map((el) => element(el) as TS.BindingElement)) : f.updateArrayBindingPattern(pattern, pattern.elements.map(element));
  };
  const patternThunk = (decl: TS.VariableDeclaration) => arrow([], f.createBlock([
    f.createVariableStatement(undefined, f.createVariableDeclarationList([f.createVariableDeclaration(patternOf(decl.name), undefined, undefined, expr(decl.initializer!))], ts.NodeFlags.Const)),
    f.createReturnStatement(f.createObjectLiteralExpression(names(decl.name).map((n) => f.createShorthandPropertyAssignment(n)))),
  ], true));
  const emit = (items: PlanItem[]): TS.Statement[] => items.map((item): TS.Statement => {
    switch (item.kind) {
      case "const": {
        const i = plan.consts.get(item.decl)!;
        return f.createExpressionStatement(f.createAssignment(f.createElementAccessExpression(c, f.createNumericLiteral(i)), f.createCallExpression(m, undefined, [f.createNumericLiteral(i), ts.isIdentifier(item.decl.name) ? thunk(item.decl.initializer!) : patternThunk(item.decl)])));
      }
      case "hoist": return f.createExpressionStatement(f.createAssignment(f.createElementAccessExpression(h, f.createNumericLiteral(item.index)), thunk(item.expr)));
      case "block": return f.createBlock(emit(item.items), true);
    }
  });
  // const __m = (i, g) => { let d = false, v; return () => { if (d) return v; try { v = g(); } catch (e) { if (e instanceof Object && e.__trigscriptConst === undefined) e.__trigscriptConst = i; throw e; } d = true; return v; }; };
  const d = f.createIdentifier("d");
  const v = f.createIdentifier("v");
  const e = f.createIdentifier("e");
  const g = f.createIdentifier("g");
  const i = f.createIdentifier("i");
  const mark = f.createPropertyAccessExpression(e, "__trigscriptConst");
  const rethrow = f.createCatchClause(f.createVariableDeclaration(e), f.createBlock([
    f.createIfStatement(
      f.createLogicalAnd(f.createBinaryExpression(e, ts.SyntaxKind.InstanceOfKeyword, f.createIdentifier("Object")), f.createStrictEquality(mark, f.createIdentifier("undefined"))),
      f.createExpressionStatement(f.createAssignment(mark, i)),
    ),
    f.createThrowStatement(e),
  ]));
  const getter = arrow([], f.createBlock([
    f.createIfStatement(d, f.createReturnStatement(v)),
    f.createTryStatement(f.createBlock([f.createExpressionStatement(f.createAssignment(v, f.createCallExpression(g, undefined, [])))]), rethrow, undefined),
    f.createExpressionStatement(f.createAssignment(d, f.createTrue())),
    f.createReturnStatement(v),
  ], true));
  const memo = arrow(["i", "g"], f.createBlock([
    f.createVariableStatement(undefined, f.createVariableDeclarationList([f.createVariableDeclaration(d, undefined, undefined, f.createFalse()), f.createVariableDeclaration(v)], ts.NodeFlags.Let)),
    f.createReturnStatement(getter),
  ], true));
  const body = f.createBlock([
    f.createVariableStatement(undefined, f.createVariableDeclarationList([
      f.createVariableDeclaration(h, undefined, undefined, f.createArrayLiteralExpression([])),
      f.createVariableDeclaration(c, undefined, undefined, f.createArrayLiteralExpression([])),
      f.createVariableDeclaration(m, undefined, undefined, memo),
    ], ts.NodeFlags.Const)),
    ...emit(plan.tree),
    f.createReturnStatement(f.createObjectLiteralExpression([f.createPropertyAssignment("h", h), f.createPropertyAssignment("c", c)])),
  ], true);
  return arrow([], body);
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
        if ((lib === "program" && node.arguments.length >= 1 && node.arguments.length <= 2) || (lib === "game" && node.arguments.length === 1)) {
          const arrow = node.arguments[0];
          const plan = ts.isArrowFunction(arrow) || ts.isFunctionExpression(arrow) ? ctx.planFor(arrow) : undefined;
          if (plan) {
            const descriptor = f.createObjectLiteralExpression([
              f.createPropertyAssignment("__trigscript", f.createStringLiteral("program")),
              f.createPropertyAssignment("at", at(node)),
              f.createPropertyAssignment("pos", f.createNumericLiteral(arrow.getStart(sf))),
              f.createPropertyAssignment("hoisted", hoistedFunction(ts, checker, plan, context)),
            ], true);
            const rest = lib === "program" ? pad(node.arguments.slice(1).map((a) => ts.visitNode(a, visit) as TS.Expression), 1) : [];
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
