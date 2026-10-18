// B5's first played map: what only this computer knows, shown live in the text lines, and sync() acting on it.
// Play it in single player, then hosted as a multiplayer game alone. What to look for (the lines say it too):
//   1  the panel: your camera and your mouse, on the screen and on the map, every frame; beside it the mouse as MSQC
//      sends it to everyone (mouse(P1)), a few frames behind when you move
//   2  Q: a Marine at the top left corner of your screen, 64 pixels in, sent with sync(); the frames it took
//   3  W: a Marine under your cursor, sent with sync() as camera + mouse; the frames it took
//   4  scroll somewhere and press Q again: the Marine follows your screen
// Built with
//   npx tsx scripts/build-fixture.mts probes/local-ui.tsx fixtures/eud/local-ui.scx
import { program, ui, print, createUnit, centerLocation, keyPressed, mouse, sleep, frames, local, sync, memory, units, P1, type Location } from "trigscript";

const SPOT = 1 as Location;

program(async () => {
  // The panel reads these; written every frame, so it is drawn again every frame they change.
  let cx = 0, cy = 0, mx = 0, my = 0, sx = 0, sy = 0;
  let last = "press Q or W";
  ui.lines(P1, () => (
    <>
      <line color="yellow">LOCAL VALUES <span color="white">player {local.player}</span></line>
      <line>camera <span color="cyan">{cx},{cy}</span>   mouse on the screen <span color="cyan">{mx},{my}</span></line>
      <line>on the map <span color="green">{cx + mx},{cy + my}</span>   sent by MSQC <span color="orange">{sx},{sy}</span></line>
      <line color="white">{last}</line>
      <line color="sage">Q: a Marine at your screen's corner   W: a Marine under the cursor</line>
    </>
  ));
  while (true) {
    cx = local.camera.x; cy = local.camera.y;
    mx = local.mouse.x; my = local.mouse.y;
    const m = mouse(P1);
    sx = m.x; sy = m.y;
    if (keyPressed(P1, "Q")) {
      const asked = memory.game.frame;
      const [x, y] = await sync(P1, local.camera.x + 64, local.camera.y + 64);
      centerLocation(SPOT, x, y);
      createUnit(P1, units.TerranMarine, 1, SPOT);
      last = `Q: corner ${x},${y}, sent in ${memory.game.frame - asked} frames`;
    }
    if (keyPressed(P1, "W")) {
      const asked = memory.game.frame;
      const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y);
      centerLocation(SPOT, x, y);
      createUnit(P1, units.TerranMarine, 1, SPOT);
      last = `W: cursor ${x},${y}, sent in ${memory.game.frame - asked} frames`;
    }
    await sleep(frames(1));
  }
}, { owner: P1 });

program(() => { print("The local-values map: a live panel, Q and W. Host it as a multiplayer game too."); });
