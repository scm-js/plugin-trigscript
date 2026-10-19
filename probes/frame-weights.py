"""
[frameWeights]

The weights probe (TrigScript 4, cost step 1): what each kind of condition and action costs Remastered, so A4's count
can be weighed rather than counted. Hand-written eudplib, built beside probes/frame-weights.ts. It plays a schedule by
itself, one mix at a time, each at two amounts of work a frame, with an idle phase now and then to measure the game
without it. Nothing needs pressing; profile it with remastered/profile.py (scm-sim-reader) while it runs.

Why these mixes (read from Remastered 1.23.10.13515 in Ghidra, 2026-10-18):
- An EUD map's every Deaths / Set Deaths goes through the EUD emulator (+0x2E1450, +0x2E18F0): a one-entry cache of
  the last region read (+0x80) and the last written (+0x88), else a search of a tree of ~12,300 regions (+0x2DA5A0),
  then the region's own read or write. Every unit is a region of its own (336 bytes), every sprite and image too.
- A masked Set Deaths is a read and a write (+0x2E7DB0).
- The trigger walk (+0x41B350) finds each trigger through the same caches or the tree (+0x2E1940) and reads its next
  pointer through the emulator (+0x2E4540): a trigger costs something of its own, which A4 does not count.

Every phase lasts PHASE frames. What the profiler reads from outside, as deaths of Player 12 (index 11), which the
emulator keeps in the game's own deaths array:
  unit 220: MAGIC once the probe has started     unit 221: the phase (0, 1, ...; DONE when the schedule is over)
  unit 222: the frame, counted by the probe
The phase table (mix, amount, records a frame as designed) is printed by `python3 probes/frame-weights.py`.
"""
import json, sys

PHASE = 8 * 24  # 8 game seconds a phase at every speed
MAGIC = 0x57E16475
DONE = 0xFFFF
DEATHS = 0x58A364
UNIT_TABLE, UNIT_SIZE = 0x59CCA8, 336
# Unit fields Remastered reads for every unit, none of them a pointer (data/remastered.json).
UNIT_FIELDS = (0x08, 0x10, 0x18, 0x1C, 0x20, 0x24, 0x28, 0x2C, 0x30, 0x34, 0x38, 0x3C, 0x40, 0x44, 0x48, 0x4C)

# Each mix: its name, records a turn as A4 counts them (conditions + actions; "empty" counts triggers) and what it
# isolates. A turn holds 256 records wherever the mix allows it; the turns themselves are made on the map's side.
MIXES = [
    ("loop", 39, "the dial's loop: i < n (variable against variable), i += 1, x += 1"),
    ("act64", 256, "payload Set Deaths, 64 to a trigger: an action, little of the trigger"),
    ("act8", 256, "the same, 8 to a trigger"),
    ("act1", 256, "the same, 1 to a trigger: mostly the trigger"),
    ("empty", 256, "triggers with nothing in them: the walk alone (256 triggers a turn, 0 records)"),
    ("cond16", 256, "payload Deaths conditions, 16 to a trigger, all true"),
    ("deaths64", 256, "Set Deaths in the deaths table: another region than the payload, one region all along"),
    ("alt64", 256, "Set Deaths alternating payload / deaths table: the write cache misses every time"),
    ("mask64", 256, "masked payload Set Deaths: a read and a write"),
    ("unitSame", 256, "Deaths conditions on one unit's fields: the read cache holds"),
    ("unitWalk", 256, "Deaths conditions on 256 different units: the tree every time"),
    ("unitAlt", 256, "Deaths conditions alternating one unit / payload: the read cache misses every time"),
    ("switch64", 256, "Set Switch: an action that is not Set Deaths"),
]
LEVELS = (200_000, 800_000)  # records a frame as designed; "empty" takes these as triggers a frame


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
    """The phases, as the profiler's analysis reads them: `python3 probes/frame-weights.py --json`."""
    return [{"phase": p, "first": max(1, p * PHASE), "mix": None if m is None else MIXES[m][0],
             "level": None if l is None else LEVELS[l], "turns": None if m is None else turns_for(m, LEVELS[l])}
            for p, (m, l) in enumerate(SCHEDULE)]


