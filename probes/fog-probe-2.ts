// The S4 fog probe, second round (TrigScript 4). The script below only keeps the map's triggers running every frame;
// what is tried is fog-probe-2.py, hand-written eudplib built into the same map. Host it as a multiplayer game, alone.
// Play it twice: Remastered graphics, then Classic. What to look for, by the second:
//   A   2  one brush jumping: the old place goes dark at once?
//   C   6  the sizes 1-11, each a unit type of its own: each a different size now?
//   E  12  four pictures, 4 s each
//   F  28  the animation
//   H  34  ground Map Revealers at sight 0 (3x3?) above size-1 air brushes
//   I  38  the dancer painted 3-10 times a frame: when does "Cannot create more units." start?
// Built with
//   npx tsx probes/lib/fog-base-map.mts fixtures/eud/fog-base.scx
//   EXTRA_PLUGIN=fogSpike2=probes/fog-probe-2.py npx tsx scripts/build-fixture.mts probes/fog-probe-2.ts fixtures/eud/fog-probe-2.scx fixtures/eud/fog-base.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
