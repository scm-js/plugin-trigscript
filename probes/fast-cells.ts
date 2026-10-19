// The fast-cell probe (TrigScript 4): whether the neutral players' ore, gas and score are cheaper cells than Set Deaths. The script
// below only keeps the map's triggers running every frame; what is measured is fast-cells.py, hand-written eudplib
// built into the same map, which plays its schedule by itself (`python3 probes/fast-cells.py` prints it). Play it
// alone, single player, at Fastest, with remastered/profile.py (scm-sim-reader) running; press nothing.
// Built with
//   EXTRA_PLUGIN=fastCells=probes/fast-cells.py npx tsx scripts/build-fixture.mts probes/fast-cells.ts fixtures/eud/fast-cells.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
