/**
 * `test()`: a script's own tests, run in the simulator. A test is ordinary TypeScript that
 * runs where the script ran — never in the game — after a compile that went through. The
 * names are Vitest's (`test`, `describe`, `beforeEach`, `afterEach`, `test.only`,
 * `test.skip`, `test.each`, `expect`), imported from `"trigscript"`; what is the script's
 * own is `sim`, the world the test is handed: the map's placed units and locations, the
 * compiled programs at frame 0 and the `trigger()` records beside them, `random()` seeded
 * with the same number every time.
 *
 * Registering is one half (`TestRegistry`, filled while the script runs: a `test()` costs
 * the map nothing), running the other (`runTests`). Each test gets a world of its own. A
 * test fails by an `expect` that does not hold, by anything it throws, by an `until` that
 * never comes true, and by a fault of the simulator it did not ask for (an index past an
 * array's end, the stack's depth, the heap full). Nothing here touches the DOM, and what
 * `runTests` returns is plain data: it crosses from the compile worker to the editor.
 */
import { ActionType, type ActionRecord, type TriggerRecord } from "../vendor/triggers";
import { actionDef } from "../vendor/triggerDefs";
import type { TestCost } from "./gameCost";
import type { At, Program } from "./ir";
import type { ScriptString } from "./runtime";
import { Simulation } from "./simulate";
import { FRAMES_PER_SECOND, ProgramSimulation } from "./simulateIr";
import type { SimBounds, SimUnit, SimUnitInit, SimUnitProperties } from "./world";

/* ── What is registered ── */

type Mode = "run" | "skip" | "only";
type TestFn = (sim: TestWorldLike, ...args: unknown[]) => unknown;
type Hook = (sim: TestWorldLike) => unknown;
interface Where { file: string; line: number; column?: number }

interface Suite {
  kind: "suite";
  name: string;
  at: Where;
  mode: Mode;
  parent: Suite | null;
  children: (Suite | Case)[];
  before: Hook[];
  after: Hook[];
}
interface Case {
  kind: "test";
  name: string;
  at: Where;
  mode: Mode;
  parent: Suite;
  fn: TestFn;
  args: unknown[];
  /** `{ as: P2 }`: the player the world is simulated as, when the map's player settings are not given. */
  as?: number;
  /** `{ players: [P1, P2] }`: in the game, a copy of it for each, kept in step. */
  players?: number[];
}

/** A test or a `describe`, as the editor lists it. `id` is the file and the names down to it: the same from one compile to the next. */
export interface TestInfo {
  id: string;
  kind: "suite" | "test";
  name: string;
  /** The `describe`s it is inside, outermost first. */
  path: string[];
  file: string;
  line: number;
  mode: Mode;
  /** A test's `{ players }`: run in the game as a copy for each. */
  players?: number[];
}

export interface TestEvent { frame: number; text: string; file?: string; line?: number; player: number }

export interface TestResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  /** One line: "expected 8, got 6". */
  message?: string;
  /** The two values in full, when an `expect` compared two. */
  expected?: string;
  actual?: string;
  /** Where it failed: the `expect`'s line, the line that threw, or the program's line a fault happened at. */
  at?: Where;
  /** What was shown to the players, in order. */
  printed: string[];
  /** Everything that happened, by frame. */
  events: TestEvent[];
  frames: number;
  ms: number;
  /** In the lifted game: what the test's frames cost, by frame and by line (TrigScript 4, A4). */
  cost?: TestCost;
}

export interface TestReport {
  list: TestInfo[];
  /** Empty when the tests were only listed. */
  results: TestResult[];
  /** A `test.only` or `describe.only` is in the script: the rest of its file did not run. */
  only: Where[];
  ms: number;
}

