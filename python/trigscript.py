"""
[trigscript]
ir : /work/files/trigscript.json

TrigScript's programs: the euddraft plugin that lowers the compiler's IR — data, never
code — into eudplib. The IR file is what the plugin's compiler wrote (docs/ir.md);
this module is handed to the eudplib library plugin as a source with every build, so the
two halves of the IR version are always the same build.

A program is a coroutine the game runs every frame. Its body is lowered to straight-line
eudplib triggers with jumps between labels: `if` / `while` / `switch` become conditional
jumps, and `sleep` stores the label to resume at in a state variable, sets a frame counter,
and leaves the frame. The frame's entry counts the wait down, then jumps to the stored
label. A program runs for the players it is owned by, as a trigger would: one owner runs
it as that player while that player is in the game; several owners, All Players or a force
run it once each frame for every such player who is in the game, CurrentPlayer set, its
variables and its state as 12-slot arrays indexed by the player.

Text is written out in the IR: an action's `text` or `wav` is the string itself, which
eudplib adds to the built map's string table, or a number when the script named an index
of the map's own. The map the user edits never holds a program's strings.

A read is a value of the game taken when the expression is evaluated. What a condition compares
is read from the game's tables where the table is that value (a player's deaths, kills, ore, gas)
and otherwise found by asking the condition itself — "at least 2^31? at least that plus 2^30? …" —
so a read means what the condition means, for a force's minerals or the units at a location alike.
Player facts are bytes of the player tables. Text with values in it is printed through eudplib's
string buffer, for the player it is for and nobody else.

A unit of the game is a pointer into the game's unit table — 1700 slots of 336 bytes — with the slot's
uniqueness byte kept beside it: the game gives a dead unit's slot to the next unit made, so a unit kept
in a variable is checked before every use (a sprite, an order other than "die", the same uniqueness
byte) and reads 0, and takes no write, once it is gone. A loop over units and a pick walk the whole
table with conditions whose address is moved on a slot at a time, as eudplib's own EUDLoopUnit2 does;
a dying unit is passed over. What a unit can be asked and told is what Magenta's probe maps saw
working in Remastered: no position, cloak or speed writes. The game's tables (`stats()`) are plain
cells at addresses the IR carries; a speed is four flingy records, a colour two bytes, a name a string.

What the players do — keys, clicks, the mouse, what they type — happens on one computer, and two
plugins the build adds beside this one bring it to all of them in step. chatEvent (before this
plugin) finds the line the local player typed; this plugin matches it against the programs'
patterns, there and then, into a number for the pattern and up to three values; MSQC (after this
plugin) sends those, the keys and the clicks to every computer as the player they came from, and
keeps each player's mouse in a location. They land in arrays registered by name — which is how the
other two plugins' settings reach them — a cell per player, fresh every frame: an input reads 1 on
the frame it arrives. The IR's `input` lists what is asked for; the editor wrote the settings from it.

Numbers keep one contract with the simulator: 32 bits, a `number` signed and a `u32` not, wrapping at
either end. + - * and the bitwise operators are the same bits whichever way they are read; what reads
them one way or the other - a comparison, a division, a shift right, min and max, a printed number -
says which in the IR (`unsigned`), so nothing here works a type out. Where the game takes nothing below
zero the compiler has already written max(v, 0), and a store keeps stopping at the top of what it holds.
In here a number known when the map is built is a Python int holding the 32 bits, 0 to 2^32 - 1.
"""
import json

from eudplib import *

IR_VERSION = 9
FRAMES_PER_SECOND = 24
# Where the game keeps what a read reads (1.16.1 addresses, which Remastered emulates). The player
# tables are the ones Magenta's probes 5 and 8 read in the game.
DEATHS_TABLE = 0x58A364
KILLS_TABLE = 0x5878A4
ORE_TABLE = 0x57F0F0
GAS_TABLE = 0x57F120
PLAYER_BYTES = {"slot": 0x57F1B4, "race": 0x57F1C0}
# Per race (144 bytes apart: Zerg, Terran, Protoss), a dword per player, in half supplies.
SUPPLY_TABLES = {"provided": 0x582144, "used": 0x582174, "max": 0x5821A4}
# The unit table, and a unit's dwords the scans test (as EPD offsets from the unit's own).
UNIT_TABLE = 0x59CCA8
UNIT_SIZE = 336
UNIT_SLOTS = 1700
UNIT_END = UNIT_TABLE + UNIT_SIZE * UNIT_SLOTS
OFF_SPRITE, OFF_POS, OFF_OWNER_ORDER, OFF_TYPE, OFF_UID = 0x0C // 4, 0x28 // 4, 0x4C // 4, 0x64 // 4, 0xA4 // 4
# units.dat: max hit points (dword, 256 to a point), max shields (word), the group flags a trigger's
# Men / Buildings / Factories go by (byte), the flingy a type moves as (byte).
UNITS_MAX_HP = 0x662350
UNITS_MAX_SHIELDS = 0x660E00
UNITS_GROUP = 0x6637A0
UNITS_FLINGY = 0x6644F8
GROUP_BITS = {230: 0x08, 231: 0x10, 232: 0x20}
# flingy.dat, by flingy id: movement control (byte), top speed (dword), acceleration (word), halt distance (dword).
FLINGY_CONTROL, FLINGY_SPEED, FLINGY_ACCELERATION, FLINGY_HALT = 0x6C9858, 0x6C9EF8, 0x6C9C78, 0x6C9930
MINIMAP_COLOR_OFFSET = 0x581DD6 - 0x581D76
# The location table, and the one an order borrows for the length of one action (put back after).
MRGN = 0x58DC60
SCRATCH_LOCATION = 255
UNIT_TIMERS = {"stim": "stimTimer", "ensnare": "ensnareTimer", "plague": "plagueTimer", "lockdown": "lockdownTimer", "maelstrom": "maelstromTimer", "irradiate": "irradiateTimer", "stasis": "stasisTimer"}
STATUS_INVINCIBLE, STATUS_HALLUCINATION, STATUS_BURROWED, STATUS_CLOAKED = 0x04000000, 0x40000000, 0x00000010, 0x00000300
COND_COMMAND, COND_BRING, COND_ACCUMULATE, COND_KILL, COND_OPPONENTS, COND_DEATHS = 2, 3, 4, 5, 14, 15
CURRENT_PLAYER = 13
# The state of a program whose body ended: nothing resumes it.
DONE = 0xFFFFFFFF
U32 = 0xFFFFFFFF
SIGN = 0x80000000

MINUS_SIGN = Db(b"-\0\0\0")
NO_SIGN = Db(b"\0\0\0\0")

with open(settings["ir"], encoding="utf-8") as _f:
    IR = json.load(_f)
if IR.get("version") != IR_VERSION:
    raise RuntimeError("trigscript: the IR is version %r; this plugin reads version %d" % (IR.get("version"), IR_VERSION))


def where(node):
    """" at main.ts:12:5" for a node with a position — what the editor parses back into a marker."""
    at = node.get("at") if isinstance(node, dict) else None
    if not at:
        return ""
    if at.get("file"):
        return " at %s:%s:%s" % (at.get("file"), at.get("line"), at.get("column"))
    return " at %s:%s" % (at.get("line"), at.get("column"))


class Fail(RuntimeError):
    pass


class Leave(Exception):
    """Raised through the lowering when a statement ends the straight line (break / continue / return)."""


class Storage:
    """A variable's cell: plain, or a 12-slot row of a per-player program."""

    def __init__(self, decl, per_player, player_of):
        self.decl = decl
        self.bits = decl.get("bits")
        self.rowed = per_player and not decl.get("shared")
        self.player_of = player_of
        self.store = EUDArray([0] * 12) if self.rowed else EUDVariable(0)  # initial: the variable's own cell

    def get(self):
        return self.store[self.player_of()] if self.rowed else self.store

    def set(self, value):
        if self.bits:
            value = saturate(value, self.bits)
        if self.rowed:
            self.store[self.player_of()] = value
        else:
            self.store << value


class ArrayStorage:
    """An array's cells: `length` of them, twelve rows of that in a per-player program, or - `values` - a list
    the script computed when it was built, which is in the map as it loads and which nothing writes. An index
    past either end (read from 0 up, so one below zero too) reads 0 and stores nothing."""

    def __init__(self, decl, per_player, player_of):
        self.decl = decl
        self.length = int(decl["length"])
        self.bits = decl.get("bits")
        values = decl.get("values")
        self.rowed = per_player and not decl.get("shared") and values is None
        self.player_of = player_of
        self.store = EUDArray([int(v) & U32 for v in values] if values is not None else [0] * (self.length * (12 if self.rowed else 1)))  # initial: a table's values, or cells declareArray sets

    def at(self, index):
        """The cell's place among the store's: the player's row first."""
        if not self.rowed:
            return index
        p = self.player_of()
        row = p * self.length if isinstance(p, int) else f_mul(p, self.length)
        return row + index

    def get(self, index):
        if isinstance(index, int):
            return self.store[self.at(index)] if index < self.length else 0
        out = fresh(0)
        if EUDIf()(index <= self.length - 1):
            out << self.store[self.at(index)]
        EUDEndIf()
        return out

    def set(self, index, value):
        if self.bits:
            value = saturate(value, self.bits)
        if isinstance(index, int):
            if index < self.length:
                self.store[self.at(index)] = value
            return
        if EUDIf()(index <= self.length - 1):
            self.store[self.at(index)] = value
        EUDEndIf()

    def fill(self, value):
        if self.length <= 16:
            for i in range(self.length):
                self.set(i, value)
            return
        v, i = as_var(value), fresh(0)
        if EUDWhile()(i <= self.length - 1):
            self.set(i, v)
            i += 1
        EUDEndWhile()


