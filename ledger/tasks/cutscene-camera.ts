// ledger: step 5, refused: a location moved (centerLocation)
// trigscript/cutscene: a `Camera`, which looks at a point of the map as soon as it is made, and at another by `look(x, y)`.
import { Camera } from "trigscript/cutscene";
program(async () => {
  const cam = new Camera(640, 480);
  await sleep(frames(24));
  cam.look(1024, 512);
});
