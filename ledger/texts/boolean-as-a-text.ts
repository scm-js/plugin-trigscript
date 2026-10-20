// ledger: step 8, takes
// A boolean of the program as a text, true or false: `` `${done}` ``.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  const done = n > 10;
  print(`${done}`);
});
