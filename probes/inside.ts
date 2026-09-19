// TrigScript 3.9's probe (slice 8½), part three: arrays inside arrays and inside records. An array of arrays whose rows
// are all one length is one flat array, a row a window on it; rows of different lengths, or a row something pushes to,
// are rows that grow, each a block of the heap found through the outer array. Play it alone (Use Map Settings): you are
// Player 1. Every line says what it expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  an 8 × 8 grid filled by two loops and read back: the sum, and one cell            — expect 2016 29
//   5 s  B  a row past its own end reads 0 and stores nothing: the next row is untouched      — expect 0 8
//   8 s  C  a row kept, sorted the other way round and summed by a function                   — expect 23 156
//  11 s  D  whole rows pushed to one that starts empty, one popped                            — expect 4 9
//  14 s  E  rows that grow: one pushed to ten times (past its first blocks), one stored into  — expect 10 9 12
//  17 s  F  3000 rows pushed and cut off again, 100 a frame: NO "out of memory" in red may appear — expect 3000 1
//  24 s  G  arrays in a record, fixed and growing                                             — expect 5 17
//  27 s  H  in a program of every player, rows a player — expect "H: <your name> 3 7 5"
//  30 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/inside.ts fixtures/eud/inside.scx`.
import { trigger, program, always, displayText, sleep, seconds, frames, name, P1, CurrentPlayer, AllPlayers } from "trigscript";

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  // A bound that is a variable keeps a loop a loop: one whose bounds the script knows is written out turn by turn.
  let eight = 8;
  let g = new Array(8).fill(0).map(() => new Array(8).fill(0));
  function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }

  sleep(seconds(2));
  for (let y = 0; y < eight; y++) for (let x = 0; x < eight; x++) g[y][x] = y * 8 + x;
  let sum = 0;
  for (const row of g) sum += total(row);
  let three = 3;
  displayText(`A: ${sum} ${g[three][three + 2]} (expect 2016 29)`);

  sleep(seconds(3));
  let zero = 0;
  const past = g[zero][eight];
  g[zero][eight] = 99;
  displayText(`B: ${past} ${g[1][0]} (expect 0 8)`);

  sleep(seconds(3));
  let two = 2;
  const row = g[two];
  two = 5;
  row.sort((a, b) => b - a);
  displayText(`C: ${row[0]} ${total(g[2])} (expect 23 156)`);

  sleep(seconds(3));
  const path: number[][] = [];
  let five = 5;
  for (let i = 0; i < five; i++) path.push([i, i * i]);
  path.pop();
  displayText(`D: ${path.length} ${path[path.length - 1][1]} (expect 4 9)`);

  sleep(seconds(3));
  let b = [[1, 2], [], [3]];
  let ten = 10;
  for (let i = 0; i < ten; i++) b[1].push(i);
  b[zero][1] += 10;
  displayText(`E: ${b[1].length} ${b[1][9]} ${b[0][1]} (expect 10 9 12)`);

  sleep(seconds(3));
  const rows: number[][] = [[1]];
  let turns = 0;
  let many = 3000;
  while (turns < many) {
    rows.push([turns, 1, 2, 3, 4]);
    rows[rows.length - 1].push(5);
    if (rows.length > 3) rows.length = 1;
    turns++;
    if (turns % 100 == 0) sleep(frames(1));
  }
  displayText(`F: ${turns} ${rows[0].length} - and no out of memory in red (expect 3000 1)`);

  sleep(seconds(6));
  let p = { hp: 5, trail: [1, 2, 3], seen: [] as number[] };
  let one = 1;
  p.trail[one] += 10;
  p.seen.push(p.trail[1]);
  p.seen.push(p.hp);
  let seen = 0;
  for (const s of p.seen) seen += s;
  displayText(`G: ${p.seen.length + p.trail.length} ${seen} (expect 5 17)`);

  sleep(seconds(6));
  displayText("done");
}, { owner: P1 });

program(() => {
  sleep(seconds(27));
  let mine = [[1], [2, 3]];
  mine[0].push(4);
  mine.push([5, 6, 7]);
  let cells = 0;
  for (const r of mine) cells += r.length;
  displayText(`H: ${name(CurrentPlayer)} ${mine.length} ${cells} ${mine[2][0]} (expect your name, 3 7 5)`);
}, { owner: AllPlayers });
