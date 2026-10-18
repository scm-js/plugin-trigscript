/**
 * Writes data/allowlist.json: what Remastered is known to allow, each entry with what it rests on (see
 * compiler/allowlist.ts). Four sources, in this order:
 *
 * 1. Magenta's catalogue (plugin-magenta's src/catalogue/eud.json): every entry with its address, its Remastered
 *    read/write and whether a probe verified it. A verified yes is allowed; anything else is not known.
 * 2. Failures seen in the game, written out below with the probe that showed each.
 * 3. The traces of TrigScript's probes run in the lifted game (scm-sim's `scripts/exact-eud.ts --trace`): every
 *    probe here was played in Remastered with every line as expected, so whatever its build reads or writes was
 *    allowed there. A trace is made from today's build of the probe, not the build that was played; the families of
 *    addresses are the same, and a probe played again is what makes a new one certain.
 * 4. data/remastered.json: Remastered's own EUD emulator, run on a dump of the running game (2026-10-16): every
 *    region it emulates and what it does with each dword read and written, and that anything outside its regions
 *    ends the game. Facts about addresses only. Entries from it carry `from: "dump"`; what was played (1–3) wins
 *    over the same byte.
 *
 *   npx tsx scripts/allowlist.mts <dir of <probe>.trace.json> [--magenta=<eud.json>] [--remastered=<json>] [--out=<path>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AllowEntry, Allowlist, Trace, Verdict } from "../compiler/allowlist";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const traceDir = args.find((a) => !a.startsWith("--"));
const magentaPath = args.find((a) => a.startsWith("--magenta="))?.slice(10) ?? join(root, "..", "plugin-magenta", "src", "catalogue", "eud.json");
if (!traceDir || !existsSync(traceDir)) { console.error("usage: allowlist.mts <dir of <probe>.trace.json> [--magenta=<eud.json>]"); process.exit(2); }

/** When each probe was played in Remastered with every line as expected (docs/eud-plan.md's slices). */
const PLAYED: Record<string, string> = {
  spike: "2026-09-18", v3: "2026-09-18", reads: "2026-09-18", units: "2026-09-18", input: "2026-09-18", numbers: "2026-09-18",
  arrays: "2026-09-19", functions: "2026-09-19", recursion: "2026-09-19", callbacks: "2026-09-19", inside: "2026-09-19",
  strings: "2026-09-19", classes: "2026-09-19", map: "2026-09-19", leftovers: "2026-09-19",
};
/** 1.16.1's unit table: 1700 rows of 336 bytes. A probe's reads of it become one entry per field, not one per unit. */
const UNITS = { base: 0x59cca8, stride: 336, count: 1700 };
const ROWS = { stride: UNITS.stride, count: UNITS.count };

const entries: AllowEntry[] = [];

// 1. Magenta's catalogue.
interface MagentaEntry {
  id: string; name: string; width: number | "bit"; verified?: boolean; local?: boolean;
  address?: { base: string; terms?: { arg: string; stride: number }[] };
  args?: { name: string; max?: number }[];
  remastered?: { read?: boolean; write?: boolean };
}
const magenta = JSON.parse(readFileSync(magentaPath, "utf8")) as { entries: MagentaEntry[] };
for (const e of magenta.entries) {
  if (!e.address?.base) continue;
  const base = Number(e.address.base), terms = e.address.terms ?? [];
  const width = e.width === "bit" ? 4 : e.width;
  const max = (arg: string) => e.args?.find((a) => a.name === arg)?.max ?? 1;
  const verdict = (yes: boolean | undefined): Verdict => (yes && e.verified ? "allowed" : "unknown");
  const evidence = [`Magenta ${e.id}${e.verified ? ", verified by its probes" : ", not verified"}`];
  const shape = terms.length === 1
    ? { stride: terms[0].stride, count: max(terms[0].arg) }
    : terms.length > 1 ? { width: terms.reduce((n, t) => n + t.stride * (max(t.arg) - 1), 0) + width } : {};
  entries.push({ name: e.name.toLowerCase(), base, width, ...shape, read: verdict(e.remastered?.read), write: verdict(e.remastered?.write), evidence, ...(e.local ? { local: true } : {}) });
}

