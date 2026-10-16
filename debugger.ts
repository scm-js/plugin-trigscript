/**
 * The debugger in the game (TrigScript 4, A5), as the workspace shows it: a Debug view in the panel over a test's
 * recorded run (`compiler/gameDebug.ts`, walked by `compiler/debugModel.ts`), and what it puts in the editor — the
 * line about to run, the test's line, breakpoints, and the values each line wrote beside it.
 *
 * Everything is the record, so stepping back is as quick as stepping forward; the one thing asked of the engine as
 * the cursor moves is a picture of the game at the cursor's frame, and only when a view to draw it is there.
 *
 * Keys, as VS Code has them where it can: F5 continue, F6 continue backwards, F10 the next line, Shift+F10 the line
 * before, F11 the next frame, Shift+F11 the frame before, Shift+F5 stop, F9 a breakpoint.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { Translate } from "./i18n";
import type { IconName, Shell } from "./shell";
import type { LineHint } from "./compiler/compiler";
import { STEP_EUDPLIB, STEP_TEST, STEP_UNSEEN, type DebugRecording } from "./compiler/gameDebug";
import { DebugCursor, show, type DebugPlace, type DebugStop } from "./compiler/debugModel";
import type { VariableMap } from "./compiler/gameVariables";
import { shortCount } from "./compiler/gameCost";

type El = PluginApi["ui"]["el"];

/** The engine's side of a session: pictures of the run's frames (scm-sim's `ScmSimDebugSession`). */
export interface DebugPictures {
  picture(frame: number): Promise<{ frame: number; kept: unknown }>;
  close(): void;
  readonly closed: boolean;
}

/** Where a picture is drawn: a view of the game the editor made for the session (scm-sim's view), when there is one. */
export interface DebugGameView {
  readonly element: HTMLElement;
  show(picture: { frame: number; kept: unknown }): void;
  dispose(): void;
}

export interface DebuggerDeps {
  t: Translate;
  el: El;
  shell: Shell;
  /** Shows the line in the editor (opening its file), without taking the keyboard from the panel. */
  reveal(file: string, line: number): void;
  /** What the debugger puts in the editor changed: draw it again. */
  changed(): void;
  setStatus(kind: "info" | "ok" | "error" | "busy", text: string, timeout?: number): void;
}

export interface DebugStart {
  recording: DebugRecording;
  variables: VariableMap | null;
  pictures: DebugPictures | null;
  /** A view to draw the pictures in, or why there is none (in words). */
  view: DebugGameView | string | null;
  /** The script's files as the run was built from them: lines are only meant while the files are the same. */
  files: Record<string, string>;
}

