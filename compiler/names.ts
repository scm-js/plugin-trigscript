/**
 * The identifiers a script uses for the map's things. `scriptNames(sources)` builds five
 * tables — players, units, locations, switches, AI scripts — each entry being a value and
 * the keys it goes by: an identifier derived from the display name (`TerranMarine`,
 * `BeaconAlpha`) first, the display name itself second (usable as `Units["Terran Marine"]`),
 * then any custom name the map gives it. The declarations are generated from these tables
 * and the printer chooses the first key, so the two agree by construction; keys are unique
 * within a table (a duplicate name gets `_2`, `_3`).
 *
 * The map's part comes in as plain `NameSources` — force names, used locations, switch
 * names, custom unit names — which the plugin reads off the editor's API and the tests
 * hand in directly; nothing here touches a scenario.
 */
import { PlayerGroup, SWITCH_COUNT } from "../vendor/triggers";
import { AI_SCRIPT_CHOICES, aiScriptCode, PLAYER_GROUP_CHOICES, UNIT_CLASS_CHOICES } from "../vendor/triggerDefs";
import { UNIT_NAMES } from "../vendor/units";

/** The location slot the game calls Anywhere (0-based); a script names it `Locations.Anywhere`, value 64. */
export const ANYWHERE_INDEX = 63;

export interface NameEntry {
  value: number;
  /** All keys, the preferred identifier first. Unique within the table. */
  keys: string[];
}

export interface NameTable {
  /** The object the script reads the entries from (`Units`). */
  object: string;
  /** The branded type of its values (`UnitId`). */
  type: string;
  doc: string;
  entries: NameEntry[];
}

export interface ScriptNames {
  players: NameTable;
  units: NameTable;
  locations: NameTable;
  switches: NameTable;
  aiScripts: NameTable;
}

/** What a map contributes to the tables; every part is optional (the fixed lists stand without a map). */
export interface NameSources {
  /** The four force names, null or blank where a force has none. */
  forceNames?: (string | null)[];
  /** The map's used location slots (0-based) with their names; Anywhere is added when it is not listed. */
  locations?: { index: number; name: string }[];
  /** A name per switch slot, when the map names it (`Switch N` and blanks add nothing). */
  switchNames?: (string | null)[];
  /** A unit type's custom name, null or blank for the default. */
  unitCustomName?: (id: number) => string | null;
}

/** `Terran Siege Tank (Tank Mode)` → `TerranSiegeTankTankMode`; never empty, never starts with a digit. */
export function identifier(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (id === "") id = "_";
  if (/^\d/.test(id)) id = `_${id}`;
  return id;
}

/** Keys for a display name: its identifier, then the name itself when that differs. */
function keysFor(...names: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    for (const k of [identifier(n), n]) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Make every key unique across the table: a later duplicate is dropped, or suffixed when it is the entry's first key. */
function table(object: string, type: string, doc: string, entries: NameEntry[]): NameTable {
  const seen = new Set<string>();
  const out: NameEntry[] = [];
  for (const e of entries) {
    const keys: string[] = [];
    e.keys.forEach((k, i) => {
      if (!seen.has(k)) { seen.add(k); keys.push(k); return; }
      if (i !== 0) return;
      let n = 2;
      while (seen.has(`${k}_${n}`)) n++;
      seen.add(`${k}_${n}`);
      keys.push(`${k}_${n}`);
    });
    out.push({ value: e.value, keys });
  }
  return { object, type, doc, entries: out };
}

const PLAYER_KEYS: Record<number, string> = {
  [PlayerGroup.None]: "None", [PlayerGroup.CurrentPlayer]: "Current", [PlayerGroup.Foes]: "Foes", [PlayerGroup.Allies]: "Allies",
  [PlayerGroup.NeutralPlayers]: "Neutral", [PlayerGroup.AllPlayers]: "All", [PlayerGroup.NonAlliedVictoryPlayers]: "NonAlliedVictory",
};

export function playerEntries(forceNames: (string | null)[] = []): NameEntry[] {
  return PLAYER_GROUP_CHOICES.map((c) => {
    const keys = c.value < 12 ? [`P${c.value + 1}`, c.label] : keysFor(PLAYER_KEYS[c.value] ?? c.label, c.label);
    const force = c.value - PlayerGroup.Force1;
    if (force >= 0 && force < 4) keys.push(...keysFor(forceNames[force]).filter((k) => !keys.includes(k)));
    return { value: c.value, keys };
  });
}

export function unitEntries(customName: (id: number) => string | null = () => null): NameEntry[] {
  const out: NameEntry[] = UNIT_NAMES.map((name, id) => ({ value: id, keys: keysFor(name, customName(id) || null) }));
  for (const c of UNIT_CLASS_CHOICES) out.push({ value: c.value, keys: keysFor(c.label, ...(c.aliases ?? [])) });
  return out;
}

export function aiScriptEntries(): NameEntry[] {
  return AI_SCRIPT_CHOICES.map((s) => ({ value: aiScriptCode(s.id), keys: keysFor(s.name, s.id) }));
}

/** The default name of a switch slot, as StarEdit shows it. */
export const defaultSwitchName = (index: number) => `Switch ${index + 1}`;

/** The tables for a map's names — or, with nothing given, the fixed lists alone (what tests use). */
export function scriptNames(src: NameSources = {}): ScriptNames {
  const withMap = !!(src.forceNames || src.locations || src.switchNames || src.unitCustomName);
  const locations: NameEntry[] = [{ value: 0, keys: ["NoLocation", "No Location"] }];
  const listed = (src.locations ?? []).slice().sort((a, b) => a.index - b.index);
  if (!listed.some((l) => l.index === ANYWHERE_INDEX)) listed.push({ index: ANYWHERE_INDEX, name: "Anywhere" });
  for (const { index, name } of listed) {
    locations.push({ value: index + 1, keys: index === ANYWHERE_INDEX ? ["Anywhere", ...keysFor(name).filter((k) => k !== "Anywhere")] : keysFor(name) });
  }
  const switches = Array.from({ length: SWITCH_COUNT }, (_, i) => {
    const keys = [`Switch${i + 1}`, `Switch ${i + 1}`];
    const name = src.switchNames?.[i];
    if (name && name.trim() && name.trim() !== defaultSwitchName(i)) for (const k of keysFor(name.trim())) if (!keys.includes(k)) keys.push(k);
    return { value: i, keys };
  });
  return {
    players: table("Players", "PlayerId", withMap ? "Players, player groups and the map's forces." : "Players and player groups.", playerEntries(src.forceNames ?? [])),
    units: table("Units", "UnitId", withMap ? "Unit types, by StarEdit name and by the map's custom names." : "Unit types, by StarEdit name.", unitEntries(src.unitCustomName ?? (() => null))),
    locations: table("Locations", "LocationId", "The map's locations.", locations),
    switches: table("Switches", "SwitchId", withMap ? "The 256 switches, by number and by the map's names." : "The 256 switches.", switches),
    aiScripts: table("AiScripts", "AiScriptId", "AI scripts, by StarEdit name or four-character code.", aiScriptEntries()),
  };
}

/** Tables over fixed lists only — what a script sees with no map open, and what tests use. */
export function defaultScriptNames(): ScriptNames {
  return scriptNames();
}

/** The entry for a value, if the table has one. */
export function entryFor(t: NameTable, value: number): NameEntry | undefined {
  return t.entries.find((e) => e.value === value);
}
