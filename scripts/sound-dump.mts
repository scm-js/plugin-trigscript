/**
 * The sounds a script's build puts in its map, written to a folder: each as the map gets it (Ogg Vorbis encoded, WAVs
 * as they are), under its own name. For listening outside the game and for comparing a recording of a probe with what
 * went in (`scripts/recording-check.mts`).
 *
 *   npx tsx scripts/sound-dump.mts probes/korobeiniki-form.ts out/            # every sound the build makes
 *   npx tsx scripts/sound-dump.mts probes/korobeiniki-band.ts out/ --append 'program(async () => { playWav(st.playthrough.ogg(5), 0); });'
 *   npx tsx scripts/sound-dump.mts probes/korobeiniki.ts out/ --check         # the names a check gives, no samples
 *
 * `--append` adds a line to the script first — a clip it does not play, made a sound of the build (the bars of a song
 * cut for the game, summed as the game plays them). `--raw` writes each Ogg's samples beside it as interleaved 32-bit
 * floats, before encoding.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { finishSounds, vorbisEncoder } from "../compiler/vorbis";
import { defaultLib } from "../bundle/lib.mjs";
import { scriptFiles } from "./script-files.mts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [scriptPath, outDir] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--append");
if (!scriptPath || !outDir) { console.error("usage: sound-dump <script.ts> <folder> [--append <line>] [--raw] [--check]"); process.exit(2); }
const files = scriptFiles(scriptPath);
const extra = value("--append");
if (extra) files["main.ts"] += `\n${extra}\n`;
const t0 = performance.now();
const r = compileScript(ts, files, defaultScriptNames(), { lib: defaultLib(), sounds: !flag("--check") });
for (const d of r.diagnostics) console.error(`${d.file}:${d.line}:${d.column} ${d.message}`);
if (r.diagnostics.length) process.exit(1);
console.log(`${flag("--check") ? "check" : "build"} ${(performance.now() - t0).toFixed(0)} ms, ${r.sounds.length} sounds`);
if (flag("--check")) { for (const s of r.sounds) console.log(s.path); process.exit(0); }
mkdirSync(outDir, { recursive: true });
if (flag("--raw")) for (const s of r.sounds) if (s.vorbis) {
  const [l, rr] = s.vorbis.channels, n = l.length, out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { out[2 * i] = l[i]; out[2 * i + 1] = (rr ?? l)[i]; }
  writeFileSync(join(outDir, `${s.path.split("\\").pop()}.f32`), new Uint8Array(out.buffer));
}
const t1 = performance.now();
finishSounds(r.sounds, vorbisEncoder(readFileSync(join(import.meta.dirname, "..", "node_modules", "wasm-media-encoders", "wasm", "ogg.wasm"))));
console.log(`encoded ${(performance.now() - t1).toFixed(0)} ms`);
let bytes = 0;
for (const s of r.sounds) { writeFileSync(join(outDir, s.path.split("\\").pop()!), s.bytes!); bytes += s.bytes!.length; }
console.log(`${r.sounds.length} files, ${(bytes / 1048576).toFixed(2)} MB in ${outDir}`);
