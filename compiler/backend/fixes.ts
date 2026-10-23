/**
 * What eudplib does to a map's sections before it writes them (`eudplib/core/mapdata/fixmapdata.py`), done here to the
 * CHK a map of our own is built from, so that a map built either way is the same map (TrigScript 4, step 14):
 *
 * - UNIT: a placed unit's flags for a figure left at its default are cleared, and a figure whose flag is clear is
 *   zeroed, so that the record says one thing.
 * - UNIx, UPGx, TECx: a row that says "use the defaults" has its settings zeroed.
 * - VER: 206, a Remastered file (the programs' payload is laid out where Remastered keeps the strings).
 * - MTXM: a tile of 0 (null terrain) is made tile 1 — by eudplib's account, null tiles desync a game.
 *
 * Each says in a line what it changed, when it changed anything.
 */
import type { Sections } from "./chk";

export const REMASTERED_VERSION = 206;

export function fixMap(s: Sections): string[] {
  return [...fixUnits(s), ...fixSettings(s), ...makeRemastered(s), ...fixNullTiles(s)];
}

function fixUnits(s: Sections): string[] {
  const had = s.get("UNIT");
  if (!had) return [];
  const unit = had.slice();
  let changed = 0;
  for (let i = 0; i + 36 <= unit.length; i += 36) {
    const before = unit.slice(i, i + 36);
    // A figure at its default needs no flag: 100 % hit points or shields, no hangar units, a state not valid.
    if (unit[i + 17] === 100) unit[i + 14] &= ~2;
    if (unit[i + 18] === 100) unit[i + 14] &= ~4;
    if (unit[i + 24] === 0 && unit[i + 25] === 0) unit[i + 14] &= ~32;
    for (let k = 0; k < 5; k++) if ((unit[i + 26] & (1 << k)) === 0) unit[i + 12] &= ~(1 << k);
    // A figure whose flag is clear is nothing.
    if ((unit[i + 14] & 2) === 0) unit[i + 17] = 0;
    if ((unit[i + 14] & 4) === 0) unit[i + 18] = 0;
    if ((unit[i + 14] & 8) === 0) unit[i + 19] = 0;
    if ((unit[i + 14] & 16) === 0) unit.fill(0, i + 20, i + 24);
    if ((unit[i + 14] & 32) === 0) unit.fill(0, i + 24, i + 26);
    for (let k = 0; k < 5; k++) if ((unit[i + 12] & (1 << k)) === 0) unit[i + 26] &= ~(1 << k);
    if (before.some((b, k) => b !== unit[i + k])) changed++;
  }
  if (!changed) return [];
  s.set("UNIT", unit);
  return [`${changed} placed unit${changed === 1 ? "" : "s"} with a figure's flag at odds with the figure: made to agree (UNIT)`];
}

const TABLES: [name: string, count: number, settings: number[], pad: number][] = [
  ["UNIx", 228, [4, 2, 1, 2, 2, 2, 2], 0],
  ["UPGx", 61, [2, 2, 2, 2, 2, 2], 1],
  ["TECx", 44, [2, 2, 2, 2], 0],
];

function fixSettings(s: Sections): string[] {
  const lines: string[] = [];
  for (const [name, count, settings, pad] of TABLES) {
    const had = s.get(name);
    if (!had) continue;
    const data = had.slice();
    let changed = 0;
    for (let i = 0; i < count && i < data.length; i++) {
      if (data[i] === 0) continue;
      let offset = count + pad;
      let touched = false;
      for (const width of settings) {
        for (let k = 0; k < width; k++) {
          const at = offset + width * i + k;
          if (at < data.length && data[at] !== 0) { data[at] = 0; touched = true; }
        }
        offset += width * count;
      }
      if (touched) changed++;
    }
    if (!changed) continue;
    s.set(name, data);
    lines.push(`${changed} row${changed === 1 ? "" : "s"} of ${name.trim()} at the defaults with settings left in: zeroed`);
  }
  return lines;
}

function makeRemastered(s: Sections): string[] {
  const ver = s.get("VER ");
  const was = ver && ver.length >= 2 ? ver[0] | (ver[1] << 8) : 0;
  if (was === REMASTERED_VERSION) return [];
  s.set("VER ", new Uint8Array([REMASTERED_VERSION & 0xff, REMASTERED_VERSION >> 8]));
  return [`a Remastered file (VER ${REMASTERED_VERSION}, was ${was}): a map with a program plays on StarCraft: Remastered`];
}

function fixNullTiles(s: Sections): string[] {
  const had = s.get("MTXM");
  if (!had) return [];
  const mtxm = had.slice();
  const dim = s.get("DIM ");
  const width = dim && dim.length >= 2 ? dim[0] | (dim[1] << 8) : 0;
  const at: string[] = [];
  for (let i = 0; i + 2 <= mtxm.length; i += 2) {
    if (mtxm[i] !== 0 || mtxm[i + 1] !== 0) continue;
    mtxm[i] = 1;
    const tile = i / 2;
    at.push(width ? `(${tile % width}, ${Math.floor(tile / width)})` : String(tile));
  }
  if (!at.length) return [];
  s.set("MTXM", mtxm);
  return [`${at.length} null tile${at.length === 1 ? "" : "s"} (0000.00) made 0000.01, as eudplib does — they desync a game: at ${at.slice(0, 12).join(", ")}${at.length > 12 ? ", …" : ""}`];
}
