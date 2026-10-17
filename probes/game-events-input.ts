// TrigScript 4, B2: on.chat and on.key in the lifted game, with what the handler prints to the player.
//   npx tsx scripts/test-game.mts probes/game-events-input.ts
import { test, expect, program, print, setResources, on, P1 } from "trigscript";

program(async () => {
  let gave = 0, helped = 0;
  on.chat("-give {n}", (p, { n }) => { gave += n; setResources(p, "add", n, "ore"); print(`gave ${n}`, { to: p }); });
  on.key("F7", (p) => { helped++; print("help", { to: p }); });
}, { owner: P1, name: "input" });

test("a typed line and a key reach their handlers, and what they print shows", (sim) => {
  sim.frames(4);
  sim.type("-give 100").seconds(1);
  expect(sim.program("input").gave).toBe(100);
  expect(sim).toHavePrinted("gave 100");
  sim.press("F7").seconds(1);
  expect(sim.program("input").helped).toBe(1);
  expect(sim).toHavePrinted("help");
});