/** The world every test starts from, as plain data. */
export interface TestWorld {
  units?: SimUnitInit[];
  locations?: Record<number, SimBounds>;
  players?: number[];
  forces?: Record<number, number>;
  /** The computer players among `players`: a Transmission of theirs does nothing. */
  computers?: number[];
  /** By unit type. */
  unitStats?: Record<number, { hp?: number; shields?: number; energy?: number }>;
  /** Create Unit with Properties slots, the first at 0. */
  properties?: (SimUnitProperties | null)[];
  heapCells?: number;
  stackDepth?: number;
  /** Unit types by their name in lower case, for a `{…:unit}` typed in chat. */
  unitNames?: Record<string, number>;
}

export interface TestRunOptions {
  world?: TestWorld;
  /**
   * A world other than the simulator's for each test (the lifted game's, `GameSim`): made fresh for every test,
   * given the player the test asked to be (`{ as: P2 }`). Absent: the simulator.
   */
  makeWorld?: (as?: number, test?: { id: string; players?: number[] }) => TestWorldLike;
  /** Run only these: tests of these files, or with these ids (a suite's id runs what is under it). Absent: all. */
  files?: string[];
  ids?: string[];
}

/** What a failing test throws from `expect`. */
export class ExpectError extends Error {
  expected?: string;
  actual?: string;
  constructor(message: string, expected?: string, actual?: string) {
    super(message);
    this.name = "ExpectError";
    this.expected = expected;
    this.actual = actual;
  }
}

const DEFAULT_SEED = 0x5eed;
const UNTIL_FRAMES = 2400;
export const isTestFile = (path: string) => /\.test\.ts$/i.test(path);

/** Filled while the script runs. `where` says which line of the script is calling — read from the stack, so `test.each` and a helper of the script's that calls `test` are found too. */
export class TestRegistry {
  readonly root: Suite = { kind: "suite", name: "", at: { file: "", line: 0 }, mode: "run", parent: null, children: [], before: [], after: [] };
  private current = this.root;
  /** Set for the length of a run of tests: a `test()` reached then would register into nothing that runs. */
  running = false;
  where: () => Where = () => ({ file: "", line: 0 });

  get empty(): boolean { return this.root.children.length === 0; }

  private guard(what: string): void {
    if (this.running) throw new Error(`${what} inside a test: a test is declared when the script runs, not while another is running.`);
  }

  private addTest(mode: Mode, name: unknown, a: unknown, b: unknown, args: unknown[] = []): void {
    this.guard("test()");
    if (typeof name !== "string" || !name) throw new Error("test(name, (sim) => { … }): the name is a text.");
    const fn = typeof a === "function" ? a : b;
    const options = typeof a === "function" ? undefined : a;
    if (typeof fn !== "function") throw new Error(`test("${name}"): the second argument is the test's function, (sim) => { … }.`);
    if (fn.constructor?.name === "AsyncFunction") throw new Error(`test("${name}"): a test is not async. Nothing in sim waits: sim.frames(n) and sim.until(…) have run by the time they return.`);
    const as = options && typeof options === "object" && typeof (options as { as?: unknown }).as === "number" ? (options as { as: number }).as : undefined;
    const given = options && typeof options === "object" ? (options as { players?: unknown }).players : undefined;
    if (given !== undefined && !(Array.isArray(given) && given.length >= 2 && given.length <= 8 && given.every((p) => Number.isInteger(p) && p >= 0 && p < 8) && new Set(given).size === given.length))
      throw new Error(`test("${name}", { players }): two to eight different players of P1 to P8, as [P1, P2].`);
    const players = given as number[] | undefined;
    this.current.children.push({ kind: "test", name, at: this.where(), mode, parent: this.current, fn: fn as TestFn, args, ...(as !== undefined ? { as } : {}), ...(players ? { players: [...players] } : {}) });
  }

