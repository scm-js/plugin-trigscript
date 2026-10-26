// The weights probe (TrigScript 4, cost step 1): what each kind of condition and action costs Remastered. The script
// below only keeps the map's triggers running every frame; what is measured is frame-weights.py, hand-written eudplib
// built into the same map, which plays its schedule by itself (`python3 probes/frame-weights.py` prints it). Play it
// alone, single player, at Fastest, with remastered/profile.py (scm-sim-reader) running; press nothing.
// Built with
//   EXTRA_PLUGIN=frameWeights=probes/frame-weights.py npx tsx scripts/build-fixture.mts probes/frame-weights.ts fixtures/eud/frame-weights.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
