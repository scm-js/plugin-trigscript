/**
 * The storage a list of triggers touches — every death counter and switch its records
 * read or write — so the programs' variables can be allocated around it. One scan serves
 * both the map's hand-made triggers (`script.ts`) and the raw `trigger()` records a
 * script itself emits (`compiler.ts`): a program must not share a counter with either.
 *
 * A player field is not always a player. Below `PLAYER_SLOTS` it names one slot; the
 * groups (`CurrentPlayer`, `AllPlayers`, `Force1` …) stand for whichever slots the game
 * resolves them to, so they are expanded to every slot they could mean — `CurrentPlayer`
 * to the trigger's owners, the rest to all twelve, since the forces are not known here.
 * Anything at or past `PLAYER_GROUP_COUNT` is a raw EUD offset (`memory()`,
 * `setMemory()`), kept as it is: the death table is one flat array, `[unit][player]`,
 * so `(player, unit)` and `(player + 12·unit, 0)` are the same cell and the allocator's
 * key (`unit · 12 + player`) already says so.
 *
 * Deaths of a unit *class* (`AnyUnit`, `Men`, …) read a sum the game computes and are
 * not a cell; they reserve nothing.
 */
import { ActionType, ConditionType, PLAYER_GROUP_COUNT, PlayerGroup, SWITCH_COUNT, type TriggerRecord } from "../vendor/triggers";
import { PLAYER_SLOTS } from "./lower";

export type DeathSlot = readonly [player: number, unit: number];

export interface Storage {
  deaths: DeathSlot[];
  switches: number[];
}

/** The lowest id of a unit class (`AnyUnit`); a Deaths record at or past it is not a cell. */
const UNIT_CLASS_FIRST = 228;

/** The slots a player field of a trigger can mean, given the trigger's owners. */
export function playerSlots(player: number, owners: readonly number[]): number[] {
  if (player < PLAYER_SLOTS) return [player];
  if (player >= PLAYER_GROUP_COUNT) return [player];
  if (player === PlayerGroup.None) return [];
  if (player === PlayerGroup.CurrentPlayer) {
    const out = new Set<number>();
    for (const o of owners) for (const p of playerSlots(o, [])) if (p < PLAYER_SLOTS) out.add(p);
    return [...out].sort((a, b) => a - b);
  }
  return Array.from({ length: PLAYER_SLOTS }, (_, i) => i);
}

/** Every death counter and switch the records read or write, each once, in first-seen order. */
export function storageOf(triggers: readonly TriggerRecord[]): Storage {
  const deaths = new Map<number, DeathSlot>();
  const switches = new Set<number>();
  const cell = (player: number, unit: number, owners: readonly number[]) => {
    if (unit >= UNIT_CLASS_FIRST) return;
    for (const p of playerSlots(player, owners)) deaths.set(unit * PLAYER_SLOTS + p, [p, unit]);
  };
  const sw = (index: number) => { if (index >= 0 && index < SWITCH_COUNT) switches.add(index); };
  for (const t of triggers) {
    const owners: number[] = [];
    t.players.forEach((on, i) => { if (on) owners.push(i); });
    for (const c of t.conditions) {
      if (c.type === ConditionType.Deaths) cell(c.player, c.unitId, owners);
      else if (c.type === ConditionType.Switch) sw(c.resource);
    }
    for (const a of t.actions) {
      if (a.type === ActionType.SetDeaths) cell(a.player, a.unitId, owners);
      else if (a.type === ActionType.SetSwitch) sw(a.target);
    }
  }
  return { deaths: [...deaths.values()], switches: [...switches].sort((a, b) => a - b) };
}
