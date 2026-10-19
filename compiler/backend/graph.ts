/**
 * The emitter's triggers (TrigScript 4, the backend: the emitter, E1). A statement the emitter takes is lowered to a
 * graph of these, which `python/trigscript.py` makes into the map's triggers where the statement was (`Lowering.graph`)
 * while the rest of the lowering stays its own; the simulator runs the statements the graph replaced.
 *
 * A trigger compares dwords with numbers and writes numbers into dwords — the game's Deaths condition and Set Deaths
 * action reaching any address, as an EUD map has them — and says where the walk goes after it. A dword is one of the
 * game's, a variable's cell on the Python side, a dword of data the graph keeps, or a field of one of its own triggers:
 * a condition's number, an action's number, destination or modifier, the trigger's next pointer. The emitter decides
 * where every value lives by writing such fields, which is the point of having one.
 */
import type { At } from "../ir";

/** A dword the graph reads or writes. */
export type Dword =
  /** An address in the game's memory. */
  | { game: number }
  /** The cell of a variable of the program (the Python side's, by the variable's id): its value. */
  | { var: string }
  /** A dword of the graph's own data, by name: made once in the map, 0 when the map starts. */
  | { data: string }
  /** A field of one of the graph's triggers, by its label. */
  | { at: string; field: Field };

/** A field of a trigger: a condition's number, an action's number, destination or modifier, the next pointer. */
export type Field = { cond: number } | { act: number; part: "value" | "dest" | "modifier" } | "next";

export type Compare = "atLeast" | "atMost" | "exactly";
export type Modifier = "set" | "add" | "subtract";

/** A number an action writes or a condition compares with: a constant, or where a label is (a trigger's address). */
export type Value = number | { label: string };

/** The dword compared with `value` (read from 0 up); with `mask`, only the bits of the mask, on both sides. */
export interface Cond { dword: Dword; compare: Compare; value: number; mask?: number }

/**
 * `value` written into the dword, added to it or taken from it; with `mask`, only the mask's bits change. An add wraps;
 * the game's subtract stops at 0, so it is no way to take a variable away (add its negation).
 */
export interface Act { dword: Dword; modifier: Modifier; value: Value; mask?: number }

/**
 * A trigger: its conditions all hold, its actions run, in order. Then the walk goes to `next` — a label of the graph's,
 * or `END` for what follows the graph — or, unset, to the trigger after it in the list.
 */
export interface Trigger { label: string; conds: Cond[]; acts: Act[]; next?: string; at?: At; copy?: Copy }

/**
 * A copy in the middle of the graph, in place of a trigger (`conds` and `acts` empty, no `next`: the walk goes on to the
 * trigger after it): the variable's cell, as it is now, written into each dword — times its `scale`, plus `add` —
 * the way the Python side routes a read. What a variable whose writes cannot be laid out into all its places (one set
 * from itself, two that read each other) does after each write.
 */
export interface Copy { from: string; into: { dword: Dword; add: number; scale?: number }[] }

/** Where the walk goes when it leaves the graph: the statement after it. */
export const END = "@end";

/**
 * A copy into the graph on the way in: the variable's value times `scale` (1 when unset; wrapping) plus `add`, written
 * into the dword. The variables a graph reads that something else writes come in this way, once each time the walk
 * enters it (the Python side routes the variable's cell, as it does any read).
 */
export interface Entry { from: string; into: Dword; add: number; scale?: number }

export interface Graph { entries: Entry[]; triggers: Trigger[] }

/** The most conditions and actions a trigger of the game holds. */
export const MOST_CONDS = 16;
export const MOST_ACTS = 64;

/** The trigger's own next pointer, as a dword. */
export const nextOf = (label: string): Dword => ({ at: label, field: "next" });
/** The dword holding a trigger's k-th condition's number. */
export const condValue = (label: string, k: number): Dword => ({ at: label, field: { cond: k } });
/** The dword holding a trigger's k-th action's number. */
export const actValue = (label: string, k: number): Dword => ({ at: label, field: { act: k, part: "value" } });

/** The checks a graph must pass before the Python side makes it: labels known, sizes within the game's. */
export function checkGraph(g: Graph): string[] {
  const labels = new Set(g.triggers.map((t) => t.label));
  const out: string[] = [];
  const known = (l: string) => l === END || labels.has(l);
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
      if (typeof a.value === "object" && !known(a.value.label)) out.push(`${t.label} action ${k}: no label ${a.value.label}`);
    });
  }
  for (const e of g.entries) dword(e.into, `entry of ${e.from}`);
  return out;
}
