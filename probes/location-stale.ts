// The stale-location probe (TrigScript 4, the limits): does Bring read old counts after its location moved in the same
// trigger pass? The script below only keeps the map's triggers running every frame; the probe is location-stale.py,
// hand-written eudplib built into the same map, which prints nine lines by itself. Play it single player; press nothing.
// Built with
//   EXTRA_PLUGIN=locationStale=probes/location-stale.py npx tsx scripts/build-fixture.mts probes/location-stale.ts fixtures/eud/location-stale.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
