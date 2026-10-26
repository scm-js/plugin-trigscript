// TrigScript 4, the backend: square roots, sines, cosines and arc tangents in a map of our own (scripts/build-fixture.mts)
// — step 4 of the way off eudplib, part 5. Built both ways (through eudplib, and as a map of our own), the lifted game
// should print the same lines at the same frames; every line should end "ok", and a line ending "WRONG" names the check
// that failed. Frames 2 to 10 (the lifted game's 4 to 12) are each one kind of work, 200 times, to weigh.
// (`Math.sqrt(n)` of a whole number gives a fixed number: the root of n as it is, not of n / 65 536.)
//   npx tsx scripts/build-fixture.mts probes/own-math.ts /tmp/own-math.scx
//   npx tsx scripts/build-fixture.mts probes/own-math.ts /tmp/own-math-eud.scx
import { program, print, sleep, frames, fixed, type fixed as Fixed } from "trigscript";

// The game's arithmetic on raw cells (compiler/fixedMath.ts, written out here), to work out when the script is built
// what each frame's sum should be. The tables are the ones the compiler gives a program (compiler/numbers.ts).
const raw = (v: number) => Math.round(v * 65536) | 0;
const SIN = Array.from({ length: 4096 }, (_, i) => raw(Math.sin((2 * Math.PI * i) / 4096)));
const ATAN = Array.from({ length: 1025 }, (_, i) => raw(Math.atan(i / 1024)));
const SCALE = raw(4096 / (2 * Math.PI)), PI = raw(Math.PI), HALF_PI = raw(Math.PI / 2);
const U32 = 0x1_0000_0000n;
const mag = (v: number) => BigInt(v < 0 ? -v : v);
const cell = (m: bigint, neg: boolean) => Number(BigInt.asIntN(32, (neg ? U32 - (m % U32) : m) % U32));
const fmul = (a: number, b: number) => cell((mag(a) * mag(b)) >> 16n, (a < 0) !== (b < 0));
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
const sqrt = (v: number) => (v <= 0 ? 0 : Number(isqrt(BigInt(v) << 16n)));
const sqrtWhole = (v: number) => (v >>> 0 >= 2 ** 30 ? 0x7fffffff : Number(isqrt(BigInt(v >>> 0) << 32n)));
function between(a: number, b: number, f: number, bits: number): number {
  const d = b - a, part = Math.floor((Math.abs(d) * f) / 2 ** bits);
  return (d < 0 ? a - part : a + part) | 0;
}
function sin(x: number, cos = false): number {
  const at = fmul(x, SCALE), i = ((at >>> 16) + (cos ? 1024 : 0)) & 4095;
  return between(SIN[i], SIN[(i + 1) & 4095], at & 0xffff, 16);
}
function atan2(y: number, x: number): number {
  const ax = mag(x), ay = mag(y);
  if (ax === 0n && ay === 0n) return 0;
  const read = (small: bigint, large: bigint) => { const r = Number((small << 16n) / large); return between(ATAN[r >> 6] ?? 0, ATAN[(r >> 6) + 1] ?? 0, r & 63, 6); };
  let t = ay <= ax ? read(ay, ax) : HALF_PI - read(ax, ay);
  if (x < 0) t = PI - t;
  if (y < 0) t = -t;
  return t | 0;
}
/** Each turn's x (and y), as the program steps them, and the sum of `f` over the 200 turns, as a fixed number. */
function sumOf(f: (x: number, y: number) => number): number {
  let x = raw(-30), y = raw(7.25), s = 0;
  for (let j = 0; j < 200; j++) { x = (x + raw(0.371)) | 0; y = (y - raw(0.0625)) | 0; s = (s + f(x, y)) | 0; }
  return s / 65536;
}
function wholeRoots(): number {
  let n = 3, s = 0;
  for (let j = 0; j < 200; j++) { n = (n + 9973) | 0; s = (s + sqrtWhole(n)) | 0; }
  return s / 65536;
}
const ROOTS = sumOf((x) => sqrt(x)), WHOLE = wholeRoots();
const SINES = sumOf((x) => sin(x)), COSINES = sumOf((x) => sin(x, true)), ANGLES = sumOf((x, y) => atan2(y, x));
// A: the edges — roots of 0, of below zero, of the largest; angles on the axes and of (0, 0); sines at a whole turn.
const EDGES = [sqrt(raw(2)), sqrt(0x7fffffff), sqrtWhole(2 ** 30 - 1), sqrtWhole(1), atan2(raw(-1), raw(-1)), atan2(0, raw(-3)), atan2(raw(5), 0), sin(fmul(raw(2), raw(3.14159265358979))), sin(raw(-1), true)].map((v) => v / 65536);

program(() => {
  print("Own math: the payload runs.");
  let two: Fixed = fixed(2), most: Fixed = fixed(32767) + 0.99998474121, minus: Fixed = fixed(0) - 3, zero: Fixed = fixed(0), one: Fixed = fixed(1);
  let w = 1073741823, w1 = 1, w0 = 0, wbig = -1;
  if (Math.sqrt(two) == EDGES[0] && Math.sqrt(most) == EDGES[1] && Math.sqrt(w) == EDGES[2] && Math.sqrt(w1) == EDGES[3] && Math.sqrt(minus) == 0
    && Math.sqrt(zero) == 0 && Math.sqrt(w0) == 0 && Math.sqrt(wbig) == 32767.99998474121 && Math.atan2(zero - one, zero - one) == EDGES[4]
    && Math.atan2(zero, minus) == EDGES[5] && Math.atan2(one * 5, zero) == EDGES[6] && Math.atan2(zero, zero) == 0
    && Math.sin(two * 3.14159265358979) == EDGES[7] && Math.cos(zero - one) == EDGES[8]) print("A: edges ok");
  else print("A: edges WRONG");
  sleep(frames(2));
  let x: Fixed = fixed(-30), y: Fixed = fixed(7.25), sum: Fixed = fixed(0), j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += Math.sqrt(x); j++; }
  if (sum == ROOTS) print("B: 200 square roots ok"); else print("B: 200 square roots WRONG");
  sleep(frames(2));
  let n = 3;
  sum = fixed(0); j = 0;
  while (j < 200) { n += 9973; sum += Math.sqrt(n); j++; }
  if (sum == WHOLE) print("C: 200 square roots of whole numbers ok"); else print("C: 200 square roots of whole numbers WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += Math.sin(x); j++; }
  if (sum == SINES) print("D: 200 sines ok"); else print("D: 200 sines WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += Math.cos(x); j++; }
  if (sum == COSINES) print("E: 200 cosines ok"); else print("E: 200 cosines WRONG");
  sleep(frames(2));
  x = fixed(-30); y = fixed(7.25); sum = fixed(0); j = 0;
  while (j < 200) { x += 0.371; y -= 0.0625; sum += Math.atan2(y, x); j++; }
  if (sum == ANGLES) print("F: 200 arc tangents ok"); else print("F: 200 arc tangents WRONG");
  print("Own math: done.");
});
