// ledger: step 9, refused: an array that grows
// A loop over a `Map`'s keys and values, in the order the keys went in: `for (const [key, value] of map)`.
program(() => {
  const scores = new Map<number, number>();
  let key = 1;
  while (key < 20) {
    scores.set(key, key + 1);
    key += 6;
  }
  let total = 0;
  for (const [k, v] of scores) total += k + v;
  print(`${total}`);
});
