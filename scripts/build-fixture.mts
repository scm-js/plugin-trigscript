/**
 * Build a fixture script for the Remastered target under Node, the way the golden test
 * does: compile to IR, hand the IR, the map and `python/trigscript.py` to a plugin-eudplib
 * checkout's `scripts/build-map.mts`, write the built map. For probe maps that get played.
 *
 *   npx tsx scripts/build-fixture.mts probes/spike.ts fixtures/eud/spike-eud.scx [map.scx] [../plugin-eudplib]
 *
 * The output lands in the ignored fixtures/ folder: it is built on a Blizzard map, which is never committed.
 *
 * The script's texts are interned into the map's string table first through the editor's
 * own codec (a scm-js checkout beside this repository, or SCMJS_DIR), the way a build in
 * the editor does, so the built map says what the script says.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { checkForTarget, serializeIr } from "../compiler/eud";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";

const [scriptPath, outPath, mapArg, eudplibArg] = process.argv.slice(2);
if (!scriptPath || !outPath) { console.error("usage: build-fixture <script.ts> <out.scx> [map.scx] [plugin-eudplib dir]"); process.exit(2); }
const root = resolve(import.meta.dirname, "..");
const map = resolve(mapArg ?? join(root, "fixtures", "maps", "(2)Binary Burghs.scx"));
const eudplib = resolve(eudplibArg ?? process.env.EUDPLIB_DIR ?? join(root, "..", "plugin-eudplib"));
if (!existsSync(map)) { console.error(`no map at ${map}`); process.exit(2); }
if (!existsSync(join(eudplib, "scripts", "build-map.mts"))) { console.error(`no plugin-eudplib checkout at ${eudplib}`); process.exit(2); }

const r = compileScript(ts, { "main.ts": readFileSync(scriptPath, "utf8") }, defaultScriptNames(), { lib: defaultLib() });
if (r.diagnostics.length) { for (const d of r.diagnostics) console.error(`${d.file}:${d.line}:${d.column} ${d.message}`); process.exit(1); }
const problems = r.ir.flatMap((p) => checkForTarget(p, "remastered"));
if (problems.length) { for (const d of problems) console.error(`${d.at.file}:${d.at.line}:${d.at.column} ${d.message}`); process.exit(1); }
// The texts the script names go into the map's own string table first, as the editor's build does, so the IR can name
// them by the map's indices; the editor's codec does it (the scm-js checkout beside this repository).
const EDITOR = resolve(process.env.SCMJS_DIR ?? join(root, "..", "scm-js"));
const { loadMap, saveMap, readExtras } = await import(join(EDITOR, "src", "formats", "mpq", "scm.ts"));
const { parseScenario, serializeScenario } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { internString, patchPlayer } = await import(join(EDITOR, "src", "editor", "settings.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(map)));
const scn = parseScenario(loaded.chk);
// A probe map is played alone: Player 1 is the human (Terran), Player 2 a computer (Zerg) in a
// force of its own, so a Use Map Settings game starts with one person. Fixed races on purpose:
// with User Selectable the game hands out melee units and drops the placed ones.
patchPlayer(scn, 0, { type: 6, race: 1, force: 0 });
patchPlayer(scn, 1, { type: 5, race: 0, force: 1 });
// The base map is a melee map: its stock triggers defeat whoever commands no buildings, and in
// Use Map Settings nobody is handed melee units — both players lose at once and the game
// ends in a draw a second in. The probe's own programs are the only triggers it should have,
// and each player gets a base at their start location so there is something to look at.
const { markDirty } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { addUnits, applyUnitChanges, makeUnit, nextSerial } = await import(join(EDITOR, "src", "editor", "units.ts"));
scn.triggers = [];
const START_LOCATION = 214, COMMAND_CENTER = 106, HATCHERY = 131, MARINE = 0, ZERGLING = 37;
const placed = [];
let serial = nextSerial(scn);
for (const [owner, base, troop] of [[0, COMMAND_CENTER, MARINE], [1, HATCHERY, ZERGLING]] as const) {
  const start = scn.units.find((u: { unitId: number; owner: number }) => u.unitId === START_LOCATION && u.owner === owner);
  if (!start) continue;
  placed.push(makeUnit(null, base, owner, start.x, start.y, serial++));
  for (let i = 0; i < 4; i++) placed.push(makeUnit(null, troop, owner, start.x - 48 + i * 32, start.y + 96, serial++));
}
applyUnitChanges(scn, addUnits(scn, placed));
markDirty(scn, "TRIG", "UNIT");
const indices = new Map<number, number>();
r.strings.forEach((str, i) => { indices.set(i + 1, "index" in str ? str.index : internString(scn, str.text)); });
const ir = serializeIr(r.ir, (local) => (local === 0 ? 0 : indices.get(local) ?? 0));
const extras = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
const withStrings = await saveMap(serializeScenario(scn), { extras, compress: "pkware", listfile: true });
const dir = mkdtempSync(join(tmpdir(), "trigscript-fixture-"));
const irPath = join(dir, "trigscript.json");
const pluginsPath = join(dir, "plugins.json");
writeFileSync(irPath, ir);
writeFileSync(resolve(outPath).replace(/\.scx$/, ".json"), ir);
const mapPath = join(dir, "in.scx");
writeFileSync(mapPath, withStrings);
writeFileSync(pluginsPath, JSON.stringify({ trigscript: { ir: "/work/files/trigscript.json" }, eudTurbo: {} }));
const res = spawnSync("npx", ["tsx", join(eudplib, "scripts", "build-map.mts"), mapPath, resolve(outPath), pluginsPath, `trigscript=${join(root, "python", "trigscript.py")}`, `file=trigscript.json=${irPath}`], { cwd: eudplib, encoding: "utf8", env: { ...process.env, EUDPLIB_LOG: "1" } });
rmSync(dir, { recursive: true, force: true });
process.stdout.write(res.stdout);
if (res.status !== 0) { console.error(res.stderr); process.exit(1); }
