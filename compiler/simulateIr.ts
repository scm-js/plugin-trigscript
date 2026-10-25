/**
 * The program interpreter: runs `program()` bodies from the IR, one player, frame by
 * frame. It is what Simulate shows and what the tests prove programs with; the model is
 * the backend's (`compiler/backend/`, the map of our own), which is what the game runs — and was
 * the Python lowering's (`python/trigscript.py`), which laid the same programs out through eudplib
 * until TrigScript 4's step 17; the gate before it (step 16, `tests/random-scripts.test.ts`) holds
 * the two to the same lines.
 *
 * A program is a coroutine the game resumes every frame. Its body runs until it sleeps or
 * ends: loops run to completion within the frame, only `sleep` gives the frame back
 * (`sleep(frames(n))` is n frames, `seconds` at twenty-four a second), and a program whose
 * body ends stops for good. A map with a program is built with eudTurbo, so the game goes
 * through its trigger list every frame from frame 2; with a world of the caller's on the
 * game's schedule (`Simulation.tick`), the programs run inside its passes, as the build
 * runs them, and the `trigger()` records beside them in the same pass.
 *
 * Numbers keep the one contract: 32 bits, signed unless the variable is a `u32`, wrapping
 * at either end as `x | 0` does; a `u8` / `u16` stops at 0 and at its maximum. The world — death
 * counters the script names, switches, the conditions the interpreter cannot answer,
 * the strings — is a trigger `Simulation`, shared with any `trigger()` records run beside
 * the programs, so an action a program takes is seen by a hand trigger and the other way
 * round.
 *
 * Units are the world's (`world.ts`): the ones the caller supplies (`units`, the map's placed
 * ones in the editor), in the order of the game's unit table, with the map's locations as
 * boxes (`locations`), and the ones `createUnit` makes from then on. A loop over units, a
 * pick and every field and verb work on that table; a unit that is killed or removed is gone
 * from the next line on, and its place is the next unit's. What the simulation does not
 * model is the game itself: nothing walks, nothing fights. The game's tables (`stats()`)
 * hold what the program wrote and otherwise what `table` answers, else 0.
 *
 * With the map's player settings (`players`, `forces`) a program runs once a frame for each
 * of its owners who is in the game, each with its own variables (a `shared` one is
 * everybody's), as the lowering runs it. Without them there is the one player.
 *
 * What the players do is fed in by the caller: `press`, `click`, `type` and `moveMouse` say what
 * the next frame finds. A key, a click and a typed line last that one frame, as they do in the
 * game; the mouse stays where it was put.
 */
import { fixedAtan2, fixedDiv, fixedMul, fixedSin, fixedSqrt, fixedText } from "./fixedMath";
import { ActionType, Comparison, ConditionType, SetModifier, SWITCH_COUNT, SwitchAction, SwitchState, type ActionRecord, type ConditionRecord } from "../vendor/triggers";
import { emptyAction, ResourceType } from "../vendor/triggers";
import { ORDER_OF_VERB } from "./orders";
import { BUILD_BYTES, ERROR_CODES, HEAP_CELLS, HEAP_SMALLEST, STACK_DEPTH, STACK_OVERFLOW_MESSAGE, TEXT_BYTES, TEXT_FIELD_BYTES, eachStart, heapCells, isTextExpr, programDeclarations, stackDepth } from "./ir";
import type { TextExpr, ArrayDecl, At, BoolExpr, Call, EventSource, NumExpr, Program, ReadSource, Stmt, TableCell, TextPart, UnitExpr, UnitFilter, UnitNumField, UnitVerb, VarDecl } from "./ir";
import { cellMax } from "./tables";
import { inputsOf, keyName, matchChat, parseChatPattern, type ChatPattern, type InputSource, type MouseButton } from "./input";
import { Simulation, type SimulationOptions } from "./simulate";
import { TABLE_FIELDS } from "./tables";
import { FOG_SHAPES } from "./fogShapes";

/** The tiles across and down the simulator's fog keeps: the largest map's. */
const FOG_SIZE = 256;
import type { SimBounds, SimUnit, SimUnitInit, World } from "./world";

export type { SimBounds, SimUnit, SimUnitInit, SimUnitProperties } from "./world";

export const FRAMES_PER_SECOND = 24;
/** What Elapsed Time and the countdown count: a game second is sixteen frames (the slice 2 probe: 21 after 336 frames), not the twenty-four of a second at Fastest. */
export const FRAMES_PER_GAME_SECOND = 16;
const U32 = 0x1_0000_0000;
/** Frames with no message before a held key counts as let go; the backend's input has the same number (`compiler/backend/input.ts`). */
const HELD_GRACE = 2;

/** The code of the game's texts nearest each player's colour, by slot, when the map does not change them: red, blue, teal, purple, orange, brown, white, yellow. */
const SLOT_COLOR_CODES = [8, 14, 15, 16, 17, 21, 22, 23];

export interface ProgramEvent {
  /** 0-based run of the programs. */
  cycle: number;
  /** The game's frame it happened in (with a world of the caller's on the game's schedule, the first is frame 2). */
  frame: number;
  /** Index of the program in the list. */
  program: number;
  /** The player the program was running as. */
  player: number;
  at: At;
  action: ActionRecord;
  text?: string;
}

/** The most a field of a unit holds: a byte for the timers, the cooldown and the kills, 255 points of energy, a word of resources. */
const UNIT_FIELD_MAX: Partial<Record<UnitNumField, number>> = { hp: 0xff_ffff, shields: 0xff_ffff, energy: 255, kills: 255, cooldown: 255, resources: 0xffff, stim: 255, ensnare: 255, plague: 255, lockdown: 255, maelstrom: 255, irradiate: 255, stasis: 255 };
export interface ProgramSimulationOptions extends Pick<SimulationOptions, "player" | "condition" | "random" | "strings" | "players" | "forces" | "properties"> {
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
  /** The hit points, shields and energy a type is made with, where `table` has no answer (it is asked `unit.maxHp` and `unit.maxShields` first). */
  unitStats?: SimulationOptions["unitStats"];
  /** A player's name in a printed text; default "Player 1" … */
  playerName?: (player: number) => string;
  /** The code of the game's texts a player's colour is (8 red, 14 blue, …); default the colour of the player's slot when a map does not change it. */
  playerColor?: (player: number) => number;
  /** The units on the map, in the order of the game's unit table. With a `world` of the caller's they are added to it. */
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
/** An error of the program's is in flight (`Program.errors` holds it), on its way to the nearest `try`. */
class Thrown extends Error {}

/** A slot of a `start`: the task in it (none: free), its generation, the frame it last ran in, and its own cells. */
interface TaskSlot {
  exec: Exec | null;
  apart: Exec[];
  gen: number;
  ran: number;
  vars: Map<string, Value>;
  units: Map<string, SimUnit | null>;
  texts: Map<string, HeldText>;
  arrays: Map<string, Held>;
  latches: Map<object, boolean>;
}
/** A `start` statement's tasks: its slots, and the ids of the variables and arrays a slot has a copy of. */
interface TaskPool { start: Extract<Stmt, { kind: "start" }>; vars: string[]; arrays: ArrayDecl[]; slots: TaskSlot[]; said: boolean }

/** One program's run: its variables, its latches, and the coroutine that is its body. */
/** What a recursive function holds, kept for the length of a call that may come back into it. */
interface Frame {
  vars: [string, Value][];
  units: [string, SimUnit | null][];
  /** The texts the function holds: each keeps its block, and the variable holds none for the length of the call. */
  texts: [string, HeldText][];
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

/** What the runs of one program have in common: the `shared` variables and arrays, one for every player. */
interface Common {
  ids: Set<string>;
  vars: Map<string, Value>;
  unitVars: Map<string, SimUnit | null>;
  textVars: Map<string, HeldText>;
  arrays: Map<string, Held>;
}
const newCommon = (): Common => ({ ids: new Set(), vars: new Map(), unitVars: new Map(), textVars: new Map(), arrays: new Map() });

/** A run's variables of one kind: its own, but for the ids that are `shared`, which are the program's. */
class Cells<V> extends Map<string, V> {
  private readonly ids: ReadonlySet<string>;
  private readonly common: Map<string, V>;
  constructor(ids: ReadonlySet<string>, common: Map<string, V>) { super(); this.ids = ids; this.common = common; }
  override get(id: string): V | undefined { return this.ids.has(id) ? this.common.get(id) : super.get(id); }
  override has(id: string): boolean { return this.ids.has(id) ? this.common.has(id) : super.has(id); }
  override set(id: string, value: V): this { if (this.ids.has(id)) this.common.set(id, value); else super.set(id, value); return this; }
}

class ProgramRun {
  readonly vars: Map<string, Value>;
  /** The variables that hold a unit, or none. */
  readonly unitVars: Map<string, SimUnit | null>;
  /** The variables that hold a text. */
  readonly textVars: Map<string, HeldText>;
  readonly bits = new Map<string, 8 | 16>();
  /** The `u32` variables. */
  readonly unsigned = new Set<string>();
  /** Every latch's state; a task has its own, swapped in while it runs. */
  latches = new Map<object, boolean>();
  /** The units of on.died() turns: read as they died, though they are gone. */
  readonly asDied = new Set<string>();
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
  private apart: Exec[] = [];
  /** The number of the task whose turn it is (`taskHandle`); 0 in the program's own turn. */
  private taskNow = 0;
  /** Where the error in flight was thrown: what an uncaught one is said at. */
  private thrownAt: At | undefined;
  /** The `start` statements' tasks, in order of their numbers. */
  private readonly pools: TaskPool[] = [];
  /** Frames the tasks have run, for a slot to tell whether it has had its turn in this one. */
  private taskFrame = 0;
  /** A task was started during this frame's turn of the tasks: they are gone through again, for it to start in this frame too. */
  private again = false;
  readonly sim: ProgramSimulation;
  readonly index: number;
  readonly program: Program;
  /** The player this run is: who Current Player is while it runs. */
  readonly player: number;
  private readonly common: Common;
  /** The variables the closures count (`VarDecl.held`): read by their own declare, 0 before it. */
  private readonly held: ReadonlySet<string>;

