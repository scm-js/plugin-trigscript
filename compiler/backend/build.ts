/**
 * A map of our own, built from a scenario file (TrigScript 4, step 14: the build in the editor). What
 * `scripts/build-own.mts` did with the editor's code, done on the CHK's bytes alone (`chk.ts`), so that the plugin's
 * build step can do it on Save, Test Map and an export, in the compile worker, with no eudplib and no Python:
 *
 * 1. The map's facts: its size, who plays and in which force, its own triggers (the script's `trigger()` records
 *    among them, once applied), the unit types and the unit-properties slots in use.
 * 2. eudplib's fixes to the map (`fixes.ts`), so that a map built either way is the same map.
 * 3. The programs lowered whole (`own.ts`, `emitOwn`): every text known when built goes into the strings, one after
 *    another from the next index; every printed text and every action's text or sound file is interned; a text
 *    printed with values in it gets a string as long as its template, which is then written over that string.
 * 4. The layout (`layout.ts`): the payload after the strings, where Remastered keeps them, and the start-up in TRIG.
 * 5. The slot of unit properties the carriers of the players' input are made with, marked in transit.
 *
 * A program the emitter does not take is a refusal, said in the user's words with the line; the map is then not
 * built this way (the editor builds it through eudplib while that is still there, or saves it without its programs).
 */
import type { CompileResult } from "../compiler";
import type { TriggerRecord } from "../../vendor/triggers";
import { Sections, addString, freeCuwpSlot, intern, markInTransit, readFacts, readStrings, readTriggers, unitTypesUsed, writeStrings } from "./chk";
import { fixMap } from "./fixes";
import { STRINGS, layout } from "./layout";
import { emitOwn, type OwnOptions } from "./own";
import type { MapPlayers } from "./emit";
import type { Graph } from "./graph";

/** The Valkyrie: the carrier of the players' input unless the map's units or triggers name it. */
const CARRIER = 58;
const UNIT_TYPES = 228;

export interface OwnBuildInput {
  /** The scenario as the editor would save it: the script applied. */
  chk: Uint8Array;
  /**
   * The compile. Its `triggers` are records the map's trigger list does not hold yet (a probe built under Node);
   * the editor passes none, the block being in the list already.
   */
  compiled: Pick<CompileResult, "ir" | "strings" | "input" | "triggers">;
  /** The script's settings: the heap's cells, the stack's depth. */
  settings?: OwnOptions;
  /** Leave the map's own triggers out (a probe built on a melee map, whose stock triggers would end the game). */
  dropMapTriggers?: boolean;
  /** A dword written into every free cell of the payload (a probe's marker). */
  free?: number;
}

export interface OwnBuildStats {
  runs: number;
  /** The programs' runs, as "program 2 as P1". */
  runNames: string[];
  graphTriggers: number;
  payloadBytes: number;
  address: number;
  /** The map's own triggers laid out, and the copies of them (one a player they run for). */
  mapTriggers: number;
  mapTriggerCopies: number;
  hyperTriggersLeftOut: number;
  startUpTriggers: number;
  input: { keys: number; mouse: boolean; syncs: number; carrier: number; ring: number; rings: number; humans: number[]; cuwp: number; bits: number } | null;
  /** How many strings the map had before, and has now. */
  stringsBefore: number;
  stringsAfter: number;
}

export interface OwnBuild {
  chk: Uint8Array;
  /** What was done, for the Output panel: the fixes, the input, the counts. */
  lines: string[];
  stats: OwnBuildStats;
}

export type OwnBuildOutcome = OwnBuild | { refused: string };

