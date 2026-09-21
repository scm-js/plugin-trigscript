/**
 * The simulated game's units and players (`compiler/world.ts`): what `createUnit` and the
 * rest do in the simulator, what the unit conditions answer, and a world of several players.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { Simulation } from "../compiler/simulate";
import { ProgramSimulation, type ProgramSimulationOptions } from "../compiler/simulateIr";
import { UNIT_SLOTS, World } from "../compiler/world";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const MARINE = 0, ZERGLING = 37;
const HOME = "(1 as Location)", FIELD = "(2 as Location)";
const LOCATIONS = { 1: { left: 0, top: 0, right: 200, bottom: 200 }, 2: { left: 1000, top: 1000, right: 1200, bottom: 1100 } };
const TABLE: ProgramSimulationOptions["table"] = (c) => (c.name === "unit.maxHp" ? (c.index === MARINE ? 40 : 35) : c.name === "unit.maxShields" ? 0 : undefined);

const compileFile = (src: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
  expect(r.diagnostics.map((d) => `${d.line}:${d.message}`)).toEqual([]);
  return r;
};
const run = (body: string, frames = 1, options: Partial<ProgramSimulationOptions> = {}, programOptions = "") => {
  const r = compileFile(`program(() => {${body}}${programOptions});`);
  return new ProgramSimulation(r.ir, { strings: r.strings, locations: LOCATIONS, table: TABLE, ...options }).run(frames);
};
const shown = (sim: ProgramSimulation) => sim.events.filter((e) => e.text !== undefined && !/^unit \d/.test(e.text)).map((e) => e.text);

describe("units are made", () => {
  it("at the location's centre, with the type's hit points, and a loop finds them", () => {
    const sim = run(`createUnit(P1, units.TerranMarine, 3, ${HOME}); let n = 0; let hp = 0; for (const u of unitsAt(${HOME}, { owner: P1 })) { n++; hp += u.hp; } print(\`\${n} \${hp} \${countUnits(P1, units.TerranMarine, ${HOME})} \${countUnits(P1, units.TerranMarine, ${FIELD})}\`);`);
    expect(shown(sim)).toEqual(["3 120 3 0"]);
    expect(sim.units.map((u) => [u.x, u.y, u.slot])).toEqual([[100, 100, 0], [100, 100, 1], [100, 100, 2]]);
  });

  it("a type's hit points a program wrote are what the next one is made with", () => {
    const sim = run(`stats(units.TerranMarine).maxHp = 500; createUnit(P1, units.TerranMarine, 1, ${HOME}); const m = first({ type: units.TerranMarine }); print(\`\${m ? m.hp : 0}\`);`);
    expect(shown(sim)).toEqual(["500"]);
  });

  it("with properties: the slot's percentages and flags", () => {
    const sim = run(`createUnitWithProperties(P1, units.TerranMarine, 1, ${HOME}, 2);`, 1, { properties: (slot) => (slot === 2 ? { hpPercent: 50, invincible: true } : undefined) });
    expect(sim.units[0]).toMatchObject({ hp: 20, maxHp: 40, invincible: true });
  });

  it("the conditions that count units answer from the table", () => {
    const sim = run(`let seen = 0; while (true) { if (bring(P1, units.TerranMarine, ${HOME}, ">=", 2) && command(P1, units.Men, "==", 2) && !bring(P2, units.AnyUnit, ${HOME}, ">=", 1)) seen++; createUnit(P1, units.TerranMarine, 1, ${HOME}); sleep(frames(1)); }`, 4);
    // True on the frame that starts with two Marines, and on no other.
    expect(sim.value("seen")).toBe(1);
  });

  it("no unit is made when the table is full, as in the game", () => {
    const world = new World({}, 0);
    for (let i = 0; i < UNIT_SLOTS; i++) expect(world.make({ type: MARINE, owner: 0 })).not.toBeNull();
    expect(world.make({ type: MARINE, owner: 0 })).toBeNull();
  });
});

describe("what is done to units", () => {
  it("gives, moves, kills some and removes the rest; deaths are counted, removals are not", () => {
    const sim = run(`
      createUnit(P1, units.TerranMarine, 5, ${HOME});
      giveUnits(P1, P2, units.TerranMarine, 2, ${HOME});
      moveUnit(P2, units.TerranMarine, "All", ${HOME}, ${FIELD});
      const a = countUnits(P1, units.TerranMarine, ${HOME}); const b = countUnits(P2, units.TerranMarine, ${FIELD});
      killUnitAt(P1, units.TerranMarine, 2, ${HOME});
      removeUnit(P2, units.TerranMarine);
      print(\`\${a} \${b} \${countUnits(P1, units.AnyUnit)} \${countUnits(P2, units.AnyUnit)} \${deaths(P1, units.TerranMarine)} \${deaths(P2, units.TerranMarine)}\`);`);
    expect(shown(sim)).toContain("3 2 1 0 2 0");
    expect(sim.units.filter((u) => u.owner === 1).map((u) => [u.x, u.y])).toEqual([[1100, 1050], [1100, 1050]]);
  });

  it("sets hit points by percent, makes invincible, and centres a location on a unit", () => {
    const sim = run(`
      createUnit(P1, units.TerranMarine, 1, ${FIELD});
      modifyHitPoints(P1, units.TerranMarine, 25, "All", ${FIELD});
      setInvincibility(P1, units.TerranMarine, ${FIELD}, "enable");
      moveLocation(P1, units.TerranMarine, ${FIELD}, ${HOME});
      createUnit(P1, units.ZergZergling, 1, ${HOME});`);
    expect(sim.units[0]).toMatchObject({ hp: 10, invincible: true });
    // Home went to where the Marine is, so the Zergling is made there.
    expect([sim.units[1].x, sim.units[1].y]).toEqual([1100, 1050]);
  });

  it("a place used again is another unit: what kept the dead one does not find the new one", () => {
    const sim = run(`
      createUnit(P1, units.TerranMarine, 2, ${HOME});
      const hits = new Map<Unit, number>();
      for (const u of unitsAt(${HOME})) hits.set(u, 7);
      const victim = first({ type: units.TerranMarine });
      if (victim) victim.kill();
      createUnit(P1, units.TerranMarine, 1, ${HOME});
      let found = 0; let live = 0;
      for (const u of unitsAt(${HOME})) { live++; if (hits.has(u)) found++; }
      print(\`\${live} \${found} \${victim ? victim.hp : -1}\`);`);
    // Two alive, one of them known; the variable that held the dead one finds no unit, though its place has one in it again.
    expect(shown(sim)).toEqual(["2 1 -1"]);
    expect(sim.units.map((u) => [u.slot, u.uid, u.alive])).toEqual([[0, 0, false], [1, 0, true], [0, 1, true]]);
  });

  it("a trigger()'s units are the programs' units: one world", () => {
    const r = compileFile(`trigger(P1, [always()], [createUnit(P1, units.ZergZergling, 4, ${HOME})]);
      trigger(P1, [bring(P1, units.ZergZergling, ${HOME}, "==", 3)], [displayText("three left")]);
      program(() => { sleep(frames(1)); const z = first({ type: units.ZergZergling }); if (z) z.kill(); });`);
    const world = new Simulation(r.triggers, { strings: r.strings, locations: LOCATIONS });
    const programs = new ProgramSimulation(r.ir, { world, strings: r.strings, table: TABLE });
    for (let i = 0; i < 4; i++) { world.step(); programs.step(); }
    expect(world.events.map((e) => e.text).filter(Boolean)).toEqual(["three left"]);
    expect(world.death(0, ZERGLING)).toBe(1);
  });
});

describe("several players", () => {
  // P1 and P2 are Force 1, P3 is Force 2; P4 is not in the game.
  const PLAYERS = { players: [0, 1, 2], forces: { 0: 0, 1: 0, 2: 1, 3: 1 } };

  it("a program of a force runs for each of its players, each with their own variables and one shared", () => {
    const sim = run(`let mine = 0; let all = shared(0); while (true) { mine += 1; all += 1; setResources(CurrentPlayer, "add", 10, "ore"); sleep(frames(1)); }`, 3, PLAYERS, `, { owner: players.Force1 }`);
    expect(sim.runs.map((r) => r.player)).toEqual([0, 1]);
    // The shared one is put to 0 again when the second player's run comes to its declaration, on the first frame: as the built map does.
    expect([sim.value("mine", 0, 0), sim.value("mine", 0, 1), sim.value("all")]).toEqual([3, 3, 5]);
    const ore = run(`print(\`\${minerals(P1)} \${minerals(P2)} \${minerals(P3)} \${minerals(players.Force1)}\`);`, 1, PLAYERS);
    expect(shown(ore)).toEqual(["0 0 0 0"]);
  });

  it("All Players are those in the game; a player who is not has no run", () => {
    const sim = run(`createUnit(CurrentPlayer, units.TerranMarine, 1, ${HOME});`, 1, PLAYERS, `, { owner: AllPlayers }`);
    expect(sim.units.map((u) => u.owner)).toEqual([0, 1, 2]);
    const none = run(`createUnit(CurrentPlayer, units.TerranMarine, 1, ${HOME});`, 1, PLAYERS, `, { owner: P4 }`);
    expect(none.units).toEqual([]);
  });

  it("a group in an action is each of its players, in a condition all of them together", () => {
    const sim = run(`
      createUnit(players.Force1, units.TerranMarine, 2, ${HOME});
      setDeaths(players.Force1, units.TerranMarine, "add", 5);
      setResources(AllPlayers, "set", 50, "gas");
      print(\`\${countUnits(P1, units.TerranMarine)} \${countUnits(players.Force1, units.TerranMarine)} \${countUnits(players.Foes, units.AnyUnit)} \${deaths(P2, units.TerranMarine)} \${deaths(players.Force1, units.TerranMarine)} \${gas(AllPlayers)}\`);`, 1, PLAYERS);
    expect(shown(sim)).toEqual(["2 4 0 5 10 150"]);
  });

  it("a trigger of a force runs once for each of its players", () => {
    const r = compileFile(`trigger(players.Force1, [always()], [createUnit(CurrentPlayer, units.TerranMarine, 1, ${HOME})]);
      trigger(P3, [commandTheLeast(units.TerranMarine)], [displayText("fewest")]);`);
    const world = new Simulation(r.triggers, { strings: r.strings, locations: LOCATIONS, ...PLAYERS }).run(2);
    expect(world.game.units.map((u) => u.owner)).toEqual([0, 1]);
    expect(world.events.filter((e) => e.text === "fewest").map((e) => e.player)).toEqual([2]);
  });

  it("without the map's player settings there is the one player, whom a force means", () => {
    const sim = run(`let mine = 0; mine += 1; createUnit(CurrentPlayer, units.TerranMarine, 1, ${HOME});`, 1, { player: 1 }, `, { owner: players.Force2 }`);
    expect(sim.runs.map((r) => r.player)).toEqual([1]);
    expect(sim.units.map((u) => u.owner)).toEqual([1]);
  });
});