  constructor(sim: ProgramSimulation, index: number, program: Program, player: number, common: Common = newCommon()) {
    this.held = new Set(programDeclarations(program).filter((d) => d.held).map((d) => d.id));
    this.sim = sim;
    this.index = index;
    this.program = program;
    this.player = player;
    this.common = common;
    this.vars = new Cells(common.ids, common.vars);
    this.unitVars = new Cells(common.ids, common.unitVars);
    this.textVars = new Cells(common.ids, common.textVars);
    (this.arrays as unknown as { run: ProgramRun }).run = this;
    for (const decl of program.arrays ?? []) {
      // A shared array is the same cells for every player's run; any other is this run's own.
      const held = (decl.shared ? common.arrays.get(decl.id) : undefined) ?? { decl, room: 0, cells: decl.values ? [...decl.values] : decl.dynamic ? [] : new Array<Value>(decl.length).fill(decl.kind === "number" ? 0 : false) };
      if (decl.shared) common.arrays.set(decl.id, held);
      this.arrays.set(decl.id, held);
    }
    this.body = this.run();
    const decls = programDeclarations(this.program);
    const starts: Extract<Stmt, { kind: "start" }>[] = [];
    eachStart([program.body, program.functions ?? []], (st) => starts.push(st));
    starts.sort((a, b) => a.task - b.task);
    for (const start of starts) {
      const slots = Array.from({ length: start.max }, (): TaskSlot => ({ exec: null, apart: [], gen: 0, ran: 0, vars: new Map(), units: new Map(), texts: new Map(), arrays: new Map(), latches: new Map() }));
      this.pools.push({ start, vars: decls.filter((d) => d.task === start.task).map((d) => d.id), arrays: (program.arrays ?? []).filter((a) => a.task === start.task), slots, said: false });
    }
  }

  private *run(): Exec {
    const flow = yield* this.block(this.program.body, {});
    void flow;
    return "next";
  }

  /** One frame: resume the body until it gives the frame back or ends, then each task that is running. */
  tick(): void {
    this.steps = 0;
    if (!this.done && this.body) {
      try {
        if (this.drive(this.body)) { this.done = true; this.body = null; }
      } catch (err) {
        this.apart.length = 0;
        if (!(err instanceof Stopped)) throw err;
        this.done = true;
        this.body = null;
        this.depth = 0;
      }
    }
    this.runTasks();
  }

  /** Whether a task of the program is still running. */
  get tasksRunning(): boolean { return this.pools.some((p) => p.slots.some((s) => s.exec)); }

  /**
   * The tasks' turn, after the program's: each that is running goes on until it gives the frame back or ends, in order of
   * their start's number and then of their slot. A task started meanwhile has its first turn in this frame too.
   */
  private runTasks(): void {
    if (!this.pools.length) return;
    this.taskFrame++;
    do {
      this.again = false;
      for (const pool of this.pools) {
        for (const slot of pool.slots) {
          if (!slot.exec || slot.ran === this.taskFrame) continue;
          slot.ran = this.taskFrame;
          this.runSlot(pool, slot);
        }
      }
    } while (this.again);
  }

  /** A task's turn: its cells in place of the slot's, its body driven as the program's is. */
  private runSlot(pool: TaskPool, slot: TaskSlot): void {
    const exec = slot.exec!;
    const outer = this.apart, latches = this.latches;
    this.taskNow = pool.slots.indexOf(slot) | (pool.start.task << 8) | (slot.gen << 16);
    this.swap(pool, slot, true);
    this.apart = slot.apart;
    this.latches = slot.latches;
    try {
      if (this.drive(exec)) { slot.exec = null; slot.apart.length = 0; }
    } catch (err) {
      slot.apart.length = 0;
      if (!(err instanceof Stopped)) throw err;
      slot.exec = null;
      this.depth = 0;
    } finally {
      this.taskNow = 0;
      this.apart = outer;
      this.latches = latches;
      this.swap(pool, slot, false);
    }
  }

  /** A slot's cells into the run's (`into`), or back out of them: between turns nothing of a task is among the run's. */
  private swap(pool: TaskPool, slot: TaskSlot, into: boolean): void {
    const move = <V>(run: Map<string, V>, own: Map<string, V>, id: string) => {
      if (into) { if (own.has(id)) run.set(id, own.get(id)!); else run.delete(id); }
      else { if (run.has(id)) own.set(id, run.get(id)!); else own.delete(id); run.delete(id); }
    };
    for (const id of pool.vars) { move(this.vars, slot.vars, id); move(this.unitVars, slot.units, id); move(this.textVars, slot.texts, id); }
    for (const a of pool.arrays) {
      if (into) this.arrays.set(a.id, slot.arrays.get(a.id) ?? this.newHeld(a));
      else { const held = (this.arrays as Map<string, Held>).get(a.id); if (held) slot.arrays.set(a.id, held); }
    }
  }

  private newHeld(decl: ArrayDecl): Held {
    return { decl, room: 0, cells: decl.values ? [...decl.values] : decl.dynamic ? [] : new Array<Value>(decl.length).fill(decl.kind === "number" ? 0 : false) };
  }

  /** The pool and slot a task's number names, while that task is in it; undefined for a number that is no running task's. */
  private taskOf(handle: number): { pool: TaskPool; slot: TaskSlot } | undefined {
    const pool = this.pools.find((p) => p.start.task === ((handle >>> 8) & 0xff));
    const slot = pool?.slots[handle & 0xff];
    return pool && slot?.exec && slot.gen === handle >>> 16 ? { pool, slot } : undefined;
  }

