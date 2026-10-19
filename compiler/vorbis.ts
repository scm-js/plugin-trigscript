/**
 * Ogg Vorbis for the clips a build puts in the map at two seconds or more (`sound.ts`'s `clipFile`): libvorbis and
 * libogg compiled to WebAssembly by wasm-media-encoders (MIT; libvorbis and libogg BSD), its `ogg.wasm` copied to
 * `dist/vorbis.wasm` by the build. The glue is this file's own, a few calls into the module's exports: the package's
 * JavaScript carries both its encoders inline, and instantiates them only asynchronously.
 *
 * A compile only names a Vorbis clip (by its samples); it is encoded when the map is to get it — a build, not a check
 * as the user types — by `finishSounds`, which the compile worker calls when asked, and `scripts/build-fixture.mts`
 * calls for a probe map. Encoding three minutes of two channels takes about a second and a half.
 */
import { VORBIS_QUALITY, type ClipFile } from "./sound";

/** What the module exports, as wasm-media-encoders 0.7.0 builds it. */
interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(at: number): void;
  enc_init(params: number): number;
  enc_get_pcm(ref: number, frames: number): number;
  enc_encode(ref: number, frames: number): number;
  enc_flush(ref: number): number;
  enc_get_out_buf(ref: number): number;
  enc_free(ref: number): void;
}

/** Samples handed to the encoder at a time. */
const CHUNK = 8192;

export interface VorbisEncoder {
  /** One or two channels of samples (−1 … 1) at `rate`, as an Ogg Vorbis file: the same bytes for the same samples. */
  encode(channels: readonly Float32Array[], rate: number, quality?: number): Uint8Array;
}

/** An encoder from the module's bytes (or the module), made at once: a worker, or Node, may compile a module this size synchronously. */
export function vorbisEncoder(wasm: BufferSource | WebAssembly.Module): VorbisEncoder {
  const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: { proc_exit: (code: number) => { throw new Error(`The Vorbis encoder stopped (exit ${code}).`); } },
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const x = instance.exports as unknown as Exports;
  x._initialize();
  // The memory may grow inside any call: a view is made after the call it is for.
  const bytesOut = (ref: number, n: number) => new Uint8Array(x.memory.buffer, x.enc_get_out_buf(ref), n).slice();
  return {
    encode(channels, rate, quality = VORBIS_QUALITY) {
      const n = channels.length;
      if (n !== 1 && n !== 2) throw new Error("Vorbis here takes one channel or two.");
      const params = x.malloc(16);
      if (!params) throw new Error("The Vorbis encoder is out of memory.");
      const view = new DataView(x.memory.buffer);
      view.setUint32(params, n, true);
      view.setUint32(params + 4, rate, true);
      view.setFloat32(params + 8, quality, true);
      // The stream's serial number: fixed, so a build writes the same file for the same samples.
      view.setInt32(params + 12, 0x54726753, true);
      const ref = x.enc_init(params);
      x.free(params);
      if (!ref) throw new Error("The Vorbis encoder would not start.");
      try {
        const parts: Uint8Array[] = [];
        const frames = channels[0].length;
        for (let i = 0; i < frames; i += CHUNK) {
          const m = Math.min(CHUNK, frames - i);
          const table = x.enc_get_pcm(ref, m);
          if (!table) throw new Error("The Vorbis encoder is out of memory.");
          const pointers = new Int32Array(x.memory.buffer, table, n);
          for (let c = 0; c < n; c++) new Float32Array(x.memory.buffer, pointers[c], m).set(channels[c].subarray(i, i + m));
          const out = x.enc_encode(ref, m);
          if (out < 0) throw new Error(`The Vorbis encoder failed (${out}).`);
          if (out > 0) parts.push(bytesOut(ref, out));
        }
        const last = x.enc_flush(ref);
        if (last < 0) throw new Error(`The Vorbis encoder failed (${last}).`);
        if (last > 0) parts.push(bytesOut(ref, last));
        const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) { file.set(p, o); o += p.length; }
        return file;
      } finally {
        x.enc_free(ref);
      }
    },
  };
}

/** Files encoded already, by their names (which say what they hold): a build after a build of the same song is quick. */
const encoded = new Map<string, Uint8Array>();
const KEEP = 32;

/**
 * Give each sound of a compile its bytes: the Vorbis ones encoded, with `encoder` — or, with none, left as names only
 * (a check, whose sounds the map does not get) and their samples dropped, so the result is small to send.
 */
export function finishSounds(sounds: ClipFile[], encoder: VorbisEncoder | null): void {
  for (const s of sounds) {
    if (!s.vorbis) continue;
    if (encoder) {
      let bytes = encoded.get(s.path);
      if (!bytes) {
        bytes = encoder.encode(s.vorbis.channels, s.vorbis.rate);
        if (encoded.size >= KEEP) encoded.delete(encoded.keys().next().value!);
        encoded.set(s.path, bytes);
      }
      s.bytes = bytes;
    }
    delete s.vorbis;
  }
}

/** The encoder, its module fetched from `url` once. */
let loading: { url: string; encoder: Promise<VorbisEncoder> } | null = null;

export function loadVorbis(url: string): Promise<VorbisEncoder> {
  if (loading?.url !== url) {
    const encoder = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Could not load the Vorbis encoder from ${url} (${r.status}).`);
      return vorbisEncoder(await r.arrayBuffer());
    });
    encoder.catch(() => { if (loading?.encoder === encoder) loading = null; });
    loading = { url, encoder };
  }
  return loading.encoder;
}
