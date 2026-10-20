// ledger: step 8, refused: two texts compared
// A template put together while the game runs and used as a text, not printed at once: `` `${n}` === "15" ``.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if (`${n}` === "15") print("fifteen");
  else print("not fifteen");
});
