/**
 * A right-click on a command card button: the standard library's "trigscript/card" (TrigScript 4). Single-player maps.
 *
 *   import { CardButton, cardSlots } from "trigscript/card";
 *
 *   program(async () => {
 *     const restore = new CardButton(techs.Restoration, cardSlots.Restoration);
 *     await restore.begin();
 *     let on = true;
 *     while (true) {
 *       if (await restore.rightClicked()) {
 *         on = !on;
 *         print(on ? "On" : "Off", { to: CurrentPlayer });
 *       }
 *       …
 *       await nextFrame();
 *     }
 *   }, { owner: AllPlayers });
 *
 * The game keeps no record of which card button a right-click landed on, and a right-click on a button does nothing in
 * the game. So the button tests where the mouse was when the right button went down against where the button is drawn,
 * while the card shows the buttons of the units that have the ability (a Medic's for Restoration). Make it inside a
 * program run for the human player, and call rightClicked() once on every pass of the program's loop.
 *
 * Where a button is drawn depends on the graphics. Classic graphics draws the game 640 pixels wide; Remastered's draws it
 * as wide as the display's shape (`local.screen.width`), and that width reads the same in both. The card sits against the
 * right edge, so the button needs to know which graphics are on. At the start it centers the view on the middle of the
 * map, reads where the camera stopped (half the drawn width left of the middle) and sends the view back; after that, a
 * click on the minimap and the camera going further right than Remastered's can keep it current when the player switches
 * graphics mid-game. Until it knows, a press on either layout's place for the button counts.
 *
 * Played in StarCraft: Remastered (2026-11-12), on a Mac in Classic and Remastered graphics:
 * - Center View glides: the camera takes a few frames to arrive. A second Center View sent during the glide was lost,
 *   and moving a location and centering the view on it in one frame while the camera already sat there hung the game.
 * - A Center View after an await in the same branch, or in a task beside the program, misbehaved (the view locked);
 *   each step here is its own pass of the caller's loop, and the only awaits are sync()s followed by nothing but sums.
 * - The card's buttons: columns 132, 86 and 40 pixels in from the drawn width's right edge, rows at 352, 396 and 440,
 *   each about 31 by 30, in both graphics.
 * - A minimap click lands the camera half the drawn width, and one minimap pixel's worth more, left of the spot clicked.
 */
import { sync, clicked, centerLocation, centerView, reserveLocation, print, memory, local, techs, CurrentPlayer, type Tech } from "trigscript";

/** The nine places on the command card, left to right and top to bottom, and each ability's own place. */
export const cardSlots = {
  topLeft: 0,
  topMiddle: 1,
  topRight: 2,
  middleLeft: 3,
  center: 4,
  middleRight: 5,
  bottomLeft: 6,
  bottomMiddle: 7,
  bottomRight: 8,
  Restoration: 7,
};

const VIEW = reserveLocation("card: where the camera is sent to measure the screen");

let afterCalibrationHandler: (() => void) | undefined = undefined;
let showMeasurements = false;

/**
 * At the top of the script, before any CardButton: `afterCalibration` runs once the start's measurement is done, in
 * place of sending the view back — where an opening cinematic starts. `showMeasurements` prints each step of it, and each
 * right-click the button tests, as numbered lines.
 */
export function cardSetup(options: { afterCalibration?: () => void; showMeasurements?: boolean } = {}) {
  afterCalibrationHandler = options.afterCalibration;
  showMeasurements = options.showMeasurements === true;
}

