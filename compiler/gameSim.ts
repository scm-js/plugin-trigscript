/**
 * The world a test is handed when it runs in the lifted game (TrigScript 4, A2): `sim` as the simulator's `TestSim`
 * has it, but every frame is the game's own and every read is the game's memory. It drives a `GameHandle`, which
 * whatever hosts the game supplies (scm-sim's `src/exact/testGame.ts`); nothing here imports the game.
 *
 * What a test does to the world goes through the game's own trigger actions, run between frames as the player's
 * trigger would run them: Create Unit for `place`, and for one unit Kill, Remove, Give or Move with a location
 * centred on it (the last of the map's 255, put back afterwards). A typed line is the game's chat command; a key and
 * the mouse are the local machine's memory, where MSQC reads them.
 *
 * A program's variables (`program()`) are read where the build said they are (`gameVariables.ts`), when it was asked
 * to say. Not in the game yet, and said so when asked: what another player was shown. A program's fault is the red
 * line it prints ("TrigScript: …"), its line not known.
 */
import { ActionType } from "../vendor/triggers";
import type { At } from "./ir";
import { msqcKey } from "./input";
import { programVariables, type VariableMap } from "./gameVariables";
import type { CostLines, GameCostTap, TestCost } from "./gameCost";
import { ExpectError, WORLD, type TestEvent, type TestWorldLike } from "./testing";
import type { SimBounds, SimUnit } from "./world";

/** What a host of the lifted game hands a test (scm-sim's `TestGameHandle`). */
export interface GameHandle {
  readonly m: DataView;
  readonly u8: Uint8Array;
  readonly frame: number;
  readonly localPlayer: number;
  readonly over: boolean;
  step(): void;
  lines(): { frame: number; text: string }[];
  action(record: Uint8Array, player: number): number;
  chat(text: string): void;
  call(address: number, registers: Record<string, number>, args?: number[]): number;
  reset(): void;
  /** What each frame of the map's triggers ran (TrigScript 4, A4), when the host counts it; `reset()` clears it. */
  readonly cost?: GameCostTap;
  /** Where eudplib's payload ends in the game's memory, when the host knows: with the build's map of triggers, each record's line. */
  readonly payloadEnd?: number;
  /** When the game is one of several copies kept in step, a copy for each of a test's players (scm-sim's `CopyHandle`). */
  readonly copy?: GameCopy;
  /**
   * Told after the test wrote the game's memory itself between frames (a key, the mouse, a scratch location, hit
   * points), when the handle listens: the debugger (A5) keeps every such write, to play the run again to a frame.
   */
  wrote?(address: number, length: number): void;
}

/** One copy of several (TrigScript 4, A3): which, the slot each copy plays, and where they stopped agreeing. */
export interface GameCopy {
  readonly index: number;
  readonly copies: number;
  readonly players: readonly number[];
  readonly desync: Desync | null;
  label: string | null;
  linesOf(slot: number): { frame: number; text: string }[] | null;
}
export interface Desync {
  frame: number;
  /** Each copy's frame, when they were not even at the same one. */
  apart: number[] | null;
  differences: { what: string; values: (number | null)[] }[];
  /** By copy: the lines that wrote what differs in the turn before, and those that read the local machine's own memory. */
  wrote: string[][];
  readLocal: string[][];
  players: number[];
  /** eudplib's payload, watched: dwords that had come to differ before the split, from which frame, by copy. */
  watched?: { address: number; since: number; values: (number | null)[] }[];
}

/** The script's variables by the address of their cells (`program.name` or `program #k.name`), from the build's map. */
export function variableNames(map: VariableMap | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const p of map?.programs ?? []) {
    const program = p.name ? p.name : `program #${p.index}`;
    for (const v of p.vars) for (const [cell, at] of Object.entries(v.cells)) if (at !== null && at !== undefined) {
      const name = `${v.id.replace(/#\d+$/, "")}${cell === "value" ? "" : ` (${cell})`}`;
      if (v.rowed) for (let k = 0; k < 12; k++) out.set(at + 4 * k, `${name} of P${k + 1}, in ${program}`);
      else out.set(at, `${name}, in ${program}`);
    }
    for (const a of p.arrays) if (a.at !== null && a.at !== undefined && !a.dynamic) {
      const cells = a.length * (a.rowed ? 12 : 1);
      const id = a.id.replace(/#\d+$/, "");
      for (let i = 0; i < cells && i < 4096; i++) out.set(a.at + 4 * i, `${id}[${a.rowed ? `${Math.floor(i / 12)}] of P${(i % 12) + 1}` : `${i}]`}, in ${program}`);
    }
  }
  return out;
}

