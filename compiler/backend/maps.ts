/**
 * The tools' maps of a map of our own (TrigScript 4, step 15): where each trigger of the payload is and the line it
 * came from (`TriggerMap`), and where each program's variables and arrays are (`VariableMap`) — the rows the Python
 * build wrote into its log for the lifted game, Find an EUD Error, the cost by line, the desync detector, the debugger
 * and `sim.program()` to read (`compiler/gameVariables.ts`), made here from the layout instead, and said in the same
 * lines (`TRIGSCRIPT-MAP`, `-ROWS`, `-VARS`, `-PROGRAM`) so that every reader of them is unchanged.
 *
 * - A trigger's origin is the statement its graph trigger was made for ("file:line:column"); a trigger holding several
 *   statements' work says each action's. A cell trigger (a routed variable, an array's or a stack's cell, the heap's)
 *   and what no statement made (a run's wake, the gate, a route) have no origin.
 * - A unit is two numbers of the program's: the EPD of its record and its uniqueness byte (`units.ts`); a made text is
 *   its block's EPD and its length (`texts.ts`): said with `epd` set, and the reader makes the address.
 * - A per-player program runs once a player, each run with variables of its own (`own.ts`): one row of the map a run,
 *   its owner that player, its ids the program's own (the run's renaming undone).
 */
import { programDeclarations, type ArrayDecl, type At, type Program, type VarDecl } from "../ir";
import type { GameArray, GameProgramPlaces, GameVariable, TriggerMap, VariableMap } from "../gameVariables";
import { STRINGS, type OwnMap } from "./layout";
import { HEAP } from "./heap";
import type { Own } from "./own";

/** A cell trigger's value: its action's number field. */
const CELL_VALUE = 348;
const CELL_BYTES = 72;

export interface OwnMaps {
  triggers: TriggerMap;
  variables: VariableMap;
  /** The maps as lines of a build's log, for the readers of the Python build's. */
  lines: string[];
}

/**
 * `stringsBefore`: the string section's length before the payload (the payload's offsets count from its end);
 * `textBase`: the map's string the pool's first text is (a text variable holds its number in the pool).
 */