/** One button of the command card, watched for a right-click. */
export class CardButton {
  /** The button set the card shows for the units that have the ability: a Medic's for Restoration. */
  buttonSet = 0xffff;
  /** How far in from the drawn width's right edge the button's column starts, and the top of its row. */
  fromRight = 132;
  top = 352;
  mapWidth = 0;
  mapHeight = 0;
  middleX = 0;
  middleY = 0;
  /** 0 the location is moved, 1 the view is sent, 2 waiting for it to settle, 3 read, 4 the location goes back, 5 the view goes back, 6 done. */
  phase = 6;
  passes = 0;
  startX = 0;
  startY = 0;
  settledX = 0;
  settledY = 0;
  /** Kept on this computer only: equal camera readings in a row while it settles, and the reading a pass ago. */
  steady = 0;
  lastX = 0;
  lastY = 0;
  /** Kept on this computer only: 0 not known, 1 Classic graphics, 2 Remastered's. */
  graphics = 0;
  pressed = 0;
  wasDown = 0;
  lastCameraX = 0;
  line = 0;

  constructor(tech: Tech, slot: number) {
    if (tech == techs.Restoration) this.buttonSet = 34;
    const column = slot % 3;
    if (column == 1) this.fromRight = 86;
    if (column == 2) this.fromRight = 40;
    if (slot >= 3) this.top = 396;
    if (slot >= 6) this.top = 440;
  }

  /** Before the program's loop: where the view starts, sent to every computer, so the view can be sent back there. */
  async begin() {
    this.mapWidth = memory.map.width * 32;
    this.mapHeight = memory.map.height * 32;
    this.middleX = (this.mapWidth - this.mapWidth % 64) / 2;
    this.middleY = (this.mapHeight - this.mapHeight % 64) / 2;
    const [x, y] = await sync(CurrentPlayer, local.camera.x, local.camera.y);
    this.startX = x;
    this.startY = y;
    this.lastCameraX = x;
    if (showMeasurements) {
      this.line += 1;
      print(`#${this.line} card: the view starts at ${x},${y}; the map is ${this.mapWidth} by ${this.mapHeight} pixels`);
    }
    // A map narrower or shorter than this would stop the camera before it is centered, and the reading would mean nothing.
    if (this.mapWidth >= 1024 && this.mapHeight >= 1024) this.phase = 0;
    else {
      if (showMeasurements) {
        this.line += 1;
        print(`#${this.line} card: the map is too small to measure the screen; both layouts count`);
      }
      const after = afterCalibrationHandler;
      if (after) after();
    }
  }

