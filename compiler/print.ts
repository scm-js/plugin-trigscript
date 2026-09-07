/**
 * Triggers → script: the inverse of the raw level, so hand-made triggers can be
 * "ejected" into the TrigScript editor and a generated block can be inspected as
 * source. Uses the first key of each name-table entry (`units.TerranMarine`,
 * `locations["Beacon Alpha"]` when the name is not an identifier), a bare number for
 * anything the tables do not cover, and the raw `condition(...)` / `action(...)` forms
 * for unknown types — so any record prints, and printing then running gives the record
 * back.
 */
import { ActionFlag, ConditionFlag, PlayerGroup, type ActionRecord, type ConditionRecord, type TriggerRecord } from "../vendor/triggers";
import { actionDef, aiScriptName, conditionDef, type ArgKind } from "../vendor/triggerDefs";
import { actionIdent, choiceWord, conditionIdent, memberAccess, MODULE_NAME, scriptParams, TRIGGER_OPTION_NAMES } from "./api";
import { entryFor, type NameTable, type ScriptNames } from "./names";
import { ACTION_FIELDS, CONDITION_FIELDS } from "./record";

export interface PrintContext {
  names: ScriptNames;
  /** Text of a string-table entry, null when unset. */
  string(index: number): string | null;
  /** Filled in as the printer goes: every library name the output uses, for the import line. */
  used?: Set<string>;
}

function use(ctx: PrintContext, name: string): string {
  ctx.used?.add(name);
  return name;
}

function ref(table: NameTable, value: number, ctx: PrintContext): string {
  const e = entryFor(table, value);
  return e ? memberAccess(use(ctx, table.object), e.keys[0]) : String(value);
}

export function playerRef(ctx: PrintContext, value: number): string {
  if (value >= 0 && value < 12) return use(ctx, `P${value + 1}`);
  if (value === PlayerGroup.CurrentPlayer) return use(ctx, "CurrentPlayer");
  if (value === PlayerGroup.AllPlayers) return use(ctx, "AllPlayers");
  return ref(ctx.names.players, value, ctx);
}

function formatValue(kind: ArgKind, value: number, ctx: PrintContext): string {
  switch (kind) {
    case "player": return playerRef(ctx, value);
    case "unit": return ref(ctx.names.units, value, ctx);
    case "location": return ref(ctx.names.locations, value, ctx);
    case "switch": return ref(ctx.names.switches, value, ctx);
    case "aiScript": {
      const e = entryFor(ctx.names.aiScripts, value);
      return e ? memberAccess(use(ctx, ctx.names.aiScripts.object), e.keys[0]) : JSON.stringify(aiScriptName(value));
    }
    case "text": case "wav": return JSON.stringify(ctx.string(value) ?? "");
    case "count": return value === 0 ? '"All"' : String(value);
    case "number": case "amount": case "duration": case "percent": case "cuwp": case "slot": return String(value);
    default: {
      const word = choiceWord(kind, value);
      return word ? JSON.stringify(word) : String(value);
    }
  }
}

function wrapDisabled(text: string, off: boolean, ctx: PrintContext) {
  return off ? `${use(ctx, "disabled")}(${text})` : text;
}

export function printCondition(c: ConditionRecord, ctx: PrintContext): string {
  const def = conditionDef(c.type);
  const ident = conditionIdent(c.type);
  const off = (c.flags & ConditionFlag.Disabled) !== 0;
  if (!def || !ident || ident === "briefing") {
    const r = c as unknown as Record<string, number>;
    return wrapDisabled(`${use(ctx, "condition")}(${CONDITION_FIELDS.map((f) => r[f]).join(", ")})`, off, ctx);
  }
  const args = scriptParams(def).map((p) => formatValue(p.arg.kind, (c as unknown as Record<string, number>)[p.arg.field], ctx));
  return wrapDisabled(`${use(ctx, ident)}(${args.join(", ")})`, off, ctx);
}

export function printAction(a: ActionRecord, ctx: PrintContext): string {
  const def = actionDef(a.type);
  const ident = actionIdent(a.type);
  const off = (a.flags & ActionFlag.Disabled) !== 0;
  const r = a as unknown as Record<string, number>;
  if (!def || !ident) return wrapDisabled(`${use(ctx, "action")}(${ACTION_FIELDS.map((f) => r[f]).join(", ")})`, off, ctx);
  const args: string[] = [];
  for (const p of scriptParams(def)) {
    if (p.arg.kind === "textFlags") { if (!(r.flags & ActionFlag.AlwaysDisplay)) args.push("false"); continue; }
    args.push(formatValue(p.arg.kind, r[p.arg.field], ctx));
  }
  return wrapDisabled(`${use(ctx, ident)}(${args.join(", ")})`, off, ctx);
}

function block(items: string[]): string {
  return items.length ? `[\n${items.map((s) => `  ${s},`).join("\n")}\n]` : "[]";
}

export function printTrigger(t: TriggerRecord, ctx: PrintContext): string {
  const players: string[] = [];
  t.players.forEach((v, i) => { if (v) players.push(playerRef(ctx, i)); });
  const known = TRIGGER_OPTION_NAMES.reduce((m, [bit]) => m | bit, 0);
  const options: string[] = TRIGGER_OPTION_NAMES.filter(([bit]) => t.flags & bit).map(([, name]) => `${name}: true`);
  if (t.flags & ~known) options.push(`flags: 0x${(t.flags & ~known).toString(16)}`);
  const parts = [
    players.length === 1 ? players[0] : `[${players.join(", ")}]`,
    block(t.conditions.map((c) => printCondition(c, ctx))),
    block(t.actions.map((a) => printAction(a, ctx))),
  ];
  if (options.length) parts.push(`{ ${options.join(", ")} }`);
  return `${use(ctx, "trigger")}(${parts.join(", ")});`;
}

export const SCRIPT_HEADER = `// TrigScript — built into a block of the map's trigger list.
// Each trigger(players, conditions, actions, options?) call becomes one trigger, in order.
`;

export interface PrintOptions {
  /** The comment at the top; `SCRIPT_HEADER` by default, "" for none. */
  header?: string;
  /** Start with an import of the library names the script uses (they are also globals, so a fragment appended to a file needs none). */
  imports?: boolean;
}

export function printScript(triggers: TriggerRecord[], ctx: PrintContext, options: PrintOptions = {}): string {
  const header = options.header ?? SCRIPT_HEADER;
  const used = new Set<string>();
  const body = triggers.length ? triggers.map((t) => printTrigger(t, { ...ctx, used })).join("\n\n") + "\n" : "";
  const imports = options.imports && used.size ? `import { ${[...used].sort().join(", ")} } from "${MODULE_NAME}";\n` : "";
  return [header, imports, body].filter((s) => s !== "").join("\n");
}
