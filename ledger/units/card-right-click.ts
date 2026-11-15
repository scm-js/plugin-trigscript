// ledger: step 10, takes
// trigscript/card: a right-click on a command card button, in a single-player map: `new CardButton(techs.Restoration, cardSlots.Restoration)`, `await button.begin()` before the program's loop and `await button.rightClicked()` on each pass; `cardSetup()` at the top of a script.
import { CardButton, cardSlots, cardSetup } from "trigscript/card";
cardSetup({ afterCalibration: () => print("Measured"), showMeasurements: true });
program(async () => {
  const button = new CardButton(techs.Restoration, cardSlots.Restoration);
  await button.begin();
  let clicks = 0;
  while (true) {
    if (await button.rightClicked()) {
      clicks += 1;
      print(`${clicks}`, { to: CurrentPlayer });
    }
    await nextFrame();
  }
}, { owner: AllPlayers });
