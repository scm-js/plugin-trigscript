/**
 * The debugger's record of a test run in the lifted game (TrigScript 4, A5), under Node: each test of a script run
 * once with everything written down (compiler/gameDebug.ts), what the record holds said in numbers, and the record
 * held against the game itself: at frames across the run, a picture of the frame (the nearest kept game, the test's
 * own actions done again, the frames played) must hold the script's memory as the record says it was then, and the
 * program's variables read from the two must agree.
 *
 *   npx tsx scripts/debug-game.mts <script.ts> [test name] [map.scx]
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
import { readLocations } from "../compiler/gameSim";
import { defaultScriptNames } from "../compiler/names";
import { STEP_EUDPLIB, STEP_TEST, STEP_UNSEEN, type DebugHost, type DebugRecording } from "../compiler/gameDebug";
import { programVariables, type VariableMap } from "../compiler/gameVariables";
import { defaultLib } from "../bundle/lib.mjs";
import { scriptFiles } from "./script-files.mts";

const root = resolve(import.meta.dirname, "..");
const [script, only, baseMap] = process.argv.slice(2);
if (!script || !existsSync(script)) { console.error("usage: debug-game.mts <script.ts> [test name] [map.scx]"); process.exit(2); }
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "src", "exact", "testGame.ts"))) { console.error(`no scm-sim checkout with src/exact/testGame.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);

const dir = mkdtempSync(join(tmpdir(), "trigscript-debug-"));
let bad = 0;
try {
  const built = join(dir, basename(script, ".ts") + ".scx");
  const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(script), built, ...(baseMap ? [resolve(baseMap)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, VARIABLE_MAP: "1", TRIGGER_MAP: "1" } });
  if (b.status !== 0) { console.error(b.stdout.split("\n").slice(-20).join("\n"), b.stderr); process.exit(1); }

  const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
  const { exactMissing, startExactGame } = await from("src/exact/node.ts");
  const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
  const { testGame } = await from("src/exact/testGame.ts");
  const { installCost } = await from("src/exact/cost.ts");
  const missing = exactMissing() as string[];
  if (missing.length) { console.error("the lifted game cannot run here; missing:\n  " + missing.join("\n  ")); process.exit(1); }
  const chk = Archive.open(new Uint8Array(readFileSync(built))).readFile("staredit\\scenario.chk") as Uint8Array;
  const chkPath = join(dir, "scenario.chk");
  writeFileSync(chkPath, classicScenario(chk));
  const run = await startExactGame(chkPath, { game: "ums" });
  const strings = placeStrings(run.lifted, chk);
  const eud = installEud(run.lifted, strings);
  const payloadEnd = 0x191943c8 + strings.bytes;
  const handle = testGame(run.engine, run.lifted, [{ from: strings.gameTable, to: payloadEnd }], { cost: installCost(run.lifted), payloadEnd, eud }) as DebugHost;

  const source = scriptFiles(script);
  const names = defaultScriptNames();
  const locations = readLocations(handle);
  const compiled = compileScript(ts, source, names, { lib: defaultLib(), tests: {} });
  if (!compiled.modules) { console.error(compiled.ok ? "the script has no tests" : compiled.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n")); process.exit(1); }
  const bundle = join(dir, "gametest.js");
  spawnSync("npx", ["esbuild", join(root, "compiler", "gameTestEntry.ts"), "--bundle", "--format=esm", "--target=es2022", "--platform=neutral", `--outfile=${bundle}`], { cwd: root });
  const host = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(bundle)).toString("base64")}`) as typeof import("../compiler/gameTestEntry");
  const variables = JSON.parse(readFileSync(built.replace(/\.scx$/, ".variables.json"), "utf8")) as VariableMap;
  const triggers = JSON.parse(readFileSync(built.replace(/\.scx$/, ".triggers.json"), "utf8"));
  const payload = { modules: compiled.modules, names, locations, variables, triggers };
  const listed = host.runGameTests(handle, { ...payload, ids: [] });
  const tests = listed.list.filter((t) => t.kind === "test" && !t.players && (!only || t.name.includes(only)));
  if (!tests.length) { console.error(only ? `no test named like "${only}"` : "the script has no test of one player"); process.exit(1); }

  for (const t of tests) {
    const t0 = Date.now();
    const session = host.debugGameTest(handle, { ...payload, test: t.id });
    const r: DebugRecording = session.recording;
    const steps = r.stepLine.length, writes = r.writes.length / 3;
    const kinds = { line: 0, eudplib: 0, test: 0, unseen: 0 };
    for (const l of r.stepLine) { if (l === STEP_EUDPLIB) kinds.eudplib++; else if (l === STEP_TEST) kinds.test++; else if (l === STEP_UNSEEN) kinds.unseen++; else kinds.line++; }
    console.log(`${r.result.status === "passed" ? "✓" : r.result.status === "failed" ? "✗" : "–"} ${t.name}: ${r.frames} frames (${r.first}–${r.first + r.frames - 1}), recorded in ${r.ms} ms`);
    console.log(`    ${steps.toLocaleString("en")} steps (${kinds.line} of lines, ${kinds.eudplib} eudplib's, ${kinds.test} the test's, ${kinds.unseen} unseen), ${writes.toLocaleString("en")} writes, ${r.lines.length} lines, ${r.kept.length} kept games${r.cut ? `; CUT at frame ${r.cut.frame}: ${r.cut.why}` : ""}`);
    console.log(`    record: ${Math.round((r.memory.bytes.byteLength + r.writes.byteLength + 4 * (r.stepLine.length * 3 + r.frameSteps.length + r.testLine.length * 2)) / 1024)} KB`);
    const busiest = [...r.frameSteps.slice(1)].map((e, k) => ({ k, n: e - r.frameSteps[k] })).sort((a, b) => b.n - a.n)[0];
    if (busiest) console.log(`    busiest frame ${r.first + busiest.k}: ${busiest.n} steps; test lines asked for frames: ${[...new Set(r.testLine)].filter(Boolean).join(", ") || "none"}`);
    if (kinds.unseen) console.log(`    note: ${kinds.unseen} frames had writes no record said (the game's own routines)`);

    // The record against the game: pictures at frames across the run.
    if (!r.frames) continue;
    const at = [...new Set([0, 1, Math.floor(r.frames / 3), Math.floor(r.frames / 2), r.frames - 2, r.frames - 1].filter((k) => k >= 0 && k < r.frames))];
    // Backwards first, then forwards: a picture from a kept game and one played on from the last.
    for (const k of [...at].reverse().concat(at)) {
      const frame = r.first + k;
      const p0 = Date.now();
      const pic = session.picture(frame);
      const ms = Date.now() - p0;
      const mem = memoryAt(r, k);
      const live = handle.u8.subarray(r.memory.at, r.memory.at + mem.byteLength);
      let differ = 0, firstAt = -1;
      for (let i = 0; i < mem.byteLength; i += 4) if (mem[i] !== live[i] || mem[i + 1] !== live[i + 1] || mem[i + 2] !== live[i + 2] || mem[i + 3] !== live[i + 3]) { differ++; if (firstAt < 0) firstAt = r.memory.at + i; }
      let vars = "";
      if (variables.programs.length) {
        const a = JSON.stringify(readAll(handle.m, handle.u8, variables)), c = JSON.stringify(readAll(overlay(handle.u8, r.memory.at, mem), overlayBytes(handle.u8, r.memory.at, mem), variables));
        vars = a === c ? ", variables agree" : `, VARIABLES DIFFER: game ${a.slice(0, 160)} / record ${c.slice(0, 160)}`;
        if (a !== c) bad++;
      }
      if (differ || pic.frame !== frame) bad++;
      console.log(`    picture of frame ${frame}: ${ms} ms, at ${pic.frame}${differ ? `, ${differ} DWORDS DIFFER from the record (first 0x${firstAt.toString(16)})` : ", memory as the record says"}${vars}`);
    }
    session.close();
    console.log(`    ${Date.now() - t0} ms in all`);
  }
  console.log(bad ? `\n${bad} checks failed` : "\nevery check held");
  if (bad) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** The script's memory at the end of record frame `k`: the start, and every write up to the end of that frame. */
