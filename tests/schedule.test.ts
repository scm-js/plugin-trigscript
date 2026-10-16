// When the trigger list runs, in Simulate and in tests: the game's own schedule (StarCraft 1.16.1's trigger code,
// read and measured through the game — see the editor's trigger reference, "How triggers run"). A pass on frame 2,
// then every 31 frames; a Wait that runs out brings the next pass to the frame after; a player has one wait slot;
// hyper triggers make a pass every 2 frames; a map with a program has one every frame.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import type { TestWorld } from "../compiler/testing";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const WORLD: TestWorld = { locations: { 1: { left: 0, top: 0, right: 200, bottom: 200 } } };
const HEAD = `import { test, expect, trigger, program, hyperTriggers, always, elapsedTime, deaths, setDeaths, preserve, wait, transmission, sleep, frames, units, P1, P8, type Location } from "trigscript";`;

/** Each test's outcome by name: "passed", or the failure's message. */
function outcome(body: string, world: TestWorld = WORLD): Record<string, string> {
  const r = compileScript(ts, { "main.ts": `${HEAD}\n${body}` }, NAMES, { lib: LIB, tests: { world } });
  expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
  return Object.fromEntries(r.tests!.results.map((t) => [t.id.split("::")[1], t.status === "passed" ? "passed" : `${t.status}: ${t.message}`]));
}

describe("the game's schedule", () => {
  it("a pass on frame 2, then every 31 frames", () => {
    expect(outcome(`
trigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "add", 1), preserve()]);
test("passes", (sim) => {
  const seen: number[] = [];
  for (let f = 1; f <= 95; f++) { const before = sim.deaths(P1, units.TerranMarine); sim.frames(1); if (sim.deaths(P1, units.TerranMarine) > before) seen.push(sim.frame); }
  expect(seen).toEqual([2, 33, 64, 95]);
});`)).toEqual({ passes: "passed" });
  });

  it("a Wait holds its trigger for its time and the pass after it comes the next frame", () => {
    // Wait(1000) begun in the pass on frame 2: 24 frames of 42 ms free the slot on frame 26, the pass is on 27.
    // Wait(0) frees it on the frame after, the pass the frame after that.
    expect(outcome(`
trigger(P1, [always()], [wait(1000), setDeaths(P1, units.TerranMarine, "add", 1), wait(0), setDeaths(P1, units.TerranMarine, "add", 1)]);
test("waits", (sim) => {
  const seen: number[] = [];
  for (let f = 1; f <= 40; f++) { const before = sim.deaths(P1, units.TerranMarine); sim.frames(1); if (sim.deaths(P1, units.TerranMarine) > before) seen.push(sim.frame); }
  expect(seen).toEqual([27, 29]);
});`)).toEqual({ waits: "passed" });
  });

  it("a player has one wait slot: another trigger's Wait stops until it is free, a trigger without one runs every pass", () => {
    expect(outcome(`
trigger(P1, [always()], [wait(2000), setDeaths(P1, units.TerranMarine, "add", 1)]);
trigger(P1, [always()], [wait(0), setDeaths(P1, units.TerranGhost, "add", 1)]);
trigger(P1, [always()], [setDeaths(P1, units.TerranVulture, "add", 1), preserve()]);
test("one slot", (sim) => {
  const at = (unit: number) => { for (let f = 1; f <= 80; f++) { sim.frames(1); if (sim.deaths(P1, unit) > 0) return sim.frame; } return -1; };
  // 2000 ms: 48 frames from frame 2, the slot free on 50, the pass on 51; the second trigger's Wait(0) then starts in that pass.
  expect(at(units.TerranMarine)).toBe(51);
  expect(at(units.TerranGhost)).toBe(53);
  // The third trigger ran in every pass: 2, 33, 51, 53.
  expect(sim.deaths(P1, units.TerranVulture)).toBe(4);
});`)).toEqual({ "one slot": "passed" });
  });

  it("hyper triggers make a pass every 2 frames, never every frame", () => {
    expect(outcome(`
hyperTriggers(P8);
trigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "add", 1), preserve()]);
test("hyper", (sim) => {
  sim.frames(100);
  expect(sim.deaths(P1, units.TerranMarine)).toBe(50);
});`, { ...WORLD, players: [0, 7] })).toEqual({ hyper: "passed" });
  });

  it("Elapsed Time is whole game seconds of 16 frames, seen at the next pass", () => {
    expect(outcome(`
trigger(P1, [elapsedTime(">=", 3)], [setDeaths(P1, units.TerranMarine, "add", 1)]);
test("elapsed", (sim) => {
  sim.until(() => sim.deaths(P1, units.TerranMarine) > 0);
  expect(sim.frame).toBe(64);
});`)).toEqual({ elapsed: "passed" });
  });

  it("a Transmission holds for its time, a computer's does nothing", () => {
    expect(outcome(`
trigger(P1, [always()], [transmission("Over.", units.TerranMarine, 1 as Location, "set", 1000, "", 0), setDeaths(P1, units.TerranMarine, "add", 1)]);
trigger(P8, [always()], [transmission("Over.", units.TerranMarine, 1 as Location, "set", 1000, "", 0), setDeaths(P8, units.TerranMarine, "add", 1)]);
test("transmission", (sim) => {
  sim.frames(26);
  expect([sim.deaths(P1, units.TerranMarine), sim.deaths(P8, units.TerranMarine)]).toEqual([0, 1]);
  sim.frames(1);
  expect(sim.deaths(P1, units.TerranMarine)).toBe(1);
});`, { ...WORLD, players: [0, 7], computers: [7] })).toEqual({ transmission: "passed" });
  });

  it("a map with a program: a pass every frame from frame 2, the programs inside it", () => {
    expect(outcome(`
program(() => { while (true) { setDeaths(P1, units.TerranGhost, "add", 1); sleep(frames(1)); } });
trigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "add", 1), preserve()]);
test("every frame", (sim) => {
  sim.frames(1);
  expect([sim.deaths(P1, units.TerranMarine), sim.deaths(P1, units.TerranGhost)]).toEqual([0, 0]);
  sim.frames(9);
  expect([sim.deaths(P1, units.TerranMarine), sim.deaths(P1, units.TerranGhost)]).toEqual([9, 9]);
});`)).toEqual({ "every frame": "passed" });
  });
});
