// ledger: step 1, takes
// A method that returns a boolean, called from more than one place and tested in an `if`.
class Timer {
  left = 5;
  done(): boolean {
    return this.left <= 0;
  }
}
program(() => {
  const t = new Timer();
  let ticks = 0;
  while (ticks < 10) {
    if (t.done()) break;
    t.left -= 1;
    ticks += 1;
  }
  if (t.done()) print(`${ticks}`);
});
