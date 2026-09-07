/**
 * The TrigScript dialog: Monaco over the map's script files, checked live against
 * declarations generated from the map (`compiler/declarations.ts`) and compiled — run —
 * in the worker (`compile.ts`). Build installs the result as the script's block of the
 * trigger list (`service.ts`).
 *
 * The files are the map's: every edit is written straight into the archive (they are
 * members of the .scx, like a WAV), so closing the dialog loses nothing — only Build
 * changes triggers. A list at the left holds the files; `main.ts` is where a build
 * starts and cannot be renamed or removed. Monaco and TypeScript come from the CDN on
 * first open.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { compileInBackground, CompileSuperseded, retainCompileWorker } from "./compile";
import { ENTRY_FILE, normalizePath, type CompileResult, type ScriptDiagnostic, type ScriptFiles, type TriggerSource } from "./compiler/compiler";
import { printScript } from "./compiler/print";
import { Simulation, type SimulationEvent } from "./compiler/simulate";
import { actionDef } from "./vendor/triggerDefs";
import { createScriptEditor, loadMonaco, releaseScriptEditor, setCompilerMarkers, setDeclarations, type MonacoApi, type ScriptEditor } from "./monaco";
import { FILE_NAME } from "./script";
import type { MapNames, ScriptService } from "./service";

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

// A program: let variables are death counters and switches; if, while, for and
// functions work. It runs as one player, one loop iteration per trigger cycle.
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

const STYLE = `
.tsd { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.tsd .tsd-editor { flex: 1; min-height: 0; display: flex; border: 1px solid var(--border); box-shadow: var(--bevel-sunken); border-radius: var(--radius); overflow: hidden; background: var(--bg-0); }
.tsd .tsd-side { flex: none; width: 168px; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg-1); }
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
`;

/** One line of the simulation log: "Display Text — hello". */
function describeEvent(e: SimulationEvent): string {
  const name = actionDef(e.action.type)?.name ?? `Action ${e.action.type}`;
  return e.text !== undefined ? `${name} — ${e.text}` : name;
}

export interface OpenOptions {
  file?: string;
  line?: number;
}

interface OpenEditor {
  handle: DialogHandle;
  reveal(file?: string, line?: number): void;
}

let current: OpenEditor | null = null;

