// ledger: step 11, takes
// `await sleep(…).then(() => 7)` as a value: the wait, then what the function gives.
program(async () => {
  let n = 0;
  n = await sleep(frames(1)).then(() => 7);
  print(`${n}`);
});
