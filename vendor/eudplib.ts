/**
 * The contract of the eudplib library plugin's `eudplib.build` service — a copy of
 * `contract.d.ts` in github.com/scm-js/plugin-eudplib, taken by `import type` only.
 * Refresh it from there when the library's service version moves.
 */
export interface EudplibBuildRequest {
  /** The map as a .scm/.scx archive. */
  map: Uint8Array;
  /** euddraft plugin sections, name → settings (the .eds sections: value strings or numbers). */
  plugins: Record<string, Record<string, string | number>>;
  /** Extra euddraft plugins the caller brings as Python source, module name → code; a name here may also appear in `plugins` with its settings. */
  sources?: Record<string, string>;
  /** Data files the caller brings, file name → text, written to `/work/files/<name>` for a plugin setting to name (library 0.2). */
  files?: Record<string, string>;
  options?: { shufflePayload?: boolean; sectorSize?: number };
}
export interface EudplibBuildResult { map: Uint8Array; log: string; chkBytes: number; ms: number }
export type EudplibState = "absent" | "installing" | "ready" | "failed";
export interface EudplibService {
  /** The plugin's version, eudplib's, and Pyodide's. */
  versions: { plugin: string; eudplib: string; pyodide: string; euddraft: string };
  state(): EudplibState;
  /** Download size in bytes, for a caller that wants to say it before calling ensure(). */
  downloadBytes: number;
  /** Make the runtime available: true when ready, false when the user declined. Opens the install dialog when the runtime is absent; concurrent callers share one install. */
  ensure(opts?: { reason?: string }): Promise<boolean>;
  build(request: EudplibBuildRequest, opts?: { signal?: AbortSignal; onLog?: (line: string) => void }): Promise<EudplibBuildResult>;
}
/** The service name, as `api.services.get` / `watch` take it. */
export const EUDPLIB_SERVICE = "eudplib.build";
