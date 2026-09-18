// The Remastered target's probe script (slice 0/1): what a player should see, in order.
//   - Every second: "Tick N" for everyone, with N counting up (a dynamic value in a message
//     is not in this slice, so the tick is a fixed text and the count reaches you as ore:
//     the minerals of P1 go up by 5 each tick, and P1's gas IS the tick count: 1, 2, 3, …
//     — a variable in an action, and the check that a sum starts fresh every run).
//   - Each human player is greeted once, three seconds in, in their own text: "Hello there."
//     (the per-player program runs once for every human player).
//   - Five seconds in, a Terran Marine appears at Anywhere's centre for P1, once.
// Built with `npx tsx scripts/build-fixture.mts probes/spike.ts fixtures/eud/spike-eud.scx`, which makes
// Player 1 the human and Player 2 a computer so the map starts with one person. The built map sits on
// a Blizzard map's terrain, so it stays in the ignored fixtures/ folder and is never committed.
import { program, displayText, setResources, createUnit, units, locations, P1, AllPlayers } from "trigscript";

program(() => {
  let ticks = 0;
  while (true) {
    ticks += 1;
    displayText("Tick");
    setResources(P1, "add", 5, "ore");
    setResources(P1, "set", ticks, "gas");
    if (ticks == 5) createUnit(P1, units.TerranMarine, 1, locations.Anywhere);
    sleep(seconds(1));
  }
}, { owner: P1 });

program(() => {
  sleep(seconds(3));
  displayText("Hello there.");
}, { owner: AllPlayers });
