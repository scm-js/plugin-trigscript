/**
 * Workers that go to work: the standard library's "trigscript/workers" (TrigScript 4).
 *
 *   import { autoMining } from "trigscript/workers";
 *
 *   autoMining();   // at the top of the script, once: on for the whole game
 *
 * With auto-mining on, a human player's new SCV, Probe or Drone whose producer's rally point is on a mineral patch
 * starts mining that patch, instead of walking there and standing. One rallied to the player's own finished gas
 * building (Refinery, Extractor, Assimilator) starts gathering gas from it. Anywhere else — the ground, a bare geyser,
 * another player's gas building, a patch mined out — it walks to the rally point as it always does. A worker rallied to,
 * or right-clicked on, the player's own gas building still being built waits there, and starts gathering when the
 * building finishes, unless the player has given it another order since. Computer players' workers and those a trigger
 * makes (Create Unit) are left alone, and a busy patch or gas building is the game's to sort out, as when the player
 * right-clicks it.
 *
 * Played in StarCraft: Remastered (2026-11-07 and 2026-11-08): SCVs, Probes and Drones rallied to minerals and to gas
 * all went to work. How it sees a new worker, from `map trace` (2026-11-07): an SCV comes out of training with its
 * order changing from Nothing, and a Drone from ZergBirth, on the frame the rally is applied (a Probe was not traced;
 * in play it went to work as an SCV does). A rally on a patch gives the worker Move to the patch's exact centre with no target; one on a building gives
 * Follow with the building as the target. `gather()` then gives the order a right-click would: MoveToMinerals or
 * MoveToGas.
 */
import { program, on, nextFrame, isHuman, allUnits, units, orders, P1, P2, P3, P4, P5, P6, P7, P8, type Unit } from "trigscript";

function ownerIsHuman(worker: Unit): boolean {
  const owner = worker.owner;

  if (owner == P1) {
    return isHuman(P1);
  }
  if (owner == P2) {
    return isHuman(P2);
  }
  if (owner == P3) {
    return isHuman(P3);
  }
  if (owner == P4) {
    return isHuman(P4);
  }
  if (owner == P5) {
    return isHuman(P5);
  }
  if (owner == P6) {
    return isHuman(P6);
  }
  if (owner == P7) {
    return isHuman(P7);
  }
  if (owner == P8) {
    return isHuman(P8);
  }

  return false;
}

function isWorker(unit: Unit): boolean {
  return unit.type == units.TerranSCV || unit.type == units.ProtossProbe || unit.type == units.ZergDrone;
}

function isGasBuilding(unit: Unit): boolean {
  return unit.type == units.TerranRefinery || unit.type == units.ProtossAssimilator || unit.type == units.ZergExtractor;
}

// A Protoss building's build time reaches 0 while it is still warping in, and a worker sent to it then gives up.
function isFinished(building: Unit): boolean {
  return building.buildTime == 0 && building.orderId != orders.IncompleteWarping;
}

function isUnfinishedGasBuildingOf(worker: Unit, gasBuilding: Unit): boolean {
  return isGasBuilding(gasBuilding) && gasBuilding.owner == worker.owner && !isFinished(gasBuilding);
}

// A worker that reaches the building it follows stops: Follow, then Guard, then PlayerGuard.
function isWaitingAt(worker: Unit, gasBuilding: Unit): boolean {
  const order = worker.orderId;
  if (order == orders.Follow) {
    return worker.orderTarget == gasBuilding;
  }
  return order == orders.Guard || order == orders.PlayerGuard;
}

function gatherFromRally(worker: Unit) {
  if (!ownerIsHuman(worker)) {
    return;
  }

  if (worker.orderId == orders.Follow) {
    const gasBuilding = worker.orderTarget;
    if (gasBuilding) {
      const isOwnFinishedGasBuilding = isGasBuilding(gasBuilding) && gasBuilding.owner == worker.owner && isFinished(gasBuilding);
      if (isOwnFinishedGasBuilding) {
        worker.gather(gasBuilding);
      }
    }
    return;
  }

  if (worker.orderId != orders.Move || worker.hasTarget) {
    return;
  }

  const x = worker.orderTargetX;
  const y = worker.orderTargetY;

  for (const patch of allUnits({ type: units.MineralFieldType1 })) {
    if (patch.x == x && patch.y == y) {
      worker.gather(patch);
      return;
    }
  }
  for (const patch of allUnits({ type: units.MineralFieldType2 })) {
    if (patch.x == x && patch.y == y) {
      worker.gather(patch);
      return;
    }
  }
  for (const patch of allUnits({ type: units.MineralFieldType3 })) {
    if (patch.x == x && patch.y == y) {
      worker.gather(patch);
      return;
    }
  }
}

let programBuilt = false;

/**
 * Turn auto-mining on for the whole game: every human player's new SCV, Probe or Drone rallied to a mineral patch or
 * the player's own finished gas building starts gathering from it, and one sent to the player's own gas building still
 * being built starts when it finishes. Called at the top of a script: it makes a program,
 * and programs are made when the map is built, so a call inside a program is an error. A call after the first adds
 * nothing.
 */
export function autoMining() {
  if (programBuilt) {
    return;
  }
  programBuilt = true;

  program(async () => {
    const waitingWorkers: Unit[] = [];
    const awaitedGasBuildings: Unit[] = [];

    on.order((unit, currentOrder, previousOrder) => {
      if (currentOrder == orders.Follow && isWorker(unit) && ownerIsHuman(unit)) {
        const followed = unit.orderTarget;
        if (followed) {
          if (isUnfinishedGasBuildingOf(unit, followed)) {
            waitingWorkers.push(unit);
            awaitedGasBuildings.push(followed);
          }
        }
      }

      if (unit.type == units.ZergDrone) {
        if (previousOrder == orders.ZergBirth) {
          gatherFromRally(unit);
        }
      } else if (previousOrder == orders.Nothing) {
        const isScvOrProbe = unit.type == units.TerranSCV || unit.type == units.ProtossProbe;
        if (isScvOrProbe) {
          gatherFromRally(unit);
        }
      }
    });

    while (true) {
      for (let i = waitingWorkers.length - 1; i >= 0; i--) {
        const worker = waitingWorkers[i];
        const gasBuilding = awaitedGasBuildings[i];

        // A unit kept in a list is a place in the game's unit table, which another unit can take after it dies.
        const isSameWorker = isWorker(worker) && ownerIsHuman(worker);
        const isSameGasBuilding = isGasBuilding(gasBuilding) && gasBuilding.owner == worker.owner;
        if (isSameWorker && isSameGasBuilding && isWaitingAt(worker, gasBuilding)) {
          if (!isFinished(gasBuilding)) {
            continue;
          }
          worker.gather(gasBuilding);
        }

        waitingWorkers.splice(i, 1);
        awaitedGasBuildings.splice(i, 1);
      }
      await nextFrame();
    }
  });
}
