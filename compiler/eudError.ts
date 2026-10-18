/**
 * Remastered's "EUD ERROR: 0x…", back to the line of the script (TrigScript 4, from R0 and A1).
 *
 * When Remastered's emulation of 1.16.1's memory refuses a read or a write, it ends the game and shows a code. R0
 * found what the code is: the address the trigger named, its bits inverted (probe D of the dump's probe ended on
 * "EUD ERROR: 0xFFA632E3", a read of 0x59CD1C, the first unit's +0x74). So the code says exactly which address, and
 * not which trigger. Which line it was comes from a run in the lifted game with every EUD access written down under
 * the line that made it (`EudTracer`): the lines that touched that address are the answer.
 *
 * The run is not the person's game. A unit's place in the unit table differs from game to game, so a unit field is
 * matched by the field in any unit as well as by the exact address; a line the run never reached is not found.
 */
import { verdictOf, type Allowlist, type Verdict } from "./allowlist";
import type { CostLines } from "./gameCost";
import { TABLE_FIELDS, type TableKind } from "./tables";
import { MEMORY_FIELDS } from "./memory";

/** The address an error code names, or null when the text holds no code. Takes "EUD ERROR: 0xFFA632E3", "0xFFA632E3" or "FFA632E3". */
export function addressOfEudError(text: string): number | null {
  const m = /EUD\s*ERROR\s*:?\s*(?:0x)?([0-9a-f]{1,8})\b/i.exec(text) ?? /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/i.exec(text);
  return m ? ~parseInt(m[1], 16) >>> 0 : null;
}

