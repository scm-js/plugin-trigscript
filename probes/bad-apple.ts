// Bad Apple!! in the fog of war (TrigScript 4, S4 in TrigScript: B8). The video is imported like a file of the
// script — a .video, the frames the editor decoded — and the fog library plays it on the minimap a frame of it every
// frame of the game, with the song from the map's archive. Host it as a multiplayer game, alone, with Classic graphics.
//
// The video and the song are not ours and never committed. Made with:
//   npx tsx scripts/import-video.mts <video file> probes/bad-apple.video --size=128x96
//   ffmpeg -i <video file> -vn -ac 2 -ar 44100 -c:a libvorbis -q:a 3 <song.ogg>
//   BA_ERA=1 BA_TILE=23778 npx tsx probes/lib/bad-apple-map.mts <base.scx> <song.ogg> 'staredit\wav\badapple.ogg'
//   npx tsx scripts/build-fixture.mts probes/bad-apple.ts <map.scx> <base.scx>
import { fog } from "trigscript/fog";
import badApple from "./bad-apple.video";

/** Where the camera waits, below the board: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("bad apple: the camera, below the board");

program(async () => {
  // The base's units would light fog of their own.
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04Bad Apple!! in the fog of war. The video plays on the MINIMAP.");
  displayText("\x11Classic graphics (Options > Graphics) draws the minimap sharp, Remastered soft; a snow board is brighter in Remastered.");
  await nextFrame();
  // The whole board lit once, so a dark part of a frame is fog grey, not the black of a tile never seen.
  fog.reveal(P1);
  await sleep(frames(118));
  for (const s of [5, 4, 3, 2, 1]) {
    displayText(`\x04Starting in ${s}...`);
    await sleep(frames(24));
  }
  playWav("staredit\\wav\\badapple.ogg", 0);
  await fog.play(P1, badApple);
  displayText("\x04Fin.");
});
