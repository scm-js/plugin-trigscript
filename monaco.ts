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
 * The theme is the editor's own palette (tokens.css) rather than VS Code's.
 *
 * The URL is not a static import on purpose: the editor's plugin loader follows every
 * literal import specifier and would try to fetch and transpile the bundle. A dynamic
 * `import()` of a variable passes through to the browser untouched.
 */
import type * as Monaco from "monaco-editor";
import { DECLARATIONS_FILE } from "./compiler/declarations";
import type { LineCost, ScriptDiagnostic, ScriptFiles, SourceRange, VariableInfo } from "./compiler/compiler";
import { normalizePath } from "./compiler/compiler";
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
    lib: ["lib.es2022.d.ts"],
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
 * Hovering a program's variable says where it lives — "a death counter, P2 · Cantina
 * (Unused)" — under TypeScript's own `let n: number`. The identifier is resolved to its
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
        const what = v.kind === "boolean" ? "a switch" : v.bits ? `a u${v.bits} death counter (0 … ${2 ** v.bits - 1})` : "a death counter";
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: `**${v.name}** is a variable of the program: ${what}, ${v.storage}.` }],
        };
      }
      return null;
    },
  });
}

let costHints: () => LineCost[] = () => [];
let costChanged: Monaco.Emitter<void> | null = null;

/**
 * The cost of a line, at its end, as an inlay hint: "66 triggers" after `a = b`. The
 * dialog decides which lines get one (`costs` is its filtered list); `refreshCostHints`
 * makes Monaco ask again after a compile. Registered once per Monaco.
 */
export function setCostHints(monaco: MonacoApi, costs: () => LineCost[]) {
  costHints = costs;
  if (costChanged) { costChanged.fire(); return; }
  const changed = new monaco.Emitter<void>();
  costChanged = changed;
  monaco.languages.registerInlayHintsProvider("typescript", {
    onDidChangeInlayHints: changed.event,
    provideInlayHints(model, range) {
      if (model.uri.scheme !== "file") return null;
      const path = pathOfUri(model.uri);
      const hints = costHints()
        .filter((c) => normalizePath(c.file) === path && c.line >= range.startLineNumber && c.line <= range.endLineNumber && c.line <= model.getLineCount())
        .map((c): Monaco.languages.InlayHint => ({
          position: { lineNumber: c.line, column: model.getLineMaxColumn(c.line) },
          label: `${c.triggers} trigger${c.triggers === 1 ? "" : "s"}`,
          kind: monaco.languages.InlayHintKind.Type,
          paddingLeft: true,
          ...(c.note ? { tooltip: c.note } : {}),
        }));
      return { hints, dispose() {} };
    },
  });
}

export function refreshCostHints() {
  costChanged?.fire();
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

/** The compiler's own diagnostics, drawn under the TypeScript ones, per file. */
export function setCompilerMarkers(monaco: MonacoApi, files: ScriptFiles, diagnostics: ScriptDiagnostic[]) {
  for (const path of Object.keys(files)) {
    const model = monaco.editor.getModel(fileUri(monaco, path));
    if (!model) continue;
    monaco.editor.setModelMarkers(
      model,
      "trigscript",
      diagnostics.filter((d) => d.source !== "typescript" && normalizePath(d.file) === normalizePath(path)).map((d) => ({
        severity: monaco.MarkerSeverity.Error,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
      })),
    );
  }
}

export interface ScriptEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
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

export function createScriptEditor(monaco: MonacoApi, host: HTMLElement, files: ScriptFiles, active: string, onChange: (path: string, text: string) => void): ScriptEditor {
  disposeModels(monaco);
  const models = new Map<string, Monaco.editor.ITextModel>();
  const subs = new Map<string, Monaco.IDisposable>();
  /** Per file, the ids of the build-time decorations, for the next `deltaDecorations`. */
  const decorations = new Map<string, string[]>();
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
