// ledger: step 11, refused: try
// An error a task ends on, thrown again where the task is awaited and caught there: `try { await t; } catch (e) { … }`.
async function wave(n: number) {
  await sleep(frames(2));
  if (n == 2) throw new Error("lost");
}
program(async () => {
  const t = start(wave(2));
  try {
    await t;
    print("done");
  } catch (e) {
    print("the wave was lost");
  }
});
