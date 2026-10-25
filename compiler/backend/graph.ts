/**
 * The emitter's triggers (TrigScript 4, the backend: the emitter, E1). A statement the emitter takes is lowered to a
 * graph of these, which `python/trigscript.py` makes into the map's triggers where the statement was (`Lowering.graph`)
 * while the rest of the lowering stays its own; the simulator runs the statements the graph replaced.
 *
 * A trigger compares dwords with numbers and writes numbers into dwords — the game's Deaths condition and Set Deaths
 * action reaching any address, as an EUD map has them — and says where the walk goes after it. A dword is one of the
 * game's, a variable's cell (the layout's), a dword of data the graph keeps, or a field of one of its own triggers:
 * a condition's number, an action's number, destination or modifier, the trigger's next pointer. The emitter decides
 * where every value lives by writing such fields, which is the point of having one.
 */
import type { At } from "../ir";
import type { ScriptString } from "../runtime";
import type { ActionRecord, ConditionRecord } from "../../vendor/triggers";

/** A dword the graph reads or writes. */
export type Dword =
  /** An address in the game's memory. */
  | { game: number }
  /** The cell of a variable of the program (the layout's, by the variable's id): its value. */
  | { var: string }
  /** A dword of the graph's own data, by name: made once in the map, 0 when the map starts. */
  | { data: string }
  /** A field of one of the graph's triggers, by its label. */
  | { at: string; field: Field }
  /**
   * The value of the first cell of one of the program's arrays (a list known when the map is built, which nothing
   * writes). A condition on it whose player field is a place reads the cell that field says: its EPD.
   */
  | { element: string }
  /** A scratch cell of the graph's: where a cell's value comes out. */
  | { temp: string }
  /** The `word`-th dword of a printed text's template (`Graph.templates`), which the layout puts on a dword's start. */
  | { template: string; word: number }
  /** A cell of one of a map of our own's regions of cell triggers (`Graph.cells`), by its index: its number. */
  | { cell: string; index: number };

/**
 * A field of a trigger: a condition's number (or its player, the EPD of the dword it reads), an action's number,
 * destination or modifier, the mask of a masked one (a condition's or an action's, which it reads as it runs: what the
 * mask is can be written like any number), the next pointer.
 */
/**
 * (An action of the game's, `Act.record`, names its other fields by these too: its location is where the mask is, its
 * first player the destination, its second player or amount the number, its unit type, kind and count the modifier's
 * dword; `text`, `wav` and `time` are its own.)
 */
/**
 * `current`: the dword whose top byte is the trigger's current action (where a trigger held by a Wait or a
 * Transmission goes on from); an action's `flags` dword has its flags in the low byte (bit 0: a Wait or a Transmission
 * started, which the game steps over the next time it is reached). `flags`: the trigger's own (4, preserved; 8 more,
 * done: the walk passes it by before its conditions, at about 40% of what an empty trigger costs it).
 */
export type Field = { cond: number; part?: "value" | "player" | "mask" } | { act: number; part: ActPart } | "next" | "current" | "flags";
/** A trigger's flags: preserved, and preserved and done (passed by: `Trigger.off`). */
export const TRIGGER_ON = 4, TRIGGER_OFF = 12;
export type ActPart = "value" | "dest" | "modifier" | "mask" | "text" | "wav" | "time" | "flags";

export type Compare = "atLeast" | "atMost" | "exactly";
export type Modifier = "set" | "add" | "subtract";

/**
 * A number known when the map is made: a constant, or the EPD of an array's first cell's value plus a constant, or the
 * address of an EUDVArray's first cell (a trigger: what a jump into a cell goes to) plus a constant.
 */
export type Num = number | { epdOf: string; plus: number } | { addrOf: string; plus: number };

/**
 * A number an action writes: one known when the map is made, where a label is (a trigger's address), or the EPD of a
 * dword (what an action's destination holds: a cell of the graph's own routed to write somewhere else).
 */
export type Value = Num | { label: string } | { epd: Dword };

/**
 * The dword compared with `value` (read from 0 up); with `mask`, the dword's bits of the mask (`value` as it is).
 * `game`: instead, a condition of the game's as the script wrote it (a map of our own: TrigScript 4, step 5 of the way
 * off eudplib) — its record laid out as it is, the dword not read.
 */
export interface Cond { dword: Dword; compare: Compare; value: number; mask?: number; game?: ConditionRecord }

/**
 * `value` written into the dword, added to it or taken from it; with `mask`, only the mask's bits change. An add wraps;
 * the game's subtract stops at 0, so it is no way to take a variable away (add its negation).
 */
/**
 * `at`: the statement the action is for, when a trigger holds the work of several (the cost of a line, action by
 * action). `display`: instead of a write, the game's own Display Text of that text (to the current player, as a
 * trigger of theirs shows it); only a graph made for a map of our own has one (`emitBody`): its text is put in the
 * map's strings when the map is made.
 */
