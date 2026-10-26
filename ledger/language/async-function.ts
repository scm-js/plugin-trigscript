// ledger: step 0, takes
// An `async` function that waits, awaited by the program: the program goes on when it returns, with its result.
async function slowDouble(n: number) {
  await sleep(frames(3));
  return n + n;
}
program(async () => {
  let n = 0;
  while (n < 3) n += 1;
  n = await slowDouble(n);
  print(`${n}`);
});
