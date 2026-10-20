/**
 * What inside `program(() => { … })` runs when the script is built, and what runs in
 * the game. The body is real TypeScript, but its `let` variables live in the game's
 * memory and its `if`s are trigger conditions, so it cannot simply run. Instead:
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
  | { kind: "block"; items: PlanItem[] }
  /** A declaration the build-time parts after it name, made where it stands: an `enum` of the body. */
  | { kind: "statement"; node: TS.Statement };

export interface ProgramPlan {
  /** The program's or the game function's arrow; unset for a class's plan (`planClass`). */
  arrow?: TS.ArrowFunction | TS.FunctionExpression;
  /** What the plan covers: the arrow's body, or the class. */
  root: TS.Node;
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
  // A function with overloads: the declaration with the body is the one that runs.
  if (sym && sym.flags & ts.SymbolFlags.Function && (sym.declarations?.length ?? 0) > 1) {
    const body = sym.declarations!.find((d) => ts.isFunctionDeclaration(d) && !!d.body);
    if (body) return body;
  }
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

/** Whether a call is one of `on`'s — `on.died(…)` — with `on` the library's own object. */
export function isOnCall(ts: typeof TS, checker: TS.TypeChecker, call: TS.CallExpression): boolean {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && libraryName(ts, checker, callee.expression) === "on";
}

/** Climb from a binding element to the declaration that owns it. */
function owningDeclaration(ts: typeof TS, decl: TS.Declaration): TS.Node {
  let d: TS.Node = decl;
  while (ts.isBindingElement(d) || ts.isArrayBindingPattern(d) || ts.isObjectBindingPattern(d)) d = d.parent;
  return d;
}

/** What `on.…` listens for (TrigScript 4, B2): `on.created(filter, handler)` and the rest. */
export const ON_EVENTS = ["created", "died", "killed", "order", "morphed", "chat", "key"] as const;

/** The library calls that must not appear inside a program body: they would run at build time, silently. */
const FORBIDDEN_INSIDE = new Set(["trigger", "program", "hyperTriggers", "game"]);
/**
 * JavaScript's clock and dice: `Date.now()`, `new Date()`, `Math.random()`, `performance.now()`. Worked out when the script
 * is built they would be the computer's time and one number, the same in every game; inside a program they are refused,
 * with the game's own in their place. At the top of a file they are the build's, as everything there is.
 */
export function clockCall(ts: typeof TS, checker: TS.TypeChecker, n: TS.Node): string | null {
  const isLib = (id: TS.Expression) => {
    const sf = checker.getSymbolAtLocation(id)?.declarations?.[0]?.getSourceFile();
    return !!sf && (sf.hasNoDefaultLib || /(^|\/)lib(\.[^/]*)?\.d\.ts$/.test(sf.fileName));
  };
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && !n.arguments?.length && isLib(n.expression)) return "new Date()";
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !ts.isIdentifier(n.expression.expression)) return null;
  const name = `${n.expression.expression.text}.${n.expression.name.text}`;
  return ["Date.now", "Math.random", "performance.now"].includes(name) && isLib(n.expression.expression) ? `${name}()` : null;
}

/** What a program has in place of one of JavaScript's clock and dice. */
export function clockMessage(call: string): string {
  return call === "Math.random()"
    ? "Math.random() would be drawn once, when the map is built, and be the same number in every game. In a program use random(n), a whole number from 0 to n − 1 the game picks, or random() for a coin toss."
    : `${call} is the time on the computer that builds the map, not the game's. In a program use elapsed(), game seconds since the start, or memory.game.frame, frames.`;
}

/** The library calls the game answers: never hoisted, the structured compiler lowers them. */
const GAME_CALLS = new Set(["random", "sleep", "nextFrame", "until", "sync", "select", "start", "rose", "once", "shared", "lines", "centerLocation", ...ON_EVENTS]);
const EVENT_NAMES: ReadonlySet<string> = new Set(ON_EVENTS);
/**
 * Whether a library name is one of `GAME_CALLS`. An event's name is the game's as `on.order(…)` or a unit's
 * `u.order(…)`, not as the action of the same name, `order(…)`, a function of the library's own whose arguments the
 * script works out as any action's.
 */
function answeredByGame(ts: typeof TS, checker: TS.TypeChecker, id: TS.Identifier, lib: string): boolean {
  if (!GAME_CALLS.has(lib)) return false;
  if (!EVENT_NAMES.has(lib)) return true;
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  return !(decl && ts.isFunctionDeclaration(decl));
}
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
/** The library objects whose fields are cells of the game (`memory.vision.countdown`): a field is a value, but nothing around it is the script's. */
const GAME_CELL_ROOTS = new Set(["memory", "local"]);
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

