// TrigScript 3.9's probe (slice 8½), part four: texts. A `string` of a program is the number of a text in the built
// map's table when it only ever holds texts written in the script, and a block of the programs' memory when it is made
// while the map is played. Play it alone (Use Map Settings): you are Player 1. Every line says what it expects, so a
// wrong answer shows. NOTHING in red may appear before step R, which is there to make one red line appear.
//
//   0 s  "trigger(): hello"
//   2 s  A  a made text kept across a sleep, the number it was made from changed meanwhile   — expect Wave 3
//   5 s  B  a copy does not follow what it was copied from                                   — expect x1y x1
//   8 s  C  texts of the map chosen by a variable: a list looked up, a ? : between two       — expect Hard late
//  11 s  D  compared: the same, not the same, before, a made one with one of the map         — expect 1 0 1 1
//  14 s  E  Korean counted in characters, found, asked about                                 — expect 10 4 1 1 1 0 -1
//  17 s  F  cut in the middle of Korean: slice, from the end, substring, s[i], at(-1)        — expect 글링a|bc0|링ab|글|0
//  20 s  G  padStart, padEnd, repeat                                                         — expect 007|7aba|===
//  23 s  H  for…of over a text, a character a turn, the text built back to front             — expect 0cba링글저 7
//  26 s  I  switch over a text of the map and over one that was made                         — expect 12
//  29 s  J  a function takes a text and returns one; a parameter it changes is its own       — expect [[wave 2] 3]! wave
//  32 s  K  3000 texts made, 100 a frame, each taking the last one's place: no red line      — expect number 2999, 64
//  41 s  L  the objectives (open them: F10, Mission Objectives): first a text of the map …   — expect "Hold the line"
//  47 s     … then one that was made. Open them again.                                       — expect "Wave 3: 12 Zerglings left"
//  53 s  M  a leaderboard whose label is made again every second for five seconds            — expect "Kills at 53" … "Kills at 57"
//  59 s  N  a transmission whose line was made                                               — expect "Marine 7 reporting, wave 3"
//  65 s  O  a Marine's name made: select one                                                 — expect "Marine of wave 3"
//  68 s  P  in a program of every player, a made text with your name kept in it              — expect "P: <your name> has 5 lives"
//  71 s  Q  an emoji: one character to a program; the game is believed to draw nothing of it  — expect 3, and what is between the bars?
//  74 s  R  a text past what one holds: ONE red line saying a text was cut off, and          — expect 1023
//  77 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/strings.ts fixtures/eud/strings.scx`.
import { trigger, program, always, displayText, print, sleep, seconds, frames, name, setMissionObjectives, leaderboardKills, leaderboardComputerPlayers, transmission, stats, units, locations, P1, CurrentPlayer, AllPlayers } from "trigscript";

trigger(P1, [always()], [displayText("trigger(): hello")]);

const titles = ["Easy", "Hard", "Insane"];

