// Bad Apple!! in the fog of war: the TrigScript showcase map. The video is imported like a file of the script — a
// .video, the frames the editor decoded — and the fog library plays it on the minimap, a frame of it every frame of
// the game, with the song from the map's archive. Host it as a multiplayer game, alone, with Classic graphics.
//
// The map is 128 × 128 Badlands with no units. Its top 96 rows (the board, 4:3) are all tile 23778, white when lit
// and grey in fog on the Classic minimap; the rows below are never seen, so they stay black around the picture, and
// the camera waits there. The video and the song are not ours and never committed. Made with:
//   npx tsx scripts/import-video.mts <video file> probes/bad-apple.video --size=128x96
//   ffmpeg -i <video file> -vn -ac 2 -ar 44100 -c:a libvorbis -q:a 3 <song.ogg>
//   BA_ERA=0 BA_TILE=23778 npx tsx probes/lib/bad-apple-map.mts <base.scx> <song.ogg> 'staredit\wav\badapple.ogg'
//   NO_BASES=1 npx tsx scripts/build-fixture.mts probes/bad-apple.ts <map.scx> <base.scx>
import { fog } from "trigscript/fog";
import badApple from "./bad-apple.video";

const W = 128, H = 96;
/** Where the camera waits, below the board: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("bad apple: the camera, below the board");

/** Rows `from` to `to` of the board lit, as a picture: one step of the curtain the video opens and closes behind. */
const band = (from: number, to: number) =>
  fog.picture(Array.from({ length: H }, (_, y) => (y >= from && y < to ? "#" : ".").repeat(W)));
const STEP = 4;
const board = band(0, H);
/** White falls over the board from the top, a second long. */
const fall = Array.from({ length: H / STEP }, (_, i) => band(0, (i + 1) * STEP));
/** The white slides off the bottom, leaving the board in fog. */
const lift = Array.from({ length: H / STEP - 1 }, (_, i) => band((i + 1) * STEP, H));

const credits = () => {
  displayText("\x04Bad Apple!! feat. nomico");
  displayText("\x05Alstroemeria Records, after a Touhou Project song by ZUN. Shadow art video by Anira.");
};

program(async () => {
  centerLocation(PARK, 64 * 32, 116 * 32);
  centerView(PARK);
  await sleep(frames(24));
  credits();
  displayText("\x05Played on the minimap with the fog of war, written in TrigScript.");
  for (const p of fall) { fog.light(P1, 0, 0, p); await nextFrame(); }
  let i = 0;
  while (i < 72) { fog.light(P1, 0, 0, board); await nextFrame(); i++; }
  for (const p of lift) { fog.light(P1, 0, 0, p); await nextFrame(); }
  await sleep(frames(12));

  playWav("staredit\\wav\\badapple.ogg", 0);
  await fog.play(P1, badApple);

  // The song runs a little past the last frame.
  await sleep(frames(48));
  for (const p of fall) { fog.light(P1, 0, 0, p); await nextFrame(); }
  displayText("\x04Fin.");
  credits();
  i = 0;
  while (i < 120) { fog.light(P1, 0, 0, board); await nextFrame(); i++; }
  for (const p of lift) { fog.light(P1, 0, 0, p); await nextFrame(); }
});
