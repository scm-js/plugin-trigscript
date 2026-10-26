// TrigScript 4, the backend: functions that call themselves in a map of our own (scripts/build-fixture.mts) — each call that
// may come back keeps the function's variables and where it goes back to on a stack of its own, cell triggers the
// layout makes. Built both ways (through eudplib, and as a map of our own), the lifted game should print the same
// lines at the same frames; every line should end "ok", a line ending "WRONG" names the check that failed. The last
// part goes past the stack's depth (1024 calls, the default setting): the program says so in red and stops for good.
//   npx tsx scripts/build-fixture.mts probes/own-recursion.ts /tmp/own-recursion.scx
//   npx tsx scripts/build-fixture.mts probes/own-recursion.ts /tmp/own-recursion-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  print("Own recursion: the payload runs.");
  let calls = 0;

  // Two calls of itself, its parameter needed after the first.
  function fib(n: number): number {
    calls += 1;
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
  }
  // Two functions that call each other.
  function isEven(n: number): boolean {
    if (n == 0) return true;
    return isOdd(n - 1);
  }
  function isOdd(n: number): boolean {
    if (n == 0) return false;
    return isEven(n - 1);
  }
  // A loop around a call of itself: the counter and the sum kept across it.
  function tree(depth: number, width: number): number {
    if (depth == 0) return 1;
    let sum = 1, i = 0;
    while (i < width) { sum += tree(depth - 1, width); i++; }
    return sum;
  }
  // Its parameters handed on crossed (each read before either is set), by subtraction.
  function gcd(a: number, b: number): number {
    if (b == 0) return a;
    if (a < b) return gcd(b, a);
    return gcd(a - b, b);
  }
  // As deep as it is asked to go.
  function down(n: number): number {
    if (n == 0) return 0;
    return down(n - 1) + 1;
  }

  // A: fib(10), and how many calls it took.
  let f = fib(10);
  if (f == 55 && calls == 177) print("A: fib(10) ok"); else print("A: fib(10) WRONG");
  // B: two functions that call each other.
  let k = 7;
  if (isOdd(k) && isEven(k + 3) && !isEven(k)) print("B: calling each other ok"); else print("B: calling each other WRONG");
  sleep(frames(4));
  // C: a loop around the call.
  if (tree(3, 3) == 40) print("C: a loop around the call ok"); else print("C: a loop around the call WRONG");
  // D: parameters handed on crossed.
  if (gcd(1071, 462) == 21 && gcd(17, 5) == 1) print("D: parameters crossed ok"); else print("D: parameters crossed WRONG");
  sleep(frames(4));
  // E: a thousand calls deep, under the stack's depth.
  if (down(1000) == 1000) print("E: a thousand deep ok"); else print("E: a thousand deep WRONG");
  // F: fib(18), 8361 calls in one frame.
  calls = 0;
  f = fib(18);
  if (f == 2584 && calls == 8361) print("F: fib(18) ok"); else print("F: fib(18) WRONG");
  sleep(frames(4));
  // G: past the stack's depth: the program says so in red and stops — the next line must never show.
  print("G: going past the stack's depth now");
  down(1100);
  print("G: WRONG, the program went on");
});
