// ledger: step 12, refused: the players' input (key)
// A key held down, true on every frame it is down: `keyHeld(P1, "D")`.
program(async () => {
  let x = 0;
  while (true) {
    if (keyHeld(P1, "D")) x += 1;
    print(`${x}`);
    await nextFrame();
  }
});
