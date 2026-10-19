// A map of one tileset for measuring each tile's minimap colour in StarCraft: Remastered, lit and in fog, from a
// recording (probes/tile-survey.ts lights the left half). Remastered draws its minimap from its own art, not from the
// palette colour 1.16.1 picks, so the board tile chosen by the classic survey (Badlands 23778) is dim there.
//
//   npx tsx probes/lib/tile-survey-map.mts <era 0-7> <out.scx>
//
// 88 tiles, each in a block 7 across and 8 down: block i at (2 + 7 * (i % 8), 2 + 8 * floor(i / 8)) in the left half,
// and again 64 tiles to the right. The tiles: the 72 whose art is brightest on average, then 16 spread over the rest,
// so the recording can say how the art's brightness turns into the minimap's. Badlands puts 23778 first, the board
// the fog probes use. Writes <out>.json beside the map: each block's tile id and its art's average luminance.
// Needs a scm-js checkout beside this one with its tileset data (npm run extract).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const E = process.env.SCMJS_DIR ?? join(import.meta.dirname, "..", "..", "..", "scm-js");
const { createScenario } = await import(join(E, "src/formats/chk/create.ts"));
const { markDirty, serializeScenario } = await import(join(E, "src/formats/chk/scenario.ts"));
const { saveMap } = await import(join(E, "src/formats/mpq/scm.ts"));
const { TILESET_FILENAMES } = await import(join(E, "src/formats/tileset/load.ts"));
const { loadTileset } = await import(join(E, "src/formats/tileset/decode.ts"));
const { baseTerrain, flatTerrain } = await import(join(E, "src/formats/tileset/terrain.ts"));

const [eraArg, out] = process.argv.slice(2);
const ERA = Number(eraArg);
if (!(ERA >= 0 && ERA < 8) || !out) { console.error("usage: tile-survey-map.mts <era 0-7> <out.scx>"); process.exit(2); }
const W = 128, H = 128, BLOCKS = 88, BW = 7, BH = 8;
const part = (ext: string) => new Uint8Array(readFileSync(join(E, "public/tileset", `${TILESET_FILENAMES[ERA]}.${ext}`)));
const ts = loadTileset({ cv5: part("cv5"), vf4: part("vf4"), vr4: part("vr4"), vx4: part("vx4"), wpe: part("wpe") });
const P = ts.palette, lum = (c: number) => 0.299 * P[c * 4] + 0.587 * P[c * 4 + 1] + 0.114 * P[c * 4 + 2];

// Every distinct megatile once, by the first tile id that shows it, with its art's average luminance.
const byMega = new Map<number, { tile: number; luminance: number }>();
ts.groups.forEach((g: { megatiles: Uint16Array }, gi: number) => g.megatiles.forEach((mega: number, s: number) => {
  if (mega === 0 || byMega.has(mega)) return;
  let sum = 0;
  for (let k = 0; k < 16; k++) { const mini = ts.megatileRefs[mega * 16 + k] >> 1; for (let p = 0; p < 64; p++) sum += lum(ts.minitiles[mini * 64 + p]); }
  byMega.set(mega, { tile: (gi << 4) | s, luminance: sum / 1024 });
}));
const all = [...byMega.values()].sort((a, b) => b.luminance - a.luminance);
const first = ERA === 0 ? all.filter((t) => t.tile === 23778) : [];
const top = all.filter((t) => !first.includes(t)).slice(0, 72 - first.length);
const rest = all.filter((t) => !first.includes(t) && !top.includes(t));
const spread = Array.from({ length: BLOCKS - 72 }, (_, k) => rest[Math.floor(((k + 0.5) * rest.length) / (BLOCKS - 72))]);
const chosen = [...first, ...top, ...spread];

let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const flat = flatTerrain(W, H, baseTerrain(ts, 2), ts, rnd, ERA);
const tiles = flat.tiles;
// The board's top 96 rows: the blocks, and the first tile between and around them; below, ground for the start locations.
for (let y = 0; y < 96; y++) for (let x = 0; x < W; x++) tiles[y * W + x] = chosen[0].tile;
chosen.forEach((t, i) => {
  const bx = 2 + BW * (i % 8), by = 2 + BH * Math.floor(i / 8);
  for (const half of [0, 64]) for (let y = by; y < by + BH; y++) for (let x = bx + half; x < bx + half + BW; x++) tiles[y * W + x] = t.tile;
});
const scn = createScenario({
  width: W, height: H, era: ERA, tiles, isom: flat.isom,
  name: `Tile survey: ${TILESET_FILENAMES[ERA]}`,
  description: "Each tile's minimap colour, lit (left) and in fog (right). Host as multiplayer, alone, with Remastered graphics.",
});
scn.playerTypes = scn.playerTypes.map((t: number, i: number) => (i === 0 ? 6 : i === 1 ? 5 : i < 8 ? 0 : t));
scn.editorPlayerTypes = [...scn.playerTypes];
scn.playerRaces = scn.playerRaces.map((r: number, i: number) => (i === 0 ? 1 : i === 1 ? 0 : i < 8 ? 7 : r));
const start = (owner: number, tx: number, ty: number, serial: number) => ({ classInstance: serial, x: tx * 32 + 16, y: ty * 32 + 16, unitId: 214, relationFlags: 0, validStates: 0, validProperties: 0, owner, hitPointsPercent: 100, shieldPercent: 100, energyPercent: 100, resourceAmount: 0, hangarUnits: 0, stateFlags: 0, unused: 0, relatedSerial: 0 });
scn.units.push(start(0, 110, 120, 1), start(1, 120, 120, 2));
markDirty(scn, "OWNR", "IOWN", "SIDE", "UNIT", "MTXM", "TILE", "ISOM");
writeFileSync(out, await saveMap(serializeScenario(scn), { extras: new Map(), compress: "pkware", listfile: true }));
writeFileSync(`${out}.json`, JSON.stringify({ era: ERA, tileset: TILESET_FILENAMES[ERA], blocks: chosen.map((t) => ({ tile: t.tile, luminance: Math.round(t.luminance * 10) / 10 })) }));
console.log(`${TILESET_FILENAMES[ERA]}: ${chosen.length} tiles, art luminance ${chosen[0].luminance.toFixed(0)} … ${chosen[chosen.length - 1].luminance.toFixed(0)}`);
