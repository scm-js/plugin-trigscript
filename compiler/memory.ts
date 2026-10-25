/**
 * `memory`: cells of the game's memory that have no other word in the language (TrigScript 4, B7). Each is one cell
 * at a fixed address — a table cell with no index, so it is read and written as `stats()` fields are (`tableRead` /
 * `tableWrite`), and the simulator keeps it as it keeps them.
 *
 * Every field says what StarCraft: Remastered does with it, from its own EUD emulator (R0, `data/remastered.json`) and
 * from played probes; the hover shows it. A field the game only keeps for itself is `readonly` in the declarations,
 * so a write is a type error before anything is built. Addresses are 1.16.1's, which Remastered emulates.
 */
import type { TableField } from "./tables";

export interface MemoryField {
  /** Where it sits in `memory`: ["vision", "countdown"] is `memory.vision.countdown`. */
  path: [string, string];
  doc: string;
  base: number;
  width: 1 | 2 | 4;
  readonly?: boolean;
  /** What Remastered does with it, as the hover says it. */
  remastered: string;
}

/** The groups of `memory`, each an interface of its own in the declarations. */
export const MEMORY_GROUPS: Record<string, [string, string]> = {
  vision: ["MemoryVision", "How the game keeps fog of war."],
  game: ["MemoryGame", "The game as a whole."],
  map: ["MemoryMap", "The map being played."],
};

export const MEMORY_FIELDS: MemoryField[] = [
  {
    path: ["vision", "countdown"], base: 0x51ce98, width: 4,
    doc: "Frames until the game works out again what every player sees. It counts down from 100 each frame; at 0 every tile goes back to fog and every unit reveals what it sees again. Between, a tile once revealed stays revealed. Write 1 after drawing and the next frame starts from a wiped board — `fog` does this for you.",
    remastered: "Remastered: read and written as in 1.16.1 (its own EUD emulator; its frame step is 1.16.1's line for line). Played: the S4 fog probes.",
  },
  {
    path: ["game", "frame"], base: 0x57f23c, width: 4, readonly: true,
    doc: "Game frames since the game began: 24 a second on Fastest, the same on every player's computer.",
    remastered: "Remastered: read allowed (its own EUD emulator). The game keeps it; a write would only confuse its own count.",
  },
  {
    path: ["map", "width"], base: 0x57f1d4, width: 2, readonly: true,
    doc: "The map's width, in tiles (a tile is 32 pixels).",
    remastered: "Remastered: read allowed (its own EUD emulator).",
  },
  {
    path: ["map", "height"], base: 0x57f1d6, width: 2, readonly: true,
    doc: "The map's height, in tiles (a tile is 32 pixels).",
    remastered: "Remastered: read allowed (its own EUD emulator).",
  },
];

/** The game's locations: 255 records of 20 bytes — left, top, right, bottom in pixels, then the elevation flags. */
export const LOCATION_TABLE = 0x58dc60, LOCATION_BYTES = 20;
export const LOCATION_SIDES = ["left", "top", "right", "bottom"] as const;
/** `bounds(location).left`: one edge of a location as a table cell, which the program reads and writes where it is now. */
export function locationField(side: (typeof LOCATION_SIDES)[number]): TableField {
  return { name: side, doc: `The location's ${side} edge, in pixels.`, base: LOCATION_TABLE + 4 * LOCATION_SIDES.indexOf(side), stride: LOCATION_BYTES, width: 4 };
}

/**
 * `local`: what only the computer the game runs on knows (TrigScript 4, B5) — who sits at it, where its screen is, where
 * its mouse is on the screen. Each is a cell read as `memory`'s are, and every one is a `Local` value: it may differ from
 * one computer to the next, so the compiler keeps it away from anything that changes the game (`local.ts`) and `sync()`
 * is how it reaches everyone. Read from Remastered's emulator and played (`probes/local-reads`, 2026-10-17).
 */
export const LOCAL_FIELDS: MemoryField[] = [
  {
    path: ["player", ""], base: 0x512684, width: 4, readonly: true,
    doc: "The player sitting at this computer: 0 for Player 1, 1 for Player 2, … Every computer has its own.",
    remastered: "Remastered: the real local player number (its own EUD emulator). Played: 0 in a game hosted alone.",
  },
  {
    path: ["camera", "x"], base: 0x62848c, width: 4, readonly: true,
    doc: "Where this computer's screen is on the map: the left edge, in pixels. The screen is 640 pixels wide in Classic graphics and 853 in Remastered's at 16:9.",
    remastered: "Remastered: the real camera, read live (its own EUD emulator); a write is ignored — centerView() moves it. Played.",
  },
  {
    path: ["camera", "y"], base: 0x6284a8, width: 4, readonly: true,
    doc: "Where this computer's screen is on the map: the top edge, in pixels.",
    remastered: "Remastered: the real camera, read live (its own EUD emulator); a write is ignored. Played.",
  },
  {
    path: ["mouse", "x"], base: 0x6cddc4, width: 4, readonly: true,
    doc: "Where this computer's mouse is on the screen, from its left edge, in the game's pixels: 0 to 639 in Classic graphics, to 852 in Remastered's at 16:9. On the map it is local.camera.x + local.mouse.x; mouse(p) is that place, sent to every computer.",
    remastered: "Remastered: its input record, read live; in widescreen wider than 640 (2560 screen pixels read as 853). Played.",
  },
  {
    path: ["mouse", "y"], base: 0x6cddc8, width: 4, readonly: true,
    doc: "Where this computer's mouse is on the screen, from its top edge, in the game's pixels: 0 to 479.",
    remastered: "Remastered: its input record, read live. Played.",
  },
];

/** The memory that is one computer's own: what a read of it gives is a `Local` value. Not only `LOCAL_FIELDS`: the keys and the selection too. */
export const LOCAL_MEMORY: readonly { name: string; from: number; size: number }[] = [
  { name: "the local player", from: 0x512684, size: 4 },
  { name: "the keys held", from: 0x596a18, size: 256 },
  { name: "the camera", from: 0x62848c, size: 4 },
  { name: "the camera", from: 0x6284a8, size: 4 },
  { name: "the selection", from: 0x6284b8, size: 48 },
  { name: "the mouse buttons", from: 0x6cddc0, size: 4 },
  { name: "the mouse", from: 0x6cddc4, size: 8 },
];

/** What of `LOCAL_MEMORY` an address is in, if any. */
export function localMemoryAt(address: number): string | undefined {
  return LOCAL_MEMORY.find((m) => address >= m.from && address < m.from + m.size)?.name;
}

/** The name a `local` field goes by: `local.camera.x`, `local.player`. */
export function localName(f: MemoryField): string {
  return f.path[1] ? `local.${f.path[0]}.${f.path[1]}` : `local.${f.path[0]}`;
}

/** A field as the table machinery takes it: one cell, no index. */
export function memoryTableField(f: MemoryField): TableField {
  return { name: f.path.join("."), doc: f.doc, base: f.base, stride: 0, width: f.width, ...(f.readonly ? { readonly: true } : {}) };
}
