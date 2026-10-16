/**
 * A trigger interpreter: runs a trigger list on the game's schedule, frame by frame,
 * modelling the state the structured level is built on — death counters, switches, the
 * preserve flag, the wait slots — and logging every other action as an event.
 *
 * It exists so the compiler can be *tested* (a program's triggers are run and the log
 * asserted, in `tests/script-structured.test.ts`) and so the Script editor can show what
 * a program does before the map is ever loaded in the game. It is not the game: the units
 * are those of `world.ts` — made, given, moved, killed and counted, never walking or
 * fighting. A condition neither models is answered by a callback (`false` by default).
 *
 * **When the list runs** (StarCraft's own rules, read from the game and measured). The game
 * goes through the trigger list in a *pass*. A countdown decides when: it starts at 1 and
 * goes down by one each frame, a pass comes on the frame it is found at 0, and the pass
 * sets it to 30 — so the passes are on frames 2, 33, 64, …, one every 31 frames. A Wait
 * that runs out sets it to 1, so the next pass comes the frame after. A map built with a
 * program (eudplib's eudTurbo) sets it to 0 at the end of every pass: a pass every frame
 * from frame 2 (`everyFrame`).
 *
 * **A pass**: each player in the game in slot order walks the whole list (the one
 * simulated player, unless the map's player settings are given); a trigger runs when the
 * player owns it (or it is for All Players, or for the player's force) and every enabled
 * condition holds; actions run in order. A trigger without the Preserve flag or a Preserve
 * Trigger action is finished for that player once its actions are done.
 *
 * **Waits**: each player has one wait slot. A Wait starts its time in the slot and stops
 * its trigger there; the trigger carries on from that action, without looking at its
 * conditions again, at the first pass that finds the slot free — and so does the next
 * Wait of any other trigger of the same player, which stops until the slot is free. The
 * time is milliseconds at the game speed (`msPerFrame`, Fastest by default), counted down
 * each frame; it frees the slot on frame F + max(1, ⌈ms / msPerFrame⌉) of a Wait begun on
 * frame F, and the trigger goes on in the pass on the frame after. A Transmission holds
 * its trigger the same way, for its time (a computer's does nothing).
 *
 * Deaths add wraps at 2³², subtract stops at 0 — the game's behaviour; a group's deaths are
 * its players' together, and a write to a group is a write to each of them. Elapsed Time
 * is whole game seconds of 16 frames.
 */
