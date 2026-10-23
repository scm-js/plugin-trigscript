/**
 * The TrigScript workspace: Monaco over the map's script files, checked live against
 * declarations generated from the map (`compiler/declarations.ts`) and compiled — run —
 * in the worker (`compile.ts`). Apply writes the script's `trigger()` records into the
 * trigger list as its block (`service.ts`); saving or testing the map does the same by
 * itself, and that is also when the programs are built — into the file, by the eudplib
 * plugin. Play does both and hands the result to Test Map.
 *
 * It is laid out as VS Code is (`shell.ts`): the files in an Explorer with the programs
 * and their variables under them, tabs over the editor with the run controls at their
 * right, Problems / Output / Simulate as views of a panel under it, the state of the
 * script in a status bar, and what needs an answer as a notification in the corner.
 * Every command is also in Monaco's command palette (F1) with VS Code's own keys where
 * it has one: F5 tests, Ctrl+Shift+B applies, Ctrl+J is the panel, Ctrl+B the Explorer.
 * Nothing that appears moves the text.
 *
 * It opens two ways. As a full-screen dialog, for a long session on the script; or
 * *beside the map*, as a resizable panel that blocks nothing, so the map and the code
 * are worked on together: Ctrl+click on `locations.Beacon` shows the location, *Pick
 * from map* puts the name of a clicked location or unit at the cursor, and a location
 * the map renames offers to update the references. The same workspace mounts in either;
 * a button switches.
 *
 * The files are the map's: every edit is written straight into the archive (they are
 * members of the .scx, like a WAV), so closing loses nothing — only applying changes
 * triggers. `main.ts` is where the script starts and cannot be renamed or removed.
 * Monaco and TypeScript come from the CDN on first open.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { CompileSuperseded, allowlistUrl, gametestUrl, retainCompileWorker } from "./compile";
import type { Allowlist } from "./compiler/allowlist";
import { addressOfEudError, findEudError, type EudErrorAnswer } from "./compiler/eudError";
import type { GameTestReport } from "./compiler/gameTests";
import { ENTRY_FILE, normalizePath, type CompileResult, type LineHint, type ScriptDiagnostic, type ScriptFiles, type TriggerSource } from "./compiler/compiler";
import { CELL_HEAP_MOST, HEAP_CELLS, HEAP_CELLS_MAX, HEAP_CELLS_MIN, STACK_CELLS_MAX, STACK_DEPTH, STACK_DEPTH_MAX, STACK_DEPTH_MIN, heapCells, stackDepth } from "./compiler/ir";
import { largestFrame } from "./compiler/recursion";
import { entryFor } from "./compiler/names";
import { printScript } from "./compiler/print";
import { Simulation, type SimulationEvent } from "./compiler/simulate";
import { actionDef } from "./vendor/triggerDefs";
import { PlayerGroup } from "./vendor/triggers";
import {
  BUILD_TIME_CLASS, TEST_MARK_CLASS, createScriptEditor, loadMonaco, refreshLineHints, releaseScriptEditor, setCompilerMarkers, setLineHints, setDeclarations, setHoverVariables, setMapRefs, setMonacoTranslator,
  type LocationRef, type MonacoApi, type ScriptEditor, type ScriptWarning,
} from "./monaco";
import { renamedKeys, renamesInUse, replaceReferences, type Renamed } from "./refs";
import { FILE_NAME } from "./script";
import { isMachineLine, readTriggerMap, readVariableMap } from "./compiler/gameVariables";
import { mergeCopies } from "./compiler/gameCopies";
import { costByLine, shortCount, shortMs, type TestCost } from "./compiler/gameCost";
import { MOST_MS, SMOOTH_MS } from "./compiler/remasteredCost";
import { isTestFile, type TestInfo, type TestReport, type TestResult, type TestRunOptions } from "./compiler/testing";
import { countTests, foldPlayers, idsUnder, marksOf, mergeReport, NO_TESTS, notesOf, playersLabel, stateOf, stateOfCounts, summary, testTree, warningsOf, type TestNode, type TestState, type TestStateName } from "./testState";
import { testName } from "./service";
import { applyMoves, buildTree, filesUnder, folderOf, movesOf, refuseMoves, tabLabels, validFolder, type Moves, type TreeNode } from "./tree";
import { ProgramSimulation, type ProgramEvent, type ProgramSimulationOptions, type SimBounds, type SimUnitInit } from "./compiler/simulateIr";
import { positionIn, type BuildRefusal, type MapNames, type ScriptArtifact, type ScriptService } from "./service";
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, SHELL_STYLE, createShell, type IconName, type ShellLayout } from "./shell";
import { DEBUG_STYLE, Debugger, type DebugGameView } from "./debugger";
import type { DebugRecording } from "./compiler/gameDebug";
import type { ScmSimDebugView } from "./vendor/scmSim";
import type { EudplibBuildEvent, EudplibService } from "./vendor/eudplib";
import type { Translate } from "./i18n";
import { describeMedia, isImageFile, isMediaFile, isNotesFile, isSoundFile } from "./compiler/media";
import { importMedia, showImage, showVideo } from "./videoImport";
import { isSoundSource, showSound } from "./soundImport";
import { isMidiSource, showNotes } from "./notesImport";

export const TEMPLATE = `// TrigScript: ordinary TypeScript that runs when you build. Every trigger() call becomes
// one trigger of the map, in order; code inside program(() => { … }) runs in the game.
// Names come from the map: units.*, locations.*, switches.*, players.*, P1 … P12.
import { trigger, program, bring, displayText, preserve, units, locations, P1, AllPlayers, CurrentPlayer } from "trigscript";

trigger(AllPlayers, [
  bring(CurrentPlayer, units.AnyUnit, locations.Anywhere, ">=", 1),
], [
  displayText("Hello from TrigScript."),
  preserve(),
]);

// A program is code that runs in the game: variables, if, while, for, functions.
// It runs every frame from where it left off, until it sleeps. The underlined parts
// are computed when the script is applied, everything else runs in the game.
//
// A map with a program is built by TrigScript itself when you save it, and needs
// StarCraft: Remastered to play. trigger() alone plays on every version.
//
// program(() => {
//   let elapsed = 0;
//   while (true) {
//     elapsed++;
//     if (elapsed == 10) displayText("Ten seconds have passed.");
//     sleep(seconds(1));
//   }
// }, { owner: P1 });
`;

/** What a new file starts with. */
export const FILE_TEMPLATE = `import { trigger, units, locations, P1 } from "trigscript";

// Helpers this file exports are imported by main.ts: import { … } from "./name";
`;

/** What a new test file starts with: one test, which passes. */
export const TEST_TEMPLATE = `import { test, expect, units, locations, P1 } from "trigscript";

// A test runs here, in the simulator, after every change that compiles: never in the game, and it costs the map nothing.
// sim is a world of its own for each test: the map's placed units and locations, and the script's programs at frame 0.
test("the script runs for a second", (sim) => {
  sim.seconds(1);
  expect(sim.frame).toBe(24);
});
`;

/** Frames the Simulate button runs. */
/** Twenty seconds of the game at Fastest. */
export const SIMULATE_FRAMES = 480;
/** Start Location: a marker of the map, not a unit of the game. */
const START_LOCATION_UNIT = 214;
/** OWNR: the slots that are in a game. */
const OWNER_COMPUTER = 5;
const OWNER_HUMAN = 6;
/** How many of a simulation's events the list shows before it says how many more there were. */
const SIMULATE_ROWS = 200;
/** A build's log as a person reads it: without the lines the lowering says for a run in the lifted game. */
const withoutMachineLines = (text: string) => text.split("\n").filter((l) => !isMachineLine(l)).join("\n");
/** The most lines with a fault the Simulate view lists. */
const SIMULATE_FAULTS = 20;

const CHECK_DELAY_MS = 350;
/** Lines the Output view keeps. */
const OUTPUT_LINES = 2000;
/** How long a good outcome stays in the status bar, and an answer in the corner. */
const STATUS_MS = 10_000;
const NOTICE_MS = 8_000;
/** When running every test takes longer than this, only the open file's run by themselves after a compile. */
const TESTS_SLOW_MS = 2_000;
/**
 * What Remastered was seen to run in a frame with no effect: the dial (probes/frame-cost.ts, played 2026-10-16) ran
 * 500 thousand conditions and actions a frame with none; from a million the screen flickers, enough to distract,
 * and at 5 million the game slows. That was a fast computer (Ryzen 9 7900X): a slower one reaches each sooner.
 */
const COST_SEEN = 500_000;
/** A line that ran this many conditions and actions in one frame of a test in the game says so beside it: 2% of COST_SEEN. */
const COST_HINT = 10_000;
/**
 * Where the host weighs (cost step 1), a line that took this many milliseconds of Remastered's in one frame says so
 * instead: 2% of SMOOTH_MS, the trigger work a frame took with no flicker seen (probes/frame-weights, 2026-10-18).
 */
const COST_HINT_MS = 0.3;
/** Frames the map is played with nobody at it when an EUD error is looked up, before the tests: two minutes of game time at Fastest. */
const EUD_TRACE_FRAMES = 3_000;
/** The costliest lines a test's results name. */
const COST_LINES = 3;
/** The key the shortcuts are written with. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

/** The panel beside the map starts this big; the user resizes it and the size is kept for the session. */
export const PANEL_WIDTH = 760;
export const PANEL_HEIGHT = 540;

const STYLE = `${SHELL_STYLE}
.tsd .tsd-settings { box-sizing: border-box; height: 100%; overflow: auto; padding: 8px 20px 12px; font-size: var(--fs-md); }
.tsd .tsd-settings > * { max-width: 680px; }
.tsd .tsd-settings h4 { margin: 0 0 4px; font-size: var(--fs-md); font-weight: 600; }
.tsd .tsd-settings p { margin: 0 0 8px; color: var(--text-dim); line-height: 1.45; }
.tsd .tsd-settings .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.tsd .tsd-settings input { width: 110px; padding: 2px 6px; font: inherit; font-family: var(--font-mono); color: var(--text); background: var(--bg-1); border: 1px solid var(--border); border-radius: 2px; }
.tsd .tsd-settings input:focus { outline: 1px solid var(--teal); outline-offset: -1px; }
.tsd .tsd-settings button { padding: 2px 8px; font: inherit; color: var(--text); background: var(--bg-3); border: 1px solid var(--border); border-radius: 2px; cursor: pointer; }
.tsd .tsd-settings button:disabled { opacity: 0.5; cursor: default; }
.tsd .tsd-settings .now { color: var(--text-faint); }
.tsd .tsd-list { margin: 0; padding: 2px 0; list-style: none; font-size: var(--fs-md); }
.tsd .tsd-list li { display: flex; align-items: baseline; gap: 8px; padding: 2px 12px 2px 20px; line-height: 18px; cursor: pointer; }
.tsd .tsd-list li:hover { background: var(--bg-3); }
.tsd .tsd-list li.tsd-plain { cursor: default; }
.tsd .tsd-list .tsd-i { align-self: center; font-size: 14px; color: var(--danger); }
.tsd .tsd-list .msg { flex: 0 1 auto; min-width: 0; white-space: pre-wrap; }
.tsd .tsd-list .src, .tsd .tsd-list .where { flex: none; color: var(--text-faint); font-size: var(--fs-sm); }
.tsd .tsd-list .frame { flex: none; min-width: 72px; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-sm); }
.tsd .tsd-list .note { color: var(--text-dim); }
.tsd .tsd-output { margin: 0; padding: 4px 20px; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 17px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
.tsd .tsd-list li.tsd-warning .tsd-i { color: var(--warn); }
.tsd .tsd-rows .tsd-empty { padding: 6px 12px 6px 20px; color: var(--text-faint); white-space: normal; line-height: 1.45; cursor: default; }
.tsd .tsd-test-passed, .tsd .tsd-list .tsd-i.tsd-test-passed { color: var(--ok); }
.tsd .tsd-test-failed { color: var(--danger); }
.tsd .tsd-test-none, .tsd .tsd-test-skipped, .tsd .tsd-list .tsd-i.tsd-test-none, .tsd .tsd-list .tsd-i.tsd-test-skipped { color: var(--text-faint); }
.${TEST_MARK_CLASS} { cursor: pointer; font: normal normal normal 14px/18px codicon; text-align: center; color: var(--text-faint); }
.${TEST_MARK_CLASS}::before { content: "\\eabc"; }
.${TEST_MARK_CLASS}-passed { color: var(--ok); }
.${TEST_MARK_CLASS}-passed::before { content: "\\eba4"; }
.${TEST_MARK_CLASS}-failed { color: var(--danger); }
.${TEST_MARK_CLASS}-failed::before { content: "\\ea87"; }
.${TEST_MARK_CLASS}-skipped::before { content: "\\eabd"; }
.${TEST_MARK_CLASS}-note { color: var(--danger); font-style: italic; opacity: 0.9; }
.tsd .tsd-list li.tsd-cost { align-items: center; }
.tsd .tsd-cost-graph { flex: 1 1 auto; min-width: 0; max-width: 480px; height: 36px; }
.tsd .tsd-cost-graph path { fill: var(--teal); fill-opacity: 0.35; stroke: var(--teal); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.${BUILD_TIME_CLASS} { text-decoration: underline dotted rgba(153, 162, 179, 0.55); text-underline-offset: 3px; }
${DEBUG_STYLE}`;

/** "P1", "all players", "Force 2", "P1, P2" — who a program runs for. */
function ownerLabel(p: { owners: number[] }, t: Translate): string {
  return p.owners.map((o) => (o === PlayerGroup.AllPlayers ? t("all players") : o >= PlayerGroup.Force1 && o <= PlayerGroup.Force4 ? t("Force {n}", { n: o - PlayerGroup.Force1 + 1 }) : `P${o + 1}`)).join(", ");
}

/** One line of the simulation log: "Display Text — hello". */
function describeEvent(e: SimulationEvent | ProgramEvent): string {
  const name = actionDef(e.action.type)?.name ?? `Action ${e.action.type}`;
  return e.text !== undefined ? `${name} — ${e.text}` : name;
}


/** How the workspace is shown: a full-screen dialog, or a resizable panel beside the map. */
export type WorkspaceMode = "dialog" | "panel";

export interface OpenOptions {
  file?: string;
  line?: number;
  /** Beside the map (a panel) rather than in a dialog. Unset: however it is open already, else a dialog. */
  dock?: boolean;
  /** Start a Pick from map as soon as the editor is up. */
  pick?: boolean;
}

interface OpenWorkspace {
  mode: WorkspaceMode;
  isOpen(): boolean;
  close(): void;
  reveal(file?: string, line?: number): void;
  /** The file and line the cursor is on, to carry across a mode switch. */
  cursor(): { file: string; line: number } | null;
}

let current: OpenWorkspace | null = null;

/** The editor's language changed: the open workspace is built again in it, in the same place and at the same line. */
export function relabelScriptEditor(svc: ScriptService): void {
  if (!current?.isOpen()) return;
  const at = current.cursor();
  const dock = current.mode === "panel";
  current.close();
  current = null;
  openScriptEditor(svc, { dock, file: at?.file, line: at?.line });
}

/** Open the workspace (or bring the open one to the file and line, or move it to the other mode when `dock` says so). */
export function openScriptEditor(svc: ScriptService, options: OpenOptions = {}): void {
  const api = svc.api;
  if (current?.isOpen()) {
    const wanted: WorkspaceMode | null = options.dock === undefined ? null : options.dock ? "panel" : "dialog";
    if ((!wanted || wanted === current.mode) && !options.pick) { current.reveal(options.file, options.line); return; }
    const at = current.cursor();
    const modeNow = current.mode;
    current.close();
    current = null;
    if (options.file === undefined && at) options = { ...options, file: at.file, line: at.line };
    if (options.dock === undefined) options = { ...options, dock: modeNow === "panel" };
  }
  if (!api.document.isOpen()) { api.ui.toast({ kind: "info", title: api.i18n.t("Open or create a map first.") }); return; }
  const mode: WorkspaceMode = options.dock ? "panel" : "dialog";
  const ws = createWorkspace(svc, options, mode);
  if (mode === "dialog") {
    const handle = api.ui.dialog({
      title: "TrigScript",
      size: "full",
      tall: true,
      // The workspace is the whole dialog, edge to edge, with its own status bar for a footer.
      flush: true,
      buttons: [],
      // Escape inside the workspace dismisses its own popups (suggestions, a menu, the palette); it must not close the dialog.
      keepOpenOnEscape: (target) => target instanceof Node && ws.root.contains(target),
      mount(body, dialog) {
        body.append(ws.root);
        return ws.attach(() => dialog.close());
      },
    });
    current = { mode, isOpen: () => handle.isOpen(), close: () => handle.close(), reveal: ws.reveal, cursor: ws.cursor };
  } else {
    const handle = api.ui.panel({
      title: "TrigScript",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      resizable: true,
      flush: true,
      mount(body, panel) {
        body.append(ws.root);
        return ws.attach(() => panel.close());
      },
    });
    current = { mode, isOpen: () => handle.isOpen(), close: () => handle.close(), reveal: ws.reveal, cursor: ws.cursor };
  }
}

