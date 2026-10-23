/**
 * The debugger in the game (TrigScript 4, A5): one test run once in the lifted game with everything it did written
 * down, so that stepping forward and back, by frame or by line, is a walk over the record and never the game again.
 *
 * What is recorded, frame by frame:
 *
 * - **Steps.** The game runs a frame's triggers one record after another; the host's cost tap says each record, in
 *   order, under the line the build's map of triggers puts it (A1, A4). Records of one line in a row are one step:
 *   "line 12 ran 9 conditions and actions". A loop's turns come out as the lines of its body, again and again.
 * - **Writes.** Every dword of the script's memory a step changed (eudplib's variables and arrays, the heap, the made
 *   texts: everything between the start of `STRx` and the end of the payload), with what it held before and after.
 *   With both, a step back is the writes put back in reverse, and the variables at any step are read the way
 *   `sim.program()` reads them (`gameVariables.ts`), over a copy of that memory the debugger keeps. What the game wrote
 *   there without a record (a routine of its own) is found at the frame's end, compared, and written down as the
 *   frame's last step, so the copy never drifts.
 * - **The test's line.** Which line of the test asked for the frame (a `sim.frames`, `until`, `seconds`).
 * - **What was shown** on the text lines, by frame.
 *
 * And, for a picture of any frame, kept on the host's side and never sent: the game kept every so many frames
 * (`TestGameHandle.keep`), and everything the test did to it between frames (its actions, typed lines, routines
 * called and its own writes to memory: keys, the mouse, a scratch location). A picture of frame F is the nearest
 * kept game before it, those things done again at their frames, and the frames in between played.
 *
 * A test is synchronous JavaScript, so a run cannot stop in the middle; a frame cannot either (the game's trigger
 * loop runs to its end), which is why a step inside a frame comes from the record and not from a pause.
 */
import type { GameHandle } from "./gameSim";
import type { TestResult } from "./testing";

/** Where the script's memory starts: Remastered's strings, where eudplib puts `STRx` and its payload after it. */
export const SCRIPT_MEMORY = 0x191943c8;

/** A step's line when it is not a line of the script. */
export const STEP_EUDPLIB = -1;
/** What the test did between frames (its own actions), recorded as the step before the frame's first. */
export const STEP_TEST = -3;
/** What the game changed in the script's memory with no record to say so, found at the frame's end. */
export const STEP_UNSEEN = -4;

/** What is recorded at most; past it the record says where it stopped, and the run goes on without it. */
export interface DebugLimits {
  steps?: number;
  writes?: number;
  /** What the kept games may hold together, in bytes; past it every other one goes and they are kept half as often. */
  keptBytes?: number;
  /** A game kept every this many frames at first. */
  every?: number;
}
const LIMITS: Required<DebugLimits> = { steps: 4_000_000, writes: 6_000_000, keptBytes: 256 * 2 ** 20, every: 48 };

/**
 * A test's run in the game, as plain data (structured-clone safe; the typed arrays transfer).
 *
 * Frame `k` of the record is game frame `first + k`. Its steps are `frameSteps[k]` to `frameSteps[k + 1]`; a step's
 * writes are `stepWrites[s]` to `stepWrites[s + 1]`, three numbers each in `writes` (address, before, after).
 */
export interface DebugRecording {
  version: 1;
  test: { id: string; name: string; file: string; line: number };
  result: TestResult;
  /** The lines a step can be, by number (a step's `stepLine`). */
  lines: { file: string; line: number }[];
  /** The script's memory as the test found it (frame `first` - 1, before its first frame): `memory.at` on. */
  memory: { at: number; bytes: Uint8Array };
  /** The frame the test started at (the game put back: 0), and the first recorded. */
  start: number;
  first: number;
  frames: number;
  frameSteps: Int32Array;
  /** By frame: the test's line that asked for it (0: none known). */
  testLine: Int32Array;
  testFile: string[];
  /** By frame: an index into `testFile`. */
  testFileOf: Int32Array;
  stepLine: Int32Array;
  stepRecords: Int32Array;
  stepWrites: Int32Array;
  writes: Uint32Array;
  shown: { frame: number; text: string }[];
  /** Where the record stopped short, in words, and from which frame; null when it is whole. */
  cut: { frame: number; why: string } | null;
  /** The frames a picture can be had of quickly: the kept games'. */
  kept: number[];
  ms: number;
}

