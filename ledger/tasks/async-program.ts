// ledger: step 0, takes
// A program written as an async function, that waits with `await sleep(…)`.
program(async () => {
  print("now");
  await sleep(frames(3));
  print("later");
});
