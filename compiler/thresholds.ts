/**
 * A division whose result is small, worked out as comparisons (TrigScript 4, after the cost slices).
 *
 * `Math.min(H, Math.floor(C / x))` — the raycaster's wall height, a bar's length from a distance — divides by a variable,
 * which the game does a bit at a time: about 7 µs of Remastered's time for a fixed number, where a comparison of a
 * variable with a constant is about 0.13. For `x` above zero the quotient only falls as `x` grows, and `min` caps it at
 * `H`, so the result is the largest `h` of 0 … H with `x ≤ T(h)`, `T(h)` the largest `x` whose quotient is still `h` or
 * more: a tree of comparisons with constants worked out when the script is built, as deep as H has bits.
 *
 * The thresholds are found with the very arithmetic the game does (`fixedMath.ts`, which the simulator shares), and
 * checked at both sides of each, so the result is the same bits as the division's for every `x`. Where that cannot
 * hold — `x` at or below zero, or so close to it that `C × 65 536 / x` passes what 32 bits hold and wraps — the
 * original division is kept, behind one comparison.
 */
import { fixedDiv } from "./fixedMath";
import type { At, NumExpr } from "./ir";

/** The most a capped result may be: a tree of 2·H comparisons in the map, 8 deep. */
export const THRESHOLDS_MOST = 256;

const I32_MAX = 0x7fffffff;
/** The `min`s kept inside a tree, behind its comparison: never made into a tree again, if a pass meets them twice. */
const kept = new WeakSet<NumExpr>();

/** The quotient's shape, and how to work it out for one `x` above `from` (where nothing wraps). */
interface Quotient { x: string; from: number; at: (x: number) => number }

/**
 * Of `q`, the shapes taken: `fdiv(C, x) >> 16` (Math.floor of a fixed quotient), `(fdiv(C, x) + c) >> 16` (Math.round,
 * Math.ceil), and a whole `C / x`; `C` a constant above zero, `x` a variable.
 */
function quotientOf(q: NumExpr): Quotient | null {
  if (q.kind === "binary" && q.op === "/" && !q.unsigned && q.left.kind === "const" && q.left.value > 0 && q.right.kind === "var") {
    const c = q.left.value;
    return { x: q.right.id, from: 1, at: (x) => Math.trunc(c / x) };
  }
  if (q.kind !== "binary" || q.op !== ">>" || q.right.kind !== "const" || q.right.value !== 16) return null;
  let inner = q.left, add = 0;
  if (inner.kind === "binary" && inner.op === "+" && inner.right.kind === "const" && inner.right.value >= 0 && inner.right.value < 0x10000) {
    add = inner.right.value;
    inner = inner.left;
  }
  if (inner.kind !== "intrinsic" || inner.name !== "fdiv") return null;
  const [n, d] = inner.args;
  if (n.kind !== "const" || n.value <= 0 || d.kind !== "var") return null;
  const c = BigInt(n.value) << 16n;
  // The smallest x whose quotient plus `add` stays below 2³¹: below it the game's quotient wraps.
  const from = Number(c / BigInt(I32_MAX + 1 - add)) + 1;
  return { x: d.id, from, at: (x) => (fixedDiv(n.value, x) + add) >> 16 };
}

/** The largest x ≥ from with g(x) ≥ h (g falls as x grows), or from − 1 when none is. */
function threshold(g: (x: number) => number, from: number, h: number): number {
  if (g(from) < h) return from - 1;
  let lo = from, hi = I32_MAX;
  if (g(hi) >= h) return hi;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (g(mid) >= h) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * `min` of a constant and a quotient as comparisons, or null when it is not of that shape. `e` is the `min` as the
 * final pass of `numbers.ts` left it: whole numbers, signed.
 */
export function divisionByThresholds(e: Extract<NumExpr, { kind: "intrinsic" }>): NumExpr | null {
  if (e.name !== "min" || e.args.length !== 2 || e.unsigned || kept.has(e)) return null;
  const [a, b] = e.args;
  const [cap, q] = a.kind === "const" ? [a, b] : b.kind === "const" ? [b, a] : [null, null];
  if (!cap || cap.kind !== "const" || cap.fixed || cap.value < 1 || cap.value > THRESHOLDS_MOST) return null;
  const quotient = quotientOf(q!);
  if (!quotient) return null;
  const { x, from, at: g } = quotient;
  const top = cap.value;
  const t: number[] = [Infinity];
  for (let h = 1; h <= top; h++) t.push(threshold(g, from, h));
  // The thresholds as the game's arithmetic has them on both sides: what the tree answers is the division's.
  for (let h = 1; h <= top; h++) {
    if (t[h] >= from && g(t[h]) < h) return null;
    if (t[h] < I32_MAX && t[h] + 1 >= from && g(t[h] + 1) >= h) return null;
    if (t[h] > t[h - 1]) return null;
  }
  const where: { at: At; label: string } = { at: e.at, label: e.label };
  const v: NumExpr = { kind: "var", id: x };
  const k = (value: number): NumExpr => ({ kind: "const", value });
  // The result lies in lo … hi: is it at least mid, the middle?
  const tree = (lo: number, hi: number): NumExpr => {
    if (lo === hi) return k(lo);
    const mid = Math.ceil((lo + hi) / 2);
    if (t[mid] < from) return tree(lo, mid - 1);
    // (Past the first comparison x is above zero, so these read it from 0 up: one condition each, where signed is a few.)
    return { kind: "ternary", cond: { kind: "compare", op: "<=", left: v, right: k(t[mid]), unsigned: true, ...where }, whenTrue: tree(mid, hi), whenFalse: tree(lo, mid - 1), ...where };
  };
  kept.add(e);
  return { kind: "ternary", cond: { kind: "compare", op: "<", left: v, right: k(from), ...where }, whenTrue: e, whenFalse: tree(0, top), ...where };
}
