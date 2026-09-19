// TrigScript 3.9's probe (slice 8½), part five: classes. A class declared in a program is a record and its methods
// functions with the instance first; an array of instances is an array a field, and a row may hold a unit, a text,
// arrays that grow and another instance, whose blocks it owns. Play it alone (Use Map Settings): you are Player 1,
// Terran. "Home" is the ground next to your base. Every line says what it expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  an instance: a method called three times, a getter, a setter                          — expect 9 18 20
//   5 s  B  two instances, a #private field each, a static field they share, a static method      — expect 1 2 2
//   8 s  C  extends: super(), an overridden method called by the class it extends, instanceof     — expect 7 39 bird 7
//  11 s  D  a method that calls itself: fib(15), and how many calls that was                       — expect 610 1973
//  14 s  E  an instance that holds a made text, an array that grows and another instance           — expect Alpha 3: 2 6 5
//  17 s  F  an array of instances: methods on rows, for…of, push, a getter asked of every row      — expect 3 0 0 5 2
//  20 s  G  rows that hold an array, an instance and a text: sorted by what the arrays say         — expect 231 blue! 1
//  23 s  H  filter gives its rows arrays and texts of their own: the rows it took them from stay   — expect 2 105 copy 5 green
//  26 s  I  2000 rows with a text and an array pushed, given anew, popped and cut off, 100 a frame: NO "out of memory" in red may appear — expect 2000 2
//  36 s  J  three Marines appear at Home and join a squad kept in a row; its leader, their hit points; then the squad is killed — expect 3 120 40, and the three Marines die
//  40 s  K  in a program of every player, an instance a player                                    — expect "K: <your name> 2 7"
//  43 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/classes.ts fixtures/eud/classes.scx`.
import { trigger, program, always, displayText, createUnit, sleep, seconds, frames, name, unitsAt, units, P1, CurrentPlayer, AllPlayers, type Location, type Unit } from "trigscript";

