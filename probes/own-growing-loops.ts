// TrigScript 4, the backend: the common patterns of an array that grows in a map of our own, a frame each (weighed):
// pushes, a loop at an index over its length, for…of, a store at the loop's index, records pushed and moved, an array
// filtered in place. Loops over an array test nothing at its counter and keep each cell's place beside it.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the
// same frames; every line should end "ok", and a line ending "WRONG" names the check that failed.
//   npx tsx scripts/build-own.mts probes/own-growing-loops.ts /tmp/own-growing-loops.scx
//   npx tsx scripts/build-fixture.mts probes/own-growing-loops.ts /tmp/own-growing-loops-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own growing loops: the payload runs.");
  const xs: number[] = [];
  let m = 0;
  while (m < 500) { xs.push(m); m++; }
  if (xs.length == 500) print("1: 500 pushes ok"); else print("1: 500 pushes WRONG");
  sleep(frames(4));
  // A: a loop at an index over its length.
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i];
  if (total == 124750) print("A: a loop at an index ok"); else print("A: a loop at an index WRONG");
  sleep(frames(4));
  // B: for…of.
  total = 0;
  for (const v of xs) total += v;
  if (total == 124750) print("B: for of ok"); else print("B: for of WRONG");
  sleep(frames(4));
  // C: written at a loop's index.
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i] + 1;
  if (xs[0] == 1 && xs[499] == 500) print("C: stores at the counter ok"); else print("C: stores at the counter WRONG");
  sleep(frames(4));
  // D: records in an array that grows, pushed, then moved and aged.
  const bs: { x: number; dx: number; life: number }[] = [];
  let b = 0;
  while (b < 200) { bs.push({ x: b * 13, dx: 3 + b % 5, life: 100 + b }); b++; }
  if (bs.length == 200 && bs[199].life == 299) print("2: 200 records pushed ok"); else print("2: 200 records pushed WRONG");
  sleep(frames(4));
  let alive = 0;
  for (const q of bs) { q.x += q.dx; if (q.x >= 4000) q.dx = -3; if (q.life > 0) { q.life--; alive++; } }
  if (alive == 200 && bs[0].x == 3 && bs[199].life == 298 && bs[199].x == 2594) print("D: records moved ok"); else print("D: records moved WRONG");
  sleep(frames(4));
  // E: filtered in place while walking it, then cut to what is left.
  let w = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i] % 3 != 0) { xs[w] = xs[i]; w++; }
  xs.length = w;
  if (xs.length == 334 && xs[0] == 1 && xs[1] == 2 && xs[2] == 4) print("E: filtered in place ok"); else print("E: filtered in place WRONG");
  print("Own growing loops: done.");
});
