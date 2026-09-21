/**
 * Monaco on first use, from the plugin's own build of it (`bundle/build.mjs` → `dist/`:
 * the editor with the TypeScript language and its styles, and the two workers), served
 * by jsDelivr's GitHub mirror at a tag of this repository — a CDN's on-the-fly bundler
 * breaks Monaco's lazy language chunks, see the build script. The workers start from
 * blob module workers, since a cross-origin script cannot be a worker directly.
 *
 * The script's files are one model each under `file:///`, so `import { x } from
 * "./bases"` resolves between them in Monaco's own TypeScript worker; the generated
 * declarations are the one extra lib, and the standard library is the worker's own.
 * The theme is the editor's own palette (tokens.css) rather than VS Code's, down to
 * Monaco's own widgets (the command palette, the context menu).
 *
 * The URL is not a static import on purpose: the editor's plugin loader follows every
 * literal import specifier and would try to fetch and transpile the bundle. A dynamic
 * `import()` of a variable passes through to the browser untouched.
 */
import type * as Monaco from "monaco-editor";
import { DECLARATIONS_FILE } from "./compiler/declarations";
import type { LineHint, ScriptDiagnostic, ScriptFiles, SourceRange, VariableInfo } from "./compiler/compiler";
import { describeVariable, normalizePath } from "./compiler/compiler";
import { findReferences } from "./refs";

export const MONACO_VERSION = "0.56.0";
/** The tag `dist/` is served from; move it when the bundle changes (`git tag monaco-<version>-<n>`). */
export const DIST_TAG = "monaco-0.56.0-2";
export const DEFAULT_DIST = `https://cdn.jsdelivr.net/gh/scm-js/plugin-trigscript@${DIST_TAG}/dist`;
/** The plugin storage key that overrides where the bundle is fetched from (development: a local server). */
export const DIST_STORAGE_KEY = "monacoDist";

export type MonacoApi = typeof Monaco;

export const THEME = "scm";

let loading: Promise<MonacoApi> | null = null;
let loadedFrom: string | null = null;

function moduleWorker(url: string): Worker {
  const blob = new Blob([`import ${JSON.stringify(url)};\n`], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(blob), { type: "module" });
}

/** The TypeScript language service's settings: a top-level `typescript` export in 0.56's ESM build (`languages.typescript` is the deprecated spot). */
function tsLanguage(monaco: MonacoApi): typeof Monaco.typescript {
  const found = monaco.typescript ?? (monaco.languages as unknown as { typescript?: typeof Monaco.typescript }).typescript;
  if (!found?.typescriptDefaults) throw new Error("Monaco loaded without its TypeScript language service.");
  return found;
}

/** TypeScript's `ModuleResolutionKind.Bundler`; Monaco's copy of the enum predates it. */
const BUNDLER_RESOLUTION = 100;

function configure(monaco: MonacoApi) {
  const ts = tsLanguage(monaco);
  ts.typescriptDefaults.setCompilerOptions({
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: BUNDLER_RESOLUTION as unknown as Monaco.typescript.ModuleResolutionKind,
    lib: ["lib.es2023.d.ts"],
    noEmit: true,
    types: [],
  });
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });

  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5d6675", fontStyle: "italic" },
      { token: "keyword", foreground: "e6b95c" },
      { token: "string", foreground: "4fd1c5" },
      { token: "number", foreground: "f4d08a" },
      { token: "type.identifier", foreground: "8fd3ff" },
      { token: "identifier", foreground: "dde2ea" },
      { token: "delimiter", foreground: "99a2b3" },
      { token: "operator", foreground: "99a2b3" },
    ],
    colors: {
      "editor.background": "#0a0c10",
      "editor.foreground": "#dde2ea",
      "editor.lineHighlightBackground": "#12151b",
      "editor.lineHighlightBorder": "#12151b",
      "editorLineNumber.foreground": "#5d6675",
      "editorLineNumber.activeForeground": "#99a2b3",
      "editor.selectionBackground": "#2b4f80",
      "editor.inactiveSelectionBackground": "#222732",
      "editorCursor.foreground": "#e6b95c",
      "editorIndentGuide.background1": "#222732",
      "editorIndentGuide.activeBackground1": "#353c4b",
      "editorWidget.background": "#191d25",
      "editorWidget.border": "#2c3341",
      "editorSuggestWidget.background": "#191d25",
      "editorSuggestWidget.border": "#2c3341",
      "editorSuggestWidget.selectedBackground": "#2b4f80",
      "editorHoverWidget.background": "#191d25",
      "editorHoverWidget.border": "#2c3341",
      "editorError.foreground": "#d9534f",
      "editorWarning.foreground": "#e0a545",
      "scrollbarSlider.background": "#353c4b80",
      "scrollbarSlider.hoverBackground": "#3b4453a0",
      "editorGutter.background": "#0a0c10",
      "minimap.background": "#0a0c10",
      // The command palette, Go to Line and the context menu are Monaco's own widgets; the workspace around them is tokens.css.
      "focusBorder": "#3a68a8",
      "widget.shadow": "#000000a0",
      "input.background": "#0a0c10",
      "input.foreground": "#dde2ea",
      "input.border": "#2c3341",
      "quickInput.background": "#191d25",
      "quickInput.foreground": "#dde2ea",
      "quickInputList.focusBackground": "#2b4f80",
      "quickInputList.focusForeground": "#dde2ea",
      "list.hoverBackground": "#222732",
      "list.highlightForeground": "#e6b95c",
      "list.focusHighlightForeground": "#f4d08a",
      "pickerGroup.border": "#2c3341",
      "pickerGroup.foreground": "#99a2b3",
      "keybindingLabel.background": "#222732",
      "keybindingLabel.foreground": "#dde2ea",
      "keybindingLabel.border": "#3b4453",
      "keybindingLabel.bottomBorder": "#3b4453",
      "menu.background": "#191d25",
      "menu.foreground": "#dde2ea",
      "menu.selectionBackground": "#2b4f80",
      "menu.selectionForeground": "#dde2ea",
      "menu.separatorBackground": "#2c3341",
      "menu.border": "#3b4453",
    },
  });
}

