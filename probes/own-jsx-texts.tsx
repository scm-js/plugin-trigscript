// TrigScript 4, step 8 part 3 on our own backend: JSX put together while the game runs, a player's name and colour in
// a printed line, an array of texts written at a place that changes, and a text in each row of an array of records.
// Built both ways (`build-own`, `build-fixture`): the lines and the frames are the same.
import { Meter } from "trigscript/ui";

program(() => {
  let n = 0;
  while (n < 12) n += 5;
  // A: JSX with a number of the program's, a colour chosen as the game runs, a meter from `trigscript/ui`.
  print(<line>A: Wave {n} (should say A: Wave 15)</line>);
  const c = n > 10 ? textColors.green : textColors.red;
  print(
    <line>
      A: <cell color={c} /> (should be a green square)
    </line>,
  );
  print(<Meter label="A: Base" value={n * 80} max={1500} />);
  sleep(frames(1));
  // B: the players' names and colours, filled in by the game.
  print(`B: ${name(P1)} is ${color(P1)}you\x04 (should be your name, then "you" in your colour)`);
  print(`B: ${color(P2)}${name(P2)}\x04 is there (should be the computer's name, in its colour)`);
  sleep(frames(1));
  // C: an array of texts, written at a place that changes and read back; joined; a text in each row of records.
  const names = ["Marine", "Marine", "Marine"];
  let i = 0;
  while (i < 2) i += 1;
  names[i] = "Medic";
  names[0] = `${names[i]} x${n}`;
  print(`C: ${names.join(", ")} (should say C: Medic x15, Marine, Medic)`);
  const heroes = [
    { name: "Raynor", hp: 5 },
    { name: "Kerrigan", hp: 7 },
  ];
  let h = 0;
  while (h < 1) h += 1;
  heroes[h].name = "Tassadar";
  if (heroes[h].name === "Tassadar" && heroes[0].name.length == 6 && names[1] !== names[2]) print("C: records ok");
  else print("C: records WRONG");
});