export const DEBUG_STYLE = `
.tsd .tsd-debug:focus { outline: none; }
.tsd .tsd-debug { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; min-height: 0; font-size: var(--fs-md); }
.tsd .tsd-debug-bar { flex: none; display: flex; align-items: center; gap: 2px; padding: 2px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; }
.tsd .tsd-debug-bar .tsd-icon-button { display: inline-flex; }
.tsd .tsd-debug-bar .tsd-sep { width: 1px; height: 16px; margin: 0 6px; background: var(--border); }
.tsd .tsd-debug-bar .tsd-where { margin-left: 8px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text); }
.tsd .tsd-debug-bar .tsd-why { margin-left: 10px; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); font-size: var(--fs-sm); }
.tsd .tsd-debug-bar .tsd-why.tsd-failed { color: var(--danger); }
.tsd .tsd-debug-bar label { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding-left: 10px; color: var(--text-dim); font-size: var(--fs-sm); cursor: pointer; }
.tsd .tsd-debug-time { flex: none; height: 40px; margin: 4px 8px 2px; cursor: ew-resize; touch-action: none; }
.tsd .tsd-debug-time svg { display: block; width: 100%; height: 100%; }
.tsd .tsd-debug-time .cost { fill: var(--teal); fill-opacity: 0.3; stroke: var(--teal); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.tsd .tsd-debug-time .hit { fill: var(--danger); }
.tsd .tsd-debug-time .said { fill: var(--gold); }
.tsd .tsd-debug-time .cut { fill: var(--text-faint); fill-opacity: 0.25; }
.tsd .tsd-debug-time .now { fill: var(--text); }
.tsd .tsd-debug-time .end { fill: var(--danger); fill-opacity: 0.6; }
.tsd .tsd-debug-cols { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--border); }
.tsd .tsd-debug-col { flex: 1 1 0; min-width: 0; overflow: auto; border-right: 1px solid var(--border); }
.tsd .tsd-debug-col:last-child { border-right: none; }
.tsd .tsd-debug-col h5 { position: sticky; top: 0; z-index: 1; margin: 0; padding: 3px 10px; background: var(--bg-1); font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-dim); }
.tsd .tsd-debug-col ul { margin: 0; padding: 2px 0; list-style: none; }
.tsd .tsd-debug-col li { display: flex; align-items: baseline; gap: 6px; padding: 1px 10px; line-height: 18px; white-space: nowrap; }
.tsd .tsd-debug-col li.tsd-click { cursor: pointer; }
.tsd .tsd-debug-col li.tsd-click:hover { background: var(--bg-3); }
.tsd .tsd-debug-col li.tsd-here { background: var(--bg-4); }
.tsd .tsd-debug-col li.tsd-dim { color: var(--text-faint); }
.tsd .tsd-debug-col li.tsd-program { padding-top: 4px; color: var(--text-dim); font-size: var(--fs-sm); }
.tsd .tsd-debug-col .k { flex: none; color: var(--text-dim); font-family: var(--font-mono); font-size: var(--fs-sm); }
.tsd .tsd-debug-col .v { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text); }
.tsd .tsd-debug-col .v.tsd-changed { color: var(--gold); }
.tsd .tsd-debug-col .n { flex: none; margin-left: auto; color: var(--text-faint); font-size: var(--fs-sm); }
.tsd .tsd-debug-col li .tsd-icon-button { visibility: hidden; flex: none; }
.tsd .tsd-debug-col li:hover .tsd-icon-button, .tsd .tsd-debug-col li .tsd-icon-button.tsd-on { visibility: visible; }
.tsd .tsd-debug-col .tsd-icon-button.tsd-on { color: var(--gold); }
.tsd .tsd-debug-col .tsd-empty { padding: 6px 10px; color: var(--text-faint); white-space: normal; line-height: 1.45; }
.tsd .tsd-debug-game { flex: 1.3 1 0; display: flex; flex-direction: column; overflow: hidden; }
.tsd .tsd-debug-game .tsd-view { position: relative; flex: 1; min-height: 0; background: #000; }
.tsd .tsd-debug-overlay { position: absolute; z-index: 4; display: none; background: #000; }
.tsd .tsd-debug-overlay > div, .tsd .tsd-debug-overlay iframe { display: block; width: 100%; height: 100%; border: 0; }
.tsd .tsd-debug-game .tsd-shown { flex: none; max-height: 40%; overflow: auto; padding: 2px 10px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-dim); }
.tsd .tsd-debug-game .tsd-shown div { white-space: pre-wrap; }
.trigscript-debug-line { background: rgba(214, 178, 74, 0.18); }
.trigscript-debug-arrow::before { content: "\\eb89"; font: normal normal normal 14px/18px codicon; color: var(--gold); padding-left: 2px; }
.trigscript-debug-test { background: rgba(78, 201, 176, 0.12); }
.trigscript-debug-test-arrow::before { content: "\\eb8a"; font: normal normal normal 14px/18px codicon; color: var(--teal); padding-left: 2px; }
.trigscript-bp { cursor: pointer; }
.trigscript-bp::before { content: "\\ea71"; font: normal normal normal 14px/18px codicon; color: #e51400; }
.trigscript-debug-hint { color: var(--gold) !important; opacity: 0.9; }
`;

