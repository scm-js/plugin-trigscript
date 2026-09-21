/**
 * What another repository's tests need to *run* triggers rather than read them: the text
 * format's parser, the trigger-cycle interpreter and its world, the game's unit names (what
 * the parser needs to be told) and the record constants a test compares against. Bundled
 * on its own as `dist/testing.js` (with its declarations in `dist/testing.d.ts`) and
 * committed like `dist/compiler.js`, so a plugin takes this repository as a git
 * devDependency at a tag and imports `scmjs-plugin-trigscript/testing`.
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
