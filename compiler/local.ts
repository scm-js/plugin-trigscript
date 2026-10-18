/**
 * Local values (TrigScript 4, B5): what only one computer knows — `local.camera`, `local.mouse`, `local.player` and the
 * rest of `LOCAL_MEMORY` — may be shown, and may not change the game.
 *
 * Every computer in a game runs every trigger, and stays in step only because each does the same with the same. A value
 * read from a computer's own memory is different on each, so whatever depends on it would happen differently on each,
 * and the game would split (StarCraft drops a player when it notices). What may depend on one is what is only shown on
 * that computer: a text (print, Display Text, ui.lines), a sound, the camera, a ping on the minimap. And `sync()`, which
 * is how a player's value reaches every computer.
 *
 * The check follows the values through the program, as far as the program's own cells go: a variable, an array, a
 * text buffer or a function's parameter that is ever given a Local value is Local itself, and so is everything done
 * under a test of one (an `if`, a loop's condition, a `switch`) — so is a variable assigned there, whatever it is
 * assigned. It goes round until nothing more becomes Local, then says what may not depend on what it found:
 *  - an action that is not only shown, a unit changed or ordered, a location moved, a table of the game written;
 *  - under a test of a Local value: waiting (a sleep, an await), starting or cancelling a task, throwing, a random
 *    number (each draw moves the game's random numbers on), and leaving a loop or a function that was entered on every
 *    computer (break, continue, return) — after which every computer would be somewhere else in the program.
 * A called function run under a Local test is walked as if all of it were under one.
 *
 * A `memory(address, …)` condition on one of those addresses is a Local value too.
 *
 * Not followed: the made texts' heap (a Local text may be longer on one computer, and take more of the heap).
 */
import { ActionType, ConditionType, type ConditionRecord } from "../vendor/triggers";
import type { ProgramDiagnostic } from "./eud";
import { localMemoryAt } from "./memory";
import { programDeclarations, type At, type Call, type Program, type Stmt } from "./ir";

/** The deaths table, which memory(address, …) is a condition on. */
const DEATHS = 0x58a364;

/** Actions that only show something, on the computer of the player they are for. */
const SHOWN = new Set<number>([ActionType.PlayWav, ActionType.DisplayText, ActionType.CenterView, ActionType.MinimapPing, ActionType.SetMissionObjectives]);

/** The statement lists inside a statement: walked as statements, not looked at as operands. */
const NESTED = new Set(["then", "else", "body", "catch", "iterations", "cases", "update", "branches"]);

interface Ctx {
  /** Under a test of a Local value: why, in words; null when not. */
  under: string | null;
  /** Why this part is walked as if under a test although it is not written so, for the words; when it is. */
  note?: string;
  /**
   * What a `break` leaves (the nearest loop or switch), a `continue` (the nearest loop) and a `return` (the function, the
   * program): left early under a Local test, it goes differently from computer to computer after that point, so it is
   * walked again as a whole under the test (`whole`). `…Local`: it already is, and leaving it changes nothing.
   */
  breaks?: object;
  breaksLocal?: boolean;
  continues?: object;
  continuesLocal?: boolean;
  returns?: object;
  returnsLocal?: boolean;
  /** The variable a `return` here writes. */
  result?: string;
}

export interface LocalCheck {
  errors: ProgramDiagnostic[];
  /** The ids of the program's cells that may hold a Local value: what a copy of the game may hold differently from another. */
  locals: string[];
}

