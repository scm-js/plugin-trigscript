/**
 * The `trigscript.build` service, as other plugins see it (TrigScript 4): TrigScript as the library other plugins
 * build their programs through. Types only: take this file with `import type` and reach the object through
 * `api.services.watch("trigscript.build", …)`. The provider's `ServiceInfo.version` is 2 for this shape (1 had no
 * `provideLibrary`).
 *
 * A plugin whose rows need code in the map writes them as TrigScript source — `program(() => { … })` bodies, the
 * language the guide describes — and *contributes* them: on Save, Test Map and an export TrigScript compiles them with
 * the map's own script (the contributed files run as entries after it, so their programs come after the script's) and
 * lays every program out into the saved map in one build. The map the user edits is never touched; the files never
 * enter the archive. Magenta contributes its build rows this way.
 */

/** A standing offer to take part in the map's build. */
export interface TrigScriptBuildContribution {
  /** The plugin's id ("magenta"): what the build's events name the contribution by. */
  id: string;
  /** What the editor's notice calls it. */
  label: string;
  /** Asked on every save: cheap, synchronous, no side effects. */
  applies(): boolean;
  /** Your part of the build for the open map as it is now. Throw an `Error` worded for the user. */
  collect(ctx: { purpose: "save" | "test" | "export"; signal: AbortSignal }): Promise<TrigScriptContributedScript>;
}

/**
 * The files a contribution brings: TrigScript source by path, each under a folder named after the plugin
 * (`magenta/main.ts`) so that none can shadow the map's own files, and which of them run as entries, in order. A
 * contribution holds programs only: a `trigger()` in it is a problem, since nothing writes it into the trigger list.
 * A file may import another of the contribution's (`./rows`) and the standard library ("trigscript/…").
 */
export interface TrigScriptContributedScript { files: Record<string, string>; entries: string[] }

/** What `check` says of a contribution's source, as a build would compile it. */
export interface TrigScriptContributionCheck {
  /** TypeScript's and the compiler's problems, a `trigger()` where only programs go, and what the build does not take, each at its file and 1-based line and column. */
  problems: { file: string; line: number; column: number; message: string }[];
  /** How many `program()`s the source holds. */
  programs: number;
}

export type TrigScriptBuildEvent =
  | { kind: "start"; purpose: "save" | "test" | "export"; contributors: string[] }
  | { kind: "log"; line: string }
  | { kind: "done"; purpose: "save" | "test" | "export"; contributors: string[]; log: string; chkBytes: number; ms: number }
  /** `from`: the id of the contribution whose part failed, or "trigscript" for the script's own. */
  | { kind: "failed"; purpose: "save" | "test" | "export"; contributors: string[]; from: string | null; message: string; log: string }
  /** What the map maker should hear of beyond the log: a trigger of the map's own left out or never run. */
  | { kind: "warning"; message: string };

/**
 * A library for scripts to import (service version 2): TrigScript modules by path, imported by the library's id —
 * `import { patrol } from "stamps/patrol"` is the module `patrol.ts`, `import { … } from "stamps"` is `index.ts`. A
 * module may import the library's other modules (`./waves`), another library ("other/x") and the standard library
 * ("trigscript/…"). It joins a script's files only when something imports it, so a `program()` at its top level runs
 * in the maps that import it and no others.
 *
 * A map copies the modules it imports when its script is applied, and builds with that copy from then on, wherever
 * it is opened and whether this plugin is installed there or not. A newer version provided later is offered to the
 * map maker as an update; it never replaces the copy by itself.
 */
export interface TrigScriptLibrary {
  /** What a script imports it by: lower-case letters, digits and "-", starting with a letter, up to 40; never "trigscript". */
  id: string;
  /** What the editor calls it ("Stamp Library"). */
  label: string;
  /** The library's version, as the map maker reads it ("1.2.0"). */
  version: string;
  /** Each module's TrigScript source by its path in the library, ending in .ts or .tsx: "patrol.ts", "ai/waves.tsx". No test files. */
  modules: Record<string, string>;
}

export interface TrigScriptBuildService {
  /** The plugin's version. */
  versions: { plugin: string };
  /** Take part in every build of the open map while the handle lives; the second contribution of one id replaces the first. */
  contribute(contribution: TrigScriptBuildContribution): { dispose(): void };
  /** Hear how each build goes: the log, and where a failure points. */
  onBuild(listener: (event: TrigScriptBuildEvent) => void): { dispose(): void };
  /** Compile a contribution's source against the open map without building: for a contributor's own preflight. */
  check(files: Record<string, string>, entries: string[]): Promise<TrigScriptContributionCheck>;
  /**
   * Hold a library out for scripts to import while the handle lives; the second of one id replaces the first. Throws
   * an `Error` saying what is wrong with a library it cannot take. Service version 2.
   */
  provideLibrary(library: TrigScriptLibrary): { dispose(): void };
}

/** The service name, as `api.services.get` / `watch` take it. */
export declare const TRIGSCRIPT_BUILD_SERVICE: "trigscript.build";
