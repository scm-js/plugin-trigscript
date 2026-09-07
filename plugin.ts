/**
 * TrigScript: TypeScript kept as files inside the map and built into a block of its
 * trigger list. This is the activation: the editor under Triggers, a claim on the
 * generated block so the editor's own trigger editors show it badged and locked, and
 * the commands other plugins call (`trigscript.compile`, `.build`, …). The language and
 * the compiler are documented in the README.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { TriggerRecord } from "./vendor/triggers";
import { openScriptEditor } from "./editor";
import { ScriptService, type ScriptInput } from "./service";

export default function activate(api: PluginApi) {
  const svc = new ScriptService(api, (file, line) => openScriptEditor(svc, { file, line }));

  // A hand trigger inserted before the block moved it: keep the manifest pointing at it.
  api.events.on("triggers", () => { svc.relocate(); if (svc.manifestChanged()) svc.claim.refresh(); });
  api.events.on("file", () => { if (svc.manifestChanged()) svc.claim.refresh(); });
  api.events.on("document", () => { svc.manifestChanged(); svc.claim.refresh(); });

  api.commands.register({ id: "open", title: "TrigScript…", enabled: () => api.document.isOpen(), run: (options) => openScriptEditor(svc, isRecord(options) ? { file: str(options.file), line: num(options.line), dock: options.dock === true ? true : options.dock === false ? false : undefined } : {}) });
  api.commands.register({ id: "dock", title: "TrigScript beside the map", enabled: () => api.document.isOpen(), run: () => openScriptEditor(svc, { dock: true }) });
  api.menu.add("Triggers", { label: "TrigScript…", after: "Text Trigger Editor…", enabled: () => api.document.isOpen(), command: "open" });
  api.menu.add("Triggers", { label: "TrigScript beside the map", after: "TrigScript…", enabled: () => api.document.isOpen(), command: "dock" });

  // What other plugins reach: the script without the editor.
  api.commands.register({ id: "state", title: "TrigScript: state", run: () => svc.state() });
  api.commands.register({ id: "declarations", title: "TrigScript: declarations", run: (options) => svc.declarations({ compact: isRecord(options) && options.compact === true }) });
  api.commands.register({ id: "compile", title: "TrigScript: compile", run: (input) => svc.compile(scriptInput(input)) });
  api.commands.register({ id: "build", title: "TrigScript: build", run: (input, options) => svc.build(scriptInput(input), { takeOver: isRecord(options) && options.takeOver === true }) });
  api.commands.register({ id: "print", title: "TrigScript: print records as script", run: (triggers, options) => svc.print(records(triggers), isRecord(options) ? { imports: options.imports === true, header: str(options.header) } : undefined) });
  api.commands.register({ id: "simulate", title: "TrigScript: simulate records", run: (triggers, cycles, options) => svc.simulate(records(triggers), Math.max(1, Math.round(Number(cycles) || 30)), { player: isRecord(options) && typeof options.player === "number" ? options.player : undefined }) });
  api.commands.register({ id: "triggerAt", title: "TrigScript: trigger at a source line", run: (file, line) => svc.triggerAt(str(file) ?? "main.ts", Number(line) || 0) });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const records = (v: unknown): TriggerRecord[] => (Array.isArray(v) ? (v as TriggerRecord[]) : []);
/** A string is the entry file; an object is every file by path. */
const scriptInput = (v: unknown): ScriptInput => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === "string")) as Record<string, string> : String(v ?? ""));
