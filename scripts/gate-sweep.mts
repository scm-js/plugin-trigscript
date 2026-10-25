/**
 * Every probe and showpiece built and played in the lifted game (TrigScript 4, step 16's sweep; until step 17 it built
 * each through eudplib too and held the two builds' lines against each other). For each script under probes/: the
 * build command its header gives (the base map among its arguments), the build played with nobody at it for N frames
 * by scm-sim's lifted game (scripts/exact-eud.ts), its lines of text; a game-*.ts probe runs its tests in the game
 * instead (scripts/test-game.mts). The result is a table, Markdown, for the plan.
 *
 *   npx tsx scripts/gate-sweep.mts [--frames=300] [--only=name,name] [--out=file.md]
 *
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated. A probe whose base
 * map or library is not on disk is said so.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => { const f = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return f === undefined ? undefined : f.includes("=") ? f.slice(f.indexOf("=") + 1) : ""; };
const frames = Number(flag("frames") ?? 300);
const only = flag("only")?.split(",").filter(Boolean);
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "scripts", "exact-eud.ts"))) { console.error(`no scm-sim checkout with scripts/exact-eud.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }

interface Row { probe: string; own: string; lines: string; note: string }
const rows: Row[] = [];
const dir = mkdtempSync(join(tmpdir(), "trigscript-gate-"));

/** The lines the lifted game printed, as `frame:text` from the first line's frame, and how the run ended. */
function play(map: string): { lines: string[]; ended: string; error?: string } {
  const run = spawnSync("node", ["--experimental-strip-types", join(sim, "scripts", "exact-eud.ts"), map, `--frames=${frames}`], { cwd: sim, encoding: "utf8", maxBuffer: 256 << 20 });
  if (run.status !== 0) {
    const limit = /past what STR can name/.test(run.stderr);
    return { lines: [], ended: "", error: limit ? "strings past 64 KB (1.16.1)" : (run.stderr.split("\n").find((l) => /Error/.test(l)) ?? "the lifted game failed").slice(0, 100) };
  }
  const said = run.stdout.split("\n").map((l) => /^\s*(\d+)  ([^\n]*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ frame: Number(m[1]), text: m[2].replace(/\r/g, "") }));
  const first = said[0]?.frame ?? 0;
  const ended = /ended: (.*)$/m.exec(run.stdout)?.[1] ?? "";
  return { lines: said.map((s) => `${s.frame - first}:${s.text}`), ended };
}

const probes = readdirSync(join(root, "probes")).filter((f) => /\.tsx?$/.test(f) && (!only || only.includes(f.replace(/\.tsx?$/, "")))).sort();
for (const file of probes) {
  const name = file.replace(/\.tsx?$/, "");
  const source = readFileSync(join(root, "probes", file), "utf8");
  const head = source.split("\n").slice(0, 40).join("\n");
  const t0 = Date.now();
  // A game-*.ts probe: its tests in the game, on the own build.
  if (/^game-/.test(name) || /test-game\.mts probes/.test(head)) {
    const cmd = /npx tsx scripts\/test-game\.mts probes\/\S+( \S+\.scx)?/.exec(head);
    const base = cmd?.[1]?.trim();
    if (base && !existsSync(join(root, base))) { rows.push({ probe: name, own: "—", lines: "—", note: `needs ${base}` }); continue; }
    if (/debug-game\.mts/.test(head)) { rows.push({ probe: name, own: "—", lines: "—", note: "debug-game: run by hand" }); continue; }
    const r = spawnSync("npx", ["tsx", join(root, "scripts", "test-game.mts"), join(root, "probes", file), ...(base ? [join(root, base)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, SCM_SIM_DIR: sim } });
    const out = r.stdout + r.stderr;
    const game = /in the game[^\n]*?(\d+) of (\d+)|(\d+) of (\d+) in the game/.exec(out);
    const passed = out.match(/(\d+) passed/g)?.join(", ") ?? "";
    rows.push({ probe: name, own: r.status === 0 ? "ok" : "FAILED", lines: game ? `${game[1] ?? game[3]} of ${game[2] ?? game[4]} in the game` : passed || out.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 80) || "", note: `${((Date.now() - t0) / 1000).toFixed(0)} s` });
    console.log(`${name}: ${rows.at(-1)!.own} ${rows.at(-1)!.lines}`);
    continue;
  }
  // A played probe: built and played.
  const cmd = /build-fixture(?:\.mts)? probes\/\S+ \S+(?: (\S+\.scx))?/.exec(head);
  const base = cmd?.[1];
  const needs = /probes\/lib\/[\w-]+\.mts/.exec(head)?.[0];
  if (base && !existsSync(join(root, base))) { rows.push({ probe: name, own: "—", lines: "—", note: `needs ${base}${needs ? ` (${needs})` : ""}` }); console.log(`${name}: needs ${base}`); continue; }
  // (A header's own environment is not passed: the sweep holds the script as it is.)
  const build = (): { map: string; error?: string } => {
    const map = join(dir, `${name}.scx`);
    const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), join(root, "probes", file), map, ...(base ? [join(root, base)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, MAP_NAME: name } });
    if (b.status !== 0) {
      const text = b.stdout + b.stderr;
      const refused = /refus\w+[: ]+(.*)/i.exec(text)?.[1] ?? text.split("\n").filter((l) => /error|Error|refus/i.test(l)).slice(-1)[0] ?? text.split("\n").filter(Boolean).slice(-1)[0];
      return { map, error: (refused ?? "build failed").slice(0, 110) };
    }
    return { map };
  };
  const own = build();
  const row: Row = { probe: name, own: own.error ? `REFUSED: ${own.error}` : "built", lines: "", note: "" };
  if (!own.error) {
    const p = play(own.map);
    row.own = p.error ? `built; ${p.error}` : `${p.lines.length} lines${p.ended && !/frame limit/.test(p.ended) ? `; ${p.ended}` : ""}`;
    row.lines = p.lines.slice(0, 3).map((l) => JSON.stringify(l)).join(" ");
  }
  row.note = `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  rows.push(row);
  console.log(`${name}: ${row.own} | ${row.lines}`);
}
rmSync(dir, { recursive: true, force: true });

const table = ["| Probe | Built, played | First lines | Note |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.probe} | ${r.own} | ${r.lines} | ${r.note} |`)].join("\n");
const out = flag("out");
if (out) writeFileSync(out, table + "\n");
console.log("\n" + table);
