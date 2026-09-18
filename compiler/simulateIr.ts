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
 * Numbers keep the one contract: an expression is its exact value; stored below zero as
 * 0, at 2³² or above wrapped, a `u8` / `u16` saturated at its maximum. The world — death
 * counters the script names, switches, the conditions the interpreter cannot answer,
 * the strings — is a trigger `Simulation`, shared with any `trigger()` records run beside
 * the programs, so an action a program takes is seen by a hand trigger and the other way
 * round.
 */
import { ActionType, Comparison, ConditionType, SetModifier, SWITCH_COUNT, SwitchAction, SwitchState, type ActionRecord, type ConditionRecord } from "../vendor/triggers";
import { emptyAction, PlayerGroup, ResourceType } from "../vendor/triggers";
import type { At, BoolExpr, Call, NumExpr, Program, ReadSource, Stmt, TextPart, VarDecl } from "./ir";
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
}

/** What an expression adds and what it subtracts: the constants exactly, the rest wrapping at 2³² as the game's additions do. */
interface Sides { plus: number; minus: number; plusConst: number; minusConst: number; variable: boolean }
const newSides = (): Sides => ({ plus: 0, minus: 0, plusConst: 0, minusConst: 0, variable: false });
function add(sides: Sides, sign: 1 | -1, value: number, buildTime: boolean) {
  if (buildTime) { if (sign > 0) sides.plusConst += value; else sides.minusConst += value; return; }
  sides.variable = true;
  if (sign > 0) sides.plus = (sides.plus + value) % U32; else sides.minus = (sides.minus + value) % U32;
}
/** The two sums as the game has them: exact while every term was known when the script was built, else wrapped. */
function totals(sides: Sides): [number, number] {
  if (!sides.variable) return [sides.plusConst, sides.minusConst];
  return [(sides.plusConst % U32 + sides.plus) % U32, (sides.minusConst % U32 + sides.minus) % U32];
}
function difference(sides: Sides, absolute = false): number {
  const [p, n] = totals(sides);
  return (absolute ? Math.abs(p - n) : Math.max(p - n, 0)) % U32;
}
/** Whether the lowering sees a plain integer here: constants, and arithmetic over nothing but constants. */
function isBuildTime(e: NumExpr): boolean {
  switch (e.kind) {
    case "const": return true;
    case "unary": return isBuildTime(e.expr);
    case "binary": return isBuildTime(e.left) && isBuildTime(e.right);
    case "intrinsic": return e.args.every(isBuildTime);
    default: return false;
  }
}

type Flow = "next" | "break" | "continue" | "return";
type Exec = Generator<undefined, Flow, undefined>;
type Value = number | boolean;

interface Ctx {
  /** Inside an inlined call: where `return` writes. */
  fn?: { result?: string };
}

class Halt extends Error {}

/** One program's run: its variables, its latches, and the coroutine that is its body. */
class ProgramRun {
  readonly vars = new Map<string, Value>();
  readonly bits = new Map<string, 8 | 16>();
  readonly latches = new Map<object, boolean>();
  body: Exec | null;
  done = false;
  steps = 0;
  readonly sim: ProgramSimulation;
  readonly index: number;
  readonly program: Program;

