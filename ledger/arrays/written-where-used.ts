// ledger: step 8, takes
// An array written out where it is used, a value of the program in it: joined, its length, searched, walked, mapped,
// and spread into Math.max — as an array kept in a variable is.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print([n, 2, 8].join(", "));
  print(`${[1, n].length} ${[n, 4].indexOf(4)} ${[n, 4].includes(15)} ${[n, 7].map((x) => x * 2).join("+")} ${Math.max(...[n, 4])}`);
  for (const x of [n, 1]) print(`${x}`);
});
