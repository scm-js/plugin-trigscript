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
import type { ScriptDiagnostic, ScriptFiles } from "./compiler/compiler";
import { normalizePath } from "./compiler/compiler";

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
    dispose() {
      for (const s of subs.values()) s.dispose();
      editor.dispose();
    },
  };
}
