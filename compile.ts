/**
 * Compiling off the main thread. TypeScript is nine megabytes of JavaScript, a program
 * check takes tens of milliseconds, and the script then *runs* — none of which belongs
 * on the main thread while the user types — so the compiler runs in a worker: a classic
 * worker built from a blob that `importScripts` TypeScript from the CDN, fetches the
 * standard library's declarations once from the plugin's `dist/`, and `import()`s this
 * plugin's own compiler module — by the `blob:` URL the editor's loader gave it
 * (`compiler/entry.ts`), or, for a copy compiled into the editor, the release's own
 * `dist/compiler.js` from the CDN (`workerModuleUrl`). Requests are numbered; a result for anything but the newest
 * request is dropped, so a burst of keystrokes settles on the last one.
 *
 * A script that never finishes (an endless loop outside `program()`) would hang the
 * worker, so a request that is not answered in `COMPILE_TIMEOUT_MS` terminates it and
 * rejects; the next request starts a fresh worker. If the worker cannot start, or cannot
 * import the module (a browser that keeps a window's blob URLs from its workers), the
 * compiler runs on the main thread instead, with TypeScript loaded once through a
 * `<script>` tag — slower, never silent, and without the timeout's protection.
 */
import type * as TS from "typescript";
import { compileScript, type CompileResult, type ScriptFiles } from "./compiler/compiler";
import { ENTRY_URL } from "./compiler/entry";
import type { ScriptNames } from "./compiler/names";
import { DEFAULT_DIST } from "./monaco";
import { VERSION } from "./version";

/** The same TypeScript the compiler is written against; `lib/typescript.js` defines a global `ts`. */
export const TS_URL = "https://cdn.jsdelivr.net/npm/typescript@6.0.3/lib/typescript.js";

/** The standard library, concatenated by `bundle/build.mjs`, next to the Monaco build. */
export const libUrl = (dist: string = DEFAULT_DIST) => `${dist.replace(/\/+$/, "")}/lib.d.ts`;

/**
 * The compiler as one module, for the worker, when the plugin was not loaded through
 * `blob:` URLs: `dist/compiler.js` (`npm run build` bundles `compiler/entry.ts` into it)
 * at this release's own tag, so the worker runs the same compiler as the plugin. A
 * `monacoDist` override (development) serves it from the same directory as Monaco.
 */
export const compilerUrl = (dist: string = DEFAULT_DIST) =>
  dist === DEFAULT_DIST ? `https://cdn.jsdelivr.net/gh/scm-js/plugin-trigscript@v${VERSION}/dist/compiler.js` : `${dist.replace(/\/+$/, "")}/compiler.js`;

/**
 * What the worker is told to import. The editor's loader turns a fetched plugin into
 * `blob:` modules, and the compiler's own blob URL is the compiler the main thread would
 * run. A plugin compiled into the editor (a default) has no such URL — its module is a
 * chunk of the editor's bundle, which imports the editor's own chunks and cannot load
 * outside a page — so the worker fetches this release's compiler bundle instead.
 */
export const workerModuleUrl = (dist: string = DEFAULT_DIST) => (ENTRY_URL.startsWith("blob:") ? ENTRY_URL : compilerUrl(dist));

export const COMPILE_TIMEOUT_MS = 15_000;

export interface CompileInput {
  files: ScriptFiles;
  names: ScriptNames;
  reservedDeaths?: readonly (readonly [number, number])[];
  reservedSwitches?: readonly number[];
}

interface CompileRequest extends CompileInput {
  id: number;
  moduleUrl: string;
  libUrl: string;
}

interface CompileResponse {
  id: number;
  result?: CompileResult;
  error?: string;
  /** The worker could not load its compiler at all: every later request would fail the same way. */
  fatal?: boolean;
}

const WORKER_SOURCE = `
importScripts(${JSON.stringify(TS_URL)});
let loading = null;
let lib = null;
self.onmessage = async (e) => {
  const { id, moduleUrl, libUrl, files, names, reservedDeaths, reservedSwitches } = e.data;
  try {
    if (!loading) loading = import(moduleUrl);
    let mod;
    try { mod = await loading; } catch (err) { loading = null; postMessage({ id, error: String((err && err.message) || err), fatal: true }); return; }
    if (lib === null) {
      const r = await fetch(libUrl);
      if (!r.ok) throw new Error("Could not load the standard library from " + libUrl + " (" + r.status + ").");
      lib = await r.text();
    }
    postMessage({ id, result: mod.compileScript(self.ts, files, names, { lib, reservedDeaths, reservedSwitches }) });
  } catch (err) {
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
`;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: CompileResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/**
 * The worker is a whole TypeScript instance (tens of MB of heap) and it is only busy while
 * the editor is checking as you type. It goes away this long after its last answer —
 * unless a `retainCompileWorker` lease is held, which the open editor does — and is
 * started again on the next request.
 */
