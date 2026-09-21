/** `compiler/testing.ts`: a script's own `test()`s — where they may be, what `sim` and `expect` do, what fails one. */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult, type ScriptFiles } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import type { TestRunOptions, TestWorld } from "../compiler/testing";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const WORLD: TestWorld = {
  locations: { 1: { left: 0, top: 0, right: 200, bottom: 200 }, 2: { left: 1000, top: 1000, right: 1200, bottom: 1100 } },
  unitStats: { 0: { hp: 40 }, 37: { hp: 35 } },
};
const run = (files: ScriptFiles | string, tests: TestRunOptions = { world: WORLD }): CompileResult => compileScript(ts, typeof files === "string" ? { "main.ts": files } : files, NAMES, { lib: LIB, tests });
const outcome = (r: CompileResult) => Object.fromEntries((r.tests?.results ?? []).map((t) => [t.id.replace(/^.*?::/, ""), t.status === "failed" ? `failed: ${t.message}` : t.status]));

const WAVES = `import { test, expect, describe, beforeEach, program, createUnit, killUnitAt, countUnits, sleep, frames, print, units, P1, P2, type Location } from "trigscript";
const BEACON = 1 as Location, SPAWN = 2 as Location;
program(() => {
  let wave = 0;
  while (true) {
    if (countUnits(P1, units.TerranMarine, BEACON) > 0) {
      wave += 1;
      createUnit(P2, units.ZergZergling, wave * 4, SPAWN);
      print(\`Wave \${wave}\`);
      killUnitAt(P1, units.TerranMarine, "All", BEACON);
    }
    sleep(frames(1));
  }
}, { name: "waves" });
`;

describe("a test beside what it tests", () => {
  it("runs in a world of its own and reads the program by the names in the source", () => {
    const r = run(`${WAVES}
test("the second wave is bigger", (sim) => {
  sim.place(P1, units.TerranMarine, BEACON);
  sim.until(() => sim.program("waves").wave === 1);
  sim.place(P1, units.TerranMarine, BEACON);
  sim.until(() => sim.program("waves").wave === 2);
  expect(sim.count(P2, units.ZergZergling, SPAWN)).toBe(12);
  expect(sim).toHavePrinted("Wave 2");
  expect(sim).not.toHavePrinted(/Wave 3/);
  expect(sim.deaths(P1, units.TerranMarine)).toBe(2);
});
test("nothing happens with nobody on the beacon", (sim) => {
  sim.seconds(2);
  expect(sim.frame).toBe(48);
  expect(sim.units()).toHaveLength(0);
  expect(sim.program(0).wave).toBe(0);
});`);
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(outcome(r)).toEqual({ "the second wave is bigger": "passed", "nothing happens with nobody on the beacon": "passed" });
    expect(r.tests!.list.map((t) => [t.name, t.file, t.line])).toEqual([["the second wave is bigger", "main.ts", 16], ["nothing happens with nobody on the beacon", "main.ts", 26]]);
    expect(r.tests!.results[0].printed).toEqual(["Wave 1", "Wave 2"]);
    // A test costs the map nothing.
    expect(r.ir).toHaveLength(1);
    expect(r.triggers).toHaveLength(0);
  });

  it("says where and what when an expect does not hold", () => {
    const r = run(`${WAVES}
test("wrong", (sim) => {
  sim.place(P1, units.TerranMarine, BEACON);
  sim.frames(2);
  expect(sim.count(P2, units.ZergZergling, SPAWN)).toBe(8);
});`);
    const [t] = r.tests!.results;
    expect([t.status, t.message, t.expected, t.actual, t.at]).toEqual(["failed", "expected 8, got 4", "8", "4", { file: "main.ts", line: 19, column: 52 }]);
    // A failing test is not a fault of the script: the build stands.
    expect(r.ok).toBe(true);
  });

  it("an until that never comes true fails the test and does not hang it", () => {
    const r = run(`${WAVES}\ntest("never", (sim) => { sim.until(() => sim.program("waves").wave === 1, 50); });`);
    expect(outcome(r)).toEqual({ never: "failed: until: still not true after 50 frames" });
    expect(r.tests!.results[0].frames).toBe(50);
  });

  it("is listed and not run without a world, and not at all when the script has problems", () => {
    const listed = compileScript(ts, { "main.ts": `${WAVES}\ntest("later", () => {});` }, NAMES, { lib: LIB });
    expect([listed.tests!.list.map((t) => t.name), listed.tests!.results]).toEqual([["later"], []]);
    const broken = run(`${WAVES}\ntest("later", () => {}); const x: number = "no";`);
    expect(broken.tests).toBeNull();
  });
});

