// ledger: step 8, refused: JSX made while the game runs
// A colour of the game's texts chosen while the game runs, in a printed line: `<cell color={c} />`, `c` one of
// `textColors`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  const c = n > 10 ? textColors.green : textColors.red;
  print(
    <line>
      Health <cell color={c} />
    </line>,
  );
});
