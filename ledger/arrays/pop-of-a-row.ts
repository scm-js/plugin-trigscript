// ledger: step 9, takes
// `rows[i].pop() ?? -1`: a pop of a row of an array of arrays, the other value when the row is empty.
program(() => {
  const rows = [[1, 2], [3]];
  let i = 1;
  let a = 0;
  let b = 0;
  a = rows[i].pop() ?? -1;
  b = rows[i].pop() ?? -1;
  print(`${a} ${b}`);
});
