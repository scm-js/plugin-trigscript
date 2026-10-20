// ledger: step 11, refused: a task started
// A task started by a call nothing waits for: `void later()`.
async function later() {
  await sleep(frames(2));
  print("later");
}
program(async () => {
  void later();
  print("now");
});
