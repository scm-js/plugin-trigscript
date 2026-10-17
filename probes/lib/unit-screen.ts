// A board drawn with units, on the map and the minimap (TrigScript 4, S2): a cell of the board is an Overlord on the map,
// its owner's colour the cell's colour. Nothing moves a unit: the screen keeps what it has drawn and, given the board,
// takes away and makes only the cells that changed — a location centred on the cell, Remove Unit and Create Unit there.
//
// What the unit-pixel probe found, played in Remastered (2026-10-16): Overlords sit on their cells on any ground; a
// computer's AI moves its own units, so the owners are the empty slots; neighbours of one owner join into one block on
// the minimap; 80 made and taken away a frame did not slow the game; a Create Unit that fails prints a warning in the
// text lines, which an Overlord never does. The map needs a 64 × 64 location for the cells (the probe maps' "Pixel").
//
// A game() function, since a function from another file reaches a program that way; a class would read better, and a
// class declared outside a program is not the program's yet.
import { game, centerLocation, createUnit, removeUnitAt, units, players, P3, P4, P5, P6, P7, P8, type Location, type Player } from "trigscript";

/** Where a board is drawn: its corner on the map, its width in cells, a cell's size, and the location moved to each cell. */
export interface UnitBoard { x: number; y: number; width: number; cell: number; at: Location }
/** What a board's cell holds — a colour each piece has — and the player whose Overlord shows each. */
export interface Palette { colors: readonly number[]; owners: readonly Player[] }

/** The empty slots and Player 12: units no computer moves. */
export const OWNERS: readonly Player[] = [P3, P8, P4, P6, players.P12, P7, P5];

/**
 * The board on the map. `shown` is what each cell shows now — the board as it was the last time — and is brought up to
 * date: each cell that changed is taken away and made again in its colour (0 is an empty cell, nothing on the map).
 */
export const drawUnits = game((board: number[], shown: number[], where: UnitBoard, palette: Palette) => {
  for (let i = 0; i < shown.length; i++) {
    const now = board[i];
    const was = shown[i];
    if (now !== was) {
      centerLocation(where.at, where.x + (i % where.width) * where.cell + where.cell / 2, where.y + Math.floor(i / where.width) * where.cell + where.cell / 2);
      palette.colors.forEach((color, k) => { if (was === color) removeUnitAt(palette.owners[k], units.ZergOverlord, 1, where.at); });
      palette.colors.forEach((color, k) => { if (now === color) createUnit(palette.owners[k], units.ZergOverlord, 1, where.at); });
      shown[i] = now;
    }
  }
});
