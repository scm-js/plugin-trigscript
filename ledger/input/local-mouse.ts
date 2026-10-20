// ledger: step 12, refused: a read of local.mouse.x
// Where this computer's mouse is on the screen: `local.mouse.x`, `local.mouse.y`.
program(() => {
  print(`${local.mouse.x}, ${local.mouse.y}`);
});
