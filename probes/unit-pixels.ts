// The unit-pixel probe (TrigScript 4, S2 → a Tetris drawn with units): can a script draw on the minimap and the map
// with units for pixels? A unit's position can never be written (Magenta probe 6), but a location can be centred on any
// point and a unit made or taken away there; Create Unit puts it inside the location, so the location ("Pixel") is one
// cell, 64 × 64. A pixel's colour is its owner's.
//
// Run in the lifted game first: an Overlord lands on its cell on any ground (168 of 168), a building only where the
// ground takes one — (2)Binary Burghs is a patchwork near the base — and small items lose a few cells too. The lifted
// game never makes a Map Revealer (a gap of its own; Remastered does), so step B is the game's to answer.
//
// What to look for, by the second (each step says so in the middle of the screen too):
//   A   2  a row of Overlords, one for each player P1 … P8 and P12: which colours show on the minimap without vision?
//          (Player 2 is a computer and may move its own; Player 12's was not made in the lifted game.)
//   B  12  Map Revealers of yours over the board: which show now, on the minimap and on the screen?
//   C  22  rows of other kinds, one for each of P1 … P8: Science Vessel, Pylon, Psi Emitter, Data Disk, Flag.
//          Which make a clean square on the minimap? Which look good on the screen? Any missing, or not on its cell?
//          (In the lifted game: Vessels zigzag, Pylons and small items miss cells where the ground will not take them.)
//   D  40  two pixels fall down the right side, an Overlord and a Psi Emitter: smooth? Anything left behind?
//   E  58  10, 20, 40 then 80 Overlords made and taken away every frame, to the right: when does the game slow or stutter?
// Host it as a multiplayer game, alone, or single player: nothing here reads the keys.
//   npx tsx scripts/build-fixture.mts probes/unit-pixels.ts fixtures/eud/unit-pixels.scx
//   npx tsx scripts/test-game.mts probes/unit-pixels.ts     (where each kind landed, in the lifted game)
import { test, expect, program, print, createUnit, removeUnitAt, centerLocation, centerView, sleep, seconds, frames, units, players, P1, P2, P3, P4, P5, P6, P7, P8, type Location } from "trigscript";

const PIXEL = 3 as Location;
/** The board's corner, beside Player 1's base on (2)Binary Burghs, and its cells. */
const OX = 672, OY = 2144, CELL = 64;
const OWNERS = [P1, P2, P3, P4, P5, P6, P7, P8];
const KINDS = [units.TerranScienceVessel, units.ProtossPylon, units.PsiEmitter, units.DataDisk, units.Flag];

program(async () => {
  /** The pixel location on the middle of cell (x, y). */
  function at(x: number, y: number) { centerLocation(PIXEL, OX + x * CELL + CELL / 2, OY + y * CELL + CELL / 2); }

  await sleep(seconds(1));
  at(5, 4);
  centerView(PIXEL);
  print("A: a row of nine Overlords, one for each player (P1 to P8, then P12). On the minimap: which colours show?", { position: "center" });
  OWNERS.forEach((p, i) => { at(i, 0); createUnit(p, units.ZergOverlord, 1, PIXEL); });
  at(8, 0);
  createUnit(players.P12, units.ZergOverlord, 1, PIXEL);

  await sleep(seconds(10));
  print("B: now with Map Revealers of yours over the board. Which colours show on the minimap now? On the screen?", { position: "center" });
  for (let y = 0; y < 14; y += 3) for (let x = 0; x < 24; x += 3) { at(x, y); createUnit(P1, units.MapRevealer, 1, PIXEL); }

  await sleep(seconds(10));
  print("C: a row of each kind, one for each player: Science Vessel, Pylon, Psi Emitter, Data Disk, Flag. Clean squares? Missing? Off their cells?", { position: "center" });
  KINDS.forEach((kind, r) => OWNERS.forEach((p, i) => { at(i, r + 1); createUnit(p, kind, 1, PIXEL); }));

  await sleep(seconds(18));
  print("D: two pixels fall down the right side of the board, an Overlord and a Psi Emitter. Smooth? Anything left behind?", { position: "center" });
  for (let y = 0; y < 12; y++) {
    at(9, y); createUnit(P3, units.ZergOverlord, 1, PIXEL);
    at(10, y); createUnit(P5, units.PsiEmitter, 1, PIXEL);
    await sleep(frames(8));
    at(9, y); removeUnitAt(P3, units.ZergOverlord, 1, PIXEL);
    at(10, y); removeUnitAt(P5, units.PsiEmitter, 1, PIXEL);
  }

  await sleep(seconds(1));
  // E: N Overlords to the right of the board, made on one frame and taken away on the next, for six seconds each.
  for (const n of [10, 20, 40, 80]) {
    print(`E: ${n} Overlords made and taken away every frame, to the right. Does the game slow down or stutter?`, { position: "center" });
    for (let f = 0; f < 72; f++) {
      for (let k = 0; k < n; k++) {
        at(12 + k % 10, Math.floor(k / 10));
        if (f % 2 === 0) createUnit(P4, units.ZergOverlord, 1, PIXEL);
        else removeUnitAt(P4, units.ZergOverlord, 1, PIXEL);
      }
      await sleep(frames(1));
    }
  }
  print("That is the end of the unit-pixel probe. Thank you.", { position: "center" });
}, { owner: P1 });

// What the lifted game showed besides: Player 2's Overlord was moved off its cell (a computer: its AI moves its units),
// Player 12's was never made, Pylons landed on 4 of 8 cells and Psi Emitters on 7 (the ground), and Science Vessels
// zigzagged — every other one pushed 56 pixels down, since air units that overlap push each other apart. Overlords, 64
// apart, stay put. So a board's pixels are Overlords of Player 1 and the empty slots, P3 … P8: seven colours, as many as
// Tetris has pieces.
test("Overlords land on their cells, for Player 1 and the empty slots", (sim) => {
  sim.frames(24 * 23);
  const mine = [0, 2, 3, 4, 5, 6, 7];
  const onCell = sim.units({ type: units.ZergOverlord }).filter((u) => mine.includes(u.owner) && (u.x - OX - CELL / 2) % CELL === 0 && (u.y - OY - CELL / 2) % CELL === 0);
  expect(onCell.length).toBe(7);
});
