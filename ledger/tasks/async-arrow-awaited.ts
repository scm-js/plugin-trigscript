// ledger: step 1, takes
// An async arrow function called and awaited where it is written: `await (async () => { … })()`.
program(async () => {
  let n = 0;
  await (async () => {
    await sleep(frames(2));
    n = 4;
  })();
  print(`${n}`);
});
