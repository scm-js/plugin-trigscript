/**
 * The `.d.ts` a script is checked against: the library (`trigscript`) as types, plus
 * tables generated from the map — its locations, switches, forces and custom unit
 * names — so Monaco completes `locations.` with what the map actually has and a
 * misspelt name is a type error, not a bare number.
 *
 * Everything is declared twice: as globals, so a file works without an import line, and
 * as the ambient module `"trigscript"`, so `import { trigger } from "trigscript"` works
 * too. The runtime (`runtime.ts`) provides the same names as values; `runtimeNames`
 * is the list both are checked against.
 *
 * `compact` is the variant a language model reads: globals only, each unit once, the
 * first sixteen switches and every named one, AI scripts as an index signature.
 */
import { ACTION_FIELDS, CONDITION_FIELDS } from "./record";
import { READ_ARITY } from "./runtime";
import { ACTION_IDENTS, argType, CHOICE_TYPES, choiceWords, CONDITION_IDENTS, MODULE_NAME, propertyKey, scriptParams, TRIGGER_OPTION_NAMES } from "./api";
import type { ActionDef, ArgKind, ConditionDef } from "../vendor/triggerDefs";
import { allTables, defaultScriptNames, type NameTable, type ScriptNames } from "./names";
import { PLAYER_COLORS, TABLE_FIELDS, type TableKind } from "./tables";
import { LOCAL_FIELDS, MEMORY_FIELDS, MEMORY_GROUPS, type MemoryField } from "./memory";
import { PLAYER_SLOTS } from "./lower";
import { KEY_NAMES } from "./input";
import { TEXT_COLORS } from "./jsx";

export const DECLARATIONS_FILE = "trigscript.d.ts";

export interface DeclarationOptions {
  compact?: boolean;
}

const HEADER = `// ── TrigScript ────────────────────────────────────────────────────────────
// Generated for the open map; rebuilt whenever the map's names change. Do not edit.
//
// A script is ordinary TypeScript that runs when you build: every trigger() it calls
// becomes one trigger of the map, in order. Code inside program(() => { … }) runs in
// the game instead (StarCraft: Remastered), built into the map when it is saved.
`;

function types(kw: string): string {
  return `
${kw}type Brand<K extends string> = { readonly __kind?: K };
/** A player or player group (P1 … P12, CurrentPlayer, AllPlayers, players.*, or a raw group number). */
${kw}type Player<N extends number = number> = N & Brand<"player">;
/** A unit type (units.*, or a raw units.dat id): what a condition or an action names. A unit on the map is a Unit. */
${kw}type UnitType<N extends number = number> = N & Brand<"unit">;
/** A weapon (weapons.*, or a raw weapons.dat id), for stats(). */
${kw}type Weapon<N extends number = number> = N & Brand<"weapon">;
/** An upgrade (upgrades.*, or a raw upgrades.dat id), for stats(). */
${kw}type Upgrade<N extends number = number> = N & Brand<"upgrade">;
/** A technology (techs.*, or a raw techdata.dat id), for stats(). */
${kw}type Tech<N extends number = number> = N & Brand<"tech">;
/** An order (orders.*, or a raw orders.dat id): what a unit is doing. */
${kw}type Order<N extends number = number> = N & Brand<"order">;
/** A player colour (colors.*), for stats(player).color. */
${kw}type PlayerColor<N extends number = number> = N & Brand<"color">;
${kw}type ColorName = __COLOR_NAMES__;
/** A location (locations.*, or a raw 1-based location number; 0 = none). */
${kw}type Location<N extends number = number> = N & Brand<"location">;
/** A switch (switches.*, or a raw 0-based switch number). */
${kw}type Switch<N extends number = number> = N & Brand<"switch">;
/** A sound of the map (sounds.*, the Sound Editor's list): the string of its path, what playWav() takes. A path in the map's archive as text also works. */
${kw}type Sound<N extends number = number> = N & Brand<"sound">;
/** An AI script (aiScripts.*; a four-character code or StarEdit name as a string also works). */
${kw}type AiScript<N extends number = number> = N & Brand<"aiScript">;
/** A race (races.*), as race() returns it. */
${kw}type Race<N extends number = number> = N & Brand<"race">;
/** What holds a player's slot (slots.*), as slot() returns it. */
${kw}type Slot<N extends number = number> = N & Brand<"slot">;
/** A unit count: a number, or "All". */
${kw}type Count = number | "All";
/** A number of a program that stays within 0 … 255: stored below zero it is 0, above 255 it is 255. A plain \`number\` is signed and wraps. */
${kw}type u8 = number & Brand<"u8">;
/** A number of a program that stays within 0 … 65 535: stored below zero it is 0, above 65 535 it is 65 535. */
${kw}type u16 = number & Brand<"u16">;
/**
 * A number of a program read as 0 … 4 294 967 295, wrapping as \`x >>> 0\` does: for bit masks, hashes and a count past
 * 2 147 483 647. A plain \`number\` is signed. The two do not mix in arithmetic without saying which is meant — u32(x), i32(x) —
 * but compare exactly: a number below zero is smaller than any u32.
 */
${kw}type u32 = number & Brand<"u32">;
/**
 * A number with a fraction: 16.16 fixed point, −32 768 … 32 767.99998 in steps of 1/65 536. A number is one as soon as a
 * fraction is stored into it (\`let x = 0.5\`, \`x += speed * 0.1\`, \`Math.cos(a)\`), so the annotation is only needed
 * to say so before anything does. + − × ÷ and the comparisons work as on any number, and a whole number beside one is
 * turned into one; Math.floor / round / trunc / ceil make a whole number of it, which is what an index, a count or a
 * place on the map takes. Math.sqrt, sin, cos, tan, atan, atan2 and hypot give one (angles in radians, as in JavaScript).
 */
${kw}type fixed = number & Brand<"fixed">;
/** A function that runs in the game, as returned by game(): call it inside program() or another game function. */
${kw}type GameFunction<F extends (...args: never[]) => unknown> = F & { readonly __game: true };

/** A condition, as returned by bring(...), deaths(...), …: give it to trigger(), or test it in an if inside program(). */
${kw}interface Condition { readonly __condition: true; }
/** An action, as returned by displayText(...), setDeaths(...), …: give it to trigger(), or call it as a statement inside program(). */
${kw}interface Action { readonly __action: true; }
/** A trigger, as returned by trigger(). */
${kw}interface Trigger { readonly __trigger: true; }
/** A length of time, from seconds(), minutes() or frames(): what sleep() takes. */
${kw}interface Duration { readonly __duration: true; }
/** Conditions, nested arrays allowed (they are flattened); false / null / undefined entries are skipped. */
${kw}type Conditions = readonly (Condition | Conditions | false | null | undefined)[];
/** Actions, nested arrays allowed (they are flattened); false / null / undefined entries are skipped. */
${kw}type Actions = readonly (Action | Actions | false | null | undefined)[];

${kw}interface TriggerOptions {
${TRIGGER_OPTION_NAMES.map(([, name]) => `  ${name}?: boolean;`).join("\n")}
  /** Raw execution flags, ORed in. */
  flags?: number;
}

/**
 * A unit on the map, inside program() only: one of the game's units as it is right now. Get one from a
 * loop — \`for (const u of unitsAt(locations.Pen, { owner: P2 })) u.hp = u.maxHp / 2;\` — or a pick,
 * which may find none: \`const t = nearest(units.TerranMarine, locations.Beacon); if (t) t.order("move", locations.Exit);\`
 * A variable may keep a unit across a sleep(). The game reuses a dead unit's place for a new one, so
 * every use checks that the unit is still the one that was kept: once it is gone, its numbers read 0,
 * its booleans false, and writing to it or telling it something does nothing. \`if (u)\` asks whether it is still there.
 */
${kw}interface Unit {
  readonly __unit: true;
  /** Hit points, in whole points as the game shows them. Writing 0 kills the unit. */
  hp: number;
  /** The type's hit points. */
  readonly maxHp: number;
  /** Shield points. */
  shields: number;
  /** The type's shield points. */
  readonly maxShields: number;
  /** Energy, 0 … 255. */
  energy: number;
  /** Who owns the unit; give() changes it. */
  readonly owner: Player;
  /** What the unit is: \`if (u.type == units.TerranMarine)\`. */
  readonly type: UnitType;
  /** Where the unit is, in pixels (32 a tile). Read only: the game ends when a position is written. */
  readonly x: number;
  readonly y: number;
  /** How many units it has killed, 0 … 255. */
  kills: number;
  /** What the unit is doing: \`if (u.orderId == orders.Move)\`. orders.PlayerGuard is standing guard, orders.AttackUnit attacking. */
  readonly orderId: Order;
  /** Frames until the unit can attack or cast again, 0 … 255; writing it holds the unit's fire that long. */
  cooldown: number;
  /** What a mineral field or a geyser still holds. */
  resources: number;
  /** Frames left of each effect, 0 … 255: write one to start, lengthen or end it. Stim, ensnare and the rest tick down about every eighth frame. */
  stim: number;
  ensnare: number;
  plague: number;
  lockdown: number;
  maelstrom: number;
  irradiate: number;
  stasis: number;
  /** Whether the unit cannot be hurt. */
  invincible: boolean;
  readonly hallucinated: boolean;
  readonly cloaked: boolean;
  readonly burrowed: boolean;
  /** True for about a second after something hit the unit. */
  readonly underAttack: boolean;
  /** Send the unit somewhere, as the Order action does, this unit alone. */
  order(order: "move" | "patrol" | "attack", target: Location): void;
  /** Hand the unit to another player. */
  give(player: Player): void;
  kill(): void;
  /** Take the unit off the map without a death. */
  remove(): void;
  /** Take hit points away — so many, or a percentage of the type's maximum; at 0 the unit dies. Shields are left alone. */
  damage(amount: number | { percent: number }): void;
  /** Give hit points back, up to the type's maximum. */
  heal(amount: number | { percent: number }): void;
  /** Centre a location on the unit, its size kept: then createUnit(), moveUnit() and the rest can happen where the unit is. */
  locate(location: Location): void;
}
/** Which units a loop or a pick looks at; a part left out matches all. units.Men, units.Buildings and units.Factories work as a type. */
${kw}interface UnitFilter {
  type?: UnitType;
  owner?: Player;
  /** Inside this location. */
  at?: Location;
}
/** A key keyPressed() knows. F2 to F6 are not among them: StarCraft: Remastered reports no press of them. */
${kw}type Key = __KEY_NAMES__;
/** What a chatted() pattern's captures are read as: {n} a number, {unit:unit} a unit type, {kind:ore|gas} the place of the word in its list. */
${kw}type ChatCapture<C extends string> = C extends \`\${infer N}:unit\` ? { readonly [K in N]: UnitType } : C extends \`\${infer N}:\${string}\` ? { readonly [K in N]: number } : { readonly [K in C]: number };
${kw}type ChatValues<P extends string> = P extends \`\${string}{\${infer C}}\${infer Rest}\` ? ChatCapture<C> & ChatValues<Rest> : {};
__STATS_TYPES__
${kw}interface ProgramOptions {
  /**
   * Who the program runs for (default P1). One player: one thread, as that player. AllPlayers, a
   * force (players.Force1) or a list of players: the program runs once for each of them at the
   * same time, CurrentPlayer is that player, and every variable is per player — each player has
   * their own copy (a variable declared with shared() is one cell they all share).
   */
  owner?: Player | readonly Player[];
  /** What the program is called: in the Explorer's list, and by a test — sim.program("waves"). */
  name?: string;
}
`;
}