/** A host's game, as the debugger needs it: a test's handle that can keep and restore, and its two taps. */
export interface DebugHost<K = unknown, P = unknown> extends GameHandle {
  keep(): K;
  restore(kept: K): void;
  portable(kept: K): { kept: P; transfer: ArrayBuffer[] };
  readonly eud?: { listen: ((record: number, address: number, write: boolean, mask: number, was: number) => void) | null };
  readonly cost?: GameHandle["cost"] & { trace: ((record: number, group: number, action: boolean) => void) | null; paused: boolean };
}

/** What the test did to the game between frames, to do again on the way to a picture. */
type Op =
  | { kind: "action"; record: Uint8Array; player: number }
  | { kind: "call"; address: number; registers: Record<string, number>; args?: number[] }
  | { kind: "chat"; text: string }
  | { kind: "poke"; address: number; bytes: Uint8Array };

class Ints {
  a: Int32Array;
  n = 0;
  constructor(size = 1024) { this.a = new Int32Array(size); }
  push(v: number) { if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  done(): Int32Array { return this.a.slice(0, this.n); }
}
class Words {
  a: Uint32Array;
  n = 0;
  constructor(size = 3072) { this.a = new Uint32Array(size); }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  done(): Uint32Array { return this.a.slice(0, this.n); }
}

/**
 * Wraps a host's handle for one test: everything `GameSim` does goes through it and is written down. `where` says the
 * test's line from inside a step (the stack's innermost line of a linked file).
 */
export class RecordingHandle<K, P> implements GameHandle {
  private readonly host: DebugHost<K, P>;
  private readonly where: () => { file: string; line: number } | null;
  private readonly limits: Required<DebugLimits>;
  private readonly lo: number;
  private readonly hi: number;

  private recording = false;
  private stepping = false;
  private group = Number.NaN;
  private image: Uint8Array = new Uint8Array(0);
  private mirror: Uint32Array = new Uint32Array(0);
  private start = 0;
  private first = -1;
  private frameSteps = new Ints();
  private testLine = new Ints();
  private testFileOf = new Ints();
  private testFile: string[] = [];
  private stepLine = new Ints();
  private stepRecords = new Ints();
  private stepWrites = new Ints();
  private writes = new Words();
  private shownLines: { frame: number; text: string }[] = [];
  private cut: { frame: number; why: string } | null = null;
  private keptGames: { frame: number; kept: K; bytes: number }[] = [];
  private keptBytes = 0;
  private every: number;
  private ops = new Map<number, Op[]>();
  private lastFrame = 0;
  private began = 0;

  /** `from`: where the script's memory starts (Remastered's strings; another for a host of its own, a test's). */
  constructor(host: DebugHost<K, P>, where: () => { file: string; line: number } | null, limits: DebugLimits = {}, from = SCRIPT_MEMORY) {
    this.host = host;
    this.where = where;
    this.limits = { ...LIMITS, ...limits };
    this.every = this.limits.every;
    const end = host.payloadEnd ?? from;
    this.lo = from;
    this.hi = Math.max(from, Math.min(end, host.u8.length)) & ~3;
  }

  get m() { return this.host.m; }
  get u8() { return this.host.u8; }
  get frame() { return this.host.frame; }
  get localPlayer() { return this.host.localPlayer; }
  get over() { return this.host.over; }
  get cost() { return this.host.cost; }
  get payloadEnd() { return this.host.payloadEnd; }

  /** The test's world is made: the game back at its start, and the record begins. */
  reset(): void {
    this.host.reset();
    this.begin();
  }

  private begin() {
    this.recording = true;
    this.began = Date.now();
    this.start = this.host.frame;
    this.first = -1;
    this.image = this.host.u8.slice(this.lo, this.hi);
    this.mirror = new Uint32Array(this.image.slice().buffer);
    for (const k of ["frameSteps", "testLine", "testFileOf", "stepLine", "stepRecords", "stepWrites"] as const) this[k] = new Ints();
    this.writes = new Words();
    this.testFile = [];
    this.shownLines = [];
    this.cut = null;
    this.keptGames = [];
    this.keptBytes = 0;
    this.every = this.limits.every;
    this.ops.clear();
    this.group = Number.NaN;
    this.frameSteps.push(0);
    this.keepNow();
    const cost = this.host.cost, eud = this.host.eud;
    if (cost) cost.trace = (_record, group) => this.ran(group);
    if (eud) eud.listen = (_record, address, write, _mask, was) => { if (write) this.wrote32(address, was); };
  }

