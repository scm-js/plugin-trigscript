/**
 * A map with a script already in it: `trigscript\main.ts` written into the archive, so the
 * workspace opens on that script. For the headless drive and for fixtures.
 *
 *   npx tsx scripts/with-script.mts <map.scx> <script.ts> <out.scx> [../scm-js]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [mapPath, scriptPath, outPath, editorArg] = process.argv.slice(2);
if (!mapPath || !scriptPath || !outPath) { console.error("usage: with-script <map.scx> <script.ts> <out.scx> [scm-js dir]"); process.exit(2); }
const EDITOR = resolve(editorArg ?? process.env.SCMJS_DIR ?? join(import.meta.dirname, "..", "..", "scm-js"));
const { loadMap, saveMap, readExtras } = await import(join(EDITOR, "src", "formats", "mpq", "scm.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(mapPath)));
const extras: Map<string, Uint8Array> = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
extras.set("trigscript\\main.ts", new TextEncoder().encode(readFileSync(scriptPath, "utf8")));
writeFileSync(outPath, await saveMap(loaded.chk, { extras, compress: "pkware", listfile: true }));
console.log(`${outPath}: ${extras.size + 1} members`);
