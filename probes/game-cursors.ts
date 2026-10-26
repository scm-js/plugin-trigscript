// TrigScript 4, the backend's second part (record loops): reads and writes at a loop's counter through registers moved on
// at the update. Every shape the lowering takes that way — a loop over records, other lists read and written at its
// counter (as long, and shorter: then the checked way), fixed arrays with the bound proved and not, steps of 2 and -1,
// continue and break, a loop inside reading at the outer counter — in the lifted game and the simulator. Every expected
// line is worked out in plain JavaScript (a read past an array's end guarded: the simulator calls it a fault).
//   npx tsx scripts/test-game.mts probes/game-cursors.ts
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

class Shot { constructor(public x: number, public y: number, public dx: number, public life: number) {} }

program(() => {
  setResources(P1, "set", 1, "gas");
  sleep(frames(2));
  const one = gas(P1); // 1, read in the game

  // A: records, moved and aged twice; one bounces.
  const shots: Shot[] = [];
  for (let i = 0; i < 6; i++) shots.push(new Shot(one * i * 100, one * i * 7, one * (i + 1) * 3, one * (i * 2 + 1)));
  for (let turn = 0; turn < 2; turn++) {
    for (const s of shots) {
      s.x += s.dx;
      if (s.x >= 310) s.dx = -s.dx;
      if (s.life > 0) s.life--;
      s.y = s.y + s.x % 5;
    }
  }
  let a = "";
  for (const s of shots) a += `${s.x},${s.y},${s.dx},${s.life} `;
  displayText(`A: ${a}`);
  sleep(frames(1));

  // B: a list read and written at the counter of a loop over another, longer and shorter; the shorter one is read as 0
  // and written as a push past its end.
  const own: number[] = [];
  const longer: number[] = [];
  const shorter: number[] = [];
  for (let i = 0; i < 5; i++) { own.push(one * (i + 1)); longer.push(one * 10 * i); }
  for (let i = 0; i < 3; i++) shorter.push(one * (i + 7));
  for (let i = 0; i < own.length; i++) {
    longer[i] = longer[i] + own[i];
    own[i] = own[i] * 2 + (i < shorter.length ? shorter[i] : 0);
  }
  let b = `${own.join(",")} ${longer.join(",")} ${shorter.join(",")}`;
  for (let i = 0; i < own.length; i++) shorter[i] = own[i] + 1;
  b += ` ${shorter.join(",")}`;
  displayText(`B: ${b}`);
  sleep(frames(1));

  // C: fixed arrays: bounds proved by the loop (no check), and an index that can run past the end (checked).
  const cells = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) cells[i] = one * i * i;
  let c = 0;
  for (let i = 0; i < 8; i++) c += cells[i];
  const n = one * 11;
  let past = 0;
  for (let i = 0; i < n; i++) { if (i < 8) { past += cells[i]; cells[i] = cells[i] + 1; } }
  displayText(`C: ${c} ${past} ${cells.join(",")}`);
  sleep(frames(1));

  // D: steps of 2 and -1, continue and break, and a loop inside reading at the outer counter.
  const vals = [one * 5, one * 6, one * 7, one * 8, one * 9, one * 10, one * 11, one * 12];
  let d1 = 0, d2 = 0, d3 = 0;
  for (let i = 0; i < 8; i += 2) d1 += vals[i];
  for (let i = 7; i >= 0; i--) { if (vals[i] % 3 == 0) continue; if (vals[i] < 6) break; d2 += vals[i]; }
  for (let i = 0; i < 4; i++) { for (let j = 0; j < 3; j++) d3 += vals[i] * (j + 1) + vals[j + 4]; }
  displayText(`D: ${d1} ${d2} ${d3}`);
});

test("records moved and aged", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 6,4,3,0 112,10,6,1 218,21,9,3 300,23,-12,5 400,28,15,7 500,38,18,9 ");
});
test("other lists at the counter, longer and shorter", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 9,12,15,8,10 1,12,23,34,45 7,8,9 10,13,16,9,11");
});
test("fixed arrays, the bound proved and not", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 140 140 1,2,5,10,17,26,37,50");
});
test("steps, continue and break, a loop inside", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 32 36 276");
});
