/**
 * Workers that go to work: the standard library's "trigscript/workers" (TrigScript 4).
 *
 *   import { buildAutoMiningProgram } from "trigscript/workers";
 *
 *   buildAutoMiningProgram();   // at the top of the script, once: on for the whole game
 *
 * With auto-mining on, a human player's new SCV, Probe or Drone whose producer's rally point is on a mineral patch
 * starts mining that patch, instead of walking there and standing. One rallied to the player's own finished gas
 * building (Refinery, Extractor, Assimilator) starts gathering gas from it. Anywhere else — the ground, a bare geyser,
 * a gas building still being built or another player's, a patch mined out — it walks to the rally point as it always
 * does. It acts once, as the worker comes out: an order the player gives afterwards stands. Computer players' workers
 * and those a trigger makes (Create Unit) are left alone, and a busy patch or gas building is the game's to sort out,
 * as when the player right-clicks it.
 *
 * Played in StarCraft: Remastered (2026-11-07 and 2026-11-08): SCVs, Probes and Drones rallied to minerals and to gas
 * all went to work. How it sees a new worker, from `map trace` (2026-11-07): an SCV comes out of training with its
 * order changing from Nothing, and a Drone from ZergBirth, on the frame the rally is applied (a Probe was not traced;
 * in play it went to work as an SCV does). A rally on a patch gives the worker Move to the patch's exact centre with no target; one on a building gives
 * Follow with the building as the target. `gather()` then gives the order a right-click would: MoveToMinerals or
 * MoveToGas.
 */
import { program, on, isHuman, allUnits, units, orders, P1, P2, P3, P4, P5, P6, P7, P8, type Unit } from "trigscript";

function ownerIsHuman(worker: Unit): boolean {
  const owner = worker.owner;
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

function gatherFromRally(worker: Unit) {
  if (!ownerIsHuman(worker)) return;
  if (worker.orderId == orders.Follow) {
    const gasBuilding = worker.orderTarget;
    if (gasBuilding) if (gasBuilding.owner == worker.owner && gasBuilding.buildTime == 0) worker.gather(gasBuilding);
    return;
  }
  if (worker.orderId != orders.Move || worker.hasTarget) return;
  const x = worker.orderTargetX, y = worker.orderTargetY;
  for (const patch of allUnits({ type: units.MineralFieldType1 })) if (patch.x == x && patch.y == y) { worker.gather(patch); return; }
  for (const patch of allUnits({ type: units.MineralFieldType2 })) if (patch.x == x && patch.y == y) { worker.gather(patch); return; }
  for (const patch of allUnits({ type: units.MineralFieldType3 })) if (patch.x == x && patch.y == y) { worker.gather(patch); return; }
}

let programBuilt = false;

/**
 * Build the program that turns auto-mining on for the whole game: every human player's new SCV, Probe or Drone rallied
 * to a mineral patch or the player's own finished gas building starts gathering from it. Called at the top of a
 * script, as programs are made when the map is built; a call after the first adds nothing.
 */
export function buildAutoMiningProgram() {
  if (programBuilt) return;
  programBuilt = true;
  program(async () => {
    on.order((worker, order, was) => {
      if (worker.type == units.ZergDrone) {
        if (was == orders.ZergBirth) gatherFromRally(worker);
      } else if (was == orders.Nothing) {
        if (worker.type == units.TerranSCV || worker.type == units.ProtossProbe) gatherFromRally(worker);
      }
    });
  });
}
