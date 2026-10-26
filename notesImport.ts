/**
 * Import Video… for a MIDI file, and the notes viewer. A `.mid` the person picks is read here once and written as a
 * `.notes` file of the script (`compiler/notes.ts`), which the build reads the same on every computer; `music.midi`
 * makes a song of it. Clicking a `.notes` shows its notes on a roll, a colour a track, and plays them roughly — a
 * sine a note — to hear that they are the right ones.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { Translate } from "./i18n";
import { readMidi, readNotes, writeNotes, type NotesData } from "./compiler/notes";

export const MIDI_FILES = ".mid,.midi,audio/midi,audio/x-midi";
export const isMidiSource = (f: File): boolean => /\.midi?$/i.test(f.name) || f.type === "audio/midi" || f.type === "audio/x-midi";

const COLORS = ["#9cc8ff", "#ffd75e", "#8ee08e", "#ff9c9c", "#d4a8ff", "#7fe0d8", "#ffb86b", "#c8c8c8"];
const ROLL_STYLE = "width: 100%; max-width: 640px; height: 160px; display: block; margin: 0 auto 8px; background: #222;";

/** The notes on a roll: time across, pitch up, a colour a track (those `shown` says), a mark at `mark` beats. */
function drawRoll(canvas: HTMLCanvasElement, data: NotesData, shown: (k: number) => boolean, mark = -1): void {
  const w = (canvas.width = 640), h = (canvas.height = 160), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, w, h);
  const all = data.tracks.flatMap((t, k) => (shown(k) ? t.notes : []));
  if (all.length === 0) return;
  const end = Math.max(...all.map((n) => n.at + n.beats)), lo = Math.min(...all.map((n) => n.pitch)), hi = Math.max(...all.map((n) => n.pitch));
  const x = (beat: number) => (beat / end) * w, row = h / (hi - lo + 1);
  data.tracks.forEach((t, k) => {
    if (!shown(k)) return;
    ctx.fillStyle = COLORS[k % COLORS.length];
    for (const n of t.notes) ctx.fillRect(x(n.at), h - (n.pitch - lo + 1) * row, Math.max(1, x(n.beats) - 0.5), Math.max(1, row - 0.5));
  });
  if (mark >= 0) { ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(x(mark)), 0, 1, h); }
}

/** A rough player: each note a sine with a short fade, the drums a click; the roll's mark follows. */
function player(data: NotesData, shown: (k: number) => boolean, canvas: HTMLCanvasElement) {
  let ctx: AudioContext | null = null, raf = 0, started = 0, playing = false;
  const spb = 60 / data.bpm;
  const stop = () => { playing = false; cancelAnimationFrame(raf); void ctx?.close(); ctx = null; drawRoll(canvas, data, shown); };
  const play = () => {
    stop();
    ctx = new AudioContext();
    const out = ctx.createGain();
    out.gain.value = 0.15;
    out.connect(ctx.destination);
    started = ctx.currentTime + 0.1;
    let last = 0;
    data.tracks.forEach((t, k) => {
      if (!shown(k)) return;
      for (const n of t.notes) {
        const at = started + n.at * spb, len = Math.max(0.03, Math.min(n.beats * spb, 4)), osc = ctx!.createOscillator(), g = ctx!.createGain();
        osc.type = t.channel === 10 ? "square" : "sine";
        osc.frequency.value = t.channel === 10 ? 80 + (n.pitch % 12) * 40 : 440 * 2 ** ((n.pitch - 69) / 12);
        const peak = (n.velocity / 127) * (t.channel === 10 ? 0.4 : 0.5), tail = t.channel === 10 ? 0.04 : len;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 0.005);
        g.gain.setValueAtTime(peak, at + Math.max(0.006, tail - 0.03));
        g.gain.linearRampToValueAtTime(0, at + tail);
        osc.connect(g).connect(out);
        osc.start(at);
        osc.stop(at + tail + 0.01);
        last = Math.max(last, n.at + n.beats);
      }
    });
    playing = true;
    const mine = ctx;
    const tick = () => {
      if (!playing || ctx !== mine) return;
      const beat = (mine.currentTime - started) / spb;
      if (beat > last) { stop(); return; }
      drawRoll(canvas, data, shown, Math.max(0, beat));
      raf = requestAnimationFrame(tick);
    };
    tick();
  };
  return { play, stop };
}

