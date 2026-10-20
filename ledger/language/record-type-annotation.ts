// ledger: step 0, takes
// A record with a declared type (an `interface`), and a field marked optional.
interface Wave {
  count: number;
  delay: number;
  boss?: boolean;
}
program(() => {
  let w: Wave = { count: 3, delay: 10 };
  while (w.count < 8) w.count += w.delay > 5 ? 2 : 1;
  print(`${w.count}`);
});
