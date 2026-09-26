import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { english } from "../i18n";
import { KO } from "../ko";

// Every literal the plugin shows through `t("…")`, or keeps in a table as `msg("…")`, read from the source the way the
// editor's own extractor reads it: the plugin's files and the compiler's (the compiler describes a variable for the hover).
const root = new URL("../", import.meta.url);
const files = [
  ...readdirSync(root).filter((f) => f.endsWith(".ts") && f !== "ko.ts" && !f.endsWith(".d.ts")),
  ...readdirSync(new URL("compiler/", root)).filter((f) => f.endsWith(".ts")).map((f) => `compiler/${f}`),
];
const sources = files.map((f) => readFileSync(new URL(f, root), "utf8"));
const keys = new Set(sources.flatMap((source) => [...source.matchAll(/\b(?:t|tr|msg)\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)));

/** The placeholders a string fills: `{name}`, `{n, plural, …}`, `{name|을}` — not the words inside a plural's branches. */
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)(?=[},|])/g)].map((m) => m[1]));
/** The ones only English needs: the count a plural chooses its branch by. */
const counts = (s: string) => new Set([...s.matchAll(/\{(\w+), plural/g)].map((m) => m[1]));

describe("the Korean catalogue", () => {
  it("reads the source", () => {
    expect(keys.size).toBeGreaterThan(100);
  });

  it("has every string the plugin shows", () => {
    expect([...keys].filter((k) => !(k in KO))).toEqual([]);
  });

  it("has nothing the plugin no longer shows", () => {
    expect(Object.keys(KO).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps every placeholder, and adds none", () => {
    for (const [en, ko] of Object.entries(KO)) {
      const want = [...names(en)].filter((n) => !counts(en).has(n) || names(ko).has(n)).sort();
      expect([...names(ko)].sort(), en).toEqual(want);
    }
  });

  it("fills English the way the editor does", () => {
    expect(english("{n, plural, one {# test} other {# tests}} passed.", { n: 1 })).toBe("1 test passed.");
    expect(english("{n, plural, one {# test} other {# tests}} passed.", { n: 3 })).toBe("3 tests passed.");
    expect(english("There is already a {name}.", { name: "a.ts" })).toBe("There is already a a.ts.");
    expect(english("{n, plural, one {The program is} other {The # programs are}} built", { n: 2 })).toBe("The 2 programs are built");
  });
});
