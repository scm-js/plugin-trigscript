"""
[localReads]

The local-reads probe (TrigScript 4, B5). Hand-written eudplib: every read here is of the machine's own memory,
which no TrigScript program reads yet. Read from the dump of Remastered's EUD emulator (Ghidra, 2026-10-17):

  0x512684  the local player: kind 0x27, the real local player number
  0x62848C  the camera's X, 0x6284A8 its Y: the real camera; writes ignored
  0x6CDDC4  the mouse on the screen, X then Y: Remastered's input record (850 in a dump: wider than 640)
  0x6CDDC0  the mouse buttons: left 2, right 8, middle 32 (MSQC's bits)
  0x6284B8  the selection, twelve slots (F8 writes a Marine into slot 0): a read gives the unit's 1.16.1 address, a write of one selects the real unit

Five lines, printed again every half second, keep every result on the screen:

  1  live values             2  the mouse's range since F7    3  the selection; F8 writes it
  4  a left click's trip     5  F9 writes the mouse; what it reads back after 0, 1, 2, 8 frames

The synced half is probes/local-reads.ts: it leaves the frame a left click arrived through MSQC in P1's deaths of
Terran Civilian, and the synced mouse in P2's and P3's.
"""
from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString

LOCAL_PLAYER = 0x512684
SCREEN_X, SCREEN_Y = 0x62848C, 0x6284A8
MOUSE_X, MOUSE_Y = 0x6CDDC4, 0x6CDDC8
BUTTONS = 0x6CDDC0
SELECTION = 0x6284B8      # twelve unit addresses
KEYS = 0x596A18           # a byte a virtual key
FRAME = 0x57F23C
UNITS, UNIT_SIZE, UNIT_COUNT = 0x59CCA8, 336, 1700
DEATHS = 0x58A364
CIVILIAN = 15
F7, F8, F9 = 0x76, 0x77, 0x78
LEFT = 2


def deaths_of(player):
    return DEATHS + (CIVILIAN * 12 + player) * 4


tick = EUDVariable()
keys_before = EUDArray(3)

min_x, max_x, min_y, max_y = EUDCreateVariables(4)
seen = EUDVariable()

wrote_from, wrote_to, wrote_type = EUDCreateVariables(3)

buttons_before = EUDVariable()
local_click, arrived, arrived_before, delay = EUDCreateVariables(4)
shortest, longest, trips = EUDCreateVariables(3)

write_frame = EUDVariable()
back = EUDArray(8)        # x, y after 0, 1, 2 and 8 frames

LINES = [ForceAddString(" " * 255) for _ in range(5)]


def say(slot, *parts):
    f_dbstr_print(GetMapStringAddr(slot), *parts)
    DoActions(DisplayText(slot))


def pressed(k, vk):
    """The key went down this frame on this machine."""
    now = f_bread(KEYS + vk)
    went = EUDVariable()
    went << 0
    if EUDIf()([now >= 1, keys_before[k] == 0]):
        went << 1
    EUDEndIf()
    keys_before[k] = now
    return went


def unit_type(ptr):
    return f_wread(ptr + 0x64)


def onPluginStart():
    seen << 0
    shortest << 0xFFFF