const COLOR_NAMES = Object.keys(PLAYER_COLORS).map((w) => JSON.stringify(w)).join(" | ");
const TEXT_COLOR_TABLE = Object.entries(TEXT_COLORS).map(([w, n]) => `readonly ${w}: ${n}`).join("; ");
const COLOR_TABLE = Object.entries(PLAYER_COLORS).map(([w, n]) => `readonly ${w}: PlayerColor<${n}>`).join("; ");

function choiceTypes(kw: string): string {
  const out: string[] = [];
  for (const [kind, name] of Object.entries(CHOICE_TYPES) as [ArgKind, string][]) {
    out.push(`${kw}type ${name} = ${choiceWords(kind).map((w) => JSON.stringify(w)).join(" | ")};`);
  }
  return out.join("\n");
}

function functions(kw: string): string {
  return `
/**
 * Define one trigger. The script's triggers become a contiguous, generated block of the
 * map's trigger list in the order they are defined; hand-made triggers around it are left alone.
 * @param players The player or players the trigger runs for.
 * @param conditions Up to 16 conditions; a trigger with none never fires.
 * @param actions Up to 64 actions.
 * @param options Execution flags: { preserve: true } is the same as a preserveTrigger() action.
 */
${kw}function trigger(players: Player | readonly Player[], conditions: Conditions, actions: Actions, options?: TriggerOptions): Trigger;
/**
 * Code that runs in the game, every frame, from where it left off. Inside the arrow,
 * variables hold whole numbers (32-bit and signed, wrapping at the ends; u8, u16 and u32 are
 * the other widths), booleans, text, units and arrays (a const computed from them is
 * one too, and cannot be reassigned; \`let p = { lives: 3 }\` is a record of them); if / else,
 * while, do, for, switch, break, continue, ?: and functions (arguments passed by value,
 * return values allowed) all work; conditions go in an if or while and
 * actions stand as statements. The body runs until it sleeps or ends, all within one frame:
 * a loop runs to completion at once, so a loop that goes on for ever needs a sleep() inside
 * it — \`while (true) { …; sleep(frames(1)); }\` is a game loop. Arithmetic: + − × / %,
 * Math.min / max / abs, clamp(). Everything the body reads from outside (constants, helpers,
 * conditions, actions) is computed when you build — the editor underlines those parts — so
 * it cannot depend on the variables, except the amount of setResources / setDeaths /
 * setScore / setCountdownTimer, the unit count of createUnit / killUnitAt / removeUnitAt /
 * giveUnits and an action's unit type, which can be variables, and the text of displayText() /
 * print(), which can hold numbers of the program. The game's own values are reads:
 * minerals(P1), deaths(P1, unit), … and what the players do: keyPressed(), clicked(), mouse(), chatted().
 *
 * A map with a program in it needs StarCraft: Remastered: the programs are built into the
 * saved map by the eudplib plugin. trigger() makes ordinary triggers that play anywhere.
 */
${kw}function program(body: () => void, options?: ProgramOptions): void;
/**
 * A function that runs in the game, for programs to call — from any file, imported like any
 * other: \`export const award = game((p: Player, n: number) => { setResources(p, "add", n, "ore"); })\`.
 * Its body follows program()'s rules; arguments pass by value and it may return a value. Calling it when the script is built is an error.
 */
${kw}function game<F extends (...args: any[]) => unknown>(body: F): GameFunction<F>;
/** Three preserved triggers of sixty-two Wait(0) each: the game goes through the trigger list every 2 frames instead of every 31. Owned by one player whose triggers never wait: a player has one wait slot. */
${kw}function hyperTriggers(owner?: Player): void;
/** A coin toss, inside program() only: \`flag = random()\`, \`if (random() && …)\`. */
${kw}function random(): boolean;
/** A whole number from 0 to n − 1, picked by the game; inside program() only: \`let lane = random(3)\`. n may be a variable; 0 gives 0. */
${kw}function random(n: number): number;
/** A length of time in seconds, for sleep(): twenty-four frames a second at Fastest. */
${kw}function seconds(n: number): Duration;
/** A length of time in minutes, for sleep(). */
${kw}function minutes(n: number): Duration;
/** A length of time in frames of the game, for sleep(): sleep(frames(1)) ends this frame's turn and goes on in the next. */
${kw}function frames(n: number): Duration;
/** @deprecated The same as frames(): a program's clock is the frame. */
${kw}function cycles(n: number): Duration;
/**
 * Pause the program, inside program() only: the statements after it run that much later, and nothing
 * else of this program runs meanwhile (other programs and triggers go on). \`while (true) { spawn(); await sleep(seconds(15)); }\`
 * is a wave every fifteen seconds. Unlike wait(), it takes nothing from the triggers: a Wait uses the player's one wait slot.
 * In an async function it is awaited; in a program that is not async, \`sleep(…)\` on its own pauses as before.
 */
${kw}function sleep(duration: Duration): Promise<void>;
/**
 * Wait for the next frame — the same as sleep(frames(1)), as a frame loop reads:
 * \`while (true) { …draw…; await nextFrame(); }\`. Inside program() only.
 */
${kw}function nextFrame(): Promise<void>;
/**
 * Wait until a condition holds, inside an async program only: \`await until(() => countUnits(P8, units.ZergZergling) === 0)\`.
 * The function is asked once now and then once every frame; the program goes on in the frame it answers true.
 * A condition on its own is asked again the same way: \`await until(bring(P1, units.AnyUnit, locations.Exit, ">=", 1))\`.
 */
${kw}function until(test: (() => boolean) | Condition): Promise<void>;
/**
 * A task that start() started: \`t.cancel()\` stops it where it is, \`t.running\` is true until it ends or is cancelled,
 * and \`await t\` waits for it to end. Kept in a variable, it is a number of the program, 0 for none.
 */
${kw}interface Task extends Promise<void> {
  readonly __task: true;
  /** Stop the task where it is. Nothing happens when it has ended already. */
  cancel(): void;
  /** True until the task ends or is cancelled. */
  readonly running: boolean;
}
/**
 * Start a task and go on without waiting for it, inside an async program only: \`start(wave(3))\`, or
 * \`start(async () => { … })\`. The arguments are worked out now; the task runs beside the program, from this frame on,
 * and keeps running after the program ends. \`void wave(3)\` starts one too, without a Task to keep.
 *
 * Each start() is a body of its own, and \`max\` of its tasks (16 unless said) can run at once: a start with all of
 * them running starts nothing, and the game says so. \`for (…) start(wave(n), { max: 40 })\`. A loop unrolled when the
 * script is built has a start() for each of its turns.
 */
${kw}function start(task: Promise<unknown> | (() => Promise<unknown>), options?: { max?: number }): Task;
/** True on the frame its condition becomes true, false until it becomes false and true again. Inside program(), in an if: \`if (rose(bring(…)))\`. */
${kw}function rose(condition: Condition | boolean): boolean;
/** True the first time its condition holds, never again. Inside program(), in an if. */
${kw}function once(condition: Condition | boolean): boolean;
/** In a program that runs for several players, a variable they all share instead of one per player: \`let total = shared(0)\`. */
${kw}function shared(initial: number): number;
${kw}function shared(initial: boolean): boolean;
${kw}function shared(initial: number[]): number[];
${kw}function shared(initial: boolean[]): boolean[];
/** The value kept within low … high: Math.min(Math.max(value, low), high). Works on variables inside program() and on numbers outside. */
${kw}function clamp(value: number, low: number, high: number): number;
/** The same 32 bits read as a u32: u32(-1) is 4 294 967 295. Costs nothing in a program; \`x >>> 0\` says the same. */
${kw}function u32(value: number): u32;
/** The same 32 bits read as a signed number: i32(4294967295) is -1. Costs nothing in a program; \`x | 0\` of a u32 says the same. */
${kw}function i32(value: number): number;
/** A whole number as a fixed one, so that what is computed with it keeps the fraction: 3 / 2 is 1, 3 / fixed(2) is 1.5. Costs a shift in a program. */
${kw}function fixed(value: number): fixed;
/**
 * Reads, inside program() only: a value the game holds, read when the line runs. Use it wherever a
 * number goes — \`let ore = minerals(P1)\`, \`if (minerals(CurrentPlayer) > price * 2)\`,
 * \`setResources(P2, "set", minerals(P1), "ore")\`. Every condition that compares a quantity is
 * also a read when called without its comparison and amount: \`deaths(P1, units.TerranMarine)\`,
 * \`bring(P1, units.AnyUnit, locations.Base)\`, \`score(P1, "kills")\`, \`countdownTimer()\`.
 * What to read — the player, the unit, the location — is known when you build.
 */
/** A player's minerals. */
${kw}function minerals(player: Player): number;
/** A player's gas. */
${kw}function gas(player: Player): number;
/** A player's minerals, gas, or both added up: what accumulate() compares. */
${kw}function resources(player: Player, resource: ResourceKind | number): number;
/** How many units of a type a player has — at a location (what bring() compares) or anywhere (what command() compares). */
${kw}function countUnits(player: Player, unit: UnitType, location?: Location): number;
/** How many units of a type a player has killed: what kill() compares. */
${kw}function kills(player: Player, unit: UnitType): number;
/** The countdown timer, in game seconds: what countdownTimer() compares. A game second is sixteen frames, so at Fastest the timer runs about one and a half times as fast as sleep(seconds()). */
${kw}function countdown(): number;
/** Game seconds since the start: what elapsedTime() compares. A game second is sixteen frames: after sleep(seconds(14)) at Fastest it reads about 21. */
${kw}function elapsed(): number;
/** The race a player is playing, as one of races.*: \`if (race(CurrentPlayer) == races.Zerg)\`. */
${kw}function race(player: Player): Race;
/** What holds a player's slot, as one of slots.*: \`if (slot(P3) == slots.Computer)\` — a melee computer and a Use Map Settings one alike. */
${kw}function slot(player: Player): Slot;
/** Whether a person plays this slot. */
${kw}function isHuman(player: Player): boolean;
/** Whether the player has left the game (P1 … P8). A computer never does. */
${kw}function hasLeft(player: Player): boolean;
/**
 * A player's supply as the top bar shows it: "used", "max" (the cap, 200 unless the map changed it)
 * or "provided" (by depots, overlords, pylons). Of the race the player plays unless one is given.
 */
${kw}function supply(player: Player, of?: "used" | "max" | "provided", race?: Race): number;
/** The races, as race() returns them and supply() takes them. */
${kw}const races: { readonly Zerg: Race<0>; readonly Terran: Race<1>; readonly Protoss: Race<2> };
/** What a slot can hold, as slot() returns it. */
${kw}const slots: { readonly Empty: Slot<0>; readonly Computer: Slot<1>; readonly Human: Slot<2>; readonly Rescuable: Slot<3>; readonly Neutral: Slot<7> };
/**
 * Units on the map, inside program() only. Each of these looks through the game's 1700 unit slots when the
 * line runs — once or a few times a second is nothing, every frame for every player adds up (the editor
 * notes it at the end of the line). What to look for is known when you build. A loop over units runs
 * within the frame: no sleep() inside it.
 */
/**
 * What unitsAt(), unitsOf() and allUnits() give: the units of the game the filter matches, as they are when the line
 * runs. They come in no order, so there is no place and no sort; filter() keeps them in an array of the program.
 */
${kw}interface UnitSet extends Iterable<Unit> {
  /** \`unitsOf(P1).forEach((u) => u.heal(10));\` */
  forEach(fn: (unit: Unit) => void): void;
  some(fn: (unit: Unit) => boolean): boolean;
  every(fn: (unit: Unit) => boolean): boolean;
  /** One that matches, or null. */
  find(fn: (unit: Unit) => boolean): Unit | null;
  /** The ones that match, kept in an array: \`const weak = unitsOf(P1).filter((u) => u.hp < 20);\` */
  filter(fn: (unit: Unit) => boolean): Unit[];
  /** A number from each, in an array. */
  map(fn: (unit: Unit) => number): number[];
  map(fn: (unit: Unit) => boolean): boolean[];
  /** \`const hp = unitsOf(P1).reduce((sum, u) => sum + u.hp, 0);\` */
  reduce(fn: (so: number, unit: Unit) => number, start: number): number;
  reduce(fn: (so: boolean, unit: Unit) => boolean, start: boolean): boolean;
}
/** The units inside a location: \`for (const u of unitsAt(locations.Pen, { owner: P2 })) u.kill();\` */
${kw}function unitsAt(location: Location, filter?: Omit<UnitFilter, "at">): UnitSet;
/** A player's units: \`for (const u of unitsOf(CurrentPlayer, { type: units.TerranMarine })) u.heal(10);\` */
${kw}function unitsOf(player: Player, filter?: Omit<UnitFilter, "owner">): UnitSet;
/** Every unit on the map the filter matches. */
${kw}function allUnits(filter?: UnitFilter): UnitSet;
/** The first unit the filter matches, or null. */
${kw}function first(filter?: UnitFilter): Unit | null;
/** The unit of a type nearest to the centre of a location, or null; units.AnyUnit for any type. */
${kw}function nearest(unit: UnitType, location: Location, filter?: Omit<UnitFilter, "type">): Unit | null;
/** One of the units the filter matches, picked by the game, or null. */
${kw}function randomUnit(filter?: UnitFilter): Unit | null;
/**
 * The game's own tables, inside program() only: what a unit type costs, what a weapon does, a player's
 * upgrades. Read a field as a number, assign to it, += it: \`stats(units.TerranMarine).minerals = 25;\`
 * \`stats(weapons.GaussRifle).damage += 2;\` \`stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;\`
 * A write lasts for the game. Only fields seen working in StarCraft: Remastered are here.
 */
${kw}function stats(unit: UnitType): UnitTypeStats;
${kw}function stats(weapon: Weapon): WeaponStats;
${kw}function stats(upgrade: Upgrade): UpgradeStats;
${kw}function stats(tech: Tech): TechStats;
${kw}function stats(player: Player): PlayerStats;
/**
 * For a library: a location of the map's first 63 that the map does not use, taken when the script is
 * built, so the library's users never have to give it one. The same reason gives the same location; the
 * reason is what the map's requirements show. \`const spot = reserveLocation("fog: where each brush is made");\`
 */
${kw}function reserveLocation(why: string): Location;
/**
 * A video the script imports, when the script is built: \`import badApple from "./bad-apple.video"\`.
 * A .video file is made by Import Video… in the Explorer — the frames the editor decoded, a tile a pixel,
 * ink or not, a frame for every frame of the game — and kept in the map with the script.
 */
${kw}interface Video {
  /** Tiles across. */
  readonly width: number;
  /** Tiles down. */
  readonly height: number;
  /** How many frames. */
  readonly length: number;
  /** How long a frame shows, in milliseconds: 42 is a frame of the game on Fastest. */
  readonly frameMs: number;
  /** How long the whole video plays, in seconds. */
  readonly seconds: number;
  /** Frame i as rows of text, # ink and . not: what fog.picture takes. When the script is built. */
  frame(i: number): readonly string[];
}
/** A brush of cover(): which of the shapes (0 the first), centred on tile (x, y) of the picture. */
${kw}interface Brush { readonly x: number; readonly y: number; readonly shape: number }
/**
 * When the script is built: the brushes whose union is a picture's ink — rows of text, # the ink — each one
 * of \`shapes\` (rows of text, # its tiles and @ its centre, a row one run of tiles) lying on ink only. Ink
 * thinner than the first shape gets the first shape on it anyway. Greedy, the largest gain first. For a
 * renderer of a library's own: fog.picture is this with the game's sight ranges.
 *   cover([".##.", "####"], [["#@#"]])   // brushes of a 3-wide bar
 * Of a video, each frame's brushes (worked out once while the file and the shapes stay the same).
 */
${kw}function cover(picture: readonly string[], shapes: readonly (readonly string[])[]): readonly Brush[];
${kw}function cover(video: Video, shapes: readonly (readonly string[])[]): readonly (readonly Brush[])[];
/** The player colours stats(player).color takes. */
${kw}const colors: { __COLOR_TABLE__ };
/**
 * A player's name, for a text a program shows: displayText(\`\${name(CurrentPlayer)} wins\`). The game
 * fills it in when the text is shown, so it works inside program() only.
 */
${kw}function name(player: Player): string;
/** The colour code of a player's colour, for a text a program shows: \`\${color(P2)}\${name(P2)}\`. Inside program() only. */
${kw}function color(player: Player): string;
/**
 * Show text, inside program() only. Like displayText(), whose text may hold the program's numbers too —
 * displayText(\`\${gold} gold left\`) — but for someone else, or in the middle of the screen where the
 * game's own messages ("Not enough minerals") appear: print(\`Wave \${wave}\`, { to: AllPlayers, position: "center" }).
 */
${kw}function print(text: string, options?: { to?: Player; position?: "chat" | "center" }): void;
/**
 * The colours a text in the game takes, as their colour codes: for an array that holds a colour a cell,
 * \`board[i] = textColors.orange\`, and \`<cell color={board[i]} />\` shows it (0 is an empty cell).
 * grey ends what colour a line can change: everything after it on its line stays grey.
 */
${kw}const textColors: { __TEXT_COLORS__ };
/** A colour of a text: one of textColors' names, or a colour code (0 for none). */
${kw}type TextColor = keyof typeof textColors | number;
/** What a program shows on the screen, redrawn by the game as the program's variables change. */
${kw}const ui: {
  /**
   * Show a text in the player's text lines, top left, and keep it there: the function is worked out again every
   * frame from the program's variables, and shown when it changed. Inside an async program only, as a task: it keeps
   * going after the program moves on, and the Task it gives back stops it (\`board.cancel()\`). Eleven lines: one
   * player's text lines are this text's only, so give a player one ui.lines at a time.
   *
   *   ui.lines(P1, () => (
   *     <>
   *       <line color="yellow">Score {score}</line>
   *       {rows.map((r) => <line>{r.map((c) => <cell color={c} />)}</line>)}
   *     </>
   *   ));
   */
  lines(player: Player, view: () => string): Task;
};
/** A unit as it was when it died, which is what on.died() hands its function: the unit itself is gone. */
${kw}interface DeadUnit {
  readonly type: UnitType;
  readonly owner: Player;
  /** Where it died, in pixels (32 a tile). */
  readonly x: number;
  readonly y: number;
}
/** How many of an event's handlers can be waiting at once, when the handler is async (16 unless said, up to 255). */
${kw}interface EventOptions { max?: number }
/** What on.order() looks for: a unit filter and, if you like, the order the unit takes up. */
${kw}interface OrderFilter extends UnitFilter { order?: Order }
/** What on.killed() looks for: a unit filter and, if you like, the player who killed it. */
${kw}interface KillFilter extends UnitFilter { by?: Player }
/**
 * What happens in the game, as it happens: on.created(…), on.died(…), on.chat(…) and the rest each runs its function for
 * every time it happens from the next frame on. Each is a task (it keeps listening after the program moves on, and the
 * Task it gives back stops it), inside an async program — or at the top of a script, where it listens from the start
 * of the game as a program of its own. A function that is not async runs within the frame, once for each time; an
 * async one is started as a task each time, so it can wait: \`max\` of them at once.
 */
${kw}const on: {
  /**
   * A unit comes onto the map — made by an action or a program, trained, hatched, landed, placed by a test — and the
   * function is handed it in the next frame. A unit in a transport or a hangar comes on when it first comes out.
   * \`on.created(units.ZergZergling, (u) => { u.energy = 50; })\`
   */
  created(handler: (unit: Unit) => void, options?: EventOptions): Task;
  created(filter: UnitType | UnitFilter, handler: (unit: Unit) => void, options?: EventOptions): Task;
  /**
   * A unit dies or is removed, and the function is handed what it was and where, in the next frame — once for every
   * unit on.created() would have been handed. The filter is of the unit as it died.
   * \`on.died({ owner: P8 }, async (u) => { await sleep(seconds(2)); createUnit(P8, u.type, 1, locations.Spawn); })\`
   */
  died(handler: (unit: DeadUnit) => void, options?: EventOptions): Task;
  died(filter: UnitType | UnitFilter, handler: (unit: DeadUnit) => void, options?: EventOptions): Task;
  /**
   * A unit is killed in a fight — shot, burned, caught in a storm — and the function is handed what it was, where, and
   * the player whose attack killed it. A unit a trigger or a program kills or removes, or one that goes down with its
   * transport, has no killer and is not handed on (on.died() hears every one); nor does one its own player killed (a
   * storm on your own units), for which the game keeps no attacker, as it counts no kill.
   * \`on.killed({ owner: P8, by: P1 }, (u, by) => setResources(by, "add", 25, "ore"))\`
   */
  killed(handler: (unit: DeadUnit, by: Player) => void, options?: EventOptions): Task;
  killed(filter: UnitType | KillFilter, handler: (unit: DeadUnit, by: Player) => void, options?: EventOptions): Task;
  /**
   * A unit takes up a new order — told to move, starting to cast, sieging, going back to guard — and the function is
   * handed it in the next frame, with the order it took up and the one it had. An order held for less than a frame is
   * not seen. This looks at every unit on the map each frame: the hint says what it costs.
   * \`on.order(units.ProtossHighTemplar, orders.CastPsionicStorm, (u) => print("Storm!"))\`
   */
  order(handler: (unit: Unit, order: Order, was: Order) => void, options?: EventOptions): Task;
  order(filter: UnitType | OrderFilter, handler: (unit: Unit, order: Order, was: Order) => void, options?: EventOptions): Task;
  order(filter: UnitType | UnitFilter, order: Order, handler: (unit: Unit, order: Order, was: Order) => void, options?: EventOptions): Task;
  /**
   * A unit turns into another type and stays the same unit: a Siege Tank sieging, a Larva becoming an egg and the egg
   * its unit, a Drone becoming a building, a High Templar becoming an Archon (its partner leaves, as on.died() hears).
   * The function is handed the unit, now of its new type, and the type it was. The filter is of the new type.
   * \`on.morphed(units.TerranSiegeTankSiegeMode, (u) => print("Sieged"))\`
   */
  morphed(handler: (unit: Unit, was: UnitType) => void, options?: EventOptions): Task;
  morphed(filter: UnitType | UnitFilter, handler: (unit: Unit, was: UnitType) => void, options?: EventOptions): Task;
  /**
   * A player types a line that fits the pattern, which is chatted()'s: \`on.chat("-give {n}", (p, { n }) => setResources(p, "add", n, "ore"))\`.
   * Every player P1 … P8 unless \`from\` names one (CurrentPlayer in a program for several players); \`p\` is known
   * when the script is built, so an action can be for them.
   */
  chat<const P extends string>(pattern: P, handler: (player: Player, values: ChatValues<P>) => void, options?: EventOptions & { from?: Player }): Task;
  /** A player presses a key, as keyPressed() sees it: \`on.key("F7", (p) => print("Help", { to: p }))\`. Every player P1 … P8 unless \`from\` names one. */
  key(key: Key, handler: (player: Player) => void, options?: EventOptions & { from?: Player }): Task;
};
/**
 * What the players do, inside program() only. A key, a click and a typed line are true on the one
 * frame they arrive, so look for them in a loop that runs every frame:
 * \`while (true) { if (keyPressed(CurrentPlayer, "F7")) …; sleep(frames(1)); }\`. They reach every
 * player's computer in step, a few frames after they happen. The player is one of P1 … P8 or
 * CurrentPlayer — in a program with \`{ owner: AllPlayers }\`, each player's own keys.
 * The map gives up a little for it: one free location among the first 63 (nine when the mouse is read),
 * the Valkyrie unit type, and Player 12 to hold the units that carry the input.
 */
/** True on the frame a player's press of a key arrives. Not while the player is typing a message. */
${kw}function keyPressed(player: Player, key: Key): boolean;
/**
 * True on every frame a key is down — for moving while it is held. It reaches every player's computer
 * in step, a few frames after it happens, as a press does. Not while the player is typing a message.
 */
${kw}function keyHeld(player: Player, key: Key): boolean;
/** True on the frame a player's press of a mouse button arrives ("left" when none is named). */
${kw}function clicked(player: Player, button?: "left" | "right" | "middle"): boolean;
/** Where a player's mouse is on the map, in pixels (32 to a tile): \`const at = mouse(CurrentPlayer);\` keeps the place as it is now. */
${kw}function mouse(player: Player): { readonly x: number; readonly y: number };
/** The unit nearest a player's mouse and no farther from it than \`within\` pixels (48 when not given), or null. */
${kw}function underMouse(player: Player, filter?: UnitFilter & { within?: number }): Unit | null;
/**
 * What a player typed, on the frame the line arrives: null, or the values the pattern names.
 * \`const m = chatted(CurrentPlayer, "-give {n}"); if (m) setResources(CurrentPlayer, "add", m.n, "ore");\`
 * The pattern's own text is matched exactly and the whole line has to fit it. {n} reads a whole number
 * (up to 1 048 575), {unit:unit} a unit type by its name — the rest of the line, so it comes last —
 * and {kind:ore|gas} one of the listed words, giving its place in the list (0, 1, …); names and words
 * match whatever the capitals. Up to three values. A game played alone has no chat: test these in a
 * multiplayer game, which one person can host.
 */
${kw}function chatted<const P extends string>(player: Player, pattern: P): ChatValues<P> | null;
/** Centre a location on a point of the map, in pixels, its size kept; inside program() only. With mouse(): \`centerLocation(locations.Cursor, at.x, at.y)\`, then createUnit() there. */
${kw}function centerLocation(location: Location, x: number, y: number): void;
/**
 * Centre a location on a point of the map and give it a size, all in pixels; inside program() only. Nothing of its
 * old size is read, so it costs less than keeping the size: \`centerLocation(spot, x, y, 32, 32)\`.
 */
${kw}function centerLocation(location: Location, x: number, y: number, width: number, height: number): void;
/** Keep a condition or action in the trigger but switched off (StarEdit's disabled state). */
${kw}function disabled<T extends Condition | Action>(item: T): T;
/**
 * The opposite of a condition, for a trigger's conditions list: a comparison flips ("at least 3" becomes
 * "at most 2"), a switch test flips, always becomes never. Throws for "exactly n" and for conditions the
 * game cannot negate in one condition; inside program(), if (!…) handles every condition.
 */
${kw}function not(condition: Condition): Condition;
/** A condition by raw type number and record fields, for types the editor does not know. */
${kw}function condition(${CONDITION_FIELDS.map((f) => `${f}?: number`).join(", ")}): Condition;
/** An action by raw type number and record fields, for types the editor does not know. */
${kw}function action(${ACTION_FIELDS.map((f) => `${f}?: number`).join(", ")}): Action;
/** EUD: compare the 32-bit value at a memory address (1.16.1 layout; Remastered emulates it). deaths at player EPD(address). */
${kw}function memory(address: number, comparison: Comparison | number, value: number): Condition;
/** EUD: set / add to / subtract from the 32-bit value at a memory address (1.16.1 layout; Remastered emulates it). */
${kw}function setMemory(address: number, modifier: Modifier | number, value: number): Action;
/** Preserve Trigger: the trigger runs again next cycle instead of once. */
${kw}function preserve(): Action;
`;
}

