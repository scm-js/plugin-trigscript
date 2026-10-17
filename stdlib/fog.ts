/**
 * Fog of war as a picture: the standard library's "trigscript/fog" (TrigScript 4).
 *
 *   import { fog } from "trigscript/fog";
 *
 *   const heart = fog.picture([".##.##.", "#######", ".#####.", "..###.."]);
 *
 *   program(async () => {
 *     fog.reveal(P1);                  // the whole map lit once: from now on dark is fog, not black
 *     while (true) {
 *       fog.light(P1, 30, 20, 5);       // a disc of size 5 around tile (30, 20), this frame only
 *       fog.light(P1, 60, 40, heart);   // a picture, its top left on tile (60, 40)
 *       await nextFrame();
 *     }
 *   });
 *
 * The fog is a canvas that starts every frame dark: what a program lights this frame is what shows this frame, and
 * nothing else needs doing. There is no dark brush — the game's sight only ever reveals — so dark is whatever is not
 * lit; to draw dark shapes, light around them (a picture with `{ ink: "dark" }`). Dark is also the sharper ink: a lit
 * part is at least a brush wide (3 tiles across, 4 down), while a dark line one tile wide stays exactly that. Nothing
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
import { game, program, sleep, frames, stats, units, createUnit, removeUnit, centerLocation, reserveLocation, memory, cover, nextFrame, type Player, type UnitType, type Video } from "trigscript";

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

/** One disc: the tiles a brush of `size` covers (SHAPES), centred on tile (x, y). What light() does with a size. */
const disc = game((player: Player, x: number, y: number, size: number) => {
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
    for (let x = 2; x < width + 12; x += 14) disc(player, Math.min(x, width - 3), Math.min(y, height - 3), 11);
  }
});

/** A picture for the fog, made when the script is built: its size in tiles and the brushes that draw it. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  readonly brushes: readonly { readonly x: number; readonly y: number; readonly size: number }[];
}

/**
 * A picture from rows of text, worked out when the script is built: `#` is the ink, anything else is not.
 *
 *   fog.picture(["..##..", ".####.", "######"])                     // light ink: the # tiles are lit
 *   fog.picture(["..##..", ".####.", "######"], { ink: "dark" })    // dark ink: the # tiles stay dark, the rest is lit
 *
 * With light ink a lit part thinner than a brush (3 tiles across, 4 down) is drawn a tile or two thicker. With dark
 * ink every tile of the picture's rectangle that is not `#` is lit and the `#` tiles keep their shape exactly,
 * however thin — the ink for line art and silhouettes.
 */
export function picture(rows: readonly string[], options: { readonly ink?: "light" | "dark" } = {}): Picture {
  const height = rows.length;
  const width = Math.max(0, ...rows.map((r) => r.length));
  // Dark ink: the picture's rectangle lit but for the # tiles, so what is covered is the rest.
  const ink = options.ink === "dark" ? Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (rows[y][x] === "#" ? "." : "#")).join("")) : rows;
  const brushes = cover(ink, SHAPES).map((b) => ({ x: b.x, y: b.y, size: b.shape + 1 }));
  return Object.freeze({ width, height, brushes: Object.freeze(brushes) });
}

/**
 * A video's frames as brushes, worked out when the script is built: a word a brush (x | y << 8 | size << 16), the
 * frames one after another, and where each one starts — the tables the game reads a frame from. Once a build.
 */
interface Film { readonly words: readonly number[]; readonly starts: readonly number[] }
const films = new Map<Video, Film>();
function film(video: Video): Film {
  const had = films.get(video);
  if (had) return had;
  const words: number[] = [], starts: number[] = [0];
  for (const brushes of cover(video, SHAPES)) {
    for (const b of brushes) words.push(b.x | (b.y << 8) | ((b.shape + 1) << 16));
    starts.push(words.length);
  }
  const made = { words, starts };
  films.set(video, made);
  return made;
}

/**
 * Light the fog for this frame: a disc, a picture or a frame of a video. Tiles count from the map's top left, (0, 0).
 *
 *   fog.light(P1, 30, 20, 5);              // a disc of size 5 centred on tile (30, 20)
 *   fog.light(P1, 60, 40, heart);          // a picture (fog.picture), its top left on tile (60, 40)
 *   fog.light(P1, 0, 0, badApple, f);      // frame f of a video the script imports, its top left on tile (0, 0)
 *
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param x The tile's column: a disc's centre, a picture's left edge.
 * @param y The tile's row: a disc's centre, a picture's top edge.
 * @param shape A size, 1 (3 tiles wide) to 11 (23 wide) — it may change while the game runs — a picture, or a video.
 * @param frame Of a video, which frame, from 0: it may change while the game runs. Past the end, nothing is lit.
 */
export const light = game((player: Player, x: number, y: number, shape: number | Picture | Video, frame: number = 0) => {
  if (typeof shape === "number") disc(player, x, y, shape);
  else if ("brushes" in shape) for (const b of shape.brushes) disc(player, x + b.x, y + b.y, b.size);
  else {
    const { words, starts } = film(shape);
    const end = starts[frame + 1];
    for (let i = starts[frame]; i < end; i++) {
      const w = words[i];
      disc(player, x + (w & 255), y + ((w >> 8) & 255), w >> 16);
    }
  }
});

/**
 * Play a video in the fog, a frame of it every frame of the game, from its first to its last; resolves when it ends.
 * Inside an async program: `await fog.play(P1, badApple)`. On Fastest a game frame is 42 ms, which is what Import
 * Video makes a video's frames by default; the game runs a little slower when a frame is heavy, and so does the video.
 *
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param video A video the script imports.
 * @param x The column of its left edge, 0 by default.
 * @param y The row of its top edge, 0 by default.
 */
export const play = game(async (player: Player, video: Video, x: number = 0, y: number = 0) => {
  // (A while: a for over a length known when the script is built would be unrolled, a copy of the body a frame.)
  let f = 0;
  while (f < video.length) {
    light(player, x, y, video, f);
    await nextFrame();
    f++;
  }
});

/** Everything above as one name: import { fog } from "trigscript/fog"; fog.light(P1, x, y, 3). */
export const fog = { light, play, reveal, picture, SHAPES };

// The canvas: every brush's sight set, every frame, and the board wiped on the next — for as long as the game runs.
program(() => {
  while (true) {
    for (let s = 1; s <= 11; s++) stats(BRUSHES[s - 1]).sight = s;
    memory.vision.countdown = 1;
    sleep(frames(1));
  }
});
