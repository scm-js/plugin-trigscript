/**
 * The vocabulary TrigScript shares between its consumers — the generated declarations
 * (`declarations.ts`), the runtime library (`runtime.ts`), the structured compiler and
 * the printer (`print.ts`): which identifier each condition and action goes by, what
 * TypeScript type each argument kind has, and the words the enumerated kinds accept.
 *
 * Identifiers are the `ConditionType` / `ActionType` keys in camel case (`bring`,
 * `displayText`, `killUnitAt`), so the script reads like ordinary code; argument order
 * is the table's, so a text trigger and its script form line up. The one exception is
 * the condition `Switch`, which is a reserved word and goes by `switchIs`.
 */
import {
  ACTION_DEFS, CHOICES, CONDITION_DEFS, type ActionDef, type ArgDef, type ArgKind, type ConditionDef,
} from "../vendor/triggerDefs";
import {
  ActionType, AllianceStatus, Comparison, ConditionType, Order, ResourceType, ScoreType, SetModifier, SwitchAction, SwitchState, TriggerFlag, UnitState,
} from "../vendor/triggers";

function keyOf(table: Record<string, number>, value: number): string | undefined {
  for (const [k, v] of Object.entries(table)) if (v === value) return k;
  return undefined;
}

const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield".split(" "));

/** `DisplayText` → `displayText`; a reserved word gets `Is` (`switch` → `switchIs`). */
export function camel(key: string): string {
  const id = key[0].toLowerCase() + key.slice(1);
  return RESERVED.has(id) ? `${id}Is` : id;
}

export function conditionIdent(type: number): string | undefined {
  const key = keyOf(ConditionType, type);
  return key === undefined ? undefined : camel(key);
}

export function actionIdent(type: number): string | undefined {
  const key = keyOf(ActionType, type);
  return key === undefined ? undefined : camel(key);
}

/** Script identifier → definition. Mission Briefing is a briefing-only condition and has no script form. */
export const CONDITION_IDENTS: ReadonlyMap<string, ConditionDef> = new Map(
  CONDITION_DEFS.filter((d) => d.type !== ConditionType.Briefing).map((d) => [conditionIdent(d.type)!, d]),
);
export const ACTION_IDENTS: ReadonlyMap<string, ActionDef> = new Map(ACTION_DEFS.map((d) => [actionIdent(d.type)!, d]));

/** The names of the string-union types for enumerated argument kinds. */
export const CHOICE_TYPES: Partial<Record<ArgKind, string>> = {
  comparison: "Comparison",
  switchState: "SwitchState",
  switchAction: "SwitchAction",
  modifier: "Modifier",
  unitState: "UnitState",
  order: "OrderKind",
  alliance: "Alliance",
  resource: "ResourceKind",
  score: "ScoreKind",
};

/**
 * The spelling a script uses for each enumerated value: the short, code-like word the
 * declarations offer and the printer writes. Every StarEdit label and text-format alias
 * in `CHOICES` is accepted at run time as well.
 */
export const CANONICAL: Partial<Record<ArgKind, [number, string][]>> = {
  comparison: [[Comparison.AtLeast, ">="], [Comparison.AtMost, "<="], [Comparison.Exactly, "=="]],
  switchState: [[SwitchState.Set, "set"], [SwitchState.Cleared, "cleared"]],
  switchAction: [[SwitchAction.Set, "set"], [SwitchAction.Clear, "clear"], [SwitchAction.Toggle, "toggle"], [SwitchAction.Randomize, "randomize"]],
  modifier: [[SetModifier.SetTo, "set"], [SetModifier.Add, "add"], [SetModifier.Subtract, "subtract"]],
  unitState: [[UnitState.Enable, "enable"], [UnitState.Disable, "disable"], [UnitState.Toggle, "toggle"]],
  order: [[Order.Move, "move"], [Order.Patrol, "patrol"], [Order.Attack, "attack"]],
  alliance: [[AllianceStatus.Enemy, "enemy"], [AllianceStatus.Ally, "ally"], [AllianceStatus.AlliedVictory, "alliedVictory"]],
  resource: [[ResourceType.Ore, "ore"], [ResourceType.Gas, "gas"], [ResourceType.OreAndGas, "oreAndGas"]],
  score: [
    [ScoreType.Total, "total"], [ScoreType.Units, "units"], [ScoreType.Buildings, "buildings"], [ScoreType.UnitsAndBuildings, "unitsAndBuildings"],
    [ScoreType.Kills, "kills"], [ScoreType.Razings, "razings"], [ScoreType.KillsAndRazings, "killsAndRazings"], [ScoreType.Custom, "custom"],
  ],
};