function signature(kw: string, ident: string, def: ConditionDef | ActionDef, returns: "Condition" | "Action"): string {
  const all = scriptParams(def);
  const params = all.map((p) => `${p.name}${p.optional ? "?" : ""}: ${argType(p.arg.kind)}`);
  const doc = def.args.length ? `${def.name} — ${def.args.map((a) => a.label).join(", ")}` : def.name;
  const out = `/** ${doc} */\n${kw}function ${ident}(${params.join(", ")}): ${returns};`;
  if (returns !== "Condition" || !READ_ARITY.has(ident)) return out;
  // Without the comparison and the amount, the quantity itself: a read, inside program().
  const read = all.filter((p) => p.arg.kind !== "comparison" && p.arg.kind !== "amount").map((p) => `${p.name}: ${argType(p.arg.kind)}`);
  return `${out}\n/** ${def.name}, as a number: what the condition compares, read inside program(). */\n${kw}function ${ident}(${read.join(", ")}): number;`;
}

function tableDecl(kw: string, t: NameTable, keep: (key: string, index: number) => boolean = () => true, note?: string): string {
  const lines = [`/** ${t.doc} */`, `${kw}const ${t.object}: {`];
  if (note) lines.push(`  // ${note}`);
  for (const e of t.entries) e.keys.forEach((k, i) => { if (keep(k, i)) lines.push(`  readonly ${propertyKey(k)}: ${t.type}<${e.value}>;`); });
  lines.push("};");
  return lines.join("\n");
}

