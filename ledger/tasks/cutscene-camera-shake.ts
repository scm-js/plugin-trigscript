// ledger: step 5, takes
// trigscript/cutscene: a camera that shakes for so many frames and settles where it was: `await cam.shake(12)`.
import { Camera } from "trigscript/cutscene";
program(async () => {
  const cam = new Camera(640, 480);
  await cam.shake(12);
});