/**
 * A function that is part of what a program waits for: the one `until(…)` asks every frame, the one given to `.then(…)`,
 * an async arrow called where it is written — `(async () => { … })()` in a `Promise.all` — and the one start(…) runs as a task. Like a callback, its body
 * is the program's and is walked, not run when the script is built.
 */
export function isTaskFunction(ts: typeof TS, checker: TS.TypeChecker, node: TS.Node): node is TS.ArrowFunction | TS.FunctionExpression {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let at: TS.Node = node;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const call = at.parent;
  if (!ts.isCallExpression(call)) return false;
  if (call.expression === at) return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!call.arguments.includes(at as TS.Expression)) return false;
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "then") return true;
  const lib = libraryCallName(ts, checker, call);
  if (lib && (ON_EVENTS as readonly string[]).includes(lib) && isOnCall(ts, checker, call)) return call.arguments.includes(at as TS.Expression);
  return lib === "until" || (lib === "start" && call.arguments[0] === at) || (lib === "lines" && call.arguments[1] === at);
}

/** Whether a node is JSX or has JSX inside it: a text the program puts together, never one worked out when the script is built. */
export function hasJsx(ts: typeof TS, node: TS.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return !!ts.forEachChild(node, (c) => hasJsx(ts, c) || undefined);
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

/**
 * A class declared at the top of a script's file, planned as a game function is: it is ordinary JavaScript when the script
 * is built, and the program's own wherever a program makes an instance of it — its parameters and its variables the
 * game's, what its fields' first values and its bodies compute when the script is built hoisted. Its errors are reported
 * only where a program uses it.
 */
export function planClass(ts: typeof TS, checker: TS.TypeChecker, cls: TS.ClassDeclaration): ProgramPlan {
  const forced = new Set<TS.Node>();
  for (;;) {
    const before = forced.size;
    const plan = planOnce(ts, checker, cls, { parameters: true }, forced);
    if (forced.size === before) return plan;
  }
}

/**
 * `on.died(…)` written as a statement at the top of a script's file (TrigScript 4, B2): it listens from the start of the
 * game, as a program of its own whose body is that one statement.
 */
export function isTopListener(ts: typeof TS, checker: TS.TypeChecker, node: TS.Node): node is TS.ExpressionStatement {
  return ts.isExpressionStatement(node) && ts.isSourceFile(node.parent) && !node.parent.isDeclarationFile && ts.isCallExpression(node.expression) && isOnCall(ts, checker, node.expression);
}

/** The plan for a listener at the top of a file (`isTopListener`), made as a program's is. */
export function planListener(ts: typeof TS, checker: TS.TypeChecker, stmt: TS.ExpressionStatement): ProgramPlan {
  const forced = new Set<TS.Node>();
  for (;;) {
    const before = forced.size;
    const plan = planOnce(ts, checker, stmt, {}, forced);
    if (forced.size === before) return plan;
  }
}

/**
 * Whether a function is one of the script's own, declared at the top of one of its files (TrigScript 4): a program may
 * call it with its own values, as it calls a `game()` function, and use it as a JSX component. Called with values the
 * script knows, it still runs when the script is built.
 */
/**
 * Whether a statement is at the top of one of the script's files: in the file itself, or in a `namespace` there (as deep
 * as namespaces go), which is the file's too, under a name.
 */
export function atTop(ts: typeof TS, node: TS.Node): boolean {
  let p = node.parent;
  while (p && ts.isModuleBlock(p)) {
    let ns: TS.Node = p.parent;
    if ((ns as TS.ModuleDeclaration).modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
    // `namespace A.B { … }` is B inside A.
    while (ns.parent && ts.isModuleDeclaration(ns.parent)) ns = ns.parent;
    p = ns.parent;
  }
  return !!p && ts.isSourceFile(p) && !p.isDeclarationFile;
}

export function isScriptFunction(ts: typeof TS, decl: TS.Node): decl is TS.FunctionDeclaration {
  // A generator and an async function too (TrigScript 4): a library's `walkTo(u, at)` waits, `waves()` yields.
  return ts.isFunctionDeclaration(decl) && !!decl.name && !!decl.body && atTop(ts, decl) && !decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}

/** `const Title = (props: …) => <line>…</line>` at the top of a file: the arrow, a function of the script's own as a declared one is. */
export function scriptArrow(ts: typeof TS, decl: TS.Node): TS.ArrowFunction | TS.FunctionExpression | undefined {
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  const stmt = list.parent;
  if (!ts.isVariableStatement(stmt) || !atTop(ts, stmt)) return undefined;
  let init = decl.initializer;
  while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
  if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return undefined;
  if (init.asteriskToken) return undefined;
  return init;
}

/** The plan of a function at the top of a file (`isScriptFunction`, `scriptArrow`), made as a `game()` function's is. */
export function planFunction(ts: typeof TS, checker: TS.TypeChecker, fn: TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression): ProgramPlan {
  return planProgram(ts, checker, fn as unknown as TS.FunctionExpression, { parameters: true });
}

const usesGameMemo = new WeakMap<TS.Node, boolean>();

/**
 * Whether a function of the script's own does what only the game can — draws a random number, reads the game, waits,
 * prints — itself or through another of the script's functions: called with values the script knows, it still runs in
 * the game, never when the script is built.
 */
export function usesGame(ts: typeof TS, checker: TS.TypeChecker, fn: TS.Node, seen = new Set<TS.Node>()): boolean {
  const hit = usesGameMemo.get(fn);
  if (hit !== undefined) return hit;
  if (seen.has(fn)) return false;
  seen.add(fn);
  let found = false;
  const look = (n: TS.Node): void => {
    if (found) return;
    if (clockCall(ts, checker, n)) { found = true; return; }
    if (ts.isIdentifier(n)) {
      const lib = libraryName(ts, checker, n);
      if (lib && (answeredByGame(ts, checker, n, lib) || READ_CALLS.has(lib) || READ_ARITY.has(lib) || GAME_CELL_ROOTS.has(lib))) { found = true; return; }
      const decl = declarationOf(ts, checker, n);
      const other = decl && decl !== fn && (isScriptFunction(ts, decl) ? decl : scriptArrow(ts, decl) ?? (classMember(ts, decl) ? decl : undefined));
      if (other && usesGame(ts, checker, other, seen)) { found = true; return; }
      return;
    }
    // `new E()`: its fields' first values and its constructor run where the instance is made, its base class's before them.
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const cls = declarationOf(ts, checker, n.expression);
      if (cls && isScriptClass(ts, cls) && usesGame(ts, checker, cls, seen)) { found = true; return; }
    }
    ts.forEachChild(n, look);
  };
  if (ts.isClassDeclaration(fn)) {
    for (const m of fn.members) {
      if ((ts.isPropertyDeclaration(m) && m.initializer && !m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) || ts.isConstructorDeclaration(m)) look(m);
    }
    const base = fn.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const baseDecl = base && ts.isIdentifier(base) ? declarationOf(ts, checker, base) : undefined;
    if (!found && baseDecl && isScriptClass(ts, baseDecl)) found = usesGame(ts, checker, baseDecl, seen);
  } else {
    const body = (fn as TS.FunctionLikeDeclaration).body;
    if (body) look(body);
  }
  usesGameMemo.set(fn, found);
  return found;
}

/** A method, an accessor or a constructor of one of the script's classes: what a call through an instance runs. */
function classMember(ts: typeof TS, decl: TS.Node): boolean {
  return (ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl) || ts.isConstructorDeclaration(decl)) && !!decl.body && isScriptClass(ts, decl.parent);
}

