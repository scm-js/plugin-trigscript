// ledger: step 11, refused: a task started
// An error a task ends on that nothing awaits: the task ends and the game says so, and the program goes on.
async function worker() {
  await sleep(frames(1));
  throw new Error("worker failed");
}
program(async () => {
  start(worker());
  await sleep(frames(3));
  print("still here");
});
