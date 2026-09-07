/**
 * The TrigScript workspace: Monaco over the map's script files, checked live against
 * declarations generated from the map (`compiler/declarations.ts`) and compiled — run —
 * in the worker (`compile.ts`). Build installs the result as the script's block of the
 * trigger list (`service.ts`).
 *
 * It opens two ways. As a full-screen dialog, for a long session on the script; or
 * *beside the map*, as a resizable panel that blocks nothing, so the map and the code
 * are worked on together: Ctrl+click on `locations.Beacon` shows the location, *Pick
 * from map* puts the name of a clicked location or unit at the cursor, and a location
 * the map renames offers to update the references. The same workspace mounts in either;
 * a button switches.
 *
 * The files are the map's: every edit is written straight into the archive (they are
 * members of the .scx, like a WAV), so closing loses nothing — only Build changes
 * triggers. A list at the left holds the files; `main.ts` is where a build starts and
 * cannot be renamed or removed. Monaco and TypeScript come from the CDN on first open.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { CompileSuperseded, retainCompileWorker } from "./compile";
import { ENTRY_FILE, normalizePath, type CompileResult, type LineCost, type ScriptDiagnostic, type ScriptFiles, type TriggerSource } from "./compiler/compiler";
import { entryFor } from "./compiler/names";
import { printScript } from "./compiler/print";
import { Simulation, type SimulationEvent } from "./compiler/simulate";
import { actionDef } from "./vendor/triggerDefs";
import { PlayerGroup } from "./vendor/triggers";
import {
  BUILD_TIME_CLASS, createScriptEditor, loadMonaco, refreshCostHints, releaseScriptEditor, setCompilerMarkers, setCostHints, setDeclarations, setHoverVariables, setMapRefs,
  type LocationRef, type MonacoApi, type ScriptEditor,
} from "./monaco";
import { renamedKeys, renamesInUse, replaceReferences, type Renamed } from "./refs";
import { FILE_NAME } from "./script";
import type { BuildRefusal, MapNames, ScriptArtifact, ScriptService } from "./service";

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

// A program: its variables are death counters and switches; if, while, for and
// functions work. It runs as one player, one loop iteration per trigger cycle. The
// underlined parts are computed when you build, everything else runs in the game.
program(() => {
  let cycles = 0;
  while (true) {
    cycles++;
    if (cycles == 10) displayText("Ten trigger cycles have passed.");
  }
}, { owner: P1 });
`;

/** What a new file starts with. */
export const FILE_TEMPLATE = `import { trigger, units, locations, P1 } from "trigscript";

// Helpers this file exports are imported by main.ts: import { … } from "./name";
`;

/** Trigger cycles the Simulate button runs. */
export const SIMULATE_CYCLES = 30;

const CHECK_DELAY_MS = 350;

/** The panel beside the map starts this big; the user resizes it and the size is kept for the session. */
export const PANEL_WIDTH = 760;
export const PANEL_HEIGHT = 540;

