/**
 * Every probe and showpiece built our way and played in the lifted game, beside its eudplib build (TrigScript 4, step
 * 16: the gate before the Python goes — the last time the two builds are held against each other). For each script
 * under probes/: the build command its header gives (the base map among its arguments), the own build and the eudplib
 * build, each played with nobody at it for N frames by scm-sim's lifted game (scripts/exact-eud.ts), the lines of text
 * compared frame by frame; a game-*.ts probe runs its tests in the game instead (scripts/test-game.mts). The result
 * is a table, Markdown, for the plan.
 *
 *   npx tsx scripts/gate-sweep.mts [--frames=300] [--only=name,name] [--no-eudplib] [--out=file.md]
 *
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated, and for the eudplib
 * builds a plugin-eudplib checkout (or EUDPLIB_DIR). A probe whose base map or library is not on disk is said so.
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
const withEudplib = flag("no-eudplib") === undefined;
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "scripts", "exact-eud.ts"))) { console.error(`no scm-sim checkout with scripts/exact-eud.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
const eudplibDir = resolve(process.env.EUDPLIB_DIR ?? join(root, "..", "plugin-eudplib"));
const haveEudplib = withEudplib && existsSync(join(eudplibDir, "scripts", "build-map.mts"));

interface Row { probe: string; own: string; eudplib: string; lines: string; note: string }
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
    if (base && !existsSync(join(root, base))) { rows.push({ probe: name, own: "—", eudplib: "—", lines: "—", note: `needs ${base}` }); continue; }
    if (/debug-game\.mts/.test(head)) { rows.push({ probe: name, own: "—", eudplib: "—", lines: "—", note: "debug-game: run by hand" }); continue; }
    const r = spawnSync("npx", ["tsx", join(root, "scripts", "test-game.mts"), join(root, "probes", file), ...(base ? [join(root, base)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, SCM_SIM_DIR: sim } });
    const out = r.stdout + r.stderr;
    const game = /in the game[^\n]*?(\d+) of (\d+)|(\d+) of (\d+) in the game/.exec(out);
    const passed = out.match(/(\d+) passed/g)?.join(", ") ?? "";
    rows.push({ probe: name, own: r.status === 0 ? "ok" : "FAILED", eudplib: "—", lines: game ? `${game[1] ?? game[3]} of ${game[2] ?? game[4]} in the game` : passed || out.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 80) || "", note: `${((Date.now() - t0) / 1000).toFixed(0)} s` });
    console.log(`${name}: ${rows.at(-1)!.own} ${rows.at(-1)!.lines}`);
    continue;
  }
  // A played probe: build both ways and play both.
  const cmd = /build-fixture(?:\.mts)? probes\/\S+ \S+(?: (\S+\.scx))?/.exec(head);
  const base = cmd?.[1];
  const needs = /probes\/lib\/[\w-]+\.mts/.exec(head)?.[0];
  if (base && !existsSync(join(root, base))) { rows.push({ probe: name, own: "—", eudplib: "—", lines: "—", note: `needs ${base}${needs ? ` (${needs})` : ""}` }); console.log(`${name}: needs ${base}`); continue; }
  // (A header's own environment — EXTRA_PLUGIN=…, a Python plugin of eudplib's for a measurement — is not passed: it is
  // the eudplib build's alone, and the gate holds the script, not the plugin.)
  const build = (way: "own" | "eudplib"): { map: string; error?: string } => {
    const map = join(dir, `${name}-${way}.scx`);
    const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), join(root, "probes", file), map, ...(base ? [join(root, base)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, ...(way === "eudplib" ? { EUDPLIB: "1" } : {}), MAP_NAME: `${name} ${way}` } });
    if (b.status !== 0) {
      const text = b.stdout + b.stderr;
      const refused = /refus\w+[: ]+(.*)/i.exec(text)?.[1] ?? text.split("\n").filter((l) => /error|Error|refus/i.test(l)).slice(-1)[0] ?? text.split("\n").filter(Boolean).slice(-1)[0];
      return { map, error: (refused ?? "build failed").slice(0, 110) };
    }
    return { map };
  };
  const own = build("own");
  const row: Row = { probe: name, own: own.error ? `REFUSED: ${own.error}` : "built", eudplib: haveEudplib ? "" : "—", lines: "", note: "" };
  let ownPlay: ReturnType<typeof play> | undefined;
  if (!own.error) {
    ownPlay = play(own.map);
    row.own = ownPlay.error ? `built; ${ownPlay.error}` : `${ownPlay.lines.length} lines${ownPlay.ended && !/frame limit/.test(ownPlay.ended) ? `; ${ownPlay.ended}` : ""}`;
  }
  if (haveEudplib) {
    const e = build("eudplib");
    if (e.error) row.eudplib = `build failed: ${e.error}`;
    else {
      const p = play(e.map);
      row.eudplib = p.error ? `built; ${p.error}` : `${p.lines.length} lines${p.ended && !/frame limit/.test(p.ended) ? `; ${p.ended}` : ""}`;
      if (ownPlay && !ownPlay.error && !p.error) {
        const same = ownPlay.lines.join("\n") === p.lines.join("\n");
        const prefix = (a: string[], b: string[]) => a.length < b.length && a.every((l, k) => l === b[k]);
        if (same) row.lines = "the same";
        else if (prefix(p.lines, ownPlay.lines)) row.lines = `the same as far as eudplib's go (${ownPlay.lines.length - p.lines.length} more of ours in the frames)`;
        else if (prefix(ownPlay.lines, p.lines)) row.lines = `the same as far as ours go (${p.lines.length - ownPlay.lines.length} more of eudplib's in the frames)`;
        else {
          const i = ownPlay.lines.findIndex((l, k) => l !== p.lines[k]);
          row.lines = `differ at ${i}: own ${JSON.stringify(ownPlay.lines[i] ?? "")} / eudplib ${JSON.stringify(p.lines[i] ?? "")}`.slice(0, 160);
        }
      }
    }
  }
  row.note = `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  rows.push(row);
  console.log(`${name}: own ${row.own} | eudplib ${row.eudplib} | ${row.lines}`);
}
rmSync(dir, { recursive: true, force: true });

const table = ["| Probe | Own build, played | eudplib build, played | Lines | Note |", "| --- | --- | --- | --- | --- |", ...rows.map((r) => `| ${r.probe} | ${r.own} | ${r.eudplib} | ${r.lines} | ${r.note} |`)].join("\n");
const out = flag("out");
if (out) writeFileSync(out, table + "\n");
console.log("\n" + table);
