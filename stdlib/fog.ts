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

/**
 * One disc: the tiles a brush of `size` covers (SHAPES), centred on tile (x, y). What light() does with a size. A brush
 * is a unit made where SPOT is and taken away again at once; each branch makes its own size's, so that the unit type
 * of the action is known when the script is built (one given by the program costs writing it into the action).
 */
const disc = game((player: Player, x: number, y: number, size: number) => {
  centerLocation(SPOT, x * 32 + 16, y * 32 + 16, 32, 32);
  switch (size) {
    case 0: case 1: createUnit(player, BRUSHES[0], 1, SPOT); removeUnit(player, BRUSHES[0]); break;
    case 2: createUnit(player, BRUSHES[1], 1, SPOT); removeUnit(player, BRUSHES[1]); break;
    case 3: createUnit(player, BRUSHES[2], 1, SPOT); removeUnit(player, BRUSHES[2]); break;
    case 4: createUnit(player, BRUSHES[3], 1, SPOT); removeUnit(player, BRUSHES[3]); break;
    case 5: createUnit(player, BRUSHES[4], 1, SPOT); removeUnit(player, BRUSHES[4]); break;
    case 6: createUnit(player, BRUSHES[5], 1, SPOT); removeUnit(player, BRUSHES[5]); break;
    case 7: createUnit(player, BRUSHES[6], 1, SPOT); removeUnit(player, BRUSHES[6]); break;
    case 8: createUnit(player, BRUSHES[7], 1, SPOT); removeUnit(player, BRUSHES[7]); break;
    case 9: createUnit(player, BRUSHES[8], 1, SPOT); removeUnit(player, BRUSHES[8]); break;
    case 10: createUnit(player, BRUSHES[9], 1, SPOT); removeUnit(player, BRUSHES[9]); break;
    default: createUnit(player, BRUSHES[10], 1, SPOT); removeUnit(player, BRUSHES[10]);
  }
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

/**
 * Light a rectangle of tiles for this frame, worked out while the game runs: its top left on tile (x, y), `width`
 * tiles across and `height` down. Every one of the five may change from frame to frame — the walls of a raycaster, a
 * bar of a chart. It is exact from 3 × 4 up (the smallest brush); a thinner one is lit a brush wide, centred.
 *
 *   fog.rect(P1, 10, 20, 3, wall);        // a column 3 tiles wide, `wall` tall
 *
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param x The column of its left edge.
 * @param y The row of its top edge.
 * @param width How many tiles across.
 * @param height How many tiles down.
 */
export const rect = game((player: Player, x: number, y: number, width: number, height: number) => {
  if (width < 1 || height < 1) return;
  // Size 1 is 3 tiles across and 4 down, its centre the middle column and the third row: a grid of them, the last
  // column and row moved back to end on the edge (overlapping the one before), covers the rectangle exactly.
  const right = Math.max(x + width - 2, x + 1);
  const bottom = Math.max(y + height - 2, y + 2);
  // (The brush made here, not through disc(): its unit type is then known when the script is built, which makes the
  // action a constant — a size from the program costs a branch and a written field a brush.)
  let cy = y + 2;
  while (true) {
    let cx = x + 1;
    while (true) {
      centerLocation(SPOT, cx * 32 + 16, cy * 32 + 16, 32, 32);
      createUnit(player, BRUSHES[0], 1, SPOT);
      removeUnit(player, BRUSHES[0]);
      if (cx >= right) break;
      cx = Math.min(cx + 3, right);
    }
    if (cy >= bottom) break;
    cy = Math.min(cy + 4, bottom);
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

/**
 * How fog.columns() lays its columns out, known when the script is built: `count` columns side by side, each `width`
 * tiles across (3, a brush's width, by default) and up to `height` tiles tall, centred on the middle row. `ink`:
 * "light" lights each column (the walls of a raycaster bright, on fog), "dark" lights all but the columns (dark walls
 * between a lit ceiling and floor); dark is cheaper when columns fill most of the board, light when they are short.
 */
export interface ColumnLayout {
  readonly count: number;
  readonly height: number;
  readonly width?: number;
  readonly ink?: "light" | "dark";
}

/**
 * What fog.columns() reads, worked out once a layout when the script is built: for each level of the drawing that is
 * wider than a column (all the columns, a group of them, the last group) and each depth from 0 to half the height, the
 * brushes that cover a rectangle that wide and that deep exactly — the encoder's covers (cover()), a few large brushes
 * in the middle and small ones at the edges. A brush is a word, dx | dy << 8 | size << 16 from the rectangle's top
 * left; `starts` says where each (level, depth) begins.
 */
interface ColumnPlan { readonly words: readonly number[]; readonly starts: readonly number[]; readonly group: number; readonly half: number }
const columnPlans = new Map<string, ColumnPlan>();
const COLUMN_GROUP = 6;
function columnPlan(layout: ColumnLayout): ColumnPlan {
  const width = layout.width ?? 3, half = layout.height >> 1, group = Math.min(COLUMN_GROUP, layout.count);
  const key = `${layout.count}:${width}:${half}`;
  const had = columnPlans.get(key);
  if (had) return had;
  const words: number[] = [], starts: number[] = [];
  for (const columns of [layout.count, group, layout.count % group || group]) {
    for (let depth = 0; depth <= half; depth++) {
      starts.push(words.length);
      if (depth === 0) continue;
      // A rectangle shallower than a brush is drawn a brush deep, the rest of it on what the level before lit.
      const rows = Array.from({ length: Math.max(depth, 4) }, () => "#".repeat(columns * width));
      for (const b of cover(rows, SHAPES)) words.push(b.x | (b.y << 8) | ((b.shape + 1) << 16));
    }
  }
  starts.push(words.length);
  const made = { words, starts, group, half };
  columnPlans.set(key, made);
  return made;
}

/**
 * One rectangle of fog.columns() wider than a column: the cover at `at` (a level and a depth) drawn twice, the half
 * above the middle and the half below, its top rows `top` and `bottom`, from column `x`.
 */
const columnRect = game((player: Player, words: readonly number[], starts: readonly number[], at: number, x: number, top: number, bottom: number) => {
  let i = starts[at];
  const end = starts[at + 1];
  while (i < end) {
    const w = words[i];
    const dx = x + (w & 255), dy = (w >> 8) & 255, size = w >> 16;
    disc(player, dx, top + dy, size);
    disc(player, dx, bottom + dy, size);
    i++;
  }
});

/**
 * One column's part of fog.columns(): `k` rows, a brush (3 × 4) every 4 of them and the last moved back to end on the
 * edge, twice — from row `top` down and from row `bottom` down — centred on column `x`. What the smallest brush covers
 * exactly, worked out here rather than read: it is the most common rectangle by far.
 */
const columnBar = game((player: Player, x: number, top: number, bottom: number, k: number) => {
  const last = Math.max(k, 4) - 2;
  let r = 2;
  while (true) {
    centerLocation(SPOT, x * 32 + 16, (top + r) * 32 + 16, 32, 32);
    createUnit(player, BRUSHES[0], 1, SPOT);
    removeUnit(player, BRUSHES[0]);
    centerLocation(SPOT, x * 32 + 16, (bottom + r) * 32 + 16, 32, 32);
    createUnit(player, BRUSHES[0], 1, SPOT);
    removeUnit(player, BRUSHES[0]);
    if (r >= last) break;
    r = Math.min(r + 4, last);
  }
});

/**
 * A shaded column of fog.columns(), the other face of a raycaster's walls: hollow — lit along its top and bottom edges,
 * a brush deep, and dark between (light ink), or lit across its middle (dark ink). Two brushes a column, where lines at
 * its quarters took two dozen, and its edges still run to the horizon. `a` is half the column's height; one too short to
 * be hollow is lit whole.
 */
const columnHollow = game((player: Player, cx: number, mid: number, a: number, dark: boolean) => {
  if (dark) { if (a >= 6) columnBar(player, cx, mid - 4, mid, 4); return; }
  if (a < 8) columnBar(player, cx, mid - a, mid, a);
  else columnBar(player, cx, mid - a, mid + a - 4, 4);
});

/**
 * Light columns for this frame — the walls of a raycaster, a bar chart — each as tall as the program says, centred on
 * the layout's middle row. The covers are worked out when the script is built (see ColumnLayout), so a frame costs a
 * brush for each part of the picture that differs from its neighbours, not one for every few tiles: a wall that fills
 * the board is a few large brushes.
 *
 *   const VIEW = { count: 42, height: 96, ink: "dark" } as const;
 *   fog.columns(P1, 1, 0, VIEW, heights);           // heights: one a column, in tiles, the program's
 *   fog.columns(P1, 1, 0, VIEW, heights, shaded);   // shaded: 1 for a column drawn hollow, 0 whole
 *
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param x The column of the layout's left edge.
 * @param y The row of its top edge.
 * @param layout How the columns are laid out: known when the script is built.
 * @param heights Each column's height in tiles (0 to the layout's height), an array of the program's.
 * @param shaded Which columns are drawn hollow (not 0) — the other face of a raycaster's walls, so that a corner
 *   shows — an array of the program's as long as `heights`. Optional.
 */
export const columns = game((player: Player, x: number, y: number, layout: ColumnLayout, heights: readonly number[], shaded?: readonly number[]) => {
  const { words, starts, half, group } = columnPlan(layout);
  const count = layout.count, width = layout.width ?? 3, dark = layout.ink === "dark";
  const span = half + 1;
  // Each column's depth from where its lit part starts: the middle row for light ink, the top and bottom for dark.
  // A shaded column of light ink is drawn on its own, after the rest: to the rest it is as if it were not there.
  const depth: number[] = new Array(count).fill(0);
  let least = half;
  let i = 0;
  while (i < count) {
    const a = Math.min(Math.max(heights[i] >> 1, 0), half);
    let d = dark ? half - a : a;
    if (shaded !== undefined && !dark && shaded[i] != 0) d = 0;
    depth[i] = d;
    if (d < least) least = d;
    i++;
  }
  // A rectangle from depth p, k deep, starts on the rows above and below the middle (light) or below the top and above
  // the bottom (dark); one shallower than 4 is drawn 4 deep, reaching back over what is lit already.
  const mid = y + half;
  // Every column, from depth 0 to the least.
  if (least > 0) {
    const k = Math.max(least, 4);
    if (dark) columnRect(player, words, starts, least, x, y + least - k, y + 2 * half - least);
    else columnRect(player, words, starts, least, x, mid - least, mid + least - k);
  }
  // Each group of columns, from the least to the group's least; then each column, from there to its own.
  let g = 0;
  while (g < count) {
    const last = Math.min(g + group, count);
    let gl = half;
    let j = g;
    while (j < last) { if (depth[j] < gl) gl = depth[j]; j++; }
    const level = last - g === group ? 1 : 2;
    if (gl > least) {
      const k = gl - least, kk = Math.max(k, 4);
      if (dark) columnRect(player, words, starts, level * span + k, x + g * width, y + gl - kk, y + 2 * half - gl);
      else columnRect(player, words, starts, level * span + k, x + g * width, mid - gl, mid + gl - kk);
    }
    j = g;
    while (j < last) {
      const k = depth[j] - gl;
      if (k > 0) {
        const kk = Math.max(k, 4), cx = x + j * width + 1;
        if (dark) columnBar(player, cx, y + depth[j] - kk, y + 2 * half - depth[j], k);
        else columnBar(player, cx, mid - depth[j], mid + depth[j] - kk, k);
      }
      j++;
    }
    g = last;
  }
  if (shaded !== undefined) {
    i = 0;
    while (i < count) {
      if (shaded[i] != 0) columnHollow(player, x + i * width + 1, mid, Math.min(Math.max(heights[i] >> 1, 0), half), dark);
      i++;
    }
  }
});

/** Everything above as one name: import { fog } from "trigscript/fog"; fog.light(P1, x, y, 3). */
export const fog = { light, rect, columns, play, reveal, picture, SHAPES };

// The canvas: every brush's sight set, every frame, and the board wiped on the next — for as long as the game runs.
program(() => {
  while (true) {
    for (let s = 1; s <= 11; s++) stats(BRUSHES[s - 1]).sight = s;
    memory.vision.countdown = 1;
    sleep(frames(1));
  }
});
