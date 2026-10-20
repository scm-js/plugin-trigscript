// ledger: step 5, takes
// The action Set Resources, the amount from a value of the program.
program(() => {
  let bounty = 50;
  bounty += 25;
  setResources(P1, "add", bounty, "ore");
});
