// ledger: step 0, takes
// `satisfies`, a check of a type: it changes nothing in the map.
const LIMITS = { low: 5, high: 20 } satisfies Record<string, number>;
program(() => {
  let n = 0;
  while (n < LIMITS.high) n += LIMITS.low;
  print(`${n}`);
});
