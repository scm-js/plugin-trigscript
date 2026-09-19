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
  ActionFlag, Comparison, ConditionFlag, ActionType, ConditionType, emptyAction, emptyCondition, emptyTrigger, MAX_ACTIONS, MAX_CONDITIONS, PLAYER_GROUP_COUNT, PlayerGroup,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { aiScriptByName, type ActionDef, type ArgKind, type ConditionDef } from "../vendor/triggerDefs";
import { ACTION_IDENTS, CANONICAL, choiceOf, choiceWords, CONDITION_IDENTS, scriptParams, TRIGGER_OPTION_NAMES } from "./api";
import { ACTION_FIELDS, CONDITION_FIELDS } from "./record";
import { hyperTriggers, negateCondition, PLAYER_SLOTS } from "./lower";
import { allTables, type ScriptNames } from "./names";
import type { RaceId, ReadSource, TableCell, TextPart, UnitFilter } from "./ir";
import { DEAF_KEYS, keyName, KEY_NAMES, MOUSE_BUTTONS, parseChatPattern, type ChatPattern, type InputSource, type MouseButton } from "./input";
import { PLAYER_COLORS, TABLE_FIELDS, TABLE_SIZE, tableOfBrand, type TableField, type TableKind } from "./tables";

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
  /** Runs for several players at once: every variable is per player. */
  perPlayer: boolean;
}

/** What `seconds(2)`, `minutes(1)` and `frames(5)` return: a length of time for `sleep()`; `cycles` counts frames. */
export interface DurationValue { readonly __trigscript: "duration"; readonly ms?: number; readonly cycles?: number }
export const isDuration = (v: unknown): v is DurationValue => typeof v === "object" && v !== null && (v as DurationValue).__trigscript === "duration";

/**
 * What a read returns when the script is built — `deaths(P1, unit)`, `minerals(P1)`, `race(P2)`: not a
 * number, a description of where the game keeps one. A program's expression takes it as a value
 * (`let ore = minerals(P1)`); anywhere else it is a mistake, and using it in arithmetic when the
 * script is built says so. `equals` makes a boolean of it: `isHuman(p)` is the slot's byte being 2.
 */
export interface ReadValue { readonly __trigscript: "read"; readonly read: ReadSource; readonly equals?: number; readonly ident: string }
export const isRead = (v: unknown): v is ReadValue => typeof v === "object" && v !== null && (v as ReadValue).__trigscript === "read";

/** What `print(text, { to, position })` returns: a program's statement, never a trigger's action. */
export interface PrintValue { readonly __trigscript: "print"; readonly text: string; readonly to: number; readonly position: "chat" | "center" }
export const isPrint = (v: unknown): v is PrintValue => typeof v === "object" && v !== null && (v as PrintValue).__trigscript === "print";

/**
 * What `unitsAt(…)`, `unitsOf(…)` and `allUnits(…)` return when the script is built: which units a
 * `for…of` inside program() runs over. The units themselves exist only in the game.
 */
export interface UnitQueryValue { readonly __trigscript: "units"; readonly filter: UnitFilter; readonly ident: string }
export const isUnitQuery = (v: unknown): v is UnitQueryValue => typeof v === "object" && v !== null && (v as UnitQueryValue).__trigscript === "units";

/** What `first(…)`, `nearest(…)` and `randomUnit(…)` return when the script is built: how the game is to pick one unit. */
export interface UnitPickValue { readonly __trigscript: "pick"; readonly by: "first" | "nearest" | "random"; readonly filter: UnitFilter; readonly near?: number; readonly mouse?: number; readonly within?: number; readonly ident: string }
export const isUnitPick = (v: unknown): v is UnitPickValue => typeof v === "object" && v !== null && (v as UnitPickValue).__trigscript === "pick";

/**
 * A property of `stats(…)`: a cell of the game's tables. Like a read it has no value when the
 * script is built; a program reads it as a number (or a boolean) and assigns to it.
 */
export interface TableValue { readonly __trigscript: "table"; readonly cell: TableCell; readonly field: TableField; readonly ident: string }
export const isTable = (v: unknown): v is TableValue => typeof v === "object" && v !== null && (v as TableValue).__trigscript === "table";

/**
 * What `keyPressed()`, `clicked()`, `mouse(p).x` and a value of `chatted()` are when the script is
 * built: which thing a player does the program is asking about. `boolean`: it reads as true or false.
 */
