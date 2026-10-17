/**
 * A video into a `.video` file of a script (TrigScript 4, B8), under Node, as Import Video… does it in the editor:
 * the frames at the game's speed, scaled to so many tiles, each tile ink where it is lighter than the threshold.
 * For probes and for a person with ffmpeg; the editor decodes with the browser instead.
 *
 *   npx tsx scripts/import-video.mts <video> <out.video> [--size=128x96] [--threshold=128] [--frame-ms=42] [--dark]
 *
 * `--dark`: ink is where the video is darker than the threshold (for a dark figure on a light ground, drawn with
 * fog.picture's dark ink). Needs ffmpeg on the path.
 */
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { FASTEST_FRAME_MS, writeVideo } from "../compiler/media";

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [input, output] = args.filter((a) => !a.startsWith("--"));
if (!input || !output) { console.error("usage: import-video.mts <video> <out.video> [--size=128x96] [--threshold=128] [--frame-ms=42] [--dark]"); process.exit(2); }
const [width, height] = (flag("size") ?? "128x96").split("x").map(Number);
const threshold = Number(flag("threshold") ?? 128), frameMs = Number(flag("frame-ms") ?? FASTEST_FRAME_MS), dark = args.includes("--dark");

const t0 = Date.now();
const r = spawnSync("ffmpeg", ["-v", "error", "-i", input, "-vf", `fps=1000/${frameMs},scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const raw = r.stdout as Buffer, n = width * height, count = Math.floor(raw.length / n);
const frames: Uint8Array[] = [];
for (let k = 0; k < count; k++) {
  const f = new Uint8Array(n);
  for (let i = 0; i < n; i++) f[i] = (raw[k * n + i] >= threshold) !== dark ? 1 : 0;
  frames.push(f);
}
const text = writeVideo({ width, height, frameMs, frames, source: basename(input) });
writeFileSync(output, text);
console.log(`${count} frames of ${width} × ${height}, ${frameMs} ms each (${((count * frameMs) / 1000).toFixed(1)} s): ${(text.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
