// Tetris in StarCraft's text lines (TrigScript 4, S2's showpiece). The screen is JSX: ui.lines() shows it to Player 1
// every frame, redrawn from the program's variables. A D move (hold to slide), W turns, S drops (hold to keep
// dropping), Space drops all the way.
// The pieces and their four turns are worked out when the script is built, in ordinary JavaScript.
// Host it as a multiplayer game, alone: the keys reach the game the way typed lines do.
// Built with
//   npx tsx scripts/build-fixture.mts probes/tetris.tsx fixtures/eud/tetris.scx
import { program, P1, keyPressed, keyHeld, random, sleep, frames, ui, textColors } from "trigscript";

const W = 10;
const H = 10;

// Each piece's four cells in its box, as it first appears.
const PIECES: [number, number][][] = [
  [[0, 1], [1, 1], [2, 1], [3, 1]], // I
  [[1, 0], [2, 0], [1, 1], [2, 1]], // O
  [[1, 0], [0, 1], [1, 1], [2, 1]], // T
  [[1, 0], [2, 0], [0, 1], [1, 1]], // S
  [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
  [[0, 0], [0, 1], [1, 1], [2, 1]], // J
  [[2, 0], [0, 1], [1, 1], [2, 1]], // L
];
const COLORS = [textColors.cyan, textColors.yellow, textColors.purple, textColors.green, textColors.red, textColors.blue, textColors.orange];
const BOX = [4, 4, 3, 3, 3, 3, 3];

/** The cells of piece p turned r times, one after another as x, y: eight numbers a turn, thirty-two a piece. */
const SHAPES: number[] = PIECES.flatMap((cells, p) =>
  [0, 1, 2, 3].flatMap((r) => {
    let turned = cells;
    // The O stays as it is; the others turn a quarter clockwise in their box.
    for (let i = 0; i < r && p !== 1; i++) turned = turned.map(([x, y]) => [BOX[p] - 1 - y, x] as [number, number]);
    return turned.flat();
  }),
);
/** Each piece as it first appears, two rows of four: 1 where it has a cell. For the "next" box. */
const PREVIEW: number[] = PIECES.flatMap((cells) => [0, 1].flatMap((y) => [0, 1, 2, 3].map((x) => (cells.some(([cx, cy]) => cx === x && cy === y) ? 1 : 0))));
const POINTS = [0, 40, 100, 300, 1200];
/** Held, A or D slides after this many frames, then a column every SLIDE frames; S held drops a row every DROP frames. */
const DELAY = 8;
const SLIDE = 2;
const DROP = 2;
const ROWS = [...Array(H).keys()];
const COLS = [...Array(W).keys()];

program(async () => {
  const board: number[] = new Array(W * H).fill(0);
  let piece = random(7), next = random(7), turn = 0, px = 3, py = 0;
  let score = 0, lines = 0, level = 0, over = false, best = 0;

  ui.lines(P1, () => (
    <>
      <line color="yellow">
        TETRIS <span color="white">{score}</span> <span color="sage">lines {lines} level {level + 1}</span>
        {over && <span color="red"> GAME OVER - Space to play again</span>}
      </line>
      {ROWS.map((y) => (
        <line color="lavender">
          |{COLS.map((x) => <cell color={board[y * W + x]} />)}|
          {y === 1 && <span color="white"> next</span>}
          {(y === 2 || y === 3) && [0, 1, 2, 3].map((x) => <cell color={PREVIEW[(next * 2 + y - 2) * 4 + x] ? COLORS[next] : 0} />)}
          {y === 5 && <span color="white"> best {best}</span>}
          {y === 7 && <span color="sage"> A D move (hold), W turn</span>}
          {y === 8 && <span color="sage"> S down (hold), Space drop</span>}
        </line>
      ))}
    </>
  ));

  /** Whether piece p, turned r times, fits with its box's corner at (x, y): inside the walls, on empty cells. */
  function fits(p: number, r: number, x: number, y: number): boolean {
    const at = (p * 4 + r) * 8;
    for (let k = 0; k < 4; k++) {
      const cx = x + SHAPES[at + k * 2];
      const cy = y + SHAPES[at + k * 2 + 1];
      if (cx < 0 || cx >= W || cy >= H) return false;
      if (cy >= 0 && board[cy * W + cx] !== 0) return false;
    }
    return true;
  }

  /** The falling piece written into the board in a colour (0 takes it out again). */
  function place(color: number) {
    const at = (piece * 4 + turn) * 8;
    for (let k = 0; k < 4; k++) {
      const cy = py + SHAPES[at + k * 2 + 1];
      if (cy >= 0) board[cy * W + px + SHAPES[at + k * 2]] = color;
    }
  }

  /** The piece moved and turned, if it fits there. */
  function move(dx: number, dy: number, dr: number): boolean {
    place(0);
    const r = (turn + dr) % 4;
    const ok = fits(piece, r, px + dx, py + dy);
    if (ok) { px += dx; py += dy; turn = r; }
    place(COLORS[piece]);
    return ok;
  }

  /** Full rows taken out, the rows above them moved down. How many there were. */
  function clearRows(): number {
    let cleared = 0;
    let y = H - 1;
    while (y >= 0) {
      let full = true;
      for (let x = 0; x < W; x++) if (board[y * W + x] === 0) full = false;
      if (full) {
        for (let yy = y; yy > 0; yy--) for (let x = 0; x < W; x++) board[yy * W + x] = board[(yy - 1) * W + x];
        for (let x = 0; x < W; x++) board[x] = 0;
        cleared++;
      } else y--;
    }
    return cleared;
  }

  /** The next piece at the top; the game is over when it does not fit there. */
  function spawn() {
    piece = next;
    next = random(7);
    turn = 0;
    px = 3;
    py = 0;
    if (fits(piece, turn, px, py)) place(COLORS[piece]);
    else { over = true; if (score > best) best = score; }
  }

  /** The piece stays where it is; full rows go, and they score. */
  function land() {
    const n = clearRows();
    lines += n;
    score += POINTS[n] * (level + 1);
    level = Math.min(9, Math.floor(lines / 5));
    spawn();
  }

  spawn();
  let wait = 0;
  // How long A, D and S have been held, in frames.
  let left = 0, right = 0, down = 0;
  while (true) {
    if (over) {
      if (keyPressed(P1, "Space")) {
        board.fill(0);
        score = 0; lines = 0; level = 0; over = false;
        spawn();
      }
    } else {
      // A press moves at once; held, the piece slides after a moment, as Tetris does.
      left = keyHeld(P1, "A") ? left + 1 : 0;
      right = keyHeld(P1, "D") ? right + 1 : 0;
      down = keyHeld(P1, "S") ? down + 1 : 0;
      if (keyPressed(P1, "A") || (left > DELAY && left % SLIDE === 0)) move(-1, 0, 0);
      if (keyPressed(P1, "D") || (right > DELAY && right % SLIDE === 0)) move(1, 0, 0);
      // A turn against a wall tries one step in, each way.
      if (keyPressed(P1, "W") && !move(0, 0, 1) && !move(-1, 0, 1)) move(1, 0, 1);
      if (keyPressed(P1, "Space")) { while (move(0, 1, 0)) { /* down to the floor */ } land(); wait = 0; }
      wait++;
      if (keyPressed(P1, "S") || (down > 0 && down % DROP === 0) || wait >= 24 - level * 2) {
        wait = 0;
        if (!move(0, 1, 0)) land();
      }
    }
    await sleep(frames(1));
  }
}, { owner: P1 });