program(() => {
  let wave = 3;
  let one = 1;

  sleep(seconds(2));
  let kept = `Wave ${wave}`;
  wave = 99;
  sleep(seconds(1));
  print(`A: ${kept} (expect Wave 3)`);
  wave = 3;

  sleep(seconds(2));
  let a = `x${one}`;
  let b = a;
  a += "y";
  print(`B: ${a} ${b} (expect x1y x1)`);

  sleep(seconds(3));
  let level = one;
  let title = titles[level];
  let mood = wave > 2 ? "late" : "early";
  print(`C: ${title} ${mood} (expect Hard late)`);

  sleep(seconds(3));
  let red = "red";
  let made = `re${"d"}${one}`;
  let same = red == "red" ? 1 : 0;
  let differs = red != "red" ? 1 : 0;
  let before = "re" < red ? 1 : 0;
  let mixed = made == "red1" && made > red ? 1 : 0;
  print(`D: ${same} ${differs} ${before} ${mixed} (expect 1 0 1 1)`);

  sleep(seconds(3));
  let ko = `저글링 wave ${wave - 1}`;
  let starts = ko.startsWith("저글") ? 1 : 0;
  let ends = ko.endsWith("2") ? 1 : 0;
  let has = ko.includes("wave") ? 1 : 0;
  let hasNot = ko.includes("boss") ? 1 : 0;
  print(`E: ${ko.length} ${ko.indexOf("wave")} ${starts} ${ends} ${has} ${hasNot} ${ko.indexOf("e", 9)} (expect 10 4 1 1 1 0 -1)`);

  sleep(seconds(3));
  let s = `저글링abc${one - 1}`;
  print(`F: ${s.slice(1, 4)}|${s.slice(-3)}|${s.substring(5, 2)}|${s[1]}|${s.at(-1) ?? "?"} (expect 글링a|bc0|링ab|글|0)`);

  sleep(seconds(3));
  let seven = String(wave + 4);
  print(`G: ${seven.padStart(3, "0")}|${seven.padEnd(4, "ab")}|${"=".repeat(wave)} (expect 007|7aba|===)`);

  sleep(seconds(3));
  let back = String("");
  let turns = 0;
  for (const ch of s) { back = ch + back; turns++; }
  print(`H: ${back} ${turns} (expect 0cba링글저 7)`);

  sleep(seconds(3));
  let picked = 0;
  switch (mood) { case "early": picked = 1; break; case "late": picked = 10; break; default: picked = 100; }
  switch (kept) { case "Wave 2": picked += 1; break; case "Wave 3": picked += 2; break; }
  print(`I: ${picked} (expect 12)`);

  sleep(seconds(3));
  function tag(what: string, n: number): string { return `[${what} ${n}]`; }
  function shout(text: string): string { text += "!"; return text; }
  let word = `wa${"ve"}`;
  let tagged = shout(tag(tag(word, 2), 3));
  print(`J: ${tagged} ${word} (expect [[wave 2] 3]! wave)`);

  sleep(seconds(3));
  let last = String("");
  let count = 0;
  let many = 3000;
  while (count < many) {
    last = `number ${count}`;
    count++;
    if (count % 100 == 0) sleep(frames(1));
  }
  // The heap is whole if an array can still grow to what it could at the start.
  const room: number[] = [];
  let sixtyFour = 64;
  for (let i = 0; i < sixtyFour; i++) room.push(i);
  print(`K: ${last}, ${room.length} - and no red line (expect number 2999, 64)`);

  sleep(seconds(4));
  let objective = wave > 2 ? "Hold the line" : "Scout";
  setMissionObjectives(objective);
  print("L: open the objectives (F10, Mission Objectives): expect Hold the line");
  sleep(seconds(6));
  let left = 12;
  setMissionObjectives(`Wave ${wave}: ${left} Zerglings left`);
  print("L: open them again: expect Wave 3: 12 Zerglings left");

  sleep(seconds(6));
  leaderboardComputerPlayers("disable");
  print("M: a leaderboard whose label counts: Kills at 53 … Kills at 57");
  let second = 53;
  while (second < 58) {
    leaderboardKills(`Kills at ${second}`, units.TerranMarine);
    second++;
    sleep(seconds(1));
  }

  sleep(seconds(1));
  let who = 7;
  transmission(`Marine ${who} reporting, wave ${wave}`, units.TerranMarine, locations.Anywhere, "set", 4000, "sound\\Misc\\Buzz.wav", 1000);
  print("N: the transmission's line: expect Marine 7 reporting, wave 3");

  sleep(seconds(6));
  stats(units.TerranMarine).name = `Marine of wave ${wave}`;
  print("O: select a Marine: expect Marine of wave 3");

  sleep(seconds(6));
  let face = `|${"\u{1F600}"}|`;
  print(`Q: ${face.length} ${face} (expect 3 - and what is between the bars?)`);

  sleep(seconds(3));
  let long = "0123456789".repeat(wave * 40);
  print(`R: ${long.length} - and ONE red line above saying a text was cut off (expect 1023)`);

  sleep(seconds(3));
  print("done");
}, { owner: P1 });

program(() => {
  sleep(seconds(68));
  let lives = 5;
  let mine = `${name(CurrentPlayer)} has ${lives} lives`;
  lives = 0;
  print(`P: ${mine} (expect your name, has 5 lives)`);
}, { owner: AllPlayers });
