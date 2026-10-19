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
import type { At, Stmt } from "../ir";

/** A dword the graph reads or writes. */
export type Dword =
  /** An address in the game's memory. */
  | { game: number }
  /** The cell of a variable of the program (the Python side's, by the variable's id): its value. */
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
  /** A parameter of one of the Python side's fixed-point functions (`FixedFn`): its cell. */
  | { param: FixedFn; index: number }
  /**
   * The offset the Python side may keep beside a counter some array is indexed by (`Place`): 72 times it in bytes,
   * 18 times it in EPD — stepped by the Python side's own stores of the counter, by the graph's writes when the graph
   * writes it. A dword that is never read when the Python side keeps no such offset.
   */
  | { counter: string; part: "bytes" | "dwords" }
  /**
   * eudplib's getter, which an EUDVArray's cell goes to after writing its value into it: the dword its action writes
   * (`dest`, an EPD) and where it goes after (`next`) — set before the walk is sent into a cell.
   */
  | { getter: "dest" | "next" }
  /** A scratch cell of the graph's (a variable of the Python side's it makes): where a cell's value comes out. */
  | { temp: string };

/**
 * One of the Python side's fixed-point functions (part 3): a product or a quotient of two variables, or of one and a
 * constant above zero (`c`) — `fdiv_by` is c / x, `fdiv_by_const` x / c.
 */
export interface FixedFn { fn: "fmul_vars" | "fdiv_vars" | "fmul_by" | "fdiv_by" | "fdiv_by_const"; c?: number }

/**
 * A field of a trigger: a condition's number (or its player, the EPD of the dword it reads), an action's number,
 * destination or modifier, the next pointer.
 */
export type Field = { cond: number; part?: "value" | "player" } | { act: number; part: "value" | "dest" | "modifier" } | "next";

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

/** The dword compared with `value` (read from 0 up); with `mask`, the dword's bits of the mask (`value` as it is). */
export interface Cond { dword: Dword; compare: Compare; value: number; mask?: number }

/**
 * `value` written into the dword, added to it or taken from it; with `mask`, only the mask's bits change. An add wraps;
 * the game's subtract stops at 0, so it is no way to take a variable away (add its negation).
 */
/** `at`: the statement the action is for, when a trigger holds the work of several (the cost of a line, action by action). */
export interface Act { dword: Dword; modifier: Modifier; value: Value; mask?: number; at?: At }

/**
 * A trigger: its conditions all hold, its actions run, in order. Then the walk goes to `next` — a label of the graph's,
 * or `END` for what follows the graph — or, unset, to the trigger after it in the list.
 */
export interface Trigger { label: string; conds: Cond[]; acts: Act[]; next?: string; at?: At; copy?: Copy; island?: Stmt; call?: Call }

/**
 * A call of a fixed-point function, in place of a trigger as a copy is: its parameters' cells were written by the
 * triggers before it; the function goes back to the trigger after it, its result written into `into`.
 */
export interface Call extends FixedFn { into: Dword }

/**
 * A copy in the middle of the graph, in place of a trigger (`conds` and `acts` empty, no `next`: the walk goes on to the
 * trigger after it): the variable's cell, as it is now, written into each dword — times its `scale`, plus `add` —
 * the way the Python side routes a read. What a variable whose writes cannot be laid out into all its places (one set
 * from itself, two that read each other) does after each write.
 */
/**
 * `from`: a variable's id, or (`@…`) a scratch cell of the graph's (`{ temp }`). `top`: the most the copied value can
 * be, when value ranges know it never below zero (a multiple of it is then worked out over only the bits it can have).
 */
export interface Copy { from: string; into: { dword: Dword; add: Num; scale?: number }[]; top?: number }

/*
 * An island, in place of a trigger as a copy is: a statement the emitter does not lower, which the Python side lowers
 * where it is, as it would anywhere — every variable it reads is in its cell, and the graph copies what it may write
 * back into the variable's other places after it. Nothing in it leaves it (no break of a loop outside it, no return,
 * no wait).
 */

/** Where the walk goes when it leaves the graph: the statement after it. */
export const END = "@end";

/**
 * A copy into the graph on the way in: the variable's value times `scale` (1 when unset; wrapping) plus `add`, written
 * into the dword. The variables a graph reads that something else writes come in this way, once each time the walk
 * enters it (the Python side routes the variable's cell, as it does any read).
 */
export interface Entry { from: string; into: Dword; add: Num; scale?: number }

/**
 * `arrays`: the arrays whose cells the graph reads where they are, each with the EPD between one cell's value and the
 * next's as the emitter laid the reads out (the Python side's EUDVArray's 18, an EUDArray's 1): the Python side checks
 * it is so.
 */
export interface Graph { entries: Entry[]; triggers: Trigger[]; arrays?: { id: string; stride: number }[] }

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
    if ((t.copy || t.island || t.call) && (t.conds.length || t.acts.length || t.next !== undefined)) out.push(`${t.label}: a copy, an island or a call with conditions, actions or a next of its own`);
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
  return out;
}
