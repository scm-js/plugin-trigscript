/**
 * The `trigscript` library as a script sees it at build time: ordinary functions that
 * *record* triggers. A script is real TypeScript that runs (in a worker) when it is
 * built; every `trigger()` it calls, directly or through whatever helpers it wrote,
 * pushes one record onto the collector, and `program()` pushes a marker that the
 * structured compiler later turns into a run of state-machine triggers.
 *
 * Conditions and actions are values (`bring(...)` returns a `Condition`), which is what
 * makes composition free — keep them in arrays, return them from functions, spread them.
 * Every enumerated argument takes the canonical word (`">="`, `"add"`) or StarEdit's own
 * label; a bad argument throws, and the runner reports it at the line that called.
 *
 * Nothing here touches TypeScript or the DOM: the same code runs under vitest.
 */
import {
  ActionFlag, ConditionFlag, ActionType, ConditionType, emptyAction, emptyCondition, emptyTrigger, MAX_ACTIONS, MAX_CONDITIONS, PLAYER_GROUP_COUNT, PlayerGroup,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { aiScriptByName, type ActionDef, type ArgKind, type ConditionDef } from "../vendor/triggerDefs";
import { ACTION_IDENTS, CANONICAL, choiceOf, choiceWords, CONDITION_IDENTS, scriptParams, TRIGGER_OPTION_NAMES } from "./api";
import { ACTION_FIELDS, CONDITION_FIELDS } from "./record";
import { hyperTriggers, negateCondition, PLAYER_SLOTS } from "./lower";
import type { ScriptNames } from "./names";

/** `memory(address, …)` reads `deaths` at player `EPD(address)`, unit 0: the deaths table starts here in 1.16.1's memory. */
export const DEATHS_TABLE_ADDRESS = 0x58a364;

/** A string a record refers to: text to intern, or an existing string-table index (raw forms). */
export type ScriptString = { text: string } | { index: number };

/** A source position the transformer stamps on calls: file index and 1-based line. */
export type At = [file: number, line: number];

export interface ConditionValue { readonly __trigscript: "condition"; readonly record: ConditionRecord }
export interface ActionValue { readonly __trigscript: "action"; readonly record: ActionRecord }
export interface TriggerValue { readonly __trigscript: "trigger"; readonly record: TriggerRecord }

export interface ProgramOptions {
  /** The player groups the program runs for: one slot, or All Players, a force, several slots. */
  owners: number[];
  /** Runs for several players at once: every variable is per player (see `Machine`). */
  perPlayer: boolean;
  comments: boolean;
  variableUnits: number[];
}

/** What `seconds(2)`, `minutes(1)` and `cycles(5)` return: a length of time `sleep()` turns into trigger cycles when the program is compiled. */
export interface DurationValue { readonly __trigscript: "duration"; readonly ms?: number; readonly cycles?: number }
export const isDuration = (v: unknown): v is DurationValue => typeof v === "object" && v !== null && (v as DurationValue).__trigscript === "duration";

/**
 * What the transformer turns `program(() => { … })` into: where the body is, and a
 * function that declares the body's build-time constants and returns one thunk per
 * hoisted expression — called by the compiler when its walk reaches the expression.
 */
export interface ProgramDescriptor {
  __trigscript: "program";
  at: At;
  /** Position of the arrow function in its file, to find the body again. */
  pos: number;
  hoisted: () => (() => unknown)[];
}

export type Entry =
  | { kind: "trigger"; record: TriggerRecord; at: At | null }
  | { kind: "program"; descriptor: ProgramDescriptor; options: ProgramOptions; at: At | null };

/** Thrown for a bad argument; the runner reports it at the calling line. */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

/** What a run of the script produces, in execution order. */
export class Collector {
  readonly entries: Entry[] = [];
  readonly strings: ScriptString[] = [];
  /** The script emitted hyper triggers: the trigger loop runs twelve times a second, not once in two. */
  hyper = false;

  localString(s: ScriptString): number {
    const at = this.strings.findIndex((x) => ("text" in x && "text" in s ? x.text === s.text : "index" in x && "index" in s && x.index === s.index));
    if (at >= 0) return at + 1;
    this.strings.push(s);
    return this.strings.length;
  }
}

export const isCondition = (v: unknown): v is ConditionValue => typeof v === "object" && v !== null && (v as ConditionValue).__trigscript === "condition";
export const isAction = (v: unknown): v is ActionValue => typeof v === "object" && v !== null && (v as ActionValue).__trigscript === "action";
export const isTrigger = (v: unknown): v is TriggerValue => typeof v === "object" && v !== null && (v as TriggerValue).__trigscript === "trigger";
export const isProgramDescriptor = (v: unknown): v is ProgramDescriptor => typeof v === "object" && v !== null && (v as ProgramDescriptor).__trigscript === "program";

const condition = (record: ConditionRecord): ConditionValue => ({ __trigscript: "condition", record });
const action = (record: ActionRecord): ActionValue => ({ __trigscript: "action", record });

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  if (isCondition(v)) return "a condition";
  if (isAction(v)) return "an action";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "function") return "a function";
  return "an object";
}

