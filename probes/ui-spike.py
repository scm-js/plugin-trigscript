"""
[uiSpike]

The UI spike (TrigScript 4, S2, before any compiler work): where can a script draw a screen of
text that the player watches while playing, and what does it look like? S2's demonstration is
Tetris drawn in the game's text, so every step asks something a Tetris board needs. Hand-written
eudplib, not the compiler's output.

  A    2  the text lines: thirteen numbered lines are printed; which numbers stay on the screen?
  B1  12  cell characters, page 1: ten of each in a row between bars; which rows end level?
  B2  24  cell characters, page 2
  C   36  the colour codes: which give a colour of their own on a cell?
  D   48  how many cells fit on one line before it wraps or is cut?
  E   60  one Display Text with line breaks in it: one line or several?
  F1  70  a Tetris board in the text lines, redrawn every frame: does it flicker?
  F2  82  the same, redrawn every fourth frame
  F3  94  twenty rows in ten lines with half blocks, redrawn every frame
  G  106  the text lines' memory written straight, no action: does the screen change? when do lines fade?
  H  126  a 22-row board in the objectives panel: does it fall while the panel is open? is the game paused?
  I  161  the leaderboard's label: how many cells before it is cut?

The map's texts are written as UTF-8 here (eudplib's own default for a map string is cp949), so
every literal goes through u(). Built beside probes/ui-spike.ts, which says the same.
"""
from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString

tick = EUDVariable()     # 0..23, a second's frames
second = EUDVariable()
beat = EUDVariable()     # 0..11: a static page is printed again when it is 0
fall = EUDVariable()     # frames since the piece last moved
row = EUDVariable()      # the falling piece's top row
redraw = EUDVariable()   # F2's frames since the board was last printed

TEXT_LINES = 0x640B60    # the game's text lines, 218 bytes each (allowed both ways in Remastered's emulator)
LINE = 218

SLOT_OBJECTIVES = ForceAddString(" " * 2047)
SLOT_BOARD = ForceAddString(" " * 255)
SLOT_LINE = ForceAddString(" " * 255)


def u(s):
    return s.encode("utf-8")


def show(s):
    DoActions(DisplayText(u(s)))


def between(a, b):
    return EUDIf()([second >= a, second <= b])


def at(n):
    return EUDIf()([second == n, tick == 0])


def page(lines):
    """Print a page of lines every half second, so it stays up and a reader can compare."""
    if EUDIf()(beat == 0):
        for line in lines:
            show(line)
    EUDEndIf()


GREY, WHITE = "\x05", "\x04"
EMPTY10 = GREY + "□" * 10
PIECE = GREY + "□□□□" + "\x11■■" + GREY + "□□□□"
STACK = [
    "\x08■■\x0E■■■" + GREY + "□" + "\x07■■\x03■■",
    "\x10■\x07■■■\x11■■\x0F■■■" + GREY + "□",
]


def framed(cells, end=""):
    return WHITE + "|" + cells + WHITE + "|" + end


def move_piece(every, last):
    """The piece's top row goes down one every `every` frames, from 0 to `last` and again."""
    fall.__iadd__(1)
    if EUDIf()(fall >= every):
        fall << 0
        row.__iadd__(1)
        if EUDIf()(row > last):
            row << 0
        EUDEndIf()
    EUDEndIf()


def occupies(i):
    """Row i holds the O piece when its top row is i - 1 or i."""
    return [row == 0] if i == 0 else [row >= i - 1, row <= i]


def full_board(header):
    """Ten lines: an O piece falling through rows 0..7 above a two-row stack."""
    show(header)
    for i in range(8):
        if EUDIf()(occupies(i)):
            show(framed(PIECE))
        if EUDElse()():
            show(framed(EMPTY10))
        EUDEndIf()
    for cells in STACK:
        show(framed(cells))


HALF_EMPTY = GREY + "░" * 10
HALF = {"full": "██", "upper": "▀▀", "lower": "▄▄"}
HALF_STACK = [
    "\x08██\x0E███" + GREY + "░" + "\x07██\x03██",
    "\x10█\x07███\x11██\x0F███" + GREY + "░",
]


def half_board(header):
    """Twenty rows in ten lines: line i holds rows 2i (top half) and 2i+1 (bottom half)."""
    show(header)
    for i in range(8):
        cells = {k: framed(GREY + "░░░░\x11" + v + GREY + "░░░░") for k, v in HALF.items()}
        if EUDIf()(row == 2 * i):
            show(cells["full"])
        if EUDElseIf()(row == 2 * i + 1):
            show(cells["lower"])
        if i and EUDElseIf()(row == 2 * i - 1):
            show(cells["upper"])
        if EUDElse()():
            show(framed(HALF_EMPTY))
        EUDEndIf()
    for cells in HALF_STACK:
        show(framed(cells))


def objectives_board():
    """The objectives text: a header and 22 numbered rows, the piece falling through rows 0..19."""
    p = EUDVariable()
    p << f_dbstr_print(GetMapStringAddr(SLOT_OBJECTIVES), u("\x07H: a board in the objectives, second "), second, u("\n"))
    for i in range(20):
        if EUDIf()(occupies(i)):
            p << f_dbstr_print(p, u(framed(PIECE, " %d\n" % (i + 1))))
        if EUDElse()():
            p << f_dbstr_print(p, u(framed(EMPTY10, " %d\n" % (i + 1))))
        EUDEndIf()
    f_dbstr_print(p, u(framed(STACK[0], " 21\n") + framed(STACK[1], " 22\n") + WHITE + "(23) a row of 20: " + "■" * 20))


