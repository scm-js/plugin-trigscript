// Writes the Bad Apple map's eudplib (TrigScript 4, S4): the encoder's brushes (probes/lib/bad-apple-encode.mts) as
// a table in the map, played one frame of video a game frame, with the song started on the video's first frame.
//
//   npx tsx probes/lib/bad-apple-gen.mts <brushes.bin> <out.py> <song name in the archive> [sound lead in frames]
//   EXTRA_PLUGIN=badApple=<out.py> EXTRA_FILE=badapple.b64=<out.py>.b64 \
//     npx tsx scripts/build-fixture.mts probes/bad-apple.ts <map.scx> <base.scx>
// The table goes in as a data file beside the source (<out.py>.b64): a plugin's source may hold 512 KB at most.
//
// The table and the song are not ours and never committed; this file, the encoder and the map's base are.
// How it draws (played in Remastered 2026-10-17, see docs/v4-plan.md S4): every brush is a unit made on its tile and
// removed in the same trigger pass — the tiles it revealed stay lit through the draw — and the vision countdown
// (1.16.1 0x51CE98) is written to 1 after the pass, so the next frame starts from a wiped board. Each brush size is a
// unit type of its own whose sight is written every frame and never changed within a pass (Remastered takes a sight
// write a frame late).
import { readFileSync, writeFileSync } from "node:fs";
import { encodeFrame, unpack, W, H } from "./bad-apple-encode.mts";

const [input, out, songName, leadArg] = process.argv.slice(2);
if (!input || !out || !songName) { console.error("usage: bad-apple-gen.mts <brushes.bin> <out.py> <song name> [lead]"); process.exit(2); }
const LEAD = Number(leadArg ?? 0);

/** Brush size → the unit that draws it: a ground unit at sight 0 for the 3 × 3, flyers for the air shapes. */
const TYPES: [string, number][] = [
  ["Terran Marine", 0], ["Zerg Scourge", 47], ["Zerg Mutalisk", 43], ["Terran Wraith", 8], ["Terran Valkyrie", 58],
  ["Protoss Corsair", 60], ["Terran Dropship", 11], ["Protoss Shuttle", 69], ["Zerg Guardian", 44],
  ["Zerg Devourer", 62], ["Terran Science Vessel", 9], ["Terran Battlecruiser", 12],
];

const frames = unpack(readFileSync(input));
const words: number[] = [];
// The whole board lit once before the video, so every tile is "explored" and a dark part of a frame is fog grey
// everywhere (round 2: a board lit only in places came out a patchwork of black and grey).
const lightAll = words.length;
for (const w of encodeFrame(new Uint8Array(W * H).fill(1))) words.push(w);
words.push(0xffffffff);
const video = words.length;
for (const f of frames) { for (const w of f) words.push(w); words.push(0xffffffff); }
words.push(0xfffffffe);
const data = Buffer.from(Uint32Array.from(words).buffer).toString("base64");

const F0 = 240;   // 10 seconds to switch to Classic graphics
const sightWrites = TYPES.map(([, id], size) => `SetMemoryX(0x663238 + ${id & ~3}, SetTo, ${size << (8 * (id & 3))}, ${0xff << (8 * (id & 3))})`);
const py = `"""
[badApple]

Bad Apple!! in the fog of war (TrigScript 4, S4). Hand-written eudplib, made by probes/lib/bad-apple-gen.mts from
${frames.length} frames of video, ${words.length - frames.length - 2} brushes. The video starts at frame ${F0}, the song at frame ${F0 + LEAD}.
"""
import base64
from eudplib import *

LOC = "Pixel"
COUNTDOWN = 0x51CE98
SONG = ${JSON.stringify(songName)}
DATA = Db(base64.b64decode(open("/work/files/badapple.b64").read()))

f = EUDVariable()
p = EUDVariable()
playing = EUDVariable()


def u(s):
    return s.encode("utf-8")


def show(s):
    DoActions(DisplayText(u(s)))


@EUDFunc
def brush(x, y, size):
    left = x * 32
    top = y * 32
    f_setloc(LOC, left, top, left + 32, top + 32)
    EUDSwitch(size)
${TYPES.map(([name], size) => `    if EUDSwitchCase()(${size}):\n        DoActions([CreateUnit(1, "${name}", LOC, P1), RemoveUnit("${name}", P1)])\n        EUDBreak()`).join("\n")}
    EUDEndSwitch()


@EUDFunc
def paint(start):
    q = EUDVariable()
    q << start
    if EUDInfLoop()():
        v = f_dwread_epd(q)
        EUDBreakIf(v >= 0xFFFFFFFE)
        q += 1
        w0, w1, bx, by, bs, b3 = f_dwbreak(v)
        brush(bx, by, bs)
    EUDEndInfLoop()
    EUDReturn(q)


def at(n):
    return EUDIf()(f == n)


def afterTriggerExec():
    f.__iadd__(1)
    DoActions([
${sightWrites.map((s) => `        ${s},`).join("\n")}
    ])
    if at(1):
        DoActions([RemoveUnit("(any unit)", P1), RemoveUnit("(any unit)", P2)])
        f_setloc(LOC, 64 * 32, 112 * 32, 64 * 32 + 32, 112 * 32 + 32)
        DoActions(CenterView(LOC))
        show("\\x04Bad Apple!! in the fog of war. The video plays on the MINIMAP.")
        show("\\x11Switch to Classic graphics now (Options > Graphics) for a sharp minimap.")
    EUDEndIf()
    if at(2):
        paint(EPD(DATA) + ${lightAll})
    EUDEndIf()
${[5, 4, 3, 2, 1].map((s) => `    if at(${F0 - s * 24}):\n        show("\\x04Starting in ${s}...")\n    EUDEndIf()`).join("\n")}
    if at(${F0 + LEAD}):
        DoActions(PlayWAV(SONG))
    EUDEndIf()
    if at(${F0}):
        p << EPD(DATA) + ${video}
        playing << 1
    EUDEndIf()
    if EUDIf()(playing == 1):
        q = paint(p)
        if EUDIf()(f_dwread_epd(q) == 0xFFFFFFFE):
            playing << 0
            show("\\x04Fin.")
        if EUDElse()():
            p << q + 1
        EUDEndIf()
    EUDEndIf()
    DoActions(SetMemory(COUNTDOWN, SetTo, 1))
`;
writeFileSync(out, py);
writeFileSync(`${out}.b64`, data);
console.log(`${frames.length} frames, ${words.length * 4} bytes of table, video from frame ${F0}, song from ${F0 + LEAD}`);
