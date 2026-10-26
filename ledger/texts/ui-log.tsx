// ledger: step 9, takes
// A log that keeps its last lines, shown a line each, from `trigscript/ui`: `log(lines, text)` and
// `<LogLines lines={lines} />`.
import { LogLines, log } from "trigscript/ui";
program(async () => {
  const lines: string[] = [];
  let wave = 0;
  while (wave < 8) {
    wave += 1;
    log(lines, wave > 4 ? "a wave" : "a quiet wave", 3);
  }
  print(<LogLines lines={lines} />);
});
