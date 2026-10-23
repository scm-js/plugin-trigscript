/**
 * The ledger (`ledger/`, `tests/ledger.ts`): every feature's script says what a map of our own makes of it, and the
 * scripts together reach every kind of the IR and every name of the library. When a step of the way off eudplib lands,
 * `npx tsx scripts/ledger.mts --write` brings the first lines up to date, and the diff is the step's account.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { agrees, apiNames, headerFor, irKeys, irKinds, outcome, readLedger, uses, type Outcome, type Row } from "./ledger";

const rows = readLedger();
const outcomes = new Map<Row, Outcome>();

/** Kinds of the IR no script compiles to, and why that is right. */
const NOT_FROM_A_SCRIPT: Record<string, string> = {
  graph: "the emitter's own statement, made only when a map is built through eudplib with the emitter on",
  textBlock: "a map of our own's statement, which compiler/backend/texts.ts makes for a made text's block",
  showText: "a map of our own's statement, which compiler/backend/texts.ts makes to print a made text's block",
  watch: "a map of our own's statement, which compiler/backend/units.ts makes for the events pass",
  cast: "`u32()`, `i32()` and `fixed()` settle a value's type; `compiler/numbers.ts` takes every cast out once types are known",
  "intrinsic floor": "`compiler/numbers.ts` makes it the number itself, or a shift of a fixed one",
  "intrinsic ceil": "`compiler/numbers.ts` makes it the number itself, or a shift of a fixed one",
  "intrinsic round": "`compiler/numbers.ts` makes it the number itself, or a shift of a fixed one",
  "intrinsic trunc": "`compiler/numbers.ts` makes it the number itself, or a quotient of a fixed one",
};

describe("the ledger", () => {
  beforeAll(() => {
    for (const row of rows) outcomes.set(row, outcome(row));
  }, 600_000);

  it("has a script for each feature", () => {
    expect(rows.length).toBeGreaterThan(300);
  });

  it("says, for every script, what a map of our own makes of it", () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const o = outcomes.get(row)!;
      if (o.error) wrong.push(`${row.file}: does not compile — ${o.error}`);
      else if (!agrees(row, o)) wrong.push(`${row.file}: says "${row.takes ? "takes" : `refused: ${row.reason}`}", is "${headerFor(row.step, o).replace(/^\/\/ ledger: step \d+, /, "")}"`);
    }
    // (After a step lands: `npx tsx scripts/ledger.mts --write`, and read the diff.)
    expect(wrong).toEqual([]);
  });

  it("reaches every kind of the IR", () => {
    const seen = new Set<string>();
    for (const o of outcomes.values()) irKeys(o.ir, seen);
    const missing = irKinds().filter((k) => !seen.has(k) && !(k in NOT_FROM_A_SCRIPT));
    expect(missing).toEqual([]);
  });

  it("uses every name a script has from the library", () => {
    const missing = apiNames().filter((n) => !rows.some((row) => uses(row, n))).map((n) => n.name);
    expect(missing).toEqual([]);
  });
});
