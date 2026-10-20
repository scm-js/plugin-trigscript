/**
 * A map of our own: a script built with no eudplib and no Python (TrigScript 4, the backend: our own layout and
 * start-up). Each program's whole body is lowered by the emitter (`compiler/backend/emit.ts`, `emitBody`) — once for
 * each player a per-player program runs for — laid out at fixed addresses after the strings
 * (`compiler/backend/layout.ts`), and handed to the game's trigger walk by a few triggers in the map's TRIG section.
 * What the emitter cannot lower yet is refused, and said.
 *
 *   npx tsx scripts/build-own.mts probes/own-loader.ts out.scx [map.scx]
 *
 * The map is prepared as build-fixture prepares it (a base each, Player 1 the person; PEOPLE and a `// probe-players:`
 * line as there), made a Remastered map (VER 206, STRx), and written through the editor's own code (a scm-js checkout
 * beside this repository, or SCMJS_DIR).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { emitOwn } from "../compiler/backend/own";
import type { MapPlayers } from "../compiler/backend/emit";
import { STRINGS, layout } from "../compiler/backend/layout";
import type { Graph } from "../compiler/backend/graph";
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
const { parseScenario, serializeScenario, markDirty, setMapVersion } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { internString, patchPlayer, readPlayerSettings } = await import(join(EDITOR, "src", "editor", "settings.ts"));
const { addUnits, applyUnitChanges, makeUnit, nextSerial } = await import(join(EDITOR, "src", "editor", "units.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(map)));
const scn = parseScenario(loaded.chk);
setMapVersion(scn, "remastered");
patchPlayer(scn, 0, { type: 6, race: 1, force: 0 });
patchPlayer(scn, 1, { type: 5, race: 0, force: 1 });
for (const slot of (process.env.PEOPLE ?? "").split(",").filter(Boolean).map(Number)) patchPlayer(scn, slot, { type: 6, race: 1, force: slot === 0 ? 0 : 1 });
const playersLine = /^\/\/ probe-players: (.+)$/m.exec(readFileSync(scriptPath, "utf8"));
if (playersLine) for (const [slot, patch] of Object.entries(JSON.parse(playersLine[1]) as Record<string, { type?: number; rgb?: [number, number, number] }>)) patchPlayer(scn, Number(slot), patch);
// The map's players as the programs need them: the slots a human or a computer plays, and their forces.
const settings = readPlayerSettings(scn) as { types: number[]; force: number[] };
const players: MapPlayers = { slots: [0, 1, 2, 3, 4, 5, 6, 7].filter((p) => settings.types[p] === 5 || settings.types[p] === 6), forces: settings.force.slice(0, 8) };
const lowered = emitOwn(r, players);
if (typeof lowered === "string") { console.error(`the emitter cannot lower this program: ${lowered}`); process.exit(1); }
const { runs } = lowered;
const graphs: Graph[] = runs.map((run) => run.graph);
const emitted = performance.now();
// No trigger of the melee map's (they would end the game at once): the start-up is the only one.
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
// The texts the graph shows, in the strings first: the payload goes after them.
const texts = new Map<string, number>();
const intern = (text: string) => { if (!texts.has(text)) texts.set(text, internString(scn, text)); };
for (const t of graphs.flatMap((g) => g.triggers)) for (const a of t.acts) {
  if (a.display !== undefined) intern(a.display);
  // (An action of the game's: its text and its sound file's name.)
  for (const s of [a.strings?.text, a.strings?.wav]) if (s && "text" in s) intern(s.text);
  if (a.amountText) intern(a.amountText.text);
}
// A string for each text printed with values in it, as long as its template and three bytes more: once the strings are
// laid out, the template goes in it from its first dword's start on, and the string's offset is moved there (the
// game's own table of strings names only its first 64 KB in 1.16.1, so the template stays among them, as eudplib's
// buffer does).
const templates = new Map<string, number>();
for (const t of graphs.flatMap((g) => g.templates ?? [])) {
  // (A print at the centre of the screen is written into the game's own line: no string.)
  if (t.at !== undefined) continue;
  const name = `(TrigScript text ${t.id})`;
  templates.set(t.id, internString(scn, name + "\r".repeat(Math.max(0, t.bytes.length + 3 - name.length))));
}
markDirty(scn, "TRIG", "UNIT", "STRx");
const chk = serializeScenario(scn);

// The sections, as they are; the strings' and the triggers' put back with the payload and the start-up.
const sections: { name: string; body: Uint8Array }[] = [];
const dv = new DataView(chk.buffer, chk.byteOffset, chk.byteLength);
for (let o = 0; o + 8 <= chk.length;) {
  const name = String.fromCharCode(...chk.subarray(o, o + 4));
  const len = dv.getInt32(o + 4, true);
  if (len < 0 || o + 8 + len > chk.length) break;
  sections.push({ name, body: chk.subarray(o + 8, o + 8 + len) });
  o += 8 + len;
}
const strx = sections.find((s) => s.name === "STRx");
if (!strx) { console.error("the map came out with no STRx"); process.exit(1); }
const values = lowered.values;
// (STRx: the count, then a four-byte offset a string from the section's start; the section is at STRINGS in the game.)
const strings = new Uint8Array(strx.body);
const offsets = new DataView(strings.buffer);
const templateAt = new Map<string, number>();
for (const t of graphs.flatMap((g) => g.templates ?? [])) {
  if (t.at !== undefined) continue;
  const index = templates.get(t.id)!;
  const at = (STRINGS + offsets.getUint32(4 * index, true) + 3) & ~3;
  strings.set(t.bytes, at - STRINGS);
  offsets.setUint32(4 * index, at - STRINGS, true);
  templateAt.set(t.id, at);
}
const own = layout({ runs: runs.map((run) => ({ graph: run.graph, owner: run.player })), players: players.slots, strings: strings.length, text: (t) => texts.get(t)!, arrays: values, template: (id) => templates.get(id)!, templateAt });
const withPayload = new Uint8Array(strings.length + own.payload.length);
withPayload.set(strings);
withPayload.set(own.payload, strings.length);
strx.body = withPayload;
const trig = sections.find((s) => s.name === "TRIG");
if (trig) trig.body = own.trig;
else sections.push({ name: "TRIG", body: own.trig });
const parts: Uint8Array[] = [];
for (const s of sections) {
  const head = new Uint8Array(8);
  head.set([...s.name].map((c) => c.charCodeAt(0)));
  new DataView(head.buffer).setInt32(4, s.body.length, true);
  parts.push(head, s.body);
}
const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let at = 0;
for (const p of parts) { out.set(p, at); at += p.length; }
const extras = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
// The clips the script plays, in the archive (an Ogg one encoded first), as build-fixture puts them.
if (r.sounds.some((s) => s.vorbis)) finishSounds(r.sounds, vorbisEncoder(readFileSync(join(root, "node_modules", "wasm-media-encoders", "wasm", "ogg.wasm"))));
for (const s of r.sounds) extras.set(s.path, s.bytes!);
writeFileSync(resolve(outPath), await saveMap(out, { extras, compress: "pkware", listfile: true }));
const done = performance.now();
console.log(`${resolve(outPath)}: ${runs.length} run${runs.length === 1 ? "" : "s"} (${runs.map((run) => `program ${run.program + 1} as P${run.player + 1}`).join(", ")}), ${graphs.reduce((n, g) => n + g.triggers.length, 0)} triggers of the graphs, payload ${own.payload.length} bytes at 0x${own.address.toString(16)}, start-up ${own.trig.length / 2400} triggers`);
console.log(`built in ${(done - started).toFixed(0)} ms (compile ${(compiled - started).toFixed(0)}, emit ${(emitted - compiled).toFixed(0)}, map ${(done - emitted).toFixed(0)})`);
