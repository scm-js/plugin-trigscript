/**
 * The structured level's back end: a *trigger machine* that turns straight-line code,
 * branches and loops into ordinary triggers — no memory tricks, so the output runs on
 * every StarCraft version, and it is exactly what a trigger-cycle interpreter can
 * simulate (`simulate.ts`, which the tests use to prove programs behave).
 *
 * The model, in four facts about how the game runs triggers:
 *
 * 1. Every trigger cycle the game walks a player's trigger list *in order* and runs each
 *    trigger whose conditions hold, once. So a run of triggers that each test
 *    `pc == S` and are placed in list order execute *sequentially within one cycle* —
 *    a basic block is a sequence of triggers sharing a state number.
 * 2. Setting `pc` to a *later* state continues in the same cycle (its triggers are further
 *    down the list); setting it to an *earlier* state resumes next cycle. Forward control
 *    flow is free; a loop's back edge costs one trigger cycle, which is what a game loop
 *    wants anyway (every ~2 s at Normal speed, every frame with hyper triggers).
 * 3. Two triggers in the same state, one with an extra condition, give negation for free:
 *    `[pc == S, C] → pc = THEN` followed by `[pc == S] → pc = ELSE` — the second only
 *    fires when the first did not. Conditions the game cannot negate (Command the Most)
 *    become "skip" steps the same way.
 * 4. Variables are death counters — `Deaths` / `Set Deaths` on units that never die —
 *    unsigned 32-bit, subtraction saturating at 0. `x += 5` is one action; `x += y` is the
 *    classic binary decomposition (32 conditioned steps moving `y` into `x` and a temp,
 *    32 moving the temp back), so a variable-to-variable operation costs 64 triggers.
 *    Booleans are switches.
 *
 * The machine is deliberately ignorant of TypeScript: the compiler walks the AST and
 * calls `Machine` with records; `Bool` trees carry ready-made condition records. Every
 * generated trigger is preserved and owned by one player — the program is a single
 * thread running as that player.
 */
