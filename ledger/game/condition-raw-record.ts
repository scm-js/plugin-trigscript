// ledger: step 5, takes
// A condition by its raw type number and fields, `condition(type, …)`: what StarEdit stores, for a type the
// editor does not know (here 15, Deaths).
program(() => {
  if (condition(15, 0, 0, 3, 0, 0, 0)) print("yes");
});
