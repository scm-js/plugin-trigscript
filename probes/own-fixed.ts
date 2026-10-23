// TrigScript 4, the backend: numbers with a fraction (fixed, 16.16) in a map of our own (scripts/build-fixture.mts) — step 4
// of the way off eudplib, part 3: a product and a quotient by a constant, a constant over a value, and a product and a
// quotient of two values, and fixed numbers printed. Built both ways (through eudplib, and as a map of our own), the
// lifted game should print the same lines at the same frames; every line should end "ok", and a line ending "WRONG"
// names the check that failed. Line G should read "G: -2.5 0.75 30000 0 0 1 0.3333 -0.3333 -2500".
// Frames 2 to 10 (the lifted game's 4 to 12) are each one kind of work, 200 times, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-fixed.ts /tmp/own-fixed.scx
//   npx tsx scripts/build-fixture.mts probes/own-fixed.ts /tmp/own-fixed-eud.scx
import { program, print, sleep, frames, fixed, type fixed as Fixed } from "trigscript";

// The game's arithmetic on raw cells (compiler/fixedMath.ts), to work out when the script is built what each frame's
// sum should be: towards zero, wrapping at 32 bits; a quotient by 0 is 0.
const U32 = 0x1_0000_0000n;
const mag = (v: number) => BigInt(v < 0 ? -v : v);
const cell = (m: bigint, neg: boolean) => Number(BigInt.asIntN(32, (neg ? U32 - (m % U32) : m) % U32));
const fmul = (a: number, b: number) => cell((mag(a) * mag(b)) >> 16n, (a < 0) !== (b < 0));
const fdiv = (a: number, b: number) => (b === 0 ? 0 : cell((mag(a) << 16n) / mag(b), (a < 0) !== (b < 0)));
const raw = (v: number) => Math.round(v * 65536);
/** Each turn's x (and y), as the program steps them, and the sum of `f` over the 200 turns, as a fixed number. */
function sumOf(f: (x: number, y: number) => number): number {
  let x = raw(-30), y = raw(7.25), s = 0;
  for (let j = 0; j < 200; j++) { x = (x + raw(0.371)) | 0; y = (y - raw(0.0625)) | 0; s = (s + f(x, y)) | 0; }
  return s / 65536;
}
const BY_CONST = sumOf((x) => fmul(x, raw(1.5))), OVER_CONST = sumOf((x) => fdiv(x, raw(1.5))), RECIPROCAL = sumOf((x) => fdiv(raw(3), x));
const PRODUCTS = sumOf((x, y) => fmul(x, y)), QUOTIENTS = sumOf((x, y) => fdiv(x, y));
const [A, B, BIG] = [raw(-2.5), raw(0.75), raw(30000)];
const EDGES = [fmul(A, B), fmul(A, raw(1.5)), fdiv(A, B), fdiv(B, A), fdiv(raw(1), B), fdiv(A, raw(1.5)), fmul(BIG, BIG), fmul(-1, B)].map((v) => v / 65536);

program(() => {
  print("Own fixed: the payload runs.");
  // A: signs, rounding towards zero, wrapping, by 0.
  let a: Fixed = fixed(0) - 2.5, b: Fixed = fixed(0) + 0.75, big: Fixed = fixed(30000), zero: Fixed = fixed(0);
  if (a * b == EDGES[0] && a * 1.5 == EDGES[1] && a / b == EDGES[2] && b / a == EDGES[3] && 1 / b == EDGES[4] && a / 1.5 == EDGES[5]
    && big * big == EDGES[6] && (zero - 0.0000152587890625) * b == EDGES[7] && a / zero == 0 && 3 / zero == 0) print("A: fixed ok");
  else print("A: fixed WRONG");
  sleep(frames(2));
  let x: Fixed = fixed(-30), y: Fixed = fixed(7.25), sum: Fixed = fixed(0), j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += x * 1.5; j++; }
  if (sum == BY_CONST) print("B: 200 products by a constant ok"); else print("B: 200 products by a constant WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += x / 1.5; j++; }
  if (sum == OVER_CONST) print("C: 200 quotients by a constant ok"); else print("C: 200 quotients by a constant WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += 3 / x; j++; }
  if (sum == RECIPROCAL) print("D: 200 constants over a value ok"); else print("D: 200 constants over a value WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += x * y; j++; }
  if (sum == PRODUCTS) print("E: 200 products of two values ok"); else print("E: 200 products of two values WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += x / y; j++; }
  if (sum == QUOTIENTS) print("F: 200 quotients of two values ok"); else print("F: 200 quotients of two values WRONG");
  // G: fixed numbers printed — the places rounded half up, zeros at the end not shown, a minus sign only when what is
  // shown is not 0, and 0.99999 shown as 1.
  let tiny: Fixed = zero + 0.0000152587890625, almost: Fixed = zero + 0.99999, third: Fixed = fixed(1) / 3;
  print(`G: ${a} ${b} ${big} ${tiny} ${zero - tiny} ${almost} ${third} ${zero - third} ${a * 1000}`);
  print("Own fixed: done.");
});
