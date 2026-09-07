/**
 * The `.d.ts` a script is checked against: the library (`trigscript`) as types, plus
 * tables generated from the map — its locations, switches, forces and custom unit
 * names — so Monaco completes `locations.` with what the map actually has and a
 * misspelt name is a type error, not a bare number.
 *
 * Everything is declared twice: as globals, so a file works without an import line, and
 * as the ambient module `"trigscript"`, so `import { trigger } from "trigscript"` works
 * too. The runtime (`runtime.ts`) provides the same names as values; `runtimeNames`
 * is the list both are checked against.
 *
 * `compact` is the variant a language model reads: globals only, each unit once, the
 * first sixteen switches and every named one, AI scripts as an index signature.
 */
import { ACTION_FIELDS, CONDITION_FIELDS } from "./record";
import { ACTION_IDENTS, argType, CHOICE_TYPES, choiceWords, CONDITION_IDENTS, MODULE_NAME, propertyKey, scriptParams, TRIGGER_OPTION_NAMES } from "./api";
import type { ActionDef, ArgKind, ConditionDef } from "../vendor/triggerDefs";
import { defaultScriptNames, type NameTable, type ScriptNames } from "./names";
import { PLAYER_SLOTS } from "./lower";

export const DECLARATIONS_FILE = "trigscript.d.ts";

export interface DeclarationOptions {
  compact?: boolean;
}

const HEADER = `// ── TrigScript ────────────────────────────────────────────────────────────
// Generated for the open map; rebuilt whenever the map's names change. Do not edit.
//
// A script is ordinary TypeScript that runs when you build: every trigger() it calls
// becomes one trigger of the map, in order. Code inside program(() => { … }) runs in
// the game instead, as a state machine of death counters.
`;

function types(kw: string): string {
  return `
${kw}type Brand<K extends string> = { readonly __kind?: K };
/** A player or player group (P1 … P12, CurrentPlayer, AllPlayers, players.*, or a raw group number). */
${kw}type Player<N extends number = number> = N & Brand<"player">;
/** A unit type (units.*, or a raw units.dat id). */
${kw}type Unit<N extends number = number> = N & Brand<"unit">;
/** A location (locations.*, or a raw 1-based location number; 0 = none). */
${kw}type Location<N extends number = number> = N & Brand<"location">;
/** A switch (switches.*, or a raw 0-based switch number). */
${kw}type Switch<N extends number = number> = N & Brand<"switch">;
/** An AI script (aiScripts.*; a four-character code or StarEdit name as a string also works). */
${kw}type AiScript<N extends number = number> = N & Brand<"aiScript">;
/** A unit count: a number, or "All". */
${kw}type Count = number | "All";

/** A condition, as returned by bring(...), deaths(...), …: give it to trigger(), or test it in an if inside program(). */
${kw}interface Condition { readonly __condition: true; }
/** An action, as returned by displayText(...), setDeaths(...), …: give it to trigger(), or call it as a statement inside program(). */
${kw}interface Action { readonly __action: true; }
/** A trigger, as returned by trigger(). */
${kw}interface Trigger { readonly __trigger: true; }
/** Conditions, nested arrays allowed (they are flattened); false / null / undefined entries are skipped. */
${kw}type Conditions = readonly (Condition | Conditions | false | null | undefined)[];
/** Actions, nested arrays allowed (they are flattened); false / null / undefined entries are skipped. */
${kw}type Actions = readonly (Action | Actions | false | null | undefined)[];

${kw}interface TriggerOptions {
${TRIGGER_OPTION_NAMES.map(([, name]) => `  ${name}?: boolean;`).join("\n")}
  /** Raw execution flags, ORed in. */
  flags?: number;
}

${kw}interface ProgramOptions {
  /** The single player the program's triggers run as (default P1). It must be in the game for the program to run. */
  owner?: Player;
  /** Put a Comment action naming the source line on every generated trigger (default true). */
  comments?: boolean;
  /** Unit types whose death counters hold the variables (default: the "(Unused)" units, Cantina first). */
  variableUnits?: readonly Unit[];
}
`;
}

function choiceTypes(kw: string): string {
  const out: string[] = [];
  for (const [kind, name] of Object.entries(CHOICE_TYPES) as [ArgKind, string][]) {
    out.push(`${kw}type ${name} = ${choiceWords(kind).map((w) => JSON.stringify(w)).join(" | ")};`);
  }
  return out.join("\n");
}

