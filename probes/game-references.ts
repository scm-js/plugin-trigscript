// TrigScript 4, B9: references, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-references.ts
// Every value starts from a variable the game holds (gas, which the program sets first), so which class a row is, and
// how many rows are made and given back, is decided in the game.
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

abstract class Thing {
  hp = 10;
  name = "thing";
  abstract kind(): number;
  hit(n: number) { this.hp -= n; }
}
class Grunt extends Thing {
  kind() { return 1; }
}
class Boss extends Thing {
  armor = 3;
  kind() { return 2; }
  hit(n: number) { super.hit(Math.max(0, n - this.armor)); }
}
class Link {
  next: Link | null = null;
  constructor(public v: number) {}
}
class Tree {
  left: Tree | null = null;
  right: Tree | null = null;
  constructor(public v: number) {}
  sum(): number { return this.v + (this.left ? this.left.sum() : 0) + (this.right ? this.right.sum() : 0); }
}
class Squad {
  members: Thing[] = [];
  label = "";
  total() { let t = 0; for (const m of this.members) t += m.hp; return t; }
}

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: one of two classes each turn, each its own method; super; instanceof. 121 18 B
  const things: Thing[] = [];
  let i = 0;
  while (i < g) { things.push(i % 2 === 0 ? new Grunt() : new Boss()); i++; }
  for (const t of things) t.hit(g + 2);
  let kinds = 0;
  let hps = 0;
  for (const t of things) { kinds = kinds * 10 + t.kind(); hps += t.hp; }
  displayText(`A: ${kinds} ${hps} ${things[1] instanceof Boss ? "B" : "g"}`);
  sleep(frames(1));

  // B: a list made, walked and reversed; none at its end. 321 123
  let head: Link | null = null;
  let k = 1;
  while (k <= g) { const n = new Link(k); n.next = head; head = n; k++; }
  let s1 = 0;
  for (let c = head; c; c = c.next) s1 = s1 * 10 + c.v;
  let rev: Link | null = null;
  while (head) { const next: Link | null = head.next; head.next = rev; rev = head; head = next; }
  let s2 = 0;
  for (let c = rev; c; c = c.next) s2 = s2 * 10 + c.v;
  displayText(`B: ${s1} ${s2} ${(head as Link | null)?.v ?? -1}`);
  sleep(frames(1));

  // C: a tree summed by a method that calls itself on other rows. 10
  const root = new Tree(1);
  root.left = new Tree(2);
  root.right = new Tree(g);
  root.left.left = new Tree(g + 1);
  displayText(`C: ${root.sum()}`);
  sleep(frames(1));

  // D: instances inside an instance, a text field, a Map of them. 3 Alpha 13 10 -1
  const sq = new Squad();
  sq.label = "Alpha";
  sq.members.push(new Grunt());
  sq.members.push(new Boss());
  sq.members[0].hp = g;
  const byId = new Map<number, Thing>();
  byId.set(7, sq.members[0]);
  byId.set(8, new Grunt());
  displayText(`D: ${byId.get(7)?.hp ?? -1} ${sq.label} ${sq.total()} ${byId.get(8)!.hp} ${byId.get(9)?.hp ?? -1}`);
  sleep(frames(1));

  // E: 3000 made across frames and let go of, never running out; the kept ones still there. 2999 3
  let kept: Link | null = null;
  let last: Link | null = null;
  let made = 0;
  while (made < g * 1000) {
    last = new Link(made);
    if (made % 1000 === 999) { last.next = kept; kept = last; }
    made++;
    if (made % 100 === 0) sleep(frames(1));
  }
  let count = 0;
  for (let c = kept; c; c = c.next) count++;
  displayText(`E: ${last?.v ?? -1} ${count}`);
});

test("one of several classes", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 121 18 B");
});
test("a list made, walked and reversed", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 321 123 -1");
});
test("a method that calls itself on other rows", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 10");
});
test("instances inside an instance, a text, a Map", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 3 Alpha 13 10 -1");
});
test("rows given back", (sim) => {
  sim.frames(80);
  expect(sim).toHavePrinted("E: 2999 3");
});
