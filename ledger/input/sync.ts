// ledger: step 12, takes
// One player's value only their computer knows, sent to every computer: `const x = await sync(P1, local.camera.x)`.
program(async () => {
  const x = await sync(P1, local.camera.x);
  print(`${x}`);
});
