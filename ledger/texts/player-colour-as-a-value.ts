// ledger: step 8, takes
// A player's name and colour kept in a text and looked into: the colour is one character, the code the game fills in;
// the name is as long as the player's.
program(() => {
  const c = `${color(P1)}`;
  const who = `${name(P1)}!`;
  print(`${c.length} ${c.charCodeAt(0) > 1} ${who.length > 1} ${who.endsWith("!")}`);
});