/** Monaco, loaded once from `base` (`DEFAULT_DIST` unless overridden); a failed load can be retried. */
export function loadMonaco(base: string = DEFAULT_DIST): Promise<MonacoApi> {
  const dist = base.replace(/\/+$/, "");
  if (loading && loadedFrom !== dist) return loading;
  loading ??= (async () => {
    loadedFrom = dist;
    (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: (_id: string, label: string) => moduleWorker(`${dist}/${label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js"}`),
    };
    const url = `${dist}/monaco.js`;
    const monaco = (await import(/* @vite-ignore */ url)) as MonacoApi;
    configure(monaco);
    return monaco;
  })().catch((err) => {
    loading = null;
    loadedFrom = null;
    throw err;
  });
  return loading;
}

/** Point the language service at a fresh declaration file (the map's names changed). */
export function setDeclarations(monaco: MonacoApi, content: string) {
  tsLanguage(monaco).typescriptDefaults.setExtraLibs([{ content, filePath: `file:///${DECLARATIONS_FILE}` }]);
}

export const fileUri = (monaco: MonacoApi, path: string) => monaco.Uri.parse(`file:///${normalizePath(path)}`);
/** The script path of a `file:///` model. */
const pathOfUri = (uri: Monaco.Uri) => normalizePath(uri.path.replace(/^\/+/, ""));

/** The class the build-time parts of a program are drawn with; the dialog's stylesheet gives it its underline. */
export const BUILD_TIME_CLASS = "trigscript-build-time";
export const BUILD_TIME_NOTE = "Computed when the script is built, not in the game.";

let hoverVariables: () => VariableInfo[] = () => [];
let hoverRegistered = false;

/**
 * Hovering a program's variable says what it holds — "a number (−2 147 483 648 …" —
 * under TypeScript's own `let n: number` (`describeVariable`). The identifier is resolved to its
 * declaration by Monaco's TypeScript worker, and the declaration matched against the
 * last compile's variables. Registered once per Monaco; `variables` is the open dialog's.
 */
export function setHoverVariables(monaco: MonacoApi, variables: () => VariableInfo[]) {
  hoverVariables = variables;
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("typescript", {
    async provideHover(model, position) {
      if (model.uri.scheme !== "file") return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const client = await (await tsLanguage(monaco).getTypeScriptWorker())(model.uri);
      const defs = (await client.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(position))) as { fileName: string; textSpan: { start: number } }[] | undefined;
      for (const d of defs ?? []) {
        const m = monaco.editor.getModel(monaco.Uri.parse(d.fileName));
        if (!m) continue;
        const at = m.getPositionAt(d.textSpan.start);
        const path = pathOfUri(m.uri);
        const v = hoverVariables().find((x) => x.at && normalizePath(x.at.file) === path && x.at.line === at.lineNumber && x.at.column === at.column);
        if (!v) continue;
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: `**${v.name}** is a variable of the program: ${describeVariable(v)}${v.shared ? ", one value shared by every player the program runs for" : ""}. It lives in the game while the map is played.` }],
        };
      }
      return null;
    },
  });
}

