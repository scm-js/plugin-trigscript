import * as TS from 'typescript';

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
export interface NameEntry {
	value: number;
	/** All keys, the preferred identifier first. Unique within the table. */
	keys: string[];
}
export interface NameTable {
	/** The object the script reads the entries from (`units`). */
	object: string;
	/** The branded type of its values (`Unit`). */
	type: string;
	doc: string;
	entries: NameEntry[];
}
export interface ScriptNames {
	players: NameTable;
	units: NameTable;
	locations: NameTable;
	switches: NameTable;
	aiScripts: NameTable;
	/** weapons.dat, upgrades.dat and techdata.dat ids: what `stats()` and a unit type's weapon fields take. */
	weapons: NameTable;
	upgrades: NameTable;
	techs: NameTable;
	/** orders.dat ids: what a unit is doing (`u.orderId`) and what `on.order()` listens for. */
	orders: NameTable;
	/** The map's sounds, the Sound Editor's list: each the string of its path, what Play WAV takes. */
	sounds: NameTable;
}
/** What a map contributes to the tables; every part is optional (the fixed lists stand without a map). */
export interface NameSources {
	/** The four force names, null or blank where a force has none. */
	forceNames?: (string | null)[];
	/** The map's used location slots (0-based) with their names; Anywhere is added when it is not listed. */
	locations?: {
		index: number;
		name: string;
	}[];
	/** A name per switch slot, when the map names it (`Switch N` and blanks add nothing). */
	switchNames?: (string | null)[];
	/** A unit type's custom name, null or blank for the default. */
	unitCustomName?: (id: number) => string | null;
	/** The map's sounds: the string each one's path is (1-based, as a trigger names it) and the path. */
	sounds?: {
		stringIndex: number;
		path: string;
	}[];
}
/** The tables for a map's names — or, with nothing given, the fixed lists alone (what tests use). */
export declare function scriptNames(src?: NameSources): ScriptNames;
/** Tables over fixed lists only — what a script sees with no map open, and what tests use. */
export declare function defaultScriptNames(): ScriptNames;
export type MouseButton = "left" | "right" | "middle";
export type ChatCapture = 
/** `{n}`: a whole number. */
{
	name: string;
	kind: "number";
}
/** `{unit:unit}`: a unit type by its name, the rest of the line. */
 | {
	name: string;
	kind: "unit";
}
/** `{kind:ore|gas}`: one of the words; its place in the list is the value. */
 | {
	name: string;
	kind: "word";
	words: string[];
};
export interface ChatPattern {
	/** As the script wrote it; what tells one pattern from another. */
	pattern: string;
	/** The written text and the captures, in order: text is a string, a capture its index. */
	segments: (string | number)[];
	captures: ChatCapture[];
}
/** One thing a program reads from the players; `player` is a slot, or 13 for the current player. */
export type InputSource = 
/** 1 on the frame the key's press arrives; `held`, on every frame it is down. */
{
	source: "key";
	key: string;
	player: number;
	held?: boolean;
}
/** 1 on the frame the button's press arrives. */
 | {
	source: "click";
	button: MouseButton;
	player: number;
}
/** Where the player's mouse is on the map, in pixels. */
 | {
	source: "mouse";
	axis: "x" | "y";
	player: number;
}
/** A typed line: with `capture` null, 1 on the frame a line matching the pattern arrives; else that capture's value on that frame, 0 otherwise. */
 | {
	source: "chat";
	pattern: string;
	capture: number | null;
	player: number;
}
/** What `syncSend` of the slot sent from `player`'s computer, plus 1, once it has arrived; 0 until then (B5). */
 | {
	source: "sync";
	slot: number;
	player: number;
};
/** Everything the programs read of the players, for the build (`backend/input.ts`) and the simulator. */
export interface InputPlan {
	keys: string[];
	/** The keys a program asks are held, each read on every frame it is down. */
	held?: string[];
	buttons: MouseButton[];
	chats: ChatPattern[];
	/** Unit names a `{…:unit}` capture knows, lower case, with the type each means; only when one is used. */
	unitNames?: [
		name: string,
		id: number
	][];
	/** Whether a program reads the players' mice. */
	mouse: boolean;
	/** How many `sync()` slots the programs use (B5): each a value sent from one computer to all; absent when none. */
	syncs?: number;
}
/** Where a node came from; `column` is 1-based like `line`. */
export interface At {
	file: string;
	line: number;
	column: number;
}
/** A variable of the program. `id` is unique within the program; `name` is the source's. */
export interface VarDecl {
	id: string;
	name: string;
	/** `unit`: a unit on the map, or none — a pointer the lowering re-checks before each use, since the game reuses a dead unit's slot. */
	kind: "number" | "boolean" | "unit" | "text";
	/**
	 * How a `text` variable is kept. `id`: it only ever receives texts known when the script is built, so it holds the
	 * text's id in the built map's string table — one cell, assigning is copying a number, any action's text field takes
	 * it. `made`: three cells — where the text is, the block of the heap it owns (0 when it owns none: a text of the
	 * table), its length in characters. What holds a made text owns its block: assigning copies it (a value that was
	 * just made is moved), and assigning or declaring again gives the old block back first.
	 */
	text?: "id" | "made";
	/**
	 * A map of our own only (`compiler/backend/texts.ts`): kept in one cell and read where it is used, as a variable the
	 * emitter copies is — for one read in many places and written often (a write is one action, not one a place).
	 */
	routed?: boolean;
	/**
	 * A map of our own only (`compiler/backend/heap.ts`): never below zero and at most this, whatever is written — a copy
	 * of it into a place that holds a multiple of it is then worked out over only the bits it can have.
	 */
	top?: number;
	/**
	 * A map of our own only (`compiler/backend/heap.ts`): one cell for the whole map — every program and every run of one
	 * — that no program declares, 0 as the map starts, and read where it is used (`routed` too).
	 */
	global?: boolean;
	/**
	 * A map of our own only (`compiler/backend/heap.ts`): kept in every place it is read, however many — written seldom and
	 * read often (where an array's block starts), so that a read never copies it in, as a variable past a trigger's worth
	 * of places otherwise is.
	 */
	everywhere?: boolean;
	/**
	 * A map of our own only (`compiler/backend/heap.ts`): declared in a loop's body and read nowhere outside the loop — a
	 * `for…of`'s variable — so its cell need not hold what is read into it.
	 */
	scoped?: boolean;
	/** `shared(…)`: one cell for every player of a per-player program. */
	shared: boolean;
	/** A `u8` / `u16` annotation; unset for the full 32 bits. */
	bits?: 8 | 16;
	/** A `u32`: the 32 bits read as 0 … 4 294 967 295. Unset, a number is signed (a `u8` / `u16` never goes below zero either way). */
	unsigned?: boolean;
	/** A `fixed`: a 16.16 number, the cell the value times 65 536 (signed). Declared so, or found by `numbers.ts` to be stored a fraction. */
	fixed?: boolean;
	/** A backend's scratch value that dies with the statement (a function's result). */
	temp?: boolean;
	/** A variable of a task's body (`start`, its `task`): a cell for each of its slots, within each player's row. */
	task?: number;
	/** A reference the closures count (24): its declare lets go of what it held before, so it is read first — 0 the first time, as a backend's cell is. */
	held?: boolean;
	at: At;
}
/**
 * An array of the program: `length` cells of one kind, known when the script is built. A per-player
 * program has one for every player unless it is `shared`. `values`: a list the script computed when it
 * was built, which a program only reads — `const price = [50, 100, 150]; price[level]` — one for
 * everyone, never initialised in the game and never written. Reading past either end gives 0 (false);
 * a store past either end does nothing.
 */
