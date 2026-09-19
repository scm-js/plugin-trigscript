/**
 * The program interpreter: runs `program()` bodies from the IR, one player, frame by
 * frame. It is what Simulate shows and what the tests prove programs with; the model is
 * the Python lowering's (`python/trigscript.py`), which is what the game runs.
 *
 * A program is a coroutine the game resumes every frame. Its body runs until it sleeps or
 * ends: loops run to completion within the frame, only `sleep` gives the frame back
 * (`sleep(frames(n))` is n frames, `seconds` at twenty-four a second), and a program whose
 * body ends stops for good. With eudTurbo the game's own trigger loop runs every frame
 * too, so a frame here is also one cycle of the `trigger()` records run beside the programs.
 *
 * Numbers keep the one contract: 32 bits, signed unless the variable is a `u32`, wrapping
 * at either end as `x | 0` does; a `u8` / `u16` stops at 0 and at its maximum. The world — death
 * counters the script names, switches, the conditions the interpreter cannot answer,
 * the strings — is a trigger `Simulation`, shared with any `trigger()` records run beside
 * the programs, so an action a program takes is seen by a hand trigger and the other way
 * round.
 *
 * Units are a list the caller supplies (`units`, the map's placed ones in the editor), in the
 * order of the game's unit table, with the map's locations as boxes (`locations`). A loop
 * over units, a pick and every field and verb work on that list; a unit that is killed or
 * removed is gone from the next line on. What the simulation does not model is the game
 * itself: nothing moves, nothing fights, `createUnit` makes no unit. The game's tables
 * (`stats()`) hold what the program wrote and otherwise what `table` answers, else 0.
 *
 * What the players do is fed in by the caller: `press`, `click`, `type` and `moveMouse` say what
 * the next frame finds. A key, a click and a typed line last that one frame, as they do in the
 * game; the mouse stays where it was put.
 */
import { ActionType, Comparison, ConditionType, SetModifier, SWITCH_COUNT, SwitchAction, SwitchState, type ActionRecord, type ConditionRecord } from "../vendor/triggers";
import { emptyAction, PlayerGroup, ResourceType } from "../vendor/triggers";
import { HEAP_CELLS, HEAP_SMALLEST, STACK_DEPTH, TEXT_BYTES, TEXT_FIELD_BYTES, heapCells, isTextExpr, stackDepth } from "./ir";
import type { TextExpr, ArrayDecl, At, BoolExpr, Call, NumExpr, Program, ReadSource, Stmt, TableCell, TextPart, UnitExpr, UnitFilter, UnitNumField, UnitVerb, VarDecl } from "./ir";
import { cellMax } from "./tables";
import { inputsOf, keyName, matchChat, parseChatPattern, type ChatPattern, type InputSource, type MouseButton } from "./input";
import { Simulation, type SimulationOptions } from "./simulate";

export const FRAMES_PER_SECOND = 24;
/** What Elapsed Time and the countdown count: a game second is sixteen frames (the slice 2 probe: 21 after 336 frames), not the twenty-four of a second at Fastest. */
export const FRAMES_PER_GAME_SECOND = 16;
const U32 = 0x1_0000_0000;

export interface ProgramEvent {
  /** 0-based frame. */
  cycle: number;
  /** Index of the program in the list. */
  program: number;
  at: At;
  action: ActionRecord;
  text?: string;
}

/** A unit of the simulated game. Hit points, shields and energy in whole points. */
export interface SimUnit {
  type: number; owner: number; x: number; y: number;
  hp: number; maxHp: number; shields: number; maxShields: number; energy: number;
  kills: number; orderId: number; cooldown: number; resources: number;
  stim: number; ensnare: number; plague: number; lockdown: number; maelstrom: number; irradiate: number; stasis: number;
  hallucinated: boolean; cloaked: boolean; burrowed: boolean; invincible: boolean; underAttack: boolean;
  /** Still on the map. */
  alive: boolean;
}
export type SimUnitInit = Partial<Omit<SimUnit, "alive">> & { type: number; owner: number };
export interface SimBounds { left: number; top: number; right: number; bottom: number }

const newUnit = (u: SimUnitInit): SimUnit => {
  const hp = u.hp ?? u.maxHp ?? 1;
  const shields = u.shields ?? u.maxShields ?? 0;
  return {
    x: 0, y: 0, energy: 0, kills: 0, orderId: 3, cooldown: 0, resources: 0,
    stim: 0, ensnare: 0, plague: 0, lockdown: 0, maelstrom: 0, irradiate: 0, stasis: 0,
    hallucinated: false, cloaked: false, burrowed: false, invincible: false, underAttack: false,
    ...u, hp, maxHp: u.maxHp ?? hp, shields, maxShields: u.maxShields ?? shields, alive: true,
  };
};

/** The most a field of a unit holds: a byte for the timers, the cooldown and the kills, 255 points of energy, a word of resources. */
const UNIT_FIELD_MAX: Partial<Record<UnitNumField, number>> = { hp: 0xff_ffff, shields: 0xff_ffff, energy: 255, kills: 255, cooldown: 255, resources: 0xffff, stim: 255, ensnare: 255, plague: 255, lockdown: 255, maelstrom: 255, irradiate: 255, stasis: 255 };
/** The production buildings a trigger's "Factories" class counts. */
const FACTORIES: ReadonlySet<number> = new Set([106, 111, 113, 114, 131, 132, 133, 154, 155, 160, 167]);
const inClass = (type: number, cls: number): boolean => (cls === 230 ? type < 106 : cls === 231 ? type >= 106 && type <= 202 : FACTORIES.has(type));

export interface ProgramSimulationOptions extends Pick<SimulationOptions, "player" | "condition" | "random" | "strings"> {
  /** The trigger interpreter holding the world; one is made when absent. */
  world?: Simulation;
  /** A runaway guard: statements one program may run in one frame; default 100 000. */
  maxStepsPerCycle?: number;
  /**
   * What a read finds, for the values the simulation does not hold itself (unit counts, kills,
   * scores, the clocks, the player tables). Undefined falls back to the simulation's own answer:
   * deaths and resources from its world, the simulated player a human, 0 for the rest.
   */
  read?: (read: ReadSource, sim: ProgramSimulation) => number | undefined;
  /** A player's name in a printed text; default "Player 1" … */
  playerName?: (player: number) => string;
  /** The units on the map, in the order of the game's unit table. */
  units?: SimUnitInit[];
  /** The map's locations as boxes, by their 1-based number. A location the simulation does not know holds every unit. */
  locations?: Record<number, SimBounds>;
  /** What a cell of the game's tables holds before the program writes it, in the script's units (points, seconds); default 0. */
  table?: (cell: TableCell) => number | undefined;
  /** Whether a unit type is of a trigger class (230 Men, 231 Buildings, 232 Factories); default by id range. */
  unitClass?: (type: number, cls: number) => boolean;
  /** The cells of the heap the programs' growing arrays share: the map's script setting; default `HEAP_CELLS`. */
  heapCells?: number;
  /** How many calls deep a function that calls itself may go: the map's script setting; default `STACK_DEPTH`. */
  stackDepth?: number;
  /** The unit type a name typed in chat means, the name in lower case: what a `{…:unit}` capture asks. Default: no name is known. */
  unitByName?: (lower: string) => number | undefined;
}

type Flow = "next" | "break" | "continue" | "return";
type Exec = Gen<Flow>;
type Value = number | boolean;
/**
 * A piece of a program's run. What it yields is the frame (`undefined`: a sleep, and the rest of the run waits for the
 * next frame) or a body to be run apart from it (`Apart`), whose outcome is what the `yield` then evaluates to.
 */
type Gen<T> = Generator<Apart | undefined, T, unknown>;
/**
 * The body of a call that may come back into its own function, handed to the run's loop (`ProgramRun.drive`) instead
 * of being run inside the caller: each `yield*` is a frame of JavaScript's own stack, a thousand calls deep would be
 * ten thousand of those, and the browser's stack ends long before the map's does.
 */
interface Apart { run: Exec }

interface Ctx {
  /** Inside an inlined call: where `return` writes. */
  fn?: { result?: VarDecl };
}