import {
  ActionFlag, ActionType, Comparison, ConditionFlag, ConditionType, SetModifier, SWITCH_COUNT, SwitchAction, SwitchState, TriggerFlag,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import type { ScriptString } from "./runtime";
import { World, type WorldOptions } from "./world";

export interface SimulationEvent {
  /** 0-based pass. */
  cycle: number;
  /** The game's frame it happened in: the first pass is on frame 2. */
  frame: number;
  /** Index of the trigger in the list. */
  trigger: number;
  /** The player it ran for. */
  player: number;
  action: ActionRecord;
  /** The action's text, when it has one and the simulation can resolve it. */
  text?: string;
}

export interface SimulationOptions extends WorldOptions {
  /** The player the triggers run as (0-based) when no `players` are given, and the one an input or a log is for; default: the first player any trigger is owned by. */
  player?: number;
  /** Asked before the simulation's own answer: a condition the caller wants to decide (undefined leaves it to the simulation), and the ones it does not model (scores, the countdown). Default: false. */
  condition?: (c: ConditionRecord, sim: Simulation) => boolean | undefined;
  /** For Randomize Switch; default Math.random. */
  random?: () => number;
  /** Text of a string id — the compiler's local table, or a function over the map's. */
  strings?: ScriptString[] | ((index: number) => string | null);
  /** Stop a cycle after this many trigger runs (a runaway guard); default 100 000. */
  maxRunsPerCycle?: number;
  /** A pass every frame from the first, as in a map built with a program (eudplib's eudTurbo). Default: the game's own schedule, one every 31 frames. */
  everyFrame?: boolean;
  /** How many milliseconds a frame lasts at the game speed, which a Wait is counted down in: 42 at Fastest (the default), 67 at Normal, 167 at Slowest. */
  msPerFrame?: number;
  /** The computer players: a Transmission of theirs does nothing. */
  computers?: readonly number[];
}

/** One player's copy of a trigger, as it stands between passes. */
interface Copy {
  /** Its actions are under way: the next pass carries on at `at` without looking at the conditions. */
  executing: boolean;
  at: number;
  /** Preserve Trigger has run, or the record has the flag: it starts again when it reaches its end. */
  preserved: boolean;
  /** The Waits and Transmissions of this copy that have started their time and not yet gone on. */
  started: Set<number>;
}

/** A wait slot that never frees. */
const FOREVER = 0xffffffff;

export class Simulation {
  readonly triggers: TriggerRecord[];
  /** The simulated player: the only one, without the map's player settings; with them, the one inputs and logs default to. */
  readonly player: number;
  /** The player a trigger or a program is running as right now: who Current Player is. */
  current: number;
  /** The units, the locations and who the players are. */
  readonly game: World;
  readonly events: SimulationEvent[] = [];
  readonly switches = new Uint8Array(SWITCH_COUNT);
  private readonly deaths = new Map<number, number>();
  /** Trigger × player, for the triggers that ran without Preserve. */
  private readonly done = new Set<number>();
  /** Trigger × player: the copies that have run, where they stand. */
  private readonly copies = new Map<number, Copy>();
  /** Each player's wait slot while it is busy: the milliseconds left. */
  readonly waiting = new Map<number, number>();
  private readonly options: SimulationOptions;
  /** Passes run. */
  cycle = 0;
  /** Frames run: the game's frame number. */
  frame = 0;
  /** The game's pass countdown: a pass on the frame it is found at 0. */
  private countdown = 1;

  constructor(triggers: TriggerRecord[], options: SimulationOptions = {}) {
    this.triggers = triggers;
    this.options = options;
    this.player = options.player ?? options.players?.[0] ?? (triggers.map((t) => t.players.findIndex((v, i) => v && i < 12)).find((p) => p >= 0) ?? 0);
    this.current = this.player;
    this.game = new World(options, this.player);
    // A unit that is killed is a death of its type for its owner, in the table the script's own counters are in.
    this.game.onDeath = (u) => this.deaths.set(u.type * 4096 + u.owner, ((this.deaths.get(u.type * 4096 + u.owner) ?? 0) + 1) >>> 0);
  }

  /** A player's deaths of a unit; a group's are its players' together. */
  death(player: number, unit: number): number {
    let n = 0;
    for (const p of this.game.players.of(player, this.current)) n += this.deaths.get(unit * 4096 + p) ?? 0;
    return n >>> 0;
  }

  /** Set for a player, or for each player of a group. */
  setDeath(player: number, unit: number, value: number) {
    for (const p of this.game.players.of(player, this.current)) this.deaths.set(unit * 4096 + p, value >>> 0);
  }

  /** A Set Deaths action: set to, add or subtract, for each player the action names. */
  changeDeath(player: number, unit: number, modifier: number, amount: number) {
    const n = amount >>> 0;
    for (const p of this.game.players.of(player, this.current)) {
      const cur = this.deaths.get(unit * 4096 + p) ?? 0;
      this.deaths.set(unit * 4096 + p, (modifier === SetModifier.SetTo ? n : modifier === SetModifier.Add ? cur + n : Math.max(0, cur - n)) >>> 0);
    }
  }

  text(index: number): string | undefined {
    const { strings } = this.options;
    if (!strings || index === 0) return undefined;
    if (typeof strings === "function") return strings(index) ?? undefined;
    const s = strings[index - 1];
    return s && "text" in s ? s.text : undefined;
  }

  /** One frame of the game: the wait slots counted down, then a pass if one is due. True when a pass ran. */
  tick(): boolean {
    this.frame++;
    const ms = this.options.msPerFrame ?? 42;
    for (const [player, left] of this.waiting) {
      if (left === FOREVER) continue;
      if (ms < left) this.waiting.set(player, left - ms);
      else { this.waiting.delete(player); this.countdown = 1; }
    }
    const due = this.countdown === 0;
    this.countdown = Math.max(0, this.countdown - 1);
    if (!due) return false;
    this.pass();
    return true;
  }

  /** Frames until the next pass, and that pass. */
  step() {
    while (!this.tick());
    return this;
  }

  /** `cycles` passes. */
  run(cycles: number) {
    for (let i = 0; i < cycles; i++) this.step();
    return this;
  }

  /** One pass of the list, as the game makes it. */
  private pass() {
    this.countdown = 30;
    let runs = 0;
    const limit = this.options.maxRunsPerCycle ?? 100_000;
    // As the game does: each player in turn walks the whole list. Without player settings a force's trigger runs for the one player.
    for (const player of this.game.players.slots) {
      this.current = player;
      for (let i = 0; i < this.triggers.length; i++) {
        const t = this.triggers[i], key = i * 12 + player;
        if (this.done.has(key) || t.flags & TriggerFlag.Disabled) continue;
        if (!this.game.players.owns(t.players, player)) continue;
        let copy = this.copies.get(key);
        if (!copy?.executing) {
          if (!t.conditions.every((c) => this.condition(c))) continue;
          if (++runs > limit) throw new Error(`More than ${limit} trigger runs in one cycle.`);
          copy = { executing: true, at: 0, preserved: copy?.preserved || (t.flags & TriggerFlag.Preserve) !== 0, started: new Set() };
          this.copies.set(key, copy);
        }
        let held = false;
        for (; copy.at < t.actions.length; copy.at++) {
          const a = t.actions[copy.at];
          if (a.type === ActionType.None) break;
          if (a.flags & ActionFlag.Disabled) continue;
          if (!this.action(a, i, copy)) { held = true; break; }
        }
        if (held) continue;
        if (copy.preserved) { copy.executing = false; copy.at = 0; copy.started.clear(); }
        else this.done.add(key);
      }
    }
    this.current = this.player;
    this.cycle++;
    if (this.options.everyFrame) this.countdown = 0;
  }

  private condition(c: ConditionRecord): boolean {
    if (c.flags & ConditionFlag.Disabled) return true;
    switch (c.type) {
      case ConditionType.Always: return true;
      case ConditionType.Never: return false;
      case ConditionType.Deaths: return compare(this.death(c.player, c.unitId), c.comparison, c.amount);
      case ConditionType.Switch: return c.comparison === SwitchState.Set ? this.switches[c.resource] === 1 : this.switches[c.resource] === 0;
      case ConditionType.ElapsedTime: return this.options.condition?.(c, this) ?? compare(Math.floor(this.frame / 16), c.comparison, c.amount);
      default: return this.options.condition?.(c, this) ?? this.game.holds(c, this.current) ?? false;
    }
  }

  /** Runs an action of a copy; false when it holds the trigger there (a Wait or a Transmission with its time to run). */
  private action(a: ActionRecord, trigger: number, copy: Copy): boolean {
    switch (a.type) {
      case ActionType.PreserveTrigger:
        copy.preserved = true;
        return true;
      case ActionType.Wait:
      case ActionType.Transmission: {
        const player = this.current;
        // A Transmission with no location does nothing at all, and a computer's does nothing.
        if (a.type === ActionType.Transmission && (a.location === 0 || this.options.computers?.includes(player))) return true;
        if (this.waiting.has(player)) return false;
        if (copy.started.delete(copy.at)) return true;
        let ms = a.time >>> 0;
        if (a.type === ActionType.Transmission) {
          const n = a.target >>> 0;
          ms = a.modifier === SetModifier.SetTo ? n : a.modifier === SetModifier.Add ? (ms + n) >>> 0 : a.modifier === SetModifier.Subtract ? (n > ms ? 0 : ms - n) : ms;
        }
        this.waiting.set(player, ms);
        copy.started.add(copy.at);
        this.log(a, trigger);
        return false;
      }
      case ActionType.SetDeaths:
        this.changeDeath(a.player, a.unitId, a.modifier, a.target);
        return true;
      case ActionType.SetSwitch: {
        const i = a.target;
        if (i < 0 || i >= SWITCH_COUNT) return true;
        switch (a.modifier) {
          case SwitchAction.Set: this.switches[i] = 1; break;
          case SwitchAction.Clear: this.switches[i] = 0; break;
          case SwitchAction.Toggle: this.switches[i] ^= 1; break;
          case SwitchAction.Randomize: this.switches[i] = (this.options.random ?? Math.random)() < 0.5 ? 0 : 1; break;
        }
        return true;
      }
      case ActionType.Comment:
        return true;
      default:
        // What is done to units is done, and said like everything else.
        this.game.act(a, this.current);
        this.log(a, trigger);
        return true;
    }
  }

  private log(a: ActionRecord, trigger: number) {
    const ev: SimulationEvent = { cycle: this.cycle, frame: this.frame, trigger, player: this.current, action: a };
    const text = this.text(a.text);
    if (text !== undefined) ev.text = text;
    this.events.push(ev);
  }
}

function compare(value: number, comparison: number, amount: number): boolean {
  const n = amount >>> 0;
  switch (comparison) {
    case Comparison.AtLeast: return value >= n;
    case Comparison.AtMost: return value <= n;
    case Comparison.Exactly: return value === n;
    default: return false;
  }
}

/** Compile-result convenience: run a script's triggers for `cycles` passes. */
export function simulate(triggers: TriggerRecord[], cycles: number, options: SimulationOptions = {}): Simulation {
  return new Simulation(triggers, options).run(cycles);
}
