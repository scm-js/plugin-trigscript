// ledger: step 10, takes
// trigscript/cutscene: a unit sent to a point by a Move order, waited for until it is there: `await walk(u, x, y)`.
import { walk } from "trigscript/cutscene";
program(async () => {
  const u = first({ owner: P1 });
  if (u) {
    const there = await walk(u, 1200, 640);
    if (there) print("arrived");
  }
});