/** "12:5" → "line 12"; "lib.ts:3:1" → "lib.ts line 3"; anything else as it is. */
const lineWords = (origin: string) => origin.replace(/(?:^|(?<= ))(?:([^\s:]+):)?(\d+):\d+(?= |$)/g, (_m, file: string | undefined, line: string) => `${file ? `${file} ` : ""}line ${line}`);

/**
 * A desync in words: what differs, where, what each computer's triggers did in the turn before, and which of the
 * script's variables had already come apart (`names`: by the address of their cells).
 */
export function desyncMessage(d: Desync, names: Map<number, string> = new Map()): string {
  const who = (c: number) => `P${d.players[c] + 1}'s computer`;
  if (d.apart) return `the players' games stopped agreeing: they were at different frames (${d.apart.map((f, c) => `${f} at ${who(c)}`).join(", ")})`;
  const first = d.differences[0];
  const what = first ? `${first.what} is ${first.values.map((v, c) => `${v ?? "?"} at ${who(c)}`).join(", ")}` : "their state differs";
  const more = d.differences.length > 1 ? ` (and ${d.differences.length - 1} more)` : "";
  const notes = d.players.map((_, c) => {
    const said = [...d.wrote[c] ?? [], ...d.readLocal[c] ?? []].map(lineWords);
    return said.length ? ` At ${who(c)}: ${said.slice(0, 4).join("; ")}.` : "";
  }).join("");
  const known = (d.watched ?? []).filter((w) => names.has(w.address));
  const theirs = (d.watched ?? []).length - known.length;
  const before = known.length
    ? ` Before that, the script's ${known.slice(0, 3).map((w) => `${names.get(w.address)} from frame ${w.since} (${w.values.map((v, c) => `${v ?? "?"} at ${who(c)}`).join(", ")})`).join("; ")}${known.length > 3 ? ` and ${known.length - 3} more` : ""} had come apart.`
    : "";
  const own = theirs ? ` (${theirs} of eudplib's own cells differed too; some are each computer's own on purpose.)` : "";
  return `the players' games stopped agreeing at frame ${d.frame}: ${what}${more}.${notes}${before}${own}`;
}

// 1.16.1's addresses, which Remastered's emulation keeps.
const UNITS = 0x59cca8, UNIT_BYTES = 336, UNIT_COUNT = 1700, FIRST_UNIT = 0x628430;
const ORE = 0x57f0f0, GAS = 0x57f120, DEATHS = 0x58a364, KILLS = 0x5878a4, SWITCHES = 0x58dc40, LOCATIONS = 0x58dc60;
const MAX_HP = 0x662350, MAX_SHIELDS = 0x660e00, KEYS = 0x596a18, BUTTONS = 0x6cddc0, MOUSE = 0x6cddc4;
const SCRATCH = 255, SCRATCH_TO = 254;
/** The routine a unit that dies in the game goes through to be counted: its owner's death, the killer's kill (0x488AF0). */
const COUNT_DEATH = 0x488af0;
const BUTTON_BITS = { left: 2, right: 8, middle: 32 } as const;
const FRAMES_PER_SECOND = 24, UNTIL_FRAMES = 2400;

/** The frame from which the game's own locations are the map's (eudplib has put them right by then). */
export const LOCATIONS_READY = 2;

function readLocation(game: GameHandle, n: number): SimBounds | undefined {
  const m = game.m, at = LOCATIONS + 20 * (n - 1);
  const b = { left: m.getUint32(at, true), top: m.getUint32(at + 4, true), right: m.getUint32(at + 8, true), bottom: m.getUint32(at + 12, true) };
  return b.right > b.left || b.bottom > b.top ? b : undefined;
}

/**
 * The map's locations as the game holds them once eudplib has put them right: played to `LOCATIONS_READY` and put
 * back to frame 0. For `GameSim`'s `locations`, and for the simulator's world of the same map.
 */
