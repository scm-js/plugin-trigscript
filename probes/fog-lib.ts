// The fog library in the lifted game (TrigScript 4, S4): fog.reveal once, then every frame a disc and a picture.
//   npx tsx probes/lib/fog-base-map.mts fixtures/eud/fog-base.scx
//   npx tsx scripts/build-fixture.mts probes/fog-lib.ts fixtures/eud/fog-lib.scx fixtures/eud/fog-base.scx
import { fog } from "trigscript/fog";

const heart = fog.picture([
  ".##...##.",
  "####.####",
  "#########",
  ".#######.",
  "..#####..",
  "...###...",
  "....#....",
]);

program(async () => {
  fog.reveal(P1);
  await nextFrame();
  while (true) {
    fog.light(P1, 30, 30, 5);
    fog.light(P1, 60, 40, heart);
    await nextFrame();
  }
});
