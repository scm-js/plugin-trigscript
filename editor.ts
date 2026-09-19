/**
 * The TrigScript workspace: Monaco over the map's script files, checked live against
 * declarations generated from the map (`compiler/declarations.ts`) and compiled — run —
 * in the worker (`compile.ts`). Apply writes the script's `trigger()` records into the
 * trigger list as its block (`service.ts`); saving or testing the map does the same by
 * itself, and that is also when the programs are built — into the file, by the eudplib
 * plugin. Test does both and hands the result to Test Map.
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
import { CompileSuperseded, retainCompileWorker } from "./compile";
import { ENTRY_FILE, normalizePath, type CompileResult, type ScriptDiagnostic, type ScriptFiles, type TriggerSource } from "./compiler/compiler";
import { HEAP_CELLS, HEAP_CELLS_MAX, HEAP_CELLS_MIN, STACK_CELLS_MAX, STACK_DEPTH, STACK_DEPTH_MAX, STACK_DEPTH_MIN, heapCells, stackDepth } from "./compiler/ir";
import { largestFrame } from "./compiler/recursion";
import { entryFor } from "./compiler/names";
import { printScript } from "./compiler/print";
import { Simulation, type SimulationEvent } from "./compiler/simulate";
import { actionDef } from "./vendor/triggerDefs";
import { PlayerGroup } from "./vendor/triggers";
import {
  BUILD_TIME_CLASS, createScriptEditor, loadMonaco, refreshLineHints, releaseScriptEditor, setCompilerMarkers, setLineHints, setDeclarations, setHoverVariables, setMapRefs,
  type LocationRef, type MonacoApi, type ScriptEditor,
} from "./monaco";
import { renamedKeys, renamesInUse, replaceReferences, type Renamed } from "./refs";
import { FILE_NAME, type ScriptSettings } from "./script";
import { ProgramSimulation, type ProgramEvent, type ProgramSimulationOptions, type SimBounds, type SimUnitInit } from "./compiler/simulateIr";
import { positionIn, type BuildRefusal, type MapNames, type ScriptArtifact, type ScriptService } from "./service";
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, SHELL_STYLE, createShell, type ShellLayout } from "./shell";
import type { EudplibBuildEvent, EudplibService } from "./vendor/eudplib";

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
// A map with a program is built by the eudplib plugin when you save it, and needs
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

/** Frames the Simulate button runs. */
/** Twenty seconds of the game at Fastest. */
export const SIMULATE_FRAMES = 480;
/** Start Location: a marker of the map, not a unit of the game. */
const START_LOCATION_UNIT = 214;
/** How many of a simulation's events the list shows before it says how many more there were. */
const SIMULATE_ROWS = 200;
/** The most lines with a fault the Simulate view lists. */
const SIMULATE_FAULTS = 20;