export function readLocations(game: GameHandle): Record<number, SimBounds> {
  game.reset();
  while (game.frame < LOCATIONS_READY && !game.over) game.step();
  const out: Record<number, SimBounds> = {};
  for (let n = 1; n <= 255; n++) { const b = readLocation(game, n); if (b) out[n] = b; }
  game.reset();
  return out;
}

/** Each unit type's hit points and shields as the game's tables have them: the simulator's `unitStats` for the same map. */
export function readUnitStats(game: GameHandle): Record<number, { hp: number; shields: number }> {
  const out: Record<number, { hp: number; shields: number }> = {};
  for (let t = 0; t < 228; t++) out[t] = { hp: Math.floor(game.m.getInt32(MAX_HP + 4 * t, true) / 256), shields: game.m.getUint16(MAX_SHIELDS + 2 * t, true) };
  return out;
}

/** The virtual key MSQC's name for a key stands for. */
function virtualKey(key: string): number {
  const k = msqcKey(key);
  if (/^[A-Z0-9]$/.test(k)) return k.charCodeAt(0);
  if (/^F([1-9]|1[0-2])$/.test(k)) return 0x6f + Number(k.slice(1));
  if (/^NUMPAD[0-9]$/.test(k)) return 0x60 + Number(k.slice(6));
  const named: Record<string, number> = { SPACE: 0x20, ENTER: 0x0d, ESC: 0x1b, TAB: 0x09, SHIFT: 0x10, LCTRL: 0x11, LALT: 0x12, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, BACK: 0x08, DELETE: 0x2e, INSERT: 0x2d, HOME: 0x24, END: 0x23, PGUP: 0x21, PGDN: 0x22 };
  if (k in named) return named[k];
  throw new ExpectError(`press: "${key}" is not a key the game reports`);
}

/** A line as a player reads it: the game's colour codes and eudplib's padding (carriage returns) taken out. */
const clean = (text: string) => text.replace(/[\x01-\x1f]/g, "");

/** A unit as the game holds it: every property read from its slot while it is the same unit, its last value after. */
class GameUnit implements SimUnit {
  readonly slot: number;
  readonly uid: number;
  private readonly at: number;
  private last: Partial<SimUnit> = {};
  private readonly game: GameHandle;
  constructor(game: GameHandle, slot: number) {
    this.game = game;
    this.slot = slot;
    this.at = UNITS + UNIT_BYTES * slot;
    this.uid = game.u8[this.at + 0xa5];
  }
  get alive(): boolean {
    const { m, u8 } = this.game;
    return u8[this.at + 0xa5] === this.uid && m.getUint32(this.at + 0x0c, true) !== 0 && u8[this.at + 0x4d] !== 0;
  }
  private read<K extends keyof SimUnit>(key: K, f: () => SimUnit[K]): SimUnit[K] {
    if (this.alive) (this.last as Record<string, unknown>)[key] = f();
    return (this.last[key] ?? 0) as SimUnit[K];
  }
  private get m() { return this.game.m; }
  private flag(bit: number): boolean { return (this.m.getUint32(this.at + 0xdc, true) & bit) !== 0; }
  get type() { return this.read("type", () => this.m.getUint16(this.at + 0x64, true)); }
  get owner() { return this.read("owner", () => this.game.u8[this.at + 0x4c]); }
  get x() { return this.read("x", () => this.m.getInt16(this.at + 0x28, true)); }
  get y() { return this.read("y", () => this.m.getInt16(this.at + 0x2a, true)); }
  get hp() { return this.read("hp", () => Math.ceil(this.m.getInt32(this.at + 0x08, true) / 256)); }
  set hp(v: number) { if (this.alive) { this.m.setInt32(this.at + 0x08, Math.max(0, v) * 256, true); this.game.wrote?.(this.at + 0x08, 4); } }
  get maxHp() { return Math.floor(this.m.getInt32(MAX_HP + 4 * this.type, true) / 256); }
  get shields() { return this.read("shields", () => Math.floor(this.m.getInt32(this.at + 0x60, true) / 256)); }
  get maxShields() { return this.m.getUint16(MAX_SHIELDS + 2 * this.type, true); }
  get energy() { return this.read("energy", () => Math.floor(this.m.getUint16(this.at + 0xa2, true) / 256)); }
  get kills() { return this.read("kills", () => this.game.u8[this.at + 0x8f]); }
  get orderId() { return this.read("orderId", () => this.game.u8[this.at + 0x4d]); }
  get cooldown() { return this.read("cooldown", () => this.game.u8[this.at + 0x55]); }
  get resources() { return this.read("resources", () => this.m.getUint16(this.at + 0xd0, true)); }
  get invincible() { return this.read("invincible", () => this.flag(0x04000000)); }
  get cloaked() { return this.read("cloaked", () => this.flag(0x00000300)); }
  get burrowed() { return this.read("burrowed", () => this.flag(0x00000010)); }
  get hallucinated() { return this.read("hallucinated", () => this.flag(0x40000000)); }
  // Not read from the game yet: the spell timers and whether the unit is under attack.
  stim = 0; ensnare = 0; plague = 0; lockdown = 0; maelstrom = 0; irradiate = 0; stasis = 0; underAttack = false;
}