const NS = "http://www.w3.org/2000/svg";

/** How tall the panel is made for a session: the bar, the timeline, and room for the columns and the game. */
const DEBUG_PANEL = 340;
/** How long the cursor must stay before a picture of its frame is asked for (scrubbing asks for none on the way). */
const PICTURE_MS = 60;

interface Session extends DebugStart {
  cursor: DebugCursor;
  costs: Int32Array;
  /** What the variables read at the last cursor, to colour what changed. */
  last: Map<string, string>;
  /** Why the cursor stands where it does (the last continue), for the bar. */
  stop: DebugStop | null;
  picture: { timer: ReturnType<typeof setTimeout> | null; asked: number; shown: number };
}

export class Debugger {
  readonly breakpoints = new Set<string>();
  /** Variables watched: a continue stops where one changes ("wave", or "waves.wave"). */
  readonly watch: string[] = [];
  /** eudplib's own steps (and the test's, and the unseen) are stopped at too. */
  everyStep = false;
  private session: Session | null = null;
  private readonly d: DebuggerDeps;
  private readonly body: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly time: HTMLElement;
  private readonly cols: HTMLElement;
  private readonly root: HTMLElement;
  /** The three columns, made once a session (the game's view is a frame: moved, it would load again). */
  private readonly varsCol: HTMLElement;
  private readonly stepsCol: HTMLElement;
  private readonly gameCol: HTMLElement;
  private readonly viewBox: HTMLElement;
  private readonly shownBox: HTMLElement;
  /**
   * Where the game's view lives: over the workspace, laid over `viewBox` while the Debug view shows and hidden
   * otherwise. The view is a frame, which loads again whenever it is moved or taken out of the page, and the panel
   * takes a view's body out when another is shown.
   */
  private readonly overlay: HTMLElement;
  private placing = 0;
  private placed = "";

  constructor(deps: DebuggerDeps) {
    this.d = deps;
    const { el, t, shell } = deps;
    const view = shell.view({ id: "debug", title: t("Debug") });
    this.body = view.body;
    this.bar = el("div", { className: "tsd-debug-bar" });
    this.time = el("div", { className: "tsd-debug-time" });
    this.cols = el("div", { className: "tsd-debug-cols" });
    this.varsCol = el("div", { className: "tsd-debug-col" });
    this.stepsCol = el("div", { className: "tsd-debug-col" });
    this.viewBox = el("div");
    this.shownBox = el("div", { className: "tsd-shown", title: t("The text lines up to this frame") });
    this.gameCol = el("div", { className: "tsd-debug-col tsd-debug-game" }, el("h5", {}, t("The game")), this.viewBox, this.shownBox);
    this.overlay = el("div", { className: "tsd-debug-overlay" });
    shell.root.append(this.overlay);
    // (Focusable, so that a click anywhere in the view leaves the keys with the workspace: F10 and the rest.)
    this.root = el("div", { className: "tsd-debug", tabIndex: -1 }, this.bar, this.time, this.cols);
    this.body.append(this.root);
    this.time.addEventListener("pointerdown", (e) => {
      if (!this.session) return;
      // (The graph is drawn anew under the pointer, so the browser would give the focus to the page: the view takes it.)
      e.preventDefault();
      this.root.focus({ preventScroll: true });
      this.time.setPointerCapture(e.pointerId);
      this.scrub(e);
      const move = (m: PointerEvent) => this.scrub(m);
      const up = () => { this.time.removeEventListener("pointermove", move); this.time.removeEventListener("pointerup", up); };
      this.time.addEventListener("pointermove", move);
      this.time.addEventListener("pointerup", up);
    });
    this.render();
  }

  get active(): boolean { return this.session !== null; }

  /**
   * Where a view of the game for the next session goes (`DebugStart.view`'s element must be this): in the page from
   * the start, since a frame made outside it never loads.
   */
  gameHost(): HTMLElement {
    const host = this.d.el("div");
    this.overlay.replaceChildren(host);
    return host;
  }

