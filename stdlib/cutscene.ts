/**
 * Scenes acted out in the game: the standard library's "trigscript/cutscene" (TrigScript 4).
 *
 *   import { Camera, walk, line, play, SECOND } from "trigscript/cutscene";
 *
 *   async function intro(raider: Unit) {
 *     const cam = new Camera(raider.x, raider.y);
 *     await line(units.JimRaynorMarine, "Something's moving out there.", 3 * SECOND);
 *     const there = start(walk(raider, 1200, 640));   // the walk goes on while the camera follows
 *     await cam.follow(raider, 2 * SECOND);
 *     await there;
 *     await cam.pan(1600, 400, 2 * SECOND);
 *     await cam.shake(12);
 *   }
 *
 *   program(async () => {
 *     const raider = first(unitsAt(locations.Base, { owner: P1, type: units.TerranMarine }));
 *     if (!raider) return;
 *     const skipped = await play(P1, start(intro(raider)));   // Escape skips the rest of it
 *     if (skipped) print("Skipped.");
 *   });
 *
 * Everything here is what a trigger can do, done a frame at a time: the camera is Center View on a location the library
 * keeps for itself, moved to where the camera should look; a unit walks by a Move order to another; a line is the
 * speaker's portrait talking and the words in the middle of the screen. Places are pixels (32 a tile), (0, 0) the map's
 * top left; time is frames of the game, 24 a second on Fastest (`SECOND`). The camera is the one of the player the
 * program runs as, as Center View's is.
 */
import { centerLocation, centerView, reserveLocation, talkingPortrait, print, sleep, frames, nextFrame, keyPressed, type Player, type Task, type Unit, type UnitType } from "trigscript";
import { easeInOutQuad, easeInQuad, easeOutQuad, easeOutBack } from "trigscript/math";

/** Frames a second of game time on Fastest, the speed a map is played at. */
export const SECOND = 24;

const VIEW = reserveLocation("cutscene: where the camera looks");
const GOAL = reserveLocation("cutscene: where a unit is sent");

/** How a glide speeds up and slows down: evenly, starting slow, ending slow, both, or ending past the mark and back. */
export type Ease = "linear" | "in" | "out" | "inOut" | "back";

/** How far along a glide is at `t` (0 at its start, 1 at its end), as `ease` has it. */
function eased(t: fixed, ease: Ease): fixed {
  if (ease === "in") return easeInQuad(t);
  if (ease === "out") return easeOutQuad(t);
  if (ease === "inOut") return easeInOutQuad(t);
  if (ease === "back") return easeOutBack(t);
  return t;
}

/**
 * The camera of the player the program runs as: where it looks, and how it gets somewhere else. It looks at its first
 * place as soon as it is made.
 */
export class Camera {
  /** The point the camera is centred on, in pixels. */
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    centerLocation(VIEW, x, y);
    centerView(VIEW);
  }

  /** Look at a point, now. */
  look(x: number, y: number) {
    this.x = x;
    this.y = y;
    centerLocation(VIEW, x, y);
    centerView(VIEW);
  }

  /**
   * Glide to a point over `time` frames, looking at each place on the way a frame at a time.
   * @param ease How it speeds up and slows down; "inOut" unless it says.
   */
  async pan(x: number, y: number, time: number, ease: Ease = "inOut") {
    const fromX = this.x;
    const fromY = this.y;
    let i = 1;
    while (i <= time) {
      const k = eased(fixed(i) / time, ease);
      this.look(fromX + Math.round((x - fromX) * k), fromY + Math.round((y - fromY) * k));
      await nextFrame();
      i++;
    }
    this.look(x, y);
  }

  /** Keep a unit in the middle of the screen for `time` frames, or until it is gone. */
  async follow(u: Unit, time: number) {
    let i = 0;
    while (i < time && u) {
      this.look(u.x, u.y);
      await nextFrame();
      i++;
    }
  }

  /** Shake for `time` frames, `size` pixels each way (8 unless it says), and settle where it was. */
  async shake(time: number, size: number = 8) {
    const x = this.x;
    const y = this.y;
    let i = 0;
    while (i < time) {
      const left = (i % 4) < 2;
      const up = (i % 2) === 0;
      centerLocation(VIEW, left ? x - size : x + size, up ? y - size : y + size);
      centerView(VIEW);
      await nextFrame();
      i++;
    }
    this.look(x, y);
  }
}

/**
 * Send a unit to a point by a Move order, and wait until it is there — within `near` pixels (48 unless it says) — or
 * `limit` frames have passed (30 seconds unless it says), or it is gone.
 * @returns Whether it got there.
 */
export async function walk(u: Unit, x: number, y: number, near: number = 48, limit: number = 30 * SECOND): Promise<boolean> {
  return go(u, x, y, "move", near, limit);
}

/** The same with an Attack order: the unit fights what it meets on the way. */
export async function charge(u: Unit, x: number, y: number, near: number = 48, limit: number = 30 * SECOND): Promise<boolean> {
  return go(u, x, y, "attack", near, limit);
}

async function go(u: Unit, x: number, y: number, how: "move" | "attack", near: number, limit: number): Promise<boolean> {
  centerLocation(GOAL, x, y);
  u.order(how, GOAL);
  let waited = 0;
  while (u && Math.abs(u.x - x) + Math.abs(u.y - y) > near && waited < limit) {
    await nextFrame();
    waited++;
  }
  return !!u && Math.abs(u.x - x) + Math.abs(u.y - y) <= near;
}

/**
 * Send every unit of a group to a point together, and wait until each is there, gone, or `limit` frames have passed.
 * @returns How many got there.
 */
export async function walkAll(group: Unit[], x: number, y: number, near: number = 64, limit: number = 30 * SECOND): Promise<number> {
  centerLocation(GOAL, x, y);
  for (const u of group) if (u) u.order("move", GOAL);
  let waited = 0;
  let there = 0;
  while (waited < limit) {
    there = 0;
    let moving = 0;
    for (const u of group) {
      if (!u) continue;
      if (Math.abs(u.x - x) + Math.abs(u.y - y) <= near) there++;
      else moving++;
    }
    if (moving === 0) break;
    await nextFrame();
    waited++;
  }
  return there;
}

/**
 * A line of the scene: the speaker's portrait talks and the words show in the middle of the screen, for `time` frames
 * (3 seconds unless it says), and then the scene goes on.
 */
export async function line(speaker: UnitType, text: string, time: number = 3 * SECOND) {
  talkingPortrait(speaker, Math.round((time * 1000) / SECOND));
  print(text, { position: "center" });
  await sleep(frames(time));
}

/**
 * Play a scene, started as a task (`start(intro())`), for a player who may skip it: when they press `key` (Escape unless
 * it says) the scene stops where it is. Put things where the scene would have left them when it gives true.
 * @returns Whether it was skipped.
 */
export async function play(player: Player, scene: Task, key: "Escape" | "Space" | "Enter" = "Escape"): Promise<boolean> {
  while (scene.running) {
    if (keyPressed(player, key)) {
      scene.cancel();
      return true;
    }
    await nextFrame();
  }
  return false;
}