const STYLE = `
.tsd { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.tsd .tsd-editor { flex: 1; min-height: 0; display: flex; border: 1px solid var(--border); box-shadow: var(--bevel-sunken); border-radius: var(--radius); overflow: hidden; background: var(--bg-0); }
.tsd .tsd-side { flex: none; width: 168px; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg-1); }
.tsd.tsd-panel .tsd-side { width: 132px; }
.tsd .tsd-files { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 4px 0; list-style: none; font-family: var(--font-mono); font-size: var(--fs-sm); }
.tsd .tsd-files li { display: flex; align-items: center; gap: 4px; padding: 3px 6px 3px 10px; cursor: pointer; color: var(--text-dim); white-space: nowrap; }
.tsd .tsd-files li:hover { background: var(--bg-3); }
.tsd .tsd-files li.active { background: var(--bg-0); color: var(--text); }
.tsd .tsd-files li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.tsd .tsd-files li .name.problem { color: var(--danger); }
.tsd .tsd-files li button { flex: none; border: none; background: none; padding: 0 3px; font: inherit; color: var(--text-faint); cursor: pointer; visibility: hidden; }
.tsd .tsd-files li.active button { visibility: visible; }
.tsd .tsd-files li button:hover { color: var(--text); }
.tsd .tsd-side .tsd-new { margin: 4px 6px 6px; }
.tsd .tsd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.tsd .tsd-host { flex: 1; min-height: 0; }
.tsd .tsd-problems { flex: none; max-height: 132px; overflow: auto; margin: 0; padding: 2px 0; list-style: none; border-top: 1px solid var(--border); background: var(--bg-1); font-family: var(--font-mono); font-size: var(--fs-sm); }
.tsd.tsd-panel .tsd-problems { max-height: 96px; }
.tsd .tsd-problems li { display: flex; gap: 10px; padding: 2px 10px; cursor: pointer; align-items: baseline; }
.tsd .tsd-problems li:hover { background: var(--bg-3); }
.tsd .tsd-problems .where { flex: none; min-width: 48px; color: var(--text-faint); }
.tsd .tsd-problems .msg { flex: 1; color: var(--danger); white-space: pre-wrap; }
.tsd .tsd-problems .src { flex: none; color: var(--text-faint); font-size: var(--fs-xs); text-transform: uppercase; }
.tsd .tsd-run .msg { color: var(--text); }
.tsd .tsd-run li { cursor: default; }
.tsd .tsd-program { border: none; background: none; padding: 0; font: inherit; font-size: var(--fs-sm); color: var(--gold); cursor: pointer; }
.tsd .tsd-program:hover { text-decoration: underline; }
.tsd .tsd-variables { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 4px 8px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-1); }
.tsd .tsd-variables .internal { color: var(--text-faint); }
.tsd .tsd-notice { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 10%, var(--bg-2)); border-radius: var(--radius); color: var(--warn); font-size: var(--fs-sm); }
.tsd .tsd-notice .grow { flex: 1; }
.tsd .tsd-mode { margin-left: 4px; }
.${BUILD_TIME_CLASS} { text-decoration: underline dotted rgba(153, 162, 179, 0.55); text-underline-offset: 3px; }
`;

/** "P1", "all players", "Force 2", "P1, P2" — who a program runs for. */
function ownerLabel(p: { owners: number[] }): string {
  return p.owners.map((o) => (o === PlayerGroup.AllPlayers ? "all players" : o >= PlayerGroup.Force1 && o <= PlayerGroup.Force4 ? `Force ${o - PlayerGroup.Force1 + 1}` : `P${o + 1}`)).join(", ");
}

