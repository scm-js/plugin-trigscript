// ledger: step 9, refused: a variable a closure keeps
// A closure that keeps a count, made in the program by a function of the script's (`const next = counter()`) and
// called at each turn of a loop: 1, 2, 3.
function counter() {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}
program(() => {
  const next = counter();
  let k = 0;
  while (k < 3) {
    print(`${next()}`);
    k += 1;
  }
});