# The heap the programs' growing arrays share. A block is a power of two of cells, four at least; one given back
# waits in its size's list (its first cell links the next) for whoever wants that size next; new ground is taken
# from the bottom up, and the stack - recursion's, to come - will take it from the top down. Cell 0 is never
# handed out: 0 is "no block". compiler/simulateIr.ts counts the same way, so both run out at the same push.
HEAP_CELLS = min(1 << 20, max(1024, int(IR.get("heap", 16384))))  # the map's script settings, or the default
HEAP_SMALLEST = 4
HEAP_ROOMS = []
while HEAP_SMALLEST << len(HEAP_ROOMS) <= HEAP_CELLS:
    HEAP_ROOMS.append(HEAP_SMALLEST << len(HEAP_ROOMS))
_HEAP = {}


def heap():
    """The heap's cells and its functions, made when the first growing array is met."""
    if _HEAP:
        return _HEAP
    cells = EUDArray(HEAP_CELLS)
    rooms = EUDArray(HEAP_ROOMS + [0xFFFFFFFF])  # initial: the sizes, never written
    free = EUDArray(len(HEAP_ROOMS))  # initial: no block waits
    top = EUDVariable(1)  # initial: the heap's own state, for the whole game
    stack = EUDVariable(HEAP_CELLS)  # initial: the heap's own state
    said = EUDVariable(0)  # initial: the heap's own state

    @EUDFunc
    def take(k):
        """A block of size class k: its place among the cells, or 0 when there is none."""
        at = EUDVariable()
        at << free[k]
        if EUDIf()(at >= 1):
            free[k] = cells[at]
            EUDReturn(at)
        EUDEndIf()
        end = top + rooms[k]
        if EUDIf()(end <= stack):
            at << top
            top << end
            EUDReturn(at)
        EUDEndIf()
        EUDReturn(0)

    @EUDFunc
    def give(at, k):
        cells[at] = free[k]
        free[k] = at

    @EUDFunc
    def grow(ptr, length, room, k, need):
        """Room for `need` cells: a larger block, the cells copied over, the old block given back. Returns the
        handle as it is now and whether there is room; when the heap has no block left the handle is unchanged."""
        if EUDIf()(need <= room):
            EUDReturn(ptr, room, k, 1)
        EUDEndIf()
        nk = EUDVariable()
        nk << 0
        if EUDIf()(ptr >= 1):
            nk << k + 1
        EUDEndIf()
        if EUDWhile()(rooms[nk] < need):
            nk += 1
        EUDEndWhile()
        if EUDIf()(nk >= len(HEAP_ROOMS)):
            EUDReturn(ptr, room, k, 0)
        EUDEndIf()
        block = take(nk)
        if EUDIf()(block == 0):
            EUDReturn(ptr, room, k, 0)
        EUDEndIf()
        if EUDIf()(ptr >= 1):
            if EUDIf()(length >= 1):
                # An EUDArray's own value is where it is, as an EPD already.
                f_repmovsd_epd(cells + block, cells + ptr, length)
            EUDEndIf()
            give(ptr, k)
        EUDEndIf()
        EUDReturn(block, rooms[nk], nk, 1)

    @EUDFunc
    def push(ptr, length, room, k, value):
        """One more cell at the end; the handle as it is afterwards. Nothing is pushed when the heap is full."""
        ptr, room, k, ok = grow(ptr, length, room, k, length + 1)
        if EUDIf()(ok >= 1):
            cells[ptr + length] = value
            length += 1
        if EUDElse()():
            if EUDIf()(said == 0):
                said << 1
                GetGlobalStringBuffer().print("\x06TrigScript: out of memory - an array could not grow (the programs' arrays share %d cells)." % HEAP_CELLS)
            EUDEndIf()
        EUDEndIf()
        EUDReturn(ptr, length, room, k)

    @EUDFunc
    def reserve(n):
        """The stack's: n cells from the top down; their place, or 0 when the heap has grown up to there."""
        if EUDIf()(top + n <= stack):
            stack -= n
            EUDReturn(stack)
        EUDEndIf()
        EUDReturn(0)

    @EUDFunc
    def release(n):
        stack += n

    _HEAP.update(cells=cells, take=take, give=give, grow=grow, push=push, reserve=reserve, release=release)
    return _HEAP


class ListStorage:
    """An array that grows: a handle - where its block is among the heap's cells (0: none yet), how many cells are
    in use, how many the block has room for, and the block's size class - a cell each, or a row of twelve each in
    a per-player program. Reads and stores are bounded by the cells in use; a store at exactly the length is a push."""

    def __init__(self, decl, per_player, player_of):
        self.decl = decl
        self.bits = decl.get("bits")
        self.rowed = per_player and not decl.get("shared")
        self.player_of = player_of
        make = (lambda: EUDArray([0] * 12)) if self.rowed else (lambda: EUDVariable(0))  # initial: no block
        self.handle = {name: make() for name in ("ptr", "len", "room", "k")}
        self.heap = heap()

    def field(self, name):
        cell = self.handle[name]
        return cell[self.player_of()] if self.rowed else cell

    def put(self, name, value):
        if self.rowed:
            self.handle[name][self.player_of()] = value
        else:
            self.handle[name] << value

    def length(self):
        return self.field("len")

    def get(self, index):
        out = fresh(0)
        if EUDIf()(as_var(index) < as_var(self.field("len"))):
            out << self.heap["cells"][self.field("ptr") + index]
        EUDEndIf()
        return out

    def push(self, value):
        if self.bits:
            value = saturate(value, self.bits)
        ptr, length, room, k = self.heap["push"](self.field("ptr"), self.field("len"), self.field("room"), self.field("k"), value)
        for name, v in (("ptr", ptr), ("len", length), ("room", room), ("k", k)):
            self.put(name, v)

    def set(self, index, value):
        if self.bits:
            value = saturate(value, self.bits)
        i, v, n = as_var(index), fresh(value), as_var(self.field("len"))
        if EUDIf()(i < n):
            self.heap["cells"][self.field("ptr") + i] = v
        if EUDElseIf()(i == n):
            self.push(v)  # xs[xs.length] = v, as JavaScript has it
        EUDEndIf()

    def pop(self):
        out = fresh(0)
        n = fresh(self.field("len"))
        if EUDIf()(n >= 1):
            n -= 1
            self.put("len", n)
            out << self.heap["cells"][self.field("ptr") + n]
        EUDEndIf()
        return out

    def set_length(self, value):
        v = as_var(value)
        if EUDIf()(v < as_var(self.field("len"))):
            self.put("len", v)
        EUDEndIf()

    def declare(self, values):
        """Declared (again): the block it held goes back, and it starts over with these values."""
        ptr = fresh(self.field("ptr"))
        if EUDIf()(ptr >= 1):
            self.heap["give"](ptr, self.field("k"))
        EUDEndIf()
        for name in ("ptr", "len", "room", "k"):
            self.put(name, 0)
        for v in values:
            self.push(v)

    def declare_filled(self, value, count):
        """The same with one value `count` times over: a loop, where a push a cell would be a push a cell in the map."""
        if count <= 8:
            self.declare([value] * count)
            return
        self.declare([])
        v, i = as_var(value), fresh(0)
        if EUDWhile()(i <= count - 1):
            self.push(v)
            i += 1
        EUDEndWhile()

    def fill(self, value):
        v, i = as_var(value), fresh(0)
        if EUDWhile()(i < as_var(self.field("len"))):
            self.heap["cells"][self.field("ptr") + i] = v
            i += 1
        EUDEndWhile()


class UnitRef:
    """A unit of the game as the lowering holds it: the pointer, its EPD, and the slot's uniqueness byte
    (as it sits in its dword, masked 0xFF00). `uid` None is the unit of a loop's turn, there by
    construction; a pointer that is the int 0 is no unit at all."""

    def __init__(self, ptr, epd, uid=None):
        self.ptr, self.epd, self.uid = ptr, epd, uid

    @property
    def none(self):
        return isinstance(self.ptr, int) and self.ptr == 0


NO_UNIT = UnitRef(0, 0, 0)


class UnitStorage:
    """A unit variable: three cells, or three 12-slot rows of a per-player program."""

    def __init__(self, decl, per_player, player_of):
        self.decl = decl
        self.rowed = per_player
        self.player_of = player_of
        make = (lambda: EUDArray([0] * 12)) if self.rowed else (lambda: EUDVariable(0))  # initial: no unit
        self.ptr, self.epd, self.uid = make(), make(), make()

    def get(self):
        if self.rowed:
            p = self.player_of()
            return UnitRef(self.ptr[p], self.epd[p], self.uid[p])
        return UnitRef(self.ptr, self.epd, self.uid)

    def set(self, ref):
        uid = ref.uid
        if uid is None:
            # The unit of a loop's turn is there now: this is when its slot's uniqueness byte is taken.
            uid = f_maskread_epd(ref.epd + OFF_UID, 0xFF00)
        for cell, value in ((self.ptr, ref.ptr), (self.epd, ref.epd), (self.uid, uid)):
            if self.rowed:
                cell[self.player_of()] = value
            else:
                cell << value


class LoopUnit:
    """The variable of a loop over units: the scan's own pointer, never kept past the loop."""

    def __init__(self, ref):
        self.ref = ref

    def get(self):
        return self.ref

    def set(self, ref):
        raise Fail("trigscript: the unit of a loop's turn cannot be assigned")


def saturate(value, bits):
    top = (1 << bits) - 1
    if isinstance(value, int):
        return min(value, top)
    v = EUDVariable()
    v << value
    if EUDIf()(v >= top + 1):
        v << top
    EUDEndIf()
    return v


def as_var(value):
    if isinstance(value, int):
        return EUDVariable(value & U32)  # initial: a constant, never written
    return value


def fresh(value=0):
    """A temporary that starts from `value` every time the code runs. `EUDVariable(n)` is not
    that: n is the cell's value when the map loads, so a temporary built that way and then
    written keeps what the last run left in it — `ticks + 1` went 1, 2, 4, 8 (found in the
    first played probe, 2026-09-18). Anything the lowering writes to starts here."""
    v = EUDVariable()
    v << value
    return v


