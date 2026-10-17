// The S4 fog probe (TrigScript 4): fog of war as a picture. The script below only keeps the map's triggers running
// every frame; what is tried is fog-probe.py, hand-written eudplib built into the same map. Host it as a multiplayer
// game, alone. What to look for, by the second (each step says so in the text lines too):
//   A   2  one brush jumping between two places, countdown written: does the old place go dark at once?
//   B  12  the same with the countdown not written: the old place should stay lit for up to four seconds
//   C  22  the brush sizes, sight 1-6 top row, 7-11 lower row (the minimap shows them all)
//   D  32  one brush sliding a tile a frame: smooth, smeared, trailing?
//   E  42  four pictures, 5 s each: dancer, apple, "Bad Apple", the dancer white on black
//   F  62  an animation, 72 frames looped
//   G  82  the dancer painted 1, 2, 4, 8 times a frame: when does the game stutter?
//   H 102  ground revealers (top row: sight 0, sight 1) beside air ones (lower row: sight 1)
// Built with
//   npx tsx probes/lib/fog-base-map.mts fixtures/eud/fog-base.scx
//   EXTRA_PLUGIN=fogSpike=probes/fog-probe.py npx tsx scripts/build-fixture.mts probes/fog-probe.ts fixtures/eud/fog-probe.scx fixtures/eud/fog-base.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
