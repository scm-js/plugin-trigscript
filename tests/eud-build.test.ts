/**
 * Programs end to end under Node: fixture scripts compiled to IR, the IR
 * and the map handed to the eudplib plugin's command-line builder (the same worker the
 * editor runs), the built map opened again. Skipped unless a plugin-eudplib checkout is
 * at `EUDPLIB_DIR` or beside this repository.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { serializeIr } from "../compiler/eud";
import { buildPlugins } from "../compiler/input";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";

const EUDPLIB_DIR = process.env.EUDPLIB_DIR ?? resolve(import.meta.dirname, "..", "..", "plugin-eudplib");
const MAP = resolve(import.meta.dirname, "..", "fixtures", "maps", "(2)Binary Burghs.scx");
const have = existsSync(join(EUDPLIB_DIR, "scripts", "build-map.mts")) && existsSync(MAP);

const LIB = defaultLib();
const NAMES = defaultScriptNames();

const FIXTURES: Record<string, string> = {
  counter: `program(() => {
    let n = 0;
    let gold = 0;
    while (true) {
      n += 1;
      gold = n * 5;
      if (gold >= 50 && n % 2 == 0) { setResources(P1, "add", gold, "ore"); displayText("paid"); }
      sleep(frames(24));
    }
  });`,
  nested: `program(() => {
    let i = 0;
    let lives = 3;
    function heal(by: number): number { return by + 1; }
    while (true) {
      i = 0;
      while (i < 3) {
        if (lives > 0) { sleep(frames(2)); lives -= 1; }
        else { lives = heal(lives); }
        i++;
      }
      switch (i) { case 3: lives = 9; break; default: lives = 0; }
      for (const k of [1, 2]) { if (k == 2) break; lives += k; }
      sleep(seconds(1));
    }
  });`,
  arithmetic: `program(() => {
    let a = 7; let b = 3; let q = 0;
    while (true) {
      q = a / b + a % b + a * b;
      if (a - b == 0 || Math.abs(b - a) > 3 || a >= -1) { q = Math.min(q, a) + Math.max(b, 2); }
      b = q / (b - b);
      createUnit(P1, units.TerranMarine, a, locations.Anywhere);
      playWav("sound\\\\glue\\\\mousedown2.wav", 0);
      sleep(seconds(5));
    }
  }, { owner: players.Force1 });`,
  reads: `program(() => {
    let price = 50;
    while (true) {
      let ore = minerals(P1);
      let lost = deaths(CurrentPlayer, units.TerranMarine);
      let here = countUnits(P1, units.AnyUnit, locations.Anywhere) + countUnits(players.Force1, units.TerranMarine);
      let team = resources(players.Force1, "oreAndGas") + kills(P1, units.ZergZergling) + score(P1, "kills") + countdown() + elapsed() + opponents(P1);
      if (minerals(P1) > price * 2 && isHuman(P1) && !hasLeft(P2) && race(P1) == races.Terran && slot(P2) != slots.Empty) {
        setResources(P1, "set", minerals(P1) - price + supply(P1, "used") + supply(P1, "max", races.Zerg) + supply(P1, "provided"), "gas");
      }
      let pick = random(3) + random(price) + ((ore & 255) | (lost << 2)) + ((here ^ team) >> price);
      createUnit(P1, units.TerranMarine, pick % 3, locations.Anywhere);
      sleep(seconds(1));
    }
  });`,
  strings: `const titles = ["Easy", "Hard", "Insane"];
  program(() => {
    let wave = 0;
    let level = 1;
    let title = titles[level];
    let mood = wave > 2 ? "late" : "early";
    let boss = { name: "Ultralisk", hp: 400 };
    function tag(what: string, n: number): string { return \`[\${what} \${n}]\`; }
    function shout(s: string): string { s += "!"; return s; }
    while (true) {
      wave += 1;
      let s = \`Wave \${wave} of \${titles[level]}\`;
      s += " - " + mood;
      const kept = s;
      s = shout(tag(s, wave));
      print(s);
      print(\`\${kept} / \${s.length} / \${name(CurrentPlayer)}\`, { to: AllPlayers });
      if (s == kept || s != "x" || s < kept || s >= title) mood = "late";
      if (s.startsWith("[W") && s.endsWith("!") && s.includes("of") && !s.includes("boss")) level = (level + 1) % 3;
      let at = s.indexOf("of", 2) + s.codePointAt(0)! + (s ? 1 : 0);
      let piece = s.slice(1, -1) + s.substring(4, 2) + s[0] + s.charAt(2) + (s.at(-1) ?? "?") + s.padStart(12, "ab") + s.padEnd(at, ".") + "=".repeat(wave) + (mood || "none");
      for (const ch of piece) { if (ch == " ") continue; if (ch == "!") break; at += ch.length; }
      switch (mood) { case "late": at += 1; break; case "early": at += 2; break; default: at = 0; }
      switch (s) { case "[Wave 1 of Hard - early 1]!": at += 5; break; }
      boss.name = \`\${boss.name}+\`;
      title = titles[level];
      setMissionObjectives(title);
      setMissionObjectives(\`\${boss.name}: wave \${wave}, \${at}\`);
      leaderboardKills(\`Kills in wave \${wave}\`, units.TerranMarine);
      transmission(piece, units.TerranMarine, locations.Anywhere, "set", 2000, "sound\\\\misc\\\\buzz.wav", 1000);
      stats(units.TerranMarine).name = \`Marine of wave \${wave}\`;
      stats(units.ZergZergling).name = title;
      sleep(seconds(2));
    }
  }, { owner: AllPlayers });`,
  text: `program(() => {
    let wave = 0;
    const banner = (p: Player) => \`\${color(p)}\${name(p)}\\x01 is here\`;
    while (true) {
      wave += 1;
      displayText(\`Wave \${wave}: \${minerals(CurrentPlayer)} ore, \${name(CurrentPlayer)}\`);
      displayText(banner(P2));
      print(\`Wave \${wave}\`, { to: AllPlayers, position: "center" });
      print("plain, to the others", { to: players.Force2 });
      print(\`\${color(P1)}\${wave * 2}\`, { to: P1 });
      sleep(seconds(2));
    }
  }, { owner: AllPlayers });`,
  units: `program(() => {
    stats(units.TerranMarine).minerals = 25;
    stats(units.TerranMarine).speed = 6.5;
    stats(units.TerranMarine).buildTime = 1.5;
    stats(units.ZergZergling).name = "Dog";
    stats(units.TerranGhost).permanentCloak = true;
    stats(weapons.GaussRifle).damage += 2;
    stats(upgrades.TerranInfantryArmor).minerals = stats(upgrades.TerranInfantryArmor).maxLevel * 10;
    stats(P1).color = "teal";
    stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;
    stats(P1).researched[techs.Lockdown] = true;
    let kept: Unit | null = null;
    let fast = 3;
    function weakest(): Unit | null {
      let best: Unit | null = null;
      let least = 9999;
      for (const u of unitsOf(P1, { type: units.Men })) { if (u.hp < least) { least = u.hp; best = u; } }
      return best;
    }
    function hurt(u: Unit, by: number) { u.damage(by); u.stim = 40; }
    while (true) {
      for (const u of unitsAt(locations.Anywhere, { owner: P2, type: units.ZergZergling })) {
        if (u.burrowed || u.invincible) continue;
        u.hp = u.maxHp / 2; u.energy += 10; u.kills++; u.cooldown = 24; u.invincible = !u.hallucinated;
        if (u.shields > u.maxShields) break;
        kept = u;
      }
      const target = nearest(units.TerranMarine, locations.Anywhere, { owner: P1 });
      if (target) { target.order("move", locations.Anywhere); target.damage({ percent: 50 }); target.heal(fast); target.locate(5 as Location); print(\`\${target.hp} hp at \${target.x}, \${target.y}\`); }
      const lucky = randomUnit({ owner: P1 });
      if (lucky != null && lucky != target) { lucky.give(P2); hurt(lucky, fast); }
      const w = weakest();
      if (w) w.heal({ percent: fast });
      if (kept && kept.type == units.ZergZergling && kept.owner == P2) kept.kill();
      if (stats(units.TerranGhost).permanentCloak && !stats(units.TerranMarine).detector) { stats(units.TerranMarine).detector = fast > 3; }
      if (!first({ type: units.Buildings, owner: P2 })) { stats(units.TerranMarine).speed = fast; fast += 1; }
      first({ owner: P2 })?.remove();
      sleep(seconds(1));
    }
  });`,
  unitsPerPlayer: `program(() => {
    let mine: Unit | null = null;
    while (true) {
      if (!mine) mine = first({ owner: CurrentPlayer, type: units.Men });
      if (mine) { mine.heal(1); stats(CurrentPlayer).color = colors.green; }
      for (const u of unitsOf(CurrentPlayer)) { if (u == mine) continue; if (u.underAttack) u.invincible = true; }
      sleep(frames(8));
    }
  }, { owner: AllPlayers });`,
  input: `program(() => {
    let gold = 0;
    while (true) {
      if (keyPressed(CurrentPlayer, "F2") || keyPressed(CurrentPlayer, "Space")) gold += 1;
      if (clicked(CurrentPlayer) || clicked(CurrentPlayer, "right")) { const at = mouse(CurrentPlayer); centerLocation(1, at.x + 8, at.y); createUnit(CurrentPlayer, units.TerranMarine, 1, 1); }
      const m = chatted(CurrentPlayer, "-spawn {n} {unit:unit}");
      if (m) createUnit(CurrentPlayer, m.unit, m.n, 1);
      const g = chatted(CurrentPlayer, "-give {kind:ore|gas} {n}");
      if (g != null && g.kind == 1) setResources(CurrentPlayer, "add", g.n, "gas");
      if (chatted(CurrentPlayer, "-help")) displayText("no help");
      const u = underMouse(CurrentPlayer, { owner: CurrentPlayer, within: 64 });
      if (u) u.kill();
      sleep(frames(1));
    }
  }, { owner: AllPlayers });`,
  inputOnePlayer: `program(() => {
    while (true) {
      if (keyPressed(P1, "A") && mouse(P1).x > 100) underMouse(P1)?.heal(5);
      sleep(frames(1));
    }
  });`,
  arrays: `const price = [50, 100, 150];
  program(() => {
    let hp = [10, 20, 30];
    const seen = [false, false, false];
    let lives: u8[] = new Array(24).fill(3);
    let i = 0;
    function bump(list: number[], by: number) { for (let k = 0; k < list.length; k++) list[k] += by; }
    while (true) {
      hp[i] += price[i] - 60;
      seen[i] = hp[i] < 0;
      lives[i + 20] -= 1;
      for (const h of hp) { if (h > 100) setResources(P1, "add", h, "ore"); }
      let swap = [hp[1], hp[0]];
      bump(hp, swap[0]);
      if (seen[i] && lives[i] == 0) displayText(\`\${hp[i]} at \${i}\`);
      i = (i + 1) % 4;
      sleep(frames(12));
    }
  });`,
  growing: `program(() => {
    const queue: number[] = [];
    let flags = [true];
    let big: u8[] = new Array(40).fill(3);
    let n = 0;
    function add(list: number[], v: number) { list.push(v); }
    while (true) {
      queue.push(n, n * 2);
      add(queue, n + 1);
      flags.push(queue.includes(n) && queue.indexOf(n * 2) >= 0);
      big.push(n);
      queue[queue.length] = 9;
      if (queue.length > 50) { queue.length = 10; big.length = 0; }
      const last = queue.pop() ?? 0;
      if (flags.pop()) setResources(P1, "add", last, "ore");
      const scratch: number[] = [];
      for (const q of queue) { if (q > 5) scratch.push(q); }
      scratch.fill(1);
      n = scratch.length;
      sleep(frames(12));
    }
  });`,
  growingPerPlayer: `program(() => {
    const mine: number[] = [];
    const all = shared([0]);
    while (true) {
      mine.push(mine.length); all.push(mine.pop() ?? 0);
      sleep(frames(12));
    }
  }, { owner: AllPlayers });`,
  keyed: `const bounty: Record<UnitType, number> = { [units.ZergZergling]: 5, [units.ZergHydralisk]: 15 };
  const elite = new Set<UnitType>([units.ZergUltralisk]);
  program(() => {
    const score: Record<Player, number> = { [P1]: 0 };
    const lost = new Map<UnitType, number>();
    const seen = new Set<UnitType>();
    while (true) {
      for (const u of unitsOf(P2)) {
        if (u.hp < 10) {
          score[u.owner] += bounty[u.type] + (elite.has(u.type) ? 100 : 0);
          lost.set(u.type, (lost.get(u.type) ?? 0) + 1);
          seen.add(u.type);
          u.kill();
        }
      }
      if (seen.size >= 3 && lost.has(units.ZergZergling)) { setResources(P1, "add", score[P1], "ore"); seen.clear(); lost.delete(units.ZergZergling); }
      sleep(seconds(1));
    }
  });`,
  arraysPerPlayer: `program(() => {
    let mine = [0, 0, 0];
    let all = shared([0, 0, 0]);
    let big = new Array(40).fill(7);
    let i = 0;
    while (true) {
      mine[i] += 1; all[i] += mine[i]; big[i + 30] = all[i];
      i = (i + 1) % 3;
      sleep(frames(12));
    }
  }, { owner: AllPlayers });`,
  perPlayer: `program(() => {
    let mine = 0;
    let total = shared(0);
    while (true) {
      mine += 1; total += 1;
      if (mine > total / 2) { mine = 0; }
      sleep(frames(12));
    }
  }, { owner: AllPlayers });`,
};

function build(name: string, src: string): { out: number; triggers: number } {
  const r = compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
  expect(r.diagnostics).toEqual([]);
  // One program a fixture, but for the numbers probe, which has a second one for every player.
  expect(r.ir.length).toBe(name === "numbers" || name === "arraysProbe" || name === "functions" || name === "functionsProbe" || name === "callbacksProbe" || name === "insideProbe" || name === "stringsProbe" || name === "classesProbe" || name === "mapProbe" ? 2 : name === "leftoversProbe" ? 1 : name === "recursionProbe" ? 3 : 1);
  const ir = serializeIr(r.ir, r.strings, r.input);
  const dir = mkdtempSync(join(tmpdir(), "trigscript-eud-"));
  const irPath = join(dir, "trigscript.json");
  const pluginsPath = join(dir, "plugins.json");
  const outPath = join(dir, `${name}-eud.scx`);
  writeFileSync(irPath, ir);
  writeFileSync(pluginsPath, JSON.stringify(buildPlugins(r.input, "/work/files/trigscript.json")));
  const res = spawnSync("npx", ["tsx", join(EUDPLIB_DIR, "scripts", "build-map.mts"), MAP, outPath, pluginsPath, `trigscript=${resolve(import.meta.dirname, "..", "python", "trigscript.py")}`, `file=trigscript.json=${irPath}`], { cwd: EUDPLIB_DIR, encoding: "utf8", env: { ...process.env, EUDPLIB_LOG: "1" } });
  if (res.status !== 0) throw new Error(`${name}: build failed\n${res.stdout}\n${res.stderr}`);
  const out = readFileSync(outPath).length;
  rmSync(dir, { recursive: true, force: true });
  // The builder prints "<path>: <bytes> bytes, <n> triggers" once the output opened again.
  const m = /(\d+) triggers/.exec(res.stdout);
  return { out, triggers: m ? Number(m[1]) : 0 };
}

// Functions that are called: parameters and results of each kind, an argument that is a call of the same function, a copy an
// array, a called function calling another, and — in the second program — cells that are a row a player.
FIXTURES.functions = `program(() => {
    let out = 0; let yes = false;
    let hp = [1, 2, 3]; let shields = [10, 20];
    function add(a: number, b: number) { return a + b; }
    function big(n: number) { return n >= 10; }
    function total(xs: number[]) { let t = 0; for (const x of xs) t = add(t, x); return t; }
    function weakest(below: number): Unit | null { let best: Unit | null = null; for (const u of unitsOf(P1)) { if (u.hp < below) best = u; } return best; }
    function hurt(u: Unit | null, by: number) { if (u) u.hp -= by; }
    while (true) {
      out = add(add(1, 2), add(out, 4)) + total(hp) + total(hp) + total(shields) + total(shields);
      yes = big(out) && !big(out - 100);
      hurt(weakest(30), 5);
      hurt(weakest(out), 1);
      if (yes) print(\`out \${out}\`);
      sleep(seconds(1));
    }
  });
  program(() => {
    let mine = 0;
    function earn(n: number) { mine += n; return mine; }
    while (true) {
      if (earn(1) + earn(2) > 100) mine = 0;
      sleep(frames(8));
    }
  }, { owner: AllPlayers });`;
// The numbers probe whole: every signed path of the lowering — a division towards zero by a variable and by a constant, a shift that
// keeps the sign, a comparison of a number with a u32, a number printed with its minus sign — is in it.
FIXTURES.numbers = readFileSync(resolve(import.meta.dirname, "..", "probes", "numbers.ts"), "utf8");
// And the arrays probe: fixed arrays, tables, the heap, records, units and keyed tables in one build.
FIXTURES.arraysProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "arrays.ts"), "utf8");

// And the functions probe: every kind of called function in one build.
FIXTURES.functionsProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "functions.ts"), "utf8");

// And the recursion probe: frames kept and brought back for numbers, booleans, units and arrays' handles, two functions
// calling each other, rows a player, and the overflow that stops a program.
FIXTURES.recursionProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "recursion.ts"), "utf8");

// Destructuring and spread are the front end's alone; this is that what they come to still builds: a record of mouse() taken
// apart, a swap of cells, a rest that grows, a row spread into a push, a pattern for a parameter of a called function.
FIXTURES.destructuring = `program(() => {
  let ws = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }];
  let xs: number[] = [];
  function cost({ count, delay }: { count: number; delay: number }, ...extra: number[]) { let c = count * delay; for (const e of extra) c += e; return c; }
  while (true) {
    const { x, y } = mouse(P1);
    xs.push(x); xs.push(y); xs.push(x + y);
    const [first, ...tail] = xs;
    [xs[0], xs[1]] = [xs[1], xs[0]];
    const w = ws[0];
    ws.push({ ...w, count: first });
    const all = [...tail, first, cost(w), cost(ws[1], x, y)];
    let sum = 0;
    for (const { count, delay } of ws) sum += count + delay;
    ws.forEach(({ count }) => { sum += count; });
    displayText(\`\${sum} \${all.length} \${tail.length}\`);
    xs.length = 0; ws.length = 2;
    sleep(seconds(1));
  }
});`;

// Arrays of arrays of a fixed shape: one flat array, a row a window on it (IR 12's `slice`) — read by two indices, a row
// kept, looped, sorted and filled through its window, whole rows pushed to one that grows, and an array in a record.
FIXTURES.grids = `program(() => {
  let g = [[1, 2, 3], [4, 5, 6]];
  const path: number[][] = [];
  let p = { hp: 5, trail: [0, 0, 0], seen: [] as number[] };
  function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
  let y = 0;
  while (true) {
    y = (y + 1) % 2;
    const row = g[y];
    row[0] += 1; g[y][2] = g[1 - y][y] + row[1];
    row.sort((a, b) => b - a); g[0].fill(total(row));
    path.push([y, g[y][0]]); if (path.length > 4) path.length = 0;
    let sum = 0; for (const r of g) sum += r.reduce((s, c) => s + c, 0);
    p.trail[y] = sum; p.seen.push(total(p.trail)); if (p.seen.length > 8) p.seen.length = 0;
    displayText(\`\${sum} \${path.length} \${p.seen.length} \${g.findIndex((r) => r[0] > 9)}\`);
    sleep(seconds(1));
  }
});`;

// Arrays that grow inside an array (IR 12's `through`): rows of different lengths reached through a handle a row, the
// outer one growing too, rows popped, cut off and assigned giving their blocks back, a row sorted and handed to a function.
FIXTURES.lists = `program(() => {
  const b: number[][] = [[1, 2], [], [3]];
  let fixed = [[5], [6, 7]];
  let p = { hp: 5, lanes: [[1], [2, 3]] };
  function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
  let n = 0;
  while (true) {
    n++;
    b[n % 3].push(n); fixed[n % 2].push(n); p.lanes[0].push(p.hp);
    const row = b[0]; row.sort((x, y) => y - x);
    b.push([n, n + 1], []); b[b.length - 1] = [7, 7, 7];
    let sum = 0; for (const r of b) sum += total(r);
    const sizes = b.map((r) => r.length);
    if (b.length > 6) { b.pop(); b.length = 3; }
    if (fixed[0].length > 8) fixed[0].length = 0;
    displayText(\`\${sum} \${sizes.length} \${b.findIndex((r) => r.includes(7))} \${total(p.lanes[0])}\`);
    sleep(seconds(1));
  }
});`;

// And the probe of arrays inside arrays: a grid filled and read back, a row past its end, rows that grow with the outer one
// cut off three thousand times, arrays in a record, rows a player.
FIXTURES.insideProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "inside.ts"), "utf8");
FIXTURES.stringsProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "strings.ts"), "utf8");
FIXTURES.classesProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "classes.ts"), "utf8");
FIXTURES.mapProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "map.ts"), "utf8");
FIXTURES.leftoversProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "leftovers.ts"), "utf8");

// Classes: an instance a record, its methods functions with the instance first — called, inlined, calling themselves — what
// a class extends, statics, a getter and a setter, texts, arrays and an instance inside, and an array of instances.
FIXTURES.classes = `program(() => {
  class Vec { constructor(public x: number, public y: number) {} add(o: Vec) { this.x += o.x; this.y += o.y; } get far() { return this.x + this.y > 100; } }
  class Thing {
    static made = 0;
    #id = 0;
    name: string;
    pos = new Vec(0, 0);
    seen: number[] = [];
    constructor(name: string, public hp: number) { this.name = name; Thing.made++; this.#id = Thing.made; }
    get id() { return this.#id; }
    set life(v: number) { this.hp = v < 0 ? 0 : v; }
    hurt(by: number) { this.life = this.hp - by; this.seen.push(by); }
    fib(n: number): number { return n < 2 ? n : this.fib(n - 1) + this.fib(n - 2); }
    label(): string { return \`\${this.name} #\${this.id} \${this.hp}\`; }
  }
  class Boss extends Thing {
    rage = 1;
    constructor(hp: number) { super("Boss", hp * 2); }
    hurt(by: number) { super.hurt(by / 2); this.rage++; }
  }
  class Wave { left: number; constructor(public count: number, public delay: number) { this.left = count; } spawn() { if (this.left > 0) this.left--; } get done() { return this.left == 0; } }
  class Squad {
    members: Unit[] = []; seen: number[] = []; leader: Unit | null = null; at = new Vec(0, 0); name: string;
    constructor(public owner: number) { this.name = \`Squad \${owner}\`; }
    add(u: Unit) { this.members.push(u); this.seen.push(u.hp); if (!this.leader) this.leader = u; }
    get hp() { let t = 0; for (const m of this.members) t += m.hp; return t; }
  }
  const squads: Squad[] = [];
  squads.push(new Squad(0)); squads.push(new Squad(1));
  for (const u of allUnits()) if (u.owner == P1) squads[0].add(u); else squads[1].add(u);
  let n = 0;
  const t = new Thing(\`Grunt \${n}\`, 40);
  const b = new Boss(100);
  const step = new Vec(3, 4);
  const waves = [new Wave(2, 10), new Wave(3, 20)];
  while (true) {
    n++;
    t.hurt(n); t.hurt(1); b.hurt(n); t.pos.add(step); b.pos.add(step);
    for (const w of waves) w.spawn();
    if (waves.every((w) => w.done)) waves.push(new Wave(n, 1));
    waves.sort((x, y) => x.left - y.left);
    squads.sort((x, y) => y.hp - x.hp);
    const led = squads.filter((q) => q.members.length > 0);
    const lead = squads[0].leader; if (lead) lead.hp += 1;
    squads[0].at.add(step); squads[1].seen = [n, n + 1];
    if (squads.length > 4) { squads.pop(); squads.length = 2; squads[1] = new Squad(n); }
    if (n % 5 == 0) squads.push(new Squad(n));
    squads[0].name += "!"; if (squads[1].name == "Squad 1") squads[1].name = "First";
    displayText(\`\${squads[0].name} \${led[0].name} \${squads[1].name.length}\`);
    displayText(\`\${led.length} \${squads[0].hp} \${squads[0].seen.length} \${squads[0].at.far ? 1 : 0}\`);
    if (b instanceof Thing && t.pos.far) displayText(t.label());
    displayText(\`\${b.label()} \${b.rage} \${t.fib(n % 12)} \${Thing.made} \${waves.length} \${t.seen.length}\`);
    sleep(seconds(1));
  }
});`;

// And the callbacks probe: the methods that take a function, over arrays, records, arrays of units, the units of the game
// and a list the script has — returns out of loops over units, a break inside the sort, arrays made by filter and map.
FIXTURES.callbacksProbe = readFileSync(resolve(import.meta.dirname, "..", "probes", "callbacks.ts"), "utf8");

describe.skipIf(!have)("programs build through the eudplib plugin", () => {
  for (const [name, src] of Object.entries(FIXTURES)) {
    it(`${name}: compiles to IR, builds, and the output opens with the payload's triggers`, () => {
      const { out, triggers } = build(name, src);
      expect(out).toBeGreaterThan(10_000);
      // eudplib's bootstrap is a fixed set of triggers on top of the map's own two.
      expect(triggers).toBeGreaterThan(2);
    }, 240_000);
  }
});

describe("the IR as the lowering reads it", () => {
  it("writes a program's text and sounds out, and keeps an index the script named", () => {
    const r = compileScript(ts, { "main.ts": `program(() => { displayText("hello"); playWav("sound\\\\x.wav", 0); });` }, NAMES, { lib: LIB });
    expect(r.diagnostics).toEqual([]);
    const ir = JSON.parse(serializeIr(r.ir, r.strings));
    const actions = ir.programs[0].body.filter((s: { kind: string }) => s.kind === "action").map((s: { record: { text: unknown; wav: unknown } }) => [s.record.text, s.record.wav]);
    expect(actions).toEqual([["hello", 0], [0, "sound\\x.wav"]]);
    expect(ir.version).toBe(14);
  });
});