/** The code Remastered shows for an address (the other way round, for a probe's answer sheet and the tests). */
export function eudErrorOf(address: number): string {
  return `0x${(~address >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** 1.16.1's unit table: 1,700 units of 336 bytes. */
export const UNIT_TABLE = { base: 0x59cca8, stride: 336, count: 1700 };

/** The fields of a unit (CUnit), by offset and width, as 1.16.1 lays them out. */
const UNIT_FIELDS: [number, number, string][] = [
  [0x00, 4, "previous unit"], [0x04, 4, "next unit"], [0x08, 4, "hit points"], [0x0c, 4, "sprite"],
  [0x10, 4, "move target position"], [0x14, 4, "move target unit"], [0x18, 4, "next waypoint"], [0x1c, 4, "next target waypoint"],
  [0x20, 1, "movement flags"], [0x21, 1, "facing direction"], [0x22, 1, "turn radius"], [0x23, 1, "velocity direction"],
  [0x24, 2, "flingy"], [0x26, 1, "unknown 0x26"], [0x27, 1, "movement type"], [0x28, 2, "x"], [0x2a, 2, "y"],
  [0x2c, 4, "halt x"], [0x30, 4, "halt y"], [0x34, 4, "top speed"], [0x38, 4, "speed 1"], [0x3c, 4, "speed 2"],
  [0x40, 4, "current speed"], [0x44, 2, "acceleration"], [0x46, 1, "direction 2"], [0x47, 1, "velocity direction 2"],
  [0x48, 4, "unknown 0x48"], [0x4c, 1, "owner"], [0x4d, 1, "order"], [0x4e, 1, "order state"], [0x4f, 1, "order signal"],
  [0x50, 2, "order unit type"], [0x52, 2, "unknown 0x52"], [0x54, 1, "order timer"], [0x55, 1, "ground weapon cooldown"],
  [0x56, 1, "air weapon cooldown"], [0x57, 1, "spell cooldown"], [0x58, 4, "order target position"], [0x5c, 4, "order target unit"],
  [0x60, 4, "shields"], [0x64, 2, "unit type"], [0x66, 2, "unknown 0x66"], [0x68, 4, "previous unit of its player"],
  [0x6c, 4, "next unit of its player"], [0x70, 4, "subunit"], [0x74, 4, "order queue head"], [0x78, 4, "order queue tail"],
  [0x7c, 4, "auto target unit"], [0x80, 4, "connected unit"], [0x84, 1, "order queue count"], [0x85, 1, "order queue timer"],
  [0x86, 1, "unknown 0x86"], [0x87, 1, "attack notify timer"], [0x88, 2, "previous unit type"], [0x8a, 1, "last event timer"],
  [0x8b, 1, "last event colour"], [0x8c, 2, "unused 0x8c"], [0x8e, 1, "rank increase"], [0x8f, 1, "kills"],
  [0x90, 1, "last attacking player"], [0x91, 1, "secondary order timer"], [0x92, 1, "AI action flag"], [0x93, 1, "user action flags"],
  [0x94, 2, "button set"], [0x96, 1, "cloaked"], [0x97, 1, "movement state"], [0x98, 10, "build queue"], [0xa2, 2, "energy"],
  [0xa4, 1, "build queue slot"], [0xa5, 1, "unique id"], [0xa6, 1, "secondary order"], [0xa7, 1, "building overlay state"],
  [0xa8, 2, "hit point gain"], [0xaa, 2, "shield gain"], [0xac, 2, "remaining build time"], [0xae, 2, "previous hit points"],
  [0xb0, 16, "loaded units"], [0xc0, 16, "what its type keeps (mines, interceptors, nuke…)"], [0xd0, 12, "what a building keeps (resources, …)"],
  [0xdc, 4, "status flags"], [0xe0, 1, "resource type"], [0xe1, 1, "wireframe randomiser"], [0xe2, 1, "secondary order state"],
  [0xe3, 1, "recent order timer"], [0xe4, 4, "visibility"], [0xe8, 4, "secondary order position"], [0xec, 4, "unit being built"],
  [0xf0, 4, "previous burrowed unit"], [0xf4, 4, "next burrowed unit"], [0xf8, 8, "rally point"], [0x100, 4, "path"],
  [0x104, 1, "pathing collision interval"], [0x105, 1, "pathing flags"], [0x106, 1, "unused 0x106"], [0x107, 1, "being healed"],
  [0x108, 8, "contour bounds"], [0x110, 2, "remove timer"], [0x112, 2, "defensive matrix hit points"], [0x114, 1, "defensive matrix timer"],
  [0x115, 1, "stim timer"], [0x116, 1, "ensnare timer"], [0x117, 1, "lockdown timer"], [0x118, 1, "irradiate timer"],
  [0x119, 1, "stasis timer"], [0x11a, 1, "plague timer"], [0x11b, 1, "storm timer"], [0x11c, 4, "irradiated by"],
  [0x120, 1, "irradiating player"], [0x121, 1, "parasites"], [0x122, 1, "cycle counter"], [0x123, 1, "blind"],
  [0x124, 1, "maelstrom timer"], [0x125, 1, "unused 0x125"], [0x126, 1, "acid spore count"], [0x127, 9, "acid spore timers"],
  [0x130, 2, "3×3 attack sequence"], [0x132, 2, "unused 0x132"], [0x134, 4, "computer player's data"], [0x138, 2, "air strength"],
  [0x13a, 2, "ground strength"], [0x13c, 16, "unit finder bounds"], [0x14c, 4, "repulse"],
];

/** A unit field's name, by the byte. */
export function unitFieldAt(offset: number): string {
  const f = UNIT_FIELDS.find(([at, n]) => offset >= at && offset < at + n);
  return f ? (offset === f[0] ? f[2] : `${f[2]} (+${offset - f[0]})`) : `+${hex(offset)}`;
}

/** Other tables of 1.16.1's a script reaches, by name; a row of `stride` bytes, `count` of them. */
const TABLES: { name: string; base: number; stride: number; count: number; row?: (i: number) => string }[] = [
  { name: "deaths", base: 0x58a364, stride: 4, count: 12 * 228, row: (i) => `of unit type ${Math.floor(i / 12)} for P${(i % 12) + 1}` },
  { name: "kills", base: 0x5878a4, stride: 4, count: 12 * 228, row: (i) => `of unit type ${Math.floor(i / 12)} for P${(i % 12) + 1}` },
  { name: "minerals", base: 0x57f0f0, stride: 4, count: 12, row: (i) => `of P${i + 1}` },
  { name: "gas", base: 0x57f120, stride: 4, count: 12, row: (i) => `of P${i + 1}` },
  { name: "switches", base: 0x58dc40, stride: 4, count: 8, row: (i) => `${32 * i + 1} to ${32 * i + 32}` },
  { name: "locations", base: 0x58dc60, stride: 20, count: 255, row: (i) => `location ${i + 1}` },
  { name: "text lines", base: 0x640b60, stride: 218, count: 13, row: (i) => `line ${i + 1}` },
  { name: "keys of the local machine", base: 0x596a18, stride: 1, count: 256 },
  { name: "mouse buttons of the local machine", base: 0x6cddc0, stride: 4, count: 1 },
  { name: "mouse position of the local machine", base: 0x6cddc4, stride: 8, count: 1 },
  { name: "current player", base: 0x6509b0, stride: 4, count: 1 },
];

/** Where an address lies, in words: "unit slot 0 of 1,700, order queue head (+0x74)". With `list`, an entry's name where nothing else knows it. */
export function placeOfAddress(address: number, list?: Allowlist): string {
  const u = address - UNIT_TABLE.base;
  if (u >= 0 && u < UNIT_TABLE.stride * UNIT_TABLE.count) {
    const at = u % UNIT_TABLE.stride;
    return `the unit table: slot ${Math.floor(u / UNIT_TABLE.stride)} of ${UNIT_TABLE.count.toLocaleString("en")}, ${unitFieldAt(at)} (+${hex(at)})`;
  }
  for (const t of TABLES) {
    const off = address - t.base;
    if (off < 0 || off >= t.stride * t.count) continue;
    const i = Math.floor(off / t.stride), within = off % t.stride;
    return `${t.name}${t.row ? `, ${t.row(i)}` : ""}${t.stride > 4 && within ? ` (+${within})` : ""}`;
  }
  const cell = MEMORY_FIELDS.find((f) => address >= f.base && address < f.base + f.width);
  if (cell) return `memory.${cell.path.join(".")}`;
  for (const [kind, fields] of Object.entries(TABLE_FIELDS) as [TableKind, (typeof TABLE_FIELDS)[TableKind]][]) {
    for (const f of fields) {
      const width = f.width === "bit" ? 4 : f.width, off = address - f.base;
      if (off < 0 || off % f.stride >= width) continue;
      const i = Math.floor(off / f.stride);
      if (i < (f.keyed ? 12 : TABLE_SIZE_OF[kind])) return `stats(): the ${kind} table's ${f.name}, entry ${i}`;
    }
  }
  const named = list?.entries.find((e) => !/^0x[0-9a-f]+$/i.test(e.name) && covers(e, address));
  return named ? named.name : "no table TrigScript knows";
}
const TABLE_SIZE_OF: Record<TableKind, number> = { unit: 228, weapon: 130, upgrade: 61, tech: 44, player: 12 };
function covers(e: Allowlist["entries"][number], byte: number): boolean {
  const off = byte - e.base;
  if (off < 0) return false;
  if (!e.stride) return off < e.width;
  return off % e.stride < e.width && Math.floor(off / e.stride) < (e.count ?? 1);
}