let lineHints: () => LineHint[] = () => [];
let hintsChanged: Monaco.Emitter<void> | null = null;

/**
 * A word at the end of a line about what the compiler did with it: "unrolled ×6" after a
 * `for` whose bounds were known when the script was built. `refreshLineHints` makes Monaco
 * ask again after a compile. Registered once per Monaco.
 */
export function setLineHints(monaco: MonacoApi, hints: () => LineHint[]) {
  lineHints = hints;
  if (hintsChanged) { hintsChanged.fire(); return; }
  const changed = new monaco.Emitter<void>();
  hintsChanged = changed;
  monaco.languages.registerInlayHintsProvider("typescript", {
    onDidChangeInlayHints: changed.event,
    provideInlayHints(model, range) {
      if (model.uri.scheme !== "file") return null;
      const path = pathOfUri(model.uri);
      const hints = lineHints()
        .filter((c) => normalizePath(c.file) === path && c.line >= range.startLineNumber && c.line <= range.endLineNumber && c.line <= model.getLineCount())
        .map((c): Monaco.languages.InlayHint => ({
          position: { lineNumber: c.line, column: model.getLineMaxColumn(c.line) },
          label: c.label,
          kind: monaco.languages.InlayHintKind.Type,
          paddingLeft: true,
          tooltip: c.note,
        }));
      return { hints, dispose() {} };
    },
  });
}

export function refreshLineHints() {
  hintsChanged?.fire();
}

/** A location the script can name, for the editor's links and hovers. */
export interface LocationRef {
  /** The slot, 0-based. */
  index: number;
  name: string;
  /** In tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapRefs {
  /** The object the script reads locations from (`locations`). */
  object: string;
  /** By the key the script uses. */
  byKey: Map<string, LocationRef>;
  /** Ctrl+click: show the location on the map. */
  open(ref: LocationRef): void;
}

let mapRefs: () => MapRefs | null = () => null;
let mapRefsRegistered = false;
const LINK_SCHEME = "trigscript";

/**
 * `locations.Beacon` in the script is a link to the location: Ctrl+click shows it on the
 * map, and hovering it says where it is and how big. The link provider marks every
 * reference the compiler's names know; the opener answers the link's own scheme and
 * leaves every other link to Monaco. Registered once per Monaco; `refs` is the open
 * dialog's.
 */
export function setMapRefs(monaco: MonacoApi, refs: () => MapRefs | null) {
  mapRefs = refs;
  if (mapRefsRegistered) return;
  mapRefsRegistered = true;
  monaco.languages.registerLinkProvider("typescript", {
    provideLinks(model) {
      const r = mapRefs();
      if (!r || model.uri.scheme !== "file") return { links: [] };
      const links = findReferences(model.getValue(), r.object).filter((x) => r.byKey.has(x.key)).map((x) => ({
        range: new monaco.Range(x.line, x.column, x.line, x.endColumn),
        url: monaco.Uri.from({ scheme: LINK_SCHEME, path: `/location/${r.byKey.get(x.key)!.index}` }),
        tooltip: "Show on the map",
      }));
      return { links };
    },
  });
  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme !== LINK_SCHEME) return false;
      const m = /^\/location\/(\d+)$/.exec(resource.path);
      const r = mapRefs();
      if (!m || !r) return true;
      const index = Number(m[1]);
      const ref = [...r.byKey.values()].find((x) => x.index === index);
      if (ref) r.open(ref);
      return true;
    },
  });
  monaco.languages.registerHoverProvider("typescript", {
    provideHover(model, position) {
      const r = mapRefs();
      if (!r || model.uri.scheme !== "file") return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      if (!before.endsWith(`${r.object}.`)) return null;
      const ref = r.byKey.get(word.word);
      if (!ref) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: `**${ref.name}** — location ${ref.index + 1}: ${ref.w} × ${ref.h} tiles at ${ref.x}, ${ref.y}. Ctrl+click to show it on the map.` }],
      };
    },
  });
}

/** A line worth a warning that is no fault of the script: a test that fails, a `test.only` left in. */
export interface ScriptWarning { file: string; line: number; message: string }

