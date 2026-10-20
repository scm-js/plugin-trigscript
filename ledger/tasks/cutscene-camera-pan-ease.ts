// ledger: step 5, refused: a location moved (centerLocation)
// trigscript/cutscene: a camera's glide that starts slow, ends slow or goes past and back: `cam.pan(x, y, time, "back")`.
import { Camera } from "trigscript/cutscene";
program(async () => {
  const cam = new Camera(640, 480);
  await cam.pan(1600, 400, 48, "back");
});
