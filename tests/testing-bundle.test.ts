/**
 * `dist/testing.js` is what another repository's tests import to run trigger text (see
 * `compiler/testingEntry.ts`). It is committed, so this reads the built file itself: what
 * it exports, and that text goes in one end and a death count comes out the other.
 */
import { describe, expect, it } from "vitest";
import * as source from "../compiler/testingEntry";
import type { TriggerNames } from "../compiler/testingEntry";

const UNITS = new Map([["Terran Marine", 0], ["Cave", 194]]);
const NAMES: TriggerNames = {
  string: () => null,
  intern: () => 1,
  location: (i) => `Location ${i}`,
  locationByName: (s) => Number(s.replace("Location ", "")) || undefined,
  unit: (i) => [...UNITS].find(([, id]) => id === i)?.[0] ?? String(i),
  unitByName: (s) => UNITS.get(s),
  switch: (i) => `Switch ${i + 1}`,
  switchByName: (s) => Number(s.replace("Switch ", "")) - 1,
};

const TEXT = `Trigger("Player 1"){
Conditions:
	Always();

Actions:
	Set Deaths("Player 1", "Cave", Add, 2);
	Preserve Trigger();
}

//-----------------------------------------------------------------//

Trigger("Player 1"){
Conditions:
	Deaths("Player 1", "Cave", At least, 6);

Actions:
	Victory();
}`;

describe("the testing bundle", () => {
  it("exports what the entry module does", async () => {
    const built = await import("../dist/testing.js" as string) as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual(Object.keys(source).sort());
  });

  it("parses trigger text and runs it", async () => {
    const built = await import("../dist/testing.js" as string) as typeof source;
    const triggers = built.parseTriggers(TEXT, NAMES).map((t) => t.trigger);
    const sim = new built.Simulation(triggers, { players: [0] });
    sim.run(3);
    expect(sim.death(0, 194)).toBe(6);
    expect(sim.events.filter((e) => e.action.type === built.ActionType.Victory).map((e) => e.cycle)).toEqual([2]);
  });
});
