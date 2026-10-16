/**
 * Walking a debugged run (TrigScript 4, A5): a cursor over a `DebugRecording`, and the script's memory as it was at
 * the cursor. Nothing here touches the game or the page: the record holds everything, so a step back is as quick as
 * a step forward (the writes between the two put back or done again).
 *
 * Where the cursor stands is a frame of the record and a step of it: `{ k, s }`, with `s` from the frame's first step
 * to its end (`frameSteps[k]` … `frameSteps[k + 1]`). Standing at step `s` is standing before it, its line about to
 * run, the memory as every step before it left it; standing at the end of frame k is the game as the frame left it,
 * the same memory as before frame k + 1's first step.
 */
import type { DebugRecording } from "./gameDebug";
import { programVariables, type GameArray, type GameVariable, type VariableMap } from "./gameVariables";

export interface DebugPlace { file: string; line: number }
export interface DebugAt { k: number; s: number }

/** Why a continue stopped: a breakpoint on a line, a watched variable that changed, or the run's end (or start). */
export type DebugStop = { kind: "breakpoint"; place: DebugPlace } | { kind: "watch"; name: string; before: string; after: string } | { kind: "end" } | { kind: "start" };

/** What the variables view shows of one program: its name, for whom, and each variable's value as the source has it. */
export interface DebugProgram { label: string; values: { name: string; value: unknown }[] }

const key = (p: DebugPlace) => `${p.file}:${p.line}`;
const UNITS = 0x59cca8, UNIT_BYTES = 336;

/** A unit a variable holds, as the debugger says it (the unit table is not in the record). */
export interface DebugUnitRef { unitSlot: number }

export class DebugCursor {
  readonly rec: DebugRecording;
  private readonly map: VariableMap | null;
  /** The script's memory at the cursor (`rec.memory.at` on). */
  readonly memory: Uint8Array;
  private readonly view: DataView;
  private at: DebugAt = { k: 0, s: 0 };
  /** Writes done: everything before this index of `rec.writes` (by write). */
  private done = 0;
  /** The step's line, or null for eudplib's own and the rest. */
  readonly placeOf: (s: number) => DebugPlace | null;

  constructor(rec: DebugRecording, map: VariableMap | null) {
    this.rec = rec;
    this.map = map;
    this.memory = rec.memory.bytes.slice();
    this.view = new DataView(this.memory.buffer);
    this.placeOf = (s) => { const l = rec.stepLine[s]; return l >= 0 ? rec.lines[l] ?? null : null; };
    if (rec.frames) this.moveTo({ k: 0, s: rec.frameSteps[0] });
  }

  get where(): DebugAt { return { ...this.at }; }
  get frames(): number { return this.rec.frames; }
  /** The game frame of record frame k. */
  frame(k = this.at.k): number { return this.rec.first + k; }
  frameStart(k: number): number { return this.rec.frameSteps[k]; }
  frameEnd(k: number): number { return this.rec.frameSteps[k + 1]; }
  atEnd(): boolean { return this.at.s >= this.frameEnd(this.at.k); }
  /** The memory is what the record says only up to where it was cut. */
  get known(): boolean { return !this.rec.cut || this.frame() < this.rec.cut.frame; }

  /** The line about to run (null at a frame's end, or for a step that is no line of the script's). */
  line(): DebugPlace | null { return this.atEnd() ? null : this.placeOf(this.at.s); }
  /** The test's line that asked for the frame the cursor is in. */
  testLine(k = this.at.k): DebugPlace | null {
    const f = this.rec.testFileOf[k], line = this.rec.testLine[k];
    return f >= 0 && line > 0 ? { file: this.rec.testFile[f], line } : null;
  }

  moveTo(to: DebugAt): void {
    const k = Math.max(0, Math.min(to.k, this.rec.frames - 1));
    const s = Math.max(this.frameStart(k), Math.min(to.s, this.frameEnd(k)));
    const target = this.rec.stepWrites[s];
    const w = this.rec.writes, base = this.rec.memory.at, v = this.view;
    while (this.done < target) { const i = 3 * this.done++; v.setUint32(w[i] - base, w[i + 2], true); }
    while (this.done > target) { const i = 3 * --this.done; v.setUint32(w[i] - base, w[i + 1], true); }
    this.at = { k, s };
  }

  /** A step the person stops at: a line of the script's, or every step with `all`. */
  private visible(s: number, all: boolean): boolean { return all || this.rec.stepLine[s] >= 0; }

