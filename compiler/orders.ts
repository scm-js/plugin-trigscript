/**
 * The game's orders, one per orders.dat id: what a unit is doing (`u.orderId`) and what `on.order(…)` listens for. The
 * names are the community's, as BWAPI and scm-sim give them; the name tables offer them as identifiers (`orders.Move`).
 */
export const ORDER_NAMES: readonly string[] = [
  "Die", "Stop", "Guard", "PlayerGuard", "TurretGuard", "BunkerGuard", "Move", "ReaverStop", "Attack1", "Attack2", "AttackUnit",
  "AttackFixedRange", "AttackTile", "Hover", "AttackMove", "InfestedCommandCenter", "UnusedNothing", "UnusedPowerup", "TowerGuard",
  "TowerAttack", "VultureMine", "StayInRange", "TurretAttack", "Nothing", "Unused24", "DroneStartBuild", "DroneBuild", "CastInfestation",
  "MoveToInfest", "InfestingCommandCenter", "PlaceBuilding", "PlaceProtossBuilding", "CreateProtossBuilding", "ConstructingBuilding", "Repair",
  "MoveToRepair", "PlaceAddon", "BuildAddon", "Train", "RallyPointUnit", "RallyPointTile", "ZergBirth", "ZergUnitMorph", "ZergBuildingMorph",
  "IncompleteBuilding", "IncompleteMorphing", "BuildNydusExit", "EnterNydusCanal", "IncompleteWarping", "Follow", "Carrier", "ReaverCarrierMove",
  "CarrierStop", "CarrierAttack", "CarrierMoveToAttack", "CarrierIgnore2", "CarrierFight", "CarrierHoldPosition", "Reaver", "ReaverAttack",
  "ReaverMoveToAttack", "ReaverFight", "ReaverHoldPosition", "TrainFighter", "InterceptorAttack", "ScarabAttack", "RechargeShieldsUnit",
  "RechargeShieldsBattery", "ShieldBattery", "InterceptorReturn", "DroneLand", "BuildingLand", "BuildingLiftOff", "DroneLiftOff", "LiftingOff",
  "ResearchTech", "Upgrade", "Larva", "SpawningLarva", "Harvest1", "Harvest2", "MoveToGas", "WaitForGas", "HarvestGas", "ReturnGas",
  "MoveToMinerals", "WaitForMinerals", "MiningMinerals", "Harvest3", "Harvest4", "ReturnMinerals", "Interrupted", "EnterTransport", "PickupIdle",
  "PickupTransport", "PickupBunker", "Pickup4", "PowerupIdle", "Sieging", "Unsieging", "WatchTarget", "InitCreepGrowth", "SpreadCreep",
  "StoppingCreepGrowth", "GuardianAspect", "ArchonWarp", "CompletingArchonSummon", "HoldPosition", "QueenHoldPosition", "Cloak", "Decloak",
  "Unload", "MoveUnload", "FireYamatoGun", "MoveToFireYamatoGun", "CastLockdown", "Burrowing", "Burrowed", "Unburrowing", "CastDarkSwarm",
  "CastParasite", "CastSpawnBroodlings", "CastEMPShockwave", "NukeWait", "NukeTrain", "NukeLaunch", "NukePaint", "NukeUnit",
  "CastNuclearStrike", "NukeTrack", "InitializeArbiter", "CloakNearbyUnits", "PlaceMine", "RightClickAction", "SuicideUnit", "SuicideLocation",
  "SuicideHoldPosition", "CastRecall", "Teleport", "CastScannerSweep", "Scanner", "CastDefensiveMatrix", "CastPsionicStorm", "CastIrradiate",
  "CastPlague", "CastConsume", "CastEnsnare", "CastStasisField", "CastHallucination", "Hallucination2", "ResetCollision", "ResetHarvestCollision",
  "Patrol", "CTFCOPInit", "CTFCOPStarted", "CTFCOP2", "ComputerAI", "AtkMoveEP", "HarassMove", "AIPatrol", "GuardPost", "RescuePassive",
  "Neutral", "ComputerReturn", "InitializePsiProvider", "SelfDestructing", "Critter", "HiddenGun", "OpenDoor", "CloseDoor", "HideTrap",
  "RevealTrap", "EnableDoodad", "DisableDoodad", "WarpIn", "Medic", "MedicHeal", "HealMove", "MedicHoldPosition", "MedicHealToIdle",
  "CastRestoration", "CastDisruptionWeb", "CastMindControl", "DarkArchonMeld", "CastFeedback", "CastOpticalFlare", "CastMaelstrom", "JunkYardDog", "Fatal",
];

/** The orders a unit is given by `u.order(…)` and the Order action: move, patrol, attack (an attack-move). */
export const ORDER_OF_VERB: Readonly<Record<"move" | "patrol" | "attack", number>> = { move: 6, patrol: 152, attack: 14 };
