// TrigScript 3.9's probe (slice 8½), part six: a Map and a Set over any number. Their entries are kept in the order the
// keys went in, as JavaScript keeps them, and a key is found through slots that are made again at twice the size when
// three quarters are taken. Play it alone (Use Map Settings): you are Player 1. Every line says what it expects —
// which is what JavaScript itself says of the same lines — so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  set, get, has, delete, size; a key below zero and one past 65535                          — expect 2 3 -1 1 0 1 0
//   5 s  B  the order: a key set again stays where it was, one deleted and set again goes last        — expect 30=4 20=3 10=5
//   8 s  C  a loop reaches what is added while it runs, and not what is deleted                       — expect 0 2 7 8 4
//  11 s  D  300 keys alike in their low 16 bits, half deleted, a third set again: six doublings       — expect 200 200 129850 1 1006 -1
//  16 s  E  a Set                                                                                     — expect 3 1000000 -2 1 4 1 0
//  19 s  F  3000 sets with a delete each, 100 a frame: NO "out of memory" in red may appear           — expect 3000 5 14990 2995 2996 2997 2998 2999
//  28 s  G  400 has() of a Map of 64 within ONE frame: does the game pause? (timed by eye)            — expect 320
//  31 s  H  a Map that is a field of a class, handed to a function                                    — expect 5:2 9:11
//  34 s  I  in a program of every player, a Map a player                                              — expect "I: <your name> 2 30"
//  37 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/map.ts fixtures/eud/map.scx`.
import { trigger, program, always, displayText, sleep, seconds, frames, name, P1, CurrentPlayer, AllPlayers } from "trigscript";

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  sleep(seconds(2));
  {
    const m = new Map<number, number>();
    let k = 70000;
    m.set(k, 1); m.set(-5, 2); m.set(k, 3); m.set(0, 9);
    const gone = m.delete(-5);
    const again = m.delete(-5);
    displayText(`A: ${m.size} ${m.get(k) ?? -1} ${m.get(-5) ?? -1} ${m.has(0) ? 1 : 0} ${m.has(1) ? 1 : 0} ${gone ? 1 : 0} ${again ? 1 : 0} (expect 2 3 -1 1 0 1 0)`);
  }

  sleep(seconds(3));
  {
    const m = new Map<number, number>();
    let a = 30;
    m.set(a, 1); m.set(10, 2); m.set(20, 3); m.set(a, 4); m.delete(10); m.set(10, 5);
    let s = "";
    for (const [k, v] of m) s += ` ${k}=${v}`;
    displayText(`B:${s} (expect 30=4 20=3 10=5)`);
  }

  sleep(seconds(3));
  {
    const m = new Map<number, number>();
    let n = 3;
    for (let i = 0; i < n; i++) m.set(i, i);
    let s = "";
    for (const [k] of m) { if (k == 0) { m.delete(1); m.set(7, 7); } if (k == 7) m.set(8, 8); s += `${k} `; }
    displayText(`C: ${s}${m.size} (expect 0 2 7 8 4)`);
  }

  sleep(seconds(3));
  {
    const m = new Map<number, number>();
    let n = 300;
    for (let i = 0; i < n; i++) { m.set(i * 65536, i); if (i % 50 == 49) sleep(frames(1)); }
    for (let i = 0; i < n; i += 2) m.delete(i * 65536);
    sleep(frames(1));
    for (let i = 0; i < n; i += 3) m.set(i * 65536, 1000 + i);
    sleep(frames(1));
    let sum = 0;
    let count = 0;
    for (const [k, v] of m) { sum += v; count++; }
    let first = -1;
    for (const k of m.keys()) { first = k / 65536; break; }
    displayText(`D: ${m.size} ${count} ${sum} ${first} ${m.get(6 * 65536) ?? -1} ${m.get(2 * 65536) ?? -1} (expect 200 200 129850 1 1006 -1)`);
  }

  sleep(seconds(4));
  {
    const s = new Set<number>([3, 1]);
    let k = 1000000;
    s.add(k); s.add(3); s.add(-2); s.delete(1); s.add(1);
    let t = "";
    for (const x of s) t += `${x} `;
    displayText(`E: ${t}${s.size} ${s.has(k) ? 1 : 0} ${s.has(4) ? 1 : 0} (expect 3 1000000 -2 1 4 1 0)`);
  }

  sleep(seconds(3));
  {
    const keep = new Map<number, number>();
    let turns = 0;
    let many = 3000;
    let total = 0;
    while (turns < many) {
      keep.set(turns, turns);
      if (keep.size > 5) keep.delete(turns - 5);
      total += keep.size;
      turns++;
      if (turns % 100 == 0) sleep(frames(1));
    }
    let s = "";
    for (const k of keep.keys()) s += ` ${k}`;
    displayText(`F: ${turns} ${keep.size} ${total}${s} - and no out of memory in red (expect 3000 5 14990 2995 2996 2997 2998 2999)`);
  }

  sleep(seconds(6));
  {
    const m = new Map<number, number>();
    let n = 64;
    for (let i = 0; i < n; i++) m.set(i * 1001, i);
    sleep(seconds(1));
    let hits = 0;
    let reads = 400;
    for (let i = 0; i < reads; i++) { if (m.has((i % 80) * 1001)) hits++; }
    displayText(`G: ${hits} - did the game pause just now? (expect 320)`);
  }

  sleep(seconds(3));
  {
    class Tally {
      counts = new Map<number, number>();
      add(k: number) { this.counts.set(k, (this.counts.get(k) ?? 0) + 1); }
    }
    function bump(m: Map<number, number>, k: number) { m.set(k, (m.get(k) ?? 0) + 10); }
    const t = new Tally();
    let k = 5;
    t.add(k); t.add(k); t.add(9);
    bump(t.counts, 9);
    let s = "";
    for (const [a, b] of t.counts) s += ` ${a}:${b}`;
    displayText(`H:${s} (expect 5:2 9:11)`);
  }

  sleep(seconds(6));
  displayText("done");
}, { owner: P1 });

program(() => {
  sleep(seconds(34));
  const mine = new Map<number, number>();
  mine.set(-1, 10); mine.set(500000, 20); mine.set(-1, 10);
  let sum = 0;
  for (const v of mine.values()) sum += v;
  displayText(`I: ${name(CurrentPlayer)} ${mine.size} ${sum} (expect your name, 2 30)`);
}, { owner: AllPlayers });
