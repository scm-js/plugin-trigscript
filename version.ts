/**
 * The plugin's version, as code: `plugin.json` is what the editor reads, but a file the
 * editor's loader turns into a module cannot import JSON, and the compile worker needs
 * the version to fetch this release's own compiler bundle from the CDN when the plugin
 * has been compiled into the editor (`compile.ts`). `tests/script.test.ts` keeps this
 * equal to the manifest's.
 */
export const VERSION = "2.5.1";
