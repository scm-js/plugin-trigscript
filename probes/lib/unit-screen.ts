// A board drawn with units, on the map and the minimap (TrigScript 4, S2): a cell of the board is an Overlord on the map,
// its owner's colour the cell's colour. Nothing moves a unit: the screen keeps what it has drawn and, given the board,
// takes away and makes only the cells that changed — a location centred on the cell, Remove Unit and Create Unit there.
//
// What the unit-pixel probe found, played in Remastered (2026-10-16): Overlords sit on their cells on any ground; a
// computer moves its own units (its idle order), so the owners are you and the empty slots; neighbours of one owner join
// into one block on the minimap; 80 made and taken away a frame did not slow the game; a Create Unit that fails prints
// a warning in the text lines, which an Overlord never does. The map needs a 64 × 64 location for the cells (the probe
// maps' "Pixel").
//
// An ordinary class: declared outside any program, it is the program's wherever a program makes one (TrigScript 4).
import { centerLocation, createUnit, removeUnitAt, units, type Location, type Player } from "trigscript";

/**
 * How the cells look, known when the script is built: each colour a cell can hold, the player whose Overlord shows it,
 * and the location moved to each cell — an action's player and location are, so they come with each draw, not as fields.
 */
export interface Look { colors: readonly number[]; owners: readonly Player[]; at: Location }

export class UnitScreen {
  /** What each cell shows on the map now: the board as it was the last time it was drawn. */
  shown: number[] = [];
  x: number;
  y: number;
  width: number;
  cell: number;

  /** A board `width` × `height` cells, its corner at (x, y) on the map, a cell `cell` pixels. */
  constructor(x: number, y: number, width: number, height: number, cell: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.cell = cell;
    for (let i = 0; i < width * height; i++) this.shown.push(0);
  }

  /** The board on the map: each cell that changed since the last time, taken away and made again in its colour (0 is empty). */
  draw(board: number[], look: Look) {
    for (let i = 0; i < this.shown.length; i++) {
      const now = board[i];
      const was = this.shown[i];
      if (now !== was) {
        centerLocation(look.at, this.x + (i % this.width) * this.cell + this.cell / 2, this.y + Math.floor(i / this.width) * this.cell + this.cell / 2);
        look.colors.forEach((color, k) => { if (was === color) removeUnitAt(look.owners[k], units.ZergOverlord, 1, look.at); });
        look.colors.forEach((color, k) => { if (now === color) createUnit(look.owners[k], units.ZergOverlord, 1, look.at); });
        this.shown[i] = now;
      }
    }
  }
}
