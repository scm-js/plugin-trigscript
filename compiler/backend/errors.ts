/**
 * Errors on a map of our own (TrigScript 4, step 11 of the way off eudplib). The front end has done most of it (B4):
 * before a `throw` it sets the error in flight — its class's code into `Program.errors.thrown`, its message into
 * `message` — `finally` is copied before every way out, and a program's body is a `try` whose `catch` is `uncaught`.
 * What is left is where the walk goes, which is the emitter's (`Emitter.handler`): a `throw` goes to the `catch` of the
 * nearest `try` around it, or out of the function it is in, and the call goes on from there.
 *
 * `ownErrors` rewrites what the emitter would need texts for, before the texts are lowered (`texts.ts`): the line each
 * error is thrown at kept in a variable of the program's, `uncaught` as the print the Python side makes of it, and —
 * when a function calls itself — the RangeError a stack that runs out throws, a function the emitter calls there.
 */
import { ERROR_CODES, STACK_OVERFLOW_MESSAGE, type At, type FuncDecl, type Program, type ProgramErrors, type Stmt, type VarDecl } from "../ir";

/** The variable the line an error was thrown at is kept in: what an uncaught one is said with. */
export const errorLine = (errors: ProgramErrors): string => `${errors.thrown}@line`;
/** The function that sets the error in flight to the RangeError of a stack that ran out (`Emitter.keep`). */
export const OVERFLOW_FN = "@error.overflow";
/** The function that says an error nothing caught, where more than one place may: each a call of it. */
const UNCAUGHT_FN = "@error.uncaught";
/**
 * The functions a task's error goes through: the front end's `catch` around a task's body — the error noted in the
 * task's slot for an `await` of it, or said — which reads the task's number (`taskHandle`) and nothing of the task's
 * own, laid out once for every task whose `catch` is the same, a call each (a start of sixteen slots had sixteen).
 */
const TASK_FAILED_FN = "@error.task";

export function ownErrors(program: Program): Program {
  const errors = program.errors;
  if (!errors) return program;
  const line = errorLine(errors), at0 = program.at;
  const set = (target: string, value: number, at: At): Stmt => ({ kind: "assign", target, value: { kind: "const", value }, at, label: "" });
  // (`throw` and `uncaught` are statements only: wherever a list holds one, it is a list of statements.)
  const walk = (list: Stmt[]): Stmt[] => deep(list) as Stmt[];
  const deep = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.flatMap((y) => (y && typeof y === "object" && (y.kind === "throw" || y.kind === "uncaught") ? statement(y as Stmt) : [deep(y)]));
    if (!x || typeof x !== "object") return x;
    const o = (x as { kind?: string }).kind === "start" ? outline(x as Extract<Stmt, { kind: "start" }>) : (x as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = v && typeof v === "object" ? deep(v) : v;
    return out;
  };
  // (Said where it is when only one place says it; else once, in a function each place calls — a task's body has one
  // in every slot.)
  let sites = 0;
  const count = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(count);
    else if (x && typeof x === "object") {
      if ((x as { kind?: string }).kind === "uncaught") sites++;
      Object.values(x).forEach(count);
    }
  };
  count([program.body, program.functions ?? []]);
  // (A task's `catch` first: it says an uncaught error too.)
  const failed: { shape: string; f: FuncDecl }[] = [];
  const outline = (st: Extract<Stmt, { kind: "start" }>): Extract<Stmt, { kind: "start" }> => {
    const top = st.call.body.length === 1 ? st.call.body[0] : undefined;
    if (top?.kind !== "try" || !taskCatch(top.catch, st.task)) return st;
    const shape = canonical(top.catch);
    let f = failed.find((x) => x.shape === shape)?.f;
    if (!f) {
      const h: VarDecl = { id: `${TASK_FAILED_FN}${failed.length}.h`, name: "(task)", kind: "number", shared: false, at: st.at };
      const body = replaced(top.catch, (o) => (o.kind === "taskHandle" ? { kind: "var", id: h.id } : undefined)) as Stmt[];
      f = { id: `${TASK_FAILED_FN}${failed.length}`, name: "(a task's error)", params: [h], at: st.at, body };
      failed.push({ shape, f });
    }
    const call: Stmt = { kind: "call", call: { fn: f.id, name: f.name, params: [{ decl: f.params[0], init: { kind: "taskHandle", at: top.at }, label: "" }], body: [], at: top.at, label: "" }, at: top.at, label: "" };
    return { ...st, call: { ...st.call, body: [{ ...top, catch: [call] }] } };
  };
  const said = (at: At, label: string): Stmt[] => [
        { kind: "print", to: CURRENT_PLAYER, position: "chat", at, label, parts: [
          { kind: "text", text: "\x06TrigScript: uncaught " },
          { kind: "value", text: { kind: "textOf", array: errors.names, index: { kind: "var", id: errors.thrown }, at } },
          { kind: "text", text: ": " },
          { kind: "value", text: { kind: "textVar", id: errors.message } },
          { kind: "text", text: ", line " },
          { kind: "number", expr: { kind: "var", id: line } },
          { kind: "text", text: "." },
        ] },
        set(errors.thrown, 0, at),
      ];
  const statement = (s: Stmt): Stmt[] => {
    switch (s.kind) {
      // Where it was thrown: a caught error thrown again keeps where it came from.
      case "throw": return s.rethrow ? [s] : [set(line, s.at.line, s.at), s];
      // Said in red to the player the program runs as, as a fault of the game's is, and given up.
      case "uncaught": return sites > 1 ? [{ kind: "call", call: { fn: UNCAUGHT_FN, name: "(uncaught)", params: [], body: [], at: s.at, label: s.label }, at: s.at, label: s.label }] : said(s.at, s.label);
      default: return [s];
    }
  };
  const decl: VarDecl = { id: line, name: "(error line)", kind: "number", shared: true, at: at0 };
  const functions: FuncDecl[] = (program.functions ?? []).map((f) => ({ ...f, body: walk(f.body) }));
  if (sites > 1) functions.push({ id: UNCAUGHT_FN, name: "(uncaught)", params: [], at: at0, body: said(at0, "") });
  const body = walk(program.body);
  for (const { f } of failed) functions.push({ ...f, body: walk(f.body) });
  if (functions.some((f) => f.recursive)) {
    functions.push({ id: OVERFLOW_FN, name: "(stack overflow)", params: [], at: at0, body: [
      { kind: "assignText", target: errors.message, value: { kind: "text", text: STACK_OVERFLOW_MESSAGE }, at: at0, label: "" },
      set(errors.thrown, ERROR_CODES.RangeError, at0),
    ] });
  }
  return {
    ...program,
    body: [{ kind: "declare", decl, init: { kind: "const", value: 0 }, at: at0, label: "" }, ...body],
    ...(functions.length ? { functions } : {}),
  };
}

