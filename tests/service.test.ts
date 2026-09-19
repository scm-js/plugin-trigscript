/**
 * The service against a stand-in host: applying lands on the map the script was compiled
 * for, and only there; saving applies the script first and hands its programs to the
 * eudplib plugin's build. The compiler is the real one, run synchronously; the host is the
 * handful of calls `prepare` and `install` make, over a trigger list and a member map
 * per "document".
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { ActionType, emptyAction, emptyTrigger, type TriggerRecord } from "../vendor/triggers";
import { compileScript } from "../compiler/compiler";
import { firstFault, positionIn, ScriptService, type Compiler } from "../service";
import { readFiles, readManifest, scriptState } from "../script";
import type { EudplibBuildEvent, EudplibContribution, EudplibService } from "../vendor/eudplib";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();

interface Doc { id: number; triggers: TriggerRecord[]; extras: Map<string, Uint8Array>; strings: string[]; locations: string[] }

/** A host with several open maps and one in front. */
function host() {
  const docs: Doc[] = [];
  let front: Doc | null = null;
  const statuses: string[] = [];
  const doc = () => { if (!front) throw new Error("no map"); return front; };
  /** What the editor's save path holds for the plugin: the work before the bytes, and the library the service watches for. */
  const before: { id: string; label: string; applies?: () => boolean; run: (ctx: { purpose: "save"; signal: AbortSignal }) => void | Promise<void> }[] = [];
  let library: EudplibService | null = null;
  const watchers = new Set<(s: EudplibService | null) => void>();
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
      buildSteps: { before: (spec: (typeof before)[number]) => { before.push(spec); return { dispose: () => { before.splice(before.indexOf(spec), 1); } }; } },
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
    services: {
      get: () => library,
      watch: (_name: string, listener: (s: EudplibService | null) => void) => { watchers.add(listener); listener(library); return { dispose: () => { watchers.delete(listener); } }; },
    },
    ui: { status: (text: string) => { statuses.push(text); } },
  };
  return {
    api: api as unknown as PluginApi,
    statuses,
    before,
    /** The eudplib plugin arrives (or goes): what it was asked to build with is kept for the test to look at. */
    provide(svc: EudplibService | null) { library = svc; for (const w of [...watchers]) w(svc); },
    open(id: number, locations: string[] = []): Doc { const d: Doc = { id, triggers: [], extras: new Map(), strings: [""], locations }; docs.push(d); front = d; return d; },
    activate(d: Doc) { front = d; },
    close() { front = null; },
  };
}

/** The real compiler, at once — with a hook to run something between the compile starting and its result landing. */
function compiler(during: () => void = () => {}): Compiler {
  return async (input) => {
    const r = compileScript(ts, input.files, input.names, { lib: LIB });
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
function libraryStub() {
  const contributions: EudplibContribution[] = [];
  const listeners = new Set<(e: EudplibBuildEvent) => void>();
  const svc = {
    versions: { plugin: "0.4.0", eudplib: "0.81.0", pyodide: "314", euddraft: "x" }, state: () => "ready" as const, downloadBytes: 0,
    ensure: async () => true, build: async () => { throw new Error("not in this test"); },
    contribute: (c: EudplibContribution) => { contributions.push(c); return { dispose: () => { contributions.splice(contributions.indexOf(c), 1); } }; },
    onBuild: (l: (e: EudplibBuildEvent) => void) => { listeners.add(l); return { dispose: () => { listeners.delete(l); } }; },
  } satisfies EudplibService;
  return { svc, contributions, emit: (e: EudplibBuildEvent) => { for (const l of [...listeners]) l(e); } };
}
const ctx = { purpose: "save" as const, signal: new AbortController().signal };

describe("service: saving applies the script and builds its programs", () => {
  const PROGRAM = `${SRC}\nprogram(() => { let n = 0; while (true) { n++; displayText("tick"); sleep(seconds(1)); } });`;

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

  it("contributes its programs to the library's build: the IR with every text written out, the lowering, eudTurbo", async () => {
    const h = host();
    h.open(1);
    const lib = libraryStub();
    let compiles = 0;
    const svc = new ScriptService(h.api, () => {}, compiler(() => { compiles++; }));
    svc.attach();
    expect(lib.contributions).toHaveLength(0);
    h.provide(lib.svc);
    expect(lib.contributions).toHaveLength(1);
    const mine = lib.contributions[0];
    expect(mine).toMatchObject({ id: "trigscript", label: "TrigScript" });
    // Nothing applied yet, then a script of triggers alone: nothing for eudplib, so Save stays what it was.
    expect(mine.applies()).toBe(false);
    await svc.build(SRC);
    expect(mine.applies()).toBe(false);
    await svc.build(PROGRAM);
    expect(mine.applies()).toBe(true);
    const before = compiles;
    const input = await mine.collect(ctx);
    // The apply that just ran compiled these very files against these very names: no second compile.
    expect(compiles).toBe(before);
    expect(Object.keys(input.plugins)).toEqual(["trigscript", "eudTurbo"]);
    expect(input.plugins.trigscript).toEqual({ ir: "/work/files/trigscript.json" });
    expect(input.sources!.trigscript).toContain("IR_VERSION = 11");
    const ir = JSON.parse(input.files!["trigscript.json"]);
    expect(ir.version).toBe(11);
    expect(ir.programs).toHaveLength(1);
    expect(JSON.stringify(ir)).toContain('"text":"tick"');
    // The library going away takes the contribution with it; coming back, it is made again.
    h.provide(null);
    expect(lib.contributions).toHaveLength(0);
    h.provide(lib.svc);
    expect(lib.contributions).toHaveLength(1);
  });

  it("collect compiles when it has to, and a script with errors fails the build in one line", async () => {
    const h = host();
    h.open(1);
    const lib = libraryStub();
    const svc = new ScriptService(h.api, () => {}, compiler());
    svc.attach();
    h.provide(lib.svc);
    await svc.build(PROGRAM);
    svc.writeFiles({ "main.ts": `${PROGRAM}\nnope();` });
    await expect(lib.contributions[0].collect(ctx)).rejects.toThrow(/^main\.ts:3 — /);
    // A library older than 0.4 has no contribute(): the service simply does not take part.
    const old = host();
    old.open(1);
    const svc2 = new ScriptService(old.api, () => {}, compiler());
    svc2.attach();
    old.provide({ ...lib.svc, contribute: undefined, onBuild: undefined });
    expect(svc2.library()?.contribute).toBeUndefined();
  });

  it("hears the library's builds, and finds the line a failure names", () => {
    const h = host();
    h.open(1);
    const lib = libraryStub();
    h.provide(lib.svc);
    const svc = new ScriptService(h.api, () => {}, compiler());
    const heard: string[] = [];
    const sub = svc.onBuild((e) => heard.push(e.kind));
    lib.emit({ kind: "start", purpose: "save", contributors: ["trigscript"] });
    lib.emit({ kind: "failed", purpose: "save", contributors: ["trigscript"], from: null, message: "trigscript: unknown variable 'n' at main.ts:12:5", log: "" });
    expect(heard).toEqual(["start", "failed"]);
    sub.dispose();
    lib.emit({ kind: "log", line: "x" });
    expect(heard).toHaveLength(2);
    expect(positionIn("trigscript: unknown variable 'n' at main.ts:12:5")).toEqual({ file: "main.ts", line: 12, column: 5 });
    expect(positionIn("eudplib said no")).toBeNull();
    expect(firstFault([])).toBe("The script has errors.");
  });
});
