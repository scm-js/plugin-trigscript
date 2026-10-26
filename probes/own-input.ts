// TrigScript 4, the backend: the players' input in a map of our own (scripts/build-fixture.mts) — step 12 of the way off
// eudplib. Keys, clicks, the mouse and sync() carried between the players' computers by the map itself: a ring of
// hidden carrier units a player, a Select and a Move to a point each send, the point read back from the carrier's order
// target on every computer. Nothing of chatEvent's or MSQC's.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines for the same
// keys, clicks and mouse; a line ending "WRONG" names the check that failed. The trip takes two frames in a map of our
// own and about five through MSQC, so the frames differ. Typed lines (part 2) are read from the text lines on the
// computer they were typed on and matched there; a pattern's number and its values make the trip.
//   npx tsx scripts/build-fixture.mts probes/own-input.ts /tmp/own-input.scx
//   npx tsx scripts/build-fixture.mts probes/own-input.ts /tmp/own-input-eud.scx
import { program, print, keyPressed, keyHeld, clicked, mouse, sync, local, underMouse, chatted, nextFrame } from "trigscript";

program(async () => {
  print("Own input: the payload runs.");
  on.chat("-ping {n}", (p, { n }) => { print(`on.chat: ping ${n}`); });
  // The smallest and the largest value a point carries, one in the middle, and two sent on the same frame.
  const a = await sync(P1, 0);
  const b = await sync(P1, 1048574);
  const [c, d] = await sync(P1, 12345, 67890);
  print(`sync ${a} ${b} ${c} ${d}` + (a == 0 && b == 1048574 && c == 12345 && d == 67890 ? " ok" : " WRONG"));
  let held = 0, presses = 0, clicks = 0, moves = 0, lastX = 0, lastY = 0;
  while (true) {
    if (keyPressed(P1, "F7")) { presses += 1; print(`F7 pressed ${presses}, held ${held} frames before`); }
    if (keyHeld(P1, "F7")) held += 1;
    if (keyPressed(P1, "Space")) print(`Space: F7 was held ${held} frames`);
    if (clicked(P1)) { clicks += 1; const at = mouse(P1); print(`click ${clicks} at ${at.x},${at.y}`); }
    if (clicked(P1, "right")) {
      const u = underMouse(P1, { within: 64 });
      if (u) print(`right-click on a unit of type ${u.type}`);
      else print("right-click on nothing");
    }
    const at = mouse(P1);
    if (at.x != lastX || at.y != lastY) { moves += 1; lastX = at.x; lastY = at.y; }
    if (keyPressed(P1, "F8")) {
      print(`mouse at ${at.x},${at.y}, moved ${moves} times`);
      const s = local.selected;
      if (s) print(`selected: a unit of type ${s.type}`);
      else print("nothing selected");
    }
    // Typed lines: whole, a number (kept to 1048575), a word of a list, a unit by its name.
    if (chatted(P1, "-help")) print("typed: help");
    const g = chatted(P1, "-give {n} {what:ore|gas}");
    if (g) print(`typed: give ${g.n} of ${g.what}` + (g.what == 1 ? " (gas)" : " (ore)"));
    const sp = chatted(P1, "-spawn {what:unit}");
    if (sp) print(`typed: spawn type ${sp.what}` + (sp.what == units.TerranMarine ? " (a marine)" : ""));
    await nextFrame();
  }
});