class Halt extends Error {}
/** The program stops for good, as the game stops it: its stack ran out. Said as a fault where it happened. */
class Stopped extends Error {}

/** One program's run: its variables, its latches, and the coroutine that is its body. */
/** What a recursive function holds, kept for the length of a call that may come back into it. */
interface Frame {
  vars: [string, Value][];
  units: [string, SimUnit | null][];
  arrays: { a: { decl: ArrayDecl; cells: Value[]; room: number }; cells: Value[]; room: number }[];
}

/** A text a variable holds: the characters, and the cells of the block of the heap it owns (0: it owns none — a text of the map's table). */
interface HeldText { s: string; room: number }
/** A text as an expression gives it. `taken`: the block is the value's own — nothing else holds it — so what receives the value keeps the block or gives it back; a variable's is only looked at. */
interface TextValue extends HeldText { taken: boolean }

const UTF8 = new TextEncoder();
/** The bytes a text is in the game, where it is UTF-8. */
const bytesOf = (s: string): number => UTF8.encode(s).length;
/** The cells of the block a made text of that many bytes takes: one that says the block's size, the bytes four to a cell, the text's end. */
export function textRoom(bytes: number): number {
  let room = HEAP_SMALLEST;
  while (room < Math.floor(bytes / 4) + 2) room *= 2;
  return room;
}
/** A text cut to at most `bytes` bytes, never inside a character. */
function cutTo(s: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = bytesOf(ch);
    if (used + n > bytes) break;
    out += ch;
    used += n;
  }
  return out;
}
/** Two texts by the numbers of their characters, as the game compares their bytes (UTF-8 keeps that order): below zero, zero, above. */
function compareTexts(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) { const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
}

/** An array's cells, and the room its block has when it is one that grows. */
interface Held { decl: ArrayDecl; cells: Value[]; room: number }

class ProgramRun {
  readonly vars = new Map<string, Value>();
  /** The variables that hold a unit, or none. */
  readonly unitVars = new Map<string, SimUnit | null>();
  /** The variables that hold a text. */
  readonly textVars = new Map<string, HeldText>();
  readonly bits = new Map<string, 8 | 16>();
  /** The `u32` variables. */
  readonly unsigned = new Set<string>();
  readonly latches = new Map<object, boolean>();
  /** The program's arrays: their cells, as a variable's value is kept. */
  readonly arrays: Map<string, Held> = new (class extends Map<string, Held> {
    run!: ProgramRun;
    /** An array that grows inside another is found through the outer one's cells, every time it is asked for. */
    override get(id: string): Held | undefined { const a = super.get(id); return a?.decl.through ? this.run.inner(a.decl, (k) => super.get(k)) : a; }
  })();
  body: Exec | null;
  done = false;
  steps = 0;
  /** How many calls deep the program is in functions that call themselves: frames on the stack. Nothing is on it between frames. */
  depth = 0;
  /** The bodies being run apart from the one that called them, innermost last (`Apart`). */
  private readonly apart: Exec[] = [];
  readonly sim: ProgramSimulation;
  readonly index: number;
  readonly program: Program;

  constructor(sim: ProgramSimulation, index: number, program: Program) {
    this.sim = sim;
    this.index = index;
    this.program = program;
    (this.arrays as unknown as { run: ProgramRun }).run = this;
    for (const decl of program.arrays ?? []) this.arrays.set(decl.id, { decl, room: 0, cells: decl.values ? [...decl.values] : decl.dynamic ? [] : new Array<Value>(decl.length).fill(decl.kind === "number" ? 0 : false) });
    this.body = this.run();
  }

  private *run(): Exec {
    const flow = yield* this.block(this.program.body, {});
    void flow;
    return "next";
  }

  /** One frame: resume the body until it gives the frame back or ends. */
  tick(): void {
    if (this.done || !this.body) return;
    this.steps = 0;
    try {
      if (this.drive()) { this.done = true; this.body = null; }
    } catch (err) {
      this.apart.length = 0;
      if (!(err instanceof Stopped)) throw err;
      this.done = true;
      this.body = null;
      this.depth = 0;
    }
  }

  /** The run until it gives the frame back (false) or ends (true): the body, and above it each body that was handed over to be run apart. */
  private drive(): boolean {
    let send: unknown;
    for (;;) {
      const top = this.apart[this.apart.length - 1] ?? this.body!;
      const r = top.next(send);
      send = undefined;
      if (r.done) {
        if (!this.apart.length) return true;
        this.apart.pop();
        send = r.value;
      } else if (r.value === undefined) return false;
      else this.apart.push(r.value.run);
    }
  }

  private step(): void {
    if (++this.steps > this.sim.maxSteps) throw new Halt(`A program ran more than ${this.sim.maxSteps} statements in one frame: is there a loop with no sleep() in it?`);
  }

  /* ── storage ── */

  private read(id: string, at?: At): Value {
    const v = this.vars.get(id);
    if (v === undefined) throw new Error(`The variable ${id} was read before it was declared${at ? ` (line ${at.line})` : ""}.`);
    return v;
  }

  /** A number is kept as its type reads the 32 bits: a `u32` 0 and up, a `u8` / `u16` stopped at its top, anything else signed. */
  private store(id: string, value: Value): void {
    if (typeof value === "number") {
      const bits = this.bits.get(id);
      this.vars.set(id, bits ? Math.min(value >>> 0, 2 ** bits - 1) : this.unsigned.has(id) ? value >>> 0 : value | 0);
    } else {
      this.vars.set(id, value);
    }
  }

  /** A value as a cell of its type keeps it: a `u32` from 0 up, a `u8` / `u16` stopped at its top, anything else signed. */
  private kept(value: Value, type: { bits?: 8 | 16; unsigned?: boolean }): Value {
    if (typeof value !== "number") return value;
    return type.bits ? Math.min(value >>> 0, 2 ** type.bits - 1) : type.unsigned ? value >>> 0 : value | 0;
  }

