/**
 * Whole programs made at random, run every way there is (TrigScript 4, step 16: the gate before the Python goes).
 * Without the game, each seed is run as JavaScript, in the simulator and as the built map of our own walked from
 * its bytes (`tests/randomRun.ts`, what CI runs). With `--game`, the seeds are built our way, several to a map, and
 * played in the lifted game, their lines held against the simulator's frame by frame; with `--eudplib` too, the
 * same scripts are built through eudplib and played, the last use of the second build.
 *
 *   npx tsx scripts/random-scripts.mts [--seeds=1..200] [--programs=3] [--frames=12] [--game [--eudplib] [--batch=8]]
 *   npx tsx scripts/random-scripts.mts --show=SEED            the script as TrigScript
 *   npx tsx scripts/random-scripts.mts --reduce=SEED          the smallest script that still fails the same way
 *
 * The game needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated; eudplib a
 * plugin-eudplib checkout (or EUDPLIB_DIR). The maps are built on fixtures/maps/(2)Binary Burghs.scx, as the probes are.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomScript, reduce, renderScript, type Generated } from "../tests/randomScript";
import { checkRandom, compileRandom, diff, simLines } from "../tests/randomRun";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => { const f = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return f === undefined ? undefined : f.includes("=") ? f.slice(f.indexOf("=") + 1) : ""; };
const programs = Number(flag("programs") ?? 3), frames = Number(flag("frames") ?? 12);
const make = (seed: number) => randomScript(seed, programs, frames);

if (flag("show") !== undefined) {
  process.stdout.write(renderScript(make(Number(flag("show")))));
  process.exit(0);
}

if (flag("reduce") !== undefined) {
  const seed = Number(flag("reduce"));
  const g = make(seed);
  const first = checkRandom(g);
  if (!first.problem) { console.log(`seed ${seed} passes`); process.exit(0); }
  console.log(`seed ${seed} fails (${first.kind}): ${first.problem}\n\ncutting down…`);
  let tries = 0;
  // (The same failure: its kind, and for a compile error or a refusal the message's words — not another error the
  // cutting down brought in, a counter cut from the loop that read it, say.)
  const words = (o: { kind?: string; problem?: string }) => (o.kind === "compile" || o.kind === "refused" ? (o.problem ?? "").replace(/main\.ts:\d+:\d+ |line \d+|\d+/g, "").split("\n")[0] : "");
  const small = reduce(g, (t) => { tries++; const o = checkRandom(t); return o.kind === first.kind && words(o) === words(first); });
  const last = checkRandom(small);
  console.log(`\n${tries} tries; the smallest (${last.kind}): ${last.problem}\n`);
  process.stdout.write(renderScript(small));
  process.exit(1);
}

const [from, to] = (flag("seeds") ?? "1..50").split("..").map(Number);
const seeds = Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);

// ── without the game ──
const failed: number[] = [];
let lines = 0;
const kinds: Record<string, number> = {};
const t0 = Date.now();
for (const seed of seeds) {
  const o = checkRandom(make(seed));
  lines += o.lines;
  if (o.problem) { failed.push(seed); kinds[o.kind!] = (kinds[o.kind!] ?? 0) + 1; console.log(`seed ${seed} (${o.kind}): ${o.problem}`); }
}
console.log(`${seeds.length} seeds × ${programs} programs, ${lines} lines compared as JavaScript, in the simulator and from the map's bytes: ${failed.length ? `${failed.length} failed (${JSON.stringify(kinds)}: seeds ${failed.join(", ")})` : "all agree"}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);

if (flag("game") === undefined) process.exit(failed.length ? 1 : 0);

// ── in the lifted game ──
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "scripts", "exact-eud.ts"))) { console.error(`no scm-sim checkout with scripts/exact-eud.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
// (The lifted game is 1.16.1, whose string table names only its first 64 KB: a few programs to a map.)
const batch = Number(flag("batch") ?? 3);
const eudplib = flag("eudplib") !== undefined;
const dir = mkdtempSync(join(tmpdir(), "trigscript-random-"));
const gameFailed: string[] = [];
let gameLines = 0, eudLines = 0;

/**
 * What the lifted game reports of the simulator's lines: it reads the game's ring of thirteen text lines once a frame
 * (scm-sim's `readText`), so of a frame that printed more only the last thirteen are seen, and a slot whose text is the
 * same as when it was last read, and that the ring's pointer did not pass this frame, is not seen again. Modelled here
 * on the simulator's lines, frame by frame, so that the two can be compared line for line.
 */
function throughTheRing(lines: string[]): string[] {
  const RING = 13;
  const slots = Array.from({ length: RING }, () => ""), reported = Array.from({ length: RING }, () => "");
  let at = 0, ringAt = 0;
  const out: string[] = [];
  const byFrame = new Map<number, string[]>();
  for (const l of lines) { const i = l.indexOf(":"); const f = Number(l.slice(0, i)); byFrame.set(f, [...(byFrame.get(f) ?? []), l.slice(i + 1)]); }
  const last = Math.max(-1, ...byFrame.keys());
  for (let f = 0; f <= last; f++) {
    // (A slot holds 218 bytes with its end: a longer line is cut there.)
    for (const text of byFrame.get(f) ?? []) { slots[at] = new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, 217)).replace(/\uFFFD$/, ""); at = (at + 1) % RING; }
    const oldest = at, moved = (oldest - ringAt + RING) % RING;
    ringAt = oldest;
    for (let k = 0; k < RING; k++) {
      const i = (oldest + k) % RING, text = slots[i];
      if (text === reported[i] && k < RING - moved) continue;
      reported[i] = text;
      if (text) out.push(`${f}:${text}`);
    }
  }
  return out;
}

