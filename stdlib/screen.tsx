/**
 * Pixel screens: the standard library's "trigscript/screen" (TrigScript 4).
 *
 *   import { Screen, ScreenView, sprite } from "trigscript/screen";
 *
 *   const SHIP = sprite([".1.", "111", "1.1"]);
 *
 *   program(async () => {
 *     const screen = new Screen(4, 4, 24, 16);   // 24 × 16 pixels, its corner on tile (4, 4)
 *     let x = 10;
 *     while (true) {
 *       screen.clear();
 *       screen.rect(0, 15, 24, 1, 5);           // the ground, in colour 5
 *       screen.blit(SHIP, x, 12);
 *       screen.number(score, 1, 1, 2);          // digits 3 × 5 pixels, in colour 2
 *       screen.present();                       // on the map, and so on the minimap
 *       await nextFrame();
 *     }
 *   });
 *
 * A screen is a grid of pixels, each 0 (empty) or a colour from 1 to 7; drawing changes the grid, and `present()`
 * shows it: a pixel is a unit on the map, owned by the player whose colour it is, so the minimap shows the picture —
 * neighbouring pixels of one colour join into a solid block there. Only the pixels that changed since the last
 * `present()` are made or taken away, so a still picture costs nothing to show. The same grid can be shown in a
 * player's text lines too, as squares (`ScreenView` in a `ui.lines` view): one game, two screens, as the Tetris probe has it.
 *
 * What the map needs, found playing the unit-pixel probe in StarCraft: Remastered (2026-10-16): the owners of the
 * pixels (P3 … P8 and P1 below; their colours are theirs on the map, so pick the map's player colours to suit) must not
 * be computers — a computer moves its own units — and Remastered will not start a game without a computer, so one slot
 * (P2 here) is a computer that owns no pixel. A pixel is an Overlord, which sits on any ground and on nothing else; keep
 * the screen's tiles clear of buildings. About 80 pixels made and taken away in a frame did not slow the game.
 */
import { centerLocation, createUnit, removeUnitAt, reserveLocation, textColors, units, P1, P3, P4, P5, P6, P7, P8, type Player } from "trigscript";

/** Whose units show colours 1 to 7 on the map: the players whose colours they are. Not computers. */
export const OWNERS: readonly Player[] = [P3, P4, P5, P6, P7, P8, P1];
/** The same colours in the text lines (`ScreenView`), 0 an empty square: cyan, yellow, purple, green, red, blue, orange. */
export const TEXT_COLORS: readonly number[] = [0, textColors.cyan, textColors.yellow, textColors.purple, textColors.green, textColors.red, textColors.blue, textColors.orange];

/** Where each pixel's unit is made: a location the map does not use, taken when the script is built. */
const SPOT = reserveLocation("screen: where each pixel is made");

/** A picture known when the script is built, to `blit` onto a screen: its size, and its pixels a row at a time (0 is see-through). */
export interface Sprite { readonly width: number; readonly height: number; readonly cells: readonly number[] }

/**
 * A sprite from rows of text, when the script is built: "1" … "7" a pixel of that colour, anything else see-through.
 *
 *   const SHIP = sprite([".1.", "111", "1.1"]);
 */
export function sprite(rows: readonly string[]): Sprite {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cells: number[] = [];
  for (const row of rows) for (let x = 0; x < width; x++) { const c = Number(row[x]); cells.push(c >= 1 && c <= 7 ? c : 0); }
  return { width, height: rows.length, cells };
}

/** The digits 0 to 9, three pixels wide and five high, for `number()`: each fifteen pixels, a row at a time. */
const DIGITS: readonly number[] = [
  "111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
  "111100111001111", "111100111101111", "111001001010010", "111101111101111", "111101111001111",
].flatMap((d) => d.split("").map(Number));

export class Screen {
  /** The picture being drawn: a colour a pixel, a row at a time. */
  pixels: number[] = [];
  /** What the map shows now: the picture as it was at the last `present()`. */
  shown: number[] = [];
  x: number;
  y: number;
  width: number;
  height: number;
  cell: number;

