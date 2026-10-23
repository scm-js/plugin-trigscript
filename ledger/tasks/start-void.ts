// ledger: step 11, takes
// A task started by a call nothing waits for: `void later()`.
async function later() {
  await sleep(frames(2));
  print("later");
}
program(async () => {
  void later();
  print("now");
});
