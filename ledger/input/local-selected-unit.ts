// ledger: step 12, takes
// The unit this computer has selected, kept and its hit points shown: `const u = local.selected; if (u) … u.hp`.
program(() => {
  const u = local.selected;
  if (u) print(`${u.hp}`);
});
