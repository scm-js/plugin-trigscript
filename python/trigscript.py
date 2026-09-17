"""
[trigscript]
ir : /work/files/trigscript.json

TrigScript's Remastered target: the euddraft plugin that lowers the compiler's IR — data,
never code — into eudplib. The IR file is what the plugin's compiler wrote (docs/ir.md);
this module is handed to the eudplib library plugin as a source with every build, so the
two halves of the IR version are always the same build.

A program is a coroutine the game runs every frame. Its body is lowered to straight-line
eudplib triggers with jumps between labels (the same shape the classic backend's state
machine has): `if` / `while` / `switch` become conditional jumps, and `sleep` stores the
label to resume at in a state variable, sets a frame counter, and leaves the frame. The
frame's entry counts the wait down, then jumps to the stored label. A per-player program
runs once per human player each frame with CurrentPlayer set, its variables and its state
as 12-slot arrays indexed by the player.

Numbers keep the classic contract: 32-bit unsigned, an expression's exact value stored
below zero as 0 and at 2^32 or above wrapped, u8 / u16 saturating at their maximum.
"""
import json

from eudplib import *

IR_VERSION = 1
FRAMES_PER_SECOND = 24
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
        self.store = EUDArray([0] * 12) if self.rowed else EUDVariable(0)

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
        return EUDVariable(value & U32)
    return value


class Lowering:
    def __init__(self, program):
        self.p = program
        self.per_player = bool(program.get("perPlayer"))
        self.owner = int(program.get("owner", 0))
        self.player = None
        self.vars = {}
        self.state = EUDArray([0] * 12) if self.per_player else EUDVariable(0)
        self.wait = EUDArray([0] * 12) if self.per_player else EUDVariable(0)
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
        """Flatten + and - into positive and negative terms; anything else is one term."""
        k = e["kind"]
        if k == "binary" and e["op"] in ("+", "-"):
            self.linear(e["left"], pos, neg, sign)
            self.linear(e["right"], pos, neg, sign if e["op"] == "+" else -sign)
        elif k == "unary":
            self.linear(e["expr"], pos, neg, -sign)
        else:
            (pos if sign > 0 else neg).append(self.term(e))

    def num(self, e):
        k = e["kind"]
        if k == "unary" or (k == "binary" and e["op"] in ("+", "-")):
            pos, neg = [], []
            self.linear(e, pos, neg, 1)
            cp = sum(t for t in pos if isinstance(t, int))
            cn = sum(t for t in neg if isinstance(t, int))
            vp = [t for t in pos if not isinstance(t, int)]
            vn = [t for t in neg if not isinstance(t, int)]
            if not vp and not vn:
                return max(cp - cn, 0) & U32
            if not vn and cn == 0:
                acc = EUDVariable(cp & U32)
                for t in vp:
                    acc += t
                return acc
            acc = EUDVariable(cp & U32)
            for t in vp:
                acc += t
            sub = EUDVariable(cn & U32)
            for t in vn:
                sub += t
            r = EUDVariable()
            if EUDIf()(acc >= sub):
                r << acc - sub
            if EUDElse()():
                r << 0
            EUDEndIf()
            return r
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
            if isinstance(a, int) and isinstance(b, int):
                if op == "*":
                    return (a * b) & U32
                if b == 0:
                    raise Fail("trigscript: division by zero%s" % where(e))
                return (a // b if op == "/" else a % b) & U32
            if op == "*":
                return f_mul(as_var(a), as_var(b))
            q, r = f_div(as_var(a), as_var(b))
            return q if op == "/" else r
        if k == "unary":
            return self.num(e)
        if k == "ternary":
            t = EUDVariable()
            if EUDIf()(self.cond(e["cond"])):
                t << self.num(e["whenTrue"])
            if EUDElse()():
                t << self.num(e["whenFalse"])
            EUDEndIf()
            return t
        if k == "intrinsic":
            args = [self.num(a) for a in e["args"]]
            name = e["name"]
            if name == "abs":
                return args[0]  # unsigned: a stored value is never negative
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

    # ── booleans: an eudplib condition ──
    def cond(self, e):
        k = e["kind"]
        if k == "const":
            return EUDVariable(1 if e["value"] else 0) >= 1
        if k == "cond":
            return condition(e["record"])
        if k == "var":
            return as_var(self.var(e["id"], e).get()) >= 1
        if k == "test":
            return as_var(self.num(e["expr"])) >= 1
        if k == "compare":
            a, b = self.num(e["left"]), self.num(e["right"])
            op = e["op"]
            if isinstance(a, int) and isinstance(b, int):
                return EUDVariable(1 if compare(a, op, b) else 0) >= 1
            # One comparison, built once: a comparison between variables writes into its own
            # condition, and one that is built and dropped is an orphan eudplib refuses.
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
        t = EUDVariable(0)
        if EUDIf()(self.cond(e)):
            t << 1
        EUDEndIf()
        return t

    def edge(self, e):
        """rose(c): true on the frame c becomes true; once(c): true the first time it holds."""
        key = id(e)
        if key not in self.latches:
            self.latches[key] = EUDArray([0] * 12) if self.per_player else EUDVariable(0)
        latch = self.latches[key]

        def get():
            return latch[self.player] if self.per_player else latch

        def put(v):
            if self.per_player:
                latch[self.player] = v
            else:
                latch << v

        fired = EUDVariable(0)
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
        fields = dict(locid1=r["location"], strid=r["text"], wavid=r["wav"], time=r["time"], player1=r["player"], player2=r["target"], unitid=r["unitId"], acttype=r["type"], amount=r["modifier"], flags=r["flags"])
        if variable is None:
            DoActions(Action(**fields))
            return
        value = as_var(self.num(variable["expr"]))
        field = variable["field"]
        if field == "modifier":
            # A unit count: the byte field is not a variable's place, so the action is done once per unit.
            fields["amount"] = 1
            for _ in EUDLoopRange(0, value):
                DoActions(Action(**fields))
            return
        name = {"target": "player2", "time": "time", "player": "player1", "location": "locid1", "text": "strid", "wav": "wavid", "unitId": "unitid"}.get(field)
        if name is None:
            raise Fail("trigscript: no variable can stand in the %s field%s" % (field, where(st)))
        fields[name] = value
        DoActions(Action(**fields))

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
            for p in EUDLoopPlayer("Human"):
                self.player = p
                f_setcurpl(p)
                self.frame()
            self.player = None
        else:
            f_setcurpl(self.owner if self.owner < 12 else 0)
            self.frame()


def compare(a, op, b):
    return {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def condition(r):
    return Condition(r["location"], r["player"], r["amount"], r["unitId"], r["comparison"], r["type"], r["resource"], r["flags"], eudx=r.get("mask", 0) or 0)


PROGRAMS = [Lowering(p) for p in IR.get("programs", [])]


def afterTriggerExec():
    for prog in PROGRAMS:
        prog.run()
