// ledger: step 0, takes
// A value kept between a low and a high: `clamp(a, 0, 10)`.
program(() => {
  let a = 0;
  while (a < 20) a += 7;
  print(`${clamp(a, 0, 10)}`);
});
