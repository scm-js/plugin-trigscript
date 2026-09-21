/**
 * The simulated game's units and players: what `createUnit`, `giveUnits`, `bring` and the
 * rest act on and ask, for the trigger interpreter (`simulate.ts`) and the programs'
 * (`simulateIr.ts`) alike — one world, so a unit a hand trigger makes is one a program's
 * loop finds.
 *
 * What it does is what can be known without the game. A unit is made at the centre of its
 * location with the hit points and shields its type has, in the lowest free place of the
 * unit table; a place used again has its uniqueness byte moved on, so what kept the unit
 * that was there does not find the new one. Units are given, moved to a location's centre,
 * killed and removed, their hit points, shields, energy and resources set; the conditions
 * that count units answer from the table; deaths and kills are counted.
 *
 * What it leaves out: nothing walks, nothing fights, nothing is built over time, nothing
 * is in the way of anything (a unit made always finds room) and no unit dies but by a
 * trigger, a program or the caller.
 *
 * Players: with the map's player settings (`players`, `forces`) a group is the players it
 * is in the game — All Players those in it, a force its members, Foes and Allies by force.
 * Without them the world has the one player, and a force or the current player is that one.
 */
import { ActionType, Comparison, ConditionType, PlayerGroup, UnitState, type ActionRecord, type ConditionRecord } from "../vendor/triggers";

/** The game's unit table. */
export const UNIT_SLOTS = 1700;

/** A unit of the simulated game. Hit points, shields and energy in whole points. */
export interface SimUnit {
  type: number; owner: number; x: number; y: number;
  hp: number; maxHp: number; shields: number; maxShields: number; energy: number;
  kills: number; orderId: number; cooldown: number; resources: number;
  stim: number; ensnare: number; plague: number; lockdown: number; maelstrom: number; irradiate: number; stasis: number;
  hallucinated: boolean; cloaked: boolean; burrowed: boolean; invincible: boolean; underAttack: boolean;
  /** Still on the map. */
  alive: boolean;
  /** Its place in the unit table, from 0; another unit's once this one is gone. */
  slot: number;
  /** The place's uniqueness byte while this unit is in it. */
  uid: number;
}
export type SimUnitInit = Partial<Omit<SimUnit, "alive" | "slot" | "uid">> & { type: number; owner: number };
export interface SimBounds { left: number; top: number; right: number; bottom: number }

/** What a Create Unit with Properties slot sets, the percentages of the type's own. */
export interface SimUnitProperties {
  hpPercent?: number; shieldPercent?: number; energyPercent?: number; resources?: number;
  cloaked?: boolean; burrowed?: boolean; hallucinated?: boolean; invincible?: boolean;
}

/** The production buildings a trigger's "Factories" class counts. */
const FACTORIES: ReadonlySet<number> = new Set([106, 111, 113, 114, 131, 132, 133, 154, 155, 160, 167]);
const inClass = (type: number, cls: number): boolean => (cls === 229 ? true : cls === 230 ? type < 106 : cls === 231 ? type >= 106 && type <= 202 : FACTORIES.has(type));

export interface PlayersOptions {
  /** The slots in the game — the map's human and computer players. Absent: the one simulated player, and every force is that one. */
  players?: readonly number[];
  /** The force of each slot, 0 … 3. A slot without one is in no force. */
  forces?: Readonly<Record<number, number>>;
}

/** Who a player number of a trigger means. */
export class Players {
  /** The slots in the game, in order. */
  readonly slots: readonly number[];
  /** No player settings were given: one player, whom every force and the current player mean. */
  readonly loose: boolean;
  private readonly forces: Readonly<Record<number, number>>;

  constructor(options: PlayersOptions, only: number) {
    this.loose = !options.players;
    this.slots = options.players ? [...new Set(options.players)].filter((p) => p >= 0 && p < 12).sort((a, b) => a - b) : [only];
    this.forces = options.forces ?? {};
  }

