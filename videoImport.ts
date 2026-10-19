/**
 * Import Video… and the video viewer (TrigScript 4, B8). A video the person picks is decoded here, in the browser,
 * once: scaled to so many tiles, a frame for every frame of the game, each tile ink where it is lighter (or darker)
 * than the threshold — and written as a `.video` file of the script (`compiler/media.ts`), which the build reads the
 * same on every computer. A picture becomes an `.image` file — its pixels, in colour or grey, which the script works
 * on when it is built (`compiler/image.ts`) — or a `.ts` file of rows of text, `#` its ink, which `fog.picture` takes
 * and a person can edit.
 *
 * A frame of the game is the video's frame nearest its time, as ffmpeg's fps filter picks it. Decoding takes the
 * file apart and hands its frames to WebCodecs (`videoDecode.ts`): every frame, with its own time, at the decoder's
 * speed. Where that cannot be done (another container, no WebCodecs), the video plays through, muted, each frame the
 * browser shows taken with its time, and the frames it did not show are fetched by seeking, exact but slow.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { Translate } from "./i18n";
import { FASTEST_FRAME_MS, readVideo, writeVideo, type VideoData } from "./compiler/media";
import { makeImage, MAX_IMAGE_SIDE, readImage, writeImage, type ImageData } from "./compiler/image";
import { cover, covers, prepareShapes } from "./compiler/cover";
import { FOG_SHAPES } from "./compiler/fogShapes";
import { decodeTrack, demux } from "./videoDecode";

/** A picture or a video the person picked, ready to be drawn at a size. */
interface Source {
  kind: "image" | "video";
  name: string;
  width: number;
  height: number;
  /** Seconds; 0 for an image. */
  duration: number;
  /** The file it was opened from (a video's: `decodeAll` reads it again for WebCodecs). */
  file?: File;
  /** The picture at a time (seconds), drawn into `ctx` at w × h and averaged down: a byte of grey a tile. */
  grey(time: number, w: number, h: number): Promise<Uint8Array>;
  /** A picture's pixels at w × h, four bytes each (red, green, blue, alpha), averaged down the same way. */
  rgba?(w: number, h: number): Promise<Uint8Array>;
  close(): void;
}

/** Each tile the average of the k × k pixels over it (k up to 8): what ffmpeg's "area" scaling does. */
function areaGrey(image: CanvasImageSource, sw: number, sh: number, w: number, h: number, canvas: HTMLCanvasElement): Uint8Array {
  const k = Math.max(1, Math.min(8, Math.floor(Math.min(sw / w, sh / h))));
  canvas.width = w * k;
  canvas.height = h * k;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, w * k, h * k);
  const px = ctx.getImageData(0, 0, w * k, h * k).data;
  const out = new Uint8Array(w * h), row = w * k * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = (y * k + dy) * row + (x * k + dx) * 4;
      sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    out[y * w + x] = Math.round(sum / (k * k));
  }
  return out;
}

/** As `areaGrey`, each pixel's red, green, blue and alpha: colour averaged by how opaque it is, so no edge darkens. */
function areaRgba(image: CanvasImageSource, sw: number, sh: number, w: number, h: number, canvas: HTMLCanvasElement): Uint8Array {
  const k = Math.max(1, Math.min(8, Math.floor(Math.min(sw / w, sh / h))));
  canvas.width = w * k;
  canvas.height = h * k;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w * k, h * k);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, w * k, h * k);
  const px = ctx.getImageData(0, 0, w * k, h * k).data;
  const out = new Uint8Array(w * h * 4), row = w * k * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = (y * k + dy) * row + (x * k + dx) * 4, o = px[i + 3];
      r += px[i] * o; g += px[i + 1] * o; b += px[i + 2] * o; a += o;
    }
    const o = (y * w + x) * 4;
    out[o] = a ? Math.round(r / a) : 0; out[o + 1] = a ? Math.round(g / a) : 0; out[o + 2] = a ? Math.round(b / a) : 0;
    out[o + 3] = Math.round(a / (k * k));
  }
  return out;
}