/** Whether a class is one of the script's own, declared at the top of one of its files: a program may make instances of it. */
export function isScriptClass(ts: typeof TS, decl: TS.Node): decl is TS.ClassDeclaration {
  return ts.isClassDeclaration(decl) && !!decl.name && atTop(ts, decl) && !decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}

function planOnce(ts: typeof TS, checker: TS.TypeChecker, of: TS.ArrowFunction | TS.FunctionExpression | TS.ClassDeclaration | TS.ExpressionStatement, options: PlanOptions, forced: Set<TS.Node>): ProgramPlan {
  if (ts.isClassDeclaration(of)) return planClassOnce(ts, checker, of, forced);
  if (ts.isExpressionStatement(of)) {
    // A block that holds the statement where it stands: its range the statement's, so that it has a place in the file.
    const body = ts.setTextRange(ts.factory.createBlock([of]), of);
    (body as { parent: TS.Node }).parent = of.parent;
    const plan: ProgramPlan = { root: of, body, hoisted: [], index: new Map(), game: new Set(), consts: new Map(), constList: [], tree: [], errors: [], grows: new Set() };
    return planWithin(ts, checker, plan, undefined, options, forced);
  }
  const arrow = of;
  const plan: ProgramPlan = { arrow, root: arrow.body, body: ts.isBlock(arrow.body) ? arrow.body : undefined as unknown as TS.Block, hoisted: [], index: new Map(), game: new Set(), consts: new Map(), constList: [], tree: [], errors: [], grows: new Set() };
  return planWithin(ts, checker, plan, arrow, options, forced);
}

function planClassOnce(ts: typeof TS, checker: TS.TypeChecker, cls: TS.ClassDeclaration, forced: Set<TS.Node>): ProgramPlan {
  const plan: ProgramPlan = { root: cls, body: ts.factory.createBlock([]), hoisted: [], index: new Map(), game: new Set(), consts: new Map(), constList: [], tree: [], errors: [], grows: new Set() };
  return planWithin(ts, checker, plan, undefined, { parameters: true }, forced);
}

