/**
 * TrigScript 4, B5: what only one computer knows. `local.camera`, `local.mouse` and `local.player` are read as any cell
 * is; the compiler keeps them away from whatever changes the game (`compiler/local.ts`), and `sync()` sends one player's
 * value to every computer (MSQC's `val`).
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { inputPlugins } from "../compiler/input";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (main: string, file = "main.ts"): CompileResult => compileScript(ts, { [file]: main }, NAMES, { lib: LIB });
const compile = (main: string, file?: string): CompileResult => { const r = raw(main, file); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const messages = (main: string): string[] => raw(main).diagnostics.map((d) => d.message);
/** The one message, which says what it is about and why it is refused. */
const refused = (main: string, ...words: string[]) => {
  const m = messages(main);
  expect(m).toHaveLength(1);
  for (const w of words) expect(m[0]).toContain(w);
};
const printed = (s: ProgramSimulation): string[] => s.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.frame}:${e.text}`);
const sim = (r: CompileResult, players = [0]) => new ProgramSimulation(r.ir, { strings: r.strings, players });
/** A base: a Command Center (106) and two Marines (0) of Player 1's. */
const base = (r: CompileResult) => new ProgramSimulation(r.ir, { strings: r.strings, players: [0], units: [
  { type: 106, owner: 0, x: 200, y: 200, hp: 1500 }, { type: 0, owner: 0, x: 100, y: 100, hp: 40 }, { type: 0, owner: 0, x: 120, y: 100, hp: 31 },
] });

describe("local values: read", () => {
  it("the camera, the mouse on the screen and the player at this computer", () => {
    const r = compile(`program(() => { print(\`\${local.player} \${local.camera.x},\${local.camera.y} \${local.mouse.x},\${local.mouse.y}\`); });`);
    const s = sim(r).moveCamera(320, 640).moveMouse(400, 700).run(1);
    expect(printed(s)).toEqual(["1:0 320,640 80,60"]);
  });
  it("are cells of the game's memory, at the addresses Remastered's emulator gives them", () => {
    const r = compile(`program(() => { const a = local.camera.x; const b = local.mouse.y; print(\`\${a} \${b}\`); });`);
    const cells = JSON.stringify(r.ir[0]).match(/"base":\d+/g);
    expect(cells).toEqual([`"base":${0x62848c}`, `"base":${0x6cddc8}`]);
  });
  it("are no value when the script is built", () => {
    expect(messages(`const x = local.camera.x + 1; program(() => { print(\`\${x}\`); });`).join(" ")).toContain("local.camera.x");
  });
  it("cannot be written", () => {
    expect(messages(`program(() => { local.camera.x = 5; });`).join(" ")).toContain("read-only");
  });
});

describe("local values: may be shown", () => {
  it("in a print, under a test of one, through variables and functions", () => {
    compile(`program(() => {
      const shown = (v: number) => v * 2;
      let far = local.mouse.x > 400;
      if (far) print(\`far: \${shown(local.mouse.x)}\`); else displayText("near");
      while (local.camera.x > 1000) { print("right"); break; }
      switch (local.player) { case 0: print("one"); break; default: print("someone"); }
    });`);
  });
  it("on the camera and in a sound", () => {
    compile(`program(() => { if (local.camera.y > 2000) { centerView(locations.Anywhere); minimapPing(locations.Anywhere); } });`);
  });
  it("in ui.lines", () => {
    compile(`program(async () => { ui.lines(P1, () => <line>camera {local.camera.x}, mouse {local.mouse.x}</line>); });`, "main.tsx");
  });
});