// 2. What the game was seen to refuse or ignore (Magenta's docs/candidates.md).
entries.push(
  { name: "unit table: position", base: 0x59ccd0, ...ROWS, width: 4, read: "allowed", write: "ignored", evidence: ["the dump probe, steps A and B (2026-10-16): a unit's X and Y written, the game went on and nothing was seen to move", "Magenta probe 6, key I (2026-09-14) ended the game writing the unit's position and its sprite's together; the dump probe wrote each alone and neither did"] },
  { name: "sprite table: position", base: 0x629d98 + 0x14, stride: 36, count: 2500, width: 4, read: "allowed", write: "ignored", evidence: ["the dump probe, step C (2026-10-16): a sprite's X and Y written, the game went on and nothing on the screen changed"] },
  { name: "unit table: +0x74", base: 0x59cd1c, ...ROWS, width: 4, read: "ends", write: "ends", evidence: ["the dump probe, step D (2026-10-16): read, the game ended \"EUD ERROR: 0xFFA632E3\" (the address, bits flipped), as the dump said"] },
  { name: "unit table: cloak flags", base: 0x59cd85, ...ROWS, width: 1, read: "allowed", write: "ignored", evidence: ["Magenta probe 6, keys Y and H (2026-09-14): status flags 0x100 and 0x200 written, no visible cloak"] },
  { name: "game speed", base: 0x6cdfd4, width: 4, read: "allowed", write: "ignored", evidence: ["Magenta probe 5, key 9 (2026-09-14): written, the game kept its speed"] },
);

// 3. The probes' traces.
/** byte address (or unit-table field) → what was seen there */
const seen = new Map<string, { base: number; width: number; units: boolean; read: Set<string>; write: Set<string> }>();
let probes = 0;
for (const file of readdirSync(traceDir).filter((f) => f.endsWith(".trace.json")).sort()) {
  const probe = basename(file, ".trace.json");
  if (!PLAYED[probe]) { console.warn(`${file}: no play recorded for a probe called ${probe}; left out`); continue; }
  probes++;
  const trace = JSON.parse(readFileSync(join(traceDir, file), "utf8")) as Trace;
  for (const [, address, write, mask] of trace.rows) {
    if (address >= trace.strings.from && address < trace.strings.to) continue;
    if (trace.heap && address >= trace.heap.from && address < trace.heap.to) continue;
    for (let k = 0; k < 4; k++) {
      if (!((mask >>> (8 * k)) & 0xff)) continue;
      const byte = address + k, off = byte - UNITS.base;
      const units = off >= 0 && off < UNITS.stride * UNITS.count;
      const at = units ? UNITS.base + (off % UNITS.stride) : byte;
      const key = `${units ? "u" : "b"}${at}`;
      const s = seen.get(key) ?? { base: at, width: 1, units, read: new Set<string>(), write: new Set<string>() };
      (write ? s.write : s.read).add(probe);
      seen.set(key, s);
    }
  }
}
// Runs of neighbouring bytes seen by the same probes the same way become one entry.
const bytes = [...seen.values()].sort((a, b) => Number(a.units) - Number(b.units) || a.base - b.base);
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const runs: typeof bytes = [];
for (const b of bytes) {
  const last = runs[runs.length - 1];
  if (last && last.units === b.units && last.base + last.width === b.base && same(last.read, b.read) && same(last.write, b.write)) last.width++;
  else runs.push({ ...b });
}
const named = (set: Set<string>) => [...set].sort().map((p) => `${p} (${PLAYED[p]})`);
for (const r of runs) {
  const evidence = [...new Set([...named(r.read), ...named(r.write)])];
  entries.push({
    name: r.units ? `unit table: +0x${(r.base - UNITS.base).toString(16)}` : `0x${r.base.toString(16)}`,
    base: r.base, width: r.width, ...(r.units ? { stride: UNITS.stride, count: UNITS.count } : {}),
    read: r.read.size ? "allowed" : "unknown", write: r.write.size ? "allowed" : "unknown",
    evidence: [`touched by the probes ${evidence.join(", ")}, each played in Remastered with every line as expected`],
  });
}

// 4. The dump of Remastered's emulator.
const remasteredPath = args.find((a) => a.startsWith("--remastered="))?.slice(13) ?? join(root, "data", "remastered.json");
let outside: Allowlist["outside"];
let dumped = 0;
if (existsSync(remasteredPath)) {
  const r = JSON.parse(readFileSync(remasteredPath, "utf8")) as {
    build: string; source: string; outside: Verdict;
    entries: { name: string; base: number; width: number; stride?: number; count?: number; read: Verdict; write: Verdict; note?: string }[];
  };
  const evidence = [`Remastered ${r.build}'s own EUD emulator, run on a dump of the game (2026-10-16)`];
  for (const e of r.entries) {
    entries.push({ ...e, evidence, from: "dump" });
    dumped++;
  }
  outside = { verdict: r.outside, evidence: [`no region of Remastered ${r.build}'s EUD emulator covers it (a dump of the game, 2026-10-16); the game ends with "EUD ERROR" and the address with its bits flipped`] };
}

const list: Allowlist = { version: 1, entries, ...(outside ? { outside } : {}) };
const out = args.find((a) => a.startsWith("--out="))?.slice(6) ?? join(root, "data", "allowlist.json");
writeFileSync(out, JSON.stringify(list, null, 1) + "\n");
console.log(`${out}: ${entries.length} entries — ${magenta.entries.length} from Magenta's catalogue, 6 seen in the game, ${runs.length} runs from ${probes} probes' traces, ${dumped} from the dump of Remastered's emulator`);
