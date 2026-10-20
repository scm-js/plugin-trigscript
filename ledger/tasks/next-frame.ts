// ledger: step 0, takes
// A wait for the next frame: `await nextFrame()`, the same as one frame's sleep.
program(async () => {
  let n = 0;
  while (n < 3) {
    n += 1;
    await nextFrame();
  }
  print(`${n}`);
});