describe("local values: may not change the game", () => {
  it("an action given one", () => refused(`program(() => { setResources(P1, "add", local.camera.x, "ore"); });`, "setResources()", "local.camera.x", "sync("));
  it("an action under a test of one", () => refused(`program(() => { if (local.player == 0) createUnit(P1, units.TerranMarine, 1, locations.Anywhere); });`, "createUnit()", "under a test of local.player"));
  it("through a variable, named with where it came from", () => refused(`program(() => { let n = 0; if (local.mouse.x > 100) n = 1; if (n == 1) killUnit(P1, units.TerranMarine); });`, "killUnit()", "n (from local.mouse.x)"));
  it("through an array", () => refused(`program(() => { const xs: number[] = []; xs.push(local.camera.x); setResources(P1, "add", xs[0], "ore"); });`, "xs (from local.camera.x)"));
  it("through what a function returns", () => refused(`program(() => { function f(v: number) { return v * 2; } const k = f(local.camera.x); setResources(P1, "add", k, "ore"); });`, "k (from local.camera.x)"));
  it("in a function called under a test of one", () => refused(`program(() => { function g() { createUnit(P1, units.TerranMarine, 1, locations.Anywhere); } if (local.player == 0) g(); });`, "createUnit()", "local.player"));
  it("in a called function that is given one", () => refused(`program(() => { function give(n: number) { setResources(P1, "add", n, "ore"); } give(1); give(local.mouse.y); });`, "setResources()", "n (from local.mouse.y)"));
  it("a location moved", () => refused(`program(() => { centerLocation(1 as Location, local.camera.x, local.camera.y); });`, "Moving a location"));
  it("a table of the game written", () => refused(`program(() => { stats(units.TerranMarine).minerals = local.mouse.x; });`, "Writing the game's tables"));
  it("a unit changed", () => refused(`program(() => { const u = first({ owner: P1 }); if (u) u.hp = local.mouse.x; });`, "Changing a unit"));
  it("waiting under a test of one", () => refused(`program(() => { if (local.camera.x > 10) sleep(frames(4)); });`, "Waiting", "different frame"));
  it("what is left of a loop some computers leave early under a test of one", () => {
    refused(`program(() => { while (true) { if (local.camera.x > 10) break; sleep(frames(1)); } });`, "Waiting", "a break or continue under that test leaves this loop");
    refused(`program(() => { for (let i = 0; i < 9; i++) { if (local.mouse.x < i * 50) continue; createUnit(P1, units.TerranMarine, 1, 1 as Location); } });`, "createUnit()", "leaves this loop");
    compile(`program(() => { for (let i = 0; i < 9; i++) { if (local.mouse.x < i * 50) break; print(\`\${i}\`); } createUnit(P1, units.TerranMarine, 1, 1 as Location); });`);
  });
  it("what is left of a function some computers return from early", () => {
    refused(`program(() => { function f() { if (local.mouse.x > 5) return; createUnit(P1, units.TerranMarine, 1, 1 as Location); } f(); });`, "createUnit()", "a return under that test leaves this function");
    refused(`program(() => { function f() { if (local.mouse.x > 5) return 1; return 2; } setResources(P1, "add", f(), "ore"); });`, "setResources()", "f()");
  });
  it("a random number drawn under a test of one, or only when one says so", () => {
    refused(`program(() => { if (local.camera.x > 3) { const r = random(6); print(\`\${r}\`); } });`, "A random number");
    refused(`program(() => { if (local.camera.x > 3 && random()) print("hi"); });`, "A random number");
  });
  it("a task started under a test of one", () => refused(`program(async () => { async function t() { await sleep(frames(2)); } if (local.player == 1) start(t()); });`, "Starting a task"));
  it("a memory() condition on a local address is one", () => refused(`program(async () => { while (true) { if (memory(0x62848c, 0, 1000)) setDeaths(P1, units.TerranCivilian, "set", 1); await sleep(frames(1)); } });`, "setDeaths()", "memory(0x62848C, …), the camera"));
  it("a random number beside one is fine, as is one that is only shown", () => {
    compile(`program(() => { const r = random(6); print(\`\${r} \${local.camera.x}\`); });`);
  });
});

