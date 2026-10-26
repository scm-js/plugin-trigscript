/**
 * An example of a plugin that provides a TrigScript library. The library is the TrigScript in lib/, carried as text in
 * modules.ts (`node embed.mjs`), and handed to TrigScript through its `trigscript.build` service whenever TrigScript is
 * there — it may start before this plugin or after it, and come back after an update. Scripts then import it by the
 * id: `import { spawnWave } from "waves"`.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { MODULES } from "./modules";

/** The part of TrigScript's `trigscript.build` a library needs (its `contract.d.ts` has the whole). */
interface TrigScriptBuild {
  provideLibrary(library: { id: string; label: string; version: string; modules: Record<string, string> }): { dispose(): void };
}

export default function activate(api: PluginApi) {
  let held: { dispose(): void } | null = null;
  const watched = api.services.watch<TrigScriptBuild>("trigscript.build", (build, info) => {
    held?.dispose();
    held = null;
    // Version 2 of the service is the first with libraries.
    if (build && (info?.version ?? 1) >= 2) held = build.provideLibrary({ id: "waves", label: "Waves", version: api.plugin.version ?? "1.0.0", modules: MODULES });
  });
  return () => { watched.dispose(); held?.dispose(); };
}