export interface ArrayDecl {
	id: string;
	name: string;
	kind: "number" | "boolean";
	length: number;
	shared: boolean;
	bits?: 8 | 16;
	unsigned?: boolean;
	/** Its cells are `fixed` numbers (16.16), as a variable's are; `values` are then the raw cells. */
	fixed?: boolean;
	values?: number[];
	/** A list of texts the script has, which a program indexes with a variable (`titles[level]`): `values` are their places here, the lowering's their ids in the built map's table. */
	texts?: string[];
	/** An array declared in a task's body (`start`, its `task`): its cells once for each of its slots. */
	task?: number;
	/**
	 * The array grows: something pushes to it, pops from it or sets its length. Its cells are a block of the
	 * programs' heap (`HEAP_CELLS`), reached through a handle — where the block is, how many cells are in use, how
	 * many it has room for — and `length` is only how many it starts with. A block that is full is exchanged for
	 * one twice the size. Declared again (in a loop, in a function called again) it gives back the block it held.
	 */
	dynamic?: boolean;
	/**
	 * The array is a window on another's cells — a row of a grid (`grid[y]`, which is `length` cells of one flat array):
	 * cell i of it is cell `offset + i` of `of`, where `offset` is a variable of the program set before the window is
	 * used. It has no cells of its own and is never declared; past its own end it reads 0 and stores nothing, as any
	 * array does, so a row never reaches into the next.
	 */
	slice?: {
		of: string;
		offset: string;
	};
	/**
	 * The array is one that grows *inside* another — `buckets[i]` of `let buckets: number[][] = [[], []]`, the `path` of
	 * `squads[i]`: its handle is not cells of its own but cell `index` (a variable of the program, set before this is
	 * used) of four arrays the outer one keeps, a handle a row. What holds the handle owns the block: the front end gives
	 * a row's block back (`declareArray` of this, empty) before the row goes — popped, cut off, the outer declared again.
	 * A copy of the four cells is a second name for the same block, as a copy of a reference is, and no second owner.
	 */
	through?: {
		ptr: string;
		len: string;
		room: string;
		k: string;
		index: string;
	};
	at: At;
}
/** A player's race as the game holds it; what `race(p)` gives and `supply()` takes. */
export type RaceId = 0 | 1 | 2;
/**
 * What a `read` reads. `condition`: the quantity a trigger condition tests — the record is
 * that condition with "at least 0" in it, so whatever the condition can be asked (a force's
 * minerals, the Marines a player brought to a location) can be read. `player`: a byte of
 * the game's player tables. `supply`: a player's supply as the top bar shows it, of one
 * race or (`race` null) of the race the player is. `player` is a slot, or 13 for the
 * current player.
 */
/**
 * `epd` (a map of our own only, `compiler/backend/texts.ts`): the condition's player field is this value — a Deaths of
 * unit 0 then reads the dword at that EPD, wherever it is.
 */
export type ReadSource = {
	source: "condition";
	record: ConditionRecord;
	epd?: NumExpr;
} | {
	source: "player";
	fact: "race" | "slot" | "left";
	player: number;
} | {
	source: "supply";
	of: "used" | "max" | "provided";
	race: RaceId | null;
	player: number;
};
/**
 * Which units a loop or a pick looks at, every part known when the script is built: a unit type
 * (230 Men, 231 Buildings, 232 Factories are the trigger classes), an owner (a slot, or 13 for the
 * current player) and a location the unit's centre is inside (1-based). An absent part matches all.
 */
export interface UnitFilter {
	type?: number;
	owner?: number;
	at?: number;
}
type EventSource$1 = "created" | "died" | "killed" | "ordered" | "morphed";
/**
 * A number of a unit on the map. Hit points, shields and energy are whole points; the timers, the cooldown and the
 * remaining build time frames; `matrix` the defensive matrix's frames; `speed` the current speed in 256ths of a pixel a frame.
 */
export type UnitNumField = "hp" | "maxHp" | "shields" | "maxShields" | "energy" | "owner" | "type" | "x" | "y" | "kills" | "orderId" | "cooldown" | "resources" | "stim" | "ensnare" | "plague" | "lockdown" | "maelstrom" | "irradiate" | "stasis" | "buildTime" | "rank" | "matrix" | "speed";
/** A true / false of a unit on the map; `invincible`, `hallucinated` and `speedUpgrade` take a write. */
export type UnitFlag = "hallucinated" | "cloaked" | "burrowed" | "invincible" | "underAttack" | "speedUpgrade" | "hasTarget" | "inTransport";
/** A unit on the map, or none. */
export type UnitExpr = {
	kind: "unitNull";
} | {
	kind: "unitVar";
	id: string;
}
/**
 * One unit among those the filter matches: the first in the game's unit table, the nearest to the
 * centre of location `near` (by |dx| + |dy|), or one at random. None when nothing matches.
 * `mouse` in place of `near`: nearest to that player's mouse (a slot, or 13 for the current
 * player), and no farther from it than `within` pixels.
 */
 | {
	kind: "pick";
	by: "first" | "nearest" | "random";
	filter: UnitFilter;
	near?: number;
	mouse?: number;
	within?: number;
	at: At;
	label: string;
}
/**
 * The unit three numbers name — what `unitPart` gave of one, kept in cells of the program (an array of units is three
 * arrays of numbers). None when `ptr` is 0; like any kept unit it is re-checked before use.
 */
 | {
	kind: "unitAt";
	ptr: NumExpr;
	epd: NumExpr;
	uid: NumExpr;
	at: At;
}
/** A call inlined here whose result is a unit. */
 | {
	kind: "call";
	call: Call;
}
/** The unit in slot `index` of this computer's selection (`local.selected` is slot 0; B5), or none: a Local value. */
 | {
	kind: "selected";
	index: number;
	at: At;
};
/** What a unit is told to do. `to` and `target` are known when the script is built; an amount is the program's. */
export type UnitVerb = {
	do: "kill";
} | {
	do: "remove";
} | {
	do: "give";
	to: number;
}
/** The game's own Order, reaching this unit alone. `target` is a location. */
 | {
	do: "order";
	order: "move" | "patrol" | "attack";
	target: number;
}
/** Hit points down (at 0 the unit dies) or up (to the type's maximum), by points or by a percentage of the maximum. */
 | {
	do: "damage" | "heal";
	amount: NumExpr;
	percent: boolean;
}
/** Centre a location on the unit, its size kept. */
 | {
	do: "locate";
	location: number;
};
/**
 * One cell of the game's tables (`tables.ts`): `base + index × stride + key`, `width` bytes or one
 * bit. `index` 13 in a player table is the current player. `scale`: stored = value × scale.
 */
export interface TableCell {
	/** "unit.minerals", "player.upgrades": the table and the field, for a log and the simulator. */
	name: string;
	base: number;
	stride: number;
	index: number;
	/** The second index of a keyed field (the upgrade of `stats(P1).upgrades[…]`), in bytes from the row's start. */
	key?: number;
	width: 1 | 2 | 4 | "bit";
	bit?: number;
	scale?: number;
	/** The index is a player: 13 means whoever the program is running as. */
	player?: boolean;
	special?: "speed" | "color" | "name";
}
/** `>>` keeps the sign of what it shifts; `>>>` fills with zeros. */
export type ArithOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | ">>>";
/**
 * A number of the IR. Any of them may carry `range: [lo, hi]` (IR 25): `ranges.ts` found its signed reading always
 * between the two, both included. It is a promise a backend may lean on — take only the bits a value can have, drop a
 * check that cannot fail — and never needs to.
 */