describe("sync()", () => {
  const SYNCED = `program(async () => {
    const x = await sync(P1, local.camera.x + 100);
    centerLocation(1 as Location, x, 64);
    setResources(P1, "set", x, "ore");
    print(\`synced \${x}\`);
  });`;
  it("sends the player's value to every computer, and what arrives may change the game", () => {
    const r = compile(SYNCED);
    const s = sim(r).moveCamera(500, 0).run(4);
    expect(printed(s)).toEqual(["2:synced 600"]);
    expect(s.events.some((e) => e.action.type === ActionType.SetResources)).toBe(true);
  });
  it("is MSQC's val, a slot of its own for each sync() in the build", () => {
    const r = compile(`program(async () => { const a = await sync(P1, local.camera.x); print(\`\${a}\`); });
      program(async () => { const b = await sync(P2, local.mouse.y); const c = await sync(P1, local.mouse.x); print(\`\${b} \${c}\`); });`);
    expect(r.input?.syncs).toBe(3);
    const msqc = inputPlugins(r.input!).after.MSQC;
    expect(msqc["tsin_sync2.AtLeast(1); val, tsin_sync2"]).toBe("tsin_sync2_in");
    const slots = JSON.stringify(r.ir).match(/"kind":"syncSend","slot":\d/g);
    expect(slots).toEqual(['"kind":"syncSend","slot":0', '"kind":"syncSend","slot":1', '"kind":"syncSend","slot":2']);
  });
  it("of several values sends them on the same frame, and gives one for each", () => {
    const r = compile(`program(async () => {
      const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y);
      print(\`at \${x},\${y}\`);
    });`);
    expect(r.input?.syncs).toBe(2);
    // Both sends are one after the other in the program, before its wait.
    const kinds = r.ir[0].body.map((s) => s.kind);
    expect(kinds.slice(0, 2)).toEqual(["syncSend", "syncSend"]);
    const s = sim(r).moveCamera(100, 200).moveMouse(150, 260).run(4);
    expect(printed(s)).toEqual(["2:at 150,260"]);
  });
  it("of several values gives them apart where it is awaited", () => {
    expect(messages(`program(async () => { const x = await sync(P1, 1, 2); print(\`\${x}\`); });`).join(" ")).toContain("take them apart");
  });
  it("from a player who is no person gives 0 at once", () => {
    const r = compile(`program(async () => { const x = await sync(P2, local.camera.x + 7); print(\`got \${x}\`); });`);
    expect(printed(sim(r).run(2))).toEqual(["1:got 0"]);
  });
  it("is awaited where it is assigned, in an async program", () => {
    expect(messages(`program(async () => { sync(P1, local.camera.x); });`).join(" ")).toContain("await");
    expect(messages(`program(async () => { if ((await sync(P1, 1)) > 0) print("x"); });`).join(" ")).toContain("where it is awaited");
    expect(messages(`program(() => { const x = sync(P1, 1); });`).join(" ")).toContain("await");
  });
  it("cannot be reached on some computers only", () => {
    expect(messages(`program(async () => { if (local.player == 0) { const x = await sync(P1, 1); print(\`\${x}\`); } });`).join(" ")).toContain("sync() under a test of local.player");
  });
  it("takes one player, known when the script is built", () => {
    expect(messages(`program(async () => { const x = await sync(AllPlayers, 1); print(\`\${x}\`); });`).join(" ")).toContain("P1 … P8, or CurrentPlayer");
  });
});

describe("the selection", () => {
  it("local.selected is the unit this computer has selected, and local.selectionCount how many", () => {
    const r = compile(`program(() => { const u = local.selected; if (u) print(\`\${u.type} \${u.hp} of \${local.selectionCount}\`); else print("none"); });`);
    const s = base(r);
    s.selectUnits(s.game.matching(undefined, 0)).run(1);
    expect(printed(s)).toEqual(["1:0 40 of 2"]);
    expect(printed(base(r).run(1))).toEqual(["1:none"]);
  });
  it("is a Local value: an order to it is refused, select() of it is not", () => {
    refused(`program(() => { const u = local.selected; if (u) u.kill(); });`, "This order to a unit", "local.selected");
    compile(`program(() => { const u = local.selected; if (u) select(P1, u); });`);
  });
  it("select() makes what the player has selected, a unit or a list", () => {
    const r = compile(`program(async () => {
      const cc = first({ owner: P1, type: units.TerranCommandCenter });
      if (cc) select(P1, cc);
      await sleep(frames(1));
      let u = local.selected;
      if (u) print(\`\${u.type} of \${local.selectionCount}\`);
      const m = first({ owner: P1, type: units.TerranMarine });
      if (m) if (cc) select(P1, [m, cc]);
      await sleep(frames(1));
      u = local.selected;
      if (u) print(\`\${u.type} of \${local.selectionCount}\`);
    });`);
    expect(printed(base(r).run(4))).toEqual(["2:106 of 1", "3:0 of 2"]);
  });
  it("under a test of a Local value, as it travels as a command", () => {
    compile(`program(() => { const m = first({ owner: P1, type: units.TerranMarine }); if (local.mouse.x > 300) if (m) select(P1, m); });`);
  });
  it("takes one to twelve units, written out", () => {
    expect(messages(`program(() => { select(P1, []); });`).join(" ")).toContain("one to twelve");
  });
});
