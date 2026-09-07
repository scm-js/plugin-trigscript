/**
 * The service against a stand-in host: a build lands on the map it was compiled for,
 * and only there. The compiler is the real one, run synchronously; the host is the
 * handful of calls `prepare` and `install` make, over a trigger list and a member map
 * per "document".
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { ActionType, emptyAction, emptyTrigger, type TriggerRecord } from "../vendor/triggers";
import { compileScript } from "../compiler/compiler";
import { ScriptService, type Compiler } from "../service";
import { readFiles, scriptState } from "../script";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();

interface Doc { id: number; triggers: TriggerRecord[]; extras: Map<string, Uint8Array>; strings: string[]; locations: string[] }

/** A host with several open maps and one in front. */
function host() {
  const docs: Doc[] = [];
  let front: Doc | null = null;
  const statuses: string[] = [];
  const doc = () => { if (!front) throw new Error("no map"); return front; };
  const api = {
    document: {
      isOpen: () => front !== null,
      id: () => front?.id ?? null,
      info: () => (front ? { width: 64, height: 64 } : null),
      extras: {
        list: () => [...doc().extras.keys()],
        get: (name: string) => doc().extras.get(name) ?? null,
        set: (name: string, bytes: Uint8Array) => { doc().extras.set(name, bytes); },
        remove: (name: string) => { doc().extras.delete(name); },
      },
      update: (_label: string, build: (tx: unknown) => void) => {
        const d = doc();
        build({
          triggers: { list: () => d.triggers.slice(), set: (list: TriggerRecord[]) => { d.triggers = list; } },
          strings: { intern: (text: string) => { let i = d.strings.indexOf(text); if (i < 0) { d.strings.push(text); i = d.strings.length - 1; } return i; } },
        });
        return { ok: true };
      },
    },
    triggers: {
      list: () => doc().triggers.slice(),
      switchNames: () => Array.from({ length: 256 }, (_, i) => `Switch ${i + 1}`),
      claim: () => ({ refresh() {}, remove() {}, dispose() {} }),
    },
    settings: { unitTypes: () => [], forces: () => [] },
    query: { locationsIn: () => doc().locations.map((_, i) => i) },
    names: { location: (i: number) => doc().locations[i] ?? null, string: (i: number) => doc().strings[i] ?? null },
    storage: { get: (_k: string, d: unknown) => d },
    ui: { status: (text: string) => { statuses.push(text); } },
  };
  return {
    api: api as unknown as PluginApi,
    statuses,
    open(id: number, locations: string[] = []): Doc { const d: Doc = { id, triggers: [], extras: new Map(), strings: [""], locations }; docs.push(d); front = d; return d; },
    activate(d: Doc) { front = d; },
    close() { front = null; },
  };
}

/** The real compiler, at once — with a hook to run something between the compile starting and its result landing. */
function compiler(during: () => void = () => {}): Compiler {
  return async (input) => {
    const r = compileScript(ts, input.files, input.names, { lib: LIB, reservedDeaths: input.reservedDeaths, reservedSwitches: input.reservedSwitches });
    during();
    return r;
  };
}

const SRC = `trigger(P1, [always()], [displayText("hi")]);`;

describe("service: a build lands on the map it was compiled for", () => {
  it("builds the map in front and stores the files", async () => {
    const h = host();
    const d = h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler());
    const out = await svc.build(SRC);
    expect(out.refused).toBeUndefined();
    expect(out.block).toEqual({ start: 0, count: 1, sources: [{ file: "main.ts", line: 1 }] });
    expect(d.triggers).toHaveLength(1);
    expect(readFiles(d.extras)).toEqual({ "main.ts": SRC });
    expect(scriptState(d.triggers, d.extras)).toMatchObject({ unbuilt: false, stale: false });
    expect(h.statuses).toEqual(["Built 1 trigger → #1–#1."]);
  });

  it("refuses when another map came to the front during the compile", async () => {
    const h = host();
    const a = h.open(1);
    const b = h.open(2);
    h.activate(a);
    const svc = new ScriptService(h.api, () => {}, compiler(() => h.activate(b)));
    const out = await svc.build(SRC);
    expect(out).toMatchObject({ block: null, refused: "switched" });
    expect(a.triggers).toEqual([]);
    expect(b.triggers).toEqual([]);
    expect(b.extras.size).toBe(0);
  });

  it("refuses when the map closed during the compile", async () => {
    const h = host();
    h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler(() => h.close()));
    expect(await svc.build(SRC)).toMatchObject({ block: null, refused: "closed" });
  });

  it("compiles again when the map's names changed under it, and gives up after two more tries", async () => {
    const h = host();
    const d = h.open(1, ["Start"]);
    let compiles = 0;
    const svc = new ScriptService(h.api, () => {}, compiler(() => { compiles++; d.locations.push(`Extra ${compiles}`); }));
    expect(await svc.build(SRC)).toMatchObject({ block: null, refused: "changed" });
    expect(compiles).toBe(3);
    // A change that settles is built against the new names.
    const settled = host();
    const e = settled.open(1, ["Start"]);
    let once = false;
    const svc2 = new ScriptService(settled.api, () => {}, compiler(() => { if (!once) { once = true; e.locations.push("Base"); } }));
    const out = await svc2.build(`trigger(P1, [bring(P1, units.AnyUnit, locations.Base, ">=", 1)], [victory()]);`);
    expect(out.refused).toBeUndefined();
    expect(e.triggers).toHaveLength(1);
  });

  it("an artifact with errors is refused, not installed", async () => {
    const h = host();
    const d = h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler());
    const out = await svc.build(`trigger(P1, [always()], [wait("x" as any)]);`);
    expect(out).toMatchObject({ block: null, refused: "errors" });
    expect(d.triggers).toEqual([]);
  });

  it("files edited in the archive during the compile are kept, and the build reads as unbuilt", async () => {
    const h = host();
    const d = h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler(() => svc.writeFiles({ "main.ts": `${SRC} // newer` })));
    const out = await svc.build(SRC);
    expect(out.block).toMatchObject({ count: 1 });
    expect(readFiles(d.extras)).toEqual({ "main.ts": `${SRC} // newer` });
    expect(scriptState(d.triggers, d.extras)).toMatchObject({ unbuilt: true, stale: false, block: { start: 0, count: 1 } });
  });

  it("replaces its block in place among hand triggers, and a hand trigger's cells stay out of the programs", async () => {
    const h = host();
    const d = h.open(1);
    const hand = emptyTrigger();
    hand.players[0] = 1;
    hand.actions.push({ ...emptyAction(), type: ActionType.SetDeaths, player: 13, unitId: 181, modifier: 7, target: 1 });
    d.triggers = [hand];
    const svc = new ScriptService(h.api, () => {}, compiler());
    const first = await svc.build(`program(() => { displayText("a"); });`);
    expect(first.block).toMatchObject({ start: 1 });
    expect(first.compiled.variables[0]).toMatchObject({ name: "(program counter)", player: 1, unit: 181 });
    const second = await svc.build(`program(() => { displayText("a"); displayText("b"); });`);
    expect(second.block).toMatchObject({ start: 1 });
    expect(d.triggers[0]).toBe(hand);
    expect(d.triggers).toHaveLength(1 + second.block!.count);
  });
});