  private addSuite(mode: Mode, name: unknown, body: unknown): void {
    this.guard("describe()");
    if (typeof name !== "string" || !name) throw new Error("describe(name, () => { … }): the name is a text.");
    if (typeof body !== "function") throw new Error(`describe("${name}"): the second argument is a function that declares the tests.`);
    const suite: Suite = { kind: "suite", name, at: this.where(), mode, parent: this.current, children: [], before: [], after: [] };
    this.current.children.push(suite);
    const outer = this.current;
    this.current = suite;
    try { (body as () => void)(); } finally { this.current = outer; }
  }

  /** `%s`, `%d`, `%i`, `%j` and `%o` take the row's values in turn, `$name` a field of a row that is an object; a name with neither gets the row's number. */
  private static title(name: string, row: unknown[], index: number): string {
    let i = 0;
    let used = false;
    let out = name.replace(/%([sdijo%])/g, (_m, c: string) => { if (c === "%") return "%"; used = true; const v = row[i++]; return c === "j" || c === "o" ? JSON.stringify(v) : String(v); });
    const first = row[0];
    if (first && typeof first === "object") out = out.replace(/\$([A-Za-z_][\w]*)/g, (m, k: string) => { if (!(k in (first as object))) return m; used = true; return String((first as Record<string, unknown>)[k]); });
    return used ? out : `${out} (${index + 1})`;
  }

  /** The functions a script imports. */
  library(): Record<string, unknown> {
    const each = (mode: Mode, suite: boolean) => (rows: unknown) => (name: unknown, fn: unknown) => {
      if (!Array.isArray(rows)) throw new Error("each([…]): the cases are a list.");
      rows.forEach((row, i) => {
        const args = Array.isArray(row) ? row : [row];
        const title = TestRegistry.title(String(name), args, i);
        if (suite) this.addSuite(mode, title, () => (fn as (...a: unknown[]) => void)(...args));
        else this.addTest(mode, title, fn, undefined, args);
      });
    };
    const test = Object.assign((name: unknown, a: unknown, b?: unknown) => this.addTest("run", name, a, b), {
      only: Object.assign((name: unknown, a: unknown, b?: unknown) => this.addTest("only", name, a, b), { each: each("only", false) }),
      skip: Object.assign((name: unknown, a: unknown, b?: unknown) => this.addTest("skip", name, a, b), { each: each("skip", false) }),
      each: each("run", false),
    });
    const describe = Object.assign((name: unknown, body: unknown) => this.addSuite("run", name, body), {
      only: Object.assign((name: unknown, body: unknown) => this.addSuite("only", name, body), { each: each("only", true) }),
      skip: Object.assign((name: unknown, body: unknown) => this.addSuite("skip", name, body), { each: each("skip", true) }),
      each: each("run", true),
    });
    const hook = (list: "before" | "after", what: string) => (fn: unknown) => {
      this.guard(`${what}()`);
      if (typeof fn !== "function") throw new Error(`${what}((sim) => { … }) takes a function.`);
      this.current[list].push(fn as Hook);
    };
    return { test, it: test, describe, beforeEach: hook("before", "beforeEach"), afterEach: hook("after", "afterEach"), expect };
  }
}

/** The names `library()` gives: a script imports them, they are not globals (a script may well have a `test` of its own). */
export const TESTING_NAMES = ["test", "it", "describe", "beforeEach", "afterEach", "expect"] as const;

/* ── The world a test is handed ── */

/** What every world a test may be handed carries: the simulator's (`TestSim`) and the lifted game's (`GameSim`). */
export const WORLD = Symbol.for("trigscript.world");
export const isWorld = (v: unknown): v is TestWorldLike => typeof v === "object" && v !== null && (v as { [WORLD]?: unknown })[WORLD] === true;

