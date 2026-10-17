/**
 * A video file's frames without a `<video>` element (TrigScript 4, B8): the file is taken apart here — WebM and
 * Matroska (EBML), MP4 and QuickTime (ISO boxes) — and its video track's samples handed to WebCodecs' `VideoDecoder`,
 * which gives back every frame with its own time, as fast as it decodes and whatever the page is busy drawing. A
 * `<video>` played through shows only the frames the page has time to paint (7.5 a second in a busy editor in a
 * headless Chromium), and seeking is 66 ms a frame. Anything this cannot read — another container, a codec the
 * browser's decoder does not take — returns null, and Import Video… plays the file in an element instead.
 *
 * Only what a video track needs is read: no audio, no subtitles, no lacing (video blocks are not laced), no
 * encryption, one video track (the first).
 */

/** A video track's samples, in decode order, and what the decoder needs to know about them. */
export interface Demuxed {
  /** The codec string `VideoDecoder.configure` takes: "avc1.64001f", "vp09.00.10.08", "av01.0.04M.08", … */
  codec: string;
  /** avcC / hvcC / av1C, for the codecs that take one. */
  description?: Uint8Array;
  width: number;
  height: number;
  samples: { data: Uint8Array; time: number; key: boolean }[];
  /** The time of the last frame's end (µs), or of its start when nothing says how long it lasts. */
  end: number;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** av01.P.LLT.DD from an av1C box (the AV1 codec string), or a plain one for an 8-bit Main stream. */
function av1Codec(c?: Uint8Array): string {
  if (!c || c.length < 4) return "av01.0.08M.08";
  const profile = c[1] >> 5, level = c[1] & 31, tier = c[2] >> 7 ? "H" : "M";
  const high = (c[2] >> 6) & 1, twelve = (c[2] >> 5) & 1;
  const depth = high ? (twelve ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}

/** avc1.PPCCLL from an avcC box. */
const avcCodec = (c?: Uint8Array) => (c && c.length >= 4 ? `avc1.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}` : "avc1.42001f");

/** hvc1… from an hvcC box (profile space/idc, compatibility flags, tier/level, constraints). */
function hevcCodec(c?: Uint8Array, tag = "hvc1"): string {
  if (!c || c.length < 13) return `${tag}.1.6.L93.B0`;
  const space = ["", "A", "B", "C"][c[1] >> 6], tier = (c[1] >> 5) & 1 ? "H" : "L", idc = c[1] & 31;
  let flags = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, reversed = 0;
  for (let i = 0; i < 32; i++) { reversed = (reversed << 1) | (flags & 1); flags >>>= 1; }
  const constraints = [...c.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return [`${tag}.${space}${idc}`, (reversed >>> 0).toString(16), `${tier}${c[12]}`, ...constraints.map((b) => b.toString(16))].join(".");
}

/* ── WebM / Matroska ── */

const EBML = 0x1a45dfa3, SEGMENT = 0x18538067, INFO = 0x1549a966, TIMECODE_SCALE = 0x2ad7b1, TRACKS = 0x1654ae6b, TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7, TRACK_TYPE = 0x83, CODEC_ID = 0x86, CODEC_PRIVATE = 0x63a2, VIDEO = 0xe0, PIXEL_WIDTH = 0xb0, PIXEL_HEIGHT = 0xba;
const DEFAULT_DURATION = 0x23e383, CLUSTER = 0x1f43b675, TIMECODE = 0xe7, SIMPLE_BLOCK = 0xa3, BLOCK_GROUP = 0xa0, BLOCK = 0xa1;
/** Elements that hold others, walked into; everything else is skipped or read. */
const MASTERS = new Set([SEGMENT, INFO, TRACKS, TRACK_ENTRY, VIDEO, CLUSTER, BLOCK_GROUP]);

function demuxMatroska(b: Uint8Array): Demuxed | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  /** An EBML variable-length number; `keep` keeps the length marker (an element id does). */
  const vint = (keep: boolean): number | null => {
    if (at >= b.length) return null;
    const first = b[at];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || at + len > b.length) return null;
    let v = keep ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + b[at + i];
    // All ones: a size not known (a live stream's segment or cluster) — read to its end.
    const unknown = !keep && v === 2 ** (7 * len) - 1;
    at += len;
    return unknown ? -1 : v;
  };
  const uint = (from: number, size: number) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + b[from + i]; return v; };
  if (view.byteLength < 4 || view.getUint32(0) !== EBML) return null;
  let scale = 1_000_000;
  const tracks: { number: number; type: number; codec: string; priv?: Uint8Array; width: number; height: number; duration: number }[] = [];
  let track: (typeof tracks)[number] | null = null;
  let videoTrack = -1, cluster = 0;
  const samples: Demuxed["samples"] = [];
  const block = (from: number, end: number, key: boolean | null) => {
    const save = at;
    at = from;
    const number = vint(false);
    if (number === null || number !== videoTrack) { at = save; return; }
    const rel = view.getInt16(at);
    const flags = b[at + 2];
    at += 3;
    if (flags & 0x06) { at = save; return; } // laced: not a video block
    samples.push({ data: b.subarray(at, end), time: Math.round(((cluster + rel) * scale) / 1000), key: key ?? !!(flags & 0x80) });
    at = save;
  };
  while (at < b.length) {
    const start = at;
    const id = vint(true), size = vint(false);
    if (id === null || size === null) break;
    const end = size < 0 ? b.length : Math.min(b.length, at + size);
    if (MASTERS.has(id)) {
      if (id === TRACK_ENTRY) { track = { number: 0, type: 0, codec: "", width: 0, height: 0, duration: 0 }; tracks.push(track); }
      if (id === CLUSTER && videoTrack < 0) {
        const video = tracks.find((t) => t.type === 1);
        if (!video) return null;
        videoTrack = video.number;
      }
      continue; // into it
    }
    if (id === TIMECODE_SCALE) scale = uint(at, size);
    else if (track && id === TRACK_NUMBER) track.number = uint(at, size);
    else if (track && id === TRACK_TYPE) track.type = uint(at, size);
    else if (track && id === CODEC_ID) track.codec = new TextDecoder().decode(b.subarray(at, end));
    else if (track && id === CODEC_PRIVATE) track.priv = b.subarray(at, end);
    else if (track && id === PIXEL_WIDTH) track.width = uint(at, size);
    else if (track && id === PIXEL_HEIGHT) track.height = uint(at, size);
    else if (track && id === DEFAULT_DURATION) track.duration = uint(at, size);
    else if (id === TIMECODE) cluster = uint(at, size);
    else if (id === SIMPLE_BLOCK) block(at, end, null);
    else if (id === BLOCK) block(at, end, false);
    if (end <= start) break;
    at = end;
  }
  const video = tracks.find((t) => t.number === videoTrack);
  if (!video || !samples.length) return null;
  const codec = video.codec === "V_VP8" ? "vp8" : video.codec === "V_VP9" ? "vp09.00.10.08" : video.codec === "V_AV1" ? av1Codec(video.priv)
    : video.codec === "V_MPEG4/ISO/AVC" ? avcCodec(video.priv) : video.codec === "V_MPEGH/ISO/HEVC" ? hevcCodec(video.priv) : null;
  if (!codec) return null;
  // (A block in a group with no reference is a key frame too; a decoder only needs the first to be one.)
  samples[0].key = true;
  const last = samples.reduce((m, s) => Math.max(m, s.time), 0);
  return { codec, ...(video.priv && codec !== "vp8" && !codec.startsWith("vp09") ? { description: video.priv } : {}), width: video.width, height: video.height, samples, end: last + Math.round(video.duration / 1000) };
}