def beforeTriggerExec():
    frame = f_dwread(FRAME)
    mx = f_dwread(MOUSE_X)
    my = f_dwread(MOUSE_Y)

    # 2: the mouse's range on the screen.
    if EUDIf()(seen == 0):
        min_x << mx
        max_x << mx
        min_y << my
        max_y << my
        seen << 1
    EUDEndIf()
    if EUDIf()(mx < min_x):
        min_x << mx
    EUDEndIf()
    if EUDIf()(mx > max_x):
        max_x << mx
    EUDEndIf()
    if EUDIf()(my < min_y):
        min_y << my
    EUDEndIf()
    if EUDIf()(my > max_y):
        max_y << my
    EUDEndIf()
    if EUDIf()(pressed(0, F7) == 1):
        seen << 0
    EUDEndIf()

    # 3: F8 puts another unit of Player 1's in slot 0 and clears the rest.
    if EUDIf()(pressed(1, F8) == 1):
        wrote_from << f_dwread(SELECTION)
        wrote_to << 0
        i = EUDVariable()
        i << 0
        if EUDWhile()(i < UNIT_COUNT):
            ptr = UNITS + i * UNIT_SIZE
            # A Marine: the first round took MSQC's own Valkyrie (type 58, Player 1's, hidden), which no player selects.
            if EUDIf()([f_dwread(ptr + 0x0C) >= 1, f_bread(ptr + 0x4C) == 0, f_wread(ptr + 0x64) == 0, ptr != wrote_from]):
                wrote_to << ptr
                EUDBreak()
            EUDEndIf()
            i += 1
        EUDEndWhile()
        if EUDIf()(wrote_to >= 1):
            wrote_type << unit_type(wrote_to)
            f_dwwrite(SELECTION, wrote_to)
            for s in range(1, 12):
                f_dwwrite(SELECTION + s * 4, 0)
        EUDEndIf()
    EUDEndIf()

    # 4: a left click, down here, and when it arrived through MSQC.
    buttons = f_dwread(BUTTONS) & 0xFFFF
    left = buttons & LEFT
    if EUDIf()([left == LEFT, buttons_before == 0]):
        local_click << frame
    EUDEndIf()
    buttons_before << left
    arrived << f_dwread(deaths_of(0))
    if EUDIf()([arrived != arrived_before, arrived >= 1]):
        delay << arrived - local_click
        trips.__iadd__(1)
        if EUDIf()(delay < shortest):
            shortest << delay
        EUDEndIf()
        if EUDIf()(delay > longest):
            longest << delay
        EUDEndIf()
        arrived_before << arrived
    EUDEndIf()

    # 5: F9 writes the mouse; read back on this frame and three later.
    if EUDIf()(pressed(2, F9) == 1):
        f_dwwrite(MOUSE_X, 320)
        f_dwwrite(MOUSE_Y, 240)
        write_frame << frame
        back[0] = f_dwread(MOUSE_X)
        back[1] = f_dwread(MOUSE_Y)
    EUDEndIf()
    for n, (ix, iy) in ((1, (2, 3)), (2, (4, 5)), (8, (6, 7))):
        if EUDIf()([write_frame >= 1, frame == write_frame + n]):
            back[ix] = mx
            back[iy] = my
        EUDEndIf()

    tick.__iadd__(1)
    if EUDIf()(tick >= 12):
        tick << 0
        sx = f_dwread(SCREEN_X)
        sy = f_dwread(SCREEN_Y)
        say(LINES[0], "\x071 \x04player ", f_dwread(LOCAL_PLAYER), " | camera ", sx, ",", sy,
            " | mouse ", mx, ",", my, " = map ", sx + mx, ",", sy + my,
            " | synced ", f_dwread(deaths_of(1)), ",", f_dwread(deaths_of(2)), " | buttons ", buttons)
        say(LINES[1], "\x072 \x04mouse seen x ", min_x, "..", max_x, "  y ", min_y, "..", max_y,
            "   (all four corners; F7 starts again)")
        count = EUDVariable()
        count << 0
        for s in range(12):
            if EUDIf()(f_dwread(SELECTION + s * 4) >= 1):
                count += 1
            EUDEndIf()
        first = f_dwread(SELECTION)
        first_type = EUDVariable()
        first_type << 0xFFFF
        if EUDIf()(first >= 1):
            first_type << unit_type(first)
        EUDEndIf()
        # What every machine holds as Player 1's selection (0x6284E8, the orders run over it): a Select command changes it.
        held = f_dwread(SELECTION + 0x30)
        held_type = EUDVariable()
        held_type << 0xFFFF
        if EUDIf()(held >= 1):
            held_type << unit_type(held)
        EUDEndIf()
        say(LINES[2], "\x073 \x04selected ", count, ", slot 0 type ", first_type, " | game holds type \x07", held_type, "\x04",
            " | F8 put type ", wrote_type, " in slot 0 (unit ", wrote_to, ", was ", wrote_from, ")")
        say(LINES[3], "\x074 \x04left click: down at ", local_click, ", arrived ", arrived, ": \x07", delay,
            "\x04 frames  (", trips, " clicks, ", shortest, " to ", longest, ")")
        say(LINES[4], "\x075 \x04F9 at frame ", write_frame, ": read back ", back[0], ",", back[1],
            " | +1 ", back[2], ",", back[3], " | +2 ", back[4], ",", back[5], " | +8 ", back[6], ",", back[7])
    EUDEndIf()


def afterTriggerExec():
    pass
