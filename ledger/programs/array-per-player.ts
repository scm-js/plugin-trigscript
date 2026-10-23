// ledger: step 7, takes
// An array in a program for several players: each player's run its own cells, `const marks = [0, 0, 0]`.
program(() => {
  const marks = [0, 0, 0];
  let i = 0;
  while (i < 3) {
    marks[i] += i + 1;
    i += 1;
  }
  print(`${marks[0] + marks[1] + marks[2]}`);
}, { owner: [P1, P2] });