  constructor(sim: ProgramSimulation, index: number, program: Program) {
    this.sim = sim;
    this.index = index;
    this.program = program;
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
    const r = this.body.next();
    if (r.done) { this.done = true; this.body = null; }
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

  private store(id: string, value: Value): void {
    if (typeof value === "number") {
      let v = Math.trunc(value);
      if (v < 0) v = 0;
      else if (v >= U32) v = v % U32;
      const bits = this.bits.get(id);
      if (bits) v = Math.min(v, 2 ** bits - 1);
      this.vars.set(id, v);
    } else {
      this.vars.set(id, value);
    }
  }

  private declare(decl: VarDecl): void {
    if (decl.bits) this.bits.set(decl.id, decl.bits);
    this.vars.set(decl.id, decl.kind === "number" ? 0 : false);
  }

  /* ── expressions ── */

  /**
   * A number, the way the game computes it (`python/trigscript.py`): + and − are flattened
   * into what is added and what is subtracted, each side summed — wrapping at 2³² once a
   * variable is part of it — and the difference stops at 0. Everything else is a term:
   * × wraps, ÷ and % round down and give 0 for a divisor of 0.
   */
  private *num(e: NumExpr): Generator<undefined, number, undefined> {
    if (e.kind === "unary" || (e.kind === "binary" && (e.op === "+" || e.op === "-")) || (e.kind === "const" && e.value < 0)) {
      const sides = newSides();
      yield* this.linear(e, sides, 1);
      return difference(sides);
    }
    return yield* this.term(e);
  }

  private *linear(e: NumExpr, sides: Sides, sign: 1 | -1): Generator<undefined, void, undefined> {
    if (e.kind === "binary" && (e.op === "+" || e.op === "-")) {
      yield* this.linear(e.left, sides, sign);
      yield* this.linear(e.right, sides, e.op === "+" ? sign : (-sign as 1 | -1));
    } else if (e.kind === "unary") {
      yield* this.linear(e.expr, sides, -sign as 1 | -1);
    } else if (e.kind === "const" && e.value < 0) {
      add(sides, -sign as 1 | -1, -e.value, true);
    } else {
      add(sides, sign, yield* this.term(e), isBuildTime(e));
    }
  }

  private *term(e: NumExpr): Generator<undefined, number, undefined> {
    switch (e.kind) {
      // A constant below zero as a factor or a divisor is its 32-bit pattern, as it is in the game.
      case "const": return ((Math.trunc(e.value) % U32) + U32) % U32;
      case "var": return Number(this.read(e.id));
      case "unary": return yield* this.num(e);
      case "binary": {
        const a = yield* this.num(e.left);
        const b = yield* this.num(e.right);
        switch (e.op) {
          case "*": return Number((BigInt(a) * BigInt(b)) % BigInt(U32));
          case "/": return b === 0 ? 0 : Math.floor(a / b);
          case "%": return b === 0 ? 0 : a % b;
          case "&": return (a & b) >>> 0;
          case "|": return (a | b) >>> 0;
          case "^": return (a ^ b) >>> 0;
          // A shift by 32 or more leaves nothing, where JavaScript would shift by the remainder.
          case "<<": return b >= 32 ? 0 : (a << b) >>> 0;
          case ">>": return b >= 32 ? 0 : a >>> b;
          default: return yield* this.num(e);
        }
      }
      case "read": return this.sim.read(e.read);
      case "randomInt": {
        const n = yield* this.num(e.bound);
        return n === 0 ? 0 : Math.min(n - 1, Math.floor(this.sim.random() * n));
      }
      case "ternary": return (yield* this.bool(e.cond)) ? yield* this.num(e.whenTrue) : yield* this.num(e.whenFalse);
      case "intrinsic": {
        if (e.name === "abs") {
          const sides = newSides();
          yield* this.linear(e.args[0], sides, 1);
          return difference(sides, true);
        }
        const args: number[] = [];
        for (const a of e.args) args.push(yield* this.num(a));
        return e.name === "min" ? Math.min(...args) : Math.max(...args);
      }
      case "call": return Number(yield* this.call(e.call));
    }
  }

  private *bool(e: BoolExpr): Generator<undefined, boolean, undefined> {
    switch (e.kind) {
      case "const": return e.value;
      case "cond": return this.sim.condition(e.record);
      case "var": return Boolean(this.read(e.id));
      case "test": return (yield* this.num(e.expr)) !== 0;
      case "compare": {
        // What either side subtracts is added to the other: a - b == 0 asks whether a == b, and x >= -1 is true.
        const sides = newSides();
        yield* this.linear(e.left, sides, 1);
        yield* this.linear(e.right, sides, -1);
        const [a, b] = totals(sides);
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
    }
  }

  private *init(e: NumExpr | BoolExpr, kind: "number" | "boolean"): Generator<undefined, Value, undefined> {
    return kind === "number" ? yield* this.num(e as NumExpr) : yield* this.bool(e as BoolExpr);
  }

  private *call(c: Call): Generator<undefined, Value, undefined> {
    if (c.result) this.declare(c.result.decl);
    for (const p of c.params) {
      this.declare(p.decl);
      this.store(p.decl.id, yield* this.init(p.init, p.decl.kind));
    }
    const flow = yield* this.block(c.body, { fn: { result: c.result?.decl.id } });
    if (flow === "break" || flow === "continue") throw new Error(`${flow} inside a function reached its end (line ${c.at.line}).`);
    return c.result ? this.read(c.result.decl.id) : 0;
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
        if (!s.failed) this.store(s.decl.id, yield* this.init(s.init, s.decl.kind));
        return "next";
      }
      case "assign": this.store(s.target, yield* this.num(s.value)); return "next";
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
        let from = s.cases.findIndex((c) => c.value !== null && c.value === v);
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
        if (s.value && ctx.fn?.result) this.store(ctx.fn.result, yield* this.init(s.value, typeof this.read(ctx.fn.result) === "number" ? "number" : "boolean"));
        return "return";
      }
      case "sleep": {
        const n = s.cycles ?? Math.max(1, Math.round((s.ms ?? 0) / 1000 * FRAMES_PER_SECOND));
        for (let i = 0; i < n; i++) yield;
        return "next";
      }
      case "action": {
        const record: ActionRecord = { ...s.record };
        if (s.variable) {
          // A unit count is that many units (the game does the action once for each), whatever a byte could hold.
          (record as unknown as Record<string, number>)[s.variable.field as string] = yield* this.num(s.variable.expr);
        }
        this.sim.act(this, record, s.at);
        return "next";
      }
      case "print": {
        let text = "";
        for (const p of s.parts) text += p.kind === "number" ? String(yield* this.num(p.expr)) : this.sim.partText(p);
        this.sim.print(this, text, s.to, s.at);
        return "next";
      }
      case "call": { yield* this.call(s.call); return "next"; }
      case "block": return yield* this.block(s.body, ctx);
      case "remark": return "next";
    }
  }

  /** A user variable's value by its source name (the last declared with that name). */
  value(name: string): Value | undefined {
    let found: Value | undefined;
    for (const [id, v] of this.vars) if (id === name || id.startsWith(`${name}#`)) found = v;
    return found;
  }
}

