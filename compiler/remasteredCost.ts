/**
 * What a frame costs Remastered, in time (TrigScript 4, cost step 1): the lifted game's count of conditions, actions
 * and triggers (scm-sim's `CostTap`), each weighed by what `probes/frame-weights` measured Remastered spending on it.
 * The tap asks `RemasteredWeigh` about every trigger the walk passes and every record it runs, in the game's order,
 * and adds the answers up by frame and by line.
 *
 * Why the answer depends on more than the record's kind (read in Ghidra, Remastered 1.23.10.13515; see the plan's
 * "What Remastered charges"): every Deaths and Set Deaths of an EUD map goes through the EUD emulator, which keeps the
 * region it read last and the region it wrote last, and searches a tree of ~12,300 regions for any other. Every unit,
 * sprite and image is a region of its own (`data/remastered-regions.json`). The walk finds each trigger through the
 * same two caches and reads its next pointer through the read side. So the weigher keeps the two caches as Remastered
 * would and charges a search where Remastered would make one.
 *
 * The numbers are a Ryzen 9 7900X's (2026-10-18, single player at Fastest, the game's own work 5.4 ms a frame): a
 * slower computer takes longer for all of them alike, so they say how much of a frame a script takes on a fast one.
 */
import regionsData from "../data/remastered-regions.json";

/**
 * Nanoseconds, from probes/frame-weights and probes/fast-cells played 2026-10-18 (the slopes between 200 and 800
 * thousand records a frame).
 * A kind the probe did not measure is counted as the measured kind closest to it, said beside each.
 */
export const WEIGHTS = {
  /** A trigger the walk passes: found through the caches, its next pointer read (empty triggers 9.0; 1 against 64 actions to a trigger 8.6). */
  trigger: 8.6,
  /** A Deaths condition, the region cached. */
  deathsCondition: 4.8,
  /** A Set Deaths, the region cached. */
  setDeaths: 9.7,
  /** More for a masked Set Deaths: a read before the write. */
  masked: 3.0,
  /** More for a field of a unit: the unit region's own read (measured on reads; writes counted the same). */
  unitField: 7.5,
  /** More when the emulator searches its tree: the region is not the one cached. */
  search: 7.3,
  /** The search from one unit to another: the two lie close in the tree (unitWalk against unitSame). */
  searchNextUnit: 4.7,
  /**
   * An action outside the emulator: probes/fast-cells (2026-10-18) measured Set Switch 3.3, Set Resources 3.7–4.2 and
   * Set Score 3.8–4.2 (frame-weights had Set Switch 3.1). Display Text, Create Unit and the rest are not measured, and
   * likely more.
   */
  otherAction: 3.8,
  /** A condition outside the emulator: Switch 3.0, Accumulate 3.8, Score 3.7 (probes/fast-cells). */
  otherCondition: 3.6,
} as const;

/** Remastered's frame on that computer: what the game takes of 42 ms (Fastest) before the triggers, and what is left. */
export const FRAME_MS = 42, GAME_MS = 5.4;
/** The trigger work a frame took with no flicker anyone saw (frame-weights, 15 ms of one-action triggers), and the most before the game slows. */
export const SMOOTH_MS = 15, MOST_MS = FRAME_MS - GAME_MS;

const DEATHS = 0x58a364, CURRENT_PLAYER = 0x6509b0;
const DEATHS_CONDITION = 15, SET_DEATHS = 45, MASKED = 0x4353; // 'SC' in the record's last word

interface Regions { strings: number; pools: { name: string; base: number; stride: number; count: number }[]; regions: [number, number, number][] }

/** Which emulator region an address is in, as a number: equal numbers are one region. */
export class RegionMap {
  private readonly starts: number[];
  private readonly ends: number[];
  private readonly pools: Regions["pools"];
  private readonly strings: number;
  private readonly unitsBase: number;
  private readonly unitsEnd: number;
  /** Numbers past every region's own: the pools' elements, then pages of what no region names. */
  private static readonly POOLS = 1 << 20;

  constructor(data: Regions = regionsData as unknown as Regions) {
    const r = [...data.regions].sort((a, b) => a[0] - b[0]);
    this.starts = r.map((x) => x[0]);
    this.ends = r.map((x) => x[0] + x[1]);
    this.pools = data.pools;
    this.strings = data.strings;
    const units = data.pools.find((p) => p.name === "units");
    this.unitsBase = units?.base ?? 0;
    this.unitsEnd = units ? units.base + units.stride * units.count : 0;
  }

