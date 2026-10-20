// TrigScript 4, the backend: arrays in a map of our own (scripts/build-own.mts) — each array a region of cell triggers
// the layout makes, a read at an index a jump into its cell, a store one action whose destination follows the index.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the
// same frames; every line should end "ok", and a line ending "WRONG" names the check that failed.
//   npx tsx scripts/build-own.mts probes/own-arrays.ts /tmp/own-arrays.scx
//   npx tsx scripts/build-fixture.mts probes/own-arrays.ts /tmp/own-arrays-eud.scx
import { program, print, sleep, frames } from "trigscript";

const SQUARES = [0, 1, 4, 9, 16, 25, 36, 49];
const BIG = [100000, -7, 2147483647, 65536, 3];

program(() => {
  print("Own arrays: the payload runs.");
  // A: written at a variable's index, read back.
  let board = new Array(10).fill(0);
  let i = 0, sum = 0;
  while (i < 10) { board[i] = i * 3 + 1; i++; }
  i = 0;
  while (i < 10) { sum += board[i]; i++; }
  if (sum == 145 && board[3] == 10) print("A: store and read at an index ok"); else print("A: store and read at an index WRONG");
  // B: a grid, its rows windows on one array.
  let grid: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let y = 0;
  while (y < 3) { let x = 0; while (x < 4) { grid[y][x] = y * 10 + x; x++; } y++; }
  let row = 2, col = 3;
  if (grid[row][col] == 23 && grid[1][0] == 10 && grid[0][3] == 3) print("B: a grid's rows ok"); else print("B: a grid's rows WRONG");
  sleep(frames(4));
  // C: past either end a read is 0 and a store is nothing.
  let far = 12, below = -1;
  board[far] = 99;
  board[below] = 99;
  if (board[far] == 0 && board[below] == 0 && board[9] == 28) print("C: past the ends ok"); else print("C: past the ends WRONG");
  // D: booleans: the primes below 200 by a sieve.
  let composite = new Array<boolean>(200).fill(false);
  let n = 2, primes = 0;
  while (n < 200) {
    if (!composite[n]) { primes++; let m = n * 2; while (m < 200) { composite[m] = true; m += n; } }
    n++;
  }
  if (primes == 46) print("D: a sieve of booleans ok"); else print("D: a sieve of booleans WRONG");
  sleep(frames(4));
  // E: lists known when the map is built, narrow and wide values, read at a variable's index.
  let k = 5, e = 0;
  e += SQUARES[k];
  k = 2;
  e += BIG[k] - 2147483600;
  k = 1;
  e += BIG[k];
  if (e == 25 + 47 - 7) print("E: lists known when built ok"); else print("E: lists known when built WRONG");
  // F: declared again in a loop, it starts again.
  let turns = 0, seen = 0;
  while (turns < 3) {
    let fresh = [7, 7, 7];
    seen += fresh[turns];
    fresh[turns] = 1;
    turns++;
  }
  if (seen == 21) print("F: declared again ok"); else print("F: declared again WRONG");
  sleep(frames(4));
  // G: a function that reads an array, called twice.
  function total(upto: number): number {
    let s = 0, j = 0;
    while (j < upto) { s += board[j]; j++; }
    return s;
  }
  if (total(3) == 12 && total(10) == 145) print("G: a function reads an array ok"); else print("G: a function reads an array WRONG");
  // H: a sieve up to 2000 in one frame.
  let big = new Array<boolean>(2000).fill(false);
  n = 2;
  primes = 0;
  while (n < 2000) {
    if (!big[n]) { primes++; let m = n * 2; while (m < 2000) { big[m] = true; m += n; } }
    n++;
  }
  if (primes == 303) print("H: a sieve up to 2000 ok"); else print("H: a sieve up to 2000 WRONG");
  sleep(frames(4));
  // I: a cell read before a call that stores into it reads what was there; a loop's test that reads a cell the loop
  // stores into is tested every turn.
  let cells = [1, 2, 3];
  function bump(): number { cells[0] = 10; return 1; }
  let before = cells[k - 1] + bump();
  let turnsI = 0;
  let open = [true, true, true, true];
  while (open[1] && turnsI < 4) { turnsI++; open[1] = turnsI < 2; }
  if (before == 2 && cells[0] == 10 && turnsI == 2) print("I: reads in order ok"); else print("I: reads in order WRONG");
  // J: a cell against a constant in a test, signed: below zero, above, the ends; and past the end, 0.
  let signs = [-5, 0, 7, -2147483648, 2147483647];
  let j = 0, negative = 0, above = 0;
  while (j < 6) { if (signs[j] < 0) negative++; if (signs[j] > 0) above++; if (signs[j] >= -5 && signs[j] <= 0) above += 10; j++; }
  if (negative == 2 && above == 2 + 30) print("J: cells in tests ok"); else print("J: cells in tests WRONG");
  print("Own arrays: done.");
});
