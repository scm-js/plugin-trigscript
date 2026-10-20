// ledger: step 11, refused: a task started
// Whether a task still runs: `t.running`, true until it ends or is cancelled.
async function short() {
  await sleep(frames(3));
}
program(async () => {
  const t = start(short());
  let n = 0;
  while (t.running) {
    n += 1;
    await nextFrame();
  }
  print(`${n}`);
});
