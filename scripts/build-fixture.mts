/**
 * Build a script into a map under Node, the way saving does in the editor: compile, write the `trigger()` records
 * into the map, and lay the programs out into the scenario as TrigScript's own build does (`compiler/backend/build.ts`,
 * step 14). For probe maps that get played.
 *
 *   [TRIGGER_MAP=1] [VARIABLE_MAP=1] [PEOPLE=0,1] [PREP_ONLY=1] npx tsx scripts/build-fixture.mts probes/spike.ts fixtures/eud/spike.scx [map.scx]
 *
 * The output lands in the ignored fixtures/ folder: it is built on a Blizzard map, which is never committed.
 *
 * The map is prepared through the editor's own code (a scm-js checkout beside this repository, or SCMJS_DIR): players,
 * a base each, and the script's `trigger()` records with their texts interned. TRIGGER_MAP=1 and VARIABLE_MAP=1 write
 * where each trigger and each variable is beside the map (<out>.triggers.json, <out>.variables.json), for scm-sim's
 * run in the lifted game and `sim.program()`. MAP_NAME names the scenario (what the lobby shows); KEEP_TRIGGERS=1 keeps
 * the base map's own triggers before the script's; STACK_DEPTH and HEAP_CELLS are the script's settings; OWN_FREE a
 * dword written into every free cell of the payload.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { buildOwnMap, isRefused } from "../compiler/backend/build";
import { resolveStrings } from "../script";
import { finishSounds, vorbisEncoder } from "../compiler/vorbis";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { scriptFiles } from "./script-files.mts";

const [scriptPath, outPath, mapArg] = process.argv.slice(2);
if (!scriptPath || !outPath) { console.error("usage: build-fixture <script.ts> <out.scx> [map.scx]"); process.exit(2); }
const root = resolve(import.meta.dirname, "..");
const map = resolve(mapArg ?? join(root, "fixtures", "maps", "(2)Binary Burghs.scx"));
if (!existsSync(map)) { console.error(`no map at ${map}`); process.exit(2); }

// RANGES=0: built without value ranges (compiler/ranges.ts), to weigh what they give.
const r = compileScript(ts, scriptFiles(scriptPath), defaultScriptNames(), { lib: defaultLib(), ranges: process.env.RANGES !== "0" });
if (r.diagnostics.length) { for (const d of r.diagnostics) console.error(`${d.file}:${d.line}:${d.column} ${d.message}`); process.exit(1); }
const EDITOR = resolve(process.env.SCMJS_DIR ?? join(root, "..", "scm-js"));
const { loadMap, saveMap, readExtras } = await import(join(EDITOR, "src", "formats", "mpq", "scm.ts"));
const { parseScenario, serializeScenario, setScenarioName } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { internString, patchPlayer } = await import(join(EDITOR, "src", "editor", "settings.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(map)));
const scn = parseScenario(loaded.chk);
// (MAP_NAME: the name the lobby shows, so that maps built on the same base can be told apart in a recording.)
if (process.env.MAP_NAME) setScenarioName(scn, process.env.MAP_NAME);
// A probe map is played alone: Player 1 is the human (Terran), Player 2 a computer (Zerg) in a
// force of its own, so a Use Map Settings game starts with one person. Fixed races on purpose:
// with User Selectable the game hands out melee units and drops the placed ones.
patchPlayer(scn, 0, { type: 6, race: 1, force: 0 });
patchPlayer(scn, 1, { type: 5, race: 0, force: 1 });
// PEOPLE=0,1: those slots open to a person each (Terran), for a test of several players (scripts/test-game.mts).
for (const slot of (process.env.PEOPLE ?? "").split(",").filter(Boolean).map(Number)) patchPlayer(scn, slot, { type: 6, race: 1, force: slot === 0 ? 0 : 1 });
// A probe that needs its players set otherwise says so in a line of its own: `// probe-players: {"1":{"type":0,"rgb":[0,255,255]}}`,
// by 0-based slot — a slot type (0 inactive, 5 computer, 6 human) and a Remastered colour of its own.
const playersLine = /^\/\/ probe-players: (.+)$/m.exec(readFileSync(scriptPath, "utf8"));
if (playersLine) for (const [slot, patch] of Object.entries(JSON.parse(playersLine[1]) as Record<string, { type?: number; rgb?: [number, number, number] }>)) patchPlayer(scn, Number(slot), patch);
// The base map is a melee map: its stock triggers defeat whoever commands no buildings, and in
// Use Map Settings nobody is handed melee units — both players lose at once and the game
// ends in a draw a second in. The probe's own script is the only source of triggers it should have,
// and each player gets a base at their start location so there is something to look at.
const { markDirty } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { addUnits, applyUnitChanges, makeUnit, nextSerial } = await import(join(EDITOR, "src", "editor", "units.ts"));
// … and the script's own trigger() records, as applying the script writes them.
scn.triggers = [...(process.env.KEEP_TRIGGERS ? scn.triggers : []), ...resolveStrings(r, (text: string) => internString(scn, text))];
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
// Location 1, "Home": the ground next to Player 1's base, so a probe can make something happen in sight
// (`createUnit(P2, unit, 4, 1)` — a location is its number where the map's names are not known).
const home = scn.units.find((u: { unitId: number; owner: number }) => u.unitId === START_LOCATION && u.owner === 0);
if (home && scn.locations?.[0] && !scn.locations[0].nameIndex && scn.locations[0].right === 0) {
  // Below the base where the map has room, else above it; kept inside the map.
  const w = scn.width * 32, h = scn.height * 32;
  const top = home.y + 320 <= h ? home.y + 128 : home.y - 320;
  const left = Math.max(0, Math.min(w - 384, home.x - 192));
  scn.locations[0] = { ...scn.locations[0], left, top, right: left + 384, bottom: top + 192, nameIndex: internString(scn, "Home") };
  // Location 2, "Away": a smaller box beside Home — to its right where the map has room, else to its left — for a probe to send a unit to.
  if (scn.locations[1] && !scn.locations[1].nameIndex && scn.locations[1].right === 0) {
    const awayLeft = left + 384 + 256 + 128 <= w ? left + 384 + 256 : Math.max(0, left - 256 - 128);
    scn.locations[1] = { ...scn.locations[1], left: awayLeft, top, right: awayLeft + 128, bottom: top + 192, nameIndex: internString(scn, "Away") };
  }
  // Location 3, "Pixel": 64 × 64 — one cell of a board drawn with units, room for a 2 × 2 building, which Create Unit puts
  // inside the location or not at all — for a probe to centre on a point and make or take away a unit there.
  if (scn.locations[2] && !scn.locations[2].nameIndex && scn.locations[2].right === 0) {
    scn.locations[2] = { ...scn.locations[2], left: 0, top: 0, right: 64, bottom: 64, nameIndex: internString(scn, "Pixel") };
  }
  markDirty(scn, "MRGN");
}
markDirty(scn, "TRIG", "UNIT");
const extras = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
// The clips the script plays (compiler/sound.ts), as the editor's Apply writes them: the long ones Ogg Vorbis, encoded
// here as a build in the editor encodes them (compiler/vorbis.ts).
if (r.sounds.some((s) => s.vorbis)) finishSounds(r.sounds, vorbisEncoder(readFileSync(resolve(import.meta.dirname, "..", "node_modules", "wasm-media-encoders", "wasm", "ogg.wasm"))));
for (const s of r.sounds) extras.set(s.path, s.bytes!);
const prepared: Uint8Array = serializeScenario(scn);
const withStrings = await saveMap(prepared, { extras, compress: "pkware", listfile: true });
// PREP_ONLY=1: the prepared map as it is, not built: what the editor opens in a run end to end, and builds itself.
if (process.env.PREP_ONLY) { writeFileSync(resolve(outPath), withStrings); process.exit(0); }
// TrigScript's own build, as the editor's step runs it: the records are in the map's TRIG already.
const settings = { ...(process.env.STACK_DEPTH ? { stackDepth: Number(process.env.STACK_DEPTH) } : {}), ...(process.env.HEAP_CELLS ? { heapCells: Number(process.env.HEAP_CELLS) } : {}) };
const built = buildOwnMap({ chk: prepared, compiled: { ...r, triggers: [] }, settings, maps: Boolean(process.env.TRIGGER_MAP || process.env.VARIABLE_MAP), ...(process.env.OWN_FREE ? { free: Number(process.env.OWN_FREE) } : {}) });
if (isRefused(built)) { console.error(`TrigScript's own build does not take this script: ${built.refused}`); process.exit(1); }
writeFileSync(resolve(outPath), await saveMap(built.chk, { extras, compress: "pkware", listfile: true }));
if (process.env.TRIGGER_MAP) writeFileSync(resolve(outPath).replace(/\.scx$/, ".triggers.json"), JSON.stringify(built.maps!.triggers));
if (process.env.VARIABLE_MAP) writeFileSync(resolve(outPath).replace(/\.scx$/, ".variables.json"), JSON.stringify(built.maps!.variables));
for (const line of built.lines) console.log(line);
