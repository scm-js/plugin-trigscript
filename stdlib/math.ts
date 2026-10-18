/**
 * Numbers for motion and play: the standard library's "trigscript/math" (TrigScript 4).
 *
 *   import { Vec, lerp, easeOutQuad, distance, angleTo, approach, wrap } from "trigscript/math";
 *
 *   const t = fixed(frame) / 48;                          // 0 to 1 over two seconds
 *   const x = lerp(fromX, toX, easeOutQuad(t));           // eased from one place to another
 *   const v = Vec.fromAngle(angleTo(x, y, tx, ty), fixed(4));
 *   pos = pos.add(v);
 *
 * Fractions are the language's fixed numbers (16.16: four decimal places or so, from about −32 768 to 32 767): a
 * number becomes one when a fraction is stored into it, or written `fixed(…)`. Angles are radians, as JavaScript's are.
 * Whole numbers stay whole where they can — `distanceSq`, `manhattan`, `wrap`, `sign` — and cost less.
 */

/** π, and a whole turn. */
export const PI = Math.PI;
export const TAU = Math.PI * 2;

/** From a to b by t: a at 0, b at 1, between them in between (t outside 0 … 1 goes past). */
export function lerp(a: fixed, b: fixed, t: fixed): fixed {
  return a + (b - a) * t;
}

/** Where v is from a to b, as lerp's t: 0 at a, 1 at b. */
export function inverseLerp(a: fixed, b: fixed, v: fixed): fixed {
  return b === a ? fixed(0) : (v - a) / (b - a);
}

/** v from the range a1 … b1 into a2 … b2. */
export function remap(v: fixed, a1: fixed, b1: fixed, a2: fixed, b2: fixed): fixed {
  return lerp(a2, b2, inverseLerp(a1, b1, v));
}

/** t kept inside 0 … 1. */
export function clamp01(t: fixed): fixed {
  return t < 0 ? fixed(0) : t > 1 ? fixed(1) : t;
}

/** From `current` towards `target` by at most `step`, never past it: a value that follows another at a speed. */
export function approach(current: number, target: number, step: number): number {
  if (current < target) return current + step > target ? target : current + step;
  return current - step < target ? target : current - step;
}

/** n into 0 … size − 1, going round: wrap(-1, 10) is 9, wrap(12, 10) is 2. */
export function wrap(n: number, size: number): number {
  return ((n % size) + size) % size;
}

/** −1, 0 or 1, by whether n is below, at or above zero. */
export function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/** The distance from one point to another, as the crow flies. */
export function distance(x1: number, y1: number, x2: number, y2: number): fixed {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** The distance squared: whole, and cheaper — compare it with a range squared. */
export function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
}

/** The distance along the axes, |dx| + |dy|: what the game's own "nearest" goes by. */
export function manhattan(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

/** The angle from one point to another, in radians from −π to π: 0 is to the right (east), π / 2 down (south, y grows down). */
export function angleTo(x1: number, y1: number, x2: number, y2: number): fixed {
  return Math.atan2(y2 - y1, x2 - x1);
}

/** Degrees as radians. */
export function radians(degrees: fixed): fixed {
  return (degrees * PI) / 180;
}

/** Radians as degrees. */
export function degrees(radians: fixed): fixed {
  return (radians * 180) / PI;
}

/* Easing: t from 0 to 1, how far along a motion is at that point of its time — slow then fast, fast then slow, … */

/** Slow at the start. */
export function easeInQuad(t: fixed): fixed {
  return t * t;
}

/** Slow at the end. */
export function easeOutQuad(t: fixed): fixed {
  return t * (2 - t);
}

/** Slow at both ends. */
export function easeInOutQuad(t: fixed): fixed {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/** Slower at the start than easeInQuad. */
export function easeInCubic(t: fixed): fixed {
  return t * t * t;
}

/** Slower at the end than easeOutQuad. */
export function easeOutCubic(t: fixed): fixed {
  const u = t - 1;
  return u * u * u + 1;
}

/** Goes a little past the end and comes back. */
export function easeOutBack(t: fixed): fixed {
  const u = t - 1;
  return 1 + 2.70158 * u * u * u + 1.70158 * u * u;
}

/** Slow at both ends, smoothly (Hermite: 3t² − 2t³). */
export function smoothstep(t: fixed): fixed {
  return t * t * (3 - 2 * t);
}

/**
 * A point, or a direction and a length: two fixed numbers. Each operation gives a new Vec.
 *
 *   let pos = new Vec(fixed(x), fixed(y));
 *   const toward = new Vec(fixed(tx), fixed(ty)).sub(pos).normalized().scale(fixed(3));
 *   pos = pos.add(toward);
 */
export class Vec {
  x: fixed;
  y: fixed;

  constructor(x: fixed, y: fixed) {
    this.x = x;
    this.y = y;
  }

  /** A direction `length` long at `angle` radians (0 to the right, π / 2 down). */
  static fromAngle(angle: fixed, length: fixed): Vec {
    return new Vec(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(o: Vec): Vec {
    return new Vec(this.x + o.x, this.y + o.y);
  }

  sub(o: Vec): Vec {
    return new Vec(this.x - o.x, this.y - o.y);
  }

  scale(k: fixed): Vec {
    return new Vec(this.x * k, this.y * k);
  }

  dot(o: Vec): fixed {
    return this.x * o.x + this.y * o.y;
  }

  /** How long it is. */
  length(): fixed {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  /** The same direction, 1 long (or none, for none). */
  normalized(): Vec {
    const l = this.length();
    const k: fixed = l === 0 ? fixed(0) : 1 / l;
    return new Vec(this.x * k, this.y * k);
  }

  /** Its angle, in radians from −π to π. */
  angle(): fixed {
    return Math.atan2(this.y, this.x);
  }

  /** Turned by `angle` radians (clockwise on the map, where y grows down). */
  rotate(angle: fixed): Vec {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vec(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  /** How far it is from another point. */
  distanceTo(o: Vec): fixed {
    return this.sub(o).length();
  }

  /** From this towards another by t (0 here, 1 there). */
  lerp(o: Vec, t: fixed): Vec {
    return new Vec(this.x + (o.x - this.x) * t, this.y + (o.y - this.y) * t);
  }
}