/** What a test can ask of its world, whichever it was handed. */
export interface TestWorldLike {
  readonly [WORLD]: true;
  /** What the test's frames cost, where the world counts it (the lifted game's). */
  cost?(): TestCost | null;
  faultsExpected: boolean;
  readonly frame: number;
  seed(n: number): this;
  frames(n?: number): this;
  seconds(n: number): this;
  until(done: () => unknown, most?: number): this;
  place(player: number, type: number, at: number, n?: number): SimUnit[];
  kill(unit: SimUnit, by?: number): this;
  remove(unit: SimUnit): this;
  give(unit: SimUnit, to: number): this;
  morph(unit: SimUnit, type: number): this;
  move(unit: SimUnit, to: number | { x: number; y: number }): this;
  press(key: string, player?: number): this;
  click(button?: "left" | "right" | "middle", player?: number): this;
  type(line: string, player?: number): this;
  moveMouse(x: number, y: number, player?: number): this;
  moveCamera(x: number, y: number, player?: number): this;
  count(player: number, type: number, at?: number): number;
  units(filter?: { owner?: number; type?: number; at?: number }): SimUnit[];
  resources(player: number): { ore: number; gas: number };
  deaths(player: number, type: number): number;
  kills(player: number, type: number): number;
  switch(n: number): boolean;
  fog(player: number, area?: { x: number; y: number; width: number; height: number }): string[] | null;
  location(n: number): SimBounds | undefined;
  program(name?: string | number, player?: number): Record<string, unknown>;
  printed(player?: number): string[];
  log(sourceOf?: (trigger: number) => Where | null): TestEvent[];
  readonly events: TestEvent[];
  readonly faults: { at: At; message: string; cycle: number; frame: number; program: number }[];
}

/* ── expect ── */

const show = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") return "a function";
  if (v instanceof RegExp) return String(v);
  if (isWorld(v)) return "sim";
  try { return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x === undefined ? "undefined" : x)) ?? String(v); } catch { return String(v); }
};
const brief = (v: unknown): string => { const s = show(v); return s.length > 60 ? `${s.slice(0, 57)}…` : s; };

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function expect(actual: unknown) {
  const make = (not: boolean) => {
    /** `holds` is the matcher's answer; `what` finishes "expected …". */
    const check = (holds: boolean, what: string, expected?: unknown) => {
      if (holds !== not) return;
      const got = isWorld(actual) ? "" : `, got ${brief(actual)}`;
      throw new ExpectError(`expected ${not ? "not " : ""}${what}${got}`, expected === undefined ? undefined : show(expected), isWorld(actual) ? undefined : show(actual));
    };
    const number = (name: string): number => { if (typeof actual !== "number") throw new ExpectError(`${name}: ${brief(actual)} is not a number`); return actual; };
    const sim = (name: string): TestWorldLike => { if (!isWorld(actual)) throw new ExpectError(`${name} is asked of the world: expect(sim).${name}(…)`); return actual; };
    return {
      toBe: (e: unknown) => check(Object.is(actual, e), brief(e), e),
      toEqual: (e: unknown) => check(same(actual, e), brief(e), e),
      toBeTruthy: () => check(!!actual, "something true"),
      toBeFalsy: () => check(!actual, "something false"),
      toBeNull: () => check(actual === null, "null"),
      toBeDefined: () => check(actual !== undefined, "a value"),
      toBeUndefined: () => check(actual === undefined, "undefined"),
      toBeGreaterThan: (n: number) => check(number("toBeGreaterThan") > n, `more than ${n}`, n),
      toBeGreaterThanOrEqual: (n: number) => check(number("toBeGreaterThanOrEqual") >= n, `${n} or more`, n),
      toBeLessThan: (n: number) => check(number("toBeLessThan") < n, `less than ${n}`, n),
      toBeLessThanOrEqual: (n: number) => check(number("toBeLessThanOrEqual") <= n, `${n} or less`, n),
      toContain: (e: unknown) => check(typeof actual === "string" ? actual.includes(String(e)) : Array.isArray(actual) && actual.some((x) => same(x, e)), `something that contains ${brief(e)}`, e),
      toHaveLength: (n: number) => check((actual as { length?: number } | null)?.length === n, `a length of ${n}`, n),
      toMatch: (e: RegExp | string) => check(typeof actual === "string" && (typeof e === "string" ? actual.includes(e) : e.test(actual)), `a text that matches ${brief(e)}`, e),
      toThrow: (e?: RegExp | string) => {
        if (typeof actual !== "function") throw new ExpectError("toThrow is asked of a function: expect(() => …).toThrow()");
        let thrown: unknown;
        let threw = false;
        try { (actual as () => unknown)(); } catch (err) { threw = true; thrown = err; }
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        check(threw && (e === undefined || (typeof e === "string" ? message.includes(e) : e.test(message))), e === undefined ? "the function to throw" : `the function to throw ${brief(e)}`);
      },
      /** A text shown to a player: all of it, or a pattern it matches. `to`: only what that player was shown. */
      toHavePrinted: (e: RegExp | string, options?: { to?: number }) => {
        const lines = sim("toHavePrinted").printed(options?.to);
        if (lines.some((l) => (typeof e === "string" ? l === e || l.includes(e) : e.test(l))) !== not) return;
        throw new ExpectError(`expected ${not ? "nothing" : "something"} printed that matches ${brief(e)}; printed: ${lines.length ? lines.map((l) => JSON.stringify(l)).join(", ") : "nothing"}`, show(e), show(lines));
      },
      /** The simulator said a program did what is always a mistake; asking for it is what lets a test go on past it. */
      toHaveFaulted: (e?: RegExp | string) => {
        const s = sim("toHaveFaulted");
        s.faultsExpected = true;
        const messages = s.faults.map((f) => f.message);
        if (messages.some((m) => (e === undefined ? true : typeof e === "string" ? m.includes(e) : e.test(m))) !== not) return;
        throw new ExpectError(`expected ${not ? "no" : "a"} fault${e === undefined ? "" : ` that matches ${brief(e)}`}; faults: ${messages.length ? messages.join(" | ") : "none"}`, e === undefined ? undefined : show(e), show(messages));
      },
    };
  };
  return { ...make(false), not: make(true) };
}

