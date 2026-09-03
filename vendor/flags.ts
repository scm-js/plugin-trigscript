/**
 * The trigger execution flags by the names the text trigger format spells them with
 * (vendored from the editor's `formats/triggers/text.ts`): the script's fourth `trigger()`
 * argument takes these strings.
 */
import { TriggerFlag } from "./triggers";

export const TRIGGER_FLAG_NAMES: [number, string][] = [
  [TriggerFlag.Preserve, "Preserve"],
  [TriggerFlag.Disabled, "Disabled"],
  [TriggerFlag.IgnoreGameEnd, "Ignore Game End"],
  [TriggerFlag.IgnoreDisplay, "Ignore Display"],
  [TriggerFlag.ConditionsMet, "Conditions Met"],
  [TriggerFlag.Paused, "Paused"],
  [TriggerFlag.WaitSkipDisabled, "Wait Skip Disabled"],
];