const CHECK_DELAY_MS = 350;
/** Lines the Output view keeps. */
const OUTPUT_LINES = 2000;
/** How long a good outcome stays in the status bar, and an answer in the corner. */
const STATUS_MS = 10_000;
const NOTICE_MS = 8_000;
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
.tsd .tsd-settings input:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
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
.${BUILD_TIME_CLASS} { text-decoration: underline dotted rgba(153, 162, 179, 0.55); text-underline-offset: 3px; }
`;

/** "P1", "all players", "Force 2", "P1, P2" — who a program runs for. */
function ownerLabel(p: { owners: number[] }): string {
  return p.owners.map((o) => (o === PlayerGroup.AllPlayers ? "all players" : o >= PlayerGroup.Force1 && o <= PlayerGroup.Force4 ? `Force ${o - PlayerGroup.Force1 + 1}` : `P${o + 1}`)).join(", ");
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
  if (!api.document.isOpen()) { api.ui.toast({ kind: "info", title: "Open or create a map first." }); return; }
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
  /** Test is under way: the script applied, the map built as Save would, handed to Test Map. */
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
  });
  const root = shell.root;
  root.prepend(el("style", undefined, STYLE));
  const hostEl = shell.editorHost;

  const testAction = shell.action({ icon: "play", title: `Test (F5): apply the script, build the map as Save would and hand it to Test Map`, run: () => { void test(); } });
  const simulateAction = shell.action({ icon: "beaker", title: `Simulate (${MOD}+F5): run the script's triggers and programs for ${SIMULATE_FRAMES} frames (${SIMULATE_FRAMES / 24} seconds of the game) in a built-in interpreter and list what happened`, run: () => { void simulateNow(); } });
  const applyAction = shell.action({ icon: "check", title: `Apply (${MOD}+Shift+B): run the script and write its triggers into the map now. Saving and testing the map do this by themselves; programs are built into the saved file, not into the trigger list`, run: () => { void build(); } });
  const pickAction = shell.action({ icon: "target", title: "Pick from map: click a location or a unit on the map to put its name at the cursor", run: () => { void pickFromMap(); } });
  shell.action(mode === "dialog"
    ? { icon: "multiple-windows", title: "Beside the map: open the script as a panel, so the map stays in reach", run: () => switchMode() }
    : { icon: "screen-full", title: "In a window: open the script full-screen", run: () => switchMode() });
  const moreAction = shell.action({ icon: "ellipsis", title: "More actions…", run: () => shell.menu(moreAction.element, [
    menuItem("save"),
    null,
    ...["import", "newFile"].map(menuItem),
    null,
    ...["problems", "output", "panel", "explorer"].map(menuItem),
    null,
    menuItem("settings"),
    null,
    { label: "Command Palette…", keys: "F1", disabled: !ready, run: () => palette() },
  ]) });

  const fileList = el("ul", { className: "tsd-rows" });
  shell.section({ title: "Script", actions: [{ icon: "new-file", title: "New file…: main.ts imports it with import { … } from \"./name\"", run: () => { void newFile(); } }] }).body.append(fileList);
  const programList = el("ul", { className: "tsd-rows" });
  const programsSection = shell.section({ title: "Programs" });
  programsSection.body.append(programList);
  programsSection.setHidden(true);

  const problemsView = shell.view({ id: "problems", title: "Problems" });
  const outputEl = el("pre", { className: "tsd-output" });
  const outputView = shell.view({ id: "output", title: "Output", onShow: () => renderOutput(true), actions: [{ icon: "clear-all", title: "Clear the output", run: () => { output = []; renderOutput(); } }] });
  const simulateView = shell.view({ id: "simulate", title: "Simulate" });
  const settingsView = shell.view({ id: "settings", title: "Settings", onShow: () => renderSettings() });

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
    const row = (o: { key: keyof ScriptSettings; min: number; max: number; step: number; normal: number; fit: (v: unknown) => number; said: (now: number) => string }) => {
      const now = settings[o.key];
      const input = el("input", { type: "number", min: String(o.min), max: String(o.max), step: String(o.step), value: String(now), disabled: !open }) as HTMLInputElement;
      const reset = el("button", { type: "button", disabled: !open || now === o.normal }, `Default (${count(o.normal)})`) as HTMLButtonElement;
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
    // What a call deep costs this script: the largest frame any of its functions keeps, as it was last compiled.
    const frame = result?.ok ? largestFrame(result.ir) : 0;
    const stack = (depth: number) => {
      if (!frame) return "calls deep — no function of this script calls itself";
      const cells = frame * depth;
      return `calls deep — ${frame} cells a call here, ${size(cells)} while the map is played${cells > STACK_CELLS_MAX ? `: more than the ${size(STACK_CELLS_MAX)} a map may use, and it will not build` : ""}`;
    };
    settingsView.body.replaceChildren(el("div", { className: "tsd-settings" },
      el("h4", {}, "Memory for arrays that grow"),
      el("p", {}, "Arrays a program pushes to share one pool of cells; this is its size. A single array can reach between a quarter and a half of it. When the pool runs out, nothing more is pushed and the game says so once."),
      row({ key: "heapCells", min: HEAP_CELLS_MIN, max: HEAP_CELLS_MAX, step: 1024, normal: HEAP_CELLS, fit: heapCells, said: (now) => `cells — ${size(now)} of the built map` }),
      el("p", {}, `${count(HEAP_CELLS_MIN)} to ${count(HEAP_CELLS_MAX)} cells, four bytes each. A larger pool does not slow the game and hardly grows the saved file; it takes more memory while the map is played. Kept in the map, so it builds the same on any computer.`),
      el("h4", {}, "Recursion depth"),
      el("p", {}, "How many calls deep a function that calls itself may go. Around each such call the function's variables are kept on a stack, which is only in the built map when some function calls itself. A call past the limit stops the program, and the game says where; Simulate stops at the same call."),
      row({ key: "stackDepth", min: STACK_DEPTH_MIN, max: STACK_DEPTH_MAX, step: 256, normal: STACK_DEPTH, fit: stackDepth, said: stack }),
      el("p", {}, `${count(STACK_DEPTH_MIN)} to ${count(STACK_DEPTH_MAX)} calls. The limit costs nothing until it is reached, but each call deep keeps and brings back every variable of its function, so thousands of calls within one frame make the game stutter. Kept in the map, like the pool above.`),
    ));
  }

  const problemsItem = shell.statusItem("left");
  const blockItem = shell.statusItem("left");
  const staleItem = shell.statusItem("left");
  const renamesItem = shell.statusItem("left");
  const messageItem = shell.statusItem("left");
  const buildItem = shell.statusItem("right");
  const libraryItem = shell.statusItem("right");
  const programsItem = shell.statusItem("right");
  const cursorItem = shell.statusItem("right");

  /** The files with a tab, in the order they were opened. */
  let openTabs: string[] = [normalizePath(options.file ?? ENTRY_FILE)];
  /** What Apply, Test and the builds of the programs reported, oldest first. */
  let output: string[] = [];
  /** The last build of the programs (Save, Test Map or Test ran it), for the status bar. */
  let buildState: { kind: "busy" | "ok" | "error"; text: string } | null = null;
  /** Lines the build under way has streamed; a build that streams none hands its log over at the end. */
  let streamed = 0;

  /** The log, kept at its end unless the user has scrolled up to read. */
  const renderOutput = (toEnd = false) => {
    if (output.length === 0) { outputView.body.replaceChildren(el("div", { className: "tsd-empty" }, "What Apply, Test and the builds of the programs report is kept here.")); return; }
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

  const where = (s: TriggerSource | null | undefined) => (s ? (Object.keys(files).length > 1 ? `${s.file}:${s.line}` : `Ln ${s.line}`) : "?");

  /** Show a file, in a tab of its own. */
  const openFile = (path: string) => {
    if (!editor) return;
    const p = normalizePath(path);
    if (files[p] === undefined) return;
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

  const renderFiles = () => {
    const active = editor?.active() ?? openTabs[0] ?? ENTRY_FILE;
    const paths = Object.keys(files).sort((a, b) => (a === ENTRY_FILE ? -1 : b === ENTRY_FILE ? 1 : a.localeCompare(b)));
    const broken = new Map<string, number>();
    for (const d of diagnostics) { const p = normalizePath(d.file); broken.set(p, (broken.get(p) ?? 0) + 1); }
    openTabs = openTabs.filter((p) => files[p] !== undefined);
    if (!openTabs.includes(active)) openTabs.push(active);
    shell.setTabs(openTabs.map((p) => ({ id: p, label: p.split("/").pop() ?? p, title: p, problems: broken.get(p), closable: openTabs.length > 1 })), active);
    fileList.replaceChildren(...paths.map((path) => el("li", { className: path === active ? "tsd-row tsd-active" : "tsd-row", title: path, onClick: () => openFile(path) },
      el("span", { className: "tsd-ts" }, "TS"),
      el("span", { className: broken.has(path) ? "tsd-name tsd-problem" : "tsd-name" }, path),
      el("span", { className: "tsd-row-actions" },
        path !== ENTRY_FILE ? shell.iconButton({ icon: "edit", title: "Rename…", run: () => { void renameFile(path); } }).element : undefined,
        path !== ENTRY_FILE ? shell.iconButton({ icon: "trash", title: "Remove…", run: () => { void removeFile(path); } }).element : undefined,
        broken.has(path) ? el("span", { className: "tsd-count" }, String(broken.get(path))) : undefined,
      ),
    )));
  };

  const typeOf = (v: { kind: "number" | "boolean" | "unit" | "text"; bits?: number; unsigned?: boolean }) => (v.kind === "number" ? (v.bits ? `u${v.bits}` : v.unsigned ? "u32" : "number") : v.kind === "unit" ? "Unit" : v.kind === "text" ? "string" : "boolean");

  /** The programs and, under each, the variables it keeps in the game. */
  const renderPrograms = () => {
    const programs = outline?.programs ?? [];
    programsSection.setHidden(programs.length === 0);
    programList.replaceChildren(...programs.flatMap((p, i) => [
      el("li", { className: "tsd-row", title: `${p.name ?? `Program ${i + 1}`}, run as ${ownerLabel(p)}`, onClick: () => goTo(p.source.file, p.source.line) },
        shell.icon("symbol-method"),
        el("span", { className: "tsd-name" }, p.name ?? `program ${i + 1}`),
        el("span", { className: "tsd-about" }, `${ownerLabel(p)}${p.perPlayer ? " · per player" : ""}`),
      ),
      ...(outline?.variables ?? []).filter((v) => v.program === i).map((v) =>
        el("li", { className: "tsd-row tsd-child", title: `${v.name}: ${typeOf(v)}${v.shared ? ", one value shared by every player" : p.perPlayer ? ", one per player" : ""}`, onClick: () => goTo(v.at.file, v.at.line, v.at.column) },
          shell.icon("symbol-variable"),
          el("span", { className: "tsd-name" }, v.name),
          el("span", { className: "tsd-about" }, `${typeOf(v)}${v.shared ? " · shared" : ""}`),
        )),
    ]));
  };

  const renderProblems = () => {
    problemsView.badge(diagnostics.length);
    if (diagnostics.length === 0) { problemsView.body.replaceChildren(el("div", { className: "tsd-empty" }, !ready ? "" : result ? "No problems have been detected in the script." : "Checking…")); return; }
    problemsView.body.replaceChildren(el("ul", { className: "tsd-list" }, ...diagnostics.map((d) =>
      el("li", { title: d.message, onClick: () => goTo(d.file, d.line, d.column) },
        shell.icon("error"),
        el("span", { className: "msg" }, d.message.split("\n")[0]),
        el("span", { className: "src" }, d.source === "typescript" ? "types" : d.source === "script" ? "script" : "compiler"),
        el("span", { className: "where" }, `${d.file} [Ln ${d.line}, Col ${d.column}]`),
      ))));
  };

  const renderSimulation = () => {
    if (!simulation) { simulateView.body.replaceChildren(el("div", { className: "tsd-empty" }, `Simulate (${MOD}+F5) runs the script's first ${SIMULATE_FRAMES / 24} seconds in a built-in interpreter and lists what happened. A change to the script clears the list.`)); return; }
    const { sim, programs: ps, result: r } = simulation;
    const list = el("ul", { className: "tsd-list" });
    list.append(el("li", { className: "tsd-plain" }, el("span", { className: "msg note" }, `${SIMULATE_FRAMES} frames (${SIMULATE_FRAMES / 24} s) as P${sim.player + 1}. Unit conditions (bring, command, …) count as false and reads of what the simulation does not hold (units, kills, scores) give 0; wait takes no time.`)));
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
        el("span", { className: "frame" }, `frame ${f.cycle + 1}`), shell.icon("error"),
        el("span", { className: "msg" }, times > 1 ? `${f.message} (and ${times - 1} more time${times === 2 ? "" : "s"} at this line)` : f.message),
        el("span", { className: "where" }, where({ file: f.at.file, line: f.at.line }))));
    }
    if (faults.size > SIMULATE_FAULTS) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "…"), el("span", { className: "msg" }, `and ${faults.size - SIMULATE_FAULTS} more lines with a fault`)));
    // Hand triggers' events (trigger interpreter) and the programs' (program interpreter), in time order.
    const rows: { cycle: number; order: number; line: () => HTMLElement }[] = [];
    sim.events.forEach((e, i) => {
      const at = r.sources[e.trigger];
      rows.push({ cycle: e.cycle, order: i, line: () => el("li", { title: `Trigger #${e.trigger + 1}`, onClick: () => { if (at) goTo(at.file, at.line); } },
        el("span", { className: "frame" }, `frame ${e.cycle + 1}`), el("span", { className: "msg" }, describeEvent(e)), el("span", { className: "where" }, where(at))) });
    });
    ps?.events.forEach((e, i) => {
      rows.push({ cycle: e.cycle, order: sim.events.length + i, line: () => el("li", { title: `Program ${e.program + 1}`, onClick: () => goTo(e.at.file, e.at.line, e.at.column) },
        el("span", { className: "frame" }, `frame ${e.cycle + 1}`), el("span", { className: "msg" }, describeEvent(e)), el("span", { className: "where" }, where({ file: e.at.file, line: e.at.line }))) });
    });
    rows.sort((a, b) => a.cycle - b.cycle || a.order - b.order);
    if (rows.length === 0) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "—"), el("span", { className: "msg" }, `No actions ran in ${SIMULATE_FRAMES} frames.`)));
    for (const row of rows.slice(0, SIMULATE_ROWS)) list.append(row.line());
    if (rows.length > SIMULATE_ROWS) list.append(el("li", { className: "tsd-plain" }, el("span", { className: "frame" }, "…"), el("span", { className: "msg" }, `and ${rows.length - SIMULATE_ROWS} more actions`)));
    const shownVars = new Set<string>();
    for (const v of r.variables) {
      if (shownVars.has(v.name)) continue;
      shownVars.add(v.name);
      const value = ps?.value(v.name);
      const shown = value === undefined ? "?" : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
      list.append(el("li", { title: "The variable's value when the run ended", onClick: () => goTo(v.at.file, v.at.line, v.at.column) },
        el("span", { className: "frame" }, "after"), el("span", { className: "msg" }, `${v.name} = ${shown}`), el("span", { className: "where" }, typeOf(v))));
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
      shell.notify({ key: "stale", kind: "warn", text: "The script's triggers were edited or removed outside the script. They stay as hand-made triggers; the next Apply appends a fresh block. Saving the map does not apply the script until this is settled." });
      return;
    }
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
    const facts = `The script's triggers were edited outside the script: ${n(e.unchanged, "trigger")} ${e.unchanged === 1 ? "is" : "are"} still the script's, ${n(e.changed, "trigger")} ${e.changed === 1 ? "was" : "were"} changed.`;
    const plan = appendInstead
      ? "The next Apply leaves them all as hand-made triggers and appends a fresh block."
      : `The next Apply replaces the ${e.unchanged} and keeps the ${n(e.changed, "edited one")} as hand-made triggers right after the new block.`;
    shell.notify({ key: "stale", kind: "warn", text: `${facts} ${plan}`, actions: [
      { label: appendInstead ? "Replace instead" : "Append instead", keep: true, run: () => { appendInstead = !appendInstead; render(); } },
      { label: "Apply", primary: true, run: () => { void build(); } },
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
    shell.notify({ key: "renames", kind: "info", text: `The map renamed ${all.length === 1 ? "something the script names" : `${all.length} things the script names`}: ${all.join(", ")}.`, actions: [
      { label: "Leave", run: () => { renames = []; render(); } },
      { label: "Update references", primary: true, run: () => { void applyRenames(); } },
    ] });
  };

  const renderCursor = () => {
    const at = editor?.editor.getPosition();
    cursorItem.set(at ? { text: `Ln ${at.lineNumber}, Col ${at.column}`, title: "Go to line…", onClick: () => { editor?.editor.focus(); editor?.editor.trigger("trigscript", "editor.action.gotoLine", null); } } : null);
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

    problemsItem.set(ready ? { icon: errors ? "error" : "pass", text: String(errors), kind: errors ? "error" : undefined, title: errors ? `${errors} problem${errors === 1 ? "" : "s"}` : result ? "No problems" : "Checking…", onClick: () => shell.togglePanel("problems") } : null);
    const onSave = "saving or testing the map applies the script by itself";
    blockItem.set(stale ? null : block && !state?.unbuilt
      ? { icon: "check", text: `${block.count} trigger${block.count === 1 ? "" : "s"} at #${block.start + 1}`, title: `The script's triggers are in the map's trigger list, from #${block.start + 1}. Click to apply the script again`, onClick: () => { void build(); } }
      : { icon: "circle-filled", text: block ? "Changes not applied" : "Not applied yet", title: `${block ? "The script changed since it was applied" : "The script's triggers are not in the map yet"}: ${onSave}. Click to apply it now (${MOD}+Shift+B)`, onClick: () => { void build(); } });
    staleItem.set(stale ? { icon: "warning", kind: "warn", text: "Triggers edited outside the script", title: "What the next Apply does about it", onClick: () => showStale(true) } : null);
    const renamed = renamedNow().length;
    renamesItem.set(renamed ? { icon: "sync", kind: "warn", text: `${renamed} renamed`, title: "The map renamed things the script names", onClick: () => showRenames(true) } : null);
    messageItem.set(status ? { text: status.text, busy: status.kind === "busy" } : !ready && !failed ? { text: "Loading the editor…", busy: true } : null);

    buildItem.set(buildState ? { text: buildState.text, busy: buildState.kind === "busy", icon: buildState.kind === "error" ? "error" : "package", kind: buildState.kind === "error" ? "error" : undefined, title: "The last build of the programs. Click for its log", onClick: () => shell.showPanel("output") } : null);
    // The library matters only to a script with programs: it is what builds them into the saved map.
    const needsLibrary = programs > 0;
    const libraryOk = !!library?.contribute && library.state() !== "failed";
    libraryItem.set(!needsLibrary ? null : {
      kind: libraryOk ? undefined : "warn",
      icon: libraryOk ? undefined : "warning",
      text: !library
        ? "eudplib plugin not running"
        : !library.contribute
          ? "eudplib plugin older than 0.4"
          : `eudplib ${library.versions.eudplib} · ${library.state() === "ready" ? "runtime ready" : library.state() === "installing" ? "runtime downloading…" : library.state() === "failed" ? "runtime failed" : "runtime downloads on the first save"}`,
      title: !library
        ? "The programs will not be built: install or turn on the eudplib plugin under Plugins ▸ Manage Plugins…"
        : !library.contribute
          ? "Update the eudplib plugin to build the programs"
          : "The eudplib plugin builds the programs into the map when it is saved or tested; its runtime is downloaded once, the first time",
    });
    programsItem.set(programs ? { text: `${programs === 1 ? "1 program" : `${programs} programs`} · Remastered`, title: "Programs are built into the saved map, which then needs StarCraft: Remastered. Click for the programs and their variables", onClick: () => { shell.toggleSidebar(true); programsSection.expand(); } } : null);

    renderFiles();
    renderPrograms();
    renderProblems();
    renderSimulation();
    showStale();
    showRenames();
  };

  const applyResult = (r: CompileResult) => {
    diagnostics = r.diagnostics;
    result = r;
    if (r.ok) outline = { programs: r.programs, variables: r.variables };
    simulation = null;
    if (editor && monaco) { setCompilerMarkers(monaco, files, diagnostics); editor.decorate(r.buildTime); refreshLineHints(); }
    render();
  };

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
      svc.prepare(files, generated).then(
        (a) => { if (!cancelled) applyResult(a.compiled); },
        (err: Error) => { if (!cancelled && !(err instanceof CompileSuperseded)) setStatus("error", `Compiler: ${err.message}`); },
      );
    }, CHECK_DELAY_MS);
  };

  /**
   * Compile what is in the editor right now, and hand back the artifact a build installs.
   * A keystroke during the compile supersedes it with the newer text's check; the newer
   * text is what the user wants built, so it is compiled again — a few times at most.
   */
  const compileNow = async (): Promise<ScriptArtifact | null> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancelled || !generated) return null;
      try {
        const a = await svc.prepare(files, generated);
        applyResult(a.compiled);
        return a;
      } catch (err) {
        if (err instanceof CompileSuperseded) continue;
        setStatus("error", `Compiler: ${(err as Error).message}`);
        return null;
      }
    }
    return null;
  };

  const refusal = (why: BuildRefusal | undefined): string => {
    switch (why) {
      case "closed": return "Not applied: the map closed.";
      case "switched": return "Not applied: another map is in front now.";
      case "changed": return "Not applied: the map changed while the script was running. Apply again.";
      default: return "Not applied.";
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
    setStatus("busy", "Running the script…");
    try {
      for (let attempt = 0; ; attempt++) {
        const a = await compileNow();
        if (!a || cancelled) return false;
        if (!a.compiled.ok || diagnostics.length) {
          const n = diagnostics.length || a.compiled.diagnostics.length;
          setStatus("error", `Not applied: ${n} problem${n === 1 ? "" : "s"} in the script.`, NOTICE_MS);
          shell.showPanel("problems");
          return false;
        }
        const wasStale = svc.state()?.stale ?? false;
        setStatus("busy", "Writing the triggers…");
        const out = svc.install(a, { takeOver, replaceStale: wasStale && !appendInstead });
        if (out.block) {
          const b = out.block;
          const tail = out.replaced
            ? ` (replaced the previous block's ${out.replaced.removed} unchanged trigger${out.replaced.removed === 1 ? "" : "s"}; ${out.replaced.kept} edited one${out.replaced.kept === 1 ? "" : "s"} kept after it)`
            : wasStale ? " (appended: the previous block had been edited outside the script)" : "";
          const n = a.compiled.ir.length;
          const built = n ? ` ${n === 1 ? "The program is" : `The ${n} programs are`} built into the map when it is saved or tested.` : "";
          setStatus("ok", (b.count === 0
            ? `Applied: the script defines no triggers${n ? "" : "; its block is empty"}.`
            : `Applied ${b.count} trigger${b.count === 1 ? "" : "s"} → #${b.start + 1}–#${b.start + b.count}${tail}.`) + built);
          return true;
        }
        // The names changed under the compile (a location renamed, a trigger added): once more against the new ones.
        if (out.refused === "changed" && attempt < 2) { setStatus("busy", "The map changed while the script ran; running it again…"); continue; }
        setStatus("error", refusal(out.refused));
        return false;
      }
    } finally {
      building = false;
      render();
    }
  };

  /**
   * Test: the script applied, then the map exactly as Save would write it — the editor runs
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
      setStatus("busy", "Building the map…");
      const file = await api.document.export({ format: "scx" });
      if (!file) { setStatus("error", "No map is open."); return; }
      if (failure) { setStatus("error", `Not tested: ${failure}`); return; }
      if (result?.programs.length && !library?.contribute) { setStatus("error", "Not tested: the programs need the eudplib plugin (0.4 or newer) to be built. Install or turn it on under Plugins ▸ Manage Plugins…."); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const outcome = await api.document.test(bytes, file.name);
      const kb = Math.round(bytes.length / 1024);
      setStatus(outcome ? "ok" : "info", outcome?.launched
        ? `Started the game with ${outcome.path} (${kb} KB).`
        : outcome
          ? `Written to ${outcome.path} (${kb} KB)${outcome.message ? ` — ${outcome.message}` : ""}.`
          : "The map is built, but this browser has no test folder yet: pick one once under Tools ▸ Test Map…, which builds the map the same way.");
    } catch (err) {
      setStatus("error", `Not tested: ${(err as Error).message}`);
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
      buildState = { kind: "busy", text: `Building for ${e.purpose === "test" ? "Test Map" : e.purpose === "save" ? "Save" : "an export"}…` };
      log(`Building the programs for ${e.purpose === "test" ? "Test Map" : e.purpose === "save" ? "Save" : "an export"}`);
    } else if (e.kind === "log") {
      streamed++;
      log(e.line, false);
    } else if (e.kind === "done") {
      if (!streamed && e.log) log(e.log, false);
      const kb = Math.round(e.chkBytes / 1024), seconds = (e.ms / 1000).toFixed(1);
      buildState = { kind: "ok", text: `Built ${kb} KB · ${seconds} s` };
      log(`Built: ${kb} KB of scenario in ${seconds} s`);
    } else {
      if (!streamed && e.log) log(e.log, false);
      buildState = { kind: "error", text: "Build failed" };
      log(`Build failed: ${e.message}`);
      shell.notify({ key: "build", kind: "error", text: `The programs were not built: ${e.message}`, actions: [{ label: "Show the log", run: () => shell.showPanel("output") }] });
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
    if (before.length + after.length === 0) { setStatus("info", "There are no hand-made triggers to import."); return; }
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
    if (ok) setStatus("ok", `Imported ${n} hand-made trigger${n === 1 ? "" : "s"}; every trigger is now generated by the script.`);
  };

  /**
   * What a simulated program finds on the map: the placed units, in the order the map has them, with
   * the hit points their type and their own percentage give, and the map's locations as boxes.
   */
  const simulatedMap = (): Pick<ProgramSimulationOptions, "units" | "locations"> => {
    const scn = api.document.scenario();
    if (!scn) return {};
    const types = new Map<number, { hp: number; shields: number }>();
    const typeOf = (id: number) => {
      let t = types.get(id);
      if (!t) { const view = api.settings?.unitType(id); t = { hp: view?.hitPoints ?? 1, shields: view?.shields ?? 0 }; types.set(id, t); }
      return t;
    };
    const part = (max: number, percent: number, valid: boolean) => (valid ? Math.max(1, Math.ceil((max * Math.min(100, percent)) / 100)) : max);
    const units: SimUnitInit[] = scn.units.filter((u) => u.unitId !== START_LOCATION_UNIT).map((u) => {
      const t = typeOf(u.unitId);
      return {
        type: u.unitId, owner: u.owner, x: u.x, y: u.y,
        // validStates says which of a placed unit's own figures are set: 2 hit points, 4 shields, 64 the state flags.
        maxHp: t.hp, hp: part(t.hp, u.hitPointsPercent, (u.validStates & 2) !== 0),
        maxShields: t.shields, shields: t.shields ? part(t.shields, u.shieldPercent, (u.validStates & 4) !== 0) : 0,
        resources: u.resourceAmount,
        ...((u.validStates & 64) !== 0 ? { cloaked: (u.stateFlags & 1) !== 0, burrowed: (u.stateFlags & 2) !== 0, hallucinated: (u.stateFlags & 8) !== 0, invincible: (u.stateFlags & 16) !== 0 } : {}),
      };
    });
    const locations: Record<number, SimBounds> = {};
    scn.locations.forEach((l, i) => { if (l.right > l.left || l.bottom > l.top) locations[i + 1] = { left: l.left, top: l.top, right: l.right, bottom: l.bottom }; });
    return { units, locations };
  };

  /** Run the compiled triggers through the trigger-cycle interpreter and show what happened. */
  const simulateNow = async () => {
    const r = (await compileNow())?.compiled;
    if (!r) return;
    if (!r.ok) { setStatus("error", `Not simulated: ${r.diagnostics.length} problem${r.diagnostics.length === 1 ? "" : "s"} in the script.`, NOTICE_MS); shell.showPanel("problems"); return; }
    try {
      // The programs run from the IR; the trigger() records through the trigger interpreter, sharing one world.
      const player = r.programs[0]?.owner;
      const sim = new Simulation(r.triggers, { strings: r.strings, player });
      const programs = r.ir.length ? new ProgramSimulation(r.ir, { world: sim, strings: r.strings, player, heapCells: svc.settings().heapCells, stackDepth: svc.settings().stackDepth, ...simulatedMap() }) : null;
      for (let i = 0; i < SIMULATE_FRAMES; i++) { sim.step(); programs?.step(); }
      simulation = { sim, programs, result: r };
      const count = sim.events.length + (programs?.events.length ?? 0);
      // Nobody presses a key in a simulation: said, so that a program waiting for one is not taken for broken.
      const quiet = r.input ? " Keys, clicks, the mouse and chat are not simulated: they read as nothing." : "";
      const faults = programs?.faults.length ?? 0;
      const wrong = faults ? ` ${faults} fault${faults === 1 ? "" : "s"}: an array read or written past its end, or out of memory — first in the list.` : "";
      setStatus("ok", `Simulated ${SIMULATE_FRAMES} frames as P${sim.player + 1}: ${count} action${count === 1 ? "" : "s"} ran.${wrong}${quiet}`);
      shell.showPanel("simulate");
    } catch (err) {
      setStatus("error", `Simulation stopped: ${(err as Error).message}`);
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
      const picked = await api.ui.pickObject({ prompt: "Click a location or a unit for the script" });
      if (cancelled || !picked || !editor) return;
      const scn = api.document.scenario();
      const table = picked.kind === "unit" ? generated.names.units : generated.names.locations;
      const value = picked.kind === "unit" ? scn?.units[picked.index]?.unitId : picked.index + 1;
      const entry = value === undefined ? undefined : entryFor(table, value);
      if (!entry) { setStatus("info", picked.kind === "unit" ? "That unit's type has no name in the script's tables." : "That location is not in the script's tables yet; try again after the map's names refresh."); return; }
      editor.insert(`${table.object}.${entry.keys[0]}`);
      setStatus("ok", `Inserted ${table.object}.${entry.keys[0]}.`);
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
    setStatus("ok", `Updated ${count} reference${count === 1 ? "" : "s"}.`);
    check();
  };

  /* ── Files ── */

  const askName = async (message: string, value: string): Promise<string | null> => {
    for (;;) {
      const answer = await api.ui.prompt(message, { title: "TrigScript", value, placeholder: "helpers.ts" });
      if (answer === null) return null;
      let name = normalizePath(answer.trim());
      if (name && !/\.ts$/i.test(name)) name += ".ts";
      if (!FILE_NAME.test(name)) { value = answer; message = "A file name is letters, digits, _ - and ., folders with /, ending in .ts."; continue; }
      if (files[name] !== undefined) { value = answer; message = `There is already a ${name}.`; continue; }
      return name;
    }
  };

  const newFile = async () => {
    if (!editor) return;
    const name = await askName("Name of the new file:", "helpers.ts");
    if (!name) return;
    editor.add(name, FILE_TEMPLATE);
    openFile(name);
  };

  const renameFile = async (path: string) => {
    if (!editor || path === ENTRY_FILE) return;
    const name = await askName(`Rename ${path} to:`, path);
    if (!name) return;
    editor.rename(path, name);
    openTabs = openTabs.map((p) => (p === path ? name : p));
    const next = { ...files };
    next[name] = next[path];
    delete next[path];
    files = next;
    svc.writeFiles(files);
    renderFiles();
    check();
  };

  const removeFile = async (path: string) => {
    if (!editor || path === ENTRY_FILE) return;
    if (!(await api.ui.confirm(`Remove ${path} from the script? Its text is not kept anywhere else.`, { title: "TrigScript", confirmLabel: "Remove", danger: true }))) return;
    editor.remove(path);
    const next = { ...files };
    delete next[path];
    files = next;
    svc.writeFiles(files);
    renderFiles();
    check();
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
  interface Command { id: string; label: string; key?: { code: string; mod?: boolean; shift?: boolean }; context?: boolean; run(): void }
  const commands: Command[] = [
    // The editor's own Ctrl+S does not reach a map under a dialog, and a browser would offer to save the page.
    { id: "save", label: "Save the Map", key: { code: "KeyS", mod: true }, run: () => { void api.document.save(); } },
    { id: "test", label: "Test the Map", key: { code: "F5" }, run: () => { void test(); } },
    { id: "simulate", label: "Simulate", key: { code: "F5", mod: true }, run: () => { void simulateNow(); } },
    { id: "apply", label: "Apply the Script to the Map", key: { code: "KeyB", mod: true, shift: true }, run: () => { void build(); } },
    { id: "pick", label: "Pick a Location or Unit from the Map", context: true, run: () => { void pickFromMap(); } },
    { id: "import", label: "Import the Map's Triggers", run: () => { void importHand(); } },
    { id: "newFile", label: "New File…", run: () => { void newFile(); } },
    { id: "mode", label: mode === "dialog" ? "Open Beside the Map" : "Open in a Window", run: () => switchMode() },
    { id: "problems", label: "Show Problems", key: { code: "KeyM", mod: true, shift: true }, run: () => shell.togglePanel("problems") },
    { id: "output", label: "Show Output", key: { code: "KeyU", mod: true, shift: true }, run: () => shell.togglePanel("output") },
    { id: "settings", label: "Open Settings", key: { code: "Comma", mod: true }, run: () => { shell.showPanel("settings"); renderSettings(); } },
    { id: "panel", label: "Toggle Panel", key: { code: "KeyJ", mod: true }, run: () => shell.togglePanel() },
    { id: "explorer", label: "Toggle Explorer", key: { code: "KeyB", mod: true }, run: () => shell.toggleSidebar() },
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
      : commands.find((x) => x.key && x.key.code === e.code && !!x.key.mod === mod && !!x.key.shift === e.shiftKey);
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    if (ready) c.run();
  };
  root.addEventListener("keydown", onKey, true);

  const attach = (close: () => void) => {
    render();
    // Monaco comes from the CDN on first open, which can take a while: the editor's box says so.
    const loadingCover = w.busy(hostEl, "Loading the editor…");
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
        setLineHints(m, () => result?.hints ?? []);
        setMapRefs(m, mapRefs);
        // Uncover first: `done` puts the host back in its own place, and Monaco measures it where it lands.
        loadingCover.done();
        // Monaco's stylesheet brought the icons' font.
        shell.ready();
        editor = createScriptEditor(m, hostEl, files, options.file ?? ENTRY_FILE, (path, text) => {
          files = { ...files, [path]: text };
          svc.writeFiles(files);
          check();
        });
        const code = editor.editor;
        for (const c of commands) {
          code.addAction({
            id: `trigscript.${c.id}`,
            label: `TrigScript: ${c.label}`,
            keybindings: c.key ? [(c.key.mod ? m.KeyMod.CtrlCmd : 0) | (c.key.shift ? m.KeyMod.Shift : 0) | m.KeyCode[c.key.code as keyof typeof m.KeyCode]] : undefined,
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
      (err: Error) => { if (!cancelled) { loadingCover.done(); failed = true; setStatus("error", `The editor failed to load: ${err.message}`); } },
    );
    return () => {
      cancelled = true;
      loadingCover.done();
      if (timer !== null) clearTimeout(timer);
      if (statusTimer !== null) clearTimeout(statusTimer);
      root.removeEventListener("keydown", onKey, true);
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