describe("what fails a test without being asked", () => {
  const FAULTY = `import { test, expect, program, sleep, frames } from "trigscript";
program(() => { const xs = [1, 2, 3]; let i = 5; let got = xs[i]; sleep(frames(1)); });`;
  it("a fault of the simulator, at the program's line", () => {
    const r = run(`${FAULTY}\ntest("reads past the end", (sim) => { sim.frames(1); });`);
    const [t] = r.tests!.results;
    expect(t.status).toBe("failed");
    expect(t.message).toMatch(/xs\[5\] is past the end/);
    expect(t.at).toMatchObject({ file: "main.ts", line: 2 });
  });
  it("unless the test asks for it", () => {
    const r = run(`${FAULTY}\ntest("reads past the end", (sim) => { sim.frames(1); expect(sim).toHaveFaulted(/past the end/); });`);
    expect(outcome(r)).toEqual({ "reads past the end": "passed" });
  });
  it("anything it throws, at the line that threw", () => {
    const r = run(`import { test } from "trigscript";\ntest("throws", () => {\n  const o: any = null;\n  o.x = 1;\n});`);
    expect(r.tests!.results[0]).toMatchObject({ status: "failed", at: { file: "main.ts", line: 4 } });
  });
  it("an async test is refused when it is declared", () => {
    const r = run(`import { test } from "trigscript";\ntest("waits", async () => {});`);
    expect(r.diagnostics.map((d) => [d.line, d.message])).toEqual([[2, expect.stringMatching(/a test is not async/)]]);
  });
});

describe("Vitest's names", () => {
  const SCRIPT = `import { test, it, describe, beforeEach, afterEach, expect, program, setDeaths, deaths, sleep, frames, units, P1 } from "trigscript";
program(() => { while (true) { setDeaths(P1, units.TerranMarine, "add", 1); sleep(frames(1)); } });
const calls: string[] = [];
describe("counting", () => {
  beforeEach((sim) => { sim.frames(3); calls.push("before"); });
  afterEach(() => { calls.push("after"); });
  test("starts from the hook", (sim) => { expect(sim.deaths(P1, units.TerranMarine)).toBe(3); expect(calls).toEqual(["before"]); });
  describe("deeper", () => {
    beforeEach((sim) => { sim.frames(2); });
    it("runs the outer hook first", (sim) => { expect(sim.deaths(P1, units.TerranMarine)).toBe(5); expect(calls).toEqual(["before", "after", "before"]); });
  });
  test.skip("not now", () => { throw new Error("never runs"); });
  test.each([[1, 4], [10, 13]])("after %i more frames there are %i", (sim, more, total) => { sim.frames(more); expect(sim.deaths(P1, units.TerranMarine)).toBe(total); });
});`;
  it("describe, the hooks, skip and each", () => {
    const r = run(SCRIPT);
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(outcome(r)).toEqual({
      "counting > starts from the hook": "passed", "counting > deeper > runs the outer hook first": "passed", "counting > not now": "skipped",
      "counting > after 1 more frames there are 4": "passed", "counting > after 10 more frames there are 13": "passed",
    });
    expect(r.tests!.list.filter((t) => t.kind === "suite").map((t) => [t.name, t.path])).toEqual([["counting", []], ["deeper", ["counting"]]]);
  });
  it("only narrows its own file, and is said", () => {
    const r = run({
      "main.ts": `import { test } from "trigscript";\nimport "./other";\ntest("a", () => {});\ntest.only("b", () => {});`,
      "other.ts": `import { test } from "trigscript";\ntest("c", () => {});`,
    });
    expect(outcome(r)).toEqual({ a: "skipped", b: "passed", c: "passed" });
    expect(r.tests!.only).toEqual([{ file: "main.ts", line: 4 }]);
  });
  it("runs only what is asked for", () => {
    expect(Object.keys(outcome(run(SCRIPT, { world: WORLD, ids: ["main.ts::counting > deeper"] })))).toEqual(["counting > deeper > runs the outer hook first"]);
    expect(Object.keys(outcome(run(SCRIPT, { world: WORLD, files: ["other.ts"] })))).toEqual([]);
  });
  it("are imported, never globals: a script's own test() is its own", () => {
    const r = run(`function test(n: number) { return n + 1; }\ntrigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "set", test(1))]);`);
    expect([r.diagnostics.map((d) => d.message), r.triggers.length, r.tests]).toEqual([[], 1, null]);
  });
});