/** One line of the simulation log: "Display Text — hello". */
function describeEvent(e: SimulationEvent): string {
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
      // Escape inside the editor dismisses its own popups (suggestions, parameter hints); it must not close the dialog.
      keepOpenOnEscape: (target) => target instanceof Node && ws.host.contains(target),
      mount(body, dialog) {
        body.append(ws.root);
        return ws.attach(() => dialog.close());
      },
      buttons: [
        { label: "Build & Close", primary: true, run: async () => ((await ws.build()) ? undefined : false) },
        { label: "Close" },
        // Returning the promise keeps the footer busy — ring, buttons held — until the build lands.
        { label: "Build", closes: false, run: async () => { await ws.build(); } },
      ],
    });
    current = { mode, isOpen: () => handle.isOpen(), close: () => handle.close(), reveal: ws.reveal, cursor: ws.cursor };
  } else {
    const handle = api.ui.panel({
      title: "TrigScript",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      resizable: true,
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
  /** Where Monaco lives, for the dialog's Escape guard. */
  host: HTMLElement;
  /** Subscribe, load Monaco, and hand back the cleanup; `close` shuts the shell (the map went away). */
  attach(close: () => void): () => void;
  build(): Promise<boolean>;
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
  let building = false;
  /** The build under way was started by Import map triggers, so that is the button wearing the ring. */
  let importing = false;
  let picking = false;
  let diagnostics: ScriptDiagnostic[] = [];
  let result: CompileResult | null = null;
  let simulation: { sim: Simulation; result: CompileResult } | null = null;
  let showVariables = false;
  let cancelled = false;
  /** Renames the map made to things the script names, waiting for the user's word. */
  let renames: { object: string; list: Renamed[] }[] = [];

  /* ── DOM ── */
  const style = el("style", undefined, STYLE);
  const buildButton = w.button("Build", { onClick: () => { void build(); } });
  buildButton.title = "Run the script and install its triggers as the map's generated block";
  const importButton = w.button("Import map triggers", { onClick: () => { void importHand(); } });
  importButton.title = "Rewrite the map's hand-made triggers as script, appended around the block, and rebuild";
  const simulateButton = w.button("Simulate", { onClick: () => { void simulateNow(); } });
  simulateButton.title = `Run the compiled triggers for ${SIMULATE_CYCLES} trigger cycles in a built-in interpreter and list what happened`;
  const pickButton = w.button("Pick from map", { ghost: true, onClick: () => { void pickFromMap(); } });
  pickButton.title = "Click a location or a unit on the map to put its name at the cursor";
  const modeButton = w.button(mode === "dialog" ? "Beside the map" : "In a window", { ghost: true, onClick: () => switchMode() });
  modeButton.className += " tsd-mode";
  modeButton.title = mode === "dialog" ? "Open the script as a panel beside the map, so the map stays in reach" : "Open the script in a full-screen window";
  const programButton = el("button", { type: "button", className: "tsd-program", hidden: true, title: "Where the programs' variables are stored (death counters and switches)", onClick: () => { showVariables = !showVariables; render(); } });
  const problemsCount = el("span", { className: "hint" }, "");
  const variables = el("div", { className: "tsd-variables", hidden: true });
  const notice = el("div", { className: "tsd-notice", hidden: !initial?.stale }, "The triggers from the last build were edited or removed outside the script. They stay as hand-made triggers; the next Build appends a fresh block.");
  const renameNotice = el("div", { className: "tsd-notice tsd-renames", hidden: true });
  const hostEl = el("div", { className: "tsd-host" });
  const problems = el("ul", { className: "tsd-problems", hidden: true });
  const fileList = el("ul", { className: "tsd-files" });
  const newButton = w.button("New file", { ghost: true, onClick: () => { void newFile(); } });
  newButton.className += " tsd-new";
  newButton.title = "Add a file to the script; main.ts imports it with import { … } from \"./name\"";
  const statusLine = w.statusLine();
  const root = el("div", { className: mode === "panel" ? "tsd tsd-panel" : "tsd" },
    style,
    el("div", { className: "row" }, buildButton, importButton, simulateButton, pickButton, el("span", { className: "grow" }), programButton, problemsCount, modeButton),
    variables,
    notice,
    renameNotice,
    el("div", { className: "tsd-editor" },
      el("div", { className: "tsd-side" }, fileList, newButton),
      el("div", { className: "tsd-main" }, hostEl, problems),
    ),
    statusLine,
  );

  let status: { kind: "info" | "ok" | "error" | "busy"; text: string } = { kind: "info", text: "" };
  const setStatus = (kind: "info" | "ok" | "error" | "busy", text: string) => { status = { kind, text }; render(); };

  const goTo = (file: string, line: number, column = 1) => {
    if (!editor) return;
    editor.show(file);
    editor.editor.revealLineInCenter(line);
    editor.editor.setPosition({ lineNumber: line, column });
    editor.editor.focus();
    renderFiles();
  };

  const where = (s: TriggerSource | null | undefined) => (s ? (Object.keys(files).length > 1 ? `${s.file}:${s.line}` : `L${s.line}`) : "?");

  const renderFiles = () => {
    const active = editor?.active() ?? ENTRY_FILE;
    const paths = Object.keys(files).sort((a, b) => (a === ENTRY_FILE ? -1 : b === ENTRY_FILE ? 1 : a.localeCompare(b)));
    const broken = new Set(diagnostics.map((d) => normalizePath(d.file)));
    fileList.replaceChildren(...paths.map((path) => {
      const row = el("li", { className: path === active ? "active" : undefined, title: path, onClick: () => { if (editor) { editor.show(path); renderFiles(); editor.editor.focus(); } } },
        el("span", { className: broken.has(path) ? "name problem" : "name" }, path));
      if (path !== ENTRY_FILE) {
        row.append(
          el("button", { type: "button", title: "Rename", onClick: (e: MouseEvent) => { e.stopPropagation(); void renameFile(path); } }, "✎"),
          el("button", { type: "button", title: "Remove", onClick: (e: MouseEvent) => { e.stopPropagation(); void removeFile(path); } }, "×"),
        );
      }
      return row;
    }));
  };

  const renderRenames = () => {
    const all = renames.flatMap((r) => r.list.map((x) => `${r.object}.${x.from} → ${r.object}.${x.to}`));
    renameNotice.hidden = all.length === 0;
    if (all.length === 0) return;
    renameNotice.replaceChildren(
      el("span", { className: "grow" }, `The map renamed ${all.length === 1 ? "something the script names" : `${all.length} things the script names`}: ${all.join(", ")}.`),
      w.button("Update references", { onClick: () => applyRenames() }),
      w.button("Leave", { ghost: true, onClick: () => { renames = []; renderRenames(); } }),
    );
  };

  const render = () => {
    const errors = diagnostics.length;
    buildButton.setBusy(building && !importing);
    importButton.setBusy(importing);
    pickButton.setBusy(picking);
    buildButton.disabled = importButton.disabled = !ready || building;
    simulateButton.disabled = !ready || building || errors > 0;
    pickButton.disabled = !ready || picking;
    newButton.disabled = !ready;
    if (!ready) problemsCount.replaceChildren(w.spinner({ size: "sm", label: "Loading the editor…" }));
    else if (!result) problemsCount.textContent = "Checking…";
    else problemsCount.textContent = errors ? `${errors} problem${errors === 1 ? "" : "s"}` : "No problems";
    const programs = result?.programs ?? [];
    const userVariables = result?.variables.filter((v) => !v.name.startsWith("(")) ?? [];
    programButton.hidden = programs.length === 0;
    if (programs.length) {
      const count = programs.reduce((n, p) => n + p.count, 0);
      const owners = [...new Set(programs.map(ownerLabel))].join(", ");
      programButton.textContent = `${programs.length === 1 ? "Program" : `${programs.length} programs`}: ${count} trigger${count === 1 ? "" : "s"} as ${owners} · ${userVariables.length} variable${userVariables.length === 1 ? "" : "s"}`;
    }
    variables.hidden = !(showVariables && result && result.variables.length > 0);
    variables.replaceChildren(...(result?.variables ?? []).map((v) => el("span", { className: v.name.startsWith("(") ? "internal" : undefined }, el("b", undefined, v.name), ` ${v.kind === "number" ? "number" : "boolean"} → ${v.storage}`)));
    // Read live, not cached: the block's state belongs to the map and other editors change it.
    const state = svc.state();
    const block = state?.block ?? null;
    const stale = state?.stale ?? false;
    notice.hidden = !stale;
    renderFiles();
    renderRenames();

    problems.replaceChildren();
    problems.className = "tsd-problems";
    if (errors > 0) {
      problems.hidden = false;
      for (const d of diagnostics) {
        problems.append(el("li", { title: d.message, onClick: () => goTo(d.file, d.line, d.column) },
          el("span", { className: "where" }, `${Object.keys(files).length > 1 ? `${d.file}:` : ""}${d.line}:${d.column}`),
          el("span", { className: "msg" }, d.message.split("\n")[0]),
          el("span", { className: "src" }, d.source === "typescript" ? "types" : d.source === "script" ? "script" : "compiler"),
        ));
      }
    } else if (simulation) {
      problems.hidden = false;
      problems.className = "tsd-problems tsd-run";
      const { sim, result: r } = simulation;
      if (sim.events.length === 0) problems.append(el("li", undefined, el("span", { className: "where" }, "—"), el("span", { className: "msg" }, `No actions ran in ${SIMULATE_CYCLES} cycles.`)));
      for (const e of sim.events) {
        const at = r.sources[e.trigger];
        problems.append(el("li", { title: `Trigger #${e.trigger + 1}`, onClick: () => { if (at) goTo(at.file, at.line); } },
          el("span", { className: "where" }, `cycle ${e.cycle + 1}`),
          el("span", { className: "msg" }, describeEvent(e)),
          el("span", { className: "src" }, where(at)),
        ));
      }
      for (const v of r.variables.filter((x) => !x.name.startsWith("("))) {
        const shown = v.kind === "number" ? String(sim.death(v.player!, v.unit!)) : (v.flag !== undefined ? sim.death(PlayerGroup.CurrentPlayer, v.flag) !== 0 : sim.switches[v.switch!] === 1) ? "true" : "false";
        problems.append(el("li", undefined,
          el("span", { className: "where" }, "after"),
          el("span", { className: "msg" }, `${v.name} = ${shown}`),
          el("span", { className: "src" }, v.storage),
        ));
      }
    } else {
      problems.hidden = true;
    }

    const line = status.text || (block
      ? `Block: ${block.count} generated trigger${block.count === 1 ? "" : "s"} at #${block.start + 1}${state?.unbuilt ? " · unbuilt changes" : ""}`
      : stale ? "The last build's triggers were edited outside the script" : "Not built yet");
    if (status.kind === "busy") statusLine.busy(line);
    else statusLine.set(line, status.kind === "error" ? "error" : status.kind === "ok" ? "ok" : undefined);
  };

  const applyResult = (r: CompileResult) => {
    diagnostics = r.diagnostics;
    result = r;
    simulation = null;
    if (editor && monaco) { setCompilerMarkers(monaco, files, r.diagnostics); editor.decorate(r.buildTime); refreshCostHints(); }
    render();
  };

  /** Which lines get a cost at their end: those that made more than one trigger, and each program's own line with its total. */
  const costHints = (): LineCost[] => {
    if (!result) return [];
    const out = result.costs.filter((c) => c.triggers >= 2);
    for (const p of result.programs) out.push({ file: p.source.file, line: p.source.line, triggers: p.count, note: `The whole program: ${p.count} trigger${p.count === 1 ? "" : "s"} as ${ownerLabel(p)}.` });
    return out;
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
      case "closed": return "Not built: the map closed.";
      case "switched": return "Not built: another map is in front now.";
      case "changed": return "Not built: the map changed while the script was running. Build again.";
      default: return "Not built.";
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
        if (!a.compiled.ok) {
          const n = a.compiled.diagnostics.length;
          setStatus("error", `Not built: ${n} error${n === 1 ? "" : "s"}.`);
          return false;
        }
        const wasStale = svc.state()?.stale ?? false;
        setStatus("busy", "Installing the triggers…");
        const out = svc.install(a, { takeOver });
        if (out.block) {
          const b = out.block;
          setStatus("ok", b.count === 0
            ? "Built: the script defines no triggers; the block is empty."
            : `Built ${b.count} trigger${b.count === 1 ? "" : "s"} → #${b.start + 1}–#${b.start + b.count}${wasStale ? " (appended: the previous block had been edited outside the script)" : ""}.`);
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
    editor.show(ENTRY_FILE);
    files = { ...files, [ENTRY_FILE]: text };
    importing = true;
    let ok = false;
    try { ok = await build(true); } finally { importing = false; }
    const n = before.length + after.length;
    if (ok) setStatus("ok", `Imported ${n} hand-made trigger${n === 1 ? "" : "s"}; every trigger is now generated by the script.`);
  };

  /** Run the compiled triggers through the trigger-cycle interpreter and show what happened. */
  const simulateNow = async () => {
    const r = (await compileNow())?.compiled;
    if (!r) return;
    if (!r.ok) { setStatus("error", `Not simulated: ${r.diagnostics.length} error${r.diagnostics.length === 1 ? "" : "s"}.`); return; }
    try {
      const sim = new Simulation(r.triggers, { strings: r.strings, player: r.programs[0]?.owner }).run(SIMULATE_CYCLES);
      simulation = { sim, result: r };
      setStatus("ok", `Simulated ${SIMULATE_CYCLES} trigger cycles as P${sim.player + 1}: ${sim.events.length} action${sim.events.length === 1 ? "" : "s"} ran. Unit conditions (bring, command, …) count as false; wait takes no time.`);
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
      if (!entry) { setStatus("info", picked.kind === "unit" ? "That unit's type has no name in the script's tables." : "That location is not in the script's tables yet; build again after the map's names refresh."); return; }
      editor.insert(`${table.object}.${entry.keys[0]}`);
      setStatus("ok", `Inserted ${table.object}.${entry.keys[0]}.`);
    } finally {
      picking = false;
      render();
    }
  };

  /** The map renamed things the script names: after the user says so, the references follow. */
  const applyRenames = () => {
    if (!editor) return;
    let next = files;
    let count = 0;
    for (const r of renames) {
      const done = replaceReferences(next, r.object, r.list);
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
    renderFiles();
    editor.editor.focus();
  };

  const renameFile = async (path: string) => {
    if (!editor || path === ENTRY_FILE) return;
    const name = await askName(`Rename ${path} to:`, path);
    if (!name) return;
    editor.rename(path, name);
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
        const list = renamesInUse(files, object, renamedKeys(before.names[table], generated.names[table]));
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

  const reveal = (file?: string, line?: number) => { if (line) goTo(file ?? ENTRY_FILE, line); else if (file) { editor?.show(file); renderFiles(); } };

  const attach = (close: () => void) => {
    render();
    // Monaco comes from the CDN on first open, which can take a while: the editor's box says so.
    const loadingCover = w.busy(hostEl, "Loading the editor…");
    // Checks run on every keystroke (debounced), so the compile worker stays up while the editor is open.
    const releaseWorker = retainCompileWorker();
    const subs = [
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
        setCostHints(m, costHints);
        setMapRefs(m, mapRefs);
        // Uncover first: `done` puts the host back in its own place, and Monaco measures it where it lands.
        loadingCover.done();
        editor = createScriptEditor(m, hostEl, files, options.file ?? ENTRY_FILE, (path, text) => {
          files = { ...files, [path]: text };
          svc.writeFiles(files);
          check();
        });
        // A fresh script's template is the map's from now on.
        if (fresh) svc.writeFiles(files);
        reveal(options.file, options.line);
        editor.editor.focus();
        ready = true;
        render();
        check();
        if (options.pick) void pickFromMap();
      },
      (err: Error) => { if (!cancelled) { loadingCover.done(); problemsCount.textContent = ""; setStatus("error", `The editor failed to load: ${err.message}`); } },
    );
    return () => {
      cancelled = true;
      loadingCover.done();
      if (timer !== null) clearTimeout(timer);
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
    host: hostEl,
    attach,
    build: () => build(),
    reveal,
    cursor: () => editor?.cursor() ?? null,
  };
}
