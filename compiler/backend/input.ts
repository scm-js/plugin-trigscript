/**
 * The players' input in a map of our own (TrigScript 4, step 12 of the way off eudplib): keys, clicks, the mouse and
 * `sync()`, carried between the players' computers by the map itself, in place of chatEvent and MSQC.
 *
 * A key is pressed on one computer. What a map can carry to every computer is a game command: the game sends each
 * player's commands to all of them in turns and runs them in step, so what a command leaves in the game's memory is
 * the same everywhere. The carrier is a unit, as MSQC's: for each human player a ring of hidden units of theirs, and
 * a send is a Select of the next one and a targeted Move to a point — the point is the value, in the carrier's order
 * target (`+0x58`) that same frame. Every computer, before the programs' turns (the receive pass, `receive`), reads
 * each human's ring from its read cursor, takes what arrived in order, writes 0 back and moves the cursor on. After the
 * programs' turns (the send pass, `send`), the computer the player sits at reads what they did and queues what changed,
 * never more in flight than the ring holds, and then a Select of the player's own selection, so their orders go on
 * reaching their units. A turn that brings several frames' sends keeps every one.
 *
 * Two rings a human: **points** (the mouse, raw, one a frame when it moved) and **messages**, each a header and then
 * the raw values the header counts: a *state* (a bit a key the programs read, then the three mouse buttons; sent when
 * it changed, paid out one a frame on arrival, so a key is held for as many frames as it was down, and a press is the
 * frame its bit came on), a *sync* (the slot, then the value). The value of a point is `x − 1 + (y − 1) << XB` with
 * `2^XB` the largest power of two at most the map's width in pixels less 2, which the game keeps a Move's target
 * within (x in `[1, W − 2]`, y in `[1, H − 34]`): `bits` of a value, 20 on a 64×64 map.
 *
 * The carriers are made at the first frame, on every computer alike (`startUp`): the chosen type's dat entry patched
 * as MSQC's (the Command Center's flingy so it cannot move, 1×1, no weapon, no sight, no right-click), the units
 * created in transit — hidden, and selectable — through a unit-properties slot the build writes, given to Player 12
 * so they are in no human's list, and their owner byte put back to the player's so a Select and an order of that
 * player reach them. The records' EPDs and tags are kept in cells of the map's.
 *
 * A typed line (part 2) is read where it was typed: the game shows each line as `name:\x07 text` in its thirteen text
 * lines (0x640B60, 218 bytes each) and moves the byte at 0x640B58 on with every line. When that byte has moved, the
 * send pass looks through the lines for one that begins with this computer's player's name (read at the first frame
 * from the player table, 0x57EEEB + 36p), copies the text into cells, swaps the two bytes after the colon so the line is
 * not found again (chatEvent's mark: the line reads the same), and matches the text against the patterns in order —
 * text byte for byte, `{n}` digits, `{k:ore|gas}` and `{u:unit}` by a hash of the word or of the rest of the line
 * (`hashOf`), a unit's name found among the names' hashes in order by halves. The first pattern that fits the whole
 * line goes as a *chat* message: the pattern's number, then its values. On arrival the pattern's flag is up for a
 * frame and its values are in cells.
 */
import { STATEMENT_KINDS } from "./emit";
import type { ArrayDecl, At, BoolExpr, NumExpr, Program, Stmt, VarDecl } from "../ir";
import type { ActionRecord, TriggerRecord } from "../../vendor/triggers";
import { MAX_CHAT_BYTES, MAX_CHAT_NUMBER, MOUSE_BUTTONS, inputsOf, parseChatPattern, virtualKey, type ChatPattern, type InputSource, type MouseButton } from "../input";

/**
 * What the build says of the map: the human players' slots, the map in pixels, the unit-properties slot (1-based) it
 * wrote as "in transit", and the carrier type. `triggers`: the map's own triggers as its TRIG section holds them before
 * the script's records (TrigScript 4, step 13) — laid out with the records, before them; their texts and sound files
 * are the map's strings already.
 */
export interface OwnMap { humans: number[]; width: number; height: number; cuwp: number; carrier?: number; triggers?: TriggerRecord[] }

export interface OwnInputPlan {
  humans: number[];
  /** Bit `i` of a state is key `i`'s; the buttons' bits follow. */
  keys: string[];
  buttons: MouseButton[];
  mouse: boolean;
  /** How many `sync()` slots the programs use, numbered across the build. */
  syncs: number;
  /** The typed-line patterns the programs read, numbered from 1 in this order; the most values one carries; what a number in a line is at most (what a point carries). */
  chats: ChatPattern[];
  captures: number;
  numberMost: number;
  /** The names a `{…:unit}` capture knows: `hashOf` each name in rising order, and the type each means. */
  units: { hashes: number[]; ids: number[] };
  carrier: number;
  cuwp: number;
  /** Carriers a ring, and rings a human (the mouse's second). */
  ring: number;
  rings: number;
  /** The bits of x in a point's value, and the bits a value has. */
  xb: number;
  bits: number;
  /** The Move's target is kept within these (W − 2, H − 34). */
  box: { w: number; h: number };
}

/** The Valkyrie: what MSQC makes its carriers of too. */
export const CARRIER = 58;
/** Carriers a ring. */
export const RING_SIZE = 6;
/** Where the carriers stand, in pixels: the map's top left corner. */
export const CARRIER_X = 64, CARRIER_Y = 64;
/** The most a `sync()` value is: what a point carries on the smallest map the contract holds for (64×64), less the 1 that tells a value from nothing. */
export const SYNC_MOST = 2 ** 20 - 2;

const DEATHS = 0x58a364;
const epd = (address: number) => (address - DEATHS) / 4;
const UNIT_TABLE = 0x59cca8, STRIDE = 336, UNIT_TABLE_EPD = epd(UNIT_TABLE);
const LOCAL = epd(0x512684), CURRENT = epd(0x6509b0), SELECTION = epd(0x6284b8), QUEUE = epd(0x654880), QUEUED = epd(0x654aa0), QUEUE_MOST = epd(0x57f0d8);
const FIRST_UNIT = epd(0x6283f8), MRGN = epd(0x58dc60), SCRATCH_LOCATION = 255;
const KEYS = 0x596a18, TYPING = epd(0x68c144), BUTTONS = epd(0x6cddc0), MOUSE_X = epd(0x6cddc4), MOUSE_Y = epd(0x6cddc8), SCREEN_X = epd(0x62848c), SCREEN_Y = epd(0x6284a8);
/** The text lines: the byte that moves with every line shown, the lines, a line's bytes, how many; the player table and where a name is in a record. */
const TEXT_RING = epd(0x640b58), TEXT_LINES = epd(0x640b60), TEXT_LINE = 218, TEXT_LINE_COUNT = 13, PLAYERS = epd(0x57eee0), PLAYER_STRIDE = 36, NAME_OFFSET = 11, NAME_MOST = 24;
const BUTTON_BITS: Record<MouseButton, number> = { left: 2, right: 8, middle: 32 };
const NEXT_UNIT = 0x6c >> 2, ORDER_TARGET = 0x58 >> 2, OWNER_DWORD = 0x4c >> 2, STATUS = 0xdc >> 2, UID_DWORD = 0xa4 >> 2;
const SET_DEATHS = 45, SET_TO = 7, MASKED = 0x4353;
const CREATE_WITH_PROPERTIES = 11, GIVE_UNITS = 48, NEUTRAL = 11;
const AT0: At = { file: "", line: 0, column: 0 };