export function ownMaps(own: Own, laid: OwnMap, ir: readonly Program[], stringsBefore: number, textBase: number): OwnMaps {
  const payload = laid.payload;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const payloadStart = STRINGS + stringsBefore;
  const offsetOf = (address: number) => address - payloadStart;
  const kindByte = (address: number, at: number) => { const o = offsetOf(address) + at; return o >= 0 && o < payload.length ? dv.getUint8(o) : 0; };
  /** How many conditions and actions the game reads of a node: up to the first of kind 0. */
  const counts = (address: number): [number, number] => {
    let conds = 0;
    while (conds < 16 && kindByte(address, 8 + 20 * conds + 15) !== 0) conds++;
    let acts = 0;
    while (acts < 64 && kindByte(address, 328 + 32 * acts + 26) !== 0) acts++;
    return [conds, acts];
  };
  const origin = (at?: At): string => (at ? `${at.file}:${at.line}:${at.column}` : "");
  const rows: TriggerMap["triggers"] = [];
  const seen = new Set<number>();
  for (const run of own.runs) {
    for (const t of run.graph.triggers) {
      const address = laid.triggers.get(t.label);
      if (address === undefined || seen.has(address)) continue;
      seen.add(address);
      const [conds, acts] = counts(address);
      const row: TriggerMap["triggers"][number] = [offsetOf(address), conds, acts, origin(t.at)];
      // (A trigger of the emitter's holding several lines' work: each action's line, where any differs from the trigger's.)
      if (t.acts.some((a) => a.at && origin(a.at) !== origin(t.at))) row.push(t.acts.slice(0, acts).map((a) => origin(a.at ?? t.at)));
      rows.push(row);
    }
  }
  for (const t of own.triggers) for (const slot of t.slots) {
    const address = laid.triggers.get(`@trig${own.triggers.indexOf(t)}.p${slot}`);
    if (address === undefined || seen.has(address)) continue;
    seen.add(address);
    const [conds, acts] = counts(address);
    rows.push([offsetOf(address), conds, acts, ""]);
  }
  for (let k = 0; k < laid.cellCount; k++) {
    const address = laid.cellBase + CELL_BYTES * k;
    if (seen.has(address)) continue;
    seen.add(address);
    const [conds, acts] = counts(address);
    rows.push([offsetOf(address), conds, acts, ""]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const triggers: TriggerMap = { payload: payload.length, triggers: rows };

  const heapRegion = laid.regions.get(HEAP);
  const programs: GameProgramPlaces[] = own.runs.map((run) => {
    const program = ir[run.program];
    const cellOf = (id: string): number | null => laid.vars.get(run.rename(id)) ?? null;
    const vars: GameVariable[] = [];
    const seenIds = new Set<string>();
    for (const d of programDeclarations(program)) {
      if (seenIds.has(d.id) || d.temp || d.task !== undefined) continue;
      seenIds.add(d.id);
      vars.push(variableRow(d, cellOf, textBase));
    }
    const arrays: GameArray[] = [];
    for (const a of program.arrays ?? []) {
      if (a.task !== undefined) continue;
      arrays.push(arrayRow(a, run.rename, laid, cellOf));
    }
    return { index: run.program, name: program.name ?? null, perPlayer: !!program.perPlayer, owners: [run.player], vars, arrays };
  });
  const variables: VariableMap = { heap: null, cells: heapRegion === undefined ? null : heapRegion + CELL_VALUE, strings: STRINGS, programs };

  const lines = [
    "TRIGSCRIPT-MAP " + JSON.stringify({ payload: triggers.payload, count: rows.length }),
    ...chunks(rows, 400).map((part) => "TRIGSCRIPT-ROWS " + JSON.stringify(part)),
    "TRIGSCRIPT-VARS " + JSON.stringify({ programs: programs.length, heap: variables.heap, cells: variables.cells, strings: variables.strings }),
    ...programs.map((p) => "TRIGSCRIPT-PROGRAM " + JSON.stringify(p)),
  ];
  return { triggers, variables, lines };
}

function variableRow(d: VarDecl, cellOf: (id: string) => number | null, textBase: number): GameVariable {
  const base = { id: d.id, kind: d.kind, text: d.kind === "text" ? d.text ?? "id" : null, bits: d.bits ?? null, unsigned: !!d.unsigned, rowed: false, stride: 4 };
  if (d.kind === "unit") return { ...base, cells: { ptr: cellOf(`${d.id}@e`), uid: cellOf(`${d.id}@k`) }, epd: true };
  if (d.kind === "text" && d.text === "made") return { ...base, cells: { addr: cellOf(`${d.id}@e`), len: cellOf(`${d.id}@n`) }, epd: true };
  if (d.kind === "text") return { ...base, cells: { value: cellOf(d.id) }, textBase };
  return { ...base, cells: { value: cellOf(d.id) } };
}

function arrayRow(a: ArrayDecl, rename: (id: string) => string, laid: OwnMap, cellOf: (id: string) => number | null): GameArray {
  const base = { id: a.id, kind: a.kind, bits: a.bits ?? null, unsigned: !!a.unsigned, length: a.length, rowed: false };
  // One that grows: its handle's cells, its block among the heap's (`heap.ts`).
  const ptr = cellOf(`${a.id}@p`), len = cellOf(`${a.id}@n`);
  if (ptr !== null || len !== null) return { ...base, dynamic: true, ptr, len, stride: 4 };
  const region = laid.regions.get(rename(a.id));
  if (region !== undefined) return { ...base, at: region + CELL_VALUE, stride: CELL_BYTES };
  const list = laid.lists.get(rename(a.id));
  if (list) return { ...base, at: list.at, stride: 4 * list.stride };
  return { ...base, at: null, stride: 4 };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out.length ? out : [[]];
}
