// ledger: step 11, refused: Promise.race
// Two waits side by side, the program going on when the first ends: `await Promise.race([…])`.
async function wave(n: number): Promise<number> {
  await sleep(frames(n));
  return n;
}
program(async () => {
  const v = await Promise.race([wave(5), sleep(frames(3)).then(() => 0)]);
  print(`${v}`);
});