  /** Stops listening (the run is over, or a picture is being made). */
  stop(): void {
    const cost = this.host.cost, eud = this.host.eud;
    if (cost) cost.trace = null;
    if (eud) eud.listen = null;
    this.recording = false;
  }

  private full(): boolean {
    if (this.cut) return true;
    if (this.stepLine.n >= this.limits.steps || this.writes.n / 3 >= this.limits.writes) {
      this.cut = { frame: this.host.frame, why: this.stepLine.n >= this.limits.steps ? `more than ${this.limits.steps.toLocaleString("en")} steps` : `more than ${this.limits.writes.toLocaleString("en")} writes` };
      return true;
    }
    return false;
  }

  private newStep(line: number) {
    this.stepLine.push(line);
    this.stepRecords.push(0);
    this.stepWrites.push(this.writes.n / 3);
  }

  /** A record ran under `group`. */
  private ran(group: number) {
    if (!this.recording || !this.stepping || this.full()) return;
    const line = group < 0 ? STEP_EUDPLIB : group;
    if (line !== this.group) { this.newStep(line); this.group = line; }
    this.stepRecords.a[this.stepRecords.n - 1]++;
  }

  /** A dword was written by an EUD action; `was` what it held before. */
  private wrote32(address: number, was: number) {
    if (!this.recording || address < this.lo || address + 4 > this.hi || (address & 3) !== 0 || this.full()) return;
    const now = this.host.m.getUint32(address, true);
    const k = (address - this.lo) >>> 2;
    if (now === this.mirror[k]) return;
    // Between frames (the test's own action did it): the frame-to-be's first step is the test's. In a frame with no
    // record said yet (a host that does not trace), eudplib's.
    if (!this.stepping && this.group !== STEP_TEST) { this.newStep(STEP_TEST); this.group = STEP_TEST; }
    else if (this.stepping && Number.isNaN(this.group)) { this.newStep(STEP_EUDPLIB); this.group = STEP_EUDPLIB; }
    void was;
    this.writes.push3(address, this.mirror[k], now);
    this.mirror[k] = now;
  }

  step(): void {
    if (!this.recording) { this.host.step(); return; }
    const at = this.where();
    // (A frame's steps start where the last frame's ended: a step the test made between frames is the first of them.)
    if (this.first < 0) this.first = this.host.frame + 1;
    this.group = Number.NaN;
    this.stepping = true;
    try { this.host.step(); } finally { this.stepping = false; }
    this.unseen();
    this.group = Number.NaN;
    this.frameSteps.push(this.stepLine.n);
    let file = -1;
    if (at) { file = this.testFile.indexOf(at.file); if (file < 0) { file = this.testFile.length; this.testFile.push(at.file); } }
    this.testLine.push(at?.line ?? 0);
    this.testFileOf.push(file);
    this.lastFrame = this.host.frame;
    if (this.host.frame - (this.keptGames.at(-1)?.frame ?? -Infinity) >= this.every) this.keepNow();
  }

  /** The script's memory as the game left it, against the copy: what no record said is the frame's last step. */
  private unseen() {
    if (this.cut) return;
    const u8 = this.host.u8;
    const words = u8.byteOffset % 4 === 0 && (u8.byteOffset + this.lo) % 4 === 0 ? new Uint32Array(u8.buffer, u8.byteOffset + this.lo, (this.hi - this.lo) >>> 2) : null;
    const read = words ? (k: number) => words[k] : (k: number) => this.host.m.getUint32(this.lo + 4 * k, true);
    const mirror = this.mirror;
    let opened = false;
    for (let k = 0; k < mirror.length; k++) {
      const now = read(k);
      if (now === mirror[k]) continue;
      if (!opened) { this.newStep(STEP_UNSEEN); opened = true; }
      this.writes.push3(this.lo + 4 * k, mirror[k], now);
      mirror[k] = now;
    }
  }

