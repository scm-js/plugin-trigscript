// TrigScript 4, the backend: texts made while the game runs, in a map of our own (scripts/build-own.mts) — step 8 of
// the way off eudplib, part 2. A made text is in a block of its own (a string of the map's: printed alone, it is shown
// as it is), made at a cursor and read a byte at a time where it is. Built both ways (through eudplib, and as a map of
// our own), the lifted game should print the same lines at the same frames; every line should end "ok", and the lines
// that show a made text say what they should show.
//   npx tsx scripts/build-own.mts probes/own-made-texts.ts /tmp/own-made-texts.scx
//   npx tsx scripts/build-fixture.mts probes/own-made-texts.ts /tmp/own-made-texts-eud.scx
import { program, print, sleep, frames } from "trigscript";
import { clock, thousands } from "trigscript/ui";

function label(name: string, n: number): string {
  return `${name} x${n}`;
}

program(() => {
  let n = 0;
  while (n < 12) n += 5;
  // A: a number made a text, kept and printed alone; a template compared with a known text.
  const a: string = String(n);
  print(a);
  if (`${n}` === "15" && a !== String(n + 1) && a === "15" && a.length == 2) print("A: made and compared ok"); else print("A: made and compared WRONG");
  // B: padded, repeated, a function's text, the game's time.
  print(`B: [${a.padStart(4, "0")}] [${"ab".repeat(n / 5)}] ${label(n > 10 ? "Medic" : "Marine", n)} ${clock(1512)} ${thousands(n * 823)} (should say [0015] [ababab] Medic x15 1:03 12,345)`);
  sleep(frames(1));
  // C: what library functions make of a made text: trim, case, replace, and a number read back from it.
  let words = `  ${n > 10 ? "banana" : "papaya"} split  `;
  words = words.trim();
  print(`C: [${words}] [${words.toUpperCase()}] [${words.replace("a", "o")}] [${words.replaceAll("a", "o")}] (should say [banana split] [BANANA SPLIT] [bonana split] [bonono split])`);
  const number = ` ${n * 3} ore`;
  if (parseInt(number) == 45 && isNaN(parseInt("none")) && number.indexOf("ore") == 4 && number.includes("45") && number.endsWith("ore") && !number.startsWith("4")) print("C: read back and searched ok");
  else print("C: read back and searched WRONG");
  sleep(frames(1));
  // D: walked a character at a time; a slice of it; made in a loop, one character more each time.
  let vowels = 0;
  for (const ch of words) if (ch === "a" || ch === "e" || ch === "i") vowels += 1;
  let typed = "";
  let k = 0;
  while (k < words.length) {
    typed = words.slice(0, k + 1);
    k += 1;
  }
  if (vowels == 4 && typed === words && words.slice(7) === "split" && words.charCodeAt(1) == 97) print("D: walked, sliced, typed ok"); else print("D: walked, sliced, typed WRONG");
  // (`[n, 2, 8].join(…)` is refused by the front end — an array literal holding a value of the program, as a call's
  // argument: noted in the plan as a gap; the array is made first here.)
  const xs = [5, 2, 8];
  xs[0] = n;
  print(`D: ${xs.join(", ")} (should say 15, 2, 8)`);
});
