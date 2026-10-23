//   npx tsx probes/lib/fog-base-map.mts <out.scx>    (needs a scm-js checkout beside this one with its tileset data)
// A 128 × 96 Ice map of snow alone, for the fog probe: one tile a minimap pixel, 4:3, no high ground.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const E = process.env.HOME + "/github/scm-js";
const { createScenario } = await import(join(E, "src/formats/chk/create.ts"));
const { markDirty, serializeScenario } = await import(join(E, "src/formats/chk/scenario.ts"));
const { saveMap } = await import(join(E, "src/formats/mpq/scm.ts"));
const { TILESET_FILENAMES } = await import(join(E, "src/formats/tileset/load.ts"));
const { loadTileset } = await import(join(E, "src/formats/tileset/decode.ts"));
const { baseTerrain, flatTerrain } = await import(join(E, "src/formats/tileset/terrain.ts"));
const ERA = 6, W = 128, H = 96;
const part = (ext: string) => new Uint8Array(readFileSync(join(E, "public/tileset", `${TILESET_FILENAMES[ERA]}.${ext}`)));
const ts = loadTileset({ cv5: part("cv5"), vf4: part("vf4"), vr4: part("vr4"), vx4: part("vx4"), wpe: part("wpe") });
const terrain = baseTerrain(ts, 2); // Snow
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const { tiles, isom } = flatTerrain(W, H, terrain, ts, rnd, ERA);
const scn = createScenario({ width: W, height: H, era: ERA, name: "TrigScript S4: fog probe", description: "Fog of war as a picture. Host as multiplayer, alone.", tiles, isom });
scn.playerTypes = scn.playerTypes.map((t: number, i: number) => (i === 0 ? 6 : i === 1 ? 5 : i < 8 ? 0 : t));
scn.editorPlayerTypes = [...scn.playerTypes];
scn.playerRaces = scn.playerRaces.map((r: number, i: number) => (i === 0 ? 1 : i === 1 ? 0 : i < 8 ? 7 : r));
const start = (owner: number, tx: number, ty: number, serial: number) => ({ classInstance: serial, x: tx * 32 + 16, y: ty * 32 + 16, unitId: 214, relationFlags: 0, validStates: 0, validProperties: 0, owner, hitPointsPercent: 100, shieldPercent: 100, energyPercent: 100, resourceAmount: 0, hangarUnits: 0, stateFlags: 0, unused: 0, relatedSerial: 0 });
scn.units.push(start(0, 8, 88, 1), start(1, 118, 88, 2));
markDirty(scn, "OWNR", "IOWN", "SIDE", "UNIT", "MTXM", "TILE", "ISOM");
writeFileSync(process.argv[2], await saveMap(serializeScenario(scn), { extras: new Map(), compress: "pkware", listfile: true }));
console.log("terrain", terrain, "first tiles", [...tiles.slice(0, 4)].map((t: number) => t.toString(16)));