  private keepNow() {
    const kept = this.host.keep();
    const bytes = (kept as { bytes?: number }).bytes ?? 0;
    this.keptGames.push({ frame: this.host.frame, kept, bytes });
    this.keptBytes += bytes;
    if (this.keptBytes > this.limits.keptBytes && this.keptGames.length > 2) {
      // Every other one goes (never the first), and from now on they are kept half as often.
      this.keptGames = this.keptGames.filter((_, i) => i === 0 || i % 2 === 0);
      this.keptBytes = this.keptGames.reduce((n, k) => n + k.bytes, 0);
      this.every *= 2;
    }
  }

  private op(o: Op) {
    if (!this.recording) return;
    const f = this.host.frame;
    const list = this.ops.get(f);
    if (list) list.push(o); else this.ops.set(f, [o]);
  }

  lines(): { frame: number; text: string }[] {
    const l = this.host.lines();
    if (this.recording) this.shownLines.push(...l);
    return l;
  }
  action(record: Uint8Array, player: number): number {
    this.op({ kind: "action", record: record.slice(0, 32), player });
    return this.host.action(record, player);
  }
  chat(text: string): void { this.op({ kind: "chat", text }); this.host.chat(text); }
  call(address: number, registers: Record<string, number>, args?: number[]): number {
    this.op({ kind: "call", address, registers: { ...registers }, ...(args ? { args: [...args] } : {}) });
    return this.host.call(address, registers, args);
  }
  wrote(address: number, length: number): void {
    this.op({ kind: "poke", address, bytes: this.host.u8.slice(address, address + length) });
  }

  /** The record, once the test has run. */
  finish(test: DebugRecording["test"], result: TestResult, lines: DebugRecording["lines"]): DebugRecording {
    this.stop();
    const frames = this.testLine.n;
    // (Steps the test made after its last frame belong to no frame: the last frame's list ends before them.)
    const frameSteps = this.frameSteps.done();
    this.stepWrites.push(this.writes.n / 3);
    return {
      version: 1, test, result, lines,
      memory: { at: this.lo, bytes: this.image },
      start: this.start, first: this.first < 0 ? this.start + 1 : this.first, frames,
      frameSteps, testLine: this.testLine.done(), testFile: this.testFile, testFileOf: this.testFileOf.done(),
      stepLine: this.stepLine.done(), stepRecords: this.stepRecords.done(), stepWrites: this.stepWrites.done(), writes: this.writes.done(),
      shown: this.shownLines, cut: this.cut, kept: this.keptGames.map((k) => k.frame), ms: Date.now() - this.began,
    };
  }

  /** Where the game stands after a picture (so the next, a frame or two on, plays on from there). */
  private standing: number | null = null;

  /**
   * The game at frame `frame` (clamped to the run), for another engine to draw: the nearest kept game before it,
   * what the test did between frames done again, and the frames in between played. Only once the record is finished.
   */
  picture(frame: number): { frame: number; kept: P; transfer: ArrayBuffer[] } {
    const host = this.host;
    const target = Math.max(this.start, Math.min(frame, this.lastFrame));
    const cost = host.cost;
    const paused = cost?.paused ?? false;
    if (cost) cost.paused = true;
    try {
      const from = this.keptGames.filter((k) => k.frame <= target).at(-1)!;
      const here = this.standing;
      // Playing on from where the last picture left the game is quicker when it is behind the target and nearer.
      if (here === null || here > target || here < from.frame) host.restore(from.kept);
      while (host.frame < target && !host.over) {
        for (const o of this.ops.get(host.frame) ?? []) this.redo(o);
        host.step();
      }
      host.lines();
      this.standing = host.frame;
      const kept = host.keep();
      const p = host.portable(kept);
      return { frame: host.frame, kept: p.kept, transfer: p.transfer };
    } finally { if (cost) cost.paused = paused; }
  }

  private redo(o: Op) {
    const host = this.host;
    if (o.kind === "action") host.action(o.record, o.player);
    else if (o.kind === "call") host.call(o.address, o.registers, o.args);
    else if (o.kind === "chat") host.chat(o.text);
    else host.u8.set(o.bytes, o.address);
  }
}
