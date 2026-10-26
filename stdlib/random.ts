/**
 * Chance: the standard library's "trigscript/random" (TrigScript 4).
 *
 *   import { chance, range, pick, shuffle, weighted, Random } from "trigscript/random";
 *
 *   if (chance(25)) dropLoot();                       // one time in four
 *   const lane = range(1, 3);                         // 1, 2 or 3
 *   const boss = pick(BOSSES);                        // any one of a list
 *   shuffle(order);                                   // an array of the program, in place
 *   const tier = weighted([70, 25, 5]);               // 0 most of the time, 2 rarely
 *
 *   const rng = new Random(seed);                     // the same numbers every time for the same seed
 *   const x = rng.range(0, 63);
 *
 * The functions use the game's own random numbers, which every player's game draws alike, so nothing goes out of step
 * in a game of several players. `Random` is a generator of your own (xorshift), seeded: the same seed gives the same
 * numbers, game after game — a level made from a seed, a save code that holds one.
 */
import { random } from "trigscript";

/** True `percent` times in a hundred (25: one time in four). */
export function chance(percent: number): boolean {
  return random(100) < percent;
}

/** A whole number from `min` to `max`, both included. */
export function range(min: number, max: number): number {
  return min + random(max - min + 1);
}

/** The total of `count` dice of `sides` sides each (3, 6: from 3 to 18). */
export function dice(count: number, sides: number): number {
  let total = 0;
  let i = 0;
  while (i < count) { total += 1 + random(sides); i++; }
  return total;
}

/** One of a list, any one alike; a list the script has, or an array of the program (the first's 0 when it is empty). */
export function pick<T>(items: readonly T[]): T {
  return items[random(items.length)];
}

/** The place of one of the weights, each as likely as its share of their total: [70, 25, 5] gives 0 most of the time. */
export function weighted(weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let roll = random(total);
  let i = 0;
  while (i < weights.length) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
    i++;
  }
  return weights.length - 1;
}

/** An array of the program in a random order, in place (Fisher–Yates: every order alike). */
export function shuffle<T>(items: T[]) {
  let i = items.length - 1;
  while (i > 0) {
    const j = random(i + 1);
    const held = items[i];
    items[i] = items[j];
    items[j] = held;
    i--;
  }
}

/**
 * A generator of random numbers of your own, seeded: the same seed gives the same numbers, in the game and when the
 * script is tested. Make it in the program (`const rng = new Random(1234)`).
 */
export class Random {
  state: number;

  /** Seeded with any whole number (0 is taken as 1). */
  constructor(seed: number) {
    this.state = seed === 0 ? 1 : seed;
  }

  /** The next number, from 0 to 2 147 483 647. */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return x & 0x7fffffff;
  }

  /** A whole number from 0 to n − 1. */
  int(n: number): number {
    return this.next() % n;
  }

  /** A whole number from `min` to `max`, both included. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** True `percent` times in a hundred. */
  chance(percent: number): boolean {
    return this.int(100) < percent;
  }

  /** One of a list, any one alike. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** An array of the program in a random order, in place. */
  shuffle<T>(items: T[]) {
    let i = items.length - 1;
    while (i > 0) {
      const j = this.int(i + 1);
      const held = items[i];
      items[i] = items[j];
      items[j] = held;
      i--;
    }
  }
}
