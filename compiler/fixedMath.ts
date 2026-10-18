/**
 * Fixed-point arithmetic (16.16) as the game computes it (`python/trigscript.py`'s `f_fixmul` and the rest), for the
 * simulator: every function gives the very bits the built map does. A value here is a raw cell — the number times
 * 65 536 — read signed. A product and a quotient go through the magnitudes, rounded down, and take the sign after,
 * which is rounding towards zero; both wrap at 32 bits.
 */

const U32 = 0x1_0000_0000n;

/** A cell's distance from 0, from 0 up (−2³¹'s is 2³¹). */
const magnitude = (v: number): bigint => BigInt(v < 0 ? -v : v);
/** A magnitude taken back to a signed cell, negated when the signs differed, wrapping at 32 bits. */
const signedCell = (m: bigint, negative: boolean): number => Number(BigInt.asIntN(32, (negative ? U32 - (m % U32) : m) % U32));

/** a × b / 65 536, towards zero. */
export function fixedMul(a: number, b: number): number {
  return signedCell((magnitude(a) * magnitude(b)) >> 16n, (a < 0) !== (b < 0));
}

/** a × 65 536 / b, towards zero; a divisor of 0 gives 0. */
export function fixedDiv(a: number, b: number): number {
  if (b === 0) return 0;
  return signedCell((magnitude(a) << 16n) / magnitude(b), (a < 0) !== (b < 0));
}

/** The largest r with r² ≤ n. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/**
 * The square root of a fixed number, rounded down; 0 below zero. `whole`: of a whole number read from 0 up, the root
 * still a fixed one — from 2³⁰ up past what a fixed number holds, which gives the largest.
 */
export function fixedSqrt(v: number, whole = false): number {
  if (whole) return v >>> 0 >= 2 ** 30 ? 0x7fffffff : signedCell(isqrt(BigInt(v >>> 0) << 32n), false);
  if (v <= 0) return 0;
  return signedCell(isqrt(BigInt(v) << 16n), false);
}

/** π and π/2 as fixed numbers. */
export const FIXED_PI = Math.round(Math.PI * 65536);
export const FIXED_HALF_PI = Math.round((Math.PI / 2) * 65536);

/** a + (b − a) × f / 2^bits, the part of the step towards zero: a table read between its cells. */
function between(a: number, b: number, f: number, bits: number): number {
  const d = b - a;
  const part = Math.floor((Math.abs(d) * f) / 2 ** bits);
  return (d < 0 ? a - part : a + part) | 0;
}

/**
 * atan2(y, x) of fixed numbers, a fixed number of radians from −π to π, read from `table` (atan(i / 1 024), 1 025
 * cells): the smaller side over the larger, a fixed number from 0 to 1, read between the table's cells (ten bits of it
 * the cell, six the way to the next), then put in its octant.
 */
export function fixedAtan2(y: number, x: number, table: readonly number[]): number {
  const ax = magnitude(x), ay = magnitude(y);
  if (ax === 0n && ay === 0n) return 0;
  const read = (small: bigint, large: bigint) => {
    const r = Number((small << 16n) / large);
    return between(table[r >> 6] ?? 0, table[(r >> 6) + 1] ?? 0, r & 63, 6);
  };
  let t = ay <= ax ? read(ay, ax) : FIXED_HALF_PI - read(ax, ay);
  if (x < 0) t = FIXED_PI - t;
  if (y < 0) t = -t;
  return t | 0;
}

/**
 * sin(x) of a fixed number of radians, from `table` (sin(2π i / 4 096), 4 096 cells): x times `scale` (4 096 / 2π)
 * is the place, sixteen bits of it the way to the next cell. `cos`: a quarter turn on.
 */
export function fixedSin(x: number, scale: number, table: readonly number[], cos = false): number {
  const at = fixedMul(x, scale);
  const i = ((at >>> 16) + (cos ? 1024 : 0)) & 4095;
  return between(table[i] ?? 0, table[(i + 1) & 4095] ?? 0, at & 0xffff, 16);
}

/** A fixed number as a decimal, as a program prints it: up to four places, rounded, without trailing zeros. */
export function fixedText(v: number): string {
  const m = Math.abs(v);
  let whole = Math.floor(m / 65536);
  let places = Math.floor(((m % 65536) * 10000 + 32768) / 65536);
  if (places === 10000) { whole++; places = 0; }
  const sign = v < 0 && (whole || places) ? "-" : "";
  return sign + String(whole) + (places ? "." + String(places).padStart(4, "0").replace(/0+$/, "") : "");
}
