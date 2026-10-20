// ledger: step 8, takes
// A bar of squares in a line of JSX, as long as a value of the program: `<bar value={hp} max={100} width={10} />`.
program(() => {
  let hp = 0;
  while (hp < 60) hp += 25;
  print(
    <line>
      Base <bar value={hp} max={100} width={10} />
    </line>,
  );
});
