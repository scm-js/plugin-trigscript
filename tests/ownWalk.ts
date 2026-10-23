/**
 * A built map of our own walked as the game walks its triggers, from the scenario's bytes alone (TrigScript 4, step
 * 15: a built map tested end to end where no lifted game is, in CI). The payload is read out of the STRx section, each
 * player's list walked from their entry every frame with the current player theirs, and what Display Text shows is
 * read from the map's own string table — so what comes out is what the file holds, not what the layout meant.
 * The game's conditions and actions a map of our own uses are modelled as `tests/emitter.test.ts`'s walker models
 * them: Deaths and Set Deaths (masked too), Always, Never, Switch, Set Switch, Display Text, Preserve Trigger,
 * Comment, Play WAV; Create Unit with Properties and Give Units are passed over.
 */
import { Sections } from "../compiler/backend/chk";
import { STRINGS } from "../compiler/backend/layout";
import { GAME_TICK } from "../compiler/backend/emit";

const DEATHS = 0x58a364;
const CURRENT_PLAYER = 0x6509b0;
const SWITCHES = 0x58dc40;
const U32 = 2 ** 32;
const u = (n: number) => ((n % U32) + U32) % U32;

export interface Walked {
  /** What was shown, in order, each with the frame it was shown in (frames from 1). */
  printed: { frame: number; text: string }[];
  /** The game's memory as the walk left it: a dword at an address — inside the payload or out of it. */
  read(address: number): number;
  /** A byte of it. */
  byte(address: number): number;
  /** `programVariables`' view of the memory. */
  memory: { m: DataView; u8: Uint8Array };
}

/** `entries`: where each player's entry is (`OwnBuildStats.entries`), `players` who they are; `memory`: the game's dwords to start from. */
export function walkBuiltMap(chk: Uint8Array, players: number[], entries: number[], frames: number, memory?: Map<number, number>): Walked {
  const s = new Sections(chk);
  const strx = s.get("STRx");
  if (!strx) throw new Error("the map has no STRx");
  // The whole section is at STRINGS: the strings, then the payload.
  const section = strx.slice();
  const dv = new DataView(section.buffer);
  const inside = (a: number) => a >= STRINGS && a + 4 <= STRINGS + section.length;
  const game = new Map<number, number>(memory);
  const rd = (a: number) => (inside(a) ? dv.getUint32(a - STRINGS, true) : game.get(a) ?? 0);
  const wr = (a: number, v: number) => (inside(a) ? dv.setUint32(a - STRINGS, u(v), true) : game.set(a, u(v)));
  const byte = (a: number) => (inside(a) ? dv.getUint8(a - STRINGS) : (game.get(a & ~3) ?? 0) >>> (8 * (a & 3)) & 0xff);
  const u16 = (a: number) => dv.getUint16(a - STRINGS, true);
  const at = (epd: number) => u(DEATHS + 4 * (epd === 13 ? rd(CURRENT_PLAYER) : epd));
  const switchAt = (sw: number): [number, number] => [SWITCHES + 4 * (sw >> 5), 2 ** (sw & 31)];
  const stringCount = dv.getUint32(0, true);
  const stringAt = (index: number): string => {
    if (index < 1 || index > stringCount) return `string ${index}`;
    const start = STRINGS + dv.getUint32(4 * index, true);
    const out: number[] = [];
    for (let a = start; inside(a) && byte(a) !== 0; a++) out.push(byte(a));
    return new TextDecoder().decode(new Uint8Array(out)).replace(/\r/g, "");
  };
  const printed: { frame: number; text: string }[] = [];
  for (let frame = 1; frame <= frames; frame++) {
    game.set(GAME_TICK, frame);
    entries.forEach((start, w) => {
      wr(CURRENT_PLAYER, players[w]);
      let pc = start;
      for (let steps = 0; !(pc & 0x80000000); steps++) {
        if (steps > 50_000_000) throw new Error("the payload does not end");
        if (!inside(pc)) throw new Error(`the walk left the payload: 0x${pc.toString(16)}`);
        let holds = (rd(pc + 2376) & 8) === 0;
        for (let k = 0; holds && k < 16; k++) {
          const o = pc + 8 + 20 * k, kind = byte(o + 15);
          if (byte(o + 17) & 2) continue;
          if (kind === 0) break;
          if (kind === 22) continue;
          if (kind === 23) { holds = false; continue; }
          if (kind === 11) {
            const [addr, bit] = switchAt(byte(o + 16));
            holds = byte(o + 14) === 2 ? (rd(addr) & bit) !== 0 : (rd(addr) & bit) === 0;
            continue;
          }
          if (kind !== 15) throw new Error(`condition kind ${kind} at 0x${o.toString(16)}`);
          const d = at(rd(o + 4)) + 48 * u16(o + 12);
          const masked = u16(o + 18) === 0x4353;
          const x = masked ? (rd(d) & rd(o)) >>> 0 : rd(d), y = rd(o + 8), compare = byte(o + 14);
          holds = compare === 0 ? x >= y : compare === 1 ? x <= y : x === y;
        }
        for (let k = 0; holds && k < 64; k++) {
          const o = pc + 328 + 32 * k, kind = byte(o + 26);
          if (byte(o + 28) & 2) continue;
          if (kind === 0) break;
          if (kind === 9) { printed.push({ frame, text: stringAt(rd(o + 4)) }); continue; }
          if (kind === 13) {
            const [addr, bit] = switchAt(rd(o + 20)), modifier = byte(o + 27);
            const on = modifier === 4 ? true : modifier === 5 ? false : modifier === 6 ? (rd(addr) & bit) === 0 : modifier === 11 ? Math.random() < 0.5 : null;
            if (on === null) throw new Error(`Set Switch ${modifier}`);
            wr(addr, on ? (rd(addr) | bit) >>> 0 : (rd(addr) & ~bit) >>> 0);
            continue;
          }
          if (kind === 3) { wr(pc + 2376, rd(pc + 2376) | 4); continue; }
          if (kind === 47 || kind === 8 || kind === 11 || kind === 48) continue;
          if (kind !== 45) throw new Error(`action kind ${kind} at 0x${o.toString(16)}`);
          const dest = at(rd(o + 16)) + 48 * u16(o + 24), value = rd(o + 20), modifier = byte(o + 27), old = rd(dest);
          if (u16(o + 30) === 0x4353) {
            const m = rd(o), f = (old & m) >>> 0, w = (value & m) >>> 0;
            const next = modifier === 7 ? w : modifier === 8 ? u(f + w) : Math.max(0, f - w);
            wr(dest, ((old & ~m) | (next & m)) >>> 0);
            continue;
          }
          wr(dest, modifier === 7 ? value : modifier === 8 ? u(old + value) : Math.max(0, old - value));
        }
        if (holds && !(rd(pc + 2376) & 4)) wr(pc + 2376, rd(pc + 2376) | 8);
        pc = rd(pc + 4);
      }
    });
  }
  // A memory for `programVariables`: the section where it is, everything else from the game's dwords.
  const m = {
    getUint32: (a: number) => rd(a),
    getUint8: (a: number) => byte(a),
  } as unknown as DataView;
  const u8 = new Proxy(new Uint8Array(0), {
    get: (_, key) => {
      if (key === "length") return 2 ** 32;
      if (key === "subarray") return (from: number, to: number) => Uint8Array.from({ length: Math.max(0, to - from) }, (_x, i) => byte(from + i));
      return typeof key === "string" && /^\d+$/.test(key) ? byte(Number(key)) : undefined;
    },
  }) as Uint8Array;
  return { printed, read: rd, byte, memory: { m, u8 } };
}
