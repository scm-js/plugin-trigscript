/**
 * TrigScript 4, slice B2: events. `on.created`, `on.died`, `on.killed`, `on.order`, `on.morphed`, `on.chat` and `on.key` are each a task that, from the next
 * frame on, runs its handler for every time the thing happens: the units come from the frame's events pass (a loop with
 * a `source` in the IR), the lines and keys from what chatted() and keyPressed() read. The interpreter here;
 * `eud-build.test.ts` builds the same through eudplib, and `probes/game-events.ts` runs it in the game.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation, type SimUnitInit } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";
import type { Stmt } from "../compiler/ir";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const MARINE = 0, ZERGLING = 37;
const raw = (body: string, options = ""): CompileResult => compileScript(ts, { "main.ts": `const HOME = 1 as Location;\nprogram(async () => {${body}}${options ? `, ${options}` : ""});` }, NAMES, { lib: LIB });
const compile = (body: string, options = ""): CompileResult => { const r = raw(body, options); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const messages = (body: string): string[] => raw(body).diagnostics.map((d) => d.message);
const WORLD: SimUnitInit[] = [
  { type: MARINE, owner: 0, x: 100, y: 100, hp: 40 },
  { type: ZERGLING, owner: 7, x: 120, y: 110, hp: 35 },
];
const LOCATIONS = { 1: { left: 0, top: 0, right: 256, bottom: 256 } };
const sim = (r: CompileResult) => new ProgramSimulation(r.ir, { strings: r.strings, units: WORLD, locations: LOCATIONS, players: [0, 1], unitStats: () => ({ hp: 40 }) });
/** What was shown, as "frame:text". */
const printed = (s: ProgramSimulation): string[] => s.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`);

describe("events: the front end", () => {
  it("on.created is a task whose loop goes through the units the frame's pass found", () => {
    const r = compile(`on.created(units.ZergZergling, (u) => { u.energy = 50; });`);
    const start = r.ir[0].body[0] as Extract<Stmt, { kind: "start" }>;
    expect(start).toMatchObject({ kind: "start", max: 1, call: { name: "on.created()" } });
    expect(start.call.body[0]).toMatchObject({ kind: "while", body: [{ kind: "sleep", cycles: 1 }, { kind: "unitLoop", source: "created", filter: { type: ZERGLING } }] });
  });

  it("what is wrong is said", () => {
    expect(messages(`on.created((u) => {});`)).toEqual([]);
    expect(raw(`});\nprogram(() => { on.died((u) => {}); `).diagnostics.map((d) => d.message)).toContain("on.died() listens beside the program as a task: at the top of a script, or inside program(async () => { … }).");
    expect(messages(`on.created(units.ZergZergling);`)[0]).toContain("is not assignable");
    expect(messages(`on.key("F6", (p) => {});`)[0]).toContain("F6");
    expect(messages(`on.created((u) => {}, { max: 4 });`)[0]).toContain("max is for an async handler");
    expect(messages(`on.chat("-x", (p) => {}, { from: P9 });`)[0]).toContain("from is one player");
  });
});

describe("events: in the simulator", () => {
  it("on.created runs in the frame after a unit is made, for the ones the filter matches; the map's own units are not new", () => {
    const r = compile(`
      on.created(units.ZergZergling, (u) => { print(\`made \${u.owner} \${u.hp}\`); });
      await sleep(frames(2));
      createUnit(P8, units.ZergZergling, 2, HOME);
      createUnit(P1, units.TerranMarine, 1, HOME);`);
    const s = sim(r).run(5);
    expect(printed(s)).toEqual(["3:made 7 40", "3:made 7 40"]);
  });

  it("on.died hands what the unit was and where, as it died, to a handler that may wait", () => {
    const r = compile(`
      on.died({ owner: P8 }, async (u) => { print(\`gone \${u.type} at \${u.x}\`); await sleep(frames(3)); createUnit(u.owner, u.type, 1, HOME); print("back"); });
      await sleep(frames(1));
      for (const u of unitsOf(P8)) u.kill();`);
    const s = sim(r).run(8);
    expect(printed(s)).toEqual([`2:gone ${ZERGLING} at 120`, "5:back"]);
    expect(s.game.living().filter((u) => u.owner === 7)).toHaveLength(1);
  });

  it("a unit made and gone between two passes is neither made nor dead; each death is handed once", () => {
    const r = compile(`
      let made = 0, died = 0;
      on.created((u) => { made++; });
      on.died((u) => { died++; });
      await sleep(frames(1));
      createUnit(P1, units.TerranMarine, 3, HOME);
      for (const u of unitsOf(P1, { type: units.TerranMarine })) u.remove();
      await sleep(frames(1));
      createUnit(P1, units.TerranMarine, 1, HOME);
      await sleep(frames(2));
      for (const u of unitsOf(P1)) u.kill();
      await sleep(frames(3));
      print(\`\${made} \${died}\`);`);
    expect(printed(sim(r).run(10))).toEqual(["7:1 2"]);
  });

  it("cancel() stops listening", () => {
    const r = compile(`
      const t = on.created((u) => { print("seen"); });
      await sleep(frames(1));
      t.cancel();
      createUnit(P1, units.TerranMarine, 1, HOME);`);
    expect(printed(sim(r).run(4))).toEqual([]);
  });

  it("on.chat and on.key: every player, the player known in the handler", () => {
    const r = compile(`
      on.chat("-give {n}", (p, { n }) => { setResources(p, "add", n, "ore"); print(\`gave \${n}\`, { to: p }); });
      on.key("F7", (p) => print("help", { to: p }), { from: P2 });`);
    const s = sim(r);
    s.run(2).type("-give 25", 1).press("F7", 1).press("F7", 0).run(1);
    expect(printed(s)).toEqual(["2:gave 25", "2:help"]);
    expect(s.events.filter((e) => e.action.type === ActionType.SetResources).map((e) => e.action.player)).toEqual([1]);
  });
});