export class ProgramSimulation {
  readonly world: Simulation;
  readonly runs: ProgramRun[];
  readonly events: ProgramEvent[] = [];
  readonly maxSteps: number;
  readonly random: () => number;
  private readonly conditionOf?: SimulationOptions["condition"];
  private readonly readOf?: ProgramSimulationOptions["read"];
  private readonly nameOf: (player: number) => string;
  /** Ore and gas by player slot, as the programs' own setResources actions leave them. */
  private readonly resources = new Map<number, [ore: number, gas: number]>();
  cycle = 0;

  constructor(programs: Program[], options: ProgramSimulationOptions) {
    this.world = options.world ?? new Simulation([], { player: options.player ?? programs[0]?.owner ?? 0, condition: options.condition, random: options.random, strings: options.strings });
    this.maxSteps = options.maxStepsPerCycle ?? 100_000;
    this.random = options.random ?? Math.random;
    this.conditionOf = options.condition;
    this.readOf = options.read;
    this.nameOf = options.playerName ?? ((p) => `Player ${p + 1}`);
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

  partText(p: Exclude<TextPart, { kind: "number" }>): string {
    // A colour is a control character in the game; the log keeps the words.
    return p.kind === "text" ? p.text : p.kind === "name" ? this.nameOf(this.slotOf(p.player)) : "";
  }

  /** A printed text: an event like a Display Text action's, the text already filled in. */
  print(run: ProgramRun, text: string, to: number, at: At): void {
    this.events.push({ cycle: this.cycle, program: run.index, at, action: { ...emptyAction(), type: ActionType.DisplayText, player: to }, text });
  }

  /** An action a program takes: the world's own kinds are applied, the rest logged. */
  act(run: ProgramRun, a: ActionRecord, at: At): void {
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
        const text = this.world.text(a.text);
        if (text !== undefined) ev.text = text;
        this.events.push(ev);
      }
    }
  }

  /** One frame: every program in order, from where it left off. */
  step(): void {
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

  /** A variable's value by its source name, in a program (the first by default). */
  value(name: string, program = 0): Value | undefined { return this.runs[program]?.value(name); }
}

/** Run a compile's programs for `cycles` frames. */
export function simulatePrograms(programs: Program[], cycles: number, options: ProgramSimulationOptions): ProgramSimulation {
  return new ProgramSimulation(programs, options).run(cycles);
}