export interface InputValue { readonly __trigscript: "input"; readonly input: InputSource; readonly boolean: boolean; readonly ident: string }
export const isInput = (v: unknown): v is InputValue => typeof v === "object" && v !== null && (v as InputValue).__trigscript === "input";
/** What `mouse(p)` returns: the two numbers of where a player's mouse is. */
export interface MouseValue { readonly __trigscript: "mouse"; readonly x: InputValue; readonly y: InputValue }
export const isMouse = (v: unknown): v is MouseValue => typeof v === "object" && v !== null && (v as MouseValue).__trigscript === "mouse";
/** What `chatted(p, pattern)` returns: whether a line matching the pattern came in, and the values it carried by their names. */
export interface ChatValue { readonly __trigscript: "chat"; readonly pattern: ChatPattern; readonly matched: InputValue; readonly values: Readonly<Record<string, InputValue>> }
export const isChat = (v: unknown): v is ChatValue => typeof v === "object" && v !== null && (v as ChatValue).__trigscript === "chat";

/** A value only the game has: nothing the script computes when it is built may take it as a number. */
export const isGameValue = (v: unknown): v is ReadValue | TableValue | UnitPickValue | InputValue | MouseValue | ChatValue => isRead(v) || isTable(v) || isUnitPick(v) || isInput(v) || isMouse(v) || isChat(v);

/** The colour byte for what a script wrote as a player colour: a word of `PLAYER_COLORS`, or the byte itself. */
export function playerColor(v: unknown): number {
  if (typeof v === "string") {
    const n = PLAYER_COLORS[v.trim().toLowerCase()];
    if (n === undefined) throw new ScriptError(`Unknown colour ${JSON.stringify(v)}: one of ${Object.keys(PLAYER_COLORS).map((w) => JSON.stringify(w)).join(", ")}.`);
    return n;
  }
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  throw new ScriptError("A player colour is one of colors.*, a word such as \"teal\", or a palette entry from 0 to 255.");
}

/** A function of the library a program's expression calls for a value of the game: never computed when the script is built. */
export interface ReaderFunction { (...args: unknown[]): ReadValue; readonly __trigscript: "reader" }
export const isReader = (v: unknown): v is ReaderFunction => typeof v === "function" && (v as ReaderFunction).__trigscript === "reader";

/**
 * `name(p)` and `color(p)` are text only the game knows, so inside a string they travel as a mark
 * — two private-use characters around a letter and the player — which `textParts` takes out again
 * where a program shows the text. Text is text: the mark survives a template, a `+`, a helper.
 */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const MARK = /\uE000([nc])(\d+)\uE001/g;
export const hasTextMark = (text: string): boolean => text.includes(MARK_OPEN);
const textMark = (letter: "n" | "c", player: number): string => `${MARK_OPEN}${letter}${player}${MARK_CLOSE}`;

/** A text as the parts a `print` has: written text, and the names and colours marked in it. */
export function textParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let from = 0;
  for (const m of text.matchAll(MARK)) {
    if (m.index > from) out.push({ kind: "text", text: text.slice(from, m.index) });
    out.push({ kind: m[1] === "n" ? "name" : "color", player: Number(m[2]) });
    from = m.index + m[0].length;
  }
  if (from < text.length) out.push({ kind: "text", text: text.slice(from) });
  return out;
}

/** The conditions that compare a quantity: leave the comparison and the amount out and the call is a read of it. */
export const READ_ARITY: ReadonlyMap<string, number> = new Map(
  [...CONDITION_IDENTS].filter(([, def]) => def.args.some((a) => a.kind === "comparison") && def.args.some((a) => a.kind === "amount"))
    .map(([ident, def]) => [ident, def.args.length - 2]),
);
/** The library's functions that read the game, by the name a script calls them by. */
export const READER_NAMES = ["minerals", "gas", "resources", "countUnits", "kills", "countdown", "elapsed", "race", "slot", "isHuman", "hasLeft", "supply"] as const;
/** The library's functions about units on the map and the game's tables: the game's too, never computed when the script is built. */
export const UNIT_CALL_NAMES = ["unitsAt", "unitsOf", "allUnits", "first", "nearest", "randomUnit", "underMouse", "stats"] as const;
/** The library's functions about what the players do, and the one that moves a location to a point: the game's as well. */
export const INPUT_CALL_NAMES = ["keyPressed", "clicked", "mouse", "chatted", "centerLocation"] as const;