/** How the notes are described: tracks, notes, tempo, length. */
function about(t: Translate, data: NotesData): string {
  const n = data.tracks.reduce((s, tr) => s + tr.notes.length, 0);
  const end = Math.max(0, ...data.tracks.flatMap((tr) => tr.notes.map((x) => x.at + x.beats)));
  const seconds = Math.round((end * 60) / data.bpm);
  return t("{tracks} tracks, {notes} notes, {bpm} beats a minute ({time}).", { tracks: data.tracks.length, notes: n.toLocaleString(), bpm: Math.round(data.bpm * 100) / 100, time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` })
    + (data.tempoChanges ? " " + t("The tempo changes later in the file; a song plays at the first.") : "");
}

/** The tracks listed: a colour, the name, the channel, how many notes. */
function trackList(api: PluginApi, t: Translate, data: NotesData): HTMLElement {
  const el = api.ui.el;
  const styled = <E extends HTMLElement>(e: E, style: string) => { e.setAttribute("style", style); return e; };
  return styled(el("ul", {},
    ...data.tracks.map((tr, k) => el("li", {},
      styled(el("span", {}), `display: inline-block; width: 10px; height: 10px; margin-right: 6px; background: ${COLORS[k % COLORS.length]};`),
      tr.channel === 10
        ? t("{name} — the drums, {n} notes", { name: tr.name, n: tr.notes.length })
        : t("{name} — channel {channel}, instrument {program}, {n} notes", { name: tr.name, channel: tr.channel, program: tr.program, n: tr.notes.length })))),
  "list-style: none; padding: 0; margin: 0 0 8px; font-size: 12px; max-height: 140px; overflow: auto;");
}

/**
 * Import a MIDI file: its tracks, a listen, the name; the `.notes` file it becomes, or null when the person cancelled
 * or it could not be read. `taken` says whether a path is in use.
 */
export async function importNotes(api: PluginApi, t: Translate, file: File, taken: (path: string) => boolean, stem: string): Promise<{ path: string; text: string } | null> {
  const w = api.ui.widgets, el = api.ui.el;
  let data: NotesData;
  try { data = readMidi(new Uint8Array(await file.arrayBuffer()), file.name); } catch (err) {
    await api.ui.alert(t("{name} could not be opened: {message}", { name: file.name, message: (err as Error).message }));
    return null;
  }
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", ROLL_STYLE);
  const status = w.hint("");
  const name = w.text({ value: `${stem}.notes` });
  const play = player(data, () => true, canvas);
  let result: { path: string; text: string } | null = null;
  await new Promise<void>((closed) => {
    api.ui.dialog({
      title: t("Import MIDI"),
      size: "md",
      mount(body) {
        body.append(
          canvas,
          w.row(w.button(t("Play"), { onClick: () => play.play() }), w.button(t("Stop"), { onClick: () => play.stop() })),
          trackList(api, t, data),
          w.form([{ label: t("File"), field: name }]),
          w.hint(about(t, data)),
          w.hint(t("The notes are kept, not the sounds: music.midi(notes, { Piano: keys }) plays each track you name with an instrument of the music library.")),
          status,
        );
        drawRoll(canvas, data, () => true);
        return () => { play.stop(); closed(); };
      },
      buttons: [
        { label: t("Cancel") },
        {
          label: t("Import"), primary: true,
          run: () => {
            let path = name.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
            if (!path.toLowerCase().endsWith(".notes")) path += ".notes";
            if (!/^[A-Za-z0-9_\-./]+$/.test(path) || path.split("/").some((p) => p === "." || p === ".." || p === "")) { status.textContent = t("A file name is letters, digits, _ - and ., folders with /."); return false; }
            if (taken(path)) { status.textContent = t("There is already a {name}.", { name: path }); return false; }
            result = { path, text: writeNotes(data) };
            return true;
          },
        },
      ],
    });
  });
  return result;
}

/** A `.notes` file of the script, shown: its roll, its tracks, played roughly, and how a script uses it. */
export function showNotes(api: PluginApi, t: Translate, path: string, text: string): void {
  let data: NotesData;
  try { data = readNotes(text); } catch (err) { void api.ui.alert(`${path}: ${(err as Error).message}`); return; }
  const w = api.ui.widgets, el = api.ui.el;
  const canvas = el("canvas", {}) as HTMLCanvasElement;
  canvas.setAttribute("style", ROLL_STYLE);
  const play = player(data, () => true, canvas);
  const stem = (path.split("/").pop() ?? path).replace(/\.notes$/i, "");
  const name = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_]+/, "") || "notes";
  api.ui.dialog({
    title: path,
    size: "md",
    mount(body) {
      body.append(
        canvas,
        w.row(w.button(t("Play"), { onClick: () => play.play() }), w.button(t("Stop"), { onClick: () => play.stop() })),
        trackList(api, t, data),
        w.hint(about(t, data) + (data.source ? ` · ${data.source}` : "")),
        w.hint(t("Import it with import {name} from \"./{file}\", make a song of it with music.midi({name}, { \"{track}\": music.presets.keys() }).", { name, file: path.split("/").pop() ?? path, track: data.tracks[0]?.name ?? "Track 1" })),
      );
      drawRoll(canvas, data, () => true);
      return () => play.stop();
    },
  });
}
