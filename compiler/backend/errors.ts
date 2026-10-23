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
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = v && typeof v === "object" ? deep(v) : v;
    return out;
  };
  const statement = (s: Stmt): Stmt[] => {
    switch (s.kind) {
      // Where it was thrown: a caught error thrown again keeps where it came from.
      case "throw": return s.rethrow ? [s] : [set(line, s.at.line, s.at), s];
      // Said in red to the player the program runs as, as a fault of the game's is, and given up.
      case "uncaught": return [
        { kind: "print", to: CURRENT_PLAYER, position: "chat", at: s.at, label: s.label, parts: [
          { kind: "text", text: "\x06TrigScript: uncaught " },
          { kind: "value", text: { kind: "textOf", array: errors.names, index: { kind: "var", id: errors.thrown }, at: s.at } },
          { kind: "text", text: ": " },
          { kind: "value", text: { kind: "textVar", id: errors.message } },
          { kind: "text", text: ", line " },
          { kind: "number", expr: { kind: "var", id: line } },
          { kind: "text", text: "." },
        ] },
        set(errors.thrown, 0, s.at),
      ];
      default: return [s];
    }
  };
  const decl: VarDecl = { id: line, name: "(error line)", kind: "number", shared: true, at: at0 };
  const functions: FuncDecl[] = (program.functions ?? []).map((f) => ({ ...f, body: walk(f.body) }));
  if (functions.some((f) => f.recursive)) {
    functions.push({ id: OVERFLOW_FN, name: "(stack overflow)", params: [], at: at0, body: [
      { kind: "assignText", target: errors.message, value: { kind: "text", text: STACK_OVERFLOW_MESSAGE }, at: at0, label: "" },
      set(errors.thrown, ERROR_CODES.RangeError, at0),
    ] });
  }
  return {
    ...program,
    body: [{ kind: "declare", decl, init: { kind: "const", value: 0 }, at: at0, label: "" }, ...walk(program.body)],
    ...(functions.length ? { functions } : {}),
  };
}

/** Player 13 in a print: the current player. */
const CURRENT_PLAYER = 13;