# --- the map's side (skipped when the file is run as a script for the table) ---
if __name__ != "__main__":
    from eudplib import *

    MARK_MAGIC, MARK_PHASE, MARK_FRAME = (EPD(DEATHS) + unit * 12 + 11 for unit in (220, 221, 222))
    # Death cells nobody reads: units 200-219 of every player, written with Add 0.
    SPARE_DEATHS = [EPD(DEATHS) + unit * 12 + p for unit in range(200, 220) for p in range(12)]
    pay = Db(4096)  # 1024 payload cells, in the strings region like eudplib's variables
    PAY = EPD(pay)

    def unit_cell(k, off):
        return EPD(UNIT_TABLE + UNIT_SIZE * k + off)

    def act_turn(per):
        return [([], [SetMemoryEPD(PAY + (t * per + a) % 1024, Add, 1) for a in range(per)]) for t in range(256 // per)]

    # A turn: a list of triggers, each (conditions, actions); None for the loop, which is written out below.
    TURNS = {
        "loop": None,
        "act64": act_turn(64),
        "act8": act_turn(8),
        "act1": act_turn(1),
        "empty": [([], []) for _ in range(256)],
        "cond16": [([MemoryEPD(PAY + t * 16 + c, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "deaths64": [([], [SetMemoryEPD(SPARE_DEATHS[(t * 64 + a) % len(SPARE_DEATHS)], Add, 0) for a in range(64)]) for t in range(4)],
        "alt64": [([], [SetMemoryEPD(PAY + a, Add, 1) if a % 2 == 0 else SetMemoryEPD(SPARE_DEATHS[a], Add, 0) for a in range(64)]) for t in range(4)],
        "mask64": [([], [SetMemoryXEPD(PAY + (t * 64 + a) % 1024, Add, 1, 0xFF) for a in range(64)]) for t in range(4)],
        "unitSame": [([MemoryEPD(unit_cell(0, off), AtLeast, 0) for off in UNIT_FIELDS], []) for t in range(16)],
        "unitWalk": [([MemoryEPD(unit_cell(t * 16 + c, 0x08), AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "unitAlt": [([MemoryEPD(unit_cell(0, 0x08), AtLeast, 0) if c % 2 == 0 else MemoryEPD(PAY + c, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "switch64": [([], [SetSwitch(a % 256, Set) for a in range(64)]) for t in range(4)],
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
            return f"\x04weights {p + 1}/{len(SCHEDULE)}: idle"
        return f"\x04weights {p + 1}/{len(SCHEDULE)}: {MIXES[m][0]} at {LEVELS[l] // 1000}k"

    def afterTriggerExec():
        f.__iadd__(1)
        f_dwwrite_epd(MARK_MAGIC, MAGIC)
        f_dwwrite_epd(MARK_FRAME, f)
        if EUDIf()(f == 1):
            DoActions([RemoveUnit("(any unit)", P2)])
            show("\x04Weights probe: it runs by itself for about five minutes. Keep the profiler going; play nothing.")
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
                show("\x04Weights probe: done. Stop the profiler.")
            EUDEndIf()
            EUDReturn()
        EUDEndIf()
        f_dwwrite_epd(MARK_PHASE, phase)
        mixv << 0xFFFF
        turns << 0
        for p, (m, l) in enumerate(SCHEDULE):
            if EUDIf()(phase == p):
                if m is not None:
                    DoActions([mixv.SetNumber(m), turns.SetNumber(turns_for(m, LEVELS[l]))])
                if EUDIf()(pf == 0):
                    show(label(p))
                EUDEndIf()
            EUDEndIf()
        for m, (name, _, _) in enumerate(MIXES):
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
            what = "idle" if row["mix"] is None else f"{row['mix']:9} {row['level']:>8} {row['turns']:6} turns"
            print(f"{row['phase']:2} from frame {row['first']:5}  {what}")
