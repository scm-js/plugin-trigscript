// ledger: step 12, takes
// Several of one player's values sent together, read on the same frame: `const [x, y] = await sync(P1, a, b)`.
program(async () => {
  const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y);
  print(`${x}, ${y}`);
});
