// ledger: step 8, takes
// A text put into a record a character at a time, from `trigscript/ui`: `await typewriter(box, "…")`.
import { typewriter } from "trigscript/ui";
program(async () => {
  const box = { text: "" };
  await typewriter(box, "Incoming!");
  print(box.text);
});