  /**
   * A screen `width` × `height` pixels, its top left corner on tile (x, y) of the map, a pixel every `cell` pixels of the
   * map (64, two tiles, unless it says: an Overlord's size).
   */
  constructor(x: number, y: number, width: number, height: number, cell: number = 64) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.cell = cell;
    let i = 0;
    while (i < width * height) { this.pixels.push(0); this.shown.push(0); i++; }
  }

  /** Every pixel the colour (0, empty, unless it says). */
  clear(color: number = 0) {
    for (let i = 0; i < this.pixels.length; i++) this.pixels[i] = color;
  }

  /** One pixel; nothing happens outside the screen. */
  set(x: number, y: number, color: number) {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.pixels[y * this.width + x] = color;
  }

  /** The colour of a pixel; 0 outside the screen. */
  get(x: number, y: number): number {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) return this.pixels[y * this.width + x];
    return 0;
  }

  /** A filled rectangle, its top left at (x, y); what is outside the screen is left out. */
  rect(x: number, y: number, width: number, height: number, color: number) {
    let j = 0;
    while (j < height) {
      let i = 0;
      while (i < width) { this.set(x + i, y + j, color); i++; }
      j++;
    }
  }

  /** A line from (x0, y0) to (x1, y1), both ends drawn. */
  line(x0: number, y0: number, x1: number, y1: number, color: number) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    while (true) {
      this.set(x, y, color);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  /** A sprite with its top left at (x, y): its see-through pixels leave what is under them. */
  blit(s: Sprite, x: number, y: number) {
    let k = 0;
    let j = 0;
    while (j < s.height) {
      let i = 0;
      while (i < s.width) {
        const c = s.cells[k];
        if (c !== 0) this.set(x + i, y + j, c);
        k++;
        i++;
      }
      j++;
    }
  }

  /** A whole number's digits, 3 × 5 pixels each with a pixel between, its top left at (x, y): a score on the minimap. */
  number(n: number, x: number, y: number, color: number) {
    let rest = n < 0 ? -n : n;
    let count = 1;
    let probe = rest;
    while (probe >= 10) { probe = Math.floor(probe / 10); count++; }
    let place = x + (count - 1) * 4;
    while (true) {
      const d = rest % 10;
      let k = 0;
      while (k < 15) {
        if (DIGITS[d * 15 + k] === 1) this.set(place + (k % 3), y + Math.floor(k / 3), color);
        k++;
      }
      rest = Math.floor(rest / 10);
      place -= 4;
      if (rest === 0) break;
    }
  }

  /** The picture on the map: each pixel that changed since the last time taken away and made again in its colour. */
  present() {
    const half = Math.floor(this.cell / 2);
    for (let i = 0; i < this.pixels.length; i++) {
      const now = this.pixels[i];
      const was = this.shown[i];
      if (now !== was) {
        centerLocation(SPOT, this.x * 32 + (i % this.width) * this.cell + half, this.y * 32 + Math.floor(i / this.width) * this.cell + half, 32, 32);
        OWNERS.forEach((owner, k) => { if (was === k + 1) removeUnitAt(owner, units.ZergOverlord, 1, SPOT); });
        OWNERS.forEach((owner, k) => { if (now === k + 1) createUnit(owner, units.ZergOverlord, 1, SPOT); });
        this.shown[i] = now;
      }
    }
  }
}

/**
 * A screen in the text lines, a square a pixel — filled in its colour, or empty — a line a row. For a `ui.lines` view:
 * `<ScreenView screen={screen} width={10} height={8} />`, the screen's size known when the script is built. Eleven lines
 * show at once, sixty squares across.
 */
export function ScreenView({ screen, width, height }: { screen: Screen; width: number; height: number }) {
  return <>{UP_TO_60.map((y) => y < height && <line>{UP_TO_60.map((x) => x < width && <cell color={TEXT_COLORS[screen.pixels[y * width + x]]} />)}</line>)}</>;
}

/** 0 … 59: the places a view's rows and columns are counted over, the ones past its size left out when the script is built. */
const UP_TO_60: readonly number[] = Array.from({ length: 60 }, (_, i) => i);
