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
/** 1 on the frame the key's press arrives. */
{
	source: "key";
	key: string;
	player: number;
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
};
/** Everything the input plugins are set up from, written into the IR file beside the programs. */
export interface InputPlan {
	keys: string[];
	buttons: MouseButton[];
	chats: ChatPattern[];
	/** Unit names a `{…:unit}` capture knows, lower case, with the type each means; only when one is used. */
	unitNames?: [
		name: string,
		id: number
	][];
	/** The location MSQC keeps for itself, as its 0-based slot. */
	qcLocation: number;
	/** The 1-based number of the first of eight locations in a row MSQC keeps the players' mice in; null when no program reads the mouse. */
	mouseBase: number | null;
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
	/** `shared(…)`: one cell for every player of a per-player program. */
	shared: boolean;
	/** A `u8` / `u16` annotation; unset for the full 32 bits. */
	bits?: 8 | 16;
	/** A `u32`: the 32 bits read as 0 … 4 294 967 295. Unset, a number is signed (a `u8` / `u16` never goes below zero either way). */
	unsigned?: boolean;
	/** A backend's scratch value that dies with the statement (a function's result). */
	temp?: boolean;
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
	values?: number[];
	/** A list of texts the script has, which a program indexes with a variable (`titles[level]`): `values` are their places here, the lowering's their ids in the built map's table. */
	texts?: string[];
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
export type ReadSource = {
	source: "condition";
	record: ConditionRecord;
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
/** A number of a unit on the map. Hit points, shields and energy are whole points; the timers and the cooldown frames. */
export type UnitNumField = "hp" | "maxHp" | "shields" | "maxShields" | "energy" | "owner" | "type" | "x" | "y" | "kills" | "orderId" | "cooldown" | "resources" | "stim" | "ensnare" | "plague" | "lockdown" | "maelstrom" | "irradiate" | "stasis";
/** A true / false of a unit on the map; only `invincible` takes a write. */
export type UnitFlag = "hallucinated" | "cloaked" | "burrowed" | "invincible" | "underAttack";
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
export type NumExpr = {
	kind: "const";
	value: number;
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
	to: "u32" | "i32";
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
/** `unsigned`, on `min` and `max`: the arguments are compared as `u32`s. `abs` is of a signed number. */
 | {
	kind: "intrinsic";
	name: "min" | "max" | "abs";
	args: NumExpr[];
	unsigned?: boolean;
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
};
export type BoolExpr = {
	kind: "const";
	value: boolean;
}
/** A trigger condition the script wrote, its fields known when the script is built. */
 | {
	kind: "cond";
	record: ConditionRecord;
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
/** `unsigned`: printed as a `u32`; unset, a number below zero has its minus sign. */
 | {
	kind: "number";
	expr: NumExpr;
	unsigned?: boolean;
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
 */
 | {
	kind: "unitLoop";
	decl: VarDecl;
	filter: UnitFilter;
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
} | {
	kind: "do";
	body: Stmt[];
	cond: BoolExpr;
	at: At;
	label: string;
	condLabel: string;
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
 | {
	kind: "centerLocation";
	location: number;
	x: NumExpr;
	y: NumExpr;
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
/** A word for the editor about a line: a loop unrolled when the script was built. */
 | {
	kind: "remark";
	text: string;
	short?: string;
	at: At;
};
export interface Program {
	version: number;
	name?: string;
	owner: number;
	owners: number[];
	perPlayer: boolean;
	/** Every array of the program, those of inlined functions included: what a backend allocates before anything runs. */
	arrays: ArrayDecl[];
	/** The functions that are called rather than inlined; absent when there is none. */
	functions?: FuncDecl[];
	body: Stmt[];
	at: At;
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
	/** Run only these: tests of these files, or with these ids (a suite's id runs what is under it). Absent: all. */
	files?: string[];
	ids?: string[];
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
	/** The programs as IR (`ir.ts`), one per `program()` in order — what eudplib builds into the map on save. A map with any needs StarCraft: Remastered. */
	ir: Program[];
	/** What the programs read of the players — keys, clicks, the mouse, typed lines — and what carrying it takes from the map (`input.ts`); null when they read none. */
	input: InputPlan | null;
	/** The script's `test()`s, and what running them found; null when it has none, or did not compile that far. */
	tests: TestReport | null;
	/** No errors: `triggers` and `ir` are the complete output. */
	ok: boolean;
}
export interface CompileOptions {
	/** The standard library's declarations (`lib.es2023.d.ts` and what it references, concatenated). */
	lib: string;
	/** Run the script's tests after a compile that went through: the world they start from, and which of them. Absent: they are listed and not run. */
	tests?: TestRunOptions;
}
/** Compile a script against a map's names. Never throws for script errors — read `diagnostics`. */
export declare function compileScript(ts: typeof TS, files: ScriptFiles, names: ScriptNames, options: CompileOptions): CompileResult;
/** The concatenated standard library text (`lib.es2022.d.ts` and what it references). */
export function defaultLib(): string;

export {};