/** The canonical word for a value, else the table's label. */
export function choiceWord(kind: ArgKind, value: number): string | undefined {
  const hit = CANONICAL[kind]?.find(([v]) => v === value);
  if (hit) return hit[1];
  return CHOICES[kind]?.find((c) => c.value === value)?.label;
}

/** The value a word means — canonical spellings and StarEdit's labels and aliases alike; case does not matter. */
export function choiceOf(kind: ArgKind, text: string): number | undefined {
  const key = text.trim().toLowerCase();
  const hit = CANONICAL[kind]?.find(([, w]) => w.toLowerCase() === key);
  if (hit) return hit[0];
  const list = CHOICES[kind];
  if (!list) return undefined;
  for (const c of list) {
    if (c.label.toLowerCase() === key) return c.value;
    if (c.aliases?.some((al) => al.toLowerCase() === key)) return c.value;
  }
  return undefined;
}

/** The canonical words of a kind, in table order. */
export function choiceWords(kind: ArgKind): string[] {
  return (CANONICAL[kind] ?? []).map(([, w]) => w);
}

/** The TypeScript type of an argument of this kind. */
export function argType(kind: ArgKind): string {
  switch (kind) {
    case "player": return "Player";
    case "unit": return "Unit";
    case "location": return "Location";
    case "switch": return "Switch";
    case "text": case "wav": return "string";
    case "aiScript": return "AiScript | string";
    case "count": return "Count";
    case "textFlags": return "boolean";
    case "number": case "amount": case "duration": case "percent": case "cuwp": case "slot": return "number";
    default: return `${CHOICE_TYPES[kind] ?? "number"} | number`;
  }
}

/** A parameter name for an argument label: `Unit at` → `unitAt`; reserved words get a trailing underscore. */
export function paramName(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const id = words.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("");
  if (/^\d/.test(id) || id === "") return `_${id}`;
  return RESERVED.has(id) ? `${id}_` : id;
}

export interface ScriptParam {
  arg: ArgDef<string>;
  name: string;
  optional: boolean;
}

/**
 * The parameters of a condition or action as the script takes them: the table's
 * arguments in order, except that a text action's "Always Display" flag comes last as
 * an optional boolean (`displayText("hello")` displays always; pass `false` not to).
 */
export function scriptParams(def: ConditionDef | ActionDef): ScriptParam[] {
  const used = new Set<string>();
  const name = (label: string) => {
    let p = paramName(label);
    while (used.has(p)) p = `${p}_`;
    used.add(p);
    return p;
  };
  const main: ScriptParam[] = def.args.filter((a) => a.kind !== "textFlags").map((arg) => ({ arg, name: name(arg.label), optional: false }));
  const flag = def.args.find((a) => a.kind === "textFlags");
  return flag ? [...main, { arg: flag, name: "always", optional: true }] : main;
}

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A property key as it appears in a declaration: bare when it is an identifier, quoted otherwise. */
export function propertyKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** A member access as it appears in a script: `units.TerranMarine` or `units["Terran Marine"]`. */
export function memberAccess(object: string, key: string): string {
  return IDENTIFIER.test(key) ? `${object}.${key}` : `${object}[${JSON.stringify(key)}]`;
}

/** The trigger options' flags, by bit, as `trigger(…, { preserve: true })` spells them. */
export const TRIGGER_OPTION_NAMES: [number, string][] = [
  [TriggerFlag.Preserve, "preserve"],
  [TriggerFlag.Disabled, "disabled"],
  [TriggerFlag.IgnoreGameEnd, "ignoreGameEnd"],
  [TriggerFlag.IgnoreDisplay, "ignoreDisplay"],
  [TriggerFlag.ConditionsMet, "conditionsMet"],
  [TriggerFlag.Paused, "paused"],
  [TriggerFlag.WaitSkipDisabled, "waitSkipDisabled"],
];

/** The module a script imports the library from. */
export const MODULE_NAME = "trigscript";
