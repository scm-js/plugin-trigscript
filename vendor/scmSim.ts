/**
 * The part of the scm-sim plugin's `scm-sim.engine` service that TrigScript uses — a copy of
 * what `contract.d.ts` in github.com/scm-js/plugin-scm-sim says of it, taken by `import type`
 * only. TrigScript never imports the engine: it hands the engine's page its tests (TrigScript
 * 4, A2), and the page runs them beside the game.
 */
export const SCM_SIM_SERVICE = "scm-sim.engine";

export interface ScmSimStatus {
  available: boolean;
  /** When not available: why, in words for the person. */
  reason: string | null;
  /** The version of the test request the page answers; null or absent: it answers none. */
  tests?: number | null;
  /** The version of the request for a test of several players; null or absent: the page (or the browser) cannot run copies. */
  copies?: number | null;
  /** The version of the debugger's requests (TrigScript 4, A5); null or absent: the page has no debugger. */
  debug?: number | null;
}

/** A test recorded for the debugger: the module's record, and the run's game held for pictures until `close()`. */
export interface ScmSimDebugSession {
  readonly recording: unknown;
  picture(frame: number, options?: { signal?: AbortSignal }): Promise<{ frame: number; kept: unknown }>;
  close(): void;
  readonly closed: boolean;
}

/**
 * The part of the plugin's view (`ScmSimView`) the debugger draws with: `debug(map)` starts the built map the way
 * the engine's page started it for the record, `show(picture)` draws a picture of the run. Absent from a view from
 * before the debugger.
 */
export interface ScmSimDebugView {
  debug?(map: Uint8Array): Promise<unknown>;
  show?(picture: { frame: number; kept: unknown }): void;
  /** What went wrong with no request waiting on it: a picture that could not be drawn. */
  onError?(listener: (message: string) => void): { dispose(): void };
  dispose(): void;
}

/** One copy's answer to `testCopies`. */
export interface TestCopyResult {
  result: unknown;
  error: string | null;
  desync: unknown;
  frame: number;
  player: number;
}

export interface ScmSimEngine {
  /** Whether this editor has the engine beside it at all (scmjs.dev, or a stand-in for the site). */
  readonly present: boolean;
  status(): Promise<ScmSimStatus>;
  /**
   * A script's tests beside the game: the map as Save builds it (a whole .scx; the page reads
   * its scenario) or that scenario as eudplib built it, the text of a module
   * whose `runGameTests(game, payload)` runs them, and its payload; resolves with what the
   * module returned. Absent from the plugin before 0.11.0.
   */
  test?(scenario: Uint8Array, module: string, payload: unknown, options?: { signal?: AbortSignal; onProgress?: (p: { stage: "starting" }) => void }): Promise<unknown>;
  /**
   * A test of several players (TrigScript 4, A3): a copy of the game for each of `players`, kept in step, each
   * running the module's `drive(game, payload)`; `triggers` the build's map of them, for the lines of a desync.
   * Resolves with each copy's answer, in the order of `players`. Absent from the plugin before 0.11.0.
   */
  testCopies?(scenario: Uint8Array, module: string, payload: unknown, options: { players: number[]; triggers?: { payload: number; triggers: [number, number, number, string, string[]?][] } | null; signal?: AbortSignal; onProgress?: (p: { stage: "starting" }) => void }): Promise<TestCopyResult[]>;
  /**
   * One test recorded for the debugger (TrigScript 4, A5): the module's `debugGameTest(game, payload)` runs it once
   * with everything written down, and the run's game stays with the page for pictures. Absent before 0.11.0.
   */
  debug?(scenario: Uint8Array, module: string, payload: unknown, options?: { signal?: AbortSignal; onProgress?: (p: { stage: "starting" }) => void }): Promise<ScmSimDebugSession>;
  /** A view of the game in `element` (the plugin's replay view, which draws a debugged run's pictures from 0.11.0). */
  view?(element: HTMLElement): ScmSimDebugView;
}
