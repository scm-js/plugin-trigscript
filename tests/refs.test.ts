/** `refs.ts`: references to the map's names in the script text, and renames following them. */
import { describe, expect, it } from "vitest";
import { findReferences, renamedKeys, renamesInUse, replaceReferences } from "../refs";
import type { NameTable } from "../compiler/names";

const table = (entries: [number, string, string][]): NameTable => ({ object: "locations", type: "Location", doc: "", entries: entries.map(([value, key, name]) => ({ value, keys: [key, name] })) });

describe("references", () => {
  it("finds object.key with positions, not lookalikes", () => {
    const text = 'bring(P1, units.AnyUnit, locations.Beacon, ">=", 1);\nconst x = my.locations.Beacon + locations["Beacon"];\n  locations.Spawn;';
    expect(findReferences(text, "locations")).toEqual([
      { key: "Beacon", line: 1, column: 36, endColumn: 42 },
      { key: "Spawn", line: 3, column: 13, endColumn: 18 },
    ]);
  });

  it("sees what the map renamed, and only what the script uses", () => {
    const before = table([[1, "Beacon", "Beacon"], [2, "Spawn", "Spawn"], [3, "Old", "Old"]]);
    const after = table([[1, "Beacon", "Beacon"], [2, "SpawnPoint", "Spawn Point"], [3, "New", "New"]]);
    const renames = renamedKeys(before, after);
    expect(renames).toEqual([{ value: 2, from: "Spawn", to: "SpawnPoint" }, { value: 3, from: "Old", to: "New" }]);
    expect(renamesInUse({ "main.ts": "locations.Spawn; locations.Beacon;" }, "locations", renames)).toEqual([{ value: 2, from: "Spawn", to: "SpawnPoint" }]);
  });

  it("replaces every reference across files", () => {
    const files = { "main.ts": "a(locations.Spawn);\nb(locations.Spawn, locations.Old);", "x/y.ts": "locations.Beacon" };
    const out = replaceReferences(files, "locations", [{ value: 2, from: "Spawn", to: "SpawnPoint" }, { value: 3, from: "Old", to: "New" }]);
    expect(out.count).toBe(3);
    expect(out.files).toEqual({ "main.ts": "a(locations.SpawnPoint);\nb(locations.SpawnPoint, locations.New);", "x/y.ts": "locations.Beacon" });
  });
});
