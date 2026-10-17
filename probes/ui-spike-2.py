"""
[uiSpike2]

The UI spike's second round (TrigScript 4, S2): the colours of a board in the text lines. The first
round found that after colour code 05 (grey) every later code on the line is ignored; this round
asks which other codes do that, tries empty cells in colours that are not grey, draws the board the
way the compiler will (one Display Text with line breaks, made in the game, every frame), and times
how long a line stays up. Hand-written eudplib, not the compiler's output.

  A1   2  one code per line, then red, green and blue cells: which lines stay one colour?
  A2  14  the rest of the codes the same way
  B1  26  a board with empty cells in 15 (brown), one Display Text a frame
  B2  38  empty cells in 18 (dark green)
  B3  50  empty cells in 1E (lavender)
  B4  62  empty cells in 0E (blue)
  C   74  one line printed once: at which second (the leaderboard's clock) does it go?

The map's texts are written as UTF-8 (eudplib's own default for a map string is cp949). Built beside
probes/ui-spike-2.ts, which says the same.
"""
from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString

tick = EUDVariable()     # 0..23, a second's frames
second = EUDVariable()
beat = EUDVariable()     # 0..11: a static page is printed again when it is 0
fall = EUDVariable()     # frames since the piece last moved
row = EUDVariable()      # the falling piece's top row

SLOT_SCREEN = ForceAddString(" " * 2047)
SLOT_CLOCK = ForceAddString(" " * 63)
WHITE = "\x04"


def u(s):
    return s.encode("utf-8")


def show(s):
    DoActions(DisplayText(u(s)))


def between(a, b):
    return EUDIf()([second >= a, second <= b])


def at(n):
    return EUDIf()([second == n, tick == 0])


def page(lines):
    if EUDIf()(beat == 0):
        for line in lines:
            show(line)
    EUDEndIf()


CODES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0E, 0x0F, 0x10, 0x11, 0x14,
         0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F]


def code_line(c):
    # White label first, then the code under test on two cells, then cells in three other codes and a word.
    return WHITE + "%02X: " % c + chr(c) + "■■" + "\x08■\x07■\x0E■" + WHITE + " end"


def occupies(i):
    """Row i holds the O piece when its top row is i - 1 or i."""
    return [row == 0] if i == 0 else [row >= i - 1, row <= i]


def board(header, empty):
    """The screen as one text: a header and ten rows, an orange O falling through rows 0..7 above a
    two-row stack, empty cells in the code `empty`. Written into a slot, then one Display Text."""
    e = empty + "□"
    piece = WHITE + "|" + e * 4 + "\x11■■" + e * 4 + WHITE + "|"
    blank = WHITE + "|" + empty + "□" * 10 + WHITE + "|"
    stack = [
        WHITE + "|" + "\x08■■\x0E■■■" + e + "\x07■■\x03■■" + WHITE + "|",
        WHITE + "|" + "\x10■\x07■■■\x11■■\x0F■■■" + e + WHITE + "|",
    ]
    p = EUDVariable()
    p << f_dbstr_print(GetMapStringAddr(SLOT_SCREEN), u(header))
    for i in range(8):
        if EUDIf()(occupies(i)):
            p << f_dbstr_print(p, u("\n" + piece))
        if EUDElse()():
            p << f_dbstr_print(p, u("\n" + blank))
        EUDEndIf()
    f_dbstr_print(p, u("\n" + stack[0] + "\n" + stack[1]))
    DoActions(DisplayText(SLOT_SCREEN))


def move_piece(every, last):
    fall.__iadd__(1)
    if EUDIf()(fall >= every):
        fall << 0
        row.__iadd__(1)
        if EUDIf()(row > last):
            row << 0
        EUDEndIf()
    EUDEndIf()


BOARDS = [
    (26, "15", "\x15", "brown"),
    (38, "18", "\x18", "dark green"),
    (50, "1E", "\x1E", "lavender"),
    (62, "0E", "\x0E", "blue"),
]


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
        f_dbstr_print(GetMapStringAddr(SLOT_CLOCK), u("clock: "), second)
    EUDEndIf()

    if at(1):
        DoActions([LeaderBoardComputerPlayers(Disable), LeaderBoardKills("Terran Marine", SLOT_CLOCK)])
    EUDEndIf()

    if between(2, 13):
        page(["\x07A1: a code, then red, green, blue cells and \"end\". Which lines stay ONE colour after the code?"] + [code_line(c) for c in CODES[:10]])
    EUDEndIf()
    if between(14, 25):
        page(["\x07A2: the rest of the codes. Which lines stay one colour?"] + [code_line(c) for c in CODES[10:]])
    EUDEndIf()

    for start, code, empty, name in BOARDS:
        if at(start):
            row << 0
            fall << 0
        EUDEndIf()
        if between(start, start + 11):
            move_piece(6, 6)
            board("\x07B: empty cells in %s (%s). Is the piece orange, the stack in colour? Easy to read?" % (code, name), empty)
        EUDEndIf()

    if at(74):
        show("\x07C: this line is printed once, at clock 74. At which clock does it go?")
    EUDEndIf()
    if at(100):
        show("\x07That is the end of the second round. Thank you.")
    EUDEndIf()


def afterTriggerExec():
    pass
