// ledger: step 11, takes
// An event's function that waits, started as a task each time: `on.died(…, async (u) => { await sleep(…); … })`.
program(async () => {
  on.died({ owner: P8 }, async (u) => {
    await sleep(seconds(2));
    print("back");
  }, { max: 4 });
});