  /** Keeps the game's view over its place in the Debug view, and out of sight while that is not shown. */
  private place = () => {
    this.placing = 0;
    const s = this.session;
    if (!s || !s.view || typeof s.view === "string") { this.overlay.style.display = "none"; this.placed = ""; return; }
    const root = this.d.shell.root, box = this.viewBox;
    const b = box.isConnected ? box.getBoundingClientRect() : null;
    let key = "none";
    if (b) {
      // (Only what of it the column shows.)
      const c = this.gameCol.getBoundingClientRect();
      const left = Math.max(b.left, c.left), top = Math.max(b.top, c.top), right = Math.min(b.right, c.right), bottom = Math.min(b.bottom, c.bottom);
      const o = root.getBoundingClientRect();
      if (right - left > 0 && bottom - top > 0) key = `${Math.round(left - o.left)},${Math.round(top - o.top)},${Math.round(right - left)},${Math.round(bottom - top)}`;
    }
    if (key !== this.placed) {
      this.placed = key;
      if (key === "none") this.overlay.style.display = "none";
      else {
        const [x, y, w, h] = key.split(",");
        Object.assign(this.overlay.style, { display: "block", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      }
    }
    this.placing = requestAnimationFrame(this.place);
  };

  /** A recorded run to walk: the cursor at its start, or at its end when the test failed (where debugging begins). */
  start(s: DebugStart): void {
    const keep = s.view && typeof s.view !== "string" ? s.view.element : null;
    this.end(keep);
    const cursor = new DebugCursor(s.recording, s.variables);
    this.session = { ...s, cursor, costs: cursor.frameCosts(), last: new Map(), stop: null, picture: { timer: null, asked: -1, shown: -1 } };
    const { el, t } = this.d;
    this.viewBox.replaceChildren(...(keep ? [] : [el("div", { className: "tsd-empty" }, typeof s.view === "string" ? s.view : t("No picture of the game here."))]));
    this.viewBox.className = keep ? "tsd-view" : "";
    if (!keep) this.overlay.replaceChildren();
    if (keep && !this.placing) this.placing = requestAnimationFrame(this.place);
    this.cols.replaceChildren(this.varsCol, this.stepsCol, this.gameCol);
    if (s.recording.result.status === "failed" && s.recording.frames) cursor.toFrame(s.recording.frames - 1);
    else this.firstLine();
    this.d.shell.showPanel("debug");
    this.d.shell.growPanel(DEBUG_PANEL);
    this.moved();
  }

  /** The session is over: the engine's game let go, the editor's marks taken away (`keep`: a view made for the next). */
  end(keep: HTMLElement | null = null): void {
    if (!keep) { this.overlay.replaceChildren(); this.overlay.style.display = "none"; this.placed = ""; }
    if (this.placing) { cancelAnimationFrame(this.placing); this.placing = 0; }
    const s = this.session;
    if (!s) return;
    if (s.picture.timer) clearTimeout(s.picture.timer);
    s.pictures?.close();
    if (s.view && typeof s.view !== "string" && s.view.element !== keep) s.view.dispose();
    this.viewBox.replaceChildren();
    this.session = null;
    this.render();
    this.d.changed();
  }

  /* ── what the person does ── */

  toggleBreakpoint(file: string, line: number): void {
    const k = `${file}:${line}`;
    if (!this.breakpoints.delete(k)) this.breakpoints.add(k);
    this.d.changed();
    if (this.session) this.renderTime();
  }

  toggleWatch(name: string): void {
    const at = this.watch.indexOf(name);
    if (at >= 0) this.watch.splice(at, 1); else this.watch.push(name);
    this.render();
  }

  continueForward(): void { this.go((c) => c.continueForward(this.breakpoints, this.watch)); }
  continueBack(): void { this.go((c) => c.continueBack(this.breakpoints, this.watch)); }
  stepForward(): void { this.go((c) => { c.stepForward(this.everyStep); return null; }); }
  stepBack(): void { this.go((c) => { c.stepBack(this.everyStep); return null; }); }
  nextFrame(): void { this.go((c) => { c.nextFrame(); return null; }); }
  prevFrame(): void { this.go((c) => { c.prevFrame(); return null; }); }
  restart(): void { this.go(() => { this.firstLine(); return null; }); }

  /** The run's first line of the script (frames with none run, such as the first, are passed over). */
  private firstLine() {
    const c = this.session!.cursor;
    c.moveTo({ k: 0, s: c.frameStart(0) });
    if (this.everyStep) return;
    while (!c.line()) {
      const was = c.where;
      c.stepForward(false);
      const now = c.where;
      if (now.k === was.k && now.s === was.s) { c.moveTo({ k: 0, s: c.frameStart(0) }); return; }
    }
  }

  private go(move: (c: DebugCursor) => DebugStop | null): void {
    const s = this.session;
    if (!s) return;
    s.stop = move(s.cursor);
    this.moved();
  }

  private scrub(e: PointerEvent) {
    const s = this.session;
    if (!s || !s.recording.frames) return;
    const r = this.time.getBoundingClientRect();
    const k = Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * s.recording.frames);
    s.cursor.toFrame(Math.max(0, Math.min(s.recording.frames - 1, k)));
    s.stop = null;
    this.moved();
  }

  /** The cursor moved: the editor's line, the view, the picture. */
  private moved() {
    const s = this.session;
    if (!s) return;
    const at = s.cursor.line() ?? s.cursor.testLine();
    if (at) this.d.reveal(at.file, at.line);
    this.render();
    this.d.changed();
    this.askPicture();
  }

  /* ── what goes in the editor ── */

  /** The editor's marks: breakpoints, the line about to run, the test's line. */
  marks(): { breakpoints: DebugPlace[]; at: DebugPlace | null; test: DebugPlace | null } {
    const breakpoints = [...this.breakpoints].map((k) => { const i = k.lastIndexOf(":"); return { file: k.slice(0, i), line: Number(k.slice(i + 1)) }; });
    const s = this.session;
    if (!s || !this.current()) return { breakpoints, at: null, test: null };
    return { breakpoints, at: s.cursor.line(), test: s.cursor.testLine() };
  }

  /** Beside each line run so far in the frame: the variables it wrote, at the cursor, and how often it ran. */
  hints(): LineHint[] {
    const s = this.session;
    if (!s || !this.current() || !s.cursor.known) return [];
    const { t } = this.d;
    const values = new Map<string, string>();
    for (const p of s.cursor.programs()) for (const v of p.values) if (!values.has(v.name)) values.set(v.name, show(v.value, 40));
    return s.cursor.frameLines().map((l) => {
      const said = l.names.map((n) => `${n} = ${values.get(n) ?? "?"}`);
      if (l.steps > 1) said.push(`×${l.steps}`);
      return said.length ? { file: l.place.file, line: l.place.line, label: said.join("  "), note: t("What this line wrote in frame {frame}, as it stands at the debugger's cursor; ×n: how many times it ran in the frame so far.", { frame: s.cursor.frame() }) } : null;
    }).filter((h): h is LineHint => h !== null);
  }

  /** The script is as the run was built from: lines mean what they meant. */
  private current(): boolean {
    const s = this.session;
    return !!s && Object.keys(s.files).length > 0 && this.filesNow !== null && Object.entries(s.files).every(([f, text]) => this.filesNow![f] === text);
  }
  private filesNow: Record<string, string> | null = null;
  /** The editor's files now (the debugger's marks show only while they are the run's). */
  setFiles(files: Record<string, string>): void {
    const was = this.current();
    this.filesNow = files;
    if (this.session && was !== this.current()) { this.render(); this.d.changed(); }
  }

  /* ── the picture ── */

  private askPicture() {
    const s = this.session;
    if (!s || !s.pictures || !s.view || typeof s.view === "string") return;
    if (s.picture.timer) clearTimeout(s.picture.timer);
    s.picture.timer = setTimeout(() => {
      s.picture.timer = null;
      const c = s.cursor;
      // (Mid-frame, the game as the frame found it: the frame before's end.)
      const frame = c.atEnd() ? c.frame() : c.frame() - 1;
      if (frame === s.picture.shown || frame === s.picture.asked || s.pictures!.closed) return;
      s.picture.asked = frame;
      s.pictures!.picture(frame).then(
        (p) => {
          if (this.session !== s || typeof s.view === "string" || !s.view) return;
          s.picture.asked = -1;
          s.picture.shown = p.frame;
          s.view.show(p);
          // The cursor moved on while it was made: the next.
          this.askPicture();
        },
        (err: Error) => { s.picture.asked = -1; if (this.session === s) this.d.setStatus("error", this.d.t("No picture of the game: {message}", { message: err.message })); },
      );
    }, PICTURE_MS);
  }

  /* ── the view ── */

  private button(icon: IconName, title: string, run: () => void, disabled = false): HTMLElement {
    const b = this.d.shell.iconButton({ icon, title, run });
    b.set({ disabled });
    return b.element;
  }

  private render() {
    // (A button pressed here is drawn anew: the keys stay with the view rather than going to the page.)
    const focused = this.root.contains(document.activeElement);
    this.draw();
    if (focused && !this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
  }

  private draw() {
    const { el, t } = this.d;
    const s = this.session;
    if (!s) {
      this.bar.replaceChildren(el("span", { className: "tsd-why" }, t("No test is being debugged. Debug one from its row in the Testing view (the bug icon) or with Debug Test at Cursor: it runs once in the game with everything it did written down, and here you walk it, forwards and back.")));
      this.time.replaceChildren();
      this.cols.replaceChildren();
      return;
    }
    if (this.cols.childElementCount !== 3) this.cols.replaceChildren(this.varsCol, this.stepsCol, this.gameCol);
    const c = s.cursor, rec = s.recording;
    const none = !rec.frames;
    const why = (() => {
      if (!this.current()) return { text: t("The script changed since this run: its lines may have moved. Debug the test again to walk the script as it is."), failed: true };
      if (s.stop?.kind === "breakpoint") return { text: t("Stopped at the breakpoint on line {line}.", { line: s.stop.place.line }), failed: false };
      if (s.stop?.kind === "watch") return { text: t("{name} changed: {before} → {after}", { name: s.stop.name, before: s.stop.before, after: s.stop.after }), failed: false };
      if (s.stop?.kind === "start") return { text: t("The start of the run."), failed: false };
      if (s.stop?.kind === "end") return { text: rec.result.status === "failed" ? t("The end of the run: {message}", { message: rec.result.message ?? t("the test failed") }) : t("The end of the run: the test passed."), failed: rec.result.status === "failed" };
      if (rec.cut && !c.known) return { text: t("The record stops at frame {frame} ({why}): the variables are not known past it.", { frame: rec.cut.frame, why: rec.cut.why }), failed: true };
      return rec.result.status === "failed" ? { text: t("{test} failed: {message}", { test: rec.test.name, message: rec.result.message ?? "" }), failed: true } : { text: t("{test} passed.", { test: rec.test.name }), failed: false };
    })();
    const line = c.line();
    const where = none ? t("no frames") : `${t("frame {frame}", { frame: c.frame() })}  ${(c.frame() / 24).toFixed(2)} s  ${line ? `${line.file}:${line.line}` : c.atEnd() ? t("end of frame") : t("eudplib")}`;
    const every = el("input", { type: "checkbox", checked: this.everyStep }) as HTMLInputElement;
    every.addEventListener("change", () => { this.everyStep = every.checked; this.render(); });
    this.bar.replaceChildren(
      this.button("debug-reverse-continue", t("Continue backwards (F6): to the breakpoint or the change of a watched variable before this, or the start"), () => this.continueBack(), none),
      this.button("debug-step-back", t("Back a line (Shift+F10)"), () => this.stepBack(), none),
      this.button("debug-step-over", t("On a line (F10)"), () => this.stepForward(), none),
      this.button("debug-continue", t("Continue (F5): to the next breakpoint or change of a watched variable, or the end"), () => this.continueForward(), none),
      el("span", { className: "tsd-sep" }),
      this.button("arrow-left", t("Back a frame (Shift+F11)"), () => this.prevFrame(), none),
      this.button("arrow-right", t("On a frame (F11): to the end of this one"), () => this.nextFrame(), none),
      this.button("debug-restart", t("To the start of the run"), () => this.restart(), none),
      this.button("debug-stop", t("Stop debugging (Shift+F5)"), () => this.end()),
      el("span", { className: "tsd-where" }, where),
      el("span", { className: why.failed ? "tsd-why tsd-failed" : "tsd-why", title: why.text }, why.text),
      el("label", { title: t("Stop at every step, eudplib's own work and what the game wrote by itself included, not only at the script's lines") }, every, t("Every step")),
    );
    this.renderTime();
    this.renderCols();
  }

  private renderTime() {
    const s = this.session;
    if (!s) return;
    const rec = s.recording, n = Math.max(rec.frames, 1), c = s.cursor;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} 100`);
    svg.setAttribute("preserveAspectRatio", "none");
    const rect = (x: number, y: number, w: number, h: number, cls: string, title?: string) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x)); r.setAttribute("y", String(y)); r.setAttribute("width", String(w)); r.setAttribute("height", String(h)); r.setAttribute("class", cls);
      if (title) { const tt = document.createElementNS(NS, "title"); tt.textContent = title; r.append(tt); }
      svg.append(r);
    };
    const top = Math.max(1, ...s.costs);
    const area = document.createElementNS(NS, "path");
    const pts: string[] = [];
    s.costs.forEach((v, k) => { const y = (100 - (v / top) * 70).toFixed(2); pts.push(`${k},${y} ${k + 1},${y}`); });
    area.setAttribute("d", `M0,100 L${pts.join(" L")} L${n},100 Z`);
    area.setAttribute("class", "cost");
    svg.append(area);
    const { t } = this.d;
    if (rec.cut) { const k = rec.cut.frame - rec.first; rect(k, 0, n - k, 100, "cut", t("Not recorded past frame {frame}: {why}", { frame: rec.cut.frame, why: rec.cut.why })); }
    const w = Math.max(n / 600, 0.6);
    for (const b of this.marks().breakpoints) for (const k of c.hits(b)) rect(k, 0, w, 14, "hit", t("Line {line} runs in frame {frame}", { line: b.line, frame: rec.first + k }));
    for (const x of rec.shown) rect(x.frame - rec.first, 88, w, 12, "said", x.text);
    if (rec.result.status === "failed") rect(n - w, 0, w, 100, "end", rec.result.message ?? "");
    rect(c.where.k, 0, Math.max(w, n / 300), 100, "now");
    const title = document.createElementNS(NS, "title");
    title.textContent = t("Frames {from} to {to}: the script's conditions and actions a frame ({peak} at the most). Red: a breakpoint's line runs; gold: a line of text was shown. Click or drag to go to a frame.", { from: rec.first, to: rec.first + rec.frames - 1, peak: shortCount(top) });
    svg.prepend(title);
    this.time.replaceChildren(svg);
  }

  private renderCols() {
    const { el, t } = this.d;
    const s = this.session!;
    const c = s.cursor, rec = s.recording;

    // Watched variables and every program's, at the cursor, what changed since the last stop in gold.
    const vars = this.varsCol;
    vars.replaceChildren(el("h5", {}, t("Variables")));
    const list = el("ul");
    const now = new Map<string, string>();
    if (!c.known) list.append(el("li", { className: "tsd-empty" }, t("Not known here: the record stops at frame {frame}.", { frame: rec.cut!.frame })));
    else {
      const programs = c.programs();
      if (this.watch.length) {
        list.append(el("li", { className: "tsd-program" }, t("Watched")));
        for (const name of this.watch) list.append(this.varRow(name, c.watchText(name), s.last.get(`watch:${name}`), true, () => this.toggleWatch(name)));
        for (const name of this.watch) now.set(`watch:${name}`, c.watchText(name));
      }
      if (!programs.length) list.append(el("li", { className: "tsd-empty" }, t("The build did not say where the programs' variables are.")));
      for (const p of programs) {
        list.append(el("li", { className: "tsd-program" }, p.label));
        for (const v of p.values) {
          const text = show(v.value, 400), id = `${p.label}:${v.name}`;
          now.set(id, text);
          const watchName = programs.filter((x) => x.values.some((y) => y.name === v.name)).length > 1 ? `${p.label.split(" ")[0]}.${v.name}` : v.name;
          list.append(this.varRow(v.name, text, s.last.get(id), this.watch.includes(watchName), () => this.toggleWatch(watchName)));
        }
      }
    }
    s.last = now;
    vars.append(list);

    // The frame's steps, the cursor's highlighted; a click goes there.
    const steps = this.stepsCol;
    steps.replaceChildren(el("h5", {}, t("Frame {frame}", { frame: c.frame() })));
    const rows = el("ul");
    const k = c.where.k;
    const first = c.frameStart(k), end = c.frameEnd(k);
    const most = 400;
    for (let i = first; i < Math.min(end, first + most); i++) {
      const l = rec.stepLine[i], place = c.placeOf(i);
      if (!this.everyStep && l === STEP_EUDPLIB && rec.stepWrites[i + 1] === rec.stepWrites[i]) continue;
      const label = place ? `${place.file === "main.ts" ? "" : `${place.file} `}${t("line {line}", { line: place.line })}` : l === STEP_TEST ? t("the test") : l === STEP_UNSEEN ? t("the game itself") : t("eudplib");
      const wrote = rec.stepWrites[i + 1] - rec.stepWrites[i];
      const row = el("li", { className: `tsd-click${i === c.where.s ? " tsd-here" : ""}${place ? "" : " tsd-dim"}`, onClick: () => { c.moveTo({ k, s: i }); s.stop = null; this.moved(); } },
        el("span", { className: "k" }, label),
        el("span", { className: "v" }, wrote ? t("{n, plural, one {# write} other {# writes}}", { n: wrote }) : ""),
        el("span", { className: "n", title: t("conditions and actions") }, String(rec.stepRecords[i])));
      rows.append(row);
    }
    if (end - first > most) rows.append(el("li", { className: "tsd-dim" }, t("… and {n} more steps", { n: end - first - most })));
    rows.append(el("li", { className: `tsd-click${c.atEnd() ? " tsd-here" : ""} tsd-dim`, onClick: () => { c.moveTo({ k, s: end }); s.stop = null; this.moved(); } }, el("span", { className: "k" }, t("end of frame")), el("span", { className: "n" }, String(s.costs[k] ?? 0))));
    steps.append(rows);

    // What was shown on the game's text lines up to the cursor's frame (the picture is drawn into its own box).
    const shown = c.shown();
    this.shownBox.replaceChildren(...(shown.length ? shown.map((x) => el("div", {}, `${x.frame}  ${x.text}`)) : [el("div", {}, t("Nothing shown yet."))]));
  }

  private varRow(name: string, text: string, before: string | undefined, watched: boolean, toggle: () => void): HTMLElement {
    const { el, t } = this.d;
    const eye = this.d.shell.iconButton({ icon: "eye", title: watched ? t("Stop watching {name}", { name }) : t("Watch {name}: Continue stops where it changes", { name }), run: toggle });
    if (watched) eye.element.classList.add("tsd-on");
    return el("li", { title: text },
      el("span", { className: "k" }, name),
      el("span", { className: before !== undefined && before !== text ? "v tsd-changed" : "v" }, text),
      eye.element);
  }
}