const identifierKey = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

const STATS_INTERFACES: Record<TableKind, [name: string, doc: string]> = {
  unit: ["UnitTypeStats", "units.dat, for one unit type. Most fields reach the units made after the write; the ones already on the map keep what they were made with."],
  weapon: ["WeaponStats", "weapons.dat, for one weapon: every unit using it follows at once."],
  upgrade: ["UpgradeStats", "upgrades.dat, for one upgrade."],
  tech: ["TechStats", "techdata.dat, for one technology."],
  player: ["PlayerStats", "The player tables, for one player."],
};

/** The interfaces `stats()` returns, from the one list of fields (`tables.ts`). */
function statsTypes(kw: string): string {
  return (Object.keys(TABLE_FIELDS) as TableKind[]).map((kind) => {
    const [name, doc] = STATS_INTERFACES[kind];
    const lines = [`/** ${doc} */`, `${kw}interface ${name} {`];
    for (const f of TABLE_FIELDS[kind]) {
      const type = f.type ?? (f.boolean ? "boolean" : "number");
      lines.push(`  /** ${f.doc}${f.writeOnly ? " Set only." : ""} */`);
      lines.push(f.keyed ? `  readonly ${f.name}: { [${f.keyed.kind}: number]: ${type} };` : `  ${f.readonly ? "readonly " : ""}${f.name}: ${type};`);
    }
    lines.push("}");
    return lines.join("\n");
  }).join("\n");
}

