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

Numbers keep one contract with the simulator: 32-bit unsigned, an expression's exact value stored
below zero as 0 and at 2^32 or above wrapped, u8 / u16 saturating at their maximum.
"""
import json

from eudplib import *

IR_VERSION = 3
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
COND_COMMAND, COND_BRING, COND_ACCUMULATE, COND_KILL, COND_OPPONENTS, COND_DEATHS = 2, 3, 4, 5, 14, 15
CURRENT_PLAYER = 13
# The state of a program whose body ended: nothing resumes it.
DONE = 0xFFFFFFFF
U32 = 0xFFFFFFFF

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
        s = Storage(decl, self.per_player, self.player_of)
        self.vars[decl["id"]] = s
        return s

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

    # ── numbers: an int or an EUDVariable ──
    def linear(self, e, pos, neg, sign):
        """Flatten + and - into positive and negative terms; anything else is one term. A constant
        below zero is a term of the other sign: -1 is "subtract 1", never 0xFFFFFFFF."""
        k = e["kind"]
        if k == "binary" and e["op"] in ("+", "-"):
            self.linear(e["left"], pos, neg, sign)
            self.linear(e["right"], pos, neg, sign if e["op"] == "+" else -sign)
        elif k == "unary":
            self.linear(e["expr"], pos, neg, -sign)
        elif k == "const" and e["value"] < 0:
            (neg if sign > 0 else pos).append(int(-e["value"]))
        else:
            (pos if sign > 0 else neg).append(self.term(e))

    @staticmethod
    def total(terms):
        """The sum of a side: an int when every term is one, else a variable (additions wrap at 2^32)."""
        const = sum(t for t in terms if isinstance(t, int))
        variables = [t for t in terms if not isinstance(t, int)]
        if not variables:
            return const
        acc = fresh(const & U32)
        for t in variables:
            acc += t
        return acc

    def difference(self, pos, neg, absolute=False):
        """sum(pos) - sum(neg), stopping at 0 — or, with `absolute`, the distance between the two."""
        p, n = self.total(pos), self.total(neg)
        if isinstance(p, int) and isinstance(n, int):
            return (abs(p - n) if absolute else max(p - n, 0)) & U32
        if isinstance(n, int) and n == 0:
            return p
        r = EUDVariable()
        pv, nv = as_var(p), as_var(n)
        if EUDIf()(pv >= nv):
            r << pv - nv
        if EUDElse()():
            r << (nv - pv if absolute else 0)
        EUDEndIf()
        return r

    def num(self, e):
        k = e["kind"]
        if k == "unary" or (k == "binary" and e["op"] in ("+", "-")) or (k == "const" and e["value"] < 0):
            pos, neg = [], []
            self.linear(e, pos, neg, 1)
            return self.difference(pos, neg)
        return self.term(e)

    def term(self, e):
        k = e["kind"]
        if k == "const":
            return int(e["value"]) & U32
        if k == "var":
            return self.var(e["id"], e).get()
        if k == "binary":
            a, b = self.num(e["left"]), self.num(e["right"])
            op = e["op"]
            if op in BITWISE:
                return self.bitwise(op, a, b)
            if isinstance(a, int) and isinstance(b, int):
                if op == "*":
                    return (a * b) & U32
                if b == 0:
                    raise Fail("trigscript: division by zero%s" % where(e))
                return (a // b if op == "/" else a % b) & U32
            if op == "*":
                return f_mul(as_var(a), as_var(b))
            if isinstance(b, int):
                if b == 0:
                    raise Fail("trigscript: division by zero%s" % where(e))
                q, r = f_div(as_var(a), b)
                return q if op == "/" else r
            # A divisor that is 0 in the game gives 0, as the simulator does; f_div alone would answer 0xFFFFFFFF.
            out = fresh(0)
            bv = as_var(b)
            if EUDIf()(bv >= 1):
                q, r = f_div(as_var(a), bv)
                out << (q if op == "/" else r)
            EUDEndIf()
            return out
        if k == "unary":
            return self.num(e)
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
        if k == "ternary":
            t = EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                t << self.num(e["whenTrue"])
            if EUDElse()():
                t << self.num(e["whenFalse"])
            EUDEndIf()
            return t
        if k == "intrinsic" and e["name"] == "abs":
            # The distance between what the expression adds and what it subtracts: abs(b - a) is |b - a|, not 0 when a is larger.
            pos, neg = [], []
            self.linear(e["args"][0], pos, neg, 1)
            return self.difference(pos, neg, absolute=True)
        if k == "intrinsic":
            args = [self.num(a) for a in e["args"]]
            name = e["name"]
            a, b = args
            if isinstance(a, int) and isinstance(b, int):
                return min(a, b) if name == "min" else max(a, b)
            t = EUDVariable()
            av, bv = as_var(a), as_var(b)
            if EUDIf()(av <= bv if name == "min" else av >= bv):
                t << av
            if EUDElse()():
                t << bv
            EUDEndIf()
            return t
        if k == "call":
            return self.call(e["call"])
        raise Fail("trigscript: unknown expression %r%s" % (k, where(e)))

    @staticmethod
    def bitwise(op, a, b):
        """& | ^ << >> over 32 bits; a shift by 32 or more leaves nothing."""
        if isinstance(a, int) and isinstance(b, int):
            if op in ("<<", ">>"):
                return 0 if b >= 32 else ((a << b) & U32 if op == "<<" else a >> b)
            return {"&": a & b, "|": a | b, "^": a ^ b}[op]
        if op in ("<<", ">>"):
            if isinstance(b, int) and b >= 32:
                return 0
            return (f_bitlshift if op == "<<" else f_bitrshift)(fresh(a), b)
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
            return EUDVariable(1 if e["value"] else 0) >= 1  # initial: a constant, never written
        if k == "cond":
            return condition(e["record"])
        if k == "var":
            return as_var(self.var(e["id"], e).get()) >= 1
        if k == "test":
            return as_var(self.num(e["expr"])) >= 1
        if k == "compare":
            # What either side subtracts is added to the other, so a - b == 0 asks whether a == b
            # and x >= -1 is true: neither side stops at 0 on its own, as it would were it stored.
            left, right = [], []
            self.linear(e["left"], left, right, 1)
            self.linear(e["right"], right, left, 1)
            a, b = self.total(left), self.total(right)
            op = e["op"]
            if isinstance(a, int) and isinstance(b, int):
                return EUDVariable(1 if compare(a, op, b) else 0) >= 1  # initial: a constant, never written
            # One comparison, built once: a comparison between variables writes into its own
            # condition, and one that is built and dropped is an orphan eudplib refuses.
            if isinstance(b, int):
                b &= U32
            av = as_var(a)
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
        if k == "and":
            return EUDAnd(*[self.cond(c) for c in e["items"]])
        if k == "or":
            return EUDOr(*[self.cond(c) for c in e["items"]])
        if k == "not":
            return EUDNot(self.cond(e["expr"]))
        if k == "random":
            return (f_rand() & 1) >= 1
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

    # ── statements ──
    def block(self, statements, ctx):
        for st in statements:
            self.statement(st, ctx)

    def statement(self, st, ctx):
        k = st["kind"]
        if k == "declare":
            s = self.declare(st["decl"])
            if not st.get("failed"):
                s.set(self.num(st["init"]) if st["decl"]["kind"] == "number" else self.truth(st["init"]))
        elif k == "assign":
            self.var(st["target"], st).set(self.num(st["value"]))
        elif k == "assignBool":
            self.var(st["target"], st).set(self.truth(st["value"]))
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
                fn["result"].set(self.num(st["value"]) if fn["kind"] == "number" else self.truth(st["value"]))
            EUDJump(fn["end"])
            raise Leave()
        elif k == "sleep":
            self.sleep(st)
        elif k == "action":
            self.action(st)
        elif k == "print":
            self.print_(st)
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
            if n != n or n < 0 or n > U32:  # NaN, or a value the variable never holds
                continue
            EUDJumpIf(v == int(n), label)
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
        self.set_wait(frames)
        EUDJump(self.frame_end)
        resume << NextTrigger()

    def action(self, st):
        r = st["record"]
        variable = st.get("variable")
        fields = dict(locid1=r["location"], strid=string_of(r["text"]), wavid=string_of(r["wav"]), time=r["time"], player1=r["player"], player2=r["target"], unitid=r["unitId"], acttype=r["type"], amount=r["modifier"], flags=r["flags"])
        if variable is None:
            DoActions(Action(**fields))
            return
        value = as_var(self.num(variable["expr"]))
        field = variable["field"]
        if field == "modifier":
            # A unit count: the byte field is not a variable's place, so the action is done once per
            # unit — as many as the variable says, 0 being none (in the record, 0 means "all").
            fields["amount"] = 1
            for _ in EUDLoopRange(0, value):
                DoActions(Action(**fields))
            return
        name = {"target": "player2", "time": "time", "player": "player1", "location": "locid1", "text": "strid", "wav": "wavid", "unitId": "unitid"}.get(field)
        if name is None:
            raise Fail("trigscript: no variable can stand in the %s field%s" % (field, where(st)))
        fields[name] = value
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
                args.append(str(v) if isinstance(v, int) else v)
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

    def call(self, call):
        result = self.declare(call["result"]["decl"]) if call.get("result") else None
        if result is not None:
            result.set(0)
        for p in call["params"]:
            s = self.declare(p["decl"])
            s.set(self.num(p["init"]) if p["decl"]["kind"] == "number" else self.truth(p["init"]))
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


BITWISE = ("&", "|", "^", "<<", ">>")


def uses_random(node):
    if isinstance(node, dict):
        return node.get("kind") in ("random", "randomInt") or any(uses_random(v) for v in node.values())
    return isinstance(node, list) and any(uses_random(v) for v in node)


def compare(a, op, b):
    return {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def condition(r):
    return Condition(r["location"], r["player"], r["amount"], r["unitId"], r["comparison"], r["type"], r["resource"], r["flags"], eudx=r.get("mask", 0) or 0)


PROGRAMS = [Lowering(p) for p in IR.get("programs", [])]


def onPluginStart():
    # eudplib's generator starts from the same seed in every game; the game's own randomness (a switch randomized) seeds it.
    if uses_random(IR.get("programs", [])):
        f_randomize()


def afterTriggerExec():
    for prog in PROGRAMS:
        prog.run()
