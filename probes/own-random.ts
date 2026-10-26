// TrigScript 4, the backend: random numbers in a map of our own (scripts/build-fixture.mts) — step 4 of the way off
// eudplib, part 4. random(n) draws the bits of n − 1 from the top, each one Set Switch to a random state, the game's own
// random numbers, and draws again when they make n or more; random() is one bit. Built both ways (through eudplib, and
// as a map of our own), the lifted game should print lines ending "ok" either way — the numbers drawn differ, so the
// checks are of ranges: a line ending "WRONG" names the check that failed. Frames 2, 4 and 6 (the lifted game's 4, 6
// and 8) are each one kind of work, 200 times, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-random.ts /tmp/own-random.scx
//   npx tsx scripts/build-fixture.mts probes/own-random.ts /tmp/own-random-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own random: the payload runs.");
  // A: bounds — 0 and 1 give 0, a bound below zero is read from 0 up, and every number drawn is below its bound.
  let zero = 0, one = 1, big = -1, j = 0, under = 0;
  while (j < 20) {
    const n = j * 3 + 2;
    if (random(n) < n && random(7) < 7 && random(big) < 4294967295 && random(65536) < 65536) under++;
    j++;
  }
  if (random(zero) == 0 && random(one) == 0 && random(1) == 0 && under == 20) print("A: random bounds ok");
  else print("A: random bounds WRONG");
  sleep(frames(2));
  // Frame 2: 200 dice, each face about a sixth of them (33, give or take 21).
  const faces = [0, 0, 0, 0, 0, 0];
  j = 0;
  while (j < 200) { faces[random(6)] += 1; j++; }
  let fair = 0;
  for (const f of faces) if (f >= 12 && f <= 55) fair++;
  if (fair == 6) print("B: 200 dice ok"); else print("B: 200 dice WRONG");
  sleep(frames(2));
  // Frame 4: 200 numbers below bounds from 1 to 10, their total about 450 (give or take 100).
  let sum = 0;
  j = 0;
  while (j < 200) { sum += random(j % 10 + 1); j++; }
  if (sum >= 350 && sum <= 550) print("C: 200 below a value ok"); else print("C: 200 below a value WRONG");
  sleep(frames(2));
  // Frame 6: 200 coin tosses, about 100 heads (give or take 30).
  let heads = 0;
  j = 0;
  while (j < 200) { if (random()) heads++; j++; }
  if (heads >= 70 && heads <= 130) print("D: 200 coin tosses ok"); else print("D: 200 coin tosses WRONG");
  print("Own random: done.");
});