async function openSource(file: File): Promise<Source> {
  const canvas = document.createElement("canvas");
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file);
    return {
      kind: "image", name: file.name, width: bitmap.width, height: bitmap.height, duration: 0,
      grey: async (_t, w, h) => areaGrey(bitmap, bitmap.width, bitmap.height, w, h, canvas),
      rgba: async (w, h) => areaRgba(bitmap, bitmap.width, bitmap.height, w, h, canvas),
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((done, fail) => {
    video.onloadeddata = () => done();
    video.onerror = () => fail(new Error(video.error?.message || "the browser cannot play this file"));
  });
  const seek = (time: number) => new Promise<void>((done) => {
    if (Math.abs(video.currentTime - time) < 1e-4) { done(); return; }
    video.onseeked = () => done();
    video.currentTime = time;
  });
  return {
    kind: "video", name: file.name, width: video.videoWidth, height: video.videoHeight, duration: video.duration, file,
    grey: async (time, w, h) => { await seek(Math.min(time, Math.max(0, video.duration - 0.001))); return areaGrey(video, video.videoWidth, video.videoHeight, w, h, canvas); },
    close: () => { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); },
    // (The whole video is read by `decodeAll`, which plays it.)
    ...{ element: video, canvas },
  } as Source;
}

/** Every frame of the game's in a video, in tiles of grey: from the file through WebCodecs where it can be, else played. */
async function decodeAll(src: Source, w: number, h: number, frameMs: number, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array[]> {
  return (await decodeFile(src, w, h, frameMs, onProgress, signal)) ?? decodePlaying(src, w, h, frameMs, onProgress, signal);
}

/**
 * The fast way, where the browser has WebCodecs and the file is a container `videoDecode.ts` reads: every frame
 * decoded with its own time, each sample given the nearest. Null when it cannot be done this way.
 */
async function decodeFile(src: Source, w: number, h: number, frameMs: number, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array[] | null> {
  if (!src.file) return null;
  const track = demux(new Uint8Array(await src.file.arrayBuffer()));
  if (!track) return null;
  const { canvas } = src as Source & { canvas: HTMLCanvasElement };
  const total = Math.max(1, Math.floor(Math.max(src.duration * 1000, track.end / 1000) / frameMs));
  const frames: Uint8Array[] = new Array(total);
  // The frame before, kept until the next one says which samples between them are whose.
  let before: { t: number; grey: Uint8Array } | null = null, next = 0;
  const done = await decodeTrack(track, (frame) => {
    let grey: Uint8Array, t: number;
    try { t = frame.timestamp / 1000; grey = areaGrey(frame, frame.displayWidth, frame.displayHeight, w, h, canvas); } finally { frame.close(); }
    for (; next < total && next * frameMs < t; next++) frames[next] = before && next * frameMs - before.t <= t - next * frameMs ? before.grey : grey;
    before = { t, grey };
    onProgress(next, total);
  }, signal);
  if (!done || !before) return null;
  for (; next < total; next++) frames[next] = (before as { grey: Uint8Array }).grey;
  return frames;
}

/**
 * The way that works wherever a `<video>` plays, for each multiple of `frameMs` the video's own frame nearest that
 * time. The video plays through, muted, and each frame the browser shows is taken with its own time and length
 * (WebCodecs' `VideoFrame`): it is the answer for every sample within half its length of its time. A busy browser shows only some frames, and `mediaTime` then names an earlier one than the
 * element holds by the time it is drawn, so neither the gaps between frames shown nor that time can be trusted;
 * the frame's own can. Samples no frame shown answered are fetched afterwards by seeking (exact, 66 ms each for Bad
 * Apple's AV1 in Chromium); playing slows down while too many are left for that.
 */
async function decodePlaying(src: Source, w: number, h: number, frameMs: number, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array[]> {
  const { element: video, canvas } = src as Source & { element: HTMLVideoElement; canvas: HTMLCanvasElement };
  const total = Math.max(1, Math.floor((src.duration * 1000) / frameMs));
  const frames: Uint8Array[] = new Array(total);
  const answered = new Uint8Array(total);
  const stop = () => { if (signal.aborted) throw new DOMException("cancelled", "AbortError"); };
  type Frame = CanvasImageSource & { timestamp: number; duration: number | null; displayWidth: number; displayHeight: number; close(): void };
  const VideoFrameOf = (globalThis as { VideoFrame?: new (source: HTMLVideoElement) => Frame }).VideoFrame;
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback?.bind(video);
  // The video's own frame length, from the frames themselves; until one says, 1/30 s.
  let length = 1000 / 30;
  if (rvfc && VideoFrameOf) {
    await src.grey(0, w, h);
    video.playbackRate = 2;
    await new Promise<void>((done, fail) => {
      let window = 0, missed = 0, next = 0;
      const onFrame = () => {
        if (signal.aborted) { video.pause(); fail(new DOMException("cancelled", "AbortError")); return; }
        const frame = new VideoFrameOf(video);
        let t: number, grey: Uint8Array;
        try {
          t = frame.timestamp / 1000;
          if (frame.duration) length = frame.duration / 1000;
          grey = areaGrey(frame, frame.displayWidth, frame.displayHeight, w, h, canvas);
        } finally { frame.close(); }
        // The samples nearest this frame: within half its length of its time (on a tie, the later frame).
        for (let i = Math.max(0, Math.ceil((t - length / 2) / frameMs)); i < total && i * frameMs < t + length / 2; i++) { frames[i] = grey; answered[i] = 1; }
        // Those it went past without an answer are left for seeking; too many of them, and the video slows down.
        const reached = Math.min(total, Math.floor(t / frameMs));
        for (; next < reached; next++) { window++; if (!answered[next]) missed++; }
        if (window >= 48) {
          if (missed > window / 10 && video.playbackRate > 0.25) video.playbackRate /= 2;
          window = 0;
          missed = 0;
        }
        onProgress(reached, total);
        rvfc(onFrame);
      };
      video.onended = () => done();
      rvfc(onFrame);
      video.play().catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
    });
    video.pause();
  }
  // What playing did not answer: the frame nearest each such time, by seeking half a frame past it (the frame shown at
  // a time is the last that started by then).
  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!answered[i]) missing.push(i);
  for (const [n, i] of missing.entries()) {
    stop();
    frames[i] = await src.grey((i * frameMs + length / 2 - 0.5) / 1000, w, h);
    onProgress(total - missing.length + n + 1, total);
  }
  return frames;
}

const ink = (grey: Uint8Array, threshold: number, dark: boolean): Uint8Array => {
  const out = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) out[i] = (grey[i] >= threshold) !== dark ? 1 : 0;
  return out;
};

/** Ink as the fog shows it: lit tiles light, the rest the grey of fog. */
function paint(canvas: HTMLCanvasElement, tiles: Uint8Array, w: number, h: number, mark?: Uint8Array): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const lit = tiles[i] === 1, off = mark && mark[i] !== tiles[i];
    const v = lit ? 236 : 70;
    img.data[i * 4] = off ? 230 : v;
    img.data[i * 4 + 1] = off ? (lit ? 120 : 90) : v;
    img.data[i * 4 + 2] = off ? (lit ? 120 : 90) : v + 6;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Pixels as they are, in colour or in grey; what is transparent shows the preview's own dark. */
function paintPixels(canvas: HTMLCanvasElement, rgba: Uint8Array, w: number, h: number, grey = false): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  if (grey) for (let i = 0; i < rgba.length; i += 4) img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  ctx.putImageData(img, 0, 0);
}

