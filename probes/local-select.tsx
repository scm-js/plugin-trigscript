// B5's second played map: the unit you have selected, shown live, and select() choosing it for you.
// Play it in single player, then hosted as a multiplayer game alone. What to look for (the lines say it too):
//   1  the panel: the unit you have selected — its type, hit points, order — and how many, every frame
//   2  S: the script selects your Command Center. Does the circle move to it? The panel at the bottom? Right-click
//      the ground: a rally point (the Command Center obeys) or a Marine walking?
//   3  D: the script selects the unit under your cursor (point at a Marine first): the same three questions
//   4  W: a Marine walks to where your cursor is — sent with sync(x, y) in one trip; the frames it took
// Built with
//   npx tsx scripts/build-fixture.mts probes/local-select.tsx fixtures/eud/local-select.scx
import { program, ui, print, keyPressed, underMouse, first, select, unitsOf, centerLocation, sleep, frames, local, sync, memory, units, P1, type Location } from "trigscript";

const SPOT = 1 as Location;

program(async () => {
  let type = -1, hp = 0, most = 0, order = 0, count = 0;
  let last = "S: your Command Center   D: what is under the cursor   W: Marines walk to the cursor";
  ui.lines(P1, () => (
    <>
      <line color="yellow">SELECTED <span color="white">{count} unit{count === 1 ? "" : "s"}</span></line>
      <line>type <span color="cyan">{type}</span>   hit points <span color="green">{hp}</span> of {most}   order <span color="cyan">{order}</span></line>
      <line color="white">{last}</line>
    </>
  ));
  while (true) {
    // Only shown: each computer its own.
    const u = local.selected;
    count = local.selectionCount;
    if (u) { type = u.type; hp = u.hp; most = u.maxHp; order = u.orderId; } else { type = -1; hp = 0; most = 0; order = 0; }
    if (keyPressed(P1, "S")) {
      const cc = first({ owner: P1, type: units.TerranCommandCenter });
      if (cc) { select(P1, cc); last = "S: the Command Center selected by the script. Circle? Panel? Right-click: who obeys?"; }
    }
    if (keyPressed(P1, "D")) {
      const under = underMouse(P1, { owner: P1 });
      if (under) { select(P1, under); last = `D: the unit under the cursor (type ${under.type}) selected. Circle? Panel? Who obeys?`; }
      else last = "D: point at one of your units first";
    }
    if (keyPressed(P1, "W")) {
      const asked = memory.game.frame;
      const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y);
      centerLocation(SPOT, x, y);
      for (const m of unitsOf(P1, { type: units.TerranMarine })) m.order("move", SPOT);
      last = `W: Marines to ${x},${y}, sent in ${memory.game.frame - asked} frames (x and y together)`;
    }
    await sleep(frames(1));
  }
}, { owner: P1 });

program(() => { print("The selection map: a live panel, S, D and W. Host it as a multiplayer game too."); });
