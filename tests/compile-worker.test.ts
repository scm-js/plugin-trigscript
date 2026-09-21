/**
 * The compile worker's starts. A worker that cannot import the blob module is replaced by
 * one that imports the release's bundle; when that fails too the request rejects with
 * `CompilerUnavailable`, a later request starts over — and nothing is ever compiled on
 * the calling thread, where an endless loop in a script could not be stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Request { id: number; moduleUrl: string }

/** Stands in for `Worker`: every instance is kept, and answers a request as `answer` says. */
class FakeWorker {
  static made: FakeWorker[] = [];
  static answer: (req: Request) => object = () => ({});
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  seen: Request[] = [];
  terminated = false;
  constructor() { FakeWorker.made.push(this); }
  postMessage(req: Request) {
    this.seen.push(req);
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: { id: req.id, ...FakeWorker.answer(req) } }); });
  }
  terminate() { this.terminated = true; }
}

const INPUT = { files: { "main.ts": "" }, names: {} as never };
const RESULT = { diagnostics: [] };

async function load(entryUrl: string) {
  vi.resetModules();
  vi.doMock("../compiler/entry", () => ({ ENTRY_URL: entryUrl }));
  return import("../compile");
}

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../compiler/entry");
  vi.useRealTimers();
});

describe("the compile worker", () => {
  it("imports the blob module the loader made", async () => {
    const { compileInBackground } = await load("blob:editor/compiler");
    FakeWorker.answer = () => ({ result: RESULT });
    await expect(compileInBackground(INPUT)).resolves.toBe(RESULT);
    expect(FakeWorker.made.map((w) => w.seen.map((r) => r.moduleUrl))).toEqual([["blob:editor/compiler"]]);
  });

  it("starts another worker on the release's bundle when the blob is refused", async () => {
    const { compileInBackground, compilerUrl } = await load("blob:editor/compiler");
    FakeWorker.answer = (req) => (req.moduleUrl.startsWith("blob:") ? { error: "Failed to fetch dynamically imported module", fatal: true } : { result: RESULT });
    await expect(compileInBackground(INPUT)).resolves.toBe(RESULT);
    expect(FakeWorker.made.length).toBe(2);
    expect(FakeWorker.made[0].terminated).toBe(true);
    expect(FakeWorker.made[1].seen[0].moduleUrl).toBe(compilerUrl());
    // …and stays on it.
    await compileInBackground(INPUT);
    expect(FakeWorker.made.length).toBe(2);
    expect(FakeWorker.made[1].seen[1].moduleUrl).toBe(compilerUrl());
  });

  it("rejects when neither address loads, and tries again later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { compileInBackground, CompilerUnavailable, UNAVAILABLE_RETRY_MS } = await load("blob:editor/compiler");
    FakeWorker.answer = () => ({ error: "no network", fatal: true });
    await expect(compileInBackground(INPUT)).rejects.toBeInstanceOf(CompilerUnavailable);
    expect(FakeWorker.made.length).toBe(2);
    // A keystroke straight after starts nothing.
    await expect(compileInBackground(INPUT)).rejects.toThrow(/no network/);
    expect(FakeWorker.made.length).toBe(2);
    vi.setSystemTime(Date.now() + UNAVAILABLE_RETRY_MS + 1);
    FakeWorker.answer = () => ({ result: RESULT });
    await expect(compileInBackground(INPUT)).resolves.toBe(RESULT);
    expect(FakeWorker.made.length).toBe(3);
  });

  it("rejects where there are no workers, instead of compiling here", async () => {
    vi.stubGlobal("Worker", undefined);
    const { compileInBackground, CompilerUnavailable } = await load("https://editor/assets/chunk.js");
    await expect(compileInBackground(INPUT)).rejects.toBeInstanceOf(CompilerUnavailable);
  });

  it("rejects when a worker's own scripts do not load", async () => {
    const { compileInBackground, CompilerUnavailable } = await load("https://editor/assets/chunk.js");
    FakeWorker.answer = () => ({ result: RESULT });
    const asked = compileInBackground(INPUT);
    FakeWorker.made[0].onerror?.({ message: "importScripts failed" });
    await expect(asked).rejects.toBeInstanceOf(CompilerUnavailable);
  });

  it("says so from inside the worker when the module it imported has no compiler in it (the plugin's one built bundle)", async () => {
    const { WORKER_SOURCE } = await load("blob:editor/plugin");
    const posted: { fatal?: boolean; error?: string; result?: unknown }[] = [];
    const self: { ts: object; onmessage: ((e: { data: object }) => Promise<void>) | null } = { ts: {}, onmessage: null };
    // A function made here cannot `import()`, so the worker's import goes through this module's.
    const source = WORKER_SOURCE.replace(/^importScripts\(.*\);$/m, "").replace("import(moduleUrl)", "load(moduleUrl)");
    expect(source).toContain("load(moduleUrl)");
    new Function("self", "postMessage", "fetch", "load", source)(self, (m: object) => posted.push(m), async () => ({ ok: true, text: async () => "" }), (url: string) => import(/* @vite-ignore */ url));
    const ask = (moduleUrl: string) => self.onmessage!({ data: { id: 1, moduleUrl, libUrl: "lib", files: {}, names: {} } });
    await ask("data:text/javascript,export default function activate() {}");
    expect(posted.at(-1)).toMatchObject({ fatal: true, error: "the module has no compiler in it" });
    // …and the next address is imported afresh, not the one remembered.
    await ask("data:text/javascript,export const compileScript = () => 'compiled'");
    expect(posted.at(-1)).toEqual({ id: 1, result: "compiled" });
  });
});
