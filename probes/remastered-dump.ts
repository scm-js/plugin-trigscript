// The dump probe (TrigScript 4, 2026-10-16): what a dump of Remastered's own EUD emulator predicts, played. The
// script below does next to nothing; what is tried is probes/remastered-dump.py, hand-written eudplib built into the
// same map. It takes Magenta's `nudge` (probe 6, which ended the game) apart, one write each:
//   A   5  the first unit's X written: predicted to go through
//   B  15  its Y written: predicted to go through
//   C  25  its sprite's X and Y written: predicted to go through and change nothing on the screen
//   D  35  a read of the unit's field +0x74: predicted to END the game ("EUD not supported")
// Built with
//   EXTRA_PLUGIN=remasteredDump=probes/remastered-dump.py npx tsx scripts/build-fixture.mts probes/remastered-dump.ts fixtures/eud/remastered-dump.scx
import { program, displayText, P1 } from "trigscript";

program(() => {
  sleep(seconds(1));
  displayText("The dump probe: steps A to D, about 35 seconds. Each says what to look for.");
}, { owner: P1 });
