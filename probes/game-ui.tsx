// TrigScript 4: a ui.lines view in the lifted game and the simulator — put together when what it reads changes, and
// shown again once a second from the text it last put together.
//   npx tsx scripts/test-game.mts probes/game-ui.tsx
// The view calls thousands() twice, so it is kept as a function: the view is followed into it (it was put together
// every frame before).
import { test, expect, program, sleep, frames, setResources, gas, P1, ui } from "trigscript";
import { thousands } from "trigscript/ui";

program(async () => {
  setResources(P1, "set", 3, "gas");
  await sleep(frames(2));
  let score = gas(P1) + 1231; // 1234, read in the game
  let best = 50;
  let quiet = 0;
  ui.lines(P1, () => <line>Score {thousands(score)} best {thousands(best)}</line>);
  for (let i = 0; i < 30; i++) { quiet++; await sleep(frames(1)); }
  score += 10;
  while (true) { quiet++; await sleep(frames(1)); }
});

// (The lifted game does not tell a line shown again unchanged from the one before it, so the test reads the texts in
// order with repeats taken out; the simulator shows them at 4, 28, 34 and 58.)
test("a view is shown when it changes and once a second, from the text it last put together", (sim) => {
  sim.frames(60);
  const hud = sim.events.filter((e) => e.text.includes("Score")).map((e) => e.text.split("\n")[0].replace(/[\x01-\x1f]/g, "").replace(/^.*— /, ""));
  const changes = hud.filter((t, i) => i === 0 || t !== hud[i - 1]);
  expect(changes.join(" | ")).toBe("Score 1,234 best 50 | Score 1,244 best 50");
});
