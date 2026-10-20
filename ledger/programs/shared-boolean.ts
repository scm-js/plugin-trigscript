// ledger: step 7, takes
// A boolean every player of a program for several players shares: `let done = shared(false)`.
program(() => {
  let done = shared(false);
  if (!done) print("first here");
  done = true;
}, { owner: AllPlayers });
