/**
 * The module the compile worker imports. The editor's plugin loader turns every file of
 * this plugin into a `blob:` module on the main thread; a worker of the same origin can
 * import that URL too, and this module's `import.meta.url` *is* its blob URL — so the
 * main thread hands it over and the worker `import()`s the same compiler the main thread
 * would run, with the TypeScript namespace it loaded from the CDN passed in. When the
 * editor has compiled the plugin in instead (a default), this URL is a chunk of the
 * editor's bundle, no use to a worker, and `compile.ts` sends the worker to the same
 * module bundled on its own as `dist/compiler.js`.
 */
export { compileScript } from "./compiler";

/** Where this module was loaded from — what the worker is told to import. */
export const ENTRY_URL: string = import.meta.url;