/** The interfaces of `memory`, from its one list of fields (`memory.ts`): each field's doc and Remastered's verdict on it. */
function memoryTypes(kw: string): string {
  const groups = Object.entries(MEMORY_GROUPS).map(([group, [name, doc]]) => {
    const lines = [`/** ${doc} */`, `${kw}interface ${name} {`];
    for (const f of MEMORY_FIELDS.filter((x) => x.path[0] === group)) {
      lines.push(`  /**\n   * ${f.doc}\n   *\n   * ${f.remastered}\n   * @address 0x${f.base.toString(16).toUpperCase()}, ${f.width * 8} bits\n   */`);
      lines.push(`  ${f.readonly ? "readonly " : ""}${f.path[1]}: number;`);
    }
    lines.push("}");
    return lines.join("\n");
  });
  return groups.join("\n");
}

/**
 * `memory.vision.countdown`: the groups as a namespace merged with the trigger level's \`memory(address, …)\`
 * condition, which keeps its name.
 */
function memoryNamespace(kw: string): string {
  const lines = [
    `/**`,
    ` * Cells of the game's memory that have no other word in the language, inside program() only:`,
    ` * \\\`memory.vision.countdown = 1;\\\` \\\`if (memory.game.frame % 24 == 0) …\\\`. Each field's hover says what`,
    ` * StarCraft: Remastered does with it; one the game keeps for itself is readonly.`,
    ` */`,
    `${kw}namespace memory {`,
  ];
  for (const [group, [name, doc]] of Object.entries(MEMORY_GROUPS)) lines.push(`  /** ${doc} */`, `  export const ${group}: ${name};`);
  lines.push("}");
  return lines.join("\n");
}

