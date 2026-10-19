"""
[fastCells]

The fast-cell probe (TrigScript 4, after the cost slices): whether cells kept outside the EUD emulator are cheaper for
Remastered than the variables eudplib keeps in Set Deaths. Hand-written eudplib, built beside probes/fast-cells.ts, the
weights probe's schedule (probes/frame-weights.py) with other mixes: the same marks, so remastered/profile.py and
profile_report.py (scm-sim-reader) read it as they read that one.

Why (frame-weights, played 2026-10-18): in an EUD map every Deaths and Set Deaths goes through the emulator's region
lookup — Set Deaths 9.7 ns, a Deaths condition 4.8 — while Set Switch, an action the emulator never sees, was 3.2 ns a
record. Set Resources, Set Score, Accumulate and Score read and write the game's own tables, as Set Switch does. The
neutral players' (Player 9–12) ore, gas and custom score are cells nobody sees: if they are as cheap as a switch, a
program's hottest numbers — loop counters, flags, a countdown — could live there.

Before the schedule (frames 2–3) it checks that those cells hold what is written: ore of P9 set to 5, gas of P10 to 7,
custom score of P11 to 9, ore of P12 set to 3 and 5 taken away (the game's Subtract stops at 0), each read back by its
condition and through memory, and says the answer on the screen; and the custom score of Player 1 and Player 8, the
fallback if the neutral players' cells are refused (1.16.1, the lifted game, refuses them, as its Create Unit refuses
those players; Remastered allows Create Unit for them).

Every phase lasts PHASE frames. Marks, as deaths of Player 12 (index 11):
  unit 220: MAGIC once the probe has started     unit 221: the phase (0, 1, ...; DONE when the schedule is over)
  unit 222: the frame, counted by the probe
The phase table is printed by `python3 probes/fast-cells.py`.
"""
import json, sys

PHASE = 8 * 24  # 8 game seconds a phase at every speed
MAGIC = 0x57E16475
DONE = 0xFFFF
DEATHS = 0x58A364

