"""
[locationStale]

The stale-location probe (TrigScript 4, the limits): does Bring read old counts after its location has moved in the
same trigger pass? Hand-written eudplib, built beside probes/location-stale.ts. Nothing to measure: it prints.

What Remastered 1.23.10.13515 does (read in Ghidra, 2026-10-19): Bring fills a table of counts for its location and
keeps it while the next query is a Bring of the same location number. The table is thrown away at the start of every
trigger pass (+0x41C007), by a query of another kind or location, and by the actions that kill or remove units
(+0x28A960). Moving a location throws nothing away, so Ghidra says a Bring after a move reads the old counts.

Each test runs in a frame of its own (a pass of its own), asks Bring how many marines are in location L, moves L, and
asks again in the same pass. Box A holds 16 marines; box B none (a firebat there, for Move Location to centre on).
  1  L's sides written (as a library moves a location)               A to B: 16, then 0 fresh or 16 stale
  2  Move Location (the action)                                      A to B
  3  the same as 1, a Bring of another location asked in between     (Ghidra: fresh)
  4  the same as 1, a Command asked in between                       (Ghidra: fresh)
  5  moved at the end of one frame, asked on the next                (Ghidra: fresh)
  6  the other way: B to A                                           0, then 16 fresh or 0 stale
  7  the same as 1, a ghost removed in between (Remove Unit)         (Ghidra: fresh)
  8  L not moved, a marine made in it in between (Create Unit)       0, then 1 fresh or 0 stale
  9  8's location counted again on the next frame                    1 when 8's marine landed in L
"""
from eudplib import *

MRGN = 0x58DC60
MARINE, GHOST, FIREBAT = 0, 1, 32
L, L_A, L_B, L_OTHER, L_SPARE, L_C = range(11, 17)
BOXES = [  # (location, dx, dy, width, height) from Home's top left
    (L_A, 0, 0, 128, 128),
    (L_B, 192, 0, 128, 128),
    (L_OTHER, 600, -800, 128, 128),
    (L_SPARE, 420, 160, 128, 128),
    (L_C, 0, 220, 128, 128),
]

f = EUDVariable()
before, after = EUDVariable(), EUDVariable()


def side(loc, k):
    return EPD(MRGN + (loc - 1) * 20) + k


def place(loc, src):
    """Location loc set to the box of src (its four sides written)."""
    for k in range(4):
        f_dwwrite_epd(side(loc, k), f_dwread_epd(side(src, k)))


def count_in(loc):
    """How many marines of Player 1 Bring finds in the location, 0 … 32: every one a Bring of the same location."""
    n = EUDVariable()
    n << 0
    for k in range(1, 33):
        RawTrigger(conditions=Bring(P1, AtLeast, k, MARINE, loc), actions=n.SetNumber(k))
    return n


def report(no, what, a, b, fresh, stale):
    f_simpleprint(f"\x04{no} {what}:", a, "then", b, f"(fresh {fresh}, stale {stale})")


def afterTriggerExec():
    f.__iadd__(1)
    if EUDIf()(f == 1):
        DoActions([RemoveUnit("(any unit)", P2), RemoveUnit("(any unit)", P3), RemoveUnit("(any unit)", P4)])
        f_simpleprint("\x04Stale-location probe: nine lines over a few seconds. Play nothing.")
        sx, sy = f_dwread_epd(side(1, 0)), f_dwread_epd(side(1, 1))
        for loc, dx, dy, w, h in BOXES:
            left, top = sx + dx, sy + dy
            f_dwwrite_epd(side(loc, 0), left)
            f_dwwrite_epd(side(loc, 1), top)
            f_dwwrite_epd(side(loc, 2), left + w)
            f_dwwrite_epd(side(loc, 3), top + h)
    EUDEndIf()
    if EUDIf()(f == 2):
        DoActions([CreateUnit(16, MARINE, L_A, P1), CreateUnit(1, FIREBAT, L_B, P1), CreateUnit(4, GHOST, L_SPARE, P1)])
    EUDEndIf()

    # 1: sides written
    if EUDIf()(f == 10):
        place(L, L_A)
        before << count_in(L)
        place(L, L_B)
        after << count_in(L)
        report(1, "sides written, A to B", before, after, 0, 16)
    EUDEndIf()
    # 2: Move Location
    if EUDIf()(f == 20):
        place(L, L_A)
        before << count_in(L)
        DoActions(MoveLocation(L, FIREBAT, P1, L_B))
        after << count_in(L)
        report(2, "Move Location, A to B", before, after, 0, 16)
    EUDEndIf()
    # 3: another location asked in between
    if EUDIf()(f == 30):
        place(L, L_A)
        before << count_in(L)
        place(L, L_B)
        RawTrigger(conditions=Bring(P1, AtLeast, 0, MARINE, L_OTHER))
        after << count_in(L)
        report(3, "another location asked between", before, after, 0, 16)
    EUDEndIf()
    # 4: a Command asked in between
    if EUDIf()(f == 40):
        place(L, L_A)
        before << count_in(L)
        place(L, L_B)
        RawTrigger(conditions=Command(P1, AtLeast, 0, MARINE))
        after << count_in(L)
        report(4, "Command asked between", before, after, 0, 16)
    EUDEndIf()
    # 5: moved at the end of a frame, asked on the next
    if EUDIf()(f == 50):
        place(L, L_A)
        before << count_in(L)
        place(L, L_B)
    EUDEndIf()
    if EUDIf()(f == 51):
        after << count_in(L)
        report(5, "next frame", before, after, 0, 16)
    EUDEndIf()
    # 6: the other way
    if EUDIf()(f == 60):
        place(L, L_B)
        before << count_in(L)
        place(L, L_A)
        after << count_in(L)
        report(6, "sides written, B to A", before, after, 16, 0)
    EUDEndIf()
    # 7: a ghost removed in between
    if EUDIf()(f == 70):
        place(L, L_A)
        before << count_in(L)
        place(L, L_B)
        DoActions(RemoveUnitAt(1, GHOST, L_SPARE, P1))
        after << count_in(L)
        report(7, "Remove Unit between", before, after, 0, 16)
    EUDEndIf()
    # 8: a marine made in L, L not moved
    if EUDIf()(f == 80):
        place(L, L_C)
        before << count_in(L)
        DoActions(CreateUnit(1, MARINE, L, P1))
        after << count_in(L)
        report(8, "Create Unit between", before, after, 1, 0)
    EUDEndIf()
    if EUDIf()(f == 81):  # the marine of 8 is in L: a new pass counts it
        after << count_in(L)
        f_simpleprint("\x049 the next frame after 8:", after, "(1 when 8's marine landed in L)")
    EUDEndIf()
    if EUDIf()(f == 90):
        f_simpleprint("\x04Stale-location probe: done.")
    EUDEndIf()
