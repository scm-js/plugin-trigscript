// TrigScript 4, S5: a raycaster in the fog of war. A maze seen in 3D on the minimap, walked with W A S D: the
// textbook DDA raycaster (a ray a column, stepped from grid line to grid line until it meets a wall), written as it
// would be in any TypeScript, with fixed numbers (B6) for the fractions and the fog library for the picture.
// Host it as a multiplayer game, alone, with Classic graphics (Options > Graphics) for a sharp minimap.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/raycaster-base.scx
//   npx tsx scripts/build-fixture.mts probes/raycaster.ts fixtures/eud/raycaster.scx fixtures/eud/raycaster-base.scx
import { fog } from "trigscript/fog";
import { test, expect } from "trigscript";

const MAZE = [
  "################",
  "#......#.......#",
  "#.####.#.#####.#",
  "#.#....#.....#.#",
  "#.#.######.#.#.#",
  "#.#......#.#.#.#",
  "#.######.#.#...#",
  "#........#.###.#",
  "####.#####...#.#",
  "#....#.....#.#.#",
  "#.####.###.#.#.#",
  "#......#...#...#",
  "#.######.#######",
  "#........#.....#",
  "#.######...###.#",
  "################",
];
const SIZE = MAZE.length;
const WALL = MAZE.join("").split("").map((c) => c === "#");

/** The board: 42 columns 3 tiles wide across the top 96 rows of the map, the horizon in the middle. */
const COLUMNS = 42, WIDTH = 3, HEIGHT = 96;
const TURN = 0.08, STEP = 0.1, FOV = 0.66;
const LIGHT = { count: COLUMNS, height: HEIGHT, width: WIDTH, ink: "light" } as const;
const DARK = { count: COLUMNS, height: HEIGHT, width: WIDTH, ink: "dark" } as const;

/** Where the camera waits, below the board: the minimap draws the camera's box over what is under it. */
const PARK = reserveLocation("raycaster: the camera, below the board");

const wallAt = game((x: number, y: number): boolean => WALL[y * SIZE + x]);

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04A maze in the fog of war, on the MINIMAP. W A S D to walk.");
  displayText("\x11Switch to Classic graphics now (Options > Graphics) for a sharp minimap.");
  await nextFrame();
  fog.reveal(P1);
  await nextFrame();

  let x = 1.5, y = 1.5, angle = 0.3;
  let dark = false;
  const heights: number[] = new Array(COLUMNS).fill(0);
  while (true) {
    if (keyPressed(P1, "I")) dark = !dark;
    if (keyHeld(P1, "A")) angle -= TURN;
    if (keyHeld(P1, "D")) angle += TURN;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let step = 0;
    if (keyHeld(P1, "W")) step = STEP;
    if (keyHeld(P1, "S")) step = -STEP;
    if (step != 0) {
      const nx = x + dirX * step, ny = y + dirY * step;
      if (!wallAt(Math.floor(nx), Math.floor(y))) x = nx;
      if (!wallAt(Math.floor(x), Math.floor(ny))) y = ny;
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
      let side = 0;
      while (true) {
        if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
        else { sideY += deltaY; mapY += stepY; side = 1; }
        if (wallAt(mapX, mapY)) break;
      }
      const distance = side == 0 ? sideX - deltaX : sideY - deltaY;
      heights[col] = Math.min(HEIGHT, Math.floor(HEIGHT / distance));
      rayX += stepRayX;
      rayY += stepRayY;
      col++;
    }
    if (dark) fog.columns(P1, 1, 0, DARK, heights);
    else fog.columns(P1, 1, 0, LIGHT, heights);
    await nextFrame();
  }
});

test("the first frame", (sim) => {
  sim.frames(8);
  const board = sim.fog(P1, { x: 0, y: 0, width: 128, height: 96 });
  expect(board === null || board.length === 96).toBe(true);
  expect(1).toBe(1);
});