export type NumExpr = 
/** `fixed`: a 16.16 number, `value` its raw cell (the value times 65 536); `numbers.ts` reads it so, a backend takes `value` as it is. */
/** `fn`: the number is a function kept as a value (B3), the id of the function it stands for — what keeps that function in the map. */
{
	kind: "const";
	value: number;
	fixed?: boolean;
	fn?: string;
} | {
	kind: "var";
	id: string;
}
/** `hp[i]`: a cell of an array of numbers; 0 when the index is past either end. */
 | {
	kind: "element";
	array: string;
	index: NumExpr;
	at: At;
}
/**
 * One of the three numbers a unit is kept as: where it is in the game's unit table (`ptr`, 0 for none), the same as an
 * EPD, and the slot's uniqueness byte as it was when the unit was taken. Only ever stored and handed back to `unitAt`.
 */
 | {
	kind: "unitPart";
	unit: UnitExpr;
	part: "ptr" | "epd" | "uid";
	at: At;
}
/** `xs.length`. Of an array that does not grow it is a constant, and `numbers.ts` makes it one. */
 | {
	kind: "length";
	array: string;
	at: At;
}
/** `xs.pop()`: the last cell, which the array then no longer has; 0 when it is empty. */
 | {
	kind: "pop";
	array: string;
	at: At;
} | {
	kind: "unary";
	op: "-";
	expr: NumExpr;
	at: At;
}
/** `u32(x)` / `i32(x)`: the same 32 bits read the other way. Nothing is computed; it is there for `numbers.ts`, which works out what each operation reads its sides as. */
 | {
	kind: "cast";
	to: "u32" | "i32" | "fixed";
	expr: NumExpr;
	at: At;
}
/** `unsigned`, on `/` and `%`: both sides are `u32`s. Unset, the division is signed and rounds towards zero, the remainder taking the dividend's sign. */
 | {
	kind: "binary";
	op: ArithOp;
	left: NumExpr;
	right: NumExpr;
	unsigned?: boolean;
	at: At;
	label: string;
}
/** A value of the game, read when the expression is evaluated. */
 | {
	kind: "read";
	read: ReadSource;
	at: At;
	label: string;
}
/** `random(n)`: a whole number from 0 to n − 1, fresh at every evaluation; 0 when n is 0. */
 | {
	kind: "randomInt";
	bound: NumExpr;
	at: At;
	label: string;
}
/** A number of a unit on the map; 0 when the unit is none or gone. */
 | {
	kind: "unitField";
	unit: UnitExpr;
	field: UnitNumField;
	at: At;
	label: string;
}
/** A cell of the game's tables, unscaled: a flag reads 1 or 0. */
 | {
	kind: "tableRead";
	cell: TableCell;
	at: At;
	label: string;
}
/** What a player did, as it reached every computer (`input.ts`): a key or a click reads 1 on its frame, the mouse its place on the map, a typed line 1 or a value it carried. */
 | {
	kind: "input";
	input: InputSource;
	at: At;
	label: string;
} | {
	kind: "ternary";
	cond: BoolExpr;
	whenTrue: NumExpr;
	whenFalse: NumExpr;
	at: At;
	label: string;
}
/**
 * `unsigned`, on `min` and `max`: the arguments are compared as `u32`s. `abs` is of a signed number.
 * Of fixed numbers (16.16, raw cells): `fmul` is a × b / 65 536 and `fdiv` a × 65 536 / b, each rounded towards zero
 * and wrapping at 32 bits (a divisor of 0 gives 0); `sqrt` is the square root of a fixed, rounded down (0 below
 * zero), or with `unsigned` of a whole number read from 0 up, the root still a fixed; `atan2` of (y, x) is the angle in radians, a fixed from −π to π, read from `table`, an array of the program
 * whose 1 025 cells are atan(i / 1 024), between its cells; `sin` / `cos` of (x, scale) read `table`, the 4 096 cells
 * sin(2π i / 4 096), at fmul(x, scale) (a quarter turn on for `cos`), between its cells. The front end also gives
 * `floor` / `ceil` / `round` / `trunc`, which `numbers.ts` turns into the operations above and no backend meets.
 */
 | {
	kind: "intrinsic";
	name: "min" | "max" | "abs" | "fmul" | "fdiv" | "sqrt" | "atan2" | "sin" | "cos" | "floor" | "ceil" | "round" | "trunc";
	args: NumExpr[];
	unsigned?: boolean;
	table?: string;
	at: At;
	label: string;
}
/** `s.length`, in characters (code points). */
 | {
	kind: "textLength";
	of: TextExpr;
	at: At;
	label: string;
}
/** `s.indexOf(find, from)`: the place of the first character of the first match at or after `from`, in characters; −1 when there is none. */
 | {
	kind: "textIndexOf";
	of: TextExpr;
	find: TextExpr;
	from?: NumExpr;
	at: At;
	label: string;
}
/** `s.codePointAt(i)`: the character's number; −1 past either end. */
 | {
	kind: "textCode";
	of: TextExpr;
	index: NumExpr;
	at: At;
	label: string;
}
/** The number of the task this runs in — what `start()` gave for it, `slot | task << 8 | generation << 16` — or 0 outside a task (B4: where a task's error is kept for an `await` of it). */
 | {
	kind: "taskHandle";
	at: At;
}
/** A call inlined here: its body runs, its result is the number. */
 | {
	kind: "call";
	call: Call;
};
/**
 * A text. `text` is one known when the script was built; a variable is one of the two ways `VarDecl.text` says; `textOf`
 * is a cell of a list of texts the script has. Those, and a `ternary` between them, are texts of the built map's table,
 * which have an id. Everything else is made while the map is played, into a block of the heap that the value owns
 * until something takes it (a variable, which keeps it) or has used it (a comparison, a `print`, which give it back).
 */
