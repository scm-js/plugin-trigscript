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
  discPx(player, x * 32 + 16, y * 32 + 16, size);
});

/**
 * disc() in pixels, (px, py) the centre of the tile: what a caller with many brushes uses, its products by 32 worked
 * out once and the brushes' offsets added (a product by 32 of a number the game holds is a test a bit, about 0.4 µs).
 */
const discPx = game((player: Player, px: number, py: number, size: number) => {
  centerLocation(SPOT, px, py, 32, 32);
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
  else {
    // The picture's corner in pixels once; each brush is its offset from there (a constant of a picture).
    const px = x * 32 + 16, py = y * 32 + 16;
    if ("brushes" in shape) for (const b of shape.brushes) discPx(player, px + b.x * 32, py + b.y * 32, b.size);
    else {
      const { words, starts } = film(shape);
      const end = starts[frame + 1];
      for (let i = starts[frame]; i < end; i++) {
        const w = words[i];
        // (A row's offset in pixels straight from its byte: the same as ((w >> 8) & 255) * 32, and the shift only has
        // the byte's eight bits to look at.)
        discPx(player, px + (w & 255) * 32, py + ((w & 0xff00) >> 3), w >> 16);
      }
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
  /**
   * How the walls are told apart, with fog.columns()'s `faces`. "outline", the default: every wall drawn as its edges —
   * its top and bottom, a brush deep, and a column lit whole wherever one face meets another (on the nearer of the
   * two) — so that blocks read as boxes, the look of the raycasters of monochrome screens; with dark ink, the edges are
   * lit lines through dark walls. A few brushes a column. Chosen over the rest when played (2026-10-17).
   *
   * The others shade the faces whose number is odd (a raycaster's other side) and leave the rest whole: "hollow" —
   * dark, lit only along its top and bottom edges; "ribbed" — hollow and lit across the middle of each half; "panelled"
   * — hollow and lit across its quarters; "line" / "lines" — dark lines a tile thick across it at its middle or its
   * quarters (the finest, and two dozen brushes a column near the eye: for a view with room to spare).
   */
  readonly shading?: "outline" | "lines" | "line" | "hollow" | "ribbed" | "panelled";
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
  // In pixels once; each brush is its offset (a few bits, a few tests) from there.
  const px = x * 32 + 16, pt = top * 32 + 16, pb = bottom * 32 + 16;
  while (i < end) {
    const w = words[i];
    const dx = (w & 255) * 32, dy = (w & 0xff00) >> 3, size = w >> 16;
    discPx(player, px + dx, pt + dy, size);
    discPx(player, px + dx, pb + dy, size);
    i++;
  }
});

/**
 * One column's part of fog.columns(), in pixels: brushes (3 × 4) a column of 4 rows apart and the last moved back to
 * end on the edge, twice — from `pt` and from `pb`, the centres of the first brush of each — down a column `k32`
 * pixels deep (32 a row; under 4 rows, a brush deep), centred on `px`. What the smallest brush covers exactly, worked out
 * here rather than read: it is the most common rectangle by far. In pixels because the caller has them, stepped: a
 * product by 32 of a number the game holds is a test a bit, about 0.4 µs, where a step is an add.
 */
const columnBarPx = game((player: Player, px: number, pt: number, pb: number, k32: number) => {
  // How far down the last brush is from the first.
  const end = Math.max(k32, 128) - 128;
  let r = 0;
  while (true) {
    centerLocation(SPOT, px, pt, 32, 32);
    createUnit(player, BRUSHES[0], 1, SPOT);
    removeUnit(player, BRUSHES[0]);
    centerLocation(SPOT, px, pb, 32, 32);
    createUnit(player, BRUSHES[0], 1, SPOT);
    removeUnit(player, BRUSHES[0]);
    if (r >= end) break;
    const step = Math.min(end - r, 128);
    r += step;
    pt += step;
    pb += step;
  }
});

/** columnBarPx() in tiles: `k` rows from row `top` down and from row `bottom` down, centred on column `x`. */
const columnBar = game((player: Player, x: number, top: number, bottom: number, k: number) => {
  columnBarPx(player, x * 32 + 16, top * 32 + 80, bottom * 32 + 80, k * 32);
});

/**
 * A shaded column of fog.columns() (ColumnLayout's `shading`): `a` is half its height, `lines` how many lines across
 * each half — 0 hollow, 1 at its middle, 3 at its quarters. A line is a dark row through a lit column (light ink), or
 * a lit band a brush deep through a dark one; a column too short for its lines is drawn plain.
 */
const columnShaded = game((player: Player, cx: number, mid: number, a: number, dark: boolean, lines: number) => {
  if (lines <= 0) {
    if (dark) { if (a >= 6) columnBar(player, cx, mid - 4, mid, 4); }
    else if (a < 8) columnBar(player, cx, mid - a, mid, a);
    else {
      // Hollow: the edges. Ribbed (-1) and panelled (-3): bands across each half too, centred on its middle or
      // quarters, where there is room for them between the edges.
      columnBar(player, cx, mid - a, mid + a - 4, 4);
      const ribs = -lines;
      if (ribs > 0 && a >= 6 * (ribs + 1)) {
        let k = 1;
        while (k <= ribs) {
          const at = (a * k) / (ribs + 1);
          columnBar(player, cx, mid - at - 2, mid + at - 2, 4);
          k++;
        }
      }
    }
  } else if (a < 5 * (lines + 1)) {
    if (!dark) columnBar(player, cx, mid - a, mid, a);
  } else {
    // From the middle out: lit up to each line, the line's row dark (light ink); or a lit band on each line (dark ink).
    let from = 0, k = 1;
    while (k <= lines + 1) {
      const to = k > lines ? a : (a * k) / (lines + 1);
      if (dark) { if (k <= lines) columnBar(player, cx, mid - to - 2, mid + to - 2, 4); }
      else columnBar(player, cx, mid - to, mid + from, to - from);
      from = to + 1;
      k++;
    }
  }
});

/**
 * Light columns for this frame — the walls of a raycaster, a bar chart — each as tall as the program says, centred on
 * the layout's middle row. The covers are worked out when the script is built (see ColumnLayout), so a frame costs a
 * brush for each part of the picture that differs from its neighbours, not one for every few tiles: a wall that fills
 * the board is a few large brushes.
 *
 *   const VIEW = { count: 42, height: 96, ink: "dark" } as const;
 *   fog.columns(P1, 1, 0, VIEW, heights);          // heights: one a column, in tiles, the program's
 *   fog.columns(P1, 1, 0, VIEW, heights, faces);   // faces: which face of which wall each column shows
 *
 * @param player Whose fog: P1 … P8, known when the script is built.
 * @param x The column of the layout's left edge.
 * @param y The row of its top edge.
 * @param layout How the columns are laid out: known when the script is built.
 * @param heights Each column's height in tiles (0 to the layout's height), an array of the program's.
 * @param faces Which face of which wall each column shows, a number the same for every column of one face — in a
 *   raycaster, \`(mapY * width + mapX) * 2 + side\` — an array of the program's as long as `heights`: what the
 *   layout's `shading` tells walls apart by. Optional: without it, every column is lit whole (a bar chart).
 */
export const columns = game((player: Player, x: number, y: number, layout: ColumnLayout, heights: readonly number[], faces?: readonly number[]) => {
  const { words, starts, half, group } = columnPlan(layout);
  const count = layout.count, width = layout.width ?? 3, dark = layout.ink === "dark";
  // (Dark lines through a lit column count up; lit bands through a dark one, ribbed and panelled, down.)
  // (Without faces there is nothing to tell apart, and every column is whole.)
  const outline = faces !== undefined && (layout.shading === undefined || layout.shading === "outline");
  const lines = layout.shading === "lines" ? 3 : layout.shading === "line" ? 1 : layout.shading === "ribbed" ? -1 : layout.shading === "hollow" ? 0 : -3;
  const span = half + 1;
  // Each column's depth from where its lit part starts: the middle row for light ink, the top and bottom for dark.
  // A shaded column of light ink is drawn on its own, after the rest: to the rest it is as if it were not there — and
  // so is every column of a light outline, which is all edges.
  const depth: number[] = new Array(count).fill(0);
  // Half of each column's height, at most half the layout's: worked out once. (Clamped before the shift, the same
  // number: the shift then has the few bits the clamp leaves, where a height from the program could have any.)
  const halves: number[] = new Array(count).fill(0);
  // And in pixels (32 a row), for the bars, which place their brushes in pixels: a small number times 32 is a few tests.
  const halves32: number[] = new Array(count).fill(0);
  let least = half, most = 0;
  // (A light outline is all edges: every depth is 0, nothing to work out.)
  const flat = !dark && outline;
  if (flat) least = 0;
  let i = 0;
  while (i < count) {
    const a = Math.min(Math.max(heights[i], 0), 2 * half + 1) >> 1;
    halves[i] = a;
    halves32[i] = a * 32;
    if (!flat) {
      let d = dark ? half - a : a;
      if (faces !== undefined && !dark && !outline && (faces[i] & 1) != 0) d = 0;
      depth[i] = d;
      if (d < least) least = d;
      if (d > most) most = d;
    }
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
  // Each group of columns, from the least to the group's least; then each column, from there to its own. (Nothing,
  // when every column's depth is the least: a light outline's always.)
  let g = most > least ? 0 : count;
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
  if (outline) {
    // Where one face meets another, the nearer (taller) of the two columns is an edge.
    const edge: number[] = new Array(count).fill(0);
    let face = faces[0], tall = heights[0];
    i = 1;
    while (i < count) {
      const f = faces[i], h = heights[i];
      if (f != face) { if (h >= tall) edge[i] = 1; else edge[i - 1] = 1; }
      face = f;
      tall = h;
      i++;
    }
    // The bars in pixels: a column's centre stepped across, the middle row's worked out once.
    const mid80 = mid * 32 + 80;
    let px = (x + 1) * 32 + 16;
    i = 0;
    while (i < count) {
      const a = halves[i], a32 = halves32[i];
      if (dark) { if (edge[i] != 0 && a >= 2) columnBarPx(player, px, mid80 - a32, mid80, a32); }
      else if (a > 0) {
        if (edge[i] != 0 || a < 8) columnBarPx(player, px, mid80 - a32, mid80, a32);
        else columnBarPx(player, px, mid80 - a32, mid80 + a32 - 128, 128);
      }
      px += width * 32;
      i++;
    }
  } else if (faces !== undefined) {
    i = 0;
    while (i < count) {
      if ((faces[i] & 1) != 0) columnShaded(player, x + i * width + 1, mid, halves[i], dark, lines);
      i++;
    }
  }
});

/**
 * Keep what was lit this frame on the board for `n` frames, and wait them out: \`await fog.show(2)\` in place of
 * \`await nextFrame()\` draws every other frame at half the cost. StarCraft: Remastered redraws the fog on the minimap
 * every other frame (measured in two played recordings, 2026-10-17), so a picture drawn every other frame looks the
 * same there as one drawn every frame. The board is wiped at the start of the frame after them, ready for the next.
 *
 * @param n How many frames, 1 to 24, known when the script is built.
 */
export const show = game(async (n: number) => {
  memory.vision.countdown = n;
  await sleep(frames(n));
});

/** Everything above as one name: import { fog } from "trigscript/fog"; fog.light(P1, x, y, 3). */
export const fog = { light, rect, columns, show, play, reveal, picture, SHAPES };

/** The longest fog.show() keeps a picture: the countdown the game sets itself after a wipe is longer than this. */
const SHOW_MOST = 24;

// The canvas: every brush's sight set, every frame, and the board wiped on the next — for as long as the game runs —
// unless a program asked for the picture to stay (fog.show), when the countdown is that program's to run down.
program(() => {
  while (true) {
    for (let s = 1; s <= 11; s++) stats(BRUSHES[s - 1]).sight = s;
    const left = memory.vision.countdown;
    if (left == 0 || left > SHOW_MOST) memory.vision.countdown = 1;
    sleep(frames(1));
  }
});
