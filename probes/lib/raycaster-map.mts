// The raycaster's base map (TrigScript 4, S5): 128 × 128, the top 96 rows the board — Badlands tile 23778, white lit,
// grey in fog, black never seen, the widest apart of every tile's minimap colours (S4's survey) — and the 32 rows below
// the start locations and the parked camera, whose box the minimap draws over what is under it. As bad-apple-map.mts,
// without a song.
//
//   npx tsx probes/lib/raycaster-map.mts <out.scx>
//
// Needs a scm-js checkout beside this one with its tileset data (npm run extract).
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const E = process.env.SCMJS_DIR ?? join(import.meta.dirname, "..", "..", "..", "scm-js");
const { createScenario } = await import(join(E, "src/formats/chk/create.ts"));
const { markDirty, serializeScenario } = await import(join(E, "src/formats/chk/scenario.ts"));
const { saveMap } = await import(join(E, "src/formats/mpq/scm.ts"));
const { TILESET_FILENAMES } = await import(join(E, "src/formats/tileset/load.ts"));
const { loadTileset } = await import(join(E, "src/formats/tileset/decode.ts"));
const { baseTerrain, flatTerrain } = await import(join(E, "src/formats/tileset/terrain.ts"));

const [out] = process.argv.slice(2);
if (!out) { console.error("usage: raycaster-map.mts <out.scx>"); process.exit(2); }
const ERA = 0, TILE = 23778, W = 128, H = 128;
const part = (ext: string) => new Uint8Array(readFileSync(join(E, "public/tileset", `${TILESET_FILENAMES[ERA]}.${ext}`)));
const ts = loadTileset({ cv5: part("cv5"), vf4: part("vf4"), vr4: part("vr4"), vx4: part("vx4"), wpe: part("wpe") });
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const flat = flatTerrain(W, H, baseTerrain(ts, 2), ts, rnd, ERA);
const tiles = flat.tiles;
const ground = tiles.slice();
// The board tile everywhere — the view, and the plan under it, need its contrast — but a corner at the bottom right,
// ground the start locations stand on.
tiles.fill(TILE);
for (let y = 112; y < H; y++) for (let x = 104; x < W; x++) tiles[y * W + x] = ground[y * W + x];
const scn = createScenario({
  width: W, height: H, era: ERA, tiles, isom: flat.isom,
  name: "TrigScript raycaster",
  description: "A 3D maze drawn on the minimap with fog of war. Switch to Classic graphics (Options > Graphics) for a sharp minimap. W A S D to walk. Host as multiplayer, alone.",
});
scn.playerTypes = scn.playerTypes.map((t: number, i: number) => (i === 0 ? 6 : i === 1 ? 5 : i < 8 ? 0 : t));
scn.editorPlayerTypes = [...scn.playerTypes];
scn.playerRaces = scn.playerRaces.map((r: number, i: number) => (i === 0 ? 1 : i === 1 ? 0 : i < 8 ? 7 : r));
const start = (owner: number, tx: number, ty: number, serial: number) => ({ classInstance: serial, x: tx * 32 + 16, y: ty * 32 + 16, unitId: 214, relationFlags: 0, validStates: 0, validProperties: 0, owner, hitPointsPercent: 100, shieldPercent: 100, energyPercent: 100, resourceAmount: 0, hangarUnits: 0, stateFlags: 0, unused: 0, relatedSerial: 0 });
scn.units.push(start(0, 110, 120, 1), start(1, 120, 120, 2));
markDirty(scn, "OWNR", "IOWN", "SIDE", "UNIT", "MTXM", "TILE", "ISOM");
writeFileSync(out, await saveMap(serializeScenario(scn), { extras: new Map(), compress: "pkware", listfile: true }));