/** Whether `got` is `want` with lines left out: each line of `got` found in `want` after the one before. The first that is not, else null. */
function inOrder(want: string[], got: string[]): string | null {
  let k = 0, last = "";
  for (const line of got) {
    // (The game wraps a long line where a word ends: the first part starts the simulator's line, the rest is in it.)
    const i = want.findIndex((w, j) => j >= k && (w === line || w.startsWith(line.trimEnd())));
    if (i < 0) {
      if (last.includes(line.slice(line.indexOf(":") + 1).trim())) continue;
      return `${JSON.stringify(line)} is not among the simulator's lines from ${JSON.stringify(want[k] ?? "")} on (${got.length} lines in the game, ${want.length} in the simulator)`;
    }
    last = want[i];
    k = i + 1;
  }
  return null;
}

/** The lifted game's lines as `cycle:text`: a program first runs on the game's frame 2, the simulator's cycle 0. */
function played(map: string): string[] | string {
  const run = spawnSync("node", ["--experimental-strip-types", join(sim, "scripts", "exact-eud.ts"), map, `--frames=${frames + 8}`], { cwd: sim, encoding: "utf8", maxBuffer: 256 << 20 });
  if (run.status !== 0) {
    const limit = /past what STR can name/.test(run.stderr);
    return limit ? "the map's strings run past the 64 KB the lifted game (1.16.1) can name: fewer programs to a map (--batch)" : `the lifted game failed: ${run.stderr.split("\n").filter((l) => /Error|error/.test(l)).slice(0, 3).join(" | ") || run.stderr.split("\n").slice(-3).join(" | ")}`;
  }
  const said = run.stdout.split("\n").map((l) => /^\s*(\d+)  ([^\n]*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ frame: Number(m[1]), text: m[2].replace(/\r/g, "") }));
  if (!said.length) return "the lifted game printed nothing";
  const offset = 2;
  return said.filter((s) => s.frame - offset < frames).map((s) => `${s.frame - offset}:${s.text}`);
}

try {
  for (let i = 0; i < seeds.length; i += batch) {
    const group = seeds.slice(i, i + batch).filter((s) => !failed.includes(s));
    if (!group.length) continue;
    // One script of the group's programs: each program's lines carry its seed.
    const g: Generated = { seed: group[0], frames, programs: group.flatMap((s) => make(s).programs) };
    const r = compileRandom(g);
    if (r.diagnostics.length) { gameFailed.push(`seeds ${group.join(",")}: ${r.diagnostics[0].message}`); continue; }
    const want = throughTheRing(simLines(r, frames).lines);
    const seen: Partial<Record<"own" | "eudplib", string[]>> = {};
    const src = join(dir, `random-${group[0]}.ts`);
    writeFileSync(src, renderScript(g));
    for (const way of eudplib ? ["own", "eudplib"] : ["own"]) {
      const map = join(dir, `random-${group[0]}-${way}.scx`);
      const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), src, map], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, ...(way === "eudplib" ? { EUDPLIB: "1" } : {}), MAP_NAME: `random ${group[0]}` } });
      if (b.status !== 0) { gameFailed.push(`seeds ${group.join(",")} (${way} build): ${(b.stdout + b.stderr).split("\n").filter(Boolean).slice(-3).join(" | ")}`); continue; }
      const got = played(map);
      if (typeof got === "string") { gameFailed.push(`seeds ${group.join(",")} (${way}): ${got}`); continue; }
      if (way === "own") gameLines += got.length; else eudLines += got.length;
      // The game's lines are a part of the simulator's: every one of them among the simulator's lines of its frame, in
      // the simulator's order (the game's ring loses lines of a crowded frame, `throughTheRing` models most of it but
      // not the game's own writes to the ring); and the two builds' lines are the same, line for line.
      const missing = inOrder(want, got);
      seen[way] = got;
      if (missing) gameFailed.push(`seeds ${group.join(",")} (${way} in the lifted game, against the simulator): ${missing}`);
      else console.log(`seeds ${group[0]}–${group.at(-1)} ${way}: ${got.length} lines, every one the simulator's, in its order (${want.length} in the simulator)`);
      if (way === "eudplib" && seen.own && seen.own.join("\n") !== got.join("\n")) gameFailed.push(`seeds ${group.join(",")}: the own build and eudplib's print differently in the lifted game: ${diff(seen.own, got)}`);
    }
  }
} finally {
  if (gameFailed.length) console.log(`(the maps are kept in ${dir})`); else rmSync(dir, { recursive: true, force: true });
}
for (const f of gameFailed) console.log(f);
console.log(`in the lifted game: ${gameLines} lines of maps of our own${eudplib ? ` and ${eudLines} of eudplib's` : ""} against the simulator: ${gameFailed.length ? `${gameFailed.length} groups failed` : "all agree"}`);
process.exit(failed.length + gameFailed.length ? 1 : 0);
