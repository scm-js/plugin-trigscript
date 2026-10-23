// ledger: step 0, takes
// A line of JSX written outside the program, worked out when the map is built, with a colour by name and a cell in one
// of `textColors`: `const title = <line color="yellow">…</line>`, then `print(title)`.
const title = (
  <line color="yellow">
    Score <cell color={textColors.orange} />
  </line>
);
program(() => {
  print(title);
});
