/** `refs.ts`: references to the map's names in the script, and renames following them. */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type ScriptFiles } from "../compiler/compiler";
import { scriptNames, type NameTable } from "../compiler/names";
import { findReferences, renamedKeys, renamesInUse, replaceReferences } from "../refs";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const table = (entries: [number, string, string][]): NameTable => ({ object: "locations", type: "Location", doc: "", entries: entries.map(([value, key, name]) => ({ value, keys: key === name ? [key] : [key, name] })) });
const refsOf = (files: ScriptFiles, locations = ["Beacon", "Spawn", "Old"]) => compileScript(ts, files, scriptNames({ locations: locations.map((name, index) => ({ index, name })) }), { lib: LIB }).refs;

describe("references", () => {
  it("finds object.key by spelling, for links while typing", () => {
    const text = 'bring(P1, units.AnyUnit, locations.Beacon, ">=", 1);\nconst x = my.locations.Beacon + locations["Beacon"];\n  locations.Spawn;';
    expect(findReferences(text, "locations")).toEqual([
      { key: "Beacon", line: 1, column: 36, endColumn: 42 },
      { key: "Spawn", line: 3, column: 13, endColumn: 18 },
    ]);
  });

  it("sees what the map renamed — a custom switch name too — and only what the script uses", () => {
    const before = table([[1, "Beacon", "Beacon"], [2, "Spawn", "Spawn"], [3, "Old", "Old"]]);
    const after = table([[1, "Beacon", "Beacon"], [2, "SpawnPoint", "Spawn Point"], [3, "New", "New"]]);
    const renames = renamedKeys(before, after);
    expect(renames).toEqual([{ value: 2, from: "Spawn", to: "SpawnPoint" }, { value: 3, from: "Old", to: "New" }]);
    const refs = refsOf({ "main.ts": "locations.Spawn; locations.Beacon;" });
    expect(renamesInUse(refs, "locations", renames)).toEqual([{ value: 2, from: "Spawn", to: "SpawnPoint" }]);
    // A switch keeps Switch1 whatever it is called; the custom name is what changes.
    const door = scriptNames({ switchNames: ["Door"] }).switches;
    const gate = scriptNames({ switchNames: ["Gate"] }).switches;
    expect(renamedKeys(door, gate)).toEqual([{ value: 0, from: "Door", to: "Gate" }]);
    // A name taken away falls back to the number.
    expect(renamedKeys(door, scriptNames().switches)).toEqual([{ value: 0, from: "Door", to: "Switch1" }]);
    // A display name with spaces renames both keys the script could have used.
    const spaced = renamedKeys(table([[1, "BeaconAlpha", "Beacon Alpha"]]), table([[1, "Spawn", "Spawn"]]));
    expect(spaced).toEqual([{ value: 1, from: "BeaconAlpha", to: "Spawn" }, { value: 1, from: "Beacon Alpha", to: "Spawn" }]);
  });

  it("replaces the real references across files: not comments, strings, shadowing parameters; bracket keys and aliases included", () => {
    const files = {
      "main.ts": 'import { locations as L } from "trigscript";\n// locations.Spawn stays\nconst s = "locations.Spawn";\nfunction f(locations: { Spawn: number }) { return locations.Spawn; }\na(locations.Spawn, L.Spawn);\nb(locations["Spawn"], locations.Old);',
      "x/y.ts": "locations.Beacon",
    };
    const refs = refsOf(files);
    const out = replaceReferences(files, refs, "locations", [{ value: 2, from: "Spawn", to: "SpawnPoint" }, { value: 3, from: "Old", to: "New" }]);
    expect(out.count).toBe(4);
    expect(out.files).toEqual({
      "main.ts": 'import { locations as L } from "trigscript";\n// locations.Spawn stays\nconst s = "locations.Spawn";\nfunction f(locations: { Spawn: number }) { return locations.Spawn; }\na(locations.SpawnPoint, L.SpawnPoint);\nb(locations["SpawnPoint"], locations.New);',
      "x/y.ts": "locations.Beacon",
    });
  });
});
