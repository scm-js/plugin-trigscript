// TrigScript 3.9's probe (slice 8½), the last: what reaches the Python anew — a text handed to and given back by a
// function that is called, a text kept by a function that calls itself, a Map keyed by units — and, since they are
// here, an array of texts and a chain of methods. Play it alone (Use Map Settings): you are Player 1, Terran. "Home"
// is the ground next to your base. Every line says what it expects, so a wrong one shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  a function that takes and returns a text, called four times: one copy in the map      — expect [a:2] [[a:2]:3] [w2:0] 9
//   5 s  B  a function that calls itself and keeps a text of its own across the call              — expect 5>4>3>2>1>0 ||||| 3
//   8 s  C  400 such calls, five deep each, 20 a frame: NO "out of memory" in red may appear      — expect 400 4>3>2>1>0
//  14 s  D  an array of texts: pushed, written, popped, joined, searched                          — expect [red!][wave 3] 2 blue red!, wave 3 1 1 0
//  17 s  E  600 texts pushed and cut off, 100 a frame: NO "out of memory" in red may appear       — expect 600 3 line 599
//  22 s  F  methods in a chain, and a function that makes an instance                             — expect 63 126 10 7
//  25 s  G  three Marines appear at Home; a Map keyed by units counts hits on each; one is killed — expect 3 40 7 2, and ONE Marine dies
//  30 s  H  a new Marine, made where the dead one was: it is not the dead one's key               — expect 0 3
//  33 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/leftovers.ts fixtures/eud/leftovers.scx`.
import { trigger, program, always, displayText, createUnit, sleep, seconds, frames, unitsAt, first, units, P1, type Location, type Unit } from "trigscript";

// The map's names are not known to this script: a location is its number (build-fixture makes 1 and 2).
const HOME = 1 as Location;

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  function tag(s: string, n: number): string { return `[${s}:${n}]`; }
  function path(n: number): string { const here = `${n}`; if (n <= 0) return here; const rest = path(n - 1); return `${here}>${rest}`; }
  function bars(n: number, s: string): string { if (n <= 0) return s; return bars(n - 1, s + "|"); }
  function kept(n: number): number { let label = `c${n}`; if (n > 0) kept(n - 1); return label.length; }
  class Vec {
    constructor(public x: number, public y: number) {}
    add(o: Vec) { this.x += o.x; this.y += o.y; return this; }
    scale(k: number) { this.x *= k; this.y *= k; return this; }
  }
  function make(n: number) { return new Vec(n, n * 2); }

  sleep(seconds(2));
  let k = 2;
  const a = tag("a", k);
  const b = tag(a, k + 1);
  const c = tag(`w${k}`, 0);
  displayText(`A: ${a} ${b} ${c} ${tag(tag("q", 1), 2).length} (expect [a:2] [[a:2]:3] [w2:0] 9)`);

  sleep(seconds(3));
  let five = 5;
  displayText(`B: ${path(five)} ${bars(five, "")} ${kept(12)} (expect 5>4>3>2>1>0 ||||| 3)`);

  sleep(seconds(3));
  let calls = 0;
  let last = "";
  while (calls < 400) {
    last = path(4);
    calls++;
    if (calls % 20 == 0) sleep(frames(1));
  }
  displayText(`C: ${calls} ${last} - and no out of memory in red (expect 400 4>3>2>1>0)`);

  sleep(seconds(5));
  const names: string[] = [];
  names.push("red");
  names.push(`wave ${k + 1}`, "blue");
  names[0] += "!";
  let s = "";
  const popped = names.pop() ?? "";
  for (const t of names) s += `[${t}]`;
  displayText(`D: ${s} ${names.length} ${popped} ${names.join(", ")} ${names.indexOf("wave 3")} ${names.includes("red!") ? 1 : 0} ${names.includes("red") ? 1 : 0} (expect [red!][wave 3] 2 blue red!, wave 3 1 1 0)`);

  sleep(seconds(3));
  const lines: string[] = [];
  let turns = 0;
  while (turns < 600) {
    lines.push(`line ${turns}`);
    if (lines.length > 3) lines.length = 1;
    lines[0] = `line ${turns}`;
    turns++;
    if (turns % 100 == 0) sleep(frames(1));
  }
  displayText(`E: ${turns} ${lines.length} ${lines[0]} - and no out of memory in red (expect 600 3 line 599)`);

  sleep(seconds(4));
  const v = new Vec(1, 2);
  const w = new Vec(10, 20);
  v.add(w).scale(k + 1);
  const twice = v.add(w).add(w).add(w);
  const made = make(7);
  displayText(`F: ${twice.x} ${v.y} ${w.x} ${made.x} (expect 63 126 10 7)`);

  sleep(seconds(3));
  createUnit(P1, units.TerranMarine, 3, HOME);
  sleep(seconds(1));
  const hits = new Map<Unit | null, number>();
  for (const u of unitsAt(HOME, { owner: P1, type: units.TerranMarine })) hits.set(u, u.hp);
  const one = first({ owner: P1, type: units.TerranMarine, at: HOME });
  hits.set(one, 7);
  let sum = 0;
  for (const [u, n] of hits) if (u) sum += n;
  const was = hits.get(one) ?? -1;
  if (one) one.kill();
  sleep(seconds(1));
  let alive = 0;
  for (const u of hits.keys()) if (u) alive++;
  displayText(`G: ${hits.size} ${sum - 47} ${was} ${alive} - and ONE Marine dies (expect 3 40 7 2)`);

  sleep(seconds(3));
  createUnit(P1, units.TerranMarine, 1, HOME);
  sleep(seconds(1));
  let known = 0;
  let here = 0;
  for (const u of unitsAt(HOME, { owner: P1, type: units.TerranMarine })) { here++; if (!hits.has(u)) known++; }
  displayText(`H: ${known - 1} ${here} (expect 0 3)`);

  sleep(seconds(3));
  displayText("done");
}, { owner: P1 });