/** One dword a run read or wrote, under the line that did it (null: eudplib's own work, or the map's other triggers). */
export interface EudTraceRow { file: string | null; line: number | null; address: number; write: boolean; mask: number; times: number }

/**
 * Every EUD read and write of a run in the lifted game, by line: what the host's EUD tap says (scm-sim's
 * `installEud`), each put under the line its record ran for. The cost tap says the line, as it does for the debugger
 * (A5): it is told of each record before the record runs, with eudplib's variables and functions put under the line
 * that ran just before them, so a read inside eudplib's `f_dwread_epd` is the line that called it.
 */
export class EudTracer {
  private group = -1;
  private readonly seen = new Map<string, [number, number]>();
  private readonly places: readonly { file: string; line: number }[];
  private readonly host: EudTraceHost;

  constructor(host: EudTraceHost, lines: CostLines | null) {
    this.host = host;
    this.places = lines?.places ?? [];
  }

  /** Whether the host can trace at all: an EUD tap, and a cost tap to say the line. */
  static can(host: EudTraceHost): boolean { return !!host.eud && !!host.cost && "trace" in host.cost; }

  start(): void {
    const { cost, eud } = this.host;
    if (cost) cost.trace = (_record, group) => { this.group = group; };
    if (eud) eud.listen = (_record, address, write, mask) => {
      const key = `${this.group}|${address}|${write ? 1 : 0}`, was = this.seen.get(key);
      if (was) { was[0] = (was[0] | mask) >>> 0; was[1]++; } else this.seen.set(key, [mask >>> 0, 1]);
    };
  }

