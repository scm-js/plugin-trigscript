// ledger: step 3, takes
// `fill(value, start, end)`: a part of an array set, the places counted from the end when below zero and cut to the array.
program(() => {
  const xs = [1, 2, 3, 4, 5];
  let v = 9;
  let s = 1;
  xs.fill(v, s, 3);
  xs.fill(0, -1);
  print(`${xs[0]} ${xs[1]} ${xs[2]} ${xs[3]} ${xs[4]}`);
});
