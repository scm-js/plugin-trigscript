// ledger: step 12, refused: a task started
// trigscript/cutscene: a scene started as a task, which the player may skip with Escape: `await play(P1, start(scene()))`.
import { play } from "trigscript/cutscene";
async function scene() {
  await sleep(frames(48));
  print("the end");
}
program(async () => {
  const skipped = await play(P1, start(scene()));
  if (skipped) print("skipped");
});
