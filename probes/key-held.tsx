// The held-key probe (TrigScript 4, S2 → S3): does a key held down reach the game on every frame it is down, and stop
// when it is let go? MSQC's KeyPress is the key's state on the player's own computer, sent each frame it is down; the
// tap bug found in Tetris says it is true for every frame of a tap. Magenta probe 7 read "one event a press, no key-up".
// This draws each key's last 32 frames as a strip, newest on the right: ■ held, □ not.
// Host it as a multiplayer game, alone.
//   npx tsx scripts/build-fixture.mts probes/key-held.tsx fixtures/eud/key-held.scx
import { program, P1, keyHeld, keyPressed, sleep, frames, ui, textColors } from "trigscript";

const KEYS = ["W", "A", "S", "D", "Space"] as const;
const COLORS = [textColors.cyan, textColors.green, textColors.yellow, textColors.orange, textColors.purple];
const SPAN = 32;
const PLACES = [...Array(SPAN).keys()];

program(async () => {
  const strip: number[] = new Array(KEYS.length * SPAN).fill(0);
  const now: number[] = new Array(KEYS.length).fill(0);
  const longest: number[] = new Array(KEYS.length).fill(0);
  const taps: number[] = new Array(KEYS.length).fill(0);
  const releases: number[] = new Array(KEYS.length).fill(0);
  let head = 0;
  let frame = 0;

  ui.lines(P1, () => (
    <>
      <line color="yellow">KEY HELD PROBE <span color="white">frame {frame}</span></line>
      {KEYS.map((name, k) => (
        <line>
          {name.padEnd(5)} {PLACES.map((i) => <cell color={strip[k * SPAN + (head + 1 + i) % SPAN]} />)}
          <span color="sage"> now {now[k]} longest {longest[k]} taps {taps[k]} let go {releases[k]}</span>
        </line>
      ))}
      <line color="white">1 tap each key: a short mark, taps +1</line>
      <line color="white">2 hold W 3 seconds: a solid strip, longest near 72</line>
      <line color="white">3 let go: does the strip end at once? let go +1</line>
      <line color="white">4 Enter, type wasd, Enter: nothing should mark</line>
      <line color="white">5 hold A and D together: both strips?</line>
    </>
  ));

  while (true) {
    frame++;
    head = (head + 1) % SPAN;
    KEYS.forEach((name, k) => {
      const held = keyHeld(P1, name);
      strip[k * SPAN + head] = held ? COLORS[k] : 0;
      if (held) { now[k]++; if (now[k] > longest[k]) longest[k] = now[k]; }
      else { if (now[k] > 0) releases[k]++; now[k] = 0; }
      if (keyPressed(P1, name)) taps[k]++;
    });
    await sleep(frames(1));
  }
}, { owner: P1 });