/**
 * What the transformer turns `program(() => { … })` — and the arrow of `game(…)` — into:
 * where the body is, and a function returning one thunk per hoisted expression and one
 * memoised thunk per build-time constant, called by the compiler when its walk reaches
 * the expression (`HoistedThunks` in `hoist.ts`).
 */
export interface ProgramDescriptor {
  __trigscript: "program";
  at: At;
  /** Position of the arrow function in its file, to find the body again. */
  pos: number;
  hoisted: () => { h: (() => unknown)[]; c: (() => unknown)[] };
}

/**
 * What `game(fn)` returns: a function that throws when the script calls it (it runs in
 * the game, not when the script is built), carrying the descriptor the compiler inlines.
 */
export interface GameFunctionValue {
  (...args: unknown[]): never;
  readonly __trigscript: "gamefn";
  readonly descriptor: ProgramDescriptor;
}

/** A condition or action function of the library, as the compiler sees it: it knows the definition, so an argument can be a variable of a program. */
export interface BuilderFunction {
  /** A comparing condition called without its comparison and amount is a read of what it compares. */
  (...args: unknown[]): ConditionValue | ActionValue | ReadValue;
  readonly __trigscript: "builder";
  readonly kind: "condition" | "action";
  readonly def: ConditionDef | ActionDef;
  readonly ident: string;
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
  /**
   * The script's own statements are running — as opposed to a program's build-time parts, which the
   * compiler asks for afterwards. What a player does has no meaning there, and `if (keyPressed(…))`
   * would quietly be true (it is an object), so those functions refuse while this is set.
   */
  running = false;

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
export const isGameFunction = (v: unknown): v is GameFunctionValue => typeof v === "function" && (v as GameFunctionValue).__trigscript === "gamefn";
export const isBuilder = (v: unknown): v is BuilderFunction => typeof v === "function" && (v as BuilderFunction).__trigscript === "builder";

const condition = (record: ConditionRecord): ConditionValue => ({ __trigscript: "condition", record });
const action = (record: ActionRecord): ActionValue => ({ __trigscript: "action", record });

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  if (isCondition(v)) return "a condition";
  if (isAction(v)) return "an action";
  if (isRead(v)) return `a value the game holds (${v.ident}())`;
  if (isTable(v)) return `a value the game holds (${v.ident})`;
  if (isUnitQuery(v)) return `the units of the game (${v.ident}())`;
  if (isUnitPick(v)) return `a unit of the game (${v.ident}())`;
  if (isInput(v) || isMouse(v) || isChat(v)) return `what a player does in the game (${isInput(v) ? v.ident : isMouse(v) ? "mouse()" : "chatted()"})`;
  if (isPrint(v)) return "a print()";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "function") return "a function";
  return "an object";
}

function integer(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v) >>> 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isRead(v)) throw new ScriptError(`${what}: ${v.ident}() is a value the game holds, read while the game runs. Inside program() assign it to a variable or compare it; a trigger's condition or action takes numbers known when the script is built.`);
  if (isTable(v)) throw new ScriptError(`${what}: ${v.ident} is a value the game holds, read while the game runs. Inside program() assign it to a variable or compare it.`);
  throw new ScriptError(`${what}: expected a number, got ${describe(v)}.`);
}

function flatten(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) flatten(x, out);
  else if (v !== undefined && v !== null && v !== false) out.push(v);
  return out;
}

export interface RuntimeOptions {
  /** Comment actions on the hyper triggers; default true. */
  comments?: boolean;
}

