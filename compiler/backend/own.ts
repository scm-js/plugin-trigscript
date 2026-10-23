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
import type { ScriptString } from "../runtime";
import { ActionType, PlayerGroup, TriggerFlag, type TriggerRecord } from "../../vendor/triggers";
import { ANY_PLAYERS, emitBody, groupSlots, type MapPlayers } from "./emit";
import { NOW, type Act, type Cond, type Dword, type Graph, type Num, type Trigger, type Value } from "./graph";
import { TextPool, knownTexts } from "./texts";
import { HEAP_GLOBALS, growingArrays, heldVariables, isHeapGlobal, loopScoped } from "./heap";
import { EVENT_GLOBALS, UNIT_GLOBALS, eventSources, isEventGlobal, unitValues } from "./units";
import { INPUT_GLOBALS, hasInput, inputValues, isInputGlobal, ownInputPlan, type OwnInputPlan, type OwnMap } from "./input";
import { ownErrors } from "./errors";

export interface OwnRun {
  /** The program's index among the script's. */
  program: number;
  /** The player it runs as, 0-based: the current player while it runs. */
  player: number;
  graph: Graph;
  /** A variable's or an array's id as this run's graph names it (the first run keeps the program's; each other has its own, but for what is shared). */
  rename: (id: string) => string;
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
  /** The players' input the map carries itself (`input.ts`): what the build makes the carriers from; absent when no program reads the players. */
  input?: OwnInputPlan;
  /**
   * The map's own triggers (TrigScript 4, step 13): the map's before the script's `trigger()` and `hyperTriggers()`
   * records, in order, each with the players whose lists it runs in. The layout lays them out as the game's nodes, a
   * copy a player, before the player's gate — so that each player's run them in turn, before the programs, as
   * eudplib's build runs them.
   */
  triggers: OwnTrigger[];
  /** How many hyper triggers (`hyperTriggers()`, or the map's own) were left out of them. */
  hyperTriggersLeftOut: number;
}

/** A hyper trigger: preserved, most of its actions Wait(0) (`compiler/lower.ts`'s, or a map maker's own). */
export function isHyperTrigger(t: TriggerRecord): boolean {
  return (t.flags & TriggerFlag.Preserve) !== 0 && t.actions.filter((a) => a.type === ActionType.Wait && a.time === 0).length >= 32;
}

/**
 * A trigger of the map's own as a map of our own lays it out: its record as written, its conditions and actions as
 * the graph's (`game` / `record`, with the strings a text or a sound file is), and the players whose lists hold a copy —
 * the slots this map gives a human or a computer among those the record names, All Players and the forces resolved as
 * the game resolves them when it loads the map. A record naming no such player is in no list, as in the game.
 */
export interface OwnTrigger {
  record: TriggerRecord;
  conds: Cond[];
  acts: Act[];
  slots: number[];
}

/** A trigger record as the layout takes it; `string` names a text or a sound file by the record's index. */
function ownTrigger(record: TriggerRecord, players: MapPlayers, string: (i: number) => ScriptString | undefined): OwnTrigger {
  const slots: number[] = [];
  for (const [group, on] of record.players.entries()) {
    if (!on || group > PlayerGroup.Force4) continue;
    // (A player not in the game has no list: a trigger for them alone never runs, as in the game.)
    for (const p of groupSlots(group, players) ?? []) if (players.slots.includes(p) && !slots.includes(p)) slots.push(p);
  }
  slots.sort((a, b) => a - b);
  return {
    record,
    conds: record.conditions.map((c): Cond => ({ dword: { game: 0 }, compare: "atLeast", value: 0, game: c })),
    acts: record.actions.map((a): Act => ({ dword: { game: 0 }, modifier: "set", value: 0, record: a, ...(a.text || a.wav ? { strings: { text: string(a.text), wav: string(a.wav) } } : {}) })),
    slots,
  };
}

/** The script's settings a map of our own is built with (`script.ts`'s `ScriptSettings`): the defaults when unset. */
export interface OwnOptions {
  /** The cells of the heap the programs' growing arrays share (`ir.ts`'s `HEAP_CELLS`). */
  heapCells?: number;
  /** How many calls deep a function that calls itself may go (`ir.ts`'s `STACK_DEPTH`). */
  stackDepth?: number;
}

