/**
 * A trigger-cycle interpreter: runs a trigger list the way the game does for one player,
 * cycle by cycle, modelling exactly the state the structured level is built on — death
 * counters, switches, the preserve flag — and logging every other action as an event.
 *
 * It exists so the compiler can be *tested* (a program's triggers are run and the log
 * asserted, in `tests/script-structured.test.ts`) and so the Script editor can show what
 * a program does before the map is ever loaded in the game. It is not the game: Wait
 * takes no time, and the units are those of `world.ts` — made, given, moved, killed and
 * counted, never walking or fighting. A condition neither models is answered by a
 * callback (`false` by default).
 *
 * Semantics modelled: the list is walked in order once per cycle for each player in the
 * game (the one simulated player, unless the map's player settings are given); a trigger
 * runs when the player owns it (or it is for All Players, or for the player's force) and
 * every enabled condition holds; actions run in order; a trigger without the Preserve flag
 * or a Preserve Trigger action runs once for each player. Deaths add wraps at 2³², subtract
 * stops at 0 — the game's behaviour; a group's deaths are its players' together, and a
 * write to a group is a write to each of them.
 */
import {
  ActionFlag, ActionType, Comparison, ConditionFlag, ConditionType, SetModifier, SWITCH_COUNT, SwitchAction, SwitchState, TriggerFlag,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import type { ScriptString } from "./runtime";
import { World, type WorldOptions } from "./world";

export interface SimulationEvent {
  /** 0-based cycle. */
  cycle: number;
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
}

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
  private readonly options: SimulationOptions;
  cycle = 0;

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

  /** Run one trigger cycle. */
  step() {
    let runs = 0;
    const limit = this.options.maxRunsPerCycle ?? 100_000;
    // As the game does: each player in turn walks the whole list. Without player settings a force's trigger runs for the one player.
    for (const player of this.game.players.slots) {
      this.current = player;
      for (let i = 0; i < this.triggers.length; i++) {
        const t = this.triggers[i];
        if (this.done.has(i * 12 + player) || t.flags & TriggerFlag.Disabled) continue;
        if (!this.game.players.owns(t.players, player)) continue;
        if (!t.conditions.every((c) => this.condition(c))) continue;
        if (++runs > limit) throw new Error(`More than ${limit} trigger runs in one cycle.`);
        let preserve = (t.flags & TriggerFlag.Preserve) !== 0;
        for (const a of t.actions) {
          if (a.flags & ActionFlag.Disabled) continue;
          if (a.type === ActionType.PreserveTrigger) preserve = true;
          else this.action(a, i);
        }
        if (!preserve) this.done.add(i * 12 + player);
      }
    }
    this.current = this.player;
    this.cycle++;
  }

  run(cycles: number) {
    for (let i = 0; i < cycles; i++) this.step();
    return this;
  }

  private condition(c: ConditionRecord): boolean {
    if (c.flags & ConditionFlag.Disabled) return true;
    switch (c.type) {
      case ConditionType.Always: return true;
      case ConditionType.Never: return false;
      case ConditionType.Deaths: return compare(this.death(c.player, c.unitId), c.comparison, c.amount);
      case ConditionType.Switch: return c.comparison === SwitchState.Set ? this.switches[c.resource] === 1 : this.switches[c.resource] === 0;
      default: return this.options.condition?.(c, this) ?? this.game.holds(c, this.current) ?? false;
    }
  }

  private action(a: ActionRecord, trigger: number) {
    switch (a.type) {
      case ActionType.SetDeaths:
        this.changeDeath(a.player, a.unitId, a.modifier, a.target);
        return;
      case ActionType.SetSwitch: {
        const i = a.target;
        if (i < 0 || i >= SWITCH_COUNT) return;
        switch (a.modifier) {
          case SwitchAction.Set: this.switches[i] = 1; break;
          case SwitchAction.Clear: this.switches[i] = 0; break;
          case SwitchAction.Toggle: this.switches[i] ^= 1; break;
          case SwitchAction.Randomize: this.switches[i] = (this.options.random ?? Math.random)() < 0.5 ? 0 : 1; break;
        }
        return;
      }
      case ActionType.Comment:
        return;
      default: {
        // What is done to units is done, and said like everything else.
        this.game.act(a, this.current);
        const ev: SimulationEvent = { cycle: this.cycle, trigger, player: this.current, action: a };
        const text = this.text(a.text);
        if (text !== undefined) ev.text = text;
        this.events.push(ev);
      }
    }
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

/** Compile-result convenience: run a script's triggers for `cycles` cycles. */
export function simulate(triggers: TriggerRecord[], cycles: number, options: SimulationOptions = {}): Simulation {
  return new Simulation(triggers, options).run(cycles);
}
