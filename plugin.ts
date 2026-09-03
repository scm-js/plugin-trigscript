/**
 * Trigger Script: a TypeScript-subset language kept as a file inside the map and compiled
 * into a block of its trigger list. This is the activation: the Script Editor under
 * Triggers, a claim on the generated block so the editor's own trigger editors show it
 * badged and locked, and the commands other plugins call (`trigger-script.compile`,
 * `.build`, …). The language and the compiler are documented in the README.
 */
import type { PluginApi } from "./plugin-api/plugins/api";
import type { TriggerRecord } from "./vendor/triggers";
import { openScriptEditor } from "./editor";
import { ScriptService } from "./service";

export default function activate(api: PluginApi) {
  const svc = new ScriptService(api, (line) => openScriptEditor(svc, { line }));

  // A hand trigger inserted before the block moved it: keep the manifest pointing at it.
  api.events.on("triggers", () => { svc.relocate(); if (svc.manifestChanged()) svc.claim.refresh(); });
  api.events.on("file", () => { if (svc.manifestChanged()) svc.claim.refresh(); });
  api.events.on("document", () => { svc.manifestChanged(); svc.claim.refresh(); });

  api.commands.register({ id: "open", title: "Script Editor…", enabled: () => api.document.isOpen(), run: (options) => openScriptEditor(svc, isOptions(options) ? options : {}) });
  api.menu.add("Triggers", { label: "Script Editor…", after: "Text Trigger Editor…", enabled: () => api.document.isOpen(), command: "open" });

  // What other plugins reach: the Script Editor without the editor.
  api.commands.register({ id: "state", title: "Trigger script: state", run: () => svc.state() });
  api.commands.register({ id: "declarations", title: "Trigger script: declarations", run: () => svc.declarations() });
  api.commands.register({ id: "compile", title: "Trigger script: compile", run: (source) => svc.compile(String(source ?? "")) });
  api.commands.register({ id: "build", title: "Trigger script: build", run: (source, options) => svc.build(String(source ?? ""), { takeOver: isRecord(options) && options.takeOver === true }) });
  api.commands.register({ id: "print", title: "Trigger script: print records as script", run: (triggers) => svc.print(records(triggers)) });
  api.commands.register({ id: "simulate", title: "Trigger script: simulate records", run: (triggers, cycles, options) => svc.simulate(records(triggers), Math.max(1, Math.round(Number(cycles) || 30)), { player: isRecord(options) && typeof options.player === "number" ? options.player : undefined }) });
  api.commands.register({ id: "triggerAtLine", title: "Trigger script: trigger at a source line", run: (line) => svc.triggerAtLine(Number(line) || 0) });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isOptions = (v: unknown): v is { line?: number } => isRecord(v);
const records = (v: unknown): TriggerRecord[] => (Array.isArray(v) ? (v as TriggerRecord[]) : []);
