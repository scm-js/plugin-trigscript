// ledger: step 10, takes
// trigscript/cutscene: a unit sent to a point by an Attack order, fighting on the way: `await charge(u, x, y)`.
import { charge } from "trigscript/cutscene";
program(async () => {
  const u = first({ owner: P1 });
  if (u) {
    await charge(u, 1200, 640);
  }
});