/* ── the cells ── */
const CARRIERS = "@in.carrier", TAGS = "@in.tag", WRITE = "@in.wr", READ = "@in.rd";
const STATE = "@in.state", PRESSED = "@in.pressed", SENT = "@in.sent", READ_1 = "@in.raw1", READ_2 = "@in.raw2";
const MX = "@in.mx", MY = "@in.my", SENT_MX = "@in.smx", SENT_MY = "@in.smy";
const EXPECT = "@in.expect", SLOT = "@in.slot";
const SYNC = "@in.sync", PENDING = "@in.pend";
/** A typed line, on arrival: the pattern that came (0 none), a flag a pattern, the values a pattern, the pattern whose values are coming and how many came. */
const CHAT = "@in.chat", CHAT_FLAG = "@in.chatf", CAPTURES = "@in.cap", CHAT_PENDING = "@in.cpend", CAPTURE_AT = "@in.ci";
/** A typed line, where it was typed: the text ring's byte as last seen, the name prefix and its length, the line's text and its length, the pattern matched and its values, the unit names' hashes and types. */
const RING = "@in.ring", NAME = "@in.name", NAME_LENGTH = "@in.nlen", LINE = "@in.line", LINE_LENGTH = "@in.llen", TYPED = "@in.typed", TYPED_VALUES = "@in.tval", UNIT_HASHES = "@in.uh", UNIT_IDS = "@in.uu";
const MADE = "@in.made";
const SLOTS = 8;
const MESSAGES = 0, POINTS = 1;
const KIND_STATE = 0, KIND_SYNC = 1, KIND_CHAT = 2;

const global = (id: string): VarDecl => ({ id, name: "(input)", kind: "number", shared: true, routed: true, global: true, at: AT0 });
export const INPUT_GLOBALS: readonly VarDecl[] = [global(MADE), global(RING), global(NAME_LENGTH), global(LINE_LENGTH), global(TYPED)];
export const isInputGlobal = (id: string) => INPUT_GLOBALS.some((d) => d.id === id);
/** The mouse of a player on the map, as the receive pass keeps it: what `underMouse()`'s pick measures from. */
export const MOUSE_CELLS = { x: MX, y: MY };

/** The arrays of the map's the passes and the programs' reads share, which no program declares. */
export function inputArrays(plan: OwnInputPlan): ArrayDecl[] {
  const a = (id: string, length: number): ArrayDecl => ({ id, name: "(input)", kind: "number", length, shared: true, at: AT0 });
  const chats = plan.chats.length, captures = plan.captures, units = plan.units.hashes.length;
  return [
    a(CARRIERS, SLOTS * plan.rings * plan.ring), a(TAGS, SLOTS * plan.rings * plan.ring), a(WRITE, SLOTS * plan.rings), a(READ, SLOTS * plan.rings),
    a(STATE, SLOTS), a(PRESSED, SLOTS), a(SENT, SLOTS), a(READ_1, SLOTS), a(READ_2, SLOTS), a(EXPECT, SLOTS), a(SLOT, SLOTS),
    ...(plan.mouse ? [a(MX, SLOTS), a(MY, SLOTS), a(SENT_MX, SLOTS), a(SENT_MY, SLOTS)] : []),
    ...(plan.syncs ? [a(SYNC, SLOTS * plan.syncs), a(PENDING, plan.syncs)] : []),
    ...(chats ? [a(CHAT, SLOTS), a(CHAT_FLAG, SLOTS * chats), a(CHAT_PENDING, SLOTS), a(CAPTURE_AT, SLOTS), a(NAME, NAME_MOST + 3), a(LINE, MAX_CHAT_BYTES + 1)] : []),
    ...(chats && captures ? [a(CAPTURES, SLOTS * chats * captures), a(TYPED_VALUES, captures)] : []),
    ...(units ? [{ ...a(UNIT_HASHES, units), unsigned: true, values: plan.units.hashes }, { ...a(UNIT_IDS, units), values: plan.units.ids }] : []),
  ];
}

/** What a word or a unit's name hashes to, in a typed line: capitals A to Z as small letters, h = h × 31 + byte, in 32 bits. */
export function hashOf(data: Uint8Array): number {
  let h = 0;
  for (let b of data) {
    if (b >= 65 && b <= 90) b += 32;
    h = (Math.imul(h, 31) + b) >>> 0;
  }
  return h;
}
const bytesOf = (s: string) => new TextEncoder().encode(s);

/** Whether a program reads the players, or sends to them. */
export function hasInput(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasInput);
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: string; mouse?: unknown };
  if (o.kind === "input" || o.kind === "syncSend") return true;
  // (A pick near a player's mouse reads the mouse the receive pass keeps.)
  if (o.kind === "pick" && o.mouse !== undefined) return true;
  return Object.values(o).some((v) => v && typeof v === "object" && hasInput(v));
}

/**
 * The plan for a build's programs: null when none reads the players; a string when the map cannot carry what they
 * read, worded for the script's author.
 */
export function ownInputPlan(programs: Program[], map: OwnMap, unitNames: readonly (readonly [string, number])[] = []): OwnInputPlan | string | null {
  const { sources, mouse } = inputsOf(programs);
  if (!sources.length && !mouse) return null;
  if (!map.humans.length) return "a program reads keys, clicks, the mouse, typed lines or sync(): this map has no human player to read them from";
  const keys: string[] = [], buttons: MouseButton[] = [], chats: ChatPattern[] = [];
  for (const s of sources) {
    if (s.source === "key" && !keys.includes(s.key)) keys.push(s.key);
    else if (s.source === "click" && !buttons.includes(s.button)) buttons.push(s.button);
    else if (s.source === "chat" && !chats.some((c) => c.pattern === s.pattern)) {
      try { chats.push(parseChatPattern(s.pattern)); } catch (err) { return err instanceof Error ? err.message : String(err); }
    }
  }
  for (const b of MOUSE_BUTTONS) if (!buttons.includes(b)) buttons.push(b);
  const syncs = Math.max(0, ...sources.map((s) => (s.source === "sync" ? s.slot + 1 : 0)));
  const box = { w: map.width - 2, h: map.height - 34 };
  const xb = Math.floor(Math.log2(box.w));
  const bits = Math.floor(Math.log2(2 ** xb * box.h));
  // (A state is a header: its kind takes two bits.)
  if (keys.length + buttons.length > bits - 2) return `a script reads ${keys.length} keys: on a map this size it can read ${bits - 2 - buttons.length} at the most`;
  if (bits < 16) return "the map is too small to carry the players' input: 32 by 32 tiles at the least";
  const captures = Math.max(0, ...chats.map((c) => c.captures.length));
  // (A unit's name by its hash, the first of a hash's names: `{…:unit}` gives the type of the name typed.)
  const byHash = new Map<number, number>();
  if (chats.some((c) => c.captures.some((x) => x.kind === "unit"))) for (const [name, id] of unitNames) { const h = hashOf(bytesOf(name)); if (!byHash.has(h)) byHash.set(h, id); }
  const sorted = [...byHash].sort((a, b) => a[0] - b[0]);
  const units = { hashes: sorted.map((x) => x[0]), ids: sorted.map((x) => x[1]) };
  return { humans: map.humans, keys, buttons, mouse, syncs, chats, captures, numberMost: Math.min(MAX_CHAT_NUMBER, 2 ** bits - 1), units, carrier: map.carrier ?? CARRIER, cuwp: map.cuwp, ring: RING_SIZE, rings: mouse ? 2 : 1, xb, bits, box };
}