export type TextExpr = {
	kind: "text";
	text: string;
} | {
	kind: "textVar";
	id: string;
} | {
	kind: "textOf";
	array: string;
	index: NumExpr;
	at: At;
}
/**
 * A text kept in cell `index` of three arrays — where it is, the block of the heap it owns (0 for a text of the map's
 * table, which owns none), its length in characters: a row's (`waves[i].name`). Looked at, as a variable's is. Cells
 * that were never given a text are 0, which is the empty text.
 */
 | {
	kind: "textAt";
	addr: string;
	block: string;
	chars: string;
	index: NumExpr;
	at: At;
}
/** A template, texts joined with `+`, `String(n)`: the parts one after another. */
 | {
	kind: "template";
	parts: TextPart[];
	at: At;
	label: string;
} | {
	kind: "textTernary";
	cond: BoolExpr;
	whenTrue: TextExpr;
	whenFalse: TextExpr;
	at: At;
	label: string;
}
/** The characters from `start` (0 when absent) up to `end` (the text's end when absent), both already inside 0 … length: `slice`, `substring`, `s[i]`, `at`, `charAt`. */
 | {
	kind: "textSlice";
	of: TextExpr;
	start?: NumExpr;
	end?: NumExpr;
	at: At;
	label: string;
}
/** `padStart` / `padEnd`: `with` over and over on that side until the text is `width` characters; unchanged when it is that long already or `with` is empty. */
 | {
	kind: "textPad";
	of: TextExpr;
	side: "start" | "end";
	width: NumExpr;
	with: TextExpr;
	at: At;
	label: string;
}
/** `s.repeat(n)`; nothing when n is below 1. */
 | {
	kind: "textRepeat";
	of: TextExpr;
	count: NumExpr;
	at: At;
	label: string;
}
/** A call inlined here whose result is a text: the value is taken out of the call's result, which then holds none. */
 | {
	kind: "textCall";
	call: Call;
}
/** What buffer `buffer` holds, as the `buildText` statements before it left it: looked at where it is, never owned. */
 | {
	kind: "built";
	buffer: string;
};
export type BoolExpr = {
	kind: "const";
	value: boolean;
}
/** A trigger condition the script wrote, its fields known when the script is built. */
/**
 * `amount`: a map of our own's backend only (`Rewriter.asked`), a read compared with a value — the condition's
 * amount that value plus `add`, a place of it.
 */
 | {
	kind: "cond";
	record: ConditionRecord;
	amount?: {
		expr: NumExpr;
		add: number;
	};
	epd?: NumExpr;
}
/** A boolean variable. */
 | {
	kind: "var";
	id: string;
}
/** `alive[i]`: a cell of an array of booleans; false when the index is past either end. */
 | {
	kind: "element";
	array: string;
	index: NumExpr;
	at: At;
}
/** `flags.pop()` of an array of booleans; false when it is empty. */
 | {
	kind: "pop";
	array: string;
	at: At;
}
/** A number expression tested as a truth value: `!= 0`. */
 | {
	kind: "test";
	expr: NumExpr;
	at: At;
	label: string;
}
/**
 * `unsigned` true: both sides are read as `u32`s (or neither can be below zero, which comes to the same and costs less).
 * "left" / "right": that side is a `u32` and the other a signed number, compared exactly — a number below zero is smaller than any `u32`.
 */
 | {
	kind: "compare";
	op: CompareOp;
	left: NumExpr;
	right: NumExpr;
	unsigned?: boolean | "left" | "right";
	at: At;
	label: string;
} | {
	kind: "and";
	items: BoolExpr[];
} | {
	kind: "or";
	items: BoolExpr[];
} | {
	kind: "not";
	expr: BoolExpr;
}
/** `random()`: a coin toss, fresh at every evaluation. */
 | {
	kind: "random";
	at: At;
}
/** `t.running`: the task the number stands for (what `start()` gave) has not ended, nor been cancelled. 0 is no task. */
 | {
	kind: "running";
	task: NumExpr;
	at: At;
}
/** `if (target)`: the variable holds a unit and that unit is still on the map. */
 | {
	kind: "unitAlive";
	unit: UnitExpr;
	at: At;
	label: string;
}
/** `u == target`: both name the same unit of the game (and there is one). */
 | {
	kind: "unitSame";
	left: UnitExpr;
	right: UnitExpr;
	at: At;
	label: string;
}
/** A true / false of a unit; false when the unit is none or gone. */
 | {
	kind: "unitFlag";
	unit: UnitExpr;
	flag: UnitFlag;
	at: At;
	label: string;
}
/** `rose(c)` / `once(c)`: an edge on a condition, with a latch of its own. */
 | {
	kind: "edge";
	edge: "rose" | "once";
	cond: BoolExpr;
	at: At;
	label: string;
} | {
	kind: "ternary";
	cond: BoolExpr;
	whenTrue: BoolExpr;
	whenFalse: BoolExpr;
	at: At;
	label: string;
}
/** Two texts compared: the same characters, or the order of their characters' numbers (which is JavaScript's for every character the game draws). */
 | {
	kind: "textCompare";
	op: CompareOp;
	left: TextExpr;
	right: TextExpr;
	at: At;
	label: string;
}
/** `s.startsWith(find)`, `s.endsWith(find)`, `s.includes(find)`. */
 | {
	kind: "textTest";
	test: "startsWith" | "endsWith" | "includes";
	of: TextExpr;
	find: TextExpr;
	at: At;
	label: string;
}
/** A call inlined here whose boolean result is tested. */
 | {
	kind: "call";
	call: Call;
};
/** A piece of a `print`'s text: written text, a number's digits, a player's name, the colour code of a player's colour. */
export type TextPart = {
	kind: "text";
	text: string;
}
/** `unsigned`: printed as a `u32`; unset, a number below zero has its minus sign. `fixed`: a 16.16 number, printed as a decimal of up to four places (3.5, -0.25). */
 | {
	kind: "number";
	expr: NumExpr;
	unsigned?: boolean;
	fixed?: boolean;
} | {
	kind: "name";
	player: number;
} | {
	kind: "color";
	player: number;
}
/** A text of the program: a variable's, a function's result. */
 | {
	kind: "value";
	text: TextExpr;
}
/** One byte, the number's low eight bits: a colour code chosen when the map is played. 0 writes nothing. */
 | {
	kind: "char";
	expr: NumExpr;
}
/**
 * The text of the case `by` equals: only a map of our own makes it (`compiler/backend/texts.ts`), for a text known
 * when built chosen while the game runs; `by` is a variable or a constant, always one case's `when` or between it
 * and its `upTo`.
 */
 | {
	kind: "pick";
	by: NumExpr;
	cases: {
		when: NumExpr;
		upTo?: NumExpr;
		text: string;
	}[];
};
/** A field of an action filled in by the program: `bits` 8 is a unit count (done once per unit), 16 a unit type, 32 an amount. */
export interface ActionVariable {
	field: keyof ActionRecord;
	bits: 8 | 16 | 32;
	name: string;
	expr: NumExpr;
}
export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
/**
 * A function that is called: one body in the built map, which every `Call` naming it (`fn`) runs. Its parameters are
 * variables of its own that a call sets; `return` writes `result`, which the call copies into its own. It never sleeps.
 * `recursive`: it is on a cycle of the call graph — it calls itself, directly or round about (`recursion.ts`). Its
 * cells are still the program's own, one of each, so a call in its body that may come back into it keeps what the
 * function holds on the stack meanwhile (`Call.saves`), and such a call is always a statement of its own.
 */
export interface FuncDecl {
	id: string;
	name: string;
	params: VarDecl[];
	result?: {
		decl: VarDecl;
		kind: "number" | "boolean" | "unit" | "text";
	};
	recursive?: boolean;
	body: Stmt[];
	at: At;
}
/**
 * What a recursive function keeps on the stack around a call that may come back into it, and takes back after: the
 * variables (a cell each, three for a unit), the handles of the growing arrays declared in it (four cells each, set to
 * "no block" for the call — the block the inner run leaves is given back before the handle is taken back) and, not
 * listed, where the function returns to. `within` names the function the call is in, for the words of an overflow.
 */
export interface Saves {
	vars: string[];
	arrays: string[];
	within: string;
}
/**
 * A function at a call. Inlined (no `fn`): parameter copies, the body, and what it returns into. Called (`fn`): the
 * function is one of `Program.functions`; `params` are that function's own, each with this call's argument — all of
 * them worked out before any is set — `body` is empty, and `result` is this call's copy of what the function returned.
 */
