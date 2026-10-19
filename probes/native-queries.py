"""
[nativeQueries]

The native-query probe (TrigScript 4, the limits): what Bring and Command cost Remastered in an EUD map, so that a
library can decide whether to ask the game "how many units are in this box" instead of working it out in arithmetic.
Hand-written eudplib, built beside probes/native-queries.ts, the weights probe's schedule and marks
(probes/frame-weights.py), so remastered/profile.py and profile_report.py (scm-sim-reader) read it unchanged.

What Remastered 1.23.10.13515 does (read in Ghidra, 2026-10-19):
- Bring (+0x289CC0) and Command (+0x289C40) never go through the EUD emulator. Both read a table of counts, one cell
  for each player and unit type (0x540 bytes), that the last query filled: Command copies the game's own counts into it
  (+0x28AF60), Bring counts the units in its location into it (+0x28BBD0).
- The table is kept while the queries stay the same kind and, for Bring, the same location number. It is thrown away
  at the start of every trigger pass (+0x41C007) and by the actions that kill or remove units (+0x28A960). Writing a
  location's sides does not throw it away: a Bring of a location moved that way since its last Bring reads the old
  counts (played: probes/location-stale.py).
- So the cost is a scan each time the location changes and a lookup otherwise; the mixes take the two apart, and the
  scan at 0, 16 and 64 units in the location.

Units: 160 marines of Player 1 in four boxes around Home (16, 16, 64, 64), made on frame 2; the counts
are on the screen on frame 4. Locations 11-19 are set by the probe itself (MRGN), around the Home location build-fixture makes.

Every phase lasts PHASE frames. Marks, as deaths of Player 12 (index 11):
  unit 220: MAGIC once the probe has started     unit 221: the phase (0, 1, ...; DONE when the schedule is over)
  unit 222: the frame, counted by the probe
The phase table is printed by `python3 probes/native-queries.py`.
"""
import json, sys

PHASE = 8 * 24  # 8 game seconds a phase at every speed
MAGIC = 0x57E16475
DONE = 0xFFFF
DEATHS = 0x58A364
MRGN = 0x58DC60
MARINE = 0

# Each mix: its name, records a turn as A4 counts them, records a frame at its two levels, and what it isolates.
MIXES = [
    ("loop", 39, (200_000, 800_000), "the dial's loop, first so that the report lines the played run up with the lifted one"),
    ("act64", 256, (200_000, 800_000), "payload Set Deaths, 64 to a trigger (the yardstick for actions)"),
    ("cond16", 256, (200_000, 800_000), "payload Deaths conditions, 16 to a trigger, all true (the yardstick for conditions)"),
    ("bringSame", 256, (200_000, 800_000), "Bring of one location, 16 to a trigger: one scan a frame, the rest lookups"),
    ("commandSame", 256, (200_000, 800_000), "Command, 16 to a trigger: one copy of the game's counts a frame, the rest lookups"),
    ("bringAlt0", 256, (5_000, 20_000), "Bring alternating two empty locations: a scan each time, nothing in it"),
    ("bringAlt16", 256, (5_000, 20_000), "Bring alternating the two boxes of 16 marines: a scan each time"),
    ("bringAlt64", 256, (2_000, 8_000), "Bring alternating the two boxes of 64 marines: a scan each time"),
    ("bringCmd", 256, (5_000, 20_000), "Bring of one location and Command alternating: a scan and a copy each time"),
    ("moveAlt16", 160, (5_000, 20_000), "a location's four sides written (Set Deaths into MRGN) and Bring of it, two locations in turn, boxes of 16"),
]


def turns_for(m, level):
    return max(1, round(level / MIXES[m][1]))


def schedule():
    """[(mix index or None for idle, level index or None)]: two idle phases first, then each mix at both levels, an
    idle phase after every fourth mix and at the end."""
    out = [(None, None), (None, None)]
    for i in range(len(MIXES)):
        out += [(i, 0), (i, 1)]
        if i % 4 == 3:
            out.append((None, None))
    out.append((None, None))
    return out


SCHEDULE = schedule()


