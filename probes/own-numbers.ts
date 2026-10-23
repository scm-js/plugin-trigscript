// TrigScript 4, the backend: products, quotients and remainders in a map of our own (scripts/build-fixture.mts) — step 4 of
// the way off eudplib. A product tests the narrower side a bit at a time and adds the other side's multiples, which
// are places of it; a quotient by a constant is a chain of triggers written where it is used; a quotient of two values
// doubles the remainder in one action of a trigger of its own. Built both ways (through eudplib, and as a map of our
// own), the lifted game should print the same lines at the same frames; every line should end "ok", and a line ending
// "WRONG" names the check that failed. Frames 2, 4, 6, 8 and 10 (the lifted game's 4, 6, 8, 10 and 12) are each one kind of
// work, 200 times, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-numbers.ts /tmp/own-numbers.scx
//   npx tsx scripts/build-fixture.mts probes/own-numbers.ts /tmp/own-numbers-eud.scx
import { program, print, sleep, frames } from "trigscript";

// What each check should give, worked out when the script is built: JavaScript's own arithmetic on 32 bits.
const lcg = (s: number) => (Math.imul(s, 1103515245) + 12345) | 0;
function products(): number {
  let x = 7, acc = 1;
  for (let i = 0; i < 200; i++) { x = lcg(x); acc = (Math.imul(acc, x) + i) | 0; }
  return acc;
}
function byConstant(): number {
  let x = 7, sum = 0;
  for (let i = 0; i < 200; i++) { x = lcg(x); sum = (sum + ((x / 10) | 0) + (x % 7)) | 0; }
  return sum;
}
function byValue(): number {
  let x = 7, sum = 0;
  for (let i = 0; i < 200; i++) { x = lcg(x); const d = (x >>> 21) + 1; sum = (sum + ((x / d) | 0)) | 0; }
  return sum;
}
function remainders(): number {
  let x = 7, sum = 0;
  for (let i = 0; i < 200; i++) { x = lcg(x); const d = (x >>> 21) + 1; sum = (sum + (x % d)) | 0; }
  return sum;
}
function small(): number {
  let area = 0, share = 0;
  for (let j = 0; j < 200; j++) { area += (j % 64) * (j % 37); share += ((j * 37 + 5) / ((j % 13) + 1)) | 0; }
  return (area + share) | 0;
}
const PRODUCTS = products(), BY_CONSTANT = byConstant(), BY_VALUE = byValue(), REMAINDERS = remainders(), SMALL = small();
const LCG3 = lcg(lcg(lcg(12345)));

program(() => {
  print("Own numbers: the payload runs.");
  // A: products of two values — a small range, any number, below zero, past 32 bits.
  let i = 1, fact = 1;
  while (i <= 10) { fact = fact * i; i++; }
  let s = 12345, k = 0;
  while (k < 3) { s = s * 1103515245 + 12345; k++; }
  let n = -7, m = -300000, w = 65537, sq = -46341;
  if (fact == 3628800 && s == LCG3 && n * m == 2100000 && w * w == 131073 && sq * sq == -2147479015 && n * w == -458759) print("A: products ok");
  else print("A: products WRONG");
  sleep(frames(2));
  // Frame 2: 200 products of numbers the value ranges cannot bound.
  let x = 7, acc = 1, j = 0;
  while (j < 200) { x = x * 1103515245 + 12345; acc = acc * x + j; j++; }
  if (acc == PRODUCTS) print("B: 200 products ok"); else print("B: 200 products WRONG");
  sleep(frames(2));
  // C: by a constant — below zero, a divisor below zero, a power of two, the least number, u32.
  let a = 50, b = -50, c = -9, least = -2147483648;
  let big: u32 = 4294967294;
  if (a / 7 == 7 && a % 7 == 1 && b / 7 == -7 && b % 7 == -1 && c / -4 == 2 && c % -4 == -1 && c / 4 == -2 && c % 8 == -1
    && least / 10 == -214748364 && least % 10 == -8 && big / 3 == 1431655764 && big % 3 == 2) print("C: by a constant ok");
  else print("C: by a constant WRONG");
  // Frame 6: 200 quotients and remainders by constants.
  x = 7; j = 0;
  let sum = 0;
  while (j < 200) { x = x * 1103515245 + 12345; sum += x / 10 + x % 7; j++; }
  if (sum == BY_CONSTANT) print("D: 200 by constants ok"); else print("D: 200 by constants WRONG");
  sleep(frames(2));
  // E: of two values — signs, by 0, the least number by -1, u32 past 2^31.
  let p = 100, q = 7, mq = -7, mp = -100, zero = 0, one = -1, five = 5;
  let ua: u32 = 4000000000, ub: u32 = 3000000000, top: u32 = 4294967295, uone: u32 = 1;
  if (p / q == 14 && p % q == 2 && mp / q == -14 && mp % q == -2 && p / mq == -14 && p % mq == 2 && mp / mq == 14
    && five / zero == 0 && five % zero == 0 && least / one == -2147483648 && least % one == 0
    && ua / ub == 1 && ua % ub == 1000000000 && top / uone == 4294967295 && 2147483647 / (q - 5) == 1073741823) print("E: of two values ok");
  else print("E: of two values WRONG");
  // Frame 10: 200 quotients of two values.
  x = 7; j = 0; sum = 0;
  while (j < 200) { x = x * 1103515245 + 12345; const d = (x >>> 21) + 1; sum += x / d; j++; }
  if (sum == BY_VALUE) print("F: 200 quotients of two values ok"); else print("F: 200 quotients of two values WRONG");
  sleep(frames(2));
  // Frame 14: 200 remainders of two values.
  x = 7; j = 0; sum = 0;
  while (j < 200) { x = x * 1103515245 + 12345; const d = (x >>> 21) + 1; sum += x % d; j++; }
  if (sum == REMAINDERS) print("G: 200 remainders of two values ok"); else print("G: 200 remainders of two values WRONG");
  sleep(frames(2));
  // Frame 10: numbers as a map's are — coordinates, counts — 200 products and 200 quotients of two values whose ranges are small.
  j = 0;
  let area = 0, share = 0;
  while (j < 200) { area += (j % 64) * (j % 37); share += (j * 37 + 5) / (j % 13 + 1); j++; }
  if (area + share == SMALL) print("H: 200 of small numbers ok"); else print("H: 200 of small numbers WRONG");
  print("Own numbers: done.");
});