  /**
   * The cell an index names, or undefined past either end — where the game reads 0 and drops a store without a word.
   * Here it is said (`faults`): an index off the end is a mistake in every script that has one.
   */
  private *cell(array: string, index: NumExpr, at: At, what: string): Gen<{ cells: Value[]; decl: ArrayDecl; i: number } | undefined> {
    const a = this.arrays.get(array);
    if (!a) throw new Error(`The array ${array} is not one of the program's (line ${at.line}).`);
    const i = yield* this.num(index);
    if (a.decl.slice) {
      // A window on another array: inside its own ends, and inside those of what it is a window on.
      const of = this.arrays.get(a.decl.slice.of);
      if (!of) throw new Error(`The array ${a.decl.slice.of} is not one of the program's (line ${at.line}).`);
      const j = (Number(this.read(a.decl.slice.offset)) | 0) + i;
      if (i >= 0 && i < a.decl.length && j >= 0 && j < (of.decl.dynamic ? of.cells.length : of.decl.length)) return { decl: a.decl, cells: of.cells, i: j };
      this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `${a.decl.name}[${i}] is past the end of the row (its length is ${a.decl.length}): ${what}.` });
      return undefined;
    }
    const length = a.decl.dynamic ? a.cells.length : a.decl.length;
    if (i >= 0 && i < length) return { ...a, i };
    this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `${a.decl.name}[${i}] is past the end of the array (its length is ${length}): ${what}.` });
    return undefined;
  }

  /**
   * Room for `cells` in a growing array, as the game finds it (`python/trigscript.py`): a block twice the size from the
   * heap, the old one given back. False, and said once, when the heap has none left.
   */
  private grow(a: { decl: ArrayDecl; cells: Value[]; room: number }, cells: number, at: At): boolean {
    if (cells <= a.room) return true;
    let room = Math.max(a.room, HEAP_SMALLEST);
    while (room < cells) room *= 2;
    if (!this.sim.heap.take(room)) {
      this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `Out of memory: ${a.decl.name} could not grow to ${cells} cells (the heap the programs' arrays share is ${this.sim.heap.cells} cells; the script's settings set it).` });
      return false;
    }
    if (a.room) this.sim.heap.give(a.room);
    a.room = room;
    return true;
  }

  /**
   * The array a handle in another's cells leads to (`ArrayDecl.through`). The cell holds a number that stands for the
   * block — nothing yet is 0, and the first use makes one, as the game's first push does. A number whose block was given
   * back (the row was popped, and this is a copy of its handle kept somewhere) leads nowhere: in the game that is some
   * other array's cells by now, and here it is said.
   */
  inner(decl: ArrayDecl, plain: (id: string) => Held | undefined, release = false): Held {
    const nothing = (): Held => ({ decl, cells: [], room: 0 });
    const ptrs = plain(decl.through!.ptr);
    const i = Number(this.read(decl.through!.index)) | 0;
    if (!ptrs || i < 0 || i >= ptrs.cells.length) return nothing();
    const ptr = Number(ptrs.cells[i]);
    if (release) {
      const held = this.sim.inner.get(ptr);
      if (held?.room) this.sim.heap.give(held.room);
      this.sim.inner.delete(ptr);
      ptrs.cells[i] = 0;
      return nothing();
    }
    if (!ptr) { const made: Held = { decl, cells: [], room: 0 }; ptrs.cells[i] = ++this.sim.lastInner; this.sim.inner.set(this.sim.lastInner, made); return made; }
    const held = this.sim.inner.get(ptr);
    if (!held) { this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at: decl.at, message: `${decl.name} was given back — the row that held it was popped, cut off or declared again — and this is a copy of its handle: in the game it reads whatever has the block now.` }); return nothing(); }
    held.decl = decl;
    return held;
  }

  private declare(decl: VarDecl): void {
    if (decl.kind === "unit") { this.unitVars.set(decl.id, null); return; }
    // A text declared again keeps what it held until the new one is put in it, which is when its block goes back.
    if (decl.kind === "text") { if (!this.textVars.has(decl.id)) this.textVars.set(decl.id, { s: "", room: 0 }); return; }
    if (decl.bits) this.bits.set(decl.id, decl.bits);
    if (decl.unsigned) this.unsigned.add(decl.id);
    this.vars.set(decl.id, decl.kind === "number" ? 0 : false);
  }

  /* ── units ── */

  /** The unit an expression names; null for none. A unit that has died is still the value — what reads it finds it gone. */
  private *unit(e: UnitExpr): Gen<SimUnit | null> {
    switch (e.kind) {
      case "unitNull": return null;
      case "unitVar": return this.unitVars.get(e.id) ?? null;
      case "pick": return this.sim.pick(e.by, e.filter, e.near, e.mouse, e.within);
      // A kept unit is its place in the list, from 1: there is no slot to be reused here, so the three numbers are one.
      case "unitAt": { const ptr = (yield* this.num(e.ptr)) >>> 0; yield* this.num(e.epd); yield* this.num(e.uid); return ptr >= 1 ? this.sim.units[ptr - 1] ?? null : null; }
      case "call": { yield* this.call(e.call); return e.call.result ? this.unitVars.get(e.call.result.decl.id) ?? null : null; }
    }
  }

  /** The unit, when there is one and it is still on the map. */
  private *living(e: UnitExpr): Gen<SimUnit | null> {
    const u = yield* this.unit(e);
    return u?.alive ? u : null;
  }

  private *unitDo(e: UnitExpr, verb: UnitVerb, at: At): Gen<void> {
    const u = yield* this.living(e);
    // The amount is computed whether or not there is a unit, as the game computes it.
    const amount = verb.do === "damage" || verb.do === "heal" ? yield* this.amount(verb.amount) : 0;
    if (!u) return;
    switch (verb.do) {
      case "kill": case "remove": u.alive = false; this.sim.unitEvent(this, verb.do === "kill" ? ActionType.KillUnit : ActionType.RemoveUnit, u, at); break;
      case "give": u.owner = verb.to === PlayerGroup.CurrentPlayer ? this.sim.player : verb.to; break;
      case "order": this.sim.unitEvent(this, ActionType.Order, u, at, { location: verb.target, text: verb.order }); break;
      case "locate": this.sim.centre(verb.location, u.x, u.y); break;
      case "damage": case "heal": {
        // In the game's own units, 256 to a point, as the lowering computes it.
        const step = verb.percent ? Math.floor((u.maxHp * 256 * amount) / 100) : amount * 256;
        const raw = verb.do === "damage" ? Math.max(0, u.hp * 256 - step) : Math.min(u.maxHp * 256, u.hp * 256 + step);
        u.hp = Math.ceil(raw / 256);
        if (u.hp === 0) { u.alive = false; this.sim.unitEvent(this, ActionType.KillUnit, u, at); }
        break;
      }
    }
  }

  /* ── expressions ── */

  /**
   * A number, the way the game computes it (`python/trigscript.py`): 32 bits, given here as the
   * signed reading of them (`| 0`). + − × and the bitwise operators are the same bits whichever
   * way they are read; what reads them one way or the other — ÷, %, a shift right, min and max, a
   * comparison — says which in the IR. A divisor of 0 gives 0, as `(a / 0) | 0` does.
   */
  private *num(e: NumExpr): Gen<number> {
    switch (e.kind) {
      case "const": return e.value | 0;
      case "var": return Number(this.read(e.id)) | 0;
      case "element": { const c = yield* this.cell(e.array, e.index, e.at, "it reads 0"); return c ? Number(c.cells[c.i]) | 0 : 0; }
      case "length": return this.arrays.get(e.array)?.cells.length ?? 0;
      case "pop": return Number(this.arrays.get(e.array)?.cells.pop() ?? 0) | 0;
      case "unary": return -(yield* this.num(e.expr)) | 0;
      case "cast": return yield* this.num(e.expr);
      case "binary": {
        const a = yield* this.num(e.left);
        const b = yield* this.num(e.right);
        switch (e.op) {
          case "+": return (a + b) | 0;
          case "-": return (a - b) | 0;
          case "*": return Math.imul(a, b);
          case "/": return b === 0 ? 0 : e.unsigned ? Math.floor((a >>> 0) / (b >>> 0)) | 0 : (a / b) | 0;
          case "%": return b === 0 ? 0 : e.unsigned ? ((a >>> 0) % (b >>> 0)) | 0 : (a % b) | 0;
          case "&": return a & b;
          case "|": return a | b;
          case "^": return a ^ b;
          // A shift by 32 or more (or by a number below zero) leaves nothing but the sign, where JavaScript would shift by the remainder.
          case "<<": return b >>> 0 >= 32 ? 0 : a << b;
          case ">>": return b >>> 0 >= 32 ? (a < 0 ? -1 : 0) : a >> b;
          case ">>>": return b >>> 0 >= 32 ? 0 : (a >>> b) | 0;
        }
        return 0;
      }
      case "read": return this.sim.read(e.read) | 0;
      case "unitField": { const u = yield* this.living(e.unit); return u ? u[e.field] | 0 : 0; }
      case "unitPart": { const u = yield* this.unit(e.unit); return u ? this.sim.units.indexOf(u) + 1 : 0; }
      case "tableRead": return this.sim.tableRead(e.cell) | 0;
      case "input": return this.sim.input(e.input) | 0;
      case "randomInt": {
        const n = (yield* this.num(e.bound)) >>> 0;
        return n === 0 ? 0 : Math.min(n - 1, Math.floor(this.sim.random() * n)) | 0;
      }
      case "ternary": return (yield* this.bool(e.cond)) ? yield* this.num(e.whenTrue) : yield* this.num(e.whenFalse);
      case "intrinsic": {
        const args: number[] = [];
        for (const a of e.args) args.push(yield* this.num(a));
        if (e.name === "abs") return Math.abs(args[0]) | 0;
        const seen = e.unsigned ? args.map((a) => a >>> 0) : args;
        return (e.name === "min" ? Math.min(...seen) : Math.max(...seen)) | 0;
      }
      case "call": return Number(yield* this.call(e.call)) | 0;
      case "textLength": { const t = yield* this.text(e.of); this.used(t); return [...t.s].length; }
      case "textIndexOf": {
        const t = yield* this.text(e.of);
        const find = yield* this.text(e.find);
        const from = e.from ? Math.max(0, yield* this.num(e.from)) : 0;
        this.used(t, find);
        const chars = [...t.s];
        const at = t.s.indexOf(find.s, chars.slice(0, from).join("").length);
        return at < 0 || from > chars.length ? (find.s === "" && from <= chars.length ? from : -1) : [...t.s.slice(0, at)].length;
      }
      case "textCode": { const t = yield* this.text(e.of); const i = yield* this.num(e.index); this.used(t); return [...t.s][i]?.codePointAt(0) ?? -1; }
    }
  }

  /* ── texts ── */

  /**
   * A text that was just made, as the game keeps it (`python/trigscript.py`): past `TEXT_BYTES` it is cut, and its
   * bytes go into a block of the heap. When the heap has none, the text is empty — and both are said.
   */
  private made(s: string, at: At, cameTo = bytesOf(s)): TextValue {
    if (bytesOf(s) > TEXT_BYTES) {
      this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `This text came to ${cameTo.toLocaleString("en-US")} bytes, and a text that is made holds ${TEXT_BYTES.toLocaleString("en-US")}: it is cut off there, as it is in the game.` });
      s = cutTo(s, TEXT_BYTES);
    }
    const room = textRoom(bytesOf(s));
    if (!this.sim.heap.take(room)) {
      this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `Out of memory: no room for this text (the heap the programs' arrays and texts share is ${this.sim.heap.cells} cells; the script's settings set it). It is empty instead, as it is in the game.` });
      return { s: "", room: 0, taken: true };
    }
    return { s, room, taken: true };
  }

  /** Values that have been used: a block that was the value's own goes back to the heap. */
  private used(...values: TextValue[]): void {
    for (const v of values) if (v.taken && v.room) this.sim.heap.give(v.room);
  }

  /** A value as something to keep: its own block as it is, a copy of a variable's. */
  private owned(v: TextValue, at: At): HeldText {
    if (v.taken || !v.room) return { s: v.s, room: v.room };
    const copy = this.made(v.s, at);
    return { s: copy.s, room: copy.room };
  }

  private *parts(parts: TextPart[], used: TextValue[]): Gen<string> {
    let out = "";
    for (const p of parts) {
      if (p.kind === "number") out += String(p.unsigned ? yield* this.amount(p.expr) : yield* this.num(p.expr));
      else if (p.kind === "value") { const v = yield* this.text(p.text); used.push(v); out += v.s; }
      else out += this.sim.partText(p);
    }
    return out;
  }

  private *text(e: TextExpr): Gen<TextValue> {
    switch (e.kind) {
      case "text": return { s: e.text, room: 0, taken: true };
      case "textVar": { const v = this.textVars.get(e.id); if (!v) throw new Error(`The variable ${e.id} was read before it was declared.`); return { ...v, taken: false }; }
      case "textOf": {
        const a = this.arrays.get(e.array);
        const i = yield* this.num(e.index);
        const found = a?.decl.texts?.[i];
        if (found === undefined) this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at: e.at, message: `${a?.decl.name ?? e.array}[${i}] is past the end of the list (its length is ${a?.decl.texts?.length ?? 0}): it reads an empty text.` });
        return { s: found ?? "", room: 0, taken: true };
      }
      case "template": {
        const used: TextValue[] = [];
        const s = yield* this.parts(e.parts, used);
        const out = this.made(s, e.at);
        this.used(...used);
        return out;
      }
      case "textTernary": {
        const v = (yield* this.bool(e.cond)) ? yield* this.text(e.whenTrue) : yield* this.text(e.whenFalse);
        return { ...this.owned(v, e.at), taken: true };
      }
      case "textSlice": {
        const of = yield* this.text(e.of);
        const chars = [...of.s];
        const start = e.start ? Math.min(chars.length, Math.max(0, yield* this.num(e.start))) : 0;
        const end = e.end ? Math.min(chars.length, Math.max(0, yield* this.num(e.end))) : chars.length;
        const out = this.made(chars.slice(start, Math.max(start, end)).join(""), e.at);
        this.used(of);
        return out;
      }
      case "textPad": {
        const of = yield* this.text(e.of);
        const width = yield* this.num(e.width);
        const fill = yield* this.text(e.with);
        const chars = [...of.s], pad = [...fill.s];
        let padding = "";
        if (pad.length) for (let i = 0; chars.length + i < width; i++) padding += pad[i % pad.length];
        const out = this.made(e.side === "start" ? padding + of.s : of.s + padding, e.at);
        this.used(of, fill);
        return out;
      }
      case "textRepeat": {
        const of = yield* this.text(e.of);
        const n = yield* this.num(e.count);
        // Past what a text holds there is nothing more to see of it, and JavaScript would run out long before.
        const out = this.made(n >= 1 ? of.s.repeat(Math.min(n, Math.ceil((TEXT_BYTES + 1) / Math.max(1, bytesOf(of.s))))) : "", e.at, Math.max(0, n) * bytesOf(of.s));
        this.used(of);
        return out;
      }
      case "textCall": {
        yield* this.call(e.call);
        const held = e.call.result ? this.textVars.get(e.call.result.decl.id) : undefined;
        if (!held) return { s: "", room: 0, taken: true };
        // Taken out of the call's result, which holds no block from here on.
        const out: TextValue = { ...held, taken: true };
        held.room = 0;
        return out;
      }
    }
  }

  /** A text into a variable: worked out first, then what the variable held goes back. */
  private *putText(id: string, e: TextExpr, at: At): Gen<void> {
    const v = this.owned(yield* this.text(e), at);
    const old = this.textVars.get(id);
    if (old?.room) this.sim.heap.give(old.room);
    this.textVars.set(id, v);
  }

  /** A made text where the game shows at most `TEXT_FIELD_BYTES` of one: an action's field, a unit type's name. */
  private shown(v: TextValue, at: At, where: string): string {
    if (!v.room || bytesOf(v.s) <= TEXT_FIELD_BYTES) return v.s;
    this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at, message: `This text is ${bytesOf(v.s)} bytes, and ${where} shows ${TEXT_FIELD_BYTES} of a text that was made: it is cut off there, as it is in the game.` });
    return cutTo(v.s, TEXT_FIELD_BYTES);
  }

  /** A number as the game takes one: the 32 bits from 0 up. What goes to a unit, a table, an action or the map is never below zero by then (the compiler saw to it). */
  private *amount(e: NumExpr): Gen<number> {
    return (yield* this.num(e)) >>> 0;
  }

  private *bool(e: BoolExpr): Gen<boolean> {
    switch (e.kind) {
      case "const": return e.value;
      case "cond": return this.sim.condition(e.record);
      case "var": return Boolean(this.read(e.id));
      case "element": { const c = yield* this.cell(e.array, e.index, e.at, "it reads false"); return c ? Boolean(c.cells[c.i]) : false; }
      case "pop": return Boolean(this.arrays.get(e.array)?.cells.pop() ?? false);
      case "test": return (yield* this.num(e.expr)) !== 0;
      case "compare": {
        let a = yield* this.num(e.left);
        let b = yield* this.num(e.right);
        // Each side as its type reads it: a number below zero is smaller than any u32.
        if (e.unsigned === true || e.unsigned === "left") a = a >>> 0;
        if (e.unsigned === true || e.unsigned === "right") b = b >>> 0;
        switch (e.op) {
          case "<": return a < b;
          case "<=": return a <= b;
          case ">": return a > b;
          case ">=": return a >= b;
          case "==": return a === b;
          case "!=": return a !== b;
        }
        return false;
      }
      case "and": { for (const i of e.items) if (!(yield* this.bool(i))) return false; return true; }
      case "or": { for (const i of e.items) if (yield* this.bool(i)) return true; return false; }
      case "not": return !(yield* this.bool(e.expr));
      case "random": return this.sim.random() < 0.5;
      case "unitAlive": return (yield* this.living(e.unit)) !== null;
      case "unitSame": { const a = yield* this.unit(e.left); const b = yield* this.unit(e.right); return a !== null && a === b; }
      case "unitFlag": { const u = yield* this.living(e.unit); return u ? u[e.flag] : false; }
      case "edge": {
        const held = yield* this.bool(e.cond);
        const was = this.latches.get(e) ?? false;
        if (held) {
          if (was) return false;
          this.latches.set(e, true);
          return true;
        }
        if (e.edge === "rose") this.latches.set(e, false);
        return false;
      }
      case "ternary": return (yield* this.bool(e.cond)) ? yield* this.bool(e.whenTrue) : yield* this.bool(e.whenFalse);
      case "call": return Boolean(yield* this.call(e.call));
      case "textCompare": {
        const a = yield* this.text(e.left);
        const b = yield* this.text(e.right);
        this.used(a, b);
        const d = compareTexts(a.s, b.s);
        return e.op === "==" ? d === 0 : e.op === "!=" ? d !== 0 : e.op === "<" ? d < 0 : e.op === "<=" ? d <= 0 : e.op === ">" ? d > 0 : d >= 0;
      }
      case "textTest": {
        const of = yield* this.text(e.of);
        const find = yield* this.text(e.find);
        this.used(of, find);
        return e.test === "startsWith" ? of.s.startsWith(find.s) : e.test === "endsWith" ? of.s.endsWith(find.s) : of.s.includes(find.s);
      }
    }
  }

  private *init(e: NumExpr | BoolExpr, kind: "number" | "boolean"): Gen<Value> {
    return kind === "number" ? yield* this.num(e as NumExpr) : yield* this.bool(e as BoolExpr);
  }

  /** A declaration's, a parameter's or a return's value into its variable, whatever it holds. */
  private *put(decl: { id: string; kind: VarDecl["kind"]; at?: At }, e: NumExpr | BoolExpr | UnitExpr | TextExpr, at?: At): Gen<void> {
    if (decl.kind === "text" || isTextExpr(e)) { yield* this.putText(decl.id, e as TextExpr, at ?? decl.at ?? { file: "", line: 0, column: 0 }); return; }
    if (decl.kind === "unit") this.unitVars.set(decl.id, yield* this.unit(e as UnitExpr));
    else this.store(decl.id, yield* this.init(e as NumExpr | BoolExpr, decl.kind));
  }

  private *call(c: Call): Gen<Value> {
    if (c.result) this.declare(c.result.decl);
    const fn = c.fn ? this.program.functions?.find((f) => f.id === c.fn) : undefined;
    if (c.fn && !fn) throw new Error(`The function ${c.fn} is not one of the program's (line ${c.at.line}).`);
    let kept: Frame | undefined;
    if (fn) {
      // A called function: every argument first — one of them may be a call of the same function — then its parameters, then its one body.
      const values: (Value | SimUnit | null)[] = [];
      for (const p of c.params) values.push(p.decl.kind === "unit" ? yield* this.unit(p.init as UnitExpr) : p.decl.kind === "text" ? 0 : yield* this.init(p.init as NumExpr | BoolExpr, p.decl.kind));
      if (c.saves) kept = this.keep(c);
      c.params.forEach((p, i) => {
        this.declare(p.decl);
        if (p.decl.kind === "unit") this.unitVars.set(p.decl.id, values[i] as SimUnit | null);
        else if (p.decl.kind !== "text") this.store(p.decl.id, values[i] as Value);
      });
    } else {
      for (const p of c.params) {
        this.declare(p.decl);
        yield* this.put(p.decl, p.init);
      }
    }
    const ctx: Ctx = { fn: { result: c.result?.decl } };
    const flow = kept && fn ? ((yield { run: this.block(fn.body, ctx) }) as Flow) : yield* this.block(fn ? fn.body : c.body, ctx);
    if (flow === "break" || flow === "continue") throw new Error(`${flow} inside a function reached its end (line ${c.at.line}).`);
    if (kept) this.bringBack(kept);
    return c.result && c.result.kind !== "unit" && c.result.kind !== "text" ? this.read(c.result.decl.id) : 0;
  }

  /**
   * A call that may come back into the function it is in: what that function holds goes on the stack, as the game
   * keeps it (`python/trigscript.py`) — its variables, and the handle of each array declared in it, which is "no block"
   * for the length of the call. Past the depth the map allows the program stops, and says where.
   */
  private keep(c: Call): Frame {
    const saves = c.saves!;
    if (this.depth >= this.sim.stackDepth) {
      this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at: c.at, message: `Stack overflow in ${saves.within}: ${this.sim.stackDepth.toLocaleString("en-US")} calls deep, which is as deep as the script's settings allow. The program has stopped, as it does in the game.` });
      throw new Stopped();
    }
    this.depth++;
    const frame: Frame = { vars: [], units: [], arrays: [] };
    for (const id of saves.vars) {
      if (this.unitVars.has(id)) frame.units.push([id, this.unitVars.get(id) ?? null]);
      else if (this.vars.has(id)) frame.vars.push([id, this.vars.get(id)!]);
    }
    for (const id of saves.arrays) {
      const a = this.arrays.get(id);
      if (!a) continue;
      frame.arrays.push({ a, cells: a.cells, room: a.room });
      a.cells = [];
      a.room = 0;
    }
    return frame;
  }

  private bringBack(frame: Frame): void {
    for (const [id, v] of frame.vars) this.vars.set(id, v);
    for (const [id, u] of frame.units) this.unitVars.set(id, u);
    for (const k of frame.arrays) {
      // The block the inner run left in the handle goes back to the heap first.
      if (k.a.room) this.sim.heap.give(k.a.room);
      k.a.cells = k.cells;
      k.a.room = k.room;
    }
    this.depth--;
  }

  /* ── statements ── */

  private *block(body: Stmt[], ctx: Ctx): Exec {
    for (const s of body) {
      const flow = yield* this.stmt(s, ctx);
      if (flow !== "next") return flow;
    }
    return "next";
  }

  private *stmt(s: Stmt, ctx: Ctx): Exec {
    this.step();
    switch (s.kind) {
      case "declare": {
        this.declare(s.decl);
        if (!s.failed) yield* this.put(s.decl, s.init);
        return "next";
      }
      case "assignUnit": this.unitVars.set(s.target, yield* this.unit(s.value)); return "next";
      case "assignText": yield* this.putText(s.target, s.value, s.at); return "next";
      case "textLoop": {
        this.declare(s.decl);
        // The text as it is when the loop starts: a copy of a variable's, so that assigning the variable inside changes nothing here.
        const over = this.owned(yield* this.text(s.of), s.at);
        let flow: Flow = "next";
        for (const ch of over.s) {
          const old = this.textVars.get(s.decl.id);
          const turn = this.made(ch, s.at);
          if (old?.room) this.sim.heap.give(old.room);
          this.textVars.set(s.decl.id, { s: turn.s, room: turn.room });
          flow = yield* this.block(s.body, ctx);
          if (flow === "break" || flow === "return") break;
        }
        if (over.room) this.sim.heap.give(over.room);
        return flow === "return" ? flow : "next";
      }
      case "unitLoop": {
        this.declare(s.decl);
        // The units as they are when the loop starts, in table order; one that dies on the way is passed over.
        for (const u of this.sim.matching(s.filter)) {
          if (!u.alive) continue;
          this.unitVars.set(s.decl.id, u);
          const flow = yield* this.block(s.body, ctx);
          if (flow === "break") break;
          if (flow === "return") return flow;
        }
        return "next";
      }
      case "unitWrite": {
        const u = yield* this.living(s.unit);
        const field = s.field;
        if (field === "invincible") { const on = yield* this.bool(s.value as BoolExpr); if (u) u.invincible = on; return "next"; }
        const value = yield* this.amount(s.value as NumExpr);
        if (!u) return "next";
        (u as unknown as Record<string, number>)[field] = Math.min(value, UNIT_FIELD_MAX[field as UnitNumField] ?? 0xffff_ffff);
        if (field === "hp" && u.hp === 0) { u.alive = false; this.sim.unitEvent(this, ActionType.KillUnit, u, s.at); }
        return "next";
      }
      case "unitDo": yield* this.unitDo(s.unit, s.verb, s.at); return "next";
      case "tableWrite": {
        if (isTextExpr(s.value)) { const v = yield* this.text(s.value); this.sim.tableWrite(s.cell, 0, false, this.shown(v, s.at, "a unit type's name")); this.used(v); return "next"; }
        const value = s.boolean ? ((yield* this.bool(s.value as BoolExpr)) ? 1 : 0) : yield* this.amount(s.value as NumExpr);
        this.sim.tableWrite(s.cell, value, s.scaled === true);
        return "next";
      }
      case "assign": this.store(s.target, yield* this.num(s.value)); return "next";
      case "declareArray": {
        const a = this.arrays.get(s.array);
        if (!a) throw new Error(`The array ${s.array} is not one of the program's (line ${s.at.line}).`);
        const value = function* (run: ProgramRun, e: NumExpr | BoolExpr): Gen<Value> { return a.decl.kind === "number" ? yield* run.num(e as NumExpr) : yield* run.bool(e as BoolExpr); };
        if (a.decl.through) {
          // Given back through the outer array's cell, which is 0 again; what it is declared with makes a new one.
          this.inner(a.decl, (k) => Map.prototype.get.call(this.arrays, k) as Held | undefined, true);
          const fresh: Value[] = [];
          for (const e of s.init ?? []) fresh.push(this.kept(yield* value(this, e), a.decl));
          if (fresh.length) { const made = this.arrays.get(s.array)!; if (this.grow(made, fresh.length, s.at)) made.cells.push(...fresh); }
          return "next";
        }
        if (a.decl.dynamic) {
          // Declared again, it gives back the block it held and starts over.
          if (a.room) { this.sim.heap.give(a.room); a.room = 0; }
          a.cells.length = 0;
          const fresh: Value[] = [];
          if (s.fill) { const v = this.kept(yield* value(this, s.fill), a.decl); for (let i = 0; i < a.decl.length; i++) fresh.push(v); }
          else for (const e of s.init ?? []) fresh.push(this.kept(yield* value(this, e), a.decl));
          if (fresh.length === 0 || this.grow(a, fresh.length, s.at)) a.cells.push(...fresh);
          return "next";
        }
        if (s.fill) { const v = this.kept(yield* value(this, s.fill), a.decl); a.cells.fill(v); }
        else for (let i = 0; i < a.decl.length; i++) a.cells[i] = this.kept(s.init?.[i] ? yield* value(this, s.init[i]) : a.decl.kind === "number" ? 0 : false, a.decl);
        return "next";
      }
      case "push": {
        const a = this.arrays.get(s.array);
        if (!a) throw new Error(`The array ${s.array} is not one of the program's (line ${s.at.line}).`);
        const v = a.decl.kind === "boolean" ? yield* this.bool(s.value as BoolExpr) : yield* this.num(s.value as NumExpr);
        if (this.grow(a, a.cells.length + 1, s.at)) a.cells.push(this.kept(v, a.decl));
        return "next";
      }
      case "pop": this.arrays.get(s.array)?.cells.pop(); return "next";
      case "setLength": {
        const a = this.arrays.get(s.array);
        const n = yield* this.amount(s.value);
        if (a && n < a.cells.length) a.cells.length = n;
        return "next";
      }
      case "store": {
        const a = this.arrays.get(s.array);
        const v = a?.decl.kind === "boolean" ? yield* this.bool(s.value as BoolExpr) : yield* this.num(s.value as NumExpr);
        // xs[xs.length] = v is a push, as it is in JavaScript; farther out than that is past the end.
        if (a?.decl.dynamic) {
          const i = yield* this.num(s.index);
          if (i === a.cells.length) { if (this.grow(a, i + 1, s.at)) a.cells.push(this.kept(v, a.decl)); return "next"; }
          if (i >= 0 && i < a.cells.length) a.cells[i] = this.kept(v, a.decl);
          else this.sim.faults.push({ cycle: this.sim.cycle, program: this.index, at: s.at, message: `${a.decl.name}[${i}] is past the end of the array (its length is ${a.cells.length}): nothing is stored.` });
          return "next";
        }
        const c = yield* this.cell(s.array, s.index, s.at, "nothing is stored");
        if (c) c.cells[c.i] = this.kept(v, c.decl);
        return "next";
      }
      case "assignBool": this.store(s.target, yield* this.bool(s.value)); return "next";
      case "if": {
        if (yield* this.bool(s.cond)) return yield* this.block(s.then, ctx);
        return s.else ? yield* this.block(s.else, ctx) : "next";
      }
      case "while": {
        for (;;) {
          if (s.cond && !(yield* this.bool(s.cond))) return "next";
          const flow = yield* this.block(s.body, ctx);
          if (flow === "break") return "next";
          if (flow === "return") return flow;
        }
      }
      case "do": {
        for (;;) {
          const flow = yield* this.block(s.body, ctx);
          if (flow === "break") return "next";
          if (flow === "return") return flow;
          if (!(yield* this.bool(s.cond))) return "next";
        }
      }
      case "for": {
        for (;;) {
          if (s.cond && !(yield* this.bool(s.cond))) return "next";
          const flow = yield* this.block(s.body, ctx);
          if (flow === "break") return "next";
          if (flow === "return") return flow;
          const up = yield* this.block(s.update, ctx);
          if (up === "return") return up;
        }
      }
      case "unrolled": {
        for (const iteration of s.iterations) {
          const flow = yield* this.block(iteration, ctx);
          if (flow === "break") return "next";
          if (flow === "return") return flow;
        }
        return "next";
      }
      case "switch": {
        const v = yield* this.num(s.value);
        let from = s.cases.findIndex((c) => c.value !== null && (c.value | 0) === v);
        if (from < 0) from = s.cases.findIndex((c) => c.value === null);
        if (from < 0) return "next";
        for (let i = from; i < s.cases.length; i++) {
          const flow = yield* this.block(s.cases[i].body, ctx);
          if (flow === "break") return "next";
          if (flow !== "next") return flow;
        }
        return "next";
      }
      case "break": return "break";
      case "continue": return "continue";
      case "return": {
        if (s.value && ctx.fn?.result) yield* this.put(ctx.fn.result, s.value, s.at);
        return "return";
      }
      case "sleep": {
        const n = s.cycles ?? Math.max(1, Math.round((s.ms ?? 0) / 1000 * FRAMES_PER_SECOND));
        for (let i = 0; i < n; i++) yield;
        return "next";
      }
      case "action": {
        const record: ActionRecord = { ...s.record };
        // A unit count is that many units (the game does the action once for each), whatever a byte could hold.
        for (const v of s.variables ?? []) (record as unknown as Record<string, number>)[v.field as string] = yield* this.amount(v.expr);
        if (s.text) { const v = yield* this.text(s.text); this.sim.act(this, record, s.at, this.shown(v, s.at, "this action")); this.used(v); return "next"; }
        this.sim.act(this, record, s.at);
        return "next";
      }
      case "print": {
        const used: TextValue[] = [];
        const text = yield* this.parts(s.parts, used);
        this.used(...used);
        this.sim.print(this, text, s.to, s.at);
        return "next";
      }
      case "centerLocation": { const x = yield* this.amount(s.x); const y = yield* this.amount(s.y); this.sim.centre(s.location, x, y); return "next"; }
      case "call": { yield* this.call(s.call); return "next"; }
      case "block": return yield* this.block(s.body, ctx);
      case "remark": return "next";
    }
  }

  /** The unit a variable holds, by its source name; null for none or a unit that is gone. */
  unitValue(name: string): SimUnit | null {
    let found: SimUnit | null = null;
    for (const [id, u] of this.unitVars) if (id === name || id.startsWith(`${name}#`)) found = u;
    return found?.alive ? found : null;
  }

  /** A user variable's value by its source name (the last declared with that name). */
  value(name: string): Value | undefined {
    let found: Value | undefined;
    for (const [id, v] of this.vars) if (id === name || id.startsWith(`${name}#`)) found = v;
    return found;
  }

  /** A text variable's characters by its source name (the last declared with that name). */
  textValue(name: string): string | undefined {
    let found: string | undefined;
    for (const [id, v] of this.textVars) if (id === name || id.startsWith(`${name}#`)) found = v.s;
    return found;
  }

  /** An array's cells by its name in the source. */
  list(name: string): Value[] | undefined {
    let found: Value[] | undefined;
    for (const [id, a] of this.arrays) if (id === name || id.startsWith(`${name}#`)) found = a.cells;
    return found;
  }
}

