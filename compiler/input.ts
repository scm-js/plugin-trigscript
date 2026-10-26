/**
 * What the players do — keys, clicks, the mouse, what they type — as a program reads it.
 *
 * None of it is in the game's own tables where every computer sees the same: a key is pressed on
 * one computer. The build carries it to every computer in step itself (`backend/input.ts`, step 12
 * of the way off eudplib): hidden units of Player 12 are given orders on the computer the input
 * happened on, and the game sends the orders to everyone, where the programs read them back a
 * frame or a few later. What arrives lasts one frame — so an input is true on the frame it
 * arrives and a program that wants it looks every frame. This module is the front end's part:
 * which keys, buttons, typed patterns and sync slots the programs read (`inputPlan`), and what a
 * typed line matches (`matchChat`).
 */
import type { NameTable } from "./names";
import type { NumExpr, Program, Stmt, TextExpr, TextMap, UnitExpr, BoolExpr, Call, At } from "./ir";
import { bodiesOf, isTextExpr, isUnitExpr, mapText, mapTextOperands, mapTextParts } from "./ir";

export type MouseButton = "left" | "right" | "middle";
export const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];

/** The keys `keyPressed()` takes, as a script writes them, and the name each had in MSQC's settings (the build before step 12 carried input through that euddraft plugin; `virtualKey` still goes by these names). */
const NAMED_KEYS: Record<string, string> = {
  Space: "SPACE", Enter: "ENTER", Escape: "ESC", Tab: "TAB", Shift: "SHIFT", Ctrl: "LCTRL", Alt: "LALT",
  Left: "LEFT", Up: "UP", Right: "RIGHT", Down: "DOWN", Backspace: "BACK", Delete: "DELETE", Insert: "INSERT",
  Home: "HOME", End: "END", PageUp: "PGUP", PageDown: "PGDN",
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
/**
 * Keys the game never reports a press of, with why: the slice 4 probe pressed F6 in two builds — once
 * first in MSQC's settings, once third — and nothing arrived either time, while F7, F8, a digit and
 * the letters beside it did. The B2 keys probe (2026-10-17) found F2 to F5 the same, through on.key and
 * keyPressed alike, while Q, F7 and F9 answered: F2–F4 are the game's camera keys. Left out of the list,
 * so writing one is an error and not a silent key. F1, F10, F11 and F12 have not been played.
 */
const kept = (key: string, what: string) => `StarCraft: Remastered keeps ${key} to itself${what} and reports no press of it (played and seen); F7, F8 and F9 work`;
export const DEAF_KEYS: Readonly<Record<string, string>> = {
  F2: kept("F2", " (a camera key)"), F3: kept("F3", " (a camera key)"), F4: kept("F4", " (a camera key)"), F5: kept("F5", ""), F6: kept("F6", ""),
};
/** Every key name, as the declarations list them. */
export const KEY_NAMES: readonly string[] = [
  ...LETTERS, ...DIGITS, ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`).filter((k) => !(k in DEAF_KEYS)), ...Object.keys(NAMED_KEYS), ...DIGITS.map((d) => `Numpad${d}`),
];
const KEY_BY_LOWER = new Map(KEY_NAMES.map((k) => [k.toLowerCase(), k]));

/** The key as the declarations spell it ("f2" → "F2", "space" → "Space"), or null when it is not one. */
export function keyName(v: string): string | null {
  return KEY_BY_LOWER.get(v.trim().toLowerCase()) ?? null;
}

/** The name MSQC's settings took for a key of `KEY_NAMES` (`virtualKey` keys on it). */
export function msqcKey(key: string): string {
  return NAMED_KEYS[key] ?? key.toUpperCase();
}

/** The virtual key a key of `KEY_NAMES` is to the game (a byte of its key table, 0x596A18), or null for a name that is none. */
export function virtualKey(key: string): number | null {
  const k = msqcKey(key);
  if (/^[A-Z0-9]$/.test(k)) return k.charCodeAt(0);
  if (/^F([1-9]|1[0-2])$/.test(k)) return 0x6f + Number(k.slice(1));
  if (/^NUMPAD[0-9]$/.test(k)) return 0x60 + Number(k.slice(6));
  const named: Record<string, number> = { SPACE: 0x20, ENTER: 0x0d, ESC: 0x1b, TAB: 0x09, SHIFT: 0x10, LCTRL: 0x11, LALT: 0x12, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, BACK: 0x08, DELETE: 0x2e, INSERT: 0x2d, HOME: 0x24, END: 0x23, PGUP: 0x21, PGDN: 0x22 };
  return k in named ? named[k] : null;
}

/* ── Chat patterns ── */

/** The most values a typed line can carry (a limit from the carriers' days under MSQC, kept). */
export const MAX_CHAT_CAPTURES = 3;
/** What the game lets a player type. */
export const MAX_CHAT_BYTES = 78;
/** The most a number in a typed line comes through as (what the carriers could send on the smallest map, kept). */
export const MAX_CHAT_NUMBER = 0xfffff;

export type ChatCapture =
  /** `{n}`: a whole number. */
  | { name: string; kind: "number" }
  /** `{unit:unit}`: a unit type by its name, the rest of the line. */
  | { name: string; kind: "unit" }
  /** `{kind:ore|gas}`: one of the words; its place in the list is the value. */
  | { name: string; kind: "word"; words: string[] };

export interface ChatPattern {
  /** As the script wrote it; what tells one pattern from another. */
  pattern: string;
  /** The written text and the captures, in order: text is a string, a capture its index. */
  segments: (string | number)[];
  captures: ChatCapture[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A pattern as its parts. Throws an Error worded for the script's author. */
export function parseChatPattern(pattern: string): ChatPattern {
  if (pattern === "") throw new Error("chatted: the pattern is what the player types, such as \"-give {n}\".");
  if (/[\r\n\0]/.test(pattern)) throw new Error("chatted: a typed line is one line.");
  const segments: (string | number)[] = [];
  const captures: ChatCapture[] = [];
  let text = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "}") throw new Error("chatted: a } without its {. A capture is {name}, {name:unit} or {name:word|word}.");
    if (ch !== "{") { text += ch; continue; }
    const end = pattern.indexOf("}", i);
    if (end < 0) throw new Error("chatted: a { without its }. A capture is {name}, {name:unit} or {name:word|word}.");
    const inside = pattern.slice(i + 1, end);
    i = end;
    const colon = inside.indexOf(":");
    // Exactly as written, no spaces: the declarations read the names out of the pattern's type the same way.
    const name = colon < 0 ? inside : inside.slice(0, colon);
    const kind = colon < 0 ? "" : inside.slice(colon + 1);
    if (!IDENT.test(name) || name.startsWith("__")) throw new Error(`chatted: {${inside}} needs a name to be read by: {n}, {unit:unit}, {kind:ore|gas}.`);
    if (captures.some((c) => c.name === name)) throw new Error(`chatted: two captures are called ${name}.`);
    if (text === "") throw new Error(segments.length === 0
      ? "chatted: a pattern starts with its own word, so that ordinary talk is not taken for it: \"-give {n}\"."
      : `chatted: {${name}} follows another capture with nothing between them; put a space or a word there.`);
    segments.push(text);
    text = "";
    if (kind === "") captures.push({ name, kind: "number" });
    else if (kind === "unit") captures.push({ name, kind: "unit" });
    else {
      const words = kind.split("|");
      if (kind === "number" || kind === "word") throw new Error(`chatted: {${name}} alone is a number; {${name}:unit} a unit type; {${name}:ore|gas} one of the words listed.`);
      if (words.some((w) => w === "" || /\s/.test(w))) throw new Error(`chatted: {${inside}}: each word of the list is one word, without spaces.`);
      if (new Set(words.map((w) => w.toLowerCase())).size !== words.length) throw new Error(`chatted: {${inside}} lists a word twice.`);
      captures.push({ name, kind: "word", words });
    }
    segments.push(captures.length - 1);
  }
  if (text !== "") segments.push(text);
  if (captures.length > MAX_CHAT_CAPTURES) throw new Error(`chatted: a pattern reads at most ${MAX_CHAT_CAPTURES} values.`);
  const unit = captures.findIndex((c) => c.kind === "unit");
  if (unit >= 0 && (unit !== captures.length - 1 || typeof segments[segments.length - 1] === "string")) throw new Error("chatted: a unit's name has spaces in it, so {…:unit} reads the rest of the line and comes last.");
  const written = segments.filter((s): s is string => typeof s === "string").join("");
  if (bytes(written) > MAX_CHAT_BYTES) throw new Error(`chatted: the game lets a player type ${MAX_CHAT_BYTES} bytes; the pattern's own text is longer.`);
  return { pattern, segments, captures };
}

/**
 * A typed line against a pattern, as the lowering matches it: written text exactly, a number its
 * digits (stopping at `MAX_CHAT_NUMBER`), a word or a unit's name whatever the capitals. The
 * captures' values, or null. `unitByName` takes a name in lower case.
 */
export function matchChat(p: ChatPattern, line: string, unitByName: (lower: string) => number | undefined): number[] | null {
  let pos = 0;
  const out: number[] = [];
  for (let s = 0; s < p.segments.length; s++) {
    const seg = p.segments[s];
    if (typeof seg === "string") {
      if (!line.startsWith(seg, pos)) return null;
      pos += seg.length;
      continue;
    }
    const c = p.captures[seg];
    if (c.kind === "number") {
      const m = /^\d+/.exec(line.slice(pos));
      if (!m) return null;
      pos += m[0].length;
      out.push(Math.min(Number(m[0]), MAX_CHAT_NUMBER));
    } else if (c.kind === "unit") {
      const id = unitByName(line.slice(pos).toLowerCase());
      if (id === undefined) return null;
      pos = line.length;
      out.push(id);
    } else {
      const m = /^\S+/.exec(line.slice(pos));
      const at = m ? c.words.findIndex((w) => w.toLowerCase() === m[0].toLowerCase()) : -1;
      if (!m || at < 0) return null;
      pos += m[0].length;
      out.push(at);
    }
  }
  return pos === line.length ? out : null;
}

/* ── What the programs ask for ── */

/** One thing a program reads from the players; `player` is a slot, or 13 for the current player. */
export type InputSource =
  /** 1 on the frame the key's press arrives; `held`, on every frame it is down. */
  | { source: "key"; key: string; player: number; held?: boolean }
  /** 1 on the frame the button's press arrives. */
  | { source: "click"; button: MouseButton; player: number }
  /** Where the player's mouse is on the map, in pixels. */
  | { source: "mouse"; axis: "x" | "y"; player: number }
  /** A typed line: with `capture` null, 1 on the frame a line matching the pattern arrives; else that capture's value on that frame, 0 otherwise. */
  | { source: "chat"; pattern: string; capture: number | null; player: number }
  /** What `syncSend` of the slot sent from `player`'s computer, plus 1, once it has arrived; 0 until then (B5). */
  | { source: "sync"; slot: number; player: number };

/** Everything the programs read of the players, for the build (`backend/input.ts`) and the simulator. */
export interface InputPlan {
  keys: string[];
  /** The keys a program asks are held, each read on every frame it is down. */
  held?: string[];
  buttons: MouseButton[];
  chats: ChatPattern[];
  /** Unit names a `{…:unit}` capture knows, lower case, with the type each means; only when one is used. */
  unitNames?: [name: string, id: number][];
  /** Whether a program reads the players' mice. */
  mouse: boolean;
  /** How many `sync()` slots the programs use (B5): each a value sent from one computer to all; absent when none. */
  syncs?: number;
}

/** A library's reserved location comes from the first 63 (`reserveLocation`): every map's location table has those. */
export const LAST_SLOT = 62;

/** Every input a program reads, in the order met, and where the first is. */
export function inputsOf(programs: Program[]): { sources: InputSource[]; mouse: boolean; at: At | null } {
  const sources: InputSource[] = [];
  let mouse = false;
  let at: At | null = null;
  const unit = (u: UnitExpr) => {
    if (u.kind === "call") call(u.call);
    else if (u.kind === "pick" && u.mouse !== undefined) { mouse = true; at ??= u.at; }
    else if (u.kind === "unitAt") { expr(u.ptr); expr(u.epd); expr(u.uid); }
  };
  const any = (e: NumExpr | BoolExpr | UnitExpr | TextExpr) => (isTextExpr(e) ? text(e) : isUnitExpr(e) ? unit(e) : expr(e));
  const looks: TextMap = { num: (e) => { expr(e); return e; }, bool: (e) => { expr(e); return e; }, call: (c) => { call(c); return c; } };
  const text = (t: TextExpr) => { mapText(t, looks); };
  const expr = (e: NumExpr | BoolExpr): void => {
    if (mapTextOperands(e, looks)) return;
    switch (e.kind) {
      case "input": sources.push(e.input); at ??= e.at; if (e.input.source === "mouse") mouse = true; break;
      case "unitField": case "unitPart": case "unitAlive": case "unitFlag": unit(e.unit); break;
      case "unitSame": unit(e.left); unit(e.right); break;
      case "unary": case "cast": expr(e.expr); break;
      case "element": expr(e.index); break;
      case "binary": case "compare": expr(e.left); expr(e.right); break;
      case "ternary": expr(e.cond); expr(e.whenTrue); expr(e.whenFalse); break;
      case "intrinsic": e.args.forEach(expr); break;
      case "randomInt": expr(e.bound); break;
      case "and": case "or": e.items.forEach(expr); break;
      case "not": case "test": expr(e.expr); break;
      case "edge": expr(e.cond); break;
      case "running": expr(e.task); break;
      case "call": call(e.call); break;
      default: break;
    }
  };
  const call = (c: Call) => { for (const p of c.params) any(p.init); c.body.forEach(stmt); };
  const stmt = (s: Stmt): void => {
    switch (s.kind) {
      case "declare": if (!s.failed) any(s.init); break;
      case "assign": case "assignBool": expr(s.value); break;
      case "declareArray": s.init?.forEach(expr); if (s.fill) expr(s.fill); break;
      case "store": expr(s.index); expr(s.value); break;
      case "push": case "setLength": expr(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "assignText": text(s.value); break;
      case "storeText": expr(s.index); text(s.value); break;
      case "releaseText": expr(s.index); break;
      case "textLoop": text(s.of); s.body.forEach(stmt); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); expr(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "select": s.units.forEach(unit); break;
      case "tableWrite": any(s.value); break;
      case "centerLocation": expr(s.x); expr(s.y); if (s.size) { expr(s.size.width); expr(s.size.height); } break;
      case "syncSend": sources.push({ source: "sync", slot: s.slot, player: s.player }); at ??= s.at; expr(s.value); break;
      case "if": expr(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) expr(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); expr(s.cond); break;
      case "for": if (s.cond) expr(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": call(s.call); break;
      case "cancel": expr(s.task); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) any(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); if (s.text) text(s.text); break;
      case "print": case "buildText": mapTextParts(s.parts, looks); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
      default: break;
    }
  };
  for (const p of programs) for (const body of bodiesOf(p)) body.forEach(stmt);
  return { sources, mouse, at };
}

/**
 * The plan for a compile's programs: null when none reads the players. `units` is the map's
 * table of unit names, for a `{…:unit}` capture of a typed line.
 */
export function inputPlan(programs: Program[], units: NameTable): InputPlan | null {
  const { sources, mouse } = inputsOf(programs);
  if (sources.length === 0 && !mouse) return null;
  const keys: string[] = [];
  const held: string[] = [];
  const buttons: MouseButton[] = [];
  const chats: ChatPattern[] = [];
  for (const s of sources) {
    if (s.source === "key" && s.held) { if (!held.includes(s.key)) held.push(s.key); }
    else if (s.source === "key" && !keys.includes(s.key)) keys.push(s.key);
    else if (s.source === "click" && !buttons.includes(s.button)) buttons.push(s.button);
    else if (s.source === "chat" && !chats.some((c) => c.pattern === s.pattern)) chats.push(parseChatPattern(s.pattern));
  }
  const syncs = Math.max(0, ...sources.map((s) => (s.source === "sync" ? s.slot + 1 : 0)));
  // With a held key in the game, keys go every frame they are down, and a multiplayer game may bring two frames' commands
  // at once — the later replaces the earlier, since a carrier has one order. A press of its own ("went down") would be
  // lost that way, so every key is sent as held and a press is worked out where it arrives: held now, not before.
  if (held.length) for (const k of keys) if (!held.includes(k)) held.push(k);
  const plan: InputPlan = { keys, ...(held.length ? { held } : {}), buttons, chats, mouse, ...(syncs ? { syncs } : {}) };
  if (chats.some((c) => c.captures.some((x) => x.kind === "unit"))) {
    const seen = new Set<string>();
    plan.unitNames = [];
    for (const e of units.entries) {
      if (e.value >= 228) continue;
      for (const k of e.keys) { const lower = k.toLowerCase(); if (!seen.has(lower)) { seen.add(lower); plan.unitNames.push([lower, e.value]); } }
    }
  }
  return plan;
}

/**
 * Each program numbers its `sync()` slots from 0; the slots of a build are one list, so a program's are moved past those of
 * the programs before it. Gives how many the program has.
 */
export function numberSyncSlots(program: Program, base: number): number {
  let count = 0;
  // An expression may be one object in several places: each is moved once.
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if ((o.kind === "syncSend" || o.source === "sync") && typeof o.slot === "number") { count = Math.max(count, o.slot + 1); o.slot += base; }
    for (const k in o) if (k !== "at") walk(o[k]);
  };
  walk(program.body);
  walk(program.functions ?? []);
  return count;
}
