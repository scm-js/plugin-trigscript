// ledger: step 1, takes
// A wait until a function says true, asked once now and once every frame: `await until(() => n >= 3)`.
program(async () => {
  let n = 0;
  await until(() => {
    n += 1;
    return n >= 3;
  });
  print(`${n}`);
});
