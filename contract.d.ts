/**
 * The `trigscript.build` service, as other plugins see it (TrigScript 4): TrigScript as the library other plugins
 * build their programs through. Types only: take this file with `import type` and reach the object through
 * `api.services.watch("trigscript.build", …)`. The provider's `ServiceInfo.version` is 1 for this shape.
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

export interface TrigScriptBuildService {
  /** The plugin's version. */
  versions: { plugin: string };
  /** Take part in every build of the open map while the handle lives; the second contribution of one id replaces the first. */
  contribute(contribution: TrigScriptBuildContribution): { dispose(): void };
  /** Hear how each build goes: the log, and where a failure points. */
  onBuild(listener: (event: TrigScriptBuildEvent) => void): { dispose(): void };
  /** Compile a contribution's source against the open map without building: for a contributor's own preflight. */
  check(files: Record<string, string>, entries: string[]): Promise<TrigScriptContributionCheck>;
}

/** The service name, as `api.services.get` / `watch` take it. */
export declare const TRIGSCRIPT_BUILD_SERVICE: "trigscript.build";
