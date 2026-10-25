/**
 * What Remastered is known to allow, and a run in the lifted game held against it (TrigScript 4, A1).
 *
 * The lifted game is 1.16.1: it says what an address means and what the triggers did with it, never whether
 * Remastered's emulation of 1.16.1's memory would have let them. The allowlist says that, entry by entry, each with
 * the evidence it rests on: a probe played in Remastered, Magenta's catalogue (itself verified by probes), or a
 * failure seen in the game. `checkTrace` takes what a run touched (scm-sim's `scripts/exact-eud.ts --trace`) and
 * says, by line, what Remastered was seen to refuse or ignore and what it has not been seen to do at all.
 *
 * A trace row is a dword and the bits that were looked at or changed (the record's mask); a row is held byte by
 * byte, so a write of one byte under a mask needs only that byte allowed.
 */

/** What Remastered does with a read or a write of an entry: lets it, ends the game, does nothing, or not known. */
export type Verdict = "allowed" | "ends" | "ignored" | "unknown";

export interface AllowEntry {
  /** What lies there ("unit table: hit points", "deaths table"). */
  name: string;
  /** The first byte; with `stride`, the first byte of the first of `count` rows. */
  base: number;
  stride?: number;
  count?: number;
  /** Bytes from `base` (within each row). */
  width: number;
  read: Verdict;
  write: Verdict;
  /** What each verdict rests on, in words a person can follow up. */
  evidence: string[];
  /** A value that differs between the players' computers (the mouse, the screen): never to change the game itself. */
  local?: boolean;
  /** "dump": read off Remastered's own EUD emulator rather than seen in a game; a played entry over the same byte wins. */
  from?: "dump";
  /** What a person needs besides the verdict ("a unit pointer: the game takes only the address of a unit"). */
  note?: string;
}

export interface Allowlist {
  version: 1;
  entries: AllowEntry[];
  /** What Remastered does with an address no entry covers, and why (its emulator has no region there: the game ends). */
  outside?: { verdict: Verdict; evidence: string[] };
}

/** [origin, address, write (1) or read (0), mask, times] — origin as the build's map of triggers names it. */
export type TraceRow = [string, number, number, number, number];

export interface Trace {
  map?: string;
  frames: number;
  /** The map's own strings and the build's payload behind them, where Remastered keeps them: the map's own memory. */
  strings: { from: number; to: number };
  /** The lifted game's heap (what the game allocated: its trigger lists among it); absent in older traces. */
  heap?: { from: number; to: number };
  rows: TraceRow[];
}

export interface Finding {
  /** "12:5" or "file.ts:12:5"; "" for a trigger no line made (a program's frame, the build's own); from a build before step 17, "fn:<name>", "eudplib" or "?". */
  origin: string;
  line: number | null;
  write: boolean;
  verdict: Exclude<Verdict, "allowed">;
  /** The first address of the kind found, how many distinct dwords and how many times in all. */
  address: number;
  addresses: number;
  times: number;
  /** The entry that decided it, or the table of the game it lies in when no entry covers it. */
  entry: string | null;
  evidence: string[];
}

export interface TraceCheck {
  findings: Finding[];
  /** Accesses (rows) by what decided them. */
  counted: { own: number; heap: number; allowed: number; ends: number; ignored: number; unknown: number };
}

/** 1.16.1's tables by name, so that what no entry covers is still said in words, and a loop over every unit is one finding. */
const TABLES = [
  { name: "unit table", base: 0x59cca8, stride: 336, count: 1700 },
  { name: "deaths table", base: 0x58a364, stride: 4, count: 12 * 228 },
];
function placeOf(address: number): string {
  for (const t of TABLES) {
    const off = address - t.base;
    if (off >= 0 && off < t.stride * t.count) return t.stride > 4 ? `${t.name} +0x${(off % t.stride).toString(16)}` : t.name;
  }
  return "";
}

/** Whether a line of the script made the access (and not the build's own triggers, or a program's frame). */
export function isScriptOrigin(origin: string): boolean {
  return /^(.+:)?\d+:\d+$/.test(origin);
}

function lineOf(origin: string): number | null {
  const m = /(\d+):\d+$/.exec(origin);
  return m && isScriptOrigin(origin) ? Number(m[1]) : null;
}

/** The bytes of the dword at `address` that `mask` names. */
function bytesOf(address: number, mask: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 4; k++) if ((mask >>> (8 * k)) & 0xff) out.push(address + k);
  return out;
}

function covers(e: AllowEntry, byte: number): boolean {
  const off = byte - e.base;
  if (off < 0) return false;
  if (!e.stride) return off < e.width;
  return off % e.stride < e.width && Math.floor(off / e.stride) < (e.count ?? 1);
}

/** The entries by the 256-byte blocks they reach into, made once a list: the dump's entries cover most of the game. */
const BLOCK = 8;
const indexes = new WeakMap<Allowlist, Map<number, AllowEntry[]>>();
function indexOf(list: Allowlist): Map<number, AllowEntry[]> {
  let index = indexes.get(list);
  if (index) return index;
  index = new Map();
  for (const e of list.entries) {
    const end = e.base + (e.stride ? e.stride * ((e.count ?? 1) - 1) : 0) + e.width;
    for (let b = e.base >>> BLOCK; b <= (end - 1) >>> BLOCK; b++) {
      const at = index.get(b);
      if (at) at.push(e); else index.set(b, [e]);
    }
  }
  indexes.set(list, index);
  return index;
}

