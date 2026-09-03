/**
 * What `dist/monaco.js` is built from: the editor core, its feature set, and the
 * TypeScript language alone (no other tokenizers), exported the way Monaco's own root
 * module exports them — `editor`, `languages`, `Uri`, `MarkerSeverity`, … plus
 * `typescript` for the language service's defaults. See `bundle/build.mjs`.
 */
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/typescript/register";
import * as typescript from "monaco-editor/languages/features/typescript/register";

export * from "monaco-editor/editor/editor.api";
export { typescript };
