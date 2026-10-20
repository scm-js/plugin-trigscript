// TrigScript 4, the backend: texts printed with numbers in them, in a map of our own (scripts/build-own.mts). Each text
// is laid out when the map is built, a field of 12 bytes for each number padded with 0x0D — a carriage return, which
// StarCraft draws as nothing — and a routine shared by every print writes the number's digits into it. Built both ways (through eudplib,
// and as a map of our own), the lifted game should print the same lines at the same frames once the 0x0D are left out;
// in the game, both should look the same: no gaps, boxes or marks where the padding is. The values are variables, so
// nothing here is worked out when the map is built. (A byte from a value — a colour from JSX — is checked by the
// emitter's random programs, not here.)
//   npx tsx scripts/build-own.mts probes/own-print.ts /tmp/own-print.scx
//   npx tsx scripts/build-fixture.mts probes/own-print.ts /tmp/own-print-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  let zero = 0, seven = 7, n = 42, k = 1000, big = 65535, minus = -1, low = -2147483648, high = 2147483647;
  let apples = 12, score = 1234, full: u32 = 4294967295;
  print(`A: ${zero}, ${seven}, ${n}, ${k}, ${big}`);
  print(`B: ${minus}, ${low}, ${high}`);
  print(`C: ${full} as a u32, ${minus} as a number`);
  print(`${apples} apples come first in E`);
  print(`F: 점수 ${score}점`);
  sleep(frames(4));
  // G: a countdown, a line a frame.
  let left = 3;
  while (left > 0) { print(`G: ${left}...`); left--; sleep(frames(1)); }
  print("G: go");
  sleep(frames(4));
  // H: a hundred texts in one frame (the last ones stay on the screen).
  let i = 0;
  while (i < 100) { print(`H: line ${i} of ${100 - i} left`); i++; }
  print("Own print: done.");
});
