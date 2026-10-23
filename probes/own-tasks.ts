// TrigScript 4, the backend: tasks and Promise.all / race in a map of our own (scripts/build-fixture.mts) — step 11 of the
// way off eudplib, part 2. The program, each task's slot and each branch of a Promise.all or race is a coroutine: a
// trigger that wakes it once the map's count of frames reaches the frame its sleep wrote. The tasks have their turn
// after the program's, a start's slots in order; a slot with nothing in it is passed by as done.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same
// frames; every line should end "ok", and a line ending "WRONG" names the check that failed. The frames after "Weighed"
// are to weigh. One line says in red that a task did not start, as a start whose tasks all run says it.
//   npx tsx scripts/build-fixture.mts probes/own-tasks.ts /tmp/own-tasks.scx
//   npx tsx scripts/build-fixture.mts probes/own-tasks.ts /tmp/own-tasks-eud.scx
import { program, print, sleep, frames } from "trigscript";
import { every, after } from "trigscript/timers";

program(async () => {
  let waves = 0, turns = 0, children = 0, work = 0;
  /** Ends after n frames, giving back twice n. */
  async function slow(n: number): Promise<number> {
    await sleep(frames(n));
    return n * 2;
  }
  /** Says when it ends, n frames on. */
  async function wave(n: number) {
    await sleep(frames(n));
    waves += n;
  }
  /** Counts its turns until cancelled. */
  async function forever() {
    while (true) {
      turns += 1;
      await sleep(frames(1));
    }
  }
  /** Starts a task of its own a frame after it starts. */
  async function parent() {
    await sleep(frames(1));
    start(child(2));
  }
  async function child(n: number) {
    await sleep(frames(n));
    children += 1;
  }
  /** Ends on an error after n frames. */
  async function fails(n: number) {
    await sleep(frames(n));
    if (n > 0) throw new RangeError(`failed after ${n}`);
  }
  /** Weighed: asleep for a long while. */
  async function sleeper() {
    await sleep(frames(400));
  }
  /** Weighed: awake every frame, a little each turn. */
  async function busy(n: number) {
    let i = 0;
    while (i < n) {
      work += 1;
      i += 1;
      await sleep(frames(1));
    }
  }

  print("Own tasks: the payload runs.");
  let k = 0;
  while (k < 2) k += 1;

  // A: a task awaited, `running` true until it ends, a task cancelled where it waits.
  const t = start(slow(3));
  let seen = 0;
  while (t.running) {
    seen += 1;
    await sleep(frames(1));
  }
  const f = start(forever());
  await sleep(frames(5));
  const was = f.running;
  f.cancel();
  const counted = turns;
  await sleep(frames(3));
  if (seen == 4 && was && !f.running && turns == counted && counted == 5) print("A: awaited, running, cancelled ok");
  else print(`A: awaited, running, cancelled WRONG ${seen} ${was} ${counted} ${turns}`);

  // B: a start's slots — three at once of a start that lets two run: the third does not start (said in red).
  let i = 1;
  let started = 0;
  while (i <= 3) {
    const w = start(wave(i + k), { max: 2 });
    if (w.running) started += 1;
    i += 1;
  }
  await sleep(frames(6));
  const again = start(wave(1), { max: 2 });
  await again;
  if (started == 2 && waves == 3 + 4 + 1) print("B: slots ok"); else print(`B: slots WRONG ${started} ${waves}`);

  // C: Promise.all and Promise.race, their values.
  const [a, b] = await Promise.all([slow(2), slow(k + 2)]);
  const r = await Promise.race([slow(5), slow(k + 1)]);
  if (a == 4 && b == 8 && r == 6) print("C: all and race ok"); else print(`C: all and race WRONG ${a} ${b} ${r}`);

  // D: a task that starts one; E: every and after.
  start(parent());
  let ticks = 0, fired = 0;
  const e = every(2, (n) => {
    ticks = n;
  });
  after(5, () => {
    fired += 1;
  });
  await sleep(frames(9));
  e.cancel();
  await sleep(frames(2));
  if (children == 1 && ticks == 4 && fired == 1) print("D-E: a task's task, every and after ok"); else print(`D-E: WRONG ${children} ${ticks} ${fired}`);

  // F: an error a task ends on, caught where it is awaited.
  let caught = "";
  const g = start(fails(k));
  try {
    await g;
  } catch (err) {
    if (err instanceof RangeError) caught = err.message;
  }
  if (caught == "failed after 2") print("F: a task's error caught ok"); else print(`F: a task's error WRONG ${caught}`);
  await sleep(frames(4));

  print("Weighed:");
  // W1: sixteen tasks asleep, a frame where none wakes.
  let s = 0;
  while (s < 16) {
    start(sleeper(), { max: 16 });
    s += 1;
  }
  await sleep(frames(6));
  // W2: sixteen tasks awake every frame, each a little each turn.
  s = 0;
  while (s < 16) {
    start(busy(6), { max: 16 });
    s += 1;
  }
  await sleep(frames(8));
  // W3: the program alone, asleep a frame at a time.
  let n = 0;
  while (n < 6) {
    n += 1;
    await sleep(frames(1));
  }
  // W4: four branches of a Promise.all, each asleep a frame at a time.
  await Promise.all([slow(4), slow(4), slow(4), slow(4)]);
  await sleep(frames(4));
  if (work == 16 * 6 && n == 6) print("W: weighed ok"); else print(`W: weighed WRONG ${work} ${n}`);
});