function integer(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v) >>> 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new ScriptError(`${what}: expected a number, got ${describe(v)}.`);
}

function flatten(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) flatten(x, out);
  else if (v !== undefined && v !== null && v !== false) out.push(v);
  return out;
}

export interface RuntimeOptions {
  /** Comment actions on the hyper triggers (and, for programs, every generated trigger); default true. */
  comments?: boolean;
}

/** The library for one run: the map's names as values plus every function, keyed by the name a script uses. */
export function createRuntime(names: ScriptNames, collector: Collector, options: RuntimeOptions = {}): Record<string, unknown> {
  const rt: Record<string, unknown> = {};
  const comment = options.comments === false ? undefined : (text: string) => collector.localString({ text });

  /* ── Names ── */
  for (const t of [names.players, names.units, names.locations, names.switches, names.aiScripts]) {
    const table: Record<string, number> = {};
    for (const e of t.entries) for (const k of e.keys) table[k] = e.value;
    rt[t.object] = Object.freeze(table);
  }
  for (let i = 0; i < PLAYER_SLOTS; i++) rt[`P${i + 1}`] = i;
  rt.CurrentPlayer = PlayerGroup.CurrentPlayer;
  rt.AllPlayers = PlayerGroup.AllPlayers;

  /* ── Arguments ── */
  const argValue = (kind: ArgKind, v: unknown, what: string): number => {
    switch (kind) {
      case "text": case "wav":
        if (typeof v === "string") return v === "" ? 0 : collector.localString({ text: v });
        if (typeof v === "number") return v === 0 ? 0 : collector.localString({ index: integer(v, what) });
        throw new ScriptError(`${what}: expected text, got ${describe(v)}.`);
      case "count":
        if (typeof v === "string") { if (v.trim().toLowerCase() === "all") return 0; throw new ScriptError(`${what}: expected a count or "All", got ${describe(v)}.`); }
        return integer(v, what);
      case "aiScript":
        if (typeof v === "string") { const code = aiScriptByName(v); if (code === undefined) throw new ScriptError(`${what}: unknown AI script ${describe(v)}.`); return code; }
        return integer(v, what);
      case "textFlags":
        return v === undefined || v === true ? ActionFlag.AlwaysDisplay : v === false ? 0 : integer(v, what) & ActionFlag.AlwaysDisplay;
      default:
        if (typeof v === "string") {
          if (!CANONICAL[kind]) throw new ScriptError(`${what}: expected a number, got ${describe(v)}.`);
          const n = choiceOf(kind, v);
          if (n === undefined) throw new ScriptError(`${what}: unknown ${kind} ${describe(v)}: one of ${choiceWords(kind).map((w) => JSON.stringify(w)).join(", ")}.`);
          return n;
        }
        return integer(v, what);
    }
  };

  const fromDef = (ident: string, def: ConditionDef | ActionDef, kind: "condition" | "action") => (...args: unknown[]) => {
    const params = scriptParams(def);
    const required = params.filter((p) => !p.optional).length;
    if (args.length < required || args.length > params.length) {
      throw new ScriptError(`${ident} takes ${required === params.length ? required : `${required} to ${params.length}`} argument${params.length === 1 ? "" : "s"}, got ${args.length}.`);
    }
    const record = (kind === "condition" ? { ...emptyCondition(), type: def.type } : { ...emptyAction(), type: def.type }) as unknown as Record<string, number>;
    params.forEach((p, i) => {
      const v = argValue(p.arg.kind, args[i], `${ident}: ${p.name}`);
      if (p.arg.kind === "textFlags") record.flags = (record.flags & ~ActionFlag.AlwaysDisplay) | v;
      else record[p.arg.field] = v;
    });
    if (def.args.some((a) => a.kind === "unit")) record.flags |= kind === "condition" ? ConditionFlag.UnitTypeUsed : ActionFlag.UnitTypeUsed;
    return kind === "condition" ? condition(record as unknown as ConditionRecord) : action(record as unknown as ActionRecord);
  };
  for (const [ident, def] of CONDITION_IDENTS) rt[ident] = fromDef(ident, def, "condition");
  for (const [ident, def] of ACTION_IDENTS) rt[ident] = fromDef(ident, def, "action");
  rt.preserve = rt.preserveTrigger;

  /* ── Raw and EUD forms ── */
  const raw = (kind: "condition" | "action") => (...args: unknown[]) => {
    const fields: readonly string[] = kind === "condition" ? CONDITION_FIELDS : ACTION_FIELDS;
    const record = (kind === "condition" ? emptyCondition() : emptyAction()) as unknown as Record<string, number>;
    args.forEach((a, i) => { if (i < fields.length) record[fields[i]] = integer(a, `${kind}(): ${fields[i]}`); });
    // Raw text / wav numbers are string-table indices as written.
    if (kind === "action") for (const f of ["text", "wav"] as const) if (record[f]) record[f] = collector.localString({ index: record[f] });
    return kind === "condition" ? condition(record as unknown as ConditionRecord) : action(record as unknown as ActionRecord);
  };
  rt.condition = raw("condition");
  rt.action = raw("action");
  const epd = (address: unknown, what: string) => {
    const n = integer(address, what);
    if (n % 4 !== 0) throw new ScriptError(`${what}: expected a 4-byte-aligned memory address.`);
    return ((n - DEATHS_TABLE_ADDRESS) / 4) >>> 0;
  };
  rt.memory = (address: unknown, comparison: unknown, value: unknown) =>
    condition({ ...emptyCondition(), type: ConditionType.Deaths, player: epd(address, "memory: address"), unitId: 0, comparison: argValue("comparison", comparison, "memory: comparison"), amount: integer(value, "memory: value") });
  rt.setMemory = (address: unknown, modifier: unknown, value: unknown) =>
    action({ ...emptyAction(), type: ActionType.SetDeaths, player: epd(address, "setMemory: address"), unitId: 0, modifier: argValue("modifier", modifier, "setMemory: modifier"), target: integer(value, "setMemory: value") });
  rt.disabled = (item: unknown) => {
    if (isCondition(item)) return condition({ ...item.record, flags: item.record.flags | ConditionFlag.Disabled });
    if (isAction(item)) return action({ ...item.record, flags: item.record.flags | ActionFlag.Disabled });
    throw new ScriptError(`disabled() takes a condition or an action, got ${describe(item)}.`);
  };
  // The opposite of a condition where one trigger condition can say it: a comparison flips ("at least 3" → "at most 2"),
  // a switch flips, always ↔ never. "Not exactly 3" is two conditions either of which may hold, which a list cannot say.
  rt.not = (item: unknown) => {
    if (!isCondition(item)) throw new ScriptError(`not() takes a condition, got ${describe(item)}.`);
    const flipped = negateCondition(item.record);
    if (!flipped || flipped.length !== 1) throw new ScriptError("The game has no single condition for the opposite of this one; inside program(), if (!…) can test it.");
    return condition(flipped[0]);
  };

  /* ── Triggers ── */
  // An empty list is allowed: a trigger nobody owns is valid data that never runs (the editor's own New Trigger makes one).
  const playersOf = (v: unknown, what: string): number[] => {
    if (v === undefined || v === null) throw new ScriptError(`${what}: expected a player or a list of players.`);
    return flatten(v).map((p) => {
      const n = integer(p, what);
      if (n >= PLAYER_GROUP_COUNT) throw new ScriptError(`${what}: player group ${n} is out of range (0–${PLAYER_GROUP_COUNT - 1}).`);
      return n;
    });
  };
  const items = <T>(v: unknown, test: (x: unknown) => x is T, what: string, wrong: (x: unknown) => x is unknown, wrongName: string): T[] =>
    flatten(v).map((x) => {
      if (test(x)) return x;
      if (wrong(x)) throw new ScriptError(`${what}: ${describe(x)} belongs in the ${wrongName} list.`);
      throw new ScriptError(`${what}: expected ${what.endsWith("conditions") ? "conditions such as bring(...)" : "actions such as displayText(...)"}, got ${describe(x)}.`);
    });
  rt.trigger = (players: unknown, conditions: unknown, actions: unknown, options?: unknown, at?: unknown): TriggerValue => {
    const t = emptyTrigger();
    for (const p of playersOf(players, "trigger: players")) t.players[p] = 1;
    t.conditions = items(conditions, isCondition, "trigger: conditions", isAction, "actions").map((c) => ({ ...c.record }));
    t.actions = items(actions, isAction, "trigger: actions", isCondition, "conditions").map((a) => ({ ...a.record }));
    if (t.conditions.length > MAX_CONDITIONS) throw new ScriptError(`A trigger holds at most ${MAX_CONDITIONS} conditions (got ${t.conditions.length}).`);
    if (t.actions.length > MAX_ACTIONS) throw new ScriptError(`A trigger holds at most ${MAX_ACTIONS} actions (got ${t.actions.length}).`);
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") throw new ScriptError(`trigger: options is an object such as { preserve: true }, got ${describe(options)}.`);
      for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
        if (key === "flags") { t.flags |= integer(value, "trigger: flags"); continue; }
        const hit = TRIGGER_OPTION_NAMES.find(([, name]) => name === key);
        if (!hit) throw new ScriptError(`trigger: unknown option "${key}".`);
        if (value) t.flags |= hit[0];
      }
    }
    collector.entries.push({ kind: "trigger", record: t, at: isAt(at) ? at : null });
    return { __trigscript: "trigger", record: t };
  };
  rt.hyperTriggers = (owner: unknown = 0) => {
    const p = integer(owner, "hyperTriggers: owner");
    if (p >= PLAYER_SLOTS) throw new ScriptError(`hyperTriggers: the owner is a single player, P1 … P${PLAYER_SLOTS}.`);
    for (const record of hyperTriggers(p, comment)) collector.entries.push({ kind: "trigger", record, at: null });
    collector.hyper = true;
  };

  /* ── Time, and what only a program can do ── */
  const number = (v: unknown, what: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ScriptError(`${what}: expected a number of at least 0, got ${describe(v)}.`);
    return v;
  };
  rt.seconds = (n: unknown): DurationValue => ({ __trigscript: "duration", ms: number(n, "seconds") * 1000 });
  rt.minutes = (n: unknown): DurationValue => ({ __trigscript: "duration", ms: number(n, "minutes") * 60_000 });
  rt.cycles = (n: unknown): DurationValue => ({ __trigscript: "duration", cycles: Math.max(1, Math.round(number(n, "cycles"))) });
  rt.sleep = () => { throw new ScriptError("sleep() pauses a program: use it inside program(), as a statement — sleep(seconds(2))."); };
  rt.rose = () => { throw new ScriptError("rose() is true on the cycle its condition becomes true: use it inside program(), in an if."); };
  rt.once = () => { throw new ScriptError("once() is true the first time its condition holds: use it inside program(), in an if."); };
  rt.shared = () => { throw new ScriptError("shared() marks a variable every player of a per-player program shares: let total = shared(0), inside program()."); };

  /* ── Programs ── */
  rt.program = (body: unknown, options?: unknown, at?: unknown) => {
    if (!isProgramDescriptor(body)) {
      throw new ScriptError(typeof body === "function"
        ? "program() takes an arrow function written directly in the call: program(() => { … })."
        : `program() takes an arrow function, got ${describe(body)}.`);
    }
    const out: ProgramOptions = { owners: [0], perPlayer: false, comments: comment !== undefined, variableUnits: [] };
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") throw new ScriptError(`program: options is an object such as { owner: P2 }, got ${describe(options)}.`);
      for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
        switch (key) {
          case "owner": {
            const owners = playersOf(value, "program: owner");
            if (owners.length === 0) throw new ScriptError("program: owner is a player, All Players, a force, or a list of players.");
            const groups: number[] = [PlayerGroup.AllPlayers, PlayerGroup.Force1, PlayerGroup.Force2, PlayerGroup.Force3, PlayerGroup.Force4];
            for (const o of owners) if (o >= PLAYER_SLOTS && !groups.includes(o)) throw new ScriptError(`program: the owner is a player (P1 … P${PLAYER_SLOTS}), AllPlayers, a force (players.Force1), or a list of players — the program runs once for each of them, with CurrentPlayer as that player.`);
            out.owners = [...new Set(owners)];
            out.perPlayer = out.owners.length > 1 || out.owners[0] >= PLAYER_SLOTS;
            break;
          }
          case "comments":
            if (typeof value !== "boolean") throw new ScriptError("program: comments is true or false.");
            out.comments = value;
            break;
          case "variableUnits":
            out.variableUnits = flatten(value).map((u) => integer(u, "program: variableUnits"));
            break;
          default:
            throw new ScriptError(`program: unknown option "${key}".`);
        }
      }
    }
    collector.entries.push({ kind: "program", descriptor: body, options: out, at: isAt(at) ? at : null });
  };
  rt.random = () => { throw new ScriptError("random() is a coin toss the game makes: use it inside program(), in an if, a while or an assignment."); };

  return rt;
}

const isAt = (v: unknown): v is At => Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";

/** Every name the library exports, for the declarations, the linker's globals and the printer's imports. */
export function runtimeNames(names: ScriptNames): string[] {
  const out = [names.players.object, names.units.object, names.locations.object, names.switches.object, names.aiScripts.object];
  for (let i = 0; i < PLAYER_SLOTS; i++) out.push(`P${i + 1}`);
  out.push("CurrentPlayer", "AllPlayers");
  out.push(...CONDITION_IDENTS.keys(), ...ACTION_IDENTS.keys(), "preserve");
  out.push("condition", "action", "memory", "setMemory", "disabled", "not", "trigger", "hyperTriggers", "program", "random");
  out.push("seconds", "minutes", "cycles", "sleep", "rose", "once", "shared");
  return out;
}