/** Open the editor (or bring the open one to the file and line). */
export function openScriptEditor(svc: ScriptService, options: OpenOptions = {}): void {
  if (current?.handle.isOpen()) { current.reveal(options.file, options.line); return; }
  current = null;
  const api = svc.api;
  if (!api.document.isOpen()) { api.ui.toast({ kind: "info", title: "Open or create a map first." }); return; }
  const el = api.ui.el;
  const w = api.ui.widgets;

  const initial = svc.state();
  let files: ScriptFiles = initial?.files ?? { [ENTRY_FILE]: TEMPLATE };
  const fresh = !initial?.files;
  let generated: MapNames | null = svc.names();
  let host: HTMLDivElement | null = null;
  let editor: ScriptEditor | null = null;
  let monaco: MonacoApi | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;
  let building = false;
  /** The build under way was started by Import map triggers, so that is the button wearing the ring. */
  let importing = false;
  let diagnostics: ScriptDiagnostic[] = [];
  let result: CompileResult | null = null;
  let simulation: { sim: Simulation; result: CompileResult } | null = null;
  let showVariables = false;
  let cancelled = false;

  /* ── DOM ── */
  const style = el("style", undefined, STYLE);
  const buildButton = w.button("Build", { onClick: () => { void build(); } });
  buildButton.title = "Run the script and install its triggers as the map's generated block";
  const importButton = w.button("Import map triggers", { onClick: () => { void importHand(); } });
  importButton.title = "Rewrite the map's hand-made triggers as script, appended around the block, and rebuild";
  const simulateButton = w.button("Simulate", { onClick: () => { void simulateNow(); } });
  simulateButton.title = `Run the compiled triggers for ${SIMULATE_CYCLES} trigger cycles in a built-in interpreter and list what happened`;
  const programButton = el("button", { type: "button", className: "tsd-program", hidden: true, title: "Where the programs' variables are stored (death counters and switches)", onClick: () => { showVariables = !showVariables; render(); } });
  const problemsCount = el("span", { className: "hint" }, "");
  const variables = el("div", { className: "tsd-variables", hidden: true });
  const notice = el("div", { className: "tsd-notice", hidden: !initial?.stale }, "The triggers from the last build were edited or removed outside the script. They stay as hand-made triggers; the next Build appends a fresh block.");
  const hostEl = el("div", { className: "tsd-host" });
  host = hostEl;
  const problems = el("ul", { className: "tsd-problems", hidden: true });
  const fileList = el("ul", { className: "tsd-files" });
  const newButton = w.button("New file", { ghost: true, onClick: () => { void newFile(); } });
  newButton.className += " tsd-new";
  newButton.title = "Add a file to the script; main.ts imports it with import { … } from \"./name\"";
  const statusLine = w.statusLine();
  const root = el("div", { className: "tsd" },
    style,
    el("div", { className: "row" }, buildButton, importButton, simulateButton, el("span", { className: "grow" }), programButton, problemsCount),
    variables,
    notice,
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

  const render = () => {
    const errors = diagnostics.length;
    buildButton.setBusy(building && !importing);
    importButton.setBusy(importing);
    buildButton.disabled = importButton.disabled = !ready || building;
    simulateButton.disabled = !ready || building || errors > 0;
    newButton.disabled = !ready;
    if (!ready) problemsCount.replaceChildren(w.spinner({ size: "sm", label: "Loading the editor…" }));
    else if (!result) problemsCount.textContent = "Checking…";
    else problemsCount.textContent = errors ? `${errors} problem${errors === 1 ? "" : "s"}` : "No problems";
    const programs = result?.programs ?? [];
    const userVariables = result?.variables.filter((v) => !v.name.startsWith("(")) ?? [];
    programButton.hidden = programs.length === 0;
    if (programs.length) {
      const count = programs.reduce((n, p) => n + p.count, 0);
      const owners = [...new Set(programs.map((p) => `P${p.owner + 1}`))].join(", ");
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
        problems.append(el("li", undefined,
          el("span", { className: "where" }, "after"),
          el("span", { className: "msg" }, `${v.name} = ${v.kind === "number" ? sim.death(v.player!, v.unit!) : sim.switches[v.switch!] ? "true" : "false"}`),
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
    if (editor && monaco) setCompilerMarkers(monaco, files, r.diagnostics);
    render();
  };

  const input = () => generated ? { files, names: generated.names, reservedDeaths: generated.reservedDeaths, reservedSwitches: generated.reservedSwitches } : null;

  /** Type-check, run and lower in the background; markers land in the editor, the list below. */
  const check = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const req = input();
      if (cancelled || !req) return;
      compileInBackground(req, svc.dist()).then(
        (r) => { if (!cancelled) applyResult(r); },
        (err: Error) => { if (!cancelled && !(err instanceof CompileSuperseded)) setStatus("error", `Compiler: ${err.message}`); },
      );
    }, CHECK_DELAY_MS);
  };

  const compileNow = async (): Promise<CompileResult | null> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const req = input();
    if (!req) return null;
    try {
      const r = await compileInBackground(req, svc.dist());
      applyResult(r);
      return r;
    } catch (err) {
      if (!(err instanceof CompileSuperseded)) setStatus("error", `Compiler: ${(err as Error).message}`);
      return null;
    }
  };

  const build = async (takeOver = false): Promise<boolean> => {
    if (building || !ready) return false;
    building = true;
    setStatus("busy", "Running the script…");
    try {
      const r = await compileNow();
      if (!r) return false;
      if (!r.ok) {
        const n = r.diagnostics.length;
        setStatus("error", `Not built: ${n} error${n === 1 ? "" : "s"}.`);
        return false;
      }
      const wasStale = svc.state()?.stale ?? false;
      setStatus("busy", "Installing the triggers…");
      const out = await svc.build(files, { takeOver });
      if (!out.block) { setStatus("error", "Not built: the map closed."); return false; }
      const b = out.block;
      setStatus("ok", b.count === 0
        ? "Built: the script defines no triggers; the block is empty."
        : `Built ${b.count} trigger${b.count === 1 ? "" : "s"} → #${b.start + 1}–#${b.start + b.count}${wasStale ? " (appended: the previous block had been edited outside the script)" : ""}.`);
      return true;
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
    const r = await compileNow();
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

  /** The map's names changed under the open editor: refresh the declarations. */
  const refreshNames = () => {
    if (cancelled) return;
    generated = svc.names();
    if (monaco && generated) setDeclarations(monaco, generated.decls);
    render();
    check();
  };

  const reveal = (file?: string, line?: number) => { if (line) goTo(file ?? ENTRY_FILE, line); else if (file) { editor?.show(file); renderFiles(); } };

  const handle = api.ui.dialog({
    title: "TrigScript",
    size: "full",
    tall: true,
    // Escape inside the editor dismisses its own popups (suggestions, parameter hints); it must not close the dialog.
    keepOpenOnEscape: (target) => !!host && target instanceof Node && host.contains(target),
    mount(body, dialog) {
      body.append(root);
      render();
      // Monaco comes from the CDN on first open, which can take a while: the editor's box says so.
      const loadingCover = w.busy(hostEl, "Loading the editor…");
      // Checks run on every keystroke (debounced), so the compile worker stays up while the editor is open.
      const releaseWorker = retainCompileWorker();
      const subs = [
        api.events.on("settings", refreshNames),
        api.events.on("locations", refreshNames),
        api.events.on("triggers", refreshNames),
        // The script belongs to the map: another map, or none, closes the editor.
        api.events.on("document", () => dialog.close()),
      ];
      loadMonaco(svc.dist()).then(
        (m) => {
          if (cancelled) return;
          monaco = m;
          if (generated) setDeclarations(m, generated.decls);
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
        if (current?.handle === handle) current = null;
      };
    },
    buttons: [
      { label: "Build & Close", primary: true, run: async () => ((await build()) ? undefined : false) },
      { label: "Close" },
      // Returning the promise keeps the footer busy — ring, buttons held — until the build lands.
      { label: "Build", closes: false, run: async () => { await build(); } },
    ],
  });
  current = { handle, reveal };
}
