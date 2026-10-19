// Each tile's minimap colour in StarCraft: Remastered, lit and in fog: the left half of the board lit, the right half
// fog, the same 88 tiles in each (probes/lib/tile-survey-map.mts makes a map of one tileset). Read from a recording:
// the brightest lit tile with the widest gap to its fog is the board the fog renderers want in Remastered graphics.
//
//   npx tsx probes/lib/tile-survey-map.mts 6 fixtures/eud/survey-ice-base.scx
//   npx tsx scripts/build-fixture.mts probes/tile-survey.ts fixtures/eud/survey-ice.scx fixtures/eud/survey-ice-base.scx
import { fog } from "trigscript/fog";

/** Where the camera waits, below the board: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("tile survey: the camera, below the board");
/** The left half's blocks, lit: 8 blocks of 7 across, 11 of 8 down, from tile (2, 2). */
const LIT = fog.picture(Array.from({ length: 88 }, () => "#".repeat(56)));

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  await nextFrame();
  // The whole board seen once, so the right half is fog, not black.
  fog.reveal(P1);
  await sleep(frames(24));
  displayText("\x04Tile survey. Leave it on screen for ten seconds with Remastered graphics, then quit.");
  while (true) {
    fog.light(P1, 2, 2, LIT);
    await fog.show(24);
  }
});