  /** The next line (or the frame's end, then the next frame's first line). */
  stepForward(all = false): void {
    const { k, s } = this.at;
    for (let i = s + 1; i < this.frameEnd(k); i++) if (this.visible(i, all)) { this.moveTo({ k, s: i }); return; }
    if (s < this.frameEnd(k)) { this.moveTo({ k, s: this.frameEnd(k) }); return; }
    if (k + 1 >= this.rec.frames) return;
    for (let i = this.frameStart(k + 1); i < this.frameEnd(k + 1); i++) if (this.visible(i, all)) { this.moveTo({ k: k + 1, s: i }); return; }
    this.moveTo({ k: k + 1, s: this.frameEnd(k + 1) });
  }

  /** The line before (or the end of the frame before). */
  stepBack(all = false): void {
    const { k, s } = this.at;
    for (let i = s - 1; i >= this.frameStart(k); i--) if (this.visible(i, all)) { this.moveTo({ k, s: i }); return; }
    if (k > 0) this.moveTo({ k: k - 1, s: this.frameEnd(k - 1) });
    else this.moveTo({ k: 0, s: this.frameStart(0) });
  }

  /** To the end of this frame; from a frame's end, to the end of the next. */
  nextFrame(): void {
    const { k, s } = this.at;
    if (s < this.frameEnd(k)) this.moveTo({ k, s: this.frameEnd(k) });
    else if (k + 1 < this.rec.frames) this.moveTo({ k: k + 1, s: this.frameEnd(k + 1) });
  }

  /** To the end of the frame before (the start of this one). */
  prevFrame(): void {
    const { k } = this.at;
    if (k > 0) this.moveTo({ k: k - 1, s: this.frameEnd(k - 1) });
    else this.moveTo({ k: 0, s: this.frameStart(0) });
  }

  /** Record frame k's end. */
  toFrame(k: number): void { this.moveTo({ k, s: this.frameEnd(Math.max(0, Math.min(k, this.rec.frames - 1))) }); }

  /** The cell addresses of every variable named in `watch` ("waves.wave", or "wave" in any program), at the cursor. */
  private watched(watch: readonly string[]): Map<number, string> {
    const out = new Map<number, string>();
    if (!this.map) return out;
    for (const p of this.map.programs) for (const name of watch) {
      const [prog, v] = name.includes(".") ? name.split(".", 2) : [null, name];
      if (prog !== null && prog !== (p.name ?? String(p.index))) continue;
      for (const [addr] of this.cellsOf(p, v)) out.set(addr, name);
    }
    return out;
  }

  /** A variable's cells in a program: its own, an array's (a growing one's block as the cursor finds it). */
  private cellsOf(p: VariableMap["programs"][number], name: string): Map<number, true> {
    const out = new Map<number, true>();
    for (const v of p.vars) if (top(v.id) === name) for (const at of Object.values(v.cells)) if (at != null) for (let r = 0; r < (v.rowed ? 12 : 1); r++) out.set(at + 4 * r, true);
    for (const a of p.arrays) if (top(a.id) === name) for (const [addr] of this.arrayCells(a)) out.set(addr, true);
    return out;
  }

  private arrayCells(a: GameArray): Map<number, true> {
    const out = new Map<number, true>();
    const rows = a.rowed ? 12 : 1;
    if (!a.dynamic && a.at != null) for (let i = 0; i < Math.min(a.length * rows, 4096); i++) out.set(a.at + 4 * i, true);
    if (a.dynamic) {
      for (const c of [a.ptr, a.len]) if (c != null) for (let r = 0; r < rows; r++) out.set(c + 4 * r, true);
      // (The block the handle points at now, as far as its length says.)
      for (let r = 0; r < rows; r++) {
        const ptr = a.ptr != null ? this.read32(a.ptr + 4 * r) : 0, len = a.len != null ? this.read32(a.len + 4 * r) : 0;
        if (ptr) for (let i = 0; i < Math.min(len, 4096); i++) out.set(ptr + 4 * i, true);
      }
    }
    return out;
  }

  private read32(addr: number): number {
    const i = addr - this.rec.memory.at;
    return i >= 0 && i + 4 <= this.memory.length ? this.view.getUint32(i, true) : 0;
  }

  /**
   * On to the next breakpoint (a line of `breakpoints` about to run, or a test's line that asks for a frame, at that
   * frame's end) or the next change of a watched variable (stopped just after the step that made it), else the end.
   */
  continueForward(breakpoints: ReadonlySet<string>, watch: readonly string[] = []): DebugStop {
    return this.run(1, breakpoints, watch);
  }
  /** The same, backwards: the last stop before the cursor, else the start. */
  continueBack(breakpoints: ReadonlySet<string>, watch: readonly string[] = []): DebugStop {
    return this.run(-1, breakpoints, watch);
  }

