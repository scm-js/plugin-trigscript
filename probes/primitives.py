"""
[primitives]

The primitives probe (TrigScript 4, past eudplib): what Remastered's own trigger code offers that eudplib does not use,
weighed. Hand-written eudplib, built beside probes/primitives.ts, the schedule and marks of the weights and native-query
probes (probes/frame-weights.py), so remastered/profile.py and profile_report.py (scm-sim-reader) read it unchanged.

What Remastered 1.23.10.13515 does (read in Ghidra, 2026-10-19):
- Set Deaths (+0x285410 -> +0x288240 set, +0x2868F0 add, +0x288E30 subtract) and the Deaths condition (+0x28A2C0 ->
  +0x28AB30) take three unit columns apart before the EUD emulator: 230, 231 and 232 (Men, Buildings, Factories) of
  Players 1-8 are a table of the game's own (+0x2D84, +0x2ED4, +0x2FF4 into the game state), written and read
  natively; 229 (Any unit) reads Men plus Buildings, and is never written. Everything else in an EUD map goes through
  the emulator (+0x2E18F0 / +0x2E1450: a region found, then its write or read).
- Set Switch / Switch (+0x285600 / +0x28A1A0) and Set Resources / Accumulate (+0x2859F0 / +0x289D50) are native too;
  a resource's Add wraps.
- A masked Deaths or Set Deaths ("SC" in the record, the mask in its location) is the emulator's path and an AND.
- A player group (All Players, a force) runs the handler once for each of its players: one Set Deaths writes each, one
  Deaths condition compares their sum.
- The walk (+0x41B350) skips a trigger whose flags have bit 3 set (done) without looking at its conditions.

Each phase weighs one of those against the plain EUD record, the weights probe's way. Marks, as deaths of Player 12:
  unit 220: MAGIC once the probe has started     unit 221: the phase (0, 1, ...; DONE when the schedule is over)
  unit 222: the frame, counted by the probe
On frame 4 it says what the native records do (a line on the screen), for the answer sheet.
The phase table is printed by `python3 probes/primitives.py`.
"""
import json, sys

PHASE = 8 * 24  # 8 game seconds a phase at every speed
MAGIC = 0x5071717E
DONE = 0xFFFF
DEATHS = 0x58A364
MEN, BUILDINGS, FACTORIES, ANY_UNIT = 230, 231, 232, 229
REG = 7  # Player 8: owns no units in this map, so nothing of the game changes its Men, Buildings, Factories