export interface Call {
	name?: string;
	fn?: string;
	at: At;
	label: string;
	/** Parameters bound by copy (the function assigns them): a variable each, initialised from the argument. */
	params: {
		decl: VarDecl;
		init: NumExpr | BoolExpr | UnitExpr | TextExpr;
		label: string;
	}[];
	/** What the call returns, when it returns something: the variable `return` writes. */
	result?: {
		decl: VarDecl;
		kind: "number" | "boolean" | "unit" | "text";
	};
	/** On a call inside a recursive function that may come back into it; such a call is a statement, never inside an expression. */
	saves?: Saves;
	body: Stmt[];
}
export type Stmt = 
/** `failed`: the initializer did not compile (reported already); the variable still exists, unset. */
{
	kind: "declare";
	decl: VarDecl;
	init: NumExpr | BoolExpr | UnitExpr | TextExpr;
	failed?: boolean;
	at: At;
	label: string;
}
/** `s = value`, `s += "!"`: the text the variable held is given back once the new one is worked out. */
 | {
	kind: "assignText";
	target: string;
	value: TextExpr;
	at: At;
	label: string;
}
/** A text into cell `index` of the three arrays a `textAt` reads: worked out first, then what the cells held gives its block back, then the cells take the text — a copy of one that is only looked at. */
 | {
	kind: "storeText";
	addr: string;
	block: string;
	chars: string;
	index: NumExpr;
	value: TextExpr;
	at: At;
	label: string;
}
/** The block cell `index` of `block` names goes back to the heap, and the cell is 0: what a row that holds a text does before it goes. */
 | {
	kind: "releaseText";
	block: string;
	index: NumExpr;
	at: At;
	label: string;
}
/** `for (const ch of s)`: the body once a character, the text walked once — no `sleep` inside. `decl` is a made text of one character. */
 | {
	kind: "textLoop";
	decl: VarDecl;
	of: TextExpr;
	body: Stmt[];
	at: At;
	label: string;
} | {
	kind: "assign";
	target: string;
	value: NumExpr;
	at: At;
	label: string;
}
/** `let hp = [a, b, 0]` (`init`, a value a cell) or `new Array(12).fill(v)` (`fill`, one value for every cell): the array's cells are set, here and now. */
 | {
	kind: "declareArray";
	array: string;
	init?: (NumExpr | BoolExpr)[];
	fill?: NumExpr | BoolExpr;
	at: At;
	label: string;
}
/** `hp[i] = value`; nothing happens when the index is past either end (the value is evaluated either way). */
 | {
	kind: "store";
	array: string;
	index: NumExpr;
	value: NumExpr | BoolExpr;
	at: At;
	label: string;
}
/** `xs.push(value)`: one more cell at the end. When the heap has no block left for it, nothing is pushed and the game says so once. */
 | {
	kind: "push";
	array: string;
	value: NumExpr | BoolExpr;
	at: At;
	label: string;
}
/** `xs.pop();` with its value unused. */
 | {
	kind: "pop";
	array: string;
	at: At;
	label: string;
}
/** `xs.length = n`: the array is cut to n cells; an n above its length changes nothing. */
 | {
	kind: "setLength";
	array: string;
	value: NumExpr;
	at: At;
	label: string;
} | {
	kind: "assignBool";
	target: string;
	value: BoolExpr;
	at: At;
	label: string;
} | {
	kind: "assignUnit";
	target: string;
	value: UnitExpr;
	at: At;
	label: string;
}
/**
 * `for (const u of unitsAt(…))`: the body once for every unit the filter matches, in the order of
 * the game's unit table, all within the frame — no `sleep` inside. `decl` is the unit of the turn.
 * `source` (`on.created` / `on.died`): instead of the table, the units of this frame's events pass — the ones that
 * came onto the map since the pass of the frame before (`created`; one that has gone since is passed over), or that
 * died or were removed since then (`died`; the unit of the turn is the dead one, its fields read as it died, and
 * nothing done to it does anything); `killed` (those of `died` that died in a fight: their hit points 0, a player's
 * attack the last that hurt them); `ordered` (living units whose order is not the one the pass before found); `morphed`
 * (living units whose type is not the one the pass before found). `was`, when there: set at each turn to the killer,
 * the order the unit had, or the type it was. `event`: `ordered` only the units whose new order is `order`; `killed`
 * only the units `by` killed.
 */
 | {
	kind: "unitLoop";
	decl: VarDecl;
	filter: UnitFilter;
	source?: EventSource$1;
	was?: VarDecl;
	event?: {
		order?: number;
		by?: number;
	};
	body: Stmt[];
	at: At;
	label: string;
}
/** `u.hp = 40`, `u.invincible = true`: nothing happens when the unit is none or gone. */
 | {
	kind: "unitWrite";
	unit: UnitExpr;
	field: UnitNumField | UnitFlag;
	value: NumExpr | BoolExpr;
	at: At;
	label: string;
}
/** `u.kill()`, `u.order("move", there)`: nothing happens when the unit is none or gone. */
 | {
	kind: "unitDo";
	unit: UnitExpr;
	verb: UnitVerb;
	at: At;
	label: string;
}
/** `stats(units.TerranMarine).minerals = 25`. `scaled`: the value is already what the cell stores (a fraction known when the script was built); `boolean`: the value is a truth value, stored 1 or 0. */
 | {
	kind: "tableWrite";
	cell: TableCell;
	value: NumExpr | BoolExpr | TextExpr;
	scaled?: boolean;
	boolean?: boolean;
	at: At;
	label: string;
} | {
	kind: "if";
	cond: BoolExpr;
	then: Stmt[];
	else?: Stmt[];
	at: At;
	label: string;
}
/** `cond` absent means `while (true)`. */
 | {
	kind: "while";
	cond?: BoolExpr;
	body: Stmt[];
	at: At;
	label: string;
}
/** `before`: statements run before the test each turn, a `continue` included — made by the emitter's rewriter for a map of our own (a test that needs a value computed first); the front end writes none. */
 | {
	kind: "do";
	body: Stmt[];
	cond: BoolExpr;
	at: At;
	label: string;
	condLabel: string;
	before?: Stmt[];
}
/** `for` over a variable: `init` ran already (it is emitted before), this is the loop with its update. */
 | {
	kind: "for";
	cond?: BoolExpr;
	update: Stmt[];
	body: Stmt[];
	at: At;
	label: string; /** The loop is `name.sort(…)`: for the hint on its line; a lowering takes no notice. */
	sorts?: string;
}
/** A loop unrolled when the script was built: the body once per value, in order. */
 | {
	kind: "unrolled";
	iterations: Stmt[][];
	at: At;
	label: string;
} | {
	kind: "switch";
	value: NumExpr;
	cases: {
		value: number | null;
		body: Stmt[];
	}[];
	at: At;
	label: string;
} | {
	kind: "break";
	at: At;
	label: string;
} | {
	kind: "continue";
	at: At;
	label: string;
}
/** Inside an inlined call: leaves it, writing the result first when there is one. */
 | {
	kind: "return";
	value?: NumExpr | BoolExpr | UnitExpr | TextExpr;
	at: At;
	label: string;
}
/** `cycles` is a count of frames (`frames(n)`; `cycles(n)` is the older word for the same). */
 | {
	kind: "sleep";
	ms?: number;
	cycles?: number;
	at: At;
	label: string;
}
/**
 * `await Promise.all([…])` (`all`) / `await Promise.race([…])` (`race`): each branch is a coroutine of its own, started
 * here, in order, within this frame. From then on, every frame the program is here, each branch that has not ended
 * goes on from where it slept, in order, and the program goes on past this statement on the frame the last branch
 * ends (`all`) or the first does (`race`, whose other branches then stop where they are). A branch's `sleep` is its
 * own; `break`, `continue` and `return` never leave a branch.
 */
 | {
	kind: "parallel";
	mode: "all" | "race";
	branches: Stmt[][];
	at: At;
	label: string;
}
/**
 * `start(wave(n))`: a task — `call`, an async function's body inlined, its parameters copies of this start's arguments —
 * that runs beside what started it. Each `start` statement is a body of its own, `task` its number (they are numbered
 * from 1 in the order they are met, a task inside another's body after it), with `max` slots: that many of its tasks can
 * run at once, and a start with every slot taken starts nothing (the game says so once). A task starts in the frame it
 * is started in, once the program has given the frame back (it slept, waited or ended); from then on it goes on every
 * frame, after the program, the tasks in order of their number and slot. It runs on after the program ends. `handle`:
 * the variable that takes a number for the task — `slot | task << 8 | generation << 16`, the generation one more at
 * every start in the slot — or 0 when nothing started.
 */
