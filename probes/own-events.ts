// TrigScript 4, the backend: unit events in a map of our own (scripts/build-fixture.mts) — step 11 of the way off eudplib,
// part 3. The map's events pass, before the programs' turns each frame: a trigger for each unit place the game has
// handed out, whose conditions hold what it saw there last (the uniqueness byte, whether the unit is alive or its
// order); a place that changed goes to the handler, which lists what came on, died or took up an order. A listener is
// a task that loops over what the pass found.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same
// frames; every line should end "ok", and a line ending "WRONG" names the check that failed. The frames after "Weighed"
// are to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-events.ts /tmp/own-events.scx
//   npx tsx scripts/build-fixture.mts probes/own-events.ts /tmp/own-events-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(async () => {
  print("Own events: the payload runs.");
  let made = 0, marines = 0, theirs = 0, died = 0, killed = 0, moved = 0, late = 0;
  on.created((u) => {
    made += 1;
    if (u.type == units.TerranMarine) marines += 1;
  });
  on.created({ owner: P2 }, (u) => {
    theirs += 1;
  });
  on.died((u) => {
    died += 1;
  });
  on.killed((u, by) => {
    if (by == 0) killed += 1;
  });
  on.order(units.TerranMarine, orders.Move, (u) => {
    moved += 1;
  });
  // A handler that waits: a task each time.
  on.died(units.ZergZergling, async (u) => {
    await sleep(frames(3));
    late += 1;
  });
  await sleep(frames(2));

  // A: what was on the map before the first pass is not handed on: a listener sleeps a frame before it looks.
  const atStart = made;
  if (made == 0 && died == 0) print("A: nothing at the start ok"); else print(`A: WRONG ${made} ${died}`);

  // B: units made by the program come on in the next frame.
  createUnit(P1, units.TerranMarine, 2, locations.Anywhere);
  createUnit(P2, units.ZergZergling, 3, locations.Anywhere);
  await sleep(frames(2));
  if (made == 5 && marines == 2 && theirs == 3) print("B: made ok"); else print(`B: made WRONG ${made} ${marines} ${theirs}`);

  // C: units killed by the program die, not in a fight; the handler that waits counts a frame or three later.
  killUnit(P2, units.ZergZergling);
  await sleep(frames(2));
  const lings = died;
  await sleep(frames(4));
  if (lings >= 7 && killed == 0 && late == lings) print(`C: died ok (${lings})`); else print(`C: died WRONG ${lings} ${killed} ${late}`);

  // D: an order taken up.
  const m = first({ owner: P1, type: units.TerranMarine });
  m?.order("move", locations.Anywhere);
  await sleep(frames(3));
  if (moved == 1) print("D: an order ok"); else print(`D: an order WRONG ${moved}`);

  print("Weighed:");
  // W1: nothing coming or going, a frame of the pass and the listeners alone.
  await sleep(frames(4));
  // W2: forty units made in one frame, each handed to on.created the next.
  createUnit(P1, units.TerranMarine, 40, locations.Anywhere);
  await sleep(frames(4));
  // W3: forty killed in one frame.
  killUnit(P1, units.TerranMarine);
  await sleep(frames(6));
  if (made == atStart + 5 + 40 && died == lings + 46) print("W: weighed ok"); else print(`W: weighed WRONG ${made - atStart} ${died - lings}`);
});