/** The compiler's own diagnostics, drawn under the TypeScript ones, per file; `warnings` in the colour of a warning. */
export function setCompilerMarkers(monaco: MonacoApi, files: ScriptFiles, diagnostics: ScriptDiagnostic[], warnings: ScriptWarning[] = []) {
  for (const path of Object.keys(files)) {
    const model = monaco.editor.getModel(fileUri(monaco, path));
    if (!model) continue;
    monaco.editor.setModelMarkers(
      model,
      "trigscript",
      [
        ...diagnostics.filter((d) => d.source !== "typescript" && normalizePath(d.file) === normalizePath(path)).map((d) => ({
          severity: monaco.MarkerSeverity.Error,
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.endLine,
          endColumn: d.endColumn,
        })),
        ...warnings.filter((w) => normalizePath(w.file) === normalizePath(path) && w.line >= 1 && w.line <= model.getLineCount()).map((w) => ({
          severity: monaco.MarkerSeverity.Warning,
          message: w.message,
          startLineNumber: w.line,
          startColumn: model.getLineFirstNonWhitespaceColumn(w.line) || 1,
          endLineNumber: w.line,
          endColumn: model.getLineMaxColumn(w.line),
        })),
      ],
    );
  }
}

/** A mark in the margin beside a `test(` or a `describe(`: what became of it, and what is said at the end of a line that failed. */
export interface TestMark {
  file: string;
  line: number;
  state: "none" | "passed" | "failed" | "skipped" | "running";
  /** What the margin's mark says on hover. */
  title: string;
  /** What a click on the mark runs. */
  id: string;
}
export interface TestNote { file: string; line: number; text: string; hover?: string }

export const TEST_MARK_CLASS = "trigscript-test";

export interface ScriptEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
  /** The marks in the margin and the failures said at the end of their lines; `onMark` hears a click on a mark. */
  setTests(marks: TestMark[], notes: TestNote[]): void;
  /** The file the editor shows. */
  active(): string;
  show(path: string): void;
  files(): ScriptFiles;
  add(path: string, text: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  /** Replace a file's text (an import), keeping the model. */
  set(path: string, text: string): void;
  /** Underline the parts of the programs computed when the script is built (`CompileResult.buildTime`). */
  decorate(ranges: SourceRange[]): void;
  /** Put text at the cursor (over the selection), as typing it would, and focus the editor. */
  insert(text: string): void;
  /** The file and line the cursor is on. */
  cursor(): { file: string; line: number };
  dispose(): void;
}

/** Every model under `file:///`, disposed: the editor closed. Monaco's TypeScript worker is stopped too (see `releaseScriptEditor`). */
function disposeModels(monaco: MonacoApi) {
  for (const m of monaco.editor.getModels()) if (m.uri.scheme === "file" && m.uri.path.endsWith(".ts")) m.dispose();
}

/**
 * The editor closed: drop the models and stop Monaco's TypeScript worker. Monaco never
 * idles that worker out on its own, and it is a second TypeScript instance next to the
 * compile worker; re-setting the compiler options is the one public way to make its
 * `WorkerManager` stop it — it starts again on the next `createScriptEditor`. The files
 * themselves live in the archive, so only the closed session's undo history goes with the models.
 */
export function releaseScriptEditor(monaco: MonacoApi): void {
  disposeModels(monaco);
  const defaults = tsLanguage(monaco).typescriptDefaults;
  defaults.setCompilerOptions(defaults.getCompilerOptions());
}