def table():
    """The phases, as the profiler's analysis reads them: `python3 probes/native-queries.py --json`."""
    return [{"phase": p, "first": max(1, p * PHASE), "mix": None if m is None else MIXES[m][0],
             "level": None if l is None else MIXES[m][2][l], "turns": None if m is None else turns_for(m, MIXES[m][2][l])}
            for p, (m, l) in enumerate(SCHEDULE)]


# Locations the probe sets (1-based, as triggers name them), and each box: its place from Home's top left
# (pixels, the box's top left), its size, and the marines made in it.
L_SAME, L_E1, L_E2, L_A16, L_B16, L_A64, L_B64, L_MOVE1, L_MOVE2 = range(11, 20)
BOXES = [  # (location, dx, dy, width, height, marines)
    (L_A16, 0, 0, 128, 128, 16),
    (L_B16, 192, 0, 128, 128, 16),
    (L_SAME, 0, 0, 128, 128, 0),  # the box of L_A16 again: its 16 marines, scanned once a frame
    (L_E1, 600, -800, 128, 128, 0),
    (L_E2, 800, -800, 128, 128, 0),
    (L_A64, 160, 200, 224, 224, 64),
    (L_B64, 400, 160, 224, 224, 64),
]

# --- the map's side (skipped when the file is run as a script for the table) ---
if __name__ != "__main__":
    from eudplib import *

    MARK_MAGIC, MARK_PHASE, MARK_FRAME = (EPD(DEATHS) + unit * 12 + 11 for unit in (220, 221, 222))
    pay = Db(4096)  # 1024 payload cells, in the strings region like eudplib's variables
    PAY = EPD(pay)

    def side(loc, k):
        """The EPD of a location's left (0), top (1), right (2) or bottom (3)."""
        return EPD(MRGN + (loc - 1) * 20) + k

    def bring(loc):
        return Bring(P1, AtLeast, 0, MARINE, loc)

    def alt(a, b):
        return [([bring(a if c % 2 == 0 else b) for c in range(16)], []) for t in range(16)]

    # The moving pair: each trigger's Bring reads the location its last trigger wrote, and writes the other one's sides
    # to the box of 16 marines it already had (the same numbers: the work is the write, not a different box).
    box16 = {b[0]: b for b in BOXES}
    sx, sy = EUDVariable(), EUDVariable()

    def move_turn():
        out = []
        for t in range(32):
            here, there = (L_MOVE1, L_MOVE2) if t % 2 == 0 else (L_MOVE2, L_MOVE1)
            out.append(([bring(here)], [SetMemoryEPD(side(there, k), Add, 0) for k in range(4)]))
        return out

    TURNS = {
        "loop": None,
        "act64": [([], [SetMemoryEPD(PAY + (t * 64 + a) % 1024, Add, 1) for a in range(64)]) for t in range(4)],
        "cond16": [([MemoryEPD(PAY + t * 16 + c, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "bringSame": [([bring(L_SAME) for c in range(16)], []) for t in range(16)],
        "commandSame": [([Command(P1, AtLeast, 0, MARINE) for c in range(16)], []) for t in range(16)],
        "bringAlt0": alt(L_E1, L_E2),
        "bringAlt16": alt(L_A16, L_B16),
        "bringAlt64": alt(L_A64, L_B64),
        "bringCmd": [([bring(L_SAME) if c % 2 == 0 else Command(P1, AtLeast, 0, MARINE) for c in range(16)], []) for t in range(16)],
        "moveAlt16": move_turn(),
    }

    f = EUDVariable()  # frames since the start
    pf = EUDVariable()  # frames into this phase
    phase = EUDVariable()
    mixv = EUDVariable()
    turns = EUDVariable()
    x = EUDVariable()

    def show(s):
        DoActions(DisplayText(s.encode("utf-8")))

    def label(p):
        m, l = SCHEDULE[p]
        if m is None:
            return f"\x04native queries {p + 1}/{len(SCHEDULE)}: idle"
        return f"\x04native queries {p + 1}/{len(SCHEDULE)}: {MIXES[m][0]} at {MIXES[m][2][l] // 1000}k"

    def count_in(loc):
        """How many marines of Player 1 Bring finds in the location, 0 … 128."""
        n = EUDVariable()
        n << 0
        for k in range(1, 129):
            RawTrigger(conditions=Bring(P1, AtLeast, k, MARINE, loc), actions=n.SetNumber(k))
        return n

    def afterTriggerExec():
        f.__iadd__(1)
        f_dwwrite_epd(MARK_MAGIC, MAGIC)
        f_dwwrite_epd(MARK_FRAME, f)
        if EUDIf()(f == 1):
            DoActions([RemoveUnit("(any unit)", P2)])
            show("\x04Native-query probe: it runs by itself for about five minutes. Keep the profiler going; play nothing.")
            # The boxes, from the Home location's top left (build-fixture puts it on open ground below Player 1's base).
            sx << f_dwread_epd(side(1, 0))
            sy << f_dwread_epd(side(1, 1))
            f_simpleprint("\x04Home at", sx, sy)
            for loc, dx, dy, w, h, _ in BOXES:
                left, top = sx + dx, sy + dy
                f_dwwrite_epd(side(loc, 0), left)
                f_dwwrite_epd(side(loc, 1), top)
                f_dwwrite_epd(side(loc, 2), left + w)
                f_dwwrite_epd(side(loc, 3), top + h)
            # The moving pair start on the two boxes of 16.
            for loc, src in ((L_MOVE1, L_A16), (L_MOVE2, L_B16)):
                for k in range(4):
                    f_dwwrite_epd(side(loc, k), f_dwread_epd(side(src, k)))
        EUDEndIf()
        if EUDIf()(f == 2):
            for loc, dx, dy, w, h, n in BOXES:
                for _ in range(n // 16):
                    DoActions(CreateUnit(16, MARINE, loc, P1))
        EUDEndIf()
        if EUDIf()(f == 4):
            f_simpleprint("\x04Marines found: same", count_in(L_SAME), "empty", count_in(L_E1), count_in(L_E2),
                          "16s", count_in(L_A16), count_in(L_B16), "64s", count_in(L_A64), count_in(L_B64),
                          "moving", count_in(L_MOVE1), count_in(L_MOVE2))
        EUDEndIf()
        # The phase: counted, not divided.
        pf.__iadd__(1)
        if EUDIf()(pf == PHASE):
            pf << 0
            phase.__iadd__(1)
        EUDEndIf()
        if EUDIf()(phase >= len(SCHEDULE)):
            f_dwwrite_epd(MARK_PHASE, DONE)
            if EUDIf()(pf == 0):
                show("\x04Native-query probe: done. The profiler stops by itself.")
            EUDEndIf()
            EUDReturn()
        EUDEndIf()
        f_dwwrite_epd(MARK_PHASE, phase)
        mixv << 0xFFFF
        turns << 0
        for p, (m, l) in enumerate(SCHEDULE):
            if EUDIf()(phase == p):
                if m is not None:
                    DoActions([mixv.SetNumber(m), turns.SetNumber(turns_for(m, MIXES[m][2][l]))])
                if EUDIf()(pf == 0):
                    show(label(p))
                EUDEndIf()
            EUDEndIf()
        for m, (name, _, _, _) in enumerate(MIXES):
            turn = TURNS[name]
            if EUDIf()(mixv == m):
                if turn is None:  # the dial's loop, as eudplib writes it
                    i = EUDVariable()
                    i << 0
                    if EUDWhile()(i < turns):
                        x.__iadd__(1)
                        i.__iadd__(1)
                    EUDEndWhile()
                else:
                    if EUDWhileNot()(turns == 0):
                        for conds, acts in turn:
                            RawTrigger(conditions=conds, actions=acts)
                        turns.__isub__(1)
                    EUDEndWhile()
            EUDEndIf()

else:
    if "--json" in sys.argv:
        print(json.dumps({"phase": PHASE, "magic": MAGIC, "done": DONE, "phases": table()}))
    else:
        for row in table():
            what = "idle" if row["mix"] is None else f"{row['mix']:11} {row['level']:>8} {row['turns']:6} turns"
            print(f"{row['phase']:2} from frame {row['first']:5}  {what}")
