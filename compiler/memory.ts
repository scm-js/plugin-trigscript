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
];

/** A field as the table machinery takes it: one cell, no index. */
export function memoryTableField(f: MemoryField): TableField {
  return { name: f.path.join("."), doc: f.doc, base: f.base, stride: 0, width: f.width, ...(f.readonly ? { readonly: true } : {}) };
}
