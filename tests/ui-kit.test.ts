/**
 * The standard library's "trigscript/ui" (TrigScript 4): components for the text lines (a meter, a panel, a menu's
 * lines, a dialog, a log), what changes the state they show (choose, say, typewriter, log) and the formatting helpers.
 * Run in the simulator, keys pressed as a player would.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (source: string): CompileResult => {
  const r = compileScript(ts, { "main.tsx": source }, NAMES, { lib: LIB });
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  return r;
};
const sim = (r: CompileResult) => new ProgramSimulation(r.ir, { strings: r.strings, players: [0] });
const printed = (s: ProgramSimulation): string[] => s.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => (e.text ?? "").replace(/[\x01-\x08\x0e-\x1f]/g, ""));

describe("trigscript/ui", () => {
  it("a panel with a meter, a menu's lines, a dialog and a log, in one text", () => {
    const r = compile(`
      import { Meter, Panel, MenuList, DialogBox, LogLines, log, clock, thousands } from "trigscript/ui";
      const ITEMS = ["Marine (50)", "Medic (75)", "Leave"];
      program(async () => {
        let hp = 900;
        const shop = { selected: 1, open: true };
        const talk = { speaker: "Raynor", text: "Hold on", open: true };
        const lines: string[] = [];
        log(lines, \`wave \${hp / 300}\`);
        log(lines, "boss");
        print(<><Panel title={\`Wave 3 \${clock(hp * 3)}\`}><Meter label="Base" value={hp} max={1500} /></Panel>{shop.open && <MenuList items={ITEMS} selected={shop.selected} />}<DialogBox box={talk} /><LogLines lines={lines} /><line>{thousands(hp * 1371)}</line></>);
      });`);
    expect(printed(sim(r).run(1))).toEqual(["-- Wave 3 1:52 --\nBase ■■■■■■□□□□ 900/1500\n  Marine (50)\n> Medic (75)\n  Leave\nRaynor\nHold on\n(Space)\nwave 3\nboss\n1,233,900"]);
  });

  it("the meter's colour: green above half, yellow above a quarter, red below (the simulator's log keeps the words; the colour is the IR's)", () => {
    const r = compile(`
      import { Meter } from "trigscript/ui";
      program(async () => { let k = 80; print(<Meter label="x" value={k} max={100} width={4} />); });`);
    expect(sim(r).run(1).events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => (e.text ?? "").replace(/[\x01-\x08\x0e-\x1f]/g, ""))).toEqual(["x ■■■□ 80/100"]);
    // The bar's colour, worked out in the game: a variable whose value is green, yellow or red by the share.
    const consts: number[] = [];
    const find = (o: unknown, inside: boolean): void => {
      if (Array.isArray(o)) { o.forEach((x) => find(x, inside)); return; }
      if (!o || typeof o !== "object") return;
      const r = o as Record<string, unknown>;
      const here = inside || (r.kind === "declare" && (r.decl as { name?: string })?.name === "(colour)");
      if (here && r.kind === "const" && typeof r.value === "number") consts.push(r.value);
      for (const v of Object.values(r)) find(v, here);
    };
    find(r.ir, false);
    expect(consts).toEqual(expect.arrayContaining([7, 3, 8]));
  });

  it("a log keeps the last lines it was given", () => {
    const r = compile(`
      import { log, LogLines } from "trigscript/ui";
      program(async () => { const lines: string[] = []; let k = 0; while (k < 9) { log(lines, \`line \${k}\`, 3); k++; } print(<LogLines lines={lines} />); });`);
    expect(printed(sim(r).run(1))).toEqual(["line 6\nline 7\nline 8"]);
  });

  it("choose: W / Up and S / Down move the mark, round from the end, and Space chooses (Enter opens the chat)", () => {
    const r = compile(`
      import { choose } from "trigscript/ui";
      program(async () => {
        const shop = { selected: 0, open: false };
        const pick = await choose(P1, 3, shop);
        print(\`picked \${pick} \${shop.open ? "open" : "closed"}\`);
      });`);
    const s = sim(r).run(3);
    // A key pressed on frames one after another is one press held, as the game's input has it: a few frames apart.
    s.press("W", 0).run(3).press("Up", 0).run(3).press("S", 0).run(3);
    expect(printed(s)).toEqual([]);
    s.press("Enter", 0).run(2);
    expect(printed(s)).toEqual([]);
    s.press("Space", 0).run(2);
    expect(printed(s)).toEqual(["picked 2 closed"]);
  });

  it("say: the words typed in a character at a time, closed when the player presses Space", () => {
    const r = compile(`
      import { say } from "trigscript/ui";
      program(async () => {
        const talk = { speaker: "", text: "", open: false };
        async function watch() { while (true) { if (talk.open) print(\`\${talk.speaker}: \${talk.text}\`); await nextFrame(); } }
        start(watch());
        await say(P1, talk, "Raynor", "Hi!");
        print("done");
      });`);
    const s = sim(r).run(12);
    const shown = printed(s);
    expect(shown).toContain("Raynor: H");
    expect(shown).toContain("Raynor: Hi!");
    expect(shown).not.toContain("done");
    s.press("Space", 0).run(2);
    expect(printed(s).at(-1)).toBe("done");
  });
});
