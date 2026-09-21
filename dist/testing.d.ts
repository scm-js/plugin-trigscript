export declare const MAX_CONDITIONS = 16;
export declare const MAX_ACTIONS = 64;
export interface ConditionRecord {
	/** 1-based location number, 0 = none. */
	location: number;
	/** `PlayerGroup`. */
	player: number;
	amount: number;
	unitId: number;
	/** `Comparison` for numeric conditions; `SwitchState` for Switch. */
	comparison: number;
	/** `ConditionType`. */
	type: number;
	/** `ResourceType` / `ScoreType` / switch number, per type. */
	resource: number;
	/** `ConditionFlag` bits. */
	flags: number;
	/** EUD mask word; 0 in ordinary maps. */
	mask: number;
}
export interface ActionRecord {
	/** 1-based source location, 0 = none. */
	location: number;
	/** String index for text / comment / leaderboard label, 0 = none. */
	text: number;
	/** String index of the WAV file name, 0 = none. */
	wav: number;
	/** Milliseconds for Wait / Transmission / Talking Portrait; WAV duration for Play WAV. */
	time: number;
	/** `PlayerGroup` (first). */
	player: number;
	/** Second player / destination location / amount / AI script code, per type. */
	target: number;
	/** Unit id / `ScoreType` / `ResourceType` / `AllianceStatus`, per type. */
	unitId: number;
	/** `ActionType` (or `BriefingActionType` in MBRF). */
	type: number;
	/** Unit count (0 = all) / `SetModifier` / `SwitchAction` / `Order` / `UnitState`, per type. */
	modifier: number;
	/** `ActionFlag` bits. */
	flags: number;
	padding: number;
	/** EUD mask word; 0 in ordinary maps. */
	mask: number;
}
export interface TriggerRecord {
	conditions: ConditionRecord[];
	actions: ActionRecord[];
	/** `TriggerFlag` bits. */
	flags: number;
	/** 27 bytes, one per `PlayerGroup`; non-zero = the trigger runs for that group. */
	players: number[];
	/** The game's bookkeeping byte (offset 2399); StarEdit writes 0. */
	currentAction: number;
}
export declare const ConditionType: {
	readonly None: 0;
	readonly CountdownTimer: 1;
	readonly Command: 2;
	readonly Bring: 3;
	readonly Accumulate: 4;
	readonly Kill: 5;
	readonly CommandTheMost: 6;
	readonly CommandTheMostAt: 7;
	readonly MostKills: 8;
	readonly HighestScore: 9;
	readonly MostResources: 10;
	readonly Switch: 11;
	readonly ElapsedTime: 12;
	readonly Briefing: 13;
	readonly Opponents: 14;
	readonly Deaths: 15;
	readonly CommandTheLeast: 16;
	readonly CommandTheLeastAt: 17;
	readonly LeastKills: 18;
	readonly LowestScore: 19;
	readonly LeastResources: 20;
	readonly Score: 21;
	readonly Always: 22;
	readonly Never: 23;
};
export declare const ActionType: {
	readonly None: 0;
	readonly Victory: 1;
	readonly Defeat: 2;
	readonly PreserveTrigger: 3;
	readonly Wait: 4;
	readonly PauseGame: 5;
	readonly UnpauseGame: 6;
	readonly Transmission: 7;
	readonly PlayWav: 8;
	readonly DisplayText: 9;
	readonly CenterView: 10;
	readonly CreateUnitWithProperties: 11;
	readonly SetMissionObjectives: 12;
	readonly SetSwitch: 13;
	readonly SetCountdownTimer: 14;
	readonly RunAiScript: 15;
	readonly RunAiScriptAt: 16;
	readonly LeaderboardControl: 17;
	readonly LeaderboardControlAt: 18;
	readonly LeaderboardResources: 19;
	readonly LeaderboardKills: 20;
	readonly LeaderboardPoints: 21;
	readonly KillUnit: 22;
	readonly KillUnitAt: 23;
	readonly RemoveUnit: 24;
	readonly RemoveUnitAt: 25;
	readonly SetResources: 26;
	readonly SetScore: 27;
	readonly MinimapPing: 28;
	readonly TalkingPortrait: 29;
	readonly MuteUnitSpeech: 30;
	readonly UnmuteUnitSpeech: 31;
	readonly LeaderboardComputerPlayers: 32;
	readonly LeaderboardGoalControl: 33;
	readonly LeaderboardGoalControlAt: 34;
	readonly LeaderboardGoalResources: 35;
	readonly LeaderboardGoalKills: 36;
	readonly LeaderboardGoalPoints: 37;
	readonly MoveLocation: 38;
	readonly MoveUnit: 39;
	readonly LeaderboardGreed: 40;
	readonly SetNextScenario: 41;
	readonly SetDoodadState: 42;
	readonly SetInvincibility: 43;
	readonly CreateUnit: 44;
	readonly SetDeaths: 45;
	readonly Order: 46;
	readonly Comment: 47;
	readonly GiveUnits: 48;
	readonly ModifyHitPoints: 49;
	readonly ModifyEnergy: 50;
	readonly ModifyShields: 51;
	readonly ModifyResourceAmount: 52;
	readonly ModifyHangarCount: 53;
	readonly PauseTimer: 54;
	readonly UnpauseTimer: 55;
	readonly Draw: 56;
	readonly SetAllianceStatus: 57;
	readonly DisableDebugMode: 58;
	readonly EnableDebugMode: 59;
};
/** The 27 player-group slots of a trigger, and the values conditions/actions store. */
export declare const PlayerGroup: {
	readonly Player1: 0;
	readonly Player2: 1;
	readonly Player3: 2;
	readonly Player4: 3;
	readonly Player5: 4;
	readonly Player6: 5;
	readonly Player7: 6;
	readonly Player8: 7;
	readonly Player9: 8;
	readonly Player10: 9;
	readonly Player11: 10;
	readonly Player12: 11;
	readonly None: 12;
	readonly CurrentPlayer: 13;
	readonly Foes: 14;
	readonly Allies: 15;
	readonly NeutralPlayers: 16;
	readonly AllPlayers: 17;
	readonly Force1: 18;
	readonly Force2: 19;
	readonly Force3: 20;
	readonly Force4: 21;
	readonly Unused1: 22;
	readonly Unused2: 23;
	readonly Unused3: 24;
	readonly Unused4: 25;
	readonly NonAlliedVictoryPlayers: 26;
};
export declare const Comparison: {
	readonly AtLeast: 0;
	readonly AtMost: 1;
	readonly Exactly: 10;
};
export declare const SwitchState: {
	readonly Set: 2;
	readonly Cleared: 3;
};
export declare const SwitchAction: {
	readonly Set: 4;
	readonly Clear: 5;
	readonly Toggle: 6;
	readonly Randomize: 11;
};
export declare const SetModifier: {
	readonly SetTo: 7;
	readonly Add: 8;
	readonly Subtract: 9;
};
/** Set Doodad State / Set Invincibility. */
export declare const UnitState: {
	readonly Enable: 4;
	readonly Disable: 5;
	readonly Toggle: 6;
};
export declare const Order: {
	readonly Move: 0;
	readonly Patrol: 1;
	readonly Attack: 2;
};
export declare const AllianceStatus: {
	readonly Enemy: 0;
	readonly Ally: 1;
	readonly AlliedVictory: 2;
};
export declare const ResourceType: {
	readonly Ore: 0;
	readonly Gas: 1;
	readonly OreAndGas: 2;
};
export declare const ScoreType: {
	readonly Total: 0;
	readonly Units: 1;
	readonly Buildings: 2;
	readonly UnitsAndBuildings: 3;
	readonly Kills: 4;
	readonly Razings: 5;
	readonly KillsAndRazings: 6;
	readonly Custom: 7;
};
/** Unit ids beyond units.dat that conditions and actions accept. */
export declare const UnitClass: {
	readonly Any: 229;
	readonly Men: 230;
	readonly Buildings: 231;
	readonly Factories: 232;
};
export declare const ConditionFlag: {
	/** Game bookkeeping. */
	readonly Unknown: 1;
	readonly Disabled: 2;
	readonly AlwaysDisplay: 4;
	readonly UnitPropertiesUsed: 8;
	readonly UnitTypeUsed: 16;
	readonly UnitIdUsed: 32;
};
export declare const ActionFlag: {
	/** Ignore a Wait / Transmission once (game bookkeeping). */
	readonly IgnoreWaitOnce: 1;
	readonly Disabled: 2;
	readonly AlwaysDisplay: 4;
	readonly UnitPropertiesUsed: 8;
	readonly UnitTypeUsed: 16;
	readonly UnitIdUsed: 32;
};
export declare const TriggerFlag: {
	/** Game bookkeeping: every condition was met this cycle. */
	readonly ConditionsMet: 1;
	/** Ignore Defeat / Draw for this trigger. */
	readonly IgnoreGameEnd: 2;
	/** Same as a Preserve Trigger action. */
	readonly Preserve: 4;
	/** The trigger never runs. */
	readonly Disabled: 8;
	/** Skip Wait / text / view actions for the rest of this loop (game bookkeeping). */
	readonly IgnoreDisplay: 16;
	/** Game bookkeeping. */
	readonly Paused: 32;
	/** Game bookkeeping. */
	readonly WaitSkipDisabled: 64;
};
/** A string a record refers to: text to intern, or an existing string-table index (raw forms). */
export type ScriptString = {
	text: string;
} | {
	index: number;
};
/** The game's unit table. */
export declare const UNIT_SLOTS = 1700;
/** A unit of the simulated game. Hit points, shields and energy in whole points. */
export interface SimUnit {
	type: number;
	owner: number;
	x: number;
	y: number;
	hp: number;
	maxHp: number;
	shields: number;
	maxShields: number;
	energy: number;
	kills: number;
	orderId: number;
	cooldown: number;
	resources: number;
	stim: number;
	ensnare: number;
	plague: number;
	lockdown: number;
	maelstrom: number;
	irradiate: number;
	stasis: number;
	hallucinated: boolean;
	cloaked: boolean;
	burrowed: boolean;
	invincible: boolean;
	underAttack: boolean;
	/** Still on the map. */
	alive: boolean;
	/** Its place in the unit table, from 0; another unit's once this one is gone. */
	slot: number;
	/** The place's uniqueness byte while this unit is in it. */
	uid: number;
}
export type SimUnitInit = Partial<Omit<SimUnit, "alive" | "slot" | "uid">> & {
	type: number;
	owner: number;
};
export interface SimBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}
/** What a Create Unit with Properties slot sets, the percentages of the type's own. */
export interface SimUnitProperties {
	hpPercent?: number;
	shieldPercent?: number;
	energyPercent?: number;
	resources?: number;
	cloaked?: boolean;
	burrowed?: boolean;
	hallucinated?: boolean;
	invincible?: boolean;
}
export interface PlayersOptions {
	/** The slots in the game — the map's human and computer players. Absent: the one simulated player, and every force is that one. */
	players?: readonly number[];
	/** The force of each slot, 0 … 3. A slot without one is in no force. */
	forces?: Readonly<Record<number, number>>;
}
/** Who a player number of a trigger means. */
export declare class Players {
	/** The slots in the game, in order. */
	readonly slots: readonly number[];
	/** No player settings were given: one player, whom every force and the current player mean. */
	readonly loose: boolean;
	private readonly forces;
	constructor(options: PlayersOptions, only: number);
	/** The slots a player or a group names, as `current` sees it. A group nobody is in is empty. */
	of(group: number, current: number): number[];
	/** Whether a trigger with these owners (the record's 27 flags) runs for a slot. */
	owns(owners: ArrayLike<number | boolean>, slot: number): boolean;
}
export interface WorldOptions extends PlayersOptions {
	/** The units on the map, in the order of the game's unit table. */
	units?: readonly SimUnitInit[];
	/** The map's locations as boxes, by their 1-based number. A location the world does not know holds every unit, and its centre is 0, 0. */
	locations?: Readonly<Record<number, SimBounds>>;
	/** Whether a unit type is of a trigger class (229 any, 230 men, 231 buildings, 232 factories); default by id range. */
	unitClass?: (type: number, cls: number) => boolean;
	/** The hit points and shields a type is made with; default 1 and 0. */
	unitStats?: (type: number) => {
		hp?: number;
		shields?: number;
		energy?: number;
	} | undefined;
	/** What a Create Unit with Properties slot sets, by the slot's number in the action. */
	properties?: (slot: number) => SimUnitProperties | undefined;
}
export declare class World {
	/** Every unit there has been, in the order they were made; one that is gone stays in the list, `alive` false. */
	readonly units: SimUnit[];
	readonly locations: Map<number, SimBounds>;
	readonly players: Players;
	/** What a type is made with. Replaceable: the programs' simulation answers from the tables a program may have written. */
	stats: (type: number) => {
		hp?: number;
		shields?: number;
		energy?: number;
	} | undefined;
	/** A unit died by `kill`: the death is the caller's to count, in the table its script's counters are in. */
	onDeath: (unit: SimUnit) => void;
	private readonly table;
	private readonly uids;
	private readonly classOf;
	private readonly properties;
	/** Kills by player and type of what was killed. */
	private readonly killed;
	constructor(options: WorldOptions, only: number);
	/** A unit on the map, in the lowest free place of the table. Null when the table is full, as the game makes no unit then. */
	make(init: SimUnitInit): SimUnit | null;
	/** A unit of a type as the game makes one: the type's hit points and shields, at a point. */
	create(type: number, owner: number, x: number, y: number, properties?: SimUnitProperties): SimUnit | null;
	/** Off the map, its place free for the next unit made. `killed`: it died — counted as a death, and as a kill of `by` when someone is named. */
	gone(unit: SimUnit, killed: boolean, by?: number): void;
	/** The unit that was in a place when its uniqueness byte was `uid`: the one there now, or one long gone. */
	at(slot: number, uid: number): SimUnit | null;
	/** The units on the map, in the order of the table. */
	living(): SimUnit[];
	private typed;
	private inside;
	/** The living units of these owners (any, when undefined), of a type or a class, inside a location — in table order. */
	matching(owners: readonly number[] | undefined, type?: number, location?: number): SimUnit[];
	centreOf(location: number): {
		x: number;
		y: number;
	};
	/** A location centred on a point, its size kept. */
	centre(location: number, x: number, y: number): void;
	/** The kills these players have of a type or a class. */
	kills(owners: readonly number[], type: number): number;
	/** The number a unit condition compares, as `current` asks it; undefined for a condition that is not about units. */
	quantity(c: ConditionRecord, current: number): number | undefined;
	/** Whether a unit condition holds; undefined for a condition that is not about units. */
	holds(c: ConditionRecord, current: number): boolean | undefined;
	/** The first `count` of a list; 0 is all of them. */
	private some;
	/**
	 * An action on units, done as `current`. True when it was one of the world's — the caller
	 * logs it either way. `made`, when given, receives the units a Create Unit made.
	 */
	act(a: ActionRecord, current: number, made?: SimUnit[]): boolean;
}
export interface SimulationEvent {
	/** 0-based cycle. */
	cycle: number;
	/** Index of the trigger in the list. */
	trigger: number;
	/** The player it ran for. */
	player: number;
	action: ActionRecord;
	/** The action's text, when it has one and the simulation can resolve it. */
	text?: string;
}
export interface SimulationOptions extends WorldOptions {
	/** The player the triggers run as (0-based) when no `players` are given, and the one an input or a log is for; default: the first player any trigger is owned by. */
	player?: number;
	/** Asked before the simulation's own answer: a condition the caller wants to decide (undefined leaves it to the simulation), and the ones it does not model (scores, the countdown). Default: false. */
	condition?: (c: ConditionRecord, sim: Simulation) => boolean | undefined;
	/** For Randomize Switch; default Math.random. */
	random?: () => number;
	/** Text of a string id — the compiler's local table, or a function over the map's. */
	strings?: ScriptString[] | ((index: number) => string | null);
	/** Stop a cycle after this many trigger runs (a runaway guard); default 100 000. */
	maxRunsPerCycle?: number;
}
export declare class Simulation {
	readonly triggers: TriggerRecord[];
	/** The simulated player: the only one, without the map's player settings; with them, the one inputs and logs default to. */
	readonly player: number;
	/** The player a trigger or a program is running as right now: who Current Player is. */
	current: number;
	/** The units, the locations and who the players are. */
	readonly game: World;
	readonly events: SimulationEvent[];
	readonly switches: Uint8Array<ArrayBuffer>;
	private readonly deaths;
	/** Trigger × player, for the triggers that ran without Preserve. */
	private readonly done;
	private readonly options;
	cycle: number;
	constructor(triggers: TriggerRecord[], options?: SimulationOptions);
	/** A player's deaths of a unit; a group's are its players' together. */
	death(player: number, unit: number): number;
	/** Set for a player, or for each player of a group. */
	setDeath(player: number, unit: number, value: number): void;
	/** A Set Deaths action: set to, add or subtract, for each player the action names. */
	changeDeath(player: number, unit: number, modifier: number, amount: number): void;
	text(index: number): string | undefined;
	/** Run one trigger cycle. */
	step(): void;
	run(cycles: number): this;
	private condition;
	private action;
}
/** Compile-result convenience: run a script's triggers for `cycles` cycles. */
export declare function simulate(triggers: TriggerRecord[], cycles: number, options?: SimulationOptions): Simulation;
/** How the text format names things it cannot know on its own. */
export interface TriggerNames {
	/** Text of a string-table entry, null when unset. */
	string(index: number): string | null;
	/** Index for `text` — an existing identical entry or a new one. Only called while parsing. */
	intern(text: string): number;
	/** Display name of a 1-based location number. */
	location(number: number): string;
	/** 1-based number for a location name (or `Location N` / `Anywhere`), undefined when unknown. */
	locationByName(name: string): number | undefined;
	unit(id: number): string;
	unitByName(name: string): number | undefined;
	/** Display name of a 0-based switch. */
	switch(index: number): string;
	switchByName(name: string): number | undefined;
}
export interface TextTrigger {
	trigger: TriggerRecord;
	/** 1-based line the `Trigger(` header starts on. */
	line: number;
}
export declare function formatTriggers(triggers: TriggerRecord[], names: TriggerNames, briefing?: boolean): string;
/** Parse a whole text into triggers; throws `TriggerTextError` with the offending line. */
export declare function parseTriggers(text: string, names: TriggerNames, briefing?: boolean): TextTrigger[];
/**
 * StarEdit's unit names, one per units.dat id (vendored from the editor's `data/units.ts`;
 * the compiler labels a program's death-counter variables with them and the name tables
 * offer them as identifiers). The editor is the source of truth: copy it again when it changes.
 */
export declare const UNIT_NAMES: readonly string[];

export {};
