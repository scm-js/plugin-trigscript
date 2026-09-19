/**
 * What `stats()` reaches: the fields of the game's own tables — units.dat, weapons.dat,
 * upgrades.dat, techdata.dat, the player tables — that a program may read and write while
 * the game runs. Every field here was played in StarCraft: Remastered by Magenta's probe
 * maps (its `docs/candidates.md` has the verdict for each); a field the game showed no
 * effect for — game speed, the colour mapping, a unit's position — is left out on purpose.
 *
 * One list drives the runtime (`runtime.ts` makes the objects `stats()` returns from it),
 * the declarations (`declarations.ts` writes the interfaces) and, through the cell each
 * access becomes, the lowering and the simulator. Addresses are 1.16.1's, which
 * Remastered emulates.
 */

export type TableKind = "unit" | "weapon" | "upgrade" | "tech" | "player";

/** How many entries a table has: what an index is checked against. */
export const TABLE_SIZE: Record<TableKind, number> = { unit: 228, weapon: 130, upgrade: 61, tech: 44, player: 12 };

export interface TableField {
  /** The property a script writes: `stats(units.TerranMarine).minerals`. */
  name: string;
  doc: string;
  base: number;
  /** Bytes from one entry to the next. */
  stride: number;
  /** Bytes; `"bit"` for one bit of a dword, at `bit`. */
  width: 1 | 2 | 4 | "bit";
  bit?: number;
  /** Stored = written × scale (256 for hit points, 15 for a game second of build time, 2 for supply). */
  scale?: number;
  /** A true / false field. */
  boolean?: boolean;
  /** The game takes no write (upgrades.dat's level cap). */
  readonly?: boolean;
  /** No one number to read back: a speed is four records, a name a string. */
  writeOnly?: boolean;
  /** Not a plain cell: the lowering has a routine of its own. */
  special?: "speed" | "color" | "name";
  /** The TypeScript type of the property, when it is not `number` / `boolean`. */
  type?: string;
  /** A second index: `stats(P1).upgrades[upgrades.U238Shells]`. The cell is `base + index × stride + key`. */
  keyed?: { kind: TableKind; type: string };
}

const UNIT_FLAGS = 0x664080;
const flag = (name: string, bit: number, doc: string): TableField => ({ name, doc, base: UNIT_FLAGS, stride: 4, width: "bit", bit, boolean: true });

