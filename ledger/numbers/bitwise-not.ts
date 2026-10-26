// ledger: step 4, takes
// `~a`: every bit the other way, a ^ −1 — JavaScript's −a − 1 of a signed number.
program(() => {
  let a = 5;
  let b = 0;
  b = ~a;
  print(`${b} ${~a + a}`);
});