/** What `emitOwn` takes the map for when the build gave none: the players' slots all human, a 128 by 128 map, the last unit-properties slot. */
const ANY_MAP: OwnMap = { humans: ANY_PLAYERS.slots, width: 128 * 32, height: 128 * 32, cuwp: 64 };

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
export function emitOwn(r: Pick<CompileResult, "ir" | "triggers" | "strings"> & Partial<Pick<CompileResult, "input">>, players: MapPlayers = ANY_PLAYERS, textBase = 1, map: OwnMap = { ...ANY_MAP, humans: players === ANY_PLAYERS ? ANY_MAP.humans : players.slots }, options: OwnOptions = {}): Own | string {
  // The map's own triggers, then the script's records (step 13): a record's text or sound file is the script's string
  // it names, the map's the map's own string already. Hyper triggers are left out: a map of our own goes through its
  // triggers every frame as it is, and under that pass the game holds a list with hyper triggers in it to every second
  // frame (measured in the lifted game; eudplib's build is held so too).
  const kept = [...(map.triggers ?? []).map((t) => [t, true] as const), ...r.triggers.map((t) => [t, false] as const)].filter(([t]) => !isHyperTrigger(t));
  const hyperTriggersLeftOut = (map.triggers?.length ?? 0) + r.triggers.length - kept.length;
  const triggers = kept.map(([t, ofMap]) => ownTrigger(t, players, ofMap ? (i) => (i ? { index: i } : undefined) : (i) => (i ? r.strings[i - 1] : undefined)));
  const runs: OwnRun[] = [];
  const values = new Map<string, number[]>();
  // Every program's texts known when built first: the pool is numbered once they are all in, before any is lowered.
  // (What an error needs texts for — an uncaught one said, a stack that ran out — written out before: `errors.ts`.)
  const pool = new TextPool();
  const known = r.ir.map((p) => knownTexts(ownErrors(p), pool, textBase));
  const texts = pool.finish();
  // Units as two numbers each (`units.ts`), then arrays that grow on the heap (`heap.ts`), once the texts' numbers are
  // in: those passes copy what they rewrite.
  // (The map's events pass is one, laid out by the first program that has events, for what all of them loop over.)
  const sources = eventSources(known);
  const passer = known.findIndex((p) => eventSources(p).size);
  // (The players' input likewise: its passes laid out by the first program that reads them.)
  // (The names a `{…:unit}` capture of a typed line knows: the ones the compile listed for eudplib's build.)
  const planned = ownInputPlan(known, map, r.input?.unitNames);
  if (typeof planned === "string") return planned;
  const input = planned;
  const reader = known.findIndex(hasInput);
  const programs = known.map((p, k) => loopScoped(growingArrays(heldVariables(withInput(unitValues(p, { sources, pass: k === passer }, input?.carrier), k)), options.heapCells)));
  function withInput(p: Program, k: number): Program { return input && (hasInput(p) || k === reader) ? inputValues(p, input, k === reader) : p; }
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
    // (The heap's own variables, which no program declares, and the count of frames: one cell each for the map.)
    for (const d of [...HEAP_GLOBALS, ...UNIT_GLOBALS, ...EVENT_GLOBALS, ...INPUT_GLOBALS, NOW_DECL]) decls.set(d.id, d);
    const functions = new Map<string, FuncDecl>((program.functions ?? []).map((f) => [f.id, f]));
    const arrays = new Map<string, ArrayDecl>((program.arrays ?? []).map((a) => [a.id, a]));
    // The variables and arrays every run of the program has in common: one for every player of a per-player program.
    const shared = new Set<string>(program.perPlayer ? [...[...decls.values()].filter((d) => d.shared).map((d) => d.id), ...[...arrays.values()].filter((a) => a.shared).map((a) => a.id)] : []);
    // A program for one player runs as the first of its owners (the Python side's `slots[0]`), one for each player
    // as each of them, in the order of the slots.
    const firstRun = runs.length;
    for (const player of program.perPlayer ? [...slots].sort((a, b) => a - b) : slots.slice(0, 1)) {
      const n = runs.length;
      // (The first run keeps the emitter's names; each other one's are its own, but for what its program shares.)
      const graph = emitBody(program.body, decls, n ? `own${n}` : "own", functions, arrays, options.stackDepth, player, players, program.errors, runs.length === firstRun ? program.pass : undefined, runs.length === firstRun ? program.after : undefined);
      if (typeof graph === "string") return graph;
      const name = (id: string) => (!n || isHeapGlobal(id) || id === NOW || isEventGlobal(id) || isInputGlobal(id) || UNIT_GLOBALS.some((d) => d.id === id) ? id : shared.has(id) ? (k ? `${id}#p${k}` : id) : `${id}#${n}`);
      const g = n ? renamed(graph, `#${n}`, name) : graph;
      // An action of the game's names its text and its sound file by the script's strings: given here, for the layout.
      const of = (i: number) => (i ? r.strings[i - 1] : undefined);
      for (const t of g.triggers) for (const a of t.acts) if (a.record && (a.record.text || a.record.wav)) a.strings = { text: of(a.record.text), wav: of(a.record.wav) };
      for (const a of program.arrays ?? []) if (a.values) values.set(name(a.id), a.values);
      runs.push({ program: k, player, graph: g, rename: name });
    }
  }
  if (!runs.length) return "a script with no program";
  return { programs, runs, values, texts, triggers, hyperTriggersLeftOut, ...(input ? { input } : {}) };
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
    ...(g.tasks ? { tasks: label(g.tasks) } : {}),
    ...(g.pass ? { pass: label(g.pass) } : {}),
    ...(g.after ? { after: label(g.after) } : {}),
  };
}

/** The map's count of frames (`NOW`): a variable of every run's, one more each pass. */
const NOW_DECL: VarDecl = { id: NOW, name: "(frames)", kind: "number", shared: true, routed: true, global: true, at: { file: "", line: 0, column: 0 } };