/** `show`: instead of a write, Display Text of a printed text's template (`Graph.templates`), as it is when shown. */
/**
 * `randomize`: instead of a write, the game's Set Switch of that switch (0-based) to a random state — one bit of the
 * game's own random numbers, the same on every player's machine. A map of our own reads the switch where the game keeps
 * it (`SWITCHES`).
 */
/**
 * `record`: instead of a write, an action of the game's as the script wrote it (a map of our own), laid out as it is but
 * for its text and its sound file, which are the script's strings (`strings`: a record's `text` / `wav` of `k > 0` is the
 * script's `k`-th) and are put in the map's strings when the map is made.
 */
/**
 * `textOf`: an action of the game's whose text is a printed text's template (`Graph.templates`), filled before it.
 * `amountText`: a Set Deaths whose amount is a text's number among the map's strings, times 2^`shift` (a unit type's
 * name written).
 */
export interface Act { dword: Dword; modifier: Modifier; value: Value; mask?: number; at?: At; display?: string; show?: string; randomize?: number; record?: ActionRecord; strings?: { text?: ScriptString; wav?: ScriptString }; textOf?: string; amountText?: { text: string; shift: number } }

/** Where the game keeps its 256 switches: a bit each, 32 to a dword. */
export const SWITCHES = 0x58dc40;

/**
 * A trigger: its conditions all hold, its actions run, in order. Then the walk goes to `next` — a label of the graph's,
 * or `END` for what follows the graph — or, unset, to the trigger after it in the list.
 */
/** `off`: laid out done (`TRIGGER_OFF`), passed by until an action of the graph's switches it on: a task's slot with nothing in it. */
export interface Trigger { label: string; conds: Cond[]; acts: Act[]; next?: string; at?: At; copy?: Copy; off?: boolean }

/**
 * A copy in the middle of the graph, in place of a trigger (`conds` and `acts` empty, no `next`: the walk goes on to the
 * trigger after it): the variable's cell, as it is now, written into each dword — times its `scale`, plus `add`.
 * What a variable whose writes cannot be laid out into all its places (one set
 * from itself, two that read each other) does after each write.
 */
/**
 * `from`: a variable's id, or (`@…`) a scratch cell of the graph's (`{ temp }`). `top`: the most the copied value can
 * be, when value ranges know it never below zero (a multiple of it is then worked out over only the bits it can have).
 */
export interface Copy { from: string; into: { dword: Dword; add: Num; scale?: number }[]; top?: number }

/** Where the walk goes when it leaves the graph: the statement after it. */
export const END = "@end";

/**
 * A map of our own's count of frames (TrigScript 4, step 11): a variable of the map's, one more each pass before the
 * runs (`layout.ts`). A coroutine's wake — the program's, a task's, a branch of a `Promise.all`'s — asks whether it has
 * reached the frame its sleep wrote: one copy of it plus the frames, where the game's own tick was read a bit at a time.
 */
export const NOW = "@now";

/**
 * A copy into the graph on the way in: the variable's value times `scale` (1 when unset; wrapping) plus `add`, written
 * into the dword. A whole program's graph has none: it reads nothing it did not write first (`emitBody`), and one
 * that would is a refusal that names the variable.
 */
export interface Entry { from: string; into: Dword; add: Num; scale?: number }

/**
 * `arrays`: the arrays whose cells the graph reads where they are, each with the EPD between one cell's value and the
 * next's as the emitter laid the reads out (1: a dword each): the layout puts the list so.
 *
 * `cells`: a map of our own keeps its arrays — and the frames of each function that calls itself, a stack each (an id
 * starting `STACK`) — in regions of cell triggers as a routed variable's (`layout.ts`), this many cells each: a cell
 * holds its value in the number of its one action, which adds it where its destination says and goes where its next
 * pointer says. `values`: what the cells hold when the map starts (a list the script made when it was built).
 *
 * `templates`: the texts a map of our own prints with values in them, each its bytes as built — the text, and a field
 * of 12 bytes on a dword's start for each number, which the program fills before it shows the text (0x0D, which draws
 * nothing, wherever nothing goes) — ending in a 0.
 *
 * `rows`: the runs of triggers a doubling trigger walks (`TRIGGER_BYTES`), each laid out one after another in its
 * order, `TRIGGER_BYTES` apart. Every other trigger the layout puts where it fits (`layout.ts`).
 */
/** (A template with `at` is the game's own memory there — the line a print at the centre of the screen is written into — and its bytes are written by the program, not laid out.) */
/**
 * `tasks`: where a run's tasks have their turn (a map of our own): the walk goes there after the program's turn, and when
 * the program's wake does not hold; it ends at `END`.
 */
/**
 * `pass`: where the map's events pass starts (a map of our own), which the walk goes through before the run's `@wake`;
 * it ends at `PASS_END`. `after`: where the map's send pass starts (the input's, step 12), which the walk goes through
 * after the last run's end; it ends at `AFTER_END`.
 */