export class ProgramSimulation {
  readonly world: Simulation;
  readonly runs: ProgramRun[];
  readonly events: ProgramEvent[] = [];
  /** What the game would let pass without a word and is a mistake all the same: an index past the end of an array. */
  /** What a program did that is always a mistake — an index past an array's end, a push the heap had no room for — and the frame it happened in. */
  readonly faults: { at: At; message: string; cycle: number; program: number }[] = [];
  /**
   * The heap the programs' growing arrays share, counted as the game counts it: blocks are powers of two, a block given
   * back waits in its size's list for the next array that wants that size, and new ground is taken from the bottom up
   * up to its end. Only the counting is here: the cells are the arrays' own.
   */
  /** The arrays that grow inside others, by the number their handle's cell holds. */
  readonly inner = new Map<number, Held>();
  lastInner = 0;
  readonly heap = {
    cells: HEAP_CELLS,
    top: 1,
    stack: HEAP_CELLS,
    free: new Map<number, number>(),
    take(room: number): boolean {
      const waiting = this.free.get(room) ?? 0;
      if (waiting > 0) { this.free.set(room, waiting - 1); return true; }
      if (this.top + room > this.stack) return false;
      this.top += room;
      return true;
    },
    give(room: number): void { this.free.set(room, (this.free.get(room) ?? 0) + 1); },
  };
  /** How deep the stack of a function that calls itself goes; it is an array of its own in the built map, so the heap has no part in it. */
  readonly stackDepth: number = STACK_DEPTH;
  readonly maxSteps: number;
  readonly random: () => number;
  private readonly conditionOf?: SimulationOptions["condition"];
  private readonly readOf?: ProgramSimulationOptions["read"];
  private readonly nameOf: (player: number) => string;
  /** The units of the game, in the order of its unit table; a dead one stays in the list, gone. */
  readonly units: SimUnit[];
  readonly locations = new Map<number, SimBounds>();
  /** What the programs wrote into the game's tables, as the cell stores it; a name as its text. */
  readonly tables = new Map<string, number | string>();
  private readonly tableOf?: ProgramSimulationOptions["table"];
  private readonly classOf: (type: number, cls: number) => boolean;
  /** Ore and gas by player slot, as the programs' own setResources actions leave them. */
  private readonly resources = new Map<number, [ore: number, gas: number]>();
  /** The typed-line patterns of all the programs, in the order the game tries them: the first that matches a line is the one that line is. */
  private readonly chats: ChatPattern[] = [];
  private readonly unitByName: (lower: string) => number | undefined;
  /** What the players did, for the next frame and for the one running: "key:0:F2", "click:0:left", and a typed line as the pattern it matched with its values. */
  private queued: { events: Set<string>; lines: Map<number, { pattern: string; values: number[] }> } = { events: new Set(), lines: new Map() };
  private current = this.queued;
  /** Where each player's mouse is, in map pixels. */
  readonly mice = new Map<number, { x: number; y: number }>();
  cycle = 0;

