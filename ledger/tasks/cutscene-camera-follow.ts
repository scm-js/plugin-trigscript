// ledger: step 10, takes
// trigscript/cutscene: a camera that keeps a unit in the middle of the screen for so many frames: `await cam.follow(u, time)`.
import { Camera, SECOND } from "trigscript/cutscene";
program(async () => {
  const u = first({ owner: P1 });
  if (u) {
    const cam = new Camera(u.x, u.y);
    await cam.follow(u, 2 * SECOND);
  }
});
