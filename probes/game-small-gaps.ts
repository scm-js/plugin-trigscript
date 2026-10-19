// TrigScript 4: the small gaps of the second sweep, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-small-gaps.ts
// Everything starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, random, P1 } from "trigscript";

type St = "idle" | "run" | "hide";
type Team = "red" | "blue";
type Ev = { kind: "hit"; n: number } | { kind: "heal"; h: number };
const NAMES: Record<St, string> = { idle: "Idle", run: "Run", hide: "Hide" };

class Foe { hp = random(5) + 10; constructor(public tag: number) {} hit() { this.hp--; } }
function spawn(tag: number) { return new Foe(tag); }
function evens(n: number) { const a: number[] = []; for (let i = 0; i < n; i++) a.push(i * 2); return a; }
function sum(...xs: number[]) { return xs.reduce((a, b) => a + b, 0); }
namespace Geo { export function scale(x: number) { return x * 3; } }

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: labelled break and continue. 23 300
  let found = -1;
  outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (i * j === g * 2) { found = i * 10 + j; break outer; } } }
  let s = 0;
  rows: for (let y = 0; y < g; y++) { let x = 0; while (x < 4) { x++; if (x === 2) continue rows; s += 100; } s += 1; }
  displayText(`A: ${found} ${s}`);
  sleep(frames(1));

  // B: a function that makes an instance with a field the game gives; rest parameters; an array given back; a namespace. 1 7 3 4 9
  const f = spawn(g);
  const xs = evens(g);
  displayText(`B: ${f.hp >= 10 && f.hp < 15 ? 1 : 0} ${sum(1, g, 3)} ${xs.length} ${xs[2]} ${Geo.scale(g)}`);
  sleep(frames(1));

  // C: find() of instances, a Map keyed by texts, a record read and written at a state. 3 2 -1 blue=4 run 5 Run hide 9
  const foes = [new Foe(1), new Foe(g), new Foe(5)];
  const t = foes.find((x) => x.tag === g);
  if (t) t.hit();
  const none = foes.find((x) => x.tag > 9);
  const pick: Team = g === 3 ? "blue" : "red";
  const score = new Map<Team, number>();
  score.set(pick, g);
  score.set(pick, (score.get(pick) ?? 0) + 1);
  let teams = "";
  for (const [k, v] of score) teams += `${k}=${v}`;
  let st: St = "idle";
  const step: Record<St, () => St> = { idle: () => (g === 3 ? "run" : "idle"), run: () => "hide", hide: () => "idle" };
  const cost: Record<St, number> = { idle: 1, run: 5, hide: 2 };
  st = step[st]();
  const first = `${st} ${cost[st]} ${NAMES[st]}`;
  st = step[st]();
  cost[st] += 7;
  displayText(`C: ${t ? t.tag : -1} ${t && foes[1].hp === t.hp ? 2 : 0} ${none?.tag ?? -1} ${teams} ${first} ${st} ${cost.hide}`);
  sleep(frames(1));

  // D: sort of texts, a boolean as text, an enum in the program, push of a ?: record. Zed,a3,b true false 6 hit3 heal4
  const words = ["b", `a${g}`, "Zed"];
  words.sort();
  enum Phase { Wait, Fight = 5, Done }
  let phase = Phase.Wait;
  if (g === 3) phase = Phase.Done;
  const q: Ev[] = [];
  q.push(g === 3 ? { kind: "hit", n: g } : { kind: "heal", h: 2 });
  q.push(g > 3 ? { kind: "hit", n: 9 } : { kind: "heal", h: 4 });
  let evs = "";
  for (const e of q) evs += e.kind === "hit" ? ` hit${e.n}` : ` heal${e.h}`;
  displayText(`D: ${words.join(",")} ${g === 3} ${g > 3} ${phase}${evs}`);
});

test("labelled break and continue", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 23 300");
});
test("functions: instances, rest, arrays, namespaces", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 1 7 3 4 9");
});
test("find, text keys, records at a state", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 3 2 -1 blue=4 run 5 Run hide 9");
});
test("texts sorted, booleans, enums, ?: records", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: Zed,a3,b true false 6 hit3 heal4");
});
