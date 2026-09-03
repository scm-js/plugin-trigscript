/**
 * Compiling off the main thread. TypeScript is nine megabytes of JavaScript and a program
 * check takes tens of milliseconds, neither of which belongs on the main thread while the
 * user types — so the compiler runs in a worker: a classic worker built from a blob that
 * `importScripts` TypeScript from the CDN and then `import()`s this plugin's own compiler
 * module by the `blob:` URL the editor's loader gave it (`compiler/entry.ts`). Requests are
 * numbered; a result for anything but the newest request is dropped, so a burst of
 * keystrokes settles on the last one.
 *
 * If the worker cannot start, or cannot import the module (a browser that keeps a
 * window's blob URLs from its workers), the compiler runs on the main thread instead,
 * with TypeScript loaded once through a `<script>` tag — slower, never silent.
 */
import type * as TS from "typescript";
import { compileScript, type CompileOptions, type CompileResult } from "./compiler/compiler";
import { ENTRY_URL } from "./compiler/entry";

/** The same TypeScript the compiler is written against; `lib/typescript.js` defines a global `ts`. */
export const TS_URL = "https://cdn.jsdelivr.net/npm/typescript@6.0.2/lib/typescript.js";

interface CompileRequest {
  id: number;
  moduleUrl: string;
  source: string;
  declarations: string;
  options?: CompileOptions;
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
self.onmessage = async (e) => {
  const { id, moduleUrl, source, declarations, options } = e.data;
  try {
    if (!loading) loading = import(moduleUrl);
    let mod;
    try { mod = await loading; } catch (err) { loading = null; postMessage({ id, error: String((err && err.message) || err), fatal: true }); return; }
    postMessage({ id, result: mod.compileScript(self.ts, source, declarations, options) });
  } catch (err) {
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
`;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: CompileResult) => void; reject: (e: Error) => void }>();

/**
 * The worker is a whole TypeScript instance (tens of MB of heap) and it is only busy while
 * the Script Editor is checking as you type. It goes away this long after its last answer
 * — unless a `retainCompileWorker` lease is held, which the open Script Editor does — and
 * is started again on the next request.
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

function breakWorker(reason: string) {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(reason));
  }
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined" || !ENTRY_URL.startsWith("blob:")) return null;
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
    if (data.result) p.resolve(data.result);
    else p.reject(new Error(data.error ?? "Compile failed."));
    settle();
  };
  worker.onerror = () => breakWorker("worker unavailable");
  return worker;
}

let tsHere: Promise<typeof TS> | null = null;

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

async function compileHere(source: string, declarations: string, options?: CompileOptions): Promise<CompileResult> {
  return compileScript(await loadTypeScript(), source, declarations, options);
}

export class CompileSuperseded extends Error {
  constructor() {
    super("A newer compile replaced this one.");
    this.name = "CompileSuperseded";
  }
}

/** Compile in the background. Rejects with `CompileSuperseded` when a newer request arrived first. */
export function compileInBackground(source: string, declarations: string, options?: CompileOptions): Promise<CompileResult> {
  const w = getWorker();
  if (!w) return compileHere(source, declarations, options);
  const id = ++seq;
  // Anything still in flight is stale now.
  for (const [old, p] of pending) {
    pending.delete(old);
    p.reject(new CompileSuperseded());
  }
  return new Promise<CompileResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: CompileRequest = { id, moduleUrl: ENTRY_URL, source, declarations, options };
    w.postMessage(req);
  }).catch((err: Error) => {
    if (err.message === "worker unavailable") return compileHere(source, declarations, options);
    throw err;
  });
}