# Each mix: its name, records a turn as A4 counts them (conditions + actions; "empty" counts triggers) and what it
# isolates. A turn holds 256 records wherever the mix allows it; the turns themselves are made on the map's side.
MIXES = [
    ("loop", 39, "the dial's loop, first so that the report can line the played run up with the lifted one"),
    ("act64", 256, "payload Set Deaths, 64 to a trigger (the weights probe's, again: the yardstick)"),
    ("act1", 256, "the same, 1 to a trigger (with act64, what a trigger costs)"),
    ("cond16", 256, "payload Deaths conditions, 16 to a trigger, all true (the yardstick for conditions)"),
    ("switch64", 256, "Set Switch, 64 to a trigger (3.2 ns in the weights probe)"),
    ("ore64", 256, "Set Resources, add 1 ore to Player 9-12, 64 to a trigger"),
    ("gas64", 256, "Set Resources, add 1 gas to Player 9-12"),
    ("score64", 256, "Set Score, add 1 custom score to Player 9-12"),
    ("accum16", 256, "Accumulate, Player 9-12 has at least 0 ore, 16 to a trigger, all true"),
    ("score16", 256, "Score, Player 9-12 has at least 0 custom score, all true"),
    ("switchc16", 256, "Switch 129-144 is cleared (nothing sets them), all true"),
    ("oreSet64", 256, "Set Resources, set ore of Player 9-12 to a number (a copy into such a cell is this, its number patched)"),
    ("own64", 256, "Set Score, add 1 custom score to Player 1 (the player's own: nothing shows it without a leaderboard)"),
    ("own16", 256, "Score, Player 1 has at least 0 custom score, all true"),
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
    NEUTRAL = (P9, P10, P11, P12)
    ORE, GAS, SCORE_CUSTOM = 0x57F0F0, 0x57F120, 0x5822F4  # 1.16.1's tables (12 players each)
    pay = Db(4096)  # 1024 payload cells, in the strings region like eudplib's variables
    PAY = EPD(pay)

    def act_turn(per):
        return [([], [SetMemoryEPD(PAY + (t * per + a) % 1024, Add, 1) for a in range(per)]) for t in range(256 // per)]

    # A turn: a list of triggers, each (conditions, actions); None for the loop, which is written out below.
    TURNS = {
        "loop": None,
        "act64": act_turn(64),
        "act1": act_turn(1),
        "cond16": [([MemoryEPD(PAY + t * 16 + c, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "switch64": [([], [SetSwitch(a % 64, Set) for a in range(64)]) for t in range(4)],
        "ore64": [([], [SetResources(NEUTRAL[a % 4], Add, 1, Ore) for a in range(64)]) for t in range(4)],
        "gas64": [([], [SetResources(NEUTRAL[a % 4], Add, 1, Gas) for a in range(64)]) for t in range(4)],
        "score64": [([], [SetScore(NEUTRAL[a % 4], Add, 1, Custom) for a in range(64)]) for t in range(4)],
        "accum16": [([Accumulate(NEUTRAL[c % 4], AtLeast, 0, Ore) for c in range(16)], []) for t in range(16)],
        "score16": [([Score(NEUTRAL[c % 4], Custom, AtLeast, 0) for c in range(16)], []) for t in range(16)],
        "switchc16": [([Switch(129 + c, Cleared) for c in range(16)], []) for t in range(16)],
        "oreSet64": [([], [SetResources(NEUTRAL[a % 4], SetTo, t * 64 + a, Ore) for a in range(64)]) for t in range(4)],
        "own64": [([], [SetScore(P1, Add, 1, Custom) for a in range(64)]) for t in range(4)],
        "own16": [([Score(P1, Custom, AtLeast, 0) for c in range(16)], []) for t in range(16)],
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
            return f"\x04fast cells {p + 1}/{len(SCHEDULE)}: idle"
        return f"\x04fast cells {p + 1}/{len(SCHEDULE)}: {MIXES[m][0]} at {LEVELS[l] // 1000}k"

    def afterTriggerExec():
        f.__iadd__(1)
        f_dwwrite_epd(MARK_MAGIC, MAGIC)
        f_dwwrite_epd(MARK_FRAME, f)
        if EUDIf()(f == 1):
            DoActions([RemoveUnit("(any unit)", P2)])
            show("\x04Fast-cell probe: it runs by itself for about four minutes. Keep the profiler going; play nothing.")
        EUDEndIf()
        # The cells hold what is written: set on frame 2, read back on frame 3 by their conditions and through memory.
        if EUDIf()(f == 2):
            DoActions([SetResources(P9, SetTo, 5, Ore), SetResources(P10, SetTo, 7, Gas), SetScore(P11, SetTo, 9, Custom),
                       SetResources(P12, SetTo, 3, Ore), SetResources(P12, Subtract, 5, Ore),
                       SetScore(P1, SetTo, 11, Custom), SetScore(P8, SetTo, 13, Custom)])
        EUDEndIf()
        if EUDIf()(f == 3):
            ok = EUDVariable()
            ok << 0
            # P12's ore is set to 3 first, so 0 after the subtract says the subtract stopped at 0, not that nothing happened.
            for bit, cond in enumerate([Accumulate(P9, Exactly, 5, Ore), Accumulate(P10, Exactly, 7, Gas),
                                        Score(P11, Custom, Exactly, 9), Accumulate(P12, Exactly, 0, Ore),
                                        Score(P1, Custom, Exactly, 11), Score(P8, Custom, Exactly, 13)]):
                if EUDIf()(cond):
                    ok += 1 << bit
                EUDEndIf()
            f_simpleprint("\x04Fast cells by their conditions (63 is all six):", ok)
            f_simpleprint("\x04through memory: ore P9", f_dwread_epd(EPD(ORE) + 8), "gas P10", f_dwread_epd(EPD(GAS) + 9),
                          "score P11", f_dwread_epd(EPD(SCORE_CUSTOM) + 10), "ore P12", f_dwread_epd(EPD(ORE) + 11),
                          "score P1", f_dwread_epd(EPD(SCORE_CUSTOM)), "score P8", f_dwread_epd(EPD(SCORE_CUSTOM) + 7))
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
                show("\x04Fast-cell probe: done. The profiler stops by itself.")
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
