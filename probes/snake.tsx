// Snake on the minimap, with its score in the text lines (TrigScript 4): the standard library's two screens together.
// "trigscript/screen" draws the board — a pixel an Overlord, the minimap showing it — and "trigscript/ui" the panel,
// the meter and the menu after a game. W A S D steer; the snake grows by one at each apple and speeds up every five.
// When it runs into itself or a wall, a menu: Up and Down, Enter.
// Remastered will not start a game without a computer, and a computer moves its own units, so Player 2 is a computer
// that owns no pixel; P3 … P8 and you own them, each given a colour the text lines also draw.
// Host it as a multiplayer game, alone: the keys reach the game the way typed lines do.
// probe-players: {"0":{"rgb":[19,255,29]},"2":{"rgb":[0,255,255]},"3":{"rgb":[255,255,73]},"4":{"rgb":[165,77,189]},"5":{"rgb":[255,5,5]},"6":{"rgb":[15,87,247]},"7":{"rgb":[255,169,24]}}
// Built with
//   npx tsx scripts/build-fixture.mts probes/snake.tsx fixtures/eud/snake.scx
import { program, P1, keyPressed, random, sleep, frames, nextFrame, ui, test, expect } from "trigscript";
import { Screen } from "trigscript/screen";
import { Panel, Meter, MenuList, choose, thousands } from "trigscript/ui";

/** The board: 24 × 16 pixels, its corner on tile (4, 4) of the map. */
const W = 24, H = 16;
/** Colours, as `screen`'s OWNERS have them: 4 the snake (your own units, green), 5 the apple (red), 2 the walls (yellow). */
const SNAKE = 4, APPLE = 5, WALL = 2, HEAD = 1;
const AGAIN = ["Play again", "Stop"];

program(async () => {
  const screen = new Screen(4, 4, W, H);
  // The pixels are other players' units: without vision of them, the fog of war hides them.
  screen.reveal(P1);
  const hud = { score: 0, best: 0, length: 3, over: false };
  const menu = { selected: 0, open: false };
  ui.lines(P1, () => (
    <>
      <Panel title="SNAKE  W A S D">
        <span color="yellow">Score {thousands(hud.score)}</span>   Best {thousands(hud.best)}
      </Panel>
      <Meter label="Length" value={hud.length} max={W * H / 4} width={20} />
      {hud.over && <line color="red">You ran into something.</line>}
      {menu.open && <MenuList items={AGAIN} selected={menu.selected} />}
    </>
  ));

  while (true) {
    // The snake as two arrays from its tail to its head: a move pushes a head and shifts the tail off.
    const xs = [W / 2 - 2, W / 2 - 1, W / 2];
    const ys = [H / 2, H / 2, H / 2];
    let dx = 1, dy = 0;
    let ax = 4, ay = 4;
    let delay = 6;
    hud.score = 0;
    hud.length = 3;
    hud.over = false;
    /** An apple somewhere the snake is not. */
    function placeApple() {
      while (true) {
        ax = 1 + random(W - 2);
        ay = 1 + random(H - 2);
        if (screen.get(ax, ay) === 0) return;
      }
    }
    screen.clear();
    screen.rect(0, 0, W, 1, WALL);
    screen.rect(0, H - 1, W, 1, WALL);
    screen.rect(0, 0, 1, H, WALL);
    screen.rect(W - 1, 0, 1, H, WALL);
    for (let i = 0; i < xs.length; i++) screen.set(xs[i], ys[i], SNAKE);
    placeApple();
    screen.set(ax, ay, APPLE);
    screen.present();

    while (true) {
      // A turn is taken when a key is pressed, between moves; never straight back into the neck.
      let wait = delay;
      while (wait > 0) {
        if (keyPressed(P1, "W") && dy === 0) { dx = 0; dy = -1; }
        if (keyPressed(P1, "S") && dy === 0) { dx = 0; dy = 1; }
        if (keyPressed(P1, "A") && dx === 0) { dx = -1; dy = 0; }
        if (keyPressed(P1, "D") && dx === 0) { dx = 1; dy = 0; }
        wait--;
        await nextFrame();
      }
      const hx = xs[xs.length - 1] + dx;
      const hy = ys[ys.length - 1] + dy;
      const hit = screen.get(hx, hy);
      if (hit === WALL || hit === SNAKE || hit === HEAD) break;
      screen.set(xs[xs.length - 1], ys[ys.length - 1], SNAKE);
      xs.push(hx);
      ys.push(hy);
      screen.set(hx, hy, HEAD);
      if (hit === APPLE) {
        hud.score += 10 * hud.length;
        hud.length++;
        if (hud.length % 5 === 0 && delay > 2) delay--;
        placeApple();
        screen.set(ax, ay, APPLE);
      } else {
        screen.set(xs.shift() ?? 0, ys.shift() ?? 0, 0);
      }
      screen.present();
    }

    hud.over = true;
    if (hud.score > hud.best) hud.best = hud.score;
    menu.selected = 0;
    const pick = await choose(P1, AGAIN.length, menu);
    if (pick === 1) break;
  }
  screen.clear();
  screen.present();
  await sleep(frames(1));
});

test("the snake moves, eats and grows, and the score is shown", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("SNAKE");
  expect(sim).toHavePrinted("Score 0");
  // Straight to the right from the middle: it reaches the wall in eleven moves of six frames.
  sim.frames(90);
  expect(sim).toHavePrinted("You ran into something.");
  expect(sim).toHavePrinted("> Play again");
});
