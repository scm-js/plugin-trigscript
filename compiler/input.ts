/**
 * What the players do — keys, clicks, the mouse, what they type — as a program reads it.
 *
 * None of it is in the game's own tables where every computer sees the same: a key is pressed on
 * one computer. Two euddraft plugins the eudplib library carries bring it to everyone in step:
 * **chatEvent** finds the line the local player typed, and **MSQC** sends what happened on one
 * computer to all of them, a frame or a few later, as the player it happened to. The compiler
 * composes both from what the programs ask for (`inputPlan`, `inputPlugins`); the script never
 * names them. What arrives lands in arrays of the lowering's own (`python/trigscript.py`), one
 * cell per player, which last one frame — so an input is true on the frame it arrives and a
 * program that wants it looks every frame.
 *
 * What it takes from the map: MSQC keeps one location for itself and, when the mouse is read, one
 * more per player slot (eight in a row); it uses one unit type for its command units (the
 * Valkyrie) which the map must not use, and Player 12 to hold them.
 */
import type { NameTable } from "./names";
import type { NumExpr, Program, Stmt, UnitExpr, BoolExpr, Call, At } from "./ir";
import { isUnitExpr } from "./ir";

export type MouseButton = "left" | "right" | "middle";
export const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];
const MSQC_BUTTON: Record<MouseButton, string> = { left: "L", right: "R", middle: "M" };

/** The keys `keyPressed()` takes, as a script writes them, and the name MSQC knows each by. */
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
 * the letters beside it did. Left out of the list, so writing one is an error and not a silent key.
 */
