/**
 * LZMA's binary range coder, shared by the media a script imports (`media.ts`, `image.ts`): a bit at a time, each
 * with odds that adapt as the coder goes — `odds[k]` the chance of a 0 out of 2048 — the same way when it is read.
 */

const PROB_BITS = 11, MOVE_BITS = 5, TOP = 1 << 24;
/** Odds of even chances: what a table of odds starts at. */
export const PROB_HALF = 1 << (PROB_BITS - 1);

/** LZMA's range encoder, a bit at a time with adaptive odds (`odds[k]`: the chance of a 0, out of 2048). */
export class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out: number[] = [];

  bit(odds: Uint16Array, k: number, bit: number): void {
    const p = odds[k], bound = (this.range >>> PROB_BITS) * p;
    if (bit) { this.low += bound; this.range -= bound; odds[k] = p - (p >> MOVE_BITS); }
    else { this.range = bound; odds[k] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS); }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let byte = this.cache;
      do { this.out.push((byte + carry) & 0xff); byte = 0xff; } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private at = 0;
  /** Read past the end: the file was cut short. */
  overrun = false;

  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    for (let i = 0; i < 5; i++) this.code = ((this.code * 256) + this.next()) % 0x100000000;
  }

  private next(): number {
    if (this.at < this.bytes.length) return this.bytes[this.at++];
    this.overrun = this.at++ > this.bytes.length + 4;
    return 0;
  }

  bit(odds: Uint16Array, k: number): number {
    const p = odds[k], bound = (this.range >>> PROB_BITS) * p;
    let bit: number;
    if (this.code < bound) { this.range = bound; odds[k] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS); bit = 0; }
    else { this.code -= bound; this.range -= bound; odds[k] = p - (p >> MOVE_BITS); bit = 1; }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) % 0x100000000; }
    return bit;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
