// TrigScript 4, the backend: a map of our own — no eudplib, no Python (scripts/build-fixture.mts). The program's whole
// body is the emitter's: loops of numbers whose results it checks itself, each check showing one line of known text.
// Every line should end "ok"; a line ending "WRONG" names the check that failed. (Loops are `while` loops: a `for`
// with a bound known when the script is built is unrolled by the front end, a turn at a time in the map.)
//   npx tsx scripts/build-fixture.mts probes/own-loader.ts /tmp/own-loader.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own loader: the payload runs.");
  // A: a sum up to a bound kept in a variable.
  let n = 7, sum = 0, i = 0;
  while (i < n) { sum += i; i++; }
  if (sum == 21) print("A: a loop's sum ok"); else print("A: a loop's sum WRONG");
  sleep(frames(4));
  // B: break, continue, a loop inside a loop.
  let b = 0;
  i = 0;
  while (i < 100) {
    i++;
    if (i - 1 == n) break;
    if (i - 1 < 2) continue;
    let j = 0;
    while (j < i - 1) { b += j; j++; }
  }
  if (b == 35) print("B: break, continue, nested ok"); else print("B: break, continue, nested WRONG");
  // C: comparisons at the edges, signed and unsigned.
  let big = 2147483647, small = -2147483648, zero = 0, c = 0;
  if (small < big) c += 1;
  if (big > zero) c += 2;
  if (small < zero) c += 4;
  if (big >= big) c += 8;
  if (!(big < small)) c += 16;
  if (c == 31) print("C: comparisons at the edges ok"); else print("C: comparisons at the edges WRONG");
  sleep(frames(4));
  // D: products and shifts by constants, wrapping.
  let g = 1, h = 0;
  i = 0;
  while (i < n) { g = g * 3 + 1; h = h + (i << 29); i++; }
  if (g == 3280 && h == -1610612736) print("D: products and shifts ok"); else print("D: products and shifts WRONG");
  // E: a do-while down to a negative number.
  let k = 3, low = 100;
  do { low = k; k -= 1; } while (k >= -3);
  if (low == -3 && k == -4) print("E: do-while ok"); else print("E: do-while WRONG");
  // F: a loop that sleeps a frame each turn; the sum it keeps lives across the frames.
  let f = 0;
  i = 0;
  while (i < 5) { f += i * 10; i++; sleep(frames(1)); }
  if (f == 100) print("F: a loop across frames ok"); else print("F: a loop across frames WRONG");
  print("Own loader: done.");
});