GLYPHS_1 = ["■", "□", "█", "▀", "▄", "░", "▓", "ㅁ", "　", "●"]
GLYPHS_2 = ["◆", "★", "Ｏ", "▒", "▌", "▐", "■□", "  ", "Ⅰ", "■ (codes between)"]
COLOURS = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0E, 0x0F, 0x10, 0x11,
           0x15, 0x16, 0x17, 0x18, 0x19, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F]


def glyph_row(g):
    if g == "■ (codes between)":
        cells = "".join(("\x08" if i % 2 else "\x0E") + "■" for i in range(10))
    elif len(g) == 2 and g != "  ":
        cells = g * 5
    else:
        cells = g * 10
    return framed(cells, " " + WHITE + {"　": "full-width space", "  ": "two spaces"}.get(g, g))


def onPluginStart():
    pass


def beforeTriggerExec():
    f_setcurpl(P1)
    tick.__iadd__(1)
    beat.__iadd__(1)
    if EUDIf()(beat >= 12):
        beat << 0
    EUDEndIf()
    if EUDIf()(tick >= 24):
        tick << 0
        second.__iadd__(1)
    EUDEndIf()

    if between(2, 11):
        page(["\x07A: line %d of 13 — which numbers do you see?" % n for n in range(1, 14)])
    EUDEndIf()

    if between(12, 23):
        page(["\x07B1: cell characters. Which rows end with their bar under the ■ row's?"] + [glyph_row(g) for g in GLYPHS_1])
    EUDEndIf()
    if between(24, 35):
        page(["\x07B2: more cell characters. Which rows end level? Which glyphs are not drawn?"] + [glyph_row(g) for g in GLYPHS_2])
    EUDEndIf()

    if between(36, 47):
        rows = ["\x07C: the colour codes. Which numbers give a colour of their own?"]
        for k in range(0, len(COLOURS), 6):
            rows.append("".join("%c■■%s%02X  " % (c, WHITE, c) for c in COLOURS[k:k + 6]))
        rows.append(WHITE + "all in a row: " + "".join("%c■" % c for c in COLOURS))
        rows.append(WHITE + "half blocks: " + "".join("%c▀▄" % c for c in COLOURS[:11]))
        page(rows)
    EUDEndIf()

    if between(48, 59):
        page(["\x07D: rows of cells. Which is the longest on one line?"] + [framed("■" * n, " " + str(n)) for n in (10, 15, 20, 25, 30, 40, 50, 60)])
    EUDEndIf()

    if between(60, 69):
        if EUDIf()([beat == 0, tick <= 11]):
            show("\x07E: the next six are ONE Display Text with line breaks. Six lines, or one?")
            show("\x04E1: first\nE2: second\nE3: third\nE4: fourth\nE5: fifth\nE6: sixth")
        EUDEndIf()
    EUDEndIf()

    if at(70):
        row << 0
        fall << 0
    EUDEndIf()
    if between(70, 81):
        move_piece(6, 6)
        full_board("\x07F1: a board, redrawn every frame. Does it flicker or tear?")
    EUDEndIf()
    if between(82, 93):
        move_piece(6, 6)
        redraw.__iadd__(1)
        if EUDIf()(redraw >= 4):
            redraw << 0
            full_board("\x07F2: the same board, redrawn every fourth frame. Better, worse, the same?")
        EUDEndIf()
    EUDEndIf()
    if at(94):
        row << 0
        fall << 0
    EUDEndIf()
    if between(94, 105):
        move_piece(3, 14)
        half_board("\x07F3: twenty rows in ten lines (half blocks). Does the piece fall half a line at a time?")
    EUDEndIf()

    if at(106):
        for n in range(1, 12):
            show("\x04G: printed at second 106, line %d of 11" % n)
        show("\x07G: from now on each line's memory is written every second, no action.")
    EUDEndIf()
    if between(107, 125):
        if EUDIf()(tick == 0):
            for n in range(13):
                f_dbstr_print(TEXT_LINES + LINE * n, u("\x07G: memory of line %d, written at second " % n), second)
        EUDEndIf()
    EUDEndIf()
    if at(118):
        show("\x07G: do you see lines COUNTING? And when did the lines of second 106 fade?")
    EUDEndIf()

    if at(126):
        row << 0
        fall << 0
        f_dbstr_print(GetMapStringAddr(SLOT_BOARD), u("game clock: "), second)
        DoActions([LeaderBoardComputerPlayers(Disable), LeaderBoardKills("Terran Marine", SLOT_BOARD), SetMissionObjectives(SLOT_OBJECTIVES)])
    EUDEndIf()
    if between(126, 160):
        move_piece(6, 18)
        if EUDIf()(fall == 0):
            objectives_board()
        EUDEndIf()
        if EUDIf()(tick == 0):
            f_dbstr_print(GetMapStringAddr(SLOT_BOARD), u("game clock: "), second)
        EUDEndIf()
        if EUDIf()([tick == 0, second <= 156]):
            if EUDIf()(second.AtMost(127)):
                show("\x07H: open the objectives now (F10, Mission Objectives) and keep them open for half a minute.")
            EUDEndIf()
            if EUDIf()(second == 135):
                show("\x07H: does the orange block fall while they are open? Which row numbers show? Is row 23 cut?")
            EUDEndIf()
            if EUDIf()(second == 145):
                show("\x07H: and the leaderboard's game clock: did it go on counting while they were open?")
            EUDEndIf()
        EUDEndIf()
    EUDEndIf()

    if at(161):
        f_dbstr_print(GetMapStringAddr(SLOT_BOARD), u("I:" + "".join("■■■■■■■■■" + str(d % 10) for d in range(1, 8))))
        show("\x07I: the leaderboard's label is now cells with a digit after every ten. The last digit you see?")
    EUDEndIf()
    if at(173):
        show("\x07That is the end of the UI spike. Thank you.")
    EUDEndIf()


def afterTriggerExec():
    pass
