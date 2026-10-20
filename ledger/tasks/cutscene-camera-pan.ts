// ledger: step 5, takes
// trigscript/cutscene: a camera that glides to a point over so many frames: `await cam.pan(x, y, time)`.
import { Camera, SECOND } from "trigscript/cutscene";
program(async () => {
  const cam = new Camera(640, 480);
  await cam.pan(1600, 400, 2 * SECOND);
});