describe("test files", () => {
  const MAIN = `import { program, sleep, frames } from "trigscript";\nexport const double = (n: number) => n * 2;\nprogram(() => { let ticks = 0; while (true) { ticks += 1; sleep(frames(1)); } }, { name: "clock" });`;
  it("run after the entry, in any folder, and import the script's own functions", () => {
    const r = run({
      "main.ts": MAIN,
      "tests/clock.test.ts": `import { test, expect } from "trigscript";\nimport { double } from "../main";\ntest("ticks", (sim) => { sim.frames(7); expect(sim.program("clock").ticks).toBe(7); });\ntest("plain TypeScript", () => { expect(double(21)).toBe(42); });`,
    });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(r.tests!.results.map((t) => [t.id, t.status])).toEqual([["tests/clock.test.ts::ticks", "passed"], ["tests/clock.test.ts::plain TypeScript", "passed"]]);
    expect(r.ir).toHaveLength(1);
  });
  it("are never part of the build: not imported from one that is, and no program() or trigger() inside", () => {
    const imported = run({ "main.ts": `${MAIN}\nimport "./x.test";`, "x.test.ts": `export const n = 1;` });
    expect(imported.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/x\.test\.ts is a test file/)]);
    const declares = run({ "main.ts": MAIN, "x.test.ts": `import { trigger, always, victory, P1 } from "trigscript";\ntrigger(P1, [always()], [victory()]);` });
    expect(declares.diagnostics.map((d) => [d.file, d.line, d.message])).toEqual([["x.test.ts", 2, expect.stringMatching(/trigger\(\) in a test file/)]]);
  });
});

describe("sim", () => {
  it("keys, chat, the mouse; records, arrays and texts read back; one player a world", () => {
    const r = run(`import { test, expect, program, keyPressed, chatted, sleep, frames, minerals, setResources, CurrentPlayer, P1, P2, units, type Location } from "trigscript";
program(() => {
  let pos = { x: 1, y: 2 }; let seen = [0, 0, 0]; let label = "none"; let gold = 0;
  while (true) {
    if (keyPressed(CurrentPlayer, "F2")) { pos.x += 10; seen[1] = 7; label = \`pressed \${pos.x}\`; }
    const give = chatted(CurrentPlayer, "-give {n}");
    if (give) { setResources(CurrentPlayer, "add", give.n, "ore"); }
    gold = minerals(CurrentPlayer);
    sleep(frames(1));
  }
}, { owner: [P1, P2], name: "input" });
test("as the first player", (sim) => {
  sim.press("F2").frames(1);
  expect(sim.program("input").pos).toEqual({ x: 11, y: 2 });
  expect(sim.program("input").seen).toEqual([0, 7, 0]);
  expect(sim.program("input").label).toBe("pressed 11");
  sim.type("-give 250").frames(2);
  expect(sim.resources(P1)).toEqual({ ore: 250, gas: 0 });
  expect(sim.program("input").gold).toBe(250);
  expect(sim.program("input").nothing).toBeUndefined();
});
test("as the second", { as: P2 }, (sim) => {
  sim.type("-give 40").frames(2);
  expect(sim.resources(P2).ore).toBe(40);
  expect(sim.resources(P1).ore).toBe(0);
});
test("no such program", (sim) => { sim.program("waves"); });`);
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(outcome(r)).toEqual({ "as the first player": "passed", "as the second": "passed", "no such program": expect.stringMatching(/There is no program named "waves".*Named: input/) });
  });

  it("several players in one world, with the map's player settings", () => {
    const r = run(`import { test, expect, program, sleep, frames, createUnit, shared, CurrentPlayer, AllPlayers, units, P1, P2, P3, type Location } from "trigscript";
program(() => { let mine = 0; let all = shared(0); while (true) { mine += 1; all += 1; if (mine === 2) createUnit(CurrentPlayer, units.TerranMarine, 1, 1 as Location); sleep(frames(1)); } }, { owner: AllPlayers, name: "each" });
test("each player has a run of their own", (sim) => {
  sim.frames(3);
  expect([sim.program("each", P1).mine, sim.program("each", P3).mine]).toEqual([3, 3]);
  expect(sim.count(AllPlayers, units.TerranMarine)).toBe(2);
  expect(() => sim.program("each", P2)).toThrow(/runs for P2/);
  const [marine] = sim.units({ owner: P3 });
  sim.kill(marine, P1);
  expect([sim.deaths(P3, units.TerranMarine), sim.kills(P1, units.TerranMarine), marine.alive]).toEqual([1, 1, false]);
});`, { world: { ...WORLD, players: [0, 2], forces: { 0: 0, 2: 1 } } });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(outcome(r)).toEqual({ "each player has a run of their own": "passed" });
  });

  it("random() is the same every run, and seed() makes it another", () => {
    const script = (seed: string) => `import { test, expect, program, random, sleep, frames } from "trigscript";
program(() => { let sum = 0; while (true) { sum = sum * 7 + random(1000); sleep(frames(1)); } }, { name: "dice" });
test("rolls", (sim) => { ${seed} sim.frames(5); expect(sim.program("dice").sum).toBe(-1); });`;
    const got = (r: CompileResult) => r.tests!.results[0].actual;
    expect(got(run(script("")))).toBe(got(run(script(""))));
    expect(got(run(script("sim.seed(9);")))).not.toBe(got(run(script(""))));
  });
});