import {
  ActionFlag, ActionType, Comparison, ConditionFlag, ConditionType, emptyAction, emptyCondition, emptyTrigger,
  MAX_ACTIONS, MAX_CONDITIONS, SetModifier, SWITCH_COUNT, SwitchState, TriggerFlag,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { conditionDef } from "../vendor/triggerDefs";
import { unitName } from "../vendor/units";

/* ── Variables ───────────────────────────────────────────── */

/** Where a variable was declared, for the editor's hover; unset for the machine's own counters. */
export interface VarSource { file: string; line: number; column: number }
/**
 * A death counter. `bits` is its declared width — 8 for a `u8`, 16 for a `u16`, unset for
 * the full 32 — which is what a variable-to-variable operation decomposes over: a narrow
 * variable makes those cheap, and saturates at its maximum (one guard trigger after every
 * addition keeps the value in range, so the decomposition can trust it).
 */
export interface DcVar { kind: "dc"; name: string; player: number; unit: number; bits?: number; at?: VarSource }
export interface SwVar { kind: "switch"; name: string; index: number; at?: VarSource }
export type Var = DcVar | SwVar;

/**
 * Units whose death counters are safe to use as variables: they can never die because
 * nothing can create them — the "(Unused)" entries of units.dat, Cantina first (the
 * community's classic choice). Twelve players per unit, so eighteen units give 216 slots.
 *
 * Numbers in a program are these counters: 0 to 4 294 967 295. A stored result below
 * zero is 0 and one at 2³² or above wraps (the game's own Set Deaths rules; `assign`
 * says how an expression is ordered so that the source's exact sum is what gets stored).
 */
export const VARIABLE_UNITS: readonly number[] = [181, 179, 180, 182, 183, 184, 185, 186, 187, 204, 91, 92, 119, 121, 145, 153, 158, 161];

export const PLAYER_SLOTS = 12;

const dcKey = (player: number, unit: number) => unit * PLAYER_SLOTS + player;

/**
 * Hands out storage: death counters player-major over a pool of units (so the first
 * twelve variables share one unit id), switches from 255 downwards. There is one
 * allocator per compile — every program draws from it, whatever pool it asks for, so
 * two programs can never be handed the same cell — and it starts out with the cells the
 * map's hand triggers and the script's own raw triggers touch already taken.
 */
export class Allocator {
  private readonly usedDc = new Set<number>();
  private readonly usedSw = new Set<number>();
  readonly variables: Var[] = [];

  constructor(options: { reservedDeaths?: readonly (readonly [number, number])[]; reservedSwitches?: readonly number[] } = {}) {
    this.reserve(options.reservedDeaths ?? [], options.reservedSwitches ?? []);
  }

  /** Take cells out of the pool: something else uses them. */
  reserve(deaths: readonly (readonly [number, number])[], switches: readonly number[]) {
    for (const [p, u] of deaths) this.usedDc.add(dcKey(p, u));
    for (const s of switches) this.usedSw.add(s);
  }

  /** The first free death counter of the pool (the default pool when none is given). */
  dc(name: string, units: readonly number[] = VARIABLE_UNITS): DcVar | null {
    for (const unit of units.length ? units : VARIABLE_UNITS) {
      for (let player = 0; player < PLAYER_SLOTS; player++) {
        const key = dcKey(player, unit);
        if (this.usedDc.has(key)) continue;
        this.usedDc.add(key);
        const v: DcVar = { kind: "dc", name, player, unit };
        this.variables.push(v);
        return v;
      }
    }
    return null;
  }

  switch(name: string): SwVar | null {
    for (let index = SWITCH_COUNT - 1; index >= 0; index--) {
      if (this.usedSw.has(index)) continue;
      this.usedSw.add(index);
      const v: SwVar = { kind: "switch", name, index };
      this.variables.push(v);
      return v;
    }
    return null;
  }
}

/** "P3 · Cantina (Unused)" / "Switch 256" — where a variable lives, for the UI. */
export function storageLabel(v: Var): string {
  return v.kind === "dc" ? `P${v.player + 1} · ${unitName(v.unit)}` : `Switch ${v.index + 1}`;
}

/* ── Records ─────────────────────────────────────────────── */

export function deathsCondition(v: DcVar, comparison: number, amount: number): ConditionRecord {
  return { ...emptyCondition(), type: ConditionType.Deaths, player: v.player, unitId: v.unit, comparison, amount: amount >>> 0, flags: ConditionFlag.UnitTypeUsed };
}

export function setDeaths(v: DcVar, modifier: number, amount: number): ActionRecord {
  return { ...emptyAction(), type: ActionType.SetDeaths, player: v.player, unitId: v.unit, modifier, target: amount >>> 0, flags: ActionFlag.UnitTypeUsed };
}

export function switchCondition(v: SwVar, set: boolean): ConditionRecord {
  return { ...emptyCondition(), type: ConditionType.Switch, resource: v.index, comparison: set ? SwitchState.Set : SwitchState.Cleared };
}

export function setSwitch(v: SwVar, action: number): ActionRecord {
  return { ...emptyAction(), type: ActionType.SetSwitch, target: v.index, modifier: action };
}

export const U32_MAX = 0xffffffff;

/** The width a decomposition uses for a variable: its declared one, or all 32 bits. */
export const bitsOf = (v: DcVar): number => v.bits ?? 32;
/** The most a variable of that width holds. */
export const maxOf = (bits: number): number => (bits >= 32 ? U32_MAX : 2 ** bits - 1);
/** Bits needed for a non-negative integer (0 needs none). */
export const bitLength = (n: number): number => (n <= 0 ? 0 : Math.min(32, Math.floor(Math.log2(n)) + 1));

/**
 * The width the value of `c + Σ ±v` needs, from the widths of what goes into it: the widest
 * term or constant, plus room for their sum (each extra addend can carry once).
 */
export function widthOf(expr: Linear): number {
  const widths = expr.terms.filter((t) => t.sign > 0).map((t) => bitsOf(t.v));
  if (expr.c > 0) widths.push(bitLength(expr.c));
  if (widths.length === 0) return 32;
  return Math.min(32, Math.max(...widths) + bitLength(widths.length - 1));
}

/* ── Boolean expressions ─────────────────────────────────── */

export type Bool =
  | { kind: "const"; value: boolean }
  | { kind: "cond"; cond: ConditionRecord }
  | { kind: "not"; expr: Bool }
  | { kind: "and"; items: Bool[] }
  | { kind: "or"; items: Bool[] };

export const TRUE: Bool = { kind: "const", value: true };
export const FALSE: Bool = { kind: "const", value: false };
export const cond = (c: ConditionRecord): Bool => ({ kind: "cond", cond: c });
export const not = (expr: Bool): Bool => ({ kind: "not", expr });
export const and = (items: Bool[]): Bool => ({ kind: "and", items });
export const or = (items: Bool[]): Bool => ({ kind: "or", items });

/**
 * The conditions equivalent to `!c` — a disjunction — or null when the game has no way to
 * say it (then the branch lowering tests `c` and skips). Comparisons flip around their
 * amount: `at least n` ↔ `at most n − 1`, `exactly n` ↔ `at most n − 1 | at least n + 1`.
 */
export function negateCondition(c: ConditionRecord): ConditionRecord[] | null {
  if (c.type === ConditionType.Always) return [{ ...c, type: ConditionType.Never }];
  if (c.type === ConditionType.Never) return [{ ...c, type: ConditionType.Always }];
  if (c.type === ConditionType.Switch) {
    if (c.comparison === SwitchState.Set) return [{ ...c, comparison: SwitchState.Cleared }];
    if (c.comparison === SwitchState.Cleared) return [{ ...c, comparison: SwitchState.Set }];
    return null;
  }
  const def = conditionDef(c.type);
  if (!def?.args.some((a) => a.kind === "comparison" && a.field === "comparison") || !def.args.some((a) => a.kind === "amount" && a.field === "amount")) return null;
  const n = c.amount >>> 0;
  switch (c.comparison) {
    case Comparison.AtLeast: return n === 0 ? [{ ...c, type: ConditionType.Never }] : [{ ...c, comparison: Comparison.AtMost, amount: n - 1 }];
    case Comparison.AtMost: return n === U32_MAX ? [{ ...c, type: ConditionType.Never }] : [{ ...c, comparison: Comparison.AtLeast, amount: n + 1 }];
    case Comparison.Exactly: {
      const out: ConditionRecord[] = [];
      if (n > 0) out.push({ ...c, comparison: Comparison.AtMost, amount: n - 1 });
      if (n < U32_MAX) out.push({ ...c, comparison: Comparison.AtLeast, amount: n + 1 });
      return out;
    }
    default: return null;
  }
}

export interface Literal { cond: ConditionRecord; negative: boolean }

/** A product of literals; `[]` is `true`. */
export type Product = Literal[];

export const MAX_PRODUCTS = 256;

/**
 * Disjunctive normal form: a list of products, any of which passing means the expression
 * holds. `[]` is `false`, `[[]]` is `true`. Negation is pushed to the leaves and resolved
 * through `negateCondition` where the game can express it.
 */
export function toDnf(b: Bool): Product[] {
  switch (b.kind) {
    case "const": return b.value ? [[]] : [];
    case "cond": return [[{ cond: b.cond, negative: false }]];
    case "or": return b.items.flatMap(toDnf);
    case "and": {
      let out: Product[] = [[]];
      for (const item of b.items) {
        const rhs = toDnf(item);
        const next: Product[] = [];
        for (const p of out) for (const q of rhs) next.push([...p, ...q]);
        if (next.length > MAX_PRODUCTS) throw new LowerError(`This condition expands to more than ${MAX_PRODUCTS} cases; split it into nested ifs.`);
        out = next;
      }
      return out;
    }
    case "not": {
      const e = b.expr;
      switch (e.kind) {
        case "const": return e.value ? [] : [[]];
        case "not": return toDnf(e.expr);
        case "and": return toDnf(or(e.items.map(not)));
        case "or": return toDnf(and(e.items.map(not)));
        case "cond": {
          const flipped = negateCondition(e.cond);
          return flipped ? flipped.map((c) => [{ cond: c, negative: false }]) : [[{ cond: e.cond, negative: true }]];
        }
      }
    }
  }
}

export class LowerError extends Error {}

/* ── The machine ─────────────────────────────────────────── */

export interface MachineOptions {
  /** The player the program runs as (0-based). */
  owner: number;
  /** The compile's one allocator, shared with every other program. */
  allocator: Allocator;
  /** The units whose death counters hold this program's variables; the allocator's default pool when empty. */
  units?: readonly number[];
  /** Local string id for a text (see `CompileResult.strings`); comments are dropped when absent. */
  comment?: (text: string) => number;
}

/** The most user actions one step carries: 64 minus the comment and the `pc` set. */
export const STEP_ACTIONS = MAX_ACTIONS - 2;
/** The most conditions one step tests besides `pc`. */
export const STEP_CONDITIONS = MAX_CONDITIONS - 1;

export class Machine {
  readonly owner: number;
  readonly allocator: Allocator;
  private readonly units: readonly number[];
  readonly triggers: TriggerRecord[] = [];
  /** Per trigger, the source line it came from. */
  readonly lines: number[] = [];
  readonly pc: DcVar;
  /** Per source line, a note on why it costs what it costs (a decomposition), for the editor's cost hints. */
  readonly notes = new Map<number, string>();
  /** The state whose steps are being emitted. State 0 is the entry: every counter is 0 at game start. */
  state = 0;
  private nextState = 1;
  private stepsInState = 0;
  private readonly pending: ActionRecord[] = [];
  private pendingLine = 0;
  private pendingLabel = "";
  private readonly comment?: (text: string) => number;
  private readonly temps: DcVar[] = [];
  private tempsInUse = 0;
  private readonly scratches: SwVar[] = [];

  constructor(options: MachineOptions) {
    this.owner = options.owner;
    this.allocator = options.allocator;
    this.units = options.units ?? [];
    this.comment = options.comment;
    const pc = this.dc("(program counter)");
    if (!pc) throw new LowerError("No death counter is free for the program counter.");
    this.pc = pc;
  }

  /** A death counter for this program, from its own pool. */
  dc(name: string): DcVar | null {
    return this.allocator.dc(name, this.units);
  }

  /** A switch for this program. */
  switch(name: string): SwVar | null {
    return this.allocator.switch(name);
  }

  fresh(): number {
    return this.nextState++;
  }

  /** The state that runs when the program has finished: nothing tests it. */
  get halt(): number {
    return 0xffffffff;
  }

  enter(state: number) {
    this.state = state;
    this.stepsInState = 0;
  }

  /** Scratch counters for arithmetic: acquired in a stack, zeroed on acquisition by the caller. */
  temp(): DcVar {
    if (this.tempsInUse === this.temps.length) {
      const t = this.dc(`(temporary ${this.temps.length + 1})`);
      if (!t) throw new LowerError("Out of death counters for temporaries.");
      this.temps.push(t);
    }
    return this.temps[this.tempsInUse++];
  }

  release(n = 1) {
    this.tempsInUse -= n;
  }

  /** Scratch switches for `random()`: one per use within an expression, so two draws are independent. */
  scratch(i: number): SwVar {
    while (this.scratches.length <= i) {
      const s = this.switch(`(scratch switch ${this.scratches.length + 1})`);
      if (!s) throw new LowerError("Out of switches for a scratch switch.");
      this.scratches.push(s);
    }
    return this.scratches[i];
  }

  private raw(conds: ConditionRecord[], actions: ActionRecord[], next: number | null, line: number, label: string) {
    const t = emptyTrigger();
    t.players[this.owner] = 1;
    t.flags = TriggerFlag.Preserve;
    t.conditions = [deathsCondition(this.pc, Comparison.Exactly, this.state), ...conds];
    if (this.comment && label) t.actions.push({ ...emptyAction(), type: ActionType.Comment, text: this.comment(label) });
    t.actions.push(...actions);
    if (next !== null) t.actions.push(setDeaths(this.pc, SetModifier.SetTo, next));
    if (t.conditions.length > MAX_CONDITIONS) throw new LowerError(`A branch tests more than ${STEP_CONDITIONS} conditions at once; split it.`);
    this.triggers.push(t);
    this.lines.push(line);
    this.stepsInState++;
  }

  /** Queue an action for the current state; it is written out with the next step. */
  action(a: ActionRecord, line: number, label: string) {
    if (this.pending.length === 0) { this.pendingLine = line; this.pendingLabel = label; }
    else if (this.pendingLabel !== label && !this.pendingLabel.endsWith(" …")) this.pendingLabel += " …";
    this.pending.push(a);
    if (this.pending.length >= STEP_ACTIONS) this.flush();
  }

  flush() {
    while (this.pending.length) this.raw([], this.pending.splice(0, STEP_ACTIONS), null, this.pendingLine, this.pendingLabel);
  }

  /** One trigger in the current state: extra conditions, actions, and optionally a jump. Pending actions go first. */
  step(conds: ConditionRecord[], actions: ActionRecord[], next: number | null, line: number, label: string) {
    this.flush();
    this.raw(conds, actions, next, line, label);
  }

  /** End the current state: write the pending actions and move to `target`. */
  jump(target: number, line: number, label: string) {
    while (this.pending.length > STEP_ACTIONS) this.raw([], this.pending.splice(0, STEP_ACTIONS), null, this.pendingLine, this.pendingLabel);
    const carried = this.pending.length > 0;
    this.raw([], this.pending.splice(0), target, carried ? this.pendingLine : line, carried ? `${this.pendingLabel} → ${label}` : label);
  }

  /** Jump to a fresh state and continue there. */
  next(line: number, label: string): number {
    const s = this.fresh();
    this.jump(s, line, label);
    this.enter(s);
    return s;
  }

  /**
   * A loop header: the state a back edge returns to. When the current state is still empty
   * it is the header itself — the common `while (true)` at the top of a program then needs
   * no extra trigger.
   */
  loopHeader(line: number, label: string): number {
    if (this.stepsInState === 0 && this.pending.length === 0) return this.state;
    return this.next(line, label);
  }

  /* ── Arithmetic ── */

  set(v: DcVar, n: number, line: number, label: string) {
    if (n > maxOf(bitsOf(v))) throw new LowerError(`${v.name} is a u${bitsOf(v)} and holds 0 … ${maxOf(bitsOf(v))}, not ${n}.`);
    this.action(setDeaths(v, SetModifier.SetTo, n), line, label);
  }

  addConst(v: DcVar, n: number, line: number, label: string) {
    if (n === 0) return;
    this.action(setDeaths(v, n > 0 ? SetModifier.Add : SetModifier.Subtract, Math.abs(n)), line, label);
    if (n > 0) this.clamp(v, line, label);
  }

  /** After an addition to a narrow variable: one trigger that saturates it at its maximum. */
  private clamp(v: DcVar, line: number, label: string) {
    const bits = bitsOf(v);
    if (bits >= 32) return;
    this.step([deathsCondition(v, Comparison.AtLeast, 2 ** bits)], [setDeaths(v, SetModifier.SetTo, maxOf(bits))], null, line, label);
  }

  private note(line: number, bits: number) {
    if (bits >= 32 && !this.notes.has(line)) this.notes.set(line, "A variable-to-variable operation is the binary decomposition: 32 steps in and 32 back per variable. Declare the variable u8 or u16 for 8 + 8 or 16 + 16.");
  }

  /**
   * `dst += src` (or `-=`), `src` intact afterwards: the binary decomposition through a
   * temp, over `bits` bits (`src`'s width, or what the caller knows the value fits in).
   */
  addVar(dst: DcVar, src: DcVar, subtract: boolean, line: number, label: string, bits = bitsOf(src)) {
    this.note(line, bits);
    if (dst === src || (dst.player === src.player && dst.unit === src.unit)) {
      if (subtract) { this.set(dst, 0, line, label); return; }
      // x += x: decompose x into a doubled temp, then move the temp back.
      const t = this.temp();
      this.set(t, 0, line, label);
      for (let k = bits - 1; k >= 0; k--) {
        const bit = 2 ** k;
        if (k === 31) this.step([deathsCondition(src, Comparison.AtLeast, bit)], [setDeaths(src, SetModifier.Subtract, bit)], null, line, label);
        else this.step([deathsCondition(src, Comparison.AtLeast, bit)], [setDeaths(src, SetModifier.Subtract, bit), setDeaths(t, SetModifier.Add, bit * 2)], null, line, label);
      }
      this.move(t, dst, line, label, Math.min(32, bits + 1));
      this.release();
      this.clamp(dst, line, label);
      return;
    }
    const t = this.temp();
    this.set(t, 0, line, label);
    const mod = subtract ? SetModifier.Subtract : SetModifier.Add;
    for (let k = bits - 1; k >= 0; k--) {
      const bit = 2 ** k;
      this.step([deathsCondition(src, Comparison.AtLeast, bit)], [setDeaths(src, SetModifier.Subtract, bit), setDeaths(dst, mod, bit), setDeaths(t, SetModifier.Add, bit)], null, line, label);
    }
    this.move(t, src, line, label, bits);
    this.release();
    if (!subtract) this.clamp(dst, line, label);
  }

  /** `dst += src; src = 0` — half the price of `addVar` when `src` is dead afterwards. The caller clamps `dst` if it needs it. */
  move(src: DcVar, dst: DcVar, line: number, label: string, bits = bitsOf(src)) {
    for (let k = bits - 1; k >= 0; k--) {
      const bit = 2 ** k;
      this.step([deathsCondition(src, Comparison.AtLeast, bit)], [setDeaths(src, SetModifier.Subtract, bit), setDeaths(dst, SetModifier.Add, bit)], null, line, label);
    }
  }

  /**
   * `x = c + Σ ±v`, with the meaning the source has: the sum worked out exactly, then
   * stored — below zero it is 0, at 2³² and above it wraps. Every addition goes first and
   * every subtraction after, whatever order the source wrote them in: the running value
   * then only ever decreases through the subtractions, so it cannot touch zero unless the
   * exact result is below zero, and saturation bites exactly when the store would clamp.
   * (`a = a + b - 5` with `a = 0`, `b = 10` is 5, not 10: subtracting the 5 first would
   * saturate.) Through a temp when `x` itself is a term anywhere but as the single
   * leading `+x`.
   */
  assign(x: DcVar, expr: Linear, line: number, label: string) {
    const sameAs = (a: DcVar, b: DcVar) => a.player === b.player && a.unit === b.unit;
    const self = expr.terms.filter((t) => sameAs(t.v, x));
    const others = expr.terms.filter((t) => !sameAs(t.v, x));
    if (self.length === 1 && self[0].sign > 0) {
      // x = x + rest
      this.accumulate(x, { c: expr.c, terms: others }, line, label);
      return;
    }
    if (self.length === 0) {
      this.set(x, Math.max(0, expr.c), line, label);
      this.accumulate(x, { c: Math.min(0, expr.c), terms: others }, line, label);
      return;
    }
    const t = this.temp();
    this.evaluate(t, expr, line, label);
    this.set(x, 0, line, label);
    this.move(t, x, line, label, widthOf(expr));
    this.release();
    this.clamp(x, line, label);
  }

  /** Compute a linear expression into a temp (zeroed first). */
  evaluate(t: DcVar, expr: Linear, line: number, label: string) {
    this.set(t, Math.max(0, expr.c), line, label);
    this.accumulate(t, { c: Math.min(0, expr.c), terms: expr.terms }, line, label);
  }

  /** `v += expr` in the order `assign` describes: the additions, then the subtractions. */
  private accumulate(v: DcVar, expr: Linear, line: number, label: string) {
    if (expr.c > 0) this.addConst(v, expr.c, line, label);
    for (const t of expr.terms) if (t.sign > 0) this.addVar(v, t.v, false, line, label);
    if (expr.c < 0) this.addConst(v, expr.c, line, label);
    for (const t of expr.terms) if (t.sign < 0) this.addVar(v, t.v, true, line, label);
  }

  /**
   * `a op b` for two counters as a `Bool` over saturating differences computed now, into
   * temps the caller releases after the branch (`releaseAfterCompare`).
   */
  compareVars(a: DcVar, op: CompareOp, b: DcVar, line: number, label: string): { bool: Bool; temps: number } {
    const diff = (p: DcVar, q: DcVar) => {
      const t = this.temp();
      this.set(t, 0, line, label);
      this.addVar(t, p, false, line, label);
      this.addVar(t, q, true, line, label);
      return t;
    };
    const zero = (t: DcVar) => cond(deathsCondition(t, Comparison.Exactly, 0));
    const positive = (t: DcVar) => cond(deathsCondition(t, Comparison.AtLeast, 1));
    switch (op) {
      case "<=": return { bool: zero(diff(a, b)), temps: 1 };
      case ">=": return { bool: zero(diff(b, a)), temps: 1 };
      case "<": return { bool: positive(diff(b, a)), temps: 1 };
      case ">": return { bool: positive(diff(a, b)), temps: 1 };
      case "==": { const d1 = diff(a, b); const d2 = diff(b, a); return { bool: and([zero(d1), zero(d2)]), temps: 2 }; }
      case "!=": { const d1 = diff(a, b); const d2 = diff(b, a); return { bool: or([positive(d1), positive(d2)]), temps: 2 }; }
    }
  }

  /* ── Control flow ── */

  /**
   * End the current state with a conditional jump. Each product of the condition's DNF is
   * one trigger; negative literals are "skip" steps to the next product's state; the last
   * fallthrough goes to `elseState`.
   */
  branch(b: Bool, thenState: number, elseState: number, line: number, label: string) {
    const products = toDnf(b);
    this.flush();
    if (thenState === this.state || elseState === this.state) throw new LowerError("internal: a branch cannot target the state it is tested in.");
    if (products.length === 0) { this.jump(elseState, line, label); return; }
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const last = i === products.length - 1;
      const positives = p.filter((l) => !l.negative).map((l) => l.cond);
      const negatives = p.filter((l) => l.negative).map((l) => l.cond);
      if (positives.length > STEP_CONDITIONS) throw new LowerError(`A branch tests ${positives.length} conditions at once; at most ${STEP_CONDITIONS} fit in one trigger. Split it into nested ifs.`);
      if (positives.length === 0 && negatives.length === 0) {
        // `true`: unconditional; the products after it can never be reached.
        this.raw([], [], thenState, line, label);
        return;
      }
      if (negatives.length) {
        const after = last ? elseState : this.fresh();
        for (const c of negatives) this.raw([c], [], after, line, label);
        this.raw(positives, [], thenState, line, label);
        this.raw([], [], after, line, label);
        this.enter(after);
      } else {
        this.raw(positives, [], thenState, line, label);
        if (last) this.raw([], [], elseState, line, label);
      }
    }
  }

  /** How many temps are held right now; `releaseTo` gives them back after a branch has read them. */
  get tempsHeld(): number {
    return this.tempsInUse;
  }

  releaseTo(n: number) {
    this.tempsInUse = n;
  }
}

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** `c + Σ sign·v` — what the compiler reduces a numeric expression to. */
export interface Linear {
  c: number;
  terms: { v: DcVar; sign: 1 | -1 }[];
}

