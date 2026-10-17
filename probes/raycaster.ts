// TrigScript 4, S5: a raycaster in the fog of war. A maze seen in 3D on the minimap and walked with W A S D: the
// textbook DDA raycaster (a ray a column, stepped from grid line to grid line until it meets a wall), written as it
// would be in any TypeScript, with fixed numbers (B6) for the fractions and the fog library for the picture. Under the
// view, the maze from above with you on it. Walls facing one way are solid, the other way panelled, so corners show.
// Find the way out: the wall that flickers.
// Host it as a multiplayer game, alone, with Classic graphics (Options > Graphics) for a sharp minimap.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/raycaster-base.scx
//   npx tsx scripts/build-fixture.mts probes/raycaster.ts fixtures/eud/raycaster.scx fixtures/eud/raycaster-base.scx
import { fog } from "trigscript/fog";
import { test, expect } from "trigscript";

const MAZE = [
  "################",
  "#......#.......#",
  "#.##...#..#.#..#",
  "#.##......#.#..#",
  "#......#.......#",
  "###.####.###.###",
  "#..............#",
  "#.#.#.#..#.#.#.#",
  "#..............#",
  "####.###.##.####",
  "#......#.......#",
  "#.###..#..###..#",
  "#.#..........#.#",
  "#.#.###..##..#.#",
  "#......#.....#.E",
  "################",
];
const SIZE = MAZE.length;
/** Each cell: 0 floor, 1 wall, 2 the way out. */
const CELLS = MAZE.join("").split("").map((c) => (c === "#" ? 1 : c === "E" ? 2 : 0));

/** The view: 42 columns 3 tiles wide across the top 78 rows of the map. */
const COLUMNS = 42, WIDTH = 3, HEIGHT = 78;
/** A frame of the view is two of the game's: turning and walking are per view frame. */
const TURN = 0.16, STEP = 0.2, FOV = 0.66;
const SHADING = "panelled";
const LIGHT = { count: COLUMNS, height: HEIGHT, width: WIDTH, ink: "light", shading: SHADING } as const;
const DARK = { count: COLUMNS, height: HEIGHT, width: WIDTH, ink: "dark", shading: SHADING } as const;