  /** The run until it gives the frame back (false) or ends (true): the body, and above it each body that was handed over to be run apart. */
  private drive(body: Exec): boolean {
    let send: unknown;
    // An error thrown in a body run apart goes on in the body that called it, at the call.
    let thrown: Thrown | undefined;
    for (;;) {
      const top = this.apart[this.apart.length - 1] ?? body;
      let r: IteratorResult<Apart | undefined, Flow>;
      try {
        r = thrown ? top.throw(thrown) : top.next(send);
      } catch (err) {
        if (!(err instanceof Thrown) || !this.apart.length) throw err;
        this.apart.pop();
        thrown = err;
        continue;
      }
      thrown = undefined;
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
    if (v === undefined && this.held.has(id)) return 0;
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
      this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `${a.decl.name}[${i}] is past the end of the row (its length is ${a.decl.length}): ${what}.` });
      return undefined;
    }
    const length = a.decl.dynamic ? a.cells.length : a.decl.length;
    if (i >= 0 && i < length) return { ...a, i };
    this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `${a.decl.name}[${i}] is past the end of the array (its length is ${length}): ${what}.` });
    return undefined;
  }

  /**
   * Room for `cells` in a growing array, as the game finds it (`compiler/backend/heap.ts`): a block twice the size from the
   * heap, the old one given back. False, and said once, when the heap has none left.
   */
  private grow(a: { decl: ArrayDecl; cells: Value[]; room: number }, cells: number, at: At): boolean {
    if (cells <= a.room) return true;
    let room = Math.max(a.room, HEAP_SMALLEST);
    while (room < cells) room *= 2;
    if (!this.sim.heap.take(room)) {
      this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `Out of memory: ${a.decl.name} could not grow to ${cells} cells (the heap the programs' arrays share is ${this.sim.heap.cells} cells; the script's settings set it).` });
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
    if (!held) { this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: decl.at, message: `${decl.name} was given back — the row that held it was popped, cut off or declared again — and this is a copy of its handle: in the game it reads whatever has the block now.` }); return nothing(); }
    held.decl = decl;
    return held;
  }

  private declare(decl: VarDecl): void {
    // One cell for every player: what any of them puts in it, all of them read.
    if (decl.shared && this.program.perPlayer) this.common.ids.add(decl.id);
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
      // A kept unit is its place in the table, from 1, and the place's uniqueness byte: a unit made since in that place is another.
      case "unitAt": { const ptr = (yield* this.num(e.ptr)) >>> 0; yield* this.num(e.epd); const uid = (yield* this.num(e.uid)) >>> 0; return ptr >= 1 ? this.sim.game.at(ptr - 1, uid) : null; }
      case "call": { yield* this.call(e.call); return e.call.result ? this.unitVars.get(e.call.result.decl.id) ?? null : null; }
      case "selected": return this.sim.selectedUnit(e.index);
    }
  }

  /** The unit, when there is one and it is still on the map. */
  private *living(e: UnitExpr): Gen<SimUnit | null> {
    const u = yield* this.unit(e);
    // The unit of an on.died() turn is read as it died.
    if (u && e.kind === "unitVar" && this.asDied.has(e.id)) return u;
    return u?.alive ? u : null;
  }

  private *unitDo(e: UnitExpr, verb: UnitVerb, at: At): Gen<void> {
    const u = yield* this.living(e);
    // The amount is computed whether or not there is a unit, as the game computes it.
    const amount = verb.do === "damage" || verb.do === "heal" ? yield* this.amount(verb.amount) : 0;
    if (!u) return;
    switch (verb.do) {
      case "kill": case "remove": this.sim.game.gone(u, verb.do === "kill", undefined, false); this.sim.unitEvent(this, verb.do === "kill" ? ActionType.KillUnit : ActionType.RemoveUnit, u, at); break;
      case "give": { const to = this.sim.slotOf(verb.to); if (to < 12) this.sim.game.setOwner(u, to); break; }
      // (The unit takes up the order and keeps it here: the simulator moves nothing, so it never arrives.)
      case "order": u.orderId = ORDER_OF_VERB[verb.order]; this.sim.unitEvent(this, ActionType.Order, u, at, { location: verb.target, text: verb.order }); break;
      case "locate": this.sim.centre(verb.location, u.x, u.y); break;
      case "damage": case "heal": {
        // In the game's own units, 256 to a point, as the lowering computes it.
        const step = verb.percent ? Math.floor((u.maxHp * 256 * amount) / 100) : amount * 256;
        const raw = verb.do === "damage" ? Math.max(0, u.hp * 256 - step) : Math.min(u.maxHp * 256, u.hp * 256 + step);
        u.hp = Math.ceil(raw / 256);
        if (u.hp === 0) { this.sim.game.gone(u, true, undefined, false); this.sim.unitEvent(this, ActionType.KillUnit, u, at); }
        break;
      }
    }
  }

  /* ── expressions ── */

  /**
   * A number, the way the game computes it (`compiler/backend/emit.ts`): 32 bits, given here as the
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
      case "taskHandle": return this.taskNow;
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
      case "unitPart": { const u = yield* this.unit(e.unit); return u ? (e.part === "uid" ? u.uid : u.slot + 1) : 0; }
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
        if (e.name === "fmul") return fixedMul(args[0], args[1]);
        if (e.name === "fdiv") return fixedDiv(args[0], args[1]);
        if (e.name === "sqrt") return fixedSqrt(args[0], !!e.unsigned);
        if (e.name === "atan2" || e.name === "sin" || e.name === "cos") {
          const table = (this.arrays.get(e.table ?? "")?.cells ?? []).map((c) => Number(c) | 0);
          return e.name === "atan2" ? fixedAtan2(args[0], args[1], table) : fixedSin(args[0], args[1], table, e.name === "cos");
        }
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
   * A text that was just made, as the game keeps it (`compiler/backend/texts.ts`): past `TEXT_BYTES` it is cut, and its
   * bytes go into a block of the heap. When the heap has none, the text is empty — and both are said.
   */
  private made(s: string, at: At, cameTo = bytesOf(s)): TextValue {
    if (bytesOf(s) > TEXT_BYTES) {
      this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `This text came to ${cameTo.toLocaleString("en-US")} bytes, and a text that is made holds ${TEXT_BYTES.toLocaleString("en-US")}: it is cut off there, as it is in the game.` });
      s = cutTo(s, TEXT_BYTES);
    }
    const room = textRoom(bytesOf(s));
    if (!this.sim.heap.take(room)) {
      this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `Out of memory: no room for this text (the heap the programs' arrays and texts share is ${this.sim.heap.cells} cells; the script's settings set it). It is empty instead, as it is in the game.` });
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
      if (p.kind === "number") out += p.fixed ? fixedText(yield* this.num(p.expr)) : String(p.unsigned ? yield* this.amount(p.expr) : yield* this.num(p.expr));
      // A colour code is a character of the text, as in the game: it counts in the length, and the log shows it.
      else if (p.kind === "char") { const code = (yield* this.num(p.expr)) & 0xff; if (code) out += String.fromCharCode(code); }
      else if (p.kind === "value") { const v = yield* this.text(p.text); used.push(v); out += v.s; }
      else out += this.sim.partText(p);
    }
    return out;
  }

  private *text(e: TextExpr): Gen<TextValue> {
    switch (e.kind) {
      case "text": return { s: e.text, room: 0, taken: true };
      case "textVar": { const v = this.textVars.get(e.id); if (!v) throw new Error(`The variable ${e.id} was read before it was declared.`); return { ...v, taken: false }; }
      case "textAt": {
        // The cells hold the number the text is kept under here (where it is, in the game); 0 is a cell never given one.
        const c = yield* this.cell(e.addr, e.index, e.at, "it reads as no text");
        const held = c ? this.cellTexts.get(c.cells[c.i] as number) : undefined;
        return { s: held?.s ?? "", room: held?.room ?? 0, taken: false };
      }
      case "textOf": {
        const a = this.arrays.get(e.array);
        const i = yield* this.num(e.index);
        const found = a?.decl.texts?.[i];
        if (found === undefined) this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: e.at, message: `${a?.decl.name ?? e.array}[${i}] is past the end of the list (its length is ${a?.decl.texts?.length ?? 0}): it reads an empty text.` });
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
      case "built": return { s: this.sim.buffers.get(e.buffer) ?? "", room: 0, taken: false };
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
  /** The texts kept in cells of arrays, by the number the cells hold for one: what moves a row moves numbers, and the text goes with them. */
  private readonly cellTexts = new Map<number, HeldText>();
  private lastCellText = 0;

  private releaseCellText(key: number): void {
    const old = key ? this.cellTexts.get(key) : undefined;
    if (!old) return;
    if (old.room) this.sim.heap.give(old.room);
    this.cellTexts.delete(key);
  }

  private *putText(id: string, e: TextExpr, at: At): Gen<void> {
    const v = this.owned(yield* this.text(e), at);
    const old = this.textVars.get(id);
    if (old?.room) this.sim.heap.give(old.room);
    this.textVars.set(id, v);
  }

  /** A made text where the game shows at most `TEXT_FIELD_BYTES` of one: an action's field, a unit type's name. */
  private shown(v: TextValue, at: At, where: string): string {
    if (!v.room || bytesOf(v.s) <= TEXT_FIELD_BYTES) return v.s;
    this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `This text is ${bytesOf(v.s)} bytes, and ${where} shows ${TEXT_FIELD_BYTES} of a text that was made: it is cut off there, as it is in the game.` });
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
      case "running": return !!this.taskOf((yield* this.num(e.task)) >>> 0);
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

  /** A task's body, as its slot runs it: what it returns into is the task's own, and nothing reads it. */
  private *taskBody(c: Call): Exec {
    if (c.result) this.declare(c.result.decl);
    const flow = yield* this.block(c.body, { fn: { result: c.result?.decl } });
    if (flow === "break" || flow === "continue") throw new Error(`${flow} inside a task reached its end (line ${c.at.line}).`);
    return "next";
  }

  private *call(c: Call): Gen<Value> {
    if (c.result) this.declare(c.result.decl);
    const fn = c.fn ? this.program.functions?.find((f) => f.id === c.fn) : undefined;
    if (c.fn && !fn) throw new Error(`The function ${c.fn} is not one of the program's (line ${c.at.line}).`);
    let kept: Frame | undefined;
    if (fn) {
      // A called function: every argument first — one of them may be a call of the same function — then its parameters, then its one body.
      const values: (Value | SimUnit | HeldText | null)[] = [];
      // A text is a copy of its own by the time the parameter takes it: what it was made from may be the parameter itself.
      for (const p of c.params) values.push(p.decl.kind === "unit" ? yield* this.unit(p.init as UnitExpr) : p.decl.kind === "text" ? this.owned(yield* this.text(p.init as TextExpr), c.at) : yield* this.init(p.init as NumExpr | BoolExpr, p.decl.kind));
      if (c.saves) kept = this.keep(c);
      c.params.forEach((p, i) => {
        this.declare(p.decl);
        if (p.decl.kind === "unit") this.unitVars.set(p.decl.id, values[i] as SimUnit | null);
        else if (p.decl.kind === "text") { const old = this.textVars.get(p.decl.id); if (old?.room) this.sim.heap.give(old.room); this.textVars.set(p.decl.id, values[i] as HeldText); }
        else this.store(p.decl.id, values[i] as Value);
      });
    } else {
      for (const p of c.params) {
        this.declare(p.decl);
        yield* this.put(p.decl, p.init);
      }
    }
    const ctx: Ctx = { fn: { result: c.result?.decl } };
    let flow: Flow;
    try {
      flow = kept && fn ? ((yield { run: this.block(fn.body, ctx) }) as Flow) : yield* this.block(fn ? fn.body : c.body, ctx);
    } catch (err) {
      // The error goes on out of the call; what the function holds comes back first, as it does when the function returns.
      if (kept && err instanceof Thrown) this.bringBack(kept);
      throw err;
    }
    if (flow === "break" || flow === "continue") throw new Error(`${flow} inside a function reached its end (line ${c.at.line}).`);
    if (kept) this.bringBack(kept);
    return c.result && c.result.kind !== "unit" && c.result.kind !== "text" ? this.read(c.result.decl.id) : 0;
  }

  /**
   * A call that may come back into the function it is in: what that function holds goes on the stack, as the game
   * keeps it (`compiler/backend/emit.ts`, `Emitter.keep`) — its variables, and the handle of each array declared in it, which is "no block"
   * for the length of the call. Past the depth the map allows the program stops, and says where.
   */
  private keep(c: Call): Frame {
    const saves = c.saves!;
    if (this.depth >= this.sim.stackDepth && this.program.errors) {
      // A RangeError, as JavaScript's: where the call is, before anything of it is kept.
      this.store(this.program.errors.thrown, ERROR_CODES.RangeError);
      const old = this.textVars.get(this.program.errors.message);
      if (old?.room) this.sim.heap.give(old.room);
      this.textVars.set(this.program.errors.message, { s: STACK_OVERFLOW_MESSAGE, room: 0 });
      this.thrownAt = c.at;
      throw new Thrown();
    }
    if (this.depth >= this.sim.stackDepth) {
      this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: c.at, message: `Stack overflow in ${saves.within}: ${this.sim.stackDepth.toLocaleString("en-US")} calls deep, which is as deep as the script's settings allow. The program has stopped, as it does in the game.` });
      throw new Stopped();
    }
    this.depth++;
    const frame: Frame = { vars: [], units: [], texts: [], arrays: [] };
    for (const id of saves.vars) {
      if (this.textVars.has(id)) { frame.texts.push([id, this.textVars.get(id)!]); this.textVars.set(id, { s: "", room: 0 }); }
      else if (this.unitVars.has(id)) frame.units.push([id, this.unitVars.get(id) ?? null]);
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
    // The block the inner run left in a text goes back to the heap before the text is the outer run's again.
    for (const [id, t] of frame.texts) { const left = this.textVars.get(id); if (left?.room) this.sim.heap.give(left.room); this.textVars.set(id, t); }
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
      case "storeText": {
        const v = this.owned(yield* this.text(s.value), s.at);
        const i = yield* this.num(s.index);
        const cells = [s.addr, s.block, s.chars].map((id) => this.arrays.get(id));
        if (cells.some((a) => !a || i < 0 || i >= a.cells.length)) {
          this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: s.at, message: `${cells[0]?.decl.name ?? s.addr}[${i}] is past the end of the array (its length is ${cells[0]?.cells.length ?? 0}): nothing is stored.` });
          if (v.room) this.sim.heap.give(v.room);
          return "next";
        }
        const [addr, block, chars] = cells as Held[];
        this.releaseCellText(block.cells[i] as number);
        const key = ++this.lastCellText;
        this.cellTexts.set(key, v);
        addr.cells[i] = key;
        block.cells[i] = v.room ? key : 0;
        chars.cells[i] = [...v.s].length;
        return "next";
      }
      case "releaseText": {
        const c = yield* this.cell(s.block, s.index, s.at, "nothing is given back");
        if (c) { this.releaseCellText(c.cells[c.i] as number); c.cells[c.i] = 0; }
        return "next";
      }
      case "textLoop": {
        this.declare(s.decl);
        // The text as it is when the loop starts: a copy of a variable's, so that assigning the variable inside changes nothing here.
        const over = this.owned(yield* this.text(s.of), s.at);
        let flow: Flow = "next";
        try {
          for (const ch of over.s) {
            const old = this.textVars.get(s.decl.id);
            const turn = this.made(ch, s.at);
            if (old?.room) this.sim.heap.give(old.room);
            this.textVars.set(s.decl.id, { s: turn.s, room: turn.room });
            flow = yield* this.block(s.body, ctx);
            if (flow === "break" || flow === "return") break;
          }
        } catch (err) {
          // An error out of the body: the text the loop holds goes back on its way, as the game gives it back.
          if (err instanceof Thrown && over.room) this.sim.heap.give(over.room);
          throw err;
        }
        if (over.room) this.sim.heap.give(over.room);
        return flow === "return" ? flow : "next";
      }
      case "unitLoop": {
        this.declare(s.decl);
        // The units as they are when the loop starts, in table order; one that dies on the way is passed over. Those of
        // the frame's events pass (`on.created` / `on.died`): the ones that came on, and the ones that died, read as they died.
        const dead = s.source === "died" || s.source === "killed";
        if (dead) this.asDied.add(s.decl.id);
        if (s.was) this.declare(s.was);
        for (const { u, was } of s.source ? this.sim.eventUnits(s.source, s.filter, s.event) : this.sim.matching(s.filter).map((u) => ({ u, was: 0 }))) {
          if (!dead && !u.alive) continue;
          this.unitVars.set(s.decl.id, u);
          if (s.was) this.store(s.was.id, was);
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
        if (field === "hp" && u.hp === 0) { this.sim.game.gone(u, true, undefined, false); this.sim.unitEvent(this, ActionType.KillUnit, u, s.at); }
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
          else this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: s.at, message: `${a.decl.name}[${i}] is past the end of the array (its length is ${a.cells.length}): nothing is stored.` });
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
      case "graph": return yield* this.block(s.original, ctx);
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
      case "parallel": {
        // Each branch a coroutine of its own: started here in order, then once a frame each one still running goes on, in
        // order. A body run apart (a recursive call) inside a branch is handed up to the run's loop and its outcome back.
        const branches = s.branches.map((b) => this.block(b, {}));
        const done = branches.map(() => false);
        for (;;) {
          for (let i = 0; i < branches.length; i++) {
            if (done[i]) continue;
            let send: unknown;
            // An error from a body the branch had run apart goes on inside the branch, which may catch it.
            let thrown: Thrown | undefined;
            for (;;) {
              const r = thrown ? branches[i].throw(thrown) : branches[i].next(send);
              send = undefined;
              thrown = undefined;
              if (r.done) { done[i] = true; break; }
              if (r.value === undefined) break;
              try { send = yield r.value; } catch (err) { if (!(err instanceof Thrown)) throw err; thrown = err; }
            }
            // The first to end wins a race; the others stop where they are.
            if (done[i] && s.mode === "race") return "next";
          }
          if (done.every(Boolean)) return "next";
          yield;
        }
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
      case "buildText": {
        const used: TextValue[] = [];
        const more = yield* this.parts(s.parts, used);
        this.used(...used);
        const was = s.reset ? "" : this.sim.buffers.get(s.buffer) ?? "";
        let text = was + more;
        // Past what a buffer holds the text is cut, as it is in the game, and said once a buffer.
        if (bytesOf(text) > BUILD_BYTES) {
          if (bytesOf(was) <= BUILD_BYTES) this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: s.at, message: `This text came to more than the ${BUILD_BYTES.toLocaleString("en-US")} bytes a text put together piece by piece holds: it is cut off there, as it is in the game.` });
          text = cutTo(text, BUILD_BYTES);
        }
        this.sim.buffers.set(s.buffer, text);
        return "next";
      }
      case "select": {
        const units: SimUnit[] = [];
        for (const u of s.units) { const got = yield* this.unit(u); if (got?.alive && units.length < 12) units.push(got); }
        this.sim.selectUnits(units, this.sim.slotOf(s.player));
        return "next";
      }
      case "syncSend": {
        this.sim.readAt(s.player);
        let value: number;
        try { value = yield* this.num(s.value); } finally { this.sim.readAt(null); }
        this.sim.syncSend(s.slot, s.player, value);
        return "next";
      }
      case "centerLocation": {
        const x = yield* this.amount(s.x); const y = yield* this.amount(s.y);
        const size = s.size ? { width: yield* this.amount(s.size.width), height: yield* this.amount(s.size.height) } : undefined;
        this.sim.centre(s.location, x, y, size);
        return "next";
      }
      case "start": {
        const pool = this.pools.find((p) => p.start === s);
        if (!pool) throw new Error(`The start of task ${s.task} is not one of the program's (line ${s.at.line}).`);
        // The arguments as they are now, before any parameter is set.
        const values: (Value | SimUnit | HeldText | null)[] = [];
        for (const p of s.call.params) values.push(p.decl.kind === "unit" ? yield* this.unit(p.init as UnitExpr) : p.decl.kind === "text" ? this.owned(yield* this.text(p.init as TextExpr), s.at) : this.kept(yield* this.init(p.init as NumExpr | BoolExpr, p.decl.kind), p.decl));
        const i = pool.slots.findIndex((slot) => !slot.exec);
        if (i < 0) {
          for (const v of values) if (v && typeof v === "object" && "room" in v && v.room) this.sim.heap.give(v.room);
          if (!pool.said) this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at: s.at, message: `${s.call.name ?? "The task"} did not start: all ${s.max} of this start's tasks are running. start(…, { max: … }) lets more run at once.` });
          pool.said = true;
          if (s.handle) this.store(s.handle, 0);
          return "next";
        }
        const slot = pool.slots[i];
        slot.gen = slot.gen >= 0xffff ? 1 : slot.gen + 1;
        s.call.params.forEach((p, k) => {
          this.declare(p.decl);
          if (p.decl.kind === "unit") slot.units.set(p.decl.id, values[k] as SimUnit | null);
          else if (p.decl.kind === "text") { const old = slot.texts.get(p.decl.id); if (old?.room) this.sim.heap.give(old.room); slot.texts.set(p.decl.id, values[k] as HeldText); }
          else slot.vars.set(p.decl.id, values[k] as Value);
          // (declare() put the parameter among the run's own: it is the slot's.)
          this.vars.delete(p.decl.id);
          this.unitVars.delete(p.decl.id);
          this.textVars.delete(p.decl.id);
        });
        slot.exec = this.taskBody(s.call);
        slot.apart = [];
        slot.ran = 0;
        this.again = true;
        if (s.handle) this.store(s.handle, i | (s.task << 8) | (slot.gen << 16));
        return "next";
      }
      case "cancel": {
        const t = this.taskOf((yield* this.num(s.task)) >>> 0);
        if (t) { t.slot.exec = null; t.slot.apart.length = 0; }
        return "next";
      }
      case "call": { yield* this.call(s.call); return "next"; }
      case "block": return yield* this.block(s.body, ctx);
      case "try": {
        try {
          return yield* this.block(s.body, ctx);
        } catch (err) {
          if (!(err instanceof Thrown)) throw err;
          return yield* this.block(s.catch, ctx);
        }
      }
      case "throw": {
        if (!s.rethrow) this.thrownAt = s.at;
        throw new Thrown();
      }
      case "uncaught": {
        const errors = this.program.errors;
        if (!errors) throw new Error(`An uncaught error, but the program keeps none (line ${s.at.line}).`);
        const code = this.read(errors.thrown) as number;
        const names = this.arrays.get(errors.names);
        const name = names?.decl.texts?.[names.cells[code] as number] || "Error";
        const message = this.textVars.get(errors.message)?.s ?? "";
        const at = this.thrownAt ?? s.at;
        this.sim.faults.push({ cycle: this.sim.cycle, frame: this.sim.frame, program: this.index, at, message: `Uncaught ${name}${message ? `: ${message}` : ""}` });
        // The game says it in red to the player it ran as (`compiler/backend/errors.ts`).
        this.sim.print(this, `\x06TrigScript: uncaught ${name}: ${message}, line ${at.line}.`, 13, s.at);
        this.store(errors.thrown, 0);
        return "next";
      }
      case "remark": return "next";
      // (A map of our own's own statements, which only its backend makes and never hands the simulator.)
      case "textBlock": case "showText": case "watch": throw new Error(`the simulator does not run a ${s.kind}`);
    }
  }

  /** The unit a variable holds, by its source name; null for none or a unit that is gone. */
  unitValue(name: string): SimUnit | null {
    let found: SimUnit | null = null;
    for (const [id, u] of [...this.unitVars, ...this.common.unitVars]) if (id === name || id.startsWith(`${name}#`)) found = u;
    return found?.alive ? found : null;
  }

  /** A user variable's value by its source name (the last declared with that name). */
  value(name: string): Value | undefined {
    let found: Value | undefined;
    for (const [id, v] of [...this.vars, ...this.common.vars]) if (id === name || id.startsWith(`${name}#`)) found = v;
    return found;
  }

  /** A text variable's characters by its source name (the last declared with that name). */
  textValue(name: string): string | undefined {
    let found: string | undefined;
    for (const [id, v] of [...this.textVars, ...this.common.textVars]) if (id === name || id.startsWith(`${name}#`)) found = v.s;
    return found;
  }

  /**
   * What the source calls `name`, whatever it is: a number, a boolean, a text, an array's cells, a unit (null for none or
   * one that is gone), a record as an object of its fields, an array of records as a list of them. Undefined for no such name.
   */
  lookup(name: string): unknown {
    const value = this.value(name);
    if (value !== undefined) return value;
    const text = this.textValue(name);
    if (text !== undefined) return text;
    const list = this.list(name);
    if (list !== undefined) return [...list];
    for (const id of [...this.unitVars.keys(), ...this.common.unitVars.keys()]) if (id === name || id.startsWith(`${name}#`)) return this.unitValue(name);
    // A record is a variable a field (`pos.x`), a list of records an array a field (`rows.a`).
    const field = (id: string) => (id.startsWith(`${name}.`) ? id.slice(name.length + 1).split("#")[0] : null);
    const record: Record<string, unknown> = {};
    for (const [id, v] of [...this.vars, ...this.common.vars]) { const f = field(id); if (f && !f.includes(" (")) record[f] = v; }
    for (const [id, v] of [...this.textVars, ...this.common.textVars]) { const f = field(id); if (f) record[f] = v.s; }
    if (Object.keys(record).length) return record;
    const rows: Record<string, unknown>[] = [];
    for (const [id, a] of this.arrays) { const f = field(id); if (f) a.cells.forEach((cell, i) => { (rows[i] ??= {})[f] = cell; }); }
    return rows.length ? rows : undefined;
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
  readonly faults: { at: At; message: string; cycle: number; frame: number; program: number }[] = [];
  /**
   * The heap the programs' growing arrays share, counted as the game counts it: blocks are powers of two, a block given
   * back waits in its size's list for the next array that wants that size, and new ground is taken from the bottom up
   * up to its end. Only the counting is here: the cells are the arrays' own.
   */
  /** The arrays that grow inside others, by the number their handle's cell holds. */
  readonly inner = new Map<number, Held>();
  lastInner = 0;
  /** What each buffer of `buildText` holds: one for the whole game, as in the game. */
  readonly buffers = new Map<string, string>();
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
  private readonly colorOf: (player: number) => number;
  /** The units, the locations and who the players are: the trigger interpreter's, so both see one game. */
  readonly game: World;
  /** What the programs wrote into the game's tables, as the cell stores it; a name as its text. */
  readonly tables = new Map<string, number | string>();
  private readonly tableOf?: ProgramSimulationOptions["table"];
  /** Ore and gas by player slot, as the programs' own setResources actions leave them. */
  private readonly resources = new Map<number, [ore: number, gas: number]>();
  /** The typed-line patterns of all the programs, in the order the game tries them: the first that matches a line is the one that line is. */
  private readonly chats: ChatPattern[] = [];
  private readonly unitByName: (lower: string) => number | undefined;
  /** What the players did, for the next frame and for the one running: "key:0:F7", "click:0:left", and a typed line as the pattern it matched with its values. */
  private queued: { events: Set<string>; lines: Map<number, { pattern: string; values: number[] }> } = { events: new Set(), lines: new Map() };
  private current = this.queued;
  /** The keys and buttons down on the last frame, and on this one (what keyHeld() finds). */
  private down = new Set<string>();
  private downNow = new Set<string>();
  private readonly lastDown = new Map<string, number>();
  /** Whether a program reads a held key: then a press is worked out from the held keys, as the game does. */
  private heldKeys = false;
  /** Where each player's mouse is, in map pixels. */
  readonly mice = new Map<number, { x: number; y: number }>();
  /** Where each player's screen is on the map, its top left corner in pixels (`local.camera`; B5). */
  readonly cameras = new Map<number, { x: number; y: number }>();
  /** sync() (B5): what arrived this frame, "slot:player" → the value + 1; and what was sent, arriving at the next frame. */
  private readonly synced = new Map<string, number>();
  private sending: [key: string, value: number][] = [];
  cycle = 0;
  /** The world is the caller's, run on the game's schedule: the programs run in its passes, and its frame is the game's. */
  private readonly shared: boolean;
  /**
   * The game's frame the programs stand in. A world of the caller's says (a map with a program has a pass every frame
   * from frame 2, and the programs run in it); one of their own has the programs run every frame from frame 1.
   */
  get frame(): number { return this.shared ? this.world.frame : this.cycle + 1; }

  constructor(programs: Program[], options: ProgramSimulationOptions) {
    this.world = options.world ?? new Simulation([], {
      player: options.player ?? (options.players ? undefined : programs[0]?.owner ?? 0), condition: options.condition, random: options.random, strings: options.strings,
      players: options.players, forces: options.forces, units: options.units, locations: options.locations, unitClass: options.unitClass, properties: options.properties,
    });
    this.game = this.world.game;
    this.shared = options.world !== undefined;
    // A world of the caller's gets the units and locations handed here, as it would have had them handed to itself.
    if (options.world) {
      for (const [n, b] of Object.entries(options.locations ?? {})) this.game.locations.set(Number(n), { ...b });
      for (const u of options.units ?? []) this.game.make(u);
    }
    this.maxSteps = options.maxStepsPerCycle ?? 100_000;
    this.heap.cells = this.heap.stack = heapCells(options.heapCells);
    this.stackDepth = stackDepth(options.stackDepth);
    this.random = options.random ?? Math.random;
    this.conditionOf = options.condition;
    this.readOf = options.read;
    this.nameOf = options.playerName ?? ((p) => `Player ${p + 1}`);
    this.colorOf = options.playerColor ?? ((p) => SLOT_COLOR_CODES[p] ?? SLOT_COLOR_CODES[7]);
    this.tableOf = options.table;
    // A unit is made with what its type has now: what a program wrote into the game's tables, else what the caller says.
    const cellOf = (name: string, type: number): TableCell => { const f = TABLE_FIELDS.unit.find((x) => x.name === name)!; return { name: `unit.${name}`, base: f.base, stride: f.stride, index: type, width: f.width, ...(f.scale ? { scale: f.scale } : {}) }; };
    const given = options.unitStats ?? this.game.stats;
    this.game.stats = (type) => {
      const g = given(type) ?? {};
      return { ...g, hp: this.tableRead(cellOf("maxHp", type)) || g.hp, shields: this.tableRead(cellOf("maxShields", type)) || g.shields };
    };
    this.unitByName = options.unitByName ?? (() => undefined);
    for (const s of inputsOf(programs).sources) if (s.source === "chat" && !this.chats.some((c) => c.pattern === s.pattern)) this.chats.push(parseChatPattern(s.pattern));
    this.heldKeys = inputsOf(programs).sources.some((s) => s.source === "key" && s.held);
    this.current = { events: new Set(), lines: new Map() };
    // A program runs once a frame for each of its owners who is in the game, each run with its own variables; one that
    // is not per player runs as the first of them. Without the map's player settings there is the one player and one run.
    this.runs = programs.flatMap((p, i) => {
      const common = newCommon();
      const slots = this.ownersOf(p);
      return (p.perPlayer ? slots : slots.slice(0, 1)).map((slot) => new ProgramRun(this, i, p, slot, common));
    });
  }

  /** The simulated player: the only one without the map's player settings, else the one a key, a click and a log default to. */
  get player(): number { return this.world.player; }
  /** The units there have been, in the order they were made; one that is gone stays, `alive` false. */
  get units(): SimUnit[] { return this.game.units; }
  get locations(): Map<number, SimBounds> { return this.game.locations; }

  /** The slots a program runs for: its owners who are in the game. */
  private ownersOf(p: Program): number[] {
    const players = this.game.players;
    if (players.loose) return [this.world.player];
    const out: number[] = [];
    for (const o of p.owners?.length ? p.owners : [p.owner]) for (const slot of players.of(o, this.world.player)) if (players.slots.includes(slot) && !out.includes(slot)) out.push(slot);
    return out.sort((a, b) => a - b);
  }

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
      default: return this.conditionOf?.(c, this.world) ?? this.game.holds(c, this.world.current) ?? false;
    }
  }

  /** The players a player number means, to the run that is running. */
  slotsOf(player: number): number[] { return this.game.players.of(player, this.world.current); }
  /** The one player a player number means where one is wanted (a mouse, a name, a table's row): the first of a group. */
  slotOf(player: number): number { return this.slotsOf(player)[0] ?? player; }

  /** A player's ore and gas; a group's are its players' together. */
  resourcesOf(player: number): [ore: number, gas: number] {
    let ore = 0, gas = 0;
    for (const p of this.slotsOf(player)) if (p < 12) { const s = this.stockOf(p); ore += s[0]; gas += s[1]; }
    return [ore % U32, gas % U32];
  }

  private stockOf(slot: number): [number, number] {
    let r = this.resources.get(slot);
    if (!r) { r = [0, 0]; this.resources.set(slot, r); }
    return r;
  }

  /** The quantity a comparing condition tests, where the simulation holds it. */
  private quantity(c: ConditionRecord): number | undefined {
    switch (c.type) {
      case ConditionType.Deaths: return this.world.death(c.player, c.unitId);
      case ConditionType.Accumulate: {
        // A group's is its players' together.
        const slots = this.slotsOf(c.player).filter((p) => p < 12);
        if (slots.length === 0) return undefined;
        let ore = 0, gas = 0;
        for (const p of slots) { const s = this.stockOf(p); ore += s[0]; gas += s[1]; }
        return (c.resource === ResourceType.Ore ? ore : c.resource === ResourceType.Gas ? gas : ore + gas) % U32;
      }
      case ConditionType.ElapsedTime: return Math.floor((this.shared ? this.world.frame : this.cycle) / FRAMES_PER_GAME_SECOND);
      default: return this.game.quantity(c, this.world.current);
    }
  }

  /** What a read finds: the caller's answer, else the simulation's own, else 0. */
  read(r: ReadSource): number {
    const given = this.readOf?.(r, this);
    if (given !== undefined) return Math.max(0, Math.trunc(given)) % U32;
    if (r.source === "condition") return this.quantity(r.record) ?? 0;
    // Without the map's player settings the simulated player is a human and nobody else is there; with them, those in the game are (a computer is not told apart).
    if (r.source === "player" && r.fact === "slot") return this.game.players.slots.includes(this.slotOf(r.player)) ? 2 : 0;
    return 0;
  }

  /* ── what the players do ── */

  /** A key goes down: the next frame finds it. `player` is a slot (default: the simulated player). */
  press(key: string, player = this.player): this { this.queued.events.add(`key:${player}:${keyName(key) ?? key}`); return this; }
  click(button: MouseButton = "left", player = this.player): this { this.queued.events.add(`click:${player}:${button}`); return this; }
  moveMouse(x: number, y: number, player = this.player): this { this.mice.set(player, { x, y }); return this; }
  /** What each player has selected (B5): \`local.selected\`, \`local.selectionCount\`; select() and the tests set it. */
  readonly selections = new Map<number, SimUnit[]>();
  /** A player selects units: what \`local.selected\` reads at their computer, and what select() makes it. */
  selectUnits(units: readonly SimUnit[], player = this.player): this { this.selections.set(player, units.slice(0, 12)); return this; }
  /** The unit in a slot of the selection at the computer a program reads (\`localRead\`'s), if it is still there. */
  selectedUnit(index: number): SimUnit | null {
    const u = this.selections.get(this.sendingFrom ?? this.slotOf(13))?.[index];
    return u?.alive ? u : null;
  }
  /** A player's screen moves: its top left corner to this place on the map, in pixels (what \`local.camera\` reads). */
  moveCamera(x: number, y: number, player = this.player): this { this.cameras.set(player, { x, y }); return this; }

  /**
   * \`local.…\` (B5): what this computer knows. The simulator runs every computer's programs at once, so a program reads
   * the computer of the player it runs for, and a sync()'s value is read at the computer of the player it is sent from
   * (\`sendingFrom\`).
   */
  private sendingFrom: number | null = null;
  private localRead(name: string): number | undefined {
    const at = this.sendingFrom ?? this.slotOf(13);
    const camera = this.cameras.get(at) ?? { x: 0, y: 0 };
    const mouse = this.mice.get(at) ?? camera;
    switch (name) {
      case "local.player": return at;
      case "local.camera.x": return camera.x;
      case "local.camera.y": return camera.y;
      case "local.mouse.x": return mouse.x - camera.x;
      case "local.mouse.y": return mouse.y - camera.y;
      default: {
        // A selection slot: the unit's place in the table, from 1, as a kept unit's number is here; 0 for none.
        const slot = /^local\.selection\[(\d+)\]$/.exec(name);
        if (!slot) return undefined;
        const u = this.selections.get(at)?.[Number(slot[1])];
        return u?.alive ? u.slot + 1 : 0;
      }
    }
  }

  /** While a sync()'s value is worked out: whose computer's local values it reads. */
  readAt(player: number | null): void { this.sendingFrom = player === null ? null : this.slotOf(player); }
  /** sync()'s first half: the slot's arrival cleared everywhere, and the value on its way, arriving at the next frame. */
  syncSend(slot: number, player: number, value: number): void {
    const key = `${slot}:${this.slotOf(player)}`;
    this.synced.delete(key);
    this.sending.push([key, Math.min(Math.max(0, Math.trunc(value)), 1048574) + 1]);
  }
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
      case "key": return (i.held ? this.downNow : this.current.events).has(`key:${p}:${i.key}`) ? 1 : 0;
      case "click": return this.current.events.has(`click:${p}:${i.button}`) ? 1 : 0;
      case "mouse": return this.mice.get(p)?.[i.axis] ?? 0;
      case "sync": return this.synced.get(`${i.slot}:${p}`) ?? 0;
      case "chat": {
        const line = this.current.lines.get(p);
        if (!line || line.pattern !== i.pattern) return 0;
        return i.capture === null ? 1 : line.values[i.capture] ?? 0;
      }
    }
  }

  /* ── units and tables ── */

  /** The living units a filter matches, in the order a program's loop comes to them (the players' lists: `World.listed`). */
  matching(f: UnitFilter): SimUnit[] {
    return this.game.listed(f.owner === undefined ? undefined : this.slotsOf(f.owner), f.type, f.at);
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
  centre(location: number, x: number, y: number, size?: { width: number; height: number }): void { this.game.centre(location, x, y, size); }

  private cellKey(c: TableCell): string {
    return `${c.name}:${c.player ? this.slotOf(c.index) : c.index}${c.key !== undefined ? `:${c.key}` : ""}`;
  }

  /** A cell of the game's tables, in the script's units: what a program wrote, else the caller's answer, else 0. */
  tableRead(c: TableCell): number {
    // The game's own count of frames, which a program can read and never write (memory.ts).
    if (c.name === "memory.game.frame") return this.frame;
    // The vision countdown, run down by the frames (visionStep) as much as written by the programs.
    if (c.name === "memory.vision.countdown") return this.countdown;
    const local = c.name.startsWith("local.") ? this.localRead(c.name) : undefined;
    if (local !== undefined) return local;
    const stored = this.tables.get(this.cellKey(c));
    if (typeof stored === "number") return Math.floor(stored / (c.scale ?? 1));
    const given = this.tableOf?.(c);
    return given === undefined ? 0 : Math.max(0, Math.trunc(given));
  }

  /**
   * The fog of war, as far as the simulator draws it: each player's tiles, 0 never seen, 1 seen before, 2 seen now. A
   * unit lights the tiles of its sight when it is made — a unit whose type's sight a program set (\`stats(t).sight\`),
   * with the shape a flying unit of that sight has in the game (FOG_SHAPES), which is what the fog library draws with —
   * and the vision countdown (\`memory.vision.countdown\`) run down to 0 at the start of a frame puts every tile seen
   * now back to seen before and has the units there light theirs again, as the game's frame step does.
   */
  private readonly vision = new Map<number, Uint8Array>();
  private countdown = 0;
  private visionOf(player: number): Uint8Array {
    let v = this.vision.get(player);
    if (!v) { v = new Uint8Array(FOG_SIZE * FOG_SIZE); this.vision.set(player, v); }
    return v;
  }
  private reveal(u: SimUnit): void {
    const sight = this.tables.get(`unit.sight:${u.type}`);
    if (typeof sight !== "number" || sight < 1 || u.owner > 7) return;
    const shape = FOG_SHAPES[Math.min(sight, FOG_SHAPES.length) - 1];
    const cy = shape.findIndex((r) => r.includes("@")), cx = shape[cy].indexOf("@");
    const tx = Math.floor(u.x / 32), ty = Math.floor(u.y / 32), v = this.visionOf(u.owner);
    shape.forEach((row, dy) => { for (let dx = 0; dx < row.length; dx++) if (row[dx] !== ".") { const x = tx + dx - cx, y = ty + dy - cy; if (x >= 0 && y >= 0 && x < FOG_SIZE && y < FOG_SIZE) v[y * FOG_SIZE + x] = 2; } });
  }
  /** At the start of a frame: the countdown, and the wipe when it runs out. */
  private visionStep(): void {
    if (this.countdown <= 0) return;
    if (--this.countdown > 0) return;
    this.countdown = 100;
    for (const v of this.vision.values()) for (let i = 0; i < v.length; i++) if (v[i] === 2) v[i] = 1;
    for (const u of this.world.game.units) if (u.alive) this.reveal(u);
  }
  /** What a player sees of the fog, as GameSim.fog gives it from the game: "#" now, "+" before, "." never. */
  fog(player: number, area?: { x: number; y: number; width: number; height: number }): string[] {
    const w = this.tableOf?.({ name: "memory.map.width", base: 0x57f1d4, stride: 0, index: 0, width: 2 }) || 128;
    const h = this.tableOf?.({ name: "memory.map.height", base: 0x57f1d6, stride: 0, index: 0, width: 2 }) || 128;
    const { x = 0, y = 0, width = w, height = h } = area ?? {};
    const v = this.visionOf(player), rows: string[] = [];
    for (let ty = y; ty < Math.min(y + height, FOG_SIZE); ty++) {
      let row = "";
      for (let tx = x; tx < Math.min(x + width, FOG_SIZE); tx++) row += ".+#"[v[ty * FOG_SIZE + tx]];
      rows.push(row);
    }
    return rows;
  }

  /** `scaled`: the value is already what the cell stores. A cell holds what its width allows and no more. */
  tableWrite(c: TableCell, value: number, scaled: boolean, text?: string): void {
    if (c.name === "memory.vision.countdown") this.countdown = value;
    if (text !== undefined) { this.tables.set(this.cellKey(c), text); return; }
    const raw = scaled ? value : value * (c.scale ?? 1);
    this.tables.set(this.cellKey(c), Math.min(raw, cellMax(c.width)));
  }

  /** What a program did to a unit, for the log: the game's nearest action, with the unit in words. */
  unitEvent(run: ProgramRun, type: number, u: SimUnit, at: At, extra: { location?: number; text?: string } = {}): void {
    const what = `unit ${u.slot} (type ${u.type}, P${u.owner + 1})`;
    this.events.push({ cycle: this.cycle, frame: this.frame, program: run.index, player: run.player, at, action: { ...emptyAction(), type, player: u.owner, unitId: u.type, ...(extra.location ? { location: extra.location } : {}) }, text: extra.text ? `${extra.text}: ${what}` : what });
  }

  partText(p: Exclude<TextPart, { kind: "number" | "value" | "char" }>): string {
    // A player's colour is the code of the game's texts nearest it: one character, as the game puts it there.
    return p.kind === "text" ? p.text : p.kind === "name" ? this.nameOf(this.slotOf(p.player)) : p.kind === "color" ? String.fromCharCode(this.colorOf(this.slotOf(p.player))) : "";
  }

  /** A printed text: an event like a Display Text action's, the text already filled in. */
  print(run: ProgramRun, text: string, to: number, at: At): void {
    this.events.push({ cycle: this.cycle, frame: this.frame, program: run.index, player: run.player, at, action: { ...emptyAction(), type: ActionType.DisplayText, player: to }, text });
  }

  /** An action a program takes: the world's own kinds are applied, the rest logged. */
  act(run: ProgramRun, a: ActionRecord, at: At, programText?: string): void {
    if (a.type === ActionType.SetResources) {
      // Kept as well as logged, so a read of the resources sees what the program did to them; for a group, each of its players.
      const n = a.target >>> 0;
      const set = (cur: number) => (a.modifier === SetModifier.SetTo ? n : a.modifier === SetModifier.Add ? (cur + n) % U32 : Math.max(0, cur - n));
      for (const slot of this.slotsOf(a.player)) {
        if (slot >= 12) continue;
        const stock = this.stockOf(slot);
        if (a.unitId === ResourceType.Ore || a.unitId === ResourceType.OreAndGas) stock[0] = set(stock[0]);
        if (a.unitId === ResourceType.Gas || a.unitId === ResourceType.OreAndGas) stock[1] = set(stock[1]);
      }
    }
    switch (a.type) {
      case ActionType.SetDeaths:
        this.world.changeDeath(a.player, a.unitId, a.modifier, a.target);
        return;
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
        // What is done to units is done, and said like everything else.
        const made: SimUnit[] = [];
        this.game.act(a, run.player, made);
        for (const u of made) this.reveal(u);
        const ev: ProgramEvent = { cycle: this.cycle, frame: this.frame, program: run.index, player: run.player, at, action: a };
        const text = programText ?? this.world.text(a.text);
        if (text !== undefined) ev.text = text;
        this.events.push(ev);
      }
    }
  }

  /**
   * The frame's events pass (on.created / on.died), as the game's lowering has it: a unit is seen the first time a pass
   * finds it on the map, and its death is found by the first pass after it, once. A unit made and gone between two
   * passes is neither. Each list is the latest first, as the game's lists keep them.
   */
  private eventsFrom = 0;
  /** Each unit seen on the map, with its order and type as the pass before found them (on.order / on.morphed). */
  private readonly seen = new Map<SimUnit, { order: number; type: number }>();
  private events_: Record<EventSource, { u: SimUnit; was: number }[]> = { created: [], died: [], killed: [], ordered: [], morphed: [] };
  private eventsPass(): void {
    const out: Record<EventSource, { u: SimUnit; was: number }[]> = { created: [], died: [], killed: [], ordered: [], morphed: [] };
    // Latest first, as the game's lists keep them: what was seen before this pass, then what came on since.
    for (const [u, last] of [...this.seen].reverse()) {
      if (!u.alive) {
        out.died.push({ u, was: 0 });
        if (u.killedBy !== undefined) out.killed.push({ u, was: u.killedBy });
        this.seen.delete(u);
        continue;
      }
      if (u.orderId !== last.order) { out.ordered.push({ u, was: last.order }); last.order = u.orderId; }
      if (u.type !== last.type) { out.morphed.push({ u, was: last.type }); last.type = u.type; }
    }
    const all = this.game.units;
    for (; this.eventsFrom < all.length; this.eventsFrom++) { const u = all[this.eventsFrom]; if (u.alive) { out.created.push({ u, was: 0 }); this.seen.set(u, { order: u.orderId, type: u.type }); } }
    out.created.reverse();
    this.events_ = out;
  }

  /**
   * What this frame's events pass found that a filter matches, each with what the unit was (the killer, the order it had,
   * the type it was): the units that came on, took up an order or turned into another type and are still here, or the
   * ones that died, as they died.
   */
  eventUnits(source: EventSource, f: UnitFilter, event: { order?: number; by?: number } = {}): { u: SimUnit; was: number }[] {
    const owners = f.owner === undefined ? undefined : this.slotsOf(f.owner);
    const by = event.by === undefined ? undefined : this.slotsOf(event.by);
    const dead = source === "died" || source === "killed";
    return this.events_[source].filter(({ u, was }) => (dead || u.alive) && this.game.fits(u, owners, f.type, f.at)
      && (event.order === undefined || u.orderId === event.order) && (!by || by.includes(was)));
  }

  /** One frame: every program in order, from where it left off. */
  step(): void {
    this.eventsPass();
    this.visionStep();
    // What was done since the last frame is what this one finds, and only this one.
    this.current = this.queued;
    this.queued = { events: new Set(), lines: new Map() };
    // What was sent arrives on this frame and only this one, as MSQC's cell holds it (B5).
    this.synced.clear();
    for (const [key, value] of this.sending) this.synced.set(key, value);
    this.sending = [];
    // A key or a button down on this frame and the last is held, not pressed again: the game reports the frame it goes
    // down (MSQC's KeyDown / MouseDown), however many frames a tap lasts.
    const down = new Set([...this.current.events].filter((e) => e.startsWith("key:") || e.startsWith("click:")));
    for (const e of down) if (this.down.has(e)) this.current.events.delete(e);
    this.down = down;
    // keyHeld(): down now, or let go no more than HELD_GRACE frames ago — as the game's lowering has it, which covers a
    // message that went missing on its way between the players' computers.
    for (const e of down) this.lastDown.set(e, this.frame);
    const was = this.downNow;
    this.downNow = new Set([...this.lastDown].filter(([, f]) => this.frame - f <= HELD_GRACE).map(([e]) => e));
    // With a held key in the game every key goes as held, and a press is held now and not before (compiler/input.ts).
    if (this.heldKeys) for (const e of [...this.current.events]) if (e.startsWith("key:") && (!this.downNow.has(e) || was.has(e))) this.current.events.delete(e);
    for (const run of this.runs) {
      this.world.current = run.player;
      try { run.tick(); } catch (err) { if (err instanceof Halt) throw new Error(err.message); throw err; }
    }
    this.world.current = this.world.player;
    this.cycle++;
  }

  run(cycles: number): this {
    for (let i = 0; i < cycles; i++) this.step();
    return this;
  }

  /** Whether every program has ended. */
  finished(): boolean { return this.runs.every((r) => r.done && !r.tasksRunning); }

  /** A program's run: the program by its place in the list or its name, and of a per-player program the player's (the first by default). */
  runOf(program: number | string = 0, player?: number): ProgramRun | undefined {
    return this.runs.find((r) => (typeof program === "number" ? r.index === program : r.program.name === program) && (player === undefined || r.player === player));
  }

  /** The unit a variable holds by its source name, in a program (the first by default). */
  unit(name: string, program: number | string = 0, player?: number): SimUnit | null { return this.runOf(program, player)?.unitValue(name) ?? null; }

  /** A variable's value by its source name, in a program (the first by default). */
  value(name: string, program: number | string = 0, player?: number): Value | undefined { return this.runOf(program, player)?.value(name); }
  /** A text variable's characters by its source name, in a program (the first by default). */
  text(name: string, program: number | string = 0, player?: number): string | undefined { return this.runOf(program, player)?.textValue(name); }
  /** An array's cells, by its name in the source. */
  list(name: string, program: number | string = 0, player?: number): Value[] | undefined { return this.runOf(program, player)?.list(name); }
}

/** Run a compile's programs for `cycles` frames. */
export function simulatePrograms(programs: Program[], cycles: number, options: ProgramSimulationOptions): ProgramSimulation {
  return new ProgramSimulation(programs, options).run(cycles);
}