  constructor(programs: Program[], options: ProgramSimulationOptions) {
    this.world = options.world ?? new Simulation([], { player: options.player ?? programs[0]?.owner ?? 0, condition: options.condition, random: options.random, strings: options.strings });
    this.maxSteps = options.maxStepsPerCycle ?? 100_000;
    this.heap.cells = this.heap.stack = heapCells(options.heapCells);
    this.stackDepth = stackDepth(options.stackDepth);
    this.random = options.random ?? Math.random;
    this.conditionOf = options.condition;
    this.readOf = options.read;
    this.nameOf = options.playerName ?? ((p) => `Player ${p + 1}`);
    this.units = (options.units ?? []).map(newUnit);
    for (const [n, b] of Object.entries(options.locations ?? {})) this.locations.set(Number(n), { ...b });
    this.tableOf = options.table;
    this.classOf = options.unitClass ?? inClass;
    this.unitByName = options.unitByName ?? (() => undefined);
    for (const s of inputsOf(programs).sources) if (s.source === "chat" && !this.chats.some((c) => c.pattern === s.pattern)) this.chats.push(parseChatPattern(s.pattern));
    this.current = { events: new Set(), lines: new Map() };
    this.runs = programs.map((p, i) => new ProgramRun(this, i, p));
  }

  get player(): number { return this.world.player; }