/* ── sim ── */

const mulberry = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The world a test is handed: the simulator's. */
export class TestSim implements TestWorldLike {
  readonly [WORLD] = true as const;
  /** Set by `expect(sim).toHaveFaulted`: the faults are the test's business, and do not fail it by themselves. */
  faultsExpected = false;
  private rng = mulberry(DEFAULT_SEED);
  private readonly world: Simulation;
  private readonly programs: ProgramSimulation;

  constructor(triggers: TriggerRecord[], ir: Program[], strings: ScriptString[], options: TestWorld, as?: number) {
    const random = () => this.rng();
    const stats = options.unitStats ?? {};
    // A script with a program is built with eudTurbo: the list runs every frame. Without one, on the game's own schedule.
    this.world = new Simulation(triggers, {
      everyFrame: ir.length > 0,
      strings, random, units: options.units, locations: options.locations,
      players: options.players, forces: options.forces, computers: options.computers, unitStats: (type) => stats[type],
      properties: (slot) => options.properties?.[slot - 1] ?? undefined,
      ...(as !== undefined ? { player: as } : options.players ? {} : { player: ir[0]?.owner !== undefined && ir[0].owner < 12 ? ir[0].owner : undefined }),
    });
    const names = options.unitNames ?? {};
    this.programs = new ProgramSimulation(ir, { world: this.world, strings, random, heapCells: options.heapCells, stackDepth: options.stackDepth, unitStats: (type) => stats[type], unitByName: (lower) => names[lower] });
  }

  /** How many frames have run: the game's frame number. */
  get frame(): number { return this.world.frame; }

  /** `random()` from this number on: the same run every time. Before anything that draws one. */
  seed(n: number): this { this.rng = mulberry(n >>> 0); return this; }

  /* ── time ── */

