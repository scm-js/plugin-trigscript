/**
 * A map of our own, as far as the emitter goes: each of a compiled script's programs lowered whole by `emitBody` —
 * once for each player it runs for — or why it is not. `scripts/build-own.mts` makes the map from what this gives; the
 * ledger (`tests/ledger.test.ts`) asks it of every feature, so that the two refuse the same.
 *
 * A run is a program as one player runs it (TrigScript 4, step 7): a program for one player has one run, as the first
 * of its owners; a per-player program one for each of its owners the map gives a human or a computer, each with
 * variables and arrays of its own but for the `shared` ones, which are the program's. The layout runs them one after
 * another every frame, in the order of the programs and then of the players, as the Python side's lowering does — and
 * a run whose player is not in the game is passed over.
 */
import type { CompileResult } from "../compiler";
import type { ArrayDecl, FuncDecl, Program, VarDecl } from "../ir";
import { ANY_PLAYERS, emitBody, groupSlots, type MapPlayers } from "./emit";
import type { Act, Cond, Dword, Graph, Num, Trigger, Value } from "./graph";
import { TextPool, knownTexts } from "./texts";
import { HEAP_GLOBALS, growingArrays, heldVariables, isHeapGlobal, loopScoped } from "./heap";
import { UNIT_GLOBALS, unitValues } from "./units";

export interface OwnRun {
  /** The program's index among the script's. */
  program: number;
  /** The player it runs as, 0-based: the current player while it runs. */
  player: number;
  graph: Graph;
}

export interface Own {
  programs: Program[];
  runs: OwnRun[];
  /** The lists the runs read where they are (an array the script made when it was built), by the id a graph names. */
  values: Map<string, number[]>;
  /**
   * The texts known when built that the programs choose between while the game runs (`texts.ts`), in the order of
   * their numbers: the map's strings from `textBase` on are to be these, one after another.
   */
  texts: string[];
}

/** The players a program runs for, as the Python side's `owner_slots`: each owner's slots, in the order given. */
function ownerSlots(program: Program, players: MapPlayers): number[] | string {
  const slots: number[] = [];
  for (const o of program.owners?.length ? program.owners : [program.owner]) {
    const of = groupSlots(o, players);
    // (Players 9 to 12 run no triggers of their own; the Python side refuses them too.)
    if (!of) return `a program owned by ${o < 12 ? `P${o + 1}` : `player group ${o}`}: a program runs for players 1 to 8, All Players or a force`;
    for (const p of of) if (!slots.includes(p)) slots.push(p);
  }
  return slots.length ? slots : "no human or computer player of this map is among the program's owners";
}

/**
 * `textBase`: the string the first of `Own.texts` is to be among the map's (the next one the map adds; 1 when there is
 * no map).
 */
export function emitOwn(r: Pick<CompileResult, "ir" | "triggers" | "strings">, players: MapPlayers = ANY_PLAYERS, textBase = 1): Own | string {
  // (A map of our own is built without the map's triggers, so `trigger()` records would be lost without a word.)
  if (r.triggers.length) return `a map of our own keeps no trigger() or hyperTriggers() records yet; this script has ${r.triggers.length}`;
  const runs: OwnRun[] = [];
  const values = new Map<string, number[]>();
  // Every program's texts known when built first: the pool is numbered once they are all in, before any is lowered.
  const pool = new TextPool();
  const known = r.ir.map((p) => knownTexts(p, pool, textBase));
  const texts = pool.finish();
  // Units as two numbers each (`units.ts`), then arrays that grow on the heap (`heap.ts`), once the texts' numbers are
  // in: those passes copy what they rewrite.
  const programs = known.map((p) => loopScoped(growingArrays(heldVariables(unitValues(p)))));
  for (const [k, program] of programs.entries()) {
    const slots = ownerSlots(program, players);
    if (typeof slots === "string") return slots;
    const decls = new Map<string, VarDecl>();
    const collect = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(collect);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (o.decl && typeof o.decl === "object" && "id" in (o.decl as object)) decls.set((o.decl as VarDecl).id, o.decl as VarDecl);
        for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
      }
    };
    collect(program);
    // (The heap's own variables, which no program declares: one cell each for the map.)
    for (const d of [...HEAP_GLOBALS, ...UNIT_GLOBALS]) decls.set(d.id, d);
    const functions = new Map<string, FuncDecl>((program.functions ?? []).map((f) => [f.id, f]));
    const arrays = new Map<string, ArrayDecl>((program.arrays ?? []).map((a) => [a.id, a]));
    // The variables and arrays every run of the program has in common: one for every player of a per-player program.
    const shared = new Set<string>(program.perPlayer ? [...[...decls.values()].filter((d) => d.shared).map((d) => d.id), ...[...arrays.values()].filter((a) => a.shared).map((a) => a.id)] : []);
    // A program for one player runs as the first of its owners (the Python side's `slots[0]`), one for each player
    // as each of them, in the order of the slots.
    for (const player of program.perPlayer ? [...slots].sort((a, b) => a - b) : slots.slice(0, 1)) {
      const n = runs.length;
      // (The first run keeps the emitter's names; each other one's are its own, but for what its program shares.)
      const graph = emitBody(program.body, decls, n ? `own${n}` : "own", functions, arrays, undefined, player, players);
      if (typeof graph === "string") return graph;
      const name = (id: string) => (!n || isHeapGlobal(id) || UNIT_GLOBALS.some((d) => d.id === id) ? id : shared.has(id) ? (k ? `${id}#p${k}` : id) : `${id}#${n}`);
      const g = n ? renamed(graph, `#${n}`, name) : graph;
      // An action of the game's names its text and its sound file by the script's strings: given here, for the layout.
      const of = (i: number) => (i ? r.strings[i - 1] : undefined);
      for (const t of g.triggers) for (const a of t.acts) if (a.record && (a.record.text || a.record.wav)) a.strings = { text: of(a.record.text), wav: of(a.record.wav) };
      for (const a of program.arrays ?? []) if (a.values) values.set(name(a.id), a.values);
      runs.push({ program: k, player, graph: g });
    }
  }
  if (!runs.length) return "a script with no program";
  return { programs, runs, values, texts };
}

