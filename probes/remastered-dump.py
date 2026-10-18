"""
[remasteredDump]

What the dump of Remastered's EUD emulator (TrigScript 4, 2026-10-16) predicts, played. Hand-written eudplib.

Magenta's probe 6 wrote a unit's position and then its sprite's position in one go (`nudge`) and the game ended
with "EUD not supported". Run on a dump of the game, Remastered's own emulator accepts both writes: the unit's
position lands in the game's unit, the sprite's lands in memory the emulator keeps beside the game. So the steps
here take nudge apart, one write each, and end on a read the emulator refuses, which no probe has made before:

  A   5  the first unit's X written (two bytes, as nudge did): predicted to go through
  B  15  its Y written the same way: predicted to go through
  C  25  its sprite's X and Y written: predicted to go through and change nothing on the screen
  D  35  a read of the unit's field +0x74: predicted to END the game ("EUD not supported")

Built beside probes/remastered-dump.ts, which says the same.
"""
from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString

UNITS = 0x59CCA8          # the unit table; slot 0 is the first unit placed
POS = UNITS + 0x28        # x: u16, y: u16
SPRITE = UNITS + 0x0C     # the unit's sprite, a pointer
UNEMULATED = UNITS + 0x74

tick = EUDVariable()
second = EUDVariable()


SLOT = ForceAddString(" " * 255)   # one string of the table, room for a line made in the game (the strings spike's way)


def _say(*parts):
    f_dbstr_print(GetMapStringAddr(SLOT), *parts)
    DoActions(DisplayText(SLOT))


def _at(n):
    return EUDIf()(second == n)


def onPluginStart():
    pass


def beforeTriggerExec():
    tick.__iadd__(1)
    if EUDIf()(tick >= 24):
        tick << 0
        second.__iadd__(1)

        if _at(2):
            _say("\x04The dump probe: four steps, about 35 seconds. Watch the first unit placed (unit table slot 0).")
        EUDEndIf()

        if _at(5):
            x = f_wread(POS)
            f_wwrite(POS, x + 64)
            _say("\x07A\x04: unit 0's X written, ", x, " -> ", f_wread(POS), ". \x07Still playing?\x04 Does the unit look moved?")
        EUDEndIf()

        if _at(15):
            y = f_wread(POS + 2)
            f_wwrite(POS + 2, y + 64)
            _say("\x07B\x04: unit 0's Y written, ", y, " -> ", f_wread(POS + 2), ". \x07Still playing?\x04 Select it, click near it: where is it?")
        EUDEndIf()

        if _at(25):
            sprite = f_dwread(SPRITE)
            if EUDIf()(sprite >= 1):
                sx = f_wread(sprite + 0x14)
                sy = f_wread(sprite + 0x16)
                f_wwrite(sprite + 0x14, sx + 64)
                f_wwrite(sprite + 0x16, sy + 64)
                _say("\x07C\x04: its sprite's X and Y written (read ", sx, ",", sy, "). \x07Still playing?\x04 Did anything on the screen change?")
            EUDEndIf()
        EUDEndIf()

        if _at(33):
            _say("\x04D: in two seconds a read the dump says Remastered refuses. The game \x06should end\x04 with \"EUD not supported\".")
        EUDEndIf()

        if _at(35):
            v = f_dwread(UNEMULATED)
            _say("\x07D\x04: read ", v, ". \x06If you can read this, the dump was wrong about +0x74.")
        EUDEndIf()
    EUDEndIf()


def afterTriggerExec():
    pass
