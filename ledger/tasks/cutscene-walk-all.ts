// ledger: step 10, refused: a unit kept in a variable
// trigscript/cutscene: a group of units sent to a point together, waited for until each is there: `await walkAll(group, x, y)`.
import { walkAll } from "trigscript/cutscene";
program(async () => {
  const group = [first({ owner: P1, type: units.TerranMarine })!, first({ owner: P1, type: units.TerranFirebat })!];
  const there = await walkAll(group, 1200, 640);
  print(`${there}`);
});
