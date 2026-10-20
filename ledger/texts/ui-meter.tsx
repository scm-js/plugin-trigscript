// ledger: step 8, refused: JSX made while the game runs
// A labelled bar, green, yellow or red by how full it is, from `trigscript/ui`:
// `<Meter label="Base" value={hp} max={1500} />`.
import { Meter } from "trigscript/ui";
program(async () => {
  let hp = 0;
  while (hp < 900) hp += 400;
  print(<Meter label="Base" value={hp} max={1500} />);
});
