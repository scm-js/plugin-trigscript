/**
 * The service against a stand-in host: applying lands on the map the script was compiled
 * for, and only there; saving applies the script first and builds its programs by
 * TrigScript's own build step. The compiler is the real one, run synchronously; the host is
 * the handful of calls `prepare`, `install` and `buildOwn` make, over a trigger list and a
 * member map per "document".
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { ActionType, emptyAction, emptyTrigger, type TriggerRecord } from "../vendor/triggers";
import { compileScript } from "../compiler/compiler";
import { buildOwnMap } from "../compiler/backend/build";
import { Sections, readFacts, writeChunks } from "../compiler/backend/chk";
import { firstFault, MAGENTA_MEMBER, positionIn, ScriptService, type Compiler } from "../service";
import { readFiles, readManifest, scriptState } from "../script";
import type { OwnBuildEvent } from "../service";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();

interface Doc { id: number; triggers: TriggerRecord[]; extras: Map<string, Uint8Array>; strings: string[]; locations: string[] }

/** A build step as the host keeps it (`buildSteps.add`). */
interface Step { id: string; label: string; applies: () => boolean; run: (input: { map: Uint8Array; fileName: string; purpose: "save" | "test" | "export"; signal: AbortSignal }) => Promise<Uint8Array> }

/** A host with several open maps and one in front. */
function host() {
  const docs: Doc[] = [];
  let front: Doc | null = null;
  const statuses: string[] = [];
  const doc = () => { if (!front) throw new Error("no map"); return front; };
  /** What the editor's save path holds for the plugin: the work before the bytes, and the build steps. */
  const before: { id: string; label: string; applies?: () => boolean; run: (ctx: { purpose: "save"; signal: AbortSignal }) => void | Promise<void> }[] = [];
  const steps: Step[] = [];
  const api = {
    document: {
      isOpen: () => front !== null,
      id: () => front?.id ?? null,
      info: () => (front ? { width: 64, height: 64 } : null),
      // P1 a human, P2 a computer, in forces of their own.
      scenario: () => (front ? { width: 64, height: 64, playerTypes: [6, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], forces: { playerForce: [0, 1, 0, 0, 0, 0, 0, 0] }, units: [], locations: [], cuwp: null } : null),
      // (A bare scenario stands for the map file here.)
      sections: { chkOf: async (file: Uint8Array) => file },
      extras: {
        list: () => [...doc().extras.keys()],
        get: (name: string) => doc().extras.get(name) ?? null,
        set: (name: string, bytes: Uint8Array) => { doc().extras.set(name, bytes); },
        remove: (name: string) => { doc().extras.delete(name); },
      },
      buildSteps: {
        before: (spec: (typeof before)[number]) => { before.push(spec); return { dispose: () => { before.splice(before.indexOf(spec), 1); } }; },
        add: (spec: Step) => { steps.push(spec); return { dispose: () => { steps.splice(steps.indexOf(spec), 1); } }; },
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
    services: { get: () => null, watch: () => ({ dispose() {} }) },
    ui: { status: (text: string) => { statuses.push(text); } },
  };
  return {
    api: api as unknown as PluginApi,
    statuses,
    before,
    steps,
    open(id: number, locations: string[] = []): Doc { const d: Doc = { id, triggers: [], extras: new Map(), strings: [""], locations }; docs.push(d); front = d; return d; },
    activate(d: Doc) { front = d; },
    close() { front = null; },
  };
}

/** The real compiler, at once — with a hook to run something between the compile starting and its result landing. */
function compiler(during: () => void = () => {}): Compiler {
  return async (input) => {
    const r = compileScript(ts, input.files, input.names, { lib: LIB, ...(input.own ? { own: input.own } : {}) });
    during();
    return r;
  };
}

/** The build of a map of our own, at once. */
const builder = async (input: Parameters<typeof buildOwnMap>[0]) => buildOwnMap(input);

const SRC = `trigger(P1, [always()], [displayText("hi")]);`;

/** A scenario of the few sections the build reads: 64 × 64, P1 a human and P2 a computer, two strings, no triggers. */
function chk(): Uint8Array {
  const u16 = (...v: number[]) => new Uint8Array(v.flatMap((x) => [x & 0xff, (x >> 8) & 0xff]));
  const ownr = new Uint8Array(12); ownr[0] = 6; ownr[1] = 5;
  const forc = new Uint8Array(20); forc[1] = 1;
  const str = new Uint8Array([2, 0, 6, 0, 8, 0, 65, 0, 66, 0]);
  return writeChunks([{ name: "VER ", data: u16(59) }, { name: "DIM ", data: u16(64, 64) }, { name: "OWNR", data: ownr }, { name: "FORC", data: forc }, { name: "STR ", data: str }, { name: "TRIG", data: new Uint8Array(0) }]);
}

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
    expect(h.statuses).toEqual(["Applied 1 trigger → #1–#1."]);
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

  it("replaces its block in place among hand triggers; a program adds nothing to the list", async () => {
    const h = host();
    const d = h.open(1);
    const hand = emptyTrigger();
    hand.players[0] = 1;
    hand.actions.push({ ...emptyAction(), type: ActionType.SetDeaths, player: 13, unitId: 181, modifier: 7, target: 1 });
    d.triggers = [hand];
    const svc = new ScriptService(h.api, () => {}, compiler());
    const first = await svc.build(`${SRC}\nprogram(() => { displayText("a"); });`);
    expect(first.block).toMatchObject({ start: 1, count: 1 });
    expect(h.statuses.at(-1)).toBe("Applied 1 trigger → #2–#2. 1 program will be built into the saved map (StarCraft: Remastered).");
    const second = await svc.build(`${SRC}\n${SRC}\nprogram(() => { displayText("a"); displayText("b"); });`);
    expect(second.block).toMatchObject({ start: 1, count: 2 });
    expect(d.triggers[0]).toBe(hand);
    expect(d.triggers).toHaveLength(3);
    // The program's text never reaches the map's string table: eudplib adds it to the built file.
    expect(d.strings).toEqual(["", "hi"]);
    expect(readManifest(d.extras)).toMatchObject({ programs: 1 });
  });
});