export function createScriptEditor(monaco: MonacoApi, host: HTMLElement, files: ScriptFiles, active: string, onChange: (path: string, text: string) => void, onMark?: (id: string) => void): ScriptEditor {
  disposeModels(monaco);
  const models = new Map<string, Monaco.editor.ITextModel>();
  const subs = new Map<string, Monaco.IDisposable>();
  /** Per file, the ids of the build-time decorations, for the next `deltaDecorations`. */
  const decorations = new Map<string, string[]>();
  /** Per file, the ids of the tests' decorations. */
  const testDecorations = new Map<string, string[]>();
  /** The marks as last set, to find the one a click in the margin is on. */
  let testMarks: TestMark[] = [];
  /** Per file, the view state (cursor, scroll) to restore when it is shown again. */
  const views = new Map<string, Monaco.editor.ICodeEditorViewState | null>();
  const make = (path: string, text: string) => {
    const model = monaco.editor.createModel(text, "typescript", fileUri(monaco, path));
    models.set(path, model);
    subs.set(path, model.onDidChangeContent(() => onChange(path, model.getValue())));
    return model;
  };
  for (const [path, text] of Object.entries(files)) make(normalizePath(path), text);
  let current = normalizePath(active);
  if (!models.has(current)) current = [...models.keys()][0];
  const editor = monaco.editor.create(host, {
    model: models.get(current) ?? null,
    theme: THEME,
    automaticLayout: true,
    fontFamily: '"Cascadia Mono", "JetBrains Mono", ui-monospace, Consolas, Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 18,
    minimap: { enabled: false },
    // Where a test's mark goes; it stays narrow for a script without any.
    glyphMargin: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    tabSize: 2,
    insertSpaces: true,
    wordWrap: "off",
    fixedOverflowWidgets: true,
    padding: { top: 8, bottom: 8 },
    quickSuggestions: { other: true, strings: true, comments: false },
    suggest: { showWords: false },
  });
  // A click on a test's mark runs it.
  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    const mark = testMarks.find((m) => normalizePath(m.file) === current && m.line === line);
    if (mark) onMark?.(mark.id);
  });
  const show = (path: string) => {
    const p = normalizePath(path);
    const model = models.get(p);
    if (!model || p === current) return;
    views.set(current, editor.saveViewState());
    current = p;
    editor.setModel(model);
    const view = views.get(p);
    if (view) editor.restoreViewState(view);
  };
  return {
    editor,
    active: () => current,
    show,
    files: () => Object.fromEntries([...models].map(([p, m]) => [p, m.getValue()])),
    add(path, text) {
      const p = normalizePath(path);
      if (models.has(p)) return;
      make(p, text);
      onChange(p, text);
      show(p);
    },
    remove(path) {
      const p = normalizePath(path);
      const model = models.get(p);
      if (!model) return;
      if (p === current) { const other = [...models.keys()].find((k) => k !== p); if (other) show(other); }
      subs.get(p)?.dispose();
      subs.delete(p);
      models.delete(p);
      views.delete(p);
      decorations.delete(p);
      testDecorations.delete(p);
      model.dispose();
    },
    rename(from, to) {
      const a = normalizePath(from);
      const b = normalizePath(to);
      const model = models.get(a);
      if (!model || models.has(b)) return;
      const text = model.getValue();
      const wasCurrent = a === current;
      const view = wasCurrent ? editor.saveViewState() : views.get(a) ?? null;
      subs.get(a)?.dispose();
      subs.delete(a);
      models.delete(a);
      views.delete(a);
      decorations.delete(a);
      testDecorations.delete(a);
      if (wasCurrent) editor.setModel(null);
      model.dispose();
      const next = make(b, text);
      views.set(b, view);
      if (wasCurrent) { current = b; editor.setModel(next); if (view) editor.restoreViewState(view); }
    },
    set(path, text) {
      const model = models.get(normalizePath(path));
      if (model && model.getValue() !== text) model.setValue(text);
    },
    insert(text) {
      const sel = editor.getSelection() ?? new monaco.Selection(1, 1, 1, 1);
      editor.executeEdits("trigscript", [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
    },
    cursor() {
      return { file: current, line: editor.getPosition()?.lineNumber ?? 1 };
    },
    setTests(marks, notes) {
      testMarks = marks;
      for (const [p, model] of models) {
        const lines = model.getLineCount();
        const next: Monaco.editor.IModelDeltaDecoration[] = [
          ...marks.filter((m) => normalizePath(m.file) === p && m.line >= 1 && m.line <= lines).map((m) => ({
            range: new monaco.Range(m.line, 1, m.line, 1),
            options: { glyphMarginClassName: `${TEST_MARK_CLASS} ${TEST_MARK_CLASS}-${m.state}`, glyphMarginHoverMessage: { value: m.title }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          })),
          ...notes.filter((n) => normalizePath(n.file) === p && n.line >= 1 && n.line <= lines).map((n) => ({
            range: new monaco.Range(n.line, model.getLineMaxColumn(n.line), n.line, model.getLineMaxColumn(n.line)),
            options: { after: { content: `  ${n.text}`, inlineClassName: `${TEST_MARK_CLASS}-note` }, ...(n.hover ? { hoverMessage: { value: n.hover } } : {}), showIfCollapsed: true, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          })),
        ];
        testDecorations.set(p, model.deltaDecorations(testDecorations.get(p) ?? [], next));
      }
    },
    decorate(ranges) {
      for (const [p, model] of models) {
        const next = ranges.filter((r) => normalizePath(r.file) === p).map((r) => ({
          range: new monaco.Range(r.line, r.column, r.endLine, r.endColumn),
          // Never grows with typing at its edges: the next check redraws it where the compiler says.
          options: { inlineClassName: BUILD_TIME_CLASS, hoverMessage: { value: BUILD_TIME_NOTE }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        }));
        decorations.set(p, model.deltaDecorations(decorations.get(p) ?? [], next));
      }
    },
    dispose() {
      for (const s of subs.values()) s.dispose();
      editor.dispose();
    },
  };
}
