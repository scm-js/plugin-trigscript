/**
 * A scenario of the few sections the own build reads, for the tests: 64 × 64, P1 human and P2 computer in forces of
 * their own, a string table (STR unless `extended`), a trigger list, a placed unit with a flag at odds with its
 * figure, a null tile, a UNIx row at the defaults with a setting left in. Shared by `own-build.test.ts` and the random
 * scripts (`random-scripts.test.ts`).
 */
import { writeChunks, writeStrings } from "../compiler/backend/chk";
import { encodeTriggers, type TriggerRecord } from "../vendor/triggers";

export const u16 = (...v: number[]) => new Uint8Array(v.flatMap((x) => [x & 0xff, (x >> 8) & 0xff]));

export function scenario(opts: { strings?: string[]; triggers?: TriggerRecord[]; extended?: boolean; version?: number } = {}): Uint8Array {
  const strings = { entries: (opts.strings ?? ["Probe", "P1 says hi"]).map((s) => new TextEncoder().encode(s)) };
  const str = opts.extended ? writeStrings(strings).data : (() => {
    const count = strings.entries.length;
    const header = 2 * (1 + count);
    const size = header + strings.entries.reduce((n, e) => n + e.length + 1, 0);
    const data = new Uint8Array(size);
    const view = new DataView(data.buffer);
    view.setUint16(0, count, true);
    let at = header;
    strings.entries.forEach((e, i) => { view.setUint16(2 * (1 + i), at, true); data.set(e, at); at += e.length + 1; });
    return data;
  })();
  const ownr = new Uint8Array(12); ownr[0] = 6; ownr[1] = 5;
  const forc = new Uint8Array(20); forc[1] = 1;
  const mtxm = new Uint8Array(64 * 64 * 2).fill(1); mtxm[2 * 5] = 0; mtxm[2 * 5 + 1] = 0;
  // One Marine of P1: hit points 100 % with the flag set (at odds), energy flag clear with a figure left in.
  const unit = new Uint8Array(36); const uv = new DataView(unit.buffer);
  uv.setUint16(8, 0, true); uv.setUint16(14, 2, true); unit[16] = 0; unit[17] = 100; unit[19] = 50;
  // UNIx: row 7 at the defaults (byte 1) with its hit points left in.
  const unix = new Uint8Array(228 + 228 * (4 + 2 + 1 + 2 + 2 + 2 + 2)); unix[7] = 1; unix[228 + 4 * 7] = 40;
  return writeChunks([
    { name: "VER ", data: u16(opts.version ?? 59) },
    { name: "DIM ", data: u16(64, 64) },
    { name: "OWNR", data: ownr },
    { name: "FORC", data: forc },
    { name: opts.extended ? "STRx" : "STR ", data: str },
    { name: "MTXM", data: mtxm },
    { name: "UNIT", data: unit },
    { name: "UNIx", data: unix },
    { name: "UPRP", data: new Uint8Array(64 * 20) },
    { name: "UPUS", data: new Uint8Array(64) },
    { name: "TRIG", data: encodeTriggers(opts.triggers ?? []) },
  ]);
}