  /** Deaths, switches, always and never against the world; anything else the caller's, else false. */
  condition(c: ConditionRecord): boolean {
    switch (c.type) {
      case ConditionType.Always: return true;
      case ConditionType.Never: return false;
      case ConditionType.Deaths: {
        const v = this.world.death(c.player, c.unitId);
        const n = c.amount >>> 0;
        return c.comparison === Comparison.AtLeast ? v >= n : c.comparison === Comparison.AtMost ? v <= n : c.comparison === Comparison.Exactly ? v === n : false;
      }
      case ConditionType.Switch: return c.comparison === SwitchState.Set ? this.world.switches[c.resource] === 1 : this.world.switches[c.resource] === 0;
      default: return this.conditionOf?.(c, this.world) ?? false;
    }
  }

  /** The simulation runs one player and knows no forces: the current player is that one, and so is any group, as in the world's death table. */
  private slotOf(player: number): number {
    return player < 12 ? player : player <= PlayerGroup.Force4 || player === PlayerGroup.CurrentPlayer ? this.player : player;
  }

  private stock(player: number): [number, number] {
    const slot = this.slotOf(player);
    let r = this.resources.get(slot);
    if (!r) { r = [0, 0]; this.resources.set(slot, r); }
    return r;
  }

  /** The quantity a comparing condition tests, where the simulation holds it. */
  private quantity(c: ConditionRecord): number | undefined {
    switch (c.type) {
      case ConditionType.Deaths: return this.world.death(c.player, c.unitId);
      case ConditionType.Accumulate: {
        if (this.slotOf(c.player) >= 12) return undefined;
        const [ore, gas] = this.stock(c.player);
        return c.resource === ResourceType.Ore ? ore : c.resource === ResourceType.Gas ? gas : (ore + gas) % U32;
      }
      case ConditionType.ElapsedTime: return Math.floor(this.cycle / FRAMES_PER_GAME_SECOND);
      default: return undefined;
    }
  }