export function checkLocal(program: Program): LocalCheck {
  const names = new Map(programDeclarations(program).map((d) => [d.id, d.name]));
  for (const a of program.arrays ?? []) names.set(a.id, a.name);
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));
  /** Each cell found to hold a Local value, with what it came from, in words. */
  const locals = new Map<string, string>();
  /** The called functions run under a Local test, with why. */
  const under = new Map<string, string>();
  /** The loops, switches, functions and program bodies some computers leave early under a Local test, with why. */
  const whole = new Map<object, string>();
  const leave = (target: object | undefined, why: string) => { if (target && !whole.has(target)) { whole.set(target, why); changed = true; } };
  let changed = false;
  let report = false;
  const errors = new Map<string, ProgramDiagnostic>();
  const fail = (at: At, message: string) => { if (report) errors.set(`${at.file}:${at.line}:${at.column}:${message}`, { at, message }); };
  /** A cell found Local: it keeps where its value came from in the end (`n (from local.mouse.x)` keeps `local.mouse.x`). */
  const mark = (id: string | undefined, why: string) => {
    if (id === undefined || locals.has(id)) return;
    locals.set(id, /\(from (.+)\)$/.exec(why)?.[1] ?? why);
    changed = true;
  };

  /**
   * What of an operand is Local, or null: `say` names it as the script does (`x (from local.camera.x)`), `root` is where
   * it came from in the end (`local.camera.x`), which is what a cell given it keeps. Calls count by their result only.
   */
  const source = (v: unknown): { say: string; root: string } | null => {
    if (Array.isArray(v)) { for (const x of v) { const o = source(x); if (o) return o; } return null; }
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const cellOf = (id: string) => {
      const root = locals.get(id)!;
      const name = names.get(id);
      return { say: name && !name.startsWith("(") ? `${name} (from ${root})` : root, root };
    };
    switch (o.kind) {
      case "tableRead": {
        const cell = o.cell as { name: string; base: number; stride: number };
        const mem = cell.stride === 0 ? localMemoryAt(cell.base) : undefined;
        if (mem) { const root = cell.name.startsWith("local.") ? cell.name : mem; return { say: root, root }; }
        break;
      }
      case "cond": {
        // memory(address, …) is a Deaths condition of unit 0 whose player is the address's place from the deaths table.
        const r = o.record as ConditionRecord;
        if (r.type === ConditionType.Deaths && r.unitId === 0) {
          const address = (DEATHS + r.player * 4) >>> 0;
          const mem = localMemoryAt(address);
          if (mem) { const root = `memory(0x${address.toString(16).toUpperCase()}, …), ${mem}`; return { say: root, root }; }
        }
        break;
      }
      case "var": case "textVar": case "unitVar": if (locals.has(o.id as string)) return cellOf(o.id as string); break;
      case "element": case "textOf": case "length": case "pop": if (locals.has(o.array as string)) return cellOf(o.array as string); break;
      case "built": if (locals.has(o.buffer as string)) { const root = locals.get(o.buffer as string)!; return { say: root, root }; } break;
      case "textAt": if (locals.has(o.addr as string)) return cellOf(o.addr as string); break;
      case "call": case "textCall": {
        const call = o.call as Call;
        if (!call.result || !locals.has(call.result.decl.id)) return null;
        const root = locals.get(call.result.decl.id)!;
        return { say: `${call.name ? `${call.name}()` : "a call"} (from ${root})`, root };
      }
    }
    for (const [k, x] of Object.entries(o)) if (k !== "at" && x && typeof x === "object") { const r = source(x); if (r) return r; }
    return null;
  };
  const origin = (v: unknown): string | null => source(v)?.say ?? null;
  /** Where a cell given these operands gets its Local value from, in the end. */
  const rootOf = (v: unknown): string | null => source(v)?.root ?? null;

  /** The operands of a statement: everything but the statement lists inside it. */
  const operands = (s: Stmt): unknown[] => Object.entries(s).filter(([k]) => !NESTED.has(k) && k !== "at" && k !== "label").map(([, v]) => v);

  /** Each call inside some operands, not looking into the calls' own bodies (which `call` walks). */
  const calls = (v: unknown, ctx: Ctx): void => {
    if (Array.isArray(v)) { v.forEach((x) => calls(x, ctx)); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if ((o.kind === "call" || o.kind === "textCall") && o.call && typeof o.call === "object") { call(o.call as Call, ctx); return; }
    for (const [k, x] of Object.entries(o)) if (k !== "at" && x && typeof x === "object") calls(x, ctx);
  };

  /** Random numbers drawn in some operands: under a Local test, a draw moves the game's random numbers on for some computers only. */
  const draws = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(draws);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.kind === "randomInt" || o.kind === "random" || (o.kind === "pick" && o.by === "random")) return true;
    if (o.kind === "call") return false;
    return Object.entries(o).some(([k, x]) => k !== "at" && x && typeof x === "object" && draws(x));
  };

  const call = (c: Call, ctx: Ctx) => {
    for (const p of c.params) {
      calls(p.init, ctx);
      const o = ctx.under ?? rootOf(p.init);
      if (o) mark(p.decl.id, o);
    }
    if (c.fn) {
      const f = functions.get(c.fn);
      if (ctx.under && f && !under.has(f.id)) { under.set(f.id, ctx.under); changed = true; }
      if (f?.result && c.result && locals.has(f.result.decl.id)) mark(c.result.decl.id, locals.get(f.result.decl.id)!);
      return;
    }
    const why = ctx.under ?? whole.get(c) ?? null;
    walk(c.body, { under: why, ...(ctx.under ? { note: ctx.note } : why ? { note: LEFT_EARLY.return } : {}), returns: c, returnsLocal: why !== null, ...(c.result ? { result: c.result.decl.id } : {}) });
  };

  const walk = (body: Stmt[], ctx: Ctx) => { for (const s of body) stmt(s, ctx); };

  const stmt = (s: Stmt, ctx: Ctx): void => {
    const need = (what: string, why: string, because?: string) => words(what, why, because, ctx.note);
    if (s.kind === "call") { call(s.call, ctx); return; }
    if (s.kind === "start") {
      if (ctx.under) fail(s.at, need("Starting a task", ctx.under));
      call({ ...s.call, body: [] }, { ...ctx, under: null });
      return;
    }
    calls(operands(s), ctx);
    const L = ctx.under;
    if (L && draws(operands(s))) fail(s.at, need("A random number", L, "each draw moves the game's random numbers on, so the next would differ from computer to computer"));
    else if (draws(operands(s))) {
      // `local.mouse.x > 3 && random()`: whether the draw is made at all depends on the Local value.
      const o = origin(operands(s));
      if (o) fail(s.at, need("A random number", o, "each draw moves the game's random numbers on, so the next would differ from computer to computer"));
    }
    /** What this statement's value is Local by: the test it is under, or its operands. */
    const by = (...vs: unknown[]): string | null => L ?? rootOf(vs);
    const sink = (what: string, ...vs: unknown[]) => {
      if (L) { fail(s.at, need(what, L)); return; }
      const o = origin(vs);
      if (o) fail(s.at, `${what} would depend on ${o}, which only this computer knows (a Local value): it would go differently on each player's computer and split the game. Show it (print, ui.lines, centerView) or send it to every computer first: const v = await sync(P1, …).`);
    };
    const nested = (cond: unknown) => L ?? origin(cond);
    /** A loop's body: under its condition's test, or walked whole when some computers leave it early. */
    const loop = (cond: unknown): Ctx => {
      const o = nested(cond);
      const why = o ?? whole.get(s) ?? null;
      const note = o ? ctx.note : why ? LEFT_EARLY.loop : undefined;
      return { ...ctx, under: why, ...(note ? { note } : { note: undefined }), breaks: s, breaksLocal: why !== null, continues: s, continuesLocal: why !== null };
    };
    switch (s.kind) {
      case "declare": { const o = by(s.init); if (o) mark(s.decl.id, o); return; }
      case "assign": case "assignBool": case "assignUnit": case "assignText": { const o = by(s.value); if (o) mark(s.target, o); return; }
      case "storeText": { const o = by(s.value, s.index); if (o) { mark(s.addr, o); mark(s.block, o); } return; }
      case "releaseText": return;
      case "declareArray": { const o = by(s.init, s.fill); if (o) mark(s.array, o); return; }
      case "store": { const o = by(s.index, s.value); if (o) mark(s.array, o); return; }
      case "push": { const o = by(s.value); if (o) mark(s.array, o); return; }
      case "pop": { if (L) mark(s.array, L); return; }
      case "setLength": { const o = by(s.value); if (o) mark(s.array, o); return; }
      case "textLoop": {
        const inner = loop(s.of);
        if (inner.under) mark(s.decl.id, inner.under);
        walk(s.body, inner);
        return;
      }
      case "unitLoop": {
        const inner = loop(null);
        if (inner.under) mark(s.decl.id, inner.under);
        walk(s.body, inner);
        return;
      }
      case "if": { const o = nested(s.cond); const inner = { ...ctx, under: o, ...(o && !L ? { note: undefined } : {}) }; walk(s.then, inner); if (s.else) walk(s.else, inner); return; }
      case "while": case "do": walk(s.body, loop(s.cond)); return;
      case "for": { const inner = loop(s.cond); walk(s.body, inner); walk(s.update, inner); return; }
      // A for loop with bounds known when built, written out turn by turn: still a loop to a break or a continue.
      case "unrolled": { const inner = loop(null); for (const it of s.iterations) walk(it, inner); return; }
      case "switch": {
        const o = nested(s.value);
        const why = o ?? whole.get(s) ?? null;
        const note = o ? ctx.note : why ? LEFT_EARLY.switch : undefined;
        for (const c of s.cases) walk(c.body, { ...ctx, under: why, note, breaks: s, breaksLocal: why !== null });
        return;
      }
      case "block": walk(s.body, ctx); return;
      case "try": walk(s.body, ctx); walk(s.catch, ctx); return;
      case "parallel": if (L) fail(s.at, need("Waiting on several things at once", L)); for (const b of s.branches) walk(b, ctx); return;
      // Leaving early under a Local test: what is left goes on differently from computer to computer, so it is walked
      // again as a whole under the test, and what it does there is said where it does it.
      case "break": if (L && !ctx.breaksLocal) leave(ctx.breaks, L); return;
      case "continue": if (L && !ctx.continuesLocal) leave(ctx.continues, L); return;
      case "return": {
        if (L && !ctx.returnsLocal) leave(ctx.returns, L);
        if (s.value && ctx.result) { const o = by(s.value); if (o) mark(ctx.result, o); }
        return;
      }
      case "sleep": if (L) fail(s.at, need("Waiting", L, "each computer would go on at a different frame")); return;
      case "cancel": if (L) fail(s.at, need("Cancelling a task", L)); return;
      case "throw": case "uncaught": if (L) fail(s.at, need("Throwing", L)); return;
      case "syncSend": if (L) fail(s.at, need("sync()", L, "every computer has to reach the same sync() — test the value after it arrives instead")); return;
      case "action": {
        if (SHOWN.has(s.record.type)) return;
        const name = Object.entries(ActionType).find(([, v]) => v === s.record.type)?.[0];
        sink(name ? `${name[0].toLowerCase()}${name.slice(1)}()` : "This action", s.variables?.map((v) => v.expr), s.text);
        return;
      }
      case "print": return;
      case "buildText": { const o = by(s.parts); if (o) mark(s.buffer, o); return; }
      case "centerLocation": sink("Moving a location", s.x, s.y, s.size); return;
      case "unitWrite": sink("Changing a unit", s.unit, s.value); return;
      case "unitDo": sink("This order to a unit", s.unit, s.verb); return;
      case "tableWrite": if (!localMemoryAt(s.cell.base)) sink("Writing the game's tables", s.value); return;
      case "remark": return;
    }
  };

  const run = () => {
    const top = whole.get(program) ?? null;
    walk(program.body, { under: top, ...(top ? { note: LEFT_EARLY.program } : {}), returns: program, returnsLocal: top !== null });
    for (const f of program.functions ?? []) {
      const called = under.get(f.id) ?? null;
      const why = called ?? whole.get(f) ?? null;
      const note = called ? `${f.name} is called under that test` : why ? LEFT_EARLY.return : undefined;
      walk(f.body, { under: why, ...(note ? { note } : {}), returns: f, returnsLocal: why !== null, ...(f.result ? { result: f.result.decl.id } : {}) });
    }
  };
  for (let round = 0; round < 64; round++) { changed = false; run(); if (!changed) break; }
  report = true;
  run();
  return { errors: [...errors.values()], locals: [...locals.keys()] };
}

/** Why a part is walked whole under a Local test that is not written around it. */
const LEFT_EARLY = {
  loop: "a break or continue under that test leaves this loop on some computers and not others, so all of it goes on differently",
  switch: "a break under that test leaves this switch on some computers and not others",
  return: "a return under that test leaves this function on some computers and not others, so all of it goes on differently",
  program: "a return under that test ends the program on some computers and not others",
};

/** The words for something done under a test of a Local value. */
function words(what: string, why: string, because = "it would happen on some players' computers and not others, and split the game", note?: string): string {
  return `${what} under a test of ${why}, which only this computer knows (a Local value)${note ? ` — ${note}` : ""}: ${because}. Only what is shown (print, ui.lines, a sound, the camera) may depend on it; to act on it, send it to every computer first: const v = await sync(P1, …), then test v.`;
}
