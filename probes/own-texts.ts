// TrigScript 4, the backend: texts known when the map is built, chosen while the game runs, in a map of our own
// (scripts/build-fixture.mts) — step 8 of the way off eudplib, part 1. A text that is one of a few the script wrote is a
// number there: its place in the script's pool of texts, which the map's strings hold in order. Built both ways
// (through eudplib, and as a map of our own), the lifted game should print the same lines at the same frames; every
// line ending "ok" says so, and the lines that show a chosen text say what they should show.
//   npx tsx scripts/build-fixture.mts probes/own-texts.ts /tmp/own-texts.scx
//   npx tsx scripts/build-fixture.mts probes/own-texts.ts /tmp/own-texts-eud.scx
import { program, print, sleep, frames } from "trigscript";

const NAMES = ["Raynor", "Kerrigan", "Tassadar", "Zeratul", "Artanis"];

program(() => {
  let n = 0;
  let i = 0;
  while (n < 12) n += 5;
  while (i < 3) i += 1;
  // A: a chosen text printed alone (Display Text of the string its number names), then in a printed text.
  print(n > 10 ? "A: Medic (should say Medic)" : "A: Marine WRONG");
  print(`A: ${NAMES[i]} ready (should say Zeratul)`);
  // B: compared — the same text, and in the order of their characters.
  const a = n > 10 ? "Medic" : "Marine";
  const b = i > 2 ? "Marine" : "Medic";
  if (a !== b && b < a && a === "Medic" && NAMES[i] > NAMES[i - 1]) print("B: compared ok"); else print("B: compared WRONG");
  // C: what a function of one gives: its length, a search, a character's number, a slice.
  if (a.length == 5 && a.includes("ed") && !b.startsWith("Me") && b.endsWith("ine") && a.indexOf("c", i) == 4 && b.charCodeAt(i) == 105) print("C: length, search, character ok");
  else print("C: length, search, character WRONG");
  const s = "Terran Marine";
  print(`C: [${s.slice(i + 4, i + 8)}] [${s[i + 3]}${s.charAt(i + 4)}${s.at(-1)}] (should say [Mari] [ Me])`);
  sleep(frames(1));
  // D: a variable only ever given texts the script wrote, and a switch on it.
  let word = "red";
  if (n > 10) word = "green";
  if (i > 5) word = "blue";
  switch (word) {
    case "red": print("D: switch WRONG (red)"); break;
    case "green": print("D: switch ok"); break;
    default: print("D: switch WRONG (blue)");
  }
  print(`D: ${word} light, ${a.length + word.length} letters (should say green light, 10 letters)`);
  // E: a choice of many texts written byte by byte into a printed text, and characters past one byte.
  const t = n > 10 ? "■●" : "a";
  print(`E: ${NAMES[i]}/${NAMES[i - 1]}/${t}${t.length} (should say Zeratul/Tassadar/■●2)`);
  // F: a chosen text as an action's text (a transmission).
  transmission(n > 10 ? "F: transmitted (should say this)" : "F: transmitted WRONG", units.TerranMarine, locations.Anywhere, "add", 0, "", 500);
});
