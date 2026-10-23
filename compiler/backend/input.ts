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
 */
import type { ArrayDecl, At, BoolExpr, NumExpr, Program, Stmt, VarDecl } from "../ir";
import type { ActionRecord } from "../../vendor/triggers";
import { MOUSE_BUTTONS, inputsOf, virtualKey, type InputSource, type MouseButton } from "../input";

/** What the build says of the map: the human players' slots, the map in pixels, the unit-properties slot (1-based) it wrote as "in transit", and the carrier type. */
export interface OwnMap { humans: number[]; width: number; height: number; cuwp: number; carrier?: number }

export interface OwnInputPlan {
  humans: number[];
  /** Bit `i` of a state is key `i`'s; the buttons' bits follow. */
  keys: string[];
  buttons: MouseButton[];
  mouse: boolean;
  /** How many `sync()` slots the programs use, numbered across the build. */
  syncs: number;
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
export const RING = 6;
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
const BUTTON_BITS: Record<MouseButton, number> = { left: 2, right: 8, middle: 32 };
const NEXT_UNIT = 0x6c >> 2, ORDER_TARGET = 0x58 >> 2, OWNER_DWORD = 0x4c >> 2, STATUS = 0xdc >> 2, UID_DWORD = 0xa4 >> 2;
const SET_DEATHS = 45, SET_TO = 7, MASKED = 0x4353;
const CREATE_WITH_PROPERTIES = 11, GIVE_UNITS = 48, NEUTRAL = 11;
const AT0: At = { file: "", line: 0, column: 0 };

/* ── the cells ── */
const CARRIERS = "@in.carrier", TAGS = "@in.tag", WRITE = "@in.wr", READ = "@in.rd";
const STATE = "@in.state", PRESSED = "@in.pressed", SENT = "@in.sent";
const MX = "@in.mx", MY = "@in.my", SENT_MX = "@in.smx", SENT_MY = "@in.smy";
const EXPECT = "@in.expect", SLOT = "@in.slot";
const SYNC = "@in.sync", PENDING = "@in.pend";
const MADE = "@in.made";
const SLOTS = 8;
const MESSAGES = 0, POINTS = 1;
const KIND_STATE = 0, KIND_SYNC = 1;

export const INPUT_GLOBALS: readonly VarDecl[] = [{ id: MADE, name: "(input)", kind: "number", shared: true, routed: true, global: true, at: AT0 }];
export const isInputGlobal = (id: string) => id === MADE;
/** The mouse of a player on the map, as the receive pass keeps it: what `underMouse()`'s pick measures from. */
export const MOUSE_CELLS = { x: MX, y: MY };

/** The arrays of the map's the passes and the programs' reads share, which no program declares. */
export function inputArrays(plan: OwnInputPlan): ArrayDecl[] {
  const a = (id: string, length: number): ArrayDecl => ({ id, name: "(input)", kind: "number", length, shared: true, at: AT0 });
  return [
    a(CARRIERS, SLOTS * plan.rings * plan.ring), a(TAGS, SLOTS * plan.rings * plan.ring), a(WRITE, SLOTS * plan.rings), a(READ, SLOTS * plan.rings),
    a(STATE, SLOTS), a(PRESSED, SLOTS), a(SENT, SLOTS), a(EXPECT, SLOTS), a(SLOT, SLOTS),
    ...(plan.mouse ? [a(MX, SLOTS), a(MY, SLOTS), a(SENT_MX, SLOTS), a(SENT_MY, SLOTS)] : []),
    ...(plan.syncs ? [a(SYNC, SLOTS * plan.syncs), a(PENDING, plan.syncs)] : []),
  ];
}

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
export function ownInputPlan(programs: Program[], map: OwnMap): OwnInputPlan | string | null {
  const { sources, mouse } = inputsOf(programs);
  // (Chat is step 12's part 2: left to the emitter, which refuses it by name.)
  const taken = sources.filter((s) => s.source !== "chat");
  if (!taken.length && !mouse) return null;
  if (!map.humans.length) return "a program reads keys, clicks, the mouse or sync(): this map has no human player to read them from";
  const keys: string[] = [], buttons: MouseButton[] = [];
  for (const s of taken) {
    if (s.source === "key" && !keys.includes(s.key)) keys.push(s.key);
    else if (s.source === "click" && !buttons.includes(s.button)) buttons.push(s.button);
  }
  for (const b of MOUSE_BUTTONS) if (!buttons.includes(b)) buttons.push(b);
  const syncs = Math.max(0, ...taken.map((s) => (s.source === "sync" ? s.slot + 1 : 0)));
  const box = { w: map.width - 2, h: map.height - 34 };
  const xb = Math.floor(Math.log2(box.w));
  const bits = Math.floor(Math.log2(2 ** xb * box.h));
  // (A state is a header: its kind takes two bits.)
  if (keys.length + buttons.length > bits - 2) return `a script reads ${keys.length} keys: on a map this size it can read ${bits - 2 - buttons.length} at the most`;
  if (bits < 16) return "the map is too small to carry the players' input: 32 by 32 tiles at the least";
  return { humans: map.humans, keys, buttons, mouse, syncs, carrier: map.carrier ?? CARRIER, cuwp: map.cuwp, ring: RING, rings: mouse ? 2 : 1, xb, bits, box };
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
      case "chat": throw new Error("chat");
    }
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
    if (Array.isArray(x)) return x.map(fix);
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown> & { kind?: string };
    if (o.kind === "input" && (o.input as InputSource).source !== "chat") return read(o.input as InputSource);
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
    out.push(set(MADE, k(1)));
    return out;
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
          const raw: Stmt[] = [];
          if (plan.syncs) raw.push(store(SYNC, bin("+", bin("*", element(SLOT, k(h)), k(SLOTS)), k(h)), bin("+", V(value), k(1))));
          raw.push(store(EXPECT, k(h), bin("-", element(EXPECT, k(h)), k(1))));
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
            ...when(cmp(">=", peek(k(QUEUE_MOST)), ranged(bin("+", V(q), k(16 + 28)), 0, 0x7fffffff)), [
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
