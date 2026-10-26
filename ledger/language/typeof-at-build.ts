// ledger: step 0, takes
// `typeof` worked out when the map is built: only the branch it picks is left in the map.
const LIMIT: number | string = 30;
program(() => {
  let n = 0;
  if (typeof LIMIT === "number") {
    while (n < LIMIT) n += 7;
  }
  print(`${n}`);
});
