// ledger: step 0, takes
// A wait whose length the program worked out while the game runs: `await sleep(frames(n))`.
program(async () => {
  let n = 1;
  while (n < 5) n += 2;
  await sleep(frames(n));
  print("later");
});