  /** What a read finds: the caller's answer, else the simulation's own, else 0. */
  read(r: ReadSource): number {
    const given = this.readOf?.(r, this);
    if (given !== undefined) return Math.max(0, Math.trunc(given)) % U32;
    if (r.source === "condition") return this.quantity(r.record) ?? 0;
    if (r.source === "player" && r.fact === "slot") return this.slotOf(r.player) === this.player ? 2 : 0;
    return 0;
  }

  /* ── what the players do ── */

  /** A key goes down: the next frame finds it. `player` is a slot (default: the simulated player). */
  press(key: string, player = this.player): this { this.queued.events.add(`key:${player}:${keyName(key) ?? key}`); return this; }
  click(button: MouseButton = "left", player = this.player): this { this.queued.events.add(`click:${player}:${button}`); return this; }
  moveMouse(x: number, y: number, player = this.player): this { this.mice.set(player, { x, y }); return this; }
  /** A player sends a line of chat: the next frame finds it, as the first of the programs' patterns it matches — or not at all. */
  type(line: string, player = this.player): this {
    for (const c of this.chats) {
      const values = matchChat(c, line, this.unitByName);
      if (values) { this.queued.lines.set(player, { pattern: c.pattern, values }); break; }
    }
    return this;
  }

  /** What a program's `input` finds this frame. */
  input(i: InputSource): number {
    const p = this.slotOf(i.player);
    switch (i.source) {
      case "key": return this.current.events.has(`key:${p}:${i.key}`) ? 1 : 0;
      case "click": return this.current.events.has(`click:${p}:${i.button}`) ? 1 : 0;
      case "mouse": return this.mice.get(p)?.[i.axis] ?? 0;
      case "chat": {
        const line = this.current.lines.get(p);
        if (!line || line.pattern !== i.pattern) return 0;
        return i.capture === null ? 1 : line.values[i.capture] ?? 0;
      }
    }
  }

