// ledger: step 1, takes
// What a promise gives, handed to a function by `.then((k) => …)` where it is awaited.
async function slow(n: number): Promise<number> {
  await sleep(frames(n));
  return n + 1;
}
program(async () => {
  await slow(2).then((k) => {
    print(`then ${k}`);
  });
});
