/**
 * Fog of war as a picture: the standard library's "trigscript/fog" (TrigScript 4).
 *
 *   import { fog } from "trigscript/fog";
 *
 *   program(async () => {
 *     fog.reveal(P1);                              // the whole map lit once: from now on dark is fog, not black
 *     const heart = fog.picture(["#.#", "###", ".#."]);
 *     while (true) {
 *       fog.draw(P1, heart, 60, 40);               // this frame only
 *       await nextFrame();
 *     }
 *   });
 *
 * The fog is a canvas cleared every frame: what a program lights this frame is what shows this frame, and nothing
 * else needs doing — the library writes the game's vision countdown after every frame (memory.vision.countdown), so
 * the next frame starts from a wiped board. Watch it on the minimap with Classic graphics (Options > Graphics): a tile
 * of the map is a pixel there, sharp; Remastered graphics blurs it a few tiles wide.
 *
 * How it draws, played in StarCraft: Remastered (2026-10-17): a brush is a unit made on a tile and taken away in the
 * same trigger pass; the tiles its sight revealed stay lit through the frame. A brush's size is the unit's sight
 * range, so each size is a unit type of its own — the flying heroes below, which no ordinary map places — whose sight
 * is set every frame (Remastered takes a sight write a frame late, so one type cannot change size within a frame).
 * Coordinates are tiles, (0, 0) the map's top left. About 800 brushes a frame is the most the game makes: it keeps a
 * removed unit's place until the next frame.
 */
import { game, program, sleep, frames, stats, units, createUnit, removeUnit, centerLocation, reserveLocation, memory, type Player, type UnitType } from "trigscript";

/**
 * Each brush's shape, sizes 1 to 11: the tiles a flying unit of that sight range reveals, read out of the game.
 * "@" is the tile the brush is centred on. The game's air sight leaves the centre's row one short below, so every
 * shape reaches a row further up than down.
 */
export const SHAPES: readonly (readonly string[])[] = [
  // 1
  ["###", "###", "#@#", "###"],
  // 2
  [".###.", "#####", "#####", "##@##", "#####", "#####"],
  // 3
  ["..###..", "#######", "#######", "#######", "###@###", "#######", "#######", "#######"],
  // 4
  ["..#####...", ".#######..", "#########.", "##########", "##########", "####@#####", "##########", "##########", "#########.", ".#######..", "......#..."],
  // 5
  ["...#####....", "..#######...", ".#########..", "###########.", "############", "############", "#####@######", "############", "############", "###########.", ".#########..", "..#######...", ".......#...."],
  // 6
  ["....#####.....", "..#########...", ".###########..", "#############.", "#############.", "##############", "##############", "######@#######", "##############", "##############", "#############.", "#############.", ".###########..", "..#########...", "........#....."],
  // 7
  [".....#####......", "...#########....", "..###########...", ".#############..", "###############.", "###############.", "################", "################", "#######@########", "################", "################", "###############.", "###############.", ".#############..", "..###########...", "...#########....", ".........#......"],
  // 8
  ["......#####.......", "....#########.....", "..#############...", ".###############..", ".###############..", "#################.", "#################.", "##################", "##################", "########@#########", "##################", "##################", "#################.", "#################.", ".###############..", ".###############..", "..#############...", "....#########.....", "..........#......."],
  // 9
  ["......#######.......", "....###########.....", "...#############....", "..###############...", ".#################..", "###################.", "###################.", "####################", "####################", "####################", "#########@##########", "####################", "####################", "####################", "###################.", "###################.", ".#################..", "..###############...", "...#############....", "....###########.....", "........#####......."],
  // 10
  [".......#######........", ".....###########......", "....#############.....", "..#################...", "..#################...", ".###################..", "#####################.", "#####################.", "######################", "######################", "######################", "##########@###########", "######################", "######################", "######################", "#####################.", "#####################.", ".###################..", "..#################...", "..#################...", "....#############.....", ".....###########......", ".........#####........"],
  // 11
  ["........#######.........", "......###########.......", "....###############.....", "...#################....", "..###################...", ".#####################..", ".#####################..", "#######################.", "#######################.", "########################", "########################", "########################", "###########@############", "########################", "########################", "########################", "#######################.", "#######################.", ".#####################..", ".#####################..", "..###################...", "...#################....", "....###############.....", "......###########.......", "..........#####........."],
];

/** Each size's unit, size 1 first: flying heroes without a sight upgrade. A map that places one gets odd sight from it. */
const BRUSHES: readonly UnitType[] = [
  units.KukulzaMutalisk, units.KukulzaGuardian, units.YggdrasillOverlord, units.MagellanScienceVessel,
  units.GantrithorCarrier, units.HyperionBattlecruiser, units.NoradIIBattlecruiser, units.TomKazanskyWraith,
  units.DanimothArbiter, units.MojoScout, units.ArtanisScout,
];

/** Where each brush is made: a location the map does not use, taken when the script is built. */
const SPOT = reserveLocation("fog: where each brush is made");

/** One brush: the unit made where SPOT is, and taken away again at once. */
const brush = game((player: Player, type: UnitType) => {
  createUnit(player, type, 1, SPOT);
  removeUnit(player, type);
});

