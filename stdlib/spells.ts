/**
 * Spells that cast themselves: the standard library's "trigscript/spells" (TrigScript 4).
 *
 *   import { buildAutoRestoreProgram } from "trigscript/spells";
 *
 *   buildAutoRestoreProgram();                                            // at the top of the script, once
 *   buildAutoRestoreProgram({ switch: "Medics trained", keepEnergy: 25 }); // or tied to a switch, keeping 25 energy
 *   buildAutoRestoreProgram({ allowPlayersToTurnOffAutoCast: true });     // a single-player map: right-click Restore to turn it off
 *
 * With auto-restore on, a human player's Medic that is idle, or healing on its own from idle, casts Restoration on a
 * unit of its owner's, or of a player its owner has allied, that is within the spell's range and carries Lockdown,
 * Irradiate, Plague, Ensnare, Maelstrom, Acid Spores or Optical Flare. It is a real cast: the owner must have researched
 * Restoration, the Medic must have its energy (and `keepEnergy` more), and the cast shows and costs as a player's
 * does. The nearest Medic goes to the nearest afflicted unit, one Medic to a unit; one that is moving, attack-moving,
 * holding, patrolling or casting for the player is never used, and a Medic never walks to reach a unit. Parasite
 * alone, a unit in stasis or invincible, a hallucination (Restoration kills it) and the Medic itself are left alone.
 * Computer players' Medics are left to the computer, which casts Restoration itself.
 *
 * With `allowPlayersToTurnOffAutoCast`, for single-player maps, the player turns auto-restore off and on again by
 * right-clicking the Restore button on a Medic's command card ("trigscript/card"), and is told "Auto-restore off" or
 * "Auto-restore on". It starts on. While the map's switch is cleared, the right-click does nothing and the setting is kept.
 *
 * Played in StarCraft: Remastered (2026-11-11): the order written to the Medic (CastRestoration at the unit) is cast,
 * mid-heal too, and the Medic heals on afterwards. How it tells a Medic healing from idle from one the player sent,
 * from `map trace` (2026-11-11): either way the order is MedicHeal, but an attack-move or a patrol waits behind it in
 * the Medic's queue (`queuedOrders` 1 or 2), and the queue of one healing from idle holds nothing the game counts.
 */
import { program, nextFrame, isHuman, switchIs, switches, allUnits, stats, units, orders, techs, weapons, print, AllPlayers, CurrentPlayer, P1, P2, P3, P4, P5, P6, P7, P8, type Player, type Unit } from "trigscript";
import { CardButton, cardSlots } from "trigscript/card";

function ownerIsHuman(medic: Unit): boolean {
  const owner = medic.owner;
  if (owner == P1) return isHuman(P1);
  if (owner == P2) return isHuman(P2);
  if (owner == P3) return isHuman(P3);
  if (owner == P4) return isHuman(P4);
  if (owner == P5) return isHuman(P5);
  if (owner == P6) return isHuman(P6);
  if (owner == P7) return isHuman(P7);
  if (owner == P8) return isHuman(P8);
  return false;
}

function ownerHasRestoration(medic: Unit): boolean {
  const owner = medic.owner;
  if (owner == P1) return stats(P1).researched[techs.Restoration];
  if (owner == P2) return stats(P2).researched[techs.Restoration];
  if (owner == P3) return stats(P3).researched[techs.Restoration];
  if (owner == P4) return stats(P4).researched[techs.Restoration];
  if (owner == P5) return stats(P5).researched[techs.Restoration];
  if (owner == P6) return stats(P6).researched[techs.Restoration];
  if (owner == P7) return stats(P7).researched[techs.Restoration];
  if (owner == P8) return stats(P8).researched[techs.Restoration];
  return false;
}

function playerHasAllied(player: Player, target: Unit): boolean {
  const owner = target.owner;
  if (owner == P1) return stats(player).allied[P1];
  if (owner == P2) return stats(player).allied[P2];
  if (owner == P3) return stats(player).allied[P3];
  if (owner == P4) return stats(player).allied[P4];
  if (owner == P5) return stats(player).allied[P5];
  if (owner == P6) return stats(player).allied[P6];
  if (owner == P7) return stats(player).allied[P7];
  if (owner == P8) return stats(player).allied[P8];
  return false;
}

function isFriendly(medic: Unit, target: Unit): boolean {
  const owner = medic.owner;
  if (target.owner == owner) return true;
  if (owner == P1) return playerHasAllied(P1, target);
  if (owner == P2) return playerHasAllied(P2, target);
  if (owner == P3) return playerHasAllied(P3, target);
  if (owner == P4) return playerHasAllied(P4, target);
  if (owner == P5) return playerHasAllied(P5, target);
  if (owner == P6) return playerHasAllied(P6, target);
  if (owner == P7) return playerHasAllied(P7, target);
  if (owner == P8) return playerHasAllied(P8, target);
  return false;
}

