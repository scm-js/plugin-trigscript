// Writes the S4 fog probe, second round: probes/fog-probe-2.py (hand-written eudplib) beside probes/fog-probe-2.ts.
//   npx tsx probes/lib/fog-gen-2.mts           FOG_EXPECT=path also writes what each picture should light
//
// The first round, played 2026-10-17: the countdown write works in Remastered, but every brush of a trigger pass came
// out at the size written LAST in the pass before — Remastered takes a sight write into the game a frame late, so
// changing one unit type's sight between Create Units does nothing within the pass. Here each size is a unit type of
// its own (eleven flyers), each sight written to the same value every frame, never changed. It also finds the
// creations a frame at which "Cannot create more units." starts (round 1: between ~550 and ~1,100), and gives the
// ground revealer a step where the Map Revealer's sight never changes. Play it twice: once with Remastered graphics,
// once with Classic, for the minimap (Remastered's is blurred; the code's own minimap routine draws 2 × 2 a tile).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameFromSvg, cover } from "./fog-encode.mts";

const OUT = join(import.meta.dirname, "..");
/** Brush size → the flyer that draws it. None has an upgrade that changes its sight (Overlord, Observer, Scout do). */
const TYPES: Record<number, [string, number]> = {
  1: ["Zerg Scourge", 47], 2: ["Zerg Mutalisk", 43], 3: ["Terran Wraith", 8], 4: ["Terran Valkyrie", 58],
  5: ["Protoss Corsair", 60], 6: ["Terran Dropship", 11], 7: ["Protoss Shuttle", 69], 8: ["Zerg Guardian", 44],
  9: ["Zerg Devourer", 62], 10: ["Terran Science Vessel", 9], 11: ["Terran Battlecruiser", 12],
};
const W = 128, H = 96;
const svg = (body: string, bg = "white", fg = "black") => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384"><rect width="512" height="384" fill="${bg}"/><g fill="${fg}" stroke="${fg}">${body}</g></svg>`;
const dancer = (dx = 0, lift = 0) => `<g transform="translate(${dx} 0)"><circle cx="250" cy="70" r="34"/><path d="M220 60 Q150 40 110 ${90 - lift} Q160 70 215 85 Z"/><path d="M270 50 Q340 20 400 ${60 - lift} Q340 55 280 75 Z" />
<path d="M230 100 L275 100 L290 210 L215 210 Z"/><path d="M215 200 L300 200 L350 290 L170 290 Z"/>
<path d="M232 110 L140 ${160 - lift} L120 ${150 - lift}" fill="none" stroke-width="14"/><path d="M272 110 L360 ${80 + lift} L420 ${40 + lift}" fill="none" stroke-width="6"/>
<path d="M220 290 L205 370 M265 290 L300 370" fill="none" stroke-width="16"/></g>`;
const apple = (s = 1, cx = 256, cy = 192) => `<g transform="translate(${cx} ${cy}) scale(${s}) translate(-256 -192)"><path d="M256 110 C 190 60 110 120 140 220 C 160 300 220 330 256 300 C 292 330 352 300 372 220 C 402 120 322 60 256 110 Z"/><path d="M256 110 Q 250 70 280 40" fill="none" stroke-width="10"/><path d="M262 80 Q 310 40 340 70 Q 300 90 262 80 Z"/></g>`;