export class GameSim implements TestWorldLike {
  readonly [WORLD] = true as const;
  faultsExpected = false;
  private shown: { frame: number; text: string }[] = [];
  private readonly units_ = new Map<number, GameUnit>();
  private readonly game: GameHandle;
  private readonly known: Record<number, SimBounds>;
  private readonly variables: VariableMap | null;
  private readonly costLines: CostLines | null;

  /**
   * `locations`: the map's locations as the script means them. eudplib keeps them scrambled in the game until its
   * first frames put them right (frame 2 on a probe's map), so a test that acts at frame 0 needs them from elsewhere
   * (`readLocations`); from then on the game's own are read. `variables`: where the build put each program's
   * variables, for `program()`.
   */
  constructor(game: GameHandle, options: { locations?: Record<number, SimBounds>; variables?: VariableMap | null; test?: { id: string; players?: number[] }; costLines?: CostLines | null } = {}) {
    this.game = game;
    this.costLines = options.costLines ?? null;
    this.known = options.locations ?? {};
    this.variables = options.variables ?? null;
    if (game.copy) {
      game.copy.label = options.test?.id ?? null;
      for (const p of game.copy.players) if (p !== game.localPlayer) this.shownBy.set(p, []);
    }
    game.reset();
    this.take();
  }

  /** In a test of several players: what each other player's computer showed, by slot. */
  private readonly shownBy = new Map<number, { frame: number; text: string }[]>();
  private take(): void {
    for (const l of this.game.lines()) this.shown.push(l);
    for (const [p, list] of this.shownBy) for (const l of this.game.copy!.linesOf(p) ?? []) list.push(l);
  }
  /** The copies stopped agreeing: the test fails here, at every computer alike. */
  private checkStep(): void {
    const d = this.game.copy?.desync;
    if (d) throw new ExpectError(desyncMessage(d, this.names ??= variableNames(this.variables)));
  }
  private names: Map<number, string> | null = null;
  private record(type: number, fields: { location?: number; player?: number; number?: number; unit?: number; count?: number }): Uint8Array {
    const r = new Uint8Array(32), v = new DataView(r.buffer);
    v.setUint32(0x00, fields.location ?? 0, true);
    v.setUint32(0x10, fields.player ?? 0, true);
    v.setUint32(0x14, fields.number ?? 0, true);
    v.setUint16(0x18, fields.unit ?? 0, true);
    r[0x1a] = type;
    r[0x1b] = fields.count ?? 0;
    r[0x1c] = 0x04; // (always display: the flag every action the editor writes carries)
    return r;
  }
  private act(record: Uint8Array, player: number): void { this.game.action(record, player); this.take(); }

  get frame(): number { return this.game.frame; }
  seed(_n: number): this { return this; }
  /** What the test's frames cost in the game, by line; null when the host does not count it or the build gave no map of triggers. */
  cost(): TestCost | null { return this.costLines && this.game.cost ? this.costLines.read(this.game.cost) : null; }

  /* ── time ── */

