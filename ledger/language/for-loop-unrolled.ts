// ledger: step 0, takes
// A `for` loop over bounds known when the map is built: worked out then, its body written out once a turn.
program(() => {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += i;
    sleep(frames(1));
  }
  print(`${total}`);
});
