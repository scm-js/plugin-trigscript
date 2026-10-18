/**
 * Time in a program: the standard library's "trigscript/timers" (TrigScript 4).
 *
 *   import { every, after, Cooldown, Countdown, SECOND } from "trigscript/timers";
 *
 *   program(async () => {
 *     const spawner = every(10 * SECOND, (n) => spawnWave(n));   // every ten seconds, the wave's number handed over
 *     after(3 * SECOND, () => print("Go!"));
 *     const shot = new Cooldown(12);
 *     while (true) {
 *       if (keyPressed(P1, "Space") && shot.use()) fire();
 *       if (boss.hp <= 0) spawner.cancel();
 *       await nextFrame();
 *     }
 *   });
 *
 * Time is counted in frames of the game, 24 a second on Fastest (`SECOND`). `every` and `after` run their function in a
 * task beside the program, so the program goes on at once; the Task they give back stops it (`cancel()`) and says
 * whether it still runs (`running`). Their function is kept for the task, with what it uses of the block it was written
 * in — written in a loop, each turn's is its own, as JavaScript has it — and it runs to its end within the frame (it
 * does not wait). Sixteen of one `every` or `after` written once can run at a time. `Cooldown`, `Countdown` and
 * `Stopwatch` read the game's frame counter: no task, nothing to stop.
 */
import { game, start, sleep, frames, memory, type Task } from "trigscript";

/** Frames a second of game time on Fastest, the speed a map is played at. */
export const SECOND = 24;

/** The frames of game time since the game began. */
export function now(): number {
  return memory.game.frame;
}

const repeating = game(async (period: number, fn: (count: number) => void, times: number) => {
  let count = 0;
  while (times <= 0 || count < times) {
    await sleep(frames(period < 1 ? 1 : period));
    count++;
    fn(count);
  }
});

const later = game(async (delay: number, fn: () => void) => {
  await sleep(frames(delay < 1 ? 1 : delay));
  fn();
});

/**
 * Run `fn` every `period` frames, from `period` frames from now: forever, or `times` times. It is handed how many times
 * it has run, 1 the first time.
 * @param period Frames between one run and the next (24 a second).
 * @param fn What to run; it runs to its end within the frame.
 * @param times How many times, or 0 (the default) for as long as the game lasts.
 * @returns The task: `cancel()` stops it.
 */
export const every = game((period: number, fn: (count: number) => void, times: number = 0): Task => start(repeating(period, fn, times)));

/**
 * Run `fn` once, `delay` frames from now.
 * @param delay Frames from now (24 a second).
 * @param fn What to run; it runs to its end within the frame.
 * @returns The task: `cancel()` before then and it never runs.
 */
export const after = game((delay: number, fn: () => void): Task => start(later(delay, fn)));

/**
 * Something that can be done once every so many frames: a weapon's reload, a spell's cooldown.
 *
 *   const blink = new Cooldown(5 * SECOND);
 *   if (keyPressed(P1, "B") && blink.use()) teleport();
 */
export class Cooldown {
  period: number;
  until = 0;

  /** Ready at once, then once every `period` frames. */
  constructor(period: number) {
    this.period = period;
  }

  /** Whether it is ready now. */
  ready(): boolean {
    return now() >= this.until;
  }

  /** If it is ready, use it — it is ready again `period` frames from now — and say true; else false. */
  use(): boolean {
    if (now() < this.until) return false;
    this.until = now() + this.period;
    return true;
  }

  /** Frames until it is ready again: 0 when it is. */
  left(): number {
    return this.until > now() ? this.until - now() : 0;
  }

  /** Ready again at once. */
  reset() {
    this.until = 0;
  }
}

/**
 * A length of time that runs down while the game runs: a round's clock, a bomb's fuse.
 *
 *   const round = new Countdown(90 * SECOND);
 *   ui.lines(P1, () => <line>{clock(round.left())}</line>);
 *   await until(() => round.done());
 */
export class Countdown {
  end = 0;

  /** Running, done `length` frames from now (0: done already). */
  constructor(length: number = 0) {
    this.end = now() + length;
  }

  /** Start again, done `length` frames from now. */
  restart(length: number) {
    this.end = now() + length;
  }

  /** Frames left: 0 once it is done. */
  left(): number {
    return this.end > now() ? this.end - now() : 0;
  }

  /** Whether it has run out. */
  done(): boolean {
    return now() >= this.end;
  }

  /** More time, or less (a number below zero). */
  add(frames: number) {
    this.end += frames;
  }
}

/** How long since it was made, or last reset: a lap's time, a survival score. */
export class Stopwatch {
  from = 0;

  constructor() {
    this.from = now();
  }

  /** Frames since it started. */
  elapsed(): number {
    return now() - this.from;
  }

  /** From 0 again. */
  reset() {
    this.from = now();
  }
}
