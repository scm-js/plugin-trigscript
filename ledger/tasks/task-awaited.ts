// ledger: step 11, refused: a task started
// A task waited for: `await t`, the program going on in the frame the task ends.
async function short() {
  await sleep(frames(3));
}
program(async () => {
  const t = start(short());
  print("started");
  await t;
  print("ended");
});
