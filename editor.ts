/**
 * The Script Editor dialog: Monaco over the map's trigger script, checked live against
 * declarations generated from the map (`compiler/declarations.ts`) and compiled in the
 * worker (`compile.ts`). Build installs the result as the script's block of the trigger
 * list (`service.ts`).
 *
 * The source is the map's: every edit is written straight into the archive (it is a file
 * in the .scx, like a WAV), so closing the dialog loses nothing — only Build changes
 * triggers. Monaco and TypeScript come from the CDN on first open.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { compileInBackground, CompileSuperseded, retainCompileWorker } from "./compile";
import type { CompileResult, ScriptDiagnostic } from "./compiler/compiler";
import { printScript, SCRIPT_HEADER } from "./compiler/print";
import { Simulation, type SimulationEvent } from "./compiler/simulate";
import { actionDef } from "./vendor/triggerDefs";
import { createScriptEditor, DEFAULT_DIST, DIST_STORAGE_KEY, loadMonaco, releaseScriptEditor, setCompilerMarkers, setDeclarations, type MonacoApi, type ScriptEditor } from "./monaco";
import type { MapNames, ScriptService } from "./service";

export const TEMPLATE = `${SCRIPT_HEADER}
// Names come from the map: Locations.*, Switches.*, Units.*, Players.* (or P1 … P12, CurrentPlayer, AllPlayers).

trigger(AllPlayers, [
  Bring(CurrentPlayer, Units.AnyUnit, Locations.Anywhere, "At least", 1),
], [
  DisplayText("Always Display", "Hello from the trigger script."),
  PreserveTrigger(),
]);

// Everything else is a program: let variables (death counters / switches), if, while,
// for, functions. It runs as one player, one loop iteration per trigger cycle.
program({ owner: P1 });
let cycles = 0;
while (true) {
  cycles++;
  if (cycles == 10) {
    DisplayText("Always Display", "Ten trigger cycles have passed.");
  }
}
`;

/** Trigger cycles the Simulate button runs. */
export const SIMULATE_CYCLES = 30;

const CHECK_DELAY_MS = 350;

