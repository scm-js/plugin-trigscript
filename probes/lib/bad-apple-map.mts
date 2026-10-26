// The Bad Apple map's base (TrigScript 4, S4): 128 × 128 of snow, so the minimap draws a tile a pixel. The board is
// the top 96 rows (4:3); the 32 rows below it hold the start locations and the parked camera, whose box the minimap
// draws over whatever is under it. The song goes in the archive as it is.
//
//   npx tsx probes/lib/bad-apple-map.mts <out.scx> <song file> <name in the archive, e.g. staredit\wav\badapple.ogg>
//
// BA_ERA=<0-7> BA_TILE=<tile id>: the board is that one tile repeated, laid as the game reads it (no ISOM; the
// editor would see raw tiles). The contrast comes from the tile: the minimap's fog colours are the game's own tables
// (1.16.1 0x59C2C0, out of Remastered's reach), so the board is the tile whose lit and fogged minimap colours lie
// furthest apart. Measured 2026-10-17 over every megatile of every tileset in the lifted game: Badlands tile 23778
// (group 1486) is white lit (255), grey in fog (104), black never seen (4) — against Ice snow's 156 / 96. It is not
// ground a unit can stand on, so the video is encoded with the air brushes only (BA_AIR_ONLY=1).
// Needs a scm-js checkout beside this one with its tileset data (npm run extract). The song is never committed: it
// is not ours.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const E = process.env.SCMJS_DIR ?? join(import.meta.dirname, "..", "..", "..", "scm-js");
const { createScenario } = await import(join(E, "src/formats/chk/create.ts"));
const { markDirty, serializeScenario } = await import(join(E, "src/formats/chk/scenario.ts"));
const { saveMap } = await import(join(E, "src/formats/mpq/scm.ts"));
const { TILESET_FILENAMES } = await import(join(E, "src/formats/tileset/load.ts"));
const { loadTileset } = await import(join(E, "src/formats/tileset/decode.ts"));
const { baseTerrain, flatTerrain } = await import(join(E, "src/formats/tileset/terrain.ts"));

const [out, song, songName] = process.argv.slice(2);
if (!out || !song || !songName) { console.error("usage: bad-apple-map.mts <out.scx> <song file> <name in the archive>"); process.exit(2); }
const ERA = Number(process.env.BA_ERA ?? 6), TILE = process.env.BA_TILE ? Number(process.env.BA_TILE) : null, W = 128, H = 128;
const part = (ext: string) => new Uint8Array(readFileSync(join(E, "public/tileset", `${TILESET_FILENAMES[ERA]}.${ext}`)));
const ts = loadTileset({ cv5: part("cv5"), vf4: part("vf4"), vr4: part("vr4"), vx4: part("vx4"), wpe: part("wpe") });
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const flat = flatTerrain(W, H, baseTerrain(ts, 2), ts, rnd, ERA); // Snow on Ice; the tileset's first flat ground elsewhere
// A named tile covers the board only: the strip below keeps ground the start locations can stand on.
const tiles = flat.tiles;
if (TILE !== null) tiles.fill(TILE, 0, W * 96);
const isom = flat.isom;
const scn = createScenario({
  width: W, height: H, era: ERA, tiles, isom,
  name: "Bad Apple!! in the fog of war",
  description: "Bad Apple!! feat. nomico (Alstroemeria Records; shadow art video by Anira), played on the minimap with the fog of war and written in TrigScript. Host a multiplayer game alone and switch to Classic graphics (Options > Graphics) for a sharp minimap.",
});
scn.playerTypes = scn.playerTypes.map((t: number, i: number) => (i === 0 ? 6 : i === 1 ? 5 : i < 8 ? 0 : t));
scn.editorPlayerTypes = [...scn.playerTypes];
scn.playerRaces = scn.playerRaces.map((r: number, i: number) => (i === 0 ? 1 : i === 1 ? 0 : i < 8 ? 7 : r));
const start = (owner: number, tx: number, ty: number, serial: number) => ({ classInstance: serial, x: tx * 32 + 16, y: ty * 32 + 16, unitId: 214, relationFlags: 0, validStates: 0, validProperties: 0, owner, hitPointsPercent: 100, shieldPercent: 100, energyPercent: 100, resourceAmount: 0, hangarUnits: 0, stateFlags: 0, unused: 0, relatedSerial: 0 });
scn.units.push(start(0, 10, 118, 1), start(1, 116, 118, 2));
markDirty(scn, "OWNR", "IOWN", "SIDE", "UNIT", "MTXM", "TILE", "ISOM");
const extras = new Map<string, Uint8Array>([[songName, new Uint8Array(readFileSync(song))]]);
writeFileSync(out, await saveMap(serializeScenario(scn), { extras, compress: "pkware", listfile: true }));