/**
 * `listen` (on.created, on.died, on.chat, on.key): the task is a listener, whose body waits a frame at the top of a loop
 * that hands on what happened, so a turn when nothing did does nothing. Once it has begun, it is given a turn only in
 * a frame the events pass found units of `source`, or one of `inputs` arrived. A lowering may also give it every turn.
 */
 | {
	kind: "start";
	task: number;
	max: number;
	call: Call;
	handle?: string;
	listen?: {
		source?: EventSource$1;
		inputs?: InputSource[];
	};
	at: At;
	label: string;
}
/** `t.cancel()`: the task stops where it is. Nothing happens when it has ended, or the number is no task's. */
 | {
	kind: "cancel";
	task: NumExpr;
	at: At;
	label: string;
}
/** A trigger action; each of `variables` names a field that takes an expression's value instead of the record's. */
/**
 * `text`: the action's text is the program's. One of the table goes into the action as its id. One that was made is
 * written over a string of the table the build keeps for this kind of field — the objectives, a leaderboard's label, a
 * transmission: a player has one of each at a time — and only on the computer of a player the action is for, since the
 * game reads the string again whenever it draws; past `TEXT_FIELD_BYTES` it is cut.
 */
 | {
	kind: "action";
	record: ActionRecord;
	variables?: ActionVariable[];
	text?: TextExpr;
	at: At;
	label: string;
}
/** Centre a location on a point of the map, in pixels, its size kept. */
/** `size`: the location takes it too, centred on the point (nothing of the old size is read). */
/**
 * `sync(player, value)`'s first half (B5): on every computer, `player`'s arrival cell of slot `slot` (the `sync` input
 * source) is cleared to 0; on `player`'s own computer `value` + 1 is put where the input plugin sends it from, to arrive
 * on every computer as that cell a few frames later. `value` may be a `Local` one: it is the one thing that may be.
 */
 | {
	kind: "syncSend";
	slot: number;
	player: number;
	value: NumExpr;
	at: At;
	label: string;
}
/**
 * `select(player, units)` (B5): on `player`'s own computer, its selection becomes these units (up to 12, none left out
 * but those that are gone) — the panel told to show them again — and a Select command goes to every computer, so the
 * player's orders go to them everywhere. Done on every other computer, it does nothing.
 */
 | {
	kind: "select";
	player: number;
	units: UnitExpr[];
	at: At;
	label: string;
} | {
	kind: "centerLocation";
	location: number;
	x: NumExpr;
	y: NumExpr;
	size?: {
		width: NumExpr;
		height: NumExpr;
	};
	at: At;
	label: string;
}
/**
 * Text with values in it, shown to `to` — a slot, 13 for the current player, All Players or a
 * force — in the chat area or on the line in the middle of the screen the game's own errors use.
 */
 | {
	kind: "print";
	parts: TextPart[];
	to: number;
	position: "chat" | "center";
	at: At;
	label: string;
}
/**
 * The parts written at the end of buffer `buffer` (`reset`: the buffer emptied first): a text put together a piece at a
 * time, read back with `built`. A buffer is one place for the whole game, used up within the frame it is built in.
 */
 | {
	kind: "buildText";
	buffer: string;
	parts: TextPart[];
	reset?: boolean;
	at: At;
	label: string;
} | {
	kind: "call";
	call: Call;
	at: At;
	label: string;
}
/** A block only for scoping; nothing of its own. */
 | {
	kind: "block";
	body: Stmt[];
	at: At;
}
/**
 * `try { … } catch { … }`: `body` runs; when an error is thrown in it — a `throw`, a call that comes back with an error in
 * flight, a stack that ran out — the body stops there and `catch` runs, with the error still in flight
 * (`Program.errors`): its first statements are the front end's, which take the error and set `thrown` back to 0.
 * `finally` is the front end's too: a copy of it before every way out, and a `try` around the whole that runs it and
 * throws again. A `break`, `continue` or `return` inside `body` leaves it as it would leave a block.
 */
 | {
	kind: "try";
	body: Stmt[];
	catch: Stmt[];
	at: At;
	label: string;
}
/**
 * The error in flight (`Program.errors`, which the statements before this one set) goes to the nearest `try` around this
 * statement: the `catch` of one in this body, or, inside a called function, out of the function — which returns at
 * once, the error still in flight, to a call that goes on in the same way. `rethrow`: the error is one that was caught
 * and is thrown again, so where it was first thrown is still where it came from.
 */
 | {
	kind: "throw";
	rethrow?: boolean;
	at: At;
	label: string;
}
/**
 * The error in flight reached the end of a program, a task or a handler with nothing to catch it: said in red, as a fault
 * of the game's is — its class's name (`Program.errors.names` at `thrown`), its message and the line it was thrown at — and
 * given up (`thrown` 0). What it was thrown in then ends, as JavaScript's does: a program or a task stops, a handler of
 * an event gives up only this turn.
 */
 | {
	kind: "uncaught";
	at: At;
	label: string;
}
/** A word for the editor about a line: a loop unrolled when the script was built. */
 | {
	kind: "remark";
	text: string;
	short?: string;
	at: At;
}
/**
 * A map of our own only (`compiler/backend/texts.ts`): `decl`, a number, declared as the EPD of block `block` — a
 * string of the map's `bytes` long, laid out for it (one block for every statement that names it), empty at first or
 * holding `text`. `data`: bytes of the payload's instead, never shown as a string (the pool of blocks the cells of
 * arrays of texts that grow take: the game's own table of strings names only its first 64 KB in 1.16.1).
 */
 | {
	kind: "textBlock";
	decl: VarDecl;
	block: string;
	bytes: number;
	text?: string;
	data?: boolean;
	at: At;
}
/** A map of our own only: Display Text of block `block` as it is now, to `to` as a print's is. */
 | {
	kind: "showText";
	block: string;
	bytes: number;
	to: number;
	at: At;
}
/**
 * A map of our own only (`compiler/backend/units.ts`): the events pass's watch of the game's unit places — a trigger
 * for each, whose conditions read `fields` of the unit record where it is (`dword` into it, `mask`) against what the
 * trigger saw there last, its own numbers. A place as it was goes on to the next; one that changed runs `handler`,
 * with `@ev.e` the record's EPD and the current player at the trigger's first condition's number (`emit.ts`).
 */
 | {
	kind: "watch";
	fields: {
		dword: number;
		mask?: number;
		compare: "atLeast" | "exactly";
	}[];
	handler: Stmt[];
	gate?: boolean;
	at: At;
	label: string;
};
export interface Program {
	name?: string;
	owner: number;
	owners: number[];
	perPlayer: boolean;
	/** Every array of the program, those of inlined functions included: what a backend allocates before anything runs. */
	arrays: ArrayDecl[];
	/** The functions that are called rather than inlined; absent when there is none. */
	functions?: FuncDecl[];
	/** Present when the program throws or catches anything (B4): where an error in flight is kept. */
	errors?: ProgramErrors;
	/**
	 * A map of our own only (`compiler/backend/units.ts`): the frame's events pass — what came onto the map, died, took up
	 * an order or turned into another type since the pass before — run before the programs' turns, once for the map.
	 */
	pass?: Stmt[];
	/**
	 * A map of our own only (`compiler/backend/input.ts`): the frame's send pass — what this computer's player did,
	 * sent to every computer as game commands — run after the programs' turns, once for the map.
	 */
	after?: Stmt[];
	body: Stmt[];
	at: At;
}
/**
 * The error in flight, between a `throw` and the `catch` that takes it: `thrown` is its class's code — 0 when no error is
 * in flight, `ERROR_CODES` for the built-in classes, 16 and up for a program's own — and `message` its message, a made
 * text. Both are `shared` variables of the program, declared at the start of its body: an error is never in flight
 * across a frame, so one of each serves every player and every task. A class's own fields go through variables of their
 * own, which the front end copies; a backend knows only these two. `names` is the array of texts of the classes' names
 * by their code, which an uncaught error is said with.
 */