interface Workspace {
  root: HTMLElement;
  /** Subscribe, load Monaco, and hand back the cleanup; `close` shuts the shell (the map went away). */
  attach(close: () => void): () => void;
  reveal(file?: string, line?: number): void;
  cursor(): { file: string; line: number } | null;
}

function createWorkspace(svc: ScriptService, options: OpenOptions, mode: WorkspaceMode): Workspace {
  const api: PluginApi = svc.api;
  const el = api.ui.el;
  const w = api.ui.widgets;
  const t: Translate = (text, params) => api.i18n.t(text, params);
  setMonacoTranslator(t);

  const initial = svc.state();
  let files: ScriptFiles = initial?.files ?? { [ENTRY_FILE]: TEMPLATE };
  const fresh = !initial?.files;
  let generated: MapNames | null = svc.names();
  let editor: ScriptEditor | null = null;
  let monaco: MonacoApi | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;
  /** Monaco could not be loaded: there is nothing to wait for. */
  let failed = false;
  let building = false;
  let picking = false;
  let diagnostics: ScriptDiagnostic[] = [];
  let result: CompileResult | null = null;
  let simulation: { sim: Simulation; programs: ProgramSimulation | null; result: CompileResult } | null = null;
  /** The programs and variables of the last compile that went through: a typo does not empty the Explorer. */
  let outline: Pick<CompileResult, "programs" | "variables"> | null = null;
  /** The eudplib plugin's service, followed while the workspace is open. */
  let library: EudplibService | null = svc.library();
  /** Play is under way: the script applied, the map built as Save would, handed to Test Map. */
  let testing = false;
  let cancelled = false;
  /** Renames the map made to things the script names, waiting for the user's word. */
  let renames: { object: string; list: Renamed[] }[] = [];
  /** With a stale block that can be taken apart: the user chose to append a fresh block instead of replacing what is still the build's. */
  let appendInstead = false;

  /* ── The frame ── */
  const layoutKey = mode === "panel" ? "layout.panel" : "layout.dialog";
  const shell = createShell({
    el,
    compact: mode === "panel",
    layout: { ...(mode === "panel" ? COMPACT_LAYOUT : DEFAULT_LAYOUT), ...api.storage.get<Partial<ShellLayout>>(layoutKey, {}) },
    onLayout: (layout) => { api.storage.set(layoutKey, layout); },
    onTabSelect: (id) => openFile(id),
    onTabClose: (id) => closeTab(id),
    t,
  });
  const root = shell.root;
  root.prepend(el("style", undefined, STYLE));
  const hostEl = shell.editorHost;

  // "Test" is what the script's test() blocks are; building the map and starting it in the game is Play.
  const testAction = shell.action({ icon: "play", title: t("Play (F5): apply the script, build the map as Save would and start it in the game through Test Map"), run: () => { void test(); } });
  const simulateAction = shell.action({ icon: "beaker", title: t("Simulate ({mod}+F5): run the script's triggers and programs for {frames} frames ({seconds} seconds of the game) in a built-in interpreter and list what happened", { mod: MOD, frames: SIMULATE_FRAMES, seconds: SIMULATE_FRAMES / 24 }), run: () => { void simulateNow(); } });
  const applyAction = shell.action({ icon: "check", title: t("Apply ({mod}+Shift+B): run the script and write its triggers into the map now. Saving and testing the map do this by themselves; programs are built into the saved file, not into the trigger list", { mod: MOD }), run: () => { void build(); } });
  const pickAction = shell.action({ icon: "target", title: t("Pick from map: click a location or a unit on the map to put its name at the cursor"), run: () => { void pickFromMap(); } });
  shell.action(mode === "dialog"
    ? { icon: "multiple-windows", title: t("Beside the map: open the script as a panel, so the map stays in reach"), run: () => switchMode() }
    : { icon: "screen-full", title: t("In a window: open the script full-screen"), run: () => switchMode() });
  const moreAction = shell.action({ icon: "ellipsis", title: t("More actions…"), run: () => shell.menu(moreAction.element, [
    menuItem("save"),
    null,
    ...["import", "newFile", "newFolder", "importVideo"].map(menuItem),
    null,
    ...["runTests", "runFailedTests", "runTestsInGame"].map(menuItem),
    null,
    menuItem("findEudError"),
    null,
    ...["problems", "output", "panel", "explorer", "testing"].map(menuItem),
    null,
    menuItem("settings"),
    null,
    { label: t("Command Palette…"), keys: "F1", disabled: !ready, run: () => palette() },
  ]) });

  const fileList = el("ul", { className: "tsd-rows" });
  shell.section({ title: t("Script"), actions: [
    { icon: "new-file", title: t("New file…: main.ts imports it with import { … } from \"./name\""), run: () => { void newFile(); } },
    { icon: "new-folder", title: t("New folder…: a folder is there while a file is in it, so its first file is asked for next"), run: () => { void newFolder(); } },
    { icon: "device-camera-video", title: t("Import Video…: a video, a picture, a sound or a MIDI file as a file of the script"), run: () => { void importVideo(); } },
  ] }).body.append(fileList);
  const programList = el("ul", { className: "tsd-rows" });
  const programsSection = shell.section({ title: t("Programs") });
  programsSection.body.append(programList);
  programsSection.setHidden(true);

  const problemsView = shell.view({ id: "problems", title: t("Problems") });
  const outputEl = el("pre", { className: "tsd-output" });
  const outputView = shell.view({ id: "output", title: t("Output"), onShow: () => renderOutput(true), actions: [{ icon: "clear-all", title: t("Clear the output"), run: () => { output = []; renderOutput(); } }] });
  const simulateView = shell.view({ id: "simulate", title: t("Simulate") });
  const resultsView = shell.view({ id: "tests", title: t("Test Results") });
  const settingsView = shell.view({ id: "settings", title: t("Settings"), onShow: () => renderSettings() });
  const testingList = el("ul", { className: "tsd-rows" });
  const testingView = shell.sidebarView({ id: "testing", title: t("Testing"), icon: "beaker", actions: [
    { icon: "run-all", title: t("Run all tests"), run: () => { void runTests(); } },
    { icon: "run-errors", title: t("Run the tests that failed"), run: () => { void runFailedTests(); } },
    { icon: "target", title: t("Run all tests in the game (the lifted game of the scm-sim plugin): each gets a second mark"), run: () => { void runTestsInGame(); } },
    { icon: "filter", title: t("Show only the tests that fail"), run: () => { onlyFailing = !onlyFailing; renderTesting(); } },
  ] });
  testingView.body.append(testingList);
  /** The debugger in the game (TrigScript 4, A5): the Debug view, its marks in the editor, its values beside the lines. */
  const debug = new Debugger({
    t, el, shell,
    reveal: (file, line) => { if (!editor) return; openFile(file); editor.editor.revealLineInCenterIfOutsideViewport(line); },
    changed: () => { editor?.setDebug(debug.marks()); refreshLineHints(); },
    setStatus: (kind, text, timeout) => setStatus(kind, text, timeout),
  });

  /**
   * The map's script settings (`script.ts#ScriptSettings`): kept in the map beside the script, because the built map
   * depends on them — how much memory the arrays that grow share, and how deep a function that calls itself may go.
   */
  function renderSettings() {
    const open = api.document.isOpen();
    const settings = svc.settings();
    const count = (n: number) => n.toLocaleString("en-US");
    const size = (cells: number) => (cells * 4 >= 1 << 20 ? `${(cells * 4 / (1 << 20)).toFixed(cells * 4 % (1 << 20) ? 1 : 0)} MB` : `${Math.round(cells * 4 / 1024)} KB`);
    /** One number of the settings: the field, what it comes to, and the way back to the default. */
    const row = (o: { key: "heapCells" | "stackDepth"; min: number; max: number; step: number; normal: number; fit: (v: unknown) => number; said: (now: number) => string }) => {
      const now = settings[o.key];
      const input = el("input", { type: "number", min: String(o.min), max: String(o.max), step: String(o.step), value: String(now), disabled: !open }) as HTMLInputElement;
      const reset = el("button", { type: "button", disabled: !open || now === o.normal }, t("Default ({n})", { n: count(o.normal) })) as HTMLButtonElement;
      const commit = (value: unknown) => {
        const next = o.fit(typeof value === "number" && Number.isFinite(value) ? value : o.normal);
        if (next !== svc.settings()[o.key]) { svc.writeSettings({ ...svc.settings(), [o.key]: next }); simulation = null; renderSimulation(); }
        renderSettings();
      };
      input.addEventListener("change", () => commit(input.value === "" ? o.normal : Number(input.value)));
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); });
      reset.addEventListener("click", () => commit(o.normal));
      return el("div", { className: "row" }, input, el("span", { className: "now" }, o.said(now)), reset);
    };
    const guardRow = () => {
      const box = el("input", { type: "checkbox", checked: settings.testsGuardBuild, disabled: !open }) as HTMLInputElement;
      box.style.width = "auto";
      box.addEventListener("change", () => { svc.writeSettings({ ...svc.settings(), testsGuardBuild: box.checked }); renderSettings(); });
      return el("label", { className: "row" }, box, el("span", {}, t("A failing test refuses the build")));
    };
    // What a call deep costs this script: the largest frame any of its functions keeps, as it was last compiled.
    const frame = result?.ok ? largestFrame(result.ir) : 0;
    const stack = (depth: number) => {
      if (!frame) return t("calls deep — no function of this script calls itself");
      const cells = frame * depth;
      return cells > STACK_CELLS_MAX
        ? t("calls deep — {frame} cells a call here, {size} while the map is played: more than the {max} a map may use, and it will not build", { frame, size: size(cells), max: size(STACK_CELLS_MAX) })
        : t("calls deep — {frame} cells a call here, {size} while the map is played", { frame, size: size(cells) });
    };
    settingsView.body.replaceChildren(el("div", { className: "tsd-settings" },
      el("h4", {}, t("Memory for arrays that grow")),
      el("p", {}, t("Arrays a program pushes to share one pool of cells; this is its size. A single array can reach between a quarter and a half of it. When the pool runs out, nothing more is pushed and the game says so once.")),
      row({ key: "heapCells", min: HEAP_CELLS_MIN, max: HEAP_CELLS_MAX, step: 1024, normal: HEAP_CELLS, fit: heapCells, said: (now) => t("cells — {size} while the map is played", { size: size(now <= CELL_HEAP_MOST ? now * 19 : now) }) }),
      el("p", {}, t("{min} to {max} cells. Up to {most}, a cell is 76 bytes while the map is played: four for texts, and 72 for the arrays' own cells, which a loop reads and writes in a few steps. Past that, arrays share the texts' four bytes and a read takes about three times as long. A larger pool does not slow the game and hardly grows the saved file. Kept in the map, so it builds the same on any computer.", { min: count(HEAP_CELLS_MIN), max: count(HEAP_CELLS_MAX), most: count(CELL_HEAP_MOST) })),
      el("h4", {}, t("Recursion depth")),
      el("p", {}, t("How many calls deep a function that calls itself may go. Around each such call the function's variables are kept on a stack, which is only in the built map when some function calls itself. A call past the limit stops the program, and the game says where; Simulate stops at the same call.")),
      row({ key: "stackDepth", min: STACK_DEPTH_MIN, max: STACK_DEPTH_MAX, step: 256, normal: STACK_DEPTH, fit: stackDepth, said: stack }),
      el("p", {}, t("{min} to {max} calls. The limit costs nothing until it is reached, but each call deep keeps and brings back every variable of its function, so thousands of calls within one frame make the game stutter. Kept in the map, like the pool above.", { min: count(STACK_DEPTH_MIN), max: count(STACK_DEPTH_MAX) })),
      el("h4", {}, t("Tests")),
      el("p", {}, t("The script's test() blocks run in the simulator after every compile that goes through. A failing test is a warning. With this on it also refuses the build: Save, Test Map and an export then say which test fails and write the map without the script applied again.")),
      guardRow(),
    ));
  }

  const problemsItem = shell.statusItem("left");
  const testsItem = shell.statusItem("left");
  const blockItem = shell.statusItem("left");
  const staleItem = shell.statusItem("left");
  const renamesItem = shell.statusItem("left");
  const messageItem = shell.statusItem("left");
  const buildItem = shell.statusItem("right");
  const libraryItem = shell.statusItem("right");
  const programsItem = shell.statusItem("right");
  const cursorItem = shell.statusItem("right");

  /** The script's tests and what they last said. */
  let tests: TestState = NO_TESTS;
  /** The test the Test Results view is on. */
  let chosenTest: string | null = null;
  let onlyFailing = false;
  /** Running every test took more than `TESTS_SLOW_MS` the last time. */
  let testsSlow = false;
  let testsRunning = false;
  /**
   * The tests' last results in the lifted game (TrigScript 4, A2), by id: a mark of their own beside the simulator's,
   * kept until the next run in the game. The game is the judge: where the two differ, the simulator is wrong.
   */
  let gameResults = new Map<string, TestResult>();
  /**
   * The files as they were when the game counted what each line costs (TrigScript 4, A4): a line's count is shown
   * beside it only while its file is still that text, since an edit moves the lines.
   */
  let costFiles: ScriptFiles | null = null;
  /** The text of `dist/gametest.js`, fetched once. */
  let gametest: Promise<string> | null = null;
  /** What Remastered is known to allow, fetched the first time an EUD error is looked up. */
  let allowlist: Promise<Allowlist> | null = null;
  /**
   * The last EUD error looked up (Find EUD Error), and the files as they were when the game was traced: its lines are
   * marked only while their file is still that text, as a line's cost is.
   */
  let eudFound: { files: ScriptFiles; answer: EudErrorAnswer } | null = null;
  /** The files with a tab, in the order they were opened. */
  let openTabs: string[] = [normalizePath(options.file ?? ENTRY_FILE)];
  /** What Apply, Play and the builds of the programs reported, oldest first. */
  let output: string[] = [];
  /** The last build of the programs (Save, Test Map or Play ran it), for the status bar. */
  /** The last build of the programs. `of` is the files it was started from: an edit replaces `files`, so a build of other files is of an older script. */
  let buildState: { kind: "busy" | "ok" | "error"; text: string; title?: string; of: ScriptFiles } | null = null;
  /** Lines the build under way has streamed; a build that streams none hands its log over at the end. */
  let streamed = 0;

  /** The log, kept at its end unless the user has scrolled up to read. */
  const renderOutput = (toEnd = false) => {
    if (output.length === 0) { outputView.body.replaceChildren(el("div", { className: "tsd-empty" }, t("What Apply, Play and the builds of the programs report is kept here."))); return; }
    const scroller = outputView.body.parentElement;
    const atEnd = toEnd || !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    outputEl.textContent = output.join("\n");
    if (outputEl.parentElement !== outputView.body) outputView.body.replaceChildren(outputEl);
    if (scroller && atEnd) scroller.scrollTop = scroller.scrollHeight;
  };
  const log = (text: string, stamped = true) => {
    output.push(stamped ? `[${new Date().toLocaleTimeString()}] ${text}` : text);
    if (output.length > OUTPUT_LINES) output = output.slice(-OUTPUT_LINES);
    renderOutput();
  };

  /**
   * What just happened. Work under way and its good outcome are a line of the status bar;
   * a failure, or an answer to something the user asked for, is a notification — a failure
   * stays until it is dismissed or the next piece of work starts. All of it is kept in Output.
   */
  let status: { kind: "ok" | "busy"; text: string } | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const setStatus = (kind: "info" | "ok" | "error" | "busy", text: string, timeout?: number) => {
    if (cancelled) return;
    if (statusTimer !== null) { clearTimeout(statusTimer); statusTimer = null; }
    if (kind === "busy" || kind === "ok") {
      status = { kind, text };
      shell.dismiss("status");
      if (kind === "ok") statusTimer = setTimeout(() => { statusTimer = null; status = null; render(); }, STATUS_MS);
    } else {
      status = null;
      shell.notify({ key: "status", kind: kind === "error" ? "error" : "info", text, timeout: timeout ?? (kind === "info" ? NOTICE_MS : undefined) });
    }
    if (kind !== "busy") log(text);
    render();
  };

  const goTo = (file: string, line: number, column = 1) => {
    if (!editor) return;
    openFile(file);
    editor.editor.revealLineInCenter(line);
    editor.editor.setPosition({ lineNumber: line, column });
    editor.editor.focus();
  };

  const where = (s: TriggerSource | null | undefined) => (s ? (Object.keys(files).length > 1 ? `${s.file}:${s.line}` : t("Ln {line}", { line: s.line })) : "?");

  /** Show a file, in a tab of its own; a video or an image in a viewer of its own. */
  const openFile = (path: string) => {
    if (!editor) return;
    const p = normalizePath(path);
    if (files[p] === undefined) return;
    if (isMediaFile(p)) { (isImageFile(p) ? showImage : isSoundFile(p) ? showSound : isNotesFile(p) ? showNotes : showVideo)(api, t, p, files[p]); return; }
    if (!openTabs.includes(p)) openTabs.push(p);
    editor.show(p);
    renderFiles();
    editor.editor.focus();
  };

  /** Closing a tab closes nothing but the tab: the file stays in the Explorer. The last one stays open. */
  const closeTab = (path: string) => {
    if (!editor || openTabs.length < 2) return;
    const at = openTabs.indexOf(path);
    if (at < 0) return;
    openTabs.splice(at, 1);
    if (editor.active() === path) editor.show(openTabs[Math.min(at, openTabs.length - 1)]);
    renderFiles();
    editor.editor.focus();
  };

  /** The folders of the Explorer that are closed; kept with the layout, so the tree comes back as it was left. */
  const COLLAPSED_KEY = "explorer.collapsed";
  let collapsed = new Set(api.storage.get<string[]>(COLLAPSED_KEY, []));
  const setCollapsed = (next: Set<string>) => { collapsed = next; api.storage.set(COLLAPSED_KEY, [...next]); };
  /** What is being dragged in the Explorer: a file's path or a folder's. */
  let dragged: string | null = null;

  /** Rows take a drop by being a folder (or the list, for the top): the dragged file or folder goes into it. */
  const acceptDrops = (target: HTMLElement, folder: string) => {
    const can = () => dragged !== null && folderOf(dragged) !== folder && dragged !== folder && !`${folder}/`.startsWith(`${dragged}/`);
    target.addEventListener("dragover", (e) => { if (!can()) return; e.preventDefault(); e.stopPropagation(); target.classList.add("tsd-drop"); });
    target.addEventListener("dragleave", () => target.classList.remove("tsd-drop"));
    target.addEventListener("drop", (e) => {
      target.classList.remove("tsd-drop");
      if (!can() || dragged === null) return;
      e.preventDefault();
      e.stopPropagation();
      const name = dragged.split("/").pop()!;
      moveTo(dragged, folder ? `${folder}/${name}` : name);
    });
  };
  const draggable = (row: HTMLElement, path: string) => {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => { dragged = path; e.dataTransfer?.setData("text/plain", path); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; row.classList.add("tsd-dragged"); });
    row.addEventListener("dragend", () => { dragged = null; row.classList.remove("tsd-dragged"); });
  };
  // Below the last row is the top of the script.
  acceptDrops(fileList, "");
  // A video, a picture or a sound dropped in from outside: Import Video… with it.
  const fromOutside = (e: DragEvent) => !dragged && !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  fileList.addEventListener("dragover", (e) => { if (!fromOutside(e)) return; e.preventDefault(); fileList.classList.add("tsd-drop"); });
  fileList.addEventListener("dragleave", () => fileList.classList.remove("tsd-drop"));
  fileList.addEventListener("drop", (e) => {
    fileList.classList.remove("tsd-drop");
    if (!fromOutside(e)) return;
    e.preventDefault();
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => /^(video|image)\//.test(f.type) || /\.(mkv|webm|mp4|mov|gif)$/i.test(f.name) || isSoundSource(f) || isMidiSource(f));
    if (file) void importVideo(file);
  });

  const renderFiles = () => {
    const active = editor?.active() ?? openTabs[0] ?? ENTRY_FILE;
    const paths = Object.keys(files);
    const broken = new Map<string, number>();
    for (const d of diagnostics) { const p = normalizePath(d.file); broken.set(p, (broken.get(p) ?? 0) + 1); }
    openTabs = openTabs.filter((p) => files[p] !== undefined);
    if (!openTabs.includes(active)) openTabs.push(active);
    const labels = tabLabels(openTabs);
    shell.setTabs(openTabs.map((p) => ({ id: p, label: labels.get(p)?.label ?? p, about: labels.get(p)?.folder, title: p, problems: broken.get(p), closable: openTabs.length > 1 })), active);
    // A folder that is no longer there is forgotten, so one made later under its name starts open.
    const folders = new Set(paths.flatMap((p) => { const parts = p.split("/").slice(0, -1); return parts.map((_, i) => parts.slice(0, i + 1).join("/")); }));
    if ([...collapsed].some((f) => !folders.has(f))) setCollapsed(new Set([...collapsed].filter((f) => folders.has(f))));
    const rows: HTMLElement[] = [];
    const indent = (depth: number) => `${20 + depth * 12}px`;
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.kind === "folder") {
          const open = !collapsed.has(node.path);
          const under = filesUnder(paths, node.path);
          const problems = under.reduce((n, p) => n + (broken.get(p) ?? 0), 0);
          const toggle = () => { const next = new Set(collapsed); if (open) next.add(node.path); else next.delete(node.path); setCollapsed(next); renderFiles(); };
          const items = () => [
            { label: t("New File…"), run: () => { void newFile(node.path); } },
            { label: t("New Folder…"), run: () => { void newFolder(node.path); } },
            null,
            { label: t("Rename…"), run: () => { void renameFolder(node.path); } },
            { label: t("Remove…"), run: () => { void removeFolder(node.path); } },
          ];
          const row = el("li", { className: "tsd-row tsd-folder", title: node.path, role: "button", ariaExpanded: String(open), onClick: toggle },
            shell.icon(open ? "chevron-down" : "chevron-right"),
            el("span", { className: problems ? "tsd-name tsd-problem" : "tsd-name" }, node.name),
            el("span", { className: "tsd-row-actions" },
              shell.iconButton({ icon: "new-file", title: t("New file in {folder}…", { folder: node.path }), run: () => { void newFile(node.path); } }).element,
              shell.iconButton({ icon: "edit", title: t("Rename or move…"), run: () => { void renameFolder(node.path); } }).element,
              shell.iconButton({ icon: "trash", title: t("Remove…"), run: () => { void removeFolder(node.path); } }).element,
              problems ? el("span", { className: "tsd-count" }, String(problems)) : undefined,
            ),
          );
          row.style.paddingLeft = `${6 + depth * 12}px`;
          row.addEventListener("contextmenu", (e) => { e.preventDefault(); shell.menu(row, items(), { x: e.clientX, y: e.clientY }); });
          draggable(row, node.path);
          acceptDrops(row, node.path);
          rows.push(row);
          if (open) walk(node.children, depth + 1);
          continue;
        }
        const path = node.path;
        const fixed = path === ENTRY_FILE;
        const row = el("li", { className: path === active ? "tsd-row tsd-active" : "tsd-row", title: isMediaFile(path) ? `${path}\n${describeMedia(path, files[path])}` : path, onClick: () => openFile(path) },
          isMediaFile(path) ? shell.icon(isImageFile(path) ? "file-media" : isSoundFile(path) ? "unmute" : isNotesFile(path) ? "music" : "device-camera-video") : el("span", { className: "tsd-ts" }, "TS"),
          el("span", { className: broken.has(path) ? "tsd-name tsd-problem" : "tsd-name" }, node.name),
          el("span", { className: "tsd-row-actions" },
            !fixed ? shell.iconButton({ icon: "edit", title: t("Rename or move…"), run: () => { void renameFile(path); } }).element : undefined,
            !fixed ? shell.iconButton({ icon: "trash", title: t("Remove…"), run: () => { void removeFile(path); } }).element : undefined,
            broken.has(path) ? el("span", { className: "tsd-count" }, String(broken.get(path))) : undefined,
          ),
        );
        row.style.paddingLeft = indent(depth);
        if (!fixed) {
          row.addEventListener("contextmenu", (e) => { e.preventDefault(); shell.menu(row, [
            { label: t("Rename…"), run: () => { void renameFile(path); } },
            { label: t("Remove…"), run: () => { void removeFile(path); } },
          ], { x: e.clientX, y: e.clientY }); });
          draggable(row, path);
        }
        // Onto a file is into the folder it is in.
        acceptDrops(row, folderOf(path));
        rows.push(row);
      }
    };
    walk(buildTree(paths), 0);
    fileList.replaceChildren(...rows);
  };

  const typeOf = (v: { kind: "number" | "boolean" | "unit" | "text"; bits?: number; unsigned?: boolean }) => (v.kind === "number" ? (v.bits ? `u${v.bits}` : v.unsigned ? "u32" : "number") : v.kind === "unit" ? "Unit" : v.kind === "text" ? "string" : "boolean");

  /** The programs and, under each, the variables it keeps in the game. */
  const renderPrograms = () => {
    const programs = outline?.programs ?? [];
    programsSection.setHidden(programs.length === 0);
    programList.replaceChildren(...programs.flatMap((p, i) => [
      el("li", { className: "tsd-row", title: t("{name}, run as {owner}", { name: p.name ?? t("Program {n}", { n: i + 1 }), owner: ownerLabel(p, t) }), onClick: () => goTo(p.source.file, p.source.line) },
        shell.icon("symbol-method"),
        el("span", { className: "tsd-name" }, p.name ?? t("program {n}", { n: i + 1 })),
        el("span", { className: "tsd-about" }, `${ownerLabel(p, t)}${p.perPlayer ? ` · ${t("per player")}` : ""}`),
      ),
      ...(outline?.variables ?? []).filter((v) => v.program === i).map((v) =>
        el("li", { className: "tsd-row tsd-child", title: `${v.name}: ${typeOf(v)}${v.shared ? t(", one value shared by every player") : p.perPlayer ? t(", one per player") : ""}`, onClick: () => goTo(v.at.file, v.at.line, v.at.column) },
          shell.icon("symbol-variable"),
          el("span", { className: "tsd-name" }, v.name),
          el("span", { className: "tsd-about" }, `${typeOf(v)}${v.shared ? ` · ${t("shared")}` : ""}`),
        )),
    ]));
  };

  /**
   * A script TrigScript's own build does not take is built through eudplib instead (while that is there): a warning on
   * the line that says why, so that a map does not change builds without anyone seeing.
   */
  const ownWarnings = (): ScriptWarning[] => {
    const refusal = result?.ownRefusal;
    if (!refusal || !result?.programs.length) return [];
    const at = /, line (\d+)(?: of (\S+))?$/.exec(refusal);
    const reason = at ? refusal.slice(0, at.index) : refusal;
    const message = library?.contribute
      ? t("Built through eudplib, not by TrigScript itself: {reason}. The map is built in a few seconds instead of under one, and plays the same.", { reason })
      : t("Not built: TrigScript itself does not take this yet ({reason}), and the eudplib plugin, which would, is not running.", { reason });
    return [{ file: at?.[2] ?? ENTRY_FILE, line: at ? Number(at[1]) : 1, message, source: "build" }];
  };
  const allWarnings = (): ScriptWarning[] => [...warningsOf(tests, t), ...ownWarnings()];

  const renderProblems = () => {
    // A failing test and an only left in are warnings: said here, and no obstacle to a build unless the map's settings make one of them.
    const warnings = allWarnings();
    const eud = eudLines(), found = eudFound?.answer;
    problemsView.badge(diagnostics.length + warnings.length + eud.length);
    if (diagnostics.length + warnings.length + eud.length === 0) { problemsView.body.replaceChildren(el("div", { className: "tsd-empty" }, !ready ? "" : result ? t("No problems have been detected in the script.") : t("Checking…"))); return; }
    problemsView.body.replaceChildren(el("ul", { className: "tsd-list" },
      ...diagnostics.map((d) =>
        el("li", { title: d.message, onClick: () => goTo(d.file, d.line, d.column) },
          shell.icon("error"),
          el("span", { className: "msg" }, d.message.split("\n")[0]),
          el("span", { className: "src" }, d.source === "typescript" ? t("types") : d.source === "script" ? t("script") : t("compiler")),
          el("span", { className: "where" }, t("{file} [Ln {line}, Col {column}]", { file: d.file, line: d.line, column: d.column })),
        )),
      ...(found ? eud.map((l) =>
        el("li", { title: eudLineNote(found, l), onClick: () => goTo(l.file, l.line) },
          shell.icon("error"),
          el("span", { className: "msg" }, `EUD ERROR ${found.code}: ${found.place}`),
          el("span", { className: "src" }, t("game")),
          el("span", { className: "where" }, t("{file} [Ln {line}]", { file: l.file, line: l.line })),
        )) : []),
      ...warnings.map((w) =>
        el("li", { className: "tsd-warning", title: w.message, onClick: () => goTo(w.file, w.line) },
          shell.icon("warning"),
          el("span", { className: "msg" }, w.message),
          el("span", { className: "src" }, w.source === "build" ? t("build") : t("tests")),
          el("span", { className: "where" }, t("{file} [Ln {line}]", { file: w.file, line: w.line })),
        )),
    ));
  };

  /* ── Tests ── */

  const STATE_ICON: Record<TestStateName, IconName> = { none: "circle-outline", passed: "pass", failed: "error", skipped: "circle-slash", running: "loading" };
  const stateIcon = (state: TestStateName) => { const i = shell.icon(STATE_ICON[state]); i.classList.add(`tsd-test-${state}`); if (state === "running") i.classList.add("tsd-spin"); return i; };

  /** The Testing view: folder, file, describe, test, each with its mark; a row runs what is under it. */
  const renderTesting = () => {
    const counts = countTests(tests);
    testingView.badge(counts.failed || null, "error");
    const said = summary(counts, t);
    testsItem.set(ready && said ? { icon: testsRunning ? "loading" : said.failed ? "error" : "beaker", busy: testsRunning, text: said.text, kind: said.failed ? "error" : undefined, title: testsSlow
      ? t("{n, plural, one {# test} other {# tests}}; running them all takes a while, so only the open file's run after a change. Click for the Testing view", { n: counts.total })
      : t("{n, plural, one {# test} other {# tests}}. Click for the Testing view", { n: counts.total }), onClick: () => testingView.show() } : null);
    if (tests.list.length === 0) {
      testingList.replaceChildren(el("li", { className: "tsd-empty" }, t("The script has no tests yet. A test is a test(name, (sim) => { … }) imported from \"trigscript\", in any file or in one named *.test.ts: it runs here, in the simulator, after every change that compiles.")));
      return;
    }
    const rows: HTMLElement[] = [];
    const failing = (node: TestNode): boolean => (node.kind === "test" ? stateOf(tests, node.info) === "failed" : node.children.some(failing));
    const walk = (nodes: TestNode[], depth: number) => {
      for (const node of nodes) {
        if (onlyFailing && !failing(node)) continue;
        const ids = idsUnder(node);
        const state: TestStateName = testsRunning ? "running" : node.kind === "test" || node.kind === "suite" ? stateOf(tests, node.info) : stateOfCounts(countTests(tests, (x) => ids.some((id) => x.id === id || x.id.startsWith(`${id} > `))));
        const name = node.kind === "folder" || node.kind === "file" ? node.name : node.info.name;
        const result = node.kind === "test" ? tests.results.get(node.info.id) : undefined;
        const open = () => {
          if (node.kind === "folder") return;
          if (node.kind === "file") { openFile(node.path); return; }
          if (node.kind === "test") { chosenTest = node.info.id; shell.showPanel("tests"); renderResults(); renderTesting(); }
          goTo(node.info.file, node.info.line);
        };
        const row = el("li", { className: node.kind === "test" && node.info.id === chosenTest ? "tsd-row tsd-active" : "tsd-row", title: result?.message ?? name, onClick: open },
          stateIcon(state),
          // (The game's mark next to the simulator's, where a narrow sidebar still shows it.)
          node.kind === "test" && gameResults.has(node.info.id) ? gameMark(gameResults.get(node.info.id)!, result) : undefined,
          el("span", { className: state === "failed" ? "tsd-name tsd-problem" : "tsd-name" }, name),
          result && result.status !== "skipped" ? el("span", { className: "tsd-about" }, t("{ms} ms", { ms: result.ms })) : undefined,
          el("span", { className: "tsd-row-actions" },
            shell.iconButton({ icon: "play", title: node.kind === "test" ? t("Run this test") : t("Run these tests"), run: () => { void runTests(node.kind === "file" ? { files: [node.path] } : { ids }); } }).element,
            node.kind === "test" ? shell.iconButton({ icon: "debug-alt", title: t("Debug this test in the game: run it once with everything it did written down, then walk it forwards and back"), run: () => { void debugTest(node.info.id); } }).element : undefined,
          ),
        );
        row.style.paddingLeft = `${10 + depth * 12}px`;
        rows.push(row);
        walk(node.children, depth + 1);
      }
    };
    walk(testTree(tests.list), 0);
    if (rows.length === 0) rows.push(el("li", { className: "tsd-empty" }, t("No test fails.")));
    testingList.replaceChildren(...rows);
  };

  /** A test's mark from the game, the second beside the simulator's: its state, ringed when the two disagree, and in words on hover. */
  const gameMark = (game: TestResult, simulated: TestResult | undefined) => {
    const state: TestStateName = game.status === "failed" ? "failed" : game.status === "passed" ? "passed" : "skipped";
    const differ = simulated && simulated.status !== "skipped" && game.status !== "skipped" && simulated.status !== game.status;
    return el("span", { className: differ ? "tsd-game tsd-game-differs" : "tsd-game", title: differ
      ? t("In the game: {status}. The simulator and the game disagree: the game is right, so the simulator is wrong here (or the test leans on something it does differently).", { status: game.status === "failed" ? game.message ?? t("failed") : t("passed") })
      : game.status === "failed" ? t("In the game: {message}", { message: game.message ?? t("failed") }) : game.status === "skipped" ? game.message ?? t("In the game: not run") : t("In the game: passed") },
    stateIcon(state));
  };

  /**
   * The tests run in the lifted game (TrigScript 4, A2): the map built as Save builds it, handed with the script's
   * JavaScript and `dist/gametest.js` to the scm-sim plugin's engine page, which runs each test beside the game. The
   * simulator runs them too, so that each test has both marks.
   */
  /**
   * What a run in the game needs, made ready: the engine there and willing, the script applied and compiled, the map
   * built as Save builds it and exported whole (a bare .chk has no room for what the build steps make, so the engine's
   * page reads the scenario out of it), with the build's maps of variables and triggers from its log, and the text of
   * `dist/gametest.js`. Null, the reason said in the status bar, when something is missing.
   */
  const prepareInGame = async (filter: Pick<TestRunOptions, "files" | "ids">, ask: "tests" | "debug" | "trace") => {
    const engine = svc.engine();
    if (!engine?.present || !engine.test || (ask === "debug" && !engine.debug)) {
      setStatus("error", ask === "debug"
        ? t("Debugging in the game needs the scm-sim plugin (0.11 or newer) on scmjs.dev: install, update or turn it on under Plugins ▸ Manage Plugins….")
        : t("Running tests in the game needs the scm-sim plugin (0.11 or newer) on scmjs.dev: install or turn it on under Plugins ▸ Manage Plugins…."));
      return null;
    }
    const notRun = (message: string) => (ask === "debug" ? t("Not debugged in the game: {message}", { message }) : ask === "trace" ? t("Not looked up in the game: {message}", { message }) : t("Not run in the game: {message}", { message }));
    const status = await engine.status();
    if (!status.available) { setStatus("error", notRun(status.reason ?? t("the engine cannot run a game now"))); return null; }
    if (!status.tests) { setStatus("error", t("Not run in the game: the engine's page is from before tests in the game. Reload the editor and try again.")); return null; }
    if (ask === "debug" && !status.debug) { setStatus("error", t("Not debugged: the engine's page is from before the debugger. Reload the editor and try again.")); return null; }
    if (!(await build()) || cancelled) return null;
    const a = await compileNow({ world: svc.world(), ...filter });
    if (!a || cancelled) return null;
    if (!a.compiled.ok) { setStatus("error", ask === "trace" ? t("Not looked up: {n, plural, one {# problem} other {# problems}} in the script.", { n: a.compiled.diagnostics.length }) : t("Tests not run: {n, plural, one {# problem} other {# problems}} in the script.", { n: a.compiled.diagnostics.length }), NOTICE_MS); shell.showPanel("problems"); return null; }
    // (An EUD error is looked up in the map played with nobody at it, then the tests when there are any.)
    if (!a.compiled.modules && ask !== "trace") { setStatus("info", t("The script has no tests.")); return null; }
    if (!a.compiled.ir.length) {
      setStatus("info", ask === "trace"
        ? t("The script has no program, so nothing of it is built into the map and no line of it can touch the game's memory: an EUD error came from the map's other triggers.")
        : t("Tests run in the game only for a script with a program: without one, nothing of the script is built into the map."));
      return null;
    }
    const names = svc.names()?.names;
    if (!names) { setStatus("error", t("No map is open.")); return null; }
    setStatus("busy", t("Building the map…"));
    const built = { ...files };
    // (The build says in its log where it put the programs' variables, for sim.program().)
    const logged: string[] = [];
    const heard = svc.onBuild((e) => { if (e.kind === "log") logged.push(e.line); else if (e.kind === "done" && !logged.length) logged.push(...e.log.split("\n")); });
    const file = await svc.withVariableMap(() => api.document.export({ format: "scx" })).finally(() => heard.dispose());
    if (!file || cancelled) { if (!file) setStatus("error", t("No map is open.")); return null; }
    const variables = readVariableMap(logged), triggers = readTriggerMap(logged);
    gametest ??= fetch(gametestUrl(svc.dist())).then((r) => { if (!r.ok) throw new Error(`gametest.js: ${r.status}`); return r.text(); });
    const module = await gametest.catch((err) => { gametest = null; throw err; });
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { engine, status, a, names, variables, triggers, module, bytes, built };
  };

  const runTestsInGame = async (filter: Pick<TestRunOptions, "files" | "ids"> = {}) => {
    if (!editor || testsRunning || building || testing || !ready) return;
    testsRunning = true;
    renderTesting();
    try {
      const ready = await prepareInGame(filter, "tests");
      if (!ready || cancelled) return;
      const { engine, status, a, names, variables, triggers, module, bytes } = ready;
      setStatus("busy", t("Running the tests in the game…"));
      const report = await engine.test!(bytes, module, { modules: a.compiled.modules, names, files: filter.files, ids: filter.ids, variables, triggers }) as TestReport & { error?: string };
      if (cancelled) return;
      if (report.error) { setStatus("error", t("Not run in the game: {message}", { message: report.error })); return; }
      // A test of several players (TrigScript 4, A3): a copy of the game for each player, kept in step, where the
      // engine's page can run them; where it cannot, the test is marked as not run, and why.
      const several = new Map<string, { players: number[]; ids: string[] }>();
      for (const x of tests.list) {
        if (x.kind !== "test" || !x.players || (filter.files && !filter.files.includes(x.file)) || (filter.ids && !filter.ids.some((id) => x.id === id || x.id.startsWith(`${id} > `)))) continue;
        const key = x.players.join(","), g = several.get(key) ?? { players: x.players, ids: [] };
        g.ids.push(x.id);
        several.set(key, g);
      }
      const notRun: TestResult[] = [];
      if (several.size && (!engine.testCopies || !status.copies)) {
        const why = t("Not run: a test of several players runs a copy of the game for each, which needs memory shared between them. This browser does not allow that on the engine's page (Chrome and Edge from version 137 do).");
        for (const g of several.values()) for (const id of g.ids) notRun.push({ id, status: "skipped", message: why, printed: [], events: [], frames: 0, ms: 0 });
      } else for (const g of several.values()) {
        setStatus("busy", t("Running a test of {n} players in the game: a copy of the game for each…", { n: g.players.length }));
        const out = await engine.testCopies!(bytes, module, { modules: a.compiled.modules, names, ids: g.ids, variables, triggers }, { players: g.players, triggers });
        if (cancelled) return;
        report.results.push(...mergeCopies(g.ids, out));
      }
      const ran = report.results.filter((x) => x.status !== "skipped");
      const asked = new Set(ran.map((x) => x.id));
      gameResults = new Map([...gameResults].filter(([id]) => !asked.has(id) && tests.list.some((x) => x.id === id)));
      for (const r of ran) gameResults.set(r.id, r);
      for (const r of notRun) gameResults.set(r.id, r);
      costFiles = { ...files };
      refreshLineHints();
      const failed = ran.filter((x) => x.status === "failed");
      const differ = ran.filter((x) => { const s = tests.results.get(x.id); return s && s.status !== "skipped" && s.status !== x.status; });
      if (failed.length) { chosenTest = failed[0].id; shell.showPanel("tests"); }
      const said = t("In the game: {passed} of {n, plural, one {# test} other {# tests}} passed.", { passed: ran.length - failed.length, n: ran.length });
      const whole = notRun.length ? `${said} ${t("{n, plural, one {# test of several players was} other {# tests of several players were}} not run: this browser cannot run copies of the game.", { n: notRun.length })}` : said;
      setStatus(failed.length || differ.length ? "error" : notRun.length ? "info" : "ok", differ.length ? `${whole} ${t("The simulator disagrees on {n, plural, one {# test} other {# tests}}.", { n: differ.length })}` : whole, NOTICE_MS);
    } catch (err) {
      setStatus("error", t("Not run in the game: {message}", { message: (err as Error).message }));
    } finally {
      testsRunning = false;
      render();
    }
  };

  /**
   * One test debugged in the game (TrigScript 4, A5): built as for a run in the game, then run once by the engine's
   * page with everything it did written down; the Debug view walks that record. The game stays with the page for
   * pictures of the run's frames, drawn by a view of the scm-sim plugin's where this copy of the game may draw.
   */
  const debugTest = async (id: string) => {
    if (!editor || testsRunning || building || testing || !ready) return;
    const info = tests.list.find((x) => x.id === id);
    if (!info || info.kind !== "test") { setStatus("info", t("There is no test at the cursor.")); return; }
    if (info.players) { setStatus("info", t("“{test}” is a test of several players: the debugger runs one game, and a test of several players runs as a copy of the game for each. Not yet.", { test: info.name })); return; }
    testsRunning = true;
    renderTesting();
    try {
      const got = await prepareInGame({ ids: [id] }, "debug");
      if (!got || cancelled) return;
      const { engine, a, names, variables, triggers, module, bytes, built } = got;
      setStatus("busy", t("Running “{test}” in the game, writing down everything it does…", { test: info.name }));
      const session = await engine.debug!(bytes, module, { modules: a.compiled.modules, names, variables, triggers, test: id });
      if (cancelled) { session.close(); return; }
      const recording = session.recording as DebugRecording;
      // A view to draw the pictures in, where the plugin has one for a debugged run.
      let view: DebugGameView | string | null = null;
      if (engine.view) {
        try {
          const host = debug.gameHost();
          const v = engine.view(host) as ScmSimDebugView;
          if (typeof v.debug === "function" && typeof v.show === "function") {
            const shown = await v.debug(bytes).then(() => null, (err: Error) => err.message);
            if (shown) { v.dispose(); view = shown; }
            else {
              v.onError?.((message) => setStatus("error", t("No picture of the game: {message}", { message })));
              view = { element: host, show: (p) => v.show!(p), dispose: () => v.dispose() };
            }
          } else { v.dispose(); view = t("The scm-sim plugin's view is from before the debugger: update the plugin for a picture of the game."); }
        } catch (err) { view = (err as Error).message; }
      }
      debug.start({ recording, variables, pictures: session, view, files: built });
      debug.setFiles(files);
      const r = recording.result;
      setStatus(r.status === "failed" ? "error" : "ok", r.status === "failed"
        ? t("Debugging “{test}”: it failed in the game at frame {frame}. The debugger stands there; step back to see how it came to that.", { test: info.name, frame: recording.first + recording.frames - 1 })
        : t("Debugging “{test}”: {frames, plural, one {# frame} other {# frames}} in the game, recorded in {ms} ms.", { test: info.name, frames: recording.frames, ms: recording.ms }), NOTICE_MS);
    } catch (err) {
      setStatus("error", t("Not debugged in the game: {message}", { message: (err as Error).message }));
    } finally {
      testsRunning = false;
      render();
    }
  };

  const debugTestAtCursor = () => {
    const at = editor?.cursor();
    const here = at ? tests.list.filter((x) => x.kind === "test" && x.file === normalizePath(at.file) && x.line <= at.line).sort((a, b) => b.line - a.line)[0] : undefined;
    if (!here) { setStatus("info", t("There is no test at the cursor.")); return; }
    void debugTest(here.id);
  };

  /**
   * What a frame costs, beside the line (TrigScript 4, A4): after a run in the game, each line that ran at least
   * COST_HINT conditions and actions in one frame of some test says how many at the most, while its file is as it
   * was then.
   */
  const costHints = (): LineHint[] => {
    if (!costFiles) return [];
    const seen = costFiles;
    const costs = [...gameResults.values()].flatMap((r) => (r.cost ? [{ id: r.id, cost: r.cost }] : []));
    return costByLine(costs)
      .filter((l) => (l.ms ? l.ms.peak >= COST_HINT_MS : l.peak >= COST_HINT) && seen[normalizePath(l.file)] === files[normalizePath(l.file)])
      .map((l) => l.ms ? {
        file: l.file, line: l.line,
        label: t("{ms} ms a frame", { ms: shortMs(l.ms.peak) }),
        note: t("In the game, this line took {ms} ms of Remastered's time in one frame at the most ({n} conditions and actions): frame {frame} of the test “{test}”, which it ran in for {frames, plural, one {# frame} other {# frames}}. On a fast computer Remastered ran {smooth} ms of triggers a frame with no flicker seen, and slows past {most} ms; a slower computer gets there sooner. This is {share} of the {smooth} ms.", { ms: shortMs(l.ms.peak), n: l.peak.toLocaleString(), frame: l.ms.peakFrame, test: testName({ id: l.test }), frames: l.frames, smooth: SMOOTH_MS, most: Math.round(MOST_MS), share: shareOfMs(l.ms.peak) }),
      } : {
        file: l.file, line: l.line,
        label: t("{n} a frame", { n: shortCount(l.peak) }),
        note: t("In the game, this line ran {n} conditions and actions in one frame at the most: frame {frame} of the test “{test}”, which it ran in for {frames, plural, one {# frame} other {# frames}}. On a fast computer Remastered ran 500 thousand a frame with no visible effect; its screen flickers from a million and the game slows at 5 million. This is {share} of the 500 thousand.", { n: l.peak.toLocaleString(), frame: l.peakFrame, test: testName({ id: l.test }), frames: l.frames, share: shareOf(l.peak) }),
      });
  };

  /** The lines of the last EUD error looked up, while their file is the text that was traced. */
  const eudLines = () => {
    if (!eudFound) return [];
    const seen = eudFound.files;
    return eudFound.answer.lines.filter((l) => seen[normalizePath(l.file)] === files[normalizePath(l.file)]);
  };
  /** What a line did to the address, and what Remastered does with that, in a sentence. */
  const eudLineNote = (a: EudErrorAnswer, l: EudErrorAnswer["lines"][number]) => {
    const did = l.read && l.write ? t("reads and writes") : l.write ? t("writes") : t("reads");
    const verdict = l.write ? a.write : a.read;
    const said = verdict === "ends" ? t("Remastered ends the game on this.") : verdict === "ignored" ? t("Remastered does nothing with this.") : verdict === "allowed" ? t("Remastered was seen to allow this, so the game that ended did something else to it.") : t("This has not been seen in Remastered.");
    return l.match === "exact"
      ? t("In the game, this line {did} {place} ({times, plural, one {# time} other {# times}}). {said}", { did, place: a.place, times: l.times, said })
      : t("In the game, this line {did} the same field of another unit ({times, plural, one {# time} other {# times}}): a unit sits elsewhere in the table from one game to the next. {said}", { did, times: l.times, said });
  };
  const eudHints = (): LineHint[] => {
    const a = eudFound?.answer;
    return a ? eudLines().map((l) => ({ file: l.file, line: l.line, label: `EUD ERROR ${a.code}`, note: eudLineNote(a, l) })) : [];
  };

  /**
   * An "EUD ERROR: 0x…" Remastered showed, back to the lines of the script (TrigScript 4): the code is the address
   * the trigger named, bits inverted (R0). The map is built as Save builds it and played in the lifted game with
   * nobody at it, then the tests run, every EUD access written down under its line; the lines that touched the
   * address are marked, and what lies there is said.
   */
  const lookUpEudError = async () => {
    if (!editor || testsRunning || building || testing || !ready) return;
    const answer = await api.ui.prompt(t("The code Remastered showed when the game ended (EUD ERROR: 0x…):"), { title: "TrigScript", value: "", placeholder: "EUD ERROR: 0xFFA632E3" });
    if (answer === null || cancelled) return;
    const address = addressOfEudError(answer);
    if (address === null) { setStatus("error", t("“{text}” is not an EUD error code: Remastered shows one as EUD ERROR: 0x and eight digits.", { text: answer.trim() })); return; }
    testsRunning = true;
    renderTesting();
    try {
      const got = await prepareInGame({}, "trace");
      if (!got || cancelled) return;
      const { engine, a, names, variables, triggers, module, bytes, built } = got;
      if (!triggers) { setStatus("error", t("Not looked up: the build did not say where its triggers are. Update the eudplib plugin, or save once more.")); return; }
      setStatus("busy", t("Playing the map in the game, writing down what each line reads and writes…"));
      allowlist ??= fetch(allowlistUrl(svc.dist())).then((r) => { if (!r.ok) throw new Error(`allowlist.json: ${r.status}`); return r.json() as Promise<Allowlist>; });
      const [report, list] = await Promise.all([
        engine.test!(bytes, module, { modules: a.compiled.modules ?? [], names, variables, triggers, trace: true, play: EUD_TRACE_FRAMES }) as Promise<GameTestReport>,
        allowlist.catch(() => { allowlist = null; return undefined; }),
      ]);
      if (cancelled) return;
      if (report.error) { setStatus("error", t("Not looked up in the game: {message}", { message: report.error })); return; }
      if (!report.trace) { setStatus("error", t("Not looked up in the game: {message}", { message: report.traceError ?? t("the engine's page sent back no trace") })); return; }
      const found = findEudError(address, report.trace.rows, list);
      eudFound = { files: built, answer: found };
      log(t("EUD ERROR {code}: {place}, at 0x{address}.", { code: found.code, place: found.place, address: found.address.toString(16) }));
      for (const l of found.lines) log(`  ${l.file}:${l.line} — ${eudLineNote(found, l)}`, false);
      const ran = report.results.filter((r) => r.status !== "skipped").length;
      const where = found.lines.slice(0, 3).map((l) => `${l.file}:${l.line}`).join(", ") + (found.lines.length > 3 ? "…" : "");
      const exact = found.lines.some((l) => l.match === "exact");
      const head = t("EUD ERROR {code} is {place}.", { code: found.code, place: found.place });
      const said = found.lines.length
        ? exact
          ? t("{n, plural, one {# line touched it} other {# lines touched it}} in the game: {where}.", { n: found.lines.length, where })
          : t("No line touched that very unit, but {n, plural, one {# line touches} other {# lines touch}} the same field of other units, and a unit sits elsewhere in the table from one game to the next: {where}.", { n: found.lines.length, where })
        : found.unlined.exact + found.unlined.field
          ? t("No line of the script touched it: eudplib's own work did ({n, plural, one {# time} other {# times}}).", { n: found.unlined.exact + found.unlined.field })
          : ran
            ? t("Nothing touched it in {frames} frames of the map played with nobody at it, nor in {tests, plural, one {# test} other {# tests}}: the line that did is one this run did not reach. A test that gets there will find it.", { frames: EUD_TRACE_FRAMES.toLocaleString(), tests: ran })
            : t("Nothing touched it in {frames} frames of the map played with nobody at it: the line that did is one this run did not reach. A test that gets there will find it.", { frames: EUD_TRACE_FRAMES.toLocaleString() });
      setStatus(found.lines.length ? "error" : "info", `${head} ${said}`);
      const first = found.lines[0];
      if (first) goTo(first.file, first.line);
      refreshLineHints();
    } catch (err) {
      setStatus("error", t("Not looked up in the game: {message}", { message: (err as Error).message }));
    } finally {
      testsRunning = false;
      render();
    }
  };

  /** "0.2%", "31%": a count as a share of what Remastered was seen to run in a frame. */
  const shareOf = (n: number) => `${(n / COST_SEEN * 100).toFixed(n < COST_SEEN / 10 ? 1 : 0)}%`;
  /** The same for milliseconds, of SMOOTH_MS. */
  const shareOfMs = (ms: number) => `${(ms / SMOOTH_MS * 100).toFixed(ms < SMOOTH_MS / 10 ? 1 : 0)}%`;

  /** The test's frames in the game as a small graph, in milliseconds where the host weighs; eudplib's own work is not in it. */
  const costGraph = (cost: TestCost): Element => {
    const series = cost.ms?.perFrame ?? cost.perFrame, peak = cost.ms?.peak ?? cost.peak;
    const NS = "http://www.w3.org/2000/svg", n = Math.max(series.length, 2), top = cost.ms ? Math.max(peak, 0.001) : Math.max(peak, 1);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "tsd-cost-graph");
    svg.setAttribute("viewBox", `0 0 ${n - 1} 100`);
    svg.setAttribute("preserveAspectRatio", "none");
    const points = series.map((v, i) => `${i},${(100 - (v / top) * 96).toFixed(2)}`);
    const area = document.createElementNS(NS, "path");
    area.setAttribute("d", `M0,100 L${points.join(" L")} L${series.length - 1},100 Z`);
    svg.append(area);
    const title = document.createElementNS(NS, "title");
    title.textContent = cost.ms
      ? t("Remastered's time a frame, frame {from} to {to}: {ms} ms at the most, at frame {frame}", { from: cost.from, to: cost.from + series.length - 1, ms: shortMs(cost.ms.peak), frame: cost.ms.peakFrame })
      : t("Conditions and actions a frame, frame {from} to {to}: {peak} at the most, at frame {frame}", { from: cost.from, to: cost.from + cost.perFrame.length - 1, peak: cost.peak.toLocaleString(), frame: cost.peakFrame });
    svg.append(title);
    return svg;
  };

  /** Test Results: the chosen test's message, what it printed, and what happened by frame, each a link to its line. */
  const renderResults = () => {
    const failed = tests.list.filter((x) => x.kind === "test" && tests.results.get(x.id)?.status === "failed");
    resultsView.badge(failed.length);
    const info: TestInfo | undefined = tests.list.find((x) => x.id === chosenTest) ?? failed[0] ?? tests.list.find((x) => x.kind === "test" && tests.results.has(x.id));
    const r = info ? tests.results.get(info.id) : undefined;
    if (!info || !r) { resultsView.body.replaceChildren(el("div", { className: "tsd-empty" }, tests.list.length ? t("No test has run yet: they run after a change that compiles, or from the Testing view.") : t("The script has no tests."))); return; }
    const list = el("ul", { className: "tsd-list" });
    const at = r.at ?? { file: info.file, line: info.line };
    list.append(el("li", { title: t("Go to the test"), onClick: () => goTo(info.file, info.line) },
      stateIcon(r.status === "failed" ? "failed" : r.status === "passed" ? "passed" : "skipped"),
      el("span", { className: "msg" }, testName(info)),
      el("span", { className: "src" }, r.status === "skipped" ? t("skipped") : t("{frames, plural, one {# frame} other {# frames}} · {ms} ms", { frames: r.frames, ms: r.ms })),
      el("span", { className: "where" }, where({ file: info.file, line: info.line }))));
    if (r.status === "failed") {
      list.append(el("li", { className: "tsd-fault", title: t("Go to where it failed"), onClick: () => goTo(at.file, at.line, at.column ?? 1) },
        el("span", { className: "frame" }, t("failed")), el("span", { className: "msg" }, r.message ?? t("failed")), el("span", { className: "where" }, where({ file: at.file, line: at.line }))));
      if (r.expected !== undefined) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, t("expected")), el("span", { className: "msg" }, r.expected)));
      if (r.actual !== undefined) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, t("got")), el("span", { className: "msg" }, r.actual)));
    }
    const game = gameResults.get(info.id);
    if (game && game.status !== "skipped") {
      const gat = game.at ?? { file: info.file, line: info.line };
      list.append(el("li", { className: game.status === "failed" ? "tsd-fault" : "tsd-plain", title: t("Go to where it failed in the game"), onClick: () => goTo(gat.file, gat.line, gat.column ?? 1) },
        el("span", { className: "frame" }, t("in the game")),
        el("span", { className: "msg" }, game.status === "failed" ? game.message ?? t("failed") : t("passed")),
        el("span", { className: "where" }, game.status === "failed" ? where({ file: gat.file, line: gat.line }) : t("{frames, plural, one {# frame} other {# frames}} · {ms} ms", { frames: game.frames, ms: game.ms }))));
      if (game.status === "failed" && game.actual !== undefined) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, t("got")), el("span", { className: "msg" }, game.actual)));
      // (What its frames cost in the game, and the lines that cost the most.)
      const cost = game.cost;
      if (cost) {
        const ran = cost.perFrame.filter((x) => x > 0), average = ran.length ? Math.round(ran.reduce((a, b) => a + b, 0) / ran.length) : 0;
        const other = cost.other.slice(3), runtime = other.length ? Math.round(other.reduce((a, b) => a + b, 0) / other.length) : 0;
        if (cost.ms) {
          const ranMs = cost.ms.perFrame.filter((x) => x > 0), averageMs = ranMs.length ? ranMs.reduce((a, b) => a + b, 0) / ranMs.length : 0;
          const otherMs = cost.ms.other.slice(3), runtimeMs = otherMs.length ? otherMs.reduce((a, b) => a + b, 0) / otherMs.length : 0;
          list.append(el("li", { className: "tsd-plain", title: t("Counted in the lifted game and weighed by what Remastered was measured spending on each trigger, condition and action on a fast computer (Ryzen 9 7900X): the script's own triggers and the variables they go through, {average} conditions and actions a frame on average and {peak} at the most. eudplib's work at the top of each frame is apart: {ms} ms a frame. Remastered slows past {most} ms of triggers a frame there, and a slower computer sooner.", { average: average.toLocaleString(), peak: cost.peak.toLocaleString(), ms: shortMs(runtimeMs), most: Math.round(MOST_MS) }) },
            el("span", { className: "frame" }, t("cost")),
            el("span", { className: "msg" }, t("{average} ms a frame on average, {peak} ms at the most (frame {frame}): {share} of the {smooth} ms of triggers a frame Remastered ran with no flicker seen", { average: shortMs(averageMs), peak: shortMs(cost.ms.peak), frame: cost.ms.peakFrame, share: shareOfMs(cost.ms.peak), smooth: SMOOTH_MS }))));
        } else {
          list.append(el("li", { className: "tsd-plain", title: t("Counted in the lifted game: the script's own triggers and the variables they go through. eudplib's work at the top of each frame is apart: {n} a frame.", { n: runtime.toLocaleString() }) },
            el("span", { className: "frame" }, t("cost")),
            el("span", { className: "msg" }, t("{average} conditions and actions a frame on average, {peak} at the most (frame {frame}): {share} of the 500 thousand a frame Remastered has run with no visible effect", { average: average.toLocaleString(), peak: cost.peak.toLocaleString(), frame: cost.peakFrame, share: shareOf(cost.peak) }))));
        }
        if (cost.perFrame.length > 1) list.append(el("li", { className: "tsd-plain tsd-cost" }, el("span", { className: "frame" }), costGraph(cost)));
        for (const l of cost.lines.slice(0, COST_LINES)) {
          list.append(el("li", { title: t("Go to the line"), onClick: () => goTo(l.file, l.line) },
            el("span", { className: "frame" }), el("span", { className: "msg note" }, l.ms
              ? t("{ms} ms a frame at the most (frame {frame}), in {frames, plural, one {# frame} other {# frames}}", { ms: shortMs(l.ms.peak), frame: l.ms.peakFrame, frames: l.frames })
              : t("{peak} a frame at the most (frame {frame}), in {frames, plural, one {# frame} other {# frames}}", { peak: l.peak.toLocaleString(), frame: l.peakFrame, frames: l.frames })),
            el("span", { className: "where" }, where({ file: l.file, line: l.line }))));
        }
      }
    }
    // The same line several times over — to each of eight players, say — is one row that says how often.
    const printed: { line: string; times: number }[] = [];
    for (const line of r.printed) { const last = printed[printed.length - 1]; if (last?.line === line) last.times++; else printed.push({ line, times: 1 }); }
    for (const { line, times } of printed) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, t("printed")), el("span", { className: "msg" }, line), times > 1 ? el("span", { className: "src" }, `×${times}`) : undefined));
    const several = new Set(r.events.map((e) => e.player)).size > 1;
    const events = foldPlayers(r.events);
    for (const e of events.slice(0, SIMULATE_ROWS)) {
      list.append(el("li", { onClick: () => { if (e.file && e.line) goTo(e.file, e.line); } },
        el("span", { className: "frame" }, t("frame {n}", { n: e.frame })), el("span", { className: "msg note" }, `${several ? `${playersLabel(e.players)} · ` : ""}${e.text}`), el("span", { className: "where" }, e.file && e.line ? where({ file: e.file, line: e.line }) : "")));
    }
    if (events.length > SIMULATE_ROWS) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "…"), el("span", { className: "msg" }, t("and {n} more", { n: events.length - SIMULATE_ROWS }))));
    resultsView.body.replaceChildren(list);
  };

  /** Run tests now, from what is in the editor: all of them, a file's, or those with these ids. */
  const runTests = async (filter: Pick<TestRunOptions, "files" | "ids"> = {}) => {
    if (!editor || testsRunning) return;
    testsRunning = true;
    renderTesting();
    try {
      const a = await compileNow({ world: svc.world(), ...filter });
      if (!a || cancelled) return;
      if (!a.compiled.ok) { setStatus("error", t("Tests not run: {n, plural, one {# problem} other {# problems}} in the script.", { n: a.compiled.diagnostics.length }), NOTICE_MS); shell.showPanel("problems"); return; }
      const ran = a.compiled.tests?.results.filter((x) => x.status !== "skipped") ?? [];
      const failed = ran.filter((x) => x.status === "failed");
      if (ran.length === 0) { setStatus("info", tests.list.length ? t("No test ran.") : t("The script has no tests.")); return; }
      if (failed.length) { chosenTest = failed[0].id; shell.showPanel("tests"); }
      setStatus(failed.length ? "error" : "ok", failed.length
        ? t("{failed} of {n, plural, one {# test} other {# tests}} failed: {name} — {message}", { failed: failed.length, n: ran.length, name: testName(failed[0]), message: failed[0].message ?? t("failed") })
        : t("{n, plural, one {# test} other {# tests}} passed.", { n: ran.length }), NOTICE_MS);
    } finally {
      testsRunning = false;
      render();
    }
  };
  const runFailedTests = () => {
    const ids = tests.list.filter((x) => x.kind === "test" && tests.results.get(x.id)?.status === "failed").map((x) => x.id);
    if (ids.length === 0) { setStatus("info", t("No test has failed.")); return Promise.resolve(); }
    return runTests({ ids });
  };
  /** The test the cursor is in: the last test or describe of the file that starts at or before its line. */
  const runTestAtCursor = () => {
    const at = editor?.cursor();
    const here = at ? tests.list.filter((x) => x.file === normalizePath(at.file) && x.line <= at.line).sort((a, b) => b.line - a.line)[0] : undefined;
    if (!here) { setStatus("info", t("There is no test at the cursor.")); return Promise.resolve(); }
    return runTests({ ids: [here.id] });
  };

  const renderSimulation = () => {
    if (!simulation) { simulateView.body.replaceChildren(el("div", { className: "tsd-empty" }, t("Simulate ({mod}+F5) runs the script's first {seconds} seconds in a built-in interpreter and lists what happened. A change to the script clears the list.", { mod: MOD, seconds: SIMULATE_FRAMES / 24 }))); return; }
    const { sim, programs: ps, result: r } = simulation;
    const list = el("ul", { className: "tsd-list" });
    list.append(el("li", { className: "tsd-plain" }, el("span", { className: "msg note" }, t("{frames} frames ({seconds} s) for {players}, from the map's placed units. Units are made, given, moved, killed and counted, but nothing walks or fights; scores and the countdown read 0; wait takes no time.", { frames: SIMULATE_FRAMES, seconds: SIMULATE_FRAMES / 24, players: sim.game.players.slots.map((p) => `P${p + 1}`).join(", ") }))));
    // What a program did that is always a mistake, first: the game says nothing of these (a read past an array's end is 0
    // there, a store past it nothing), so this is where they are seen. One row a line, however often a loop came past it.
    const faults = new Map<string, { first: NonNullable<typeof ps>["faults"][number]; times: number }>();
    for (const f of ps?.faults ?? []) {
      const key = `${f.at.file}:${f.at.line}:${f.at.column}:${f.message.replace(/\d+/g, "#")}`;
      const seen = faults.get(key);
      if (seen) seen.times++; else faults.set(key, { first: f, times: 1 });
    }
    for (const { first: f, times } of [...faults.values()].slice(0, SIMULATE_FAULTS)) {
      list.append(el("li", { className: "tsd-fault", title: f.message, onClick: () => goTo(f.at.file, f.at.line, f.at.column) },
        el("span", { className: "frame" }, t("frame {n}", { n: f.frame })), shell.icon("error"),
        el("span", { className: "msg" }, times > 1 ? t("{message} (and {n, plural, one {# more time} other {# more times}} at this line)", { message: f.message, n: times - 1 }) : f.message),
        el("span", { className: "where" }, where({ file: f.at.file, line: f.at.line }))));
    }
    if (faults.size > SIMULATE_FAULTS) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "…"), el("span", { className: "msg" }, t("and {n} more lines with a fault", { n: faults.size - SIMULATE_FAULTS }))));
    // Hand triggers' events (trigger interpreter) and the programs' (program interpreter), in time order.
    // With several players in the game each line says whose it is, and what several of them did alike in a frame is one line.
    const several = sim.game.players.slots.length > 1;
    const flat = [
      ...sim.events.map((e, i) => { const at = r.sources[e.trigger]; return { frame: e.cycle, order: i, player: e.player, text: describeEvent(e), file: at?.file, line: at?.line, column: 1, title: t("Trigger #{n}", { n: e.trigger + 1 }) }; }),
      ...(ps?.events ?? []).map((e, i) => ({ frame: e.frame, order: sim.events.length + i, player: e.player, text: describeEvent(e), file: e.at.file as string | undefined, line: e.at.line as number | undefined, column: e.at.column, title: t("Program {n}", { n: e.program + 1 }) })),
    ].sort((x, y) => x.frame - y.frame || x.order - y.order);
    const rows = foldPlayers(flat).map((e) => ({
      line: () => el("li", { title: e.title, onClick: () => { if (e.file && e.line) goTo(e.file, e.line, e.column); } },
        el("span", { className: "frame" }, t("frame {n}", { n: e.frame })), el("span", { className: "msg" }, `${several ? `${playersLabel(e.players)} · ` : ""}${e.text}`), el("span", { className: "where" }, e.file && e.line ? where({ file: e.file, line: e.line }) : "?")),
    }));
    if (rows.length === 0) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "—"), el("span", { className: "msg" }, t("No actions ran in {frames} frames.", { frames: SIMULATE_FRAMES }))));
    for (const row of rows.slice(0, SIMULATE_ROWS)) list.append(row.line());
    if (rows.length > SIMULATE_ROWS) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "…"), el("span", { className: "msg" }, t("and {n} more actions", { n: rows.length - SIMULATE_ROWS }))));
    const shownVars = new Set<string>();
    for (const v of r.variables) {
      if (shownVars.has(v.name)) continue;
      shownVars.add(v.name);
      const say = (value: number | boolean | undefined) => (value === undefined ? "?" : typeof value === "boolean" ? (value ? "true" : "false") : String(value));
      // A per-player program's variable is one for each player it ran for, unless it is shared.
      const runs = ps?.runs.filter((x) => x.index === v.program) ?? [];
      const shown = runs.length > 1 && !v.shared ? runs.map((x) => `P${x.player + 1} ${say(x.value(v.name))}`).join(" · ") : say(ps?.value(v.name, v.program));
      list.append(el("li", { title: t("The variable's value when the run ended"), onClick: () => goTo(v.at.file, v.at.line, v.at.column) },
        el("span", { className: "frame" }, t("after")), el("span", { className: "msg" }, `${v.name} = ${shown}`), el("span", { className: "where" }, typeOf(v))));
    }
    simulateView.body.replaceChildren(list);
  };

  /** The block was edited outside the script: what the next Apply does about it, and the other choice. Said once per state; the status bar brings it back. */
  let staleShown = "";
  const showStale = (again = false) => {
    const state = svc.state();
    if (!state?.stale) { staleShown = ""; shell.dismiss("stale"); return; }
    const e = state.edited ?? null;
    const signature = JSON.stringify([e, appendInstead]);
    if (!again && signature === staleShown) return;
    staleShown = signature;
    if (!e) {
      shell.notify({ key: "stale", kind: "warn", text: t("The script's triggers were edited or removed outside the script. They stay as hand-made triggers; the next Apply appends a fresh block. Saving the map does not apply the script until this is settled.") });
      return;
    }
    const facts = t("The script's triggers were edited outside the script: {unchanged, plural, one {# trigger is} other {# triggers are}} still the script's, {changed, plural, one {# trigger was} other {# triggers were}} changed.", { unchanged: e.unchanged, changed: e.changed });
    const plan = appendInstead
      ? t("The next Apply leaves them all as hand-made triggers and appends a fresh block.")
      : t("The next Apply replaces the {unchanged} and keeps the {changed, plural, one {# edited one} other {# edited ones}} as hand-made triggers right after the new block.", { unchanged: e.unchanged, changed: e.changed });
    shell.notify({ key: "stale", kind: "warn", text: `${facts} ${plan}`, actions: [
      { label: appendInstead ? t("Replace instead") : t("Append instead"), keep: true, run: () => { appendInstead = !appendInstead; render(); } },
      { label: t("Apply"), primary: true, run: () => { void build(); } },
    ] });
  };

  const renamedNow = () => renames.flatMap((r) => r.list.map((x) => `${r.object}.${x.from} → ${r.object}.${x.to}`));
  let renamesShown = "";
  const showRenames = (again = false) => {
    const all = renamedNow();
    if (all.length === 0) { renamesShown = ""; shell.dismiss("renames"); return; }
    const signature = all.join("\n");
    if (!again && signature === renamesShown) return;
    renamesShown = signature;
    shell.notify({ key: "renames", kind: "info", text: t("The map renamed {n, plural, one {something the script names} other {# things the script names}}: {list}.", { n: all.length, list: all.join(", ") }), actions: [
      { label: t("Leave"), run: () => { renames = []; render(); } },
      { label: t("Update references"), primary: true, run: () => { void applyRenames(); } },
    ] });
  };

  const renderCursor = () => {
    const at = editor?.editor.getPosition();
    cursorItem.set(at ? { text: t("Ln {line}, Col {column}", { line: at.lineNumber, column: at.column }), title: t("Go to line…"), onClick: () => { editor?.editor.focus(); editor?.editor.trigger("trigscript", "editor.action.gotoLine", null); } } : null);
  };

  const render = () => {
    const errors = diagnostics.length;
    testAction.set({ disabled: !ready || building || testing, busy: testing });
    simulateAction.set({ disabled: !ready || building || errors > 0 });
    applyAction.set({ disabled: !ready || building, busy: building && !testing });
    pickAction.set({ disabled: !ready || picking, busy: picking });

    // Read live, not cached: the block's state belongs to the map and other editors change it.
    const state = svc.state();
    const block = state?.block ?? null;
    const stale = state?.stale ?? false;
    const programs = outline ? outline.programs.length : state?.programs ?? 0;

    problemsItem.set(ready ? { icon: errors ? "error" : "pass", text: String(errors), kind: errors ? "error" : undefined, title: errors ? t("{n, plural, one {# problem} other {# problems}}", { n: errors }) : result ? t("No problems") : t("Checking…"), onClick: () => shell.togglePanel("problems") } : null);
    blockItem.set(stale ? null : block && !state?.unbuilt
      ? { icon: "check", text: t("{n, plural, one {# trigger} other {# triggers}} at #{start}", { n: block.count, start: block.start + 1 }), title: t("The script's triggers are in the map's trigger list, from #{start}. Click to apply the script again", { start: block.start + 1 }), onClick: () => { void build(); } }
      : { icon: "circle-filled", text: block ? t("Changes not applied") : t("Not applied yet"), title: block
        ? t("The script changed since it was applied: saving or testing the map applies the script by itself. Click to apply it now ({mod}+Shift+B)", { mod: MOD })
        : t("The script's triggers are not in the map yet: saving or testing the map applies the script by itself. Click to apply it now ({mod}+Shift+B)", { mod: MOD }), onClick: () => { void build(); } });
    staleItem.set(stale ? { icon: "warning", kind: "warn", text: t("Triggers edited outside the script"), title: t("What the next Apply does about it"), onClick: () => showStale(true) } : null);
    const renamed = renamedNow().length;
    renamesItem.set(renamed ? { icon: "sync", kind: "warn", text: t("{n} renamed", { n: renamed }), title: t("The map renamed things the script names"), onClick: () => showRenames(true) } : null);
    messageItem.set(status ? { text: status.text, busy: status.kind === "busy" } : !ready && !failed ? { text: t("Loading the editor…"), busy: true } : null);

    // A build that went well says so only of the script it was made from.
    const editedSince = buildState?.kind === "ok" && buildState.of !== files;
    buildItem.set(buildState ? {
      text: editedSince ? `${buildState.text} · ${t("edited since")}` : buildState.text, busy: buildState.kind === "busy",
      icon: buildState.kind === "error" ? "error" : "package", kind: buildState.kind === "error" ? "error" : editedSince ? "warn" : undefined,
      title: t("{what}. Click for its log", { what: editedSince ? t("The script changed since this build: the programs in the saved map are the older ones until the next Save") : buildState.title ?? t("The last build of the programs") }),
      onClick: () => shell.showPanel("output"),
    } : null);
    // Who builds the programs into the saved map: TrigScript itself, or — where its own build does not take the
    // script yet, or Magenta shares the map — the eudplib plugin, which then has to be running.
    const needsLibrary = programs > 0 && !svc.buildsOwn();
    const whyNotOwn = needsLibrary ? svc.whyNotOwn() : null;
    const libraryOk = !!library?.contribute && library.state() !== "failed";
    libraryItem.set(programs === 0 ? null : !needsLibrary ? {
      icon: "package",
      text: t("built by TrigScript"),
      title: t("The programs are laid out into the map by TrigScript itself when it is saved or tested: no eudplib, nothing downloaded, and the map is built in under a second"),
    } : {
      kind: libraryOk ? undefined : "warn",
      icon: libraryOk ? undefined : "warning",
      text: !library
        ? t("eudplib plugin not running")
        : !library.contribute
          ? t("eudplib plugin older than 0.4")
          : `eudplib ${library.versions.eudplib} · ${library.state() === "ready" ? t("runtime ready") : library.state() === "installing" ? t("runtime downloading…") : library.state() === "failed" ? t("runtime failed") : t("runtime downloads on the first save")}`,
      title: `${!library
        ? t("The programs will not be built: install or turn on the eudplib plugin under Plugins ▸ Manage Plugins…")
        : !library.contribute
          ? t("Update the eudplib plugin to build the programs")
          : t("The eudplib plugin builds the programs into the map when it is saved or tested; its runtime is downloaded once, the first time")}${whyNotOwn ? `\n${whyNotOwn}` : ""}`,
    });
    programsItem.set(programs ? { text: t("{n, plural, one {# program} other {# programs}} · Remastered", { n: programs }), title: t("Programs are built into the saved map, which then needs StarCraft: Remastered. Click for the programs and their variables"), onClick: () => { shell.toggleSidebar(true); programsSection.expand(); } } : null);

    renderFiles();
    renderPrograms();
    renderProblems();
    renderTesting();
    renderResults();
    renderSimulation();
    showStale();
    showRenames();
  };

  const applyResult = (r: CompileResult, asked?: TestRunOptions) => {
    diagnostics = r.diagnostics;
    result = r;
    if (r.ok) outline = { programs: r.programs, variables: r.variables };
    simulation = null;
    // A script with problems keeps what its tests last said; one that compiled says what they say now.
    if (r.ok) tests = mergeReport(tests, r.tests);
    // All of them took long: from now on only the open file's run by themselves, and the rest wait for Run All.
    if (r.ok && r.tests && asked && !asked.files && !asked.ids) testsSlow = r.tests.ms > TESTS_SLOW_MS;
    if (chosenTest && !tests.results.has(chosenTest)) chosenTest = null;
    if (editor && monaco) { setCompilerMarkers(monaco, files, diagnostics, allWarnings()); editor.setTests(marksOf(tests, t), notesOf(tests, t)); editor.decorate(r.buildTime); refreshLineHints(); }
    render();
  };

  /** What a compile is asked to run of the tests: every one, or, once that proved slow, the open file's. */
  const automaticTests = (): TestRunOptions => ({ world: svc.world(), ...(testsSlow ? { files: [editor?.active() ?? ENTRY_FILE] } : {}) });

  /** The locations the script can name, by key, for Ctrl+click and the hover. */
  const mapRefs = () => {
    if (!generated) return null;
    const scn = api.document.scenario();
    if (!scn) return null;
    const byKey = new Map<string, LocationRef>();
    for (const e of generated.names.locations.entries) {
      const index = e.value - 1;
      const l = scn.locations[index];
      if (!l) continue;
      const x0 = Math.min(l.left, l.right), x1 = Math.max(l.left, l.right), y0 = Math.min(l.top, l.bottom), y1 = Math.max(l.top, l.bottom);
      byKey.set(e.keys[0], { index, name: e.keys[1] ?? e.keys[0], x: Math.floor(x0 / 32), y: Math.floor(y0 / 32), w: Math.max(1, Math.round((x1 - x0) / 32)), h: Math.max(1, Math.round((y1 - y0) / 32)) });
    }
    return { object: generated.names.locations.object, byKey, open: (ref: LocationRef) => { api.view.goTo({ kind: "location", index: ref.index }); api.view.flash({ locations: [ref.index], kind: "attention" }); } };
  };

  /** Type-check, run and lower in the background; markers land in the editor, the list below. */
  const check = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled || !generated) return;
      const asked = automaticTests();
      svc.prepare(files, generated, asked).then(
        (a) => { if (!cancelled) applyResult(a.compiled, asked); },
        (err: Error) => { if (!cancelled && !(err instanceof CompileSuperseded)) setStatus("error", t("Compiler: {message}", { message: err.message })); },
      );
    }, CHECK_DELAY_MS);
  };

  /**
   * Compile what is in the editor right now, and hand back the artifact a build installs.
   * A keystroke during the compile supersedes it with the newer text's check; the newer
   * text is what the user wants built, so it is compiled again — a few times at most.
   */
  const compileNow = async (asked: TestRunOptions = automaticTests(), sounds = false): Promise<ScriptArtifact | null> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancelled || !generated) return null;
      try {
        const a = await svc.prepare(files, generated, asked, sounds);
        applyResult(a.compiled, asked);
        return a;
      } catch (err) {
        if (err instanceof CompileSuperseded) continue;
        setStatus("error", t("Compiler: {message}", { message: (err as Error).message }));
        return null;
      }
    }
    return null;
  };

  const refusal = (why: BuildRefusal | undefined): string => {
    switch (why) {
      case "closed": return t("Not applied: the map closed.");
      case "switched": return t("Not applied: another map is in front now.");
      case "changed": return t("Not applied: the map changed while the script was running. Apply again.");
      default: return t("Not applied.");
    }
  };

  /**
   * One compile, then that exact result installed — never a second run of the script,
   * whose output could differ from what the problems list and the summary show. The
   * service refuses the install when the map is not the one the compile was made for.
   */
  const build = async (takeOver = false): Promise<boolean> => {
    if (building || !ready) return false;
    building = true;
    setStatus("busy", t("Running the script…"));
    try {
      for (let attempt = 0; ; attempt++) {
        // (A build: the map gets its sounds, the long ones encoded now.)
        const a = await compileNow(automaticTests(), true);
        if (!a || cancelled) return false;
        if (!a.compiled.ok || diagnostics.length) {
          const n = diagnostics.length || a.compiled.diagnostics.length;
          setStatus("error", t("Not applied: {n, plural, one {# problem} other {# problems}} in the script.", { n }), NOTICE_MS);
          shell.showPanel("problems");
          return false;
        }
        const wasStale = svc.state()?.stale ?? false;
        setStatus("busy", t("Writing the triggers…"));
        const out = svc.install(a, { takeOver, replaceStale: wasStale && !appendInstead });
        if (out.block) {
          const b = out.block;
          const n = a.compiled.ir.length;
          const applied = b.count === 0
            ? (n ? t("Applied: the script defines no triggers.") : t("Applied: the script defines no triggers; its block is empty."))
            : out.replaced
              ? t("Applied {n, plural, one {# trigger} other {# triggers}} → #{first}–#{last} (replaced the previous block's {removed, plural, one {# unchanged trigger} other {# unchanged triggers}}; {kept, plural, one {# edited one} other {# edited ones}} kept after it).", { n: b.count, first: b.start + 1, last: b.start + b.count, removed: out.replaced.removed, kept: out.replaced.kept })
              : wasStale
                ? t("Applied {n, plural, one {# trigger} other {# triggers}} → #{first}–#{last} (appended: the previous block had been edited outside the script).", { n: b.count, first: b.start + 1, last: b.start + b.count })
                : t("Applied {n, plural, one {# trigger} other {# triggers}} → #{first}–#{last}.", { n: b.count, first: b.start + 1, last: b.start + b.count });
          const built = n ? ` ${t("{n, plural, one {The program is} other {The # programs are}} built into the map when it is saved or tested.", { n })}` : "";
          setStatus("ok", applied + built);
          return true;
        }
        // The names changed under the compile (a location renamed, a trigger added): once more against the new ones.
        if (out.refused === "changed" && attempt < 2) { setStatus("busy", t("The map changed while the script ran; running it again…")); continue; }
        setStatus("error", refusal(out.refused));
        return false;
      }
    } finally {
      building = false;
      render();
    }
  };

  /**
   * Play: the script applied, then the map exactly as Save would write it — the editor runs
   * the build steps, so the programs are in it — handed to Test Map (`api.document.test`):
   * on the desktop into the game's folder with the game started, in a browser into the
   * test folder picked once. Nothing is saved beside the map; the map's own file is what
   * Save writes.
   */
  const test = async () => {
    if (building || testing || !ready) return;
    testing = true;
    render();
    // The library's events say how the build of the programs went; the export itself falls back to the plain map without a word.
    let failure: string | null = null;
    const heard = svc.onBuild((e) => { if (e.kind === "failed") failure = e.from && e.from !== "trigscript" ? `${e.from}: ${e.message}` : e.message; });
    try {
      if (!(await build()) || cancelled) return;
      setStatus("busy", t("Building the map…"));
      const file = await api.document.export({ format: "scx" });
      if (!file) { setStatus("error", t("No map is open.")); return; }
      if (failure) { setStatus("error", t("Not tested: {message}", { message: failure })); return; }
      if (result?.programs.length && !svc.buildsOwn() && !library?.contribute) { setStatus("error", t("Not tested: the programs need the eudplib plugin (0.4 or newer) to be built. Install or turn it on under Plugins ▸ Manage Plugins….")); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const outcome = await api.document.test(bytes, file.name);
      const kb = Math.round(bytes.length / 1024);
      setStatus(outcome ? "ok" : "info", outcome?.launched
        ? t("Started the game with {path} ({kb} KB).", { path: outcome.path, kb })
        : outcome
          ? outcome.message
            ? t("Written to {path} ({kb} KB) — {message}.", { path: outcome.path, kb, message: outcome.message })
            : t("Written to {path} ({kb} KB).", { path: outcome.path, kb })
          : t("The map is built, but this browser has no test folder yet: pick one once under Tools ▸ Test Map…, which builds the map the same way."));
    } catch (err) {
      setStatus("error", t("Not tested: {message}", { message: (err as Error).message }));
    } finally {
      heard.dispose();
      testing = false;
      render();
    }
  };

  /** A build of the programs, whoever started it (Save, Test Map, Test): its state in the status bar, its log in Output, a failure on its line. */
  const onLibraryBuild = (e: EudplibBuildEvent) => {
    if (cancelled || (e.kind !== "log" && !e.contributors.includes("trigscript"))) return;
    if (e.kind === "start") {
      streamed = 0;
      shell.dismiss("build");
      buildState = { kind: "busy", text: e.purpose === "test" ? t("Building for Test Map…") : e.purpose === "save" ? t("Building for Save…") : t("Building for an export…"), of: files };
      log(e.purpose === "test" ? t("Building the programs for Test Map") : e.purpose === "save" ? t("Building the programs for Save") : t("Building the programs for an export"));
      // A failing test does not stop a build unless the map's settings say so: said, so the log of a build is the whole story.
      const failing = countTests(tests).failed;
      if (failing) log(t("{n, plural, one {A test fails} other {# tests fail}}: see the Testing view.", { n: failing }), false);
    } else if (e.kind === "log") {
      streamed++;
      // (What the lowering says for a run in the lifted game is not for a person to read.)
      if (!isMachineLine(e.line)) log(e.line, false);
    } else if (e.kind === "done") {
      if (!streamed && e.log) log(withoutMachineLines(e.log), false);
      // (TrigScript's own build takes tens of milliseconds, eudplib's seconds: said in the unit that reads.)
      const kb = Math.round(e.chkBytes / 1024), took = e.ms < 1000 ? t("{ms} ms", { ms: e.ms }) : t("{seconds} s", { seconds: (e.ms / 1000).toFixed(1) });
      buildState = { kind: "ok", text: t("Built {kb} KB · {took}", { kb, took }), of: buildState?.of ?? files };
      log(t("Built: {kb} KB of scenario in {took}", { kb, took }));
    } else {
      if (!streamed && e.log) log(withoutMachineLines(e.log), false);
      // Save goes on without the step: the file is the map and its script, with no programs in it.
      const saved = e.purpose === "save";
      buildState = {
        kind: "error", text: saved ? t("Saved without its programs") : t("Build failed"), of: buildState?.of ?? files,
        ...(saved ? { title: t("The map was saved with the script in it, but its programs were not built, so they do not run in the game. Fix the error and save again") } : {}),
      };
      log(t("Build failed: {message}", { message: e.message }));
      shell.notify({ key: "build", kind: "error", text: saved ? t("The map was saved without its programs, which were not built: {message}", { message: e.message }) : t("The programs were not built: {message}", { message: e.message }), actions: [{ label: t("Show the log"), run: () => shell.showPanel("output") }] });
      const at = positionIn(e.message);
      if (at) {
        // The lowering named a node of the IR: the error lands on its line like a compiler error.
        diagnostics = [...diagnostics, { file: at.file, line: at.line, column: at.column, endLine: at.line, endColumn: at.column + 1, message: e.message, source: "compiler" }];
        if (editor && monaco) setCompilerMarkers(monaco, files, diagnostics);
        goTo(at.file, at.line, at.column);
      }
    }
    render();
  };

  /** Move the hand-made triggers into the script (in their list order around the script's own) and rebuild from it. */
  const importHand = async () => {
    if (!editor || !generated) return;
    const { before, after } = svc.handTriggers();
    if (before.length + after.length === 0) { setStatus("info", t("There are no hand-made triggers to import.")); return; }
    const ctx = { names: generated.names, string: (i: number) => api.names.string(i) };
    const main = files[ENTRY_FILE] ?? "";
    const blank = main.trim() === "" || main === TEMPLATE;
    // Hand triggers keep their order around the script's own: those before the block go first, those after it last.
    const text = blank
      ? printScript([...before, ...after], ctx, { imports: true })
      : [
          before.length ? printScript(before, ctx, { header: "" }).trimStart() : "",
          main.replace(/\s+$/, "") + "\n",
          after.length ? printScript(after, ctx, { header: "" }).trimStart() : "",
        ].filter((s) => s !== "").join("\n");
    editor.set(ENTRY_FILE, text);
    openFile(ENTRY_FILE);
    files = { ...files, [ENTRY_FILE]: text };
    const ok = (await build(true)) !== false;
    const n = before.length + after.length;
    if (ok) setStatus("ok", t("Imported {n, plural, one {# hand-made trigger} other {# hand-made triggers}}; every trigger is now generated by the script.", { n }));
  };

  /**
   * What a simulated program finds on the map: the placed units, in the order the map has them, with
   * the hit points their type and their own percentage give, and the map's locations as boxes.
   */
  const simulatedMap = (): Pick<ProgramSimulationOptions, "units" | "locations" | "players" | "forces" | "unitStats" | "properties"> & { computers?: number[] } => {
    const scn = api.document.scenario();
    if (!scn) return {};
    const types = new Map<number, { hp: number; shields: number }>();
    const typeOf = (id: number) => {
      let ty = types.get(id);
      if (!ty) { const view = api.settings?.unitType(id); ty = { hp: view?.hitPoints ?? 1, shields: view?.shields ?? 0 }; types.set(id, ty); }
      return ty;
    };
    const part = (max: number, percent: number, valid: boolean) => (valid ? Math.max(1, Math.ceil((max * Math.min(100, percent)) / 100)) : max);
    const units: SimUnitInit[] = scn.units.filter((u) => u.unitId !== START_LOCATION_UNIT).map((u) => {
      const ty = typeOf(u.unitId);
      return {
        type: u.unitId, owner: u.owner, x: u.x, y: u.y,
        // validStates says which of a placed unit's own figures are set: 2 hit points, 4 shields, 64 the state flags.
        maxHp: ty.hp, hp: part(ty.hp, u.hitPointsPercent, (u.validStates & 2) !== 0),
        maxShields: ty.shields, shields: ty.shields ? part(ty.shields, u.shieldPercent, (u.validStates & 4) !== 0) : 0,
        resources: u.resourceAmount,
        ...((u.validStates & 64) !== 0 ? { cloaked: (u.stateFlags & 1) !== 0, burrowed: (u.stateFlags & 2) !== 0, hallucinated: (u.stateFlags & 8) !== 0, invincible: (u.stateFlags & 16) !== 0 } : {}),
      };
    });
    const locations: Record<number, SimBounds> = {};
    scn.locations.forEach((l, i) => { if (l.right > l.left || l.bottom > l.top) locations[i + 1] = { left: l.left, top: l.top, right: l.right, bottom: l.bottom }; });
    // Who is in the game: the map's human and computer players, each in the force the map puts them in.
    const players = scn.playerTypes.slice(0, 8).flatMap((type, slot) => (type === OWNER_HUMAN || type === OWNER_COMPUTER ? [slot] : []));
    const forces = Object.fromEntries(scn.forces.playerForce.slice(0, 8).map((force, slot) => [slot, force]));
    // A Create Unit with Properties slot is 1-based in the action.
    const properties: ProgramSimulationOptions["properties"] = (slot) => {
      const c = scn.cuwp?.[slot - 1];
      if (!c) return undefined;
      const state = (bit: number) => ((c.validProperties & bit) !== 0 ? (c.stateFlags & bit) !== 0 : undefined);
      return {
        hpPercent: c.validFields & 2 ? c.hitPointsPercent : undefined, shieldPercent: c.validFields & 4 ? c.shieldsPercent : undefined,
        energyPercent: c.validFields & 8 ? c.energyPercent : undefined, resources: c.validFields & 16 ? c.resources : undefined,
        cloaked: state(1), burrowed: state(2), hallucinated: state(8), invincible: state(16),
      };
    };
    const computers = scn.playerTypes.slice(0, 8).flatMap((type, slot) => (type === OWNER_COMPUTER ? [slot] : []));
    return { units, locations, ...(players.length ? { players, forces, computers } : {}), unitStats: (id) => typeOf(id), properties };
  };

  /** Run the compiled triggers through the trigger-cycle interpreter and show what happened. */
  const simulateNow = async () => {
    const r = (await compileNow())?.compiled;
    if (!r) return;
    if (!r.ok) { setStatus("error", t("Not simulated: {n, plural, one {# problem} other {# problems}} in the script.", { n: r.diagnostics.length }), NOTICE_MS); shell.showPanel("problems"); return; }
    try {
      // The programs run from the IR; the trigger() records through the trigger interpreter, sharing one world.
      // One world for both: the map's units, locations and players.
      const { unitStats, ...map } = simulatedMap();
      const owner = r.programs[0]?.owner;
      const player = owner !== undefined && owner < 12 && (!map.players || map.players.includes(owner)) ? owner : map.players?.[0] ?? owner;
      // On the game's schedule: a pass every 31 frames, sooner when a Wait runs out; a script with a program is built
      // with eudTurbo, a pass every frame, and its programs run inside the passes.
      const sim = new Simulation(r.triggers, { strings: r.strings, player, unitStats, everyFrame: r.ir.length > 0, ...map });
      const programs = r.ir.length ? new ProgramSimulation(r.ir, { world: sim, strings: r.strings, player, heapCells: svc.settings().heapCells, stackDepth: svc.settings().stackDepth, unitStats }) : null;
      for (let i = 0; i < SIMULATE_FRAMES; i++) if (sim.tick()) programs?.step();
      simulation = { sim, programs, result: r };
      const count = sim.events.length + (programs?.events.length ?? 0);
      // Nobody presses a key in a simulation: said, so that a program waiting for one is not taken for broken.
      const quiet = r.input ? ` ${t("Keys, clicks, the mouse and chat are not simulated: they read as nothing.")}` : "";
      const faults = programs?.faults.length ?? 0;
      const wrong = faults ? ` ${t("{n, plural, one {# fault} other {# faults}}: an array read or written past its end, or out of memory — first in the list.", { n: faults })}` : "";
      const who = sim.game.players.slots.map((p) => `P${p + 1}`).join(", ");
      setStatus("ok", `${t("Simulated {frames} frames for {who}: {n, plural, one {# action} other {# actions}} ran.", { frames: SIMULATE_FRAMES, who, n: count })}${wrong}${quiet}`);
      shell.showPanel("simulate");
    } catch (err) {
      setStatus("error", t("Simulation stopped: {message}", { message: (err as Error).message }));
    }
  };

  /* ── The map ── */

  /** The script is the map's: the other way of showing it, at the same place in the text. */
  const switchMode = () => {
    const at = editor?.cursor();
    openScriptEditor(svc, { dock: mode === "dialog", file: at?.file, line: at?.line });
  };

  /**
   * Click a location or a unit on the map: its name lands at the cursor. A dialog covers
   * the map, so from the dialog this first moves the workspace beside the map.
   */
  const pickFromMap = async () => {
    if (!editor || !generated || picking) return;
    if (mode === "dialog") { const at = editor.cursor(); openScriptEditor(svc, { dock: true, file: at.file, line: at.line, pick: true }); return; }
    picking = true;
    render();
    try {
      const picked = await api.ui.pickObject({ prompt: t("Click a location or a unit for the script") });
      if (cancelled || !picked || !editor) return;
      const scn = api.document.scenario();
      const table = picked.kind === "unit" ? generated.names.units : generated.names.locations;
      const value = picked.kind === "unit" ? scn?.units[picked.index]?.unitId : picked.index + 1;
      const entry = value === undefined ? undefined : entryFor(table, value);
      if (!entry) { setStatus("info", picked.kind === "unit" ? t("That unit's type has no name in the script's tables.") : t("That location is not in the script's tables yet; try again after the map's names refresh.")); return; }
      editor.insert(`${table.object}.${entry.keys[0]}`);
      setStatus("ok", t("Inserted {name}.", { name: `${table.object}.${entry.keys[0]}` }));
    } finally {
      picking = false;
      render();
    }
  };

  /** The map renamed things the script names: after the user says so, the references follow — the checker's, from a compile of the text as it is now. */
  const applyRenames = async () => {
    if (!editor) return;
    const a = await compileNow();
    if (!a || cancelled || !editor) return;
    let next = files;
    let count = 0;
    for (const r of renames) {
      const done = replaceReferences(next, a.compiled.refs, r.object, r.list);
      next = done.files;
      count += done.count;
    }
    for (const [path, text] of Object.entries(next)) if (text !== files[path]) editor.set(path, text);
    files = next;
    renames = [];
    svc.writeFiles(files);
    setStatus("ok", t("Updated {n, plural, one {# reference} other {# references}}.", { n: count }));
    check();
  };

  /* ── Files ── */

  /** A file's name asked for until it can be one. Inside `folder` the answer is a name in it (`boss.ts`, or `big/boss.ts` for a folder under it). */
  const askName = async (message: string, value: string, folder = "", ext = ".ts"): Promise<string | null> => {
    for (;;) {
      const answer = await api.ui.prompt(message, { title: "TrigScript", value, placeholder: "helpers.ts" });
      if (answer === null) return null;
      let name = normalizePath(answer.trim());
      if (name && folder) name = `${folder}/${name}`;
      if (name && !/\.(?:tsx?|video|image|sound|notes)$/i.test(name)) name += ext;
      if (!FILE_NAME.test(name) || name.split("/").some((p) => p === "." || p === "..")) { value = answer; message = t("A file name is letters, digits, _ - and ., folders with /, ending in .ts."); continue; }
      if (files[name] !== undefined) { value = answer; message = t("There is already a {name}.", { name }); continue; }
      return name;
    }
  };

  const newFile = async (folder = "") => {
    if (!editor) return;
    // In a folder called tests, what is wanted is a test of the file that is open.
    const open = editor.active();
    const proposed = /(^|\/)tests?$/i.test(folder) ? `${(open.split("/").pop() ?? "main.ts").replace(/(\.test)?\.ts$/i, "")}.test.ts` : "helpers.ts";
    const name = await askName(folder ? t("Name of the new file in {folder}/:", { folder }) : t("Name of the new file (folder/name.ts puts it in a folder):"), proposed, folder);
    if (!name) return;
    if (folder && collapsed.has(folder)) { const next = new Set(collapsed); next.delete(folder); setCollapsed(next); }
    editor.add(name, isTestFile(name) ? TEST_TEMPLATE : FILE_TEMPLATE);
    openFile(name);
  };

  /**
   * Import Video…: a video becomes a .video file of the script, a sound a .sound file, a picture an .image file or a .ts file of its rows
   * (`videoImport.ts`). Rows open in a tab; a video or an image says how a script imports it.
   */
  const importVideo = async (file?: File) => {
    if (!editor) return;
    const info = api.document.info();
    const got = await importMedia(api, t, { mapWidth: info?.width ?? 128, mapHeight: info?.height ?? 128, taken: (p) => files[normalizePath(p)] !== undefined, file });
    if (!got || !editor || cancelled) return;
    editor.add(got.path, got.text);
    if (got.kind === "rows") { openFile(got.path); return; }
    renderFiles();
    const stem = (got.path.split("/").pop() ?? got.path).replace(/\.(?:video|image|sound|notes)$/i, "");
    const name = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_]+/, "") || got.kind;
    setStatus("ok", got.kind === "notes"
      ? t("{path} is in the script: import {name} from \"./{path}\"; then music.midi({name}, { … }) makes a song of its tracks.", { path: got.path, name })
      : got.kind === "sound"
      ? t("{path} is in the script: import {name} from \"./{path}\"; then playWav({name}) plays it inside a program.", { path: got.path, name })
      : got.kind === "image"
      ? t("{path} is in the script: import {name} from \"./{path}\"; then fog.picture({name}.threshold(128)) makes a picture of it.", { path: got.path, name })
      : t("{path} is in the script: import {name} from \"./{path}\"; then await fog.play(P1, {name}) plays it.", { path: got.path, name }));
  };

  /** An archive has no empty folder, so a folder is there while a file is in it: the folder's name, then its first file's. */
  const newFolder = async (parent = "") => {
    if (!editor) return;
    let message = parent ? t("Name of the new folder in {folder}/:", { folder: parent }) : t("Name of the new folder:");
    let value = "tests";
    for (;;) {
      const answer = await api.ui.prompt(message, { title: "TrigScript", value, placeholder: "tests" });
      if (answer === null) return;
      const name = normalizePath(answer.trim()).replace(/\/+$/, "");
      if (!validFolder(name)) { value = answer; message = t("A folder name is letters, digits, _ - and ., folders inside it with /."); continue; }
      await newFile(parent ? `${parent}/${name}` : name);
      return;
    }
  };

  /**
   * Files go where `moves` says and every import that named one of them, and the moved
   * files' own, are rewritten to match. One change to the user, whatever it touched: the
   * notification's Undo moves everything back, imports with it.
   */
  const moveFiles = (moves: Moves, undo = false) => {
    if (!editor || moves.size === 0) return;
    const refused = refuseMoves(Object.keys(files), moves, t);
    if (refused) { setStatus("error", refused); return; }
    const moved = applyMoves(files, moves);
    // Before the models change: a model's change is written into `files` by its path.
    files = moved.files;
    for (const [from, to] of moves) editor.rename(from, to);
    for (const path of moved.edited) editor.set(path, moved.files[path]);
    openTabs = openTabs.map((p) => moves.get(p) ?? p);
    svc.writeFiles(files);
    renderFiles();
    check();
    const [[from, to]] = [...moves];
    const what = moves.size === 1 ? t("{from} is now {to}", { from, to }) : t("{n} files moved", { n: moves.size });
    const text = moved.imports ? t("{what}; {n, plural, one {# import} other {# imports}} rewritten.", { what, n: moved.imports }) : `${what}.`;
    log(text);
    if (undo) { shell.dismiss("move"); return; }
    const back = new Map([...moves].map(([a, b]) => [b, a]));
    shell.notify({ key: "move", kind: "info", text, timeout: NOTICE_MS * 2, actions: [{ label: t("Undo"), run: () => moveFiles(back, true) }] });
  };

  /** A file or a folder to where it was dragged, or renamed to. */
  const moveTo = (from: string, to: string) => {
    if (!editor || from === to) return;
    moveFiles(movesOf(Object.keys(files), from, to));
  };

  const renameFile = async (path: string) => {
    if (!editor || path === ENTRY_FILE) return;
    const name = await askName(t("Rename {path} to (a folder before the name moves it):", { path }), path, "", isMediaFile(path) ? (isImageFile(path) ? ".image" : isSoundFile(path) ? ".sound" : isNotesFile(path) ? ".notes" : ".video") : ".ts");
    if (!name) return;
    moveTo(path, name);
  };

  const renameFolder = async (folder: string) => {
    if (!editor) return;
    let message = t("Rename the folder {folder} to (its files go with it, and the imports follow):", { folder });
    let value = folder;
    for (;;) {
      const answer = await api.ui.prompt(message, { title: "TrigScript", value, placeholder: folder });
      if (answer === null) return;
      const name = normalizePath(answer.trim()).replace(/\/+$/, "");
      if (!validFolder(name)) { value = answer; message = t("A folder name is letters, digits, _ - and ., folders inside it with /."); continue; }
      if (name === folder) return;
      const moves = movesOf(Object.keys(files), folder, name);
      const refused = refuseMoves(Object.keys(files), moves, t);
      if (refused) { value = answer; message = refused; continue; }
      if (collapsed.has(folder)) { const next = new Set(collapsed); next.delete(folder); next.add(name); setCollapsed(next); }
      moveFiles(moves);
      return;
    }
  };

  const removeFiles = (paths: string[]) => {
    if (!editor) return;
    const next = { ...files };
    for (const path of paths) { editor.remove(path); delete next[path]; }
    files = next;
    svc.writeFiles(files);
    renderFiles();
    check();
  };

  const removeFile = async (path: string) => {
    if (!editor || path === ENTRY_FILE) return;
    if (!(await api.ui.confirm(t("Remove {path} from the script? Its text is not kept anywhere else.", { path }), { title: "TrigScript", confirmLabel: t("Remove"), danger: true }))) return;
    removeFiles([path]);
  };

  const removeFolder = async (folder: string) => {
    if (!editor) return;
    const under = filesUnder(Object.keys(files), folder);
    if (under.includes(ENTRY_FILE)) return;
    if (!(await api.ui.confirm(t("Remove the folder {folder} and {n, plural, one {the file} other {the # files}} in it? Their text is not kept anywhere else.", { folder, n: under.length }), { title: "TrigScript", confirmLabel: t("Remove"), danger: true }))) return;
    removeFiles(under);
  };

  /** The map's names changed under the open editor: refresh the declarations, and notice what was renamed. */
  const refreshNames = () => {
    if (cancelled) return;
    const before = generated;
    generated = svc.names();
    if (before && generated) {
      for (const table of ["locations", "switches"] as const) {
        const object = generated.names[table].object;
        const list = renamesInUse(result?.refs ?? [], object, renamedKeys(before.names[table], generated.names[table]));
        if (list.length === 0) continue;
        const slot = renames.find((r) => r.object === object);
        if (slot) slot.list = [...slot.list.filter((x) => !list.some((y) => y.value === x.value)), ...list];
        else renames.push({ object, list });
      }
    }
    if (monaco && generated) setDeclarations(monaco, generated.decls);
    render();
    check();
  };

  const reveal = (file?: string, line?: number) => { if (line) goTo(file ?? ENTRY_FILE, line); else if (file) openFile(file); };

  /* ── Commands ── */

  /** Everything the workspace does, once: the keys, the More menu and Monaco's command palette are all read from here. */
  interface Command { id: string; label: string; key?: { code: string; mod?: boolean; shift?: boolean }; context?: boolean; run(): void; when?: () => boolean }
  /** While a test is debugged, its keys come before the others (F5 continues rather than plays). */
  const debugging = () => debug.active;
  const commands: Command[] = [
    { id: "debugContinue", label: t("Debug: Continue"), key: { code: "F5" }, when: debugging, run: () => debug.continueForward() },
    { id: "debugContinueBack", label: t("Debug: Continue Backwards"), key: { code: "F6" }, when: debugging, run: () => debug.continueBack() },
    { id: "debugStep", label: t("Debug: On a Line"), key: { code: "F10" }, when: debugging, run: () => debug.stepForward() },
    { id: "debugStepBack", label: t("Debug: Back a Line"), key: { code: "F10", shift: true }, when: debugging, run: () => debug.stepBack() },
    { id: "debugFrame", label: t("Debug: On a Frame"), key: { code: "F11" }, when: debugging, run: () => debug.nextFrame() },
    { id: "debugFrameBack", label: t("Debug: Back a Frame"), key: { code: "F11", shift: true }, when: debugging, run: () => debug.prevFrame() },
    { id: "debugStop", label: t("Debug: Stop"), key: { code: "F5", shift: true }, when: debugging, run: () => debug.end() },
    { id: "debugTestAtCursor", label: t("Debug Test at Cursor in the Game"), context: true, run: () => debugTestAtCursor() },
    { id: "toggleBreakpoint", label: t("Toggle Breakpoint"), key: { code: "F9" }, run: () => { const at = editor?.cursor(); if (at) debug.toggleBreakpoint(normalizePath(at.file), at.line); } },
    // The editor's own Ctrl+S does not reach a map under a dialog, and a browser would offer to save the page.
    { id: "save", label: t("Save the Map"), key: { code: "KeyS", mod: true }, run: () => { void api.document.save(); } },
    { id: "test", label: t("Play the Map"), key: { code: "F5" }, run: () => { void test(); } },
    { id: "runTests", label: t("Run All Tests"), run: () => { void runTests(); } },
    { id: "runTestsInGame", label: t("Run All Tests in the Game"), run: () => { void runTestsInGame(); } },
    { id: "findEudError", label: t("Find an EUD Error…"), run: () => { void lookUpEudError(); } },
    { id: "runTestAtCursor", label: t("Run Test at Cursor"), context: true, run: () => { void runTestAtCursor(); } },
    { id: "runFailedTests", label: t("Run Failed Tests"), run: () => { void runFailedTests(); } },
    { id: "testing", label: t("Show Testing"), run: () => testingView.show() },
    { id: "simulate", label: t("Simulate"), key: { code: "F5", mod: true }, run: () => { void simulateNow(); } },
    { id: "apply", label: t("Apply the Script to the Map"), key: { code: "KeyB", mod: true, shift: true }, run: () => { void build(); } },
    { id: "pick", label: t("Pick a Location or Unit from the Map"), context: true, run: () => { void pickFromMap(); } },
    { id: "import", label: t("Import the Map's Triggers"), run: () => { void importHand(); } },
    { id: "newFile", label: t("New File…"), run: () => { void newFile(); } },
    { id: "newFolder", label: t("New Folder…"), run: () => { void newFolder(); } },
    { id: "importVideo", label: t("Import Video…"), run: () => { void importVideo(); } },
    { id: "mode", label: mode === "dialog" ? t("Open Beside the Map") : t("Open in a Window"), run: () => switchMode() },
    { id: "problems", label: t("Show Problems"), key: { code: "KeyM", mod: true, shift: true }, run: () => shell.togglePanel("problems") },
    { id: "output", label: t("Show Output"), key: { code: "KeyU", mod: true, shift: true }, run: () => shell.togglePanel("output") },
    { id: "settings", label: t("Open Settings"), key: { code: "Comma", mod: true }, run: () => { shell.showPanel("settings"); renderSettings(); } },
    { id: "panel", label: t("Toggle Panel"), key: { code: "KeyJ", mod: true }, run: () => shell.togglePanel() },
    { id: "explorer", label: t("Toggle Explorer"), key: { code: "KeyB", mod: true }, run: () => shell.toggleSidebar() },
  ];
  const keysOf = (c: Command) => (c.key ? `${c.key.mod ? `${MOD}+` : ""}${c.key.shift ? "Shift+" : ""}${c.key.code.replace(/^Key/, "")}` : undefined);
  const menuItem = (id: string) => {
    const c = commands.find((x) => x.id === id)!;
    return { label: c.label, keys: keysOf(c), disabled: !ready, run: c.run };
  };
  const palette = () => { editor?.editor.focus(); editor?.editor.trigger("trigscript", "editor.action.quickCommand", null); };

  /**
   * The keys, wherever in the workspace the focus is — the Explorer, the panel, Monaco.
   * Taken on the way down and stopped, so neither Monaco (which knows the same keys, for
   * the palette to list) nor the editor's own hotkeys act on them a second time.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    // F1 is the editor's list of shortcuts outside the workspace; inside it, it is the palette, as it is in VS Code.
    const c = (mod && e.shiftKey && e.code === "KeyP") || (!mod && !e.shiftKey && e.code === "F1")
      ? { run: palette }
      : commands.find((x) => x.key && x.key.code === e.code && !!x.key.mod === mod && !!x.key.shift === e.shiftKey && (!x.when || x.when()));
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    if (ready) c.run();
  };
  root.addEventListener("keydown", onKey, true);

  const attach = (close: () => void) => {
    render();
    // Monaco comes from the CDN on first open, which can take a while: the editor's box says so.
    const loadingCover = w.busy(hostEl, t("Loading the editor…"));
    // Checks run on every keystroke (debounced), so the compile worker stays up while the editor is open.
    const releaseWorker = retainCompileWorker();
    const subs = [
      svc.watchLibrary((s) => { library = s; if (!cancelled) render(); }),
      svc.onBuild(onLibraryBuild),
      api.events.on("settings", refreshNames),
      api.events.on("locations", refreshNames),
      api.events.on("triggers", refreshNames),
      // The script belongs to the map: another map, or none, closes the workspace.
      api.events.on("document", () => close()),
    ];
    loadMonaco(svc.dist()).then(
      (m) => {
        if (cancelled) return;
        monaco = m;
        if (generated) setDeclarations(m, generated.decls);
        setHoverVariables(m, () => result?.variables ?? []);
        setLineHints(m, () => [...(result?.hints ?? []), ...costHints(), ...eudHints(), ...debug.hints()]);
        setMapRefs(m, mapRefs);
        // Uncover first: `done` puts the host back in its own place, and Monaco measures it where it lands.
        loadingCover.done();
        // Monaco's stylesheet brought the icons' font.
        shell.ready();
        editor = createScriptEditor(m, hostEl, files, options.file ?? ENTRY_FILE, (path, text) => {
          files = { ...files, [path]: text };
          svc.writeFiles(files);
          debug.setFiles(files);
          check();
        }, (id) => { void runTests({ ids: [id] }); }, (file, line) => debug.toggleBreakpoint(file, line));
        debug.setFiles(files);
        editor.setDebug(debug.marks());
        const code = editor.editor;
        for (const c of commands) {
          code.addAction({
            id: `trigscript.${c.id}`,
            label: `TrigScript: ${c.label}`,
            // (A key that only means something while debugging is the workspace's to hear, not Monaco's.)
            keybindings: c.key && !c.when ? [(c.key.mod ? m.KeyMod.CtrlCmd : 0) | (c.key.shift ? m.KeyMod.Shift : 0) | m.KeyCode[c.key.code as keyof typeof m.KeyCode]] : undefined,
            ...(c.context ? { contextMenuGroupId: "navigation", contextMenuOrder: 9 } : {}),
            run: () => c.run(),
          });
        }
        code.onDidChangeCursorPosition(renderCursor);
        code.onDidChangeModel(() => { renderFiles(); renderCursor(); });
        // Go to Definition on a name another file exports goes to that file, in its tab.
        subs.push(m.editor.registerEditorOpener({
          openCodeEditor(_source, resource, at) {
            const path = normalizePath(resource.path.replace(/^\/+/, ""));
            if (resource.scheme !== "file" || files[path] === undefined) return false;
            const line = at ? ("startLineNumber" in at ? at.startLineNumber : at.lineNumber) : 1;
            const column = at ? ("startColumn" in at ? at.startColumn : at.column) : 1;
            goTo(path, line, column);
            return true;
          },
        }));
        renderCursor();
        // A fresh script's template is the map's from now on.
        if (fresh) svc.writeFiles(files);
        reveal(options.file, options.line);
        editor.editor.focus();
        ready = true;
        render();
        check();
        if (options.pick) void pickFromMap();
      },
      (err: Error) => { if (!cancelled) { loadingCover.done(); failed = true; setStatus("error", t("The editor failed to load: {message}", { message: err.message })); } },
    );
    return () => {
      cancelled = true;
      loadingCover.done();
      if (timer !== null) clearTimeout(timer);
      if (statusTimer !== null) clearTimeout(statusTimer);
      root.removeEventListener("keydown", onKey, true);
      debug.end();
      shell.dispose();
      editor?.dispose();
      editor = null;
      if (monaco) releaseScriptEditor(monaco);
      releaseWorker();
      for (const s of subs) s.dispose();
      if (current && !current.isOpen()) current = null;
    };
  };

  return {
    root,
    attach,
    reveal,
    cursor: () => editor?.cursor() ?? null,
  };
}
