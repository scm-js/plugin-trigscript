// ledger: step 5, refused: a text at the centre of the screen
// trigscript/cutscene: a line of a scene, the speaker's portrait talking and the words in the middle of the screen: `await line(speaker, text)`.
import { line, SECOND } from "trigscript/cutscene";
program(async () => {
  await line(units.JimRaynorMarine, "Something's moving out there.", 3 * SECOND);
});
