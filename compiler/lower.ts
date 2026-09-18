/**
 * What the raw level shares with the programs: the player slots, condition negation (what
 * `not(…)` means for a condition the game can flip) and the community's hyper triggers.
 *
 * Until 3.0 this file was the classic back end — a trigger machine that lowered programs to
 * death-counter state machines. Programs are built by eudplib now (`python/trigscript.py`
 * over the IR), so none of that is left; the raw `trigger()` level is ordinary triggers and
 * needs only what is here.
 */
import {
  ActionType, Comparison, ConditionType, emptyAction, emptyCondition, emptyTrigger, MAX_ACTIONS, SwitchState, TriggerFlag,
  type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { conditionDef } from "../vendor/triggerDefs";

/** The player slots a trigger can run for one at a time (P1–P12); groups come after. */
export const PLAYER_SLOTS = 12;

export const U32_MAX = 0xffffffff;

/** A fault in a program's body, reported at the node it is about. */
export class LowerError extends Error {}

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** The actions whose amount comes with a Set / Add / Subtract modifier. */
export const ACTIONS_WITH_MODIFIER: ReadonlySet<number> = new Set([ActionType.SetDeaths, ActionType.SetResources, ActionType.SetScore, ActionType.SetCountdownTimer]);

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
