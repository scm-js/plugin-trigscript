// The primitives probe (TrigScript 4, past eudplib): what Remastered's own records offer that eudplib does not use. The script
// below only keeps the map's triggers running every frame; what is measured is primitives.py, hand-written eudplib
// built into the same map, which plays its schedule by itself (`python3 probes/primitives.py` prints it). Play it
// alone, single player, at Fastest, with remastered/profile.py (scm-sim-reader) running; press nothing.
// Built with
//   EXTRA_PLUGIN=primitives=probes/primitives.py npx tsx scripts/build-fixture.mts probes/primitives.ts /tmp/primitives.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