export interface ProgramErrors {
	thrown: string;
	message: string;
	names: string;
}
/** What the map's archive gets for a clip: a WAV's bytes now, or the samples of an Ogg Vorbis encoded when the map is built. */
export interface ClipFile {
	path: string;
	bytes?: Uint8Array;
	vorbis?: {
		rate: number;
		channels: readonly Float32Array[];
		quality: number;
	};
}
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
	buildTime: number;
	rank: number;
	matrix: number;
	speed: number;
	hallucinated: boolean;
	cloaked: boolean;
	burrowed: boolean;
	invincible: boolean;
	underAttack: boolean;
	speedUpgrade: boolean;
	hasTarget: boolean;
	inTransport: boolean;
	/** Still on the map. */
	alive: boolean;
	/** Its place in the unit table, from 0; another unit's once this one is gone. */
	slot: number;
	/** The place's uniqueness byte while this unit is in it. */
	uid: number;
	/** Once it has died in a fight: the player whose attack killed it (on.killed()). */
	killedBy?: number;
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
	/**
	 * The free places in the order the game hands them out (scm-sim docs/specs/unit-lists.md, section 3): at the start
	 * slot 0, then 1699, 1698 … 1; a place freed goes in right behind the first, so it is the one after the next.
	 */
	private readonly free;
	private readonly uids;
	private readonly classOf;
	private readonly properties;
	/** Kills by player and type of what was killed. */
	private readonly killed;
	constructor(options: WorldOptions, only: number);
	/** A unit on the map, in the place the game hands out next. Null when the table is full, as the game makes no unit then. */
	make(init: SimUnitInit): SimUnit | null;
	/** A unit given to a player. */
	setOwner(unit: SimUnit, to: number): void;
	/** A unit of a type as the game makes one: the type's hit points and shields, at a point. */
	create(type: number, owner: number, x: number, y: number, properties?: SimUnitProperties): SimUnit | null;
	/**
	 * Off the map, its place free for the next unit made. `killed`: it died. `fought`: it died in the game — shot, or
	 * killed by a spell — and so counts as a death, and as a kill of `by` when someone is named. A unit a trigger or a
	 * program kills (Kill Unit, a unit's kill(), hit points written down to 0) dies without counting: the lifted game
	 * says so for all three (TrigScript 4, A2, 2026-10-16), as the editor's trigger reference does for Kill Unit.
	 */
	gone(unit: SimUnit, killed: boolean, by?: number, fought?: boolean): void;
	/** The unit that was in a place when its uniqueness byte was `uid`: the one there now, or one long gone. */
	at(slot: number, uid: number): SimUnit | null;
	/**
	 * The units on the map, oldest first: the order of the game's table walked as it hands its places out (slot 0, then
	 * 1699 downwards), as long as no place freed has been handed out again — when the game frees a record, some frames after
	 * its unit is gone, is not something the simulator knows.
	 */
	living(): SimUnit[];
	private typed;
	private inside;
	/** The living units of these owners (any, when undefined), of a type or a class, inside a location — in table order. */
	matching(owners: readonly number[] | undefined, type?: number, location?: number): SimUnit[];
	/** The living units a program's loop comes to (TrigScript 4): oldest first, as `living` says. */
	listed(owners: readonly number[] | undefined, type?: number, location?: number): SimUnit[];
	/** Whether a unit, living or as it died, is of these owners (any, when undefined), of a type or a class, inside a location. */
	fits(u: SimUnit, owners: readonly number[] | undefined, type?: number, location?: number): boolean;
	centreOf(location: number): {
		x: number;
		y: number;
	};
	/** A location centred on a point, its size kept — or the size given. */
	centre(location: number, x: number, y: number, size?: {
		width: number;
		height: number;
	}): void;
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
	/** 0-based pass. */
	cycle: number;
	/** The game's frame it happened in: the first pass is on frame 2. */
	frame: number;
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
	/** A pass every frame from the first, as in a map built with a program (eudplib's eudTurbo). Default: the game's own schedule, one every 31 frames. */
	everyFrame?: boolean;
	/** How many milliseconds a frame lasts at the game speed, which a Wait is counted down in: 42 at Fastest (the default), 67 at Normal, 167 at Slowest. */
	msPerFrame?: number;
	/** The computer players: a Transmission of theirs does nothing. */
	computers?: readonly number[];
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
	/** Trigger × player: the copies that have run, where they stand. */
	private readonly copies;
	/** Each player's wait slot while it is busy: the milliseconds left. */
	readonly waiting: Map<number, number>;
	private readonly options;
	/** Passes run. */
	cycle: number;
	/** Frames run: the game's frame number. */
	frame: number;
	/** The game's pass countdown: a pass on the frame it is found at 0. */
	private countdown;
	constructor(triggers: TriggerRecord[], options?: SimulationOptions);
	/** A player's deaths of a unit; a group's are its players' together. */
	death(player: number, unit: number): number;
	/** Set for a player, or for each player of a group. */
	setDeath(player: number, unit: number, value: number): void;
	/** A Set Deaths action: set to, add or subtract, for each player the action names. */
	changeDeath(player: number, unit: number, modifier: number, amount: number): void;
	text(index: number): string | undefined;
	/** One frame of the game: the wait slots counted down, then a pass if one is due. True when a pass ran. */
	tick(): boolean;
	/** Frames until the next pass, and that pass. */
	step(): this;
	/** `cycles` passes. */
	run(cycles: number): this;
	/** One pass of the list, as the game makes it. */
	private pass;
	private condition;
	/** Runs an action of a copy; false when it holds the trigger there (a Wait or a Transmission with its time to run). */
	private action;
	private log;
}
/** Compile-result convenience: run a script's triggers for `cycles` passes. */
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
/** A line's cost over a test's run. */
export interface LineCost {
	file: string;
	line: number;
	/** Conditions and actions over the run. */
	total: number;
	/** The most in one frame, and the first frame it was that many. */
	peak: number;
	peakFrame: number;
	/** Frames the line ran in. */
	frames: number;
	/** The same as time in Remastered, when the host weighs: milliseconds over the run, the most in one frame and that frame. */
	ms?: {
		total: number;
		peak: number;
		peakFrame: number;
	};
}
/** A test's frames as time in Remastered (milliseconds), beside the counts, when the host weighs. */
export interface TestCostMs {
	/** The script's build, a frame: its lines and the build's own triggers, as `perFrame` counts them. */
	perFrame: number[];
	/** The map's other triggers a frame, as `other`. */
	other: number[];
	peak: number;
	peakFrame: number;
}
/** What a test's run in the game cost. */
export interface TestCost {
	/** The frame `perFrame` starts at. */
	from: number;
	/** Conditions and actions a frame that the script's build ran: its lines and the build's own triggers. */
	perFrame: number[];
	/**
	 * What the map's other triggers ran a frame: the start-up (once, by frame 2) and any trigger the map has besides the
	 * build's. Kept apart so that the script's own peak is not that start.
	 */
	other: number[];
	/** The most of `perFrame`, and the first frame it was that many. */
	peak: number;
	peakFrame: number;
	/** By line, the costliest first. */
	lines: LineCost[];
	/** Triggers the walk passed a frame, the map's other triggers included; when the host counts them. */
	triggers?: number[];
	/** The frames as time, when the host weighs. */
	ms?: TestCostMs;
}
export type Mode = "run" | "skip" | "only";
export interface Where {
	file: string;
	line: number;
	column?: number;
}
/** A test or a `describe`, as the editor lists it. `id` is the file and the names down to it: the same from one compile to the next. */
export interface TestInfo {
	id: string;
	kind: "suite" | "test";
	name: string;
	/** The `describe`s it is inside, outermost first. */
	path: string[];
	file: string;
	line: number;
	mode: Mode;
	/** A test's `{ players }`: run in the game as a copy for each. */
	players?: number[];
}
export interface TestEvent {
	frame: number;
	text: string;
	file?: string;
	line?: number;
	player: number;
}
export interface TestResult {
	id: string;
	status: "passed" | "failed" | "skipped";
	/** One line: "expected 8, got 6". */
	message?: string;
	/** The two values in full, when an `expect` compared two. */
	expected?: string;
	actual?: string;
	/** Where it failed: the `expect`'s line, the line that threw, or the program's line a fault happened at. */
	at?: Where;
	/** What was shown to the players, in order. */
	printed: string[];
	/** Everything that happened, by frame. */
	events: TestEvent[];
	frames: number;
	ms: number;
	/** In the lifted game: what the test's frames cost, by frame and by line (TrigScript 4, A4). */
	cost?: TestCost;
}
export interface TestReport {
	list: TestInfo[];
	/** Empty when the tests were only listed. */
	results: TestResult[];
	/** A `test.only` or `describe.only` is in the script: the rest of its file did not run. */
	only: Where[];
	ms: number;
}
/** The world every test starts from, as plain data. */
export interface TestWorld {
	units?: SimUnitInit[];
	locations?: Record<number, SimBounds>;
	players?: number[];
	forces?: Record<number, number>;
	/** The computer players among `players`: a Transmission of theirs does nothing. */
	computers?: number[];
	/** By unit type. */
	unitStats?: Record<number, {
		hp?: number;
		shields?: number;
		energy?: number;
	}>;
	/** Create Unit with Properties slots, the first at 0. */
	properties?: (SimUnitProperties | null)[];
	heapCells?: number;
	stackDepth?: number;
	/** Unit types by their name in lower case, for a `{…:unit}` typed in chat. */
	unitNames?: Record<string, number>;
}
export interface TestRunOptions {
	world?: TestWorld;
	/**
	 * A world other than the simulator's for each test (the lifted game's, `GameSim`): made fresh for every test,
	 * given the player the test asked to be (`{ as: P2 }`). Absent: the simulator.
	 */
	makeWorld?: (as?: number, test?: {
		id: string;
		players?: number[];
	}) => TestWorldLike;
	/** Run only these: tests of these files, or with these ids (a suite's id runs what is under it). Absent: all. */
	files?: string[];
	ids?: string[];
}
declare const WORLD: unique symbol;
/** What a test can ask of its world, whichever it was handed. */
export interface TestWorldLike {
	readonly [WORLD]: true;
	/** What the test's frames cost, where the world counts it (the lifted game's). */
	cost?(): TestCost | null;
	faultsExpected: boolean;
	readonly frame: number;
	seed(n: number): this;
	frames(n?: number): this;
	seconds(n: number): this;
	until(done: () => unknown, most?: number): this;
	place(player: number, type: number, at: number, n?: number): SimUnit[];
	kill(unit: SimUnit, by?: number): this;
	remove(unit: SimUnit): this;
	give(unit: SimUnit, to: number): this;
	morph(unit: SimUnit, type: number): this;
	move(unit: SimUnit, to: number | {
		x: number;
		y: number;
	}): this;
	press(key: string, player?: number): this;
	click(button?: "left" | "right" | "middle", player?: number): this;
	type(line: string, player?: number): this;
	moveMouse(x: number, y: number, player?: number): this;
	moveCamera(x: number, y: number, player?: number): this;
	selectUnits(units: readonly SimUnit[], player?: number): this;
	count(player: number, type: number, at?: number): number;
	units(filter?: {
		owner?: number;
		type?: number;
		at?: number;
	}): SimUnit[];
	resources(player: number): {
		ore: number;
		gas: number;
	};
	deaths(player: number, type: number): number;
	kills(player: number, type: number): number;
	switch(n: number): boolean;
	fog(player: number, area?: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): string[] | null;
	location(n: number): SimBounds | undefined;
	program(name?: string | number, player?: number): Record<string, unknown>;
	printed(player?: number): string[];
	log(sourceOf?: (trigger: number) => Where | null): TestEvent[];
	readonly events: TestEvent[];
	readonly faults: {
		at: At;
		message: string;
		cycle: number;
		frame: number;
		program: number;
	}[];
}
export interface LinkedFile {
	/** The emitted JavaScript. */
	js: string;
	/** Its source map (JSON), when emitted. */
	map?: string;
}
/**
 * The map's player settings, as a map of our own needs them (TrigScript 4, step 7): the slots a human or a computer
 * plays (0-based, P1 to P8), and each slot's force (0 to 3). Who a program runs for, who All Players and a force are,
 * whether a player can have left.
 */
