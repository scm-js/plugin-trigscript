// ledger: step 13, takes
// A trigger's other execution flags: ignore the game's end, ignore Display Text, conditions met,
// paused, Wait skipping off, and raw flags ORed in.
trigger(P1, [always()], [displayText("Still here.")], { ignoreGameEnd: true, ignoreDisplay: true, conditionsMet: false, paused: false, waitSkipDisabled: true, flags: 0 });
program(() => {
  print("started");
});