function isIdleOrHealingFromIdle(medic: Unit): boolean {
  const order = medic.orderId;
  if (order == orders.Medic) return true;
  return (order == orders.MedicHeal || order == orders.MedicHealToIdle) && medic.queuedOrders == 0;
}

function hasRestorableEffect(target: Unit): boolean {
  return target.lockdown > 0 || target.irradiate > 0 || target.plague > 0 || target.ensnare > 0 || target.maelstrom > 0 || target.acidSpores > 0 || target.opticalFlare;
}

function includes(list: Unit[], unit: Unit): boolean {
  for (const each of list) if (each == unit) return true;
  return false;
}

let programBuilt = false;

/**
 * Build the program that turns auto-restore on: every human player's idle or self-healing Medic casts Restoration on
 * the nearest afflicted unit of its owner's or an ally's within range. `switch`: a switch of the map, by its name;
 * auto-restore runs only while it is set. `keepEnergy`: the energy a Medic keeps after the cast (default 0).
 * `allowPlayersToTurnOffAutoCast`: a single-player map's player turns it off and on by right-clicking Restore. Called at
 * the top of a script, as programs are made when the map is built; a call after the first adds nothing.
 */
export function buildAutoRestoreProgram(options: { switch?: keyof typeof switches; keepEnergy?: number; allowPlayersToTurnOffAutoCast?: boolean } = {}) {
  if (programBuilt) return;
  programBuilt = true;
  const keepEnergy = options.keepEnergy ?? 0;
  const toggled = options.allowPlayersToTurnOffAutoCast === true;
  program(async () => {
    // Run for every player, so the card's watcher and its view moves are the human's: the others' copies end here.
    if (toggled && !isHuman(CurrentPlayer)) return;
    let autoRestoreOn = true;
    const restoreButton = new CardButton(techs.Restoration, cardSlots.Restoration);
    if (toggled) await restoreButton.begin();
    const sentMedics: Unit[] = [];
    const sentTargets: Unit[] = [];
    while (true) {
      if (toggled && (await restoreButton.rightClicked()) && (options.switch === undefined || switchIs(switches[options.switch], "set"))) {
        autoRestoreOn = !autoRestoreOn;
        print(autoRestoreOn ? "Auto-restore on" : "Auto-restore off", { to: CurrentPlayer });
      }
      const range = stats(weapons.Restoration).range;
      for (let i = sentMedics.length - 1; i >= 0; i--) {
        const medic = sentMedics[i], target = sentTargets[i];
        if (medic.orderId == orders.CastRestoration && medic.orderTarget == target) {
          // (State 2 is the cast under way, its energy spent: let it land.)
          if (medic.orderState == 2 || medic.distanceTo(target) <= range) continue;
          medic.stop();
        }
        sentMedics.splice(i, 1);
        sentTargets.splice(i, 1);
      }
      if ((options.switch !== undefined && !switchIs(switches[options.switch], "set")) || !autoRestoreOn) {
        await nextFrame();
        continue;
      }
      const energy = stats(techs.Restoration).energy + keepEnergy;
      const medics: Unit[] = [];
      const castAt: Unit[] = [];
      for (const medic of allUnits({ type: units.TerranMedic })) {
        if (medic.orderId == orders.CastRestoration) {
          const target = medic.orderTarget;
          if (target) castAt.push(target);
        } else if (isIdleOrHealingFromIdle(medic) && medic.energy >= energy && ownerIsHuman(medic) && ownerHasRestoration(medic)) {
          medics.push(medic);
        }
      }
      if (medics.length > 0) {
        const pairMedics: Unit[] = [];
        const pairTargets: Unit[] = [];
        const pairDistances: number[] = [];
        for (const target of allUnits({ type: units.Men })) {
          if (!hasRestorableEffect(target) || target.stasis > 0 || target.hallucinated || target.invincible || includes(castAt, target)) continue;
          for (const medic of medics) {
            if (medic == target || !isFriendly(medic, target)) continue;
            const distance = medic.distanceTo(target);
            if (distance > range) continue;
            pairMedics.push(medic);
            pairTargets.push(target);
            pairDistances.push(distance);
          }
        }
        while (pairMedics.length > 0) {
          let nearest = 0;
          for (let i = 1; i < pairDistances.length; i++) if (pairDistances[i] < pairDistances[nearest]) nearest = i;
          const medic = pairMedics[nearest], target = pairTargets[nearest];
          medic.cast(techs.Restoration, target);
          sentMedics.push(medic);
          sentTargets.push(target);
          for (let i = pairMedics.length - 1; i >= 0; i--) {
            if (pairMedics[i] == medic || pairTargets[i] == target) {
              pairMedics.splice(i, 1);
              pairTargets.splice(i, 1);
              pairDistances.splice(i, 1);
            }
          }
        }
      }
      await nextFrame();
    }
  }, toggled ? { owner: AllPlayers } : {});
}
