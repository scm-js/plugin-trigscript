// What a frame costs Remastered in time (cost step 1), without a game: the regions the emulator caches, and the
// weigher keeping its two caches as Remastered does, record by record.
import { describe, expect, it } from "vitest";
import { RegionMap, RemasteredWeigh, WEIGHTS as W } from "../compiler/remasteredCost";

const DEATHS = 0x58a364, UNITS = 0x59cca8, STRINGS = 0x191943c8;
/** The (player, unit) of a Deaths record that names `address` (EPD). */
const epd = (address: number) => { const i = (address - DEATHS) / 4; return { player: i >>> 0, unit: 0 }; };

/** Memory with room for records at 0x1000 (conditions) and 0x2000 (actions), and the current player. */
function memory() {
  const m = new DataView(new ArrayBuffer(0x10000));
  let at = 0x1000;
  const condition = (address: number, mask?: number) => {
    const r = at; at += 0x20;
    const { player, unit } = epd(address);
    m.setUint32(r + 4, player, true); m.setUint16(r + 0xc, unit, true);
    if (mask !== undefined) { m.setUint32(r, mask, true); m.setUint16(r + 0x12, 0x4353, true); }
    return r;
  };
  const action = (address: number, mask?: number) => {
    const r = at; at += 0x20;
    const { player, unit } = epd(address);
    m.setUint32(r + 0x10, player, true); m.setUint16(r + 0x18, unit, true);
    if (mask !== undefined) { m.setUint32(r, mask, true); m.setUint16(r + 0x1e, 0x4353, true); }
    return r;
  };
  return { m, condition, action };
}

describe("RegionMap", () => {
  const regions = new RegionMap();
  it("gives every unit a region of its own and the payload one", () => {
    expect(regions.of(UNITS + 8)).toBe(regions.of(UNITS + 0x40));
    expect(regions.of(UNITS + 336)).not.toBe(regions.of(UNITS));
    expect(regions.unit(UNITS + 336 * 1699)).toBe(true);
    expect(regions.unit(UNITS + 336 * 1700)).toBe(false);
    expect(regions.of(STRINGS + 0x100000)).toBe(-1);
  });
  it("keeps the deaths table in one region", () => {
    expect(regions.of(DEATHS)).toBe(regions.of(DEATHS + 4 * 12 * 227));
    expect(regions.of(DEATHS)).not.toBe(regions.of(UNITS));
  });
});

describe("RemasteredWeigh", () => {
  it("charges a search when the region is not the one cached, read and write apart", () => {
    const { m, condition, action } = memory();
    const w = new RemasteredWeigh(m);
    const pay = action(STRINGS + 0x40), deaths = action(DEATHS + 4 * 2400);
    expect(w.record(pay, 45, true)).toBeCloseTo(W.setDeaths + W.search);  // nothing cached yet
    expect(w.record(pay, 45, true)).toBeCloseTo(W.setDeaths);
    expect(w.record(deaths, 45, true)).toBeCloseTo(W.setDeaths + W.search);
    expect(w.record(pay, 45, true)).toBeCloseTo(W.setDeaths + W.search);
    // A read caches apart from the writes.
    const read = condition(STRINGS + 0x44);
    expect(w.record(read, 15, false)).toBeCloseTo(W.deathsCondition + W.search);
    expect(w.record(read, 15, false)).toBeCloseTo(W.deathsCondition);
    expect(w.record(pay, 45, true)).toBeCloseTo(W.setDeaths);
  });

  it("charges a unit's own read, and a shorter search from one unit to the next", () => {
    const { m, condition } = memory();
    const w = new RemasteredWeigh(m);
    const a = condition(UNITS + 8), a2 = condition(UNITS + 0x10), b = condition(UNITS + 336 + 8), pay = condition(STRINGS);
    w.record(a, 15, false);
    expect(w.record(a2, 15, false)).toBeCloseTo(W.deathsCondition + W.unitField);
    expect(w.record(b, 15, false)).toBeCloseTo(W.deathsCondition + W.unitField + W.searchNextUnit);
    expect(w.record(pay, 15, false)).toBeCloseTo(W.deathsCondition + W.search);
    expect(w.record(a, 15, false)).toBeCloseTo(W.deathsCondition + W.unitField + W.search);
  });

  it("charges a masked write its read too", () => {
    const { m, action } = memory();
    const w = new RemasteredWeigh(m);
    const masked = action(STRINGS + 0x40, 0xff);
    w.record(masked, 45, true);
    expect(w.record(masked, 45, true)).toBeCloseTo(W.setDeaths + W.masked);
  });

  it("finds a trigger through either cache, reads its next pointer through the read one, and searches when neither holds it", () => {
    const { m, condition, action } = memory();
    const w = new RemasteredWeigh(m);
    const t1 = STRINGS + 0x1000, t2 = STRINGS + 0x2000;
    expect(w.trigger(t1)).toBeCloseTo(W.trigger + W.search);   // nothing cached
    w.record(condition(UNITS + 8), 15, false);                  // reads a unit
    w.record(action(DEATHS), 45, true);                         // writes the deaths table
    expect(w.trigger(t2)).toBeCloseTo(W.trigger);               // t1's next pointer was read: the payload is the read cache again
    w.record(condition(UNITS + 8), 15, false);
    w.record(action(DEATHS), 45, true);
    // Two triggers that ran nothing in a row: the first's next pointer is read before the second is looked for.
    expect(w.trigger(t1)).toBeCloseTo(W.trigger);
  });

  it("weighs the kinds outside the emulator as measured, and resolves Current Player", () => {
    const { m } = memory();
    const w = new RemasteredWeigh(m);
    expect(w.record(0x3000, 13, true)).toBeCloseTo(W.otherAction);
    expect(w.record(0x3000, 11, false)).toBeCloseTo(W.otherCondition);
    // Current Player (13) is read from 0x6509B0: outside this small memory, so the record is weighed as the game's own.
    const r = 0x3100;
    m.setUint32(r + 4, 13, true);
    expect(w.record(r, 15, false)).toBeCloseTo(W.otherCondition);
    const big = new DataView(new ArrayBuffer(0x651000)), wb = new RemasteredWeigh(big);
    big.setUint32(0x6509b0, (UNITS + 8 - DEATHS) / 4, true);    // Current Player: an EPD into unit 0
    big.setUint32(r + 4, 13, true);
    expect(wb.record(r, 15, false)).toBeCloseTo(W.deathsCondition + W.search + W.unitField);
  });
});