/** Player 13 in a print: the current player. */
const CURRENT_PLAYER = 13;

/**
 * Whether a `catch` is the front end's around a task's body: it starts by taking the task's number, reads it nowhere
 * else, and reads no variable of the task's — what lets it be laid out once for every slot and every task.
 */
function taskCatch(list: Stmt[], task: number): boolean {
  const first = list[0];
  if (first?.kind !== "declare" || (first.init as { kind?: string }).kind !== "taskHandle") return false;
  let handles = 0, own = false;
  const look = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(look); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.kind === "taskHandle") handles++;
    if (o.decl && typeof o.decl === "object" && (o.decl as VarDecl).task === task) own = true;
    if (o.kind === "start" || o.kind === "sleep" || o.kind === "parallel" || o.kind === "return" || o.kind === "break" || o.kind === "continue") own = true;
    Object.values(o).forEach(look);
  };
  look(list);
  // (What it reads of the task's would be declared in the task: a variable it reads and does not declare is the program's.)
  return handles === 1 && !own;
}

/** A piece of the IR as text, the variables it declares numbered in the order they come, `at` and labels left out. */
function canonical(x: unknown): string {
  const names = new Map<string, string>();
  const look = (y: unknown): void => {
    if (Array.isArray(y)) { y.forEach(look); return; }
    if (!y || typeof y !== "object") return;
    const o = y as Record<string, unknown>;
    if (o.decl && typeof o.decl === "object" && !names.has((o.decl as VarDecl).id)) names.set((o.decl as VarDecl).id, `#${names.size}`);
    Object.values(o).forEach(look);
  };
  look(x);
  return JSON.stringify(x, (k, v) => (k === "at" || k === "label" || k === "range" ? undefined : typeof v === "string" && names.has(v) ? names.get(v) : v));
}

/** A copy of a piece of the IR with each object `f` gives something for replaced by it. */
function replaced(x: unknown, f: (o: Record<string, unknown>) => unknown): unknown {
  if (Array.isArray(x)) return x.map((y) => replaced(y, f));
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  const r = f(o);
  if (r !== undefined) return r;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, replaced(v, f)]));
}
