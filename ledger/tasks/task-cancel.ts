// ledger: step 11, takes
// A task stopped where it is: `t.cancel()`.
async function forever() {
  while (true) await sleep(frames(1));
}
program(async () => {
  const t = start(forever());
  await sleep(frames(10));
  t.cancel();
});