export const DEAF_KEYS: Readonly<Record<string, string>> = { F6: "StarCraft: Remastered keeps F6 to itself and reports no press of it (played and seen); F7 and F8 work" };
/** Every key name, as the declarations list them. */
export const KEY_NAMES: readonly string[] = [
  ...LETTERS, ...DIGITS, ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`).filter((k) => !(k in DEAF_KEYS)), ...Object.keys(NAMED_KEYS), ...DIGITS.map((d) => `Numpad${d}`),
];
const KEY_BY_LOWER = new Map(KEY_NAMES.map((k) => [k.toLowerCase(), k]));

/** The key as the declarations spell it ("f2" → "F2", "space" → "Space"), or null when it is not one. */
export function keyName(v: string): string | null {
  return KEY_BY_LOWER.get(v.trim().toLowerCase()) ?? null;
}

/** The name MSQC's settings take for a key of `KEY_NAMES`. */
export function msqcKey(key: string): string {
  return NAMED_KEYS[key] ?? key.toUpperCase();
}

/* ── Chat patterns ── */

/** The most values a typed line can carry: each is one of MSQC's command units per player. */
export const MAX_CHAT_CAPTURES = 3;
/** What the game lets a player type. */
export const MAX_CHAT_BYTES = 78;
/** The most a number in a typed line comes through as: what MSQC can send on the smallest map. */
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
  /** 1 on the frame the key's press arrives. */
  | { source: "key"; key: string; player: number }
  /** 1 on the frame the button's press arrives. */
  | { source: "click"; button: MouseButton; player: number }
  /** Where the player's mouse is on the map, in pixels. */
  | { source: "mouse"; axis: "x" | "y"; player: number }
  /** A typed line: with `capture` null, 1 on the frame a line matching the pattern arrives; else that capture's value on that frame, 0 otherwise. */
  | { source: "chat"; pattern: string; capture: number | null; player: number };

/** Everything the input plugins are set up from, written into the IR file beside the programs. */
export interface InputPlan {
  keys: string[];
  buttons: MouseButton[];
  chats: ChatPattern[];
  /** Unit names a `{…:unit}` capture knows, lower case, with the type each means; only when one is used. */
  unitNames?: [name: string, id: number][];
  /** The location MSQC keeps for itself, as its 0-based slot. */
  qcLocation: number;
  /** The 1-based number of the first of eight locations in a row MSQC keeps the players' mice in; null when no program reads the mouse. */
  mouseBase: number | null;
}

/** The unit type MSQC makes its command units of (the Valkyrie), and the player that holds them, as MSQC's setting takes it: what Magenta's probe maps were played with. */
export const QC_UNIT = 58;
export const QC_PLAYER = 11;
const MOUSE_SLOTS = 8;
/** Input's locations come from the first 63: every map's location table has those. */
const LAST_SLOT = 62;

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
  const any = (e: NumExpr | BoolExpr | UnitExpr) => (isUnitExpr(e) ? unit(e) : expr(e));
  const expr = (e: NumExpr | BoolExpr): void => {
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
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); expr(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "tableWrite": if (s.value.kind !== "text") expr(s.value); break;
      case "centerLocation": expr(s.x); expr(s.y); break;
      case "if": expr(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) expr(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); expr(s.cond); break;
      case "for": if (s.cond) expr(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) any(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); break;
      case "print": for (const p of s.parts) if (p.kind === "number") expr(p.expr); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  for (const p of programs) p.body.forEach(stmt);
  return { sources, mouse, at };
}

/**
 * The plan for a compile's programs: null when none reads the players. `locations` is the map's
 * table, to keep clear of the slots it uses. Throws an Error worded for the author when the map
 * has no room.
 */
export function inputPlan(programs: Program[], locations: NameTable, units: NameTable): InputPlan | null {
  const { sources, mouse } = inputsOf(programs);
  if (sources.length === 0 && !mouse) return null;
  const keys: string[] = [];
  const buttons: MouseButton[] = [];
  const chats: ChatPattern[] = [];
  for (const s of sources) {
    if (s.source === "key" && !keys.includes(s.key)) keys.push(s.key);
    else if (s.source === "click" && !buttons.includes(s.button)) buttons.push(s.button);
    else if (s.source === "chat" && !chats.some((c) => c.pattern === s.pattern)) chats.push(parseChatPattern(s.pattern));
  }
  // The highest free slots among the first 63, so the low numbers a map maker reaches for first stay free.
  const used = new Set(locations.entries.map((e) => e.value - 1));
  const free = (slot: number) => slot >= 0 && slot <= LAST_SLOT && !used.has(slot);
  let qcLocation = -1;
  for (let slot = LAST_SLOT; slot >= 0; slot--) if (free(slot)) { qcLocation = slot; break; }
  if (qcLocation < 0) throw new Error("Reading keys, clicks or chat needs one free location among the map's first 63 for the plugin that carries them between the players' computers; this map uses them all.");
  let mouseBase: number | null = null;
  if (mouse) {
    for (let slot = LAST_SLOT - MOUSE_SLOTS + 1; slot >= 0 && mouseBase === null; slot--) {
      let ok = true;
      for (let i = 0; i < MOUSE_SLOTS; i++) if (!free(slot + i) || slot + i === qcLocation) ok = false;
      if (ok) mouseBase = slot + 1;
    }
    if (mouseBase === null) throw new Error("Reading the mouse needs eight free locations in a row among the map's first 63, one per player, besides one more for the plugin that carries input; this map has no such run.");
  }
  const plan: InputPlan = { keys, buttons, chats, qcLocation, mouseBase };
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

/** The names the lowering registers its cells under, which is how MSQC's and chatEvent's settings reach them. */
export const INPUT_NAMES = {
  key: (i: number) => `tsin_key${i}`,
  button: (i: number) => `tsin_button${i}`,
  chatLocal: "tsin_chat",
  chatIn: "tsin_chat_in",
  captureLocal: (i: number) => `tsin_capture${i}`,
  captureIn: (i: number) => `tsin_capture${i}_in`,
  heard: "tsin_heard", pointer: "tsin_pointer", length: "tsin_length", pattern: "tsin_pattern",
};

/**
 * The euddraft plugin sections for a plan, in the order they have to run around `trigscript`:
 * chatEvent before it (it finds the typed line the lowering then reads), MSQC after it (it sends
 * what the lowering made of the line). Every address is a name the lowering registers.
 */
export function inputPlugins(plan: InputPlan): { before: Record<string, Record<string, string | number>>; after: Record<string, Record<string, string | number>> } {
  const before: Record<string, Record<string, string | number>> = {};
  if (plan.chats.length) before.chatEvent = { __addr__: INPUT_NAMES.heard, __ptrAddr__: INPUT_NAMES.pointer, __lenAddr__: INPUT_NAMES.length, __patternAddr__: INPUT_NAMES.pattern };
  const msqc: Record<string, string | number> = { QCUnit: QC_UNIT, QCLoc: plan.qcLocation, QCPlayer: QC_PLAYER, QCDebug: "false" };
  plan.keys.forEach((key, i) => { msqc[`KeyPress(${msqcKey(key)}); NotTyping`] = `${INPUT_NAMES.key(i)}, 1`; });
  plan.buttons.forEach((b, i) => { msqc[`MouseDown(${MSQC_BUTTON[b]})`] = `${INPUT_NAMES.button(i)}, 1`; });
  if (plan.mouseBase !== null) msqc.Mouse = plan.mouseBase;
  if (plan.chats.length) {
    const sent = `${INPUT_NAMES.chatLocal}.AtLeast(1)`;
    msqc[`${sent}; val, ${INPUT_NAMES.chatLocal}`] = INPUT_NAMES.chatIn;
    const captures = Math.max(0, ...plan.chats.map((c) => c.captures.length));
    for (let i = 0; i < captures; i++) msqc[`${sent}; val, ${INPUT_NAMES.captureLocal(i)}`] = INPUT_NAMES.captureIn(i);
  }
  return { before, after: { MSQC: msqc } };
}

/** The whole `plugins` of a build, in order: what the service contributes and the tests build with. */
export function buildPlugins(plan: InputPlan | null, irPath: string): Record<string, Record<string, string | number>> {
  const input = plan ? inputPlugins(plan) : { before: {}, after: {} };
  return { ...input.before, trigscript: { ir: irPath }, ...input.after, eudTurbo: {} };
}
