// ledger: step 0, takes
// An `async` arrow function kept in a `const` and awaited.
const pause = async (n: number) => {
  await sleep(frames(2));
  return n + 1;
};
program(async () => {
  let n = 0;
  while (n < 3) n = await pause(n);
  print(`${n}`);
});
