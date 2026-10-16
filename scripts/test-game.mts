/**
 * A script's tests run in the lifted game (TrigScript 4, A2), each beside its run in the simulator: the script built
 * as Save builds it (scripts/build-fixture.mts), started in a scm-sim checkout's lifted game with EUD let through
 * and nothing drawn, and every `test()` handed a `GameSim` over it (compiler/gameSim.ts) — the game put back to
 * frame 0 before each. The same tests then run in the simulator over the map's own world, and each is said twice.
 *
 *   npx tsx scripts/test-game.mts <script.ts> [map.scx]
 *
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { readLocations, readUnitStats, type GameHandle } from "../compiler/gameSim";
import { defaultScriptNames } from "../compiler/names";
import type { TestReport, TestWorld } from "../compiler/testing";
import { defaultLib } from "../bundle/lib.mjs";

const root = resolve(import.meta.dirname, "..");
const [script, baseMap] = process.argv.slice(2);
if (!script || !existsSync(script)) { console.error("usage: test-game.mts <script.ts> [map.scx]"); process.exit(2); }
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "src", "exact", "testGame.ts"))) { console.error(`no scm-sim checkout with src/exact/testGame.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);

const dir = mkdtempSync(join(tmpdir(), "trigscript-tests-"));
try {
  // The map, built as Save builds it.
  const built = join(dir, basename(script, ".ts") + ".scx");
  const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(script), built, ...(baseMap ? [resolve(baseMap)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
  if (b.status !== 0) { console.error(b.stdout.split("\n").slice(-20).join("\n"), b.stderr); process.exit(1); }

  // The game, at frame 0, EUD let through.
  const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
  const { exactMissing, startExactGame } = await from("src/exact/node.ts");
  const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
  const { testGame } = await from("src/exact/testGame.ts");
  const missing = exactMissing() as string[];
  if (missing.length) { console.error("the lifted game cannot run here; missing:\n  " + missing.join("\n  ")); process.exit(1); }
  const chk = Archive.open(new Uint8Array(readFileSync(built))).readFile("staredit\\scenario.chk") as Uint8Array;
  const classic = classicScenario(chk);
  const chkPath = join(dir, "scenario.chk");
  writeFileSync(chkPath, classic);
  const run = await startExactGame(chkPath, { game: "ums" });
  const strings = placeStrings(run.lifted, chk);
  installEud(run.lifted, strings);
  // (eudplib's payload lies outside what the game's snapshot covers: the handle keeps it itself.)
  const handle = testGame(run.engine, run.lifted, [{ from: strings.gameTable, to: 0x191943c8 + strings.bytes }]) as GameHandle;

  // The tests in the simulator over the map's own world, as the editor runs them; then in the game, the way a host
  // of the game runs them: the compile's JavaScript handed to dist/gametest.js, loaded from its text.
  const source = { "main.ts": readFileSync(script, "utf8") };
  const names = defaultScriptNames();
  // (The locations from the game once eudplib has put them right: in the built map they are scrambled.)
  const locations = readLocations(handle);
  const world = await mapWorld(classic, locations, readUnitStats(handle));
  const compiled = compileScript(ts, source, names, { lib: defaultLib(), tests: { world } });
  const simulated = compiled.tests;
  if (!compiled.modules) { console.error(compiled.ok ? "the script has no tests" : compiled.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n")); process.exit(1); }
  const bundle = join(dir, "gametest.js");
  spawnSync("npx", ["esbuild", join(root, "compiler", "gameTestEntry.ts"), "--bundle", "--format=esm", "--target=es2022", "--platform=neutral", `--outfile=${bundle}`], { cwd: root });
  const host = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(bundle)).toString("base64")}`) as typeof import("../compiler/gameTestEntry");
  const inGame = host.runGameTests(handle, { modules: compiled.modules, names, locations }) as TestReport & { error?: string };
  if (inGame.error) { console.error(`the script did not run beside the game: ${inGame.error}`); process.exit(1); }
  const bySim = new Map((simulated?.results ?? []).map((r) => [r.id, r]));
  let failed = 0;
  for (const r of inGame.results) {
    const s = bySim.get(r.id);
    const mark = (st: string | undefined) => (st === "passed" ? "✓" : st === "failed" ? "✗" : st === "skipped" ? "–" : "?");
    if (r.status === "failed") failed++;
    console.log(`${mark(r.status)} game  ${mark(s?.status)} simulator  ${r.id.replace(/^.*?::/, "")}  (${r.frames} frames, ${r.ms} ms)`);
    if (r.status === "failed") console.log(`    in the game: ${r.message}${r.at ? ` — line ${r.at.line}` : ""}${r.actual !== undefined ? `\n      got ${r.actual}` : ""}`);
    if (s?.status === "failed") console.log(`    in the simulator: ${s.message}${s.at ? ` — line ${s.at.line}` : ""}${s.actual !== undefined ? `\n      got ${s.actual}` : ""}`);
    if (s && s.status !== r.status) console.log("    the two disagree: one of them is wrong");
  }
  console.log(`\n${inGame.results.length} tests in the game: ${inGame.results.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** The world the editor would hand the simulator for this map: its units, the locations and stats read from the game, P1 a person, P2 a computer. */
async function mapWorld(chk: Uint8Array, locations: TestWorld["locations"], unitStats: TestWorld["unitStats"]): Promise<TestWorld> {
  const EDITOR = resolve(process.env.SCMJS_DIR ?? join(root, "..", "scm-js"));
  const { parseScenario } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
  const scn = parseScenario(chk);
  const units = (scn.units ?? []).filter((u: { unitId: number }) => u.unitId !== 214).map((u: { unitId: number; owner: number; x: number; y: number }) => ({ type: u.unitId, owner: u.owner, x: u.x, y: u.y }));
  return { units, locations, unitStats, players: [0, 1], forces: { 0: 0, 1: 1 }, computers: [1] };
}
