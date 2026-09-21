/**
 * What another repository's tests need to *run* triggers rather than read them: the text
 * format's parser, the trigger-cycle interpreter and its world, the game's unit names (what
 * the parser needs to be told) and the record constants a test compares against. Bundled
 * on its own as `dist/testing.js` (with its declarations in `dist/testing.d.ts`) and
 * committed like `dist/compiler.js`, so a plugin takes the tarball of one of this
 * repository's tags as a devDependency and imports `scmjs-plugin-trigscript/testing`.
 *
 * It carries the compiler as well (`compileScript`, with the names and the standard library
 * it is handed), so that a repository which shows a model TrigScript can test that what it
 * shows still compiles.
 *
 * The plugin itself never loads it. Not to be confused with `testing.ts`, which is the
 * script language's own `test()`.
 */
export { Simulation, simulate, type SimulationEvent, type SimulationOptions } from "./simulate";
export {
  World, Players, UNIT_SLOTS,
  type PlayersOptions, type SimBounds, type SimUnit, type SimUnitInit, type SimUnitProperties, type WorldOptions,
} from "./world";
export { formatTriggers, parseTriggers, type TextTrigger, type TriggerNames } from "../vendor/text";
export {
  ActionFlag, ActionType, AllianceStatus, Comparison, ConditionFlag, ConditionType, Order, PlayerGroup, ResourceType,
  ScoreType, SetModifier, SwitchAction, SwitchState, TriggerFlag, UnitClass, UnitState, MAX_ACTIONS, MAX_CONDITIONS,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
export { UNIT_NAMES } from "../vendor/units";
export { compileScript, type CompileOptions, type CompileResult } from "./compiler";
export { defaultScriptNames, scriptNames, type NameSources, type ScriptNames } from "./names";
// Node only: reads TypeScript's own library files from the `typescript` package beside the caller.
export { defaultLib } from "../bundle/lib.mjs";