  frames(n = 1): this {
    for (let i = 0; i < n && !this.game.over; i++) { this.game.step(); this.take(); this.releaseKeys(); this.checkStep(); }
    return this;
  }
  seconds(n: number): this { return this.frames(Math.round(n * FRAMES_PER_SECOND)); }
  until(done: () => unknown, most = UNTIL_FRAMES): this {
    for (let i = 0; ; i++) {
      if (done()) return this;
      if (i >= most) throw new ExpectError(`until: still not true after ${most} frames`);
      this.frames(1);
    }
  }

  /* ── what the test does to the world ── */

  private slots(): Set<number> {
    const out = new Set<number>(), m = this.game.m;
    for (let p = m.getUint32(FIRST_UNIT, true), guard = 0; p && guard < UNIT_COUNT; p = m.getUint32(p + 0x04, true), guard++) out.add((p - UNITS) / UNIT_BYTES);
    return out;
  }
  private unit(slot: number): GameUnit {
    const u8 = this.game.u8, uid = u8[UNITS + UNIT_BYTES * slot + 0xa5];
    const was = this.units_.get(slot);
    if (was && was.uid === uid) return was;
    const u = new GameUnit(this.game, slot);
    this.units_.set(slot, u);
    return u;
  }

  /**
   * `run(location)` with a scratch location set to `b` — its four sides, and its elevation flags cleared (a flag
   * left set keeps the units of that elevation out of it, and at frame 0 they are eudplib's scrambled bits) — then
   * put back as it was, all twenty bytes.
   */
  private scratch<T>(n: number, b: SimBounds, run: (location: number) => T): T {
    const u8 = this.game.u8, m = this.game.m, at = LOCATIONS + 20 * (n - 1), was = u8.slice(at, at + 20);
    [b.left, b.top, b.right, b.bottom].forEach((v, i) => m.setUint32(at + 4 * i, Math.max(0, v), true));
    m.setUint16(at + 0x12, 0, true);
    this.game.wrote?.(at, 20);
    try { return run(n); } finally { u8.set(was, at); this.game.wrote?.(at, 20); }
  }
  private within255<T>(b: SimBounds, run: (location: number) => T): T { return this.scratch(SCRATCH, b, run); }
  place(player: number, type: number, at: number, n = 1): SimUnit[] {
    const where = this.location(at);
    if (!where) throw new ExpectError(`place: there is no location ${at}`);
    const before = this.slots();
    this.within255(where, (loc) => this.act(this.record(ActionType.CreateUnit, { location: loc, player, unit: type, count: Math.min(255, n) }), player));
    return [...this.slots()].filter((s) => !before.has(s)).map((s) => this.unit(s)).filter((u) => u.type === type && u.owner === player);
  }
  /** One unit, by the scratch location centred on it for one action. */
  private onOne(unit: SimUnit, run: (location: number) => void): this {
    if (unit.alive) this.within255({ left: unit.x - 1, top: unit.y - 1, right: unit.x + 1, bottom: unit.y + 1 }, run);
    return this;
  }
  /**
   * What a fight is in a test, as `TestSim` has it: the unit dies and counts as its owner's death, and as a kill of
   * `by`'s. The game's Kill Unit counts nothing (only a death in a fight does), so the game's own routine that counts
   * one is called first, the unit and the killer handed to it as the game hands them, then the unit is killed.
   */
  kill(unit: SimUnit, by?: number): this {
    if (!unit.alive) return this;
    this.game.call(COUNT_DEATH, { edi: UNITS + UNIT_BYTES * unit.slot, edx: by ?? unit.owner, ecx: 0 });
    // A killer named is a death in a fight, as the game leaves one behind: no hit points, and the killer the last player
    // whose attack hurt the unit (+0x90), which is what on.killed() reads.
    if (by !== undefined) {
      const at = UNITS + UNIT_BYTES * unit.slot;
      this.game.m.setInt32(at + 0x08, 0, true); this.game.u8[at + 0x90] = by;
      this.game.wrote?.(at + 0x08, 4); this.game.wrote?.(at + 0x90, 1);
    }
    return this.onOne(unit, (loc) => this.act(this.record(ActionType.KillUnitAt, { location: loc, player: unit.owner, unit: unit.type, count: 1 }), unit.owner));
  }
  remove(unit: SimUnit): this {
    return this.onOne(unit, (loc) => this.act(this.record(ActionType.RemoveUnitAt, { location: loc, player: unit.owner, unit: unit.type, count: 1 }), unit.owner));
  }
  morph(): this { throw new ExpectError("morph: the lifted game turns a unit into another type only through a player's command, which a test cannot give yet; test on.morphed() in the simulator."); }
  give(unit: SimUnit, to: number): this {
    return this.onOne(unit, (loc) => this.act(this.record(ActionType.GiveUnits, { location: loc, player: unit.owner, number: to, unit: unit.type, count: 1 }), unit.owner));
  }
  move(unit: SimUnit, to: number | { x: number; y: number }): this {
    // (The destination through a second scratch location, so that a location still scrambled at frame 0 is not used.)
    const b = typeof to === "number" ? this.location(to) : { left: to.x, top: to.y, right: to.x, bottom: to.y };
    if (!b) throw new ExpectError(`move: there is no location ${String(to)}`);
    return this.scratch(SCRATCH_TO, b, (dest) => this.onOne(unit, (loc) => this.act(this.record(ActionType.MoveUnit, { location: loc, player: unit.owner, number: dest, unit: unit.type, count: 1 }), unit.owner)));
  }

