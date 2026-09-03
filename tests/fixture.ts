/**
 * Reading a `.scm` / `.scx` for the round-trip test without the editor: the archive
 * through mopaq, the CHK as a flat run of chunks, TRIG (every occurrence, appended —
 * how the game reads a repeated TRIG) and STR (the last occurrence) decoded with the
 * vendored codec. Nothing else in the file is looked at.
 */
import { readFileSync } from "node:fs";
import { Archive } from "mopaq";
import { decodeTriggers, type TriggerRecord } from "../vendor/triggers";

export interface FixtureMap {
  triggers: TriggerRecord[];
  strings: (string | null)[];
}

const latin1 = new TextDecoder("latin1");

/** The CHK's chunks in file order: a name, a signed length, that many bytes (a run past the end keeps what is there). */
export function chunks(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const name = latin1.decode(bytes.subarray(pos, pos + 4));
    const size = view.getInt32(pos + 4, true);
    pos += 8;
    if (size < 0) break;
    const end = Math.min(pos + size, bytes.length);
    out.push({ name, data: bytes.slice(pos, end) });
    pos = end;
  }
  return out;
}

/** STR: a u16 count, u16 offsets, null-terminated latin1 text; index 0 is "no string". */
export function decodeStrings(data: Uint8Array): (string | null)[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 2) return [null];
  const count = view.getUint16(0, true);
  const strings: (string | null)[] = [null];
  for (let i = 1; i <= count; i++) {
    const at = i * 2;
    if (at + 2 > data.length) { strings.push(null); continue; }
    const offset = view.getUint16(at, true);
    if (offset >= data.length) { strings.push(null); continue; }
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    strings.push(latin1.decode(data.subarray(offset, end)));
  }
  return strings;
}

/** The map's triggers and strings, or null when it has no TRIG. */
export async function loadFixture(path: string): Promise<FixtureMap | null> {
  const archive = await Archive.openAsync(new Uint8Array(readFileSync(path)));
  const chk = await archive.readFileAsync("staredit\\scenario.chk");
  const all = chunks(chk);
  const trig = all.filter((c) => c.name === "TRIG");
  if (trig.length === 0) return null;
  const joined = new Uint8Array(trig.reduce((n, c) => n + c.data.length, 0));
  let pos = 0;
  for (const c of trig) { joined.set(c.data, pos); pos += c.data.length; }
  const str = all.filter((c) => c.name === "STR ").at(-1);
  return { triggers: decodeTriggers(joined), strings: str ? decodeStrings(str.data) : [null] };
}
