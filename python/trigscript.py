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

A text is kept one of two ways, a variable at a time (the IR says which). One that only ever holds texts written in
the script is the text's id in the built map's string table: a number. One that is made while the map is played is
three cells - where its bytes are (UTF-8, ended by a 0), the block of the heap it owns (0: none, the bytes are a
string of the table) and its length in characters. A made text is written into one scratch buffer, measured, and
copied into a block of just that size, whose first cell says which size; what holds the text owns the block, so
assigning copies it, a value that was just made is moved, and whatever a variable held goes back to the heap once
its new value is worked out. compiler/simulateIr.ts takes and gives blocks in the same order, so both run out at
the same text. A made text in an action's field goes over a string the build keeps for that kind of field, on the
computer of the player the action is for and nowhere else: the game reads such a string again whenever it draws.
"""
import base64
import json

from eudplib import *
from eudplib.core.mapdata.stringmap import ForceAddString
from eudplib.memio.rwcommon import br1, br2, bw1

IR_VERSION = 26
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
# The selection a computer keeps: twelve unit addresses; and a Select command, 0x09, the count, a tag a unit (B5).
SELECTION = 0x6284B8
SELECT_COMMAND = Db(b"\x09" + bytes(27))
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
# The heads of the game's lists of units (1.16.1, which Remastered emulates): the visible units and the dying ones. Each
# links a record in just behind its head, so behind the head a list runs latest first (scm-sim docs/specs/unit-lists.md).
VISIBLE_HEAD, DYING_HEAD = 0x628430, 0x62842C
# How many unit records are in use (a dword): up when a record is taken, down when one is freed.
RECORDS_IN_USE = 0x6283F0
# How many units one frame's events pass hands on of each kind; past that the rest are handed on in the next frame.
EVENT_CAP = 512
# A unit's hit points (+0x08), and the last player whose attack hurt it (+0x90, a byte; 8 when none has): a unit that died
# with no hit points and a player there died in a fight, and that player killed it (on.killed).
OFF_HP, OFF_LAST_ATTACKER = 0x08 // 4, 0x90 // 4
# The location table, and the one an order borrows for the length of one action (put back after).
MRGN = 0x58DC60
SCRATCH_LOCATION = 255
UNIT_TIMERS = {"stim": "stimTimer", "ensnare": "ensnareTimer", "plague": "plagueTimer", "lockdown": "lockdownTimer", "maelstrom": "maelstromTimer", "irradiate": "irradiateTimer", "stasis": "stasisTimer"}
STATUS_INVINCIBLE, STATUS_HALLUCINATION, STATUS_BURROWED, STATUS_CLOAKED = 0x04000000, 0x40000000, 0x00000010, 0x00000300
COND_COMMAND, COND_BRING, COND_ACCUMULATE, COND_KILL, COND_OPPONENTS, COND_DEATHS = 2, 3, 4, 5, 14, 15
CURRENT_PLAYER = 13
# What a stack that ran out throws (B4), as JavaScript's does: a RangeError (compiler/ir.ts ERROR_CODES).
RANGE_ERROR = 2
STACK_OVERFLOW_MESSAGE = "Maximum call stack size exceeded"
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


# ── Static routing (TrigScript 4, the backend's first part) ──
# eudplib keeps a variable as a trigger of one action, SetDeaths(dest, modifier, value), and reads it by routing:
# three actions set that action's destination and modifier and the trigger's next pointer, then the walk goes through
# it. In a played frame of the bullets bench that routing was half the time (scripts/trigger-shapes.mts). Here every
# copy of a variable this file made (SeqCompute, and everything eudplib does through it: <<, +=, a call's arguments)
# is lowered as a *site* — whatever came before jumps to a Forward, then a setup trigger with the routing, then the
# cells, then what follows — and what eudplib itself does to a cell (its vtable, its destination, its mask, its
# modifier asked for anywhere else) is counted. Once the whole program is lowered (`decide`, at the end of
# afterTriggerExec), a cell read at exactly one site and touched nowhere else needs no routing at all: its destination,
# modifier and next pointer are written into the variable buffer as the map is built (they never change), and the site
# jumps straight into its cells. Any other site keeps its setup. Only variables this file made directly take part:
# eudplib's own (a function's parameters and results, its pooled temporaries) are shared by many places it cannot see.
# The `staticRouting` setting "0" leaves everything to eudplib, to weigh what this gives.
import sys as _sys
import eudplib.core.variable.eudv as _eudv
import eudplib.core.variable.vbuf as _vbuf
from eudplib.utils import unProxy as _unproxy_r


class _Region:
    """Where code is being lowered: a loop of the IR (`loop`), or code that runs apart from what is around it — a
    coroutine (a program's body, a task, a branch of a parallel), a function's body, a scope of triggers apart."""

    def __init__(self, kind):
        self.kind = kind
        self.waits = False  # a loop that sleeps or waits: anything else may run before it goes on
        self.unknown = False  # a loop that calls something whose body this cannot see (a function that calls itself)
        self.calls = set()  # the functions (EUDFuncN ids) called from here
        self.entry = self.after = None  # a loop's way in, which the hoisted routing goes in front of
        self.hoist = []
        self.copies = []  # (variable, its copy for one site of the loop), filled on the way in


class _Routing:
    def __init__(self, enabled):
        self.enabled = enabled
        self.on = False
        self.emitting = 0
        self.reading = 0  # inside a condition's own making: a value read, not written
        self.ours = {}  # id -> the variable, for the variables this file made while lowering
        self.touches = {}  # id -> where something other than a site asked for one of its routing fields
        self.writes = {}  # id -> where its value's address was asked for other than to read it in a condition
        self.sites = {}  # id -> the groups it is read in
        self.groups = []
        self.static = {}  # a cell's VariableTriggerForward -> (dest, modifier byte, next)
        self.stack = []  # (barrier or loop regions) innermost last
        self.main = _Region("main")
        self.functions = {}  # id of an EUDFuncN -> the region of its body
        self.loops = []
        self.names = {}  # id -> the name of the script's variable it is, for the report
        self.why_touched = {}  # id -> where it was touched, for the report
        self.made_at = {}  # id -> where it was made, for the report
        self.stats = {"groups": 0, "bare groups": 0, "cells": 0, "static": 0, "hoisted": 0, "replicas": 0, "loops": 0}

    def where(self):
        """(the region the code runs in apart from the rest, the loops around it in that region, outermost first)."""
        loops = []
        for r in reversed(self.stack):
            if r.kind != "loop":
                return r, tuple(reversed(loops))
            loops.append(r)
        return self.main, tuple(reversed(loops))

    def touched(self, v):
        if self.on and not self.emitting:
            k = id(v)
            if k in self.ours:
                self.touches.setdefault(k, []).append(self.where())
                if settings.get("routingReport") and k in self.names:
                    f, chain = _sys._getframe(2), []
                    while f is not None and len(chain) < 6:
                        chain.append("%s:%d" % (f.f_code.co_name, f.f_lineno))
                        f = f.f_back
                    self.why_touched.setdefault(k, set()).add(" < ".join(chain))

    def wrote(self, v):
        if self.on and not self.emitting and not self.reading:
            k = id(v)
            if k in self.ours:
                self.writes.setdefault(k, []).append(self.where())

    def called(self, fn):
        if self.on:
            apart, loops = self.where()
            apart.calls.add(id(fn))
            for r in loops:
                r.calls.add(id(fn))

    def waited(self):
        if self.on:
            for r in self.where()[1]:
                r.waits = True

    def unknown_call(self):
        if self.on:
            for r in self.where()[1]:
                r.unknown = True

    def reached(self, calls):
        """The regions of the functions these calls reach, those they call in turn included."""
        out, todo = [], list(calls)
        seen = set()
        while todo:
            f = todo.pop()
            if f in seen:
                continue
            seen.add(f)
            r = self.functions.get(f)
            if r is not None:
                out.append(r)
                todo.extend(r.calls)
        return out

    def plan_for(self, v, r):
        """What loop r can do for v's reads in it: "hoist" (one site in it: its routing set once in front of it),
        "replicas" (several sites, and nothing in it writes v: a copy of v a site, each copy routed for good and filled
        in front of it), or why not. Nothing that runs between the loop's way in and its way out may route v (or, for
        copies, write it) but those sites: not the loop's own code, not a function it calls, and — when it waits —
        nothing outside it in another coroutine, since anything may run while it waits."""
        k = id(v)
        groups, touches, writes = self.sites[k], self.touches.get(k, []), self.writes.get(k, [])
        if r.unknown:
            return "calls a function that calls itself"
        inside = [h for h in groups if r in h["ctx"][1]]
        if any(r in t[1] for t in touches):
            return "touched in the loop"
        fns = self.reached(r.calls)
        if any(h["ctx"][0] in fns for h in groups) or any(t[0] in fns for t in touches):
            return "a function the loop calls routes it"
        if r.waits:
            apart = inside[0]["ctx"][0]
            if any(h["ctx"][0] is not apart for h in groups) or any(t[0] is not apart for t in touches):
                return "waits, and other code routes it"
        if len(inside) == 1:
            return "hoist"
        if any(r in w[1] for w in writes) or any(w[0] in fns for w in writes):
            return "read at %d sites and written in the loop" % len(inside)
        if r.waits and any(w[0] is not inside[0]["ctx"][0] for w in writes):
            return "waits, and other code writes it"
        return "replicas"

    def choice(self, v, g):
        """For v in group g: ("static", None), (\"hoist\" or "replicas", the outermost loop that can), or (None, why not)."""
        k = id(v)
        if len(self.sites[k]) == 1 and not self.touches.get(k):
            return "static", None
        whys = []
        for r in g["ctx"][1]:
            how = self.plan_for(v, r)
            if how in ("hoist", "replicas"):
                return how, r
            whys.append(how)
        return None, "; ".join(whys) if whys else "read at %d sites, outside any loop" % len(self.sites[k])

    def decide(self):
        """Each group whose cells all need no routing at its site goes in bare: a cell read there and nowhere else is
        routed in the variable buffer for good; one that is the only read inside a loop has its routing set once in
        front of the loop; one read at several sites of a loop that never writes it is read from a copy of its own,
        routed for good, which the loop's way in fills. Every other group keeps its setup."""
        if not self.on:
            return
        self.on = False
        report = settings.get("routingReport")
        for g in self.groups:
            self.stats["groups"] += 1
            self.stats["cells"] += len(g["cells"])
            plan = []
            for v, dest, mod, nxt, slot in g["cells"]:
                how, where = self.choice(v, g)
                if how is None:
                    if report and g["ctx"][1]:
                        print("trigscript: routing kept in a loop: %s: %s" % (self.names.get(id(v)) or "a temporary made at " + self.made_at.get(id(v), "?"), where))
                        for w in sorted(self.why_touched.get(id(v), ()))[:3]:
                            print("trigscript:   touched at " + w)
                    plan = None
                    break
                plan.append((how, where))
            if plan is None:
                g["entry"] << g["setup"]
                for v, _, _, _, slot in g["cells"]:
                    slot << v.GetVTable()
                continue
            self.stats["bare groups"] += 1
            g["entry"] << g["bare"]
            for (v, dest, mod, nxt, slot), (how, r) in zip(g["cells"], plan):
                self.stats[{"static": "static", "hoist": "hoisted", "replicas": "replicas"}[how]] += 1
                if how == "static":
                    slot << v.GetVTable()
                    self.static[v.GetVTable()] = (dest, mod, nxt)
                elif how == "hoist":
                    slot << v.GetVTable()
                    r.hoist.append((v, dest, mod, nxt))
                else:
                    copy = EUDVariable()
                    slot << copy.GetVTable()
                    self.static[copy.GetVTable()] = (dest, mod, nxt)
                    r.copies.append((v, copy))
        # Each loop's way in: straight on, or through triggers that set the routing hoisted in front of it and fill its
        # copies (made here, out of the way of the code being made: what is pending is put aside and handed on after).
        held = Forward()
        SetNextTrigger(held)
        for r in self.loops:
            if not r.hoist and not r.copies:
                r.entry << r.after
                continue
            self.stats["loops"] += 1
            steps = []  # (actions, the cell the trigger goes on to, or None for the next step)
            acts = []
            for v, dest, mod, nxt in r.hoist:
                acts += [SetDeaths(EPD(v.getDestAddr()), SetTo, dest, 0), SetDeathsX(EPD(v.getDestAddr()) + 2, SetTo, mod << 24, 0, 0xFF000000), SetNextPtr(v.GetVTable(), nxt)]
            for i in range(0, len(acts), 63):
                steps.append((acts[i:i + 63], None))
            # A copy is filled by the variable's own cell, routed into the copy and back each time (it may be routed
            # otherwise outside the loop, so nothing of it is assumed).
            for v, copy in r.copies:
                steps.append(([SetDeaths(EPD(v.getDestAddr()), SetTo, EPD(copy.getValueAddr()), 0), SetDeathsX(EPD(v.getDestAddr()) + 2, SetTo, 7 << 24, 0, 0xFF000000)], v))
            firsts = [Forward() for _ in steps]
            for i, (acts_i, cell) in enumerate(steps):
                after = firsts[i + 1] if i + 1 < len(steps) else r.after
                if cell is None:
                    firsts[i] << RawTrigger(nextptr=after, actions=acts_i)
                else:
                    firsts[i] << RawTrigger(nextptr=cell.GetVTable(), actions=acts_i + [SetNextPtr(cell.GetVTable(), after)])
            r.entry << firsts[0]
        held << NextTrigger()
        print("trigscript: static routing — %(bare groups)d of %(groups)d reads without routing: %(static)d cells routed for good, %(hoisted)d routed once in front of a loop, %(replicas)d read from a copy (%(loops)d loops)" % self.stats)


ROUTE = _Routing(settings.get("staticRouting", "1") != "0")

if ROUTE.enabled:
    _var_init = _eudv.EUDVariable.__init__
    _MODULE = globals()

    def _routed_init(self, *args, **kwargs):
        _var_init(self, *args, **kwargs)
        # Made by a line of this file itself (not by eudplib on its behalf): ours to route.
        f = _sys._getframe(1)
        if ROUTE.on and f.f_globals is _MODULE:
            ROUTE.ours[id(self)] = self
            if settings.get("routingReport"):
                ROUTE.made_at[id(self)] = "%s:%d < %s:%d" % (f.f_code.co_name, f.f_lineno, f.f_back.f_code.co_name, f.f_back.f_lineno)

    _eudv.EUDVariable.__init__ = _routed_init

    def _watched(name):
        method = getattr(_eudv.EUDVariable, name)

        def wrapper(self, *args, **kwargs):
            ROUTE.touched(self)
            return method(self, *args, **kwargs)

        wrapper.__name__ = name
        setattr(_eudv.EUDVariable, name, wrapper)

    for _name in ("GetVTable", "getDestAddr", "getMaskAddr", "SetModifier", "SetDest", "AddDest", "SubtractDest", "SetDestX", "AddDestX", "SubtractDestX"):
        _watched(_name)

    # Its value's address asked for is a write unless a condition asks it (a condition only reads the value).
    _value_addr = _eudv.EUDVariable.getValueAddr

    def _routed_value_addr(self):
        ROUTE.wrote(self)
        return _value_addr(self)

    _eudv.EUDVariable.getValueAddr = _routed_value_addr
    import eudplib.core.variable.vbase as _vbase

    def _reading(name):
        method = getattr(_vbase.VariableBase, name)

        def wrapper(self, *args, **kwargs):
            ROUTE.reading += 1
            try:
                return method(self, *args, **kwargs)
            finally:
                ROUTE.reading -= 1

        wrapper.__name__ = name
        setattr(_vbase.VariableBase, name, wrapper)

    for _name in ("AtLeast", "AtMost", "Exactly", "AtLeastX", "AtMostX", "ExactlyX"):
        _reading(_name)

    _seqcompute = _eudv.SeqCompute
    _MODS = {id(SetTo): 7, id(Add): 8, id(Subtract): 9}

    def _emit_group(cells, consts, memo):
        """A site: what came before jumps to `entry`; the setup does the constant stores before it (as eudplib's own
        SeqCompute does, in the same trigger) and routes the cells in a chain, the last back to `after`. The bare way in
        (no routing: `decide` chose) does the constants alone and goes through `slot`s — each the cell itself, or a
        copy of it a loop keeps — whose routing is set elsewhere."""
        ROUTE.emitting += 1
        try:
            entry, after = Forward(), Forward()
            SetNextTrigger(entry)
            first = cells[0][0].GetVTable()
            slots = [Forward() for _ in cells]
            # (An action belongs to one trigger: the constants are made twice, for the setup and for the bare way in.)
            const_acts = lambda: [SetDeaths(_eudv._get_computedest(EncodePlayer(_unproxy_r(dst))), mdt, src, 0) for dst, mdt, src in consts]
            bare = RawTrigger(nextptr=slots[0], actions=const_acts()) if consts else slots[0]
            acts, plan = const_acts(), []
            for i, (v, dest, mod) in enumerate(cells):
                nxt = cells[i + 1][0].GetVTable() if i + 1 < len(cells) else after
                # A cell this same SeqCompute routed already keeps what was set then (eudplib's own does the same): it is
                # read at two sites, so neither goes without its setup.
                was = memo.get(id(v))
                if not was or was[0] is not dest:
                    acts.append(v.SetDest(dest))
                if not was or was[1] is not mod:
                    acts.append(v.SetModifier(mod))
                acts.append(SetNextPtr(v.GetVTable(), nxt))
                memo[id(v)] = (dest, mod)
                plan.append((v, dest, _MODS[id(mod)], slots[i + 1] if i + 1 < len(cells) else after, slots[i]))
            setup = RawTrigger(nextptr=first, actions=acts)
            after << NextTrigger()
        finally:
            ROUTE.emitting -= 1
        g = {"entry": entry, "setup": setup, "bare": bare, "cells": plan, "ctx": ROUTE.where()}
        ROUTE.groups.append(g)
        for v, _, _, _, _ in plan:
            ROUTE.sites.setdefault(id(v), []).append(g)

    def _routed_seqcompute(assignpairs):
        if not ROUTE.on or ROUTE.emitting:
            return _seqcompute(assignpairs)
        plain, group = [], []

        def flush_plain():
            if plain:
                _seqcompute(list(plain))
                plain.clear()

        consts, memo = [], {}

        def flush_group():
            if group:
                _emit_group(list(group), list(consts), memo)
                group.clear()
                consts.clear()

        for dst, mdt, src in assignpairs:
            s = _unproxy_r(src)
            if isinstance(s, EUDVariable) and id(s) in ROUTE.ours and id(mdt) in _MODS:
                if any(v is s for v, _, _ in group) or len(group) * 3 + len(consts) >= 61:
                    flush_group()
                if not group:
                    # The constant stores just before it go with it, as eudplib keeps them in one trigger.
                    k = max([i for i, (_, _, x) in enumerate(plain) if isinstance(_unproxy_r(x), EUDVariable)], default=-1)
                    consts.extend(plain[k + 1:])
                    del plain[k + 1:]
                    flush_plain()
                group.append((s, _eudv._get_computedest(EncodePlayer(_unproxy_r(dst))), mdt))
            else:
                flush_group()
                plain.append((dst, mdt, src))
        flush_group()
        flush_plain()

    # Every eudplib module that took SeqCompute by name (a call's arguments go through eudplib.core.variable's) calls this one.
    for _mod in list(_sys.modules.values()):
        if getattr(_mod, "__name__", "").startswith("eudplib") and getattr(_mod, "SeqCompute", None) is _seqcompute:
            _mod.SeqCompute = _routed_seqcompute
    SeqCompute = _routed_seqcompute

    # Where code runs apart: a function's body (eudplib's and this file's), a scope of triggers this file sets apart.
    from eudplib.core.eudfunc.eudfuncn import EUDFuncN as _EUDFuncN_r
    _fn_call = _EUDFuncN_r.__call__
    _fn_body = _EUDFuncN_r._create_func_body

    def _routed_call(self, *args, **kwargs):
        ROUTE.called(self)
        return _fn_call(self, *args, **kwargs)

    def _routed_body(self):
        r = ROUTE.functions.setdefault(id(self), _Region("fn"))
        ROUTE.stack.append(r)
        try:
            return _fn_body(self)
        finally:
            ROUTE.stack.pop()

    _EUDFuncN_r.__call__ = _routed_call
    _EUDFuncN_r._create_func_body = _routed_body
    _push_scope, _pop_scope = PushTriggerScope, PopTriggerScope

    def PushTriggerScope():  # noqa: N802 (this file's own scopes apart: a function that calls itself)
        ROUTE.stack.append(_Region("scope"))
        return _push_scope()

    def PopTriggerScope():  # noqa: N802
        ROUTE.stack.pop()
        return _pop_scope()

    # The variable buffer writes the cells a decided group reads with their routing in place.
    _create_vartrigger = _vbuf.EUDVarBuffer.create_vartrigger

    def _indexed_vartrigger(self, v, initval):
        idx = getattr(self, "_ts_index", None)
        if idx is None:
            idx = self._ts_index = {}
        idx[v] = len(self._initvals)
        return _create_vartrigger(self, v, initval)

    _vbuf.EUDVarBuffer.create_vartrigger = _indexed_vartrigger

    def _static_of(buf):
        return [(i, ROUTE.static[v]) for v, i in getattr(buf, "_ts_index", {}).items() if v in ROUTE.static]

    _collect_vars = _vbuf.EUDVarBuffer.CollectDependency

    def _collect_routed(self, emitbuffer):
        _collect_vars(self, emitbuffer)
        for _, (dest, _, nxt) in _static_of(self):
            for x in (dest, nxt):
                if type(x) is not int:
                    emitbuffer.WriteDword(x)

    _vbuf.EUDVarBuffer.CollectDependency = _collect_routed

    _write_vars = _vbuf.EUDVarBuffer.WritePayload

    def _write_routed(self, emitbuffer):
        static = _static_of(self)
        if not static:
            return _write_vars(self, emitbuffer)
        # The buffer as eudplib lays it out (vbuf.py): 324 bytes before the first cell, then 72 a variable — variable i's
        # trigger starts 4 bytes before the buffer plus 72·i, so its next pointer is at 72·i, its action's destination at
        # 340 + 72·i, its value at 344 + 72·i and its modifier byte at 351 + 72·i — then the last triggers' tails.
        n = len(self._initvals)
        blob = bytearray(324)
        block = bytearray(72)
        block[0:4] = b"\xFF\xFF\xFF\xFF"
        block[24:36] = b"\0\0\x2D\x07\0\0SC\x04\0\0\0"
        blob += block * n
        sym = {}

        def put(off, x):
            if isinstance(x, int):
                blob[off:off + 4] = (x & 0xFFFFFFFF).to_bytes(4, "little")
            else:
                sym[off] = x

        for i, iv in enumerate(self._initvals):
            if isinstance(iv, int):
                if iv:
                    put(344 + 72 * i, iv)
            else:
                put(344 + 72 * i, iv)
        for i, (dest, mod, nxt) in static:
            put(340 + 72 * i, dest)
            blob[351 + 72 * i] = mod
            put(72 * i, nxt)
        pos = 0
        for off in sorted(sym):
            emitbuffer.WriteBytes(bytes(blob[pos:off]))
            emitbuffer.WriteDword(sym[off])
            pos = off + 4
        emitbuffer.WriteBytes(bytes(blob[pos:]))
        emitbuffer.WriteSpace(32)
        emitbuffer.WriteDword(4)  # flags
        emitbuffer.WriteSpace(27)
        emitbuffer.WriteByte(0)  # currentAction
        for _i in range(27):
            emitbuffer.WriteSpace(40)
            emitbuffer.WriteDword(4)
            emitbuffer.WriteSpace(27)
            emitbuffer.WriteByte(0)

    _vbuf.EUDVarBuffer.WritePayload = _write_routed
    ROUTE.on = True


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


# Cells read at an index the game works out (an array, a row of a per-player program or of a task) are an EUDVArray
# where they fit: a cell is a variable of its own, 72 bytes, which a read jumps to and which writes itself out — a
# read at a variable index is a jump by the index's bits (4 triggers for 16 cells) where an EUDArray reads the dword
# a bit at a time (45 triggers), and one at a constant index two triggers where an EUDArray takes as many. Past
# VARRAY_MOST cells an array stays an EUDArray, 4 bytes a cell (a long table, a video's brushes).
VARRAY_MOST = 2048
VARRAY_STRIDE, VARRAY_VALUE = 72, 348  # a cell's size, and where its value is in it
_VARRAYS = {}  # id → the EUDVArray, for the map of variables (which says a cell's place by stride)


def cell_array(values):
    """`values` as cells: an EUDVArray up to VARRAY_MOST of them, else an EUDArray."""
    values = list(values)
    if len(values) > VARRAY_MOST:
        return EUDArray(values)
    v = EUDVArray(len(values))(values)
    _VARRAYS[id(v)] = v
    return v


def is_varray(store):
    return id(store) in _VARRAYS


FILL_WIDTH = 8  # cells a trigger of varray_fill writes


def varray_fill(store, length, value):
    """The first `length` cells of an EUDVArray set to `value`: eight a trigger, the Set Deaths' destinations moving on by
    eight cells each time, where a cell at a time worked its address out a bit a trigger (about 250 ns a cell, 23 now)."""
    acts = [Forward() for _ in range(FILL_WIDTH)]
    start = [SetMemory(a + 16, SetTo, store._epd + VARRAY_VALUE // 4 + VARRAY_STRIDE // 4 * k) for k, a in enumerate(acts)]
    patched = isinstance(unProxy(value), EUDVariable)
    if patched:
        RawTrigger(actions=start)
        for a in acts:
            VProc(value, list(value.QueueAssignTo(EPD(a) + 5)))
    else:
        RawTrigger(actions=start)
    turns = EUDVariable()
    turns << length // FILL_WIDTH
    if EUDWhileNot()(turns == 0):
        RawTrigger(actions=[a << SetMemoryEPD(0, SetTo, 0 if patched else value) for a in acts]
                   + [SetMemory(a + 16, Add, VARRAY_STRIDE // 4 * FILL_WIDTH) for a in acts] + [turns.SubtractNumber(1)])
    EUDEndWhile()
    for i in range(length - length % FILL_WIDTH, length):
        cell_write(store, i, value, SetTo)


def cell_write(store, index, value, modifier):
    """`store[index]` set to (`SetTo`) or added to (`Add`) `value`, the store an EUDArray or one of cell_array's
    EUDVArrays. Into an EUDVArray at a variable index: a Set Deaths whose destination, the cell's value at
    EPD + 87 + 18 i, is worked out by one trigger an index bit, as eudplib's own get does (eudplib 0.81's EUDVArray
    has no add, and its set is a third dearer)."""
    if not is_varray(store):
        if modifier == Add:
            store.iadditem(index, value)
        else:
            store[index] = value
        return
    if isinstance(index, int):
        if modifier == SetTo:
            # The variable's value written into the cell (through SeqCompute: a site of static routing).
            SeqCompute([(store._epd + VARRAY_VALUE // 4 + VARRAY_STRIDE // 4 * index, SetTo, value)])
        else:
            Trigger(actions=SetMemoryEPD(store._epd + VARRAY_VALUE // 4 + VARRAY_STRIDE // 4 * index, modifier, value))
        return
    act = Forward()
    # (Through SeqCompute, so that a variable's copy into the action is a site of static routing.)
    pairs = [(EPD(act) + 4, SetTo, store._epd + VARRAY_VALUE // 4)]
    if isinstance(unProxy(value), EUDVariable):
        pairs.append((EPD(act) + 5, SetTo, value))
        value = 0
    SeqCompute(pairs)
    for b in reversed(range(max((store._size - 1).bit_length(), 1))):
        RawTrigger(conditions=index.AtLeastX(1, 1 << b), actions=SetMemory(act + 16, Add, VARRAY_STRIDE // 4 << b))
    RawTrigger(actions=[act << SetMemoryEPD(0, modifier, value)])


# ── an index worked out once ──
# A cell of an EUDVArray at a variable index is 72 bytes a step from the first: eudplib works the place out a bit of
# the index at a time, a trigger a bit, at every read and every write. A variable whose every store is a constant or
# itself plus or minus a constant (a loop's counter, `for…of`'s own index) can have the place's offset kept beside it
# by the same stores — `i++` is two adds — and a read at it is a jump to the first cell plus the offset, a write a Set
# Deaths whose destination is the first cell's plus the offset: a few triggers whatever the array's length.

def counter_step(value, id_):
    """What a store of `value` into the variable `id_` does to it: ("set", c) or ("add", c), c a constant (wrapped),
    or None when it is anything else."""
    if not isinstance(value, dict):
        return None
    k = value.get("kind")
    if k == "const":
        return ("set", int(value["value"]) & U32)
    if k == "binary" and value.get("op") in ("+", "-") and not value.get("fixed"):
        left, right = value["left"], value["right"]
        me = lambda e: e.get("kind") == "var" and e.get("id") == id_
        if me(left) and right.get("kind") == "const":
            c = int(right["value"])
            return ("add", (c if value["op"] == "+" else -c) & U32)
        if value["op"] == "+" and me(right) and left.get("kind") == "const":
            return ("add", int(left["value"]) & U32)
    return None


def find_counters(program):
    """The ids of the variables of numbers whose every store is a constant or the variable plus or minus a constant,
    and which nothing else names but a read: no call's result, no function's saved frame, no loop's own variable."""
    ok, bad = set(), set()
    skip = ("kind", "at", "label")

    def walk(node):
        if isinstance(node, list):
            for x in node:
                walk(x)
        elif isinstance(node, str):
            bad.add(node)  # (an id anywhere but a read, a store or its declaration: something else writes it)
        elif isinstance(node, dict):
            k = node.get("kind")
            if k == "var" and isinstance(node.get("id"), str):
                return
            if k == "assign" and isinstance(node.get("target"), str):
                t = node["target"]
                (ok if counter_step(node.get("value"), t) else bad).add(t)
                for key, v in node.items():
                    if key not in skip and key != "target":
                        walk(v)
                return
            if k == "declare" and isinstance(node.get("decl"), dict):
                d = node["decl"]
                step = counter_step(node.get("init"), d.get("id"))
                plain_number = d.get("kind") == "number" and not d.get("bits") and not d.get("fixed") and d.get("task") is None
                (ok if plain_number and step and step[0] == "set" else bad).add(d.get("id"))
                for key, v in node.items():
                    if key not in skip and key != "decl":
                        walk(v)
                return
            for key, v in node.items():
                if key not in skip:
                    walk(v)

    walk([program.get("body", []), program.get("functions", [])])
    return ok - bad


def saved_arrays(program):
    """The arrays a function that calls itself saves and takes back (their handles written behind the lowering's back)."""
    out = set()

    def walk(node):
        if isinstance(node, list):
            for x in node:
                walk(x)
        elif isinstance(node, dict):
            if isinstance(node.get("saves"), dict):
                out.update(node["saves"].get("arrays", []))
            for v in node.values():
                if isinstance(v, (list, dict)):
                    walk(v)

    walk([program.get("body", []), program.get("functions", [])])
    return out


# Kinds of statement or value a loop's body may not hold for its reads at the loop's index to go unchecked: what
# changes an array's length, what calls a function (which may), and what waits (another program may run then).
UNCHECKED_REFUSE = {"push", "pop", "setLength", "declareArray", "call", "sleep", "parallel", "start", "cancel", "select",
                    "syncSend", "yield", "await", "taskHandle", "running"}


def lengths_fixed_in(body, index_id, lists):
    """Whether, in a loop's body, no array changes its length and the index is not stored to: nothing in it from
    UNCHECKED_REFUSE, no store into a growing array (`lists`, by id) but at the index itself (a store at the length
    is a push), no store into the index."""
    def ok(node):
        if isinstance(node, list):
            return all(ok(x) for x in node)
        if not isinstance(node, dict):
            return True
        k = node.get("kind")
        if k in UNCHECKED_REFUSE:
            return False
        if k == "assign" and node.get("target") == index_id:
            return False
        if k == "store" and node.get("array") in lists:
            idx = node.get("index", {})
            if not (idx.get("kind") == "var" and idx.get("id") == index_id):
                return False
        return all(ok(v) for v in node.values() if isinstance(v, (list, dict)))
    return ok(body)


def lists_at(body, index_id, lists):
    """The growing arrays (`lists`, by id) a loop's body reads or writes at the index."""
    out = []

    def walk(node):
        if isinstance(node, list):
            for x in node:
                walk(x)
        elif isinstance(node, dict):
            idx = node.get("index")
            if node.get("kind") in ("element", "store") and node.get("array") in lists and isinstance(idx, dict) \
                    and idx.get("kind") == "var" and idx.get("id") == index_id and node["array"] not in out:
                out.append(node["array"])
            for v in node.values():
                if isinstance(v, (list, dict)):
                    walk(v)

    walk(body)
    return out


class Cursors:
    """Reads and writes at a loop's counter through registers of their own (the backend's second part): a read is a
    trigger whose next pointer is the cell's address — so it jumps straight to the cell, which writes itself out
    through eudplib's getter — and a write an action whose destination is the cell's value. Each register is set once on
    the way into the loop (the array's first cell plus the counter's place) and moved on by the counter's step at the
    loop's update, one add each, where `varray_read` / `varray_write` work the place out at every access (two variables
    routed into a jump, or into an action, each time). Only for a loop whose body stores nothing into the counter, waits
    for nothing, calls nothing and changes no array's length (`lengths_fixed_in`): the arrays' blocks stay where they
    are, and nothing but the update moves the counter."""

    def __init__(self, counter, place, step):
        self.counter, self.place, self.step = counter, place, step
        self.reads = []  # (the trigger whose next pointer is the register, the first cell: a constant or a variable)
        self.writes = []  # (the action whose destination is the register, the first cell's value's EPD)

    def read(self, base, out):
        from eudplib.core.eudstruct.vararray import _getter, _getter_dst
        after = Forward()
        t = RawTrigger(nextptr=0, actions=[SetNextPtr(_getter, after), SetMemoryEPD(_getter_dst, SetTo, EPD(out.getValueAddr()))])
        after << NextTrigger()
        self.reads.append((t, base))

    def write(self, base_epd, value, modifier):
        act = Forward()
        if isinstance(unProxy(value), EUDVariable):
            SeqCompute([(EPD(act) + 5, SetTo, value)])
            value = 0
        RawTrigger(actions=[act << SetMemoryEPD(0, modifier, value)])
        self.writes.append((act, base_epd))

    def init(self):
        """The registers set from where each array's block starts and the counter's place (on the way in)."""
        pairs = []
        for t, base in self.reads:
            pairs += [(EPD(t) + 1, SetTo, base), (EPD(t) + 1, Add, self.place.bytes)]
        for act, base_epd in self.writes:
            pairs += [(EPD(act) + 4, SetTo, base_epd), (EPD(act) + 4, Add, self.place.dwords)]
        SeqCompute(pairs)

    def advance(self):
        """The registers moved on by the counter's step (at the loop's update)."""
        acts = [SetMemory(t + 4, Add, (VARRAY_STRIDE * self.step) & U32) for t, _ in self.reads]
        acts += [SetMemory(act + 16, Add, (VARRAY_STRIDE // 4 * self.step) & U32) for act, _ in self.writes]
        if acts:
            DoActions(acts)


class Place:
    """A counter's offset into EUDVArrays, kept by its stores: in bytes (72 a step, for a read's jump) and in dwords
    (18 a step, for a write's destination)."""

    def __init__(self):
        self.bytes = EUDVariable(0)  # initial: the counter's own 0
        self.dwords = EUDVariable(0)  # initial: the counter's own 0

    def step(self, step):
        op, c = step
        if op == "set":
            DoActions([self.bytes.SetNumber((VARRAY_STRIDE * c) & U32), self.dwords.SetNumber((VARRAY_STRIDE // 4 * c) & U32)])
        else:
            DoActions([self.bytes.AddNumber((VARRAY_STRIDE * c) & U32), self.dwords.AddNumber((VARRAY_STRIDE // 4 * c) & U32)])


def varray_read(base, place, out):
    """The cell at `base` + the place's bytes into `out`: `base` the first cell (a constant, or a variable holding it).
    The offset's variable adds itself into its own next-trigger pointer and jumps there, to the cell, which writes
    itself out through eudplib's getter, as EUDVArray.get does once it has the place."""
    from eudplib.core.eudstruct.vararray import _getter, _getter_dst
    off = place.bytes
    after = Forward()
    tail = [SetNextPtr(_getter, after), SetMemoryEPD(_getter_dst, SetTo, EPD(out.getValueAddr()))]
    if isinstance(base, EUDVariable):
        RawTrigger(nextptr=base.GetVTable(), actions=[SetNextPtr(base.GetVTable(), off.GetVTable()), *base.QueueAssignTo(EPD(off.GetVTable()) + 1),
                                                      *off.QueueAddTo(EPD(off.GetVTable()) + 1), *tail])
    else:
        RawTrigger(nextptr=off.GetVTable(), actions=[SetNextPtr(off.GetVTable(), base), *off.QueueAddTo(EPD(off.GetVTable()) + 1), *tail])
    after << NextTrigger()


def varray_read_at(addr, out):
    """The cell whose address the variable `addr` holds into `out`."""
    from eudplib.core.eudstruct.vararray import _getter, _getter_dst
    after = Forward()
    RawTrigger(nextptr=addr.GetVTable(), actions=[SetNextPtr(addr.GetVTable(), 0), *addr.QueueAddTo(EPD(addr.GetVTable()) + 1),
                                                  SetNextPtr(_getter, after), SetMemoryEPD(_getter_dst, SetTo, EPD(out.getValueAddr()))])
    after << NextTrigger()


def varray_write_at(value_epd, value, extra=()):
    """The cell whose value's EPD the variable `value_epd` holds set to `value`; `extra` actions in the same trigger."""
    act = Forward()
    vs, acts = [value_epd], list(value_epd.QueueAssignTo(EPD(act) + 4))
    if isinstance(unProxy(value), EUDVariable):
        vs.append(value)
        acts += value.QueueAssignTo(EPD(act) + 5)
        value = 0
    VProc(vs, acts)
    RawTrigger(actions=[act << SetMemoryEPD(0, SetTo, value), *extra])


def varray_write(value_epd, place, value, modifier):
    """The cell whose value is at EPD `value_epd` + the place's dwords set to (or added to) `value`: `value_epd` a
    constant, or a variable holding it."""
    act = Forward()
    # (Through SeqCompute, so that each variable's copy into the action is a site of static routing.)
    pairs = [(EPD(act) + 4, SetTo, value_epd), (EPD(act) + 4, Add, place.dwords)]
    if isinstance(unProxy(value), EUDVariable):
        pairs.append((EPD(act) + 5, SetTo, value))
        value = 0
    SeqCompute(pairs)
    RawTrigger(actions=[act << SetMemoryEPD(0, modifier, value)])


class Rows:
    """Which of a cell's copies is the one in use: a per-player program has one a player, a task's body one a slot of its
    start (`Pool`), and a task's in a per-player program one a slot within each player's. Called, it is the index."""

    def __init__(self, lowering, per_player, pool):
        self.lowering, self.per_player, self.pool = lowering, per_player, pool
        self.count = (12 if per_player else 1) * (pool.max if pool else 1)

    def __call__(self):
        if self.pool:
            return self.pool.row
        return self.lowering.player_of()


class RowCell:
    """A cell of the lowering's own (a coroutine's place, a latch), with a copy for each row of `rows` when it has them."""

    def __init__(self, rows, initial=0):
        self.rows = rows
        self.store = cell_array([initial] * rows.count) if rows else EUDVariable(initial)  # initial: the lowering's own state

    def get(self):
        return self.store[self.rows()] if self.rows else self.store

    def set(self, value):
        if self.rows:
            cell_write(self.store, self.rows(), value, SetTo)
        else:
            self.store << value


class Storage:
    """A variable's cell: plain, or one of rows (`Rows`) - a 12-slot row of a per-player program, a row a task's slot."""

    def __init__(self, decl, rows):
        self.decl = decl
        self.bits = decl.get("bits")
        self.rowed = rows is not None
        self.player_of = rows
        self.store = cell_array([0] * rows.count) if self.rowed else EUDVariable(0)  # initial: the variable's own cell
        if not self.rowed:
            ROUTE.names[id(self.store)] = decl.get("name", "?")

    def get(self):
        return self.store[self.player_of()] if self.rowed else self.store

    def set(self, value):
        if self.bits:
            value = saturate(value, self.bits)
        if self.rowed:
            cell_write(self.store, self.player_of(), value, SetTo)
        else:
            self.store << value

    def add(self, value, op):
        """The cell plus (`op` "+") or minus ("-") `value` where it is, wrapping as numbers do: eudplib's own add, with
        no copy through a temporary (`x = x + 1` was 9 records and 4 triggers through one, and is 1 action). False
        where it cannot: a saturated cell, or a row's cell less a variable (the game's Subtract stops at 0)."""
        if self.bits:
            return False
        if self.rowed:
            if op == "-" and not isinstance(value, int):
                return False
            cell_write(self.store, self.player_of(), value if op == "+" else (-value) & U32, Add)
            return True
        if op == "+":
            self.store += value
        else:
            self.store -= value
        return True

    def mask(self, op, c):
        """The cell & c or | c where it is: one masked write (only a variable's own cell, not a row's)."""
        DoActions(_mask_action(self.store, op, c))


def _mask_action(cell, op, c):
    """The masked write that leaves `cell & c` (clear the bits outside c) or `cell | c` (set the bits of c) in a variable."""
    return cell.SetNumberX(0, (~c) & U32) if op == "&" else cell.SetNumberX(c, c)


def unpack_table(table, length):
    """A table the IR carries packed (`compiler/eud.ts#packTable`): `bytes` a value, little-endian, in base64 - as a
    dword a value, the cells of the map."""
    width = int(table["bytes"])
    raw = base64.b64decode(table["data"])
    if len(raw) != width * length:
        raise RuntimeError("a packed table is %d bytes, not %d values of %d" % (len(raw), length, width))
    out = bytearray(4 * length)
    for b in range(width):
        out[b::4] = raw[b::width]
    return bytes(out)


class ArrayStorage:
    """An array's cells: `length` of them, twelve rows of that in a per-player program, or - `values` - a list
    the script computed when it was built, which is in the map as it loads and which nothing writes. An index
    past either end (read from 0 up, so one below zero too) reads 0 and stores nothing."""

    def __init__(self, decl, rows):
        self.decl = decl
        self.length = int(decl["length"])
        self.bits = decl.get("bits")
        values = decl.get("values")
        table = decl.get("packed")
        self.rowed = rows is not None and values is None and table is None
        self.player_of = rows
        if decl.get("texts") is not None:
            # A list of texts the script has: a cell is the text's id in the built map's table.
            values = [text_id(t) for t in decl["texts"]]
        # What a list known when the map is built holds, for what is worked out with it then (an atan2 of constants).
        self.values = [int(v) & U32 for v in values] if values is not None else None
        if table is not None:
            # A long table (a video's brushes): its bytes straight into the map, no list of a value at a time.
            # (An EUDArray is its cells' EPD, so that is what it is made from.)
            raw = unpack_table(table, self.length)
            self.values = [int.from_bytes(raw[i:i + 4], "little") for i in range(0, len(raw), 4)]
            self.store = EUDArray(_from=EPD(Db(raw)))
        else:
            self.store = cell_array([int(v) & U32 for v in values] if values is not None else [0] * (self.length * (rows.count if self.rowed else 1)))  # initial: a table's values, or cells declareArray sets

    def at(self, index):
        """The cell's place among the store's: the row first (the player's, the task's)."""
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
            if is_varray(self.store):
                self.store.get(self.at(index), ret=[out])  # (the cell writes itself into out: no copy through another)
            else:
                out << self.store[self.at(index)]
        EUDEndIf()
        return out

    def placeable(self):
        return not self.rowed and is_varray(self.store)

    def get_placed(self, index, place, bound=None):
        out = fresh(0)
        if EUDIf()(index <= self.length - 1):
            varray_read(unProxy(self.store), place, out)
        EUDEndIf()
        return out

    def set_placed(self, index, place, value, modifier=SetTo, bound=None):
        if self.bits and modifier == SetTo:
            value = saturate(value, self.bits)
        if EUDIf()(index <= self.length - 1):
            varray_write(self.store._epd + VARRAY_VALUE // 4, place, value, modifier)
        EUDEndIf()

    def set(self, index, value):
        if self.bits:
            value = saturate(value, self.bits)
        if isinstance(index, int):
            if index < self.length:
                cell_write(self.store, self.at(index), value, SetTo)
            return
        if EUDIf()(index <= self.length - 1):
            cell_write(self.store, self.at(index), value, SetTo)
        EUDEndIf()

    def add(self, index, value, op):
        """The cell plus (`op` "+") or minus ("-") the value, by the game's own Add: nothing read. Past either end,
        nothing, as a store."""
        # A subtract is the add of the value's negative, which wraps as numbers do: the game's Subtract stops at 0
        # (`a[i] -= 5` of a 3 was 0 in the game and -2 in the simulator).
        if op == "-":
            value = (-value) & U32 if isinstance(value, int) else 0 - value
        act = lambda i, v: cell_write(self.store, i, v, Add)
        if isinstance(index, int):
            if index < self.length:
                act(self.at(index), value)
            return
        if EUDIf()(index <= self.length - 1):
            act(self.at(index), value)
        EUDEndIf()

    def fill(self, value):
        if self.length <= 16:
            for i in range(self.length):
                self.set(i, value)
            return
        if is_varray(self.store) and not self.rowed:
            varray_fill(self.store, self.length, value)
            return
        v, i = as_var(value), fresh(0)
        if EUDWhile()(i <= self.length - 1):
            self.set(i, v)
            i += 1
        EUDEndWhile()


class SliceStorage:
    """A window on another array's cells - a row of a grid: cell i is cell `offset + i` of the array it is a window
    on, `offset` a variable of the program. Past its own end it reads 0 and stores nothing, so a row never reaches
    into the next; what it is a window on keeps its own ends (and its own width, and its row a player)."""

    def __init__(self, decl, lowering):
        self.decl = decl
        self.length = int(decl["length"])
        self.lowering = lowering

    def of(self):
        return self.lowering.array(self.decl["slice"]["of"], self.decl)

    def offset(self):
        return self.lowering.var(self.decl["slice"]["offset"], self.decl).get()

    def get(self, index):
        if isinstance(index, int):
            return self.of().get(self.offset() + index) if index < self.length else 0
        out = fresh(0)
        if EUDIf()(index <= self.length - 1):
            out << self.of().get(self.offset() + index)
        EUDEndIf()
        return out

    def set(self, index, value):
        if isinstance(index, int):
            if index < self.length:
                self.of().set(self.offset() + index, value)
            return
        if EUDIf()(index <= self.length - 1):
            self.of().set(self.offset() + index, value)
        EUDEndIf()

    def fill(self, value):
        v, i = as_var(value), fresh(0)
        if EUDWhile()(i <= self.length - 1):
            self.set(i, v)
            i += 1
        EUDEndWhile()


# The heap the programs' growing arrays share. A block is a power of two of cells, four at least; one given back
# waits in its size's list (its first cell links the next) for whoever wants that size next; new ground is taken
# from the bottom up. Cell 0 is never handed out: 0 is "no block". compiler/simulateIr.ts counts the same way, so
# both run out at the same push. (Recursion's stack is an array of its own, below: how deep a function may go is
# then the same whatever the arrays hold.)
HEAP_CELLS = min(1 << 20, max(1024, int(IR.get("heap", 16384))))  # the map's script settings, or the default
HEAP_SMALLEST = 4
CELL_HEAP_MOST = 1 << 16  # compiler/ir.ts#CELL_HEAP_MOST: up to this many, growing arrays have cells of their own
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
        if EUDIf()(end <= HEAP_CELLS):
            at << top
            top << end
            EUDReturn(at)
        EUDEndIf()
        EUDReturn(0)

    @EUDFunc
    def give(at, k):
        cells[at] = free[k]
        free[k] = at

    def growing(copy, write):
        """grow and push for one kind of cell: `copy(block, ptr, length)` moves a block's cells, `write(at, value)`
        stores one."""

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
                    copy(block, ptr, length)
                EUDEndIf()
                give(ptr, k)
            EUDEndIf()
            EUDReturn(block, rooms[nk], nk, 1)

        @EUDFunc
        def push(ptr, length, room, k, value):
            """One more cell at the end; the handle as it is afterwards. Nothing is pushed when the heap is full."""
            ptr, room, k, ok = grow(ptr, length, room, k, length + 1)
            if EUDIf()(ok >= 1):
                write(ptr + length, value)
                length += 1
            if EUDElse()():
                if EUDIf()(said == 0):
                    said << 1
                    GetGlobalStringBuffer().print("\x06TrigScript: out of memory - an array could not grow (the programs' arrays share %d cells)." % HEAP_CELLS)
                EUDEndIf()
            EUDEndIf()
            EUDReturn(ptr, length, room, k)

        return grow, push

    def copy_dwords(block, ptr, length):
        # An EUDArray's own value is where it is, as an EPD already.
        f_repmovsd_epd(cells + block, cells + ptr, length)

    def write_dword(at, value):
        cells[at] = value

    grow, push = growing(copy_dwords, write_dword)
    _HEAP.update(cells=cells, rooms=rooms, take=take, give=give, grow=grow, push=push, growing=growing)
    return _HEAP


def list_heap():
    """The heap with the growing arrays' own cells beside its bytes: blocks are handed out as for texts (the same
    count, so a text and an array still run out at the same push in the game and in the simulator), but an array's
    cells are an EUDVArray of the heap's length, a variable a cell, which a read jumps to instead of reading a dword
    a bit at a time (32 triggers). Made when the first growing array is met; texts never touch these cells."""
    h = heap()
    if "vcells" in h or HEAP_CELLS > CELL_HEAP_MOST:
        return h  # (past CELL_HEAP_MOST, 72 bytes a cell is too much memory: the arrays keep the heap's dwords, as in 3.x)
    vcells = EUDVArray(HEAP_CELLS)()
    _VARRAYS[id(vcells)] = vcells

    def copy_cells(block, ptr, length):
        # Both blocks walked a cell at a time: the source by its address, the destination by its value's EPD.
        src, dst, n, cell = EUDVariable(), EUDVariable(), EUDVariable(), EUDVariable()
        src << unProxy(vcells) + ptr * VARRAY_STRIDE
        dst << vcells._epd + VARRAY_VALUE // 4 + block * (VARRAY_STRIDE // 4)
        n << length
        if EUDWhile()(n >= 1):
            varray_read_at(src, cell)
            varray_write_at(dst, cell, [src.AddNumber(VARRAY_STRIDE), dst.AddNumber(VARRAY_STRIDE // 4), n.SubtractNumber(1)])
        EUDEndWhile()

    def write_cell(at, value):
        cell_write(vcells, at, value, SetTo)

    vgrow, vpush = h["growing"](copy_cells, write_cell)
    h.update(vcells=vcells, vgrow=vgrow, vpush=vpush)
    return h


# The stack of the functions that call themselves. A function's variables are cells of the program, one of each, so
# a call that may come back into the function it is in (the IR's `saves`) puts what that function holds here first
# and takes it back after, with where the function returns to. One stack serves every program and every player:
# such a function never sleeps, so the stack is empty whenever a frame ends. It is as many frames of the largest
# frame as the map's script settings allow calls deep (the IR file's `stack`), and the depth is what is counted -
# compiler/simulateIr.ts counts the same - so a program stops at the same call in both.
STACK_DEPTH = min(1 << 16, max(16, int(IR.get("stack", 1024))))
STACK_CELLS_MAX = 1 << 20
HANDLE = ("ptr", "len", "room", "k")
_STACK = {}


def frame_cells(saves, kinds):
    return 1 + 4 * len(saves.get("arrays", [])) + sum(3 if kinds.get(v) in ("unit", "text") else 1 for v in saves.get("vars", []))


def largest_frame():
    most = [0]

    def walk(node, kinds):
        if isinstance(node, list):
            for x in node:
                walk(x, kinds)
        elif isinstance(node, dict):
            if isinstance(node.get("saves"), dict):
                most[0] = max(most[0], frame_cells(node["saves"], kinds))
            for v in node.values():
                if isinstance(v, (dict, list)):
                    walk(v, kinds)

    def kinds_of(node, into):
        if isinstance(node, list):
            for x in node:
                kinds_of(x, into)
        elif isinstance(node, dict):
            if isinstance(node.get("id"), str) and node.get("kind") in ("number", "boolean", "unit", "text") and "shared" in node:
                # A text kept as its id is one cell, as a number is; one that was made is three.
                into[node["id"]] = "number" if node["kind"] == "text" and node.get("text") == "id" else node["kind"]
            for v in node.values():
                if isinstance(v, (dict, list)):
                    kinds_of(v, into)
        return into

    for program in IR.get("programs", []):
        walk(program.get("functions", []), kinds_of(program, {}))
    return most[0]


def stack():
    """The stack's cells, where the next frame goes (an EPD, so a cell is one write) and how deep it is."""
    if _STACK:
        return _STACK
    frame = largest_frame()
    if frame * STACK_DEPTH > STACK_CELLS_MAX:
        raise Fail("trigscript: the stack would be %d cells - %d calls deep, %d cells a call - and %d is the most: lower the recursion depth in the script's Settings, or keep fewer variables in the function that calls itself" % (frame * STACK_DEPTH, STACK_DEPTH, frame, STACK_CELLS_MAX))
    cells = EUDArray(max(1, frame) * STACK_DEPTH)
    base = cells  # an EUDArray's own value is where it is, as an EPD already
    at = EUDVariable(base)  # initial: the stack's own state; it is back here whenever a frame ends
    depth = EUDVariable(0)  # initial: the stack's own state; nothing is on it between frames
    _STACK.update(cells=cells, base=base, at=at, depth=depth)
    return _STACK


class ListStorage:
    """An array that grows: a handle - where its block is among the heap's cells (0: none yet), how many cells are
    in use, how many the block has room for, and the block's size class - a cell each, or a row of twelve each in
    a per-player program. Reads and stores are bounded by the cells in use; a store at exactly the length is a push."""

    def __init__(self, decl, rows):
        self.decl = decl
        self.bits = decl.get("bits")
        self.rowed = rows is not None
        self.player_of = rows
        make = (lambda: cell_array([0] * rows.count)) if self.rowed else (lambda: EUDVariable(0))  # initial: no block
        self.handle = {name: make() for name in ("ptr", "len", "room", "k")}
        self.heap = list_heap()
        # Where its block starts, kept as the block moves, for reads and writes at a counter (`Place`): the first
        # cell's address, and its value's EPD. Only when the lowering asks (`keep_base`) before anything is lowered.
        self.base = None

    def cells(self):
        """Whether the array's cells are the growing arrays' own (`list_heap`), not the heap's dwords."""
        return "vcells" in self.heap

    def keep_base(self):
        if self.base is None and not self.rowed and self.cells():
            v = self.heap["vcells"]
            first = v._epd + VARRAY_VALUE // 4
            self.base = (EUDVariable(unProxy(v)), EUDVariable(first))  # initial: block 0's
            # Where a push writes, base[1] + 18 × the length: a push with room is a write there and two adds.
            self.next = EUDVariable(first)  # initial: block 0's first cell, the length 0

    def renext(self):
        """`next` worked out again from the length (after a block moved, or the length was set)."""
        if self.base is not None:
            self.next << self.base[1] + self.handle["len"] * (VARRAY_STRIDE // 4)

    def placeable(self):
        return self.base is not None

    def field(self, name):
        cell = self.handle[name]
        return cell[self.player_of()] if self.rowed else cell

    def put(self, name, value):
        if self.rowed:
            self.handle[name][self.player_of()] = value
        else:
            if name == "ptr" and self.base is not None:
                # The block moved (a push that grew it, a declaration): its first cell again, only when it did.
                if EUDIfNot()(self.handle["ptr"] == value):
                    v = self.heap["vcells"]
                    self.base[0] << unProxy(v) + value * VARRAY_STRIDE
                    self.base[1] << v._epd + VARRAY_VALUE // 4 + value * (VARRAY_STRIDE // 4)
                EUDEndIf()
            self.handle[name] << value

    def get_placed(self, index, place, bound=None):
        """`bound`: None, checked against the length; True, known inside (the loop's own array); or a variable,
        1 when a loop found this array at least as long as its own on the way in, which is checked instead."""
        out = fresh(0)
        if bound is True:
            varray_read(self.base[0], place, out)
            return out
        if bound is not None:
            if EUDIf()(bound >= 1):
                varray_read(self.base[0], place, out)
            if EUDElseIf()(as_var(index) < as_var(self.field("len"))):
                varray_read(self.base[0], place, out)
            EUDEndIf()
            return out
        if EUDIf()(as_var(index) < as_var(self.field("len"))):
            varray_read(self.base[0], place, out)
        EUDEndIf()
        return out

    def set_placed(self, index, place, value, modifier=SetTo, bound=None):
        if self.bits and modifier == SetTo:
            value = saturate(value, self.bits)
        v = fresh(value) if modifier == SetTo and not isinstance(value, int) else value
        if bound is True:
            varray_write(self.base[1], place, v, modifier)
            return
        i, n = as_var(index), as_var(self.field("len"))
        if bound is not None:
            if EUDIf()(bound >= 1):
                varray_write(self.base[1], place, v, modifier)
            if EUDElseIf()(i < n):
                varray_write(self.base[1], place, v, modifier)
            if EUDElseIf()(i == n):
                self.push(v)  # xs[xs.length] = v, as JavaScript has it (xs[n] += v pushes v: xs[n] reads 0)
            EUDEndIf()
            return
        if EUDIf()(i < n):
            varray_write(self.base[1], place, v, modifier)
        if EUDElseIf()(i == n):
            self.push(v)  # xs[xs.length] = v, as JavaScript has it (xs[n] += v pushes v: xs[n] reads 0)
        EUDEndIf()

    def length(self):
        return self.field("len")

    def write(self, at, value):
        """Cell `at` of the cells (a place among them, the block's plus the index) set to `value`."""
        if self.cells():
            cell_write(self.heap["vcells"], at, value, SetTo)
        else:
            self.heap["cells"][at] = value

    def get(self, index):
        out = fresh(0)
        if EUDIf()(as_var(index) < as_var(self.field("len"))):
            if self.cells():
                self.heap["vcells"].get(self.field("ptr") + index, ret=[out])
            else:
                out << self.heap["cells"][self.field("ptr") + index]
        EUDEndIf()
        return out

    def push(self, value):
        if self.bits:
            value = saturate(value, self.bits)
        if self.base is None:
            self.push_growing(value)
            return
        if not isinstance(value, int):
            value = fresh(value)
        if EUDIf()(as_var(self.handle["len"]) < as_var(self.handle["room"])):
            varray_write_at(self.next, value, [self.handle["len"].AddNumber(1), self.next.AddNumber(VARRAY_STRIDE // 4)])
        if EUDElse()():
            self.grown()(value)
        EUDEndIf()

    def grown(self):
        """A push with no room left, as one function of the array's own (the heap's grow, the handle put back, where
        the next push writes worked out again): made once, where every push of the array calls it."""
        if getattr(self, "_grown", None) is None:
            @EUDFunc
            def grown(value):
                self.push_growing(value)
                self.renext()
            self._grown = grown
        return self._grown

    def push_growing(self, value):
        ptr, length, room, k = self.heap["vpush" if self.cells() else "push"](self.field("ptr"), self.field("len"), self.field("room"), self.field("k"), value)
        for name, v in (("ptr", ptr), ("len", length), ("room", room), ("k", k)):
            self.put(name, v)

    def set(self, index, value):
        if self.bits:
            value = saturate(value, self.bits)
        i, v, n = as_var(index), fresh(value), as_var(self.field("len"))
        if EUDIf()(i < n):
            self.write(self.field("ptr") + i, v)
        if EUDElseIf()(i == n):
            self.push(v)  # xs[xs.length] = v, as JavaScript has it
        EUDEndIf()

    def pop(self):
        out = fresh(0)
        n = fresh(self.field("len"))
        if EUDIf()(n >= 1):
            n -= 1
            self.put("len", n)
            if self.base is not None:
                self.next -= VARRAY_STRIDE // 4
            if self.cells():
                self.heap["vcells"].get(self.field("ptr") + n, ret=[out])
            else:
                out << self.heap["cells"][self.field("ptr") + n]
        EUDEndIf()
        return out

    def set_length(self, value):
        v = as_var(value)
        if EUDIf()(v < as_var(self.field("len"))):
            self.put("len", v)
            self.renext()
        EUDEndIf()

    def declare(self, values):
        """Declared (again): the block it held goes back, and it starts over with these values."""
        ptr = fresh(self.field("ptr"))
        if EUDIf()(ptr >= 1):
            self.heap["give"](ptr, self.field("k"))
        EUDEndIf()
        for name in ("ptr", "len", "room", "k"):
            self.put(name, 0)
        self.renext()
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
            self.write(self.field("ptr") + i, v)
            i += 1
        EUDEndWhile()


class InnerListStorage(ListStorage):
    """An array that grows inside another: its handle is cell `index` of four arrays the outer one keeps (where the
    block is, how many cells are in use, its room, its size class), `index` a variable of the program. Everything
    else is a growing array's, which only ever asks for its handle's fields and puts them back."""

    def __init__(self, decl, lowering):
        self.decl = decl
        self.bits = decl.get("bits")
        self.rowed = False
        self.lowering = lowering
        self.heap = list_heap()
        self.base = None

    def at(self):
        return self.lowering.var(self.decl["through"]["index"], self.decl).get()

    def field(self, name):
        return self.lowering.array(self.decl["through"][name], self.decl).get(self.at())

    def put(self, name, value):
        self.lowering.array(self.decl["through"][name], self.decl).set(self.at(), value)


# ── texts ──
TEXT_BYTES = 1023  # the most a made text holds; compiler/ir.ts has the same number
TEXT_FIELD_BYTES = 255  # the room of a string kept for an action's field or a unit type's name
BUILD_BYTES = 2047  # the most a buffer of buildText holds; compiler/ir.ts has the same number
UNIT_MAP_STRING = 0x660260  # units.dat: the id of the name a map gives a unit type, a word each
_TEXT = {}
_SLOTS = {}


def texts():
    """The texts' part of the run time, made when the first text that is made is met."""
    if _TEXT:
        return _TEXT
    h = heap()
    cells, rooms, take, give = h["cells"], h["rooms"], h["take"], h["give"]
    # A text being made. It may run one part past its most before it is cut, and a part is at most that long again.
    scratch = Db(TEXT_BYTES + 1 + TEXT_BYTES + 1 + 8)
    empty = Db(4)
    said_cut = EUDVariable(0)  # initial: said once a game
    said_full = EUDVariable(0)  # initial: said once a game
    said_field = EUDVariable(0)  # initial: said once a game

    @EUDFunc
    def count(addr):
        """How many characters the text at addr is: every byte but those that continue a character (10xxxxxx)."""
        n = EUDVariable()
        n << 0
        br1.seekoffset(addr)
        if EUDInfLoop()():
            b = br1.readbyte()
            EUDBreakIf(b == 0)
            if EUDIfNot()(b.ExactlyX(0x80, 0xC0)):
                n += 1
            EUDEndIf()
        EUDEndInfLoop()
        EUDReturn(n)

    @EUDFunc
    def append(pos, src):
        """The text at src written at pos, ended by a 0; where that 0 is. A text of the table may be any length, so no
        more of it than leaves the scratch whole: what is past a text's most is cut by make() anyway."""
        br1.seekoffset(src)
        bw1.seekoffset(pos)
        if EUDWhile()(pos <= scratch + TEXT_BYTES + TEXT_BYTES):
            b = br1.readbyte()
            EUDBreakIf(b == 0)
            bw1.writebyte(b)
            pos += 1
        EUDEndWhile()
        bw1.writebyte(0)
        EUDReturn(pos)

    @EUDFunc
    def make(end):
        """The text in the scratch, which ends at `end`, into a block of its own: where it is, the block, its
        length in characters. Past what a text holds it is cut, never inside a character."""
        if EUDIf()(end >= scratch + TEXT_BYTES + 1):
            end << scratch + TEXT_BYTES
            if EUDWhile()(f_bread(end).ExactlyX(0x80, 0xC0)):
                end -= 1
            EUDEndWhile()
            f_bwrite(end, 0)
            if EUDIf()(said_cut == 0):
                said_cut << 1
                GetGlobalStringBuffer().print("\x06TrigScript: a text was cut off - one that is made holds %d bytes." % TEXT_BYTES)
            EUDEndIf()
        EUDEndIf()
        need = f_div(end - scratch, 4)[0] + 2
        k = EUDVariable()
        k << 0
        if EUDWhile()(rooms[k] < need):
            k += 1
        EUDEndWhile()
        block = take(k)
        if EUDIf()(block == 0):
            if EUDIf()(said_full == 0):
                said_full << 1
                GetGlobalStringBuffer().print("\x06TrigScript: out of memory - a text could not be made (the programs' arrays and texts share %d cells)." % HEAP_CELLS)
            EUDEndIf()
            EUDReturn(empty, 0, 0)
        EUDEndIf()
        cells[block] = k
        f_repmovsd_epd(cells + block + 1, EPD(scratch), need - 1)
        addr = f_mul(cells + block + 1, 4) + 0x58A364
        EUDReturn(addr, block, count(addr))

    @EUDFunc
    def copy(addr, block, length):
        """A text as something to keep: itself when it owns no block, else a block of the same size with the same cells."""
        if EUDIf()(block == 0):
            EUDReturn(addr, 0, length)
        EUDEndIf()
        k = cells[block]
        mine = take(k)
        if EUDIf()(mine == 0):
            if EUDIf()(said_full == 0):
                said_full << 1
                GetGlobalStringBuffer().print("\x06TrigScript: out of memory - a text could not be copied (the programs' arrays and texts share %d cells)." % HEAP_CELLS)
            EUDEndIf()
            EUDReturn(empty, 0, 0)
        EUDEndIf()
        f_repmovsd_epd(cells + mine, cells + block, rooms[k])
        EUDReturn(f_mul(cells + mine + 1, 4) + 0x58A364, mine, length)

    @EUDFunc
    def release(block):
        if EUDIf()(block >= 1):
            give(block, cells[block])
        EUDEndIf()

    @EUDFunc
    def skip(addr, n):
        """Where character n of the text at addr starts; its end when it has fewer."""
        br1.seekoffset(addr)
        if EUDInfLoop()():
            b = br1.readbyte()
            EUDBreakIf(b == 0)
            if EUDIfNot()(b.ExactlyX(0x80, 0xC0)):
                EUDBreakIf(n == 0)
                n -= 1
            EUDEndIf()
            addr += 1
        EUDEndInfLoop()
        EUDReturn(addr)

    @EUDFunc
    def size(addr):
        """The bytes of the character that starts at addr; 0 at the text's end."""
        b = f_bread(addr)
        n = EUDVariable()
        n << 1
        if EUDIf()(b == 0):
            n << 0
        if EUDElseIf()(b >= 0xF0):
            n << 4
        if EUDElseIf()(b >= 0xE0):
            n << 3
        if EUDElseIf()(b >= 0xC0):
            n << 2
        EUDEndIf()
        EUDReturn(n)

    @EUDFunc
    def slice_(addr, start, end):
        """Characters start … end - 1 of the text at addr, made."""
        a = skip(addr, start)
        z = EUDVariable()
        z << a
        if EUDIf()(end >= start + 1):
            z << skip(a, end - start)
        EUDEndIf()
        # A text of the table may be longer than one that is made: no more of it than the scratch holds, and make() cuts.
        n = z - a
        if EUDIf()(n >= TEXT_BYTES + 2):
            n << TEXT_BYTES + 1
        EUDEndIf()
        f_memcpy(scratch, a, n)
        f_bwrite(scratch + n, 0)
        EUDReturn(*make(scratch + n))

    @EUDFunc
    def pad(addr, length, width, fill, at_start):
        """The text with `fill` over and over before or after it until it is `width` characters; as it is when it is that long, or `fill` is empty."""
        pos = EUDVariable()
        pos << scratch
        need = EUDVariable()
        need << 0
        if EUDIf()([width >= length + 1, width <= 0x7FFFFFFF, f_bread(fill) >= 1]):
            need << width - length
        EUDEndIf()
        if EUDIf()(at_start == 0):
            pos << append(pos, addr)
        EUDEndIf()
        src = EUDVariable()
        src << fill
        if EUDWhile()([need >= 1, pos <= scratch + TEXT_BYTES]):
            n = size(src)
            if EUDIf()(n == 0):
                src << fill
                n << size(src)
            EUDEndIf()
            f_memcpy(pos, src, n)
            pos += n
            src += n
            need -= 1
        EUDEndWhile()
        f_bwrite(pos, 0)
        if EUDIf()([at_start >= 1, pos <= scratch + TEXT_BYTES]):
            pos << append(pos, addr)
        EUDEndIf()
        EUDReturn(*make(pos))

    @EUDFunc
    def repeat(addr, times):
        pos = EUDVariable()
        pos << scratch
        f_bwrite(pos, 0)
        if EUDIf()([times <= 0x7FFFFFFF, f_bread(addr) >= 1]):
            if EUDWhile()([times >= 1, pos <= scratch + TEXT_BYTES]):
                pos << append(pos, addr)
                times -= 1
            EUDEndWhile()
        EUDEndIf()
        EUDReturn(*make(pos))

    @EUDFunc
    def starts(addr, find):
        """Whether the text at addr starts with the one at find."""
        br1.seekoffset(addr)
        br2.seekoffset(find)
        if EUDInfLoop()():
            want = br2.readbyte()
            if EUDIf()(want == 0):
                EUDReturn(1)
            EUDEndIf()
            EUDBreakIfNot(br1.readbyte() == want)
        EUDEndInfLoop()
        EUDReturn(0)

    @EUDFunc
    def find_from(addr, find, start):
        """The place, in characters, of the first match at or after character `start`; 0xFFFFFFFF when there is none."""
        if EUDIf()(start >= count(addr) + 1):
            EUDReturn(0xFFFFFFFF)
        EUDEndIf()
        at = skip(addr, start)
        place = EUDVariable()
        place << start
        if EUDInfLoop()():
            if EUDIf()(starts(at, find) >= 1):
                EUDReturn(place)
            EUDEndIf()
            n = size(at)
            EUDBreakIf(n == 0)
            at += n
            place += 1
        EUDEndInfLoop()
        EUDReturn(0xFFFFFFFF)

    @EUDFunc
    def ends(addr, find):
        a, b = f_strlen(addr), f_strlen(find)
        if EUDIf()(b >= a + 1):
            EUDReturn(0)
        EUDEndIf()
        if EUDIf()(f_strcmp(addr + (a - b), find) == 0):
            EUDReturn(1)
        EUDEndIf()
        EUDReturn(0)

    @EUDFunc
    def code(addr, index):
        """The number of character `index`; 0xFFFFFFFF past either end."""
        if EUDIf()(index >= 0x80000000):
            EUDReturn(0xFFFFFFFF)
        EUDEndIf()
        at = skip(addr, index)
        n = size(at)
        if EUDIf()(n == 0):
            EUDReturn(0xFFFFFFFF)
        EUDEndIf()
        br1.seekoffset(at)
        v = EUDVariable()
        v << br1.readbyte()
        if EUDIf()(n == 2):
            v << (v & 0x1F)
        if EUDElseIf()(n == 3):
            v << (v & 0x0F)
        if EUDElseIf()(n == 4):
            v << (v & 0x07)
        EUDEndIf()
        if EUDWhile()(n >= 2):
            v << f_mul(v, 64) + (br1.readbyte() & 0x3F)
            n -= 1
        EUDEndWhile()
        EUDReturn(v)

    @EUDFunc
    def show(dst, src):
        """At most TEXT_FIELD_BYTES bytes of the text at src over the string at dst, never half a character."""
        used = EUDVariable()
        used << 0
        if EUDInfLoop()():
            n = size(src)
            EUDBreakIf(n == 0)
            if EUDIf()(used + n >= TEXT_FIELD_BYTES + 1):
                if EUDIf()(said_field == 0):
                    said_field << 1
                    GetGlobalStringBuffer().print("\x06TrigScript: a text was cut off - an action's text and a unit's name show %d bytes of one that is made." % TEXT_FIELD_BYTES)
                EUDEndIf()
                EUDBreak()
            EUDEndIf()
            f_memcpy(dst + used, src, n)
            used += n
            src += n
        EUDEndInfLoop()
        f_bwrite(dst + used, 0)

    @EUDFunc
    def address(id_):
        """Where the text of the table with this id is; an empty one for id 0."""
        if EUDIf()(id_ == 0):
            EUDReturn(empty)
        EUDEndIf()
        EUDReturn(GetMapStringAddr(id_))

    _TEXT.update(scratch=scratch, empty=empty, append=append, count=count, make=make, copy=copy, release=release, slice=slice_, pad=pad, repeat=repeat,
                 starts=starts, ends=ends, find=find_from, code=code, show=show, size=size, address=address)
    return _TEXT


def slot(kind):
    """The string of the built map's table kept for one kind of field, made the first time one is asked for: its
    room in bytes that nothing else shares, which is what ForceAddString is for."""
    if kind not in _SLOTS:
        text = "(TrigScript: %s)" % kind
        _SLOTS[kind] = ForceAddString(text + " " * (TEXT_FIELD_BYTES - len(text)))
    return _SLOTS[kind]


# The actions whose text the game shows from a string it reads again whenever it draws (played 2026-09-19), by the
# kind of field: a player has one of each at a time, so one string a kind is enough.
SLOT_OF_ACTION = {12: "objectives", 7: "transmission"}
for _t in (17, 18, 19, 20, 21, 33, 34, 35, 36, 37, 40):
    SLOT_OF_ACTION[_t] = "leaderboard"


def text_id(text):
    """The id of a text written in the script; 0 for the empty one, which the table does not hold."""
    return EncodeString(text) if text else 0


_BUFFERS = {}


def buffer(name):
    """A buffer of buildText: its bytes and where the writing has got to. One for the whole game, used up within the
    frame it is built in. It may run a part past its most before it is cut, and a part is at most a text's room."""
    if name not in _BUFFERS:
        _BUFFERS[name] = (Db(BUILD_BYTES + 1 + TEXT_BYTES + 1 + 8), EUDVariable())
    return _BUFFERS[name]


_BUILD = {}


def builds():
    """What every buffer shares: copying a text onto the end of one, and cutting one that ran past its room."""
    if _BUILD:
        return _BUILD
    said_cut = EUDVariable(0)  # initial: said once a game

    @EUDFunc
    def append(pos, src, last):
        """The text at src written at pos, ended by a 0; where that 0 is. Never past `last`."""
        br1.seekoffset(src)
        bw1.seekoffset(pos)
        if EUDWhile()(pos <= last):
            b = br1.readbyte()
            EUDBreakIf(b == 0)
            bw1.writebyte(b)
            pos += 1
        EUDEndWhile()
        bw1.writebyte(0)
        EUDReturn(pos)

    @EUDFunc
    def cut(pos, end):
        """A buffer whose writing got to `pos`, cut at `end` (never inside a character) when it went past it."""
        if EUDIf()(pos > end):
            pos << end
            if EUDWhile()(f_bread(pos).ExactlyX(0x80, 0xC0)):
                pos -= 1
            EUDEndWhile()
            f_bwrite(pos, 0)
            if EUDIf()(said_cut == 0):
                said_cut << 1
                GetGlobalStringBuffer().print("\x06TrigScript: a text was cut off - one put together piece by piece holds %d bytes." % BUILD_BYTES)
            EUDEndIf()
        EUDEndIf()
        EUDReturn(pos)

    _BUILD.update(append=append, cut=cut)
    return _BUILD


class TextVal:
    """A text as the lowering holds it: where it is, the block it owns (the int 0: none), and its length in
    characters - an int, a variable, or None when nobody has counted yet. `taken`: the block is the value's own, so
    what receives the value keeps the block or gives it back; a variable's is only looked at."""

    def __init__(self, addr, block, length, taken):
        self.addr, self.block, self._length, self.taken = addr, block, length, taken

    def length(self):
        if self._length is None:
            self._length = texts()["count"](self.addr)
        return self._length


class TextStorage:
    """A text variable that is made: three cells, or three rows (of twelve in a per-player program, of a task's slots)."""

    def __init__(self, decl, rows):
        self.decl = decl
        self.rowed = rows is not None
        self.player_of = rows
        make = (lambda: cell_array([0] * rows.count)) if self.rowed else (lambda: EUDVariable(0))  # initial: no text yet, and no block
        self.addr, self.block, self.len = make(), make(), make()

    def cell(self, cell):
        return cell[self.player_of()] if self.rowed else cell

    def get(self):
        # A variable that was never given a text is an empty one: its address is 0 until then.
        addr = fresh(self.cell(self.addr))
        if EUDIf()(addr == 0):
            addr << texts()["empty"]
        EUDEndIf()
        return TextVal(addr, self.cell(self.block), self.cell(self.len), False)

    def write(self, addr, block, length):
        for cell, value in ((self.addr, addr), (self.block, block), (self.len, length)):
            if self.rowed:
                cell[self.player_of()] = value
            else:
                cell << value

    def take_out(self):
        """The text, and its block with it: the variable holds no block from here on."""
        v = self.get()
        out = TextVal(v.addr, fresh(v.block), fresh(v.length()), True)
        self.write(out.addr, 0, out.length())
        return out


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
    """A unit variable: three cells, or three rows (12-slot of a per-player program, of a task's slots)."""

    def __init__(self, decl, rows):
        self.decl = decl
        self.rowed = rows is not None
        self.player_of = rows
        make = (lambda: cell_array([0] * rows.count)) if self.rowed else (lambda: EUDVariable(0))  # initial: no unit
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


# ── fixed-point numbers (16.16, TrigScript 4's B6): a cell is the value times 65 536, read signed ──
FIXED_ONE = 1 << 16
FIXED_PI = 205887  # round(pi * 65536); compiler/fixedMath.ts has the same
FIXED_HALF_PI = 102944
DIGIT_TEXTS = Db(b"0\x001\x002\x003\x004\x005\x006\x007\x008\x009\x00")  # a digit d's text at 2 * d
DOT_TEXT = Db(b".\0\0\0")
_FIXED = {}


def fixed_text(v):
    """A fixed number known when the map is built, as a program prints it: compiler/fixedMath.ts#fixedText."""
    v = signed(v)
    m = abs(v)
    whole, places = m >> 16, ((m & 0xFFFF) * 10000 + 32768) >> 16
    if places == 10000:
        whole, places = whole + 1, 0
    sign = "-" if v < 0 and (whole or places) else ""
    return sign + str(whole) + ("." + ("%04d" % places).rstrip("0") if places else "")


def magnitudes(a, b):
    """a and b made their distances from 0 in place, and 1 when exactly one of them was below zero."""
    neg = fresh(0)
    if EUDIf()(a >= SIGN):
        a << 0 - a
        neg << 1
    EUDEndIf()
    if EUDIf()(b >= SIGN):
        b << 0 - b
        neg << 1 - neg
    EUDEndIf()
    return neg


def chain_fdiv(a, b):
    """a * 65536 / b, both read from 0 up and b below 2^24: eudplib's division chain (the divisor doubled into each step's
    condition and action, set up once), run for the whole part and then twice more for eight bits of the fraction each:
    what is left is less than b, so 256 times it still fits, and its quotient is below 256. The same digits as sixteen
    steps of a bit each, which cost a dozen triggers a step. `a` is the caller's own copy, used up."""
    whole, frac, x = EUDVariable(), EUDVariable(), EUDVariable()
    SeqCompute([(whole, SetTo, 0), (frac, SetTo, 0), (x, SetTo, b)])
    main = [(Forward(), Forward()) for _ in range(32)]
    parts = [[(Forward(), Forward()) for _ in range(8)] for _ in range(2)]
    start = [Forward() for _ in range(32)]
    for i in range(32):
        cells = [main[i]] + ([parts[0][i], parts[1][i]] if i < 8 else [])
        SeqCompute([(EPD(c), SetTo, x) for pair in cells for c in pair])
        # Past 2^31 the next doubling would wrap: the chain starts here.
        p1, p2, p3 = Forward(), Forward(), Forward()
        p1 << RawTrigger(nextptr=p2, conditions=x.AtLeastX(1, 0x80000000), actions=SetNextPtr(p1, p3))
        p3 << RawTrigger(nextptr=start[i], actions=SetNextPtr(p1, p2))
        p2 << NextTrigger()
        SeqCompute([(x, Add, x)])

    def steps(chain, top, into, scale):
        for i in range(top, -1, -1):
            c, act = Forward(), Forward()
            t = RawTrigger(conditions=[c << a.AtLeast(0)], actions=[act << a.SubtractNumber(0), into.AddNumber((1 << i) * scale)])
            if chain is main:
                start[i] << t
            chain[i][0] << c + 8
            chain[i][1] << act + 20

    steps(main, 31, whole, 1)
    for part, scale in ((parts[0], 256), (parts[1], 1)):
        for _ in range(8):
            a += a
        steps(part, 7, frac, scale)
    return shift_const(whole, "<<", 16) + frac


def fixed_fns():
    """The fixed numbers' functions, made when the first one is met: one body each in the map, called."""
    if "fdiv" in _FIXED:
        return _FIXED

    @EUDFunc
    def fmul(a, b):
        """a * b / 65536 towards zero, wrapping: the four products of the 16-bit halves of the magnitudes. A half is a
        masked copy (the low) or a bit a trigger (the high), where a division by 65 536 was a 32-step loop; each product
        has its smaller side first, which eudplib's goes over the bits of and stops past the highest."""
        neg = magnitudes(a, b)
        al, bl = fresh(a), fresh(b)
        DoActions([al.SetNumberX(0, 0xFFFF0000), bl.SetNumberX(0, 0xFFFF0000)])
        ah, bh = shift_const(a, ">>>", 16), shift_const(b, ">>>", 16)
        r = shift_const(f_mul(ah, bh), "<<", 16)
        r += f_mul(ah, bl)
        r += f_mul(bh, al)
        r += shift_const(f_mul(al, bl), ">>>", 16)
        if EUDIf()(neg == 1):
            r << 0 - r
        EUDEndIf()
        EUDReturn(r)

    @EUDFunc
    def fdiv(a, b):
        """a * 65536 / b towards zero, wrapping; a divisor of 0 gives 0. The whole part by eudplib's division, then
        sixteen more bits of the quotient, one a step, from what is left over."""
        if EUDIf()(b == 0):
            EUDReturn(0)
        EUDEndIf()
        neg = magnitudes(a, b)
        q = EUDVariable()
        if EUDIf()(b <= (1 << 24) - 1):
            q << chain_fdiv(a, b)
        if EUDElse()():
            # (A divisor of 256 or more: the quotient's sixteen bits past the point one a step, from what is left over.)
            w, r = [fresh(x) for x in f_div(a, b)]
            for _ in range(16):
                r += r
                w += w
                if EUDIf()(r >= b):
                    r -= b
                    w += 1
                EUDEndIf()
            q << w
        EUDEndIf()
        if EUDIf()(neg == 1):
            q << 0 - q
        EUDEndIf()
        EUDReturn(q)

    def root4(x, pairs, zeros):
        """root() kept as four times the root found so far, t: the step's trial 4r + 1 is then rem > t, no copy of r
        made a step. Only while 4r fits in 32 bits: sqrt_fixed's root is below 2^24."""
        t, rem = fresh(0), fresh(0)
        for i in range(pairs + zeros):
            rem += rem
            rem += rem
            if i < pairs:
                for weight, bit in ((2, 31 - 2 * i), (1, 30 - 2 * i)):
                    RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=rem.AddNumber(weight))
            if EUDIf()(rem > t):
                rem -= t
                rem -= 1
                t += t
                t += 4
            if EUDElse()():
                t += t
            EUDEndIf()
        return shift_const(t, ">>>", 2)

    def root(x, pairs, zeros):
        """The largest r with r * r <= x * 4 ** zeros, x read as `pairs` pairs of bits from the top: two bits a step."""
        r, rem = fresh(0), fresh(0)
        for i in range(pairs + zeros):
            rem += rem
            rem += rem
            if i < pairs:
                # The next two bits of x, read where they are (x was doubled twice a step to bring them to the top).
                for weight, bit in ((2, 31 - 2 * i), (1, 30 - 2 * i)):
                    RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=rem.AddNumber(weight))
            trial = fresh(r)
            trial += trial
            trial += trial
            trial += 1
            r += r
            if EUDIf()(rem >= trial):
                rem -= trial
                r += 1
            EUDEndIf()
        return r

    @EUDFunc
    def sqrt_fixed(x):
        """The square root of a fixed number, rounded down: isqrt(x * 65536); 0 below zero."""
        if EUDIf()(x >= SIGN):
            EUDReturn(0)
        EUDEndIf()
        EUDReturn(root4(x, 16, 8))

    @EUDFunc
    def sqrt_whole(x):
        """The square root of a whole number read from 0 up, as a fixed one: isqrt(x * 2 ** 32). From 2 ** 30 up it
        is past what a fixed number holds, and gives the largest."""
        if EUDIf()(x >= 1 << 30):
            EUDReturn(0x7FFFFFFF)
        EUDEndIf()
        EUDReturn(root(x, 16, 16))

    _FIXED.update(fmul=fmul, fdiv=fdiv, sqrt_fixed=sqrt_fixed, sqrt_whole=sqrt_whole)
    return _FIXED


# A trigger's first condition's number, and its first action's destination, number and modifier (a SetDeaths, its
# modifier the top byte of the dword: 7 SetTo, 8 Add), from the trigger's address: 8 bytes of links, 16 conditions of
# 20 bytes, then the actions. A cell of our own is a trigger of one action that adds its number to itself: running it
# doubles the number, and nothing routes it while only the loop it sits in runs it (TrigScript 4, the backend, part 3).
COND_VALUE, ACT_DEST, ACT_VALUE, ACT_MODIFIER_DWORD = 16, 344, 348, 352


_CONST_FDIV = {}


def const_fdiv(c, x, bound=None):
    """fdiv(c, x) — c × 65 536 / x towards zero — for a constant c and a variable x, the very bits fixed_fns()'s fdiv
    gives (compiler/fixedMath.ts#fixedDiv). `bound`: the most |x| can be, when ranges.ts knows. One body for each c
    (and bound) in the map, called."""
    c = signed(c & U32)
    if c == 0:
        return 0
    key = (abs(c), bound)
    if key not in _CONST_FDIV:
        _CONST_FDIV[key] = make_const_fdiv(abs(c), bound)
    q = fresh(_CONST_FDIV[key](as_var(x)))
    if c < 0:
        q << 0 - q
    return q


def make_const_fdiv(c, bound):
    """The divisor, not the dividend, stays where it is: long division the way it is done on paper, the remainder
    doubled a step and the divisor taken from it when it fits, so the divisor is written into the one comparison and
    the one subtraction of a loop of four triggers, where eudplib's division writes it, doubled, into every step it
    has (each a copy, the cost of all the rest). The dividend c × 65 536 is known: where the divisor's highest bit is
    (a search of comparisons) says how far down the dividend the first step that can take the divisor away is, and
    what the remainder is there (a constant), so only the steps that make a bit of the quotient are run. The quotient
    is counted in a cell with a bit put above it, which reaches the top on the last step: the loop's test of its end.
    Quotients of 2^31 and more (a divisor of a few 65 536ths) are fixed_fns()'s fdiv's."""
    d = c << 16
    top_d = d.bit_length() - 1
    t_most = 31 if bound is None else max(0, min(31, bound.bit_length() - 1))

    def plan(t):
        """For a divisor whose highest bit is t: (steps, the remainder before them, the dividend's bits still to
        come at the top of a cell), or None when the loop cannot (no step: the quotient is 0; too many: wraps)."""
        n = top_d - t + 1
        if n <= 0:
            return "zero"
        if n > 31:
            return None
        return (n, d >> n, ((d & ((1 << n) - 1)) << (32 - n)) & U32)

    plans = {t: plan(t) for t in range(t_most + 1)}
    with_bits = any(isinstance(v, tuple) and v[2] for v in plans.values())

    @EUDFunc
    def fdiv_by(x):
        out = EUDVariable()
        if EUDIf()(x == 0):
            EUDReturn(0)
        EUDEndIf()
        neg = fresh(0)
        if EUDIf()(x >= SIGN):
            x << 0 - x
            neg << 1
        EUDEndIf()
        # The quotient, the remainder and the dividend's bits still to come: three cells of our own in one trigger, the
        # three numbers doubled by one run of it.
        cells, take_bit, test, end, leave, after = Forward(), Forward(), Forward(), Forward(), Forward(), Forward()
        q, r, bits = cells + ACT_VALUE, cells + ACT_VALUE + 32, cells + ACT_VALUE + 64
        # The divisor, where the loop compares and subtracts.
        SeqCompute([(EPD(test + COND_VALUE), SetTo, x), (EPD(test + ACT_VALUE), SetTo, x)])
        # The quotient's cell back to doubling itself (the last call sent it to `out`).
        DoActions([SetMemory(cells + ACT_DEST, SetTo, EPD(q)),
                   SetMemoryX(cells + ACT_MODIFIER_DWORD, SetTo, 8 << 24, 0xFF000000),
                   SetNextPtr(cells, take_bit if with_bits else test)])
        how = fresh(0)  # 0: the loop, 1: the quotient is 0, 2: fdiv's own way

        def leaf(t):
            p = plans[t]
            if p is None:
                DoActions(how.SetNumber(2))
            elif p == "zero":
                DoActions(how.SetNumber(1))
            else:
                n, r0, rest = p
                # (The dividend's bits a place lower than where they are tested: the cells double them first.)
                acts = [SetMemory(r, SetTo, r0), SetMemory(q, SetTo, 1 << (31 - n))]
                if with_bits:
                    acts.append(SetMemory(bits, SetTo, rest >> 1))
                DoActions(acts)

        def tree(lo, hi):
            if lo == hi:
                leaf(lo)
                return
            mid = (lo + hi + 1) // 2
            if EUDIf()(x >= (1 << mid)):
                tree(mid, hi)
            if EUDElse()():
                tree(lo, mid - 1)
            EUDEndIf()

        tree(0, t_most)
        if EUDIf()(how == 0):
            cells << RawTrigger(actions=[SetMemory(q, Add, 0), SetMemory(r, Add, 0)] + ([SetMemory(bits, Add, 0)] if with_bits else []))
            if with_bits:
                # The dividend's next bit into the remainder, from the top of its cell.
                take_bit << RawTrigger(conditions=Memory(bits, AtLeast, SIGN), actions=SetMemory(r, Add, 1))
            test << RawTrigger(conditions=Memory(r, AtLeast, 0), actions=[SetMemory(r, Subtract, 0), SetMemory(q, Add, 1)])
            end << RawTrigger(nextptr=cells, conditions=Memory(q, AtLeast, SIGN), actions=SetNextPtr(end, leave))
            # The quotient's cell run once more, its number written into `out`; the bit above it taken off after.
            leave << RawTrigger(nextptr=cells, actions=[
                SetNextPtr(end, cells),
                SetMemory(cells + ACT_DEST, SetTo, EPD(out.getValueAddr())),
                SetMemoryX(cells + ACT_MODIFIER_DWORD, SetTo, 7 << 24, 0xFF000000),
                SetNextPtr(cells, after),
            ])
            after << RawTrigger(actions=out.AddNumber(SIGN))
        if EUDElseIf()(how == 1):
            out << 0
        if EUDElse()():
            out << fixed_fns()["fdiv"](c, x)
        EUDEndIf()
        if EUDIf()(neg == 1):
            out << 0 - out
        EUDEndIf()
        EUDReturn(out)

    return fdiv_by


_FIXED_BY_CONST = {}


def fixed_by_const(name, x, c, bound=None):
    """fmul(x, c) or fdiv(x, c) of a variable x and a constant c: the very bits fixed_fns()'s give
    (compiler/fixedMath.ts), from comparisons with constants and constants added — nothing copied. `bound`: the most
    |x| can be, when ranges.ts knows. One body for each constant (and bound) in the map, called."""
    c = signed(c & U32)
    if c == 0:
        return 0
    key = (name, abs(c), bound)
    if key not in _FIXED_BY_CONST:
        _FIXED_BY_CONST[key] = (make_fmul_by if name == "fmul" else make_fdiv_by_const)(abs(c), 31 if bound is None else max(0, min(31, bound.bit_length() - 1)))
    q = fresh(_FIXED_BY_CONST[key](as_var(x)))
    if c < 0:
        q << 0 - q
    return q


def magnitude_of(x):
    """x made its distance from 0 in place; 1 when it was below 0."""
    neg = fresh(0)
    if EUDIf()(x >= SIGN):
        x << 0 - x
        neg << 1
    EUDEndIf()
    return neg


def make_fmul_by(c, top):
    """x × c / 65 536 towards zero: each bit of |x| adds c times its place, split at the point — the whole part added
    into the result and the part below it gathered apart, whose whole part is added at the end (so the result is the
    product's, not a sum of rounded parts). `top`: the highest bit |x| can have."""
    parts = [((c << j) >> 16, (c << j) & 0xFFFF) for j in range(top + 1)]
    low_bits = sum(lo for _, lo in parts).bit_length()

    @EUDFunc
    def fmul_by(x):
        neg = magnitude_of(x)
        out, low = fresh(0), fresh(0)
        for j, (hi, lo) in enumerate(parts):
            acts = ([out.AddNumber(hi & U32)] if hi & U32 else []) + ([low.AddNumber(lo)] if lo else [])
            if acts:
                RawTrigger(conditions=x.AtLeastX(1, 1 << j), actions=acts)
        for k in range(16, low_bits):
            RawTrigger(conditions=low.AtLeastX(1, 1 << k), actions=out.AddNumber(1 << (k - 16)))
        if EUDIf()(neg == 1):
            out << 0 - out
        EUDEndIf()
        EUDReturn(out)

    return fmul_by


def make_fdiv_by_const(c, top):
    """x × 65 536 / c towards zero: long division with the divisor doubled into each step when the map is built, so a
    step is one comparison with a constant. The whole part's quotient bits go straight to their place 16 higher; the
    remainder, below c, is then moved up as far as stays under 2^32 (a bit tested, its new place added) and divided
    again, until the sixteen bits below the point are found. `top`: the highest bit |x| can have."""
    c_top = c.bit_length() - 1
    chunk = max(1, 31 - c_top)

    @EUDFunc
    def fdiv_by_const(x):
        neg = magnitude_of(x)
        out = fresh(0)
        # The whole part: steps from the highest multiple of c that |x| can reach.
        for i in range(min(31 - c_top, top - c_top) if top >= c_top else -1, -1, -1):
            add = (1 << (i + 16)) & U32
            RawTrigger(conditions=x.AtLeast(c << i), actions=[x.SubtractNumber(c << i)] + ([out.AddNumber(add)] if add else []))
        # Below the point: x < c now.
        done = 0
        while done < 16:
            k = min(chunk, 16 - done)
            for bit in range(c_top, -1, -1):  # x <<= k, from its top bit down (each lands where nothing is yet)
                RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=x.AddNumber(((1 << (bit + k)) - (1 << bit)) & U32))
            done += k
            for i in range(k - 1, -1, -1):
                RawTrigger(conditions=x.AtLeast(c << i), actions=[x.SubtractNumber(c << i), out.AddNumber(1 << (i + 16 - done))])
        if EUDIf()(neg == 1):
            out << 0 - out
        EUDEndIf()
        EUDReturn(out)

    return fdiv_by_const


def fixed_vars():
    """fmul and fdiv of two variables (TrigScript 4, the backend, part 3): loops over cells of our own, the other side
    written once into the step that adds or subtracts it, where eudplib's ways write it, shifted, into every step.
    One body each in the map, called."""
    if "fmul_vars" in _FIXED:
        return _FIXED

    def take_out(cells, out, after):
        """The actions that send the first cell of `cells` into `out` when the trigger runs next, and go on to
        `after`; the cell is put back to doubling itself when its loop starts again."""
        return [SetMemory(cells + ACT_DEST, SetTo, EPD(out.getValueAddr())),
                SetMemoryX(cells + ACT_MODIFIER_DWORD, SetTo, 7 << 24, 0xFF000000),
                SetNextPtr(cells, after)]

    def put_back(cells, nxt):
        return [SetMemory(cells + ACT_DEST, SetTo, EPD(cells + ACT_VALUE)),
                SetMemoryX(cells + ACT_MODIFIER_DWORD, SetTo, 8 << 24, 0xFF000000),
                SetNextPtr(cells, nxt)]

    @EUDFunc
    def fmul_vars(a, b):
        """a × b / 65 536 towards zero. With the 16-bit halves of the magnitudes, a × b / 65 536 is ah × b + al × bh
        plus al × bl / 65 536: one loop of sixteen steps reads a bit of ah and the same bit of al (a doubled a step,
        its bits 31 and 15 tested), and doubles two sums — w gathering ah × b + al × bh, z gathering al × bl, whose
        bits from 16 up are added to w at the end."""
        neg = magnitudes(a, b)
        bh = shift_const(b, ">>>", 16)
        bl = fresh(b)
        DoActions(bl.SetNumberX(0, 0xFFFF0000))
        out, count = EUDVariable(), EUDVariable()
        cells, high, low, end, leave, after = (Forward() for _ in range(6))
        w, z, x = cells + ACT_VALUE, cells + ACT_VALUE + 32, cells + ACT_VALUE + 64
        SeqCompute([(EPD(high + ACT_VALUE), SetTo, b), (EPD(low + ACT_VALUE), SetTo, bh), (EPD(low + ACT_VALUE + 32), SetTo, bl), (EPD(x), SetTo, a)])
        DoActions(put_back(cells, high) + [SetMemory(w, SetTo, 0), SetMemory(z, SetTo, 0), count.SetNumber(15)])
        # A step: the bits added, then (but on the last step) the sums and a doubled.
        high << RawTrigger(conditions=Memory(x, AtLeast, SIGN), actions=SetMemory(w, Add, 0))
        low << RawTrigger(conditions=MemoryX(x, AtLeast, 1, 0x8000), actions=[SetMemory(w, Add, 0), SetMemory(z, Add, 0)])
        end << RawTrigger(conditions=count.Exactly(0), actions=SetNextPtr(end, leave))
        cells << RawTrigger(nextptr=high, actions=[SetMemory(w, Add, 0), SetMemory(z, Add, 0), SetMemory(x, Add, 0), count.SubtractNumber(1)])
        leave << RawTrigger(actions=SetNextPtr(end, cells))
        for k in range(16, 32):
            RawTrigger(conditions=MemoryX(z, AtLeast, 1, 1 << k), actions=SetMemory(w, Add, 1 << (k - 16)))
        RawTrigger(nextptr=cells, actions=take_out(cells, out, after))
        after << NextTrigger()
        if EUDIf()(neg == 1):
            out << 0 - out
        EUDEndIf()
        EUDReturn(out)

    @EUDFunc
    def fdiv_vars(a, b):
        """a × 65 536 / b towards zero; a divisor of 0 gives 0. Long division the way it is done on paper: the dividend's
        bits shifted into the remainder from the top, the divisor taken away when it fits, the quotient doubled a step
        (wrapping, as fdiv's does). The divisor is written into the one comparison and the one subtraction of the loop.
        The dividend's leading zeros first: the loop's cells run on their own until its top bit is in place, each run
        a step with nothing in it (the quotient and remainder are 0, and stay so)."""
        if EUDIf()([b == 0]):
            EUDReturn(0)
        EUDEndIf()
        if EUDIf()([a == 0]):
            EUDReturn(0)
        EUDEndIf()
        neg = magnitudes(a, b)
        out, count = EUDVariable(), EUDVariable()
        if EUDIf()(a >= SIGN):
            # (2^31, the magnitude of -2^31 only: its top bit is past where the loop starts.)
            # (fdiv's own way reads it as -2^31, and b as -2^31 too when it is 2^31: the quotient of the magnitudes is
            # its quotient, negated when only a read below zero.)
            out << fixed_fns()["fdiv"](a, b)
            if EUDIf()(b <= 0x7FFFFFFF):
                out << 0 - out
            EUDEndIf()
        if EUDElse()():
            cells, ready, take_bit, test, end, leave, after = (Forward() for _ in range(7))
            q, r, d = cells + ACT_VALUE, cells + ACT_VALUE + 32, cells + ACT_VALUE + 64
            SeqCompute([(EPD(test + COND_VALUE), SetTo, b), (EPD(test + ACT_VALUE), SetTo, b), (EPD(d), SetTo, a)])
            # 47 steps: the dividend's bits 30 … 0 and sixteen 0s.
            DoActions(put_back(cells, ready) + [SetMemory(q, SetTo, 0), SetMemory(r, SetTo, 0), count.SetNumber(47)])
            # Until the dividend's top bit is at bit 30: then a run of the cells brings it to 31, where it is taken.
            ready << RawTrigger(nextptr=cells, conditions=Memory(d, AtLeast, 1 << 30), actions=SetNextPtr(cells, take_bit))
            cells << RawTrigger(nextptr=ready, actions=[SetMemory(q, Add, 0), SetMemory(r, Add, 0), SetMemory(d, Add, 0), count.SubtractNumber(1)])
            take_bit << RawTrigger(conditions=Memory(d, AtLeast, SIGN), actions=SetMemory(r, Add, 1))
            test << RawTrigger(conditions=Memory(r, AtLeast, 0), actions=[SetMemory(r, Subtract, 0), SetMemory(q, Add, 1)])
            end << RawTrigger(nextptr=cells, conditions=count.Exactly(0), actions=SetNextPtr(end, leave))
            leave << RawTrigger(nextptr=cells, actions=[SetNextPtr(end, cells)] + take_out(cells, out, after))
            after << NextTrigger()
        EUDEndIf()
        if EUDIf()(neg == 1):
            out << 0 - out
        EUDEndIf()
        EUDReturn(out)

    _FIXED.update(fmul_vars=fmul_vars, fdiv_vars=fdiv_vars)
    return _FIXED


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


class Coroutine:
    """Where a coroutine is: the label it goes on from (0 its start, DONE once it ended) and the frames it still waits,
    a cell each, a row of twelve in a per-player program, a row a slot in a task's body. The program is one; each branch
    of a Promise.all / race is another, which runs inside the frame of what waits at that statement; a task is one too.
    `task`: the coroutine is a task's own, which a cancel() may have ended while it ran: parking leaves an end an end."""

    def __init__(self, lowering, rows, initial=0, task=False):
        self.lowering = lowering
        self.state = RowCell(rows, initial)
        self.wait = RowCell(rows, 0)
        self.task = task
        self.resumes = []  # (index, Forward) for every place it can go on from
        self.frame_end = None

    def get_state(self):
        return self.state.get()

    def set_state(self, value):
        self.state.set(value)

    def get_wait(self):
        return self.wait.get()

    def set_wait(self, value):
        self.wait.set(value)

    def park(self, index, wait):
        """Stop here for this frame, to go on from `index` once `wait` more frames have passed."""
        if self.task:
            if EUDIfNot()(as_var(self.get_state()) == DONE):
                self.set_state(index)
            EUDEndIf()
        else:
            self.set_state(index)
        self.set_wait(wait)
        EUDJump(self.frame_end)

    def resume_point(self):
        """A place to go on from: its number, which the state takes, and its label, to be placed where it is."""
        index = len(self.resumes) + 1
        label = Forward()
        self.resumes.append((index, label))
        return index, label


class Pool:
    """A `start` statement's tasks: `max` slots, each a row of the cells of the task's body - its coroutine's place
    (DONE: the slot is free), the generation of the task in it, the frame it last had its turn in. `slot` is the slot
    being run or started, `row` its row among the cells (the player's rows first in a per-player program, from `base`)."""

    def __init__(self, lowering, st):
        self.st = st
        self.task = int(st["task"])
        self.max = int(st["max"])
        self.slot = EUDVariable(0)  # initial: the pool's own state
        self.row = EUDVariable(0)  # initial: the pool's own state
        self.base = EUDVariable(0)  # initial: the pool's own state
        self.said = EUDVariable(0)  # initial: nothing said yet
        self.rows = Rows(lowering, lowering.per_player, self)
        self.co = Coroutine(lowering, self.rows, DONE, task=True)
        self.gen = RowCell(self.rows, 0)
        self.ran = RowCell(self.rows, 0)
        # How many of its slots are running (the player's, in a per-player program), and that count where the tasks'
        # turn can test it every time round: the slots after the last running one are not looked at.
        self.live = RowCell(Rows(lowering, True, None) if lowering.per_player else None, 0)
        self.count = self.live.store if not lowering.per_player else EUDVariable(0)  # initial: the pool's own state
        # A listener's start (on.created, ...): set when one of its tasks is started and has not had its first turn, so
        # that without it and with nothing heard the tasks' turn passes the whole start by.
        self.fresh = RowCell(Rows(lowering, True, None) if lowering.per_player else None, 0) if st.get("listen") is not None else None

    def add(self, n):
        """One more task running (1) or one fewer (-1)."""
        if self.count is self.live.store:
            self.count += n
            return
        self.live.set(as_var(self.live.get()) + n)
        self.count += n

    def select(self, i):
        self.slot << i
        self.row << self.base + i

    def at(self, cell, slot):
        """A cell of the slot `slot`, without selecting it: the one being run stays where it is."""
        return cell.store[self.base + slot]


class SlotTable(EUDObject):
    """A dword for each of the game's 1700 unit slots, 336 bytes apart as the slots are: a unit's own EPD plus one number is
    its cell, as eudplib's EUDLoopNewUnit keeps its marks. The space between the cells is left for anything else."""

    def GetDataSize(self):
        return 4 + UNIT_SIZE * (UNIT_SLOTS - 1)

    def WritePayload(self, buf):
        buf.WriteDword(0)
        for _ in range(UNIT_SLOTS - 1):
            buf.WriteSpace(UNIT_SIZE - 4)
            buf.WriteDword(0)


class Events:
    """The frame's events pass (on.created / on.died), before the programs' turns: the units that came onto the map since
    the pass before, and the ones that died. A slot's cell of `seen` holds the uniqueness byte of the unit seen in it (as
    it sits in its dword, masked 0xFF00) and, once that unit's death has been handed on, one more: so a unit is new when
    its slot's cell is not its byte, and a death is handed on once, and only for a unit that was seen on the map. Each
    list on the map is walked from its head to the record that was behind the head at the pass before, the units linked
    in since lying in between; when that record has left the list the walk goes to the end, which costs more and misses
    nothing. The dying list is walked whole, both ways from the record its address gives: in 1.16.1 that is the list's
    head, but Remastered links its dying list the other way round and hands an EUD map its tail there (its own code
    links a dying unit in behind the other end, which no map can read), so only a walk both ways sees every record in
    both. A record stays on it only until its sprite is gone. Nothing of the game is written."""

    def __init__(self, created, died, ordered=False, morphed=False):
        self.created, self.died, self.ordered, self.morphed = created, died, ordered, morphed
        self.seen = SlotTable()
        # on.order / on.morphed: each slot's order (masked 0xFF00, as it sits in its dword) and type as the pass before found
        # them, and this frame's units that changed, each with what it was.
        self.orders = SlotTable() if ordered else None
        self.types = SlotTable() if morphed else None
        self.turned, self.turned_was = (EUDArray(EVENT_CAP), EUDArray(EVENT_CAP)) if ordered else (None, None)
        self.turned_n = EUDVariable(0)  # initial: the pass's own state, set at its start
        self.changed, self.changed_was = (EUDArray(EVENT_CAP), EUDArray(EVENT_CAP)) if morphed else (None, None)
        self.changed_n = EUDVariable(0)  # initial: the pass's own state, set at its start
        # Each a unit's pointer, which f_cunitepdread_epd reads back cheaply with its EPD: within the frame a slot is not
        # given to another unit (that takes a dying pass), so its uniqueness byte need not be kept.
        self.made = EUDArray(EVENT_CAP) if created else None
        self.made_n = EUDVariable(0)  # initial: the pass's own state, set at its start
        self.gone = EUDArray(EVENT_CAP) if died else None
        self.gone_n = EUDVariable(0)  # initial: the pass's own state, set at its start
        # For each list, as the pass before left it: the record behind the head (pointer, EPD, uniqueness byte) and the
        # head (pointer, EPD). Nothing is linked in but behind the head, so with both the same nothing came in since.
        self.bounds = {VISIBLE_HEAD: [EUDVariable(0) for _ in range(5)]}  # initial: no pass before

    def cell(self, epd, table=None):
        return epd + (EPD(table or self.seen) - EPD(UNIT_TABLE))

    def walk(self, head, step):
        """`step(ptr, epd, uid, cell, stop)` for each record from the head to the one behind the head at the pass before."""
        bptr, bepd, buid, hptr, hepd = self.bounds[head]
        top, done, stop = Forward(), Forward(), Forward()
        # Nothing linked in since the pass before: the same head, the same record behind it (or none).
        walk = Forward()
        EUDJumpIfNot(Memory(head, Exactly, hptr), walk)
        EUDJumpIf(hptr == 0, stop)
        if EUDIf()(bptr == 0):
            EUDJumpIf(MemoryEPD(hepd + 1, Exactly, 0), stop)
        if EUDElse()():
            EUDJumpIf([MemoryEPD(hepd + 1, Exactly, bptr), MemoryXEPD(bepd + OFF_UID, Exactly, buid, 0xFF00)], stop)
        EUDEndIf()
        walk << NextTrigger()
        ptr, epd = f_cunitepdread_epd(EPD(head))
        first = fresh(1)
        top << NextTrigger()
        EUDJumpIf(ptr == 0, done)
        uid = f_maskread_epd(epd + OFF_UID, 0xFF00)
        EUDJumpIf([first == 0, ptr == bptr, uid == buid], done)
        first << 0
        step(ptr, epd, uid, self.cell(epd), stop)
        f_cunitepdread_epd(epd + 1, ret=[ptr, epd])
        EUDJump(top)
        done << NextTrigger()
        # What is behind the head now is where the next pass stops.
        f_cunitepdread_epd(EPD(head), ret=[hptr, hepd])
        bptr << 0
        if EUDIf()(hptr >= 1):
            f_cunitepdread_epd(hepd + 1, ret=[bptr, bepd])
            if EUDIf()(bptr >= 1):
                buid << f_maskread_epd(bepd + OFF_UID, 0xFF00)
            EUDEndIf()
        EUDEndIf()
        stop << NextTrigger()

    def walk_all(self, head, step):
        """`step(ptr, epd, uid, cell, stop)` for every record of a list: the one at its address, those after it (+4), then
        those before it (+0)."""
        top, done, stop = Forward(), Forward(), Forward()
        EUDJumpIf(Memory(head, Exactly, 0), stop)
        ptr, epd = f_cunitepdread_epd(EPD(head))
        sepd = EUDVariable()
        sepd << epd
        link = fresh(1)
        top << NextTrigger()
        EUDJumpIf(ptr == 0, done)
        uid = f_maskread_epd(epd + OFF_UID, 0xFF00)
        step(ptr, epd, uid, self.cell(epd), stop)
        if EUDIf()(link == 1):
            f_cunitepdread_epd(epd + 1, ret=[ptr, epd])
        if EUDElse()():
            f_cunitepdread_epd(epd, ret=[ptr, epd])
        EUDEndIf()
        EUDJump(top)
        done << NextTrigger()
        # The way after it is done: now the way before it, from the record before the first.
        EUDJumpIf(link == 0, stop)
        link << 0
        f_cunitepdread_epd(sepd, ret=[ptr, epd])
        EUDJump(top)
        stop << NextTrigger()

    def watch(self):
        """on.order / on.morphed: every unit on the map, its order and its type against what the pass before found. A unit
        not seen before (it comes on in this pass) only has them kept; the units that came on are taken after this. The
        type is read as its low byte (there are 228). Whether the unit was seen is asked only when something changed."""
        top, done = Forward(), Forward()
        ptr, epd = f_cunitepdread_epd(EPD(VISIBLE_HEAD))
        top << NextTrigger()
        EUDJumpIf(ptr == 0, done)
        for table, buf, was, n, off, mask in ((self.orders, self.turned, self.turned_was, self.turned_n, OFF_OWNER_ORDER, 0xFF00),
                                              (self.types, self.changed, self.changed_was, self.changed_n, OFF_TYPE, 0xFF)):
            if table is None:
                continue
            now = f_maskread_epd(epd + off, mask)
            cell = self.cell(epd, table)
            if EUDIfNot()(MemoryEPD(cell, Exactly, now)):
                if EUDIf()([MemoryXEPD(epd + OFF_UID, Exactly, f_dwread_epd(self.cell(epd)), 0xFF00), n < EVENT_CAP]):
                    buf[n] = ptr
                    old = f_dwread_epd(cell)
                    was[n] = f_bitrshift(old, 8) if mask == 0xFF00 else old
                    n += 1
                EUDEndIf()
                f_dwwrite_epd(cell, now)
            EUDEndIf()
        f_cunitepdread_epd(epd + 1, ret=[ptr, epd])
        EUDJump(top)
        done << NextTrigger()

    def run(self):
        self.made_n << 0
        self.gone_n << 0
        self.turned_n << 0
        self.changed_n << 0
        if self.ordered or self.morphed:
            self.watch()

        def came(ptr, epd, uid, cell, stop):
            if EUDIfNot()(MemoryEPD(cell, Exactly, uid)):
                EUDJumpIf(self.made_n >= EVENT_CAP, stop)
                f_dwwrite_epd(cell, uid)
                if self.created:
                    self.made[self.made_n] = ptr
                    self.made_n += 1
            EUDEndIf()
        self.walk(VISIBLE_HEAD, came)
        if self.died:
            def went(ptr, epd, uid, cell, stop):
                if EUDIf()(MemoryEPD(cell, Exactly, uid)):
                    EUDJumpIf(self.gone_n >= EVENT_CAP, stop)
                    f_dwwrite_epd(cell, uid + 1)
                    self.gone[self.gone_n] = ptr
                    self.gone_n += 1
                EUDEndIf()
            self.walk_all(DYING_HEAD, went)


def uses_source(node, which):
    """Whether a piece of the IR has a loop over the events pass's units of that kind."""
    if isinstance(node, list):
        return any(uses_source(x, which) for x in node)
    if isinstance(node, dict):
        if node.get("kind") == "unitLoop" and node.get("source") == which:
            return True
        return any(uses_source(v, which) for v in node.values() if isinstance(v, (list, dict)))
    return False


def mentions(node, kind):
    """Whether a node of that kind is anywhere in a piece of the IR."""
    if isinstance(node, list):
        return any(mentions(x, kind) for x in node)
    if not isinstance(node, dict):
        return False
    if node.get("kind") == kind:
        return True
    return any(mentions(v, kind) for v in node.values() if isinstance(v, (dict, list)))


def called_ids(node, out):
    """The ids of the functions a piece of the IR calls."""
    if isinstance(node, list):
        for x in node:
            called_ids(x, out)
    elif isinstance(node, dict):
        if node.get("kind") in ("call", "textCall") and isinstance(node.get("call"), dict) and node["call"].get("fn") is not None:
            out.add(node["call"]["fn"])
        for v in node.values():
            if isinstance(v, (dict, list)):
                called_ids(v, out)
    return out


def throwing_functions(program):
    """The called functions that may come back with an error in flight (B4): one that throws, or calls itself (its stack may
    run out), or calls one that may. Each call of one is followed by a look at the error in flight."""
    if not program.get("errors"):
        return set()
    fns = {f["id"]: f for f in program.get("functions", [])}
    out = {i for i, f in fns.items() if f.get("recursive") or mentions(f["body"], "throw")}
    callees = {i: called_ids(f["body"], set()) for i, f in fns.items()}
    grew = True
    while grew:
        grew = False
        for i in fns:
            if i not in out and callees[i] & out:
                out.add(i)
                grew = True
    return out


def collect_decls(node, out):
    """Every variable declaration in a piece of the IR, by id: what a `declare` and a loop declare, a call's
    parameters and result, a function's."""
    if isinstance(node, list):
        for x in node:
            collect_decls(x, out)
        return
    if not isinstance(node, dict):
        return
    if isinstance(node.get("id"), str) and node.get("kind") in ("number", "boolean", "unit", "text") and "shared" in node:
        out.setdefault(node["id"], node)
    for v in node.values():
        if isinstance(v, (list, dict)):
            collect_decls(v, out)


def mentions_array(e, array):
    """Whether an expression reads the array anywhere in it."""
    if isinstance(e, dict):
        if e.get("array") == array:
            return True
        return any(mentions_array(x, array) for x in e.values())
    if isinstance(e, list):
        return any(mentions_array(x, array) for x in e)
    return False


def mentions_var(e, id_):
    """Whether an expression reads the variable anywhere in it."""
    if isinstance(e, dict):
        if e.get("kind") == "var" and e.get("id") == id_:
            return True
        return any(mentions_var(x, id_) for x in e.values())
    if isinstance(e, list):
        return any(mentions_var(x, id_) for x in e)
    return False


# Expressions that read and do nothing else: worked out at any point of a statement, they give the same answer.
PLAIN_KINDS = {"const", "var", "cast", "unary", "binary", "element", "length"}


def plain(e):
    if not isinstance(e, dict) or "kind" not in e:
        return True  # (not an expression: a number, a position)
    if e.get("kind") not in PLAIN_KINDS:
        return False
    return all(plain(v) for k, v in e.items() if isinstance(v, dict))


class Lowering:
    def __init__(self, program):
        self.p = program
        self.per_player = bool(program.get("perPlayer"))
        self.owner = int(program.get("owner", 0))
        self.slots = owner_slots(program)
        self.player = None
        self.vars = {}
        # Every variable of the program by id, and those made before their declaration was lowered: a function is
        # lowered where it is first called, which may come before a variable it uses is declared (a function kept
        # as a value, B3, is lowered with every other of its dispatcher's).
        self.decls = {}
        collect_decls(program, self.decls)
        self.early = set()
        # The `start` statements' tasks, by their number, in that order; the one whose body is being lowered.
        starts = []
        each_start([program.get("body", []), program.get("functions", [])], starts.append)
        self.pools = {}
        self.pool = None
        for st in sorted(starts, key=lambda st: int(st["task"])):
            self.pools[int(st["task"])] = Pool(self, st)
        self.tick = EUDVariable(0)  # initial: frames the tasks have run
        self.again = EUDVariable(0)  # initial: no task started during the tasks' turn
        self.arrays = {}
        for a in program.get("arrays", []):
            if a.get("slice"):
                self.arrays[a["id"]] = SliceStorage(a, self)
            elif a.get("through"):
                self.arrays[a["id"]] = InnerListStorage(a, self)
            else:
                self.arrays[a["id"]] = (ListStorage if a.get("dynamic") else ArrayStorage)(a, self.rows_of(a))
        # Counters whose offset into the arrays they index is kept beside them (`Place`), by id; a growing array read
        # at one keeps where its block starts.
        self.places = {}
        # Inside a loop over a growing array at a counter, the arrays read there unchecked: index id → {array id: True,
        # or the flag the loop set on the way in}.
        self.inside = {}
        # The loops whose accesses at their counter go through registers (`Cursors`), by the counter's id.
        self.cursors = {}
        counters, saved = find_counters(program), saved_arrays(program)

        def find_places(node):
            if isinstance(node, list):
                for x in node:
                    find_places(x)
            elif isinstance(node, dict):
                idx = node.get("index")
                if node.get("kind") in ("element", "store") and isinstance(idx, dict) and idx.get("kind") == "var" and idx.get("id") in counters:
                    d, a = self.decls.get(idx["id"]), self.arrays.get(node.get("array"))
                    if d is not None and self.rows_of(d) is None:
                        if type(a) is ListStorage and node["array"] not in saved:
                            a.keep_base()
                        if a is not None and getattr(a, "placeable", lambda: False)() and idx["id"] not in self.places:
                            self.places[idx["id"]] = Place()
                for v in node.values():
                    if isinstance(v, (list, dict)):
                        find_places(v)

        find_places([program.get("body", []), program.get("functions", [])])
        # Every plain growing array keeps where its block starts, for a push with room to be a write and two adds.
        for id_, a in self.arrays.items():
            if type(a) is ListStorage and id_ not in saved:
                a.keep_base()
        # A task's parameters are set where it is started, which may be lowered after its body: theirs are made now.
        for pool in self.pools.values():
            for prm in pool.st["call"]["params"]:
                self.declare(prm["decl"])
        # The program's own coroutine, and the one being lowered (a branch of a Promise.all / race inside it, a task).
        self.top = Coroutine(self, self.rows())
        self.co = self.top
        self.latches = {}
        # The functions that are called, by id, and each one's EUDFunc once something has called it.
        self.functions = {f["id"]: f for f in program.get("functions", [])}
        self.made = {}
        # B4: the error in flight's variables (IR `errors`), the catches the lowering is inside, innermost last — or, in a
        # called function's body, its end, which it returns from with the error still in flight — and the functions whose
        # calls are followed by a look at it. The line an error was thrown at is a cell of the lowering's own.
        self.errors = program.get("errors")
        self.handlers = []
        self.throwing = throwing_functions(program)
        if self.errors:
            self.declare({"id": "(error line)", "name": "(error line)", "kind": "number", "shared": True})
        self.in_function = 0
        # The function being lowered, when it is one that calls itself: whose return address a frame keeps.
        self.within = []

    # ── storage ──
    def player_of(self):
        if self.player is None:
            raise Fail("trigscript: a per-player variable outside the player loop")
        return self.player

    def rows(self):
        """The rows a cell of the lowering's own has where the lowering is: a player's, a task's slot's, or none."""
        return Rows(self, self.per_player, self.pool) if self.per_player or self.pool else None

    def rows_of(self, decl):
        """The rows of a variable's or an array's cells: one a player unless it is shared, one a slot of its task."""
        pool = self.pools.get(decl["task"]) if decl.get("task") is not None else None
        per_player = self.per_player and not decl.get("shared")
        return Rows(self, per_player, pool) if per_player or pool else None

    def declare(self, decl):
        made = self.vars.get(decl["id"])
        if made is not None and decl.get("task") is not None:
            return made  # (a task's parameter, made with its pool)
        if made is not None and decl["id"] in self.early:
            self.early.discard(decl["id"])
            return made  # (used by a function lowered before the declaration was)
        if decl.get("kind") == "unit":
            s = UnitStorage(decl, Rows(self, self.per_player, self.pools.get(decl.get("task"))) if self.per_player or decl.get("task") is not None else None)
        elif decl.get("kind") == "text" and decl.get("text") != "id":
            s = TextStorage(decl, self.rows_of(decl))
        else:
            s = Storage(decl, self.rows_of(decl))
        self.vars[decl["id"]] = s
        return s

    def array(self, id_, node=None):
        a = self.arrays.get(id_)
        if a is None:
            raise Fail("trigscript: unknown array %r%s" % (id_, where(node)))
        return a

    def var(self, id_, node=None):
        s = self.vars.get(id_)
        if s is None and id_ in self.decls:
            s = self.declare(self.decls[id_])
            self.early.add(id_)
        if s is None:
            raise Fail("trigscript: unknown variable %r%s" % (id_, where(node)))
        return s

    def place_of(self, index, a):
        """The counter's `Place` when `index` is one and the array reads and writes at it; else None."""
        if index.get("kind") != "var" or index.get("id") not in self.places:
            return None
        return self.places[index["id"]] if getattr(a, "placeable", lambda: False)() else None

    def bound_of(self, index, array_id):
        return self.inside.get(index.get("id"), {}).get(array_id) if index.get("kind") == "var" else None

    def step_place(self, id_, value):
        place = self.places.get(id_)
        if place is not None:
            place.step(counter_step(value, id_))

    # ── numbers: an int (the 32 bits, 0 … 2^32 - 1) or an EUDVariable ──
    def cell_step(self, st, a):
        """(op, step) when a store is the cell it stores into plus or minus a number - the same array, the same index,
        an index that reads nothing else (a constant or a variable) - into a plain array of whole numbers; else None."""
        v, i = st["value"], st["index"]
        placed_list = type(a) is ListStorage and a.placeable() and self.place_of(i, a) is not None
        if not (isinstance(a, ArrayStorage) or placed_list) or a.bits or getattr(a, "values", None) is not None or a.decl["kind"] != "number" or a.decl.get("fixed"):
            return None
        if v.get("kind") != "binary" or v.get("op") not in ("+", "-") or v.get("unsigned"):
            return None
        left = v["left"]
        if left.get("kind") != "element" or left.get("array") != st["array"] or i.get("kind") not in ("const", "var") or left.get("index") != i:
            return None
        if mentions_array(v["right"], st["array"]):
            return None
        return (v["op"], v["right"])

    def assign_in_place(self, target, st):
        """A store worked out in the variable's own cell, step by step: `x = x + e` an add where it is (`x = e + x`,
        `x = x - e` too), `x = y + e` a copy and an add, `x = x & c` / `x | c` a masked write of the cell, and these
        nested (`k = (k + 1) & 15` an add and a mask). Each `e` only reads and does not read x, so the order of the
        reads cannot matter. False when the store is not of that shape (nothing is emitted then)."""
        if not isinstance(target, Storage) or target.bits:
            return False
        steps = self.into_steps(target, st["value"], st["target"])
        if not steps or steps == [("set", st["value"])]:
            return False
        for step in steps:
            if step[0] == "set":
                target.set(self.num(step[1]))
            elif step[0] == "add":
                target.add(self.num(step[2]), step[1])
            else:
                target.mask(step[1], step[2])
        return True

    def into_steps(self, target, v, id_):
        """The steps that work `v` out in the target's own cell, or None when they cannot."""
        is_me = lambda e: e.get("kind") == "var" and e.get("id") == id_
        if is_me(v):
            return []
        k, op = v.get("kind"), v.get("op")
        if k in ("const", "var"):
            return None if target.rowed else [("set", v)]
        if k != "binary" or op not in ("+", "-", "&", "|"):
            return None
        left, right = v["left"], v["right"]
        if op in ("+", "-"):
            if op == "+" and is_me(right) and not is_me(left):
                left, right = right, left
            if not plain(right) or mentions_var(right, id_) or not plain(left):
                return None
            first = self.into_steps(target, left, id_)
            if first is None or (target.rowed and (first or (op == "-" and right.get("kind") != "const"))):
                return None
            return first + [("add", op, right)]
        # & | with a constant: a masked write of the cell (the other side worked out into it first).
        if target.rowed:
            return None
        c, other = (right, left) if right.get("kind") == "const" else (left, right) if left.get("kind") == "const" else (None, None)
        if c is None or not plain(other):
            return None
        first = self.into_steps(target, other, id_)
        return None if first is None else first + [("mask", op, int(c["value"]) & U32)]

    def num(self, e):
        k = e["kind"]
        if k in ("textLength", "textIndexOf", "textCode"):
            return self.text_number(e)
        if k == "input":
            return INPUT.read(e["input"], self, e)
        if k == "const":
            return int(e["value"]) & U32
        if k == "var":
            return self.var(e["id"], e).get()
        if k == "element":
            a = self.array(e["array"], e)
            place = self.place_of(e["index"], a)
            if place is not None:
                cur = self.cursor_at(e["index"], a)
                if cur is not None:
                    return self.cursor_read(cur, a, e)
                return a.get_placed(self.num(e["index"]), place, self.bound_of(e["index"], e["array"]))
            return a.get(self.num(e["index"]))
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
        if k == "taskHandle":
            # The task whose turn it is, as start() numbered it; 0 in the program's own turn.
            pool = self.pool
            if pool is None:
                return 0
            return pool.slot + pool.task * 256 + f_bitlshift(fresh(pool.gen.get()), 16)
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
            if top_of(e["args"][0]) is not None:
                return x
            t = fresh(x)
            if EUDIf()(t >= SIGN):
                t << 0 - t
            EUDEndIf()
            return t
        if k == "intrinsic" and e["name"] in ("fmul", "fdiv", "sqrt", "atan2", "sin", "cos"):
            return self.fixed_op(e)
        if k == "intrinsic":
            a, b = [self.num(x) for x in e["args"]]
            name = e["name"]
            unsigned = bool(e.get("unsigned"))
            if isinstance(a, int) and isinstance(b, int):
                key = (lambda v: v) if unsigned else signed
                return min(a, b, key=key) if name == "min" else max(a, b, key=key)
            # One side always the smaller (ranges.ts): no comparison. Read unsigned, only when both are never below zero.
            ra, rb = rng(e["args"][0]), rng(e["args"][1])
            if ra is not None and rb is not None and (not unsigned or (ra[0] >= 0 and rb[0] >= 0)):
                if ra[1] <= rb[0]:
                    return a if name == "min" else b
                if rb[1] <= ra[0]:
                    return b if name == "min" else a
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

    def fixed_op(self, e):
        """fmul / fdiv / sqrt / atan2 of fixed numbers (raw cells): worked out here when every argument is known, else a
        call of the function fixed_fns() makes. compiler/fixedMath.ts is the same arithmetic for the simulator."""
        name = e["name"]
        args = [self.num(x) for x in e["args"]]
        if all(isinstance(x, int) for x in args):
            return fixed_const(name, [signed(x) for x in args], e.get("unsigned"), [signed(v) for v in self.array(e["table"], e).values] if name in ("atan2", "sin", "cos") else None) & U32
        fns = fixed_fns()
        bound = lambda i: (lambda r: None if r is None else max(abs(r[0]), abs(r[1])))(rng(e["args"][i]))
        if name == "fmul":
            if isinstance(args[1], int):
                return fixed_by_const("fmul", args[0], args[1], bound(0))
            if isinstance(args[0], int):
                return fixed_by_const("fmul", args[1], args[0], bound(1))
            return fresh(fixed_vars()["fmul_vars"](*[as_var(x) for x in args]))
        if name == "fdiv":
            if isinstance(args[0], int):
                return const_fdiv(args[0], args[1], bound(1))
            if isinstance(args[1], int):
                return fixed_by_const("fdiv", args[0], args[1], bound(0))
            return fresh(fixed_vars()["fdiv_vars"](*[as_var(x) for x in args]))
        if name == "sqrt":
            return fresh(fns["sqrt_whole" if e.get("unsigned") else "sqrt_fixed"](as_var(args[0])))
        if name in ("sin", "cos"):
            return self.sine(args[0], args[1], self.array(e["table"], e), name == "cos")
        return self.atan2(args[0], args[1], self.array(e["table"], e), e)

    @staticmethod
    def between(table, i, f, bits):
        """table[i] + (table[i + 1] - table[i]) * f / 2 ** bits, the part of the step towards zero: a table read between
        its cells (compiler/fixedMath.ts#between). `i + 1` past the end reads 0, as any cell past the end does."""
        a, b = fresh(table.get(i)), fresh(table.get(i + 1))
        d, out = fresh(b - a), fresh(a)
        if EUDIf()(d >= SIGN):
            d << 0 - d
            out -= f_div(f_mul(d, f), 1 << bits)[0]
        if EUDElse()():
            out += f_div(f_mul(d, f), 1 << bits)[0]
        EUDEndIf()
        return out

    def sine(self, x, scale, table, cos):
        """sin(x) of a fixed number of radians (x * scale the place in the 4096 cells of the table), or with `cos` a
        quarter turn on: compiler/fixedMath.ts#fixedSin. The next cell is cell 0 again at the end of the turn."""
        at = fresh(fixed_fns()["fmul"](as_var(x), as_var(scale)))
        f = fresh(at & 0xFFFF)
        i = fresh(f_bitrshift(at, 16))
        if cos:
            i += 1024
        i << (i & 4095)
        # Cell 4096 is cell 0: the table read with its first cell after its last.
        a, b = fresh(table.get(i)), fresh(0)
        if EUDIf()(i == 4095):
            b << table.get(0)
        if EUDElse()():
            b << table.get(i + 1)
        EUDEndIf()
        d, out = fresh(b - a), fresh(a)
        if EUDIf()(d >= SIGN):
            d << 0 - d
            out -= f_div(f_mul(d, f), 1 << 16)[0]
        if EUDElse()():
            out += f_div(f_mul(d, f), 1 << 16)[0]
        EUDEndIf()
        return out

    def atan2(self, y, x, table, node):
        """atan2(y, x) of fixed numbers: the smaller side over the larger to the nearest 1/1024, read from the table
        (atan(i / 1024)), then put in its octant: compiler/fixedMath.ts#fixedAtan2."""
        fns = fixed_fns()
        ax, ay, t = fresh(x), fresh(y), fresh(0)
        if EUDIf()(ax >= SIGN):
            ax << 0 - ax
        EUDEndIf()
        if EUDIf()(ay >= SIGN):
            ay << 0 - ay
        EUDEndIf()
        if EUDIfNot()(EUDAnd(ax == 0, ay == 0)):
            if EUDIf()(ay <= ax):
                i, f = [fresh(v) for v in f_div(fns["fdiv"](ay, ax), 64)]
                t << self.between(table, i, f, 6)
            if EUDElse()():
                i, f = [fresh(v) for v in f_div(fns["fdiv"](ax, ay), 64)]
                t << FIXED_HALF_PI - self.between(table, i, f, 6)
            EUDEndIf()
            if EUDIf()(as_var(x) >= SIGN):
                t << FIXED_PI - t
            EUDEndIf()
            if EUDIf()(as_var(y) >= SIGN):
                t << 0 - t
            EUDEndIf()
        EUDEndIf()
        return t

    def fixed_pieces(self, v):
        """A fixed number as printed pieces: its sign, its whole part, and the point and up to four places, without the
        zeros at the end. The most it comes to is 11 bytes."""
        if isinstance(v, int):
            return [fixed_text(v)]
        sign, m = fresh(NO_SIGN), fresh(v)
        if EUDIf()(m >= SIGN):
            sign << MINUS_SIGN
            m << 0 - m
        EUDEndIf()
        whole, frac = [fresh(x) for x in f_div(m, FIXED_ONE)]
        places = fresh(f_div(f_mul(frac, 10000) + 32768, FIXED_ONE)[0])
        if EUDIf()(places == 10000):
            whole += 1
            places << 0
        EUDEndIf()
        if EUDIf()(EUDAnd(whole == 0, places == 0)):
            sign << NO_SIGN
        EUDEndIf()
        # The four places as digits, then each one's text, or none once only zeros are left after it.
        digits = []
        rest = fresh(places)
        for unit in (1000, 100, 10):
            d, rest2 = [fresh(x) for x in f_div(rest, unit)]
            digits.append(d)
            rest << rest2
        digits.append(rest)
        texts = [fresh(NO_SIGN) for _ in range(4)]
        dot = fresh(NO_SIGN)
        shown = fresh(0)
        for i in (3, 2, 1, 0):
            if EUDIf()(digits[i] >= 1):
                shown << 1
            EUDEndIf()
            if EUDIf()(shown == 1):
                texts[i] << DIGIT_TEXTS + digits[i] + digits[i]
            EUDEndIf()
        if EUDIf()(shown == 1):
            dot << DOT_TEXT
        EUDEndIf()
        return [ptr2s(sign), whole, ptr2s(dot)] + [ptr2s(t) for t in texts]

    def binary(self, e):
        a, b = self.num(e["left"]), self.num(e["right"])
        op = e["op"]
        if op in BITWISE:
            return self.bitwise(op, a, b, top_of(e["left"]))
        both = isinstance(a, int) and isinstance(b, int)
        if op == "+":
            return (a + b) & U32 if both else a + b
        if op == "-":
            return (a - b) & U32 if both else a - b
        if op == "*":
            if both:
                return (a * b) & U32
            # By a power of two, a shift: x * 32 is x << 5, a fifth of the cost of eudplib's general product.
            k, v = (b, a) if isinstance(b, int) else (a, b) if isinstance(a, int) else (None, None)
            vtop = top_of(e["left"] if k is b else e["right"]) if k is not None else None
            if k is not None and k > 0 and k & (k - 1) == 0:
                return v if k == 1 else shift_const(v, "<<", k.bit_length() - 1, vtop)
            if k is not None and vtop is not None and mul_bits_pays(vtop, k):
                # The other side known to be 0 ... vtop (ranges.ts): a trigger a bit it can have.
                return mul_bits(as_var(v), vtop, k)
            if k is not None:
                # eudplib's product goes over its first operand's bits and stops past the highest that is set: whichever
                # of the two is smaller first, the constant by its distance from 0 (a number below zero has every top
                # bit set), negated after.
                m = signed(k)
                kv = EUDVariable(abs(m))  # initial: a constant, never written
                r = EUDVariable()
                if EUDIf()(v <= abs(m) - 1):
                    f_mul(v, kv, ret=[r])
                if EUDElse()():
                    f_mul(kv, v, ret=[r])
                EUDEndIf()
                return 0 - r if m < 0 else r
            # eudplib's product goes over its first operand's bits, up to the highest set: the side with fewer first.
            ta, tb = top_of(e["left"]), top_of(e["right"])
            if tb is not None and (ta is None or tb < ta):
                a, b = b, a
            return f_mul(as_var(a), as_var(b))
        # / and %: towards zero, the remainder with the dividend's sign, unless both sides are u32s. A divisor of 0 gives 0.
        unsigned = bool(e.get("unsigned"))
        pick = (lambda q, r: q) if op == "/" else (lambda q, r: r)
        # Both sides known never below zero (ranges.ts): the division is the same read either way, and takes only the
        # bits the dividend can have. A dividend that is a constant is its own top.
        atop = a if isinstance(a, int) and a < SIGN else top_of(e["left"])
        brange = (signed(b), signed(b)) if isinstance(b, int) else rng(e["right"])
        if atop is not None and not both and brange is not None and brange[0] >= 1 and (atop >> 1).bit_length() <= 24:
            if isinstance(b, int):
                return pick(*div_bits(as_var(a), b, atop))
            return pick(*div_var_bits(as_var(a), b, atop))
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
            if atop is not None and brange is not None and brange[0] >= 0 and (atop >> 1).bit_length() <= 24:
                q, r = div_var_bits(as_var(a), b, atop)
            else:
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
            # The signed side at or above zero, and the order between the two read from 0 up: one trigger's conditions,
            # ANDed by the game (EUDAnd is a branch an item). < <= != are the other three turned round and negated.
            if op in ("<", "<=", "!="):
                return not_all([sv <= SIGN - 1, relation(sv, {"<": ">=", "<=": ">", "!=": "=="}[op], u_)])
            return [sv <= SIGN - 1, relation(sv, op, u_)]
        if isinstance(a, int):
            a, b, op = b, a, FLIPPED[op]
        if unsigned or op in ("==", "!="):
            return relation(as_var(a), op, b)
        if not isinstance(b, int):
            return signed_order(as_var(a), op, as_var(b))
        return relation(a + SIGN, op, (b + SIGN) & U32 if isinstance(b, int) else b + SIGN)

    @staticmethod
    def bitwise(op, a, b, atop=None):
        """& | ^ << >> >>> over 32 bits. `>>` keeps the sign of what it shifts and `>>>` does not; a shift by 32 or
        more leaves nothing but that sign. `atop`: the left side is known to be 0 ... atop (ranges.ts)."""
        if op in ("<<", ">>", ">>>") and isinstance(b, int) and not isinstance(a, int) and 0 < b < 32:
            return shift_const(a, op, b, atop)
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
        if op in ("&", "|") and (isinstance(a, int) or isinstance(b, int)):
            # Against a constant: a copy and one masked write (eudplib's & of two variables tests a bit a trigger).
            c, x = (a, b) if isinstance(a, int) else (b, a)
            t = fresh(x)
            DoActions(_mask_action(t, op, c))
            return t
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
            return as_var(self.num(e)) >= 1
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
        if k in ("and", "or"):
            items = e["items"]
            # JavaScript stops at the first item that settles it: an item after it that runs something — a call, a
            # pop, a random number — must not run. Each such item is worked out inside the test of the ones before.
            if any(has_effect(c) for c in items[1:]):
                t = fresh(0)
                self.short_circuit(items, k == "and", t)
                return t >= 1
            if k == "and":
                # Every item is worked out either way (none of them does anything): one trigger's conditions, ANDed by the game.
                return [self.cond(c) for c in items]
            return EUDOr(*[self.cond(c) for c in items])
        if k == "not":
            return EUDNot(self.cond(e["expr"]))
        if k == "random":
            return (f_rand() & 1) >= 1
        if k in ("unitAlive", "unitFlag", "unitSame"):
            return as_var(self.truth(e)) >= 1
        if k == "running":
            return as_var(self.running(e)) >= 1
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
        if k in ("textCompare", "textTest"):
            return as_var(self.text_truth(e)) >= 1
        raise Fail("trigscript: unknown condition %r%s" % (k, where(e)))

    def short_circuit(self, items, conj, t):
        """`a && b && …` (conj) or `a || b || …` into t, each item worked out only when those before it did not settle it."""
        if not items:
            if conj:
                t << 1
            return
        if conj:
            if EUDIf()(self.cond(items[0])):
                self.short_circuit(items[1:], conj, t)
            EUDEndIf()
        else:
            if EUDIf()(self.cond(items[0])):
                t << 1
            if EUDElse()():
                self.short_circuit(items[1:], conj, t)
            EUDEndIf()

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
        if e["kind"] == "running":
            return self.running(e)
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
            self.latches[key] = RowCell(self.rows(), 0)  # initial: the latch
        latch = self.latches[key]
        get, put = latch.get, latch.set

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
        if k == "selected":
            # A slot of this computer's selection (B5): the unit's address, as Remastered's emulator gives it, and the
            # slot's uniqueness byte taken now, so a use later re-checks it like any kept unit.
            ptr = f_dwread(SELECTION + 4 * int(e["index"]))
            epd, uid = fresh(0), fresh(0)
            if EUDIf()(ptr >= 1):
                epd << (ptr - 0x58A364) // 4
                uid << (f_dwread_epd(epd + OFF_UID) & 0xFF00)
            EUDEndIf()
            return UnitRef(fresh(ptr), epd, uid)
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
        """The game's unit table in the order the game hands its places out — slot 0, then 1699 downwards, the units
        oldest first — stopping once it has met as many units as the game says are in use (0x6283F0): the places in use
        lie at the top, so the walk costs what the map holds, not the 1 700 places (about 135 ns a place, 229 µs a loop).
        `body(ref, next_, exit_)` for every unit the filter matches. Every test is one condition whose address moves on
        with the slot, so a slot that does not match costs a trigger or two. (Counted are the places with a sprite: never
        more than the game's count, and at most one fewer in a 12 000-frame game of four, when the walk goes to the end.)"""
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
        # Slot 0 first; past it the walk jumps to slot 1699 and goes down.
        remaining = fresh(f_dwread(RECORDS_IN_USE))
        DoActions([ptr.SetNumber(UNIT_TABLE), epd.SetNumber(EPD(UNIT_TABLE))] + [SetMemory(c + 4, SetTo, EPD(UNIT_TABLE) + off) for c, off in moving])
        for c, value in values:
            f_dwwrite_epd(EPD(c + 8), value)
        top_slot = UNIT_TABLE + UNIT_SIZE * (UNIT_SLOTS - 1)
        head, next_, exit_ = Forward(), Forward(), Forward()
        head << NextTrigger()
        EUDJumpIf(remaining == 0, exit_)
        EUDJumpIf(empty, next_)
        remaining -= 1
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
        down = Forward()
        EUDJumpIfNot(ptr == UNIT_TABLE, down)
        DoActions([SetMemory(c + 4, SetTo, EPD(top_slot) + off) for c, off in moving] + [ptr.SetNumber(top_slot), epd.SetNumber(EPD(top_slot))])
        EUDJump(head)
        down << NextTrigger()
        DoActions([SetMemory(c + 4, Add, (-(UNIT_SIZE // 4)) & U32) for c, _ in moving] + [ptr.SubtractNumber(UNIT_SIZE), epd.SubtractNumber(UNIT_SIZE // 4)])
        EUDJumpIfNot(ptr == UNIT_TABLE, head)
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
        if st.get("source"):
            self.event_loop(st["source"], st.get("filter", {}), st, body)
            return
        self.scan(st.get("filter", {}), st, body)

    def event_loop(self, source, flt, node, body):
        """The units of this frame's events pass, in the order it found them: `body(ref, next_, exit_)` for each the
        filter matches. One that came on and has gone since is passed over; one that died is the dying record, read as
        it died (its slot is not given to another unit before the next frame's dying pass)."""
        if EVENTS is None:
            raise Fail("trigscript: a loop over the events pass's units, and no pass%s" % where(node))
        cells, was, count = {"created": (EVENTS.made, None, EVENTS.made_n), "died": (EVENTS.gone, None, EVENTS.gone_n),
                             "killed": (EVENTS.gone, None, EVENTS.gone_n), "ordered": (EVENTS.turned, EVENTS.turned_was, EVENTS.turned_n),
                             "morphed": (EVENTS.changed, EVENTS.changed_was, EVENTS.changed_n)}[source]
        event = node.get("event") or {}
        i = fresh(0)
        head, next_, exit_ = Forward(), Forward(), Forward()
        head << NextTrigger()
        EUDJumpIf(i >= count, exit_)
        ptr, epd = f_cunitepdread_epd(EPD(cells) + i)
        if source in ("created", "ordered", "morphed"):
            # Gone since the pass: killed or removed by a program before this turn (its slot is still its own).
            EUDJumpIfNot([MemoryEPD(epd + OFF_SPRITE, AtLeast, 1), MemoryXEPD(epd + OFF_OWNER_ORDER, AtLeast, 0x100, 0xFF00)], next_)
        match = []
        if source == "killed":
            # Died in a fight: no hit points, and one of the eight players the last whose attack hurt it.
            match += [MemoryEPD(epd + OFF_HP, Exactly, 0), MemoryXEPD(epd + OFF_LAST_ATTACKER, AtMost, 7, 0xFF)]
            by = event.get("by")
            if by is not None:
                match.append(MemoryXEPD(epd + OFF_LAST_ATTACKER, Exactly, self.current() if by == CURRENT_PLAYER else int(by), 0xFF))
        if event.get("order") is not None:
            match.append(MemoryXEPD(epd + OFF_OWNER_ORDER, Exactly, int(event["order"]) << 8, 0xFF00))
        owner = flt.get("owner")
        if owner is not None:
            who = self.current() if owner == CURRENT_PLAYER else int(owner)
            match.append(MemoryXEPD(epd + OFF_OWNER_ORDER, Exactly, who, 0xFF))
        kind = flt.get("type")
        if kind is not None and kind < 228:
            match.append(MemoryXEPD(epd + OFF_TYPE, Exactly, int(kind), 0xFFFF))
        elif kind is not None and kind not in GROUP_BITS:
            raise Fail("trigscript: unknown unit type %r%s" % (kind, where(node)))
        if flt.get("at"):
            left, top, right, bottom = self.location_bounds(flt["at"])
            for v in (left, top):
                if EUDIf()(v >= 0x80000000):
                    v << 0
                EUDEndIf()
            match += [MemoryXEPD(epd + OFF_POS, AtLeast, left, 0xFFFF), MemoryXEPD(epd + OFF_POS, AtMost, right, 0xFFFF),
                      MemoryXEPD(epd + OFF_POS, AtLeast, f_bitlshift(top, 16), 0xFFFF0000), MemoryXEPD(epd + OFF_POS, AtMost, f_bitlshift(bottom, 16), 0xFFFF0000)]
        if match:
            EUDJumpIfNot(match, next_)
        if kind in GROUP_BITS:
            group = fresh(f_bread(UNITS_GROUP + f_maskread_epd(epd + OFF_TYPE, 0xFFFF)))
            EUDJumpIf((group & GROUP_BITS[kind]) == 0, next_)
        if node.get("was"):
            # What the unit was: the killer, or the order or the type the pass before found.
            self.declare(node["was"]).set(f_maskread_epd(epd + OFF_LAST_ATTACKER, 0xFF) if source == "killed" else was[i])
        body(UnitRef(ptr, epd, None), next_, exit_)
        next_ << NextTrigger()
        i += 1
        EUDJump(head)
        exit_ << NextTrigger()

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
                forget_counts()
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
        forget_counts()

    def select(self, st):
        """select() (B5): on the player's own computer the selection becomes the units still there — the twelve slots
        (0x6284B8), the panel told it changed (0x59723C, the flag Remastered's panel refresh tests) — and a Select
        command of their tags (place + 1, uniqueness byte << 11) goes to every computer, as MSQC puts a selection back."""
        p = self.one_player(st["player"], st)
        refs = [self.unit(u) for u in st["units"]]
        if EUDIf()(f_getuserplayerid() == p):
            n = fresh(0)
            for ref in refs:
                def keep(ref=ref):
                    f_dwwrite(SELECTION + n * 4, ref.ptr)
                    # The unit's tag: its place in the table from 1, its uniqueness byte above bit 11.
                    uid = as_var(ref.uid) if ref.uid is not None else f_dwread_epd(as_var(ref.epd) + OFF_UID) & 0xFF00
                    tag = f_div(as_var(ref.ptr) - 0x59CCA8, 336)[0] + 1 + uid * 8
                    f_wwrite(SELECT_COMMAND + 2 + n * 2, tag)
                    n.__iadd__(1)
                self.when_alive(ref, keep)
            if EUDIf()(n >= 1):
                i = fresh(n)
                if EUDWhile()(i <= 11):
                    f_dwwrite(SELECTION + i * 4, 0)
                    i.__iadd__(1)
                EUDEndWhile()
                DoActions(SetMemoryX(0x59723C, SetTo, 1, 0xFF))
                f_bwrite(SELECT_COMMAND + 1, n)
                QueueGameCommand(SELECT_COMMAND, n * 2 + 2)
            EUDEndIf()
        EUDEndIf()

    def center_location(self, st):
        """A location centred on a point, its size kept - or the size given, when nothing of the old one is read."""
        x, y = self.num(st["x"]), self.num(st["y"])
        base = EPD(MRGN + (int(st["location"]) - 1) * 20)
        size = st.get("size")
        if size:
            width, height = self.num(size["width"]), self.num(size["height"])
            if isinstance(width, int) and isinstance(height, int):
                nx, ny = x - width // 2, y - height // 2
            else:
                nx, ny = x - f_div(width, 2)[0], y - f_div(height, 2)[0]
            for i, v in enumerate((nx, ny, nx + width, ny + height)):
                f_dwwrite_epd(base + i, v)
            forget_counts()
            return
        left, top, right, bottom = [f_dwread_epd(base + i) for i in range(4)]
        width, height = right - left, bottom - top
        nx, ny = x - f_div(width, 2)[0], y - f_div(height, 2)[0]
        for i, v in enumerate((nx, ny, nx + width, ny + height)):
            f_dwwrite_epd(base + i, v)
        forget_counts()

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
            if self.has_id(st["value"]):
                f_wwrite(addr, self.text_id_of(st["value"]))
                return
            # A name that was made: over the string kept for this unit type, on every computer - a name is nobody's in particular.
            made = self.text(st["value"])
            sid = slot("the name of unit type %d" % int(c["index"]))
            texts()["show"](GetMapStringAddr(sid), made.addr)
            self.used(made)
            f_wwrite(addr, sid)
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
                self.put(s, st["init"], st["decl"]["kind"])
                self.step_place(st["decl"]["id"], st["init"])
        elif k == "assignText":
            self.put(self.var(st["target"], st), st["value"], "text")
        elif k == "storeText":
            self.store_text(st)
        elif k == "releaseText":
            block, i = self.array(st["block"], st), fresh(self.num(st["index"]))
            texts()["release"](as_var(block.get(i)))
            block.set(i, 0)
        elif k == "textLoop":
            self.text_loop(st, ctx)
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
            target = self.var(st["target"], st)
            if not self.assign_in_place(target, st):
                target.set(self.num(st["value"]))
            self.step_place(st["target"], st["value"])
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
            # `xs[i] = xs[i] + v` (`xs[i] += v`, a count): the game adds to the cell itself, nothing read.
            step = self.cell_step(st, a)
            place = self.place_of(st["index"], a)
            if step is not None:
                if place is not None:
                    v = self.num(step[1])
                    if step[0] == "-":
                        v = (-v) & U32 if isinstance(v, int) else 0 - v
                    cur = self.cursor_at(st["index"], a)
                    if cur is not None:
                        self.cursor_write(cur, a, st, v, Add)
                        return
                    a.set_placed(self.num(st["index"]), place, v, Add, self.bound_of(st["index"], st["array"]))
                    return
                a.add(self.num(st["index"]), self.num(step[1]), step[0])
                return
            value = (self.num if a.decl["kind"] == "number" else self.truth)(st["value"])
            if place is not None:
                cur = self.cursor_at(st["index"], a)
                if cur is not None:
                    self.cursor_write(cur, a, st, value, SetTo)
                    return
                a.set_placed(self.num(st["index"]), place, value, SetTo, self.bound_of(st["index"], st["array"]))
                return
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
                self.put(fn["result"], st["value"], fn["kind"])
            EUDJump(fn["end"])
            raise Leave()
        elif k == "sleep":
            self.sleep(st)
        elif k == "parallel":
            self.parallel(st)
        elif k == "start":
            self.start(st)
        elif k == "cancel":
            self.cancel(st)
        elif k == "action":
            self.action(st)
        elif k == "print":
            self.print_(st)
        elif k == "buildText":
            self.build_text(st)
        elif k == "centerLocation":
            self.center_location(st)
        elif k == "select":
            self.select(st)
        elif k == "syncSend":
            INPUT.send_sync(int(st["slot"]), self.one_player(st["player"], st), self.num(st["value"]))
        elif k == "call":
            self.call(st["call"])
        elif k == "block":
            self.block(st["body"], ctx)
        elif k == "try":
            self.try_(st, ctx)
        elif k == "throw":
            if not st.get("rethrow"):
                self.var("(error line)").set(int((st.get("at") or {}).get("line", 0)))
            EUDJump(self.handler(st))
            raise Leave()
        elif k == "uncaught":
            self.uncaught(st)
        elif k == "remark":
            pass
        elif k == "graph":
            self.graph(st, ctx)
        else:
            raise Fail("trigscript: unknown statement %r%s" % (k, where(st)))

    # ── the emitter's graphs (compiler/backend/graph.ts) ──
    GRAPH_COMPARE = {"atLeast": AtLeast, "atMost": AtMost, "exactly": Exactly}
    GRAPH_MODIFIER = {"set": SetTo, "add": Add, "subtract": Subtract}

    def graph(self, st, ctx):
        """A loop the emitter lowered (TrigScript 4, the backend: the emitter): its triggers made as they are, where the
        loop was. A dword of the graph is a game address, a variable's cell, a dword of the graph's own data (one in the
        map for each name), or a field of one of its triggers; the copies into it on the way in are routed reads of the
        variables, as any read is. A statement lowered twice (a `finally` copied to each way out) makes it twice."""
        g = st["graph"]
        if not hasattr(self, "graph_data"):
            self.graph_data = {}
        labels = {t["label"]: Forward() for t in g["triggers"]}
        end = Forward()
        labels["@end"] = end

        def element0(id_):
            """The EPD of the value of an array's first cell, and of the next cell's less it."""
            store = self.array(id_, st).store
            if is_varray(store):
                return EPD(unProxy(store) + VARRAY_VALUE), VARRAY_STRIDE // 4
            return store._epd, 1

        # The lists the graph reads where they are: laid out as the emitter thought, or nothing is made.
        for a in g.get("arrays", []):
            if element0(a["id"])[1] != a["stride"]:
                raise Fail("trigscript: the emitter read %s's cells %d EPD apart, which are %d%s" % (a["id"], a["stride"], element0(a["id"])[1], where(st)))

        def epd(d):
            if "game" in d:
                return EPD(d["game"])
            if "param" in d:
                return EPD(self.graph_function(d["param"])._fargs[d["index"]].getValueAddr())
            if "var" in d:
                return EPD(self.var(d["var"], st).get().getValueAddr())
            if "data" in d:
                if d["data"] not in self.graph_data:
                    self.graph_data[d["data"]] = Db(4)
                return EPD(self.graph_data[d["data"]])
            if "element" in d:
                return element0(d["element"])[0]
            base, f = labels[d["at"]], d["field"]
            if f == "next":
                return EPD(base + 4)
            if "cond" in f:
                return EPD(base + COND_VALUE + 20 * f["cond"] - (4 if f.get("part") == "player" else 0))
            return EPD(base + ACT_DEST - 16 + 32 * f["act"] + {"value": 20, "dest": 16, "modifier": 24}[f["part"]])

        def value(v):
            if isinstance(v, dict):
                return labels[v["label"]] if "label" in v else element0(v["epdOf"])[0] + v["plus"]
            return v

        def copy(id_, into):
            """The variable's cell into each dword (times its `scale`, plus its `add`): routed reads, a multiple worked
            out once for all the dwords that take it."""
            v = self.var(id_, st).get()
            times = {1: v}
            for e in into:
                k = int(e.get("scale", 1)) & U32
                if k not in times:
                    # (A power of two is a shift, a bit a trigger; another multiple eudplib's product by a constant.)
                    times[k] = fresh(0 - v) if k == U32 else shift_const(v, "<<", k.bit_length() - 1) if k & (k - 1) == 0 else fresh(v * k)
            for i in range(0, len(into), 16):
                group = []
                for e in into[i:i + 16]:
                    d = epd(e["into"] if "into" in e else e["dword"])
                    group.append((d, SetTo, times[int(e.get("scale", 1)) & U32]))
                    if e["add"]:
                        group.append((d, Add, value(e["add"])))
                SeqCompute(group)

        entries = {}
        for e in g["entries"]:
            entries.setdefault(e["from"], []).append(e)
        for id_, es in entries.items():
            copy(id_, es)
        origins = globals().get("_ORIGINS")
        for t in g["triggers"]:
            # (With the map of triggers on, each trigger says the line of the statement it comes from.)
            if origins is not None and t.get("at"):
                origins.append(_origin_of(t["at"]))
            try:
                self.graph_trigger(t, labels, epd, value, copy, ctx)
            finally:
                if origins is not None and t.get("at"):
                    origins.pop()
        end << NextTrigger()

    def graph_trigger(self, t, labels, epd, value, copy, ctx):
        """One trigger of a graph, or what stands in its place (a copy, an island, a call)."""
        if "copy" in t:
            # (In place of a trigger: the walk goes on to the one made after it.)
            labels[t["label"]] << NextTrigger()
            if t["copy"]["into"]:
                copy(t["copy"]["from"], t["copy"]["into"])
            return
        if "island" in t:
            # A statement the emitter left to this side, lowered here as anywhere (nothing in it leaves it).
            labels[t["label"]] << NextTrigger()
            self.statement(t["island"], ctx)
            return
        if "call" in t:
            # A fixed-point function, its parameters written by the triggers before: it goes back to the trigger
            # after this one, its result written where the graph says (an EPD, as a call's return is).
            f, back = self.graph_function(t["call"]), Forward()
            labels[t["label"]] << RawTrigger(nextptr=f._fstart, actions=[SetMemory(f._nptr, SetTo, back), SetMemoryEPD(EPD(f._frets[0].getDestAddr()), SetTo, epd(t["call"]["into"]))])
            back << NextTrigger()
            return
        conds = [MemoryXEPD(epd(c["dword"]), self.GRAPH_COMPARE[c["compare"]], c["value"], c["mask"]) if "mask" in c else MemoryEPD(epd(c["dword"]), self.GRAPH_COMPARE[c["compare"]], c["value"]) for c in t["conds"]]
        acts = [SetMemoryXEPD(epd(a["dword"]), self.GRAPH_MODIFIER[a["modifier"]], value(a["value"]), a["mask"]) if "mask" in a else SetMemoryEPD(epd(a["dword"]), self.GRAPH_MODIFIER[a["modifier"]], value(a["value"])) for a in t["acts"]]
        if "next" in t:
            labels[t["label"]] << RawTrigger(nextptr=labels[t["next"]], conditions=conds, actions=acts)
        else:
            labels[t["label"]] << RawTrigger(conditions=conds, actions=acts)

    def graph_function(self, spec):
        """The fixed-point function a graph calls (compiler/backend/graph.ts, FixedFn), its body made."""
        fn, c = spec["fn"], int(spec.get("c", 0))
        if fn in ("fmul_vars", "fdiv_vars"):
            f = fixed_vars()[fn]
        elif fn == "fdiv_by":
            if (c, None) not in _CONST_FDIV:
                _CONST_FDIV[(c, None)] = make_const_fdiv(c, None)
            f = _CONST_FDIV[(c, None)]
        else:
            name = "fmul" if fn == "fmul_by" else "fdiv"
            if (name, c, None) not in _FIXED_BY_CONST:
                _FIXED_BY_CONST[(name, c, None)] = (make_fmul_by if name == "fmul" else make_fdiv_by_const)(c, 31)
            f = _FIXED_BY_CONST[(name, c, None)]
        if f._fstart is None:
            f._create_func_body()
        return f

    def try_(self, st, ctx):
        """The body with its catch as the place a throw goes to; the catch after it, reached only that way."""
        caught, end = Forward(), Forward()
        self.handlers.append(caught)
        try:
            reached = self.straight(st["body"], ctx)
        finally:
            self.handlers.pop()
        if reached:
            EUDJump(end)
        caught << NextTrigger()
        self.straight(st["catch"], ctx)
        end << NextTrigger()

    def handler(self, node):
        """Where an error goes from here: the nearest catch, or the end of the called function the lowering is in."""
        if not self.handlers:
            raise Fail("trigscript: an error with nothing to go to%s" % where(node))
        return self.handlers[-1]

    def uncaught(self, st):
        """The error in flight, said in red where the player sees the game's own faults, and given up."""
        e = self.errors
        at = st.get("at")
        self.print_({"kind": "print", "to": CURRENT_PLAYER, "position": "chat", "at": at, "label": st.get("label", ""), "parts": [
            {"kind": "text", "text": "\x06TrigScript: uncaught "},
            {"kind": "value", "text": {"kind": "textOf", "array": e["names"], "index": {"kind": "var", "id": e["thrown"]}, "at": at}},
            {"kind": "text", "text": ": "},
            {"kind": "value", "text": {"kind": "textVar", "id": e["message"]}},
            {"kind": "text", "text": ", line "},
            {"kind": "number", "expr": {"kind": "var", "id": "(error line)"}},
            {"kind": "text", "text": "."},
        ]})
        self.var(e["thrown"], st).set(0)

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

    def unchecked_loop(self, st):
        """For a loop `for (…; i < xs.length; …)` over a growing array at a counter, whose body changes no array's length
        and stores nothing into i: the arrays its body reads and writes at i, unchecked — xs itself (the condition has
        just compared), each other one under a flag set on the way in when it is at least as long as xs. None when
        the loop is not of that shape."""
        c = st.get("cond")
        if not isinstance(c, dict) or c.get("kind") != "compare" or c.get("op") != "<":
            return None
        left, right = c.get("left", {}), c.get("right", {})
        if left.get("kind") != "var" or left.get("id") not in self.places or right.get("kind") != "length":
            return None
        own = self.arrays.get(right.get("array"))
        if type(own) is not ListStorage or not own.placeable():
            return None
        lists = {id_ for id_, a in self.arrays.items() if isinstance(a, ListStorage)}
        if not lengths_fixed_in(st["body"], left["id"], lists):
            return None
        out = {right["array"]: True}
        for id_ in lists_at(st["body"], left["id"], lists):
            a = self.arrays[id_]
            if id_ in out or type(a) is not ListStorage or not a.placeable():
                continue
            flag = EUDVariable()
            flag << 0
            if EUDIf()(as_var(a.field("len")) >= as_var(own.field("len"))):
                flag << 1
            EUDEndIf()
            out[id_] = flag
        return left["id"], out

    def for_(self, st, ctx):
        unchecked = self.unchecked_loop(st)
        cursor = self.cursors_for(st)
        flags = [] if unchecked is None else [f for f in unchecked[1].values() if f is not True]
        if unchecked is not None and cursor is not None and flags and len(flags) <= 16:
            # Unswitched: every other array the body reads at the counter found as long as the loop's own on the way in
            # (the usual case: a record's fields grow together) runs a copy of the loop that knows it, with no flag
            # tested at each access; otherwise the copy that tests them.
            self._copies = getattr(self, "_copies", 0) + 1
            try:
                if EUDIf()([f >= 1 for f in flags]):
                    self.for_copy(st, ctx, (unchecked[0], {k: True for k in unchecked[1]}), True)
                if EUDElse()():
                    self.for_copy(st, ctx, unchecked, True)
                EUDEndIf()
            finally:
                self._copies -= 1
            return
        self.for_copy(st, ctx, unchecked, cursor is not None)

    def for_copy(self, st, ctx, unchecked, cursors):
        """One copy of a `for` loop: `unchecked` what `unchecked_loop` found (or the same with every flag known true),
        `cursors` whether its accesses at the counter go through registers (`Cursors`). An unswitched loop has two, each
        a region of its own for static routing, with a way in of its own."""
        head, update, exit_ = Forward(), Forward(), Forward()
        region = None
        if ROUTE.enabled and ROUTE.on and ROUTE.stack and ROUTE.stack[-1].kind == "loop" and getattr(self, "_copies", 0):
            region = _Region("loop")
            region.entry, region.after = Forward(), Forward()
            SetNextTrigger(region.entry)
            region.after << NextTrigger()
            ROUTE.loops.append(region)
        cursor = self.cursors_for(st) if cursors else None
        if cursor is not None:
            # The way in, which the registers' setting goes in front of once the body has said which there are.
            pre, pre_after = Forward(), Forward()
            SetNextTrigger(pre)
            pre_after << NextTrigger()
            self.cursors[cursor.counter] = cursor
        if region is not None:
            ROUTE.stack.append(region)
        try:
            if unchecked is not None:
                was = self.inside.get(unchecked[0])
                self.inside[unchecked[0]] = unchecked[1]
                try:
                    self.for_body(st, ctx, head, update, exit_, cursor)
                finally:
                    if was is None:
                        self.inside.pop(unchecked[0], None)
                    else:
                        self.inside[unchecked[0]] = was
            else:
                self.for_body(st, ctx, head, update, exit_, cursor)
        finally:
            if region is not None:
                ROUTE.stack.pop()
            if cursor is not None:
                del self.cursors[cursor.counter]
        if cursor is not None:
            # Made out of the way of the code being made (what is pending is put aside and handed on after), and as
            # code in front of the loop, not in it.
            outer = ROUTE.stack.pop() if ROUTE.enabled and ROUTE.stack and ROUTE.stack[-1].kind == "loop" else None
            held = Forward()
            SetNextTrigger(held)
            if cursor.reads or cursor.writes:
                pre << NextTrigger()
                cursor.init()
                SetNextTrigger(pre_after)
            else:
                pre << pre_after
            held << NextTrigger()
            if outer is not None:
                ROUTE.stack.append(outer)

    def cursors_for(self, st):
        """`Cursors` for a loop `for (…; …; i = i ± c)` at a counter with a place, when that store is its whole update and
        its body is as `lengths_fixed_in` wants it (no wait, no call, no length changed, nothing stored into i)."""
        upd = st.get("update") or []
        if len(upd) != 1 or upd[0].get("kind") != "assign":
            return None
        i = upd[0].get("target")
        if i not in self.places:
            return None
        step = counter_step(upd[0].get("value"), i)
        if step is None or step[0] != "add":
            return None
        lists = {a["id"] for a in self.p.get("arrays", []) if a.get("dynamic") or a.get("through")}
        if not lengths_fixed_in(st["body"], i, lists):
            return None
        return Cursors(i, self.places[i], step[1])

    def cursor_at(self, index, a):
        """The loop's `Cursors` an access at `index` of `a` can go through, or None: the index is a cursor loop's counter,
        and the array keeps its block where it is — a fixed one, or a growing one the loop found at least as long as its
        own (`inside`: known, or a flag set on the way in)."""
        if index.get("kind") != "var":
            return None
        cur = self.cursors.get(index.get("id"))
        if cur is None or self.places.get(cur.counter) is not cur.place:
            return None
        if type(a) is ArrayStorage and a.placeable():
            return cur
        if type(a) is ListStorage and a.placeable() and self.bound_of(index, a.decl["id"]) is not None:
            return cur
        return None

    def cursor_read(self, cur, a, e):
        # (A read that always happens fills its temporary whole: it need not start from 0, as `fresh` does.)
        if type(a) is ArrayStorage:
            r = rng(e["index"])
            if r is not None and r[0] >= 0 and r[1] <= a.length - 1:
                out = EUDVariable()
                cur.read(unProxy(a.store), out)  # (inside, the ranges say)
                return out
            out = fresh(0)
            if EUDIf()(as_var(self.num(e["index"])) <= a.length - 1):
                cur.read(unProxy(a.store), out)
            EUDEndIf()
            return out
        bound = self.bound_of(e["index"], e["array"])
        if bound is True:
            out = EUDVariable()
            cur.read(a.base[0], out)
            return out
        out = fresh(0)
        if EUDIf()(bound >= 1):
            cur.read(a.base[0], out)
        if EUDElseIf()(as_var(self.num(e["index"])) < as_var(a.field("len"))):
            varray_read(a.base[0], cur.place, out)
        EUDEndIf()
        return out

    def cursor_write(self, cur, a, st, value, modifier):
        if a.bits and modifier == SetTo:
            value = saturate(value, a.bits)
        v = fresh(value) if modifier == SetTo and not isinstance(value, int) else value
        if type(a) is ArrayStorage:
            r = rng(st["index"])
            if r is not None and r[0] >= 0 and r[1] <= a.length - 1:
                cur.write(a.store._epd + VARRAY_VALUE // 4, v, modifier)
            else:
                if EUDIf()(as_var(self.num(st["index"])) <= a.length - 1):
                    cur.write(a.store._epd + VARRAY_VALUE // 4, v, modifier)
                EUDEndIf()
            return
        bound = self.bound_of(st["index"], st["array"])
        if bound is True:
            cur.write(a.base[1], v, modifier)
            return
        i, n = as_var(self.num(st["index"])), as_var(a.field("len"))
        if EUDIf()(bound >= 1):
            cur.write(a.base[1], v, modifier)
        if EUDElseIf()(i < n):
            varray_write(a.base[1], cur.place, v, modifier)
        if EUDElseIf()(i == n):
            a.push(v)
        EUDEndIf()

    def for_body(self, st, ctx, head, update, exit_, cursor=None):
        head << NextTrigger()
        if st.get("cond") is not None:
            EUDJumpIfNot(self.cond(st["cond"]), exit_)
        self.straight(st["body"], dict(ctx, **{"break": exit_, "continue": update}))
        update << NextTrigger()
        if cursor is not None and self.cursor_update(st, cursor):
            EUDJump(head)
        elif self.straight(st["update"], ctx):
            if cursor is not None:
                cursor.advance()
            EUDJump(head)
        exit_ << NextTrigger()

    def cursor_update(self, st, cursor):
        """A cursor loop's update `i = i ± c` of a variable of the program's own: the counter, its place and every
        register moved on in one trigger, where they were three. False when the counter is kept otherwise (a row)."""
        target = self.vars.get(cursor.counter)
        if not isinstance(target, Storage) or target.rowed or target.bits:
            return False
        c = cursor.step
        acts = [target.store.AddNumber(c & U32), cursor.place.bytes.AddNumber((VARRAY_STRIDE * c) & U32), cursor.place.dwords.AddNumber((VARRAY_STRIDE // 4 * c) & U32)]
        acts += [SetMemory(t + 4, Add, (VARRAY_STRIDE * c) & U32) for t, _ in cursor.reads]
        acts += [SetMemory(act + 16, Add, (VARRAY_STRIDE // 4 * c) & U32) for act, _ in cursor.writes]
        DoActions(acts)
        return True

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
        if self.in_function:
            raise Fail("trigscript: sleep inside a function that is called%s" % where(st))
        if st.get("cycles") is not None:
            frames = int(st["cycles"])
        else:
            frames = max(1, int(round(float(st.get("ms", 0)) * FRAMES_PER_SECOND / 1000)))
        co = self.co
        index, resume = co.resume_point()
        # The frame after this one is one frame later: sleep(frames(1)) goes on in the next frame, as the
        # simulator has it. (Until 3.4 the wait was one frame longer, so a loop sleeping a frame ran every other.)
        co.park(index, frames - 1)
        resume << NextTrigger()

    def parallel(self, st):
        """Promise.all / race: each branch a coroutine of its own, started here and run from here, in order, every frame
        the program waits at this statement; the program goes on when every branch has ended (all) or the first has
        (race, which leaves the others where they are). The program waits here through a place of its own to go on
        from, which this same statement is: the first frame falls into it, the later ones jump to it."""
        if self.in_function:
            raise Fail("trigscript: await inside a function that is called%s" % where(st))
        parent = self.co
        kids = [Coroutine(self, self.rows()) for _ in st["branches"]]
        for k in kids:
            k.set_state(0)
            k.set_wait(0)
        index, again = parent.resume_point()
        again << NextTrigger()
        after = Forward()
        for k, body in zip(kids, st["branches"]):
            skip = Forward()
            EUDJumpIf(as_var(k.get_state()) == DONE, skip)
            self.coroutine(k, body)
            if st["mode"] == "race":
                EUDJumpIfNot(as_var(k.get_state()) == DONE, skip)
                for other in kids:
                    if other is not k:
                        other.set_state(DONE)
                EUDJump(after)
            skip << NextTrigger()
        if st["mode"] == "all":
            EUDJumpIf([as_var(k.get_state()) == DONE for k in kids], after)
        parent.park(index, 0)
        after << NextTrigger()

    def action(self, st):
        r = st["record"]
        fields = dict(locid1=r["location"], strid=string_of(r["text"]), wavid=string_of(r["wav"]), time=r["time"], player1=r["player"], player2=r["target"], unitid=r["unitId"], acttype=r["type"], amount=r["modifier"], flags=r["flags"])
        shown = None
        if st.get("text") is not None:
            if self.has_id(st["text"]):
                fields["strid"] = self.text_id_of(st["text"])
            else:
                kind = SLOT_OF_ACTION.get(int(r["type"]))
                if kind is None:
                    raise Fail("trigscript: this action's text cannot be one that is made%s" % where(st))
                # Over the string kept for this kind of field - on the computer of the player the action is for, which is
                # the one the program is running as: the game reads the string again whenever it draws, and another
                # player's text must not be there when it does. Nothing of the script can read the string back.
                shown = self.text(st["text"])
                if EUDIf()(IsUserCP()):
                    texts()["show"](GetMapStringAddr(slot(kind)), shown.addr)
                EUDEndIf()
                self.used(shown)
                fields["strid"] = slot(kind)
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
        moves = int(r["type"]) in MOVES_UNITS
        if count is None:
            DoActions(Action(**fields))
            if moves:
                forget_counts()
            return
        fields["amount"] = 1
        for _ in EUDLoopRange(0, count):
            DoActions(Action(**fields))
        if moves:
            forget_counts()

    def print_(self, st):
        """Text with values in it: every value first, then the text, shown only on the screen of the player it is for."""
        args = []
        temps = []
        for part in st["parts"]:
            k = part["kind"]
            if k == "text":
                args.append(part["text"])
            elif k == "value":
                v = self.text(part["text"])
                temps.append(v)
                args.append(ptr2s(v.addr))
            elif k == "number" and part.get("fixed"):
                args.extend(self.fixed_pieces(self.num(part["expr"])))
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
            elif k == "char":
                args.append(self.char(part["expr"]))
            else:
                raise Fail("trigscript: unknown text part %r%s" % (k, where(st)))
        if not args:
            return
        # eudplib prints for the current player, and only on that player's own computer.
        show = (lambda: f_eprintln(*args)) if st.get("position") == "center" else (lambda: GetGlobalStringBuffer().print(*args))
        to = int(st.get("to", CURRENT_PLAYER))
        if to == CURRENT_PLAYER:
            show()
            self.used(*temps)
            return
        for p in group_slots(to, st):
            f_setcurpl(p)
            show()
        f_setcurpl(self.current())
        self.used(*temps)

    # ── texts ──
    def has_id(self, e):
        """Whether a text is one of the built map's table whatever happens in the game (compiler/ir.ts#textHasId)."""
        k = e["kind"]
        if k in ("text", "textOf"):
            return True
        if k == "textVar":
            return not isinstance(self.var(e["id"], e), TextStorage)
        if k == "textTernary":
            return self.has_id(e["whenTrue"]) and self.has_id(e["whenFalse"])
        return False

    def text_id_of(self, e):
        """The id of a text that has one: an int, or a variable."""
        k = e["kind"]
        if k == "text":
            return text_id(e["text"])
        if k == "textVar":
            return self.var(e["id"], e).get()
        if k == "textOf":
            return self.array(e["array"], e).get(self.num(e["index"]))
        if k == "textTernary":
            t = EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                t << self.text_id_of(e["whenTrue"])
            if EUDElse()():
                t << self.text_id_of(e["whenFalse"])
            EUDEndIf()
            return t
        raise Fail("trigscript: this text has no id%s" % where(e))

    def used(self, *values):
        """Values that have been used: a block that was the value's own goes back to the heap."""
        for v in values:
            if v.taken and not isinstance(v.block, int):
                texts()["release"](v.block)

    def texts_of(self, exprs):
        """Several texts in the order they are written. A variable's text is only looked at - unless working a later
        one out runs a call, which may give that variable another text and its block back to the heap: then it is a copy."""
        out = []
        for i, e in enumerate(exprs):
            v = self.text(e)
            if not v.taken and any(has_call(x) for x in exprs[i + 1:]):
                v = self.own(v)
            out.append(v)
        return out

    def own(self, v):
        """A value as something to keep: its own block as it is, a copy of a variable's."""
        if v.taken:
            return v
        addr, block, length = texts()["copy"](v.addr, v.block, v.length())
        return TextVal(addr, block, length, True)

    def store_text(self, st):
        """A text into cell i of three arrays (a row's): worked out first - it may be made from what the cells hold -
        then the block they held goes back, then they take the text, a copy of one that was only looked at."""
        v = self.own(self.text(st["value"]))
        addr, block, length = fresh(v.addr), fresh(v.block), fresh(v.length())
        i = fresh(self.num(st["index"]))
        held = self.array(st["block"], st)
        texts()["release"](as_var(held.get(i)))
        self.array(st["addr"], st).set(i, addr)
        held.set(i, block)
        self.array(st["chars"], st).set(i, length)

    def put(self, storage, e, kind):
        """A value into a variable. A text is worked out first - it may be made from what the variable holds - and only then does the block the variable held go back."""
        if kind != "text":
            storage.set(self.value(e, kind))
            return
        if not isinstance(storage, TextStorage):
            storage.set(self.text_id_of(e))
            return
        v = self.own(self.text(e))
        addr, block, length = fresh(v.addr), fresh(v.block), fresh(v.length())
        texts()["release"](storage.cell(storage.block))
        storage.write(addr, block, length)

    def char(self, e):
        """One byte from a number, as something to print: a colour code chosen when the map is played; 0 is nothing."""
        v = self.num(e)
        if isinstance(v, int):
            return chr(v & 0xFF) if v & 0xFF else ""
        one = Db(4)
        f_bwrite(one, v & 0xFF)
        return ptr2s(one)

    def written(self, parts, st):
        """The parts of a text in the scratch, and where it ends. Every value is worked out first, since working one
        out may use the scratch itself; then the parts are written a group at a time, a group being what cannot
        come to more than a text holds, so that checking where the writing has got to between groups keeps it inside."""
        T = texts()
        items, temps = self.items(parts, st)
        pos = fresh(T["scratch"])
        f_bwrite(pos, 0)
        self.write_items(items, pos, T["scratch"] + TEXT_BYTES, lambda at, value: T["append"](at, value.addr), True)
        return pos, temps

    def build_text(self, st):
        """Parts written onto the end of a buffer (emptied first on `reset`): a text put together a piece at a time."""
        data, pos = buffer(st["buffer"])
        B = builds()
        items, temps = self.items(st["parts"], st)
        if st.get("reset"):
            pos << data
            f_bwrite(data, 0)
        last = data + BUILD_BYTES + TEXT_BYTES
        self.write_items(items, pos, data + BUILD_BYTES, lambda at, value: B["append"](at, value.addr, last), False)
        pos << B["cut"](pos, data + BUILD_BYTES)
        self.used(*temps)

    def items(self, parts, st):
        """The parts of a text as what f_dbstr_print takes, each with the most bytes it can come to; a value of the
        program as itself, to be copied in. Every value is worked out here, before anything is written."""
        items, temps = [], []
        for part in parts:
            k = part["kind"]
            if k == "text":
                data = part["text"].encode("utf-8")[:TEXT_BYTES].decode("utf-8", "ignore")
                items.append(([data], len(data.encode("utf-8")), None))
            elif k == "number" and part.get("fixed"):
                pieces = self.fixed_pieces(self.num(part["expr"]))
                items.append((pieces, 11 if len(pieces) > 1 else len(pieces[0]), None))
            elif k == "number":
                v = self.num(part["expr"])
                if isinstance(v, int):
                    data = str(v if part.get("unsigned") else signed(v))
                    items.append(([data], len(data), None))
                elif part.get("unsigned"):
                    items.append(([fresh(v)], 10, None))
                else:
                    sign, size = fresh(NO_SIGN), fresh(v)
                    if EUDIf()(size >= SIGN):
                        sign << MINUS_SIGN
                        size << 0 - size
                    EUDEndIf()
                    items.append(([ptr2s(sign), size], 11, None))
            elif k == "name":
                items.append(([PName(self.one_player(part["player"], st))], 25, None))
            elif k == "color":
                items.append(([PColor(self.one_player(part["player"], st))], 1, None))
            elif k == "value":
                v = self.text(part["text"])
                if not v.taken and has_call(parts[parts.index(part) + 1:]):
                    v = self.own(v)
                temps.append(v)
                items.append((None, TEXT_BYTES, v))
            elif k == "char":
                c = self.char(part["expr"])
                if c != "":
                    items.append(([c], 1, None))
            else:
                raise Fail("trigscript: unknown text part %r%s" % (k, where(st)))
        return items, temps

    def write_items(self, items, pos, end, append, first_free):
        """Items written at pos, which moves to where the text ends: a group at a time, a group being what cannot come
        to more than a text holds, so that checking pos against `end` between groups keeps the writing inside the room
        behind it. `first_free`: pos starts at the beginning, so the first group needs no check."""
        group, room, first = [], 0, [first_free]

        def flush():
            if not group:
                return
            if first[0]:
                pos << f_dbstr_print(pos, *group)
            else:
                if EUDIf()(pos <= end):
                    pos << f_dbstr_print(pos, *group)
                EUDEndIf()
            first[0] = False
            del group[:]

        for args, size, value in items:
            if value is not None:
                flush()
                room = 0
                if first[0]:
                    pos << append(pos, value)
                else:
                    if EUDIf()(pos <= end):
                        pos << append(pos, value)
                    EUDEndIf()
                first[0] = False
                continue
            if room + size > TEXT_BYTES + 1:
                flush()
                room = 0
            group.extend(args)
            room += size
        flush()

    def text(self, e):
        """A text: where it is, its block, its length (TextVal)."""
        T = texts()
        k = e["kind"]
        if k == "text":
            return TextVal(fresh(GetMapStringAddr(e["text"]) if e["text"] else T["empty"]), 0, len(e["text"]), True)
        if k == "textVar" and isinstance(self.var(e["id"], e), TextStorage):
            return self.var(e["id"], e).get()
        if k == "textAt":
            # Cells that were never given a text are 0: the empty one, as a variable's are.
            i = fresh(self.num(e["index"]))
            addr = fresh(self.array(e["addr"], e).get(i))
            if EUDIf()(addr == 0):
                addr << T["empty"]
            EUDEndIf()
            return TextVal(addr, fresh(self.array(e["block"], e).get(i)), fresh(self.array(e["chars"], e).get(i)), False)
        if self.has_id(e):
            return TextVal(T["address"](as_var(self.text_id_of(e))), 0, None, True)
        if k == "built":
            # Only looked at: what keeps it takes a copy, since the buffer is built again next time.
            return TextVal(fresh(buffer(e["buffer"])[0]), 0, None, False)
        if k == "template":
            pos, temps = self.written(e["parts"], e)
            addr, block, length = T["make"](pos)
            self.used(*temps)
            return TextVal(addr, block, length, True)
        if k == "textTernary":
            addr, block, length = EUDVariable(), EUDVariable(), EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                v = self.own(self.text(e["whenTrue"]))
                addr << v.addr
                block << v.block
                length << v.length()
            if EUDElse()():
                v = self.own(self.text(e["whenFalse"]))
                addr << v.addr
                block << v.block
                length << v.length()
            EUDEndIf()
            return TextVal(addr, block, length, True)
        if k == "textSlice":
            of = self.text(e["of"])
            start = self.num(e["start"]) if e.get("start") is not None else 0
            end = self.num(e["end"]) if e.get("end") is not None else 0x7FFFFFFF
            addr, block, length = T["slice"](of.addr, start, end)
            self.used(of)
            return TextVal(addr, block, length, True)
        if k == "textPad":
            of, fill = self.texts_of([e["of"], e["with"]])
            width = self.num(e["width"])
            addr, block, length = T["pad"](of.addr, of.length(), width, fill.addr, 1 if e["side"] == "start" else 0)
            self.used(of, fill)
            return TextVal(addr, block, length, True)
        if k == "textRepeat":
            of = self.text(e["of"])
            addr, block, length = T["repeat"](of.addr, self.num(e["count"]))
            self.used(of)
            return TextVal(addr, block, length, True)
        if k == "textCall":
            self.call(e["call"])
            result = e["call"].get("result")
            if result is None:
                return TextVal(fresh(T["empty"]), 0, 0, True)
            return self.var(result["decl"]["id"], e).take_out()
        raise Fail("trigscript: unknown text %r%s" % (k, where(e)))

    def text_number(self, e):
        T = texts()
        k = e["kind"]
        if k == "textIndexOf":
            of, find = self.texts_of([e["of"], e["find"]])
            start = self.num(e["from"]) if e.get("from") is not None else 0
            out = T["find"](of.addr, find.addr, start)
            self.used(of, find)
            return out
        of = self.text(e["of"])
        if k == "textLength":
            n = of.length()
            out = n if isinstance(n, int) else fresh(n)
            self.used(of)
            return out
        out = T["code"](of.addr, self.num(e["index"]))
        self.used(of)
        return out

    def text_truth(self, e):
        """A comparison of two texts, or a test of one, as 0 / 1."""
        T = texts()
        t = fresh(0)
        if e["kind"] == "textTest":
            of, find = self.texts_of([e["of"], e["find"]])
            if e["test"] == "startsWith":
                t << T["starts"](of.addr, find.addr)
            elif e["test"] == "endsWith":
                t << T["ends"](of.addr, find.addr)
            else:
                if EUDIfNot()(T["find"](of.addr, find.addr, 0) == 0xFFFFFFFF):
                    t << 1
                EUDEndIf()
            self.used(of, find)
            return t
        op = e["op"]
        if op in ("==", "!=") and self.has_id(e["left"]) and self.has_id(e["right"]):
            # Two texts of the table: the same text is the same id.
            a, b = self.text_id_of(e["left"]), self.text_id_of(e["right"])
            if isinstance(a, int) and isinstance(b, int):
                return 1 if (a == b) == (op == "==") else 0
            if EUDIf()(as_var(a) == b):
                t << 1
            EUDEndIf()
        else:
            a, b = self.texts_of([e["left"], e["right"]])
            # The difference of the first bytes that differ, as a number of 32 bits: 0, below zero, or above.
            d = f_strcmp(a.addr, b.addr)
            self.used(a, b)
            if op in ("==", "!="):
                if EUDIf()(d == 0):
                    t << 1
                EUDEndIf()
            else:
                below = (lambda: d >= SIGN)
                if op in ("<", ">="):
                    if EUDIf()(below()):
                        t << 1
                    EUDEndIf()
                else:  # "<=" and ">": whether it is not above
                    if EUDIf()(EUDOr(d == 0, below())):
                        t << 1
                    EUDEndIf()
                return flipped(t) if op in (">=", ">") else t
        return flipped(t) if op == "!=" else t

    def text_loop(self, st, ctx):
        """`for (const ch of s)`: the text walked once, a character a turn, each a made text of its own."""
        T = texts()
        turn = self.declare(st["decl"])
        over = self.own(self.text(st["of"]))
        held = fresh(over.block)
        at = fresh(over.addr)
        head, done = Forward(), Forward()
        inner = dict(ctx)
        inner["break"], inner["continue"] = done, head
        leave = None
        if ctx.get("fn") is not None:
            # A return inside the loop leaves through here, so that the text the loop holds goes back first.
            leave = Forward()
            inner["fn"] = dict(ctx["fn"], end=leave)
        head << NextTrigger()
        n = T["size"](at)
        EUDJumpIf(n == 0, done)
        f_memcpy(T["scratch"], at, n)
        f_bwrite(T["scratch"] + n, 0)
        addr, block, length = T["make"](T["scratch"] + n)
        T["release"](turn.cell(turn.block))
        turn.write(addr, block, length)
        at += n
        # An error out of the body leaves through here too (B4), so that the text the loop holds goes back first.
        unwind = Forward() if self.handlers else None
        if unwind is not None:
            outer_handler = self.handlers[-1]
            self.handlers.append(unwind)
        try:
            if self.straight(st["body"], inner):
                EUDJump(head)
        finally:
            if unwind is not None:
                self.handlers.pop()
        done << NextTrigger()
        T["release"](held)
        if unwind is not None:
            past = Forward()
            EUDJump(past)
            unwind << NextTrigger()
            T["release"](held)
            EUDJump(outer_handler)
            past << NextTrigger()
        if leave is not None:
            after = Forward()
            EUDJump(after)
            leave << NextTrigger()
            T["release"](held)
            EUDJump(ctx["fn"]["end"])
            after << NextTrigger()

    def value(self, e, kind):
        """An expression as what a variable of `kind` holds."""
        return self.num(e) if kind == "number" else self.unit(e) if kind == "unit" else self.truth(e)

    def function(self, id_, node):
        """A called function: its parameters' cells, its result's, and its one body — an EUDFunc of no
        arguments, since the cells are the program's own (a row a player, as any variable is)."""
        made = self.made.get(id_)
        if made is not None:
            return made
        f = self.functions.get(id_)
        if f is None:
            raise Fail("trigscript: unknown function %r%s" % (id_, where(node)))
        params = [self.declare(d) for d in f["params"]]
        kind = f["result"]["kind"] if f.get("result") else "void"
        result = self.declare(f["result"]["decl"]) if f.get("result") else None
        lowering = self
        if f.get("recursive"):
            return self.recursive_function(id_, f, params, kind, result)

        @EUDFunc
        def body():
            # A text result keeps what it held until `return` puts the next one in it, which is when that block goes back.
            if result is not None and kind != "text":
                result.set(NO_UNIT if kind == "unit" else 0)
            end = Forward()
            lowering.in_function += 1
            outer = lowering.handlers
            lowering.handlers = [end]
            try:
                lowering.straight(f["body"], {"fn": {"result": result, "kind": kind, "end": end}})
            finally:
                lowering.in_function -= 1
                lowering.handlers = outer
            end << NextTrigger()

        made = self.made[id_] = (body, params, result)
        return made

    def recursive_function(self, id_, f, params, kind, result):
        """A function that calls itself. eudplib's EUDFunc keeps one return address and is not there to be called
        until its body is whole, so this one is triggers of our own: the body in a scope apart, ended by a trigger
        whose next-trigger field is the return address - a cell a call writes, and a frame keeps. It is on record
        before its body is lowered, so a call of it met in that body finds it."""
        start, tail = Forward(), Forward()
        # The return address a second time, in a variable: a frame keeps it from there, since reading a cell of
        # the game's memory back costs some thirty triggers and writing a variable out costs two.
        back = EUDVariable()

        def body():
            ROUTE.unknown_call()
            after = Forward()
            DoActions([SetNextPtr(tail, after), back.SetNumber(after)])
            EUDJump(start)
            after << NextTrigger()

        made = self.made[id_] = (body, params, result)
        entry = {"f": f, "tail": tail, "back": back}
        PushTriggerScope()
        start << NextTrigger()
        if result is not None and kind != "text":
            result.set(NO_UNIT if kind == "unit" else 0)
        end = Forward()
        self.in_function += 1
        self.within.append(entry)
        outer = self.handlers
        self.handlers = [end]
        try:
            self.straight(f["body"], {"fn": {"result": result, "kind": kind, "end": end}})
        finally:
            self.within.pop()
            self.in_function -= 1
            self.handlers = outer
        end << NextTrigger()
        tail << RawTrigger()
        PopTriggerScope()
        return made

    def saved_cells(self, saves, node):
        """What a frame keeps, as (read, write) pairs a cell: the variables, a unit three cells, an array's handle four."""
        pairs = []
        for id_ in saves.get("vars", []):
            s = self.vars.get(id_)
            if s is None:
                # Declared further down the body: it has no cell yet, and the declaration that makes it sets it.
                continue
            if isinstance(s, UnitStorage):
                for cell in (s.ptr, s.epd, s.uid):
                    pairs.append(self.cell_pair(cell, s.player_of if s.rowed else None))
            elif isinstance(s, TextStorage):
                for cell in (s.addr, s.block, s.len):
                    pairs.append(self.cell_pair(cell, s.player_of if s.rowed else None))
            elif isinstance(s, Storage):
                pairs.append(self.cell_pair(s.store, s.player_of if s.rowed else None))
        for id_ in saves.get("arrays", []):
            a = self.array(id_, node)
            if isinstance(a, ListStorage):
                for name in HANDLE:
                    pairs.append(self.cell_pair(a.handle[name], a.player_of if a.rowed else None))
        return pairs

    def saved_texts(self, saves):
        """The made texts among what a frame keeps: each owns a block, which the frame keeps for it."""
        return [s for s in (self.vars.get(id_) for id_ in saves.get("vars", [])) if isinstance(s, TextStorage)]

    def cell_pair(self, cell, rows):
        if rows:
            return (lambda: cell[rows()]), (lambda v: cell.__setitem__(rows(), v))
        return (lambda: cell), (lambda v: cell << v)

    def keep(self, call):
        """Before a call that may come back into the function it is in: that function's cells and its return
        address onto the stack, the handles of its arrays set to "no block". Past the depth the map allows the
        program says so and stops for good."""
        saves = call["saves"]
        st = stack()
        if not self.within:
            raise Fail("trigscript: a call keeps a frame outside a function that calls itself%s" % where(call))
        mine = self.within[-1]
        if self.errors:
            # B4: a RangeError, as JavaScript's, where the call is and before anything of it is kept: the function this
            # call is in returns with it in flight.
            if EUDIf()(st["depth"] >= STACK_DEPTH):
                self.put(self.var(self.errors["message"], call), {"kind": "text", "text": STACK_OVERFLOW_MESSAGE}, "text")
                self.var("(error line)").set(int((call.get("at") or {}).get("line", 0)))
                self.var(self.errors["thrown"], call).set(RANGE_ERROR)
                EUDJump(self.handler(call))
        elif EUDIf()(st["depth"] >= STACK_DEPTH):
            GetGlobalStringBuffer().print("\x06TrigScript: stack overflow in %s, line %s - %d calls deep. The program has stopped." % (saves.get("within", "a function"), (call.get("at") or {}).get("line", "?"), STACK_DEPTH))
            st["depth"] << 0
            st["at"] << st["base"]
            # The program stops for good, or, in a task, the task does.
            stopped = self.pool.co if self.pool else self.top
            stopped.set_state(DONE)
            EUDJump(stopped.frame_end)
        EUDEndIf()
        pairs = self.saved_cells(saves, call)
        at = st["at"]
        f_dwwrite_epd(at, mine["back"])
        at += 1
        for read, _ in pairs:
            f_dwwrite_epd(at, read())
            at += 1
        st["depth"] += 1
        for id_ in saves.get("arrays", []):
            a = self.array(id_, call)
            if isinstance(a, ListStorage):
                for name in HANDLE:
                    a.put(name, 0)
        # A text the function holds keeps its block on the stack; the variable holds none for the length of the call,
        # so that the inner run's first text does not give the outer run's block back.
        held = self.saved_texts(saves)
        for s in held:
            s.write(0, 0, 0)
        return pairs, mine, held

    def bring_back(self, call, kept):
        pairs, mine, held = kept
        st = stack()
        # The block the inner run left in a text goes back to the heap before the text is the outer run's again.
        for s in held:
            texts()["release"](s.cell(s.block))
        # The block the inner run left in a handle goes back to the heap before the handle is the outer run's again.
        for id_ in call["saves"].get("arrays", []):
            a = self.array(id_, call)
            if isinstance(a, ListStorage):
                ptr = fresh(a.field("ptr"))
                if EUDIf()(ptr >= 1):
                    a.heap["give"](ptr, a.field("k"))
                EUDEndIf()
        at = st["at"]
        for _, write in reversed(pairs):
            at -= 1
            write(f_dwread_epd(at))
        at -= 1
        mine["back"] << f_dwread_epd(at)
        f_dwwrite_epd(EPD(mine["tail"]) + 1, mine["back"])
        st["depth"] -= 1

    def call_function(self, call, result):
        body, params, returned = self.function(call["fn"], call)
        if len(params) != len(call["params"]):
            raise Fail("trigscript: %s takes %d values, not %d%s" % (call["fn"], len(params), len(call["params"]), where(call)))
        # Every argument first, then the parameters: an argument may be a call of this same function. A variable's
        # own cell is copied when a later argument holds a call, which may be of a function that writes that variable.
        values = []
        for i, p in enumerate(call["params"]):
            if p["decl"]["kind"] == "text":
                # A text is a copy of its own by the time the parameter takes it: three numbers, read now.
                t = self.own(self.text(p["init"]))
                values.append((fresh(t.addr), fresh(t.block), fresh(t.length())))
                continue
            v = self.value(p["init"], p["decl"]["kind"])
            later = any(has_call(q["init"]) for q in call["params"][i + 1:])
            if later and p["decl"]["kind"] != "unit" and not isinstance(v, int):
                v = fresh(v)
            values.append(v)
        # A call that may come back here keeps this function's frame: after the arguments are worked out (they read
        # it), before the parameters are set (they may be this function's own).
        kept = None
        if call.get("saves"):
            # Copies: an argument may be one of this function's own parameters, which the ones set before it write over.
            values = [v if isinstance(v, (int, tuple)) else UnitRef(v.ptr if isinstance(v.ptr, int) else fresh(v.ptr), v.epd if isinstance(v.epd, int) else fresh(v.epd), v.uid if v.uid is None or isinstance(v.uid, int) else fresh(v.uid)) if isinstance(v, UnitRef) else fresh(v) for v in values]
            kept = self.keep(call)
        for s, v in zip(params, values):
            if isinstance(v, tuple):
                # What the parameter held from the call before goes back; then it holds this call's text.
                texts()["release"](s.cell(s.block))
                s.write(*v)
            else:
                s.set(v)
        body()
        if kept is not None:
            self.bring_back(call, kept)
        if call["fn"] in self.throwing:
            # It came back with an error in flight: on to the nearest catch, nothing of the result used.
            EUDJumpIf(as_var(self.var(self.errors["thrown"], call).get()) >= 1, self.handler(call))
        if result is None:
            return 0
        if isinstance(result, TextStorage):
            # The function's text moves to the call's own result, from where a textCall takes it.
            v = returned.take_out()
            texts()["release"](result.cell(result.block))
            result.write(v.addr, v.block, v.length())
            return 0
        result.set(returned.get())
        return result.get()

    def call(self, call):
        result = self.declare(call["result"]["decl"]) if call.get("result") else None
        if call.get("fn") is not None:
            return self.call_function(call, result)
        # A text result keeps what it held until `return` puts the next one in it, which is when that block goes back.
        if result is not None and call["result"]["kind"] != "text":
            result.set(NO_UNIT if call["result"]["kind"] == "unit" else 0)
        for p in call["params"]:
            s = self.declare(p["decl"])
            self.put(s, p["init"], p["decl"]["kind"])
        end = Forward()
        self.straight(call["body"], {"fn": {"result": result, "kind": call["result"]["kind"] if call.get("result") else "void", "end": end}})
        end << NextTrigger()
        return result.get() if result is not None else 0

    # ── one frame ──
    def frame(self):
        if self.pools:
            self.tick += 1
            if self.per_player:
                for pool in self.pools.values():
                    pool.base << f_mul(self.player, pool.max)
        self.coroutine(self.top, self.p["body"])
        self.run_tasks()

    def run_tasks(self):
        """The tasks' turn, after the program's: each slot whose task is running and has not had its turn in this frame
        goes on until it sleeps, waits or ends - by the number of its start, then by slot. A task started meanwhile
        sets `again`, and the slots are gone through once more, so that it starts in this frame too."""
        if not self.pools:
            return
        if self.per_player:
            for pool in self.pools.values():
                pool.count << pool.live.get()
        sweep = Forward()
        sweep << NextTrigger()
        self.again << 0
        for pool in self.pools.values():
            passed = Forward()
            if pool.fresh is not None:
                go = Forward()
                EUDJumpIf(as_var(pool.fresh.get()) >= 1, go)
                EUDJumpIfNot(self.heard(pool.st["listen"]), passed)
                go << NextTrigger()
                pool.fresh.set(0)
            i, seen = EUDVariable(), EUDVariable()
            i << 0
            seen << 0
            # `seen`: the running slots so far, less those that ended on their turn - so while it is below the count,
            # a running slot is still ahead (or one started meanwhile, which the next time round finds).
            if EUDWhile()([i <= pool.max - 1, seen < pool.count]):
                pool.select(i)
                skip = Forward()
                EUDJumpIf(as_var(pool.co.get_state()) == DONE, skip)
                seen += 1
                EUDJumpIf(as_var(pool.ran.get()) == self.tick, skip)
                pool.ran.set(self.tick)
                listen = pool.st.get("listen")
                if listen is not None:
                    # A listener (on.created, on.chat, ...) that has begun waits at the top of its loop, where a turn
                    # with nothing to hand on does nothing: it is not given one.
                    go = Forward()
                    EUDJumpIf(as_var(pool.co.get_state()) == 0, go)
                    EUDJumpIfNot(self.heard(listen), skip)
                    go << NextTrigger()
                outer = self.pool
                self.pool = pool
                end = Forward()
                call = pool.st["call"]
                result = self.declare(call["result"]["decl"]) if call.get("result") else None
                self.coroutine(pool.co, call["body"], {"fn": {"result": result, "kind": call["result"]["kind"] if call.get("result") else "void", "end": end}}, end)
                self.pool = outer
                if EUDIf()(as_var(pool.co.get_state()) == DONE):
                    pool.add(-1)
                    seen -= 1
                EUDEndIf()
                skip << NextTrigger()
                i += 1
            EUDEndWhile()
            passed << NextTrigger()
        EUDJumpIf(self.again >= 1, sweep)

    def heard(self, listen):
        """Whether a listener has anything to hand on this frame: units the events pass found, or one of its inputs."""
        source = listen.get("source")
        if source is not None:
            return {"created": EVENTS.made_n, "died": EVENTS.gone_n, "killed": EVENTS.gone_n, "ordered": EVENTS.turned_n, "morphed": EVENTS.changed_n}[source] >= 1
        found = fresh(0)
        for inp in listen.get("inputs", []):
            if EUDIf()(as_var(INPUT.read(inp, self, listen)) >= 1):
                found << 1
            EUDEndIf()
        return found >= 1

    def start(self, st):
        """A task into a free slot of its start: the arguments worked out as things are now, then the slot taken - its
        generation one more, its parameters set, its place the body's start - and the number the task is known by
        into `handle`. With every slot running nothing starts, and the game says so once."""
        pool = self.pools[int(st["task"])]
        call = st["call"]
        values = []
        for prm in call["params"]:
            kind = prm["decl"]["kind"]
            target = self.var(prm["decl"]["id"], st)
            if kind == "unit":
                ref = self.unit(prm["init"])
                uid = ref.uid if ref.uid is not None else f_maskread_epd(ref.epd + OFF_UID, 0xFF00)
                values.append(UnitRef(fresh(ref.ptr), fresh(ref.epd), fresh(uid)))
            elif kind == "text" and isinstance(target, TextStorage):
                v = self.own(self.text(prm["init"]))
                values.append(TextVal(fresh(v.addr), fresh(v.block), fresh(v.length()), True))
            elif kind == "text":
                values.append(fresh(self.text_id_of(prm["init"])))
            else:
                values.append(fresh(self.value(prm["init"], kind)))
        found, after = Forward(), Forward()
        i = fresh(0)
        if EUDWhile()(i <= pool.max - 1):
            pool.select(i)
            EUDJumpIf(as_var(pool.co.get_state()) == DONE, found)
            i += 1
        EUDEndWhile()
        # Every slot is running.
        for v in values:
            if isinstance(v, TextVal):
                texts()["release"](v.block)
        if EUDIf()(pool.said == 0):
            pool.said << 1
            GetGlobalStringBuffer().print("\x06TrigScript: %s did not start, line %s - all %d of this start's tasks are running." % (call.get("name") or "a task", (st.get("at") or {}).get("line", "?"), pool.max))
        EUDEndIf()
        if st.get("handle"):
            self.var(st["handle"], st).set(0)
        EUDJump(after)
        found << NextTrigger()
        gen = fresh(pool.gen.get())
        if EUDIf()(gen >= 0xFFFF):
            gen << 0
        EUDEndIf()
        gen += 1
        pool.gen.set(gen)
        for prm, v in zip(call["params"], values):
            target = self.var(prm["decl"]["id"], st)
            if isinstance(v, UnitRef):
                target.set(v)
            elif isinstance(v, TextVal):
                texts()["release"](target.cell(target.block))
                target.write(v.addr, v.block, v.length())
            else:
                target.set(v)
        pool.co.set_state(0)
        pool.co.set_wait(0)
        pool.ran.set(self.tick - 1)
        pool.add(1)
        if pool.fresh is not None:
            pool.fresh.set(1)
        self.again << 1
        if st.get("handle"):
            self.var(st["handle"], st).set(pool.slot + pool.task * 256 + f_bitlshift(fresh(gen), 16))
        after << NextTrigger()

    def task_slot(self, e, act):
        """The slot a task's number names, when the task is in it: `act(pool, slot)` runs for it, the slot being run left as it is."""
        h = fresh(self.num(e))
        slot = self.bitwise("&", h, 0xFF)
        task = self.bitwise("&", self.bitwise(">>>", h, 8), 0xFF)
        gen = self.bitwise(">>>", h, 16)
        for pool in self.pools.values():
            if EUDIf()([as_var(task) == pool.task, as_var(slot) <= pool.max - 1]):
                if EUDIf()([EUDNot(as_var(pool.at(pool.co.state, slot)) == DONE), as_var(pool.at(pool.gen, slot)) == gen]):
                    act(pool, slot)
                EUDEndIf()
            EUDEndIf()

    def running(self, e):
        out = fresh(0)
        self.task_slot(e["task"], lambda pool, slot: out << 1)
        return out

    def cancel(self, st):
        def stop(pool, slot):
            pool.co.state.store[pool.base + slot] = DONE
            # The task whose turn this is ends on it: the tasks' turn counts it then.
            if self.pool is pool:
                if EUDIfNot()(as_var(slot) == pool.slot):
                    pool.add(-1)
                EUDEndIf()
            else:
                pool.add(-1)
        self.task_slot(st["task"], stop)

    def coroutine(self, co, body, ctx=None, end=None):
        """One frame of a coroutine: count its wait down and leave, or go on from where it stopped until it sleeps or
        ends. Its body is lowered here, once, and the places to go on from are recorded as they are met; the jump
        table is filled in after."""
        outer = self.co
        self.co = co
        co.frame_end = Forward()
        start = Forward()
        skip = Forward()
        # Still waiting: count down and leave.
        EUDJumpIfNot(as_var(co.get_wait()) >= 1, skip)
        co.set_wait(as_var(co.get_wait()) - 1)
        EUDJump(co.frame_end)
        skip << NextTrigger()
        table = Forward()
        EUDJump(table)
        start << NextTrigger()
        try:
            self.block(body, ctx or {})
        except Leave:
            pass
        if end is not None:
            end << NextTrigger()  # (where a `return` in a task's body goes)
        # The body ended: it stops for good, as the classic backend's program does.
        co.set_state(DONE)
        EUDJump(co.frame_end)
        table << NextTrigger()
        EUDJumpIf(as_var(co.get_state()) == DONE, co.frame_end)
        for index, resume in co.resumes:
            EUDJumpIf(as_var(co.get_state()) == index, resume)
        EUDJump(start)
        co.frame_end << NextTrigger()
        self.co = outer

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


def flipped(t):
    """1 for 0 and 0 for anything else, in a variable of its own."""
    out = fresh(0)
    if EUDIf()(t == 0):
        out << 1
    EUDEndIf()
    return out


def each_start(node, visit):
    """Every `start` statement in a piece of the IR, outer ones before those in their bodies."""
    if isinstance(node, list):
        for x in node:
            each_start(x, visit)
        return
    if not isinstance(node, dict):
        return
    if node.get("kind") == "start" and isinstance(node.get("task"), int) and isinstance(node.get("call"), dict):
        visit(node)
    for v in node.values():
        if isinstance(v, (dict, list)):
            each_start(v, visit)


def has_effect(node):
    """Whether working out a piece of the IR does something beyond reading: a call, a pop, a random number."""
    if isinstance(node, list):
        return any(has_effect(x) for x in node)
    if not isinstance(node, dict):
        return False
    if node.get("kind") in ("pop", "random", "randomInt") or (node.get("kind") in ("call", "textCall") and isinstance(node.get("call"), dict)):
        return True
    return any(has_effect(v) for v in node.values() if isinstance(v, (dict, list)))


def has_call(node):
    """Whether a call is anywhere in a piece of the IR."""
    if isinstance(node, list):
        return any(has_call(x) for x in node)
    if not isinstance(node, dict):
        return False
    if node.get("kind") in ("call", "textCall") and isinstance(node.get("call"), dict):
        return True
    return any(has_call(v) for v in node.values() if isinstance(v, (dict, list)))


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


def isqrt(n):
    r = int(n ** 0.5)
    while r * r > n:
        r -= 1
    while (r + 1) * (r + 1) <= n:
        r += 1
    return r


def between_wrapped(table, i, f):
    """The sine table read between cell i and the next, cell 0 after the last."""
    a, b = table[i], table[(i + 1) & 4095]
    part = (abs(b - a) * f) >> 16
    return a - part if b < a else a + part


def fixed_const(name, args, unsigned=False, table=None):
    """A fixed operation of numbers known when the map is built, exactly as the functions of fixed_fns() compute it."""
    def towards_zero(m, negative):
        return (-(m & U32)) & U32 if negative else m & U32
    if name == "fmul":
        a, b = args
        return towards_zero((abs(a) * abs(b)) >> 16, (a < 0) != (b < 0))
    if name == "fdiv":
        a, b = args
        return 0 if b == 0 else towards_zero((abs(a) << 16) // abs(b), (a < 0) != (b < 0))
    if name == "sqrt":
        x = args[0] & U32 if unsigned else args[0]
        if unsigned:
            return 0x7FFFFFFF if x >= 1 << 30 else isqrt(x << 32)
        return 0 if x <= 0 else isqrt(x << 16)
    def between(i, f, bits):
        a = table[i] if i < len(table) else 0
        b = table[i + 1] if i + 1 < len(table) else 0
        part = (abs(b - a) * f) >> bits
        return a - part if b < a else a + part
    if name in ("sin", "cos"):
        x, scale = args
        at = fixed_const("fmul", [x, scale])
        i = ((at >> 16) + (1024 if name == "cos" else 0)) & 4095
        return between_wrapped(table, i, at & 0xFFFF)
    y, x = args
    ax, ay = abs(x), abs(y)
    if ax == 0 and ay == 0:
        return 0
    read = lambda small, large: between(((small << 16) // large) >> 6, ((small << 16) // large) & 63, 6)
    t = read(ay, ax) if ay <= ax else FIXED_HALF_PI - read(ax, ay)
    if x < 0:
        t = FIXED_PI - t
    if y < 0:
        t = -t
    return t


def rng(node):
    """The range compiler/ranges.ts found for a number of the IR - its signed reading, lowest and highest - or None."""
    if not isinstance(node, dict):
        return None
    if node.get("kind") == "const":
        v = signed(int(node["value"]) & U32)
        return (v, v)
    r = node.get("range")
    return (int(r[0]), int(r[1])) if r else None


def top_of(node):
    """The most a number of the IR can be, when ranges.ts found it never below zero; None otherwise."""
    r = rng(node)
    return r[1] if r is not None and r[0] >= 0 else None


def mul_bits(v, top, k):
    """v * k, wrapping, of a variable known to be 0 ... top and a constant k of either sign: a trigger a bit v can have,
    each adding k shifted to that bit (eudplib's product by a constant goes over all 32, through a call)."""
    r = EUDVariable()
    RawTrigger(actions=r.SetNumber(0))
    for bit in range(top.bit_length()):
        add = (k << bit) & U32
        if add:
            RawTrigger(conditions=v.AtLeastX(1, 1 << bit), actions=r.AddNumber(add))
    return r


def mul_bits_pays(top, k):
    """Whether mul_bits beats eudplib's product for a side of 0 ... top and the constant k, by Remastered's weights: about
    18 ns a bit of top, against a call (80 ns) and about 95 ns a bit of the smaller side for eudplib's."""
    m = abs(signed(k))
    return 18 * top.bit_length() < 80 + 95 * min(m.bit_length(), top.bit_length())


def div_bits(a, d, top):
    """(a // d, a % d) of a value known to be 0 ... top and a constant d >= 1: a trigger a bit the quotient can have,
    where eudplib's goes over every bit a 32-bit dividend could give, through a call. `a` is copied, not used up."""
    if d == 1:
        return a, 0
    if d & (d - 1) == 0:
        k = d.bit_length() - 1
        rem = fresh(a)
        DoActions(rem.SetNumberX(0, (~(d - 1)) & U32))
        return shift_const(as_var(a), ">>>", k, top), rem
    rem, q = fresh(a), EUDVariable()
    RawTrigger(actions=q.SetNumber(0))
    for i in range((top // d).bit_length() - 1, -1, -1):
        RawTrigger(conditions=rem.AtLeast(d << i), actions=[rem.SubtractNumber(d << i), q.AddNumber(1 << i)])
    return q, rem


def div_var_bits(a, b, top):
    """(a // b, a % b) of a value known to be 0 ... top and a variable b >= 1, both read from 0 up: eudplib's division
    chain (the divisor doubled into each step's condition and action, then the steps from the highest down), with only
    as many steps as top has bits, and the chain started as soon as the next doubling would pass top - where eudplib's
    doubles the divisor until it would pass 2^31 and keeps 32 steps."""
    n = max(1, top.bit_length())
    q, x, rem = EUDVariable(), EUDVariable(), fresh(a)
    SeqCompute([(q, SetTo, 0), (x, SetTo, b)])
    cells = [(Forward(), Forward()) for _ in range(n)]
    chain = [Forward() for _ in range(n)]
    half = (top >> 1) + 1
    for i in range(n):
        SeqCompute([(EPD(c), SetTo, x) for c in cells[i]])
        if i == n - 1:
            break
        # Past top / 2 the next doubling is past top, whose steps take nothing: the chain starts here.
        p1, p2, p3 = Forward(), Forward(), Forward()
        p1 << RawTrigger(nextptr=p2, conditions=x.AtLeast(half), actions=SetNextPtr(p1, p3))
        p3 << RawTrigger(nextptr=chain[i], actions=SetNextPtr(p1, p2))
        p2 << NextTrigger()
        SeqCompute([(x, Add, x)])
    for i in range(n - 1, -1, -1):
        c, act = Forward(), Forward()
        chain[i] << RawTrigger(conditions=[c << rem.AtLeast(0)], actions=[act << rem.SubtractNumber(0), q.AddNumber(1 << i)])
        cells[i][0] << c + 8
        cells[i][1] << act + 20
    return q, rem


def shift_const(x, op, k, top=None):
    """x << k, x >> k (the sign kept) or x >>> k for a constant k from 1 to 31, one trigger a bit that moves: a bit of x
    tested, its place in the result added. A short shift left is doublings instead (a doubling is about two triggers).
    `top`: x is known to be 0 ... top (ranges.ts), so only its bits move - and `>>` is `>>>`, the sign bit being 0."""
    if top is not None:
        if op == ">>":
            op = ">>>"
        if op == ">>>" and top >> k == 0:
            return 0
    if op == "<<" and k <= 4:
        t = fresh(x)
        for _ in range(k):
            t += t
        return t
    r = EUDVariable()
    RawTrigger(actions=r.SetNumber(0))
    if op == "<<":
        for bit in range(32 - k if top is None else min(32 - k, top.bit_length())):
            RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=r.AddNumber(1 << (bit + k)))
        return r
    # From the top, eight bits a group: a group with none of its bits set is jumped over (a small number skips most).
    # Known to be at most `top`, the bits above it are never set, and a group of eight or fewer needs no jump.
    highest = 31 if top is None else top.bit_length() - 1
    if highest - k < 8:
        for bit in range(highest, k - 1, -1):
            add = 1 << (bit - k)
            if op == ">>" and bit == 31:
                add = (add - (1 << (32 - k))) & U32
            RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=r.AddNumber(add))
        return r
    for top in range(highest, k - 1, -8):
        bits = range(top, max(k, top - 7) - 1, -1)
        group = sum(1 << bit for bit in bits)
        past = Forward()
        EUDJumpIf(x.ExactlyX(0, group), past)
        for bit in bits:
            add = 1 << (bit - k)
            if op == ">>" and bit == 31:
                add = (add - (1 << (32 - k))) & U32  # the sign bit: its place, and every bit above the result's top
            RawTrigger(conditions=x.AtLeastX(1, 1 << bit), actions=r.AddNumber(add))
        past << NextTrigger()
    return r


def signed_order(a, op, b):
    """`a op b` of two signed variables, with no addition a side: a < b read as signed is a < b read from 0 up, turned
    over once for each side below zero (the top bits differ only when exactly one is). A count of those three is a
    condition on its low bit; > <= >= are < with the sides swapped, or the count's other answer."""
    x, y, holds = (a, b, 1) if op == "<" else (b, a, 1) if op == ">" else (b, a, 0) if op == "<=" else (a, b, 0)
    n = EUDVariable()
    lt = relation(x, "<", y)
    RawTrigger(actions=n.SetNumber(0))
    RawTrigger(conditions=lt, actions=n.AddNumber(1))
    RawTrigger(conditions=x.AtLeast(SIGN), actions=n.AddNumber(1))
    RawTrigger(conditions=y.AtLeast(SIGN), actions=n.AddNumber(1))
    return n.ExactlyX(holds, 1)


def not_all(conds):
    """!(c1 && c2 && ...) as a light bool: set by one trigger, cleared by a second that has the conditions. (EUDNot of a
    list takes an if around the second, a third trigger.)"""
    v = EUDLightBool()
    RawTrigger(actions=v.Set())
    # (Trigger, not RawTrigger: a condition whose amount is a variable is patched before, as EUDIf does.)
    Trigger(conditions=conds, actions=v.Clear())
    return v


def forget_counts():
    """Bring keeps the counts it found for a location number until the trigger pass ends or a query of another kind or
    location is asked: writing a location's sides, or making units in it, leaves the next Bring of it reading the old
    counts (Remastered and the lifted game alike, probes/location-stale.py). A Command in between makes it count again
    (about 30 ns, and the next Bring is a scan, as it would be for a location that moved)."""
    RawTrigger(conditions=Command(P1, AtLeast, 0, 0))


# Actions that put units where a Bring already counted, or change whose they are: Create Unit with Properties, Move
# Unit, Create Unit, Give Units to Player.
MOVES_UNITS = {11, 39, 44, 48}


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
    if op == ">":
        return av > b
    if isinstance(unProxy(b), EUDVariable):
        # eudplib orders two variables with < and > only: a >= b is b - a, which the game's Subtract stops at 0, being
        # 0 - worked out into the condition's own first dword, as eudplib's < does it.
        return floored_zero(b, av) if op == ">=" else floored_zero(av, b)
    if op == "<=":
        return av <= b
    return av >= b


def floored_zero(x, y):
    """x - y, stopped at 0, is 0: x <= y read from 0 up, one condition and a sum written into it."""
    cell = Forward()
    cond = MemoryEPD(cell, Exactly, 0)
    cell << EPD(cond)
    SeqCompute(((cell, SetTo, x), (cell, Subtract, y)))
    return cond


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
        self.held = list(self.plan.get("held", []))
        self.buttons = list(self.plan.get("buttons", []))
        self.chats = list(self.plan.get("chats", []))
        self.mouse_base = self.plan.get("mouseBase")
        # A person can sit in the map's human slots, which is where MSQC counts the mouse locations from.
        self.humans = [p for p in range(8) if GetPlayerInfo(p).typestr == "Human"]
        if plan and not self.humans:
            raise Fail("trigscript: a program reads keys, clicks, the mouse or chat, and the map has no human player to give any")
        self.key_cells = [self.register("tsin_key%d" % i, EUDArray(12)) for i in range(len(self.keys))]
        self.held_cells = [self.register("tsin_held%d" % i, EUDArray(12)) for i in range(len(self.held))]
        # A held key is a message each frame it is down, but a multiplayer game carries commands in turns: two frames'
        # messages may arrive on one frame and none on the next. What arrives is banked and paid out a frame at a time,
        # so keyHeld() is true on as many frames as the key was down, however the turns grouped them.
        self.held_bank = [EUDArray(12) for _ in self.held]
        self.held_now = [EUDArray(12) for _ in self.held]
        # And a message can go missing for a frame (seen in the lifted game, the second frame of every hold): a key is
        # still held until HELD_GRACE frames have passed with no message, which delays a release by as much.
        self.held_quiet = [EUDArray(12) for _ in self.held]
        # With held keys every key is sent as held (compiler/input.ts#inputPlan): a press is held now and not before.
        self.held_pressed = [EUDArray(12) for _ in self.held]
        self.button_cells = [self.register("tsin_button%d" % i, EUDArray(12)) for i in range(len(self.buttons))]
        # sync() (B5): each slot a value put on one computer (local) and what arrived of it, by player (everyone's).
        self.syncs = int(self.plan.get("syncs", 0))
        self.sync_local = [self.register("tsin_sync%d" % i, EUDVariable()) for i in range(self.syncs)]
        self.sync_in = [self.register("tsin_sync%d_in" % i, EUDArray(12)) for i in range(self.syncs)]
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

    SYNC_MOST = 1048574  # what MSQC's val carries, less the 1 that tells a value from nothing

    def sync_frame(self):
        """Once a frame, before the programs: what was put to be sent has gone (MSQC sends in its beforeTriggerExec)."""
        if self.sync_local:
            DoActions([c.SetNumber(0) for c in self.sync_local])

    def send_sync(self, slot, p, value):
        """sync()'s first half: on every computer the slot's arrival for the player cleared; on the player's own the
        value, kept to what MSQC carries, plus 1, put where MSQC sends it from."""
        if slot >= self.syncs:
            raise Fail("trigscript: the IR's input plan has no sync slot %d" % slot)
        self.sync_in[slot][p] = 0
        if EUDIf()(f_getuserplayerid() == p):
            v = fresh(value)
            if EUDIf()(v >= 0x80000000):
                v << 0
            EUDEndIf()
            if EUDIf()(v >= self.SYNC_MOST + 1):
                v << self.SYNC_MOST
            EUDEndIf()
            self.sync_local[slot] << v + 1
        EUDEndIf()

    HELD_BANK_MOST = 8  # a burst after a lag spike pays out at most this many frames
    HELD_GRACE = 2  # frames with no message before a held key counts as let go

    def frame(self):
        """Once a frame, before the programs: this frame's held messages banked, one frame of each paid out, and a key
        with nothing left to pay still held for HELD_GRACE quiet frames."""
        for cells, bank, now, quiet, pressed in zip(self.held_cells, self.held_bank, self.held_now, self.held_quiet, self.held_pressed):
            for p in self.humans:
                was = fresh(now[p])
                b = fresh(bank[p] + cells[p])
                if EUDIf()(b >= self.HELD_BANK_MOST + 1):
                    b << self.HELD_BANK_MOST
                EUDEndIf()
                if EUDIf()(b >= 1):
                    now[p] = 1
                    bank[p] = b - 1
                    quiet[p] = 0
                if EUDElse()():
                    bank[p] = 0
                    q = fresh(quiet[p] + 1)
                    quiet[p] = q
                    if EUDIf()([now[p] >= 1, q <= self.HELD_GRACE]):
                        now[p] = 1
                    if EUDElse()():
                        now[p] = 0
                    EUDEndIf()
                EUDEndIf()
                if EUDIf()([now[p] >= 1, was == 0]):
                    pressed[p] = 1
                if EUDElse()():
                    pressed[p] = 0
                EUDEndIf()

    @staticmethod
    def register(name, cell):
        EUDRegisterObjectToNamespace(name, cell)
        return cell

    # ── reads ──
    def read(self, i, low, node):
        source = i.get("source")
        p = low.one_player(i["player"], node)
        if source == "key" and i.get("held"):
            return self.cell(self.held_now, self.held, i["key"], node)[p]
        if source == "key" and self.held:
            return self.cell(self.held_pressed, self.held, i["key"], node)[p]
        if source == "key":
            return self.cell(self.key_cells, self.keys, i["key"], node)[p]
        if source == "click":
            return self.cell(self.button_cells, self.buttons, i["button"], node)[p]
        if source == "mouse":
            return self.mouse(p, 0 if i["axis"] == "x" else 1, node)
        if source == "sync":
            slot = int(i["slot"])
            if slot >= self.syncs:
                raise Fail("trigscript: the IR's input plan has no sync slot %d%s" % (slot, where(node)))
            return self.sync_in[slot][p]
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


# Where each trigger came from, for a run in the lifted game to name the line a trigger belongs to (TrigScript 4,
# A1). Only when the build asks for it (the `triggerMap` setting): every RawTrigger made is tagged with the
# statement being lowered, or with the eudplib function whose body it is, and once the payload is laid out one
# header line and lines of rows say where each trigger sits in it:
#   TRIGSCRIPT-MAP {"payload": <bytes>, "count": <triggers>}
#   TRIGSCRIPT-ROWS [[offset, conditions, actions, origin], ...]     (400 a line, as many lines as it takes)
# An origin is "line:column" (or "file:line:column"), "fn:<name>" for a function of eudplib's, "" for what no
# statement made (a program's frame, its sleeps), or "eudplib" for what eudplib made before this file was read. The payload sits at the end of the strings section, so a run
# finds it at the section's address plus its length less the payload's.
if settings.get("triggerMap"):
    import eudplib.core.allocator.payload as _payload
    from eudplib.core.eudfunc.eudfuncn import EUDFuncN as _EUDFuncN
    from eudplib.core.rawtrigger.rawtriggerdef import RawTrigger as _RawTrigger

    _ORIGINS = []
    _MADE = {}

    def _origin_of(at):
        if not at:
            return ""
        if at.get("file"):
            return "%s:%s:%s" % (at.get("file"), at.get("line"), at.get("column"))
        return "%s:%s" % (at.get("line"), at.get("column"))

    _trigger_init = _RawTrigger.__init__

    def _tagged_trigger(self, *args, **kwargs):
        _trigger_init(self, *args, **kwargs)
        _MADE[self] = _ORIGINS[-1] if _ORIGINS else ""

    _RawTrigger.__init__ = _tagged_trigger

    _func_body = _EUDFuncN._create_func_body

    def _tagged_body(self):
        _ORIGINS.append("fn:" + getattr(self._bodyfunc, "__name__", "?"))
        try:
            return _func_body(self)
        finally:
            _ORIGINS.pop()

    _EUDFuncN._create_func_body = _tagged_body

    _statement = Lowering.statement

    def _tagged_statement(self, st, ctx):
        _ORIGINS.append(_origin_of(st.get("at")) or (_ORIGINS[-1] if _ORIGINS else ""))
        try:
            return _statement(self, st, ctx)
        finally:
            _ORIGINS.pop()

    Lowering.statement = _tagged_statement

    _construct = _payload._construct_payload

    def _construct_and_say():
        built = _construct()
        found = _payload._found_objects_dict
        rows = []
        # (Every trigger in the payload, also those eudplib made before this file was read, at its own import:
        # those say "eudplib".)
        for trg, i in found.items():
            if not isinstance(trg, _RawTrigger):
                continue
            origin = _MADE.get(trg, "eudplib")
            rows.append([_payload._payload_builder.get_object_addr(i).offset, len(trg._conditions), len(trg._actions), origin])
        rows.sort()
        # (In parts, so that no one line of the log runs to megabytes.)
        print("TRIGSCRIPT-MAP " + json.dumps({"payload": len(built.data), "count": len(rows)}, separators=(",", ":")))
        for k in range(0, len(rows), 400):
            print("TRIGSCRIPT-ROWS " + json.dumps(rows[k:k + 400], separators=(",", ":")))
        return built

    _payload._construct_payload = _construct_and_say


# Where each program's variables are, for a test in the lifted game to read them as `sim.program()` reads the
# simulator's (TrigScript 4, A2). Only when the build asks for it (the `variableMap` setting): once the payload is
# placed, a header line and a line a program give the address of every cell:
#   TRIGSCRIPT-VARS {"programs": <count>, "heap": <address of the heap's cells>, "cells": <address of the growing
#   arrays' first cell's value (an EUDVArray: 72 bytes a cell)>, "strings": <address of STRx>}
#   TRIGSCRIPT-PROGRAM {"index", "name", "perPlayer", "owners", "vars": [...], "arrays": [...]}
# A variable is its id (what the simulator keys it by), its kind, and its cells: `value` (a number, a boolean, a text
# of the table by its id), `addr` + `len` (a text that is made), `ptr` + `uid` (a unit). An array is its cells' `at`,
# or, growing, its handle's `ptr` + `len` among the growing arrays' cells. A cell of a per-player program's own (`rowed`) is a
# row of twelve, one a player; an address is null for what nothing in the map uses, which eudplib leaves out.
if settings.get("variableMap"):
    import eudplib.core.allocator.payload as _vpayload
    import eudplib.maprw.injector.apply_injector as _injector
    from eudplib.core.allocator.constexpr import Evaluate as _evaluate
    from eudplib.core.mapdata.stringmap import get_string_section_name as _strings_name
    from eudplib.core.variable.vbuf import get_current_varbuffer as _varbuffer
    from eudplib.utils import unProxy as _unproxy

    _PLACES = {}

    def _offset(expr):
        """A payload-relative address as a byte offset into the payload: eudplib's own (relocated whole) or an EPD
        (relocated a quarter at a time, as EPD(x) = (x - 0x58A364) / 4 is)."""
        r = _evaluate(expr)
        if r.rlocmode == 4:
            return r.offset
        if r.rlocmode == 1:
            return r.offset * 4 + 0x58A364
        return None

    def _place(obj):
        """Where a variable's value or an array's first cell is in the payload; None for what it left out."""
        if is_varray(obj):
            try:
                at = _offset(_unproxy(obj))
            except Exception:
                return None
            return None if at is None else at + VARRAY_VALUE
        if isinstance(obj, EUDVariable):
            vb = _varbuffer()
            if vb is None or obj.GetVTable() not in vb._vdict:
                return None
            return _offset(obj.getValueAddr())
        # An EUDArray is a proxy of its data's EPD (or of the data itself), the data an object of its own.
        data = _unproxy(obj)
        while not isinstance(data, EUDObject) and hasattr(data, "_value"):
            data = _unproxy(data)
        try:
            return _offset(data)
        except Exception:
            return None  # (nothing in the map uses it, so eudplib did not place it)

    def _cells_of(s):
        if isinstance(s, UnitStorage):
            return {"ptr": s.ptr, "uid": s.uid}
        if isinstance(s, TextStorage):
            return {"addr": s.addr, "len": s.len}
        return {"value": s.store}

    def _program_places(k, low):
        p = low.p
        out = {"index": k, "name": p.get("name"), "perPlayer": low.per_player, "owners": p.get("owners", [low.owner]), "vars": [], "arrays": []}
        for id_, s in low.vars.items():
            # (A loop's unit is the scan's own pointer for one turn, kept nowhere: nothing to read.)
            d = getattr(s, "decl", None)
            if d is None or d.get("temp") or d.get("task") is not None:
                continue  # (a task's variable is a row a slot: nothing a test reads by name)
            cells_ = _cells_of(s)
            out["vars"].append({"id": id_, "kind": d.get("kind"), "text": d.get("text"), "bits": d.get("bits"), "unsigned": bool(d.get("unsigned")),
                                "rowed": bool(s.rowed), "cells": {name: _place(cell) for name, cell in cells_.items()},
                                "stride": VARRAY_STRIDE if any(is_varray(c) for c in cells_.values()) else 4})
        for id_, a in low.arrays.items():
            if isinstance(a, (InnerListStorage, SliceStorage)) or a.decl.get("task") is not None:
                continue  # (a row of another's cells, or a list inside one: read through what it is in, not here)
            d = a.decl
            row = {"id": id_, "kind": d.get("kind"), "bits": d.get("bits"), "unsigned": bool(d.get("unsigned")), "length": int(d.get("length", 0)), "rowed": bool(a.rowed)}
            if isinstance(a, ListStorage):
                row.update(dynamic=True, ptr=_place(a.handle["ptr"]), len=_place(a.handle["len"]), stride=VARRAY_STRIDE if is_varray(a.handle["ptr"]) else 4)
            else:
                row.update(at=_place(a.store), stride=VARRAY_STRIDE if is_varray(a.store) else 4)
            out["arrays"].append(row)
        return out

    _vconstruct = _vpayload._construct_payload

    def _construct_and_place():
        built = _vconstruct()
        # (eudplib works addresses out only while it writes the payload: for as long as this takes, it is again.)
        was = _vpayload.phase
        _vpayload.phase = _vpayload.PHASE_WRITING
        try:
            _PLACES["programs"] = [_program_places(k, low) for k, low in enumerate(PROGRAMS)]
            _PLACES["heap"] = _place(_HEAP["cells"]) if _HEAP else None
            _PLACES["cells"] = _place(_HEAP["vcells"]) if _HEAP and "vcells" in _HEAP else None
        finally:
            _vpayload.phase = was
        _PLACES["bytes"] = len(built.data)
        return built

    _vpayload._construct_payload = _construct_and_place

    _initialize = _injector.initialize_payload

    def _initialize_and_say(chkt, payload, *args, **kwargs):
        out = _initialize(chkt, payload, *args, **kwargs)
        # The payload is the end of the strings section, which Remastered keeps at 0x191943C8.
        base = 0x191943C8 + len(chkt.getsection(_strings_name())) - _PLACES["bytes"]

        def at(o):
            return None if o is None else base + o

        print("TRIGSCRIPT-VARS " + json.dumps({"programs": len(_PLACES["programs"]), "heap": at(_PLACES["heap"]), "cells": at(_PLACES.get("cells")), "strings": 0x191943C8}, separators=(",", ":")))
        for prog in _PLACES["programs"]:
            for v in prog["vars"]:
                v["cells"] = {name: at(o) for name, o in v["cells"].items()}
            for a in prog["arrays"]:
                for key in ("at", "ptr", "len"):
                    if key in a:
                        a[key] = at(a[key])
            print("TRIGSCRIPT-PROGRAM " + json.dumps(prog, separators=(",", ":")))
        return out

    _injector.initialize_payload = _initialize_and_say


# The loops of the IR and the code that runs apart from them, for static routing (above): a loop is a region with a way
# in (`entry`, what came before jumps there; `after`, the loop's first trigger), a sleep or a parallel makes the loops
# around it wait, a coroutine (a program's body, a task, a branch) runs apart, and a call of a function that calls itself
# is one whose body this cannot follow.
if ROUTE.enabled:
    _ROUTED_LOOPS = ("while", "do", "for", "unitLoop", "textLoop")
    _lower_statement = Lowering.statement

    def _routed_statement(self, st, ctx):
        k = st["kind"]
        if k in ("sleep", "parallel"):
            ROUTE.waited()
        if k not in _ROUTED_LOOPS or not ROUTE.on:
            return _lower_statement(self, st, ctx)
        r = _Region("loop")
        r.entry, r.after = Forward(), Forward()
        SetNextTrigger(r.entry)
        r.after << NextTrigger()
        ROUTE.loops.append(r)
        ROUTE.stack.append(r)
        try:
            return _lower_statement(self, st, ctx)
        finally:
            ROUTE.stack.pop()

    Lowering.statement = _routed_statement
    _lower_coroutine = Lowering.coroutine

    def _routed_coroutine(self, *args, **kwargs):
        ROUTE.stack.append(_Region("coroutine"))
        try:
            return _lower_coroutine(self, *args, **kwargs)
        finally:
            ROUTE.stack.pop()

    Lowering.coroutine = _routed_coroutine

INPUT = Input(IR.get("input"))
_SOURCES = {s: uses_source(IR.get("programs", []), s) for s in ("created", "died", "killed", "ordered", "morphed")}
EVENTS = Events(_SOURCES["created"], _SOURCES["died"] or _SOURCES["killed"], _SOURCES["ordered"], _SOURCES["morphed"]) if any(_SOURCES.values()) else None
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
    INPUT.sync_frame()
    if INPUT.held:
        INPUT.frame()
    if EVENTS is not None:
        EVENTS.run()
    for prog in PROGRAMS:
        prog.run()
    # Everything this file makes is made by now: which reads need no routing (above).
    ROUTE.decide()
