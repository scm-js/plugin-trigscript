// TrigScript 4, the backend: calls in a map of our own (scripts/build-own.mts) — functions laid out once and called
// from several places, arguments written into the function's places, back by a next pointer. Built both ways (through
// eudplib, and as a map of our own), the lifted game should print the same lines at the same frames; every line
// should end "ok", and a line ending "WRONG" names the check that failed. (Loops are `while` loops: a `for` with a
// bound known when the script is built is unrolled by the front end.)
//   npx tsx scripts/build-own.mts probes/own-calls.ts /tmp/own-calls.scx
//   npx tsx scripts/build-fixture.mts probes/own-calls.ts /tmp/own-calls-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own calls: the payload runs.");
  let a = 5, touched = 0, steps = 0;

  // A function with a loop of its own, called from several places.
  function sumTo(n: number) {
    let s = 0, i = 0;
    while (i < n) { s += i; i++; }
    return s;
  }
  // Two parameters, a return from each branch.
  function pick(x: number, y: number) {
    if (x > y) return x - y;
    if (x == y) return 0;
    return y - x + 100;
  }
  // A function that changes a variable of the program.
  function bump() {
    a += 10;
    return 1;
  }
  // A function that calls another.
  function twice(n: number) {
    return sumTo(n) + sumTo(n + 1);
  }
  // A boolean, and one that leaves a trace when it runs.
  function even(n: number) {
    return (n & 1) == 0;
  }
  function touch() {
    touched += 1;
    return true;
  }
  // Steps a counter kept by the program; read in a loop's test.
  function next(i: number) {
    steps += 1;
    return i + 1;
  }
  function add(x: number, y: number) { return x + y; }
  function sub(x: number, y: number) { return x - y; }

  // A: the same function from three places, its loop's bound a variable.
  let x = sumTo(4) + sumTo(a);
  if (sumTo(3) == 3 && x == 16) print("A: one function, three calls ok"); else print("A: one function, three calls WRONG");
  // B: arguments that are sums, a return from each branch.
  let k = 7;
  if (pick(k + 3, 4) == 6 && pick(k, k) == 0 && pick(1, k * 2) == 113) print("B: arguments and returns ok"); else print("B: arguments and returns WRONG");
  sleep(frames(4));
  // C: JavaScript's order: a is read before bump() changes it.
  let y = a + bump();
  if (y == 6 && a == 15) print("C: read before the call ok"); else print("C: read before the call WRONG");
  // D: calls as arguments of calls; a function that calls another.
  let d = pick(sumTo(4), pick(2, 9)) + twice(3);
  if (d == 210) print("D: calls in calls ok"); else print("D: calls in calls WRONG");
  sleep(frames(4));
  // E: a boolean function in a test; a call in a later part of && runs only when the first part holds.
  let e = 0;
  if (even(k + 1)) e += 1;
  if (even(k) && touch()) e += 10;
  if (even(4) && touch()) e += 100;
  if (e == 101 && touched == 1) print("E: a boolean, && that stops ok"); else print("E: a boolean, && that stops WRONG");
  // F: a call in a loop's test, every turn.
  let i = 0, n = 0;
  while (next(i) < 6) { i = next(i); n += 1; }
  if (n == 5 && i == 5 && steps == 11) print("F: a call in a loop's test ok"); else print("F: a call in a loop's test WRONG");
  sleep(frames(4));
  // G: a function kept as a value, called through its number.
  let op = add;
  let g = op(20, 3);
  if (g > 20) op = sub;
  g = g + op(20, 3);
  if (g == 40) print("G: a function as a value ok"); else print("G: a function as a value WRONG");
  // H: two hundred calls in one frame.
  let total = 0;
  i = 0;
  while (i < 200) { total += pick(i, 100); i++; }
  if (total == 20000) print("H: two hundred calls ok"); else print("H: two hundred calls WRONG");
  print("Own calls: done.");
});
