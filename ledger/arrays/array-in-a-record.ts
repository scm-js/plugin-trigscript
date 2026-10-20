// ledger: step 3, takes
// An array of a fixed length that is a field of a record: `shop.stock[i]`.
program(() => {
  const shop = { gold: 10, stock: [3, 3, 3] };
  let i = 0;
  while (i < 2) i += 1;
  shop.stock[i] -= 1;
  print(`${shop.stock[i] + shop.gold}`);
});
