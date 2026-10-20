// ledger: step 12, refused: a read of local.camera.x
// A value only this computer knows, tested to choose what is shown here: `if (local.camera.x > 300) print(…)`.
program(() => {
  if (local.camera.x > 300) print("right side");
});