  /* ── what the players do: at their own computer ── */

  private held: number[] = [];
  /**
   * Whether what `player` does is done here. One game: only the player at this computer can act. Copies of a game
   * (a test's `players`): each player acts at their own copy, and no player named is the first of them.
   */
  private local(player: number | undefined, what: string): boolean {
    const copy = this.game.copy;
    if (!copy) {
      if (player !== undefined && player !== this.game.localPlayer) throw new ExpectError(`${what}: in the game only the player at this computer (P${this.game.localPlayer + 1}) can do it; a test of several players says so: test(…, { players: [P1, P${player + 1}] }, …)`);
      return true;
    }
    const who = player ?? copy.players[0];
    if (!copy.players.includes(who)) throw new ExpectError(`${what}: P${who + 1} is not one of this test's players (${copy.players.map((p) => `P${p + 1}`).join(", ")})`);
    return who === this.game.localPlayer;
  }
  /** A key down for one frame, as a press is (MSQC sees it down, then up). */
  press(key: string, player?: number): this { const k = virtualKey(key); if (!this.local(player, "press")) return this; this.game.u8[KEYS + k] = 1; this.game.wrote?.(KEYS + k, 1); this.held.push(k); return this; }
  click(button: "left" | "right" | "middle" = "left", player?: number): this {
    if (!this.local(player, "click")) return this;
    const m = this.game.m;
    m.setUint32(BUTTONS, m.getUint32(BUTTONS, true) | BUTTON_BITS[button], true);
    this.game.wrote?.(BUTTONS, 4);
    this.held.push(-BUTTON_BITS[button]);
    return this;
  }
  private releaseKeys(): void {
    if (!this.held.length) return;
    const m = this.game.m;
    for (const k of this.held.splice(0)) {
      if (k >= 0) { this.game.u8[KEYS + k] = 0; this.game.wrote?.(KEYS + k, 1); }
      else { m.setUint32(BUTTONS, m.getUint32(BUTTONS, true) & ~-k, true); this.game.wrote?.(BUTTONS, 4); }
    }
  }
  type(line: string, player?: number): this { if (this.local(player, "type")) this.game.chat(line); return this; }
  moveMouse(x: number, y: number, player?: number): this {
    if (!this.local(player, "moveMouse")) return this;
    this.game.m.setUint16(MOUSE, x, true);
    this.game.m.setUint16(MOUSE + 2, y, true);
    this.game.wrote?.(MOUSE, 4);
    return this;
  }

  /* ── the world read back ── */