  /** The slots a player or a group names, as `current` sees it. A group nobody is in is empty. */
  of(group: number, current: number): number[] {
    if (group < 12) return [group];
    if (group === PlayerGroup.CurrentPlayer) return [current];
    // The one player is whom any group means, as the simulation has always taken it.
    if (this.loose) return group <= PlayerGroup.Force4 ? [current] : [group];
    const force = this.forces[current];
    switch (group) {
      case PlayerGroup.AllPlayers: return [...this.slots];
      case PlayerGroup.Force1: case PlayerGroup.Force2: case PlayerGroup.Force3: case PlayerGroup.Force4:
        return this.slots.filter((p) => this.forces[p] === group - PlayerGroup.Force1);
      case PlayerGroup.Allies: return this.slots.filter((p) => p !== current && force !== undefined && this.forces[p] === force);
      case PlayerGroup.Foes: case PlayerGroup.NonAlliedVictoryPlayers: return this.slots.filter((p) => p !== current && (force === undefined || this.forces[p] !== force));
      case PlayerGroup.NeutralPlayers: return [11];
      default: return [];
    }
  }

  /** Whether a trigger with these owners (the record's 27 flags) runs for a slot. */
  owns(owners: ArrayLike<number | boolean>, slot: number): boolean {
    if (owners[slot] || owners[PlayerGroup.AllPlayers]) return true;
    for (let f = 0; f < 4; f++) if (owners[PlayerGroup.Force1 + f] && (this.loose || this.forces[slot] === f)) return true;
    return false;
  }
}

export interface WorldOptions extends PlayersOptions {
  /** The units on the map, in the order of the game's unit table. */
  units?: readonly SimUnitInit[];
  /** The map's locations as boxes, by their 1-based number. A location the world does not know holds every unit, and its centre is 0, 0. */
  locations?: Readonly<Record<number, SimBounds>>;
  /** Whether a unit type is of a trigger class (229 any, 230 men, 231 buildings, 232 factories); default by id range. */
  unitClass?: (type: number, cls: number) => boolean;
  /** The hit points and shields a type is made with; default 1 and 0. */
  unitStats?: (type: number) => { hp?: number; shields?: number; energy?: number } | undefined;
  /** What a Create Unit with Properties slot sets, by the slot's number in the action. */
  properties?: (slot: number) => SimUnitProperties | undefined;
}

const compare = (value: number, comparison: number, amount: number): boolean => {
  const n = amount >>> 0;
  return comparison === Comparison.AtLeast ? value >= n : comparison === Comparison.AtMost ? value <= n : comparison === Comparison.Exactly ? value === n : false;
};

export class World {
  /** Every unit there has been, in the order they were made; one that is gone stays in the list, `alive` false. */
  readonly units: SimUnit[] = [];
  readonly locations = new Map<number, SimBounds>();
  readonly players: Players;
  /** What a type is made with. Replaceable: the programs' simulation answers from the tables a program may have written. */
  stats: (type: number) => { hp?: number; shields?: number; energy?: number } | undefined;
  /** A unit died by `kill`: the death is the caller's to count, in the table its script's counters are in. */
  onDeath: (unit: SimUnit) => void = () => {};
  private readonly table: (SimUnit | null)[] = [];
  private readonly uids: number[] = [];
  private readonly classOf: (type: number, cls: number) => boolean;
  private readonly properties: (slot: number) => SimUnitProperties | undefined;
  /** Kills by player and type of what was killed. */
  private readonly killed = new Map<number, number>();

  constructor(options: WorldOptions, only: number) {
    this.players = new Players(options, only);
    this.classOf = options.unitClass ?? inClass;
    this.stats = options.unitStats ?? (() => undefined);
    this.properties = options.properties ?? (() => undefined);
    for (const [n, b] of Object.entries(options.locations ?? {})) this.locations.set(Number(n), { ...b });
    for (const u of options.units ?? []) this.make(u);
  }

  /* ── the unit table ── */

  /** A unit on the map, in the lowest free place of the table. Null when the table is full, as the game makes no unit then. */
  make(init: SimUnitInit): SimUnit | null {
    let slot = 0;
    while (slot < UNIT_SLOTS && this.table[slot]) slot++;
    if (slot >= UNIT_SLOTS) return null;
    // A place used again is not the place it was: what kept the unit that was here compares this byte.
    const uid = this.uids[slot] === undefined ? 0 : (this.uids[slot] + 1) & 0xff;
    this.uids[slot] = uid;
    const hp = init.hp ?? init.maxHp ?? 1;
    const shields = init.shields ?? init.maxShields ?? 0;
    const unit: SimUnit = {
      x: 0, y: 0, energy: 0, kills: 0, orderId: 3, cooldown: 0, resources: 0,
      stim: 0, ensnare: 0, plague: 0, lockdown: 0, maelstrom: 0, irradiate: 0, stasis: 0,
      hallucinated: false, cloaked: false, burrowed: false, invincible: false, underAttack: false,
      ...init, hp, maxHp: init.maxHp ?? hp, shields, maxShields: init.maxShields ?? shields, alive: true, slot, uid,
    };
    this.table[slot] = unit;
    this.units.push(unit);
    return unit;
  }

