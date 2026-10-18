// The local-reads probe (TrigScript 4, B5): what one machine's own values read as in Remastered, before B5 offers
// them. The dump's emulator (Ghidra, 2026-10-17) says the camera, the mouse, its buttons, the selection and the
// local player are all read live; this asks what playing shows. The local reads are probes/local-reads.py,
// hand-written eudplib built into the same map; the script below is the synced half: it sends a left click and the
// mouse through MSQC the way TrigScript does today, and leaves when they arrived in Player 1's deaths of Terran
// Civilian (P1: the frame a click arrived, P2 and P3: the synced mouse), for the Python to set beside the local ones.
// Five lines are printed again every half second; each says what to do. Nothing is on a clock.
//   1  the live values: local player, camera, the mouse on the screen and on the map, the synced mouse, the buttons
//   2  the mouse's smallest and largest place on the screen since F7: sweep the cursor into all four corners
//   3  the selection as the game keeps it; F8 writes it (a Marine of yours put in slot 0, the rest cleared)
//   4  a left click's trip: the frame it was down here, the frame it arrived through MSQC, the frames between
//   5  F9 writes the mouse to (320, 240): what it reads back after 0, 1, 2 and 8 frames
// Played twice: in single player, then hosted as a multiplayer game, alone.
// Built with
//   EXTRA_PLUGIN=localReads=probes/local-reads.py npx tsx scripts/build-fixture.mts probes/local-reads.ts fixtures/eud/local-reads.scx
import { program, displayText, setDeaths, sleep, frames, clicked, mouse, memory, units, P1, P2, P3 } from "trigscript";

program(() => {
  displayText("The local-reads probe: five lines, printed again every half second. F7 F8 F9 and a left click.");
  while (true) {
    if (clicked(P1, "left")) setDeaths(P1, units.TerranCivilian, "set", memory.game.frame);
    const at = mouse(P1);
    setDeaths(P2, units.TerranCivilian, "set", at.x);
    setDeaths(P3, units.TerranCivilian, "set", at.y);
    sleep(frames(1));
  }
}, { owner: P1 });
