// TrigScript 4: text and array methods, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-text-arrays.ts
// Every text and array starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: trim, replace, replaceAll, case, lastIndexOf. [x3] a+b-c-3 abc3 HI 3|hi 3 4
  const s = `a-b-c-${g}`;
  const padded = `  x${g}  `;
  displayText(`A: [${padded.trim()}] ${s.replace("-", "+")} ${s.replaceAll("-", "")} ${`Hi ${g}`.toUpperCase()}|${`Hi ${g}`.toLowerCase()} ${s.lastIndexOf("c") + 1}`);
  sleep(frames(1));

  // B: split, taken apart, parseInt and isNaN. 4 [bb] 30 61 nan
  const line = ` -give ${g * 10} 30 `;
  const [cmd, who, amount] = line.trim().split(" ");
  const parts = `a,bb,,c${g}`.split(",");
  displayText(`B: ${parts.length} [${parts[1]}] ${cmd == "-give" ? parseInt(who) : 0} ${Number(amount) * 2 + 1} ${isNaN(parseInt(`x${g}`)) ? "nan" : "number"}`);
  sleep(frames(1));

  // C: numbers: unshift, shift, splice, at, lastIndexOf, join. 3 8-70-71-72 72 2
  const xs = [1, 2];
  xs.unshift(g, 8);
  const first = xs.shift() ?? -1;
  xs.splice(1, 1, 70, 71, 72);
  xs.splice(-1);
  displayText(`C: ${first} ${xs.join("-")} ${xs.at(-1)} ${xs.lastIndexOf(71)}`);
  sleep(frames(1));

  // D: texts and records: shift, unshift, splice. z a3,B1,B2,c 0z 9y3 3c
  const names: string[] = [];
  names.push(`a${g}`);
  names.push("b");
  names.push("c");
  names.unshift("z");
  const f = names.shift() ?? "";
  names.splice(1, 1, "B1", "B2");
  const ws: { n: number; s: string }[] = [];
  ws.push({ n: 1, s: "a" });
  ws.push({ n: 2, s: `b${g}` });
  ws.push({ n: 3, s: "c" });
  ws.shift();
  ws.unshift({ n: 0, s: "z" });
  ws.splice(1, 1, { n: 9, s: `y${g}` });
  let rows = "";
  for (const w of ws) rows += ` ${w.n}${w.s}`;
  displayText(`D: ${f} ${names.join(",")}${rows}`);
});

test("text methods", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: [x3] a+b-c-3 abc3 HI 3|hi 3 5");
});
test("split and parseInt", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 4 [bb] 30 61 nan");
});
test("array of numbers", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 3 8-70-71-72 72 2");
});
test("arrays of texts and records", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: z a3,B1,B2,c 0z 9y3 3c");
});