  /* ── units and tables ── */

  /** The living units a filter matches, in table order. */
  matching(f: UnitFilter): SimUnit[] {
    const owner = f.owner === undefined ? undefined : this.slotOf(f.owner);
    const box = f.at === undefined ? undefined : this.locations.get(f.at);
    return this.units.filter((u) => u.alive
      && (owner === undefined || u.owner === owner)
      && (f.type === undefined || (f.type >= 230 ? this.classOf(u.type, f.type) : u.type === f.type))
      && (!box || (u.x >= box.left && u.x <= box.right && u.y >= box.top && u.y <= box.bottom)));
  }

  /** One of the matching units: the first, the nearest to a location's centre by |dx| + |dy| (the first of equals), or one at random. */
  pick(by: "first" | "nearest" | "random", f: UnitFilter, near?: number, mouse?: number, within?: number): SimUnit | null {
    const all = this.matching(f);
    if (all.length === 0) return null;
    if (by === "first") return all[0];
    if (by === "random") return all[Math.min(all.length - 1, Math.floor(this.random() * all.length))];
    const box = near === undefined ? undefined : this.locations.get(near);
    const pointer = mouse === undefined ? undefined : this.mice.get(this.slotOf(mouse)) ?? { x: 0, y: 0 };
    const cx = pointer ? pointer.x : box ? Math.floor((box.left + box.right) / 2) : 0;
    const cy = pointer ? pointer.y : box ? Math.floor((box.top + box.bottom) / 2) : 0;
    let best: SimUnit | null = null;
    let least = within === undefined ? Infinity : within + 1;
    for (const u of all) { const d = Math.abs(u.x - cx) + Math.abs(u.y - cy); if (d < least) { least = d; best = u; } }
    return best;
  }

  /** A location centred on a point, its size kept. */
  centre(location: number, x: number, y: number): void {
    const b = this.locations.get(location) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const w = b.right - b.left;
    const h = b.bottom - b.top;
    const left = x - Math.floor(w / 2);
    const top = y - Math.floor(h / 2);
    this.locations.set(location, { left, top, right: left + w, bottom: top + h });
  }

  private cellKey(c: TableCell): string {
    return `${c.name}:${c.player ? this.slotOf(c.index) : c.index}${c.key !== undefined ? `:${c.key}` : ""}`;
  }

  /** A cell of the game's tables, in the script's units: what a program wrote, else the caller's answer, else 0. */
  tableRead(c: TableCell): number {
    const stored = this.tables.get(this.cellKey(c));
    if (typeof stored === "number") return Math.floor(stored / (c.scale ?? 1));
    const given = this.tableOf?.(c);
    return given === undefined ? 0 : Math.max(0, Math.trunc(given));
  }

  /** `scaled`: the value is already what the cell stores. A cell holds what its width allows and no more. */
  tableWrite(c: TableCell, value: number, scaled: boolean, text?: string): void {
    if (text !== undefined) { this.tables.set(this.cellKey(c), text); return; }
    const raw = scaled ? value : value * (c.scale ?? 1);
    this.tables.set(this.cellKey(c), Math.min(raw, cellMax(c.width)));
  }

  /** What a program did to a unit, for the log: the game's nearest action, with the unit in words. */
  unitEvent(run: ProgramRun, type: number, u: SimUnit, at: At, extra: { location?: number; text?: string } = {}): void {
    const what = `unit ${this.units.indexOf(u)} (type ${u.type}, P${u.owner + 1})`;
    this.events.push({ cycle: this.cycle, program: run.index, at, action: { ...emptyAction(), type, player: u.owner, unitId: u.type, ...(extra.location ? { location: extra.location } : {}) }, text: extra.text ? `${extra.text}: ${what}` : what });
  }

  partText(p: Exclude<TextPart, { kind: "number" | "value" }>): string {
    // A colour is a control character in the game; the log keeps the words.
    return p.kind === "text" ? p.text : p.kind === "name" ? this.nameOf(this.slotOf(p.player)) : "";
  }

  /** A printed text: an event like a Display Text action's, the text already filled in. */
  print(run: ProgramRun, text: string, to: number, at: At): void {
    this.events.push({ cycle: this.cycle, program: run.index, at, action: { ...emptyAction(), type: ActionType.DisplayText, player: to }, text });
  }

  /** An action a program takes: the world's own kinds are applied, the rest logged. */
  act(run: ProgramRun, a: ActionRecord, at: At, programText?: string): void {
    if (a.type === ActionType.SetResources && this.slotOf(a.player) < 12) {
      // Kept as well as logged, so a read of the resources sees what the program did to them.
      const stock = this.stock(a.player);
      const n = a.target >>> 0;
      const set = (cur: number) => (a.modifier === SetModifier.SetTo ? n : a.modifier === SetModifier.Add ? (cur + n) % U32 : Math.max(0, cur - n));
      if (a.unitId === ResourceType.Ore || a.unitId === ResourceType.OreAndGas) stock[0] = set(stock[0]);
      if (a.unitId === ResourceType.Gas || a.unitId === ResourceType.OreAndGas) stock[1] = set(stock[1]);
    }
    switch (a.type) {
      case ActionType.SetDeaths: {
        const cur = this.world.death(a.player, a.unitId);
        const n = a.target >>> 0;
        this.world.setDeath(a.player, a.unitId, a.modifier === SetModifier.SetTo ? n : a.modifier === SetModifier.Add ? (cur + n) >>> 0 : Math.max(0, cur - n));
        return;
      }
      case ActionType.SetSwitch: {
        const i = a.target;
        if (i < 0 || i >= SWITCH_COUNT) return;
        switch (a.modifier) {
          case SwitchAction.Set: this.world.switches[i] = 1; break;
          case SwitchAction.Clear: this.world.switches[i] = 0; break;
          case SwitchAction.Toggle: this.world.switches[i] ^= 1; break;
          case SwitchAction.Randomize: this.world.switches[i] = this.random() < 0.5 ? 0 : 1; break;
        }
        return;
      }
      case ActionType.Comment: case ActionType.PreserveTrigger: return;
      default: {
        const ev: ProgramEvent = { cycle: this.cycle, program: run.index, at, action: a };
        const text = programText ?? this.world.text(a.text);
        if (text !== undefined) ev.text = text;
        this.events.push(ev);
      }
    }
  }

  /** One frame: every program in order, from where it left off. */
  step(): void {
    // What was done since the last frame is what this one finds, and only this one.
    this.current = this.queued;
    this.queued = { events: new Set(), lines: new Map() };
    for (const run of this.runs) {
      try { run.tick(); } catch (err) { if (err instanceof Halt) throw new Error(err.message); throw err; }
    }
    this.cycle++;
  }

  run(cycles: number): this {
    for (let i = 0; i < cycles; i++) this.step();
    return this;
  }

  /** Whether every program has ended. */
  finished(): boolean { return this.runs.every((r) => r.done); }

  /** The unit a variable holds by its source name, in a program (the first by default). */
  unit(name: string, program = 0): SimUnit | null { return this.runs[program]?.unitValue(name) ?? null; }

  /** A variable's value by its source name, in a program (the first by default). */
  value(name: string, program = 0): Value | undefined { return this.runs[program]?.value(name); }
  /** A text variable's characters by its source name, in a program (the first by default). */
  text(name: string, program = 0): string | undefined { return this.runs[program]?.textValue(name); }
  /** An array's cells, by its name in the source. */
  list(name: string, program = 0): Value[] | undefined { return this.runs[program]?.list(name); }
}

/** Run a compile's programs for `cycles` frames. */
export function simulatePrograms(programs: Program[], cycles: number, options: ProgramSimulationOptions): ProgramSimulation {
  return new ProgramSimulation(programs, options).run(cycles);
}
