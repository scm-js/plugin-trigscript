// ledger: step 0, takes
// `await sleep(…)` in an `async` program: the same pause as `sleep(…)` on its own.
program(async () => {
  let n = 0;
  while (n < 3) {
    await sleep(frames(5));
    n += 1;
  }
  print(`${n}`);
});
