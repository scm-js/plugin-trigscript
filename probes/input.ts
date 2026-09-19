// TrigScript 3.4's probe (slice 4): what the players do — keys, clicks, the mouse, typed lines.
// You are Player 1, Terran, with a Command Center and four Marines; Player 2 is a computer. "Home"
// is the ground next to your base, "Away" a smaller box beside it.
//
// HOST IT AS A MULTIPLAYER GAME (Use Map Settings; alone is fine): a game played in single player
// has no chat, so the typed lines (F … J) could not be tried there. Keys, clicks and the mouse
// work either way. Nothing here is on a clock: do each step when you like; every line says what
// it expects. An answer comes a few frames after what you did — that is the trip between computers.
//
//   A  at the start: a line every second for five seconds counts frames — it should read 24, 48, 72 …
//      (sleep(frames(1)) is ONE frame now; before 3.4 a loop sleeping a frame ran every other frame)
//   B  press F8, then 1: "B1: F8 pressed, n times", "B3: 1 …" — once per press, not while held, not while
//      typing a message. (F6 was here: the game never reports it, in either of two builds, so it is no Key.)
//   C  press Q: two Marines appear at Home (a key as a command)
//   D  RIGHT-click the ground: "D: right click at x, y" — the map pixels under the cursor; try the
//      map's left edge (x near 0) and somewhere far right
//   E  press W with the cursor over open ground: a Marine appears UNDER THE CURSOR (centerLocation)
//   F  press E with the cursor on one of your Marines: that Marine dies, the others do not;
//      with the cursor on empty ground: "F: nothing under the mouse"
//   G  type  -help            → "G: help, asked n times"
//   H  type  -give 250        → your minerals go up by 250, and the line says so; try -give 99999999 (stops at 1048575)
//   I  type  -pay gas 40      → gas +40; -pay ORE 5 → ore +5; -pay wood 5 → nothing at all
//   J  type  -spawn 3 Terran Firebat   → three Firebats at Home; -spawn 2 zerg zergling → two Zerglings (yours);
//      -spawn 2 Nonsense → nothing
//   K  anything else you type is ordinary chat: nothing answers
//   L  the per-player program: press F7 — "L: <your name> pressed F7, n times" (in a game with two people, each sees their own number)
//
// Built with `npx tsx scripts/build-fixture.mts probes/input.ts fixtures/eud/input.scx`.
import { trigger, program, always, displayText, createUnit, setResources, sleep, seconds, frames, keyPressed, clicked, mouse, underMouse, chatted, centerLocation, minerals, name, units, P1, CurrentPlayer, AllPlayers, type Location } from "trigscript";

// The map's names are not known to this script: a location is its number (build-fixture makes 1 and 2).
const HOME = 1 as Location;
const AWAY = 2 as Location;

trigger(P1, [always()], [displayText("trigger(): hello — the slice 4 probe. Keys F8 1 Q W E F7, right click, and chat: -help, -give 250, -pay gas 40, -spawn 3 Terran Firebat")]);

// A: the frame clock.
program(() => {
  let ticks = 0;
  let second = 0;
  while (second < 5) {
    ticks += 1;
    if (ticks % 24 == 0) { second += 1; displayText(`A: ${ticks} frames counted after ${second} s of them (expect ${second * 24})`); }
    sleep(frames(1));
  }
});

// B … F: keys, clicks, the mouse.
program(() => {
  let presses = 0;
  while (true) {
    // Played: F6 never arrives, whatever its place in MSQC's settings, so it is not a key of the language.
    if (keyPressed(P1, "F8")) { presses += 1; displayText(`B1: F8 pressed, ${presses} times`); }
    if (keyPressed(P1, "1")) { presses += 1; displayText(`B3: 1 pressed, ${presses} times`); }
    if (keyPressed(P1, "Q")) { createUnit(P1, units.TerranMarine, 2, HOME); displayText("C: Q — two Marines at Home"); }
    if (clicked(P1, "right")) { const at = mouse(P1); displayText(`D: right click at ${at.x}, ${at.y}`); }
    if (keyPressed(P1, "W")) {
      const at = mouse(P1);
      centerLocation(AWAY, at.x, at.y);
      createUnit(P1, units.TerranMarine, 1, AWAY);
      displayText(`E: W — a Marine under the cursor, at ${at.x}, ${at.y}`);
    }
    if (keyPressed(P1, "E")) {
      const target = underMouse(P1, { owner: P1 });
      if (target) { displayText(`F: E — the unit under the mouse (type ${target.type}, ${target.hp} hit points) dies`); target.kill(); }
      else displayText("F: nothing under the mouse");
    }
    sleep(frames(1));
  }
});

// G … J: typed lines.
program(() => {
  let asked = 0;
  while (true) {
    if (chatted(P1, "-help")) { asked += 1; displayText(`G: help, asked ${asked} times`); }
    const give = chatted(P1, "-give {n}");
    if (give) { setResources(P1, "add", give.n, "ore"); displayText(`H: -give ${give.n}: you have ${minerals(P1)} minerals now`); }
    const pay = chatted(P1, "-pay {kind:ore|gas} {n}");
    if (pay) {
      if (pay.kind == 0) setResources(P1, "add", pay.n, "ore");
      else setResources(P1, "add", pay.n, "gas");
      displayText(`I: -pay: kind ${pay.kind} (0 ore, 1 gas), ${pay.n}`);
    }
    const spawn = chatted(P1, "-spawn {n} {what:unit}");
    if (spawn) { createUnit(P1, spawn.what, spawn.n, HOME); displayText(`J: -spawn: ${spawn.n} of unit type ${spawn.what} at Home`); }
    sleep(frames(1));
  }
});

// L: every player's own keys.
program(() => {
  let mine = 0;
  while (true) {
    if (keyPressed(CurrentPlayer, "F7")) { mine += 1; displayText(`L: ${name(CurrentPlayer)} pressed F7, ${mine} times`); }
    sleep(frames(1));
  }
}, { owner: AllPlayers });
