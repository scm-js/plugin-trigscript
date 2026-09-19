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
  expect(r.ir.length).toBe(name === "numbers" || name === "arraysProbe" || name === "functions" || name === "functionsProbe" || name === "callbacksProbe" ? 2 : name === "recursionProbe" ? 3 : 1);
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
    expect(ir.version).toBe(11);
  });
});