function functions(kw: string): string {
  return `
/**
 * Define one trigger. The script's triggers become a contiguous, generated block of the
 * map's trigger list in the order they are defined; hand-made triggers around it are left alone.
 * @param players The player or players the trigger runs for.
 * @param conditions Up to 16 conditions; a trigger with none never fires.
 * @param actions Up to 64 actions.
 * @param options Execution flags: { preserve: true } is the same as a preserveTrigger() action.
 */
${kw}function trigger(players: Player | readonly Player[], conditions: Conditions, actions: Actions, options?: TriggerOptions): Trigger;
/**
 * Code that runs in the game: a state machine built from death counters. Inside the arrow,
 * let variables holding numbers are death counters and booleans are switches; if / else,
 * while, do, for, break, continue and functions (inlined per call) all work; conditions go in
 * an if or while and actions stand as statements. One iteration of a loop per trigger cycle.
 * Everything the body reads from outside (constants, helpers, conditions, actions) is
 * computed when you build, so it must not depend on the variables.
 */
${kw}function program(body: () => void, options?: ProgramOptions): void;
/** Three preserved triggers of sixty-two Wait(0) each: the trigger loop runs every frame. Owned by one player whose triggers never wait. */
${kw}function hyperTriggers(owner?: Player): void;
/** A coin toss (Randomize Switch), inside program() only: \`flag = random()\`, \`if (random() && …)\`. */
${kw}function random(): boolean;
/** Keep a condition or action in the trigger but switched off (StarEdit's disabled state). */
${kw}function disabled<T extends Condition | Action>(item: T): T;
/** A condition by raw type number and record fields, for types the editor does not know. */
${kw}function condition(${CONDITION_FIELDS.map((f) => `${f}?: number`).join(", ")}): Condition;
/** An action by raw type number and record fields, for types the editor does not know. */
${kw}function action(${ACTION_FIELDS.map((f) => `${f}?: number`).join(", ")}): Action;
/** EUD: compare the 32-bit value at a memory address (1.16.1 layout; Remastered emulates it). deaths at player EPD(address). */
${kw}function memory(address: number, comparison: Comparison | number, value: number): Condition;
/** EUD: set / add to / subtract from the 32-bit value at a memory address (1.16.1 layout; Remastered emulates it). */
${kw}function setMemory(address: number, modifier: Modifier | number, value: number): Action;
/** Preserve Trigger: the trigger runs again next cycle instead of once. */
${kw}function preserve(): Action;
`;
}

function signature(kw: string, ident: string, def: ConditionDef | ActionDef, returns: "Condition" | "Action"): string {
  const params = scriptParams(def).map((p) => `${p.name}${p.optional ? "?" : ""}: ${argType(p.arg.kind)}`);
  const doc = def.args.length ? `${def.name} — ${def.args.map((a) => a.label).join(", ")}` : def.name;
  return `/** ${doc} */\n${kw}function ${ident}(${params.join(", ")}): ${returns};`;
}

function tableDecl(kw: string, t: NameTable, keep: (key: string, index: number) => boolean = () => true, note?: string): string {
  const lines = [`/** ${t.doc} */`, `${kw}const ${t.object}: {`];
  if (note) lines.push(`  // ${note}`);
  for (const e of t.entries) e.keys.forEach((k, i) => { if (keep(k, i)) lines.push(`  readonly ${propertyKey(k)}: ${t.type}<${e.value}>;`); });
  lines.push("};");
  return lines.join("\n");
}

function playerAliases(kw: string, names: ScriptNames): string {
  const lines: string[] = [];
  for (const e of names.players.entries) {
    if (e.value < PLAYER_SLOTS) lines.push(`/** ${e.keys[1]} */\n${kw}const ${e.keys[0]}: Player<${e.value}>;`);
  }
  lines.push(`/** The player the trigger is running for. */\n${kw}const CurrentPlayer: Player<13>;`);
  lines.push(`/** Every player. */\n${kw}const AllPlayers: Player<17>;`);
  return lines.join("\n");
}

function tables(kw: string, names: ScriptNames, compact: boolean): string {
  if (!compact) {
    return [names.players, names.units, names.locations, names.switches, names.aiScripts].map((t) => tableDecl(kw, t)).join("\n");
  }
  const isDefaultSwitch = (k: string) => /^Switch ?(\d+)$/.test(k);
  return [
    tableDecl(kw, names.players),
    tableDecl(kw, names.units, (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k), `Every unit is also indexable by its StarEdit name: ${names.units.object}["Terran Marine"].`),
    tableDecl(kw, names.locations),
    tableDecl(kw, names.switches, (k) => { const m = /^Switch(\d+)$/.exec(k); return m ? Number(m[1]) <= 16 : !isDefaultSwitch(k); }, "Switch1 … Switch256 exist; the first sixteen are listed. A switch given a name in the map is listed by that name."),
    `/** AI scripts, by StarEdit name ("Terran Custom Level") or four-character code. */\n${kw}const ${names.aiScripts.object}: { readonly [name: string]: AiScript<number> };`,
  ].join("\n");
}

function body(kw: string, typeKw: string, names: ScriptNames, compact: boolean): string {
  return [
    types(typeKw),
    choiceTypes(typeKw),
    functions(kw),
    "// ── Conditions ──",
    ...[...CONDITION_IDENTS].map(([ident, def]) => signature(kw, ident, def, "Condition")),
    "",
    "// ── Actions ──",
    ...[...ACTION_IDENTS].map(([ident, def]) => signature(kw, ident, def, "Action")),
    "",
    "// ── The map ──",
    playerAliases(kw, names),
    tables(kw, names, compact),
  ].join("\n");
}

/** The whole declaration file for a set of names. */
export function generateDeclarations(names: ScriptNames = defaultScriptNames(), options: DeclarationOptions = {}): string {
  const compact = options.compact === true;
  const globals = body("declare ", "", names, compact);
  if (compact) return `${HEADER}${globals}\n`;
  const module = body("export ", "export ", names, false).split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
  return `${HEADER}${globals}\n\n// ── The same names, as a module: import { trigger, units } from "${MODULE_NAME}"; ──\ndeclare module "${MODULE_NAME}" {\n${module}\n}\n`;
}

