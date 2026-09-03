/**
 * Monaco on first use, from the plugin's own build of it (`bundle/build.mjs` → `dist/`:
 * the editor with the TypeScript language and its styles, and the two workers), served
 * by jsDelivr's GitHub mirror at a tag of this repository — a CDN's on-the-fly bundler
 * breaks Monaco's lazy language chunks, see the build script. The workers start from
 * blob module workers, since a cross-origin script cannot be a worker directly. The
 * language service is configured `noLib` with the generated declarations as its one
 * extra lib, and the theme is the editor's own palette (tokens.css) rather than VS Code's.
 *
 * The URL is not a static import on purpose: the editor's plugin loader follows every
 * literal import specifier and would try to fetch and transpile the bundle. A dynamic
 * `import()` of a variable passes through to the browser untouched.
 */
import type * as Monaco from "monaco-editor";
import { DECLARATIONS_FILE } from "./compiler/declarations";
import type { ScriptDiagnostic } from "./compiler/compiler";

export const MONACO_VERSION = "0.56.0";
/** The tag `dist/` is served from; move it when the bundle changes (`git tag monaco-<version>-<n>`). */
export const DIST_TAG = "monaco-0.56.0-1";
export const DEFAULT_DIST = `https://cdn.jsdelivr.net/gh/scm-js/plugin-trigger-script@${DIST_TAG}/dist`;
/** The plugin storage key that overrides where the bundle is fetched from (development: a local server). */
export const DIST_STORAGE_KEY = "monacoDist";

export type MonacoApi = typeof Monaco;

export const THEME = "scm";
export const SCRIPT_URI_TEXT = "file:///triggers.ts";

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

function configure(monaco: MonacoApi) {
  const ts = tsLanguage(monaco);
  ts.typescriptDefaults.setCompilerOptions({
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
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

/** The compiler's own diagnostics, drawn under the TypeScript ones. */
export function setCompilerMarkers(monaco: MonacoApi, model: Monaco.editor.ITextModel, diagnostics: ScriptDiagnostic[]) {
  monaco.editor.setModelMarkers(
    model,
    "scm-compiler",
    diagnostics.filter((d) => d.source === "compiler").map((d) => ({
      severity: monaco.MarkerSeverity.Error,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine,
      endColumn: d.endColumn,
    })),
  );
}

export interface ScriptEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
  model: Monaco.editor.ITextModel;
  dispose(): void;
}

/**
 * The Script Editor closed: drop the model and stop Monaco's TypeScript worker. Monaco
 * never idles that worker out on its own, and it is a second TypeScript instance next to
 * the compile worker; re-setting the compiler options is the one public way to make its
 * `WorkerManager` stop it — it starts again on the next `createScriptEditor`. The source
 * itself lives in the archive, so only the closed session's undo history goes with the model.
 */
export function releaseScriptEditor(monaco: MonacoApi): void {
  monaco.editor.getModel(monaco.Uri.parse(SCRIPT_URI_TEXT))?.dispose();
  const defaults = tsLanguage(monaco).typescriptDefaults;
  defaults.setCompilerOptions(defaults.getCompilerOptions());
}

export function createScriptEditor(monaco: MonacoApi, host: HTMLElement, source: string, onChange: (text: string) => void): ScriptEditor {
  const uri = monaco.Uri.parse(SCRIPT_URI_TEXT);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(source, "typescript", uri);
  if (model.getValue() !== source) model.setValue(source);
  const editor = monaco.editor.create(host, {
    model,
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
  const sub = model.onDidChangeContent(() => onChange(model.getValue()));
  return {
    editor,
    model,
    dispose() {
      sub.dispose();
      editor.dispose();
    },
  };
}