  private run(dir: 1 | -1, breakpoints: ReadonlySet<string>, watch: readonly string[]): DebugStop {
    const rec = this.rec;
    const cells = this.watched(watch);
    const w = rec.writes;
    const touches = (s: number): string | null => {
      for (let i = rec.stepWrites[s]; i < rec.stepWrites[s + 1]; i++) { const name = cells.get(w[3 * i]); if (name) return name; }
      return null;
    };
    let { k, s } = this.at;
    // Positions in order: each step of a frame, then its end. A position is checked as it is reached, never where
    // the cursor stood; `passed` is the step gone over on the way to it.
    const next = (): number | null => {
      if (dir > 0) {
        if (s < this.frameEnd(k)) { s++; return s - 1; }
        if (k + 1 >= rec.frames) return Number.NaN;
        k++; s = this.frameStart(k); return null;
      }
      if (s > this.frameStart(k)) { s--; return s; }
      if (k === 0) return Number.NaN;
      k--; s = this.frameEnd(k); return null;
    };
    for (;;) {
      const passed = next();
      if (Number.isNaN(passed)) break;
      // A watched variable a passed step wrote, and whose value it changed: stop just after that step.
      const name = passed !== null && cells.size ? touches(passed) : null;
      if (name && passed !== null) {
        this.moveTo({ k, s: passed });
        const before = this.watchText(name);
        this.moveTo({ k, s: passed + 1 });
        const after = this.watchText(name);
        if (before !== after) return { kind: "watch", name, before, after };
      }
      if (s < this.frameEnd(k)) {
        const place = this.placeOf(s);
        if (place && breakpoints.has(key(place))) { this.moveTo({ k, s }); return { kind: "breakpoint", place }; }
      } else {
        const t = this.testLine(k);
        if (t && breakpoints.has(key(t))) { this.moveTo({ k, s }); return { kind: "breakpoint", place: t }; }
      }
    }
    if (dir > 0) { this.moveTo({ k: rec.frames - 1, s: this.frameEnd(rec.frames - 1) }); return { kind: "end" }; }
    this.moveTo({ k: 0, s: this.frameStart(0) });
    return { kind: "start" };
  }

  /** A watched variable's value as text, at the cursor ("?" where it cannot be read). */
  watchText(name: string): string {
    const [prog, v] = name.includes(".") ? name.split(".", 2) : [null, name];
    for (const p of this.programs()) {
      if (prog !== null && !p.label.startsWith(prog)) continue;
      const found = p.values.find((x) => x.name === v);
      if (found) return show(found.value);
    }
    return "?";
  }