export interface Graph { entries: Entry[]; triggers: Trigger[]; arrays?: { id: string; stride: number }[]; cells?: Region[]; templates?: { id: string; bytes: number[]; at?: number; data?: boolean }[]; rows?: string[][]; tasks?: string; pass?: string; after?: string }
/** Where the events pass goes when it is done: its run's `@wake`. */
export const PASS_END = "@passed";
/** Where the send pass goes when it is done: the walk's end. */
export const AFTER_END = "@aftered";
export interface Region { id: string; cells: number; values?: number[] }

/**
 * A region of cell triggers, as an array's id: `{ element }` is its first cell's number, `{ epdOf }` that number's EPD
 * (a cell's destination one less, its next pointer 86 less: +344 and +4 of the trigger where the number is +348),
 * `{ addrOf }` where the first cell's trigger is; a cell every 72 bytes. A stack's id starts with this.
 */
export const STACK = "@stack";

/**
 * A trigger's bytes in memory: in a row of the graph's (`Graph.rows`, laid out one after another), a next pointer
 * moved on by this much goes to the trigger after the one it named — how a trigger walks a run of triggers it is run
 * between (`Emitter.product`, `Emitter.divide`).
 */
export const TRIGGER_BYTES = 2408;

/** The most conditions and actions a trigger of the game holds. */
export const MOST_CONDS = 16;
export const MOST_ACTS = 64;

/** The trigger's own next pointer, as a dword. */
export const nextOf = (label: string): Dword => ({ at: label, field: "next" });
/** The dword holding a trigger's k-th condition's number. */
export const condValue = (label: string, k: number): Dword => ({ at: label, field: { cond: k } });
/** The dword holding a trigger's k-th action's number. */
export const actValue = (label: string, k: number): Dword => ({ at: label, field: { act: k, part: "value" } });

/** The checks a graph must pass before the layout makes it: labels known, sizes within the game's. */
export function checkGraph(g: Graph): string[] {
  const labels = new Set(g.triggers.map((t) => t.label));
  const out: string[] = [];
  const known = (l: string) => l === END || l === PASS_END || l === AFTER_END || labels.has(l);
  const dword = (d: Dword, where: string) => {
    if ("at" in d && !labels.has(d.at)) out.push(`${where}: no trigger ${d.at}`);
  };
  if (labels.size !== g.triggers.length) out.push("a label is used twice");
  for (const t of g.triggers) {
    if (t.copy && (t.conds.length || t.acts.length || t.next !== undefined)) out.push(`${t.label}: a copy with conditions, actions or a next of its own`);
    t.copy?.into.forEach((c, k) => dword(c.dword, `${t.label} copy ${k}`));
    if (t.conds.length > MOST_CONDS) out.push(`${t.label}: ${t.conds.length} conditions`);
    if (t.acts.length > MOST_ACTS) out.push(`${t.label}: ${t.acts.length} actions`);
    if (t.next !== undefined && !known(t.next)) out.push(`${t.label}: goes to ${t.next}, which is not there`);
    t.conds.forEach((c, k) => dword(c.dword, `${t.label} condition ${k}`));
    t.acts.forEach((a, k) => {
      dword(a.dword, `${t.label} action ${k}`);
      if (typeof a.value === "object" && "label" in a.value && !known(a.value.label)) out.push(`${t.label} action ${k}: no label ${a.value.label}`);
    });
  }
  for (const e of g.entries) dword(e.into, `entry of ${e.from}`);
  // (A trigger whose next pointer is moved on by a trigger's bytes walks a row: wherever it is pointed is in one —
  // but where the trigger pointing it also moves where it adds, to take its numbers out, and goes on from there.)
  const rowed = new Set((g.rows ?? []).flat());
  for (const l of rowed) if (!labels.has(l)) out.push(`a row holds ${l}, which is not there`);
  const walkers = new Set(g.triggers.flatMap((t) => t.acts.filter((a) => "at" in a.dword && a.dword.field === "next" && a.modifier === "add" && typeof a.value === "number" && a.value % TRIGGER_BYTES === 0).map((a) => (a.dword as { at: string }).at)));
  for (const t of g.triggers) {
    t.acts.forEach((a, k) => {
      if (!("at" in a.dword) || a.dword.field !== "next" || !walkers.has(a.dword.at) || a.modifier !== "set" || typeof a.value !== "object" || !("label" in a.value)) return;
      const W = a.dword.at;
      if (t.acts.some((b) => "at" in b.dword && b.dword.at === W && typeof b.dword.field === "object" && "act" in b.dword.field && b.dword.field.part === "dest")) return;
      if (!rowed.has(a.value.label)) out.push(`${t.label} action ${k}: points ${a.dword.at}, which walks a row, at ${a.value.label}, which is in none`);
    });
  }
  return out;
}