/** A stand-in for the eudplib plugin's service: it keeps what is contributed and lets a test ask for it as a build would. */
const ctx = { purpose: "save" as const, signal: new AbortController().signal };

describe("service: saving applies the script and builds its programs", () => {
  const PROGRAM = `${SRC}\nprogram(() => { let n = 0; while (true) { n++; displayText("tick"); sleep(seconds(1)); } });`;
  /** A program the build does not take (Wait is refused on purpose). */
  const REFUSED = `${SRC}\nprogram(() => { let n = 0; while (true) { n++; displayText("tick"); wait(1000); sleep(seconds(1)); } });`;

  it("builds the programs: the step applies, and the scenario comes back a Remastered one with the payload in it", async () => {
    const h = host();
    h.open(1);
    let compiles = 0;
    const svc = new ScriptService(h.api, () => {}, compiler(() => { compiles++; }), builder);
    svc.attach();
    expect(h.steps).toHaveLength(1);
    const step = h.steps[0];
    expect(step).toMatchObject({ id: "build", label: "TrigScript" });
    // Nothing applied, then triggers alone: nothing to build.
    expect(step.applies()).toBe(false);
    await svc.build(SRC);
    expect(step.applies()).toBe(false);
    // A program: the step applies.
    await svc.build(PROGRAM);
    expect(step.applies()).toBe(true);
    expect(svc.whyNotBuilt()).toBeNull();
    const manifest = readManifest(new Map([...h.api.document.extras.list().map((n) => [n, h.api.document.extras.get(n)!] as const)]));
    expect(manifest?.programs).toBe(1);
    // The step: the scenario in, the built one out — no second compile, the apply's is fresh.
    const heard: OwnBuildEvent[] = [];
    svc.onBuild((e) => heard.push(e));
    const before = compiles;
    const out = await step.run({ map: chk(), fileName: "x.scx", purpose: "save", signal: new AbortController().signal });
    expect(compiles).toBe(before);
    const s = new Sections(out);
    expect(readFacts(s).version).toBe(206);
    expect(s.get("STRx")!.length).toBeGreaterThan(10);
    expect(s.get("TRIG")!.length % 2400).toBe(0);
    expect(s.get("TRIG")!.length).toBeGreaterThan(0);
    // Start, a line for the build itself, one for each fix (a Remastered file; STR written as STRx), the counts, done.
    expect(heard.map((e) => e.kind)).toEqual(["start", "log", "log", "log", "log", "done"]);
    expect(heard[0]).toMatchObject({ kind: "start", purpose: "save", contributors: ["trigscript"] });
    expect(heard.at(-1)).toMatchObject({ kind: "done", purpose: "save", chkBytes: out.length });
    expect((heard[1] as { line: string }).line).toMatch(/^Built by TrigScript: 1 program laid out into the map$/);
    // A build asked for the maps of where the triggers and the variables are says them in the log.
    heard.length = 0;
    await svc.withVariableMap(() => step.run({ map: chk(), fileName: "x.scx", purpose: "test", signal: new AbortController().signal }));
    const logged = heard.flatMap((e) => (e.kind === "log" ? [e.line] : []));
    expect(logged.some((l) => l.startsWith("TRIGSCRIPT-MAP "))).toBe(true);
    expect(logged.some((l) => l.startsWith("TRIGSCRIPT-VARS "))).toBe(true);
    expect(logged.filter((l) => l.startsWith("TRIGSCRIPT-PROGRAM ")).length).toBe(1);
    // The step going with the service.
    svc.attach().dispose();
  });

  it("a program the build does not take: the step runs and fails with the reason, said to the listeners too", async () => {
    const h = host();
    h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler(), builder);
    svc.attach();
    await svc.build(REFUSED);
    expect(h.steps[0].applies()).toBe(true);
    const heard: OwnBuildEvent[] = [];
    svc.onBuild((e) => heard.push(e));
    await expect(h.steps[0].run({ map: chk(), fileName: "x.scx", purpose: "test", signal: new AbortController().signal })).rejects.toThrow(/^The programs were not built: TrigScript does not take this yet \(the action Wait .*, line 2\)\.$/);
    expect(heard.at(-1)).toMatchObject({ kind: "failed", purpose: "test", from: "trigscript" });
    // Made right, the next apply builds.
    await svc.build(PROGRAM);
    const out = await h.steps[0].run({ map: chk(), fileName: "x.scx", purpose: "test", signal: new AbortController().signal });
    expect(new Sections(out).get("TRIG")!.length).toBeGreaterThan(0);
  });

  it("Magenta's triggers in the map: the programs are not built, and the notice says why", async () => {
    const h = host();
    const d = h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler(), builder);
    svc.attach();
    await svc.build(PROGRAM);
    expect(svc.whyNotBuilt()).toBeNull();
    d.extras.set(MAGENTA_MEMBER, new Uint8Array([123, 125]));
    expect(svc.whyNotBuilt()).toMatch(/^Magenta's triggers are in this map: TrigScript's programs are not built beside them yet/);
    expect(h.steps[0].applies()).toBe(true);
    await expect(h.steps[0].run({ map: chk(), fileName: "x.scx", purpose: "save", signal: new AbortController().signal })).rejects.toThrow(/^Magenta's triggers are in this map/);
    d.extras.delete(MAGENTA_MEMBER);
    expect(svc.whyNotBuilt()).toBeNull();
    await expect(h.steps[0].run({ map: chk(), fileName: "x.scx", purpose: "save", signal: new AbortController().signal })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("the work before a save applies a script that is newer than its block, and only then", async () => {
    const h = host();
    const d = h.open(1);
    let compiles = 0;
    const svc = new ScriptService(h.api, () => {}, compiler(() => { compiles++; }));
    const attached = svc.attach();
    expect(h.before).toHaveLength(1);
    const step = h.before[0];
    expect(step).toMatchObject({ id: "apply", label: "TrigScript" });
    // A map with no script is not the plugin's business: the editor does not even show its notice.
    expect(step.applies!()).toBe(false);
    svc.writeFiles({ "main.ts": PROGRAM });
    expect(step.applies!()).toBe(true);
    await step.run(ctx);
    expect(d.triggers).toHaveLength(1);
    expect(scriptState(d.triggers, d.extras)).toMatchObject({ unbuilt: false, programs: 1 });
    expect(compiles).toBe(1);
    // Up to date: the next save compiles nothing.
    await step.run(ctx);
    expect(compiles).toBe(1);
    attached.dispose();
    expect(h.before).toHaveLength(0);
  });

  it("a script that does not compile stops nothing: the work throws one line for the editor's notice, the block stays", async () => {
    const h = host();
    const d = h.open(1);
    const svc = new ScriptService(h.api, () => {}, compiler());
    svc.attach();
    await svc.build(SRC);
    svc.writeFiles({ "main.ts": `${SRC}\nnope();\nalsoNope();` });
    await expect(h.before[0].run(ctx)).rejects.toThrow(/^main\.ts:2 — Cannot find name 'nope'\. \(and 1 more\)$/);
    expect(d.triggers).toHaveLength(1);
    // A block edited by hand is the user's to settle, in the editor.
    const stale = host();
    const e = stale.open(1);
    const svc2 = new ScriptService(stale.api, () => {}, compiler());
    svc2.attach();
    await svc2.build(SRC);
    e.triggers[0] = { ...e.triggers[0], flags: 99 };
    svc2.writeFiles({ "main.ts": `${SRC} // newer` });
    await expect(stale.before[0].run(ctx)).rejects.toThrow(/edited or removed outside the script/);
  });

  it("finds the line a failure names", () => {
    expect(positionIn("trigscript: unknown variable 'n' at main.ts:12:5")).toEqual({ file: "main.ts", line: 12, column: 5 });
    expect(positionIn("eudplib said no")).toBeNull();
    expect(firstFault([])).toBe("The script has errors.");
  });
});