export interface MapPlayers {
	slots: number[];
	forces: number[];
}
/** The script's files by path (`main.ts`, `bases.ts`, `ai/waves.ts`). */
export type ScriptFiles = Record<string, string>;
export interface ScriptDiagnostic {
	file: string;
	/** 1-based. */
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	message: string;
	/** TypeScript's checker, the program compiler, or the script itself throwing when it ran. */
	source: "typescript" | "compiler" | "script";
}
export interface TriggerSource {
	file: string;
	/** 1-based: the `trigger(` call, or the statement of a program the trigger came from. */
	line: number;
}
/** A span of a file, 1-based, the end exclusive. */
export interface SourceRange {
	file: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}
export interface VariableInfo {
	name: string;
	/** `unit`: a unit of the game, or none. `text`: a string. */
	kind: "number" | "boolean" | "unit" | "text";
	/** Index into `programs` of the program it belongs to. */
	program: number;
	/** One value for every player of a per-player program (`shared(…)`); otherwise a per-player program has one per player. */
	shared: boolean;
	/** Where the variable is declared. */
	at: {
		file: string;
		line: number;
		column: number;
	};
	/** A `u8` (8) or `u16` (16) variable; unset for the full 32 bits. */
	bits?: number;
	/** A `u32`; unset, a number is signed. */
	unsigned?: boolean;
	/** A `fixed`: a number with a fraction (16.16). */
	fixed?: boolean;
}
/** Something the compiler has to say about a line that is not a fault: a loop unrolled when the script was built. */
export interface LineHint {
	file: string;
	line: number;
	/** The short form the editor shows at the end of the line ("unrolled ×6"). */
	label: string;
	note: string;
}
export interface ProgramInfo {
	/** `const award = game(…)`: the name, when the program has one. */
	name?: string;
	/** A player slot the program runs as (0-based; the first, when it runs for several) — what a simulation runs it as. */
	owner: number;
	/** The player groups it runs for: slots, or All Players / a force. */
	owners: number[];
	/** Runs for several players at once, every variable per player. */
	perPlayer: boolean;
	/** Where the `program(` call is. */
	source: TriggerSource;
}
/** Where the script names one of the map's things: `locations.Beacon`, `switches["Door"]`, resolved by the checker — through aliases and namespace imports, never in a comment, a string or a shadowing variable. */
export interface MapReference extends SourceRange {
	/** The table (`locations`, `switches`, `units`, `players`, `aiScripts`). */
	object: string;
	key: string;
	/** `locations["Beacon"]`: the range covers the string literal, quotes included. */
	quoted: boolean;
}
export interface CompileResult {
	/** The `trigger()` calls' records, in order — ordinary triggers, written into the map. Programs are not in here: see `ir`. */
	triggers: TriggerRecord[];
	/** Per trigger, where it came from; null for a hyper trigger. */
	sources: (TriggerSource | null)[];
	/** Local string table: a record's `text` / `wav` field `k > 0` means `strings[k - 1]`. */
	strings: ScriptString[];
	/**
	 * The clips the script plays (`sound.ts`), as the files the map's archive gets, by their names there: once each. An
	 * Ogg Vorbis one has its samples instead of bytes until `finishSounds` (`vorbis.ts`) encodes it; after a compile with
	 * `sounds: false` (a check) each is its name alone: the map is to get them from a build.
	 */
	sounds: ClipFile[];
	diagnostics: ScriptDiagnostic[];
	/** The programs' variables, in declaration order; a function's copies and results are left out. */
	variables: VariableInfo[];
	programs: ProgramInfo[];
	/** Inside the programs, the expressions computed when the script is built rather than in the game — what the editor underlines. */
	buildTime: SourceRange[];
	/** What the compiler did to a line that is worth a word at its end. */
	hints: LineHint[];
	/** Every `locations.X` / `switches.X` / … the files mention, whatever else went wrong (a rename is what makes them not type-check). */
	refs: MapReference[];
	/** The programs as IR (`ir.ts`), one per `program()` in order — what the build lays out into the map on save. A map with any needs StarCraft: Remastered. */
	ir: Program[];
	/** What the programs read of the players — keys, clicks, the mouse, typed lines — and what carrying it takes from the map (`input.ts`); null when they read none. */
	input: InputPlan | null;
	/** The script's `test()`s, and what running them found; null when it has none, or did not compile that far. */
	tests: TestReport | null;
	/**
	 * The script as JavaScript, file by file, when it has tests and compiled: what runs them somewhere else — in the
	 * lifted game, beside the engine (`gameTests.ts`) — without TypeScript there.
	 */
	modules?: [
		string,
		LinkedFile
	][];
	/**
	 * Why a map of our own does not take the programs (`backend/own.ts`, `emitOwn`), when the compile was asked
	 * (`CompileOptions.own`) and it does not: the first part it never takes, with its line. Absent when it takes them,
	 * when there are none, or when the script did not compile.
	 */
	ownRefusal?: string;
	/** No errors: `triggers` and `ir` are the complete output. */
	ok: boolean;
}
/** The map a compile is checked against for a map of our own (`CompileOptions.own`): who plays, and the map's size in pixels. */
export interface OwnCheck {
	players: MapPlayers;
	humans: number[];
	width: number;
	height: number;
}
export interface CompileOptions {
	/** The standard library's declarations (`lib.es2023.d.ts` and what it references, concatenated). */
	lib: string;
	/** Run the script's tests after a compile that went through: the world they start from, and which of them. Absent: they are listed and not run. */
	tests?: TestRunOptions;
	/** false: no value ranges (`ranges.ts`) — what a test compares a program with them against. */
	ranges?: boolean;
	/**
	 * false: the clips the script plays are named, not made — a check as the user types, whose sounds the map does not
	 * get (`sound.ts`'s clips work their samples out only when asked). A build's compile leaves it out.
	 */
	sounds?: boolean;
	/**
	 * Ask whether a map of our own takes the programs as they are, for this map (`ownRefusal`): what the editor shows
	 * as a problem while the script is typed, so that a map does not change builds without anyone seeing.
	 */
	own?: OwnCheck;
	/**
	 * Files among `files` that run as entries of their own after the entry, in order — what another plugin contributes
	 * to the build (`service.ts`, `contribute`): their `program()`s come after the script's. One that is not among the
	 * files is an error.
	 */
	entries?: readonly string[];
}
/** Compile a script against a map's names. Never throws for script errors — read `diagnostics`. */
export declare function compileScript(ts: typeof TS, files: ScriptFiles, names: ScriptNames, options: CompileOptions): CompileResult;
/** The concatenated standard library text (`lib.es2022.d.ts` and what it references). */
export function defaultLib(): string;

export {};