  /** A unit of a type as the game makes one: the type's hit points and shields, at a point. */
  create(type: number, owner: number, x: number, y: number, properties?: SimUnitProperties): SimUnit | null {
    const s = this.stats(type) ?? {};
    const maxHp = Math.max(1, s.hp ?? 1);
    const maxShields = Math.max(0, s.shields ?? 0);
    const part = (max: number, percent: number | undefined, least: number) => (percent === undefined ? max : Math.max(least, Math.ceil((max * Math.min(100, Math.max(0, percent))) / 100)));
    return this.make({
      type, owner, x, y, maxHp, maxShields,
      hp: part(maxHp, properties?.hpPercent, 1),
      shields: part(maxShields, properties?.shieldPercent, 0),
      energy: properties?.energyPercent === undefined ? s.energy ?? 0 : Math.floor((200 * Math.min(100, Math.max(0, properties.energyPercent))) / 100),
      resources: properties?.resources ?? 0,
      cloaked: properties?.cloaked ?? false, burrowed: properties?.burrowed ?? false,
      hallucinated: properties?.hallucinated ?? false, invincible: properties?.invincible ?? false,
    });
  }

  /** Off the map, its place free for the next unit made. `killed`: it died — counted as a death, and as a kill of `by` when someone is named. */
  gone(unit: SimUnit, killed: boolean, by?: number): void {
    if (!unit.alive) return;
    unit.alive = false;
    if (this.table[unit.slot] === unit) this.table[unit.slot] = null;
    if (!killed) return;
    this.onDeath(unit);
    if (by !== undefined) this.killed.set(unit.type * 4096 + by, (this.killed.get(unit.type * 4096 + by) ?? 0) + 1);
  }

  /** The unit that was in a place when its uniqueness byte was `uid`: the one there now, or one long gone. */
  at(slot: number, uid: number): SimUnit | null {
    const now = this.table[slot];
    if (now && now.uid === uid) return now;
    return this.units.find((u) => u.slot === slot && u.uid === uid) ?? null;
  }

  /** The units on the map, in the order of the table. */
  living(): SimUnit[] {
    const out: SimUnit[] = [];
    for (const u of this.table) if (u) out.push(u);
    return out;
  }

  private typed(u: SimUnit, type: number | undefined): boolean {
    return type === undefined || (type >= 229 ? this.classOf(u.type, type) : u.type === type);
  }

  private inside(u: SimUnit, location: number | undefined): boolean {
    const box = location === undefined || location === 0 ? undefined : this.locations.get(location);
    return !box || (u.x >= box.left && u.x <= box.right && u.y >= box.top && u.y <= box.bottom);
  }

  /** The living units of these owners (any, when undefined), of a type or a class, inside a location — in table order. */
  matching(owners: readonly number[] | undefined, type?: number, location?: number): SimUnit[] {
    return this.living().filter((u) => (!owners || owners.includes(u.owner)) && this.typed(u, type) && this.inside(u, location));
  }