export const TABLE_FIELDS: Record<TableKind, TableField[]> = {
  unit: [
    { name: "maxHp", doc: "Hit points of units made after the write.", base: 0x662350, stride: 4, width: 4, scale: 256 },
    { name: "maxShields", doc: "Shield points of units made after the write.", base: 0x660e00, stride: 2, width: 2 },
    { name: "armor", doc: "Armour, before upgrades.", base: 0x65fec8, stride: 1, width: 1 },
    { name: "minerals", doc: "What the unit costs in minerals.", base: 0x663888, stride: 2, width: 2 },
    { name: "gas", doc: "What the unit costs in gas.", base: 0x65fd00, stride: 2, width: 2 },
    { name: "buildTime", doc: "Seconds to build, on the game's clock; a fraction is fine when the number is known when you build (1.5).", base: 0x660428, stride: 2, width: 2, scale: 15 },
    { name: "supplyUsed", doc: "Supply the unit takes; a Zergling is 0.5.", base: 0x663ce8, stride: 1, width: 1, scale: 2 },
    { name: "supplyProvided", doc: "Supply the unit provides, for the ones made after the write.", base: 0x6646c8, stride: 1, width: 1, scale: 2 },
    { name: "sight", doc: "Sight range in tiles, up to 11.", base: 0x663238, stride: 1, width: 1 },
    { name: "groundWeapon", doc: "The weapon used against ground units (weapons.*); units already on the map switch too.", base: 0x6636b8, stride: 1, width: 1, type: "Weapon" },
    { name: "airWeapon", doc: "The weapon used against air units (weapons.*); weapons.None for none.", base: 0x6616e0, stride: 1, width: 1, type: "Weapon" },
    { name: "size", doc: "What concussive and explosive damage scale by: 0 independent, 1 small, 2 medium, 3 large.", base: 0x662180, stride: 1, width: 1 },
    { name: "speed", doc: "Top speed in pixels a frame (a Marine walks at 4, a Vulture at 6.67), for units made after the write: the type's flingy is switched to table control and given this speed, with acceleration and stopping distance to match. A fraction is fine when the number is known when you build.", base: 0x6c9ef8, stride: 4, width: 4, scale: 256, writeOnly: true, special: "speed" },
    { name: "name", doc: "The name shown for the type: text known when you build.", base: 0x660260, stride: 2, width: 2, writeOnly: true, special: "name", type: "string" },
    flag("detector", 15, "Sees cloaked and burrowed units in its sight range."),
    flag("permanentCloak", 22, "Always cloaked, for units made after the write."),
    flag("cloakable", 9, "Has the ability to cloak (the flag alone gives no button)."),
    flag("burrowable", 20, "Has the ability to burrow (the flag alone gives no button)."),
    flag("regenerates", 7, "Hit points climb back over time, as a Zerg unit's do; units already on the map follow at once."),
    flag("invincible", 29, "Cannot be hurt, for units made after the write."),
    flag("hero", 6, "A hero unit."),
    flag("organic", 16, "A Medic can heal it; units already on the map follow."),
    flag("mechanical", 30, "An SCV can repair it; units already on the map follow."),
    flag("robotic", 14, "Immune to the spells robotic units are immune to."),
  ],
  weapon: [
    { name: "damage", doc: "Damage of one hit, before upgrades.", base: 0x656eb0, stride: 2, width: 2 },
    { name: "bonus", doc: "Extra damage per upgrade level.", base: 0x657678, stride: 2, width: 2 },
    { name: "cooldown", doc: "Frames between attacks.", base: 0x656fb8, stride: 1, width: 1 },
    { name: "factor", doc: "Hits per attack.", base: 0x6564e0, stride: 1, width: 1 },
    { name: "range", doc: "Range in pixels, 32 a tile.", base: 0x657470, stride: 4, width: 4 },
    { name: "minRange", doc: "The least range in pixels: nothing closer can be shot.", base: 0x656a18, stride: 4, width: 4 },
  ],
  upgrade: [
    { name: "minerals", doc: "The first level's mineral cost.", base: 0x655740, stride: 2, width: 2 },
    { name: "gas", doc: "The first level's gas cost.", base: 0x655840, stride: 2, width: 2 },
    { name: "time", doc: "Seconds the first level takes, on the game's clock.", base: 0x655b80, stride: 2, width: 2, scale: 15 },
    { name: "maxLevel", doc: "How many times it can be researched. Read only: the game took no write.", base: 0x655700, stride: 1, width: 1, readonly: true },
  ],
  tech: [
    { name: "minerals", doc: "Mineral cost of the research.", base: 0x656248, stride: 2, width: 2 },
    { name: "gas", doc: "Gas cost of the research.", base: 0x6561f0, stride: 2, width: 2 },
    { name: "time", doc: "Seconds the research takes, on the game's clock.", base: 0x6563d8, stride: 2, width: 2, scale: 15 },
    { name: "energy", doc: "Energy a cast takes.", base: 0x656380, stride: 2, width: 2 },
  ],
  player: [
    { name: "color", doc: "The colour the player's units and minimap dots are drawn in: one of colors.*, or \"teal\". Takes effect at once.", base: 0x581d76, stride: 1, width: 1, writeOnly: true, special: "color", type: "PlayerColor | ColorName" },
    { name: "upgrades", doc: "The player's level of each upgrade: stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3.", base: 0x58d2b0, stride: 46, width: 1, keyed: { kind: "upgrade", type: "Upgrade" } },
    { name: "researched", doc: "Whether the player has each technology: stats(P1).researched[techs.Lockdown] = true.", base: 0x58cf44, stride: 24, width: 1, boolean: true, keyed: { kind: "tech", type: "Tech" } },
  ],
};

/** The palette entries the game's player colours are, by the word a script may write. */
export const PLAYER_COLORS: Record<string, number> = { red: 111, blue: 165, teal: 159, purple: 164, orange: 179, brown: 19, white: 255, yellow: 135, green: 117 };
/** The minimap's entry for a colour is this far from the units' in the player tables. */
export const MINIMAP_COLOR_OFFSET = 0x581dd6 - 0x581d76;

/** The brand a table's index carries in the declarations (`Brand<"unit">`): how the compiler tells `stats(units.X)` from `stats(P3)`. */
export const TABLE_BRAND: Record<TableKind, string> = { unit: "unit", weapon: "weapon", upgrade: "upgrade", tech: "tech", player: "player" };
export const tableOfBrand = (brand: string): TableKind | undefined => (Object.keys(TABLE_BRAND) as TableKind[]).find((k) => TABLE_BRAND[k] === brand);

/** The most a cell holds. */
export const cellMax = (width: 1 | 2 | 4 | "bit"): number => (width === "bit" ? 1 : width === 4 ? 0xffff_ffff : 2 ** (width * 8) - 1);
