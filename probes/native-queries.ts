// The native-query probe (TrigScript 4, the limits): what Bring and Command cost Remastered. The script
// below only keeps the map's triggers running every frame; what is measured is native-queries.py, hand-written eudplib
// built into the same map, which plays its schedule by itself (`python3 probes/native-queries.py` prints it). Play it
// alone, single player, at Fastest, with remastered/profile.py (scm-sim-reader) running; press nothing.
// Built with
//   EXTRA_PLUGIN=nativeQueries=probes/native-queries.py npx tsx scripts/build-fixture.mts probes/native-queries.ts fixtures/eud/native-queries.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