  /** The reader `programVariables` reads the record's memory through. */
  private reader() {
    const at = this.rec.memory.at, mem = this.memory, view = this.view;
    const inside = (i: number, n: number) => i >= at && i + n <= at + mem.length;
    const m = {
      getUint32: (i: number) => (inside(i, 4) ? view.getUint32(i - at, true) : 0),
      getInt32: (i: number) => (inside(i, 4) ? view.getInt32(i - at, true) : 0),
      getUint16: (i: number) => (inside(i, 2) ? view.getUint16(i - at, true) : 0),
      getInt16: (i: number) => (inside(i, 2) ? view.getInt16(i - at, true) : 0),
      getUint8: (i: number) => (inside(i, 1) ? mem[i - at] : 0),
      getInt8: (i: number) => (inside(i, 1) ? (mem[i - at] << 24) >> 24 : 0),
    } as unknown as DataView;
    const u8 = new Proxy(mem, {
      get(t, p) {
        if (typeof p === "string" && /^\d+$/.test(p)) { const i = Number(p); return i >= at && i < at + t.length ? t[i - at] : 0; }
        if (p === "length") return at + t.length;
        if (p === "subarray") return (a: number, b: number) => t.subarray(Math.max(0, a - at), Math.max(0, b - at));
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Uint8Array;
    return { m, u8, unitAt: (ptr: number) => (ptr ? ({ unitSlot: Math.round((ptr - UNITS) / UNIT_BYTES) } satisfies DebugUnitRef as never) : null) };
  }

  /** Every program's variables at the cursor, as the source names them. */
  programs(): DebugProgram[] {
    const map = this.map;
    if (!map) return [];
    const out: DebugProgram[] = [];
    const reader = this.reader();
    for (const p of map.programs) for (const who of p.perPlayer ? p.owners : [undefined]) {
      const label = `${p.name ?? `program ${p.index}`}${who !== undefined ? ` (P${who + 1})` : ""}`;
      let vars: Record<string, unknown>;
      try { vars = programVariables(reader, map, p.name ?? p.index, who); } catch { continue; }
      const names = [...new Set([...p.vars.filter((v) => !isTemp(v)).map((v) => v.id), ...p.arrays.map((a) => a.id)].map(top))];
      const values: { name: string; value: unknown }[] = [];
      for (const name of names) { let value: unknown; try { value = plain(vars[name]); } catch { value = "?"; } values.push({ name, value }); }
      out.push({ label, values });
    }
    return out;
  }

  /**
   * What each line run so far in the cursor's frame wrote: the variables, by line, with their values at the cursor;
   * and how many steps of the frame each line took. For the values beside the lines (`label`).
   */
  frameLines(): { place: DebugPlace; steps: number; names: string[] }[] {
    const map = this.map;
    const { k, s } = this.at;
    const byLine = new Map<string, { place: DebugPlace; steps: number; names: Set<string> }>();
    const owners = this.cellOwners();
    const w = this.rec.writes;
    for (let i = this.frameStart(k); i < s; i++) {
      const place = this.placeOf(i);
      if (!place) continue;
      let entry = byLine.get(key(place));
      if (!entry) { entry = { place, steps: 0, names: new Set() }; byLine.set(key(place), entry); }
      entry.steps++;
      if (map) for (let j = this.rec.stepWrites[i]; j < this.rec.stepWrites[i + 1]; j++) { const n = owners.get(w[3 * j]); if (n) entry.names.add(n); }
    }
    return [...byLine.values()].map((e) => ({ place: e.place, steps: e.steps, names: [...e.names] }));
  }

  /** Which variable each cell is (by its name in the source), arrays' cells and growing arrays' blocks included. */
  private cellOwners(): Map<number, string> {
    const out = new Map<number, string>();
    for (const p of this.map?.programs ?? []) {
      for (const v of p.vars) if (!isTemp(v)) for (const at of Object.values(v.cells)) if (at != null) for (let r = 0; r < (v.rowed ? 12 : 1); r++) out.set(at + 4 * r, top(v.id));
      for (const a of p.arrays) for (const [addr] of this.arrayCells(a)) out.set(addr, top(a.id));
    }
    return out;
  }

  /** Each frame's work: the conditions and actions the script's lines ran (eudplib's own not counted). */
  frameCosts(): Int32Array {
    const rec = this.rec, out = new Int32Array(rec.frames);
    for (let k = 0; k < rec.frames; k++) for (let s = rec.frameSteps[k]; s < rec.frameSteps[k + 1]; s++) if (rec.stepLine[s] >= 0) out[k] += rec.stepRecords[s];
    return out;
  }

  /** The record frames a breakpoint line ran in. */
  hits(place: DebugPlace): number[] {
    const rec = this.rec, out: number[] = [];
    const id = rec.lines.findIndex((l) => l.file === place.file && l.line === place.line);
    for (let k = 0; k < rec.frames; k++) {
      let hit = false;
      if (id >= 0) for (let s = rec.frameSteps[k]; s < rec.frameSteps[k + 1] && !hit; s++) hit = rec.stepLine[s] === id;
      const t = this.testLine(k);
      if (!hit && t && t.file === place.file && t.line === place.line) hit = true;
      if (hit) out.push(k);
    }
    return out;
  }

  /** What was shown on the text lines up to the cursor's frame: the last `n`. */
  shown(n = 13): { frame: number; text: string }[] {
    const f = this.frame();
    return this.rec.shown.filter((x) => x.frame <= f).slice(-n);
  }
}

function isTemp(v: GameVariable): boolean { return /^\$|^_/.test(v.id); }
/** The name a variable is read by: a record's field ("pos.x#5") is its record's ("pos"). */
const top = (id: string) => id.replace(/#\d+$/, "").split(".")[0];

/** A value as plain data (a unit as its slot), for the view and for comparing. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if ("unitSlot" in (v as object)) return v;
  return JSON.parse(JSON.stringify(v));
}

/** A value as one line: 3, true, "tick 3", [1, 2, 3], { x: 10, y: 2 }, unit 12. */
export function show(v: unknown, most = 80): string {
  const s = ((): string => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v !== "object") return String(v);
    if ("unitSlot" in (v as object)) return `unit ${(v as DebugUnitRef).unitSlot}`;
    if (Array.isArray(v)) return `[${v.map((x) => show(x, most)).join(", ")}]`;
    return `{ ${Object.entries(v as object).map(([k, x]) => `${k}: ${show(x, most)}`).join(", ")} }`;
  })();
  return s.length > most ? `${s.slice(0, most - 1)}…` : s;
}