  frames(n = 1): this {
    // The programs run inside the game's passes, as the build runs them.
    for (let i = 0; i < n; i++) if (this.world.tick()) this.programs.step();
    return this;
  }
  seconds(n: number): this { return this.frames(Math.round(n * FRAMES_PER_SECOND)); }
  /** Frames until `done()` is true: asked before the first and after each. The test fails when `most` frames pass. */
  until(done: () => unknown, most = UNTIL_FRAMES): this {
    for (let i = 0; ; i++) {
      if (done()) return this;
      if (i >= most) throw new ExpectError(`until: still not true after ${most} frames`);
      this.frames(1);
    }
  }

  /* ── what the test does to the world ── */

  /** Units of a type for a player at a location's centre; they are given back. */
  place(player: number, type: number, at: number, n = 1): SimUnit[] {
    const { x, y } = this.world.game.centreOf(at);
    const made: SimUnit[] = [];
    for (let i = 0; i < n; i++) { const u = this.world.game.create(type, player, x, y); if (u) made.push(u); }
    return made;
  }
  /** What a fight is in a test. `by`: the player the kill is counted for. */
  kill(unit: SimUnit, by?: number): this { this.world.game.gone(unit, true, by); return this; }
  remove(unit: SimUnit): this { this.world.game.gone(unit, false); return this; }
  give(unit: SimUnit, to: number): this { if (unit.alive) unit.owner = to; return this; }
  /** A unit turns into another type and stays the same unit: the new type's hit points and shields, in the same part of them. */
  morph(unit: SimUnit, type: number): this {
    if (!unit.alive) return this;
    const s = this.world.game.stats(type) ?? {};
    const maxHp = Math.max(1, s.hp ?? unit.maxHp), maxShields = Math.max(0, s.shields ?? 0);
    unit.hp = Math.max(1, Math.round((unit.hp * maxHp) / Math.max(1, unit.maxHp)));
    unit.shields = unit.maxShields ? Math.round((unit.shields * maxShields) / unit.maxShields) : maxShields;
    Object.assign(unit, { type, maxHp, maxShields });
    return this;
  }
  /** A unit to a location's centre, or to a point. */
  move(unit: SimUnit, to: number | { x: number; y: number }): this {
    const p = typeof to === "number" ? this.world.game.centreOf(to) : to;
    if (unit.alive) { unit.x = p.x; unit.y = p.y; }
    return this;
  }

  /* ── what the players do ── */

  press(key: string, player?: number): this { this.programs.press(key, player); return this; }
  click(button: "left" | "right" | "middle" = "left", player?: number): this { this.programs.click(button, player); return this; }
  type(line: string, player?: number): this { this.programs.type(line, player); return this; }
  moveMouse(x: number, y: number, player?: number): this { this.programs.moveMouse(x, y, player); return this; }
  moveCamera(x: number, y: number, player?: number): this { this.programs.moveCamera(x, y, player); return this; }

  /* ── the world read back ── */

  private owners(player: number): number[] { return this.world.game.players.of(player, this.world.player); }
  count(player: number, type: number, at?: number): number { return this.world.game.matching(this.owners(player), type, at).length; }
  /** The units on the map, in the order of the game's unit table. */
  units(filter: { owner?: number; type?: number; at?: number } = {}): SimUnit[] {
    return this.world.game.matching(filter.owner === undefined ? undefined : this.owners(filter.owner), filter.type, filter.at);
  }
  resources(player: number): { ore: number; gas: number } {
    const [ore, gas] = this.programs.resourcesOf(player);
    return { ore, gas };
  }
  deaths(player: number, type: number): number { return this.world.death(player, type); }
  kills(player: number, type: number): number { return this.world.game.kills(this.owners(player), type); }
  switch(n: number): boolean { return this.world.switches[n] === 1; }
  /** The fog of war as the simulator draws it: of the units a program set the sight of (simulateIr.ts, fog). */
  fog(player: number, area?: { x: number; y: number; width: number; height: number }): string[] | null { return this.programs.fog(player, area); }
  /** Where a location is now. */
  location(n: number): SimBounds | undefined { const b = this.world.game.locations.get(n); return b ? { ...b } : undefined; }