/** What MSQC's `Respawn` writes into the dat tables for its carrier type: each a byte, word or dword at an address. */
export function carrierDat(type: number): { address: number; bytes: 1 | 2 | 4; value: number }[] {
  return [
    { address: 0x6644f8 + type, bytes: 1, value: 94 }, // flingy: the Command Center's, top speed 0
    { address: 0x6617c8 + type * 8, bytes: 4, value: 0x10001 }, { address: 0x6617cc + type * 8, bytes: 4, value: 0x10001 }, // dimensions 1×1
    { address: 0x662860 + type * 4, bytes: 4, value: 0 }, // building dimensions
    { address: 0x6636b8 + type, bytes: 1, value: 130 }, { address: 0x6616e0 + type, bytes: 1, value: 130 }, // no ground or air weapon
    { address: 0x662db8 + type, bytes: 1, value: 0 }, { address: 0x663238 + type, bytes: 1, value: 0 }, // seek range, sight range
    { address: 0x662098 + type, bytes: 1, value: 6 }, // right-click action: none
    { address: 0x664080 + type * 4, bytes: 4, value: 0x38000025 }, // special ability flags
    { address: 0x6637a0 + type, bytes: 1, value: 0 }, // group flags
    { address: 0x660fc8 + type, bytes: 1, value: 0xc5 }, { address: 0x663150 + type, bytes: 1, value: 0x13 }, // movement flags, elevation
  ];
}

/**
 * The program with its input as reads of the map's cells, and — when `passes` — the map's receive pass (before the
 * events pass, in `Program.pass`) and send pass (`Program.after`).
 */
