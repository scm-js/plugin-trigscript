"""
[stringsSpike]

The strings spike (slice 8½, before any compiler work): does the game show a text that was
made while the map is played in a field that holds a string id? Hand-written eudplib, not
the compiler's output. One string of the built map's table is reserved for each kind of
field — 255 bytes of room, added with ForceAddString so nothing else shares its bytes — and
a text with a number in it is written over it (f_dbstr_print) before the action that names
its id runs. Each step also answers a second question: after the action has run, the slot
is written over again WITHOUT the action. If what is on the screen changes, the game reads
the string again each time it draws (so a per-player program has to write the slot only on
that player's machine); if it does not, the game copied it when the action ran.

Built beside probes/strings-spike.ts, which says what to look for, step by step.
"""
from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString

ROOM = 255


def _slot(tag):
    text = "(slot %s, never written)" % tag
    return ForceAddString(text + " " * (ROOM - len(text)))


SLOT_TEXT = _slot("text")
SLOT_OBJECTIVES = _slot("objectives")
SLOT_BOARD = _slot("leaderboard")
SLOT_TRANSMISSION = _slot("transmission")
SLOT_NAME = _slot("unit name")

tick = EUDVariable()
second = EUDVariable()

# units.dat's "unit map string": the id of the name a map gives a unit type, two bytes each.
UNIT_MAP_STRING = 0x660260
MARINE = 0


def _say(text):
    DoActions(DisplayText(text))


def _at(n):
    return EUDIf()(second == n)


def onPluginStart():
    pass


def beforeTriggerExec():
    f_setcurpl(P1)
    tick.__iadd__(1)
    if EUDIf()(tick >= 24):
        tick << 0
        second.__iadd__(1)

        # A — the control: Display Text through a slot. If this fails, the write itself does.
        if _at(3):
            f_dbstr_print(GetMapStringAddr(SLOT_TEXT), "\x07A: made text through a slot, second ", second, " \x04(the control)")
            DoActions(DisplayText(SLOT_TEXT))
        EUDEndIf()

        # B — objectives made, action run. C — slot written over, no action.
        if _at(6):
            f_dbstr_print(GetMapStringAddr(SLOT_OBJECTIVES), "B: objectives made at second ", second, "\n\x03Collect ", second, "/10 relics")
            DoActions(SetMissionObjectives(SLOT_OBJECTIVES))
            _say("\x04B: open the objectives (F10, Mission Objectives). It should say \x07B: objectives made at second 6\x04.")
        EUDEndIf()
        if _at(21):
            f_dbstr_print(GetMapStringAddr(SLOT_OBJECTIVES), "C: the slot was written over at second ", second, ", the action did not run")
            _say("\x04C: open the objectives again. \x07Still B\x04 = the game copied it. \x07Now C\x04 = the game reads it each time.")
        EUDEndIf()

        # D — leaderboard label made. E — written over without the action. F — every second.
        if _at(36):
            f_dbstr_print(GetMapStringAddr(SLOT_BOARD), "D: kills, made at ", second)
            DoActions([LeaderBoardComputerPlayers(Disable), LeaderBoardKills("Terran Marine", SLOT_BOARD)])
            _say("\x04D: a leaderboard. Its label should say \x07D: kills, made at 36\x04.")
        EUDEndIf()
        if _at(46):
            f_dbstr_print(GetMapStringAddr(SLOT_BOARD), "E: written over at ", second, ", no action")
            _say("\x04E: look at the label. \x07Still D\x04 = copied. \x07Now E\x04 = read each time it is drawn.")
        EUDEndIf()
        if EUDIf()([second >= 56, second <= 66]):
            f_dbstr_print(GetMapStringAddr(SLOT_BOARD), "F: second ", second, " (no action)")
            if _at(56):
                _say("\x04F: for ten seconds the slot is written every second. Does the label \x07count\x04?")
            EUDEndIf()
        EUDEndIf()

        # G — a transmission's text made. H — written over while it is on the screen.
        if _at(70):
            f_dbstr_print(GetMapStringAddr(SLOT_TRANSMISSION), "G: a transmission made at second ", second)
            DoActions(Transmission("Terran Command Center", "Anywhere", "sound\\Misc\\Buzz.wav", SetTo, 9000, SLOT_TRANSMISSION, AlwaysDisplay=4))
            _say("\x04G: a transmission from the Command Center. Its text should say \x07G: a transmission made at second 70\x04.")
        EUDEndIf()
        if _at(74):
            f_dbstr_print(GetMapStringAddr(SLOT_TRANSMISSION), "H: written over at second ", second)
            _say("\x04H: did the transmission's line change to \x07H\x04 while it was up?")
        EUDEndIf()

        # I — Korean and an emoji through the string buffer: what does the game draw of each?
        if _at(84):
            GetGlobalStringBuffer().print("\x04I: Korean \x07저글링\x04, and an emoji between the bars: |\U0001F600| - what is drawn there?")
        EUDEndIf()

        # J — last, because a write the game refuses ends it: a Marine's name made.
        if _at(94):
            _say("\x04J: in three seconds the Marine's name becomes a made text. If the game \x06ends\x04 here, that write is refused.")
        EUDEndIf()
        if _at(97):
            f_dbstr_print(GetMapStringAddr(SLOT_NAME), "J: Marine of second ", second)
            f_wwrite(UNIT_MAP_STRING + MARINE * 2, SLOT_NAME)
            _say("\x04J: select a Marine. Is it called \x07J: Marine of second 97\x04?")
        EUDEndIf()
        if _at(107):
            f_dbstr_print(GetMapStringAddr(SLOT_NAME), "K: renamed at ", second, " without a write")
            _say("\x04K: select a Marine again (deselect first). \x07K: renamed at 107\x04? That is the end.")
        EUDEndIf()
    EUDEndIf()


def afterTriggerExec():
    pass