  private owners(player: number): number[] {
    if (player < 12) return [player];
    if (player === 13) return [this.game.localPlayer];
    if (player === 17) return Array.from({ length: 12 }, (_, i) => i);
    throw new ExpectError(`player ${player}: only one player, Current Player or All Players are read in the game yet`);
  }
  private within(u: SimUnit, at: number): boolean {
    const b = this.location(at);
    return !!b && u.x >= b.left && u.x <= b.right && u.y >= b.top && u.y <= b.bottom;
  }
  units(filter: { owner?: number; type?: number; at?: number } = {}): SimUnit[] {
    const owners = filter.owner === undefined ? null : this.owners(filter.owner);
    return [...this.slots()].sort((a, b) => a - b).map((s) => this.unit(s))
      .filter((u) => (owners === null || owners.includes(u.owner)) && (filter.type === undefined || u.type === filter.type) && (filter.at === undefined || this.within(u, filter.at)));
  }
  count(player: number, type: number, at?: number): number { return this.units({ owner: player, type, at }).length; }
  resources(player: number): { ore: number; gas: number } {
    const m = this.game.m;
    return { ore: m.getUint32(ORE + 4 * player, true), gas: m.getUint32(GAS + 4 * player, true) };
  }
  deaths(player: number, type: number): number { return this.game.m.getUint32(DEATHS + 4 * (player + 12 * type), true); }
  kills(player: number, type: number): number { return this.owners(player).reduce((n, p) => n + this.game.m.getUint32(KILLS + 4 * (p + 12 * type), true), 0); }
  switch(n: number): boolean { return ((this.game.u8[SWITCHES + (n >> 3)] >> (n & 7)) & 1) === 1; }
  location(n: number): SimBounds | undefined {
    if (n < 1 || n > 255) return undefined;
    if (this.game.frame < LOCATIONS_READY) return this.known[n] ? { ...this.known[n] } : undefined;
    return readLocation(this.game, n);
  }
  program(name: string | number = 0, player?: number): Record<string, unknown> {
    if (!this.variables) throw new ExpectError("sim.program(…): the build did not say where the programs' variables are, so the game cannot be read for them");
    return programVariables({ m: this.game.m, u8: this.game.u8, unitAt: (ptr, uid) => this.unitAt(ptr, uid) }, this.variables, name, player);
  }
  /** The unit a variable holds: by its pointer, while its slot still has the uniqueness byte the variable kept with it. */
  private unitAt(ptr: number, uid: number): SimUnit | null {
    const slot = (ptr - UNITS) / UNIT_BYTES;
    if (!Number.isInteger(slot) || slot < 0 || slot >= UNIT_COUNT || this.game.u8[ptr + 0xa5] !== ((uid >>> 8) & 0xff)) return null;
    const u = this.unit(slot);
    return u.alive ? u : null;
  }

  /** What was shown, in order, with the game's colour codes taken out. `player`: only the player at this computer is seen. */
  printed(player?: number): string[] {
    if (player === undefined) {
      // (A line every computer showed at once is one line, as the simulator has it.)
      const seen = new Set<string>();
      return this.everyone().filter((l) => { const k = `${l.frame}\u0000${l.text}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((l) => clean(l.text));
    }
    if (player === this.game.localPlayer) return this.shown.map((l) => clean(l.text));
    const theirs = this.shownBy.get(player);
    if (theirs) return theirs.map((l) => clean(l.text));
    throw new ExpectError(this.game.copy
      ? `printed(P${player + 1}): P${player + 1} is not one of this test's players (${this.game.copy.players.map((p) => `P${p + 1}`).join(", ")})`
      : `printed(P${player + 1}): in the game only what the player at this computer (P${this.game.localPlayer + 1}) was shown is seen; a test of several players sees each one's: test(…, { players: [P1, P${player + 1}] }, …)`);
  }
  /** Every player's lines, by frame (one game: the local player's). */
  private everyone(): { frame: number; text: string; player?: number }[] {
    const all = [...this.shown.map((l) => ({ ...l, player: this.game.localPlayer })), ...[...this.shownBy].flatMap(([player, list]) => list.map((l) => ({ ...l, player })))];
    return all.sort((a, b) => a.frame - b.frame || a.player - b.player);
  }
  log(): TestEvent[] { return this.everyone().map((l) => ({ frame: l.frame, text: `Display Text Message — ${clean(l.text)}`, player: l.player ?? this.game.localPlayer })); }
  get events(): TestEvent[] { return this.log(); }
  /** A program's faults, as it says them in the game: a red line that begins "TrigScript:". */
  get faults(): { at: At; message: string; cycle: number; frame: number; program: number }[] {
    return this.shown.filter((l) => /^\W*TrigScript: /.test(l.text)).map((l) => ({ at: { file: "", line: 0, column: 0 } as At, message: clean(l.text).replace(/^TrigScript: /, ""), cycle: 0, frame: l.frame, program: 0 }));
  }
}