  /** On every pass of the program's loop: whether the player right-clicked the button since the last pass that said so. */
  async rightClicked(): Promise<boolean> {
    const cameraX = local.camera.x;
    const cameraY = local.camera.y;
    if (this.phase == 0) {
      centerLocation(VIEW, this.middleX, this.middleY);
      this.phase = 1;
    } else if (this.phase == 1) {
      centerView(VIEW);
      this.phase = 2;
      this.passes = 0;
      this.steady = 0;
      this.lastX = cameraX;
      this.lastY = cameraY;
    } else if (this.phase == 2) {
      this.passes += 1;
      if (cameraX == this.lastX && cameraY == this.lastY) this.steady += 1;
      else this.steady = 0;
      this.lastX = cameraX;
      this.lastY = cameraY;
      if (this.passes >= 16) this.phase = 3;
    }
    if (this.phase == 3) {
      const [x, y] = await sync(CurrentPlayer, local.camera.x, local.camera.y);
      this.settledX = x;
      this.settledY = y;
      this.phase = 4;
    } else if (this.phase == 4) {
      if (this.steady >= 2 && this.settledX + 296 <= this.middleX && this.settledX + 344 >= this.middleX) this.graphics = 1;
      if (this.steady >= 2 && this.settledX + 352 <= this.middleX && this.settledX + 460 >= this.middleX) this.graphics = 2;
      if (showMeasurements) {
        this.line += 1;
        print(`#${this.line} card: centered on the middle, the camera settled at ${this.settledX},${this.settledY} (${this.steady} equal readings)`);
        this.line += 1;
        if (this.graphics == 1) print(`#${this.line} card: Classic graphics, the camera ${this.middleX - this.settledX} left of the middle`);
        else if (this.graphics == 2) print(`#${this.line} card: Remastered graphics, the camera ${this.middleX - this.settledX} left of the middle`);
        else print(`#${this.line} card: graphics not known; both layouts count`);
      }
      const after = afterCalibrationHandler;
      if (after) {
        after();
        this.phase = 6;
      } else if (this.settledX != this.startX || this.settledY != this.startY) {
        centerLocation(VIEW, this.startX + this.middleX - this.settledX, this.startY + this.middleY - this.settledY);
        this.phase = 5;
      } else this.phase = 6;
    } else if (this.phase == 5) {
      centerView(VIEW);
      this.phase = 6;
      if (showMeasurements) {
        this.line += 1;
        print(`#${this.line} card: the view is sent back`);
      }
    }

    const width = local.screen.width;
    const mouseX = local.mouse.x;
    const mouseY = local.mouse.y;
    const buttons = local.mouse.buttons;
    if (this.phase == 6) {
      const before = this.graphics;
      // A minimap click or drag (a square map's minimap is 128 pixels across, from 6,348): the camera jumps to the spot
      // under the cursor, half the drawn width and a minimap pixel left of it.
      const scale = this.mapWidth / 128;
      if (this.mapWidth == this.mapHeight && buttons % 4 >= 2 && mouseX >= 6 && mouseX <= 133 && mouseY >= 348 && mouseY <= 475 && (cameraX > this.lastCameraX + 96 || this.lastCameraX > cameraX + 96) && cameraX > 0) {
        const spot = (mouseX - 6) * scale;
        if (spot >= cameraX + scale + 296 && spot <= cameraX + scale + 344) this.graphics = 1;
        if (spot >= cameraX + scale + 352 && spot <= cameraX + scale + 460) this.graphics = 2;
      }
      // Remastered's camera stops a drawn width short of the map's right edge; only Classic's gets further.
      if (width > 648 && cameraX + width > this.mapWidth) this.graphics = 1;
      if (showMeasurements && this.graphics != before) {
        this.line += 1;
        if (this.graphics == 1) print(`#${this.line} card: now Classic graphics, the camera at ${cameraX},${cameraY}`);
        else print(`#${this.line} card: now Remastered graphics, the camera at ${cameraX},${cameraY}`);
      }
    }
    this.lastCameraX = cameraX;

    const down = buttons % 16 >= 8 ? 1 : 0;
    if (down == 1 && this.wasDown == 0) {
      const inRow = mouseY >= this.top && mouseY < this.top + 30;
      const inClassic = mouseX + this.fromRight >= 640 && mouseX + this.fromRight < 640 + 31;
      const inRemastered = mouseX + this.fromRight >= width && mouseX + this.fromRight < width + 31;
      let inSlot = false;
      if (this.graphics == 1) inSlot = inClassic;
      else if (this.graphics == 2) inSlot = inRemastered;
      else inSlot = inClassic || inRemastered;
      const shown = local.card.buttonSet;
      this.pressed = shown == this.buttonSet && inRow && inSlot ? 1 : 0;
      if (showMeasurements) {
        this.line += 1;
        const verdict = this.pressed == 1 ? "on the button" : "not on the button";
        if (shown == 34) print(`#${this.line} card: right button down at ${mouseX},${mouseY}, Medic buttons (34): ${verdict}`);
        else if (shown == 0) print(`#${this.line} card: right button down at ${mouseX},${mouseY}, Marine buttons (0): ${verdict}`);
        else if (shown == 244) print(`#${this.line} card: right button down at ${mouseX},${mouseY}, mixed group buttons (244): ${verdict}`);
        else if (shown == 229) print(`#${this.line} card: right button down at ${mouseX},${mouseY}, Cancel, a targeting cursor is up (229): ${verdict}`);
        else print(`#${this.line} card: right button down at ${mouseX},${mouseY}, button set (${shown}): ${verdict}`);
      }
    }
    this.wasDown = down;

    if (clicked(CurrentPlayer, "right")) {
      const onButton = await sync(CurrentPlayer, this.pressed);
      this.pressed = 0;
      return onButton == 1;
    }
    return false;
  }
}