class Lowering:
    def __init__(self, program):
        self.p = program
        self.per_player = bool(program.get("perPlayer"))
        self.owner = int(program.get("owner", 0))
        self.slots = owner_slots(program)
        self.player = None
        self.vars = {}
        self.arrays = {a["id"]: (ListStorage if a.get("dynamic") else ArrayStorage)(a, self.per_player, self.player_of) for a in program.get("arrays", [])}
        self.state = EUDArray([0] * 12) if self.per_player else EUDVariable(0)  # initial: program state
        self.wait = EUDArray([0] * 12) if self.per_player else EUDVariable(0)  # initial: program state
        self.resumes = []  # (index, Forward) for every sleep
        self.frame_end = None
        self.latches = {}

    # ── storage ──
    def player_of(self):
        if self.player is None:
            raise Fail("trigscript: a per-player variable outside the player loop")
        return self.player

    def declare(self, decl):
        if decl.get("kind") == "unit":
            s = UnitStorage(decl, self.per_player, self.player_of)
        else:
            s = Storage(decl, self.per_player, self.player_of)
        self.vars[decl["id"]] = s
        return s

    def array(self, id_, node=None):
        a = self.arrays.get(id_)
        if a is None:
            raise Fail("trigscript: unknown array %r%s" % (id_, where(node)))
        return a

    def var(self, id_, node=None):
        s = self.vars.get(id_)
        if s is None:
            raise Fail("trigscript: unknown variable %r%s" % (id_, where(node)))
        return s

    def get_state(self):
        return self.state[self.player] if self.per_player else self.state

    def set_state(self, value):
        if self.per_player:
            self.state[self.player] = value
        else:
            self.state << value

    def get_wait(self):
        return self.wait[self.player] if self.per_player else self.wait

    def set_wait(self, value):
        if self.per_player:
            self.wait[self.player] = value
        else:
            self.wait << value

    # ── numbers: an int (the 32 bits, 0 … 2^32 - 1) or an EUDVariable ──
    def num(self, e):
        k = e["kind"]
        if k == "input":
            return INPUT.read(e["input"], self, e)
        if k == "const":
            return int(e["value"]) & U32
        if k == "var":
            return self.var(e["id"], e).get()
        if k == "element":
            return self.array(e["array"], e).get(self.num(e["index"]))
        if k == "length":
            a = self.array(e["array"], e)
            return a.length() if isinstance(a, ListStorage) else a.length
        if k == "pop":
            return self.array(e["array"], e).pop()
        if k == "cast":
            return self.num(e["expr"])
        if k == "unary":
            x = self.num(e["expr"])
            return (-x) & U32 if isinstance(x, int) else 0 - x
        if k == "binary":
            return self.binary(e)
        if k == "read":
            return self.read(e)
        if k == "randomInt":
            # 0 … n - 1; an n of 0 gives 0, as a 0 divisor does.
            n = self.num(e["bound"])
            if isinstance(n, int):
                if n <= 1:
                    return 0
                return f_div(f_dwrand(), n)[1]
            out = fresh(0)
            if EUDIf()(n >= 1):
                out << f_div(f_dwrand(), n)[1]
            EUDEndIf()
            return out
        if k == "unitField":
            return self.unit_field(e)
        if k == "unitPart":
            return self.unit_part(e)
        if k == "tableRead":
            return self.table_read(e["cell"], e)
        if k == "ternary":
            t = EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                t << self.num(e["whenTrue"])
            if EUDElse()():
                t << self.num(e["whenFalse"])
            EUDEndIf()
            return t
        if k == "intrinsic" and e["name"] == "abs":
            x = self.num(e["args"][0])
            if isinstance(x, int):
                return abs(signed(x)) & U32
            t = fresh(x)
            if EUDIf()(t >= SIGN):
                t << 0 - t
            EUDEndIf()
            return t
        if k == "intrinsic":
            a, b = [self.num(x) for x in e["args"]]
            name = e["name"]
            unsigned = bool(e.get("unsigned"))
            if isinstance(a, int) and isinstance(b, int):
                key = (lambda v: v) if unsigned else signed
                return min(a, b, key=key) if name == "min" else max(a, b, key=key)
            t = EUDVariable()
            if EUDIf()(self.ordered(a, "<=" if name == "min" else ">=", b, unsigned)):
                t << a
            if EUDElse()():
                t << b
            EUDEndIf()
            return t
        if k == "call":
            return self.call(e["call"])
        raise Fail("trigscript: unknown expression %r%s" % (k, where(e)))

    def binary(self, e):
        a, b = self.num(e["left"]), self.num(e["right"])
        op = e["op"]
        if op in BITWISE:
            return self.bitwise(op, a, b)
        both = isinstance(a, int) and isinstance(b, int)
        if op == "+":
            return (a + b) & U32 if both else a + b
        if op == "-":
            return (a - b) & U32 if both else a - b
        if op == "*":
            return (a * b) & U32 if both else f_mul(as_var(a), as_var(b))
        # / and %: towards zero, the remainder with the dividend's sign, unless both sides are u32s. A divisor of 0 gives 0.
        unsigned = bool(e.get("unsigned"))
        pick = (lambda q, r: q) if op == "/" else (lambda q, r: r)
        if isinstance(b, int):
            if b == 0:
                raise Fail("trigscript: division by zero%s" % where(e))
            if both:
                if unsigned:
                    return pick(a // b, a % b)
                x, y = signed(a), signed(b)
                q = abs(x) // abs(y) * (-1 if (x < 0) != (y < 0) else 1)
                return pick(q, x - q * y) & U32
            return pick(*(f_div(a, b) if unsigned else f_div_towards_zero(fresh(a), signed(b))))
        out = fresh(0)
        if EUDIf()(b >= 1):
            q, r = f_div(as_var(a), b) if unsigned else f_div_towards_zero(fresh(a), fresh(b))
            out << pick(q, r)
        EUDEndIf()
        return out

    def ordered(self, a, op, b, unsigned):
        """`a op b` as one condition, the two read as u32s (`unsigned` true), as signed numbers (false), or one of
        each ("left" / "right" names the u32) - exactly: a number below zero is smaller than any u32. At least one
        side is a variable. A signed order is the unsigned one with the top bit of both sides flipped."""
        if unsigned in ("left", "right"):
            # s is the signed side, u the u32, and the comparison is turned to read s op u.
            s_, u_ = (b, a) if unsigned == "left" else (a, b)
            if unsigned == "left":
                op = FLIPPED[op]
            if isinstance(s_, int):
                if s_ >= SIGN:
                    return always(op in ("<", "<=", "!="))
                return self.ordered(s_, op, u_, True)
            sv = as_var(s_)
            if op in ("<", "<=", "!="):
                return EUDOr(sv >= SIGN, relation(sv, op, u_))
            return EUDAnd(sv <= SIGN - 1, relation(sv, op, u_))
        if isinstance(a, int):
            a, b, op = b, a, FLIPPED[op]
        if unsigned or op in ("==", "!="):
            return relation(as_var(a), op, b)
        return relation(a + SIGN, op, (b + SIGN) & U32 if isinstance(b, int) else b + SIGN)

    @staticmethod
    def bitwise(op, a, b):
        """& | ^ << >> >>> over 32 bits. `>>` keeps the sign of what it shifts and `>>>` does not; a shift by 32 or
        more leaves nothing but that sign."""
        if op in ("<<", ">>", ">>>"):
            if isinstance(a, int) and isinstance(b, int):
                if op == "<<":
                    return 0 if b >= 32 else (a << b) & U32
                if op == ">>>":
                    return 0 if b >= 32 else a >> b
                return (signed(a) >> min(b, 31)) & U32
            if isinstance(b, int) and b == 0:
                return a
            if isinstance(b, int) and b >= 32 and op != ">>":
                return 0
            if op == "<<":
                return f_bitlshift(fresh(a), b)
            if op == ">>>":
                return f_bitrshift(fresh(a), b)
            # The sign kept: a number below zero is shifted as its complement, which has zeros where it has ones.
            x, below = fresh(a), fresh(0)
            if EUDIf()(x >= SIGN):
                below << 1
                x << ~x
            EUDEndIf()
            r = fresh(f_bitrshift(x, b)) if not (isinstance(b, int) and b >= 32) else fresh(0)
            if EUDIf()(below >= 1):
                r << ~r
            EUDEndIf()
            return r
        if isinstance(a, int) and isinstance(b, int):
            return {"&": a & b, "|": a | b, "^": a ^ b}[op]
        # Copies: eudplib computes in place into an operand nothing else refers to, and ours may be a variable's own cell.
        x, y = fresh(a), fresh(b)
        return x & y if op == "&" else x | y if op == "|" else x ^ y

    # ── reads: a value of the game ──
    def current(self):
        """The player the program is running as: a slot, or the player loop's variable."""
        return self.player if self.per_player else self.slots[0]

    def one_player(self, p, node):
        if p == CURRENT_PLAYER:
            return self.current()
        if 0 <= p < 12:
            return p
        raise Fail("trigscript: a read takes one player%s" % where(node))

    def read(self, e):
        r = e["read"]
        source = r.get("source")
        if source == "condition":
            return self.read_condition(r["record"], e)
        if source == "player" and r.get("fact") == "left":
            return self.read_left(r, e)
        if source == "player":
            base = PLAYER_BYTES.get(r.get("fact"))
            if base is None:
                raise Fail("trigscript: unknown player fact %r%s" % (r.get("fact"), where(e)))
            value = f_bread(base + self.one_player(r["player"], e))
            if r.get("fact") == "slot":
                # A computer of a Use Map Settings game keeps the map's own number, 5; a melee computer is 1
                # (the slice 2 probe read 5 for one). Both are "a computer": one number for the script.
                kind = fresh(value)
                if EUDIf()(kind == 5):
                    kind << 1
                EUDEndIf()
                return kind
            return value
        if source == "supply":
            return self.read_supply(r, e)
        raise Fail("trigscript: unknown read %r%s" % (source, where(e)))

    def read_left(self, r, e):
        """1 once a player who was in the map's settings as a human or a computer is gone. Asked the way
        eudplib's f_playerexist asks (the player's trigger list), which the player loop already relies on.
        The byte table at 0x581D62 read 0 for players who were there, as it should, but nobody has seen it
        turn 1 in a game — a computer never leaves — so it is not what this rests on."""
        p = self.one_player(r["player"], e)
        if isinstance(p, int) and (p >= 8 or GetPlayerInfo(p).typestr not in ("Human", "Computer")):
            return 0
        gone = fresh(1)
        if EUDIf()(f_playerexist(p)):
            gone << 0
        EUDEndIf()
        return gone

    def read_supply(self, r, e):
        base = SUPPLY_TABLES.get(r.get("of"))
        if base is None:
            raise Fail("trigscript: unknown supply %r%s" % (r.get("of"), where(e)))
        p = self.one_player(r["player"], e)
        half = fresh(0)
        if r.get("race") is None:
            # The race the player plays; a slot with none (neutral, empty) has no supply.
            race = f_bread(PLAYER_BYTES["race"] + p)
            if EUDIf()(race <= 2):
                half << f_dwread_epd(EPD(base) + race * 36 + p)
            EUDEndIf()
        else:
            half << f_dwread_epd(EPD(base) + int(r["race"]) * 36 + p)
        # As the top bar shows it: half a supply in use counts as one.
        if r["of"] == "used":
            half += 1
        return half // 2

    def read_condition(self, rec, e):
        t, player, unit = rec["type"], rec["player"], rec["unitId"]
        one = player == CURRENT_PLAYER or not 12 <= player <= 26  # not a group; beyond 26 is an EUD offset, read as it stands
        table = None
        if one and t in (COND_DEATHS, COND_KILL) and not 229 <= unit <= 232:
            table = (DEATHS_TABLE if t == COND_DEATHS else KILLS_TABLE, unit * 12)
        elif one and t == COND_ACCUMULATE and rec["resource"] in (0, 1):
            table = (ORE_TABLE if rec["resource"] == 0 else GAS_TABLE, 0)
        if table is not None:
            p = self.current() if player == CURRENT_PLAYER else player
            return f_dwread_epd(EPD(table[0]) + table[1] + p)
        # No table holds it (a group's sum, units counted at a location, a score, a clock): ask the
        # condition, a bit at a time from the top. A unit count stays under 2^12, a number of players under 2^4.
        bits = 12 if t in (COND_BRING, COND_COMMAND) else 4 if t == COND_OPPONENTS else 32
        found = fresh(0)
        for bit in reversed(range(bits)):
            probe = found + (1 << bit)
            if EUDIf()(Condition(rec["location"], player, probe, unit, 0, t, rec["resource"], rec["flags"], eudx=rec.get("mask", 0) or 0)):
                found << probe
            EUDEndIf()
        return found

    # ── booleans: an eudplib condition ──
    def cond(self, e):
        k = e["kind"]
        if k == "const":
            return always(e["value"])
        if k == "cond":
            return condition(e["record"])
        if k == "var":
            return as_var(self.var(e["id"], e).get()) >= 1
        if k == "element":
            return as_var(self.array(e["array"], e).get(self.num(e["index"]))) >= 1
        if k == "pop":
            return as_var(self.array(e["array"], e).pop()) >= 1
        if k == "test":
            return as_var(self.num(e["expr"])) >= 1
        if k == "compare":
            a, b = self.num(e["left"]), self.num(e["right"])
            op, unsigned = e["op"], e.get("unsigned", False)
            if isinstance(a, int) and isinstance(b, int):
                x = a if unsigned in (True, "left") else signed(a)
                y = b if unsigned in (True, "right") else signed(b)
                return always(compare(x, op, y))
            # One comparison, built once: a comparison between variables writes into its own
            # condition, and one that is built and dropped is an orphan eudplib refuses.
            return self.ordered(a, op, b, unsigned)
        if k == "and":
            return EUDAnd(*[self.cond(c) for c in e["items"]])
        if k == "or":
            return EUDOr(*[self.cond(c) for c in e["items"]])
        if k == "not":
            return EUDNot(self.cond(e["expr"]))
        if k == "random":
            return (f_rand() & 1) >= 1
        if k in ("unitAlive", "unitFlag", "unitSame"):
            return as_var(self.truth(e)) >= 1
        if k == "edge":
            return self.edge(e)
        if k == "ternary":
            t = EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                t << self.truth(e["whenTrue"])
            if EUDElse()():
                t << self.truth(e["whenFalse"])
            EUDEndIf()
            return t >= 1
        if k == "call":
            return as_var(self.call(e["call"])) >= 1
        raise Fail("trigscript: unknown condition %r%s" % (k, where(e)))

    def truth(self, e):
        """A boolean expression as 0 / 1."""
        if e["kind"] == "const":
            return 1 if e["value"] else 0
        if e["kind"] == "var":
            return self.var(e["id"], e).get()
        if e["kind"] == "element":
            return self.array(e["array"], e).get(self.num(e["index"]))
        if e["kind"] == "pop":
            return self.array(e["array"], e).pop()
        if e["kind"] == "unitAlive":
            ref = self.unit(e["unit"])
            t = fresh(0)
            if not ref.none:
                self.when_alive(ref, lambda: t << 1)
            return t
        if e["kind"] == "unitFlag":
            return self.unit_flag(e)
        if e["kind"] == "unitSame":
            a, b = self.unit(e["left"]), self.unit(e["right"])
            t = fresh(0)
            if not a.none and not b.none:
                ap, bp = as_var(a.ptr), as_var(b.ptr)
                if EUDIf()([ap >= 1, ap == bp]):
                    t << 1
                EUDEndIf()
            return t
        t = fresh(0)
        if EUDIf()(self.cond(e)):
            t << 1
        EUDEndIf()
        return t

    def edge(self, e):
        """rose(c): true on the frame c becomes true; once(c): true the first time it holds."""
        key = id(e)
        if key not in self.latches:
            self.latches[key] = EUDArray([0] * 12) if self.per_player else EUDVariable(0)  # initial: the latch
        latch = self.latches[key]

        def get():
            return latch[self.player] if self.per_player else latch

        def put(v):
            if self.per_player:
                latch[self.player] = v
            else:
                latch << v

        fired = fresh(0)
        held = self.truth(e["cond"])
        if EUDIf()(as_var(held) >= 1):
            if EUDIf()(as_var(get()) == 0):
                fired << 1
                put(1)
            EUDEndIf()
        if EUDElse()():
            if e["edge"] == "rose":
                put(0)
        EUDEndIf()
        return fired >= 1

    # ── units: a pointer into the game's unit table, checked before use ──
    def unit(self, e):
        k = e["kind"]
        if k == "unitNull":
            return NO_UNIT
        if k == "unitVar":
            return self.var(e["id"], e).get()
        if k == "pick":
            return self.pick(e)
        if k == "unitAt":
            # A unit kept as three numbers of the program (a cell each of an array of units): re-checked like any kept unit.
            ptr = self.num(e["ptr"])
            if isinstance(ptr, int) and ptr == 0:
                return NO_UNIT
            return UnitRef(fresh(ptr), fresh(self.num(e["epd"])), fresh(self.num(e["uid"])))
        if k == "call":
            return self.call(e["call"])
        raise Fail("trigscript: unknown unit expression %r%s" % (k, where(e)))

    def unit_part(self, e):
        """One of the three numbers a unit is kept as. The unit of a loop's turn has no uniqueness byte taken yet: it is read here."""
        ref = self.unit(e["unit"])
        if ref.none:
            return 0
        part = e["part"]
        if part == "ptr":
            return ref.ptr
        if part == "epd":
            return ref.epd
        return f_maskread_epd(ref.epd + OFF_UID, 0xFF00) if ref.uid is None else ref.uid

    def when_alive(self, ref, body):
        """`body()` when the unit is still the one that was kept: the slot has a sprite, its order is not
        "die", and its uniqueness byte is the one taken with the pointer."""
        if ref.none:
            return
        if ref.uid is None:
            body()
            return
        ptr, epd = as_var(ref.ptr), as_var(ref.epd)
        if EUDIf()([ptr >= 1, MemoryEPD(epd + OFF_SPRITE, AtLeast, 1), MemoryXEPD(epd + OFF_OWNER_ORDER, AtLeast, 0x100, 0xFF00), MemoryXEPD(epd + OFF_UID, Exactly, ref.uid, 0xFF00)]):
            body()
        EUDEndIf()

    @staticmethod
    def cunit(ref):
        return CUnit(ref.epd, ptr=ref.ptr)

    def unit_field(self, e):
        ref = self.unit(e["unit"])
        out = fresh(0)
        self.when_alive(ref, lambda: out << self.field_of(self.cunit(ref), e["field"], e))
        return out

    def field_of(self, cu, field, node):
        """A unit's number, in the script's units: whole points for hit points (as the game shows them,
        a started point counting), shields and energy."""
        if field == "hp":
            return f_div(cu.hp + 255, 256)[0]
        if field == "maxHp":
            return f_div(f_dwread_epd(EPD(UNITS_MAX_HP) + cu.unitType), 256)[0]
        if field == "shields":
            return f_div(cu.shield, 256)[0]
        if field == "maxShields":
            return f_wread(UNITS_MAX_SHIELDS + cu.unitType * 2)
        if field == "energy":
            return f_div(cu.energy, 256)[0]
        if field in UNIT_TIMERS:
            return getattr(cu, UNIT_TIMERS[field])
        name = {"owner": "owner", "type": "unitType", "x": "posX", "y": "posY", "kills": "killCount", "orderId": "orderID", "cooldown": "groundWeaponCooldown", "resources": "resourceAmount"}.get(field)
        if name is None:
            raise Fail("trigscript: unknown unit field %r%s" % (field, where(node)))
        return getattr(cu, name)

    def unit_flag(self, e):
        ref = self.unit(e["unit"])
        out = fresh(0)

        def body():
            cu = self.cunit(ref)
            flag = e["flag"]
            if flag == "underAttack":
                held = cu.attackNotifyTimer >= 1
            else:
                mask = {"hallucinated": STATUS_HALLUCINATION, "cloaked": STATUS_CLOAKED, "burrowed": STATUS_BURROWED, "invincible": STATUS_INVINCIBLE}.get(flag)
                if mask is None:
                    raise Fail("trigscript: unknown unit flag %r%s" % (flag, where(e)))
                held = cu.check_status_flag(mask)
            if EUDIf()(held):
                out << 1
            EUDEndIf()

        self.when_alive(ref, body)
        return out

    def location_bounds(self, number):
        base = EPD(MRGN + (int(number) - 1) * 20)
        return [f_dwread_epd(base + i) for i in range(4)]

    def scan(self, flt, node, body):
        """The game's unit table, slot by slot: `body(ref, next_, exit_)` for every unit on the map the
        filter matches. Every test is one condition whose address moves on with the slot, so a slot
        that does not match costs a trigger or two."""
        ptr, epd = EUDVariable(), EUDVariable()
        empty = MemoryEPD(0, Exactly, 0)
        dying = MemoryXEPD(0, Exactly, 0, 0xFF00)
        moving = [(empty, OFF_SPRITE), (dying, OFF_OWNER_ORDER)]
        match, values = [], []
        owner = flt.get("owner")
        if owner is not None:
            who = self.current() if owner == CURRENT_PLAYER else int(owner)
            c = MemoryXEPD(0, Exactly, who if isinstance(who, int) else 0, 0xFF)
            match.append(c)
            moving.append((c, OFF_OWNER_ORDER))
            if not isinstance(who, int):
                values.append((c, who))
        kind = flt.get("type")
        if kind is not None and kind < 228:
            c = MemoryXEPD(0, Exactly, int(kind), 0xFFFF)
            match.append(c)
            moving.append((c, OFF_TYPE))
        elif kind is not None and kind not in GROUP_BITS:
            raise Fail("trigscript: unknown unit type %r%s" % (kind, where(node)))
        if flt.get("at"):
            left, top, right, bottom = self.location_bounds(flt["at"])
            # A location reaching past the map's edge starts below zero, which a unit's position never is.
            for v in (left, top):
                if EUDIf()(v >= 0x80000000):
                    v << 0
                EUDEndIf()
            for comparison, mask, value in ((AtLeast, 0xFFFF, left), (AtMost, 0xFFFF, right), (AtLeast, 0xFFFF0000, f_bitlshift(top, 16)), (AtMost, 0xFFFF0000, f_bitlshift(bottom, 16))):
                c = MemoryXEPD(0, comparison, 0, mask)
                match.append(c)
                moving.append((c, OFF_POS))
                values.append((c, value))
        DoActions([ptr.SetNumber(UNIT_TABLE), epd.SetNumber(EPD(UNIT_TABLE))] + [SetMemory(c + 4, SetTo, EPD(UNIT_TABLE) + off) for c, off in moving])
        for c, value in values:
            f_dwwrite_epd(EPD(c + 8), value)
        head, next_, exit_ = Forward(), Forward(), Forward()
        head << NextTrigger()
        EUDJumpIf(ptr >= UNIT_END, exit_)
        EUDJumpIf(empty, next_)
        EUDJumpIf(dying, next_)
        if match:
            matched = Forward()
            EUDJumpIf(match, matched)
            EUDJump(next_)
            matched << NextTrigger()
        if kind in GROUP_BITS:
            group = fresh(f_bread(UNITS_GROUP + f_maskread_epd(epd + OFF_TYPE, 0xFFFF)))
            EUDJumpIf((group & GROUP_BITS[kind]) == 0, next_)
        body(UnitRef(ptr, epd, None), next_, exit_)
        next_ << NextTrigger()
        DoActions([SetMemory(c + 4, Add, UNIT_SIZE // 4) for c, _ in moving] + [ptr.AddNumber(UNIT_SIZE), epd.AddNumber(UNIT_SIZE // 4)])
        EUDJump(head)
        exit_ << NextTrigger()

    def pick(self, e):
        """One unit among the matching: the first, the nearest to a location's centre, or one at random."""
        by, flt = e["by"], e.get("filter", {})
        found_ptr, found_epd = fresh(0), fresh(0)

        def take(ref):
            found_ptr << ref.ptr
            found_epd << ref.epd

        if by == "first":
            def body(ref, next_, exit_):
                take(ref)
                EUDJump(exit_)
            self.scan(flt, e, body)
        elif by == "nearest":
            if e.get("mouse") is not None:
                # A player's mouse, and nothing farther from it than `within`.
                cx = as_var(INPUT.read({"source": "mouse", "axis": "x", "player": e["mouse"]}, self, e))
                cy = as_var(INPUT.read({"source": "mouse", "axis": "y", "player": e["mouse"]}, self, e))
                least = fresh(int(e.get("within", 48)) + 1)
            else:
                left, top, right, bottom = self.location_bounds(e["near"])
                cx, cy = f_div(left + right, 2)[0], f_div(top + bottom, 2)[0]
                least = fresh(U32)

            def body(ref, next_, exit_):
                cu = self.cunit(ref)
                # |dx| + |dy| is enough to say which is nearest, and never overflows.
                d = distance(cu.posX, cx) + distance(cu.posY, cy)
                if EUDIf()(d < least):
                    least << d
                    take(ref)
                EUDEndIf()
            self.scan(flt, e, body)
        elif by == "random":
            # Count the matching, draw one, take the drawn one on a second pass.
            count = fresh(0)
            self.scan(flt, e, lambda ref, next_, exit_: count.__iadd__(1))
            none = Forward()
            EUDJumpIf(count == 0, none)
            drawn = f_div(f_dwrand(), count)[1]
            i = fresh(0)

            def body(ref, next_, exit_):
                hit = Forward()
                EUDJumpIf(i == drawn, hit)
                i.__iadd__(1)
                EUDJump(next_)
                hit << NextTrigger()
                take(ref)
                EUDJump(exit_)
            self.scan(flt, e, body)
            none << NextTrigger()
        else:
            raise Fail("trigscript: unknown pick %r%s" % (by, where(e)))
        uid = fresh(0)
        if EUDIf()(found_ptr >= 1):
            uid << f_maskread_epd(found_epd + OFF_UID, 0xFF00)
        EUDEndIf()
        return UnitRef(found_ptr, found_epd, uid)

    def unit_loop(self, st, ctx):
        def body(ref, next_, exit_):
            self.vars[st["decl"]["id"]] = LoopUnit(ref)
            self.straight(st["body"], dict(ctx, **{"break": exit_, "continue": next_}))
        self.scan(st.get("filter", {}), st, body)

    def unit_write(self, st):
        ref = self.unit(st["unit"])
        field = st["field"]
        if field == "invincible":
            on = self.truth(st["value"])

            def flag():
                cu = self.cunit(ref)
                if isinstance(on, int):
                    cu.set_invincible() if on else cu.clear_invincible()
                    return
                if EUDIf()(as_var(on) >= 1):
                    cu.set_invincible()
                if EUDElse()():
                    cu.clear_invincible()
                EUDEndIf()
            self.when_alive(ref, flag)
            return
        value = self.num(st["value"])

        def write():
            cu = self.cunit(ref)
            if field == "hp":
                # Hit points at 0 are a dead unit, so that is what the write makes of it.
                if isinstance(value, int):
                    if value == 0:
                        cu.die()
                    else:
                        cu.hp = min(value, 0xFFFFFF) * 256
                    return
                if EUDIf()(value == 0):
                    cu.die()
                if EUDElse()():
                    cu.hp = f_mul(saturate(value, 24), 256)
                EUDEndIf()
            elif field == "shields":
                cu.shield = points(value, 24)
            elif field == "energy":
                cu.energy = points(value, 8)
            elif field == "kills":
                cu.killCount = saturate(value, 8)
            elif field == "resources":
                cu.resourceAmount = saturate(value, 16)
            elif field == "cooldown":
                frames = saturate(value, 8)
                cu.groundWeaponCooldown = frames
                cu.airWeaponCooldown = frames
                cu.spellCooldown = frames
            elif field in UNIT_TIMERS:
                setattr(cu, UNIT_TIMERS[field], saturate(value, 8))
            else:
                raise Fail("trigscript: a unit's %s takes no write%s" % (field, where(st)))
        self.when_alive(ref, write)

    def unit_do(self, st):
        ref = self.unit(st["unit"])
        verb = st["verb"]
        do = verb["do"]
        amount = self.num(verb["amount"]) if do in ("damage", "heal") else 0

        def act():
            cu = self.cunit(ref)
            if do == "kill":
                cu.die()
            elif do == "remove":
                cu.remove()
            elif do == "give":
                to = int(verb["to"])
                cu.cgive(self.current() if to == CURRENT_PLAYER else to)
            elif do == "order":
                self.order(cu, verb, st)
            elif do == "locate":
                self.locate(cu, int(verb["location"]))
            elif do in ("damage", "heal"):
                self.adjust(cu, do, amount, bool(verb.get("percent")))
            else:
                raise Fail("trigscript: unknown unit verb %r%s" % (do, where(st)))
        self.when_alive(ref, act)

    def order(self, cu, verb, node):
        """The game's own Order, reaching this unit alone: a location is made a small box around the unit
        for the length of the action (the game did nothing with a box of no size), then put back."""
        kind = {"move": Move, "patrol": Patrol, "attack": Attack}.get(verb["order"])
        if kind is None:
            raise Fail("trigscript: unknown order %r%s" % (verb["order"], where(node)))
        base = EPD(MRGN + (SCRATCH_LOCATION - 1) * 20)
        kept = [f_dwread_epd(base + i) for i in range(5)]
        x, y = cu.posX, cu.posY
        for i, v in enumerate((x - 2, y - 2, x + 2, y + 2, 0)):
            f_dwwrite_epd(base + i, v)
        DoActions(Order(cu.unitType, cu.owner, SCRATCH_LOCATION, kind, int(verb["target"])))
        for i, v in enumerate(kept):
            f_dwwrite_epd(base + i, v)

    def locate(self, cu, number):
        """A location centred on the unit, its size kept."""
        base = EPD(MRGN + (number - 1) * 20)
        left, top, right, bottom = [f_dwread_epd(base + i) for i in range(4)]
        width, height = right - left, bottom - top
        x, y = cu.posX - f_div(width, 2)[0], cu.posY - f_div(height, 2)[0]
        for i, v in enumerate((x, y, x + width, y + height)):
            f_dwwrite_epd(base + i, v)

    def center_location(self, st):
        """A location centred on a point, its size kept."""
        x, y = self.num(st["x"]), self.num(st["y"])
        base = EPD(MRGN + (int(st["location"]) - 1) * 20)
        left, top, right, bottom = [f_dwread_epd(base + i) for i in range(4)]
        width, height = right - left, bottom - top
        nx, ny = x - f_div(width, 2)[0], y - f_div(height, 2)[0]
        for i, v in enumerate((nx, ny, nx + width, ny + height)):
            f_dwwrite_epd(base + i, v)

    def adjust(self, cu, do, amount, percent):
        """Hit points down — at 0 the unit dies — or up to the type's maximum, in the game's own units (256 to a point)."""
        now = fresh(cu.hp)
        top = f_dwread_epd(EPD(UNITS_MAX_HP) + cu.unitType)
        if percent:
            step = f_div(f_mul(top, as_var(amount)), 100)[0]
        else:
            step = amount * 256 if isinstance(amount, int) else f_mul(saturate(amount, 24), 256)
        if do == "damage":
            if EUDIf()(now <= step):
                cu.die()
            if EUDElse()():
                cu.hp = now - step
            EUDEndIf()
            return
        new = fresh(now + step)
        if EUDIf()(new >= top):
            new << top
        EUDEndIf()
        cu.hp = new

    # ── the game's tables ──
    def cell_address(self, c):
        index = c["index"]
        if c.get("player") and index == CURRENT_PLAYER:
            index = self.current()
        base = int(c["base"]) + int(c.get("key") or 0)
        return base + index * int(c["stride"])

    def table_read(self, c, node):
        if c.get("special"):
            raise Fail("trigscript: %s cannot be read%s" % (c.get("name"), where(node)))
        addr = self.cell_address(c)
        width = c["width"]
        if width == "bit":
            v = fresh(0)
            if EUDIf()(MemoryX(addr, AtLeast, 1, 1 << int(c["bit"]))):
                v << 1
            EUDEndIf()
            return v
        v = f_dwread(addr) if width == 4 else f_wread(addr) if width == 2 else f_bread(addr)
        scale = int(c.get("scale") or 1)
        return f_div(v, scale)[0] if scale > 1 else v

    def table_write(self, st):
        c = st["cell"]
        addr = self.cell_address(c)
        special = c.get("special")
        if special == "name":
            f_wwrite(addr, EncodeString(st["value"]["text"]))
            return
        width = c["width"]
        if st.get("boolean"):
            value = self.truth(st["value"])
        else:
            value = self.num(st["value"])
            scale = int(c.get("scale") or 1)
            if scale > 1 and not st.get("scaled"):
                value = value * scale if isinstance(value, int) else f_mul(value, scale)
        top = 1 if width == "bit" else (1 << (8 * width)) - 1
        if isinstance(value, int):
            value = min(value, top)
        elif width != 4 and width != "bit":
            value = saturate(value, 8 * width)
        if special == "speed":
            self.write_speed(int(c["index"]), value)
        elif special == "color":
            f_bwrite(addr, value)
            f_bwrite(addr + MINIMAP_COLOR_OFFSET, value)
        elif width == "bit":
            mask = 1 << int(c["bit"])
            if isinstance(value, int):
                DoActions(SetMemoryX(addr, SetTo, mask if value else 0, mask))
            else:
                if EUDIf()(value >= 1):
                    DoActions(SetMemoryX(addr, SetTo, mask, mask))
                if EUDElse()():
                    DoActions(SetMemoryX(addr, SetTo, 0, mask))
                EUDEndIf()
        elif width == 4:
            f_dwwrite(addr, value)
        elif width == 2:
            f_wwrite(addr, value)
        else:
            f_bwrite(addr, value)

    def write_speed(self, unit, speed):
        """A unit type's top speed is its flingy's: the flingy is switched to table control and given the
        speed, with acceleration about a seventeenth of it and the braking distance v² / 2a to match
        (the Vulture's own figures), as Magenta writes it. Units made afterwards move at the new speed."""
        flingy = f_bread(UNITS_FLINGY + unit)
        if isinstance(speed, int):
            acceleration = max(1, round(speed / 17))
            halt = max(1, round(speed * speed / (2 * acceleration)))
        else:
            acceleration = fresh(f_div(speed, 17)[0])
            if EUDIf()(acceleration == 0):
                acceleration << 1
            EUDEndIf()
            halt = fresh(f_div(f_mul(speed, speed), acceleration * 2)[0])
            if EUDIf()(halt == 0):
                halt << 1
            EUDEndIf()
            acceleration = saturate(acceleration, 16)
        f_bwrite(FLINGY_CONTROL + flingy, 0)
        f_dwwrite(FLINGY_SPEED + flingy * 4, speed)
        f_wwrite(FLINGY_ACCELERATION + flingy * 2, acceleration)
        f_dwwrite(FLINGY_HALT + flingy * 4, halt)

    # ── statements ──
    def block(self, statements, ctx):
        for st in statements:
            self.statement(st, ctx)

    def statement(self, st, ctx):
        k = st["kind"]
        if k == "declare":
            s = self.declare(st["decl"])
            if not st.get("failed"):
                s.set(self.value(st["init"], st["decl"]["kind"]))
        elif k == "assignUnit":
            self.var(st["target"], st).set(self.unit(st["value"]))
        elif k == "unitLoop":
            self.unit_loop(st, ctx)
        elif k == "unitWrite":
            self.unit_write(st)
        elif k == "unitDo":
            self.unit_do(st)
        elif k == "tableWrite":
            self.table_write(st)
        elif k == "assign":
            self.var(st["target"], st).set(self.num(st["value"]))
        elif k == "assignBool":
            self.var(st["target"], st).set(self.truth(st["value"]))
        elif k == "declareArray":
            a = self.array(st["array"], st)
            cell = self.num if a.decl["kind"] == "number" else self.truth
            if isinstance(a, ListStorage):
                if st.get("fill") is not None:
                    v = cell(st["fill"])
                    a.declare_filled(v if isinstance(v, int) else fresh(v), int(a.decl["length"]))
                else:
                    values = [cell(v) for v in st.get("init", [])]
                    a.declare([v if isinstance(v, int) else fresh(v) for v in values])
            elif st.get("fill") is not None:
                a.fill(cell(st["fill"]))
            else:
                # Every value first, then the stores: [b, a] of two cells of the array itself is a swap.
                values = [cell(v) for v in st.get("init", [])]
                values = [v if isinstance(v, int) else fresh(v) for v in values]
                for i, v in enumerate(values):
                    a.set(i, v)
        elif k == "push":
            a = self.array(st["array"], st)
            a.push((self.num if a.decl["kind"] == "number" else self.truth)(st["value"]))
        elif k == "pop":
            self.array(st["array"], st).pop()
        elif k == "setLength":
            self.array(st["array"], st).set_length(self.num(st["value"]))
        elif k == "store":
            a = self.array(st["array"], st)
            value = (self.num if a.decl["kind"] == "number" else self.truth)(st["value"])
            a.set(self.num(st["index"]), value)
        elif k == "if":
            self.if_(st, ctx)
        elif k == "while":
            self.while_(st, ctx)
        elif k == "do":
            self.do_(st, ctx)
        elif k == "for":
            self.for_(st, ctx)
        elif k == "unrolled":
            self.unrolled(st, ctx)
        elif k == "switch":
            self.switch(st, ctx)
        elif k == "break":
            if "break" not in ctx:
                raise Fail("trigscript: break outside a loop%s" % where(st))
            EUDJump(ctx["break"])
            raise Leave()
        elif k == "continue":
            if "continue" not in ctx:
                raise Fail("trigscript: continue outside a loop%s" % where(st))
            EUDJump(ctx["continue"])
            raise Leave()
        elif k == "return":
            fn = ctx.get("fn")
            if fn is None:
                raise Fail("trigscript: return outside a function%s" % where(st))
            if st.get("value") is not None and fn["result"] is not None:
                fn["result"].set(self.value(st["value"], fn["kind"]))
            EUDJump(fn["end"])
            raise Leave()
        elif k == "sleep":
            self.sleep(st)
        elif k == "action":
            self.action(st)
        elif k == "print":
            self.print_(st)
        elif k == "centerLocation":
            self.center_location(st)
        elif k == "call":
            self.call(st["call"])
        elif k == "block":
            self.block(st["body"], ctx)
        elif k == "remark":
            pass
        else:
            raise Fail("trigscript: unknown statement %r%s" % (k, where(st)))

    def straight(self, statements, ctx):
        """A statement list whose end may not be reached (a break inside): Leave stops it. True when the end was reached."""
        try:
            self.block(statements, ctx)
            return True
        except Leave:
            return False

    def if_(self, st, ctx):
        else_l, end = Forward(), Forward()
        EUDJumpIfNot(self.cond(st["cond"]), else_l)
        if self.straight(st["then"], ctx):
            EUDJump(end)
        else_l << NextTrigger()
        if st.get("else"):
            self.straight(st["else"], ctx)
        end << NextTrigger()

    def while_(self, st, ctx):
        head, exit_ = Forward(), Forward()
        head << NextTrigger()
        if st.get("cond") is not None:
            EUDJumpIfNot(self.cond(st["cond"]), exit_)
        if self.straight(st["body"], dict(ctx, **{"break": exit_, "continue": head})):
            EUDJump(head)
        exit_ << NextTrigger()

    def do_(self, st, ctx):
        body, check, exit_ = Forward(), Forward(), Forward()
        body << NextTrigger()
        self.straight(st["body"], dict(ctx, **{"break": exit_, "continue": check}))
        check << NextTrigger()
        EUDJumpIf(self.cond(st["cond"]), body)
        exit_ << NextTrigger()

    def for_(self, st, ctx):
        head, update, exit_ = Forward(), Forward(), Forward()
        head << NextTrigger()
        if st.get("cond") is not None:
            EUDJumpIfNot(self.cond(st["cond"]), exit_)
        self.straight(st["body"], dict(ctx, **{"break": exit_, "continue": update}))
        update << NextTrigger()
        if self.straight(st["update"], ctx):
            EUDJump(head)
        exit_ << NextTrigger()

    def unrolled(self, st, ctx):
        exit_ = Forward()
        for statements in st["iterations"]:
            nxt = Forward()
            self.straight(statements, dict(ctx, **{"break": exit_, "continue": nxt}))
            nxt << NextTrigger()
        exit_ << NextTrigger()

    def switch(self, st, ctx):
        v = as_var(self.num(st["value"]))
        exit_ = Forward()
        labels = [Forward() for _ in st["cases"]]
        default = None
        for c, label in zip(st["cases"], labels):
            if c["value"] is None:
                default = label
                continue
            n = c["value"]
            if n != n or n < -SIGN or n > U32:  # NaN, or a value the variable never holds
                continue
            EUDJumpIf(v == int(n) & U32, label)
        EUDJump(default if default is not None else exit_)
        for c, label in zip(st["cases"], labels):
            label << NextTrigger()
            self.straight(c["body"], dict(ctx, **{"break": exit_}))
        exit_ << NextTrigger()

    def sleep(self, st):
        if st.get("cycles") is not None:
            frames = int(st["cycles"])
        else:
            frames = max(1, int(round(float(st.get("ms", 0)) * FRAMES_PER_SECOND / 1000)))
        index = len(self.resumes) + 1
        resume = Forward()
        self.resumes.append((index, resume))
        self.set_state(index)
        # The frame after this one is one frame later: sleep(frames(1)) goes on in the next frame, as the
        # simulator has it. (Until 3.4 the wait was one frame longer, so a loop sleeping a frame ran every other.)
        self.set_wait(frames - 1)
        EUDJump(self.frame_end)
        resume << NextTrigger()

    def action(self, st):
        r = st["record"]
        fields = dict(locid1=r["location"], strid=string_of(r["text"]), wavid=string_of(r["wav"]), time=r["time"], player1=r["player"], player2=r["target"], unitid=r["unitId"], acttype=r["type"], amount=r["modifier"], flags=r["flags"])
        count = None
        for variable in st.get("variables") or []:
            value = as_var(self.num(variable["expr"]))
            field = variable["field"]
            if field == "modifier":
                # A unit count: the byte field is not a variable's place, so the action is done once per
                # unit — as many as the variable says, 0 being none (in the record, 0 means "all").
                count = value
                continue
            name = {"target": "player2", "time": "time", "player": "player1", "location": "locid1", "text": "strid", "wav": "wavid", "unitId": "unitid"}.get(field)
            if name is None:
                raise Fail("trigscript: no variable can stand in the %s field%s" % (field, where(st)))
            if name == "unitid":
                # A unit type the game has: past the table, an action reads what is not a unit.
                value = fresh(value)
                if EUDIf()(value >= 228):
                    value << 228
                EUDEndIf()
            fields[name] = value
        if count is None:
            DoActions(Action(**fields))
            return
        fields["amount"] = 1
        for _ in EUDLoopRange(0, count):
            DoActions(Action(**fields))

    def print_(self, st):
        """Text with values in it: every value first, then the text, shown only on the screen of the player it is for."""
        args = []
        for part in st["parts"]:
            k = part["kind"]
            if k == "text":
                args.append(part["text"])
            elif k == "number":
                v = self.num(part["expr"])
                if isinstance(v, int):
                    args.append(str(v if part.get("unsigned") else signed(v)))
                elif part.get("unsigned"):
                    args.append(v)
                else:
                    # A number below zero: its minus sign, then how far below it is.
                    sign, size = fresh(NO_SIGN), fresh(v)
                    if EUDIf()(size >= SIGN):
                        sign << MINUS_SIGN
                        size << 0 - size
                    EUDEndIf()
                    args.append(ptr2s(sign))
                    args.append(size)
            elif k == "name":
                args.append(PName(self.one_player(part["player"], st)))
            elif k == "color":
                args.append(PColor(self.one_player(part["player"], st)))
            else:
                raise Fail("trigscript: unknown text part %r%s" % (k, where(st)))
        if not args:
            return
        # eudplib prints for the current player, and only on that player's own computer.
        show = (lambda: f_eprintln(*args)) if st.get("position") == "center" else (lambda: GetGlobalStringBuffer().print(*args))
        to = int(st.get("to", CURRENT_PLAYER))
        if to == CURRENT_PLAYER:
            show()
            return
        for p in group_slots(to, st):
            f_setcurpl(p)
            show()
        f_setcurpl(self.current())

    def value(self, e, kind):
        """An expression as what a variable of `kind` holds."""
        return self.num(e) if kind == "number" else self.unit(e) if kind == "unit" else self.truth(e)

    def call(self, call):
        result = self.declare(call["result"]["decl"]) if call.get("result") else None
        if result is not None:
            result.set(NO_UNIT if call["result"]["kind"] == "unit" else 0)
        for p in call["params"]:
            s = self.declare(p["decl"])
            s.set(self.value(p["init"], p["decl"]["kind"]))
        end = Forward()
        self.straight(call["body"], {"fn": {"result": result, "kind": call["result"]["kind"] if call.get("result") else "void", "end": end}})
        end << NextTrigger()
        return result.get() if result is not None else 0

    # ── one frame ──
    def frame(self):
        self.frame_end = Forward()
        start = Forward()
        skip = Forward()
        # Still waiting: count down and leave.
        EUDJumpIfNot(as_var(self.get_wait()) >= 1, skip)
        self.set_wait(as_var(self.get_wait()) - 1)
        EUDJump(self.frame_end)
        skip << NextTrigger()
        # The body once, resumes recorded as sleeps are met; the jump table is filled in after.
        table = Forward()
        EUDJump(table)
        start << NextTrigger()
        try:
            self.block(self.p["body"], {})
        except Leave:
            pass
        # The body ended: the program stops for good, as the classic backend's does.
        self.set_state(DONE)
        EUDJump(self.frame_end)
        table << NextTrigger()
        EUDJumpIf(as_var(self.get_state()) == DONE, self.frame_end)
        for index, resume in self.resumes:
            EUDJumpIf(as_var(self.get_state()) == index, resume)
        EUDJump(start)
        self.frame_end << NextTrigger()

    def run(self):
        if self.per_player:
            for p in loop_players(self.slots):
                self.player = p
                f_setcurpl(p)
                self.frame()
            self.player = None
        else:
            # As a trigger owned by that player would: not at all once the player has left.
            if EUDIf()(f_playerexist(self.slots[0])):
                f_setcurpl(self.slots[0])
                self.frame()
            EUDEndIf()


def string_of(value):
    """An action's text or sound: the string itself (eudplib adds it to the map), or an index the script named."""
    if isinstance(value, str):
        return EncodeString(value) if value else 0
    return int(value or 0)


def group_slots(group, node):
    """The player slots a player number stands for: a slot is itself, All Players and a force their human and computer players."""
    playing = lambda p: GetPlayerInfo(p).typestr in ("Human", "Computer")
    if 0 <= group < 8:
        return [group]
    if group == 17:
        return [p for p in range(8) if playing(p)]
    if 18 <= group <= 21:
        return [p for p in range(8) if playing(p) and GetPlayerInfo(p).force == group - 18]
    raise Fail("trigscript: expected players 1 to 8, All Players or a force%s" % where(node))


def owner_slots(program):
    """The player slots a program runs for, from its owners and the map's player settings: a slot is
    itself, All Players and a force are their human and computer players — who a trigger runs for."""
    slots = []
    for o in program.get("owners", [program.get("owner", 0)]):
        for p in group_slots(int(o), program):
            if p not in slots:
                slots.append(p)
    if not slots:
        raise Fail("trigscript: no human or computer player of this map is among the program's owners%s" % where(program))
    return slots


def loop_players(slots):
    """Each of `slots` who is in the game, as an EUDVariable: EUDLoopPlayer, for a list of our own."""
    start, end = min(slots), max(slots)
    v = EUDVariable()
    v << start
    if EUDWhile()(v <= end):
        for i in range(start, end):
            if i not in slots:
                EUDContinueIf(v == i)
        EUDContinueIfNot(f_playerexist(v))
        yield v
        EUDSetContinuePoint()
        v += 1
    EUDEndWhile()


BITWISE = ("&", "|", "^", "<<", ">>", ">>>")
FLIPPED = {"<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!="}


def points(value, bits):
    """Whole points as the game stores them, 256 to a point; `bits` is how many bits of points the cell holds."""
    if isinstance(value, int):
        return min(value, (1 << bits) - 1) * 256
    return f_mul(saturate(value, bits), 256)


def uses_random(node):
    if isinstance(node, dict):
        return node.get("kind") in ("random", "randomInt") or (node.get("kind") == "pick" and node.get("by") == "random") or any(uses_random(v) for v in node.values())
    return isinstance(node, list) and any(uses_random(v) for v in node)


def distance(a, b):
    """|a - b| of two places on the map, both from 0 up."""
    d = fresh(a)
    d -= b
    if EUDIf()(d >= SIGN):
        d << 0 - d
    EUDEndIf()
    return d


def signed(v):
    """The 32 bits as a signed number."""
    v &= U32
    return v - (1 << 32) if v >= SIGN else v


def always(truth):
    """A condition that is known when the map is built."""
    return EUDVariable(1 if truth else 0) >= 1  # initial: a constant, never written


def relation(av, op, b):
    """`av op b` between a variable and a variable or an int, both read from 0 up."""
    if op == "==":
        return av == b
    if op == "!=":
        return av != b
    if op == "<":
        return av < b
    if op == "<=":
        return av <= b
    if op == ">":
        return av > b
    return av >= b


def compare(a, op, b):
    return {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def condition(r):
    return Condition(r["location"], r["player"], r["amount"], r["unitId"], r["comparison"], r["type"], r["resource"], r["flags"], eudx=r.get("mask", 0) or 0)


class Input:
    """What the players do, as it reaches every computer: the cells chatEvent and MSQC write, by the
    names the editor put in their settings (compiler/input.ts, INPUT_NAMES), and the reads of them."""

    MAX_NUMBER = 0xFFFFF

    def __init__(self, plan):
        self.plan = plan or {}
        self.keys = list(self.plan.get("keys", []))
        self.buttons = list(self.plan.get("buttons", []))
        self.chats = list(self.plan.get("chats", []))
        self.mouse_base = self.plan.get("mouseBase")
        # A person can sit in the map's human slots, which is where MSQC counts the mouse locations from.
        self.humans = [p for p in range(8) if GetPlayerInfo(p).typestr == "Human"]
        if plan and not self.humans:
            raise Fail("trigscript: a program reads keys, clicks, the mouse or chat, and the map has no human player to give any")
        self.key_cells = [self.register("tsin_key%d" % i, EUDArray(12)) for i in range(len(self.keys))]
        self.button_cells = [self.register("tsin_button%d" % i, EUDArray(12)) for i in range(len(self.buttons))]
        self.captures = max([len(c["captures"]) for c in self.chats] or [0])
        if self.chats:
            # Local: what chatEvent found on this computer, and what the patterns made of it.
            self.heard = self.register("tsin_heard", EUDVariable())
            self.pointer = self.register("tsin_pointer", EUDVariable())
            self.length = self.register("tsin_length", EUDVariable())
            self.register("tsin_pattern", EUDVariable())
            self.chat_local = self.register("tsin_chat", EUDVariable())
            self.capture_local = [self.register("tsin_capture%d" % i, EUDVariable()) for i in range(self.captures)]
            # Everyone's: what MSQC delivered this frame, by player; 0xFFFFFFFF on a frame with nothing.
            self.chat_in = self.register("tsin_chat_in", EUDArray(12))
            self.capture_in = [self.register("tsin_capture%d_in" % i, EUDArray(12)) for i in range(self.captures)]
            self.unit_table = None

    @staticmethod
    def register(name, cell):
        EUDRegisterObjectToNamespace(name, cell)
        return cell

    # ── reads ──
    def read(self, i, low, node):
        source = i.get("source")
        p = low.one_player(i["player"], node)
        if source == "key":
            return self.cell(self.key_cells, self.keys, i["key"], node)[p]
        if source == "click":
            return self.cell(self.button_cells, self.buttons, i["button"], node)[p]
        if source == "mouse":
            return self.mouse(p, 0 if i["axis"] == "x" else 1, node)
        if source == "chat":
            number = self.chat_number(i["pattern"], node)
            out = fresh(0)
            if EUDIf()(self.chat_in[p] == number):
                out << (1 if i.get("capture") is None else self.capture_in[int(i["capture"])][p])
            EUDEndIf()
            return out
        raise Fail("trigscript: unknown input %r%s" % (source, where(node)))

    @staticmethod
    def cell(cells, names, name, node):
        if name not in names:
            raise Fail("trigscript: the IR's input plan has no %r%s" % (name, where(node)))
        return cells[names.index(name)]

    def chat_number(self, pattern, node):
        for index, c in enumerate(self.chats):
            if c["pattern"] == pattern:
                return index + 1
        raise Fail("trigscript: the IR's input plan has no pattern %r%s" % (pattern, where(node)))

    def mouse(self, p, axis, node):
        """MSQC keeps the mouse of the map's first human slot in location `mouseBase`, the next slot's in the next."""
        if self.mouse_base is None:
            raise Fail("trigscript: the IR's input plan keeps no mouse%s" % where(node))
        first = min(self.humans)
        cell = lambda h: EPD(MRGN + (int(self.mouse_base) - 1 + h - first) * 20) + axis
        if isinstance(p, int):
            return f_dwread_epd(cell(p)) if p in self.humans else 0
        out = fresh(0)
        for h in self.humans:
            if EUDIf()(p == h):
                out << f_dwread_epd(cell(h))
            EUDEndIf()
        return out

    # ── the typed line, on the computer it was typed on ──
    @staticmethod
    def hash_of(data):
        """What `hashed` makes of the same bytes: capitals A to Z as small letters, h = h × 31 + byte."""
        h = 0
        for b in data:
            if 65 <= b <= 90:
                b += 32
            h = (h * 31 + b) & U32
        return h

    def hashed(self, pos, stop_at_space):
        """The hash of the line from `pos` to its end or, with `stop_at_space`, to the next space; `pos` moves past it."""
        h = fresh(0)
        if EUDWhile()(pos < self.length):
            ch = fresh(f_bread(self.pointer + pos))
            if stop_at_space:
                EUDBreakIf(ch == 32)
            if EUDIf()([ch >= 65, ch <= 90]):
                ch += 32
            EUDEndIf()
            h << f_mul(h, 31) + ch
            pos += 1
        EUDEndWhile()
        return h

    def units(self):
        """Unit names by hash, in hash order, for a search by halves: two arrays side by side."""
        if self.unit_table is None:
            by_hash = {}
            for name, unit in self.plan.get("unitNames", []):
                by_hash.setdefault(self.hash_of(name.encode("utf-8")), int(unit))
            ordered = sorted(by_hash.items())
            self.unit_table = (EUDArray([h for h, _ in ordered] or [0]), EUDArray([u for _, u in ordered] or [0]), len(ordered))
        return self.unit_table

    def capture(self, c, pos, fail):
        """One value out of the line at `pos`, or a jump to `fail`."""
        value = fresh(0)
        if c["kind"] == "number":
            digits = fresh(0)
            if EUDWhile()(pos < self.length):
                ch = f_bread(self.pointer + pos)
                EUDBreakIf(ch <= 47)
                EUDBreakIf(ch >= 58)
                value << f_mul(value, 10) + ch - 48
                if EUDIf()(value >= self.MAX_NUMBER + 1):
                    value << self.MAX_NUMBER
                EUDEndIf()
                pos += 1
                digits += 1
            EUDEndWhile()
            EUDJumpIf(digits == 0, fail)
        elif c["kind"] == "word":
            h = self.hashed(pos, True)
            found = fresh(0)
            for index, word in enumerate(c["words"]):
                if EUDIf()(h == self.hash_of(word.encode("utf-8"))):
                    value << index
                    found << 1
                EUDEndIf()
            EUDJumpIf(found == 0, fail)
        elif c["kind"] == "unit":
            h = self.hashed(pos, False)
            hashes, units, count = self.units()
            lo, hi = fresh(0), fresh(count)
            if EUDWhile()(lo < hi):
                mid = f_div(lo + hi, 2)[0]
                if EUDIf()(hashes[mid] < h):
                    lo << mid + 1
                if EUDElse()():
                    hi << mid
                EUDEndIf()
            EUDEndWhile()
            EUDJumpIf(lo >= count, fail)
            EUDJumpIfNot(hashes[lo] == h, fail)
            value << units[lo]
        else:
            raise Fail("trigscript: unknown chat capture %r" % (c["kind"],))
        return value

    def match_line(self):
        """The line the local player typed against every pattern, in order: the first that fits the whole
        line gives its number and values to the cells MSQC sends from. Nothing fits: nothing is sent."""
        DoActions([self.chat_local.SetNumber(0)] + [c.SetNumber(0) for c in self.capture_local])
        if EUDIf()(self.heard >= 1):
            done = Forward()
            for index, chat in enumerate(self.chats):
                fail = Forward()
                pos = fresh(0)
                values = []
                for seg in chat["segments"]:
                    if isinstance(seg, str):
                        data = seg.encode("utf-8")
                        EUDJumpIf(pos + len(data) >= self.length + 1, fail)
                        EUDJumpIfNot(f_memcmp(self.pointer + pos, Db(data + b"\0"), len(data)) == 0, fail)
                        pos += len(data)
                    else:
                        values.append(self.capture(chat["captures"][int(seg)], pos, fail))
                EUDJumpIfNot(pos == self.length, fail)
                DoActions(self.chat_local.SetNumber(index + 1))
                for cell, value in zip(self.capture_local, values):
                    cell << value
                EUDJump(done)
                fail << NextTrigger()
            done << NextTrigger()
        EUDEndIf()


INPUT = Input(IR.get("input"))
PROGRAMS = [Lowering(p) for p in IR.get("programs", [])]


def onPluginStart():
    # eudplib's generator starts from the same seed in every game; the game's own randomness (a switch randomized) seeds it.
    if uses_random(IR.get("programs", [])):
        f_randomize()


def beforeTriggerExec():
    # After chatEvent has looked for a typed line, before MSQC sends what it was.
    if INPUT.chats:
        INPUT.match_line()


def afterTriggerExec():
    for prog in PROGRAMS:
        prog.run()
