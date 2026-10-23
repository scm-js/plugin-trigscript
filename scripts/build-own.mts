/**
 * A map of our own: a script built with no eudplib and no Python (TrigScript 4, the backend: our own layout and
 * start-up). Each program's whole body is lowered by the emitter (`compiler/backend/emit.ts`, `emitBody`) — once for
 * each player a per-player program runs for — laid out at fixed addresses after the strings
 * (`compiler/backend/layout.ts`), and handed to the game's trigger walk by a few triggers in the map's TRIG section.
 * What the emitter cannot lower yet is refused, and said. The build itself is `compiler/backend/build.ts`, the one
 * the plugin's build step runs in the editor (step 14); this script prepares a probe map for it and writes the file.
 *
 *   npx tsx scripts/build-own.mts probes/own-loader.ts out.scx [map.scx]
 *
 * The map is prepared as build-fixture prepares it (a base each, Player 1 the person; PEOPLE and a `// probe-players:`
 * line as there; MAP_NAME the name the lobby shows), and written through the editor's own code (a scm-js checkout
 * beside this repository, or SCMJS_DIR). The base is a melee map, whose stock triggers would end a Use Map Settings
 * game at once: they are left out unless OWN_KEEP_TRIGGERS says otherwise. OWN_FREE=<dword> fills the payload's free
 * cells with a marker.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { buildOwnMap, isRefused } from "../compiler/backend/build";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { finishSounds, vorbisEncoder } from "../compiler/vorbis";
import { scriptFiles } from "./script-files.mts";

const started = performance.now();
const [scriptPath, outPath, mapArg] = process.argv.slice(2);
if (!scriptPath || !outPath) { console.error("usage: build-own <script.ts> <out.scx> [map.scx]"); process.exit(2); }
const root = resolve(import.meta.dirname, "..");
const map = resolve(mapArg ?? join(root, "fixtures", "maps", "(2)Binary Burghs.scx"));
if (!existsSync(map)) { console.error(`no map at ${map}`); process.exit(2); }

const r = compileScript(ts, scriptFiles(scriptPath), defaultScriptNames(), { lib: defaultLib(), emitter: false });
if (r.diagnostics.length) { for (const d of r.diagnostics) console.error(`${d.file}:${d.line}:${d.column} ${d.message}`); process.exit(1); }
const compiled = performance.now();

const EDITOR = resolve(process.env.SCMJS_DIR ?? join(root, "..", "scm-js"));
const { loadMap, saveMap, readExtras } = await import(join(EDITOR, "src", "formats", "mpq", "scm.ts"));
const { parseScenario, serializeScenario, markDirty, setScenarioName } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { patchPlayer } = await import(join(EDITOR, "src", "editor", "settings.ts"));
const { addUnits, applyUnitChanges, makeUnit, nextSerial } = await import(join(EDITOR, "src", "editor", "units.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(map)));
const scn = parseScenario(loaded.chk);
// (MAP_NAME: the name the lobby shows, so that maps built on the same base can be told apart in a recording.)
if (process.env.MAP_NAME) setScenarioName(scn, process.env.MAP_NAME);
patchPlayer(scn, 0, { type: 6, race: 1, force: 0 });
patchPlayer(scn, 1, { type: 5, race: 0, force: 1 });
for (const slot of (process.env.PEOPLE ?? "").split(",").filter(Boolean).map(Number)) patchPlayer(scn, slot, { type: 6, race: 1, force: slot === 0 ? 0 : 1 });
const playersLine = /^\/\/ probe-players: (.+)$/m.exec(readFileSync(scriptPath, "utf8"));
if (playersLine) for (const [slot, patch] of Object.entries(JSON.parse(playersLine[1]) as Record<string, { type?: number; rgb?: [number, number, number] }>)) patchPlayer(scn, Number(slot), patch);
// A base and a few troops each, as build-fixture places them.
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
markDirty(scn, "UNIT");
const chk: Uint8Array = serializeScenario(scn);
const prepared = performance.now();

// The build as the editor runs it: the compile's records go in as the script's (the map's trigger list has none of
// them here, where the editor's apply would have written them into it).
const built = buildOwnMap({ chk, compiled: r, dropMapTriggers: !process.env.OWN_KEEP_TRIGGERS, ...(process.env.OWN_FREE ? { free: Number(process.env.OWN_FREE) } : {}) });
if (isRefused(built)) { console.error(`the emitter cannot lower this program: ${built.refused}`); process.exit(1); }
const emitted = performance.now();
const extras = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
// The clips the script plays, in the archive (an Ogg one encoded first), as build-fixture puts them.
if (r.sounds.some((s) => s.vorbis)) finishSounds(r.sounds, vorbisEncoder(readFileSync(join(root, "node_modules", "wasm-media-encoders", "wasm", "ogg.wasm"))));
for (const s of r.sounds) extras.set(s.path, s.bytes!);
writeFileSync(resolve(outPath), await saveMap(built.chk, { extras, compress: "pkware", listfile: true }));
const done = performance.now();
for (const line of built.lines) console.log(line);
console.log(`${resolve(outPath)}: built in ${(done - started).toFixed(0)} ms (compile ${(compiled - started).toFixed(0)}, map ${(prepared - compiled).toFixed(0)}, build ${(emitted - prepared).toFixed(0)}, archive ${(done - emitted).toFixed(0)})`);
