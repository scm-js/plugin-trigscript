// TrigScript 4, the backend: bits and shifts in a map of our own (scripts/build-own.mts) — step 4 of the way off
// eudplib, part 2. `&` `|` with a constant are a masked write of a copy; `^` with a constant and the three of two values
// a trigger a bit; a shift left by a value doublings in a doubling trigger, a shift right Horner's way over the bits
// that stay. Built both ways, the lifted game should print the same lines at the same frames; every line should end
// "ok", and a line ending "WRONG" names the check that failed. Frames 2, 4 and 6 (the lifted game's 4, 6 and 8) are
// each one kind of work, 200 times, to weigh.
//   npx tsx scripts/build-own.mts probes/own-bits.ts /tmp/own-bits.scx
//   npx tsx scripts/build-fixture.mts probes/own-bits.ts /tmp/own-bits-eud.scx
import { program, print, sleep, frames } from "trigscript";

// What each check should give, worked out when the script is built (shifts by under 32, where TrigScript and JavaScript agree).
function masks(): number {
  let x = 7, sum = 0;
  for (let j = 0; j < 200; j++) { x = (x + 0x01234567) | 0; sum = (sum + (x & 0xff) + (x | 0x100) + (x ^ 0x5555)) | 0; }
  return sum;
}
function pairs(): number {
  let x = 7, y = 3, sum = 0;
  for (let j = 0; j < 200; j++) { x = (x + 0x01234567) | 0; y = (y + 0x00765433) | 0; sum = (sum + (x & y) + (x | y) + (x ^ y)) | 0; }
  return sum;
}
function shifts(): number {
  let x = 7, sum = 0;
  for (let j = 0; j < 200; j++) { x = (x + 0x01234567) | 0; const n = j % 32; sum = (sum + (1 << n) + (x >> n) + (x >>> n)) | 0; }
  return sum;
}
const MASKS = masks(), PAIRS = pairs(), SHIFTS = shifts();

program(() => {
  print("Own bits: the payload runs.");
  // A: with constants and of two values, below zero too; shifts by 0, by 31, by 32 and more (nothing, or the sign).
  let a = -6, b = 10, n0 = 0, n31 = 31, n32 = 32, n40 = 40;
  if ((a & 0xff) == 250 && (a | 1) == -5 && (a ^ 3) == -7 && (a & b) == 10 && (a | b) == -6 && (a ^ b) == -16
    && (b << n0) == 10 && (b << n31) == 0 && (1 << n31) == -2147483648 && (b << n32) == 0 && (a >> n31) == -1 && (a >> n40) == -1
    && (a >>> n31) == 1 && (a >>> n32) == 0 && (b >> n32) == 0 && (a >> (b - 8)) == -2 && (a >>> (b - 8)) == 1073741822) print("A: bits and shifts ok");
  else print("A: bits and shifts WRONG");
  sleep(frames(2));
  // Frame 2: 200 of each mask with a constant.
  let x = 7, j = 0, sum = 0;
  while (j < 200) { x += 0x01234567; sum += (x & 0xff) + (x | 0x100) + (x ^ 0x5555); j++; }
  if (sum == MASKS) print("B: 200 masks ok"); else print("B: 200 masks WRONG");
  sleep(frames(2));
  // Frame 4: 200 of each of two values.
  let y = 3;
  x = 7; j = 0; sum = 0;
  while (j < 200) { x += 0x01234567; y += 0x00765433; sum += (x & y) + (x | y) + (x ^ y); j++; }
  if (sum == PAIRS) print("C: 200 bits of two values ok"); else print("C: 200 bits of two values WRONG");
  sleep(frames(2));
  // Frame 6: 200 shifts by a value each way.
  x = 7; j = 0; sum = 0;
  while (j < 200) { x += 0x01234567; const n = j % 32; sum += (1 << n) + (x >> n) + (x >>> n); j++; }
  if (sum == SHIFTS) print("D: 200 shifts by a value ok"); else print("D: 200 shifts by a value WRONG");
  print("Own bits: done.");
});