/**
 * `local` and `sync()` (B5): what only this computer knows, typed `Local`, and the way one player's value reaches
 * every computer. The check that keeps a `Local` value away from the game is the compiler's (`local.ts`), not the type's:
 * a sum of a `Local` number is as local, and TypeScript would lose the mark.
 */
function localNamespace(kw: string, typeKw: string): string {
  const field = (f: MemoryField, indent: string) => `${indent}/**\n${indent} * ${f.doc}\n${indent} *\n${indent} * ${f.remastered}\n${indent} * @address 0x${f.base.toString(16).toUpperCase()}, ${f.width * 8} bits\n${indent} */`;
  const lines = [
    `/**`,
    ` * A value only this computer knows: it may be different on every player's computer. It can be shown — in text, in`,
    ` * ui.lines(), a sound, the camera — but nothing that changes the game may depend on it, or the game would go`,
    ` * differently on each computer and split. The compiler says so where it happens. To act on one, send it to every`,
    ` * computer first: \\\`const x = await sync(P1, local.camera.x);\\\``,
    ` */`,
    `${typeKw}type Local<T> = T;`,
    `/**`,
    ` * What only this computer knows, inside program() only: who sits at it, where its screen is, where its mouse is on the`,
    ` * screen. Each is a Local value: show it as you like; to act on it, sync() it first.`,
    ` */`,
    `${kw}namespace local {`,
  ];
  const groups = [...new Set(LOCAL_FIELDS.map((f) => f.path[0]))];
  for (const g of groups) {
    const fs = LOCAL_FIELDS.filter((f) => f.path[0] === g);
    if (fs.length === 1 && !fs[0].path[1]) { lines.push(field(fs[0], "  "), `  export const ${g}: Local<number>;`); continue; }
    lines.push(`  export const ${g}: {`);
    for (const f of fs) lines.push(field(f, "    "), `    readonly ${f.path[1]}: Local<number>;`);
    lines.push(`  };`);
  }
  lines.push(
    `  /**`,
    `   * The unit this computer has selected — the first of a group, the one the panel at the bottom shows — or null. A`,
    `   * Local value: show it (its hit points, its order, …) as you like; to act on it, select() or sync() first.`,
    `   *`,
    `   * Remastered: the selection, read live (its own EUD emulator: each slot a unit's 1.16.1 address). Played.`,
    `   * @address 0x6284B8, 32 bits a unit, twelve`,
    `   */`,
    `  export const selected: Local<Unit | null>;`,
    `  /** How many units this computer has selected, 0 to 12. */`,
    `  export const selectionCount: Local<number>;`,
  );
  lines.push(`}`);
  lines.push(
    `/**`,
    ` * What a player has selected becomes these units — at their computer (the panel shows them) and in the orders every`,
    ` * computer runs for them, as if they had dragged a box round them: a Select command, sent from their computer as`,
    ` * MSQC sends one. The units may be any, Local ones too: select(P1, local.selected) is safe. Up to twelve, written out;`,
    ` * the selection circles may not follow.`,
    ` */`,
    `${kw}function select(player: Player, units: Unit | readonly Unit[]): void;`,
  );
  lines.push(
    `/**`,
    ` * One player's value, sent from their computer to every computer: what \\\`value\\\` is on \\\`player\\\`'s computer, the same`,
    ` * on all of them, a few frames later (5 or 6 in a game played alone; a game between computers adds its turns).`,
    ` * \\\`const x = await sync(CurrentPlayer, local.camera.x + 400);\\\` Every computer runs the program and reaches the same`,
    ` * sync(): only the named player's sends. A whole number from 0 to 1 048 574. A player who is not a person, or has`,
    ` * left, gives 0 at once. Inside an async program, awaited where it is assigned.`,
    ` */`,
    `${kw}function sync(player: Player, value: Local<number>): Promise<number>;`,
    `/**`,
    ` * Several of one player's values, read on the same frame and sent together: a point stays one point while the mouse`,
    ` * moves, and it takes one trip, not one a value. \\\`const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y);\\\``,
    ` */`,
    `${kw}function sync(player: Player, a: Local<number>, b: Local<number>): Promise<[number, number]>;`,
    `${kw}function sync(player: Player, a: Local<number>, b: Local<number>, c: Local<number>): Promise<[number, number, number]>;`,
    `${kw}function sync(player: Player, a: Local<number>, b: Local<number>, c: Local<number>, d: Local<number>): Promise<[number, number, number, number]>;`,
  );
  return lines.join("\n");
}

