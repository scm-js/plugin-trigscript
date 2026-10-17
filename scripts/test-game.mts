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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { readLocations, readUnitStats, type GameHandle } from "../compiler/gameSim";
import { mergeCopies } from "../compiler/gameCopies";
import { defaultScriptNames } from "../compiler/names";
import type { TestReport, TestWorld } from "../compiler/testing";
import { defaultLib } from "../bundle/lib.mjs";
import { scriptFiles } from "./script-files.mts";

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
  const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(script), built, ...(baseMap ? [resolve(baseMap)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, VARIABLE_MAP: "1", TRIGGER_MAP: "1" } });
  if (b.status !== 0) { console.error(b.stdout.split("\n").slice(-20).join("\n"), b.stderr); process.exit(1); }

  // The game, at frame 0, EUD let through.
  const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
  const { exactMissing, startExactGame } = await from("src/exact/node.ts");
  const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
  const { testGame } = await from("src/exact/testGame.ts");
  const { installCost } = await from("src/exact/cost.ts");
  const missing = exactMissing() as string[];
  if (missing.length) { console.error("the lifted game cannot run here; missing:\n  " + missing.join("\n  ")); process.exit(1); }
  const chk = Archive.open(new Uint8Array(readFileSync(built))).readFile("staredit\\scenario.chk") as Uint8Array;
  const classic = classicScenario(chk);
  const chkPath = join(dir, "scenario.chk");
  writeFileSync(chkPath, classic);
  const run = await startExactGame(chkPath, { game: "ums" });
  const strings = placeStrings(run.lifted, chk);
  installEud(run.lifted, strings);
  // (eudplib's payload lies outside what the game's snapshot covers: the handle keeps it itself. What each frame of
  // the triggers ran is counted, A4.)
  const payloadEnd = 0x191943c8 + strings.bytes;
  const handle = testGame(run.engine, run.lifted, [{ from: strings.gameTable, to: payloadEnd }], { cost: installCost(run.lifted), payloadEnd }) as GameHandle;

  // The tests in the simulator over the map's own world, as the editor runs them; then in the game, the way a host
  // of the game runs them: the compile's JavaScript handed to dist/gametest.js, loaded from its text.
  const source = scriptFiles(script);
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
  // (Where the build put the programs' variables, for sim.program().)
  const variables = JSON.parse(readFileSync(built.replace(/\.scx$/, ".variables.json"), "utf8"));
  const triggerMap = JSON.parse(readFileSync(built.replace(/\.scx$/, ".triggers.json"), "utf8"));
  const inGame = host.runGameTests(handle, { modules: compiled.modules, names, locations, variables, triggers: triggerMap }) as TestReport & { error?: string };
  if (inGame.error) { console.error(`the script did not run beside the game: ${inGame.error}`); process.exit(1); }
  const bySim = new Map((simulated?.results ?? []).map((r) => [r.id, r]));
  let failed = 0;
  for (const r of inGame.results) {
    if (r.status === "skipped" && r.message?.startsWith("a test of ")) continue;
    const s = bySim.get(r.id);
    const mark = (st: string | undefined) => (st === "passed" ? "✓" : st === "failed" ? "✗" : st === "skipped" ? "–" : "?");
    if (r.status === "failed") failed++;
    console.log(`${mark(r.status)} game  ${mark(s?.status)} simulator  ${r.id.replace(/^.*?::/, "")}  (${r.frames} frames, ${r.ms} ms)`);
    if (r.status === "failed") console.log(`    in the game: ${r.message}${r.at ? ` — line ${r.at.line}` : ""}${r.actual !== undefined ? `\n      got ${r.actual}` : ""}`);
    if (s?.status === "failed") console.log(`    in the simulator: ${s.message}${s.at ? ` — line ${s.at.line}` : ""}${s.actual !== undefined ? `\n      got ${s.actual}` : ""}`);
    if (s && s.status !== r.status) console.log("    the two disagree: one of them is wrong");
    // (A4: what the test's frames cost in the game, and its costliest lines.)
    if (r.cost && process.env.COST !== "0") {
      const ran = r.cost.perFrame.filter((n) => n > 0), avg = ran.length ? Math.round(ran.reduce((a, b) => a + b, 0) / ran.length) : 0;
      console.log(`    cost: ${avg} conditions and actions a frame on average, ${r.cost.peak} at the most (frame ${r.cost.peakFrame})`);
      for (const l of r.cost.lines.slice(0, 3)) console.log(`      line ${l.line}: ${l.peak} at the most (frame ${l.peakFrame}), ran in ${l.frames} frames`);
    }
  }
  // A test of several players: the map built again with their slots open to people, then a copy of the game for
  // each player, kept in step (scm-sim's runCopies), all running the same tests.
  const groups = new Map<string, { players: number[]; ids: string[] }>();
  for (const t of simulated?.list ?? []) if (t.kind === "test" && t.players) { const k = t.players.join(","); const g = groups.get(k) ?? { players: t.players, ids: [] }; g.ids.push(t.id); groups.set(k, g); }
  if (groups.size) {
    const people = [...new Set([...groups.values()].flatMap((g) => g.players))].sort((a, b) => a - b);
    const several = join(dir, basename(script, ".ts") + "-people.scx");
    const b2 = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(script), several, ...(baseMap ? [resolve(baseMap)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, VARIABLE_MAP: "1", TRIGGER_MAP: "1", PEOPLE: people.join(",") } });
    if (b2.status !== 0) { console.error(b2.stdout.split("\n").slice(-20).join("\n"), b2.stderr); process.exit(1); }
    const { runCopies } = await from("src/exact/copiesNode.ts");
    const triggers = JSON.parse(readFileSync(several.replace(/\.scx$/, ".triggers.json"), "utf8"));
    const severalVariables = JSON.parse(readFileSync(several.replace(/\.scx$/, ".variables.json"), "utf8"));
    // TRIGSCRIPT_DUMP=<dir>: what the copies are handed, kept for a run in a browser (scm-sim's web/smoke-copies.mjs).
    if (process.env.TRIGSCRIPT_DUMP) {
      const to = resolve(process.env.TRIGSCRIPT_DUMP);
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "map.scx"), readFileSync(several));
      writeFileSync(join(to, "gametest.js"), readFileSync(bundle));
      writeFileSync(join(to, "request.json"), JSON.stringify({ groups: [...groups.values()], triggers, payload: { modules: compiled.modules, names, locations, variables: severalVariables } }));
    }
    for (const g of groups.values()) {
      const out = await runCopies({ map: new Uint8Array(readFileSync(several)), seats: g.players.map((slot) => ({ slot, race: 1, name: `P${slot + 1}` })), driver: readFileSync(bundle, "utf8"), payload: { modules: compiled.modules, names, locations, variables: severalVariables, triggers, ids: g.ids }, triggers }) as { result: (TestReport & { error?: string }) | null; error: string | null; player: number }[];
      for (const c of out) if (c.error || c.result?.error) { console.error(`P${c.player + 1}'s copy: ${c.error ?? c.result?.error}`); process.exit(1); }
      // A test passes when it passes at every computer; the first that failed says why.
      for (const r of mergeCopies(g.ids, out)) {
        const s = bySim.get(r.id);
        const mark = (st: string | undefined) => (st === "passed" ? "✓" : st === "failed" ? "✗" : st === "skipped" ? "–" : "?");
        if (r.status === "failed") failed++;
        console.log(`${mark(r.status)} game ×${g.players.length}  ${mark(s?.status)} simulator  ${r.id.replace(/^.*?::/, "")}  (${r.frames} frames, ${r.ms} ms)`);
        if (r.cost && process.env.COST !== "0") console.log(`    cost: ${r.cost.peak} conditions and actions at the most in a frame (frame ${r.cost.peakFrame})`);
        if (r.status === "failed") console.log(`    in the game: ${r.message}${r.at ? ` — line ${r.at.line}` : ""}`);
        if (s?.status === "failed") console.log(`    in the simulator: ${s.message}${s.at ? ` — line ${s.at.line}` : ""}`);
        if (s && s.status !== r.status) console.log("    the two disagree: one of them is wrong");
      }
    }
  }
  const counted = inGame.results.filter((r) => r.status !== "skipped" || !r.message?.startsWith("a test of ")).length + [...groups.values()].reduce((n, g) => n + g.ids.length, 0);
  console.log(`\n${counted} tests in the game: ${counted - failed} passed, ${failed} failed`);
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
