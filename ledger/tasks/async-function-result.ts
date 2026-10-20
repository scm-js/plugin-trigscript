// ledger: step 1, takes
// An async function that gives back a number once it has waited: `const v = await slow(2)`.
async function slow(n: number): Promise<number> {
  await sleep(frames(n));
  return n + 1;
}
program(async () => {
  const v = await slow(2);
  print(`${v}`);
});