function playerAliases(kw: string, names: ScriptNames): string {
  const lines: string[] = [];
  for (const e of names.players.entries) {
    if (e.value < PLAYER_SLOTS) lines.push(`/** ${e.keys[1]} */\n${kw}const ${e.keys[0]}: Player<${e.value}>;`);
  }
  lines.push(`/** The player the trigger is running for. */\n${kw}const CurrentPlayer: Player<13>;`);
  lines.push(`/** Every player. */\n${kw}const AllPlayers: Player<17>;`);
  return lines.join("\n");
}

function tables(kw: string, names: ScriptNames, compact: boolean): string {
  if (!compact) {
    return allTables(names).map((t) => tableDecl(kw, t)).join("\n");
  }
  const isDefaultSwitch = (k: string) => /^Switch ?(\d+)$/.test(k);
  return [
    tableDecl(kw, names.players),
    tableDecl(kw, names.units, (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k), `Every unit is also indexable by its StarEdit name: ${names.units.object}["Terran Marine"].`),
    tableDecl(kw, names.locations),
    tableDecl(kw, names.switches, (k) => { const m = /^Switch(\d+)$/.exec(k); return m ? Number(m[1]) <= 16 : !isDefaultSwitch(k); }, "Switch1 … Switch256 exist; the first sixteen are listed. A switch given a name in the map is listed by that name."),
    `/** AI scripts, by StarEdit name ("Terran Custom Level") or four-character code. */\n${kw}const ${names.aiScripts.object}: { readonly [name: string]: AiScript<number> };`,
    ...[names.weapons, names.upgrades, names.techs, names.orders].map((t) => tableDecl(kw, t, identifierKey)),
  ].join("\n");
}

function body(kw: string, typeKw: string, names: ScriptNames, compact: boolean): string {
  return [
    types(typeKw).replace("__COLOR_NAMES__", COLOR_NAMES).replace("__KEY_NAMES__", KEY_NAMES.map((k) => JSON.stringify(k)).join(" | ")).replace("__STATS_TYPES__", `${statsTypes(typeKw)}\n${memoryTypes(typeKw)}`),
    choiceTypes(typeKw),
    functions(kw).replace("__COLOR_TABLE__", COLOR_TABLE).replace("__TEXT_COLORS__", TEXT_COLOR_TABLE),
    memoryNamespace(kw),
    localNamespace(kw, typeKw),
    "// ── Conditions ──",
    ...[...CONDITION_IDENTS].map(([ident, def]) => signature(kw, ident, def, "Condition")),
    "",
    "// ── Actions ──",
    ...[...ACTION_IDENTS].map(([ident, def]) => signature(kw, ident, def, "Action")),
    "",
    "// ── The map ──",
    playerAliases(kw, names),
    tables(kw, names, compact),
  ].join("\n");
}

/**
 * What the standard library gets wrong for a program: `new Array(12)` is an `any[]` there, and everything made from it —
 * a cell, what `map` or `reduce` gives — is `any` after it, which says nothing of what a variable holds. Here it is an
 * array of numbers unless it says otherwise (`new Array<boolean>(12).fill(false)`), as a number is what everything is.
 */
const ARRAYS = `
/** JSX is a text the game shows: \`<line color="yellow">Score {score}</line>\` is a string. */
declare namespace JSX {
  type Element = string;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicElements {
    /** A line of its own, in its colour (white unless it says). The lines of a text are put one under another. */
    line: { color?: TextColor; children?: unknown };
    /** What is inside it in its colour; the colour around it comes back after it. */
    span: { color?: TextColor; children?: unknown };
    /** One square: filled in its colour, or empty (lavender) when it has none or 0. A board's cell. */
    cell: { color?: TextColor };
    /** \`width\` squares (10 unless it says), as many of them filled as value is of max. */
    bar: { value: number; max: number; width?: number; color?: TextColor };
  }
}
declare function __jsx(tag: string, props: object | null, ...children: unknown[]): string;
/** What the build adds after each class at the top of a file, for a program that makes an instance of it. Not for scripts. */
declare function __class(cls: unknown, descriptor: unknown): void;
declare function __listen(descriptor: unknown, at?: unknown): void;
declare const __fragment: string;
interface ArrayConstructor {
  new <T = number>(arrayLength: number): T[];
  <T = number>(arrayLength: number): T[];
}
`;

/**
 * The tests' names: in the module only, never globals — a script may well have a `test` or an `expect` of its own.
 * They are Vitest's, so there is nothing to learn but `sim`.
 */