  /**
   * A program's variables by the names in the source: numbers, booleans, texts, arrays, a
   * record as an object, a unit (null for none). The program by its name (its `name`
   * option) or its place in the script; of a per-player program, `player`'s. A name the
   * program does not have is undefined.
   */
  program(name: string | number = 0, player?: number): Record<string, unknown> {
    const run = this.programs.runOf(name, player);
    if (!run) {
      const known = [...new Set(this.programs.runs.map((r) => r.program.name).filter(Boolean))];
      throw new Error(typeof name === "number" ? `There is no program ${name}: the script has ${new Set(this.programs.runs.map((r) => r.index)).size}.` : `There is no program named "${name}"${player !== undefined ? ` that runs for P${player + 1}` : ""}. ${known.length ? `Named: ${known.join(", ")}.` : "A program is named by its option: program(() => { … }, { name: \"waves\" })."}`);
    }
    return new Proxy({}, { get: (_, key) => (typeof key === "string" ? run.lookup(key) : undefined), has: (_, key) => typeof key === "string" && run.lookup(key) !== undefined });
  }

  /** What was shown, in order: to everybody, or what one player saw. */
  printed(player?: number): string[] {
    const shown = (to: number, runner: number) => player === undefined || this.world.game.players.of(to, runner).includes(player);
    const lines: { frame: number; order: number; text: string }[] = [];
    this.world.events.forEach((e, i) => { if (e.action.type === ActionType.DisplayText && e.text !== undefined && shown(e.action.player || 13, e.player)) lines.push({ frame: e.frame, order: i, text: e.text }); });
    this.programs.events.forEach((e, i) => { if (e.action.type === ActionType.DisplayText && e.text !== undefined && shown(e.action.player || 13, e.player)) lines.push({ frame: e.frame, order: this.world.events.length + i, text: e.text }); });
    return lines.sort((a, b) => a.frame - b.frame || a.order - b.order).map((l) => l.text);
  }

  /** Everything that happened, by frame. `sourceOf` says where a trigger came from. */
  log(sourceOf: (trigger: number) => Where | null = () => null): TestEvent[] {
    const out: (TestEvent & { order: number })[] = [];
    // As Simulate says it: the action by its name, and its text when it has one.
    const say = (action: ActionRecord, text?: string) => { const name = actionDef(action.type)?.name ?? `Action ${action.type}`; return text !== undefined ? `${name} — ${text}` : name; };
    this.world.events.forEach((e, i) => { const at = sourceOf(e.trigger); out.push({ frame: e.frame, order: i, player: e.player, text: say(e.action, e.text), ...(at ? { file: at.file, line: at.line } : {}) }); });
    this.programs.events.forEach((e, i) => out.push({ frame: e.frame, order: this.world.events.length + i, player: e.player, text: say(e.action, e.text), file: e.at.file, line: e.at.line }));
    return out.sort((a, b) => a.frame - b.frame || a.order - b.order).map(({ order: _order, ...e }) => e);
  }
  get events(): TestEvent[] { return this.log(); }
  get faults(): { at: At; message: string; cycle: number; frame: number; program: number }[] { return this.programs.faults; }
}

/* ── Running ── */

export interface TestContext {
  triggers: TriggerRecord[];
  sources: ({ file: string; line: number } | null)[];
  ir: Program[];
  strings: ScriptString[];
  /** Where in the script an error came from, from its stack. */
  locate(err: unknown): Where | null;
}

const idOf = (node: Suite | Case): string => {
  const names: string[] = [];
  for (let n: Suite | Case | null = node; n && n.parent; n = n.parent) names.unshift(n.name);
  return `${node.at.file}::${names.join(" > ")}`;
};

