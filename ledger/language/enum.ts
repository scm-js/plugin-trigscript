// ledger: step 0, takes
// An `enum` declared outside the program: its members are numbers known when the map is built.
enum Phase {
  Build,
  Fight,
  Done,
}
program(() => {
  let phase = Phase.Build;
  let turns = 0;
  while (phase != Phase.Done) {
    phase = phase == Phase.Build ? Phase.Fight : Phase.Done;
    turns += 1;
  }
  print(`${turns}`);
});
