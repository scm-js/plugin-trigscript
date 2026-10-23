// ledger: step 11, takes
// A task started beside the program, the program going on at once: `start(tick(3))`.
async function tick(n: number) {
  let i = 0;
  while (i < n) {
    print(`tick ${i}`);
    await sleep(frames(2));
    i += 1;
  }
}
program(async () => {
  start(tick(3));
  print("started");
});
