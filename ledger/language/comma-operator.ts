// ledger: step 0, takes
// The comma operator, in a `for` loop's update: both sides run, in order.
program(() => {
  let a = 0;
  let b = 10;
  let end = 0;
  while (end < 5) end += 1;
  for (let i = 0; i < end; i++, a += 2) b -= 1;
  print(`${a} ${b}`);
});