/**
 * Light the fog around a tile for this frame: the tiles a brush of `size` covers (SHAPES), centred on (x, y).
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param x The tile's column, from the map's left edge.
 * @param y The tile's row, from the map's top edge.
 * @param size 1 (3 tiles wide) to 11 (23 wide).
 */
export const light = game((player: Player, x: number, y: number, size: number) => {
  centerLocation(SPOT, x * 32 + 16, y * 32 + 16, 32, 32);
  if (size <= 1) brush(player, BRUSHES[0]);
  else if (size == 2) brush(player, BRUSHES[1]);
  else if (size == 3) brush(player, BRUSHES[2]);
  else if (size == 4) brush(player, BRUSHES[3]);
  else if (size == 5) brush(player, BRUSHES[4]);
  else if (size == 6) brush(player, BRUSHES[5]);
  else if (size == 7) brush(player, BRUSHES[6]);
  else if (size == 8) brush(player, BRUSHES[7]);
  else if (size == 9) brush(player, BRUSHES[8]);
  else if (size == 10) brush(player, BRUSHES[9]);
  else brush(player, BRUSHES[10]);
});

/**
 * Light the whole map once, so that from now on a tile left dark shows as fog (grey) rather than as never seen
 * (black) — every picture then has the same two tones. Takes one frame.
 * @param player Whose fog: P1 … P8, known when the script is built.
 */
export const reveal = game((player: Player) => {
  const width = memory.map.width;
  const height = memory.map.height;
  // Size 11 is 23 tiles wide: a brush every 14 tiles leaves no gap, and one more past the end, kept inside, reaches the edge.
  for (let y = 2; y < height + 12; y += 14) {
    for (let x = 2; x < width + 12; x += 14) light(player, Math.min(x, width - 3), Math.min(y, height - 3), 11);
  }
});

/** A picture for the fog, made when the script is built: its size in tiles and the brushes that draw it. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  readonly brushes: readonly { readonly x: number; readonly y: number; readonly size: number }[];
}

/**
 * A picture from rows of text, worked out when the script is built: each `lit` character is a tile lit, anything
 * else a tile left dark. The smallest brush is three tiles wide and four tall, so a lit part thinner than that is
 * drawn a tile or two thicker; a dark part keeps every tile, however thin.
 * @example fog.picture(["..##..", ".####.", "######"])
 */
export function picture(rows: readonly string[], lit = "#"): Picture {
  const height = rows.length;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const on = (x: number, y: number) => y >= 0 && y < height && x >= 0 && rows[y][x] === lit;
  const offsets = SHAPES.map((shape) => {
    const cy = shape.findIndex((r) => r.includes("@")), cx = shape[cy].indexOf("@");
    const out: [number, number][] = [];
    shape.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] !== ".") out.push([x - cx, y - cy]); });
    return out;
  });
  const covered = new Set<number>();
  const key = (x: number, y: number) => y * 4096 + x;
  let left = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (on(x, y)) left++;
  // Every brush that lights only lit tiles, largest first; then the one that lights the most not yet lit, again and again.
  const fits: { x: number; y: number; size: number; tiles: number[] }[] = [];
  offsets.forEach((shape, i) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (shape.every(([dx, dy]) => on(x + dx, y + dy))) fits.push({ x, y, size: i + 1, tiles: shape.map(([dx, dy]) => key(x + dx, y + dy)) });
    }
  });
  const brushes: { x: number; y: number; size: number }[] = [];
  while (left > 0 && fits.length) {
    let best = -1, gain = 0;
    fits.forEach((f, i) => { const g = f.tiles.filter((t) => !covered.has(t)).length; if (g > gain) { gain = g; best = i; } });
    if (best < 0) break;
    const f = fits[best];
    brushes.push({ x: f.x, y: f.y, size: f.size });
    for (const t of f.tiles) if (!covered.has(t)) { covered.add(t); left--; }
  }
  // A lit line thinner than three tiles: a size-1 brush on each tile still dark, lighting a dark tile or two beside it.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!on(x, y) || covered.has(key(x, y))) continue;
    brushes.push({ x, y, size: 1 });
    for (const [dx, dy] of offsets[0]) covered.add(key(x + dx, y + dy));
  }
  return Object.freeze({ width, height, brushes: Object.freeze(brushes.sort((a, b) => a.size - b.size)) });
}

/**
 * Draw a picture for this frame, its top left on tile (x, y).
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param pic A picture made when the script is built: fog.picture([…]).
 */
export const draw = game((player: Player, pic: Picture, x: number, y: number) => {
  for (const b of pic.brushes) light(player, x + b.x, y + b.y, b.size);
});

/** Everything above as one name: import { fog } from "trigscript/fog"; fog.light(P1, x, y, 3). */
export const fog = { light, reveal, picture, draw, SHAPES };

// The canvas: every brush's sight set, every frame, and the board wiped on the next — for as long as the game runs.
program(() => {
  while (true) {
    for (let s = 1; s <= 11; s++) stats(BRUSHES[s - 1]).sight = s;
    memory.vision.countdown = 1;
    sleep(frames(1));
  }
});