  /** The region of `address`: the strings region (eudplib's payload and variables) is -1. */
  of(address: number): number {
    if (address >= this.strings) return -1;
    let lo = 0, hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= address) lo = mid + 1; else hi = mid - 1;
    }
    if (hi >= 0 && address < this.ends[hi]) return hi;
    let base = RegionMap.POOLS;
    for (const p of this.pools) {
      if (address >= p.base && address < p.base + p.stride * p.count) return base + Math.floor((address - p.base) / p.stride);
      base += p.count;
    }
    return base + (address >>> 8); // nothing Remastered names: its own region, roughly
  }

  /** Whether `address` is in a unit. */
  unit(address: number): boolean { return address >= this.unitsBase && address < this.unitsEnd; }
}

/** The weigher scm-sim's tap asks (`CostWeigh`, by shape: TrigScript never imports the engine). */
export class RemasteredWeigh {
  private read = -2;
  private write = -2;
  private readUnit = false;
  private writeUnit = false;
  /** The trigger before, whose next pointer the walk reads (through the read cache) before the next trigger. */
  private before = -1;
  private readonly m: DataView;
  private readonly regions: RegionMap;

  constructor(m: DataView, regions = new RegionMap()) { this.m = m; this.regions = regions; }

  trigger(trigger: number): number {
    if (this.before >= 0) this.cacheRead(this.before);
    this.before = trigger;
    const r = this.regions.of(trigger);
    // The walk looks for the trigger's region in both caches, and searches only when neither holds it; it caches nothing.
    return WEIGHTS.trigger + (r === this.read || r === this.write ? 0 : WEIGHTS.search);
  }

  record(record: number, type: number, action: boolean): number {
    const m = this.m;
    if (record + 0x20 > m.byteLength) return action ? WEIGHTS.otherAction : WEIGHTS.otherCondition;
    if (!action && type === DEATHS_CONDITION) {
      const masked = m.getUint16(record + 0x12, true) === MASKED;
      const a = this.address(m.getUint32(record + 4, true), m.getUint16(record + 0xc, true), masked, false);
      return a < 0 ? WEIGHTS.otherCondition : WEIGHTS.deathsCondition + this.cacheRead(a);
    }
    if (action && type === SET_DEATHS) {
      const masked = m.getUint16(record + 0x1e, true) === MASKED;
      const a = this.address(m.getUint32(record + 0x10, true), m.getUint16(record + 0x18, true), masked, true);
      if (a < 0) return WEIGHTS.otherAction;
      return WEIGHTS.setDeaths + (masked ? WEIGHTS.masked + this.cacheRead(a) - (this.regions.unit(a) ? WEIGHTS.unitField : 0) : 0) + this.cacheWrite(a);
    }
    return action ? WEIGHTS.otherAction : WEIGHTS.otherCondition;
  }

  reset() { this.read = this.write = -2; this.readUnit = this.writeUnit = false; this.before = -1; }

  /** The dword a Deaths record names, as the emulator takes it; -1 when the game's own routine does it (a group of players, the unit classes). */
  private address(player: number, unit: number, masked: boolean, write: boolean): number {
    const p = player === 13 ? (CURRENT_PLAYER + 4 <= this.m.byteLength ? this.m.getUint32(CURRENT_PLAYER, true) : -1) : player >= 14 && player <= 26 ? -1 : player;
    if (p < 0 || (!masked && (write ? p < 8 && unit >= 0xe4 && unit <= 0xe8 : unit >= 0xe5 && unit <= 0xe8))) return -1;
    return (DEATHS + 4 * (p + 12 * unit)) >>> 0;
  }

  /** What a read of `address` costs beyond the record's own, and the read cache after it. */
  private cacheRead(address: number): number {
    const r = this.regions.of(address), unit = this.regions.unit(address);
    const cost = (r === this.read ? 0 : unit && this.readUnit ? WEIGHTS.searchNextUnit : WEIGHTS.search) + (unit ? WEIGHTS.unitField : 0);
    this.read = r;
    this.readUnit = unit;
    return cost;
  }

  private cacheWrite(address: number): number {
    const r = this.regions.of(address), unit = this.regions.unit(address);
    const cost = (r === this.write ? 0 : unit && this.writeUnit ? WEIGHTS.searchNextUnit : WEIGHTS.search) + (unit ? WEIGHTS.unitField : 0);
    this.write = r;
    this.writeUnit = unit;
    return cost;
  }
}
