/**
 * `storageOf`: the cells a list of records touches, with player groups expanded to the
 * slots they can mean.
 */
import { describe, expect, it } from "vitest";
import { ActionType, ConditionType, emptyAction, emptyCondition, emptyTrigger, PlayerGroup, UnitClass, type TriggerRecord } from "../vendor/triggers";
import { playerSlots, storageOf } from "../compiler/reserve";

const ALL = Array.from({ length: 12 }, (_, i) => i);

function trigger(owners: number[], build: (t: TriggerRecord) => void): TriggerRecord {
  const t = emptyTrigger();
  for (const o of owners) t.players[o] = 1;
  build(t);
  return t;
}
const deaths = (player: number, unitId: number) => ({ ...emptyCondition(), type: ConditionType.Deaths, player, unitId });
const setDeaths = (player: number, unitId: number) => ({ ...emptyAction(), type: ActionType.SetDeaths, player, unitId });

describe("player slots", () => {
  it("a player is itself, None is nothing, a group is every slot", () => {
    expect(playerSlots(4, [])).toEqual([4]);
    expect(playerSlots(PlayerGroup.None, [0])).toEqual([]);
    expect(playerSlots(PlayerGroup.AllPlayers, [0])).toEqual(ALL);
    expect(playerSlots(PlayerGroup.Force2, [0])).toEqual(ALL);
    expect(playerSlots(PlayerGroup.Foes, [0])).toEqual(ALL);
  });

  it("CurrentPlayer is the trigger's owners, themselves expanded", () => {
    expect(playerSlots(PlayerGroup.CurrentPlayer, [PlayerGroup.Player1, PlayerGroup.Player3])).toEqual([0, 2]);
    expect(playerSlots(PlayerGroup.CurrentPlayer, [PlayerGroup.Force1])).toEqual(ALL);
    expect(playerSlots(PlayerGroup.CurrentPlayer, [])).toEqual([]);
  });

  it("an EUD offset past the groups is kept as it is", () => {
    expect(playerSlots(5000, [0])).toEqual([5000]);
  });
});

describe("storageOf", () => {
  it("collects conditions and actions, each cell once", () => {
    const list = [
      trigger([0], (t) => { t.conditions.push(deaths(0, 181), { ...emptyCondition(), type: ConditionType.Switch, resource: 7 }); t.actions.push(setDeaths(0, 181), setDeaths(1, 181), { ...emptyAction(), type: ActionType.SetSwitch, target: 255 }); }),
    ];
    expect(storageOf(list)).toEqual({ deaths: [[0, 181], [1, 181]], switches: [7, 255] });
  });

  it("expands a group through the trigger's owners", () => {
    expect(storageOf([trigger([0, 2], (t) => t.actions.push(setDeaths(PlayerGroup.CurrentPlayer, 181)))]).deaths).toEqual([[0, 181], [2, 181]]);
    expect(storageOf([trigger([PlayerGroup.AllPlayers], (t) => t.actions.push(setDeaths(PlayerGroup.CurrentPlayer, 181)))]).deaths.map(([p]) => p)).toEqual(ALL);
    expect(storageOf([trigger([0], (t) => t.conditions.push(deaths(PlayerGroup.Force3, 181)))]).deaths.map(([p]) => p)).toEqual(ALL);
  });

  it("a unit class is a sum the game computes, not a cell; a raw offset is a cell", () => {
    expect(storageOf([trigger([0], (t) => t.conditions.push(deaths(0, UnitClass.Any)))]).deaths).toEqual([]);
    expect(storageOf([trigger([0], (t) => t.actions.push(setDeaths(2173, 0)))]).deaths).toEqual([[2173, 0]]);
  });

  it("a switch out of range is ignored", () => {
    expect(storageOf([trigger([0], (t) => t.actions.push({ ...emptyAction(), type: ActionType.SetSwitch, target: 300 }))]).switches).toEqual([]);
  });
});
