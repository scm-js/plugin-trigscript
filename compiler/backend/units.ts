/**
 * Units on a map of our own (TrigScript 4, step 10 of the way off eudplib). A unit of the game is a record of the game's
 * unit table — 1 700 places of 336 bytes — and `unitValues` rewrites a program's IR before the emitter sees it, so that
 * every unit is two numbers of the program's: the EPD of its record (0: none), which a condition's player field and a
 * Set Deaths' destination take as they are, and the uniqueness byte its place had when the unit was taken. The game
 * gives a dead unit's place to the next unit made, so a unit kept in a variable is checked before each use — the place
 * has a sprite, its order is not Die, its uniqueness byte is the one kept — in one trigger of four conditions; a field is
 * then read through the current player pointed at it, a bit at a time from the highest group of eight it reaches, or
 * written with a masked Set Deaths. The Python side's `UnitRef` and `when_alive`, with the pointer left out: it is the
 * EPD times four plus the deaths table.
 *
 * A loop over units and a pick walk the table in the order the game hands its places out — place 0, then 1 699 down —
 * the units oldest first (the Python side's `scan`), down to the lowest place the game has ever handed out (`scan`
 * says why that is enough). The walk is a loop of the program's, two places a turn where it can be, its filter one
 * trigger whose conditions read the place a variable is at.
 *
 * What it does not take — a unit an event gives (step 11), a pick near the mouse and the selection read (step 12) —
 * it leaves as it was, for the emitter to refuse in a script's words.
 */
import type { ArrayDecl, At, BoolExpr, Call, CompareOp, FuncDecl, NumExpr, Program, Stmt, UnitExpr, UnitFilter, UnitFlag, UnitNumField, VarDecl } from "../ir";
import type { ActionRecord, ConditionRecord } from "../../vendor/triggers";
import { STATEMENT_KINDS } from "./emit";
import { MOUSE_CELLS } from "./input";

/** The deaths table: what a condition's or an action's player field 0 is, an EPD a dword after it. */
const DEATHS = 0x58a364;
const epd = (address: number): number => (address - DEATHS) / 4;
/** The game's unit table: where its first place is (as an EPD), how far apart the places are (in dwords), how many. */
const UNIT_TABLE = epd(0x59cca8), STRIDE = 336 / 4, PLACES = 1700;
/** Where the current player is kept. */
const CURRENT = epd(0x6509b0);
/** The game's locations: 20 bytes each, from 1. */
const MRGN = epd(0x58dc60);
/** units.dat: hit points (a dword a type, 256 to a point), shields (a word a type), the group flags (a byte a type). */
const MAX_HP = epd(0x662350), MAX_SHIELDS = epd(0x660e00), GROUPS = epd(0x6637a0);
/** The group bits Men, Buildings and Factories go by (a trigger's unit classes 230, 231, 232). */
const GROUP_BITS: Record<number, number> = { 230: 0x08, 231: 0x10, 232: 0x20 };
/** The most statements a loop's body over units may have to be written twice, for two places a turn. */
const UNROLL_MOST = 16;
/** Whether a `continue` at the top of statements (not inside a loop of their own; a switch's is the loop's) reaches the loop around them. */
function continues(list: Stmt[]): boolean {
  return list.some((t) => t.kind === "continue" || (t.kind === "if" && (continues(t.then) || continues(t.else ?? []))) || (t.kind === "block" && continues(t.body)) || (t.kind === "switch" && t.cases.some((c) => continues(c.body))));
}
/** How many statements a list has, those inside them counted. */
function size(x: unknown): number {
  if (Array.isArray(x)) return x.reduce((n: number, y) => n + size(y), 0);
  if (!x || typeof x !== "object") return 0;
  const o = x as { kind?: string };
  const own = typeof o.kind === "string" && STATEMENT_KINDS.has(o.kind) ? 1 : 0;
  return own + Object.values(o).reduce((n: number, v) => n + (v && typeof v === "object" ? size(v) : 0), 0);
}
/** The location an order goes through, made a box around the unit for its one action and put back after. */
const SCRATCH_LOCATION = 255;

/** A unit's record, by the dword: where each thing is (`dword`), its bits (`mask`) and how far up they are (`shift`). */
interface Bits { dword: number; mask: number; shift: number }
const word = (byte: number, bytes: 1 | 2 | 4): Bits => {
  const dword = byte >> 2, shift = 8 * (byte & 3);
  return { dword, mask: bytes === 4 ? 0xffffffff : ((2 ** (8 * bytes) - 1) * 2 ** shift) >>> 0, shift };
};
const SPRITE = 0x0c >> 2, POSITION = 0x28 >> 2, UID = word(0xa5, 1);
/** The owner and the order share a dword: the owner its low byte, the order the next. */
const OWNER = word(0x4c, 1), ORDER = word(0x4d, 1), TYPE = word(0x64, 2);
const X = word(0x28, 2), Y = word(0x2a, 2);
const FIELDS: Partial<Record<UnitNumField, Bits>> = {
  owner: OWNER, type: TYPE, x: X, y: Y, kills: word(0x8f, 1), orderId: ORDER, cooldown: word(0x55, 1), resources: word(0xd0, 2),
  stim: word(0x115, 1), ensnare: word(0x116, 1), lockdown: word(0x117, 1), irradiate: word(0x118, 1), stasis: word(0x119, 1), plague: word(0x11a, 1), maelstrom: word(0x124, 1),
  buildTime: word(0xac, 2), rank: word(0x8e, 1), matrix: word(0x114, 1), speed: word(0x38, 4),
};
const HP = 0x08 >> 2, SHIELDS = 0x60 >> 2, ENERGY = word(0xa2, 2), STATUS = 0xdc >> 2, ATTACKED = word(0x87, 1), USER_ACTION = word(0x93, 1);
/** The status bits a flag is (cloaked: both of two). */
const FLAG_BITS: Partial<Record<UnitFlag, number>> = { invincible: 0x04000000, hallucinated: 0x40000000, burrowed: 0x10, cloaked: 0x300, speedUpgrade: 0x10000000, inTransport: 0x40 };
/** The unit an order is aimed at (a pointer, 0 for none), and the defensive matrix's hit points (a word, 256 a point) beside its timer. */
const ORDER_TARGET = 0x5c >> 2, MATRIX_HP = word(0x112, 2), MATRIX_POINTS = 250 * 256;
/** The most a field written holds, as the simulator stops it: points for hit points and shields, a byte, a word. */
const TOPS: Partial<Record<UnitNumField, number>> = { hp: 0xffffff, shields: 0xffffff, energy: 255, kills: 255, cooldown: 255, resources: 0xffff, stim: 255, ensnare: 255, plague: 255, lockdown: 255, maelstrom: 255, irradiate: 255, stasis: 255, buildTime: 0xffff, rank: 255, matrix: 255 };
/** The Order action's orders. */
const ORDERS = { move: 0, patrol: 1, attack: 2 } as const;
const SET_DEATHS = 45, ORDER_ACTION = 46, SET_TO = 7, MASKED = 0x4353;
/** A record's player field that names the current player: a condition's Deaths of it reads the dword the pointer is the EPD of. */
const CURRENT_PLAYER = 13;
/** The program's own player, read as it starts, when it is not one known when built: what the pointer goes back to. */
const ME_ID = "@u.me";
/**
 * The lowest place of the unit table the game has handed out so far, as an EPD (0: none walked yet) — a cell for the
 * whole map, as the heap's are, read and moved down by every walk (`scan`).
 */
export const UNIT_END = "@unit.end";

/**
 * The frame's events pass (TrigScript 4, step 11, part 3), the map's one, before the programs' turns: a watch of every
 * unit place (`emit.ts`'s `watch`), whose handler lists this frame's units, each an EPD — what came on, what died, what
 * took up an order or turned into another type (with what it was) — and how many of each.
 */
const MADE = "@ev.made", GONE = "@ev.gone", TURNED = "@ev.turned", TURNED_WAS = "@ev.turnedWas", CHANGED = "@ev.changed", CHANGED_WAS = "@ev.changedWas";
const MADE_N = "@ev.madeN", GONE_N = "@ev.goneN", TURNED_N = "@ev.turnedN", CHANGED_N = "@ev.changedN";
/**
 * What the watch hands its handler: the record's EPD, and the number of the watch trigger's first condition (its next
 * ones five dwords on); the distance from place 0 of the place the game hands out next.
 */
const EV_RECORD = "@ev.e", EV_FIELDS = "@ev.wf", EV_BOUNDARY = "@ev.be";
/**
 * For the watch's gate (`emit.ts`): whether the handler found a unit come on or gone this frame, and a bit for each
 * player (0 to 11) that had one — whose counts the gate reads again.
 */
const EV_TOUCHED = "@ev.touch", EV_OWNERS = "@ev.own";
const AT0 = { file: "", line: 0, column: 0 };
/** The pass's variables, one each for the map, which no program declares; and its lists, the map's (a program's events read them). */
export const EVENT_GLOBALS: readonly VarDecl[] = [MADE_N, GONE_N, TURNED_N, CHANGED_N, EV_RECORD, EV_BOUNDARY, EV_FIELDS, EV_TOUCHED, EV_OWNERS].map((id) => ({ id, name: "(events)", kind: "number", shared: true, ...(id === EV_FIELDS ? {} : { routed: true }), global: true, at: AT0 }));
export const isEventGlobal = (id: string): boolean => id.startsWith("@ev.");
/** A unit's hit points (256ths, 0 when it died in a fight) and the last player whose attack hurt it. */
const HP_DWORD = 0x08 >> 2, LAST_ATTACKER = word(0x90, 1);
/** The most units of each kind a pass hands on in a frame, as the Python side's. */
const EVENT_CAP = 512;
type EventSource = "created" | "died" | "killed" | "ordered" | "morphed";
/** The sources a piece of the IR loops over the events pass's units of. */
export function eventSources(x: unknown, out = new Set<EventSource>()): Set<EventSource> {
  if (Array.isArray(x)) { x.forEach((y) => eventSources(y, out)); return out; }
  if (!x || typeof x !== "object") return out;
  const o = x as { kind?: string; source?: EventSource };
  if (o.kind === "unitLoop" && o.source) out.add(o.source);
  for (const v of Object.values(o)) if (v && typeof v === "object") eventSources(v, out);
  return out;
}
export const UNIT_GLOBALS: readonly VarDecl[] = [{ id: UNIT_END, name: "(units)", kind: "number", shared: true, routed: true, global: true, at: { file: "", line: 0, column: 0 } }];
/**
 * Each player's list of units: its first unit (a pointer a player, 0 for none), and a unit's place in its owner's list —
 * the unit before it and the one after it (pointers). A pointer read with its two low bits left out is its EPD plus the
 * deaths table's (`DEATHS / 4`); a unit's is at least the unit table's.
 */