export const WORKER_IDLE_MS = 30_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let leases = 0;

function busy() {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function settle() {
  if (!worker || leases > 0 || pending.size > 0) return;
  busy();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!worker || leases > 0 || pending.size > 0) return;
    worker.terminate();
    worker = null;
  }, WORKER_IDLE_MS);
}

/** Keep the worker alive until the returned function is called (idempotent). */
export function retainCompileWorker(): () => void {
  leases++;
  busy();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leases--;
    settle();
  };
}

/** Whether a compile worker exists right now. */
export function compileWorkerAlive(): boolean {
  return worker !== null;
}

function rejectAll(reason: string) {
  for (const [id, p] of pending) {
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
}

function breakWorker(reason: string) {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  rejectAll(reason);
}

/** The script ran too long: drop this worker (the next request starts another) and say so. */
function timeOut(id: number) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  worker?.terminate();
  worker = null;
  rejectAll("The compile was stopped.");
  p.reject(new Error(`The script did not finish in ${COMPILE_TIMEOUT_MS / 1000} seconds. Is there an endless loop outside program()?`));
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  busy();
  if (worker) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<CompileResponse>) => {
    const data = e.data;
    if (data.fatal) { breakWorker("worker unavailable"); return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    clearTimeout(p.timer);
    if (data.result) p.resolve(data.result);
    else p.reject(new Error(data.error ?? "Compile failed."));
    settle();
  };
  worker.onerror = () => breakWorker("worker unavailable");
  return worker;
}

let tsHere: Promise<typeof TS> | null = null;
let libHere: Promise<string> | null = null;

/** TypeScript on the main thread, loaded once from the CDN as a plain script (it defines `ts`). */
export function loadTypeScript(): Promise<typeof TS> {
  const g = globalThis as { ts?: typeof TS };
  if (g.ts) return Promise.resolve(g.ts);
  tsHere ??= new Promise<typeof TS>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TS_URL;
    script.async = true;
    script.onload = () => (g.ts ? resolve(g.ts) : reject(new Error("TypeScript loaded but defined no `ts`.")));
    script.onerror = () => { tsHere = null; script.remove(); reject(new Error(`Could not load TypeScript from ${TS_URL}.`)); };
    document.head.append(script);
  });
  return tsHere;
}

function loadLib(url: string): Promise<string> {
  libHere ??= fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not load the standard library from ${url} (${r.status}).`);
    return r.text();
  }).catch((err: Error) => { libHere = null; throw err; });
  return libHere;
}

async function compileHere(input: CompileInput, lib: string): Promise<CompileResult> {
  const [ts, text] = await Promise.all([loadTypeScript(), loadLib(lib)]);
  return compileScript(ts, input.files, input.names, { lib: text, reservedDeaths: input.reservedDeaths, reservedSwitches: input.reservedSwitches });
}

export class CompileSuperseded extends Error {
  constructor() {
    super("A newer compile replaced this one.");
    this.name = "CompileSuperseded";
  }
}

/** Compile in the background. Rejects with `CompileSuperseded` when a newer request arrived first. */
export function compileInBackground(input: CompileInput, dist: string = DEFAULT_DIST): Promise<CompileResult> {
  const lib = libUrl(dist);
  const w = getWorker();
  if (!w) return compileHere(input, lib);
  const id = ++seq;
  // Anything still in flight is stale now.
  for (const [old, p] of pending) {
    pending.delete(old);
    clearTimeout(p.timer);
    p.reject(new CompileSuperseded());
  }
  return new Promise<CompileResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, timer: setTimeout(() => timeOut(id), COMPILE_TIMEOUT_MS) });
    const req: CompileRequest = { id, moduleUrl: workerModuleUrl(dist), libUrl: lib, files: input.files, names: input.names, reservedDeaths: input.reservedDeaths, reservedSwitches: input.reservedSwitches };
    w.postMessage(req);
  }).catch((err: Error) => {
    if (err.message === "worker unavailable") return compileHere(input, lib);
    throw err;
  });
}
