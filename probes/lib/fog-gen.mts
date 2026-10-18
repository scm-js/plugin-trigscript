// Writes the S4 fog probe: fog-probe.py (hand-written eudplib, every step) beside fog-probe.ts (an empty program,
// so the map has TrigScript's every-frame triggers), and with FOG_EXPECT what each picture should light.
//   npx tsx probes/lib/fog-gen.mts [unit]     unit defaults to "Map Revealer"; "Zerg Overlord" for a run in the lifted game,
//                                            which (as 1.16.1) never keeps a Map Revealer made by a trigger.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameFromSvg, cover } from "./fog-encode.mts";

const UNIT = process.argv[2] ?? "Map Revealer";
const OUT = join(import.meta.dirname, "..");
const UNIT_ID = ({ "Map Revealer": 101, "Zerg Overlord": 42 } as Record<string, number>)[UNIT];
const W = 128, H = 96;
const svg = (body: string, bg = "white", fg = "black") => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384"><rect width="512" height="384" fill="${bg}"/><g fill="${fg}" stroke="${fg}">${body}</g></svg>`;
const dancer = (dx = 0, lift = 0) => `<g transform="translate(${dx} 0)"><circle cx="250" cy="70" r="34"/><path d="M220 60 Q150 40 110 ${90 - lift} Q160 70 215 85 Z"/><path d="M270 50 Q340 20 400 ${60 - lift} Q340 55 280 75 Z" />
<path d="M230 100 L275 100 L290 210 L215 210 Z"/><path d="M215 200 L300 200 L350 290 L170 290 Z"/>
<path d="M232 110 L140 ${160 - lift} L120 ${150 - lift}" fill="none" stroke-width="14"/><path d="M272 110 L360 ${80 + lift} L420 ${40 + lift}" fill="none" stroke-width="6"/>
<path d="M220 290 L205 370 M265 290 L300 370" fill="none" stroke-width="16"/></g>`;
const apple = (s = 1, cx = 256, cy = 192) => `<g transform="translate(${cx} ${cy}) scale(${s}) translate(-256 -192)"><path d="M256 110 C 190 60 110 120 140 220 C 160 300 220 330 256 300 C 292 330 352 300 372 220 C 402 120 322 60 256 110 Z"/><path d="M256 110 Q 250 70 280 40" fill="none" stroke-width="10"/><path d="M262 80 Q 310 40 340 70 Q 300 90 262 80 Z"/></g>`;

