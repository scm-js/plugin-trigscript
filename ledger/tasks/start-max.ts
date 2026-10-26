// ledger: step 11, takes
// A start that lets so many of its tasks run at once: `start(wave(n), { max: 4 })`.
async function wave(n: number) {
  await sleep(frames(n));
  print(`wave ${n}`);
}
program(async () => {
  let n = 1;
  while (n <= 3) {
    start(wave(n), { max: 4 });
    n += 1;
  }
});
