// ledger: step 12, refused: the players' input (key)
// Someone speaking to a player, the words typed in, closed with Space, from `trigscript/ui`:
// `await say(P1, talk, "Raynor", "…")` and `<DialogBox box={talk} />`.
import { DialogBox, say } from "trigscript/ui";
program(async () => {
  const talk = { speaker: "", text: "", open: false };
  ui.lines(P1, () => <DialogBox box={talk} />);
  await say(P1, talk, "Raynor", "Hold the bridge until dawn.");
});