describe("events, second part: killed, order, morphed, at the top of a script", () => {
  it("on.killed hands a death in a fight, with its killer; a trigger's kill and a removal are not handed on", () => {
    const r = compile(`
      on.killed((u, by) => { print(\`killed \${u.type} by \${by}\`); });
      on.killed({ by: P2 }, (u) => { print(\`P2 got \${u.owner}\`); });
      on.died((u) => { print(\`died \${u.type}\`); });
      await sleep(frames(1));
      for (const u of unitsOf(P1)) u.kill();`);
    const s = sim(r).run(1);
    // Between frames 0 and 1 the zergling dies in a fight, P2's kill (the test's kill(unit, by)); in frame 1 the program
    // kills the marine, which the pass of frame 2 finds.
    s.game.gone(s.game.living().find((u) => u.type === ZERGLING)!, true, 1);
    s.run(3);
    expect(printed(s)).toEqual([`1:killed ${ZERGLING} by 1`, "1:P2 got 7", `1:died ${ZERGLING}`, `2:died ${MARINE}`]);
  });

  it("a unit killed by its own player has no killer, as the game keeps none", () => {
    const r = compile(`on.killed((u, by) => print(\`killed by \${by}\`)); on.died(() => print("died"));`);
    const s = sim(r).run(1);
    s.game.gone(s.game.living().find((u) => u.type === ZERGLING)!, true, 7);
    s.run(2);
    expect(printed(s)).toEqual(["1:died"]);
  });

  it("the action order() is not the event on.order: its arguments are worked out when the script is built", () => {
    // (It was refused inside a program — "A call's arguments must be known" — the event's name taken for the action's.)
    const r = compile(`order(P1, units.TerranMarine, HOME, HOME, "attack"); const u = first({ owner: P1 }); if (u) u.order("move", HOME);`);
    const [action, , test] = r.ir[0].body as Stmt[];
    expect(action).toMatchObject({ kind: "action", record: { type: ActionType.Order, modifier: 2, location: 1, target: 1 } });
    expect(test).toMatchObject({ kind: "if", then: [{ kind: "unitDo", verb: { do: "order", order: "move" } }] });
  });

  it("on.order hands the unit, the order it took up and the one it had; a filter on the order", () => {
    const r = compile(`
      on.order((u, order, was) => { print(\`\${u.type} \${was} -> \${order}\`); });
      on.order(units.TerranMarine, orders.Patrol, (u) => { print("patrol"); });
      on.order({ order: orders.Move }, (u, order) => { print(\`moving \${order}\`); });
      await sleep(frames(1));
      for (const u of unitsOf(P1)) u.order("move", HOME);
      await sleep(frames(2));
      for (const u of unitsOf(P1)) u.order("patrol", HOME);`);
    expect(printed(sim(r).run(6))).toEqual([`2:${MARINE} 3 -> 6`, "2:moving 6", `4:${MARINE} 6 -> 152`, "4:patrol"]);
  });

  it("on.morphed hands the unit as it is now and the type it was; the filter is of the new type", () => {
    const r = compile(`
      on.morphed((u, was) => { print(\`\${was} -> \${u.type}\`); });
      on.morphed(units.TerranSiegeTankSiegeMode, (u) => { print("sieged"); });`);
    const s = sim(r).run(2);
    s.game.living().find((u) => u.type === MARINE)!.type = 30;
    s.run(1);
    expect(printed(s)).toEqual([`2:${MARINE} -> 30`, "2:sieged"]);
  });

  it("a listener at the top of a script listens from the start, as a program of its own", () => {
    const r = compileScript(ts, { "main.ts": `const HOME = 1 as Location;
on.created(units.ZergZergling, (u) => { print(\`made \${u.owner}\`); });
on.chat("-hi", (p) => print("hello", { to: p }));
program(async () => { await sleep(frames(2)); createUnit(P8, units.ZergZergling, 1, HOME); });` }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(r.ir).toHaveLength(3);
    const s = sim(r).run(2);
    s.type("-hi", 0).run(2);
    expect(printed(s)).toEqual(["2:hello", "3:made 7"]);
  });

  it("what is wrong is said", () => {
    expect(messages(`on.order(units.TerranMarine, 999, (u) => {});`)[0]).toContain("on.order() takes the order after the filter");
    expect(messages(`on.killed({ by: P9 }, (u) => {});`)[0]).toContain("by is the player who killed the unit");
    // (TypeScript says it first: 'by' does not exist in type 'UnitFilter'.)
    expect(messages(`on.died({ by: P2 }, (u) => {});`).join("\n")).toContain("'by' does not exist");
    expect(messages(`on.morphed({ order: orders.Move }, (u) => {});`).join("\n")).toContain("'order' does not exist");
    expect(messages(`on.order({ order: orders.Move }, orders.Patrol, (u) => {});`).join("\n")).toContain("'order' does not exist");
  });
});
