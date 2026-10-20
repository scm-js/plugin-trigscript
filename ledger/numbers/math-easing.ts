// ledger: step 4, refused: a product of fixed numbers
// The easing curves of `trigscript/math`, how far along a motion is at a fraction of its time: `easeInQuad`,
// `easeOutQuad`, `easeInOutQuad`, `easeInCubic`, `easeOutCubic`, `easeOutBack` and `smoothstep`, each of `t`.
import { easeInCubic, easeInOutQuad, easeInQuad, easeOutBack, easeOutCubic, easeOutQuad, smoothstep } from "trigscript/math";
program(() => {
  let t = 0;
  while (t < 0.5) t += 0.125;
  let past = 0;
  if (easeInQuad(t) > 0.5) past += 1;
  if (easeOutQuad(t) > 0.5) past += 1;
  if (easeInOutQuad(t) > 0.5) past += 1;
  if (easeInCubic(t) > 0.5) past += 1;
  if (easeOutCubic(t) > 0.5) past += 1;
  if (easeOutBack(t) > 0.5) past += 1;
  if (smoothstep(t) > 0.5) past += 1;
  print(`${past} past half`);
});
