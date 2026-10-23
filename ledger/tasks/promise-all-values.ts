// ledger: step 11, takes
// Each side's value from a `Promise.all`: `const [a, b] = await Promise.all([…])`.
async function slow(n: number): Promise<number> {
  await sleep(frames(n));
  return n * 2;
}
program(async () => {
  const [a, b] = await Promise.all([slow(2), slow(3)]);
  print(`${a} ${b}`);
});