const STYLE = `
.tsd { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.tsd .tsd-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); box-shadow: var(--bevel-sunken); border-radius: var(--radius); overflow: hidden; background: var(--bg-0); }
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

interface OpenEditor {
  handle: DialogHandle;
  reveal(line?: number): void;
}

let current: OpenEditor | null = null;

/** Open the Script Editor (or bring the open one to the line). */
export function openScriptEditor(svc: ScriptService, options: { line?: number } = {}): void {
  if (current?.handle.isOpen()) { current.reveal(options.line); return; }
  current = null;
  const api = svc.api;
  if (!api.document.isOpen()) { api.ui.toast({ kind: "info", title: "Open or create a map first." }); return; }
  const el = api.ui.el;
  const w = api.ui.widgets;

  const initial = svc.state();
  let source = initial?.source ?? TEMPLATE;
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
  buildButton.title = "Compile the script and install its triggers as the map's generated block";
  const importButton = w.button("Import map triggers", { onClick: () => { void importHand(); } });
  importButton.title = "Rewrite the map's hand-made triggers as script, appended around the block, and rebuild";
  const simulateButton = w.button("Simulate", { onClick: () => { void simulateNow(); } });
  simulateButton.title = `Run the compiled triggers for ${SIMULATE_CYCLES} trigger cycles in a built-in interpreter and list what happened`;
  const programButton = el("button", { type: "button", className: "tsd-program", hidden: true, title: "Where the program's variables are stored (death counters and switches)", onClick: () => { showVariables = !showVariables; render(); } });
  const problemsCount = el("span", { className: "hint" }, "");
  const variables = el("div", { className: "tsd-variables", hidden: true });
  const notice = el("div", { className: "tsd-notice", hidden: !initial?.stale }, "The triggers from the last build were edited or removed outside the script. They stay as hand-made triggers; the next Build appends a fresh block.");
  const hostEl = el("div", { className: "tsd-host" });
  host = hostEl;
  const problems = el("ul", { className: "tsd-problems", hidden: true });
  const statusLine = w.statusLine();
  const root = el("div", { className: "tsd" },
    style,
    el("div", { className: "row" }, buildButton, importButton, simulateButton, el("span", { className: "grow" }), programButton, problemsCount),
    variables,
    notice,
    el("div", { className: "tsd-editor" }, hostEl, problems),
    statusLine,
  );

  let status: { kind: "info" | "ok" | "error" | "busy"; text: string } = { kind: "info", text: "" };
  const setStatus = (kind: "info" | "ok" | "error" | "busy", text: string) => { status = { kind, text }; render(); };

  const goTo = (line: number, column = 1) => {
    if (!editor) return;
    editor.editor.revealLineInCenter(line);
    editor.editor.setPosition({ lineNumber: line, column });
    editor.editor.focus();
  };

  const render = () => {
    const errors = diagnostics.length;
    buildButton.setBusy(building && !importing);
    importButton.setBusy(importing);
    buildButton.disabled = importButton.disabled = !ready || building;
    simulateButton.disabled = !ready || building || errors > 0;
    if (ready) problemsCount.textContent = errors ? `${errors} problem${errors === 1 ? "" : "s"}` : "No problems";
    else problemsCount.replaceChildren(w.spinner({ size: "sm", label: "Loading the editor…" }));
    const program = result?.program ?? null;
    const userVariables = result?.variables.filter((v) => !v.name.startsWith("(")) ?? [];
    programButton.hidden = !program;
    if (program) programButton.textContent = `Program: ${program.count} trigger${program.count === 1 ? "" : "s"} as P${program.owner + 1}${program.hyperTriggers ? " + hyper triggers" : ""} · ${userVariables.length} variable${userVariables.length === 1 ? "" : "s"}`;
    variables.hidden = !(showVariables && result && result.variables.length > 0);
    variables.replaceChildren(...(result?.variables ?? []).map((v) => el("span", { className: v.name.startsWith("(") ? "internal" : undefined }, el("b", undefined, v.name), ` ${v.kind === "number" ? "number" : "boolean"} → ${v.storage}`)));
    // Read live, not cached: the block's state belongs to the map and other editors change it.
    const state = svc.state();
    const block = state?.block ?? null;
    const stale = state?.stale ?? false;
    notice.hidden = !stale;

    problems.replaceChildren();
    problems.className = "tsd-problems";
    if (errors > 0) {
      problems.hidden = false;
      for (const d of diagnostics) {
        problems.append(el("li", { title: d.message, onClick: () => goTo(d.line, d.column) },
          el("span", { className: "where" }, `${d.line}:${d.column}`),
          el("span", { className: "msg" }, d.message.split("\n")[0]),
          el("span", { className: "src" }, d.source === "typescript" ? "types" : "compiler"),
        ));
      }
    } else if (simulation) {
      problems.hidden = false;
      problems.className = "tsd-problems tsd-run";
      const { sim, result: r } = simulation;
      if (sim.events.length === 0) problems.append(el("li", undefined, el("span", { className: "where" }, "—"), el("span", { className: "msg" }, `No actions ran in ${SIMULATE_CYCLES} cycles.`)));
      for (const e of sim.events) {
        const line = r.lines[e.trigger];
        problems.append(el("li", { title: `Trigger #${e.trigger + 1}`, onClick: () => { if (line) goTo(line); } },
          el("span", { className: "where" }, `cycle ${e.cycle + 1}`),
          el("span", { className: "msg" }, describeEvent(e)),
          el("span", { className: "src" }, `L${line ?? "?"}`),
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
    if (editor && monaco) setCompilerMarkers(monaco, editor.model, r.diagnostics);
    render();
  };

  /** Type-check and compile in the background; markers land in the editor, the list below. */
  const check = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled || !generated) return;
      compileInBackground(source, generated.decls, generated.options).then(
        (r) => { if (!cancelled) applyResult(r); },
        (err: Error) => { if (!cancelled && !(err instanceof CompileSuperseded)) setStatus("error", `Compiler: ${err.message}`); },
      );
    }, CHECK_DELAY_MS);
  };

  const compileNow = async (): Promise<CompileResult | null> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!generated) return null;
    try {
      const r = await compileInBackground(source, generated.decls, generated.options);
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
    setStatus("busy", "Compiling…");
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
      const out = await svc.build(source, { takeOver });
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

  /** Move the hand-made triggers into the script (in their list order around the block) and rebuild from it. */
  const importHand = async () => {
    if (!editor || !generated) return;
    const { before, after } = svc.handTriggers();
    if (before.length + after.length === 0) { setStatus("info", "There are no hand-made triggers to import."); return; }
    const ctx = { names: generated.names, string: (i: number) => api.names.string(i) };
    const blank = source.trim() === "" || source === TEMPLATE;
    // Hand triggers keep their order around the script's own: those before the block go first, those after it last.
    const text = blank
      ? printScript([...before, ...after], ctx)
      : [
          before.length ? printScript(before, ctx, "").trimStart() : "",
          source.replace(/\s+$/, "") + "\n",
          after.length ? printScript(after, ctx, "").trimStart() : "",
        ].filter((s) => s !== "").join("\n");
    editor.model.setValue(text);
    source = text;
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
      const sim = new Simulation(r.triggers, { strings: r.strings, player: r.program?.owner }).run(SIMULATE_CYCLES);
      simulation = { sim, result: r };
      setStatus("ok", `Simulated ${SIMULATE_CYCLES} trigger cycles as P${sim.player + 1}: ${sim.events.length} action${sim.events.length === 1 ? "" : "s"} ran. Unit conditions (Bring, Command, …) count as false; Wait takes no time.`);
    } catch (err) {
      setStatus("error", `Simulation stopped: ${(err as Error).message}`);
    }
  };

  /** The map's names changed under the open editor: refresh the declarations. */
  const refreshNames = () => {
    if (cancelled) return;
    generated = svc.names();
    if (monaco && generated) setDeclarations(monaco, generated.decls);
    render();
    check();
  };

  const reveal = (line?: number) => { if (line) goTo(line); };

  const handle = api.ui.dialog({
    title: "Script Editor",
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
      loadMonaco(api.storage.get(DIST_STORAGE_KEY, DEFAULT_DIST)).then(
        (m) => {
          if (cancelled) return;
          monaco = m;
          if (generated) setDeclarations(m, generated.decls);
          // Uncover first: `done` puts the host back in its own place, and Monaco measures it where it lands.
          loadingCover.done();
          editor = createScriptEditor(m, hostEl, source, (text) => {
            source = text;
            svc.writeSource(text);
            check();
          });
          reveal(options.line);
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