type Brush = [number, number, number];
const words: number[] = [];
const expect: Record<string, { brushes: number; white: number; missed: number; covered: string }> = {};
const packed = (c: Uint8Array) => Buffer.from(c).toString("base64");
async function picture(name: string, s: string): Promise<number> {
  const white = await frameFromSvg(s);
  const r = cover(white, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const start = words.length;
  // Sorted by size, so the sight byte changes as few times as it can (it is written for every brush anyway).
  const list: Brush[] = r.chosen.map((c) => [c.x, c.y, c.r] as Brush).sort((a, b) => a[2] - b[2]);
  for (const [x, y, rr] of list) words.push(x | (y << 8) | (rr << 16));
  words.push(0xffffffff);
  expect[name] = { brushes: list.length, white: r.whites, missed: r.missed, covered: packed(r.covered) };
  return start;
}

const pics = {
  dancer: await picture("dancer", svg(dancer())),
  apple: await picture("apple", svg(apple())),
  text: await picture("text", svg(`<text x="20" y="230" font-family="sans-serif" font-weight="bold" font-size="120">Bad Apple</text>`)),
  inverted: await picture("inverted", svg(dancer(), "black", "white")),
};
const ANIM_FRAMES = 72;
const animStart = words.length;
for (let i = 0; i < ANIM_FRAMES; i++) {
  const t = i / ANIM_FRAMES, wave = Math.sin(t * 2 * Math.PI);
  await picture(`anim${i}`, svg(dancer(-120 + 120 * wave, 30 * wave) + apple(0.35 + 0.1 * Math.cos(t * 4 * Math.PI), 420, 300)));
}
words.push(0xfffffffe);
const brushCounts = Object.entries(expect).filter(([k]) => k.startsWith("anim")).map(([, v]) => v.brushes);
console.log("pictures", Object.fromEntries(Object.entries(expect).filter(([k]) => !k.startsWith("anim")).map(([k, v]) => [k, v.brushes])), "animation brushes", Math.min(...brushCounts), "–", Math.max(...brushCounts), "data", words.length * 4, "bytes");

// Sizes 1–11 in two rows, three tiles apart.
const rowC: Brush[] = [];
let x = 4;
for (const r of [1, 2, 3, 4, 5, 6]) { const w = 2 * r + 1; rowC.push([x + r, 22, r]); x += w + 4; }
x = 4;
for (const r of [7, 8, 9, 10, 11]) { const w = 2 * r + 1; rowC.push([x + r, 64, r]); x += w + 4; }

const STEPS = { A: 48, B: 288, C: 528, D: 768, E: 1008, F: 1488, G: 1968, H: 2448, END: 2688 };
const hex = Buffer.from(Uint32Array.from(words).buffer).toString("hex");
const py = `"""
[fogSpike]

The fog probe (TrigScript 4, S4): fog of war as a picture. Hand-written eudplib, made by probes/lib/fog-gen.mts. A brush is a
${UNIT} made on a tile and taken away in the same trigger pass, its sight range written just before it is made;
the vision countdown (1.16.1 0x51CE98) is written to 1 after each pass, so the next frame starts from a wiped board.

  A   2  one brush jumping between two places, countdown written: does the old place go dark at once?
  B  12  the same with the countdown NOT written: the old place should stay lit for up to four seconds
  C  22  the sizes, sight 1 to 6 (top row) and 7 to 11 (lower row), redrawn every frame
  D  32  one brush sliding a tile a frame: smooth, smeared, or trailing?
  E  42  four pictures, five seconds each: a dancer, an apple, "Bad Apple", the dancer white on black
  F  62  an animation (the dancer swaying, an apple pulsing), 72 frames looped
  G  82  the dancer painted 1, 2, 4 then 8 times a frame (5 seconds each): when does the game stutter?
  H 102  ground revealers (top row: sight 0, sight 1) beside air ones (lower row: sight 1)
"""
from eudplib import *

UNIT = "${UNIT}"
LOC = "Pixel"
SIGHT_EPD = EPD(0x663238 + ${UNIT_ID & ~3})   # units.dat sight range: the unit (${UNIT_ID}) is byte ${UNIT_ID & 3} of this dword
SIGHT_SUBP = ${UNIT_ID & 3}
FLAGS_UNIT = 0x664080 + ${UNIT_ID} * 4   # units.dat flags of the unit; 0x4 = flyer
COUNTDOWN = 0x51CE98
DATA = Db(bytes.fromhex("${hex}"))
PICS = ${JSON.stringify(pics)}
ANIM = ${animStart}

f = EUDVariable()
anim = EUDVariable()
mv = EUDVariable()
toggle = EUDVariable()
tick = EUDVariable()


def u(s):
    return s.encode("utf-8")


def show(s):
    DoActions(DisplayText(u(s)))


@EUDFunc
def brush(x, y, r):
    left = x * 32
    top = y * 32
    f_setloc(LOC, left, top, left + 32, top + 32)
    f_bwrite_epd(SIGHT_EPD, SIGHT_SUBP, r)
    DoActions([CreateUnit(1, UNIT, LOC, P1), RemoveUnit(UNIT, P1)])


@EUDFunc
def paint(start):
    p = EUDVariable()
    p << start
    if EUDInfLoop()():
        v = f_dwread_epd(p)
        EUDBreakIf(v == 0xFFFFFFFF)
        p += 1
        w0, w1, bx, by, br, b3 = f_dwbreak(v)
        brush(bx, by, br)
    EUDEndInfLoop()
    EUDReturn(p + 1)


def center(tx, ty):
    f_setloc(LOC, tx * 32, ty * 32, tx * 32 + 32, ty * 32 + 32)
    DoActions(CenterView(LOC))


def during(a, b):
    return EUDIf()([f >= a, f < b])


def at(n):
    return EUDIf()(f == n)


def afterTriggerExec():
    f.__iadd__(1)
    if at(1):
        DoActions([RemoveUnit("(any unit)", P1), RemoveUnit("(any unit)", P2)])
        center(64, 48)
        show("\\x04S4 fog probe. Watch the screen and the minimap; each step says what to look for.")
    EUDEndIf()
    # The questions, again half way through each step (lines fade after a few seconds).
${Object.entries({
    A: "A: one brush jumping between two places every half second. Does the old place go dark AT ONCE (screen and minimap)?",
    B: "B: the same, the countdown NOT written. The old place should stay lit for up to four seconds.",
    C: "C: brush sizes. Minimap: sight 1-6 top row, 7-11 lower row. Clean shapes? Same size each frame?",
    D: "D: one brush sliding a tile a frame. Smooth? Smeared? A trail behind it?",
    E: "E: pictures, 5 s each: dancer, apple, 'Bad Apple', dancer white on black. How do they read on the minimap? On screen?",
    F: "F: an animation, 72 frames looped. Smooth? Flicker? Tearing?",
    G: "G: the dancer painted 1x, 2x, 4x, 8x a frame, 5 s each. When does the game slow down or stutter?",
    H: "H: top row ground revealers (sight 0 then 1), lower row air (sight 1). Ground sight 0 should be a 3x3 square.",
  }).map(([k, text]) => { const s = STEPS[k as keyof typeof STEPS]; return `    if EUDIf()([f.Exactly(${s})]):\n        show(${JSON.stringify("\x11" + text)})\n    EUDEndIf()\n    if EUDIf()([f.Exactly(${s + 120})]):\n        show(${JSON.stringify("\x11" + text)})\n    EUDEndIf()`; }).join("\n")}
    # A and B: toggle every 12 frames.
    if during(${STEPS.A}, ${STEPS.C}):
        tick.__iadd__(1)
        if EUDIf()(tick >= 12):
            tick << 0
            toggle << 1 - toggle
        EUDEndIf()
        if EUDIf()(toggle == 0):
            brush(56, 48, 5)
        if EUDElse()():
            brush(72, 48, 5)
        EUDEndIf()
    EUDEndIf()
    if during(${STEPS.C}, ${STEPS.D}):
${rowC.map(([x, y, r]) => `        brush(${x}, ${y}, ${r})`).join("\n")}
    EUDEndIf()
    if during(${STEPS.D}, ${STEPS.E}):
        mv.__iadd__(1)
        if EUDIf()(mv >= 116):
            mv << 0
        EUDEndIf()
        brush(mv + 6, 48, 6)
    EUDEndIf()
${(["dancer", "apple", "text", "inverted"] as const).map((k, i) => `    if during(${STEPS.E + i * 120}, ${STEPS.E + (i + 1) * 120}):\n        paint(EPD(DATA) + ${pics[k]})\n    EUDEndIf()`).join("\n")}
    if at(${STEPS.F}):
        anim << EPD(DATA) + ANIM
    EUDEndIf()
    if during(${STEPS.F}, ${STEPS.G}):
        anim << paint(anim)
        if EUDIf()(f_dwread_epd(anim) == 0xFFFFFFFE):
            anim << EPD(DATA) + ANIM
        EUDEndIf()
    EUDEndIf()
${[1, 2, 4, 8].map((k, i) => `    if during(${STEPS.G + i * 120}, ${STEPS.G + (i + 1) * 120}):\n${Array.from({ length: k }, () => `        paint(EPD(DATA) + ${pics.dancer})`).join("\n")}\n    EUDEndIf()`).join("\n")}
    if at(${STEPS.G + 120}):
        show("\\x11G: 2x a frame")
    EUDEndIf()
    if at(${STEPS.G + 240}):
        show("\\x11G: 4x a frame")
    EUDEndIf()
    if at(${STEPS.G + 360}):
        show("\\x11G: 8x a frame")
    EUDEndIf()
    if during(${STEPS.H}, ${STEPS.END}):
        DoActions(SetMemoryX(FLAGS_UNIT, SetTo, 0, 4))
        brush(52, 40, 0)
        brush(68, 40, 1)
        DoActions(SetMemoryX(FLAGS_UNIT, SetTo, 4, 4))
        brush(52, 56, 1)
        brush(68, 56, 1)
    EUDEndIf()
    if at(${STEPS.END}):
        show("\\x04Done. The fog stays as it was from here.")
    EUDEndIf()
    # B leaves the countdown alone; every other step asks for a wipe on the next frame.
    if EUDIfNot()([f >= ${STEPS.B}, f < ${STEPS.C}]):
        DoActions(SetMemory(COUNTDOWN, SetTo, 1))
    EUDEndIf()
`;
writeFileSync(join(OUT, "fog-probe.py"), py);
writeFileSync(join(OUT, "fog-probe.ts"), `// The S4 fog probe (TrigScript 4): fog of war as a picture. The script below only keeps the map's triggers running
// every frame; what is tried is fog-probe.py, hand-written eudplib built into the same map. Host it as a multiplayer
// game, alone. What to look for, by the second (each step says so in the text lines too):
//   A   2  one brush jumping between two places, countdown written: does the old place go dark at once?
//   B  12  the same with the countdown not written: the old place should stay lit for up to four seconds
//   C  22  the brush sizes, sight 1-6 top row, 7-11 lower row (the minimap shows them all)
//   D  32  one brush sliding a tile a frame: smooth, smeared, trailing?
//   E  42  four pictures, 5 s each: dancer, apple, "Bad Apple", the dancer white on black
//   F  62  an animation, 72 frames looped
//   G  82  the dancer painted 1, 2, 4, 8 times a frame: when does the game stutter?
//   H 102  ground revealers (top row: sight 0, sight 1) beside air ones (lower row: sight 1)
// Built with
//   npx tsx probes/lib/fog-base-map.mts fixtures/eud/fog-base.scx
//   EXTRA_PLUGIN=fogSpike=probes/fog-probe.py npx tsx scripts/build-fixture.mts probes/fog-probe.ts fixtures/eud/fog-probe.scx fixtures/eud/fog-base.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
`);
// FOG_EXPECT=path: what each picture should light, tile by tile, for a check in the lifted game (about 1 MB; not kept).
if (process.env.FOG_EXPECT) writeFileSync(process.env.FOG_EXPECT, JSON.stringify({ unit: UNIT, steps: STEPS, rowC, pics, expect }));