  stop(): void {
    const { cost, eud } = this.host;
    if (cost) cost.trace = null;
    if (eud) eud.listen = null;
    this.group = -1;
  }

  /** What was traced; plain data for the way back to the editor. */
  rows(): EudTraceRow[] {
    return [...this.seen].map(([key, [mask, times]]) => {
      const [g, address, write] = key.split("|").map(Number);
      const at = g >= 0 ? this.places[g] : undefined;
      return { file: at?.file ?? null, line: at?.line ?? null, address, write: write === 1, mask, times };
    });
  }
}

/** The two taps of a host's game, by shape (scm-sim's `EudTap` and `CostTap`: TrigScript never imports the engine). */
export interface EudTraceHost {
  readonly eud?: { listen: ((record: number, address: number, write: boolean, mask: number, was: number) => void) | null };
  readonly cost?: { trace?: ((record: number, group: number, action: boolean) => void) | null };
}

/** A line that touched the address, or the same field of another unit. */
export interface EudErrorLine {
  file: string;
  line: number;
  /** "exact": this very address; "field": the same field of another unit (units sit elsewhere in the person's game). */
  match: "exact" | "field";
  read: boolean;
  write: boolean;
  times: number;
}

export interface EudErrorAnswer {
  /** As Remastered shows it, "0xFFA632E3". */
  code: string;
  address: number;
  place: string;
  /** What the allowlist says of a read and a write there, and what that rests on. */
  read: Verdict;
  write: Verdict;
  evidence: string[];
  /** The lines, those that touched the very address first, then by how often. */
  lines: EudErrorLine[];
  /** Accesses to it under no line: eudplib's start and its own work at the top of a frame, or the map's other triggers. */
  unlined: { exact: number; field: number };
}

/** Which lines of a traced run touched `address` (or, in the unit table, the same field of any unit), and what it is. */
export function findEudError(address: number, rows: readonly EudTraceRow[], list?: Allowlist): EudErrorAnswer {
  const dword = address & ~3;
  const u = address - UNIT_TABLE.base;
  const field = u >= 0 && u < UNIT_TABLE.stride * UNIT_TABLE.count ? u % UNIT_TABLE.stride & ~3 : null;
  const byLine = new Map<string, EudErrorLine>();
  const unlined = { exact: 0, field: 0 };
  for (const r of rows) {
    let match: EudErrorLine["match"] | null = null;
    if (r.address === dword) match = "exact";
    else if (field !== null) {
      const o = r.address - UNIT_TABLE.base;
      if (o >= 0 && o < UNIT_TABLE.stride * UNIT_TABLE.count && o % UNIT_TABLE.stride === field) match = "field";
    }
    if (!match) continue;
    if (r.file === null || r.line === null) { unlined[match] += r.times; continue; }
    const key = `${r.file}:${r.line}`, had = byLine.get(key);
    if (!had) byLine.set(key, { file: r.file, line: r.line, match, read: !r.write, write: r.write, times: r.times });
    else {
      had.times += r.times;
      if (match === "exact") had.match = "exact";
      if (r.write) had.write = true; else had.read = true;
    }
  }
  const lines = [...byLine.values()].sort((a, b) => (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1) || b.times - a.times || a.file.localeCompare(b.file) || a.line - b.line);
  const read = list ? verdictOf(list, address, false) : null, write = list ? verdictOf(list, address, true) : null;
  const evidence = [...new Set([...(read?.entry?.evidence ?? []), ...(write?.entry?.evidence ?? [])])];
  if (list && !read?.entry && !write?.entry && list.outside) evidence.push(...list.outside.evidence);
  return {
    code: eudErrorOf(address), address, place: placeOfAddress(address, list),
    read: read?.verdict ?? "unknown", write: write?.verdict ?? "unknown", evidence, lines, unlined,
  };
}
