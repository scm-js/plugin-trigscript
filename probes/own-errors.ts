// TrigScript 4, the backend: errors in a map of our own (scripts/build-own.mts) — step 11 of the way off eudplib, part 1.
// A `throw` goes to the `catch` of the nearest `try` around it, out of the functions it is in: from a trigger of the
// function's own that each call points at where its error goes — nothing is looked at on the way back — or, for a
// function that calls itself, from its end, the call looking at the error once its frame is taken back. A stack that
// runs out throws a RangeError; an error nothing catches is said in red, and the program stops there.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same
// frames; every line should end "ok", and a line ending "WRONG" names the check that failed. The frames after "Weighed"
// are to weigh. The last line is red — "TrigScript: uncaught RangeError: the end, line 214." — and nothing comes after.
//   npx tsx scripts/build-own.mts probes/own-errors.ts /tmp/own-errors.scx
//   npx tsx scripts/build-fixture.mts probes/own-errors.ts /tmp/own-errors-eud.scx
import { program, print, sleep, frames } from "trigscript";

class OutOfGold extends Error {
  need: number;
  constructor(need: number) {
    super(`need ${need} more`);
    this.need = need;
  }
}

/** n + 1, or a RangeError past 2. */
function check(n: number): number {
  if (n > 2) throw new RangeError(`too big: ${n}`);
  return n + 1;
}
/** check's, doubled: an error goes on through it. */
function twice(n: number): number {
  return check(n) * 2;
}
/** check's, or -1: its own try keeps its errors. */
function safe(n: number): number {
  try {
    return check(n);
  } catch {
    return -1;
  }
}
function buy(gold: number, price: number): number {
  if (gold < price) throw new OutOfGold(price - gold);
  return gold - price;
}
/** Down to 0, then an error, up through every frame. */
function down(n: number): number {
  if (n == 0) throw new Error("bottom");
  return down(n - 1) + 1;
}
/** Each level keeps n and half around its call; the catch reads them once its frame is back. */
function halves(n: number): number {
  const half = n >> 1;
  try {
    if (n < 3) throw new Error("small");
    return halves(half) + n;
  } catch {
    return half * 100 + n;
  }
}
function forever(n: number): number {
  if (n > 1000000) return 0;
  return forever(n + 1) + 1;
}

program(() => {
  print("Own errors: the payload runs.");
  let k = 0;
  while (k < 2) k += 1;

  // A: a throw in the try goes to its catch; a try with no throw runs its body only.
  let a = 0;
  try {
    if (k > 1) throw new Error("too many");
    a = 5;
  } catch (e) {
    if (e instanceof Error && e.message == "too many") a = 7;
  }
  let quiet = 0;
  try {
    quiet = 1;
  } catch {
    quiet = 2;
  }
  if (a == 7 && quiet == 1) print("A: try and catch ok"); else print(`A: try and catch WRONG ${a} ${quiet}`);

  // B: classes told apart, a class's field read, a message made while the game runs.
  let said = "";
  for (let i = 0; i < 4; i++) {
    try {
      if (i == 0) buy(k * 10, 35);
      if (i == 1) throw new RangeError(`i is ${i}, k ${k}`);
      if (i == 2) throw new TypeError("type");
      said += "|through";
    } catch (e) {
      if (e instanceof OutOfGold) said += `|${e.need} ${e.message}`;
      else if (e instanceof RangeError) said += `|range ${e.message}`;
      else if (e instanceof Error) said += `|${e.name}`;
    }
  }
  if (said == "|15 need 15 more|range i is 1, k 2|TypeError|through") print("B: classes ok"); else print(`B: classes WRONG ${said}`);
  sleep(frames(2));

  // C: a caught error thrown again to the try further out; finally on each way out.
  let cleaned = 0, outer = "";
  try {
    try {
      if (k > 1) throw new Error("inner");
    } catch (e) {
      cleaned += 100;
      throw e;
    } finally {
      cleaned += 1;
    }
  } catch (e) {
    if (e instanceof Error) outer = e.message;
  }
  for (let i = 0; i < 4; i++) {
    try {
      if (i == 1) continue;
      if (i == 2) break;
    } finally {
      cleaned += 10;
    }
  }
  if (outer == "inner" && cleaned == 131) print("C: rethrow and finally ok"); else print(`C: rethrow and finally WRONG ${outer} ${cleaned}`);

  // D: out of called functions to the try around the call; a function's own try.
  let total = 0, n = 0, stopped = "";
  try {
    while (n < 5) {
      total += twice(n);
      n += 1;
    }
  } catch (e) {
    if (e instanceof Error) stopped = e.message;
  }
  try {
    total += check(k + 7);
  } catch {
    total += 1000;
  }
  if (total == 1012 && n == 3 && stopped == "too big: 3" && safe(1) == 2 && safe(k + 5) == -1) print("D: out of functions ok");
  else print(`D: out of functions WRONG ${total} ${n} ${stopped}`);
  sleep(frames(2));

  // E: up through a function that calls itself, its frames taken back on the way.
  let bottom = "";
  try {
    print(`E: WRONG, came back with ${down(k + 3)}`);
  } catch (e) {
    if (e instanceof Error) bottom = e.message;
  }
  const h = halves(k * 20);
  if (bottom == "bottom" && h == 177) print("E: through recursion ok"); else print(`E: through recursion WRONG ${bottom} ${h}`);

  // F: a stack that runs out throws a RangeError.
  let ran = "";
  try {
    ran = `${forever(k)}`;
  } catch (e) {
    if (e instanceof RangeError) ran = e.message;
  }
  if (ran == "Maximum call stack size exceeded") print("F: stack overflow caught ok"); else print(`F: stack overflow WRONG ${ran}`);
  sleep(frames(4));

  print("Weighed:");
  sleep(frames(2));
  // W1: 300 calls of a function that may throw and does not.
  let w = 0, i = 0, j = 0;
  while (i < 300) {
    w += check(j);
    j += 1;
    if (j > 1) j = 0;
    i += 1;
  }
  sleep(frames(4));
  // W2: 100 errors thrown in a called function, each caught in the loop.
  let caught = 0;
  i = 0;
  while (i < 100) {
    try {
      w += check(i + k);
    } catch {
      caught += 1;
    }
    i += 1;
  }
  sleep(frames(4));
  // W3: an error up through 40 frames, four times.
  i = 0;
  while (i < 4) {
    try {
      w += down(38 + k);
    } catch {
      caught += 1;
    }
    i += 1;
  }
  sleep(frames(4));
  // W4: 200 turns through a try with a finally, one in two left by continue.
  let f = 0;
  i = 0;
  while (i < 200) {
    i += 1;
    try {
      if ((i & 1) == 0) continue;
      w += 1;
    } finally {
      f += 1;
    }
  }
  sleep(frames(4));
  if (caught == 103 && f == 200 && w == 450 + 3 + 100) print("W: weighed ok"); else print(`W: weighed WRONG ${caught} ${f} ${w}`);
  sleep(frames(2));

  // Z: an error nothing catches, said in red where it was thrown; the program stops there.
  if (k > 1) throw new RangeError("the end");
  print("Z: WRONG, the program went on");
});