/** The maze from above, three tiles a cell (a brush is 3 across), under the view and two tiles in from the map's edges. */
const CELL = 3;
const PLAN = fog.picture(MAZE.flatMap((row) => { const r = row.replace(/[#E]/g, "#".repeat(CELL)).replace(/\./g, ".".repeat(CELL)); return Array.from({ length: CELL }, () => r); }));
const PLAN_X = 2, PLAN_Y = HEIGHT;

/** Where the camera waits, beside the plan: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("raycaster: the camera, out of the way");

const cellAt = game((x: number, y: number): number => CELLS[y * SIZE + x]);

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 100 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04A maze in the fog of war, on the MINIMAP. W A S D to walk, I to invert.");
  displayText("\x11Switch to Classic graphics now (Options > Graphics) for a sharp minimap.");
  displayText("\x04Find the way out: the wall that flickers.");
  await nextFrame();
  fog.reveal(P1);
  await nextFrame();

  let x = 1.5, y = 1.5, angle = 0.3;
  let dark = false, out = false, frame = 0;
  const heights: number[] = new Array(COLUMNS).fill(0);
  const shaded: number[] = new Array(COLUMNS).fill(0);
  while (true) {
    frame++;
    if (keyPressed(P1, "I")) dark = !dark;
    if (keyHeld(P1, "A")) angle -= TURN;
    if (keyHeld(P1, "D")) angle += TURN;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let step = 0;
    if (keyHeld(P1, "W")) step = STEP;
    if (keyHeld(P1, "S")) step = -STEP;
    if (step != 0 && !out) {
      const nx = x + dirX * step, ny = y + dirY * step;
      if (cellAt(Math.floor(nx), Math.floor(ny)) == 2) {
        out = true;
        displayText(`\x07You found the way out in ${Math.floor(frame / 12)} seconds.`);
      }
      if (cellAt(Math.floor(nx), Math.floor(y)) == 0) x = nx;
      if (cellAt(Math.floor(x), Math.floor(ny)) == 0) y = ny;
    }

    // The rays sweep the camera plane from its left edge to its right, a column's width a step.
    const planeX = -dirY * FOV, planeY = dirX * FOV;
    const stepRayX = planeX * (2 / fixed(COLUMNS)), stepRayY = planeY * (2 / fixed(COLUMNS));
    let rayX = dirX - planeX + stepRayX / 2, rayY = dirY - planeY + stepRayY / 2;
    let col = 0;
    while (col < COLUMNS) {
      let mapX = Math.floor(x), mapY = Math.floor(y);
      const deltaX = Math.abs(rayX) < 0.01 ? 100 : Math.abs(1 / rayX);
      const deltaY = Math.abs(rayY) < 0.01 ? 100 : Math.abs(1 / rayY);
      let stepX = 1, stepY = 1;
      let sideX = (mapX + 1 - x) * deltaX, sideY = (mapY + 1 - y) * deltaY;
      if (rayX < 0) { stepX = -1; sideX = (x - mapX) * deltaX; }
      if (rayY < 0) { stepY = -1; sideY = (y - mapY) * deltaY; }
      let side = 0, hit = 0;
      while (hit == 0) {
        if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
        else { sideY += deltaY; mapY += stepY; side = 1; }
        hit = cellAt(mapX, mapY);
      }
      const distance = side == 0 ? sideX - deltaX : sideY - deltaY;
      heights[col] = Math.min(HEIGHT, Math.floor(HEIGHT / distance));
      // One face of every wall drawn with lines across it, so that corners show; the way out flickers.
      shaded[col] = side;
      if (hit == 2 && (frame & 2) != 0) heights[col] = 0;
      rayX += stepRayX;
      rayY += stepRayY;
      col++;
    }
    if (dark) fog.columns(P1, 1, 0, DARK, heights, shaded);
    else fog.columns(P1, 1, 0, LIGHT, heights, shaded);
    // The plan, and you on it, blinking.
    fog.light(P1, PLAN_X, PLAN_Y, PLAN);
    if ((frame & 4) != 0) fog.light(P1, PLAN_X + Math.floor(x * CELL), PLAN_Y + Math.floor(y * CELL), 1);
    // A picture every other frame, kept on the board for both: what the minimap shows (it redraws every other frame).
    await fog.show(2);
  }
});

/** The wall heights a raycaster of floating-point numbers sees, for the tests to hold the game's picture against. */
function expectedHeights(x: number, y: number, angle: number): number[] {
  const dirX = Math.cos(angle), dirY = Math.sin(angle), planeX = -dirY * FOV, planeY = dirX * FOV;
  const out: number[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const cam = (2 * c + 1) / COLUMNS - 1;
    const rx = dirX + planeX * cam, ry = dirY + planeY * cam;
    let mx = Math.floor(x), my = Math.floor(y);
    const dx = Math.abs(1 / rx), dy = Math.abs(1 / ry);
    let sx = rx < 0 ? (x - mx) * dx : (mx + 1 - x) * dx, sy = ry < 0 ? (y - my) * dy : (my + 1 - y) * dy;
    let side = 0;
    for (;;) {
      if (sx < sy) { sx += dx; mx += rx < 0 ? -1 : 1; side = 0; } else { sy += dy; my += ry < 0 ? -1 : 1; side = 1; }
      if (CELLS[my * SIZE + mx] !== 0) break;
    }
    out.push(Math.min(HEIGHT, Math.floor(HEIGHT / (side ? sy - dy : sx - dx))));
  }
  return out;
}

/** The lit rows of each column of the view, from the fog: its top and bottom edges. */
function drawnSpans(board: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const x = 1 + c * WIDTH + 1;
    let top = -1, bottom = -1;
    for (let r = 0; r < HEIGHT; r++) if (board[r][x] === "#") { if (top < 0) top = r; bottom = r; }
    out.push([top, bottom]);
  }
  return out;
}

test("the first view is the raycaster's, column by column", (sim) => {
  sim.frames(6);
  const board = sim.fog(P1, { x: 0, y: 0, width: 128, height: HEIGHT });
  if (!board) return; // (The simulator draws no fog.)
  const want = expectedHeights(1.5, 1.5, 0.3);
  const got = drawnSpans(board);
  const off: string[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const a = Math.max(want[c] >> 1, 2);
    const mid = HEIGHT >> 1;
    if (Math.abs(got[c][0] - (mid - a)) > 1 || Math.abs(got[c][1] - (mid + a - 1)) > 1) off.push(`${c}: ${got[c]} for ${want[c]}`);
  }
  expect(off).toEqual([]);
});

test("walking forward brings the wall ahead closer", (sim) => {
  sim.frames(6);
  const before = sim.fog(P1, { x: 0, y: 0, width: 128, height: HEIGHT });
  for (let i = 0; i < 12; i++) sim.press("W").frames(1);
  sim.frames(2);
  const after = sim.fog(P1, { x: 0, y: 0, width: 128, height: HEIGHT });
  if (!before || !after) return;
  const tall = (b: string[]) => { const [top, bottom] = drawnSpans(b)[COLUMNS >> 1]; return bottom - top; };
  expect(tall(after)).toBeGreaterThan(tall(before));
});