const TESTING = `
// ── Tests: they run in the editor's simulator, never in the game, and cost the map nothing ──

/** A unit of the simulated game, as a test sees it. */
export interface SimUnit {
  readonly type: UnitType; readonly owner: Player; readonly x: number; readonly y: number;
  readonly hp: number; readonly maxHp: number; readonly shields: number; readonly maxShields: number; readonly energy: number;
  readonly kills: number; readonly orderId: Order; readonly resources: number; readonly invincible: boolean; readonly burrowed: boolean; readonly cloaked: boolean; readonly hallucinated: boolean;
  /** Still on the map. */
  readonly alive: boolean;
}

/**
 * The world a test is handed, new for every test: the map's placed units and locations, the script's
 * programs at frame 0 and its trigger()s beside them, random() the same every run. Units are made, given,
 * moved, killed and counted; nothing walks, fights or is built, and nothing dies but by the script or the test.
 */
export interface Sim {
  /** Units for a player at a location's centre, as createUnit() makes them. They are given back. */
  place(player: Player, type: UnitType, at: Location, count?: number): SimUnit[];
  /** A unit dies: what a fight is in a test. \`by\`: the player whose kill it is, and on.killed()'s killer. */
  kill(unit: SimUnit, by?: Player): this;
  /** A unit goes without dying. */
  remove(unit: SimUnit): this;
  give(unit: SimUnit, to: Player): this;
  /** A unit turns into another type and stays the same unit, as a Siege Tank sieges: what on.morphed() hears. In the simulator only. */
  morph(unit: SimUnit, type: UnitType): this;
  /** A unit to a location's centre, or to a point in pixels. */
  move(unit: SimUnit, to: Location | { x: number; y: number }): this;

  /** Run the game for so many frames (24 a second at Fastest). */
  frames(n?: number): this;
  seconds(n: number): this;
  /** Run until \`done()\` is true. The test fails when \`most\` frames pass first (2400 unless said), so no test hangs. */
  until(done: () => unknown, most?: number): this;
  /** The frames run so far. */
  readonly frame: number;
  /** random() from this number on. Before anything that draws one. */
  seed(n: number): this;

  /** A key goes down for the next frame: what keyPressed() finds. */
  press(key: Key, player?: Player): this;
  click(button?: "left" | "right" | "middle", player?: Player): this;
  /** A line of chat, for the next frame: what chatted() finds. */
  type(line: string, player?: Player): this;
  moveMouse(x: number, y: number, player?: Player): this;
  /** The player's screen to a place on the map, its top left corner in pixels: what local.camera reads. The mouse stays where it is on the map. */
  moveCamera(x: number, y: number, player?: Player): this;
  /** The player selects these units (up to twelve), as a drag would at their computer: what local.selected reads. */
  selectUnits(units: readonly SimUnit[], player?: Player): this;

  count(player: Player, type: UnitType, at?: Location): number;
  /** The units on the map, in the order of the game's unit table. */
  units(filter?: { owner?: Player; type?: UnitType; at?: Location }): SimUnit[];
  resources(player: Player): { ore: number; gas: number };
  deaths(player: Player, type: UnitType): number;
  kills(player: Player, type: UnitType): number;
  switch(n: Switch): boolean;
  /**
   * What \`player\` sees of the map's fog of war this frame, a text a row of tiles: "#" lit now, "+" seen before (fog),
   * "." never seen. \`area\` takes a part of the map (tiles), the whole of it by default. Null where the world has no
   * fog to read: the simulator does not draw it, the game does — run the tests in the game to check a picture.
   */
  fog(player: Player, area?: { x: number; y: number; width: number; height: number }): string[] | null;
  /** Where a location is now: a program may have moved it. */
  location(n: Location): { left: number; top: number; right: number; bottom: number } | undefined;

  /**
   * A program's variables, by their names in the source: numbers, booleans, texts, arrays, a record as an
   * object, a unit (null for none). The program by the name its options give it — program(() => { … },
   * { name: "waves" }) — or by its place in the script, from 0. Of a per-player program, \`player\`'s.
   */
  program(name?: string | number, player?: Player): Readonly<Record<string, any>>;

  /** What was shown, in order: to anybody, or what one player saw. */
  printed(player?: Player): string[];
  /** Everything that happened, by frame. */
  readonly events: readonly { frame: number; text: string; player: number; file?: string; line?: number }[];
  /** What a program did that is always a mistake: an index past an array's end, the stack's depth, the heap full. One the test did not ask for (expect(sim).toHaveFaulted) fails it. */
  readonly faults: readonly { message: string; cycle: number }[];
}

export interface Expectation<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toContain(item: unknown): void;
  toHaveLength(n: number): void;
  toMatch(pattern: RegExp | string): void;
  toThrow(message?: RegExp | string): void;
  /** expect(sim): a text was shown — all of it, a part of it, or a pattern. \`to\`: to that player. */
  toHavePrinted(text: RegExp | string, options?: { to?: Player }): void;
  /** expect(sim): the simulator said a program did what is always a mistake. Asking is what lets the test go on past it. */
  toHaveFaulted(message?: RegExp | string): void;
}
export function expect<T>(actual: T): Expectation<T> & { readonly not: Expectation<T> };

export interface TestOptions {
  /** Without the map's player settings the world has one player: this one. */
  as?: Player;
  /**
   * In the game: these players, each at a computer of their own — a copy of the game for each, kept in step as a
   * game between people is. What a player does (press, click, type, moveMouse) is done at their computer, and the
   * test fails at the frame the copies stop agreeing, the lines that made them differ named. The simulator runs the
   * test once, as without it.
   */
  players?: readonly Player[];
}
type TestBody<A extends readonly unknown[] = []> = (sim: Sim, ...args: A) => void;
interface TestEach<F> { <T>(cases: readonly T[]): (name: string, fn: F extends "suite" ? (...args: T extends readonly unknown[] ? T : [T]) => void : TestBody<T extends readonly unknown[] ? T : [T]>) => void }
interface TestCall { (name: string, fn: TestBody): void; (name: string, options: TestOptions, fn: TestBody): void; each: TestEach<"test"> }
interface SuiteCall { (name: string, body: () => void): void; each: TestEach<"suite"> }
/** A test: ordinary TypeScript, run in the simulator after every compile that goes through. Not async: nothing in sim waits. */
export const test: TestCall & { only: TestCall; skip: TestCall };
export const it: typeof test;
/** Tests under one name. */
export const describe: SuiteCall & { only: SuiteCall; skip: SuiteCall };
/** Before each test of this describe (or of the file) and of those inside it. */
export function beforeEach(fn: (sim: Sim) => void): void;
export function afterEach(fn: (sim: Sim) => void): void;
`;

/** The whole declaration file for a set of names. */
/** What importing one of the script's media files gives (`media.ts`). */
const MEDIA_MODULES = `// ── A video the script imports: import badApple from "./bad-apple.video"; ──
declare module "*.video" {
  const video: Video;
  export default video;
}
`;

export function generateDeclarations(names: ScriptNames = defaultScriptNames(), options: DeclarationOptions = {}): string {
  const compact = options.compact === true;
  const globals = body("declare ", "", names, compact);
  if (compact) return `${HEADER}${globals}\n${ARRAYS}`;
  const module = `${body("export ", "export ", names, false)}\n${TESTING}`.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
  return `${HEADER}${globals}\n${ARRAYS}\n// ── The same names, as a module: import { trigger, units } from "${MODULE_NAME}"; ──\ndeclare module "${MODULE_NAME}" {\n${module}\n}\n${MEDIA_MODULES}`;
}

