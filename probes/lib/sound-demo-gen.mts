// The sound demo's imported sound (probes/sound-demo.ts): a plucked string made here (Karplus–Strong at A3, 220 Hz),
// written as a .sound file the way Import Video… writes one, so the demo plays an import without anyone's recording.
//
//   npx tsx probes/lib/sound-demo-gen.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSound } from "../../compiler/sound";

const RATE = 22050, HZ = 220, SECONDS = 1.5;
const period = Math.round(RATE / HZ), out = new Float32Array(RATE * SECONDS);
let seed = 12345;
const line = Float32Array.from({ length: period }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x40000000 - 1) * 0.6);
for (let i = 0; i < out.length; i++) {
  const k = i % period, next = (k + 1) % period;
  out[i] = line[k];
  // The string's loss: each sample the average of itself and the next, a little less each time round.
  line[k] = 0.996 * 0.5 * (line[k] + line[next]);
}
writeFileSync(join(import.meta.dirname, "..", "pluck.sound"), writeSound({ rate: RATE, samples: out, source: "sound-demo-gen.mts" }));
console.log("probes/pluck.sound");