/* ── MP4 / QuickTime ── */

function demuxMp4(b: Uint8Array): Demuxed | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = (at: number) => String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
  /** The boxes in [from, to): type, where its body starts, where it ends. */
  const boxes = (from: number, to: number) => {
    const out: { type: string; body: number; end: number }[] = [];
    for (let at = from; at + 8 <= to;) {
      let size = view.getUint32(at), body = at + 8;
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); body = at + 16; } else if (size === 0) size = to - at;
      if (size < 8 || at + size > to) break;
      out.push({ type: type(at), body, end: at + size });
      at += size;
    }
    return out;
  };
  const child = (from: number, to: number, name: string) => boxes(from, to).find((x) => x.type === name);
  if (b.length < 12 || !["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(type(0))) return null;
  const moov = child(0, b.length, "moov");
  if (!moov) return null;
  for (const trak of boxes(moov.body, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(trak.body, trak.end, "mdia");
    const hdlr = mdia && child(mdia.body, mdia.end, "hdlr");
    if (!mdia || !hdlr || type(hdlr.body + 4) !== "vide") continue;
    const mdhd = child(mdia.body, mdia.end, "mdhd")!;
    const timescale = view.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const minf = child(mdia.body, mdia.end, "minf"), stbl = minf && child(minf.body, minf.end, "stbl");
    if (!stbl) return null;
    const box = (name: string) => child(stbl.body, stbl.end, name);
    const stsd = box("stsd");
    if (!stsd) return null;
    // The first sample entry: its four-character code, its size, and the configuration box inside it.
    const entry = stsd.body + 8, fourcc = type(entry), width = view.getUint16(entry + 32), height = view.getUint16(entry + 34);
    const config = boxes(entry + 86, entry + view.getUint32(entry));
    const cfg = (name: string) => { const c = config.find((x) => x.type === name); return c ? b.subarray(c.body, c.end) : undefined; };
    const codec = fourcc === "avc1" || fourcc === "avc3" ? avcCodec(cfg("avcC")) : fourcc === "hvc1" || fourcc === "hev1" ? hevcCodec(cfg("hvcC"), fourcc)
      : fourcc === "av01" ? av1Codec(cfg("av1C")) : fourcc === "vp09" ? "vp09.00.10.08" : fourcc === "vp08" ? "vp8" : null;
    if (!codec) return null;
    const description = cfg("avcC") ?? cfg("hvcC") ?? cfg("av1C");
    // Sizes, chunks, samples per chunk, durations, composition offsets, key frames.
    const stsz = box("stsz")!, fixed = view.getUint32(stsz.body + 4), count = view.getUint32(stsz.body + 8);
    const sizes = Array.from({ length: count }, (_, i) => fixed || view.getUint32(stsz.body + 12 + 4 * i));
    const stco = box("stco"), co64 = box("co64");
    const chunks: number[] = stco ? Array.from({ length: view.getUint32(stco.body + 4) }, (_, i) => view.getUint32(stco.body + 8 + 4 * i))
      : co64 ? Array.from({ length: view.getUint32(co64.body + 4) }, (_, i) => Number(view.getBigUint64(co64.body + 8 + 8 * i))) : [];
    const stsc = box("stsc")!, runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({ first: view.getUint32(stsc.body + 8 + 12 * i) - 1, per: view.getUint32(stsc.body + 12 + 12 * i) }));
    const stts = box("stts")!, deltas: number[] = [];
    for (let i = 0, n = view.getUint32(stts.body + 4); i < n; i++) for (let k = 0, c = view.getUint32(stts.body + 8 + 8 * i); k < c; k++) deltas.push(view.getUint32(stts.body + 12 + 8 * i));
    const ctts = box("ctts"), offsets: number[] = [];
    if (ctts) for (let i = 0, n = view.getUint32(ctts.body + 4); i < n; i++) for (let k = 0, c = view.getUint32(ctts.body + 8 + 8 * i); k < c; k++) offsets.push(view.getInt32(ctts.body + 12 + 8 * i));
    const stss = box("stss"), keys = stss ? new Set(Array.from({ length: view.getUint32(stss.body + 4) }, (_, i) => view.getUint32(stss.body + 8 + 4 * i) - 1)) : null;
    // An edit list's first entry moves the whole track (B-frames: the first frame shown at 0).
    const edts = child(trak.body, trak.end, "edts"), elst = edts && child(edts.body, edts.end, "elst");
    const shift = elst ? (b[elst.body] === 1 ? Number(view.getBigInt64(elst.body + 16)) : view.getInt32(elst.body + 12)) : 0;
    const samples: Demuxed["samples"] = [];
    let s = 0, dts = 0, end = 0;
    for (let c = 0; c < chunks.length && s < count; c++) {
      const run = [...runs].reverse().find((r) => r.first <= c)!;
      let at = chunks[c];
      for (let k = 0; k < run.per && s < count; k++, s++) {
        const pts = dts + (offsets[s] ?? 0) - Math.max(0, shift);
        samples.push({ data: b.subarray(at, at + sizes[s]), time: Math.round((pts * 1e6) / timescale), key: keys ? keys.has(s) : true });
        end = Math.max(end, Math.round(((pts + (deltas[s] ?? 0)) * 1e6) / timescale));
        at += sizes[s];
        dts += deltas[s] ?? 0;
      }
    }
    return samples.length ? { codec, ...(description ? { description } : {}), width, height, samples, end } : null;
  }
  return null;
}

/** The video track of a WebM, Matroska, MP4 or QuickTime file, or null for anything else. */
export function demux(bytes: Uint8Array): Demuxed | null {
  try { return demuxMatroska(bytes) ?? demuxMp4(bytes); } catch { return null; }
}

/** A decoded frame, handed over open: the caller closes it. */
type Frame = CanvasImageSource & { timestamp: number; close(): void; displayWidth: number; displayHeight: number };

/**
 * Every frame of the track, in the order shown, through `VideoDecoder` — or null when the browser's decoder does not
 * take the codec. `onFrame` gets each one open (and must close it); it may return a promise, and decoding waits for it.
 */
export async function decodeTrack(d: Demuxed, onFrame: (frame: Frame) => void, signal: AbortSignal): Promise<boolean> {
  type Decoder = { configure(c: object): void; decode(chunk: unknown): void; flush(): Promise<void>; close(): void; decodeQueueSize: number; state: string };
  const W = globalThis as unknown as {
    VideoDecoder?: { new (init: { output: (f: Frame) => void; error: (e: Error) => void }): Decoder; isConfigSupported(c: object): Promise<{ supported?: boolean }> };
    EncodedVideoChunk?: new (init: { type: "key" | "delta"; timestamp: number; data: Uint8Array }) => unknown;
  };
  if (!W.VideoDecoder || !W.EncodedVideoChunk) return false;
  const config = { codec: d.codec, codedWidth: d.width, codedHeight: d.height, ...(d.description ? { description: d.description } : {}) };
  try { if (!(await W.VideoDecoder.isConfigSupported(config)).supported) return false; } catch { return false; }
  let failure: Error | null = null;
  // (Frames come out in the order they are shown, whatever order they were decoded in.)
  const decoder = new W.VideoDecoder({ output: (f) => { try { onFrame(f); } catch (e) { failure = e as Error; f.close(); } }, error: (e) => { failure = e; } });
  decoder.configure(config);
  try {
    for (const s of d.samples) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (failure) throw failure;
      decoder.decode(new W.EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.time, data: s.data }));
      // A few in flight at most: each decoded frame holds memory until it is drawn.
      while (decoder.decodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    }
    await decoder.flush();
    if (failure) throw failure;
    return true;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
}