function planWithin(ts: typeof TS, checker: TS.TypeChecker, plan: ProgramPlan, arrow: TS.ArrowFunction | TS.FunctionExpression | undefined, options: PlanOptions, forced: Set<TS.Node>): ProgramPlan {
  const error = (node: TS.Node, message: string) => plan.errors.push({ node, message });
  const what = options.parameters ? "game()" : "program()";
  if (arrow && !ts.isBlock(arrow.body)) {
    if (!options.parameters) {
      error(arrow.body, "program() takes an arrow with a block body: program(() => { … }).");
      plan.body = ts.factory.createBlock([]);
      return plan;
    }
    plan.expression = arrow.body;
    plan.body = ts.factory.createBlock([]);
  }
  if (arrow && arrow.parameters.length && !options.parameters) error(arrow.parameters[0], "The program's arrow takes no parameters.");
  // A function at the top of a file may be a generator (TrigScript 4): a for…of in a program walks it there.
  if (arrow?.asteriskToken && !(ts.isFunctionDeclaration(arrow as TS.Node) && atTop(ts, arrow as TS.Node))) error(arrow, `A ${what} body cannot be a generator.`);

  /* ── Bindings ── */
  const declare = (node: TS.Node) => plan.game.add(node);
  for (const p of arrow?.parameters ?? []) {
    if (!options.parameters) break;
    // `...xs`: the rest of a call's arguments, an array the call makes (structured.ts, inlineWith).
    if (p.dotDotDotToken && !ts.isIdentifier(p.name)) error(p, "The rest of the arguments takes a name: ...xs: number[].");
    else if (!ts.isIdentifier(p.name)) {
      // `({ label, value }: Props)`: each name taken out is the game's, as a parameter is (a component's props).
      const names = (n: TS.BindingName): void => { if (ts.isIdentifier(n)) return; for (const el of n.elements) if (!ts.isOmittedExpression(el)) { declare(el); names(el.name); } };
      declare(p);
      names(p.name);
    } else declare(p);
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
    // What `catch (e)` takes is an error thrown while the map is played: the game's.
    if (ts.isCatchClause(node) && node.variableDeclaration) declare(node.variableDeclaration);
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
  collect(plan.root);
  // A `const` list the body stores into — `const hp = [0, 0, 0]; hp[i] = 5`, which TypeScript allows — is an array of the
  // program like a `let` one; a list that is only read stays a value of the script, which a program may still look up in.
  const ARRAY_WRITERS = new Set(["push", "pop", "fill", "shift", "unshift", "splice"]);
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
    // `add(names, t)` where add pushes to its parameter: the array handed over is written, as if the push were here.
    if (ts.isCallExpression(node)) node.arguments.forEach((arg, i) => {
      const how = ts.isIdentifier(arg) ? parameterWrite(node, i) : undefined;
      if (how) writeTo(arg as TS.Identifier, true, how === "grows" ? "push" : undefined, false);
    });
    ts.forEachChild(node, written);
  };
  /** How a function a call names writes its parameter `i`: pushes or pops it ("grows"), stores into it, or not at all. */
  const parameterWrite = (call: TS.CallExpression, i: number): "grows" | "stores" | undefined => {
    let callee: TS.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    // `rng.shuffle(xs)`: a method, found by what the checker says it is.
    let fn: TS.Node | undefined = ts.isPropertyAccessExpression(callee) ? checker.getSymbolAtLocation(callee.name)?.declarations?.[0] : ts.isIdentifier(callee) ? declarationOf(ts, checker, callee) : undefined;
    if (fn && ts.isVariableDeclaration(fn) && fn.initializer) {
      let init: TS.Expression = fn.initializer;
      // `const add = game((xs, t) => …)` as well as `const add = (xs, t) => …`.
      if (ts.isCallExpression(init) && init.arguments.length === 1) init = init.arguments[0];
      fn = init;
    }
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) || !fn.body) return undefined;
    const p = fn.parameters[i];
    if (!p || !ts.isIdentifier(p.name)) return undefined;
    const name = p.name.text;
    let how: "grows" | "stores" | undefined;
    const look = (n: TS.Node): void => {
      if (how === "grows") return;
      let t: TS.Expression | undefined;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) t = n.left;
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) t = n.operand;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ARRAY_WRITERS.has(n.expression.name.text)) t = n.expression;
      if (t && (ts.isElementAccessExpression(t) || ts.isPropertyAccessExpression(t))) {
        let root: TS.Expression = t.expression;
        while (ts.isElementAccessExpression(root) || ts.isPropertyAccessExpression(root) || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && root.text === name) {
          const member = ts.isPropertyAccessExpression(t) && ts.isIdentifier(t.expression) ? t.name.text : undefined;
          how = member && member !== "fill" && ARRAY_WRITERS.has(member) || member === "length" ? "grows" : (how ?? "stores");
        }
      }
      ts.forEachChild(n, look);
    };
    look(fn.body);
    return how;
  };
  const store = (target: TS.Expression | undefined) => {
    // `grid[y][x] = v`, `waves[i].count++`: a store however deep is a store into the list at the root of it.
    let root: TS.Expression | undefined = target && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) ? target.expression : undefined;
    const direct = !!root && ts.isIdentifier(root);
    while (root && (ts.isElementAccessExpression(root) || ts.isPropertyAccessExpression(root) || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root))) root = root.expression;
    if (target && root && ts.isIdentifier(root) && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))) {
      const member = ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
      const atLength = ts.isElementAccessExpression(target) && ts.isPropertyAccessExpression(target.argumentExpression) && target.argumentExpression.name.text === "length"
        && ts.isIdentifier(target.argumentExpression.expression) && target.argumentExpression.expression.text === root.text;
      writeTo(root, direct, member, atLength);
    }
  };
  /** The array a store reaches, if it is one of the body's: the program's from now on, and one that grows when the store is a push, a pop, a shift, … */
  const writeTo = (root: TS.Identifier, direct: boolean, member: string | undefined, atLength: boolean) => {
    {
      const decl = declarationOf(ts, checker, root);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && inside(decl)) {
        const type = checker.getTypeAtLocation(decl.name);
        if (checker.isArrayType(type) || checker.isTupleType(type)) {
          if (plan.consts.has(decl)) forced.add(decl);
          declare(decl);
          // xs.push(v), xs.pop(), shift, unshift, splice, xs.length = n and xs[xs.length] = v are what make an array one that grows.
          if (!direct) return;
          if (member === "push" || member === "pop" || member === "shift" || member === "unshift" || member === "splice" || member === "length" || atLength) plan.grows.add(decl);
        } else {
          // `const shop = { selected: 0 }; shop.selected++` — or a function it is handed writes a field: a record of the
          // program's, as a `let` one is. One only read stays a value of the script.
          let init: TS.Expression = decl.initializer;
          while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
          if (ts.isObjectLiteralExpression(init) && checker.getIndexInfosOfType(type).length === 0) {
            if (plan.consts.has(decl)) forced.add(decl);
            declare(decl);
          }
        }
      }
    }
  };
  const inside = (decl: TS.Node) => { for (let n: TS.Node | undefined = decl; n; n = n.parent) if (n === plan.root) return true; return false; };
  written(plan.root);
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
  /** `memory.vision.countdown`, `local.camera.x` — a field of one of GAME_CELL_ROOTS, two names down; or `local.player`, one. */
  const isGameCell = (n: TS.Node): boolean => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && libraryName(ts, checker, n.expression) === "local") return true;
    if (!ts.isPropertyAccessExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false;
    const root = n.expression.expression;
    if (!ts.isIdentifier(root)) return false;
    const lib = libraryName(ts, checker, root);
    // `local.selected.hp` is a field of a unit, not a cell: the cell is `local.selected`.
    if (lib === "local" && n.expression.name.text === "selected") return false;
    return !!lib && GAME_CELL_ROOTS.has(lib);
  };
  const hoistable = (e: TS.Node): boolean => {
    const hit = memo.get(e);
    if (hit !== undefined) return hit;
    let ok = true;
    // JSX is the program's own text, put together in the game (`structured.ts#jsx`), whatever is in it.
    if (hasJsx(ts, e)) { memo.set(e, false); return false; }
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
      if (lib && answeredByGame(ts, checker, n, lib)) { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p.parent) && p.parent.expression === p && property) { ok = false; return; }
      if (lib && FORBIDDEN_INSIDE.has(lib) && ts.isCallExpression(p) && p.expression === n) { ok = false; return; }
      if (property) return;
      const decl = declarationOf(ts, checker, n);
      if (decl && isGameDecl(decl)) { ok = false; return; }
      // A class of the script's own: inside a program, `new C()` is an instance of the program's, whatever its arguments.
      if (decl && isScriptClass(ts, decl)) { ok = false; return; }
      // A function of the script's own that does what only the game can (`range(2, 4)` draws the game's random numbers):
      // run in the game, whatever its arguments.
      const own = decl && (isScriptFunction(ts, decl) ? decl : scriptArrow(ts, decl));
      if (own && usesGame(ts, checker, own)) { ok = false; return; }
      // A function of the script's own kept in an array or a record (`const fs = [a, b]`): the program's functions as
      // values, which it calls with its own values. Handed to a function (`xs.map(sq)`) or called, it is the script's.
      if (decl && (isScriptFunction(ts, decl) || scriptArrow(ts, decl)) && (ts.isArrayLiteralExpression(p) || (ts.isPropertyAssignment(p) && p.initializer === n) || ts.isShorthandPropertyAssignment(p))) { ok = false; return; }
      // A generator is walked by the program's for…of, a copy of its body at each loop: never run when the script is built.
      if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.asteriskToken) { ok = false; return; }
    };
    const check = (n: TS.Node): void => {
      if (!ok) return;
      // The cell itself is a value (its handle); an expression around it — `memory.game.frame * 2` — is the program's.
      if (n !== e && isGameCell(n)) { ok = false; return; }
      // `waves.forEach((w) => createUnit(P2, w.unit, w.count, at))`: nothing of the program is named, but forEach is there for
      // what its function does, and what this one does is the game's. Run when the script is built it would make actions
      // nobody receives, and the line would silently do nothing; it is the program's loop, unrolled.
      if (isCallbackArgument(ts, n) && doesSomething(n)) { ok = false; return; }
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) { ok = false; return; }
      if (isFunctionValue(n)) { scan(n); return; }
      if (ts.isIdentifier(n)) {
        // A property name (`obj.name`, `{ name: v }`) is not a value reference.
        identifier(n, n.parent);
        return;
      }
      if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || ts.isAwaitExpression(n) || ts.isYieldExpression(n)) { ok = false; return; }
      if (clockCall(ts, checker, n)) { ok = false; return; }
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
    // A function written where a value goes — `let f = (x) => …`, `[a, () => …]`, `twice(() => …)` — is the program's (B3).
    const fn = functionWritten(e);
    if (fn) { callback(fn, items); return; }
    if (holdsFunction(e)) { descend(e, items); return; }
    if (hoistable(e)) { hoist(e, items); return; }
    descend(e, items);
  };
  /** The arrow or function expression `e` is, through parentheses and type assertions. */
  const functionWritten = (e: TS.Node): TS.ArrowFunction | TS.FunctionExpression | undefined => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    return ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? e : undefined;
  };
  /** Whether a function is one of what an expression gives — an item of a list written out, a field, either side of a choice — rather than handed to a call. */
  const holdsFunction = (e: TS.Node): boolean => {
    if (functionWritten(e)) return true;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    if (ts.isArrayLiteralExpression(e)) return e.elements.some(holdsFunction);
    if (ts.isObjectLiteralExpression(e)) return e.properties.some((p) => (ts.isPropertyAssignment(p) && holdsFunction(p.initializer)) || ts.isMethodDeclaration(p));
    if (ts.isConditionalExpression(e)) return holdsFunction(e.whenTrue) || holdsFunction(e.whenFalse);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return holdsFunction(e.left) || holdsFunction(e.right);
    return false;
  };
  const descend = (e: TS.Node, items: PlanItem[]) => {
    const fn = functionWritten(e);
    if (fn) { callback(fn, items); return; }
    if (isFunctionValue(e)) { error(e, "A class written as a value is not supported inside program(); declare it with class."); return; }
    if (ts.isIdentifier(e)) return;
    if (ts.isPropertyAccessExpression(e)) { value(e.expression, items); return; }
    if (ts.isElementAccessExpression(e)) { value(e.expression, items); value(e.argumentExpression, items); return; }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const lib = ts.isCallExpression(e) ? libraryCallName(ts, checker, e) : null;
      const clock = clockCall(ts, checker, e);
      if (clock) { error(e, clockMessage(clock)); return; }
      if (lib && FORBIDDEN_INSIDE.has(lib)) error(e, `${lib}() defines triggers of its own and cannot be used inside program(); inside, write conditions in an if and actions as statements.`);
      // `random()`, `sleep()`, … are the game's: their callee is never a value, however it is spelt (`ts.random()` through a namespace import).
      // Of a method call the object is the value, not the method: `cost.get(u.type)` has to leave `cost` — the Map — in reach, and a
      // method read off its object on its own has lost it.
      let callee: TS.Expression = e.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (isTaskFunction(ts, checker, callee)) callback(callee, items);
      else if (!lib || !answeredByGame(ts, checker, ts.isPropertyAccessExpression(callee) ? callee.name as TS.Identifier : callee as TS.Identifier, lib)) value(ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) ? e.expression.expression : e.expression, items);
      for (const a of e.arguments ?? []) {
        let fn: TS.Expression = a;
        while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
        if (isCallbackArgument(ts, fn) || isTaskFunction(ts, checker, fn)) callback(fn, items); else value(a, items);
      }
      return;
    }
    if (ts.isBinaryExpression(e)) { value(e.left, items); value(e.right, items); return; }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) { value(e.operand, items); return; }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSpreadElement(e) || ts.isAwaitExpression(e) || ts.isTypeOfExpression(e) || ts.isVoidExpression(e) || ts.isDeleteExpression(e)) { value(e.expression, items); return; }
    if (ts.isConditionalExpression(e)) { value(e.condition, items); value(e.whenTrue, items); value(e.whenFalse, items); return; }
    if (ts.isTemplateExpression(e)) { for (const s of e.templateSpans) value(s.expression, items); return; }
    // JSX: what is inside its braces, in attributes and among the children, is a value like any other.
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) {
      const attributes = ts.isJsxElement(e) ? e.openingElement.attributes : ts.isJsxSelfClosingElement(e) ? e.attributes : undefined;
      for (const a of attributes?.properties ?? []) {
        if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer)) value(a.initializer.expression, items);
        else if (ts.isJsxSpreadAttribute(a)) value(a.expression, items);
      }
      for (const c of ts.isJsxSelfClosingElement(e) ? [] : e.children) {
        if (ts.isJsxExpression(c)) value(c.expression, items);
        else if (!ts.isJsxText(c)) descend(c, items);
      }
      return;
    }
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
    // `enum Phase { Wait, Fight }` in the body: its members are known when the script is built, as at the top of a file.
    if (ts.isEnumDeclaration(s)) { items.push({ kind: "statement", node: s }); return; }
    if (ts.isReturnStatement(s)) { value(s.expression, items); return; }
    if (ts.isSwitchStatement(s)) { value(s.expression, items); for (const c of s.caseBlock.clauses) { if (ts.isCaseClause(c)) value(c.expression, items); items.push({ kind: "block", items: block(c.statements) }); } return; }
    if (ts.isForOfStatement(s) || ts.isForInStatement(s)) { value(s.expression, items); items.push({ kind: "block", items: block([s.statement]) }); return; }
    if (ts.isLabeledStatement(s)) { statement(s.statement, items, deferred); return; }
    if (ts.isThrowStatement(s)) { value(s.expression, items); return; }
    if (ts.isTryStatement(s)) {
      items.push({ kind: "block", items: block(s.tryBlock.statements) });
      if (s.catchClause) items.push({ kind: "block", items: block(s.catchClause.block.statements) });
      if (s.finallyBlock) items.push({ kind: "block", items: block(s.finallyBlock.statements) });
      return;
    }
    // break / continue / empty / types: nothing runs at build time.
  };
  // What a class of the body computes when the script is built: inside a field's first value, and inside each body, as a declared function's.
  const classItems = (c: TS.ClassDeclaration): PlanItem[] => {
    const items: PlanItem[] = [];
    for (const m of c.members) {
      if (ts.isPropertyDeclaration(m)) value(m.initializer, items);
      else if ((ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m) || ts.isAccessor(m)) && m.body) {
        // A parameter's default (`size = 8`, `limit = 30 * SECOND`) is worked out where the call leaves it out.
        for (const p of m.parameters) if (p.initializer) value(p.initializer, items);
        items.push({ kind: "block", items: block(m.body.statements) });
      }
    }
    return items;
  };
  const declarations = (list: TS.VariableDeclarationList, items: PlanItem[]) => {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const d of list.declarations) {
      if (isConst && plan.game.has(d)) { value(d.initializer, items); continue; }
      if (isConst) {
        if (!d.initializer) { error(d, "A constant needs a value."); continue; }
        // (`const w = memory.map.width` reads the game: a const of the program's, like one computed from its variables.)
        let init: TS.Expression = d.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        // `const f = (x) => …` (B3): a function the program calls with its own values, so its body is planned as a declared
        // function's. One that uses nothing of the program stays a value of the script too, which build-time code may call.
        const fn = functionWritten(init);
        if (fn) {
          if (hoistable(d.initializer)) { plan.consts.set(d, plan.constList.length); plan.constList.push(d); items.push({ kind: "const", decl: d }); }
          else plan.game.add(d);
          callback(fn, items);
          continue;
        }
        if (holdsFunction(init)) { plan.game.add(d); memo.clear(); descend(d.initializer, items); continue; }
        if (hoistable(d.initializer) && !isGameCell(init)) { plan.consts.set(d, plan.constList.length); plan.constList.push(d); items.push({ kind: "const", decl: d }); continue; }
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
  if (ts.isClassDeclaration(plan.root)) { plan.tree = classItems(plan.root); return plan; }
  plan.tree = block(plan.body.statements);
  // A parameter's default, worked out where a call leaves it out: what it names of the file is the script's.
  if (options.parameters) {
    const defaults: PlanItem[] = [];
    for (const p of arrow?.parameters ?? []) if (p.initializer) value(p.initializer, defaults);
    if (defaults.length) plan.tree = [...defaults, ...plan.tree];
  }
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
      case "statement": return ts.visitNode(item.node, rewrite) as TS.Statement;
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
  /** The plan for a class of the script's own (`planClass`), made before the transform. */
  planForClass?: (cls: TS.ClassDeclaration) => ProgramPlan | undefined;
  /** The plan for a listener at the top of a file (`planListener`), made before the transform. */
  planForListener?: (stmt: TS.ExpressionStatement) => ProgramPlan | undefined;
  /** The plan for a function at the top of a file (`planFunction`), made before the transform. */
  planForFunction?: (fn: TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression) => ProgramPlan | undefined;
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
    const visit = (node: TS.Node): TS.VisitResult<TS.Node> => {
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
      // `on.died(…)` at the top of a file: handed to the run as a program of its own (`__listen`), which listens from the
      // start of the game.
      if (isTopListener(ts, checker, node)) {
        const plan = ctx.planForListener?.(node);
        if (plan) {
          const descriptor = f.createObjectLiteralExpression([
            f.createPropertyAssignment("__trigscript", f.createStringLiteral("program")),
            f.createPropertyAssignment("at", at(node)),
            f.createPropertyAssignment("pos", f.createNumericLiteral(node.getStart(sf))),
            f.createPropertyAssignment("hoisted", hoistedFunction(ts, checker, plan, context)),
          ], true);
          return f.createExpressionStatement(f.createCallExpression(f.createIdentifier("__listen"), undefined, [descriptor, at(node)]));
        }
      }
      // `class Squad { … }` at the top of a file: the class as it is, and after it what its bodies compute when the script is
      // built, handed to the run (`__class`), for a program that makes an instance of it.
      if (ts.isClassDeclaration(node) && node.name && atTop(ts, node)) {
        const plan = ctx.planForClass?.(node);
        const visited = ts.visitEachChild(node, visit, context);
        if (!plan) return visited;
        const descriptor = f.createObjectLiteralExpression([
          f.createPropertyAssignment("__trigscript", f.createStringLiteral("class")),
          f.createPropertyAssignment("at", at(node)),
          f.createPropertyAssignment("pos", f.createNumericLiteral(node.getStart(sf))),
          f.createPropertyAssignment("hoisted", hoistedFunction(ts, checker, plan, context)),
        ], true);
        return [visited, f.createExpressionStatement(f.createCallExpression(f.createIdentifier("__class"), undefined, [f.createIdentifier(node.name.text), descriptor]))];
      }
      // `function bar() { … }` at the top of a file: the function as it is, and after it what its body computes when the
      // script is built, handed to the run (`__fn`), for a program that calls it with its own values.
      if (isScriptFunction(ts, node)) {
        const plan = ctx.planForFunction?.(node);
        const visited = ts.visitEachChild(node, visit, context);
        if (!plan) return visited;
        const descriptor = f.createObjectLiteralExpression([
          f.createPropertyAssignment("__trigscript", f.createStringLiteral("function")),
          f.createPropertyAssignment("at", at(node)),
          f.createPropertyAssignment("pos", f.createNumericLiteral(node.getStart(sf))),
          f.createPropertyAssignment("hoisted", hoistedFunction(ts, checker, plan, context)),
        ], true);
        return [visited, f.createExpressionStatement(f.createCallExpression(f.createIdentifier("__fn"), undefined, [f.createIdentifier(node.name!.text), descriptor]))];
      }
      if (ts.isVariableStatement(node) && atTop(ts, node)) {
        const arrows = node.declarationList.declarations.map((d) => [d, scriptArrow(ts, d)] as const).filter(([, a]) => a && ctx.planForFunction?.(a));
        if (arrows.length) {
          const visited = ts.visitEachChild(node, visit, context);
          // An exported const of a namespace has no name of its own once compiled (`Geo.mk = …`): it is the namespace's.
          const ns = ts.isModuleBlock(node.parent) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? (node.parent.parent as TS.ModuleDeclaration).name : undefined;
          const named = (d: TS.VariableDeclaration) => ns && ts.isIdentifier(ns) ? f.createPropertyAccessExpression(f.createIdentifier(ns.text), (d.name as TS.Identifier).text) : f.createIdentifier((d.name as TS.Identifier).text);
          return [visited, ...arrows.map(([d, a]) => f.createExpressionStatement(f.createCallExpression(f.createIdentifier("__fn"), undefined, [named(d), f.createObjectLiteralExpression([
            f.createPropertyAssignment("__trigscript", f.createStringLiteral("function")),
            f.createPropertyAssignment("at", at(a!)),
            f.createPropertyAssignment("pos", f.createNumericLiteral(a!.getStart(sf))),
            f.createPropertyAssignment("hoisted", hoistedFunction(ts, checker, ctx.planForFunction!(a!)!, context)),
          ], true)])))];
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sf, visit) as TS.SourceFile;
  };
}

export { MODULE_NAME };