/** The tests as the editor lists them; two of one name in one place get a number. */
export function listTests(registry: TestRegistry): { list: TestInfo[]; cases: Map<string, Case> } {
  const list: TestInfo[] = [];
  const cases = new Map<string, Case>();
  const seen = new Map<string, number>();
  const walk = (suite: Suite, path: string[]) => {
    for (const node of suite.children) {
      let id = idOf(node);
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id} #${n}`;
      list.push({ id, kind: node.kind, name: node.name, path, file: node.at.file, line: node.at.line, mode: node.mode, ...(node.kind === "test" && node.players ? { players: node.players } : {}) });
      if (node.kind === "suite") walk(node, [...path, node.name]);
      else cases.set(id, node);
    }
  };
  walk(registry.root, []);
  return { list, cases };
}

export function runTests(registry: TestRegistry, ctx: TestContext, options: TestRunOptions): TestReport {
  const started = Date.now();
  const { list, cases } = listTests(registry);
  const only = list.filter((t) => t.mode === "only").map((t) => ({ file: t.file, line: t.line }));
  // As Vitest: an `only` narrows its own file, and says nothing of the others.
  const narrowed = new Set(only.map((o) => o.file));
  const results: TestResult[] = [];
  registry.running = true;
  try {
    for (const info of list) {
      const test = cases.get(info.id);
      if (!test) continue;
      if (options.files && !options.files.includes(info.file)) continue;
      if (options.ids && !options.ids.some((id) => info.id === id || info.id.startsWith(`${id} > `))) continue;
      const chain: Suite[] = [];
      for (let s: Suite | null = test.parent; s; s = s.parent) chain.unshift(s);
      const skipped = test.mode === "skip" || chain.some((s) => s.mode === "skip") || (narrowed.has(info.file) && test.mode !== "only" && !chain.some((s) => s.mode === "only"));
      if (skipped) { results.push({ id: info.id, status: "skipped", printed: [], events: [], frames: 0, ms: 0 }); continue; }
      results.push(runOne(info.id, test, chain, ctx, options.world ?? {}, options.makeWorld));
    }
  } finally {
    registry.running = false;
  }
  return { list, results, only, ms: Date.now() - started };
}

function costOf(sim: TestWorldLike | null): { cost?: TestCost } {
  const cost = sim?.cost?.();
  return cost ? { cost } : {};
}

function runOne(id: string, test: Case, chain: Suite[], ctx: TestContext, world: TestWorld, makeWorld?: TestRunOptions["makeWorld"]): TestResult {
  const began = Date.now();
  let sim: TestWorldLike | null = null;
  const done = (extra: Partial<TestResult>): TestResult => ({
    id, status: "passed", printed: sim?.printed() ?? [], events: (sim?.log((t) => ctx.sources[t] ?? null) ?? []).slice(0, 500), frames: sim?.frame ?? 0, ms: Date.now() - began, ...costOf(sim), ...extra,
  });
  try {
    sim = makeWorld ? makeWorld(test.as, { id, players: test.players }) : new TestSim(ctx.triggers, ctx.ir, ctx.strings, world, test.as);
    for (const s of chain) for (const h of s.before) h(sim);
    const returned = test.fn(sim, ...test.args);
    if (returned && typeof (returned as { then?: unknown }).then === "function") throw new Error("A test is not async: what it returned is a promise. Nothing in sim waits.");
    for (const s of [...chain].reverse()) for (const h of s.after) h(sim);
    // What is always a mistake fails the test that did not ask for it.
    const fault = sim.faultsExpected ? undefined : sim.faults[0];
    if (fault) return done({ status: "failed", message: `${fault.message} (frame ${fault.frame})`, at: { file: fault.at.file, line: fault.at.line, column: fault.at.column } });
    return done({});
  } catch (err) {
    const at = ctx.locate(err) ?? test.at;
    const message = err instanceof Error ? err.message : String(err);
    return done({ status: "failed", message, at, ...(err instanceof ExpectError ? { expected: err.expected, actual: err.actual } : {}) });
  }
}
