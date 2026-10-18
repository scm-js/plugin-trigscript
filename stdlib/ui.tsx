/**
 * A kit for the game's text lines: the standard library's "trigscript/ui" (TrigScript 4).
 *
 *   import { Meter, Panel, MenuList, DialogBox, choose, say, clock } from "trigscript/ui";
 *
 *   const ITEMS = ["Marine (50)", "Medic (75)", "Leave"];
 *   const shop = { selected: 0, open: false };
 *   const talk = { speaker: "", text: "", open: false };
 *
 *   program(async () => {
 *     ui.lines(P1, () => (
 *       <>
 *         <Panel title={`Wave ${wave}  ${clock(elapsed)}`}>
 *           <Meter label="Base" value={baseHp} max={1500} />
 *         </Panel>
 *         {shop.open && <MenuList items={ITEMS} selected={shop.selected} />}
 *         <DialogBox box={talk} />
 *       </>
 *     ));
 *     await say(P1, talk, "Raynor", "Hold the bridge until dawn.");
 *     const pick = await choose(P1, ITEMS.length, shop);
 *   });
 *
 * The text lines are one player's: a view is shown to that player only, rebuilt when what it reads changes (and once a
 * second besides), so a menu, a dialog and a meter cost nothing while nothing changes. Give a player one `ui.lines` and
 * put everything in it, as the example does: the components are pieces of one view, and the state they show is a
 * record of yours (`shop`, `talk`) that the functions here change.
 *
 * What the text lines can show, played in StarCraft: Remastered (the UI spike, 2026-10-16): eleven lines; colour codes
 * take no width; ■ □ ● are one width; after grey on a line every later colour code is ignored, so grey goes last.
 */
import { keyPressed, nextFrame, sleep, frames, game, textColors, type Player, type TextColor } from "trigscript";

/** Frames a second of game time on Fastest, the speed a map is played at. */
const PER_SECOND = 24;

/** "1:05": frames of game time as minutes and seconds (24 frames a second, on Fastest). */
export function clock(frames: number): string {
  const seconds = Math.floor(frames / PER_SECOND);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "12,345": a whole number with its thousands marked. */
export function thousands(n: number): string {
  let rest = n < 0 ? -n : n;
  let out = "";
  while (rest >= 1000) {
    out = `,${String(rest % 1000).padStart(3, "0")}${out}`;
    rest = Math.floor(rest / 1000);
  }
  return `${n < 0 ? "-" : ""}${rest}${out}`;
}

/**
 * A labelled bar on a line of its own — "Base ■■■■■■□□□□ 900/1500" — green above half, yellow above a quarter, red below.
 * @param label What the bar is of.
 * @param value How much there is.
 * @param max How much there can be.
 * @param width How many squares the bar is (10 unless it says).
 */
export function Meter({ label, value, max, width }: { label: string; value: number; max: number; width?: number }) {
  return (
    <line>
      {label} <bar value={value} max={max} width={width ?? 10} color={value * 2 > max ? textColors.green : value * 4 > max ? textColors.yellow : textColors.red} /> {value}/{max}
    </line>
  );
}

/**
 * A title over what is inside it: "-- Wave 3 --" in its colour (yellow unless it says), then the lines inside.
 * @param title The title.
 * @param color The title's colour.
 */
export function Panel({ title, children, color }: { title: string; children?: Children; color?: TextColor }) {
  return (
    <>
      <line color={color ?? "yellow"}>-- {title} --</line>
      <line>{children}</line>
    </>
  );
}

/**
 * A menu's lines: each item on a line of its own, the one at `selected` marked "> " and in its colour (cyan unless it
 * says). `items` is a list the script has, or an array of texts of the program.
 */
export function MenuList({ items, selected, color }: { items: readonly string[]; selected: number; color?: TextColor }) {
  return (
    <>
      {items.map((item, i) => (
        <line color={i === selected ? (color ?? "cyan") : "white"}>
          {i === selected ? "> " : "  "}
          {item}
        </line>
      ))}
    </>
  );
}

/**
 * Let a player choose one of `count` things: the menu opens (`menu.open`), Up and Down move `menu.selected` (round
 * from the last to the first), and Enter or Space chooses — the place chosen, once it is. Show it with `MenuList`, in the
 * player's `ui.lines`: `{shop.open && <MenuList items={ITEMS} selected={shop.selected} />}`.
 * @param player Who chooses: P1 … P8, known when the script is built.
 * @param count How many things there are to choose from.
 * @param menu The record a view shows: which is marked, and whether the menu is open.
 */
export const choose = game(async (player: Player, count: number, menu: { selected: number; open: boolean }): Promise<number> => {
  menu.open = true;
  while (true) {
    if (keyPressed(player, "Up")) menu.selected = (menu.selected + count - 1) % count;
    if (keyPressed(player, "Down")) menu.selected = (menu.selected + 1) % count;
    if (keyPressed(player, "Enter") || keyPressed(player, "Space")) break;
    await nextFrame();
  }
  menu.open = false;
  return menu.selected;
});

/**
 * A text put into `into.text` a character at a time, one every `every` frames (2 unless it says): a view that shows
 * `into.text` shows it being typed. Done when the whole text is there.
 */
export const typewriter = game(async (into: { text: string }, text: string, every: number = 2) => {
  let n = 0;
  while (n < text.length) {
    n++;
    into.text = text.slice(0, n);
    await sleep(frames(every));
  }
});

/**
 * Someone says something to a player: the dialog opens (`box.open`), the speaker's name and the words typed in, and it
 * closes when the player presses Enter or Space. Show it with `DialogBox`.
 * @param player Who reads it: P1 … P8, known when the script is built.
 * @param box The record a view shows.
 * @param speaker Who speaks.
 * @param text What they say.
 */
export const say = game(async (player: Player, box: { speaker: string; text: string; open: boolean }, speaker: string, text: string) => {
  box.open = true;
  box.speaker = speaker;
  box.text = "";
  await typewriter(box, text);
  while (!(keyPressed(player, "Enter") || keyPressed(player, "Space"))) await nextFrame();
  box.open = false;
});

/** A dialog's lines while it is open: the speaker in yellow, the words, and what to press. Nothing while it is closed. */
export function DialogBox({ box }: { box: { speaker: string; text: string; open: boolean } }) {
  return box.open ? (
    <>
      <line color="yellow">{box.speaker}</line>
      <line>{box.text}</line>
      <line color="grey">(Enter)</line>
    </>
  ) : null;
}

/** A line at the end of a log that keeps the last `keep` (6 unless it says), the oldest taken off the front. */
export const log = game((lines: string[], text: string, keep: number = 6) => {
  lines.push(text);
  while (lines.length > keep) lines.shift();
});

/** A log's lines, oldest first, each in its colour (white unless it says). */
export function LogLines({ lines, color }: { lines: readonly string[]; color?: TextColor }) {
  return <>{lines.map((text) => <line color={color ?? "white"}>{text}</line>)}</>;
}