/** How grave a verdict is when a row is summed up from its bytes: one byte not known makes the row not known. */
const RANK: Record<Verdict, number> = { ends: 3, ignored: 2, unknown: 1, allowed: 0 };
/** Which of several entries over one byte decides: a failure seen beats a success, a success beats no word at all. */
const WEIGHT: Record<Verdict, number> = { ends: 3, ignored: 2, allowed: 1, unknown: 0 };

/**
 * What the allowlist says of one byte, for a read or a write, and the entry that says it. What was played in
 * Remastered decides first; the dump of its emulator decides where nothing played says more than "not known"; an
 * address neither covers takes the list's `outside`.
 */
export function verdictOf(list: Allowlist, byte: number, write: boolean): { verdict: Verdict; entry: AllowEntry | null } {
  let played: { verdict: Verdict; entry: AllowEntry | null } = { verdict: "unknown", entry: null };
  let dumped: { verdict: Verdict; entry: AllowEntry | null } = { verdict: "unknown", entry: null };
  for (const e of indexOf(list).get(byte >>> BLOCK) ?? []) {
    if (!covers(e, byte)) continue;
    const v = write ? e.write : e.read;
    const best = e.from === "dump" ? dumped : played;
    if (best.entry === null || WEIGHT[v] > WEIGHT[best.verdict]) { best.verdict = v; best.entry = e; }
  }
  if (played.entry && played.verdict !== "unknown") return played;
  if (dumped.entry) return dumped;
  if (played.entry) return played;
  return { verdict: list.outside?.verdict ?? "unknown", entry: null };
}

/**
 * Holds every row of a trace against the allowlist. The map's own memory is always allowed; the game's heap is
 * allowed to the build's own triggers (the trigger lists live there, reached through the game's pointers) and unknown to
 * a line of the script. Findings are grouped by origin, direction, verdict and the entry that decided them.
 */
export function checkTrace(trace: Trace, list: Allowlist): TraceCheck {
  const counted = { own: 0, heap: 0, allowed: 0, ends: 0, ignored: 0, unknown: 0 };
  const groups = new Map<string, Finding & { seen: Set<number> }>();
  for (const [origin, address, write, mask, times] of trace.rows) {
    if (address >= trace.strings.from && address < trace.strings.to) { counted.own++; continue; }
    if (trace.heap && address >= trace.heap.from && address < trace.heap.to) {
      if (!isScriptOrigin(origin)) { counted.heap++; continue; }
      add(origin, address, write === 1, "unknown", null, ["the game's heap, read or written by a line of the script"], times);
      continue;
    }
    let worst: { verdict: Verdict; entry: AllowEntry | null } = { verdict: "allowed", entry: null };
    for (const byte of bytesOf(address, mask)) {
      const v = verdictOf(list, byte, write === 1);
      if (RANK[v.verdict] > RANK[worst.verdict]) worst = v;
    }
    if (worst.verdict === "allowed") { counted.allowed++; continue; }
    const evidence = worst.entry ? [...worst.entry.evidence, ...(worst.entry.note ? [worst.entry.note] : [])] : worst.verdict === list.outside?.verdict ? list.outside.evidence : [];
    add(origin, address, write === 1, worst.verdict, worst.entry, evidence, times);
  }
  function add(origin: string, address: number, write: boolean, verdict: Verdict, entry: AllowEntry | null, evidence: string[], times: number) {
    counted[verdict as "ends" | "ignored" | "unknown"]++;
    const place = entry?.name ?? (placeOf(address) || null);
    const key = `${origin}|${write ? 1 : 0}|${verdict}|${place ?? address >>> 12}`;
    const g = groups.get(key);
    if (g) { g.times += times; if (!g.seen.has(address)) { g.seen.add(address); g.addresses++; } if (address < g.address) g.address = address; return; }
    groups.set(key, { origin, line: lineOf(origin), write, verdict: verdict as Finding["verdict"], address, addresses: 1, times, entry: place, evidence, seen: new Set([address]) });
  }
  const findings = [...groups.values()].map(({ seen: _seen, ...f }) => f)
    .sort((a, b) => RANK[b.verdict] - RANK[a.verdict] || (a.line ?? 1e9) - (b.line ?? 1e9) || a.address - b.address);
  return { findings, counted };
}

/** A finding as one line for a person: where, what, and what it rests on. */
export function describeFinding(f: Finding): string {
  const where = f.line !== null ? `line ${f.line}` : f.origin === "" ? "a trigger of the build's own" : f.origin.startsWith("fn:") ? `the build's ${f.origin.slice(3)}` : f.origin === "?" ? "the build's start" : f.origin;
  const what = `${f.write ? "writes" : "reads"} ${f.entry ?? "0x" + f.address.toString(16)}${f.addresses > 1 ? ` (${f.addresses} dwords from 0x${f.address.toString(16)})` : f.entry ? ` at 0x${f.address.toString(16)}` : ""}`;
  const verdict = f.verdict === "ends" ? "Remastered ends the game on this" : f.verdict === "ignored" ? "Remastered does nothing with this" : "not seen in Remastered: needs a probe";
  return `${where}: ${what} — ${verdict}${f.evidence.length ? ` (${f.evidence.join("; ")})` : ""}`;
}
