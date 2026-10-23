// ledger: step 10, takes
// A unit kept across a sleep, checked again before it is used: gone, it reads as none.
program(() => {
  const u = first({ owner: P1 });
  sleep(frames(24));
  if (u) u.heal(10);
  else print("gone");
});
