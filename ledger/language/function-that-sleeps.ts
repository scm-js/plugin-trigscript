// ledger: step 0, takes
// A function that sleeps: put where each call is, the program waiting inside it.
function pause(n: number) {
  sleep(frames(2));
  return n + 1;
}
program(() => {
  let n = 0;
  n = pause(n);
  n = pause(n);
  print(`${n}`);
});
