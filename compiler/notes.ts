/**
 * Notes a script imports (TrigScript 4, music step 3): `import tune from "./tune.notes"`. A `.notes` file is one of the
 * script's files, kept in the map with the others: the notes of a MIDI file as the editor read it when it was
 * imported — each track's name, channel and instrument, and each note's start, length, pitch and velocity, in beats.
 * The MIDI file is not kept; what is kept is what the build reads.
 *
 * The file is text, one line of JSON. What a script gets is `Notes` (below), which `music.midi` turns into a song with
 * an instrument for each track it names.
 */

/** The extension of a script's notes. */
export const NOTES_EXTENSION = ".notes";
/** The format's version, in the file. */
const VERSION = 1;

/** A note: its start and length in beats (quarter notes) from the start, its MIDI number (60 is C4), how hard (1 … 127). */
export interface NoteEvent { readonly at: number; readonly beats: number; readonly pitch: number; readonly velocity: number }

/** A track of a MIDI file as imported: notes of one channel of one track of the file. */
export interface NotesTrackData {
  readonly name: string;
  /** 1 … 16; 10 is the drums. */
  readonly channel: number;
  /** The General MIDI instrument the file asks for, 1 … 128 (1 when it asks for none). */
  readonly program: number;
  readonly notes: readonly NoteEvent[];
}

/** What a `.notes` file holds. */
export interface NotesData {
  /** The tempo the file starts at. */
  readonly bpm: number;
  /** Quarter notes a bar, from its time signature (4 for 4/4, 3 for 6/8). */
  readonly beats: number;
  /** Whether the tempo changes later (a song plays at one). */
  readonly tempoChanges: number;
  readonly tracks: readonly NotesTrackData[];
  readonly source?: string;
}

/* ── Reading a MIDI file ── */