# Each mix: its name, records a turn as A4 counts them (a trigger for the walk's mixes), records a frame at its two
# levels, and what it isolates.
MIXES = [
    ("loop", 39, (200_000, 800_000), "the dial's loop, first so that the report lines the played run up with the lifted one"),
    ("act64", 256, (200_000, 800_000), "payload Set Deaths, 64 to a trigger: the emulator's write (the yardstick)"),
    ("actNative", 256, (200_000, 800_000), "Set Deaths of Player 8's Men / Buildings / Factories, 64 to a trigger: the game's own table"),
    ("actSwitch", 256, (200_000, 800_000), "Set Switch (toggle), 64 to a trigger"),
    ("actRes", 256, (200_000, 800_000), "Set Resources of Player 8 (add), 64 to a trigger"),
    ("actMask", 256, (200_000, 800_000), "payload Set Deaths with a mask, 64 to a trigger"),
    ("actGroup", 256, (50_000, 200_000), "Set Deaths of All Players' Factories, 64 to a trigger: a write for each player"),
    ("cond16", 256, (200_000, 800_000), "payload Deaths conditions, 16 to a trigger, all true: the emulator's read (the yardstick)"),
    ("condNative", 256, (200_000, 800_000), "Deaths of Player 8's Men, 16 to a trigger, all true"),
    ("condAny", 256, (200_000, 800_000), "Deaths of Player 8's Any unit (Men plus Buildings), 16 to a trigger, all true"),
    ("condSwitch", 256, (200_000, 800_000), "Switch conditions, 16 to a trigger, all true"),
    ("condRes", 256, (200_000, 800_000), "Accumulate of Player 8's ore, 16 to a trigger, all true"),
    ("condMask", 256, (200_000, 800_000), "payload Deaths with a mask, 16 to a trigger, all true"),
    ("walkEmpty", 16, (50_000, 200_000), "triggers with nothing in them (the walk alone; a record here is a trigger)"),
    ("walkDone", 16, (50_000, 200_000), "triggers marked done (flags bit 3): the walk passes them without a look"),
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
    """The phases, as the profiler's analysis reads them: `python3 probes/primitives.py --json`."""
    return [{"phase": p, "first": max(1, p * PHASE), "mix": None if m is None else MIXES[m][0],
             "level": None if l is None else MIXES[m][2][l], "turns": None if m is None else turns_for(m, MIXES[m][2][l])}
            for p, (m, l) in enumerate(SCHEDULE)]


# --- the map's side (skipped when the file is run as a script for the table) ---
if __name__ != "__main__":
    from eudplib import *

    MARK_MAGIC, MARK_PHASE, MARK_FRAME = (EPD(DEATHS) + unit * 12 + 11 for unit in (220, 221, 222))
    pay = Db(4096)  # 1024 payload cells, in the strings region like eudplib's variables
    PAY = EPD(pay)

    CATS = (MEN, BUILDINGS, FACTORIES)
    # The walk's mixes: triggers of their own, the done ones marked so on frame 1.
    empty_turn = [([], []) for t in range(16)]
    done = [Forward() for t in range(16)]

    TURNS = {
        "loop": None,
        "act64": [([], [SetMemoryEPD(PAY + (t * 64 + a) % 1024, Add, 1) for a in range(64)]) for t in range(4)],
        "actNative": [([], [SetDeaths(REG, Add, 1, CATS[(t * 64 + a) % 3]) for a in range(64)]) for t in range(4)],
        "actSwitch": [([], [SetSwitch(192 + (t * 64 + a) % 48, Toggle) for a in range(64)]) for t in range(4)],
        "actRes": [([], [SetResources(REG, Add, 1, Ore) for a in range(64)]) for t in range(4)],
        "actMask": [([], [SetMemoryXEPD(PAY + (t * 64 + a) % 1024, Add, 0x10001, 0x00FF00FF) for a in range(64)]) for t in range(4)],
        "actGroup": [([], [SetDeaths(AllPlayers, Add, 1, FACTORIES) for a in range(64)]) for t in range(4)],
        "cond16": [([MemoryEPD(PAY + t * 16 + c, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "condNative": [([Deaths(REG, AtLeast, 0, MEN) for c in range(16)], []) for t in range(16)],
        "condAny": [([Deaths(REG, AtLeast, 0, ANY_UNIT) for c in range(16)], []) for t in range(16)],
        "condSwitch": [([Switch(240 + c, Cleared) for c in range(16)], []) for t in range(16)],
        "condRes": [([Accumulate(REG, AtLeast, 0, Ore) for c in range(16)], []) for t in range(16)],
        "condMask": [([MemoryXEPD(PAY + t * 16 + c, AtLeast, 0, 0x00FF00FF) for c in range(16)], []) for t in range(16)],
        "walkEmpty": empty_turn,
        "walkDone": "done",
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
            return f"\x04primitives {p + 1}/{len(SCHEDULE)}: idle"
        return f"\x04primitives {p + 1}/{len(SCHEDULE)}: {MIXES[m][0]} at {MIXES[m][2][l] // 1000}k"

    def afterTriggerExec():
        f.__iadd__(1)
        f_dwwrite_epd(MARK_MAGIC, MAGIC)
        f_dwwrite_epd(MARK_FRAME, f)
        if EUDIf()(f == 1):
            DoActions([RemoveUnit("(any unit)", P2)])
            show("\x04Primitives probe: it runs by itself for about five minutes. Keep the profiler going; play nothing.")
            # The done triggers: flags bit 3 (done) and bit 2 (preserve), 2376 bytes in.
            DoActions([SetMemory(d + 2376, SetTo, 12) for d in done])
        EUDEndIf()
        if EUDIf()(f == 4):
            # What the native records do, each a yes (1) or no (0), and the players All Players reached.
            vals = [EUDVariable() for _ in range(9)]
            DoActions([v.SetNumber(0) for v in vals])
            DoActions([SetDeaths(REG, SetTo, 5, MEN), SetDeaths(REG, Add, 7, MEN)])
            RawTrigger(conditions=Deaths(REG, Exactly, 12, MEN), actions=vals[0].SetNumber(1))
            DoActions([SetDeaths(REG, SetTo, 0x80000000, BUILDINGS), SetDeaths(REG, Add, 0x80000001, BUILDINGS)])
            RawTrigger(conditions=Deaths(REG, Exactly, 1, BUILDINGS), actions=vals[1].SetNumber(1))  # an add wraps
            DoActions(SetDeaths(REG, Subtract, 3, BUILDINGS))
            RawTrigger(conditions=Deaths(REG, Exactly, 0, BUILDINGS), actions=vals[2].SetNumber(1))  # 0: subtract stops at 0
            RawTrigger(conditions=Deaths(REG, Exactly, 0xFFFFFFFE, BUILDINGS), actions=vals[2].SetNumber(2))  # 2: it wraps
            DoActions([SetDeaths(REG, SetTo, 3, MEN), SetDeaths(REG, SetTo, 4, BUILDINGS)])
            RawTrigger(conditions=Deaths(REG, Exactly, 7, ANY_UNIT), actions=vals[3].SetNumber(1))  # Any unit = Men + Buildings
            DoActions([SetResources(REG, SetTo, 10, Ore), SetResources(REG, Add, 0xFFFFFFFF, Ore)])
            RawTrigger(conditions=Accumulate(REG, Exactly, 9, Ore), actions=vals[4].SetNumber(1))  # a resource's add wraps
            DoActions([SetDeaths(p, SetTo, 0, FACTORIES) for p in range(8)] + [SetDeaths(AllPlayers, SetTo, 9, FACTORIES)])
            for p in range(8):
                RawTrigger(conditions=Deaths(p, Exactly, 9, FACTORIES), actions=vals[5].AddNumber(1 << p))
            for k in range(0, 13):
                RawTrigger(conditions=Deaths(AllPlayers, Exactly, 9 * k, FACTORIES), actions=vals[6].SetNumber(k))  # the sum, in nines
            RawTrigger(conditions=MemoryXEPD(PAY, Exactly, 0, 0x00FF00FF), actions=vals[7].SetNumber(1))
            # A trigger marked done before the walk reaches it: its action does not run (0).
            hit = EUDVariable()
            hit << 0
            dd = Forward()
            DoActions(SetMemory(dd + 2376, SetTo, 12))
            dd << RawTrigger(actions=[hit.AddNumber(1)])
            vals[8] << hit
            f_simpleprint("\x04Native:", "men", vals[0], "wrap", vals[1], "sub", vals[2], "any", vals[3], "ore", vals[4],
                          "all", vals[5], "sum", vals[6], "mask", vals[7], "done", vals[8])
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
                show("\x04Primitives probe: done. The profiler stops by itself.")
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
                        if turn == "done":
                            for d in done:
                                d << RawTrigger(actions=[x.AddNumber(1)])
                        else:
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