const FIRST_UNIT = epd(0x6283f8), PREV_UNIT = 0x68 >> 2, NEXT_UNIT = 0x6c >> 2, POINTER = 0xfffffffc, IN_TABLE = 0x59cca8 / 4;
/**
 * `select()` (the Python side's): this computer's player (0x512684); its selection, twelve unit pointers (0x6284B8); the
 * flag Remastered's panel refresh tests (0x59723C); the game's queue of commands to send (0x654880), how much of it is
 * used (0x654AA0) and how much it holds (0x57F0D8).
 */
const LOCAL = epd(0x512684), SELECTION = epd(0x6284b8), PANEL = epd(0x59723c), QUEUE = epd(0x654880), QUEUED = epd(0x654aa0), QUEUE_MOST = epd(0x57f0d8);
const SELECT_COMMAND = 0x09, SELECTION_MOST = 12;
/** Kill Unit of Player 12's units of type 228, which no unit is: after it the game counts again (`emit.ts`'s `FORGET_COUNTS`). */
const FORGET_COUNTS: ActionRecord = { location: 0, text: 0, wav: 0, time: 0, player: 11, target: 0, unitId: 228, type: 22, modifier: 0, flags: 0x10, padding: 0, mask: 0 };

/**
 * A unit as the rewriting holds it: the EPD of its record (a variable, or the constant 0 for none) and its uniqueness
 * byte as kept (null: the unit is there by construction — a loop's turn, a pick in the statement that made it — and
 * nothing need be checked but `none` and `killed`). `none`: the EPD may be 0. `killed`: something since it was found may
 * have killed it (its order checked).
 */
interface Unit { e: NumExpr; k: NumExpr | null; none: boolean; killed: boolean }
const NONE: Unit = { e: { kind: "const", value: 0 }, k: null, none: true, killed: false };

/** A unit construct this pass leaves as it was: the statement that holds it is kept whole, for the emitter to refuse. */
class Leave extends Error {}

const k = (value: number): NumExpr => ({ kind: "const", value });
const V = (id: string): NumExpr => ({ kind: "var", id });
const isNone = (u: Unit) => u.e.kind === "const" && u.e.value === 0;

/** Whether a program has anything of units in it this pass rewrites. */
function hasUnits(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasUnits);
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: string; decl?: { kind?: string } };
  if (typeof o.kind === "string" && (o.kind.startsWith("unit") || o.kind === "assignUnit" || o.kind === "select" || o.kind === "selected")) return true;
  // (A pick: a unit's, not a printed text's, whose `by` is a value.)
  if (o.kind === "pick" && typeof (o as { by?: unknown }).by === "string") return true;
  if (o.decl && o.decl.kind === "unit") return true;
  return Object.values(o).some((v) => v && typeof v === "object" && hasUnits(v));
}

/** Whether a statement list may kill or remove a unit of the game: a verb, a write, an action, a call. */
function mayKill(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(mayKill);
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: string };
  if (o.kind === "unitDo" || o.kind === "unitWrite" || o.kind === "action" || o.kind === "call" || o.kind === "select") return true;
  return Object.values(o).some((v) => v && typeof v === "object" && mayKill(v));
}

/** Whether a value is a list of statements (every member one). */
function isStmtList(x: unknown): x is Stmt[] {
  // (A block has no label; a call is a statement when it has one.)
  return Array.isArray(x) && x.length > 0 && x.every((s) => s && typeof s === "object" && typeof (s as { kind?: unknown }).kind === "string" && (STATEMENT_KINDS.has((s as { kind: string }).kind) || ((s as { kind: string }).kind === "call" && "label" in s)));
}

/**
 * The program with its units as numbers: `unitValues` (see the file's comment). `owner`: the player the program runs
 * as, when it is one player known when built (the current player of a filter); otherwise read where the game keeps it.
 */
/**
 * `events`: the sources the map's programs' events loop over, and whether this program lays out the map's one events
 * pass (`Program.pass`) — the first program that has any.
 */
/**
 * `carrier`: the type of the input's carrier units (`input.ts`), which a walk of the table passes over — a hidden
 * unit of Player 12's with a human's owner byte, which no script means.
 */
