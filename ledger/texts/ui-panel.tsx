// ledger: step 8, refused: JSX made while the game runs
// A title over the lines inside it, from `trigscript/ui`: `<Panel title={…}>…</Panel>`.
import { Panel } from "trigscript/ui";
program(async () => {
  let wave = 0;
  while (wave < 3) wave += 1;
  print(
    <Panel title={`Wave ${wave}`}>
      <line>Hold the bridge</line>
    </Panel>,
  );
});