/** The library for one run: the map's names as values plus every function, keyed by the name a script uses. */
export function createRuntime(names: ScriptNames, collector: Collector, options: RuntimeOptions = {}): Record<string, unknown> {
  const rt: Record<string, unknown> = {};
  const comment = options.comments === false ? undefined : (text: string) => collector.localString({ text });

  /* ── Names ── */
  for (const t of allTables(names)) {
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

  const fromDef = (ident: string, def: ConditionDef | ActionDef, kind: "condition" | "action"): BuilderFunction => Object.assign((...args: unknown[]) => {
    const params = scriptParams(def);
    const required = params.filter((p) => !p.optional).length;
    // deaths(P1, unit): the condition without its comparison and amount is a read of what it compares.
    if (kind === "condition" && READ_ARITY.get(ident) === args.length) return readOf(ident, def as ConditionDef, args);
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
  }, { __trigscript: "builder" as const, kind, def, ident });
  const read = (ident: string, source: ReadSource, equals?: number): ReadValue => {
    const fail = (): never => { throw new ScriptError(`${ident}() is a value the game holds, read while the game runs: it has no value when the script is built. Inside program(), assign it to a let or use it in the program's own arithmetic and comparisons.`); };
    return { __trigscript: "read", read: source, ident, ...(equals !== undefined ? { equals } : {}), valueOf: fail, toString: fail } as ReadValue;
  };
  const readOf = (ident: string, def: ConditionDef, args: unknown[]): ReadValue => {
    const record = { ...emptyCondition(), type: def.type, comparison: Comparison.AtLeast } as unknown as Record<string, number>;
    const params = scriptParams(def).filter((p) => p.arg.kind !== "comparison" && p.arg.kind !== "amount");
    params.forEach((p, i) => { record[p.arg.field] = argValue(p.arg.kind, args[i], `${ident}: ${p.name}`); });
    if (def.args.some((a) => a.kind === "unit")) record.flags |= ConditionFlag.UnitTypeUsed;
    return read(ident, { source: "condition", record: record as unknown as ConditionRecord });
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
      if (isRead(x)) throw new ScriptError(`${what}: ${x.ident}() without a comparison reads the value, which only a program can do. In a trigger, give the comparison and the amount: ${x.ident}(…, ">=", 1).`);
      if (isPrint(x)) throw new ScriptError(`${what}: print() is a statement of a program; a trigger shows text with displayText().`);
      if (wrong(x)) throw new ScriptError(`${what}: ${describe(x)} belongs in the ${wrongName} list.`);
      throw new ScriptError(`${what}: expected ${what.endsWith("conditions") ? "conditions such as bring(...)" : "actions such as displayText(...)"}, got ${describe(x)}.`);
    });
  rt.trigger = (players: unknown, conditions: unknown, actions: unknown, options?: unknown, at?: unknown): TriggerValue => {
    const t = emptyTrigger();
    for (const p of playersOf(players, "trigger: players")) t.players[p] = 1;
    t.conditions = items(conditions, isCondition, "trigger: conditions", isAction, "actions").map((c) => ({ ...c.record }));
    t.actions = items(actions, isAction, "trigger: actions", isCondition, "conditions").map((a) => ({ ...a.record }));
    for (const a of t.actions) {
      const s = a.text > 0 ? collector.strings[a.text - 1] : undefined;
      if (s && "text" in s && hasTextMark(s.text)) throw new ScriptError("name() and color() are filled in by a program while the game runs; a trigger's text is fixed when the script is built. Show this text from inside program().");
    }
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
  rt.frames = (n: unknown): DurationValue => ({ __trigscript: "duration", cycles: Math.max(1, Math.round(number(n, "frames"))) });
  // The word from before 3.0, when a program's clock was the trigger cycle; a program's clock is the frame now.
  rt.cycles = (n: unknown): DurationValue => ({ __trigscript: "duration", cycles: Math.max(1, Math.round(number(n, "cycles"))) });
  rt.sleep = () => { throw new ScriptError("sleep() pauses a program: use it inside program(), as a statement — sleep(seconds(2))."); };
  rt.rose = () => { throw new ScriptError("rose() is true on the cycle its condition becomes true: use it inside program(), in an if."); };
  rt.once = () => { throw new ScriptError("once() is true the first time its condition holds: use it inside program(), in an if."); };
  rt.shared = () => { throw new ScriptError("shared() marks a variable every player of a per-player program shares: let total = shared(0), inside program()."); };
  /** A number that may be below zero, as a program's can. */
  const signed = (v: unknown, what: string) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ScriptError(`${what}: expected a number, got ${describe(v)}.`);
    return v;
  };
  rt.u32 = (v: unknown) => signed(v, "u32: value") >>> 0;
  rt.i32 = (v: unknown) => signed(v, "i32: value") | 0;
  rt.clamp = (v: unknown, lo: unknown, hi: unknown) => Math.min(Math.max(signed(v, "clamp: value"), signed(lo, "clamp: low")), signed(hi, "clamp: high"));

  /* ── Reads: what the game holds, as a value of a program ── */
  const reader = (fn: (...args: unknown[]) => ReadValue): ReaderFunction => Object.assign(fn, { __trigscript: "reader" as const });
  // One player: a read is a number, and a group of players has one only where a condition sums it (a condition's read takes a group).
  const onePlayer = (v: unknown, what: string, slots = PLAYER_SLOTS): number => {
    const n = integer(v, what);
    if (n !== PlayerGroup.CurrentPlayer && n >= slots) throw new ScriptError(`${what}: expected one player, P1 … P${slots} or CurrentPlayer.`);
    return n;
  };
  const conditionRead = (ident: string, type: number, fields: Partial<ConditionRecord>): ReadValue =>
    read(ident, { source: "condition", record: { ...emptyCondition(), type, comparison: Comparison.AtLeast, ...fields } });
  const resourceRead = (ident: string, player: unknown, kind: unknown) =>
    conditionRead(ident, ConditionType.Accumulate, { player: argValue("player", player, `${ident}: player`), resource: argValue("resource", kind, `${ident}: resource`) });
  rt.minerals = reader((player) => resourceRead("minerals", player, "ore"));
  rt.gas = reader((player) => resourceRead("gas", player, "gas"));
  rt.resources = reader((player, kind) => resourceRead("resources", player, kind));
  rt.countUnits = reader((player, unit, location) => {
    const fields = { player: argValue("player", player, "countUnits: player"), unitId: argValue("unit", unit, "countUnits: unit"), flags: ConditionFlag.UnitTypeUsed };
    return location === undefined
      ? conditionRead("countUnits", ConditionType.Command, fields)
      : conditionRead("countUnits", ConditionType.Bring, { ...fields, location: argValue("location", location, "countUnits: location") });
  });
  rt.kills = reader((player, unit) => conditionRead("kills", ConditionType.Kill, { player: argValue("player", player, "kills: player"), unitId: argValue("unit", unit, "kills: unit"), flags: ConditionFlag.UnitTypeUsed }));
  rt.countdown = reader(() => conditionRead("countdown", ConditionType.CountdownTimer, {}));
  rt.elapsed = reader(() => conditionRead("elapsed", ConditionType.ElapsedTime, {}));
  rt.races = Object.freeze({ Zerg: 0, Terran: 1, Protoss: 2 });
  rt.slots = Object.freeze({ Empty: 0, Computer: 1, Human: 2, Rescuable: 3, Neutral: 7 });
  rt.race = reader((player) => read("race", { source: "player", fact: "race", player: onePlayer(player, "race: player", 12) }));
  rt.slot = reader((player) => read("slot", { source: "player", fact: "slot", player: onePlayer(player, "slot: player", 12) }));
  rt.isHuman = reader((player) => read("isHuman", { source: "player", fact: "slot", player: onePlayer(player, "isHuman: player", 12) }, 2));
  rt.hasLeft = reader((player) => read("hasLeft", { source: "player", fact: "left", player: onePlayer(player, "hasLeft: player") }, 1));
  rt.supply = reader((player, of = "used", race) => {
    if (of !== "used" && of !== "max" && of !== "provided") throw new ScriptError(`supply: expected "used", "max" or "provided", got ${describe(of)}.`);
    let r: RaceId | null = null;
    if (race !== undefined && race !== null) {
      const n = typeof race === "string" ? ["zerg", "terran", "protoss"].indexOf(race.trim().toLowerCase()) : integer(race, "supply: race");
      if (n !== 0 && n !== 1 && n !== 2) throw new ScriptError(`supply: the race is races.Zerg, races.Terran or races.Protoss, got ${describe(race)}.`);
      r = n;
    }
    return read("supply", { source: "supply", of, race: r, player: onePlayer(player, "supply: player", 12) });
  });

  /* ── Units on the map ── */
  const onlyInProgram = (ident: string, how: string): never => { throw new ScriptError(`${ident}() is about the units in the game, which exist while it runs: ${how}, inside program().`); };
  const filterOf = (ident: string, v: unknown, given: UnitFilter): UnitFilter => {
    const out: UnitFilter = { ...given };
    if (v !== undefined && v !== null) {
      if (typeof v !== "object" || Array.isArray(v) || isGameValue(v)) throw new ScriptError(`${ident}: the filter is an object such as { type: units.TerranMarine, owner: P1, at: locations.Base }, got ${describe(v)}.`);
      for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        if (key !== "type" && key !== "owner" && key !== "at") throw new ScriptError(`${ident}: unknown filter "${key}"; a filter has type, owner and at.`);
        if (out[key] !== undefined) throw new ScriptError(`${ident}: ${key} is already given by the call's own argument.`);
        out[key] = integer(value, `${ident}: ${key}`);
      }
    }
    if (out.owner !== undefined) out.owner = onePlayer(out.owner, `${ident}: owner`, 12);
    if (out.type !== undefined) {
      // Any Unit is no filter at all; Men, Buildings and Factories are the classes a trigger knows.
      if (out.type === 229) delete out.type;
      else if (out.type > 232) throw new ScriptError(`${ident}: type is one of units.*.`);
    }
    // No location, and Anywhere, are everywhere.
    if (out.at !== undefined && (out.at === 0 || out.at === 64)) delete out.at;
    if (out.at !== undefined && out.at > 255) throw new ScriptError(`${ident}: at is one of locations.*.`);
    return out;
  };
  const query = (ident: string, filter: UnitFilter): UnitQueryValue => ({
    __trigscript: "units", filter, ident,
    [Symbol.iterator]: () => onlyInProgram(ident, `write for (const u of ${ident}(…)) { … }`),
  } as UnitQueryValue);
  const pick = (ident: string, by: UnitPickValue["by"], filter: UnitFilter, near?: number): UnitPickValue => {
    const fail = (): never => onlyInProgram(ident, `write const u = ${ident}(…); if (u) { … }`);
    return { __trigscript: "pick", by, filter, ident, ...(near !== undefined ? { near } : {}), valueOf: fail, toString: fail } as UnitPickValue;
  };
  rt.unitsAt = (location: unknown, filter?: unknown) => query("unitsAt", filterOf("unitsAt", filter, { at: argValue("location", location, "unitsAt: location") }));
  rt.unitsOf = (player: unknown, filter?: unknown) => query("unitsOf", filterOf("unitsOf", filter, { owner: integer(player, "unitsOf: player") }));
  rt.allUnits = (filter?: unknown) => query("allUnits", filterOf("allUnits", filter, {}));
  rt.first = (filter?: unknown) => pick("first", "first", filterOf("first", filter, {}));
  rt.randomUnit = (filter?: unknown) => pick("randomUnit", "random", filterOf("randomUnit", filter, {}));
  rt.nearest = (unit: unknown, location: unknown, filter?: unknown) => {
    const near = argValue("location", location, "nearest: location");
    if (near === 0 || near > 255) throw new ScriptError("nearest: the location to be near is one of locations.*.");
    return pick("nearest", "nearest", filterOf("nearest", filter, { type: argValue("unit", unit, "nearest: unit") }), near);
  };

  rt.underMouse = (player: unknown, filter?: unknown) => {
    let within = 48;
    let rest = filter;
    if (filter !== undefined && filter !== null && typeof filter === "object" && !Array.isArray(filter) && "within" in filter) {
      const { within: w, ...others } = filter as Record<string, unknown>;
      rest = others;
      if (w !== undefined && w !== null) {
        if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 4096) throw new ScriptError(`underMouse: within is a distance in pixels, 1 to 4096 (32 is a tile), got ${describe(w)}.`);
        within = w;
      }
    }
    const who = onePlayer(player, "underMouse: player", 8);
    return { ...pick("underMouse", "nearest", filterOf("underMouse", rest, {})), mouse: who, within } as UnitPickValue;
  };

  /* ── What the players do ── */
  const inputValue = (ident: string, input: InputSource, boolean: boolean): InputValue => {
    const fail = (): never => { throw new ScriptError(`${ident} is what a player does while the game runs: it has no value when the script is built. Inside program(), test it in an if or assign it to a let.`); };
    return { __trigscript: "input", input, boolean, ident, valueOf: fail, toString: fail } as InputValue;
  };
  // The players who can press a key: the eight slots a person can sit in.
  const human = (v: unknown, what: string) => {
    if (collector.running) throw new ScriptError(`${what.split(":")[0]}() asks what a player does while the game runs: use it inside program().`);
    return onePlayer(v, what, 8);
  };
  rt.keyPressed = (player: unknown, key: unknown) => {
    const name = typeof key === "string" ? keyName(key) : null;
    const deaf = typeof key === "string" ? DEAF_KEYS[key.trim().toUpperCase()] : undefined;
    if (deaf) throw new ScriptError(`keyPressed: ${deaf}.`);
    if (!name) throw new ScriptError(`keyPressed: the key is one of ${KEY_NAMES.slice(0, 3).map((k) => JSON.stringify(k)).join(", ")} … "F1" … "Space", "Enter", "Escape", "Left" …; got ${describe(key)}.`);
    return inputValue(`keyPressed(…, ${JSON.stringify(name)})`, { source: "key", key: name, player: human(player, "keyPressed: player") }, true);
  };
  rt.clicked = (player: unknown, button: unknown = "left") => {
    const b = typeof button === "string" ? button.trim().toLowerCase() : "";
    if (!(MOUSE_BUTTONS as readonly string[]).includes(b)) throw new ScriptError(`clicked: the button is "left", "right" or "middle", got ${describe(button)}.`);
    return inputValue(`clicked(…, ${JSON.stringify(b)})`, { source: "click", button: b as MouseButton, player: human(player, "clicked: player") }, true);
  };
  rt.mouse = (player: unknown): MouseValue => {
    const who = human(player, "mouse: player");
    return Object.freeze({ __trigscript: "mouse" as const, x: inputValue("mouse(…).x", { source: "mouse", axis: "x", player: who }, false), y: inputValue("mouse(…).y", { source: "mouse", axis: "y", player: who }, false) });
  };
  rt.chatted = (player: unknown, pattern: unknown): ChatValue => {
    if (typeof pattern !== "string") throw new ScriptError(`chatted: the pattern is text such as "-give {n}", got ${describe(pattern)}.`);
    let parsed: ChatPattern;
    try { parsed = parseChatPattern(pattern); } catch (err) { throw new ScriptError(err instanceof Error ? err.message : String(err)); }
    const who = human(player, "chatted: player");
    const values: Record<string, InputValue> = {};
    parsed.captures.forEach((c, i) => { values[c.name] = inputValue(`chatted(…).${c.name}`, { source: "chat", pattern, capture: i, player: who }, false); });
    return Object.freeze({ __trigscript: "chat" as const, pattern: parsed, matched: inputValue("chatted(…)", { source: "chat", pattern, capture: null, player: who }, true), values: Object.freeze(values) });
  };
  rt.centerLocation = () => { throw new ScriptError("centerLocation() moves a location while the game runs: use it inside program(), as a statement — centerLocation(locations.Cursor, x, y)."); };

  /* ── The game's tables ── */
  const tableValue = (kind: TableKind, field: TableField, index: number, ident: string, key?: number): TableValue => {
    const cell: TableCell = {
      name: `${kind}.${field.name}`, base: field.base, stride: field.stride, index, width: field.width,
      ...(key !== undefined ? { key } : {}), ...(field.bit !== undefined ? { bit: field.bit } : {}), ...(field.scale ? { scale: field.scale } : {}),
      ...(kind === "player" ? { player: true } : {}), ...(field.special ? { special: field.special } : {}),
    };
    const fail = (): never => { throw new ScriptError(`${ident} is a value the game holds: it has no value when the script is built. Inside program(), assign to it, assign it to a let, or use it in the program's own arithmetic and comparisons.`); };
    return { __trigscript: "table", cell, field, ident, valueOf: fail, toString: fail } as TableValue;
  };
  /** `stats(x)`; the compiler adds what kind of thing `x` is, which a plain number cannot say. */
  rt.stats = (of: unknown, brand?: unknown) => {
    const kind = typeof brand === "string" ? tableOfBrand(brand) : undefined;
    if (!kind) throw new ScriptError("stats() takes a unit type, a weapon, an upgrade, a technology or a player, written where the compiler can see which: stats(units.TerranMarine), stats(P3) — inside program().");
    const index = kind === "player" ? onePlayer(of, "stats: player", 12) : integer(of, `stats: ${kind}`);
    if (index !== PlayerGroup.CurrentPlayer && index >= TABLE_SIZE[kind]) throw new ScriptError(`stats: ${kind} ${index} is past the table (0–${TABLE_SIZE[kind] - 1}).`);
    const who = `stats(${entryName(kind, index)})`;
    const out: Record<string, unknown> = {};
    for (const field of TABLE_FIELDS[kind]) {
      if (!field.keyed) { out[field.name] = tableValue(kind, field, index, `${who}.${field.name}`); continue; }
      const { kind: keyKind } = field.keyed;
      out[field.name] = Object.freeze(Array.from({ length: TABLE_SIZE[keyKind] }, (_, k) => tableValue(kind, field, index, `${who}.${field.name}[${entryName(keyKind, k)}]`, k)));
    }
    return Object.freeze(out);
  };
  const tableNames: Record<TableKind, ScriptNames[keyof ScriptNames]> = { unit: names.units, weapon: names.weapons, upgrade: names.upgrades, tech: names.techs, player: names.players };
  const entryName = (kind: TableKind, value: number): string => {
    const t = tableNames[kind];
    const e = t.entries.find((x) => x.value === value);
    return e ? `${t.object}.${e.keys[0]}` : String(value);
  };
  rt.colors = Object.freeze({ ...PLAYER_COLORS });

  /* ── Text a program fills in ── */
  rt.name = (player: unknown) => textMark("n", onePlayer(player, "name: player", 12));
  rt.color = (player: unknown) => textMark("c", onePlayer(player, "color: player", 12));
  rt.print = (text: unknown, options?: unknown): PrintValue => {
    if (typeof text !== "string") throw new ScriptError(`print: expected text, got ${describe(text)}.`);
    let to: number = PlayerGroup.CurrentPlayer;
    let position: PrintValue["position"] = "chat";
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") throw new ScriptError(`print: options is an object such as { to: P2 }, got ${describe(options)}.`);
      for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
        if (key === "to") {
          to = integer(value, "print: to");
          const groups: number[] = [PlayerGroup.CurrentPlayer, PlayerGroup.AllPlayers, PlayerGroup.Force1, PlayerGroup.Force2, PlayerGroup.Force3, PlayerGroup.Force4];
          if (to >= PLAYER_SLOTS && !groups.includes(to)) throw new ScriptError(`print: to is a player (P1 … P${PLAYER_SLOTS}), CurrentPlayer, AllPlayers or a force.`);
        } else if (key === "position") {
          if (value !== "chat" && value !== "center") throw new ScriptError(`print: position is "chat" or "center", got ${describe(value)}.`);
          position = value;
        } else throw new ScriptError(`print: unknown option "${key}".`);
      }
    }
    return { __trigscript: "print", text, to, position };
  };

  /* ── Programs ── */
  rt.program = (body: unknown, options?: unknown, at?: unknown) => {
    if (!isProgramDescriptor(body)) {
      throw new ScriptError(typeof body === "function"
        ? "program() takes an arrow function written directly in the call: program(() => { … })."
        : `program() takes an arrow function, got ${describe(body)}.`);
    }
    const out: ProgramOptions = { owners: [0], perPlayer: false };
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
          case "variableUnits":
            throw new ScriptError(`program: "${key}" was for programs built as death-counter triggers. Since TrigScript 3 a program is built by eudplib and has no triggers or death counters of its own; remove the option.`);
          default:
            throw new ScriptError(`program: unknown option "${key}".`);
        }
      }
    }
    collector.entries.push({ kind: "program", descriptor: body, options: out, at: isAt(at) ? at : null });
  };
  rt.random = () => { throw new ScriptError("random() is a coin toss and random(n) a number from 0 to n − 1, both made by the game: use them inside program()."); };

  /* ── Game functions ── */
  rt.game = (body: unknown): GameFunctionValue => {
    if (!isProgramDescriptor(body)) {
      throw new ScriptError(typeof body === "function"
        ? "game() takes an arrow function written directly in the call: game((p: Player, n: number) => { … })."
        : `game() takes an arrow function, got ${describe(body)}.`);
    }
    const fn = () => { throw new ScriptError("A game() function runs in the game: call it inside program() or another game() function, not when the script is built."); };
    return Object.assign(fn, { __trigscript: "gamefn" as const, descriptor: body });
  };

  return rt;
}

const isAt = (v: unknown): v is At => Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";

/** Every name the library exports, for the declarations, the linker's globals and the printer's imports. */
export function runtimeNames(names: ScriptNames): string[] {
  const out = allTables(names).map((t) => t.object);
  for (let i = 0; i < PLAYER_SLOTS; i++) out.push(`P${i + 1}`);
  out.push("CurrentPlayer", "AllPlayers");
  out.push(...CONDITION_IDENTS.keys(), ...ACTION_IDENTS.keys(), "preserve");
  out.push("condition", "action", "memory", "setMemory", "disabled", "not", "trigger", "hyperTriggers", "program", "game", "random");
  out.push("seconds", "minutes", "frames", "cycles", "sleep", "rose", "once", "shared", "clamp", "u32", "i32");
  out.push(...READER_NAMES, "races", "slots", "name", "color", "print");
  out.push(...UNIT_CALL_NAMES, "colors", ...INPUT_CALL_NAMES);
  return out;
}