/**
 * A run's graph with names of its own: `suffix` added to every label (the graph's end too: the layout sends each run's
 * to the run after it), dword of data, scratch cell and template, and every variable and array named as `name` says.
 */
function renamed(g: Graph, suffix: string, name: (id: string) => string): Graph {
  const label = (l: string) => l + suffix;
  const dword = (d: Dword): Dword => {
    if ("var" in d) return { var: name(d.var) };
    if ("data" in d) return { data: d.data + suffix };
    if ("at" in d) return { at: label(d.at), field: d.field };
    // (A scratch cell is the cell of the variable `@` + its name, as a copy from it names it.)
    if ("temp" in d) return { temp: d.temp + suffix };
    if ("element" in d) return { element: name(d.element) };
    if ("cell" in d) return { cell: name(d.cell), index: d.index };
    if ("template" in d) return { template: d.template + suffix, word: d.word };
    return d;
  };
  const num = (v: Num): Num => (typeof v === "number" ? v : "epdOf" in v ? { epdOf: name(v.epdOf), plus: v.plus } : { addrOf: name(v.addrOf), plus: v.plus });
  const value = (v: Value): Value => (typeof v === "object" && "label" in v ? { label: label(v.label) } : typeof v === "object" && "epd" in v ? { epd: dword(v.epd) } : num(v));
  const cond = (c: Cond): Cond => ({ ...c, dword: dword(c.dword) });
  const act = (a: Act): Act => ({ ...a, dword: dword(a.dword), value: value(a.value), ...(a.show !== undefined ? { show: a.show + suffix } : {}), ...(a.textOf !== undefined ? { textOf: a.textOf + suffix } : {}) });
  const trigger = (t: Trigger): Trigger => ({
    ...t,
    label: label(t.label),
    conds: t.conds.map(cond),
    acts: t.acts.map(act),
    ...(t.next !== undefined ? { next: label(t.next) } : {}),
    ...(t.copy ? { copy: { ...t.copy, from: name(t.copy.from), into: t.copy.into.map((p) => ({ ...p, dword: dword(p.dword), add: num(p.add) })) } } : {}),
  });
  return {
    entries: g.entries.map((e) => ({ ...e, from: name(e.from), into: dword(e.into), add: num(e.add) })),
    triggers: g.triggers.map(trigger),
    ...(g.arrays ? { arrays: g.arrays.map((a) => ({ ...a, id: name(a.id) })) } : {}),
    ...(g.cells ? { cells: g.cells.map((c) => ({ ...c, id: name(c.id) })) } : {}),
    ...(g.templates ? { templates: g.templates.map((t) => ({ ...t, id: t.id + suffix })) } : {}),
    ...(g.rows ? { rows: g.rows.map((r) => r.map(label)) } : {}),
  };
}