export function inputValues(program: Program, plan: OwnInputPlan, passes: boolean): Program {
  let here: At = program.at;
  let made = 0;
  const fresh = (what: string) => `@in.${what}${made++}`;
  const owner = !program.perPlayer && program.owners.length <= 1 && program.owner >= 0 && program.owner < 8 ? program.owner : undefined;

  // ── the IR's pieces ──
  const at = () => ({ at: here, label: "" });
  const k = (value: number): NumExpr => ({ kind: "const", value });
  const V = (id: string): NumExpr => ({ kind: "var", id });
  const bin = (op: "+" | "-" | "*" | "&" | "^" | ">>>", a: NumExpr, b: NumExpr): NumExpr => {
    if (a.kind === "const" && b.kind === "const") {
      const [x, y] = [a.value >>> 0, b.value >>> 0];
      return k((op === "+" ? x + y : op === "-" ? x - y : op === "*" ? Number((BigInt(x) * BigInt(y)) & 0xffffffffn) : op === "&" ? x & y : op === "^" ? x ^ y : x >>> y) >>> 0);
    }
    return { kind: "binary", op, left: a, right: b, ...at() } as NumExpr;
  };
  const div = (a: NumExpr, by: number): NumExpr => ({ kind: "binary", op: "/", left: a, right: k(by), unsigned: true, ...at() } as NumExpr);
  const cmp = (op: "==" | "!=" | "<" | "<=" | ">" | ">=", a: NumExpr, b: NumExpr): BoolExpr => ({ kind: "compare", op, left: a, right: b, unsigned: true, ...at() });
  const ranged = (e: NumExpr, lo: number, hi: number): NumExpr => ({ ...e, range: [lo, hi] }) as unknown as NumExpr;
  const num = (id: string, top?: number, keep?: "routed" | "everywhere"): VarDecl => ({ id, name: "(input)", kind: "number", shared: false, at: here, temp: true, ...(top !== undefined ? { top } : {}), ...(keep ? { [keep]: true } : {}) } as VarDecl);
  const dec = (id: string, init: NumExpr, top?: number, keep?: "routed" | "everywhere"): Stmt => ({ kind: "declare", decl: num(id, top, keep), init, ...at() });
  const set = (target: string, value: NumExpr): Stmt => ({ kind: "assign", target, value, ...at() });
  const when = (cond: BoolExpr, then: Stmt[], otherwise: Stmt[] = []): Stmt[] => [{ kind: "if", cond, then, ...(otherwise.length ? { else: otherwise } : {}), ...at() }];
  const loop = (body: Stmt[]): Stmt => ({ kind: "while", cond: undefined, body, ...at() } as Stmt);
  const brk = (): Stmt => ({ kind: "break", ...at() });
  const element = (array: string, index: NumExpr): NumExpr => ({ kind: "element", array, index, at: here });
  const store = (array: string, index: NumExpr, value: NumExpr): Stmt => ({ kind: "store", array, index, value, ...at() });
  /** The dword at an EPD, or its bits of the mask, moved down `shift`. */
  const peek = (at_: NumExpr, mask = 0xffffffff, shift = 0): NumExpr => {
    const whole = mask >>> 0 === 0xffffffff;
    const record = { location: whole ? 0 : mask >>> 0, player: 0, amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: whole ? 0 : MASKED };
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
  /** A byte, word or dword at an address, as a Set Deaths of its dword's bits. */
  const pokeAt = (address: number, bytes: 1 | 2 | 4, value: number): Stmt => {
    const shift = 8 * (address & 3), mask = bytes === 4 ? 0xffffffff : ((2 ** (8 * bytes) - 1) * 2 ** shift) >>> 0;
    return poke(k(epd(address & ~3)), k((value * 2 ** shift) >>> 0), mask);
  };
  /** The byte at an address, 0 to 255. */
  const byteAt = (address: number): NumExpr => ranged(peek(k(epd(address & ~3)), (0xff * 2 ** (8 * (address & 3))) >>> 0, 8 * (address & 3)), 0, 255);
  const action = (record: ActionRecord): Stmt => ({ kind: "action", record, ...at() } as Stmt);
  const local = (): NumExpr => ranged(peek(k(LOCAL)), 0, 255);

  /** The player a source names: a slot, or the current player — this run's when known when built, else read. */
  const playerOf = (p: number): NumExpr => {
    if (p !== 13) return k(p);
    if (owner !== undefined) return k(owner);
    return ranged(peek(k(CURRENT), 0xff), 0, 255);
  };
  const cell = (array: string, p: NumExpr, base = 0): NumExpr => element(array, base ? bin("+", k(base), p) : p);
  const bitOf = (s: InputSource & { source: "key" | "click" }): number => (s.source === "key" ? plan.keys.indexOf(s.key) : plan.keys.length + plan.buttons.indexOf(s.button));

  // ── the reads ──
  const read = (s: InputSource): NumExpr => {
    const p = playerOf(s.player);
    switch (s.source) {
      case "key": case "click": {
        const bit = bitOf(s);
        return ranged(bin(">>>", bin("&", cell(s.source === "key" && s.held ? STATE : PRESSED, p), k(2 ** bit)), k(bit)), 0, 1);
      }
      case "mouse": return ranged(cell(s.axis === "x" ? MX : MY, p), 0, 0xffff);
      case "sync": return cell(SYNC, p, s.slot * SLOTS);
      case "chat": {
        const index = plan.chats.findIndex((c) => c.pattern === s.pattern);
        if (index < 0) throw new Error(`the input plan has no pattern ${JSON.stringify(s.pattern)}`);
        if (s.capture === null) return ranged(cell(CHAT_FLAG, p, index * SLOTS), 0, 1);
        return cell(CAPTURES, p, captureAt(index, s.capture));
      }
    }
  };
  /** Where a pattern's capture is kept, by player: a cell a player after the base. */
  const captureAt = (pattern: number, capture: number, player = 0) => (pattern * plan.captures + capture) * SLOTS + player;
  /** The byte `offset` bytes after an aligned EPD, read from its dword's quarter: the statements, and the variable the byte is in. */
  const byteFrom = (base: number, offset: NumExpr): { get: Stmt[]; b: string } => {
    const o = fresh("o"), e = fresh("e"), r = fresh("r"), b = fresh("b");
    return { b, get: [
      dec(o, offset, 0xffff), dec(e, bin("+", k(base), bin(">>>", V(o), k(2))), 0x3fffffff, "routed"), dec(r, bin("&", V(o), k(3)), 3), dec(b, k(0), 255),
      ...[0, 1, 2, 3].flatMap((q) => when(cmp("==", V(r), k(q)), [set(b, ranged(peek(V(e), (0xff * 2 ** (8 * q)) >>> 0, 8 * q), 0, 255))])),
    ] };
  };
  /** A byte written `offset` bytes after an aligned EPD. */
  const pokeByte = (base: number, offset: NumExpr, value: number): Stmt[] => {
    const o = fresh("o"), e = fresh("e"), r = fresh("r");
    return [
      dec(o, offset, 0xffff), dec(e, bin("+", k(base), bin(">>>", V(o), k(2))), 0x3fffffff, "routed"), dec(r, bin("&", V(o), k(3)), 3),
      ...[0, 1, 2, 3].flatMap((q) => when(cmp("==", V(r), k(q)), [poke(V(e), k((value * 2 ** (8 * q)) >>> 0), (0xff * 2 ** (8 * q)) >>> 0)])),
    ];
  };
  /** `syncSend`: on the player's own computer, the value kept to what a point carries, plus 1, left for the send pass. */
  const syncSend = (slot: number, player: number, value: NumExpr): Stmt[] => {
    const v = fresh("v");
    return when(cmp("==", local(), playerOf(player)), [
      dec(v, value),
      ...when(cmp(">=", V(v), k(0x80000000)), [set(v, k(0))]),
      ...when(cmp(">=", V(v), k(SYNC_MOST + 1)), [set(v, k(SYNC_MOST))]),
      store(PENDING, k(slot), bin("+", V(v), k(1))),
    ]);
  };

  const fix = (x: unknown): unknown => {
    // (A list of statements inside a statement — an if's, a loop's, a try's — as statements: a sync() in it is lowered too.)
    if (Array.isArray(x)) return x.length && x[0] && typeof x[0] === "object" && STATEMENT_KINDS.has((x[0] as { kind?: string }).kind ?? "") ? stmts(x as Stmt[]) : x.map(fix);
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown> & { kind?: string };
    if (o.kind === "input") return read(o.input as InputSource);
    return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, key === "at" || !v || typeof v !== "object" ? v : fix(v)]));
  };
  const stmts = (list: Stmt[]): Stmt[] => list.flatMap(stmt);
  const stmt = (s: Stmt): Stmt[] => {
    if (!hasInput(s)) return [s];
    const was = here;
    here = s.at ?? here;
    try {
      if (s.kind === "syncSend") return syncSend(s.slot, s.player, fix(s.value) as NumExpr);
      return [fix(s) as Stmt];
    } finally { here = was; }
  };

  // ── the carriers ──
  const ringBase = (h: number, ring: number) => (ring * SLOTS + h) * plan.ring;
  const cursor = (h: number, ring: number) => k(ring * SLOTS + h);
  /** A value into its point: x − 1 + (y − 1) << XB. */
  const xOf = (v: NumExpr): NumExpr => ranged(bin("+", bin("&", v, k(2 ** plan.xb - 1)), k(1)), 1, 2 ** plan.xb);
  const yOf = (v: NumExpr): NumExpr => ranged(bin("+", bin(">>>", v, k(plan.xb)), k(1)), 1, plan.box.h);

  /**
   * The first frame: the carriers made, on every computer alike. The dat entry patched; for each human, the scratch
   * location a point at the corner, the ring's units created there in transit and given to Player 12, then found at the
   * head of Player 12's list — the EPD and the tag of each kept, the owner byte put back to the player's, the unit made
   * to stack and never collide.
   */
  const startUp = (): Stmt[] => {
    const out: Stmt[] = [];
    for (const d of carrierDat(plan.carrier)) out.push(pokeAt(d.address, d.bytes, d.value));
    out.push(pokeAt(0x661518 + plan.carrier * 2, 2, 0x1cf)); // (StarEdit's availability, while they are made)
    const side = (i: number, v: number) => poke(k(MRGN + 5 * (SCRATCH_LOCATION - 1) + i), k(v));
    out.push(side(0, CARRIER_X), side(1, CARRIER_Y), side(2, CARRIER_X), side(3, CARRIER_Y), poke(k(MRGN + 5 * (SCRATCH_LOCATION - 1) + 4), k(0), 0xffff0000));
    const n = plan.rings * plan.ring;
    for (const h of plan.humans) {
      for (let i = 0; i < n; i++) out.push(action({ location: SCRATCH_LOCATION, text: 0, wav: 0, time: 0, player: h, target: plan.cuwp, unitId: plan.carrier, type: CREATE_WITH_PROPERTIES, modifier: 1, flags: 0x1c, padding: 0, mask: 0 }));
      out.push(action({ location: SCRATCH_LOCATION, text: 0, wav: 0, time: 0, player: h, target: NEUTRAL, unitId: plan.carrier, type: GIVE_UNITS, modifier: n, flags: 0x14, padding: 0, mask: 0 }));
      // (The given units head Player 12's list, the last made first: a pointer's EPD is its address over 4, less the deaths table's.)
      const p = fresh("p");
      out.push(dec(p, bin("-", peek(k(FIRST_UNIT + NEUTRAL), 0xfffffffc, 2), k(DEATHS / 4)), 0x3fffffff, "routed"));
      for (let i = 0; i < n; i++) {
        const slot = ringBase(h, Math.floor(i / plan.ring)) + (i % plan.ring);
        const index = fresh("ix"), uid = fresh("uid");
        out.push(
          store(CARRIERS, k(slot), V(p)),
          dec(index, div(bin("-", V(p), k(UNIT_TABLE_EPD)), STRIDE / 4), 1699, "routed"),
          dec(uid, peek(bin("+", V(p), k(UID_DWORD)), 0xff00, 8), 255, "routed"),
          store(TAGS, k(slot), bin("+", bin("+", V(index), k(1)), bin("*", V(uid), k(2048)))),
          poke(bin("+", V(p), k(OWNER_DWORD)), k(h), 0xff),
          poke(bin("+", V(p), k(STATUS)), k(0xa00000), 0xa00000),
          poke(bin("+", V(p), k(ORDER_TARGET)), k(0)),
        );
        if (i + 1 < n) out.push(set(p, bin("-", peek(bin("+", V(p), k(NEXT_UNIT)), 0xfffffffc, 2), k(DEATHS / 4))));
      }
    }
    out.push(pokeAt(0x661518 + plan.carrier * 2, 2, 0));
    // (The mouse as last sent: where a point starts, so the first frame sends nothing.)
    if (plan.mouse) for (const h of plan.humans) out.push(store(SENT_MX, k(h), k(1)), store(SENT_MY, k(h), k(1)));
    // This computer's player's name, with the ":\x07 " the game shows after it: what a line of theirs begins with.
    if (plan.chats.length) {
      const lp = fresh("lp"), n = fresh("nl");
      const byte = byteFrom(PLAYERS, bin("+", k(NAME_OFFSET), bin("+", bin("*", V(lp), k(PLAYER_STRIDE)), V(n))));
      out.push(dec(lp, local(), 255), ...when(cmp("<", V(lp), k(SLOTS)), [
        dec(n, k(0), NAME_MOST),
        loop([
          ...when(cmp(">=", V(n), k(NAME_MOST)), [brk()]),
          ...byte.get,
          ...when(cmp("==", V(byte.b), k(0)), [brk()]),
          store(NAME, V(n), V(byte.b)),
          set(n, bin("+", V(n), k(1))),
        ]),
        store(NAME, V(n), k(0x3a)), store(NAME, bin("+", V(n), k(1)), k(7)), store(NAME, bin("+", V(n), k(2)), k(0x20)),
        set(NAME_LENGTH, bin("+", V(n), k(3))),
        set(RING, ranged(peek(k(TEXT_RING), 0xff), 0, 255)),
      ]));
    }
    out.push(set(MADE, k(1)));
    return out;
  };

  // ── a typed line, where it was typed ──
  /**
   * The line's text (`LINE`, `LINE_LENGTH`) against each pattern in turn: the first that fits the whole line is `TYPED`,
   * its values `TYPED_VALUES`. A pattern's block is a loop left at the first mismatch.
   */
  const matchLine = (): Stmt[] => {
    const out: Stmt[] = [];
    const matched = fresh("m");
    out.push(dec(matched, k(0), 1));
    const lineByte = (at: NumExpr) => ranged(element(LINE, at), 0, 255);
    plan.chats.forEach((c, index) => {
      const body: Stmt[] = [];
      let pos: number | string = 0;
      const posVar = (): string => {
        if (typeof pos === "string") return pos;
        const p = fresh("pos");
        body.push(dec(p, k(pos), MAX_CHAT_BYTES + 1));
        pos = p;
        return p;
      };
      const values: string[] = [];
      for (const seg of c.segments) {
        if (typeof seg === "string") {
          const data = bytesOf(seg);
          data.forEach((byte, j) => {
            const b = fresh("sb");
            body.push(dec(b, lineByte(typeof pos === "number" ? k(pos + j) : bin("+", V(pos), k(j))), 255), ...when(cmp("!=", V(b), k(byte)), [brk()]));
          });
          if (typeof pos === "number") pos += data.length;
          else body.push(set(pos, bin("+", V(pos), k(data.length))));
          continue;
        }
        const cap = c.captures[seg];
        const p = posVar();
        const value = fresh("cv"), ch = fresh("ch");
        values.push(value);
        body.push(dec(value, k(0)));
        if (cap.kind === "number") {
          // Digits, the value kept to what a point carries.
          const digits = fresh("dg");
          body.push(dec(digits, k(0), MAX_CHAT_BYTES), loop([
            ...when(cmp(">=", V(p), V(LINE_LENGTH)), [brk()]),
            dec(ch, lineByte(V(p)), 255),
            ...when(cmp("<", V(ch), k(48)), [brk()]), ...when(cmp(">", V(ch), k(57)), [brk()]),
            set(value, bin("*", V(value), k(10))), set(value, bin("+", V(value), V(ch))), set(value, bin("-", V(value), k(48))),
            ...when(cmp(">", V(value), k(plan.numberMost)), [set(value, k(plan.numberMost))]),
            set(p, bin("+", V(p), k(1))), set(digits, bin("+", V(digits), k(1))),
          ]), ...when(cmp("==", V(digits), k(0)), [brk()]));
          continue;
        }
        // A word (to the next space) or the rest of the line, hashed as `hashOf`.
        const h = fresh("h"), found = fresh("fd");
        body.push(dec(h, k(0)), loop([
          ...when(cmp(">=", V(p), V(LINE_LENGTH)), [brk()]),
          dec(ch, lineByte(V(p)), 255),
          ...(cap.kind === "word" ? when(cmp("==", V(ch), k(32)), [brk()]) : []),
          ...when({ kind: "and", items: [cmp(">=", V(ch), k(65)), cmp("<=", V(ch), k(90))] }, [set(ch, bin("+", V(ch), k(32)))]),
          set(h, bin("*", V(h), k(31))), set(h, bin("+", V(h), V(ch))),
          set(p, bin("+", V(p), k(1))),
        ]), dec(found, k(0), 1));
        if (cap.kind === "word") {
          cap.words.forEach((w, i) => body.push(...when(cmp("==", V(h), k(hashOf(bytesOf(w)))), [set(value, k(i)), set(found, k(1))])));
        } else {
          // The names' hashes in rising order, searched by halves.
          const count = plan.units.hashes.length;
          const lo = fresh("lo"), hi = fresh("hi"), mid = fresh("mid"), hm = fresh("hm"), hl = fresh("hl");
          body.push(dec(lo, k(0), count), dec(hi, k(count), count), loop([
            ...when(cmp(">=", V(lo), V(hi)), [brk()]),
            dec(mid, bin(">>>", bin("+", V(lo), V(hi)), k(1)), count),
            dec(hm, ranged(element(UNIT_HASHES, V(mid)), 0, 0xffffffff)),
            ...when(cmp("<", V(hm), V(h)), [set(lo, bin("+", V(mid), k(1)))], [set(hi, V(mid))]),
          ]));
          if (count) body.push(...when(cmp("<", V(lo), k(count)), [dec(hl, ranged(element(UNIT_HASHES, V(lo)), 0, 0xffffffff)), ...when(cmp("==", V(hl), V(h)), [set(value, ranged(element(UNIT_IDS, V(lo)), 0, 0xffff)), set(found, k(1))])]));
        }
        body.push(...when(cmp("==", V(found), k(0)), [brk()]));
      }
      body.push(...when(cmp("!=", typeof pos === "number" ? k(pos) : V(pos), V(LINE_LENGTH)), [brk()]));
      body.push(set(TYPED, k(index + 1)));
      values.forEach((v, i) => body.push(store(TYPED_VALUES, k(i), V(v))));
      body.push(set(matched, k(1)), brk());
      out.push(...when(cmp("==", V(matched), k(0)), [loop(body)]));
    });
    return out;
  };

  /**
   * When the text ring's byte has moved: each of the thirteen lines that begins with this player's name prefix is
   * theirs — its text copied into `LINE`, the two bytes after the colon swapped so it is not found again, and matched.
   */
  const typedLines = (): Stmt[] => {
    const cur = fresh("cur"), o = fresh("lo"), slot = fresh("ls"), j = fresh("j"), nb = fresh("nb"), i = fresh("i");
    const pre = byteFrom(TEXT_LINES, bin("+", V(o), V(j)));
    const text = byteFrom(TEXT_LINES, bin("+", bin("+", V(o), V(NAME_LENGTH)), V(i)));
    const mine: Stmt[] = [
      dec(i, k(0), MAX_CHAT_BYTES),
      loop([
        ...when(cmp(">=", V(i), k(MAX_CHAT_BYTES)), [brk()]),
        ...text.get,
        ...when(cmp("==", V(text.b), k(0)), [brk()]),
        store(LINE, V(i), V(text.b)),
        set(i, bin("+", V(i), k(1))),
      ]),
      set(LINE_LENGTH, V(i)),
      ...pokeByte(TEXT_LINES, bin("-", bin("+", V(o), V(NAME_LENGTH)), k(2)), 0x20),
      ...pokeByte(TEXT_LINES, bin("-", bin("+", V(o), V(NAME_LENGTH)), k(1)), 0x07),
      ...matchLine(),
    ];
    return [
      dec(cur, ranged(peek(k(TEXT_RING), 0xff), 0, 255), 255),
      ...when(cmp("!=", V(cur), V(RING)), [
        set(RING, V(cur)),
        dec(o, k(0), TEXT_LINE * TEXT_LINE_COUNT), dec(slot, k(0), TEXT_LINE_COUNT),
        loop([
          ...when(cmp(">=", V(slot), k(TEXT_LINE_COUNT)), [brk()]),
          dec(j, k(0), NAME_MOST + 3),
          loop([
            ...when(cmp(">=", V(j), V(NAME_LENGTH)), [brk()]),
            ...pre.get,
            dec(nb, ranged(element(NAME, V(j)), 0, 255), 255),
            ...when(cmp("!=", V(pre.b), V(nb)), [brk()]),
            set(j, bin("+", V(j), k(1))),
          ]),
          ...when(cmp("==", V(j), V(NAME_LENGTH)), mine),
          set(o, bin("+", V(o), k(TEXT_LINE))), set(slot, bin("+", V(slot), k(1))),
        ]),
      ]),
    ];
  };

  // ── the receive pass ──
  /**
   * Each human's rings read from the read cursor: a carrier whose order target holds a point has a packet, taken and
   * the target written back to 0. The points ring: the mouse, one a frame. The messages ring: a header (a state, paid out
   * one a frame; a sync's slot) or the raw value a header said would follow.
   */
  const receive = (): Stmt[] => {
    const out: Stmt[] = [];
    for (let h = 0; h < SLOTS; h++) {
      if (!plan.humans.includes(h)) continue;
      out.push(store(PRESSED, k(h), k(0)));
      for (let s = 0; s < plan.syncs; s++) out.push(store(SYNC, k(s * SLOTS + h), k(0)));
      // (A typed line that arrived the frame before: its flag down and its values cleared.)
      if (plan.chats.length) {
        const came = fresh("came");
        out.push(...when(cmp(">=", element(CHAT, k(h)), k(1)), [
          dec(came, element(CHAT, k(h)), plan.chats.length),
          ...plan.chats.flatMap((c, i) => when(cmp("==", V(came), k(i + 1)), [store(CHAT_FLAG, k(i * SLOTS + h), k(0)), ...c.captures.map((_, ci) => store(CAPTURES, k(captureAt(i, ci, h)), k(0)))])),
          store(CHAT, k(h), k(0)),
        ]));
      }
    }
    for (const h of plan.humans) {
      for (let ring = 0; ring < plan.rings; ring++) {
        const rd = fresh("rd"), c = fresh("c"), v = fresh("v"), value = fresh("val"), n = fresh("n");
        const body: Stmt[] = [
          dec(c, element(CARRIERS, bin("+", k(ringBase(h, ring)), V(rd))), 0x3fffffff, "routed"),
          dec(v, peek(bin("+", V(c), k(ORDER_TARGET)))),
          ...when(cmp("==", V(v), k(0)), [brk()]),
          poke(bin("+", V(c), k(ORDER_TARGET)), k(0)),
          set(rd, bin("+", V(rd), k(1))),
          ...when(cmp(">=", V(rd), k(plan.ring)), [set(rd, k(0))]),
          store(READ, cursor(h, ring), V(rd)),
        ];
        if (ring === POINTS) {
          body.push(store(MX, k(h), bin("&", V(v), k(0xffff))), store(MY, k(h), bin(">>>", V(v), k(16))), brk());
        } else {
          const header: Stmt[] = [];
          const kind = fresh("kind"), payload = fresh("pay");
          header.push(dec(kind, bin("&", V(value), k(3)), 3), dec(payload, bin(">>>", V(value), k(2)), 2 ** (plan.bits - 2) - 1));
          const old = fresh("old");
          header.push(...when(cmp("==", V(kind), k(KIND_STATE)), [
            dec(old, element(STATE, k(h)), 2 ** (plan.bits - 2) - 1),
            store(STATE, k(h), V(payload)),
            store(PRESSED, k(h), bin("&", V(payload), bin("^", V(old), k(2 ** (plan.bits - 2) - 1)))),
            brk(),
          ]));
          if (plan.syncs) header.push(...when(cmp("==", V(kind), k(KIND_SYNC)), [store(SLOT, k(h), V(payload)), store(EXPECT, k(h), k(1))]));
          // (A typed line: the pattern's number, then as many values as it has; one with none has arrived at once.)
          if (plan.chats.length) {
            header.push(...when(cmp("==", V(kind), k(KIND_CHAT)), [
              store(CHAT_PENDING, k(h), V(payload)), store(CAPTURE_AT, k(h), k(0)),
              ...plan.chats.flatMap((c, i) => when(cmp("==", V(payload), k(i + 1)), c.captures.length
                ? [store(EXPECT, k(h), k(c.captures.length))]
                : [store(CHAT, k(h), k(i + 1)), store(CHAT_FLAG, k(i * SLOTS + h), k(1)), store(CHAT_PENDING, k(h), k(0))])),
            ]));
          }
          const sync: Stmt[] = [];
          if (plan.syncs) sync.push(store(SYNC, bin("+", bin("*", element(SLOT, k(h)), k(SLOTS)), k(h)), bin("+", V(value), k(1))));
          sync.push(store(EXPECT, k(h), bin("-", element(EXPECT, k(h)), k(1))));
          let raw = sync;
          if (plan.chats.length) {
            const came = fresh("cp"), ci = fresh("ci");
            raw = when(cmp(">=", element(CHAT_PENDING, k(h)), k(1)), [
              dec(came, element(CHAT_PENDING, k(h)), plan.chats.length), dec(ci, element(CAPTURE_AT, k(h)), plan.captures),
              ...plan.chats.flatMap((c, i) => c.captures.flatMap((_, cj) => when({ kind: "and", items: [cmp("==", V(came), k(i + 1)), cmp("==", V(ci), k(cj))] }, [store(CAPTURES, k(captureAt(i, cj, h)), V(value))]))),
              store(CAPTURE_AT, k(h), bin("+", V(ci), k(1))),
              store(EXPECT, k(h), bin("-", element(EXPECT, k(h)), k(1))),
              ...when(cmp("==", element(EXPECT, k(h)), k(0)), [
                store(CHAT, k(h), V(came)),
                ...plan.chats.flatMap((_, i) => when(cmp("==", V(came), k(i + 1)), [store(CHAT_FLAG, k(i * SLOTS + h), k(1))])),
                store(CHAT_PENDING, k(h), k(0)),
              ]),
            ], sync);
          }
          // (A point the send pass made: x and y are 1 at the least, which the subtractions lean on. Each a step of its
          // own: folded into one sum, the emitter's bit-sliced copy of v got the constant wrong — 2026-10-23.)
          const x = fresh("x"), y = fresh("y");
          body.push(dec(x, bin("&", V(v), k(0xffff)), 0xffff), set(x, bin("-", V(x), k(1))), dec(y, bin(">>>", V(v), k(16)), 0xffff), set(y, bin("-", V(y), k(1))));
          body.push(dec(value, bin("+", V(x), bin("*", V(y), k(2 ** plan.xb))), 2 ** plan.bits - 1));
          body.push(...when(cmp("==", element(EXPECT, k(h)), k(0)), header, raw));
        }
        out.push(dec(rd, element(READ, cursor(h, ring)), plan.ring - 1), dec(n, k(0), plan.ring), loop([...when(cmp(">=", V(n), k(plan.ring)), [brk()]), set(n, bin("+", V(n), k(1))), ...body]));
      }
    }
    return [...when(cmp("==", V(MADE), k(0)), startUp()), ...out];
  };

  // ── the send pass ──
  /**
   * On this computer's player's own: the keys and buttons read into a state and sent when it changed; the mouse on the
   * map sent when it moved; a pending sync sent as its header and value; then the player's own selection put back.
   * A send is a Select of the ring's next carrier and a Move to the point, 16 bytes into the game's queue as four
   * dwords — the queue brought to a dword first with KeepAlive bytes (0x05, which the game passes over).
   */
  const send = (): Stmt[] => {
    const out: Stmt[] = [];
    for (const h of plan.humans) {
      const body: Stmt[] = [];
      const sent = fresh("sent");
      body.push(dec(sent, k(0), 1));
      /** `at`: the queue's used length, kept in a variable, brought to a multiple of 4 with KeepAlives. */
      const q = fresh("q");
      body.push(dec(q, peek(k(QUEUED)), 0x7fffffff, "routed"));
      const align = (): Stmt[] => {
        const r = fresh("r");
        return [
          dec(r, bin("&", V(q), k(3)), 3),
          ...[1, 2, 3].flatMap((rr) => when(cmp("==", V(r), k(rr)), [poke(bin("+", k(QUEUE), bin(">>>", V(q), k(2))), k((0x05050505 * 2 ** (8 * rr)) >>> 0), (0xffffffff * 2 ** (8 * rr)) >>> 0), set(q, bin("+", V(q), k(4 - rr)))])),
        ];
      };
      /**
       * A packet to the ring's next carrier when the ring has room for `need` more and the queue for this one: 16
       * bytes; `flag` set to 1 when it went.
       */
      const packet = (ring: number, x: NumExpr, y: NumExpr, flag: string, need = 1): Stmt[] => {
        const wr = fresh("wr"), ahead = fresh("ahead"), tag = fresh("tag"), w = fresh("w");
        return [
          dec(wr, element(WRITE, cursor(h, ring)), plan.ring - 1),
          // (In flight: what the write cursor is ahead of the read one by; a ring with no room waits.)
          dec(ahead, bin("+", V(wr), k(plan.ring)), 2 * plan.ring),
          set(ahead, bin("-", V(ahead), element(READ, cursor(h, ring)))),
          ...when(cmp(">=", V(ahead), k(plan.ring)), [set(ahead, bin("-", V(ahead), k(plan.ring)))]),
          ...when(cmp("<=", V(ahead), k(plan.ring - 1 - need)), [
            ...align(),
            // (Room in the queue for every packet of the message and the restoring Select, so that none goes without the rest.)
            ...when(cmp(">=", peek(k(QUEUE_MOST)), ranged(bin("+", V(q), k(16 * need + 28)), 0, 0x7fffffff)), [
              dec(tag, element(TAGS, bin("+", k(ringBase(h, ring)), V(wr))), 0xffff),
              dec(w, bin("+", k(QUEUE), bin(">>>", V(q), k(2))), 0x3fffffff),
              poke(V(w), bin("+", k(0x09 | (1 << 8)), bin("*", V(tag), k(0x10000)))),
              poke(bin("+", V(w), k(1)), bin("+", bin("+", k(0x15), bin("*", x, k(0x100))), bin("*", bin("&", y, k(0xff)), k(0x1000000)))),
              poke(bin("+", V(w), k(2)), bin("+", bin(">>>", y, k(8)), k(0xe4000000))),
              poke(bin("+", V(w), k(3)), k(0x05000600)),
              set(q, bin("+", V(q), k(16))),
              poke(k(QUEUED), V(q)),
              set(wr, bin("+", V(wr), k(1))),
              ...when(cmp(">=", V(wr), k(plan.ring)), [set(wr, k(0))]),
              store(WRITE, cursor(h, ring), V(wr)),
              set(sent, k(1)),
              set(flag, k(1)),
            ]),
          ]),
        ];
      };
      const message = (value: NumExpr, flag: string, need = 1): Stmt[] => packet(MESSAGES, xOf(value), yOf(value), flag, need);
      // The state: a bit a key, unless a line is being typed; then the buttons.
      const now = fresh("now");
      body.push(dec(now, k(0), 2 ** (plan.bits - 2) - 1));
      if (plan.keys.length) {
        body.push(...when(cmp("==", peek(k(TYPING)), k(0)), plan.keys.flatMap((key, i) => when(cmp(">=", byteAt(KEYS + virtualKey(key)!), k(1)), [set(now, bin("+", V(now), k(2 ** i)))]))));
      }
      plan.buttons.forEach((b, i) => body.push(...when(cmp(">=", peek(k(BUTTONS), BUTTON_BITS[b]), k(1)), [set(now, bin("+", V(now), k(2 ** (plan.keys.length + i))))])));
      // A bit that was up the two frames before is kept up for one frame it reads down: in Remastered the key table
      // drops a held key for a frame when it begins to repeat (played 2026-10-23: a hold of F7 gave a second press
      // after 17 frames), so a release goes one frame late and a one-frame gap goes unseen.
      const raw = fresh("raw"), kept = fresh("kept");
      body.push(
        dec(raw, V(now), 2 ** (plan.bits - 2) - 1),
        dec(kept, bin("&", element(READ_1, k(h)), element(READ_2, k(h))), 2 ** (plan.bits - 2) - 1),
        set(now, bin("+", V(now), bin("&", V(kept), bin("^", V(now), k(2 ** (plan.bits - 2) - 1))))),
        store(READ_2, k(h), element(READ_1, k(h))), store(READ_1, k(h), V(raw)),
      );
      const st = fresh("st");
      body.push(...when(cmp("!=", V(now), element(SENT, k(h))), [
        dec(st, k(0), 1),
        ...message(bin("+", k(KIND_STATE), bin("*", V(now), k(4))), st),
        // (Not sent for want of room: what was sent last is what the receivers hold, and the state goes when there is.)
        ...when(cmp("==", V(st), k(1)), [store(SENT, k(h), V(now))]),
      ]));
      // The mouse on the map, kept within what a Move's target may be.
      if (plan.mouse) {
        const mx = fresh("mx"), my = fresh("my");
        body.push(
          dec(mx, bin("+", peek(k(SCREEN_X)), peek(k(MOUSE_X))), 0xffff), dec(my, bin("+", peek(k(SCREEN_Y)), peek(k(MOUSE_Y))), 0xffff),
          ...when(cmp("<", V(mx), k(1)), [set(mx, k(1))]), ...when(cmp(">", V(mx), k(plan.box.w)), [set(mx, k(plan.box.w))]),
          ...when(cmp("<", V(my), k(1)), [set(my, k(1))]), ...when(cmp(">", V(my), k(plan.box.h)), [set(my, k(plan.box.h))]),
        );
        const mv = fresh("mv");
        body.push(...when({ kind: "or", items: [cmp("!=", V(mx), element(SENT_MX, k(h))), cmp("!=", V(my), element(SENT_MY, k(h)))] }, [
          dec(mv, k(0), 1),
          ...packet(POINTS, V(mx), V(my), mv),
          ...when(cmp("==", V(mv), k(1)), [store(SENT_MX, k(h), V(mx)), store(SENT_MY, k(h), V(my))]),
        ]));
      }
      // A typed line, matched: the header (the pattern's number), then its values — all or none.
      if (plan.chats.length) {
        body.push(...typedLines());
        const sh = fresh("sh"), t = fresh("t");
        body.push(...when(cmp(">=", V(TYPED), k(1)), [
          dec(sh, k(0), 1), dec(t, V(TYPED), plan.chats.length),
          ...message(bin("+", k(KIND_CHAT), bin("*", V(t), k(4))), sh, 1 + plan.captures),
          ...when(cmp("==", V(sh), k(1)), [
            ...plan.chats.flatMap((c, i) => c.captures.length ? when(cmp("==", V(t), k(i + 1)), c.captures.flatMap((_, ci) => {
              const f = fresh("cf"), tv = fresh("tv");
              return [dec(f, k(0), 1), dec(tv, element(TYPED_VALUES, k(ci)), 2 ** plan.bits - 1), ...message(V(tv), f)];
            })) : []),
            set(TYPED, k(0)),
          ]),
        ]));
      }
      // Pending syncs: the header (the slot), then the value — both or neither, so the ring needs room for two.
      for (let s = 0; s < plan.syncs; s++) {
        const pending = fresh("pend"), sh = fresh("sh"), sv = fresh("sv");
        body.push(dec(pending, element(PENDING, k(s)), SYNC_MOST + 1, "routed"));
        body.push(...when(cmp(">=", V(pending), k(1)), [
          dec(sh, k(0), 1), dec(sv, k(0), 1),
          ...message(bin("+", k(KIND_SYNC), k(s * 4)), sh, 2),
          ...when(cmp("==", V(sh), k(1)), [...message(bin("-", V(pending), k(1)), sv), store(PENDING, k(s), k(0))]),
        ]));
      }
      // The player's own selection put back: a Select of the units in this computer's twelve slots.
      const restore: Stmt[] = [];
      {
        const n = fresh("n"), w = fresh("w");
        restore.push(dec(n, k(0), 12));
        const tags: string[] = [];
        for (let i = 0; i < 12; i++) {
          const ptr = fresh("sp"), tag = fresh("stag"), index = fresh("six"), uid = fresh("suid");
          tags.push(tag);
          restore.push(dec(tag, k(0), 0xffff, "routed"));
          // (The slot's pointer over 4: a unit's is at least the table's; its EPD is that less the deaths table's.)
          restore.push(...when(cmp("==", V(n), k(i)), [
            dec(ptr, peek(k(SELECTION + i), 0xfffffffc, 2), 0x3fffffff, "routed"),
            ...when(cmp(">=", V(ptr), k(UNIT_TABLE / 4)), [
              set(ptr, bin("-", V(ptr), k(DEATHS / 4))),
              dec(index, div(bin("-", V(ptr), k(UNIT_TABLE_EPD)), STRIDE / 4), 1699, "routed"),
              dec(uid, peek(bin("+", V(ptr), k(UID_DWORD)), 0xff00, 8), 255, "routed"),
              set(tag, bin("+", bin("+", V(index), k(1)), bin("*", V(uid), k(2048)))),
              set(n, k(i + 1)),
            ]),
          ]));
        }
        restore.push(...align());
        restore.push(...when(cmp(">=", peek(k(QUEUE_MOST)), ranged(bin("+", V(q), k(28)), 0, 0x7fffffff)), [
          dec(w, bin("+", k(QUEUE), bin(">>>", V(q), k(2))), 0x3fffffff),
          // (The first dword: the command, the count, the first tag; then two tags a dword; KeepAlives after the last.)
          poke(V(w), bin("+", bin("+", k(0x09), bin("*", V(n), k(0x100))), bin("*", V(tags[0]), k(0x10000)))),
          ...[1, 2, 3, 4, 5, 6].map((d) => poke(bin("+", V(w), k(d)), d < 6 ? bin("+", V(tags[2 * d - 1]), bin("*", V(tags[2 * d]), k(0x10000))) : V(tags[11]))),
          // (Where the count leaves a dword's bytes unused, KeepAlives: the Select is 2 + 2n bytes, brought to a multiple of 4.)
          ...Array.from({ length: 13 }, (_, c) => c).flatMap((c) => {
            const bytes = 2 + 2 * c, dwords = Math.ceil(bytes / 4), pad = dwords * 4 - bytes;
            const fixes: Stmt[] = pad ? [poke(bin("+", V(w), k(dwords - 1)), k((0x05050505 * 2 ** (8 * (4 - pad))) >>> 0), (0xffffffff * 2 ** (8 * (4 - pad))) >>> 0)] : [];
            return when(cmp("==", V(n), k(c)), [...fixes, set(q, bin("+", V(q), k(dwords * 4)))]);
          }),
          poke(k(QUEUED), V(q)),
        ]));
      }
      body.push(...when(cmp("==", V(sent), k(1)), restore));
      out.push(...when(cmp("==", local(), k(h)), body));
    }
    return out;
  };

  here = program.at;
  const body = stmts(program.body);
  const functions = program.functions?.map((f) => ({ ...f, body: stmts(f.body) }));
  const passed = passes ? { pass: [...receive(), ...(program.pass ?? [])], after: send() } : {};
  return { ...program, body, ...(functions ? { functions } : {}), ...passed, arrays: [...(program.arrays ?? []), ...inputArrays(plan)] };
}
