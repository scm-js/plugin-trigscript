// Greys in the fog of war (TrigScript 4, after the image import): what image.halftone() draws, played. The fog has
// two tones on this board, lit and fog; a halftone lights each cell of a few tiles with one brush, larger for a lighter
// cell, so that from far enough away an area looks as grey as its share of lit tiles. Three questions: does it read as
// grey at all; which cell size; and does Remastered's blurred minimap turn the dots into real grey where Classic's
// sharp one shows dots. Then: does distance shading on a raycaster's walls read, and do the dots shimmer as it moves.
// Host it as a multiplayer game, alone; watch a round with Classic graphics and a round with Remastered
// (Options > Graphics). The steps are said on screen with a letter; the answer sheet has the same letters.
//
//   npx tsx probes/lib/halftone-gen.mts
//   MAP_NAME="TrigScript halftone probe" npx tsx probes/lib/raycaster-map.mts fixtures/eud/halftone-base.scx
//   npx tsx scripts/build-fixture.mts probes/halftone.ts fixtures/eud/halftone.scx fixtures/eud/halftone-base.scx
import { fog } from "trigscript/fog";
import ramp from "./halftone-ramp.image";
import scene from "./halftone-scene.image";
import walkFlat from "./halftone-walk-flat.video";
import walk4 from "./halftone-walk-4.video";
import walk4Even from "./halftone-walk-4-even.video";
import walk6 from "./halftone-walk-6.video";
import walk6Even from "./halftone-walk-6-even.video";

/** Where the camera waits, below the board: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("halftone probe: the camera, below the board");
/** The board's top left: two tiles in from the map's edges, where a brush is never pushed inward. */
const X = 2, Y = 2;

// A: black to white, left to right, in cells of 4 × 5, 6 × 7 and 8 × 9, one band under another.
const RAMP4 = fog.picture(ramp.halftone(4));
const RAMP6 = fog.picture(ramp.halftone(6));
const RAMP8 = fog.picture(ramp.halftone(8));
// B: the same, each cell by its own grey (no diffusion): an even grid, the greys in steps.
const RAMP4_EVEN = fog.picture(ramp.halftone(4, 5, { diffuse: false }));
const RAMP6_EVEN = fog.picture(ramp.halftone(6, 7, { diffuse: false }));
const RAMP8_EVEN = fog.picture(ramp.halftone(8, 9, { diffuse: false }));
// C: a lit ball, as two tones (today's threshold) and in halftones.
const BALL_TWO = fog.picture(scene.threshold(110));
const BALL4 = fog.picture(scene.halftone(4));
const BALL6 = fog.picture(scene.halftone(6));
const BALL8 = fog.picture(scene.halftone(8));
const BALL4_EVEN = fog.picture(scene.halftone(4, 5, { diffuse: false }));
const BALL6_EVEN = fog.picture(scene.halftone(6, 7, { diffuse: false }));

program(async () => {
  // The base's units would light fog of their own.
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04Greys in the fog of war. Everything happens on the MINIMAP.");
  await nextFrame();
  // The whole board lit once, so what is not lit is fog grey, not the black of a tile never seen.
  fog.reveal(P1);
  await sleep(frames(96));
  let round = 1;
  while (true) {
    displayText(`\x11Round ${round}. Watch it once with Classic graphics and once with Remastered (Options > Graphics).`);
    await sleep(frames(96));

    displayText("\x04A: black to white, left to right. Top 4x5 cells, middle 6x7, bottom 8x9. Diffused.");
    let i = 0;
    while (i < 15) { fog.light(P1, X, Y, RAMP4); fog.light(P1, X, Y + 32, RAMP6); fog.light(P1, X, Y + 64, RAMP8); await fog.show(24); i++; }

    displayText("\x04B: the same ramps, each cell by its own grey (not diffused).");
    i = 0;
    while (i < 15) { fog.light(P1, X, Y, RAMP4_EVEN); fog.light(P1, X, Y + 32, RAMP6_EVEN); fog.light(P1, X, Y + 64, RAMP8_EVEN); await fog.show(24); i++; }

    displayText("\x04C1: a lit ball over a floor, two tones (what we draw today).");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL_TWO); await fog.show(24); i++; }
    displayText("\x04C2: the ball, halftone 4x5 cells, diffused.");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL4); await fog.show(24); i++; }
    displayText("\x04C3: the ball, halftone 6x7, diffused.");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL6); await fog.show(24); i++; }
    displayText("\x04C4: the ball, halftone 8x9, diffused.");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL8); await fog.show(24); i++; }
    displayText("\x04C5: the ball, halftone 4x5, not diffused.");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL4_EVEN); await fog.show(24); i++; }
    displayText("\x04C6: the ball, halftone 6x7, not diffused.");
    i = 0;
    while (i < 8) { fog.light(P1, X, Y, BALL6_EVEN); await fog.show(24); i++; }

    displayText("\x04D1: a walk through the raycaster's maze, walls lit whole (no shading).");
    await fog.play(P1, walkFlat, X, Y);
    displayText("\x04D2: the walk, walls greyer with distance, halftone 4x5, diffused.");
    await fog.play(P1, walk4, X, Y);
    displayText("\x04D3: the walk, halftone 4x5, not diffused.");
    await fog.play(P1, walk4Even, X, Y);
    displayText("\x04D4: the walk, halftone 6x7, diffused.");
    await fog.play(P1, walk6, X, Y);
    displayText("\x04D5: the walk, halftone 6x7, not diffused.");
    await fog.play(P1, walk6Even, X, Y);

    displayText("\x04That is the round. It starts again in a few seconds.");
    await sleep(frames(120));
    round++;
  }
});