  centreOf(location: number): { x: number; y: number } {
    const b = this.locations.get(location);
    return b ? { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) } : { x: 0, y: 0 };
  }

  /** A location centred on a point, its size kept. */
  centre(location: number, x: number, y: number): void {
    const b = this.locations.get(location) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const w = b.right - b.left;
    const h = b.bottom - b.top;
    const left = x - Math.floor(w / 2);
    const top = y - Math.floor(h / 2);
    this.locations.set(location, { left, top, right: left + w, bottom: top + h });
  }

  /** The kills these players have of a type or a class. */
  kills(owners: readonly number[], type: number): number {
    let n = 0;
    for (const [key, count] of this.killed) if (owners.includes(key % 4096) && (type >= 229 ? this.classOf(Math.floor(key / 4096), type) : Math.floor(key / 4096) === type)) n += count;
    return n;
  }

  /* ── conditions ── */

  /** The number a unit condition compares, as `current` asks it; undefined for a condition that is not about units. */
  quantity(c: ConditionRecord, current: number): number | undefined {
    const owners = this.players.of(c.player, current);
    switch (c.type) {
      case ConditionType.Bring: return this.matching(owners, c.unitId, c.location).length;
      case ConditionType.Command: return this.matching(owners, c.unitId).length;
      case ConditionType.Kill: return this.kills(owners, c.unitId);
      default: return undefined;
    }
  }

  /** Whether a unit condition holds; undefined for a condition that is not about units. */
  holds(c: ConditionRecord, current: number): boolean | undefined {
    const n = this.quantity(c, current);
    if (n !== undefined) return compare(n, c.comparison, c.amount);
    const most = c.type === ConditionType.CommandTheMost || c.type === ConditionType.CommandTheMostAt;
    const least = c.type === ConditionType.CommandTheLeast || c.type === ConditionType.CommandTheLeastAt;
    if (!most && !least) return undefined;
    const at = c.type === ConditionType.CommandTheMostAt || c.type === ConditionType.CommandTheLeastAt ? c.location : undefined;
    const mine = this.matching([current], c.unitId, at).length;
    // Against everyone else in the game; equal to the best of them is still the most.
    return this.players.slots.filter((p) => p !== current).every((p) => { const theirs = this.matching([p], c.unitId, at).length; return most ? mine >= theirs : mine <= theirs; });
  }

  /* ── actions ── */

  /** The first `count` of a list; 0 is all of them. */
  private some<T>(list: T[], count: number): T[] {
    return count > 0 ? list.slice(0, count) : list;
  }

  /**
   * An action on units, done as `current`. True when it was one of the world's — the caller
   * logs it either way. `made`, when given, receives the units a Create Unit made.
   */
  act(a: ActionRecord, current: number, made?: SimUnit[]): boolean {
    const owners = this.players.of(a.player, current);
    switch (a.type) {
      case ActionType.CreateUnit: case ActionType.CreateUnitWithProperties: {
        const { x, y } = this.centreOf(a.location);
        const properties = a.type === ActionType.CreateUnitWithProperties ? this.properties(a.target) : undefined;
        // For a group, each of its players gets the units.
        for (const owner of owners) if (owner < 12) for (let i = 0; i < Math.max(1, a.modifier); i++) { const u = this.create(a.unitId, owner, x, y, properties); if (u) made?.push(u); }
        return true;
      }
      case ActionType.KillUnit: for (const u of this.matching(owners, a.unitId)) this.gone(u, true); return true;
      case ActionType.RemoveUnit: for (const u of this.matching(owners, a.unitId)) this.gone(u, false); return true;
      case ActionType.KillUnitAt: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) this.gone(u, true); return true;
      case ActionType.RemoveUnitAt: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) this.gone(u, false); return true;
      case ActionType.GiveUnits: {
        const to = this.players.of(a.target, current)[0];
        if (to !== undefined && to < 12) for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) u.owner = to;
        return true;
      }
      case ActionType.MoveUnit: {
        const { x, y } = this.centreOf(a.target);
        for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) { u.x = x; u.y = y; }
        return true;
      }
      case ActionType.MoveLocation: {
        // Onto the first such unit where it is looked for; with none there, onto the middle of where it was looked for.
        const u = this.matching(owners, a.unitId, a.location)[0];
        const p = u ?? this.centreOf(a.location);
        this.centre(a.target, p.x, p.y);
        return true;
      }
      case ActionType.ModifyHitPoints: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) u.hp = Math.max(1, Math.ceil((u.maxHp * Math.min(100, a.target)) / 100)); return true;
      case ActionType.ModifyShields: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) u.shields = Math.ceil((u.maxShields * Math.min(100, a.target)) / 100); return true;
      case ActionType.ModifyEnergy: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) u.energy = Math.floor((200 * Math.min(100, a.target)) / 100); return true;
      case ActionType.ModifyResourceAmount: for (const u of this.some(this.matching(owners, a.unitId, a.location), a.modifier)) u.resources = Math.min(0xffff, a.target >>> 0); return true;
      case ActionType.SetInvincibility: for (const u of this.matching(owners, a.unitId, a.location)) u.invincible = a.modifier === UnitState.Enable ? true : a.modifier === UnitState.Disable ? false : !u.invincible; return true;
      default: return false;
    }
  }
}
