// TrigScript 4, the backend: what stands on the heap in a map of our own (scripts/build-own.mts) — rows that grow inside
// an array, arrays of texts that grow (each cell's text a block of a pool), closures, an array in a function that calls
// itself, signals, and two programs whose arrays share the one heap.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the
// same frames; every line should end "ok", and a line ending "WRONG" names the check that failed.
//   npx tsx scripts/build-own.mts probes/own-heap-values.ts /tmp/own-heap-values.scx
//   npx tsx scripts/build-fixture.mts probes/own-heap-values.ts /tmp/own-heap-values-eud.scx
import { program, print, sleep, frames } from "trigscript";
import { Signal } from "trigscript/signals";

function counter() {
  let n = 0;
  return () => { n += 1; return n; };
}

function adder(k: number) {
  return (x: number) => x + k;
}

function build(n: number): number {
  const xs: number[] = [];
  let i = 0;
  while (i < n) { xs.push(i * n); i++; }
  let s = 0;
  if (n > 1) s = build(n - 1) + build(n - 2);
  for (const v of xs) s += v;
  return s + xs.length;
}

program(() => {
  print("Own heap values: the payload runs.");
  // A: rows that grow, inside an array that grows.
  const rows: number[][] = [];
  let i = 0;
  while (i < 5) { rows.push([]); i++; }
  i = 0;
  while (i < 40) { rows[i % 5].push(i); i++; }
  rows[2][3] = 99;
  rows[4].length = 2;
  const last = rows[3].pop()!;
  rows.push([7, 8, 9]);
  let sum = 0;
  for (const r of rows) for (const v of r) sum += v;
  if (rows.length == 6 && rows[0].length == 8 && rows[2][3] == 99 && rows[4].length == 2 && last == 38 && rows[5][1] == 8 && sum == 689) print("A: rows that grow ok"); else print("A: rows that grow WRONG");
  sleep(frames(4));
  // B: an array of texts that grows: pushed, written over, popped, shifted, spliced, joined.
  const log: string[] = [];
  let n = 0;
  while (n < 6) { log.push(`line ${n}`); n++; }
  log[2] = log[2] + "!";
  log[0] = "first";
  const gone = log.pop()!;
  log.shift();
  log.splice(1, 1, "mid", `n=${n}`);
  if (log.join(",") == "line 1,mid,n=6,line 3,line 4" && gone == "line 5" && log.includes("mid") && log.indexOf("line 4") == 4) print("B: an array of texts that grows ok"); else print("B: an array of texts that grows WRONG");
  print(log[2]);
  // C: arrays of texts declared again on each turn: their blocks go back to the pool.
  let turns = 0, total = 0;
  while (turns < 100) {
    const words: string[] = [];
    let w = 0;
    while (w < 3) { words.push(`w${turns}.${w}`); w++; }
    total += words[2].length;
    turns++;
  }
  const parts = "a,bb,ccc".split(",");
  if (total == 10 * 4 + 90 * 5 && parts.length == 3 && parts[2] == "ccc" && parts.join("+") == "a+bb+ccc") print("C: texts given back, split ok"); else print("C: texts given back, split WRONG");
  sleep(frames(4));
  // D: closures: a count kept, a value kept.
  const next = counter();
  let t = 0, c = 0;
  while (t < 3) { c += next(); t++; }
  const add = adder(n);
  let s = 0;
  while (s < 20) s = add(s);
  if (c == 6 && s == 24) print("D: closures ok"); else print("D: closures WRONG");
  // E: an array that grows in a function that calls itself, called again and again.
  let k = 0;
  while (k < 6) k += 1;
  let all = 0, again = 0;
  while (again < 30) { all += build(k); again++; }
  if (build(k) == 271 && all == 30 * 271) print("E: an array in a function that calls itself ok"); else print("E: an array in a function that calls itself WRONG");
  sleep(frames(4));
  // F: a signal of the script's own: handlers added and run.
  const hits = new Signal<number>();
  let heard = 0;
  hits.on((x) => { heard += x; });
  hits.on((x) => { heard += x * 10; });
  hits.emit(2);
  hits.emit(3);
  if (heard == 55) print("F: a signal ok"); else print("F: a signal WRONG");
  print("Own heap values: done.");
});

// G: a second program, its arrays on the same heap as the first's.
program(() => {
  sleep(frames(20));
  const mine: number[] = [];
  let i = 0;
  while (i < 300) { mine.push(i * 2); i++; }
  let s = 0;
  for (const v of mine) s += v;
  if (mine.length == 300 && s == 89700) print("G: a second program's array ok"); else print("G: a second program's array WRONG");
});
