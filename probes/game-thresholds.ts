// TrigScript 4: a division whose result is small, worked out as comparisons with thresholds (compiler/thresholds.ts),
// against the division itself, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-thresholds.ts
// Every divisor starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game
  const zero: fixed = fixed(g - 3);

  // A: Math.min(78, Math.floor(78 / d)) for distances from below zero to far, and the same worked out by the division
  // (q < H ? q : H is not a min, so it stays a division). Each pair the same.
  const H = 78;
  const ds: fixed[] = [-3, 0, 0.001, 0.0023, 0.0024, 0.0025, 0.5, 0.99, 1, 1.0001, 1.5, 2.5, 7.99, 39, 77.9, 78, 78.5, 79, 1000, 30000];
  let tree = "", division = "";
  for (const d0 of ds) {
    const d: fixed = d0 + zero;
    tree += `${Math.min(H, Math.floor(H / d))} `;
    const q = Math.floor(H / d);
    division += `${q < H ? q : H} `;
  }
  displayText(`A: ${tree}`);
  displayText(`A division: ${division}`);
  sleep(frames(1));

  // B: Math.round and Math.ceil of a fixed quotient, and a whole 1000 / n, the same way: short lines (the game cuts
  // long ones: four pairs a line), each beside the division's.
  let half = 0;
  let rounds = "", roundsDiv = "";
  for (const d0 of ds) {
    const d: fixed = d0 + zero;
    rounds += `${Math.min(200, Math.round(300 / d))},${Math.min(5, Math.ceil(7.25 / d))} `;
    const r = Math.round(300 / d);
    const c = Math.ceil(7.25 / d);
    roundsDiv += `${r < 200 ? r : 200},${c < 5 ? c : 5} `;
    half++;
    if (half % 4 == 0) {
      displayText(`B: ${rounds}= ${roundsDiv}`);
      rounds = "";
      roundsDiv = "";
    }
  }
  let wholes = "", wholesDiv = "";
  half = 0;
  for (let n = g - 5; n < g + 60; n += 7) {
    wholes += `${Math.min(40, 1000 / n)} `;
    const w = 1000 / n;
    wholesDiv += `${w < 40 ? w : 40} `;
    half++;
    if (half % 5 == 0) {
      displayText(`D: ${wholes}= ${wholesDiv}`);
      wholes = "";
      wholesDiv = "";
    }
  }
});

const A = "A: -26 0 78 -31683 78 78 78 78 78 77 52 31 9 2 1 1 0 0 0 0 ";
test("Math.min(H, Math.floor(H / d)) as comparisons, as the division", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted(A);
  expect(sim).toHavePrinted(A.replace("A: ", "A division: "));
});
test("Math.round, Math.ceil and a whole quotient as comparisons, as the division", (sim) => {
  sim.frames(10);
  const said = sim.printed().filter((t: string) => /^[BD]: /.test(t));
  expect(said.length).toBe(7);
  for (const line of said) {
    const [tree, division] = line.slice(3).split(" = ");
    expect(tree.trim()).toBe(division.trim());
  }
});