const words: number[] = [];
const expect: Record<string, { brushes: number; white: number; missed: number; covered: string }> = {};
async function picture(name: string, s: string): Promise<number> {
  const white = await frameFromSvg(s);
  const r = cover(white, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const start = words.length;
  for (const c of r.chosen) words.push(c.x | (c.y << 8) | (c.r << 16));
  words.push(0xffffffff);
  expect[name] = { brushes: r.chosen.length, white: r.whites, missed: r.missed, covered: Buffer.from(r.covered).toString("base64") };
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
console.log("pictures", Object.fromEntries(Object.entries(expect).filter(([k]) => !k.startsWith("anim")).map(([k, v]) => [k, v.brushes])), "data", words.length * 4, "bytes");

const rowC: [number, number, number][] = [];
let x = 4;
for (const r of [1, 2, 3, 4, 5, 6]) { rowC.push([x + r, 22, r]); x += 2 * r + 5; }
x = 4;
for (const r of [7, 8, 9, 10, 11]) { rowC.push([x + r, 64, r]); x += 2 * r + 5; }

const S = { A: 48, C: 144, E: 288, F: 672, H: 816, I: 912, END: 1416 };
const CAP = [3, 4, 5, 6, 7, 8, 10];   // dancer paints a frame in step I, 72 frames each
const hex = Buffer.from(Uint32Array.from(words).buffer).toString("hex");
const sightWrites = Object.entries(TYPES).map(([r, [, id]]) => `SetMemoryX(0x663238 + ${id & ~3}, SetTo, ${Number(r) << (8 * (id & 3))}, ${0xff << (8 * (id & 3))})`);
const py = `"""
[fogSpike2]

The fog probe, second round (TrigScript 4, S4). Hand-written eudplib, made by probes/lib/fog-gen-2.mts. Each brush
size is a flyer of its own, made on a tile and taken away in the same trigger pass; every type's sight range is
written to its size at the top of every pass and never changed within it. The vision countdown (1.16.1 0x51CE98) is
written to 1 after each pass.

  A   2  one brush (size 5) jumping between two places: the old place goes dark at once (as round 1)?
  C   6  the sizes, 1 to 6 (top row) and 7 to 11 (lower row): each a different size now?
  E  12  four pictures, 4 s each: dancer, apple, "Bad Apple", dancer white on black
  F  28  the animation, 72 frames looped
  H  34  top row: ground Map Revealers at sight 0 (a 3x3?); lower row: size-1 air brushes (3 wide, 4 tall)
  I  38  the dancer painted 3, 4, 5, 6, 7, 8, 10 times a frame (${CAP.length} x 3 s): when does "Cannot create more units." start?
"""
from eudplib import *

LOC = "Pixel"
COUNTDOWN = 0x51CE98
REVEALER_FLAGS = 0x664080 + 101 * 4   # units.dat flags of the Map Revealer; 0x4 = flyer
DATA = Db(bytes.fromhex("${hex}"))
PICS = ${JSON.stringify(pics)}
ANIM = ${animStart}

f = EUDVariable()
anim = EUDVariable()
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
    EUDSwitch(r)
${Object.entries(TYPES).map(([r, [name]]) => `    if EUDSwitchCase()(${r}):\n        DoActions([CreateUnit(1, "${name}", LOC, P1), RemoveUnit("${name}", P1)])\n        EUDBreak()`).join("\n")}
    EUDEndSwitch()


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
    # Every brush type's sight, the same every frame.
    DoActions([
${sightWrites.map((s) => `        ${s},`).join("\n")}
        SetMemoryX(0x663238 + 100, SetTo, 0, 0xFF00),   # the Map Revealer's sight: 0, for step H
    ])
    if at(1):
        DoActions([RemoveUnit("(any unit)", P1), RemoveUnit("(any unit)", P2)])
        center(64, 48)
        show("\\x04S4 fog probe, round 2. Each brush size is a unit type of its own now.")
    EUDEndIf()
${Object.entries({
    A: "A: one brush jumping every half second. Does the old place go dark at once (as in round 1)?",
    C: "C: sizes 1-6 top row, 7-11 lower row (minimap). Each a DIFFERENT size now?",
    E: "E: pictures, 4 s each: dancer, apple, 'Bad Apple', dancer white on black. Screenshot the minimap, please.",
    F: "F: the animation, 72 frames looped.",
    H: "H: top row ground revealers at sight 0 (3x3 squares?), lower row air size 1 (3 wide, 4 tall).",
    I: "I: the dancer painted 3x, 4x, 5x, 6x, 7x, 8x, 10x a frame, 3 s each. When does 'Cannot create more units.' start?",
  }).map(([k, text]) => `    if at(${S[k as keyof typeof S]}):\n        show(${JSON.stringify("\x11" + text)})\n    EUDEndIf()`).join("\n")}
    if during(${S.A}, ${S.C}):
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
    if during(${S.C}, ${S.E}):
${rowC.map(([x, y, r]) => `        brush(${x}, ${y}, ${r})`).join("\n")}
    EUDEndIf()
${(["dancer", "apple", "text", "inverted"] as const).map((k, i) => `    if during(${S.E + i * 96}, ${S.E + (i + 1) * 96}):\n        paint(EPD(DATA) + ${pics[k]})\n    EUDEndIf()`).join("\n")}
    if at(${S.F}):
        anim << EPD(DATA) + ANIM
    EUDEndIf()
    if during(${S.F}, ${S.H}):
        anim << paint(anim)
        if EUDIf()(f_dwread_epd(anim) == 0xFFFFFFFE):
            anim << EPD(DATA) + ANIM
        EUDEndIf()
    EUDEndIf()
    if during(${S.H}, ${S.I}):
        DoActions(SetMemoryX(REVEALER_FLAGS, SetTo, 0, 4))
${[48, 64, 80].map((x) => `        f_setloc(LOC, ${x * 32}, ${40 * 32}, ${x * 32 + 32}, ${40 * 32 + 32})\n        DoActions([CreateUnit(1, "Map Revealer", LOC, P1), RemoveUnit("Map Revealer", P1)])`).join("\n")}
        DoActions(SetMemoryX(REVEALER_FLAGS, SetTo, 4, 4))
${[48, 64, 80].map((x) => `        brush(${x}, 56, 1)`).join("\n")}
    EUDEndIf()
${CAP.map((k, i) => `    if during(${S.I + i * 72}, ${S.I + (i + 1) * 72}):\n${Array.from({ length: k }, () => `        paint(EPD(DATA) + ${pics.dancer})`).join("\n")}\n    EUDEndIf()\n    if at(${S.I + i * 72}):\n        show(${JSON.stringify(`\x11I: ${k}x a frame (${k * expect.dancer.brushes} units made and removed a frame)`)})\n    EUDEndIf()`).join("\n")}
    if at(${S.END}):
        show("\\x04Done.")
    EUDEndIf()
    DoActions(SetMemory(COUNTDOWN, SetTo, 1))
`;
writeFileSync(join(OUT, "fog-probe-2.py"), py.replace(`(${CAP.length} x 3 s)`, `(${CAP.length} x 3 s)`));
writeFileSync(join(OUT, "fog-probe-2.ts"), `// The S4 fog probe, second round (TrigScript 4). The script below only keeps the map's triggers running every frame;
// what is tried is fog-probe-2.py, hand-written eudplib built into the same map. Host it as a multiplayer game, alone.
// Play it twice: Remastered graphics, then Classic. What to look for, by the second:
//   A   2  one brush jumping: the old place goes dark at once?
//   C   6  the sizes 1-11, each a unit type of its own: each a different size now?
//   E  12  four pictures, 4 s each
//   F  28  the animation
//   H  34  ground Map Revealers at sight 0 (3x3?) above size-1 air brushes
//   I  38  the dancer painted 3-10 times a frame: when does "Cannot create more units." start?
// Built with
//   npx tsx probes/lib/fog-base-map.mts fixtures/eud/fog-base.scx
//   EXTRA_PLUGIN=fogSpike2=probes/fog-probe-2.py npx tsx scripts/build-fixture.mts probes/fog-probe-2.ts fixtures/eud/fog-probe-2.scx fixtures/eud/fog-base.scx
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
`);
if (process.env.FOG_EXPECT) writeFileSync(process.env.FOG_EXPECT, JSON.stringify({ steps: S, rowC, pics, cap: CAP, expect }));
