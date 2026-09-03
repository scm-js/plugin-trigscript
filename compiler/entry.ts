/**
 * The module the compile worker imports. The editor's plugin loader turns every file of
 * this plugin into a `blob:` module on the main thread; a worker of the same origin can
 * import that URL too, and this module's `import.meta.url` *is* its blob URL — so the
 * main thread hands it over and the worker `import()`s the same compiler the main thread
 * would run, with the TypeScript namespace it loaded from the CDN passed in.
 */
export { compileScript } from "./compiler";

/** Where this module was loaded from — what the worker is told to import. */
export const ENTRY_URL: string = import.meta.url;