export function buildOwnMap(input: OwnBuildInput): OwnBuildOutcome {
  const s = new Sections(input.chk);
  const lines: string[] = [];
  // The map's facts come first, before the fixes change its bytes.
  const facts = readFacts(s);
  const players: MapPlayers = { slots: facts.slots, forces: facts.forces };
  const mapTriggers: TriggerRecord[] = input.dropMapTriggers ? [] : readTriggers(s);
  const used = unitTypesUsed(s, [...mapTriggers, ...input.compiled.triggers]);
  const carrier = used.has(CARRIER) ? [...Array(UNIT_TYPES).keys()].find((t) => !used.has(t)) ?? CARRIER : CARRIER;
  const cuwp = freeCuwpSlot([...mapTriggers, ...input.compiled.triggers]);
  // The strings: STRx as they are, or STR's read on as STRx (a Remastered file keeps its strings there).
  const strx = s.get("STRx");
  const str = s.get("STR ");
  if (!strx && !str) throw new Error("The map has no string table (STR or STRx).");
  const table = readStrings(strx ?? str!, !!strx);
  const stringsBefore = table.entries.length;
  const textBase = stringsBefore + 1;
  lines.push(...fixMap(s));
  if (!strx) lines.push(`the strings written as STRx (Remastered's table), from STR`);

  const lowered = emitOwn(input.compiled, players, textBase, { humans: facts.humans, width: facts.width * 32, height: facts.height * 32, cuwp, carrier, triggers: mapTriggers }, input.settings);
  if (typeof lowered === "string") return { refused: lowered };
  // The pool of texts: the map's next strings, one after another, as the programs count on.
  lowered.texts.forEach((text, i) => {
    if (addString(table, text) !== textBase + i) throw new Error("The pool of texts did not go into the map's strings one after another.");
  });
  const graphs: Graph[] = lowered.runs.map((run) => run.graph);
  const texts = new Map<string, number>();
  const want = (text: string) => { if (!texts.has(text)) texts.set(text, intern(table, text)); };
  for (const t of [...graphs.flatMap((g) => g.triggers), ...lowered.triggers]) for (const a of t.acts) {
    if (a.display !== undefined) want(a.display);
    for (const x of [a.strings?.text, a.strings?.wav]) if (x && "text" in x) want(x.text);
    if (a.amountText) want(a.amountText.text);
  }
  // A string for each text printed with values in it, as long as its template and three bytes more: once the strings
  // are laid out, the template is written over it from its first dword's start, and the string's offset moved there
  // (the game's own table of strings names only its first 64 KB in 1.16.1, so the template stays among them).
  const templates = new Map<string, number>();
  for (const t of graphs.flatMap((g) => g.templates ?? [])) {
    if (t.at !== undefined || t.data) continue;
    const name = `(TrigScript text ${t.id})`;
    templates.set(t.id, addString(table, name + "\r".repeat(Math.max(0, t.bytes.length + 3 - name.length))));
  }
  const written = writeStrings(table);
  const strings = written.data;
  const offsets = new DataView(strings.buffer, strings.byteOffset, strings.byteLength);
  const templateAt = new Map<string, number>();
  for (const t of graphs.flatMap((g) => g.templates ?? [])) {
    if (t.at !== undefined || t.data) continue;
    const index = templates.get(t.id)!;
    const at = (STRINGS + written.offsets[index - 1] + 3) & ~3;
    strings.set(t.bytes, at - STRINGS);
    offsets.setUint32(4 * index, at - STRINGS, true);
    templateAt.set(t.id, at);
  }
  const own = layout({
    runs: lowered.runs.map((run) => ({ graph: run.graph, owner: run.player })),
    players: players.slots,
    triggers: lowered.triggers,
    strings: strings.length,
    text: (t) => texts.get(t)!,
    arrays: lowered.values,
    template: (id) => templates.get(id)!,
    templateAt,
    ...(input.free !== undefined ? { free: input.free } : {}),
  });
  const withPayload = new Uint8Array(strings.length + own.payload.length);
  withPayload.set(strings);
  withPayload.set(own.payload, strings.length);
  if (strx) s.set("STRx", withPayload);
  else s.replace("STR ", "STRx", withPayload);
  s.set("TRIG", own.trig);
  if (lowered.input) markInTransit(s, cuwp);

  const stats: OwnBuildStats = {
    runs: lowered.runs.length,
    runNames: lowered.runs.map((run) => `program ${run.program + 1} as P${run.player + 1}`),
    graphTriggers: graphs.reduce((n, g) => n + g.triggers.length, 0),
    payloadBytes: own.payload.length,
    address: own.address,
    mapTriggers: lowered.triggers.length,
    mapTriggerCopies: lowered.triggers.reduce((n, t) => n + t.slots.length, 0),
    hyperTriggersLeftOut: lowered.hyperTriggersLeftOut,
    startUpTriggers: own.trig.length / 2400,
    input: lowered.input ? { keys: lowered.input.keys.length, mouse: lowered.input.mouse, syncs: lowered.input.syncs, carrier, ring: lowered.input.ring, rings: lowered.input.rings, humans: lowered.input.humans, cuwp, bits: lowered.input.bits } : null,
    stringsBefore,
    stringsAfter: table.entries.length,
  };
  if (stats.input) lines.push(`input: ${stats.input.keys} keys, ${stats.input.mouse ? "the mouse, " : ""}${stats.input.syncs} sync slots; carriers of type ${carrier}, ${stats.input.ring} a ring, ${stats.input.rings} rings, for players ${stats.input.humans.map((h) => h + 1).join(", ")}; unit-properties slot ${cuwp}; ${stats.input.bits} bits a value`);
  lines.push(`${stats.runs} run${stats.runs === 1 ? "" : "s"} (${stats.runNames.join(", ")}), ${stats.graphTriggers} triggers of the programs, payload ${stats.payloadBytes} bytes at 0x${stats.address.toString(16)}, ${stats.mapTriggers} trigger${stats.mapTriggers === 1 ? "" : "s"} of the map's own (${stats.mapTriggerCopies} copies${stats.hyperTriggersLeftOut ? `, ${stats.hyperTriggersLeftOut} hyper triggers left out` : ""}), start-up ${stats.startUpTriggers} triggers, ${stats.stringsAfter - stats.stringsBefore} strings added`);
  return { chk: s.bytes(), lines, stats };
}

export const isRefused = (o: OwnBuildOutcome): o is { refused: string } => "refused" in o;