/** The notes of a Standard MIDI File (format 0 or 1). Throws, in words for the person, when it is not one. */
export function readMidi(bytes: Uint8Array, source?: string): NotesData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || tag(0) !== "MThd") throw new Error("This is not a MIDI file: a MIDI file starts with MThd.");
  const headerLength = view.getUint32(4), format = view.getUint16(8), count = view.getUint16(10), division = view.getUint16(12);
  if (format > 1) throw new Error("This MIDI file holds separate songs (format 2): only formats 0 and 1 are read.");
  if (division & 0x8000) throw new Error("This MIDI file counts time in SMPTE frames: only files that count in beats are read.");
  const ppq = division;
  let at = 8 + headerLength;
  const tempos: [number, number][] = [];
  let meter: [number, number] | null = null;
  // Notes by file track and channel, in the order they turn up.
  const groups = new Map<string, { track: number; channel: number; name: string; program: number; notes: NoteEvent[] }>();
  for (let t = 0; t < count && at + 8 <= bytes.length; t++) {
    if (tag(at) !== "MTrk") { at += 8 + view.getUint32(at + 4); t--; continue; }
    const end = Math.min(bytes.length, at + 8 + view.getUint32(at + 4));
    let p = at + 8, tick = 0, status = 0, trackName = "";
    const programs = new Map<number, number>();
    const open = new Map<number, { tick: number; velocity: number }[]>();
    const varint = () => { let v = 0; for (let k = 0; k < 4; k++) { const b = bytes[p++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return v; };
    const group = (channel: number) => {
      const key = `${t}:${channel}`;
      let g = groups.get(key);
      if (!g) { g = { track: t, channel, name: "", program: programs.get(channel) ?? 0, notes: [] }; groups.set(key, g); }
      return g;
    };
    const close = (channel: number, pitch: number, now: number) => {
      const list = open.get(channel * 128 + pitch);
      const on = list?.shift();
      if (on && now > on.tick) group(channel).notes.push({ at: on.tick / ppq, beats: (now - on.tick) / ppq, pitch, velocity: on.velocity });
    };
    while (p < end) {
      tick += varint();
      let b = bytes[p];
      if (b & 0x80) { status = b; p++; } else if (!status) throw new Error("This MIDI file is damaged: a track starts with data and no event.");
      b = status;
      if (b === 0xff) {
        const type = bytes[p++], length = varint(), data = bytes.subarray(p, p + length);
        p += length;
        if (type === 0x51 && length === 3) tempos.push([tick, (data[0] << 16) | (data[1] << 8) | data[2]]);
        else if (type === 0x58 && length >= 2 && !meter) meter = [data[0], 2 ** data[1]];
        else if (type === 0x03 && !trackName) trackName = new TextDecoder("latin1").decode(data).trim();
        else if (type === 0x2f) break;
        status = 0;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { p += varint(); status = 0; continue; }
      const kind = b & 0xf0, channel = b & 0x0f;
      const one = bytes[p++], two = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++];
      if (kind === 0x90 && two > 0) {
        const key = channel * 128 + one;
        const list = open.get(key);
        // A note struck again while it sounds ends the first.
        if (list?.length) close(channel, one, tick);
        (open.get(key) ?? open.set(key, []).get(key)!).push({ tick, velocity: two });
        group(channel);
      } else if (kind === 0x80 || kind === 0x90) close(channel, one, tick);
      else if (kind === 0xc0) { programs.set(channel, one); const g = groups.get(`${t}:${channel}`); if (g && g.notes.length === 0) g.program = one; }
    }
    // A note never let go ends with its track.
    for (const [key, list] of open) for (const on of list) if (tick > on.tick) group(key >> 7).notes.push({ at: on.tick / ppq, beats: (tick - on.tick) / ppq, pitch: key & 127, velocity: on.velocity });
    for (const g of groups.values()) if (g.track === t) g.name = trackName;
    at = end;
  }
  tempos.sort((a, b) => a[0] - b[0]);
  const first = tempos.find((x) => x[0] === 0) ?? tempos[0];
  const bpm = first ? 60_000_000 / first[1] : 120;
  const kept = [...groups.values()].filter((g) => g.notes.length > 0);
  const several = new Map<number, number>();
  for (const g of kept) several.set(g.track, (several.get(g.track) ?? 0) + 1);
  const tracks = kept.map((g) => ({
    name: g.name ? (several.get(g.track)! > 1 ? `${g.name} (channel ${g.channel + 1})` : g.name) : `Track ${g.track + 1}${several.get(g.track)! > 1 || count === 1 ? ` channel ${g.channel + 1}` : ""}`,
    channel: g.channel + 1, program: g.program + 1,
    notes: g.notes.sort((a, b) => a.at - b.at || a.pitch - b.pitch),
  }));
  if (tracks.length === 0) throw new Error("This MIDI file has no notes.");
  // Names made unique, so a script can name each track.
  const seen = new Map<string, number>();
  for (const tr of tracks) { const n = (seen.get(tr.name) ?? 0) + 1; seen.set(tr.name, n); if (n > 1) tr.name = `${tr.name} ${n}`; }
  let changes = 0;
  for (let k = 1; k < tempos.length; k++) if (tempos[k][1] !== tempos[k - 1][1]) changes++;
  return { bpm: Math.round(bpm * 1000) / 1000, beats: meter ? (meter[0] * 4) / meter[1] : 4, tempoChanges: changes, tracks, ...(source ? { source } : {}) };
}

/* ── The .notes file ── */

/** The `.notes` file's text: a note four numbers, in 960ths of a beat. */
export function writeNotes(data: NotesData): string {
  const q = (x: number) => Math.round(x * 960);
  return JSON.stringify({
    trigscript: "notes", version: VERSION, bpm: data.bpm, beats: data.beats, tempoChanges: data.tempoChanges, ...(data.source ? { source: data.source } : {}),
    tracks: data.tracks.map((t) => ({ name: t.name, channel: t.channel, program: t.program, notes: t.notes.flatMap((n) => [q(n.at), q(n.beats), n.pitch, n.velocity]) })),
  });
}

/** A `.notes` file as the build reads it. Throws, in words for the person, when it is not one. */
export function readNotes(text: string): NotesData {
  let h: { trigscript?: unknown; version?: unknown; bpm?: unknown; beats?: unknown; tempoChanges?: unknown; source?: unknown; tracks?: unknown };
  try { h = JSON.parse(text); } catch { throw new Error("These are not notes TrigScript imported: a .notes file is one line of JSON."); }
  if (h?.trigscript !== "notes") throw new Error("These are not notes TrigScript imported.");
  if (h.version !== VERSION) throw new Error(`These notes are of version ${String(h.version)}; this TrigScript reads version ${VERSION}.`);
  const bpm = Number(h.bpm), beats = Number(h.beats);
  if (!(bpm > 0) || !(beats > 0) || !Array.isArray(h.tracks)) throw new Error("These notes are damaged: no tempo, no bar or no tracks.");
  const tracks = h.tracks.map((t: { name?: unknown; channel?: unknown; program?: unknown; notes?: unknown }, k: number) => {
    const ns = t?.notes;
    if (!Array.isArray(ns) || ns.length % 4 !== 0 || ns.some((x) => typeof x !== "number" || !Number.isFinite(x))) throw new Error(`These notes are damaged: track ${k + 1}'s notes are not four numbers each.`);
    const notes: NoteEvent[] = [];
    for (let i = 0; i < ns.length; i += 4) notes.push({ at: ns[i] / 960, beats: ns[i + 1] / 960, pitch: ns[i + 2], velocity: ns[i + 3] });
    return { name: String(t.name ?? `Track ${k + 1}`), channel: Number(t.channel ?? 1), program: Number(t.program ?? 1), notes };
  });
  return { bpm, beats, tempoChanges: Number(h.tempoChanges ?? 0), tracks, ...(typeof h.source === "string" ? { source: h.source } : {}) };
}

/* ── What a script gets ── */

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** A MIDI number's note name: 60 is "C4". */
export const noteName = (n: number): string => NAMES[n % 12] + (Math.floor(n / 12) - 1);

/** The value an import of a `.notes` file gives, kept while the text is the same (a build reads the files each time). */
const values = new Map<string, unknown>();

export function notesValue(text: string): unknown {
  const kept = values.get(text);
  if (kept) return kept;
  const data = readNotes(text);
  const value = Object.freeze({
    bpm: data.bpm, beats: data.beats, tempoChanges: data.tempoChanges, ...(data.source ? { source: data.source } : {}),
    tracks: Object.freeze(data.tracks.map((t) => Object.freeze({
      name: t.name, channel: t.channel, program: t.program, drums: t.channel === 10,
      notes: Object.freeze(t.notes.map((n) => Object.freeze({ at: n.at, beats: n.beats, pitch: n.pitch, note: noteName(n.pitch), velocity: n.velocity }))),
    }))),
  });
  if (values.size >= 8) values.delete(values.keys().next().value!);
  values.set(text, value);
  return value;
}

/** What the hover on an import says: "notes, 4 tracks, 1,204 notes, 143 beats a minute, from tune.mid". */
export function describeNotes(text: string): string {
  try {
    const d = readNotes(text);
    const n = d.tracks.reduce((s, t) => s + t.notes.length, 0);
    const end = Math.max(0, ...d.tracks.flatMap((t) => t.notes.map((x) => x.at + x.beats)));
    const seconds = Math.round((end * 60) / d.bpm);
    return `Notes: ${d.tracks.length} track${d.tracks.length === 1 ? "" : "s"} (${d.tracks.map((t) => t.name).join(", ")}), ${n.toLocaleString("en-US")} notes, ${Math.round(d.bpm * 100) / 100} beats a minute (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})${d.tempoChanges ? `, the tempo changing ${d.tempoChanges} time${d.tempoChanges === 1 ? "" : "s"} (a song plays at the first)` : ""}${d.source ? `, from ${d.source}` : ""}.`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