function memoryAt(r: DebugRecording, k: number): Uint8Array {
  const out = r.memory.bytes.slice();
  const v = new DataView(out.buffer);
  const end = r.stepWrites[r.frameSteps[k + 1]];
  for (let w = 0; w < end; w++) v.setUint32(r.writes[3 * w] - r.memory.at, r.writes[3 * w + 2], true);
  return out;
}

/** The game's memory with the record's copy of the script's laid over it (a reader that reads the record). */
function overlayBytes(u8: Uint8Array, at: number, mem: Uint8Array): Uint8Array {
  return new Proxy(u8, { get(t, p) { if (typeof p === "string" && /^\d+$/.test(p)) { const i = Number(p); return i >= at && i < at + mem.length ? mem[i - at] : t[i]; } if (p === "subarray") return (a: number, b: number) => (a >= at && b <= at + mem.length ? mem.subarray(a - at, b - at) : t.subarray(a, b)); const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
}
function overlay(u8: Uint8Array, at: number, mem: Uint8Array): DataView {
  const real = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), mine = new DataView(mem.buffer);
  return new Proxy(real, { get(t, p) { if (p === "getUint32" || p === "getInt32" || p === "getUint16" || p === "getUint8") return (i: number, le?: boolean) => (i >= at && i < at + mem.length ? (mine[p] as (i: number, le?: boolean) => number)(i - at, le) : (t[p] as (i: number, le?: boolean) => number)(i, le)); const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
}

function readAll(m: DataView, u8: Uint8Array, map: VariableMap): unknown {
  const out: Record<string, unknown> = {};
  for (const p of map.programs) for (const who of p.perPlayer ? p.owners : [undefined]) {
    try {
      const vars = programVariables({ m, u8, unitAt: (ptr, uid) => (ptr ? ({ slot: ptr, uid } as never) : null) }, map, p.name ?? p.index, who);
      const plain: Record<string, unknown> = {};
      for (const v of [...p.vars.map((x) => x.id), ...p.arrays.map((x) => x.id)]) { const name = v.replace(/#\d+$/, ""); try { plain[name] = JSON.parse(JSON.stringify(vars[name] ?? null)); } catch { plain[name] = "?"; } }
      out[`${p.name ?? p.index}${who !== undefined ? `@P${who + 1}` : ""}`] = plain;
    } catch (e) { out[String(p.index)] = String(e); }
  }
  return out;
}
