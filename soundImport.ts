/**
 * Import Video… for a sound, and the sound viewer. A sound file the person picks — anything the browser decodes: WAV,
 * MP3, Ogg, FLAC, AAC — is decoded here once, mixed to mono at the rate chosen, and written as a `.sound` file of the
 * script (`compiler/sound.ts`), which the build reads the same on every computer. Clicking a `.sound` shows its
 * waveform and plays it.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { Translate } from "./i18n";
import { readSound, writeSound, type SoundData } from "./compiler/sound";

/** What the import can decode: the browser's types, and the extensions a file picker may not type. */
export const SOUND_FILES = "audio/*,.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.opus";
export const isSoundSource = (f: File): boolean => f.type.startsWith("audio/") || /\.(wav|mp3|ogg|oga|flac|m4a|aac|opus)$/i.test(f.name);

/** The file decoded and mixed to mono at `rate`, through the browser's own decoder and resampler. */
async function decode(file: File, rate: number): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
  const frames = Math.max(1, Math.ceil(buffer.duration * rate));
  // An offline render at the rate wanted, one channel: the browser resamples, and mixes the channels down.
  const ctx = new OfflineAudioContext(1, frames, rate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  return (await ctx.startRendering()).getChannelData(0).slice();
}

/** Samples drawn as a waveform: each column the lowest and highest sample under it. */
function drawWave(canvas: HTMLCanvasElement, samples: Float32Array, mark = -1): void {
  const w = (canvas.width = 512), h = (canvas.height = 96), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#9cc8ff";
  const per = samples.length / w;
  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) { lo = Math.min(lo, samples[i]); hi = Math.max(hi, samples[i]); }
    ctx.fillRect(x, (h / 2) * (1 - Math.min(1, hi)), 1, Math.max(1, (h / 2) * (Math.min(1, hi) - Math.max(-1, lo))));
  }
  if (mark >= 0) { ctx.fillStyle = "#ffd75e"; ctx.fillRect(Math.round(mark * w), 0, 1, h); }
}

const WAVE_STYLE = "width: 100%; max-width: 512px; height: 96px; display: block; margin: 0 auto 8px; background: #222;";

/** A player for samples: play from the start, or stop; the waveform's mark follows. */
function player(samples: Float32Array, rate: number, canvas: HTMLCanvasElement) {
  let ctx: AudioContext | null = null, source: AudioBufferSourceNode | null = null, raf = 0;
  const stop = () => { source?.stop(); source = null; cancelAnimationFrame(raf); drawWave(canvas, samples); };
  const play = () => {
    stop();
    ctx ??= new AudioContext();
    const buffer = ctx.createBuffer(1, Math.max(1, samples.length), rate);
    buffer.copyToChannel(Float32Array.from(samples), 0);
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const started = ctx.currentTime, mine = source;
    source.onended = () => { if (source === mine) stop(); };
    source.start();
    const tick = () => { if (!ctx || source !== mine) return; drawWave(canvas, samples, (ctx.currentTime - started) / buffer.duration); raf = requestAnimationFrame(tick); };
    tick();
  };
  return { play, stop, close: () => { stop(); void ctx?.close(); } };
}

/**
 * Import a sound: the rate to keep it at, the name, a listen; the `.sound` file it becomes, or null when the person
 * cancelled. `taken` says whether a path is in use.
 */
export async function importSound(api: PluginApi, t: Translate, file: File, taken: (path: string) => boolean, stem: string): Promise<{ path: string; text: string } | null> {
  const w = api.ui.widgets, el = api.ui.el;
  let rate = 22050, samples: Float32Array;
  try { samples = await decode(file, rate); } catch (err) {
    await api.ui.alert(t("{name} could not be opened: {message}", { name: file.name, message: (err as Error).message }));
    return null;
  }
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", WAVE_STYLE);
  const about = w.hint(""), status = w.hint("");
  const name = w.text({ value: `${stem}.sound` });
  let play = player(samples, rate, canvas);
  const say = () => {
    const kb = Math.round((samples.length / 2 / 1024) * 1.4);
    about.textContent = t("{seconds} seconds at {rate} Hz, about {kb} KB in the map.", { seconds: (samples.length / rate).toFixed(2), rate: rate.toLocaleString(), kb: kb.toLocaleString() });
  };
  const rateField = w.select([
    { value: "11025", label: t("11 kHz (smallest)") },
    { value: "22050", label: t("22 kHz") },
    { value: "44100", label: t("44 kHz (largest)") },
  ], { value: String(rate), onChange: (v) => {
    void (async () => {
      rate = Number(v);
      play.close();
      samples = await decode(file, rate);
      play = player(samples, rate, canvas);
      drawWave(canvas, samples);
      say();
    })();
  } });
  let result: { path: string; text: string } | null = null;
  await new Promise<void>((closed) => {
    api.ui.dialog({
      title: t("Import Sound"),
      size: "md",
      mount(body) {
        body.append(
          canvas,
          w.row(w.button(t("Play"), { onClick: () => play.play() }), w.button(t("Stop"), { onClick: () => play.stop() })),
          w.form([{ label: t("Rate"), field: rateField }, { label: t("File"), field: name }]),
          about,
          w.hint(t("Kept in mono, as the game's own sounds are. A program plays it with playWav(); clips made from it — trim, gain, pitch — are made when the script is built.")),
          status,
        );
        drawWave(canvas, samples);
        say();
        return () => { play.close(); closed(); };
      },
      buttons: [
        { label: t("Cancel") },
        {
          label: t("Import"), primary: true,
          run: () => {
            let path = name.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
            if (!path.toLowerCase().endsWith(".sound")) path += ".sound";
            if (!/^[A-Za-z0-9_\-./]+$/.test(path) || path.split("/").some((p) => p === "." || p === ".." || p === "")) { status.textContent = t("A file name is letters, digits, _ - and ., folders with /."); return false; }
            if (taken(path)) { status.textContent = t("There is already a {name}.", { name: path }); return false; }
            try { result = { path, text: writeSound({ rate, samples, source: file.name }) }; } catch (err) { status.textContent = t("Not imported: {message}", { message: (err as Error).message }); return false; }
            return true;
          },
        },
      ],
    });
  });
  return result;
}

/** A `.sound` file of the script, shown: its waveform, played, and how a script imports it. */
export function showSound(api: PluginApi, t: Translate, path: string, text: string): void {
  let data: SoundData;
  try { data = readSound(text); } catch (err) { void api.ui.alert(`${path}: ${(err as Error).message}`); return; }
  const w = api.ui.widgets, el = api.ui.el;
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", WAVE_STYLE);
  const play = player(data.samples, data.rate, canvas);
  const stem = (path.split("/").pop() ?? path).replace(/\.sound$/i, "");
  const name = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_]+/, "") || "sound";
  api.ui.dialog({
    title: path,
    size: "md",
    mount(body) {
      body.append(
        canvas,
        w.row(w.button(t("Play"), { onClick: () => play.play() }), w.button(t("Stop"), { onClick: () => play.stop() })),
        w.hint(t("{seconds} seconds at {rate} Hz{from}. Import it with import {name} from \"./{file}\", play it with playWav({name}).", { seconds: (data.frames / data.rate).toFixed(2), rate: data.rate.toLocaleString(), from: data.source ? ` · ${data.source}` : "", name, file: path.split("/").pop() ?? path })),
      );
      drawWave(canvas, data.samples);
      return () => play.close();
    },
  });
}