export function flipOp(op: CompareOp): CompareOp {
  switch (op) {
    case "<": return ">";
    case ">": return "<";
    case "<=": return ">=";
    case ">=": return "<=";
    default: return op;
  }
}

/** `v op n` against a constant, as a game condition (unsigned: `v < 0` is false, `v >= -3` true). */
export function compareConst(v: DcVar, op: CompareOp, n: number): Bool {
  const c = (comparison: number, amount: number) => cond(deathsCondition(v, comparison, amount));
  switch (op) {
    case ">=": return n <= 0 ? TRUE : n > U32_MAX ? FALSE : c(Comparison.AtLeast, n);
    case ">": return n < 0 ? TRUE : n >= U32_MAX ? FALSE : c(Comparison.AtLeast, n + 1);
    case "<=": return n < 0 ? FALSE : n >= U32_MAX ? TRUE : c(Comparison.AtMost, n);
    case "<": return n <= 0 ? FALSE : n > U32_MAX ? TRUE : c(Comparison.AtMost, n - 1);
    case "==": return n < 0 || n > U32_MAX ? FALSE : c(Comparison.Exactly, n);
    case "!=": return n < 0 || n > U32_MAX ? TRUE : not(c(Comparison.Exactly, n));
  }
}

/* ── Hyper triggers ──────────────────────────────────────── */

/**
 * The community's hyper triggers: three preserved triggers of 62 `Wait(0)`s each make the
 * game run the whole trigger loop every frame instead of every two seconds. Owned by one
 * player; their waits stall that player's other `Wait` actions ("wait blocks"), so give
 * them a player whose triggers never wait.
 */
export function hyperTriggers(owner: number, comment?: (text: string) => number): TriggerRecord[] {
  return [0, 1, 2].map(() => {
    const t = emptyTrigger();
    t.players[owner] = 1;
    t.flags = TriggerFlag.Preserve;
    t.conditions.push({ ...emptyCondition(), type: ConditionType.Always });
    if (comment) t.actions.push({ ...emptyAction(), type: ActionType.Comment, text: comment("Hyper trigger") });
    while (t.actions.length < MAX_ACTIONS - 1) t.actions.push({ ...emptyAction(), type: ActionType.Wait, time: 0 });
    t.actions.push({ ...emptyAction(), type: ActionType.PreserveTrigger });
    return t;
  });
}
