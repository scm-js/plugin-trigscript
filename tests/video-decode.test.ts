/**
 * The containers Import Video… takes apart for WebCodecs (`videoDecode.ts`): small files made by ffmpeg in each, the
 * video track read back — the codec string, the size, every frame and the time it is shown. H.264 with B-frames has
 * its frames stored out of the order they are shown, which is where an MP4's composition offsets and edit list
 * matter. Skipped where ffmpeg is not installed (the files are made on the spot, never committed).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { demux } from "../videoDecode";

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const has = (encoder: string) => ffmpeg && spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes(` ${encoder} `);
const dir = ffmpeg ? mkdtempSync(join(tmpdir(), "trigscript-video-")) : "";
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Two seconds of ffmpeg's test picture, 64 × 48 at 30 frames a second, in `file` with these encoder settings. */
function make(file: string, args: string[]): Uint8Array {
  const out = join(dir, file);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30:duration=2", ...args, out]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

const CASES: { file: string; encoder: string; args: string[]; codec: RegExp; description: boolean }[] = [
  { file: "h264.mp4", encoder: "libx264", args: ["-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p"], codec: /^avc1\.[0-9a-f]{6}$/, description: true },
  { file: "h264.mov", encoder: "libx264", args: ["-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p"], codec: /^avc1\./, description: true },
  { file: "h264.mkv", encoder: "libx264", args: ["-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p"], codec: /^avc1\./, description: true },
  { file: "hevc.mp4", encoder: "libx265", args: ["-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=none"], codec: /^hvc1\.\d/, description: true },
  { file: "vp8.webm", encoder: "libvpx", args: ["-c:v", "libvpx"], codec: /^vp8$/, description: false },
  { file: "vp9.webm", encoder: "libvpx-vp9", args: ["-c:v", "libvpx-vp9"], codec: /^vp09\./, description: false },
  { file: "av1.webm", encoder: "libaom-av1", args: ["-c:v", "libaom-av1", "-cpu-used", "8"], codec: /^av01\.0\.\d\dM\.08$/, description: true },
  { file: "av1.mp4", encoder: "libaom-av1", args: ["-c:v", "libaom-av1", "-cpu-used", "8"], codec: /^av01\.0\.\d\dM\.08$/, description: true },
];

describe.skipIf(!ffmpeg)("the video track of a file", () => {
  for (const c of CASES) {
    it.skipIf(!has(c.encoder))(`${c.file}: every frame, at the time it is shown`, () => {
      const d = demux(make(c.file, c.args))!;
      expect(d).not.toBeNull();
      expect(d.codec).toMatch(c.codec);
      expect(!!d.description).toBe(c.description);
      expect([d.width, d.height]).toEqual([64, 48]);
      expect(d.samples).toHaveLength(60);
      expect(d.samples[0].key).toBe(true);
      // Shown every 1/30 s from 0, whichever order they are stored in (Matroska keeps milliseconds).
      const times = d.samples.map((s) => s.time).sort((a, b) => a - b);
      times.forEach((t, i) => expect(Math.abs(t - (i * 1e6) / 30)).toBeLessThanOrEqual(1000));
      expect(d.end).toBeGreaterThanOrEqual(times[59]);
      for (const s of d.samples) expect(s.data.length).toBeGreaterThan(0);
    });
  }

  it("is null for what it does not read", () => {
    expect(demux(new Uint8Array(64))).toBeNull();
    expect(demux(new TextEncoder().encode("GIF89a…"))).toBeNull();
  });
});