const PREVIEW_STYLE = "image-rendering: pixelated; width: 100%; max-width: 512px; background: #222; display: block; margin: 0 auto 8px;";

/** "bad-apple" from "Bad Apple!! (PV).mp4": a file name the script can have. */
function fileStem(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "video";
}

/** An image as a file of the script: rows of text, `#` ink, that `fog.picture` takes. */
function imageModule(rows: string[], from: string): string {
  return `// ${from}, imported as rows of tiles: # is ink. fog.picture(…) draws it: import heart from "./heart";\n` +
    `export default [\n${rows.map((r) => `  ${JSON.stringify(r)},`).join("\n")}\n] as const;\n`;
}

/** What an import made: a `.video`, an `.image`, or a `.ts` of a picture's rows. */
export interface ImportedFile { path: string; text: string; kind: "video" | "image" | "rows" }

/**
 * Import Video…: pick a video or an image, choose the size (and, for ink, the threshold) over a preview, and get the
 * script file it becomes — or null when the person cancelled. `taken` says whether a path is in use.
 */
export async function importMedia(api: PluginApi, t: Translate, options: { mapWidth: number; mapHeight: number; taken: (path: string) => boolean; file?: File }): Promise<ImportedFile | null> {
  const file = options.file ?? (await api.ui.pickFiles({ accept: "video/*,image/*,.mkv,.webm,.mp4,.mov,.gif" }))[0];
  if (!file) return null;
  let src: Source;
  try { src = await openSource(file); } catch (err) {
    await api.ui.alert(t("{name} could not be opened: {message}", { name: file.name, message: (err as Error).message }));
    return null;
  }
  const w = api.ui.widgets, el = api.ui.el;
  // A picture is kept as pixels — in colour, or in grey — or as rows of ink to edit; a video is always ink.
  type Keep = "color" | "grey" | "rows";
  let keep: Keep = src.kind === "image" ? "color" : "rows";
  const pixels = () => keep !== "rows";
  const fit = (mw: number) => Math.max(1, Math.min(pixels() ? MAX_IMAGE_SIDE : 256, Math.round(mw)));
  // Ink: the map's width, the height its shape gives — no taller than the map. Pixels: the picture's own size, no
  // more than 256 the longer way (a script scales it as it likes).
  const shrink = Math.min(1, 256 / Math.max(src.width, src.height, 1));
  const defaultWidth = () => (pixels() ? fit(src.width * shrink) : fit(Math.min(options.mapWidth, 256)));
  const defaultHeight = (w: number) => (pixels() ? fit(src.height * shrink) : fit(Math.min(options.mapHeight, (w * src.height) / Math.max(1, src.width))));
  let width = defaultWidth();
  let height = defaultHeight(width);
  let threshold = 128, dark = false, at = 0;
  let grey: Uint8Array | null = null, rgba: Uint8Array | null = null;
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", PREVIEW_STYLE);
  const about = w.hint("");
  const status = w.hint("");
  const progress = w.progressBar();
  progress.style.display = "none";
  const stem = fileStem(src.name);
  const extension = () => (src.kind === "video" ? ".video" : pixels() ? ".image" : ".ts");
  const name = w.text({ value: `${stem}${extension()}` });
  const frames = () => Math.max(1, Math.floor((src.duration * 1000) / FASTEST_FRAME_MS));
  const say = () => {
    const seconds = Math.round(src.duration);
    about.textContent = src.kind === "video"
      ? t("{w} × {h} tiles, {n} frames at the game's speed on Fastest ({time}).", { w: width, h: height, n: frames().toLocaleString(), time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` })
      : pixels() ? t("{w} × {h} pixels, a tile each when the fog draws them.", { w: width, h: height }) : t("{w} × {h} tiles.", { w: width, h: height });
  };
  const redraw = () => {
    if (pixels()) { if (rgba) paintPixels(canvas, rgba, width, height, keep === "grey"); }
    else if (grey) paint(canvas, ink(grey, threshold, dark), width, height);
  };
  let pending = 0;
  const refresh = async () => {
    const mine = ++pending;
    if (pixels()) {
      const got = await src.rgba!(width, height);
      if (mine !== pending) return;
      rgba = got;
    } else {
      const g = await src.grey(at, width, height);
      if (mine !== pending) return;
      grey = g;
    }
    redraw();
    say();
  };
  const sizeField = (value: number, set: (n: number) => void) => w.number({ value, min: 1, max: pixels() ? MAX_IMAGE_SIDE : 256, step: 1, onChange: (v) => { set(fit(v)); void refresh(); } });
  const slider = (min: number, max: number, value: number, step: number, onInput: (v: number) => void) => {
    const input = el("input", { type: "range" }) as HTMLInputElement;
    Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
    input.style.width = "100%";
    input.addEventListener("input", () => onInput(Number(input.value)));
    return input;
  };
  const across = sizeField(width, (n) => { width = n; }), down = sizeField(height, (n) => { height = n; });
  const inkForm = w.form([
    { label: t("Threshold"), field: slider(1, 255, threshold, 1, (v) => { threshold = v; redraw(); }) },
    { label: t("Ink"), field: w.select([{ value: "light", label: t("Light parts") }, { value: "dark", label: t("Dark parts") }], { value: "light", onChange: (v) => { dark = v === "dark"; redraw(); } }) },
  ]);
  const explain = w.hint("");
  // What the choice of keeping shows: the ink's fields for ink, and what each kind of file is for.
  const shown = () => {
    inkForm.style.display = pixels() ? "none" : "";
    across.max = down.max = String(pixels() ? MAX_IMAGE_SIDE : 256);
    explain.textContent = src.kind === "video"
      ? t("Light tiles are the ink: what fog.light lights. A video's frames are taken at the game's speed on Fastest, a frame of it each frame of the game.")
      : pixels()
        ? t("The pixels are kept for the script to work on when it is built — crop, scale, flip, threshold — and draw: fog.picture(logo.threshold(128)).")
        : t("Light tiles are the ink: what fog.light lights. The rows are a .ts file to edit, which fog.picture takes.");
  };
  const keepField = w.select([
    { value: "color", label: t("Pixels in colour (.image)") },
    { value: "grey", label: t("Pixels in grey (.image)") },
    { value: "rows", label: t("Rows of ink to edit (.ts)") },
  ], { value: keep, onChange: (v) => {
    keep = v as Keep;
    width = defaultWidth();
    height = defaultHeight(width);
    across.value = String(width);
    down.value = String(height);
    name.value = name.value.replace(/\.(?:image|ts)$/i, "") + extension();
    shown();
    void refresh();
  } });
  shown();
  const controller = new AbortController();
  let result: ImportedFile | null = null;
  await new Promise<void>((closed) => {
    api.ui.dialog({
      title: src.kind === "video" ? t("Import Video") : t("Import Image"),
      size: "md",
      mount(body) {
        body.append(
          canvas,
          ...(src.kind === "video" ? [w.form([{ label: t("Frame"), field: slider(0, Math.max(0, src.duration - 0.05), 0, 0.01, (v) => { at = v; void refresh(); }) }])] : []),
          ...(src.kind === "image" ? [w.form([{ label: t("Keep as"), field: keepField }])] : []),
          w.form([
            { label: t("Tiles across"), field: across },
            { label: t("Tiles down"), field: down },
          ]),
          inkForm,
          w.form([{ label: t("File"), field: name }]),
          about,
          explain,
          progress,
          status,
        );
        void refresh();
        return () => { controller.abort(); src.close(); closed(); };
      },
      buttons: [
        { label: t("Cancel") },
        {
          label: t("Import"), primary: true,
          run: async () => {
            let path = name.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
            const ext = extension();
            if (!path.toLowerCase().endsWith(ext)) path += ext;
            if (!/^[A-Za-z0-9_\-./]+$/.test(path) || path.split("/").some((p) => p === "." || p === ".." || p === "")) { status.textContent = t("A file name is letters, digits, _ - and ., folders with /."); return false; }
            if (options.taken(path)) { status.textContent = t("There is already a {name}.", { name: path }); return false; }
            if (src.kind === "image" && pixels()) {
              result = { path, text: writeImage({ width, height, rgba: await src.rgba!(width, height), grey: keep === "grey", source: src.name }), kind: "image" };
              return true;
            }
            if (src.kind === "image") {
              const g = await src.grey(0, width, height), tiles = ink(g, threshold, dark);
              const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (tiles[y * width + x] ? "#" : ".")).join(""));
              result = { path, text: imageModule(rows, src.name), kind: "rows" };
              return true;
            }
            progress.style.display = "";
            const t0 = performance.now();
            try {
              const greys = await decodeAll(src, width, height, FASTEST_FRAME_MS, (done, total) => {
                progress.set(done / total);
                status.textContent = t("Decoding: frame {done} of {total}…", { done: done.toLocaleString(), total: total.toLocaleString() });
              }, controller.signal);
              const text = writeVideo({ width, height, frameMs: FASTEST_FRAME_MS, frames: greys.map((g) => ink(g, threshold, dark)), source: src.name });
              result = { path, text, kind: "video" };
              status.textContent = t("{n} frames in {seconds} s, {kb} KB.", { n: greys.length.toLocaleString(), seconds: ((performance.now() - t0) / 1000).toFixed(0), kb: Math.round(text.length / 1024).toLocaleString() });
              return true;
            } catch (err) {
              if ((err as Error).name === "AbortError") return true;
              status.textContent = t("Not imported: {message}", { message: (err as Error).message });
              progress.style.display = "none";
              return false;
            }
          },
        },
      ],
    });
  });
  return result;
}

/**
 * A `.video` file of the script, shown: its frames played or scrubbed, as the tiles it holds or as the fog would light
 * them (the brushes `fog.light` makes, the tiles off the video marked red), with how many brushes a frame takes.
 */
export function showVideo(api: PluginApi, t: Translate, path: string, text: string): void {
  let video: VideoData;
  try { video = readVideo(text); } catch (err) { void api.ui.alert(`${path}: ${(err as Error).message}`); return; }
  const w = api.ui.widgets, el = api.ui.el;
  const shapes = prepareShapes(FOG_SHAPES);
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", PREVIEW_STYLE);
  const info = w.hint("");
  let frame = 0, asFog = false, timer: number | null = null;
  const scrub = el("input", { type: "range" }) as HTMLInputElement;
  Object.assign(scrub, { min: "0", max: String(Math.max(0, video.length - 1)), step: "1", value: "0" });
  scrub.style.width = "100%";
  const draw = () => {
    const tiles = video.tiles(frame);
    let said = t("Frame {n} of {total}", { n: (frame + 1).toLocaleString(), total: video.length.toLocaleString() });
    if (asFog) {
      const brushes = cover(tiles, video.width, video.height, shapes);
      paint(canvas, covers(brushes, video.width, video.height, shapes), video.width, video.height, tiles);
      said += ` · ${t("{n} brushes", { n: brushes.length })}`;
    } else paint(canvas, tiles, video.width, video.height);
    info.textContent = said;
    scrub.value = String(frame);
  };
  scrub.addEventListener("input", () => { frame = Number(scrub.value); draw(); });
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const playButton = w.button(t("Play"), { onClick: () => {
    if (timer !== null) { stop(); playButton.textContent = t("Play"); return; }
    playButton.textContent = t("Pause");
    timer = window.setInterval(() => { frame = (frame + 1) % Math.max(1, video.length); draw(); }, video.frameMs);
  } });
  const seconds = Math.round((video.length * video.frameMs) / 1000);
  api.ui.dialog({
    title: path,
    size: "md",
    mount(body) {
      body.append(
        canvas,
        scrub,
        w.row(playButton, w.select([{ value: "tiles", label: t("The video") }, { value: "fog", label: t("As the fog draws it") }], { value: "tiles", onChange: (v) => { asFog = v === "fog"; draw(); } })),
        info,
        w.hint(t("{w} × {h} tiles, {n} frames of {ms} ms ({time}){from}. Import it with import name from \"./{file}\".", {
          w: video.width, h: video.height, n: video.length.toLocaleString(), ms: video.frameMs, time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
          from: video.source ? ` · ${video.source}` : "", file: path.split("/").pop() ?? path,
        })),
      );
      draw();
      return stop;
    },
  });
}

/**
 * An `.image` file of the script, shown: its pixels, or what `threshold` or `halftone` makes of them as the fog would
 * light it (the brushes `fog.light` makes, the tiles off the picture marked red), with the line that makes it — the
 * same `Image` the build has (`compiler/image.ts`), so what is seen here is what the script gets.
 */
export function showImage(api: PluginApi, t: Translate, path: string, text: string): void {
  let data: ImageData;
  try { data = readImage(text); } catch (err) { void api.ui.alert(`${path}: ${(err as Error).message}`); return; }
  const image = makeImage(data);
  const w = api.ui.widgets, el = api.ui.el;
  const shapes = prepareShapes(FOG_SHAPES);
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", PREVIEW_STYLE);
  const info = w.hint("");
  const stem = (path.split("/").pop() ?? path).replace(/\.image$/i, "");
  const name = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_]+/, "") || "image";
  let view = "pixels", level = 128, dark = false;
  const levelField = el("input", { type: "range" }) as HTMLInputElement;
  Object.assign(levelField, { min: "1", max: "255", step: "1", value: String(level) });
  levelField.style.width = "100%";
  const draw = () => {
    levelField.disabled = view !== "threshold";
    inkField.disabled = view !== "threshold";
    if (view === "pixels") { paintPixels(canvas, data.rgba, data.width, data.height); info.textContent = ""; return; }
    const ink = dark ? `{ ink: "dark" }` : "";
    const cell = Number(view.replace("halftone", ""));
    const rows = cell ? image.halftone(cell) : image.threshold(level, { ink: dark ? "dark" : "light" });
    const call = cell ? `${name}.halftone(${cell})` : `${name}.threshold(${level}${ink ? `, ${ink}` : ""})`;
    const tiles = Uint8Array.from(rows.join(""), (c) => (c === "#" ? 1 : 0));
    // A halftone carries the brushes that drew it, which fog.picture draws as they are.
    const brushes = cell ? (rows as unknown as { brushes: { x: number; y: number; shape: number }[] }).brushes : cover(tiles, data.width, data.height, shapes);
    paint(canvas, covers(brushes, data.width, data.height, shapes), data.width, data.height, tiles);
    info.textContent = `fog.picture(${call}) · ${t("{n} brushes", { n: brushes.length })}`;
  };
  levelField.addEventListener("input", () => { level = Number(levelField.value); draw(); });
  const inkField = w.select([{ value: "light", label: t("Light parts") }, { value: "dark", label: t("Dark parts") }], { value: "light", onChange: (v) => { dark = v === "dark"; draw(); } });
  api.ui.dialog({
    title: path,
    size: "md",
    mount(body) {
      body.append(
        canvas,
        w.form([
          { label: t("Show"), field: w.select([{ value: "pixels", label: t("The image") }, { value: "threshold", label: t("Threshold, as the fog draws it") }, ...[4, 6, 8].map((c) => ({ value: `halftone${c}`, label: t("Halftone, {w} × {h} cells, as the fog draws it", { w: c, h: c + 1 }) }))], { value: view, onChange: (v) => { view = v; draw(); } }) },
          { label: t("Threshold"), field: levelField },
          { label: t("Ink"), field: inkField },
        ]),
        info,
        w.hint(t("{w} × {h} pixels{from}. Import it with import {name} from \"./{file}\".", { w: data.width, h: data.height, from: data.source ? ` · ${data.source}` : "", name, file: path.split("/").pop() ?? path })),
      );
      draw();
    },
  });
}