export function unitValues(program: Program, events?: { sources: Set<EventSource>; pass: boolean }, carrier?: number): Program {
  if (!hasUnits(program)) return program;
  let here: At = program.at;
  let made = 0;
  const fresh = (what: string) => `@u.${what}${made++}`;
  const owner = !program.perPlayer && program.owners.length <= 1 && program.owner >= 0 && program.owner < 8 ? program.owner : undefined;

  // ── the IR's own pieces ──
  const at = () => ({ at: here, label: "" });
  const bin = (op: "+" | "-" | "*" | "&" | "|" | ">>>", a: NumExpr, b: NumExpr): NumExpr => {
    // (Of two constants, the constant: a field takes it as it is.)
    if (a.kind === "const" && b.kind === "const") {
      const [x, y] = [a.value >>> 0, b.value >>> 0];
      return k((op === "+" ? x + y : op === "-" ? x - y : op === "*" ? Number((BigInt(x) * BigInt(y)) & 0xffffffffn) : op === "&" ? x & y : op === "|" ? x | y : x >>> y) >>> 0);
    }
    return { kind: "binary", op, left: a, right: b, ...at() } as NumExpr;
  };
  const cmp = (op: CompareOp, a: NumExpr, b: NumExpr): BoolExpr => ({ kind: "compare", op, left: a, right: b, unsigned: true, ...at() });
  const all = (items: BoolExpr[]): BoolExpr => (items.length === 0 ? { kind: "const", value: true } : items.length === 1 ? items[0] : { kind: "and", items });
  const any = (items: BoolExpr[]): BoolExpr => (items.length === 0 ? { kind: "const", value: false } : items.length === 1 ? items[0] : { kind: "or", items });
  const ranged = (e: NumExpr, lo: number, hi: number): NumExpr => ({ ...e, range: [lo, hi] }) as unknown as NumExpr;
  /** `keep`: "routed" — kept in one cell, read where it is used; "everywhere" — written seldom, read often, never copied. */
  const num = (id: string, top?: number, keep?: "routed" | "everywhere"): VarDecl => ({ id, name: "(unit)", kind: "number", shared: false, at: here, temp: true, ...(top !== undefined ? { top } : {}), ...(keep ? { [keep]: true } : {}) } as VarDecl);
  const dec = (id: string, init: NumExpr, top?: number, keep?: "routed" | "everywhere"): Stmt => ({ kind: "declare", decl: num(id, top, keep), init, ...at() });
  const set = (target: string, value: NumExpr): Stmt => ({ kind: "assign", target, value, ...at() });
  const when = (cond: BoolExpr | boolean, then: Stmt[], otherwise: Stmt[] = []): Stmt[] => {
    if (cond === true || (typeof cond === "object" && cond.kind === "const" && cond.value === true)) return then;
    if (cond === false || (typeof cond === "object" && cond.kind === "const" && cond.value === false)) return otherwise;
    return [{ kind: "if", cond, then, ...(otherwise.length ? { else: otherwise } : {}), ...at() }];
  };
  const brk = (): Stmt => ({ kind: "break", ...at() });
  /** The dword at an EPD, or its bits of the mask, moved down `shift`. */
  const peek = (at_: NumExpr, mask = 0xffffffff, shift = 0): NumExpr => {
    const whole = mask >>> 0 === 0xffffffff;
    const record: ConditionRecord = { location: whole ? 0 : mask >>> 0, player: 0, amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: whole ? 0 : MASKED };
    const r: NumExpr = { kind: "read", read: { source: "condition", record, epd: at_ }, ...at() } as NumExpr;
    return shift ? bin(">>>", r, k(shift)) : r;
  };
  /** A Set Deaths of the dword at an EPD: the value written, or its bits of the mask. */
  const poke = (at_: NumExpr, value: NumExpr, mask = 0xffffffff): Stmt => {
    const whole = mask >>> 0 === 0xffffffff;
    const record: ActionRecord = { location: whole ? 0 : mask >>> 0, text: 0, wav: 0, time: 0, player: 0, target: value.kind === "const" ? value.value >>> 0 : 0, unitId: 0, type: SET_DEATHS, modifier: SET_TO, flags: 0, padding: 0, mask: whole ? 0 : MASKED };
    const variables = [{ field: "player" as const, bits: 32 as const, name: "at", expr: at_ }, ...(value.kind === "const" ? [] : [{ field: "target" as const, bits: 32 as const, name: "n", expr: value }])];
    return { kind: "action", record, variables, ...at() } as Stmt;
  };
  /** A unit's dword `off` dwords into its record. */
  const of = (u: NumExpr, off: number): NumExpr => (off ? bin("+", u, k(off)) : u);
  const read = (u: NumExpr, b: Bits): NumExpr => peek(of(u, b.dword), b.mask, b.shift);
  /** The same bits where they are, for a condition: a masked Deaths, no shift. */
  const bits = (u: NumExpr, b: Bits): NumExpr => peek(of(u, b.dword), b.mask);
  /**
   * Bits of a dword read through the current player, as eudplib reads: the pointer written once where the game keeps
   * it — one place of the unit, where a read in place would make every condition of the read one — the conditions'
   * player field 13, then the pointer given back to the program's own player (`ME`).
   */
  let usesMe = false;
  const ME: NumExpr = owner !== undefined ? k(owner) : V(ME_ID);
  const through = (at_: NumExpr, inner: (here_: (mask?: number, shift?: number) => NumExpr) => Stmt[]): Stmt[] => {
    if (owner === undefined) usesMe = true;
    return [poke(k(CURRENT), at_), ...inner((mask = 0xffffffff, shift = 0) => peek(k(CURRENT_PLAYER), mask, shift)), poke(k(CURRENT), ME)];
  };
  /** A unit's bits into a variable, read through the current player. */
  const readInto = (target: string, u: NumExpr, b: Bits): Stmt[] => through(of(u, b.dword), (h) => [set(target, h(b.mask, b.shift))]);
  /** The value stopped at a top, read from 0 up, as the simulator's `amount` and the Python side's `saturate` have it. */
  const atMost = (e: NumExpr, top: number): NumExpr => {
    const r = (e as NumExpr & { range?: readonly [number, number] }).range;
    if (e.kind === "const") return k(Math.min(e.value >>> 0, top));
    if (r && r[0] >= 0 && r[1] <= top) return e;
    return { kind: "intrinsic", name: "min", args: [e, k(top)], unsigned: true, range: [0, top], ...at() } as NumExpr;
  };
  /** A value into a variable of this pass's first, unless it is a variable or a constant: a field takes one of those. */
  const plain = (e: NumExpr, pre: Stmt[], top?: number): NumExpr => {
    if (e.kind === "const" || e.kind === "var") return e;
    const t = fresh("v");
    pre.push(dec(t, e, top));
    const r = (e as NumExpr & { range?: readonly [number, number] }).range;
    return r ? ranged(V(t), r[0], r[1]) : V(t);
  };

  // ── a unit checked ──
  /** The unit's place holds it still: a sprite, an order other than Die, the uniqueness byte kept. */
  const alive = (u: Unit): BoolExpr => {
    if (isNone(u)) return { kind: "const", value: false };
    if (u.k === null) {
      const items: BoolExpr[] = [];
      if (u.none) items.push(cmp(">=", u.e, k(1)));
      if (u.killed) items.push(cmp(">=", bits(u.e, ORDER), k(0x100)));
      return all(items);
    }
    return all([
      cmp(">=", u.e, k(1)),
      cmp(">=", peek(of(u.e, SPRITE)), k(1)),
      cmp(">=", bits(u.e, ORDER), k(0x100)),
      cmp("==", bits(u.e, UID), ranged(bin("*", u.k, k(256)), 0, 0xff00)),
    ]);
  };
  /** The unit's place holds its record still, dying or not: what a read of its fields asks. A unit handed to a died
   * handler is on its way out — its order Die, its sprite still there — and its type and place are read as they are,
   * as the simulator reads them (the first play of the events probe found "died 0 at 0, 0" for every unit, 2026-10-24). */
  const present = (u: Unit): BoolExpr => {
    if (isNone(u)) return { kind: "const", value: false };
    if (u.k === null) return u.none ? cmp(">=", u.e, k(1)) : { kind: "const", value: true };
    return all([cmp(">=", u.e, k(1)), cmp(">=", peek(of(u.e, SPRITE)), k(1)), cmp("==", bits(u.e, UID), ranged(bin("*", u.k, k(256)), 0, 0xff00))]);
  };
  /** The unit's uniqueness byte as it is now, for keeping (0 for none). */
  const uidOf = (u: Unit, pre: Stmt[]): NumExpr => {
    if (u.k) return u.k;
    if (isNone(u)) return k(0);
    const t = fresh("k");
    pre.push(dec(t, k(0), 255));
    pre.push(...when(u.none ? cmp(">=", u.e, k(1)) : true, readInto(t, u.e, UID)));
    return ranged(V(t), 0, 255);
  };
  /** The unit, its EPD in a variable: what a field from a value and a condition's player take. */
  const held = (u: Unit, pre: Stmt[]): Unit => (u.e.kind === "var" || u.e.kind === "const" ? u : { ...u, e: plain(u.e, pre) });

  // ── the unit table walked ──
  /** A location's four sides, read where the game keeps them, as a filter and a pick compare positions with them. */
  const sides = (location: number, pre: Stmt[]): NumExpr[] => {
    const base = MRGN + 5 * (location - 1);
    return [0, 1, 2, 3].map((i) => {
      const t = fresh("side");
      pre.push(dec(t, peek(k(base + i))));
      // (A side reaching past the map's edge is below zero, where no unit is: it is 0. Past 65 535, no unit is either.)
      if (i < 2) pre.push(...when(cmp(">=", V(t), k(0x80000000)), [set(t, k(0))]));
      pre.push(...when(cmp(">", V(t), k(0xffff)), [set(t, k(0xffff))]));
      return ranged(V(t), 0, 0xffff);
    });
  };
  /** The player a filter's owner is: a slot, or the current player (the program's owner, or read where the game keeps it). */
  const playerOf = (p: number, pre: Stmt[]): NumExpr => {
    if (p !== 13) return k(p);
    if (owner !== undefined) return k(owner);
    const t = fresh("cp");
    pre.push(dec(t, peek(k(CURRENT), 0xff)));
    return ranged(V(t), 0, 255);
  };
  /**
   * The statements of place 0's turn, which is a turn of its own ahead of the walk's loop: a `break` at their top (not
   * inside a loop or a switch of their own) ends the walk — `skip` set first, which the loop after reads — and a
   * `continue` goes on to the loop, as the turn is a `do … while (false)` of its own.
   */
  const ending = (list: Stmt[], skip: string): { list: Stmt[]; jumps: boolean } => {
    let jumps = false;
    // (Inside a switch a `break` is the switch's, a `continue` still the loop's.)
    const walk = (x: Stmt[], inSwitch = false): Stmt[] => x.map((t): Stmt => {
      if (t.kind === "break" && !inSwitch) { jumps = true; return { kind: "block", body: [set(skip, k(1)), t], at: t.at } as Stmt; }
      if (t.kind === "continue") { jumps = true; return t; }
      if (t.kind === "if") return { ...t, then: walk(t.then, inSwitch), ...(t.else ? { else: walk(t.else, inSwitch) } : {}) };
      if (t.kind === "block") return { ...t, body: walk(t.body, inSwitch) };
      if (t.kind === "switch") return { ...t, cases: t.cases.map((c) => ({ ...c, body: walk(c.body, true) })) };
      return t;
    });
    return { list: walk(list), jumps };
  };
  /**
   * The units a filter matches, each once, oldest first: `body` with the EPD of the unit's record — a variable it must
   * not write — run for each, where `stop()` ends the walk, and a `break` and a `continue` of the walk's loop do what
   * they say. The walk is place 0's turn, then a loop from place 1 699 down to the lowest place the game has ever
   * handed out (`UNIT_END`): a turn is the loop's test, the filter asked of the place in one trigger, and the step down,
   * which goes back to the test as it is laid out. The places below that one have never held a unit — the game hands
   * them out last, in order — so nothing is counted on the way.
   */
  const scan = (filter: UnitFilter, pre: Stmt[], body: (q: NumExpr, stop: () => Stmt[]) => Stmt[]): Stmt[] => {
    const type = filter.type;
    if (type !== undefined && type >= 228 && GROUP_BITS[type] === undefined) throw new Leave();
    const n = made++;
    const Q = `@u.q${n}`, LIM = `@u.lo${n}`, SKIP = `@u.skip${n}`;
    const q = ranged(V(Q), UNIT_TABLE - STRIDE, UNIT_TABLE + STRIDE * (PLACES - 1));
    const who = filter.owner !== undefined ? playerOf(filter.owner, pre) : undefined;
    const box = filter.at ? sides(filter.at, pre) : undefined;
    // What the filter asks of a unit, read where it is: a sprite, an order other than Die, the owner, the type, inside
    // the location — one trigger.
    const living = (q: NumExpr) => cmp(">=", bits(q, ORDER), k(0x100));
    const asks = (q: NumExpr): BoolExpr[] => {
      const out: BoolExpr[] = [cmp(">=", peek(of(q, SPRITE)), k(1))];
      if (who) out.push(cmp("==", read(q, OWNER), who));
      if (type !== undefined && type < 228) out.push(cmp("==", read(q, TYPE), k(type)));
      if (box) {
        const [l, t, r, b] = box;
        const xy = (u: NumExpr, mask: number) => peek(of(u, POSITION), mask);
        out.push(cmp(">=", xy(q, 0xffff), l), cmp("<=", xy(q, 0xffff), r), cmp(">=", xy(q, 0xffff0000), ranged(bin("*", t, k(0x10000)), 0, 0xffff0000)), cmp("<=", xy(q, 0xffff0000), ranged(bin("*", b, k(0x10000)), 0, 0xffff0000)));
      }
      return out;
    };
    const turn = (q: NumExpr, inner: Stmt[], also: BoolExpr[] = []): Stmt[] => {
      if (type !== undefined && GROUP_BITS[type] !== undefined) {
        // A trigger's class (Men, Buildings, Factories): the type's group byte, read where units.dat keeps it.
        const ty = fresh("ty"), qt = fresh("tq"), bit = GROUP_BITS[type];
        const tyv = ranged(V(ty), 0, 0xffff);
        inner = [dec(ty, k(0), 0xffff), ...readInto(ty, q, TYPE), dec(qt, bin(">>>", tyv, k(2)), 0x3fff),
          ...when(any([0, 1, 2, 3].map((r) => all([cmp("==", bin("&", tyv, k(3)), k(r)), cmp(">=", peek(bin("+", k(GROUPS), V(qt)), (bit * 2 ** (8 * r)) >>> 0), k(1))]))), inner)];
      }
      // (The input's carriers, hidden units with a human's owner byte, are no script's: a unit the filter lets through
      // is asked its type once more, unless the filter asks for one type already.)
      if (carrier !== undefined && (type === undefined || type >= 228)) inner = when(cmp("!=", read(q, TYPE), k(carrier)), inner);
      // (With a filter the order is asked only of the units it lets through: a place the walk passes costs a condition
      // less, and every condition is a dword the walk's step moves on.)
      const ask = [...also, ...asks(q)];
      return ask.length > also.length + 1 ? when(all(ask), when(living(q), inner)) : when(all([...ask, living(q)]), inner);
    };
    // Place 0's turn, read at place 0 itself: its `break` ends the walk, its `continue` goes on to the loop.
    const q0 = k(UNIT_TABLE);
    const first = ending(body(q0, () => [set(SKIP, k(1))]), SKIP);
    let zero = turn(q0, first.list);
    if (first.jumps) zero = [{ kind: "do", body: zero, cond: { kind: "const", value: false }, ...at(), condLabel: "" } as Stmt];
    // The lowest place ever handed out, kept as the upper of the two places the loop's last turn walks (places 1 699
    // and 1 698 are a turn, 1 697 and 1 696 the next …): moved down a turn past each turn's places below it while the
    // first of them has held a unit (a sprite, a position or a uniqueness byte: a place never handed out is all 0, as
    // the game set the table up, and the game hands those out last, in order).
    const top = UNIT_TABLE + STRIDE * (PLACES - 1);
    const below = bin("-", V(LIM), k(2 * STRIDE));
    const used = any([cmp(">=", peek(of(below, SPRITE)), k(1)), cmp(">=", peek(of(below, POSITION)), k(1)), cmp(">=", bits(below, UID), k(0x100))]);
    const lim = ranged(V(LIM), UNIT_TABLE + STRIDE, top + 2 * STRIDE);
    // Two places a turn, when the body is small and no `continue` of its own reaches the walk's loop (the second
    // place's turn is then not the update's; a `break` ends the walk from either); else one. Neither walks place 0
    // again, the lower of the last turn's two when every place has been handed out.
    const loopBody = body(q, () => [brk()]);
    const pairs = !continues(loopBody) && size(loopBody) <= UNROLL_MOST;
    const second = bin("-", q, k(STRIDE));
    const turns = pairs ? [...turn(q, loopBody), ...turn(second, body(second, () => [brk()]), [cmp(">=", q, k(UNIT_TABLE + 2 * STRIDE))])] : turn(q, loopBody);
    // (One place a turn: down to the lower of the last turn's two, or place 1.)
    const LOW = `@u.low${n}`;
    const low: Stmt[] = pairs ? [] : [dec(LOW, bin("-", V(LIM), k(STRIDE))), ...when(cmp("<", V(LOW), k(UNIT_TABLE + STRIDE)), [set(LOW, k(UNIT_TABLE + STRIDE))])];
    return [
      dec(LIM, V(UNIT_END)),
      ...when(cmp("==", V(LIM), k(0)), [set(LIM, k(top + 2 * STRIDE))]),
      { kind: "while", cond: all([cmp(">=", V(LIM), k(UNIT_TABLE + 3 * STRIDE)), used]), body: [set(LIM, below)], ...at() } as Stmt,
      set(UNIT_END, V(LIM)),
      ...low,
      dec(Q, k(UNIT_TABLE)), dec(SKIP, k(0), 1),
      ...zero,
      ...when(cmp("==", V(SKIP), k(0)), [
        set(Q, k(top)),
        { kind: "for", cond: pairs ? cmp(">=", q, lim) : cmp(">=", q, ranged(V(LOW), UNIT_TABLE + STRIDE, top + STRIDE)), update: [set(Q, bin("-", V(Q), k(pairs ? 2 * STRIDE : STRIDE)))], body: turns, ...at() } as Stmt,
      ]),
    ];
  };

  // ── the events pass's units ──
  const back = (): Stmt => poke(k(CURRENT), ME);
  const store = (array: string, index: NumExpr, value: NumExpr): Stmt => ({ kind: "store", array, index, value, ...at() });
  const element = (array: string, index: NumExpr): NumExpr => ({ kind: "element", array, index, ...at() } as NumExpr);
  /**
   * A loop over the units this frame's events pass found (`on.*`'s), in the order it found them, the filter asked of
   * each: one that came on, took up an order or turned into another type and is gone since is passed over; one that died
   * is its record as it died (the game gives its place to no other unit before the next frame's dying pass).
   */
  const eventLoop = (s: Extract<Stmt, { kind: "unitLoop" }>): Stmt[] => {
    const source = s.source as EventSource;
    const list = { created: MADE, died: GONE, killed: GONE, ordered: TURNED, morphed: CHANGED }[source];
    const count = { created: MADE_N, died: GONE_N, killed: GONE_N, ordered: TURNED_N, morphed: CHANGED_N }[source];
    const was = source === "ordered" ? TURNED_WAS : source === "morphed" ? CHANGED_WAS : undefined;
    const type = s.filter.type;
    if (type !== undefined && type >= 228 && GROUP_BITS[type] === undefined) throw new Leave();
    const pre: Stmt[] = [];
    const I = fresh("ei"), E = fresh("ee");
    const e = V(E);
    const who = s.filter.owner !== undefined ? playerOf(s.filter.owner, pre) : undefined;
    const box = s.filter.at ? sides(s.filter.at, pre) : undefined;
    const by = s.event?.by !== undefined ? playerOf(s.event.by, pre) : undefined;
    const asks: BoolExpr[] = [];
    if (source !== "died" && source !== "killed") asks.push(cmp(">=", peek(of(e, SPRITE)), k(1)), cmp(">=", bits(e, ORDER), k(0x100)));
    // (Died in a fight: no hit points, the last attack one of the eight players'.)
    if (source === "killed") asks.push(cmp("==", peek(of(e, HP_DWORD)), k(0)), cmp("<=", read(e, LAST_ATTACKER), k(7)));
    if (by) asks.push(cmp("==", read(e, LAST_ATTACKER), by));
    if (s.event?.order !== undefined) asks.push(cmp("==", bits(e, ORDER), k(s.event.order * 256)));
    if (who) asks.push(cmp("==", read(e, OWNER), who));
    if (type !== undefined && type < 228) asks.push(cmp("==", read(e, TYPE), k(type)));
    if (box) {
      const [l, t, r, b] = box;
      const xy = (mask: number) => peek(of(e, POSITION), mask);
      asks.push(cmp(">=", xy(0xffff), l), cmp("<=", xy(0xffff), r), cmp(">=", xy(0xffff0000), ranged(bin("*", t, k(0x10000)), 0, 0xffff0000)), cmp("<=", xy(0xffff0000), ranged(bin("*", b, k(0x10000)), 0, 0xffff0000)));
    }
    let inner: Stmt[];
    turns.set(s.decl.id, { q: e, killed: mayKill(s.body) });
    try {
      inner = stmts(s.body);
    } finally {
      turns.delete(s.decl.id);
    }
    if (s.was) inner = [{ kind: "declare", decl: s.was, init: source === "killed" ? k(0) : element(was!, V(I)), ...at() }, ...(source === "killed" ? readInto(s.was.id, e, LAST_ATTACKER) : []), ...inner];
    if (type !== undefined && GROUP_BITS[type] !== undefined) {
      // (A trigger's class: the type's group byte, read where units.dat keeps it.)
      const ty = fresh("ty"), qt = fresh("tq"), bit = GROUP_BITS[type], tyv = ranged(V(ty), 0, 0xffff);
      inner = [dec(ty, k(0), 0xffff), ...readInto(ty, e, TYPE), dec(qt, bin(">>>", tyv, k(2)), 0x3fff),
        ...when(any([0, 1, 2, 3].map((r) => all([cmp("==", bin("&", tyv, k(3)), k(r)), cmp(">=", peek(bin("+", k(GROUPS), V(qt)), (bit * 2 ** (8 * r)) >>> 0), k(1))]))), inner)];
    }
    return [...pre, dec(I, k(0)), { kind: "for", cond: cmp("<", V(I), V(count)), update: [set(I, bin("+", V(I), k(1)))], body: [dec(E, element(list, V(I))), ...when(all(asks), inner)], ...at() } as Stmt];
  };

  /**
   * The frame's events pass: the counts back to 0, and the watch of every unit place (`emit.ts`), whose conditions read
   * the place's record where it is against what it saw there last — its uniqueness byte, and as the program's events
   * need them its order (whether it is alive, or which) and its type. The handler, for a place
   * that changed: what the watch saw, read from its conditions' numbers through the current player pointed at the
   * first, and the record as it is now; a unit of another uniqueness byte that is alive came on, the one seen
   * alive and alive no more died, one that took up another order or turned into another type did; and what it sees now
   * written back into the conditions' numbers. As the simulator, newest first: the places walked so.
   */
  const pass = (sources: Set<EventSource>): Stmt[] => {
    here = AT0;
    const died = sources.has("died") || sources.has("killed"), ordered = sources.has("ordered"), morphed = sources.has("morphed");
    // The gate (`emit.ts`): the watch passed by on a frame when no unit can have come on or gone — only when neither
    // orders nor types are watched, which change with nothing else of the game's to show for it.
    const gate = !ordered && !morphed;
    type Field = { name: string; dword: number; mask?: number; compare: "atLeast" | "exactly"; read: number };
    // (The uniqueness byte first: the watch of a place whose unit is not alive ends there. The game hands a place's
    // first unit a byte above 0, and every unit dies through the order Die, its sprite still there.)
    const fields: Field[] = [{ name: "uid", dword: UID.dword, mask: 0xff00, compare: "exactly", read: 0xff00 }];
    if (ordered) fields.push({ name: "order", dword: ORDER.dword, mask: 0xff00, compare: "exactly", read: 0xff00 });
    // (Whether it is alive is watched for the gate too: a unit gone marks its owner, listed or not.)
    else if (died || gate) fields.push({ name: "alive", dword: ORDER.dword, mask: 0xff00, compare: "atLeast", read: 0x100 });
    if (morphed) fields.push({ name: "type", dword: TYPE.dword, mask: 0xffff, compare: "exactly", read: 0xffff });
    const old = (name: string) => `@ev.was.${name}`, now = (name: string) => `@ev.now.${name}`;
    const e = V(EV_RECORD);
    const step = (by: number): Stmt => ({ kind: "action", record: { location: 0, text: 0, wav: 0, time: 0, player: 0, target: by, unitId: 0, type: 45, modifier: 8, flags: 0, padding: 0, mask: 0 }, variables: [{ field: "player", bits: 32, name: "at", expr: k(CURRENT) }], ...at() } as Stmt);
    const out: Stmt[] = [set(MADE_N, k(0))];
    if (gate) out.push(set(EV_TOUCHED, k(0)), set(EV_OWNERS, k(0)));
    if (died) out.push(set(GONE_N, k(0)));
    if (ordered) out.push(set(TURNED_N, k(0)));
    if (morphed) out.push(set(CHANGED_N, k(0)));
    const h: Stmt[] = [];
    // What the watch saw, its conditions' numbers five dwords apart.
    h.push(poke(k(CURRENT), V(EV_FIELDS)));
    fields.forEach((f, i) => { if (i) h.push(step(5)); h.push(dec(old(f.name), peek(k(CURRENT_PLAYER), f.read))); });
    h.push(back());
    // What the place holds now.
    // (Read into a variable only what is compared or written back; whether it is alive asked of the record.)
    h.push(dec(now("uid"), peek(of(e, UID.dword), 0xff00)));
    if (ordered) h.push(dec(now("order"), peek(of(e, ORDER.dword), 0xff00)));
    if (morphed) h.push(dec(now("type"), peek(of(e, TYPE.dword), 0xffff)));
    const ALIVE = "@ev.alive", OWNERV = "@ev.owner";
    if (gate) h.push(dec(OWNERV, k(0), 255));
    h.push(dec(ALIVE, k(0), 1), ...when(all([cmp(">=", peek(of(e, SPRITE)), k(1)), cmp(">=", ordered ? V(now("order")) : peek(of(e, ORDER.dword), 0xff00), k(0x100))]), [set(ALIVE, k(1))]));
    const listed = (list: string, n: string, extra: Stmt[] = []): Stmt[] => when(cmp("<", V(n), k(EVENT_CAP)), [store(list, V(n), e), ...extra, set(n, bin("+", V(n), k(1)))]);
    // (Gated: a unit come on or gone marks the frame and its owner's bit, for the gate to read that player's counts again.)
    const marked: Stmt[] = gate ? [set(EV_TOUCHED, k(1)), set(OWNERV, peek(of(e, OWNER.dword), OWNER.mask)), ...Array.from({ length: 12 }, (_, p) => when(cmp("==", V(OWNERV), k(p)), [set(EV_OWNERS, bin("|", V(EV_OWNERS), k(2 ** p)))])).flat()] : [];
    const same: Stmt[] = [];
    if (died) same.push(...when(all([cmp(">=", V(old(ordered ? "order" : "alive")), k(0x100)), cmp("==", V(ALIVE), k(0))]), [...listed(GONE, GONE_N), ...marked]));
    else if (gate) same.push(...when(all([cmp(">=", V(old("alive")), k(0x100)), cmp("==", V(ALIVE), k(0))]), marked));
    if (ordered) same.push(...when(all([cmp("==", V(ALIVE), k(1)), cmp("!=", V(now("order")), V(old("order")))]), listed(TURNED, TURNED_N, [store(TURNED_WAS, V(TURNED_N), bin(">>>", V(old("order")), k(8)))])));
    if (morphed) same.push(...when(all([cmp("==", V(ALIVE), k(1)), cmp("!=", V(now("type")), V(old("type")))]), listed(CHANGED, CHANGED_N, [store(CHANGED_WAS, V(CHANGED_N), V(old("type")))])));
    h.push(...when(cmp("!=", V(now("uid")), V(old("uid"))), when(cmp("==", V(ALIVE), k(1)), [...listed(MADE, MADE_N), ...marked]), same));
    // What it sees now, into the watch's numbers: whether it is alive, or its order. For a unit not alive, only another
    // in its place is news: the second condition's kind (the top byte of its dword after the number) is 0 then, and
    // the game reads no further.
    const seen: Record<string, NumExpr> = { uid: V(now("uid")), order: ordered ? V(now("order")) : k(0), alive: bin("*", V(ALIVE), k(0x100)), type: morphed ? V(now("type")) : k(0) };
    h.push(poke(k(CURRENT), V(EV_FIELDS)));
    fields.forEach((f, i) => {
      if (i) h.push(step(i === 2 ? 4 : 5));
      h.push(poke(k(CURRENT_PLAYER), seen[f.name]));
      if (i === 1) h.push(step(1), poke(k(CURRENT_PLAYER), bin("*", V(ALIVE), k(0x0f000000)), 0xff000000));
    });
    h.push(back());
    out.push({ kind: "watch", fields: fields.map(({ dword, mask, compare }) => ({ dword, ...(mask !== undefined ? { mask } : {}), compare })), handler: h, ...(gate ? { gate } : {}), ...at() } as Stmt);
    return out;
  };

  /** A pick: the first unit the filter matches, the nearest to a location's centre, or one drawn at random. */
  const pick = (p: Extract<UnitExpr, { kind: "pick" }>, pre: Stmt[]): Unit => {
    // (Kept in its cell alone: written at each unit found, the walk's address would otherwise be read into every place.)
    const R = fresh("pick");
    pre.push(dec(R, k(0), undefined, "routed"));
    const found = (q: NumExpr): Stmt => set(R, q);
    if (p.by === "first") pre.push(...scan(p.filter, pre, (q, stop) => [found(q), ...stop()]));
    else if (p.by === "nearest") {
      if (p.near === undefined && p.mouse === undefined) throw new Leave();
      const cx = fresh("cx"), cy = fresh("cy"), least = fresh("least");
      const X0 = fresh("bx"), X1 = fresh("bx"), Y0 = fresh("by"), Y1 = fresh("by");
      const c = (id: string) => ranged(V(id), 0, 0xffff);
      // (Written seldom and read at every unit: kept in each place it is read, never copied there.)
      if (p.mouse !== undefined) {
        // `underMouse()` (step 12): the player's mouse on the map as the receive pass keeps it (`input.ts`); `within` so
        // many pixels, as |dx| + |dy|, or anywhere.
        const who = playerOf(p.mouse, pre);
        pre.push(dec(cx, { kind: "element", array: MOUSE_CELLS.x, index: who, at: here } as NumExpr, 0xffff, "everywhere"), dec(cy, { kind: "element", array: MOUSE_CELLS.y, index: who, at: here } as NumExpr, 0xffff, "everywhere"));
      } else {
        const [l, t, r, b] = sides(p.near!, pre);
        pre.push(dec(cx, bin(">>>", bin("+", l, r), k(1)), 0xffff, "everywhere"), dec(cy, bin(">>>", bin("+", t, b), k(1)), 0xffff, "everywhere"));
      }
      pre.push(dec(least, k(p.within !== undefined ? Math.min(0x20000, p.within + 1) : 0x20000), 0x20000, "everywhere"));
      // A unit nearer than the nearest so far (by |dx| + |dy|) is inside the box |dx|, |dy| < that: four conditions on
      // its position, read through the current player, ask it of each unit; only one inside is measured. The box is
      // the whole map until the first.
      pre.push(dec(X0, k(0), 0xffff, "everywhere"), dec(X1, k(0xffff), 0xffff, "everywhere"), dec(Y0, k(0), 0xffff, "everywhere"), dec(Y1, k(0xffff), 0xffff, "everywhere"));
      const edges = (lo: string, hi: string, centre: string): Stmt[] => [
        set(lo, k(0)), ...when(cmp(">=", c(centre), V(least)), [set(lo, bin("+", bin("-", V(centre), V(least)), k(1)))]),
        set(hi, bin("-", bin("+", V(centre), V(least)), k(1))), ...when(cmp(">", V(hi), k(0xffff)), [set(hi, k(0xffff))]),
      ];
      pre.push(...scan(p.filter, pre, (q, stop) => {
        const x = fresh("x"), y = fresh("y"), dx = fresh("dx"), dy = fresh("dy"), d = fresh("d");
        const away = (v: string, centre: string, into: string): Stmt[] => when(cmp(">=", c(v), c(centre)), [set(into, bin("-", V(v), V(centre)))], [set(into, bin("-", V(centre), V(v)))]);
        return through(of(q, POSITION), (h) => when(
          all([cmp(">=", h(0xffff), c(X0)), cmp("<=", h(0xffff), c(X1)), cmp(">=", h(0xffff0000), ranged(bin("*", V(Y0), k(0x10000)), 0, 0xffff0000)), cmp("<=", h(0xffff0000), ranged(bin("*", V(Y1), k(0x10000)), 0, 0xffff0000))]),
          [
            // (Each of these is written at each unit measured and read once there: kept in its cell, read where it is
            // used — written into every place it reaches, the nearest so far and the box, it would be copied there a
            // bit at a time at each unit.)
            dec(x, h(X.mask, X.shift), 0xffff, "routed"), dec(y, h(Y.mask, Y.shift), 0xffff, "routed"), dec(dx, k(0), 0xffff, "routed"), dec(dy, k(0), 0xffff, "routed"),
            ...away(x, cx, dx), ...away(y, cy, dy), dec(d, bin("+", V(dx), V(dy)), 0x1fffe, "routed"),
            ...when(cmp("<", ranged(V(d), 0, 0x1fffe), V(least)), [set(least, V(d)), found(q), ...edges(X0, X1, cx), ...edges(Y0, Y1, cy),
              // (Nothing is nearer than the unit at the centre itself.)
              ...when(cmp("==", V(least), k(0)), stop())]),
          ],
        ));
      }));
    } else {
      // Counted, one drawn, taken on a second walk.
      const C = fresh("count"), D = fresh("drawn"), I = fresh("i");
      pre.push(dec(C, k(0), 0xffff));
      pre.push(...scan(p.filter, pre, () => [set(C, bin("+", V(C), k(1)))]));
      pre.push(dec(D, { kind: "randomInt", bound: ranged(V(C), 0, PLACES), ...at() } as NumExpr, 0xffff), dec(I, k(0), 0xffff));
      pre.push(...when(cmp(">=", V(C), k(1)), scan(p.filter, pre, (q, stop) => [...when(cmp("==", V(I), V(D)), [found(q), ...stop()]), set(I, bin("+", V(I), k(1)))])));
    }
    return { e: ranged(V(R), 0, UNIT_TABLE + STRIDE * PLACES), k: null, none: true, killed: false };
  };

  // ── the program's units ──
  /** The units of the loops being rewritten, by their variable: the EPD the walk is at, and whether the body may kill. */
  const turns = new Map<string, { q: NumExpr; killed: boolean }>();
  /** Each unit variable's two numbers. */
  const pair = (id: string) => ({ e: `${id}@e`, k: `${id}@k` });
  const asNumber = (d: VarDecl, part: "e" | "k"): VarDecl => {
    const { text: _t, ...rest } = d;
    void _t;
    return { ...rest, id: pair(d.id)[part], kind: "number", ...(part === "k" ? { top: 255 } : {}) };
  };
  /** What a `return` of the function or inlined call being rewritten writes its unit's uniqueness byte into. */
  const results: (string | null)[] = [];
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));

  const unit = (e: UnitExpr, pre: Stmt[]): Unit => {
    switch (e.kind) {
      case "unitNull": return NONE;
      case "unitVar": {
        const turn = turns.get(e.id);
        if (turn) return { e: turn.q, k: null, none: false, killed: turn.killed };
        const p = pair(e.id);
        return { e: ranged(V(p.e), 0, UNIT_TABLE + STRIDE * PLACES), k: ranged(V(p.k), 0, 255), none: true, killed: true };
      }
      case "pick": return pick(e, pre);
      case "selected": return fix(e, pre) as Unit;
      case "unitAt": {
        const ptr = plain(fix(e.ptr, pre) as NumExpr, pre);
        fix(e.epd, pre);
        const uid = plain(fix(e.uid, pre) as NumExpr, pre, 255);
        return { e: ranged(ptr, 0, UNIT_TABLE + STRIDE * PLACES), k: ranged(uid, 0, 255), none: true, killed: true };
      }
      case "call": {
        const out = callOf(e.call, pre);
        if (!out) throw new Leave();
        return out;
      }
      default: throw new Leave();
    }
  };

  /** A unit's number, 0 when it is none or gone. */
  const field = (u: Unit, f: UnitNumField, pre: Stmt[]): NumExpr => {
    if (isNone(u)) return k(0);
    u = held(u, pre);
    const t = fresh("f");
    const body: Stmt[] = [];
    const e = u.e;
    const type = (): NumExpr => {
      const ty = fresh("ty");
      body.push(dec(ty, k(0), 0xffff), ...readInto(ty, e, TYPE));
      return ranged(V(ty), 0, 0xffff);
    };
    switch (f) {
      // Hit points as the game shows them: a started point counts.
      case "hp": body.push(...through(of(e, HP), (h) => [set(t, h(0xffffff00, 8)), ...when(cmp(">=", h(0xff), k(1)), [set(t, bin("+", V(t), k(1)))])])); break;
      case "shields": body.push(...through(of(e, SHIELDS), (h) => [set(t, h(0xffffff00, 8))])); break;
      case "energy": body.push(...through(of(e, ENERGY.dword), (h) => [set(t, h(0xff000000, 24))])); break;
      case "maxHp": { const ty = type(); body.push(...through(bin("+", k(MAX_HP), ty), (h) => [set(t, h(0xffffff00, 8))])); break; }
      case "maxShields": {
        // A word a type: the type's half of the dword the pair of types share.
        const ty = type(), th = fresh("th");
        body.push(dec(th, bin(">>>", ty, k(1)), 0x7fff));
        body.push(...through(bin("+", k(MAX_SHIELDS), V(th)), (h) => when(cmp("==", bin("&", ty, k(1)), k(0)), [set(t, h(0xffff))], [set(t, h(0xffff0000, 16))])));
        break;
      }
      default: {
        const b = FIELDS[f];
        if (!b) throw new Leave();
        body.push(...readInto(t, e, b));
      }
    }
    pre.push(dec(t, k(0)), ...when(present(u), body));
    return V(t);
  };

  /** A unit's true / false, false when it is none or gone. */
  const flag = (u: Unit, f: UnitFlag, pre: Stmt[]): BoolExpr => {
    if (isNone(u)) return { kind: "const", value: false };
    u = held(u, pre);
    if (f === "underAttack") return all([alive(u), cmp(">=", bits(u.e, ATTACKED), k(1))]);
    if (f === "hasTarget") return all([alive(u), cmp(">=", peek(of(u.e, ORDER_TARGET)), k(1))]);
    const mask = FLAG_BITS[f];
    if (mask === undefined) throw new Leave();
    return all([alive(u), cmp("==", peek(of(u.e, STATUS), mask), k(mask))]);
  };

  /** The order Die: what kills a unit, as eudplib's `CUnit.die()`. */
  const die = (e: NumExpr): Stmt => poke(of(e, ORDER.dword), k(0), ORDER.mask);

  /** `u.hp = v` and the rest: nothing happens when the unit is none or gone. */
  const write = (s: Extract<Stmt, { kind: "unitWrite" }>, pre: Stmt[]): void => {
    const u0 = unit(s.unit, pre);
    if (s.field === "invincible" || s.field === "hallucinated" || s.field === "speedUpgrade") {
      const mask = FLAG_BITS[s.field]!;
      const on = fixBool(s.value as BoolExpr, pre);
      const t = fresh("b");
      pre.push(dec(t, k(0), 1), ...when(on, [set(t, k(1))]));
      if (isNone(u0)) return;
      const u = held(u0, pre);
      pre.push(...when(alive(u), [poke(of(u.e, STATUS), bin("*", ranged(V(t), 0, 1), k(mask)), mask)]));
      return;
    }
    const f = s.field as UnitNumField;
    const top = TOPS[f];
    if (top === undefined) throw new Leave();
    const v = plain(atMost(fix(s.value, pre) as NumExpr, top), pre, top);
    if (isNone(u0)) return;
    const u = held(u0, pre);
    const e = u.e;
    let body: Stmt[];
    switch (f) {
      // (Hit points at 0 are a dead unit, so that is what the write makes of it.)
      case "hp": body = when(cmp("==", v, k(0)), [die(e)], [poke(of(e, HP), bin("*", v, k(256)))]); break;
      case "shields": body = [poke(of(e, SHIELDS), bin("*", v, k(256)))]; break;
      case "energy": body = [poke(of(e, ENERGY.dword), bin("*", v, k(2 ** 24)), ENERGY.mask)]; break;
      // (Each of the three cooldowns: the ground weapon's, the air weapon's, the spells'.)
      case "cooldown": body = [poke(of(e, 0x54 >> 2), bin("*", v, k(0x01010100)), 0xffffff00)]; break;
      // (The matrix's frames, with 250 points for them to take off — as the Science Vessel's cast gives — or 0 points when the frames are 0.)
      case "matrix": {
        const b = FIELDS.matrix!;
        body = [poke(of(e, b.dword), v, b.mask), ...when(cmp(">=", v, k(1)), [poke(of(e, MATRIX_HP.dword), k(MATRIX_POINTS * 2 ** MATRIX_HP.shift), MATRIX_HP.mask)], [poke(of(e, MATRIX_HP.dword), k(0), MATRIX_HP.mask)])];
        break;
      }
      default: {
        const b = FIELDS[f]!;
        body = [poke(of(e, b.dword), b.shift ? bin("*", v, k(2 ** b.shift)) : v, b.mask)];
      }
    }
    pre.push(...when(alive(u), body));
  };

  /** `u.kill()` and the rest: nothing happens when the unit is none or gone. */
  const verb = (s: Extract<Stmt, { kind: "unitDo" }>, pre: Stmt[]): void => {
    const u0 = unit(s.unit, pre);
    const v = s.verb;
    // (The amount is worked out whether or not there is a unit.)
    const amount = v.do === "damage" || v.do === "heal" ? plain(fix(v.amount, pre) as NumExpr, pre) : null;
    if (isNone(u0)) return;
    const u = held(u0, pre);
    const e = u.e;
    const body: Stmt[] = [];
    switch (v.do) {
      case "kill": body.push(die(e)); break;
      // (eudplib's `CUnit.remove()`: the unit leaves without dying.)
      case "remove": body.push(poke(of(e, USER_ACTION.dword), k(4 * 2 ** USER_ACTION.shift), USER_ACTION.mask), die(e)); break;
      case "locate": {
        const x = fresh("x"), y = fresh("y");
        body.push(dec(x, k(0), 0xffff), dec(y, k(0), 0xffff), ...through(of(e, POSITION), (h) => [set(x, h(X.mask, X.shift)), set(y, h(Y.mask, Y.shift))]), { kind: "centerLocation", location: v.location, x: V(x), y: V(y), ...at() } as Stmt);
        break;
      }
      case "order": {
        // The game's own Order, reaching this unit alone: a scratch location made a box of 4 by 4 around it for the one
        // action, then put back as it was (the Python side's `order`).
        const base = MRGN + 5 * (SCRATCH_LOCATION - 1);
        const kept = [0, 1, 2, 3, 4].map((i) => {
          const t = fresh("loc");
          body.push(dec(t, peek(k(base + i))));
          return t;
        });
        const x = fresh("x"), y = fresh("y"), ty = fresh("ty"), ow = fresh("ow");
        body.push(dec(x, k(0), 0xffff), dec(y, k(0), 0xffff), dec(ty, k(0), 0xffff), dec(ow, k(0), 255));
        body.push(...through(of(e, POSITION), (h) => [set(x, h(X.mask, X.shift)), set(y, h(Y.mask, Y.shift))]), ...readInto(ty, e, TYPE), ...readInto(ow, e, OWNER));
        const box = [bin("-", V(x), k(2)), bin("-", V(y), k(2)), bin("+", V(x), k(2)), bin("+", V(y), k(2)), k(0)];
        box.forEach((value, i) => body.push(poke(k(base + i), value)));
        const record: ActionRecord = { location: SCRATCH_LOCATION, text: 0, wav: 0, time: 0, player: 0, target: v.target, unitId: 0, type: ORDER_ACTION, modifier: ORDERS[v.order], flags: 16, padding: 0, mask: 0 };
        body.push({ kind: "action", record, variables: [{ field: "player", bits: 32, name: "owner", expr: ranged(V(ow), 0, 255) }, { field: "unitId", bits: 16, name: "type", expr: ranged(V(ty), 0, 0xffff) }], ...at() } as Stmt);
        kept.forEach((t, i) => body.push(poke(k(base + i), V(t))));
        break;
      }
      case "give": {
        // eudplib's `CUnit.cgive`: the owner's byte, and the unit taken out of its owner's list and put in the new
        // owner's after its first unit — or as its first, when it has none. (The Python side's `unit_do`.)
        const to = playerOf(v.to, body);
        const D = DEATHS / 4;
        const ptrOf = (e_: NumExpr): NumExpr => bin("+", bin("*", e_, k(4)), k(DEATHS));
        const was = fresh("ow"), pp = fresh("pp"), np = fresh("np"), hp = fresh("hp"), nn = fresh("nn");
        const P = (id: string) => ranged(V(id), 0, 0x3fffffff);
        const isUnit = (id: string) => cmp(">=", P(id), k(IN_TABLE));
        const at_ = (id: string, off: number) => bin("+", P(id), k(off - D));
        body.push(
          dec(was, k(0), 15), dec(pp, k(0), 0x3fffffff), dec(np, k(0), 0x3fffffff), dec(nn, k(0), 0x3fffffff),
          ...through(of(e, OWNER.dword), (h) => [set(was, h(0xf))]), poke(of(e, OWNER.dword), to, OWNER.mask),
          ...through(of(e, PREV_UNIT), (h) => [set(pp, h(POINTER, 2))]), ...through(of(e, NEXT_UNIT), (h) => [set(np, h(POINTER, 2))]),
          ...when(isUnit(pp), [poke(at_(pp, NEXT_UNIT), bin("*", P(np), k(4)))], [poke(bin("+", k(FIRST_UNIT), ranged(V(was), 0, 15)), bin("*", P(np), k(4)))]),
          ...when(isUnit(np), [poke(at_(np, PREV_UNIT), bin("*", P(pp), k(4)))]),
          dec(hp, peek(bin("+", k(FIRST_UNIT), to), POINTER, 2), 0x3fffffff),
          ...when(isUnit(hp), [
            ...through(at_(hp, NEXT_UNIT), (h) => [set(nn, h(POINTER, 2))]),
            poke(at_(hp, NEXT_UNIT), ptrOf(e)), poke(of(e, NEXT_UNIT), bin("*", P(nn), k(4))), poke(of(e, PREV_UNIT), bin("*", P(hp), k(4))),
            ...when(isUnit(nn), [poke(at_(nn, PREV_UNIT), ptrOf(e))]),
          ], [poke(bin("+", k(FIRST_UNIT), to), ptrOf(e)), poke(of(e, NEXT_UNIT), k(0)), poke(of(e, PREV_UNIT), k(0))]),
          { kind: "action", record: FORGET_COUNTS, ...at() } as Stmt,
        );
        break;
      }
      case "damage": case "heal": {
        // Hit points down — at 0 the unit dies — or up to the type's most, in the game's own units (256 to a point).
        const now = fresh("hp"), ty = fresh("ty"), top = fresh("top"), step = fresh("step");
        body.push(dec(now, k(0)), dec(ty, k(0), 0xffff), dec(top, k(0)));
        body.push(...through(of(e, HP), (h) => [set(now, h())]), ...readInto(ty, e, TYPE), ...through(bin("+", k(MAX_HP), ranged(V(ty), 0, 0xffff)), (h) => [set(top, h())]));
        body.push(dec(step, v.percent ? ({ kind: "binary", op: "/", left: bin("*", V(top), amount!), right: k(100), unsigned: true, ...at() } as NumExpr) : bin("*", atMost(amount!, 0xffffff), k(256))));
        if (v.do === "damage") body.push(...when(cmp("<=", V(now), V(step)), [die(e)], [poke(of(e, HP), bin("-", V(now), V(step)))]));
        else {
          const nw = fresh("hp");
          body.push(dec(nw, bin("+", V(now), V(step))), ...when(cmp(">=", V(nw), V(top)), [set(nw, V(top))]), poke(of(e, HP), V(nw)));
        }
        break;
      }
    }
    pre.push(...when(alive(u), body));
  };

  /**
   * `select(player, units)`: on that player's own computer, the selection becomes the units still there — up to twelve,
   * the rest of its slots emptied, the panel told — and a Select command of their tags (place + 1, uniqueness byte
   * shifted up 11) is queued to every computer, so the player's orders go to them everywhere; nothing on any other.
   */
  const select = (s: Extract<Stmt, { kind: "select" }>, pre: Stmt[]): void => {
    if (s.player !== CURRENT_PLAYER && (s.player < 0 || s.player > 11)) throw new Leave();
    const who = playerOf(s.player, pre);
    const us = s.units.slice(0, SELECTION_MOST).map((x) => held(unit(x, pre), pre)).filter((u) => !isNone(u));
    const ks = us.map((u) => uidOf(u, pre));
    const N = fresh("n"), M = fresh("m"), L = fresh("len"), body: Stmt[] = [dec(N, k(0), SELECTION_MOST), dec(M, k(0), SELECTION_MOST)];
    const n = ranged(V(N), 0, SELECTION_MOST), m = ranged(V(M), 0, SELECTION_MOST);
    const ptrOf = (e: NumExpr): NumExpr => bin("+", bin("*", e, k(4)), k(DEATHS));
    for (const u of us) body.push(...when(alive(u), [poke(bin("+", k(SELECTION), n), ptrOf(u.e)), set(N, bin("+", V(N), k(1)))]));
    /** A byte into the queue, `at` bytes into it. */
    const putByte = (at: NumExpr, value: NumExpr): Stmt[] => {
      const w = fresh("qw"), b = fresh("qb");
      const into = bin("+", k(QUEUE), V(w));
      const byte = (j: number): Stmt[] => [poke(into, j ? bin("*", value, k(2 ** (8 * j))) : value, (0xff * 2 ** (8 * j)) >>> 0)];
      return [dec(w, bin(">>>", at, k(2)), 0x3fffffff), dec(b, bin("&", at, k(3)), 3),
        ...when(cmp("==", V(b), k(0)), byte(0), when(cmp("==", V(b), k(1)), byte(1), when(cmp("==", V(b), k(2)), byte(2), byte(3))))];
    };
    const tags: Stmt[] = [];
    us.forEach((u, j) => {
      const tag = fresh("tag"), slot = fresh("slot");
      tags.push(...when(alive(u), [
        dec(slot, { kind: "binary", op: "/", left: bin("-", u.e, k(UNIT_TABLE)), right: k(STRIDE), unsigned: true, ...at() } as NumExpr, PLACES - 1),
        dec(tag, bin("+", bin("+", V(slot), k(1)), bin("*", ks[j], k(2048))), 0xffff),
        ...putByte(bin("+", bin("+", V(L), k(2)), bin("*", m, k(2))), bin("&", V(tag), k(0xff))),
        ...putByte(bin("+", bin("+", V(L), k(3)), bin("*", m, k(2))), bin(">>>", V(tag), k(8))),
        set(M, bin("+", V(M), k(1))),
      ]));
    });
    body.push(...when(cmp(">=", n, k(1)), [
      ...Array.from({ length: SELECTION_MOST }, (_, i) => when(cmp("<=", n, k(i)), [poke(k(SELECTION + i), k(0))])).flat(),
      poke(k(PANEL), k(1), 0xff),
      dec(L, peek(k(QUEUED))),
      // (Only when the queue has room for it, as eudplib's QueueGameCommand.)
      ...when(cmp(">=", peek(k(QUEUE_MOST)), ranged(bin("+", bin("+", V(L), k(4)), bin("*", n, k(2))), 0, 0x7fffffff)), [
        ...putByte(V(L), k(SELECT_COMMAND)), ...putByte(bin("+", V(L), k(1)), n),
        ...tags,
        poke(k(QUEUED), bin("+", bin("+", V(L), k(2)), bin("*", n, k(2)))),
      ]),
    ]));
    pre.push(...when(cmp("==", peek(k(LOCAL)), who), body));
  };

  /** Two units the same unit of the game (and there is one). */
  const same = (a: Unit, b: Unit, pre: Stmt[]): BoolExpr => {
    if (isNone(a) || isNone(b)) return { kind: "const", value: false };
    a = held(a, pre);
    b = held(b, pre);
    const items: BoolExpr[] = [cmp(">=", a.e, k(1)), cmp("==", a.e, b.e)];
    // (The uniqueness bytes: one kept against the other, or against the place's as it is now.)
    if (a.k && b.k) items.push(cmp("==", a.k, b.k));
    else if (a.k || b.k) {
      const [kept, now] = a.k ? [a, b] : [b, a];
      items.push(cmp("==", bits(now.e, UID), ranged(bin("*", kept.k!, k(256)), 0, 0xff00)));
    }
    return all(items);
  };

  // ── calls ──
  /**
   * A call, its parameters and result of units as two numbers each: the call a statement in `pre`, and the unit it gives
   * back when it gives back one.
   */
  const callOf = (c: Call, pre: Stmt[]): Unit | null => {
    const params: Call["params"] = [];
    for (const p of c.params) {
      if (p.decl.kind !== "unit") { params.push({ ...p, init: fix(p.init, pre) as NumExpr }); continue; }
      const u = unit(p.init as UnitExpr, pre);
      params.push({ decl: asNumber(p.decl, "e"), init: u.e, label: p.label }, { decl: asNumber(p.decl, "k"), init: uidOf(u, pre), label: p.label });
    }
    const unitResult = c.result?.kind === "unit";
    const res = c.result && unitResult ? { decl: asNumber(c.result.decl, "e"), kind: "number" as const } : c.result;
    // (Inlined, the call's own result is what its `return`s write; called, the function's, copied after.)
    if (c.fn === undefined) results.push(unitResult ? pair(c.result!.decl.id).k : null);
    const body = c.fn === undefined ? stmts(c.body) : c.body;
    if (c.fn === undefined) results.pop();
    const saves = c.saves ? { ...c.saves, vars: c.saves.vars.flatMap((id) => (unitIds.has(id) ? [pair(id).e, pair(id).k] : [id])) } : undefined;
    if (unitResult) pre.push(dec(pair(c.result!.decl.id).k, k(0), 255));
    pre.push({ kind: "call", call: { ...c, params, body, ...(res ? { result: res } : {}), ...(saves ? { saves } : {}) }, at: c.at, label: c.label } as Stmt);
    if (!unitResult) return null;
    const r = pair(c.result!.decl.id);
    if (c.fn !== undefined) {
      const f = functions.get(c.fn);
      if (!f?.result) throw new Leave();
      pre.push(set(r.k, V(pair(f.result.decl.id).k)));
    }
    return { e: ranged(V(r.e), 0, UNIT_TABLE + STRIDE * PLACES), k: ranged(V(r.k), 0, 255), none: true, killed: false };
  };

  /** The ids of the program's unit variables, wherever declared. */
  const unitIds = new Set<string>();
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(collect); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { decl?: VarDecl; params?: VarDecl[] };
    if (o.decl && typeof o.decl === "object" && o.decl.kind === "unit") unitIds.add(o.decl.id);
    for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
  };
  collect(program);

  // ── expressions ──
  /**
   * An expression with what it reads of units as numbers, worked out in `pre` first: a field, a flag, whether a unit is
   * there, two compared, a part kept in an array. A call with units among its parameters or as its result, likewise.
   */
  const fix = (x: unknown, pre: Stmt[]): unknown => {
    if (Array.isArray(x)) return x.map((y) => fix(y, pre));
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown> & { kind?: string };
    switch (o.kind) {
      case "unitField": {
        const e = o as unknown as Extract<NumExpr, { kind: "unitField" }>;
        const v = field(unit(e.unit, pre), e.field, pre);
        const r = (e as NumExpr & { range?: readonly [number, number] }).range;
        return r && v.kind === "var" ? ranged(v, r[0], r[1]) : v;
      }
      case "unitPart": {
        const e = o as unknown as Extract<NumExpr, { kind: "unitPart" }>;
        const u = unit(e.unit, pre);
        // (A map of our own keeps a unit as its EPD and its uniqueness byte: the pointer is the EPD, 0 for none.)
        return e.part === "uid" ? ranged(uidOf(u, pre), 0, 255) : u.e;
      }
      case "unitAlive": return alive(held(unit((o as { unit: UnitExpr }).unit, pre), pre));
      case "unitFlag": { const e = o as unknown as Extract<BoolExpr, { kind: "unitFlag" }>; return flag(unit(e.unit, pre), e.flag, pre); }
      case "unitSame": { const e = o as unknown as Extract<BoolExpr, { kind: "unitSame" }>; return same(unit(e.left, pre), unit(e.right, pre), pre); }
      case "selected": {
        // `local.selected` (step 12): the unit in a slot of this computer's selection, re-checked before use as a kept
        // unit is (its uniqueness byte taken when read). The slot holds a pointer, or 0 for none.
        const e = o as unknown as Extract<UnitExpr, { kind: "selected" }>;
        const p = fresh("sel");
        pre.push(dec(p, peek(k(SELECTION + e.index), POINTER, 2), 0x3fffffff), ...when(cmp(">=", V(p), k(IN_TABLE)), [set(p, bin("-", V(p), k(DEATHS / 4)))], [set(p, k(0))]));
        return { e: ranged(V(p), 0, UNIT_TABLE + STRIDE * PLACES), k: null, none: true, killed: true };
      }
    }
    // (A call inside an expression: a statement of its own first when it takes or gives back units.)
    if (o.kind === "call" && o.call && typeof o.call === "object") {
      const c = o.call as Call;
      if (c.params.some((p) => p.decl.kind === "unit") || hasUnits(c.body)) {
        callOf(c, pre);
        if (!c.result) throw new Leave();
        return { kind: "var", id: c.result.decl.id };
      }
    }
    return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, key === "at" || !v || typeof v !== "object" ? v : fix(v, pre)]));
  };
  const fixBool = (e: BoolExpr, pre: Stmt[]): BoolExpr => fix(e, pre) as BoolExpr;

  // ── statements ──
  const stmts = (list: Stmt[]): Stmt[] => list.flatMap(stmt);
  const stmt = (s: Stmt): Stmt[] => {
    if (!hasUnits(s)) return [s];
    const was = here;
    here = s.at ?? here;
    try {
      return rewrite(s);
    } catch (err) {
      if (err instanceof Leave) return [s];
      throw err;
    } finally {
      here = was;
    }
  };
  const rewrite = (s: Stmt): Stmt[] => {
    const pre: Stmt[] = [];
    switch (s.kind) {
      case "declare": case "assignUnit": {
        if (s.kind === "declare" && s.decl.kind !== "unit") break;
        const id = s.kind === "declare" ? s.decl.id : s.target;
        const u = unit((s.kind === "declare" ? s.init : s.value) as UnitExpr, pre);
        const p = pair(id);
        const kv = uidOf(u, pre);
        if (s.kind === "declare") return [...pre, { kind: "declare", decl: asNumber(s.decl, "e"), init: u.e, at: s.at, label: s.label }, { kind: "declare", decl: asNumber(s.decl, "k"), init: kv, at: s.at, label: s.label }];
        return [...pre, { kind: "assign", target: p.e, value: u.e, at: s.at, label: s.label }, { kind: "assign", target: p.k, value: kv, at: s.at, label: s.label }];
      }
      case "unitLoop": {
        if (s.source) return [...pre, ...eventLoop(s)];
        const killed = mayKill(s.body);
        const out = scan(s.filter, pre, (q) => {
          turns.set(s.decl.id, { q, killed });
          try {
            return stmts(s.body);
          } finally {
            turns.delete(s.decl.id);
          }
        });
        return [...pre, ...out];
      }
      // (A task's call as an inlined call's: a unit among its parameters two numbers, its body rewritten.)
      case "start": {
        callOf(s.call, pre);
        const made = pre.pop() as Extract<Stmt, { kind: "call" }>;
        return [...pre, { ...s, call: made.call }];
      }
      case "unitWrite": write(s, pre); return pre;
      case "unitDo": verb(s, pre); return pre;
      case "select": select(s, pre); return pre;
      case "call": { callOf(s.call, pre); return pre; }
      case "return": {
        const into = results[results.length - 1];
        if (into === undefined || into === null || !s.value) break;
        const u = unit(s.value as UnitExpr, pre);
        const kv = uidOf(u, pre);
        return [...pre, set(into, kv), { ...s, value: u.e }];
      }
      case "while": case "for": {
        const cond = s.cond ? fixBool(s.cond, pre) : undefined;
        const body = stmts(s.body);
        const update = s.kind === "for" ? stmts(s.update) : [];
        if (!pre.length) return [s.kind === "for" ? { ...s, cond, body, update } : { ...s, cond, body }];
        // The test needs statements first: at the top of each turn, before it.
        const leave = when({ kind: "not", expr: cond! }, [brk()]);
        return [s.kind === "for" ? { ...s, cond: undefined, body: [...pre, ...leave, ...body], update } : { ...s, cond: undefined, body: [...pre, ...leave, ...body] }];
      }
      case "do": {
        const cond = fixBool(s.cond, pre);
        if (pre.length) throw new Leave();
        return [{ ...s, body: stmts(s.body), cond }];
      }
    }
    // Anything else: its expressions, then its statements.
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(s)) {
      if (key === "at" || !v || typeof v !== "object") out[key] = v;
      else if (isStmtList(v)) out[key] = stmts(v);
      else if (key === "iterations") out[key] = (v as Stmt[][]).map(stmts);
      else if (key === "cases") out[key] = (v as { value: unknown; body: Stmt[] }[]).map((c) => ({ ...c, body: stmts(c.body) }));
      else if (key === "catch" || key === "finally") out[key] = v;
      else out[key] = fix(v, pre);
    }
    return [...pre, out as unknown as Stmt];
  };

  // The functions that are called: units among their parameters and result as two numbers each.
  const rewritten: FuncDecl[] = (program.functions ?? []).map((f) => {
    if (!hasUnits(f)) return f;
    here = f.at;
    const params = f.params.flatMap((p) => (p.kind === "unit" ? [asNumber(p, "e"), asNumber(p, "k")] : [p]));
    const unitResult = f.result?.kind === "unit";
    results.push(unitResult ? pair(f.result!.decl.id).k : null);
    const body = stmts(f.body);
    results.pop();
    return {
      ...f, params,
      ...(f.result ? { result: unitResult ? { decl: asNumber(f.result.decl, "e"), kind: "number" as const } : f.result } : {}),
      body: unitResult ? [dec(pair(f.result!.decl.id).k, k(0), 255), ...body] : body,
    };
  });
  here = program.at;
  const body = stmts(program.body);
  // The map's events pass, and its lists, in the program that lays it out; the lists in every program that reads them.
  const sources = events?.sources ?? new Set<EventSource>();
  const passed = events?.pass && sources.size ? { pass: pass(sources) } : {};
  const lists = sources.size ? [MADE, ...(sources.has("died") || sources.has("killed") ? [GONE] : []), ...(sources.has("ordered") ? [TURNED, TURNED_WAS] : []), ...(sources.has("morphed") ? [CHANGED, CHANGED_WAS] : [])] : [];
  const arrays = [...(program.arrays ?? []), ...lists.map((id): ArrayDecl => ({ id, name: "(events)", kind: "number", length: EVENT_CAP, shared: true, at: AT0 }))];
  if (usesMe) body.unshift(dec(ME_ID, peek(k(CURRENT))));
  return { ...program, body, ...(program.functions ? { functions: rewritten } : {}), ...passed, ...(lists.length ? { arrays } : {}) };
}
