// TrigScript 4, the backend: arrays that grow in a map of our own (scripts/build-own.mts) — every growing array's cells
// a block of one heap of cell triggers, the array four numbers beside it (where its block is, its length, its room, its
// block's size), a push a store at the end and an addition, more room the run time's `grow`.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the
// same frames; every line should end "ok", and a line ending "WRONG" names the check that failed.
//   npx tsx scripts/build-own.mts probes/own-growing.ts /tmp/own-growing.scx
//   npx tsx scripts/build-fixture.mts probes/own-growing.ts /tmp/own-growing-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own growing arrays: the payload runs.");
  // A: pushed past several block sizes, read back, its length.
  const xs: number[] = [];
  let i = 0;
  while (i < 40) { xs.push(i * 3); i++; }
  let sum = 0;
  for (const x of xs) sum += x;
  if (xs.length == 40 && sum == 2340 && xs[39] == 117 && xs[0] == 0) print("A: pushes and reads ok"); else print("A: pushes and reads WRONG");
  // B: popped as a value and as a statement; empty, a pop is 0.
  const ys = [5, 6, 7];
  const last = ys.pop()!;
  ys.pop();
  const first = ys.pop()!;
  const none = ys.pop() ?? 0;
  if (last == 7 && first == 5 && none == 0 && ys.length == 0) print("B: pops ok"); else print("B: pops WRONG");
  sleep(frames(4));
  // C: a store at the length is a push; past it, nothing; a read past either end is 0.
  const zs = [1];
  zs.push(2);
  let at = 2;
  zs[at] = 3;
  at = 7;
  zs[at] = 9;
  let below = -1;
  zs[below] = 9;
  if (zs.length == 3 && zs[at - 5] == 3 && zs[at] == 0 && zs[below] == 0 && zs[at - 4] == 0) print("C: past the ends ok"); else print("C: past the ends WRONG");
  // D: cut short by its length, a longer length nothing; pushed again after.
  const ws = [1, 2, 3, 4, 5];
  ws.length = 2;
  let longer = 9;
  ws.length = longer;
  ws.push(8);
  if (ws.length == 3 && ws[2] == 8 && ws[1] == 2) print("D: a length set ok"); else print("D: a length set WRONG");
  sleep(frames(4));
  // E: declared again on each turn of a loop, its block given back: 500 turns of 32 cells, past the heap's 16 384 were
  // none given back.
  let turns = 0, seen = 0;
  while (turns < 500) {
    const fresh: number[] = [];
    let j = 0;
    while (j < 20) { fresh.push(turns + j); j++; }
    seen += fresh[19];
    turns++;
  }
  if (seen == 500 * 19 + 124750) print("E: blocks given back ok"); else print("E: blocks given back WRONG");
  // F: booleans, and u8 cells stopped at their top.
  const flags: boolean[] = [];
  let f = 0;
  while (f < 10) { flags.push(f % 3 == 0); f++; }
  let set = 0;
  for (const b of flags) if (b) set++;
  const bytes: u8[] = [];
  let over = 300, under = -4;
  bytes.push(over);
  bytes.push(under);
  bytes.push(7);
  if (set == 4 && flags[3] && !flags[4] && bytes[0] == 255 && bytes[1] == 0 && bytes[2] == 7) print("F: booleans and u8 ok"); else print("F: booleans and u8 WRONG");
  sleep(frames(4));
  // G: a Map and a Set.
  const scores = new Map<number, number>();
  let key = 3;
  while (key < 3000) { scores.set(key, key * 2); key = key * 3; }
  scores.set(9, 1);
  scores.delete(27);
  const seenSet = new Set<number>();
  let s = 0;
  while (s < 30) { seenSet.add(s % 7); s++; }
  let mapSum = 0;
  for (const [, v] of scores) mapSum += v;
  if (scores.size == 6 && scores.get(9) == 1 && !scores.has(27) && mapSum == 6 + 1 + 162 + 486 + 1458 + 4374 && seenSet.size == 7 && seenSet.has(6)) print("G: a Map and a Set ok"); else print("G: a Map and a Set WRONG");
  // H: filter, map, concat, slice, splice, sorted and reversed copies.
  const hs = [5, 1, 4, 2, 3];
  const big = hs.filter((x) => x > 2);
  const doubled = hs.map((x) => x * 2);
  const both = big.concat(doubled);
  const part = both.slice(1, 4);
  const sorted = hs.toSorted((a, b) => a - b);
  const turned = sorted.toReversed();
  hs.splice(1, 2, 9);
  if (big.length == 3 && both.length == 8 && part[0] == 4 && part[2] == 10 && sorted[0] == 1 && sorted[4] == 5 && turned[0] == 5 && hs.length == 4 && hs[1] == 9 && hs[2] == 2) print("H: copies and splices ok"); else print("H: copies and splices WRONG");
  sleep(frames(4));
  // I: a thousand pushes in a frame (weighed).
  const many: number[] = [];
  let m = 0;
  while (m < 1000) { many.push(m); m++; }
  if (many.length == 1000 && many[999] == 999) print("I: a thousand pushes ok"); else print("I: a thousand pushes WRONG");
  sleep(frames(4));
  // J: a thousand reads at an index that jumps about (weighed).
  let k = 0, total = 0, n = 0;
  while (n < 1000) { total += many[k]; k = (k + 373) % 1000; n++; }
  if (total == 499500) print("J: a thousand reads ok"); else print("J: a thousand reads WRONG");
  sleep(frames(4));
  // K: a thousand stores at an index that jumps about (weighed).
  n = 0;
  k = 0;
  while (n < 1000) { many[k] = n; k = (k + 373) % 1000; n++; }
  if (many[373] == 1 && many[746] == 2) print("K: a thousand stores ok"); else print("K: a thousand stores WRONG");
  sleep(frames(4));
  // L: a loop over a thousand, and pops to empty (weighed).
  total = 0;
  for (const v of many) total += v;
  while (many.length > 0) many.pop();
  if (total == 499500 && many.length == 0) print("L: a loop and pops ok"); else print("L: a loop and pops WRONG");
  sleep(frames(4));
  // M: out of memory: pushed past what the heap has left (the arrays above hold blocks still), the pushes stop at a block's
  // size, said once, and what is there is as pushed.
  const huge: number[] = [];
  let h = 0;
  while (h < 9000) { huge.push(h); h++; }
  const got = huge.length;
  if (got < 9000 && got >= 1024 && (got & (got - 1)) == 0 && huge[got - 1] == got - 1) print("M: out of memory ok"); else print("M: out of memory WRONG");
  print("Own growing arrays: done.");
});