// The map's names are not known to this script: a location is its number (build-fixture makes 1 and 2).
const HOME = 1 as Location;

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  class Counter {
    n = 0;
    step: number;
    constructor(step: number) { this.step = step; }
    bump() { this.n += this.step; }
    get twice() { return this.n * 2; }
    set twice(v: number) { this.n = v / 2; }
  }
  class Id {
    static next = 1;
    #id = 0;
    constructor() { this.#id = Id.next; Id.next++; }
    get id() { return this.#id; }
    static made() { return Id.next - 1; }
  }
  class Animal {
    legs = 4;
    sound = 1;
    constructor(public size: number) {}
    speak() { return this.sound * this.size; }
    describe() { return this.speak() + this.legs; }
  }
  class Bird extends Animal {
    legs = 2;
    constructor(size: number, public wings: number) { super(size * 2); this.sound = 5; }
    speak() { return super.speak() + this.wings; }
  }
  class Maths {
    calls = 0;
    fib(n: number): number { this.calls++; if (n < 2) return n; return this.fib(n - 1) + this.fib(n - 2); }
  }
  class Vec {
    constructor(public x: number, public y: number) {}
    add(o: Vec) { this.x += o.x; this.y += o.y; }
  }
  class Patrol {
    name: string;
    stops: number[] = [];
    pos = new Vec(1, 2);
    constructor(name: string) { this.name = name; }
    add(n: number) { this.stops.push(n); }
    get size() { return this.stops.length; }
  }
  class Wave {
    left: number;
    constructor(public count: number, public delay: number) { this.left = count; }
    spawn() { if (this.left > 0) this.left--; }
    get done() { return this.left == 0; }
  }
  class Squad {
    seen: number[] = [];
    members: Unit[] = [];
    leader: Unit | null = null;
    at = new Vec(0, 0);
    name: string;
    constructor(public id: number, name: string) { this.name = name; }
    note(n: number) { this.seen.push(n); }
    join(u: Unit) { this.members.push(u); if (!this.leader) this.leader = u; }
    get total() { let t = 0; for (const n of this.seen) t += n; return t; }
    get hp() { let t = 0; for (const m of this.members) t += m.hp; return t; }
  }

  sleep(seconds(2));
  const c = new Counter(3);
  c.bump(); c.bump(); c.bump();
  const nine = c.n;
  const eighteen = c.twice;
  c.twice = 40;
  displayText(`A: ${nine} ${eighteen} ${c.n} (expect 9 18 20)`);

  sleep(seconds(3));
  const first = new Id();
  const second = new Id();
  displayText(`B: ${first.id} ${second.id} ${Id.made()} (expect 1 2 2)`);

  sleep(seconds(3));
  let three = 3;
  const animal = new Animal(three);
  const bird: Animal = new Bird(three, 7);
  let what = "animal";
  if (bird instanceof Bird) what = `bird ${bird.wings}`;
  displayText(`C: ${animal.describe()} ${bird.describe()} ${what} (expect 7 39 bird 7)`);

  sleep(seconds(3));
  const maths = new Maths();
  let fifteen = 15;
  const fib = maths.fib(fifteen);
  displayText(`D: ${fib} ${maths.calls} (expect 610 1973)`);

  sleep(seconds(3));
  const patrol = new Patrol(`Alpha ${three}`);
  patrol.add(5); patrol.add(6);
  patrol.pos.add(new Vec(4, 0));
  displayText(`E: ${patrol.name}: ${patrol.size} ${patrol.stops[1]} ${patrol.pos.x} (expect Alpha 3: 2 6 5)`);

  sleep(seconds(3));
  const waves = [new Wave(2, 10), new Wave(1, 20)];
  waves[0].spawn();
  for (const w of waves) w.spawn();
  waves.push(new Wave(three + 2, 1));
  let done = 0;
  waves.forEach((w) => { if (w.done) done++; });
  displayText(`F: ${waves.length} ${waves[0].left} ${waves[1].left} ${waves[2].left} ${done} (expect 3 0 0 5 2)`);

  sleep(seconds(3));
  const squads = [new Squad(1, "red"), new Squad(2, "blue"), new Squad(3, "green")];
  squads[0].note(9); squads[1].note(1); squads[2].note(4); squads[2].note(1);
  squads.sort((a, b) => a.total - b.total);
  squads[0].name += "!";
  squads[2].at.add(new Vec(three, three));
  displayText(`G: ${squads[0].id}${squads[1].id}${squads[2].id} ${squads[0].name} ${squads[2].seen.length} (expect 231 blue! 1)`);

  sleep(seconds(3));
  const odd = squads.filter((s) => s.id % 2 == 1);
  odd[0].note(100);
  odd[0].name = "copy";
  displayText(`H: ${odd.length} ${odd[0].total} ${odd[0].name} ${squads[1].total} ${squads[1].name} (expect 2 105 copy 5 green)`);

  sleep(seconds(3));
  const churn: Squad[] = [];
  let turns = 0;
  let many = 2000;
  while (turns < many) {
    churn.push(new Squad(turns, `squad ${turns}`));
    churn[churn.length - 1].note(turns);
    churn[churn.length - 1].note(1);
    churn[0] = new Squad(7, "again");
    churn[0].note(2);
    if (churn.length > 3) { churn.pop(); churn.length = 1; churn.push(new Squad(0, "kept")); churn.pop(); }
    turns++;
    if (turns % 100 == 0) sleep(frames(1));
  }
  displayText(`I: ${turns} ${churn.length} - and no out of memory in red (expect 2000 2)`);

  sleep(seconds(5));
  createUnit(P1, units.TerranMarine, 3, HOME);
  sleep(seconds(1));
  const army = [new Squad(1, "guards")];
  for (const u of unitsAt(HOME, { owner: P1, type: units.TerranMarine })) army[0].join(u);
  let lead = 0;
  const leader = army[0].leader;
  if (leader) lead = leader.hp;
  displayText(`J: ${army[0].members.length} ${army[0].hp} ${lead} - and the three Marines die (expect 3 120 40)`);
  sleep(seconds(1));
  for (const m of army[0].members) m.kill();

  sleep(seconds(6));
  displayText("done");
}, { owner: P1 });

program(() => {
  class Mine {
    items: number[] = [];
    who: string;
    constructor(who: string) { this.who = who; }
    add(n: number) { this.items.push(n); }
    get sum() { let t = 0; for (const n of this.items) t += n; return t; }
  }
  sleep(seconds(40));
  const mine = new Mine(`${name(CurrentPlayer)}`);
  mine.add(3); mine.add(4);
  displayText(`K: ${mine.who} ${mine.items.length} ${mine.sum} (expect your name, 2 7)`);
}, { owner: AllPlayers });
