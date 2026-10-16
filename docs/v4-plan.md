# TrigScript 4 — the plan

Written 2026-10-15. Status: nothing built. The question it answers: now that there is a
lifted copy of the game's own code (scm-sim's exact engine) beside eudplib, what does
TrigScript become if it uses the game itself as its checker, and how far can the language
go towards the TypeScript people actually write.

The plan has three parts, in the order they would be built:

- **A. The game as the checker.** Tests, the address check, desyncs, costs and the
  debugger, run in the lifted game instead of (or beside) the simulator.
- **B. The language.** `async`/`await`, events, function values, `try`/`catch`,
  `Local<T>` and `sync()`, fixed-point numbers, typed memory.
- **C. The game, pushed.** What a map can do with that language, one probe at a time.

A comes first because it makes every later slice cheaper to check: most of what a probe
answers today, the lifted game answers in the editor. It cannot answer everything (see
*What the lifted game cannot tell us*), so probes stay, fewer and narrower.

## Where 3.12 stands

TrigScript 3.12 compiles a `program()` to an IR, `python/trigscript.py` lowers the IR
with eudplib inside the eudplib plugin, and Save writes the built map. The language has
signed numbers, arrays and a heap, records, `Map`/`Set`, strings, classes, called
functions, recursion, callbacks, `Unit` objects, input through MSQC and chatEvent, and
`test()` blocks run by `compiler/simulateIr.ts` on the game's trigger schedule.

Two costs have stayed with every slice since 3.0:

1. **Each slice that touches the game has a probe the user plays by hand.** The probe's
   lines say "(expect …)" and a person reads them in the game. Sixteen probes so far.
2. **The simulator is a model.** It answers what it was written to answer. A read it
   does not model gives 0, and 9½ made that visible rather than fixing it.

## What scm-sim changes

scm-sim's exact engine is StarCraft 1.16.1's executable and storm.dll lifted from x86 to
TypeScript (`src/exact/`, the generated module under `data/lifted/`, never committed).
What is already measured there, and what this plan leans on:

- It plays maps as well as replays: single player, UMS, the game's own computers, and
  several people seated on one game instance (`src/exact/net.ts`). Node runs 2,200–4,100
  frames a second; a start takes 0.7 s.
- The whole of its state is one `DataView` at the game's own addresses (`LiftedGame.m`).
  Reading a variable of a built map is a read at an address.
- Snapshots cost about 45 ms and 0.6 MB each, and `rewind.ts` seeks backwards from the
  nearest one. That is time travel, already built for the replay viewer.
- Routines can be hooked by address when the module is generated (`liftgame.py --hook`),
  as the two sound routines are, and any routine can be called between turns
  (`L.callAt`), as the placement check is.
- Trigger text, countdown and outcome are read from memory (`ExactLiveEngine.triggerView`).
- **EUD, measured 2026-10-12:** extended-player Deaths *reads* work; `SetDeaths` *writes*
  past the table are refused by 1.16.1's own bounds check. So an eudplib-built map,
  which writes past the table from its first frame, does not run in the lifted game as
  it stands. Lifting that check is the first job (slice 0).

### What the lifted game cannot tell us

The lifted game is 1.16.1. TrigScript programs build for Remastered, whose EUD support
is an emulation of 1.16.1's memory, not the memory itself. The two differ in ways we
have already met:

| Probe | 1.16.1 meaning | Remastered |
| --- | --- | --- |
| Magenta 6, I | a unit's position written | ends the game ("EUD not supported") |
| Magenta 10, 1–3 | the tile buffer written through the MTXM pointer | nothing changes on screen |
| Magenta 10, 4 | sprite image flags (tint) | ends the game |
| Magenta 6, J K | a unit's own top speed | no effect; only the type's table counts |
| Magenta 6, Y H | the cloak status flags | no visible cloak |
| Magenta 5, 9 | the game speed written | no effect |
| Magenta 7 | a key held | Remastered sends one event a press, no key-up |

Remastered's executable is packed and encrypted on disk, so its emulation table cannot
be read from the file. The user agreed on 2026-10-15 that Remastered may be taken
through Ghidra to settle rules the compiler needs, provided none of it ships. The way in
would be a dump of the running process, once it has unpacked itself, read in Ghidra; the
rules found go into the allowlist with "Remastered, disassembled" as their evidence, and
a probe still confirms each family before a library offers it. Until that is done, the
lifted game tells us **what an address means and what the triggers did with it**;
only a played probe tells us **whether Remastered allows it**. Part A turns that split
into a file (the allowlist) and a check, so the gap is seen at the line that falls into
it rather than in a game that ends.

## Principles

1. **It is TypeScript** (unchanged from the Remastered plan). A construct valid in
   TypeScript with a sensible meaning in the game works; one without says why and what
   to write instead.
2. **The simulator is the fast path; the game is the judge.** Every test still runs in
   the simulator on each compile. *Run in the game* runs the same tests in the lifted
   game. When the two disagree, that is a bug in one of them, and the Testing view says
   both answers.
3. **The allowlist is a file of facts with sources.** Every address a built map touches
   is on it with the probe and date that showed it working in Remastered, or the build
   says so at the line. An `unsafe` block can go past it, with a reason the author writes.
4. **A desync is a compile error where it can be, a test failure where it cannot.**
5. **Only verified facts ship** (unchanged). A new family of addresses still gets a probe
   the user plays; the lifted game shrinks what the probe has to ask.
6. **The engine stays behind the plugin edge.** The engine is a separate work (the
   decision of 2026-10-12): TrigScript never vendors or imports it. TrigScript uses
   `scm-sim.engine` when that plugin is installed and the person's own copy of the game is
   there, and works as 3.12 does when it is not. CI has neither, so engine tests skip
   there, as the game-data suites in scm-js do.

## Part A — the game as the checker

### A0. Spike: a built map runs in the lifted game

What it has to show, in order:

1. **A lifted game that lets EUD writes through.** The bounds check is code, and the
   lifted code is TypeScript, so patching bytes in memory changes nothing. (As built, the
   routine is replaced at run time; no second build was needed.)
2. **eudplib's output loads in 1.16.1.** Things to check: the CHK version the build
   writes, `STRx` against `STR`, anything eudplib does only for Remastered. If 1.16.1
   refuses the map, can a load-time rewrite (as scm-sim does for 1.21 replays) fix it?
3. **eudTurbo holds.** It writes the countdown to 0 after each pass; 1.16.1 sets it to 30
   before running the pass, so every frame should run (verified for 3.12's schedule).
4. **The probes run headless.** `probes/spike.ts` first, then the other fifteen. Their
   printed lines are read from `triggerView` and checked against their own "(expect …)"
   text. A probe that has no input steps can then run without a person.

Done when: every probe without input steps prints what it expects in the lifted game, and
each one that does not has a written reason (a 1.16.1/Remastered difference, or a bug).

Size: 2–4 days, most of it in scm-sim. **No release.**

**As built (2026-10-15, one day; scm-sim branch `eud-spike`, uncommitted).** Every probe
runs headless in the lifted game and says what it expected.

- **No second build of the module.** The lifted module keeps a table of the routines
  reached through a pointer, and `setEntry` replaces one at run time. The trigger loop
  reaches the Deaths condition (0x42CB60) and the Set Deaths action (0x4C6CC0) that way, so
  `src/exact/eud.ts` replaces those two and nothing is regenerated. Replays and Test Map
  never see the replacements.
- **The scenario.** eudplib writes `VER` 206, `STRx`, and an eight-byte section of
  negative length at the end. `classicScenario` writes `VER` 205, turns `STRx` into a `STR`
  of the same size with every byte past the header in place, and drops the last section.
- **Where the strings are.** eudplib counts on Remastered keeping the strings section at
  0x191943C8. Its payload is relocated against that address, and it reads string offsets
  from the four-byte table there. The game reads a two-byte table from wherever 0x5993D4
  points. `placeStrings` puts the `STRx` bytes at 0x191943C8 and a two-byte table for the
  game just below them, both pointing at the same text. Then a text eudplib writes in place
  is the text the game shows. Two layouts that seemed simpler were each wrong in one half:
  table strings came out empty under one, made texts under the other.
- **The mask rule** (Remastered's `'SC'` records, which eudplib uses everywhere). The field
  is `value & mask` and the number is `number & mask`. Set To writes the field, Add adds to
  it and drops the carry, Subtract stops at 0. A condition compares `value & mask` with the
  unmasked number. Two eudplib tricks fix this rule, and `tests/exact-eud.test.ts` holds
  both: its divide-by-four (Subtract 3 << t under 7 << t) and its text decoding (Add a key
  under 0xAA, then under 0x55, which is an exclusive or). The first rule I tried added the
  unmasked number, and every made text came out scrambled.
- **Results.** All 15 probes were rebuilt with the 3.12 compiler and run for 3,000 frames,
  1–5 s each. The runner (`scripts/exact-eud.ts`) checks every "(expect …)" by its numbers:
  **137 hold**. Of the 9 it flags, 7 hold when read by hand and 2 are one wrong
  expectation (both below). It leaves 12 lines for a person, those with words in the
  expectation (a name, "about 21"); all 12 read right. Not one address fell outside the
  machine.
- **Read by hand, and right:** numbers I, reads E and input A put words between the value
  and the bracket. The input probe stops after A, because nobody presses its keys.
- **One expectation is wrong, and the lifted game found it:** units K expects F's Marine at
  15 as the weakest of the Men. But the Zergling handed over at H is a Man too, and the
  Marines hurt it to 5 during G. A person found a first version of the same mistake on
  2026-09-18; the fix made then was never replayed.
- **Not checked headless:** made texts in the objectives, a leaderboard label and a unit
  name (strings L, M, O). The game shows them, but the runner reads only the text lines.
  Anything that needs a person (the input probe, "select a Marine") is not checked either.
- **Found on the way:** scm-sim's reader of the game's text lines missed a line identical
  to the one it overwrote ("Tick" each second, once the 13-line ring had gone round). It
  now counts the slots the ring moved over as new. That was a bug in Test Map in Browser
  too.

### A1. The address tracer and the allowlist (4.0.0)

**Tracing.** Hook the routines that run a trigger's conditions and actions. On entry, the
hook reads the condition or action record and works out the address it touches; for the
Deaths family, that is the table's base plus 4 × (player + 12 × unit). It records read or
write, the address, the frame and the trigger's own address. This costs a hook call per
condition, not a check per memory access.

**Back to the line.** A trigger address has to become an IR node, and then a line.
Candidate: `trigscript.py` records, per IR node, the eudplib objects it made; after the
build eudplib gives each object its address (`GetObjectAddr`), and the build returns a
table `{ start, end, at }` beside the map. Addresses that eudplib's own runtime touches
(the triggers rewriting each other's next pointers) are kept as their own kind, which
Remastered is known to allow.

**The allowlist.** `data/allowlist.json` in this repository: address ranges, read and/or
write, what the range is (from the disassembly), and the evidence (`"magenta 10, key 4,
2026-09-15: ends the game"`). It is filled first from Magenta's played probes and the 16
TrigScript probes, so it starts with what is already known.

**The check.** *Run in the game* traces every address the run touches and holds each one
against the allowlist:

- on the list, allowed: nothing said;
- on the list, refused: an error at the line ("Remastered ends the game on this write:
  Magenta probe 6, key I");
- not on the list: a warning at the line ("not seen in Remastered: needs a probe"). The
  map still builds.

The trace only sees code the run reached, so the check is only as complete as the tests'
coverage. A1 therefore also shows coverage: lines that ran in the game, lines that did not.

Ships as 4.0.0, the first version with *Run in the game*, because it adds a whole mode.

**As built (2026-10-15, under Node; the editor's half comes with A2).** One command does it:
`npx tsx scripts/game-check.mts probes/units.ts`. It builds the script, plays it in the lifted
game with nobody at it, prints the probe's own checks, then lists each access Remastered was
seen to refuse or ignore, or has never been seen to do, by line.

- **Back to the line** works as the candidate said, without touching eudplib.
  `python/trigscript.py`, when the build sets `triggerMap`, wraps `RawTrigger.__init__`,
  `Lowering.statement` and `EUDFuncN._create_func_body`, so every trigger is tagged with
  the statement being lowered (or the eudplib function whose body it is). It also wraps
  eudplib's module-level `_construct_payload` to log where each tagged trigger landed:
  offset, conditions, actions, origin, 400 a line. The runner turns those offsets into the
  address of every condition and action record (the payload sits at the end of `STRx`), and
  the hooks already see each record's address. Triggers eudplib made at its own import, and
  its variables (trigger-shaped, but not `RawTrigger`s), are put down as "eudplib". Only
  eudplib's start code in the scenario's own TRIG stays unnamed.
- **The trace** (`scm-sim scripts/exact-eud.ts --trace`) is one row per origin, dword and
  direction, with the union of the masks, so a check is byte by byte. A run of the units
  probe has 42,815 rows.
- **The allowlist** (`data/allowlist.json`, made by `scripts/allowlist.mts`, 191 entries)
  has three sources:
  - Magenta's catalogue: 73 entries, a verified yes counts as allowed.
  - Three failures seen in the game: unit position write ends the game; cloak bits and game
    speed writes are ignored.
  - The traces of the 15 played probes: 115 runs of bytes, the unit table folded into one
    entry per field. Each probe passed in Remastered, so what its build touches was
    allowed there. The traces come from today's builds, not the ones played, so this is
    evidence by family of address, and a probe played again settles a new one.

  The map's own memory (strings and payload) is always allowed. eudplib's walk of the
  game's heap (its trigger lists) is allowed; a line of the script in the heap is not seen.
- **What it showed with Magenta's catalogue alone** (an allowlist built without the
  probes): nearly every line of every probe touches something Magenta never verified.
  Examples are 0x6509B0 (eudplib's current-player trick, written around every action that
  takes a player), the trigger lists at 0x51A284, and unit-table fields read by unit
  loops. So the played probes are the larger part of the evidence. The check names each
  such line, and an unseen field of the unit table is one finding however many units the
  loop read.
- **Not yet:** the check sees only what the run reached (no coverage view yet), and runs only
  under Node. The editor needs scm-sim's `run` (A2) before it can show a finding at its line.
- **Found on the way:** `spawnSync` keeps 1 MB of a child's output by default, and
  plugin-eudplib's `build-map.mts` exits before a long log has gone down its pipe. It now
  writes the log to `EUDPLIB_LOG_FILE` when asked, and `build-fixture.mts` reads it from
  there.

### A2. Tests in the game (4.0.0, with A1)

`test()` blocks run in the lifted game as well as the simulator.

- **A test becomes a program.** The test body, with its world set-up, is compiled into a
  test copy of the map as one more program, and its assertions record into an array the
  runner reads from memory when the run ends. So the test runs with the game's own
  trigger schedule, unit table and rules, and no new mechanism is needed inside the game.
- **Input.** `sim.type` becomes the text a chat command carries; `sim.click` becomes the
  game commands a click sends; `sim.press` becomes a write of the key state the local
  machine reads (MSQC reads keys locally). All three need checking against what MSQC
  actually reads.
- **What the Testing view shows.** Each test gets two marks, simulator and game. When
  they differ, the view says both answers, at the frame they parted.
- **Where it runs.** In the editor through `scm-sim.engine`; the service needs a new
  method, roughly `run(map, { frames, seat, inputs, watch, trace })`, which means
  contract version 2. Locally from a terminal: `npm run test:game` in this repository,
  using `data/lifted/` when it is on the machine.

A headless run draws nothing, and is allowed from any copy that unlocks the editor
(decided 2026-10-15, see *Open decisions*).

**As built (2026-10-16).** One part of the design above was wrong and was not built: a test does
*not* become a program. A test is synchronous JavaScript that steps frames and reads between them
(`until(() => …)` among it), which cannot be compiled into triggers ahead of time. Instead the test
stays JavaScript and is handed a world backed by the game, and it runs where the game is.

- **`GameSim`** (`compiler/gameSim.ts`) has `TestSim`'s surface over a small synchronous
  `GameHandle`. scm-sim supplies the handle (`src/exact/testGame.ts`), and TrigScript never imports
  the engine.
  - Every read is the game's memory.
  - `place`, `kill`, `remove`, `give` and `move` are the game's own trigger actions, run between
    frames as a player's trigger would run them, through a scratch location (255; 254 for a
    destination) whose twenty bytes are put back afterwards.
  - `kill` is a fight, as `TestSim` has it: the game's death-counting routine (0x488AF0) is called
    first, so `by` gets the kill.
  - A typed line is the game's own chat command (0x5C). chatEvent reads it from the text lines as
    in play, and MSQC sends it on.
  - A key and a mouse button are the local machine's memory (0x596A18, 0x6CDDC0), held for one
    frame.
  - Not yet: `program()` (a program's variables; the build would have to say where each lives),
    and what another player was shown.
- **The same tests, twice.** `TestRunOptions.makeWorld` hands each test a world other than the
  simulator's. A compile also returns the script as JavaScript (`CompileResult.modules`).
  `compiler/gameTests.ts`, bundled as `dist/gametest.js` (198 KB, no TypeScript in it), runs those
  modules again beside the game, registers the tests and runs each with a `GameSim`. The game is
  put back to frame 0 before each test.
- **Where it runs.**
  - Under Node: `npx tsx scripts/test-game.mts <script.ts>` prints each test's game and simulator
    marks side by side.
  - In the editor: **Run All Tests in the Game** in the Testing view and the palette. It builds
    the map as Save does, exports it whole (a bare `.chk` has no room for what the build steps
    make), and hands it, with `gametest.js`'s text and the modules, to scm-sim's analysis page
    through the plugin's new `test()` (contract unchanged in version; `status().tests`). The page
    reads the scenario out of the map, starts it in a worker of its own with EUD let through,
    loads the module from its text and answers with the report. Each test then shows a second
    mark, "game", which turns red when the two disagree. Nothing is drawn, so under the decision
    of 2026-10-15 any copy of the game that unlocks the editor is enough.
- **Traps met.**
  - eudplib keeps the map's locations scrambled until its first frames put them right (by frame 2
    on a probe's map). So an action at frame 0 goes through a scratch location given the map's
    real bounds, read from the game once (`readLocations`), with the elevation flags cleared,
    since scrambled flags keep units out of a location.
  - The game's snapshot covers only the pages it had mapped at the start. eudplib's payload lies
    outside them, so a reset left eudplib's variables and its self-rewriting triggers as the last
    test left them, and typed lines and keys went unanswered from the second test on. The handle
    now keeps that range itself.
- **What the first run found:** a simulator bug. Kill Unit, Kill Unit At Location, a unit's
  `kill()` and hit points written down to 0 all counted a death in the simulator. The game counts
  none of them, and the editor's trigger reference, checked in the real game, says the same of
  Kill Unit. Fixed in the simulator (`World.gone(…, fought)`), with three tests corrected to the
  game's rule.
- **Checked:**
  - `probes/game-tests.ts` (time, a typed line, a key; units placed, killed, given and moved)
    passes in the game and in the simulator under Node, and through scm-sim's analysis page in
    headless Chromium (3.3 s, game start included).
  - plugin-scm-sim's bridge has two new tests.
  - The editor's button has not been driven end to end in the built editor yet. Its parts have:
    compile, export and the page, each on its own.

### A3. The desync detector (4.1.0)

Run two to eight copies of the game seated as different local players
(`seatPlayers`, local-player words set per copy, as `net.ts` does for multiplayer), feed
them identical turns, and hash each game's state every frame. At the first frame the
hashes differ, report the frame, the last traced trigger in each copy, and its line.

A test can ask for it: `test("shop", { players: 4 }, …)`. The Testing view then shows
"desync at frame 312, line 48: the copies took different branches here".

To check first: UMS with several people on one instance (melee is measured, UMS is not).

### A4. What a frame costs (4.1.0)

From A1's hooks: conditions and actions run per frame, by IR node and by line. Lifted
wall time is not the game's, so the count is the measure. The editor shows it per line
like the existing hints ("~1,200 actions a frame"), and as a graph over a test's run.

Open: what count, on what machine, actually lags Remastered. A probe with a dial (run
k × 1,000 actions a frame, the user says when it stutters) gives the first number.

### A5. The debugger in the game (4.2.0)

9½'s debugger gets a second backend.

- **Variables** are read from memory: the build's address table (A1) knows where each
  `EUDVariable` and array lives.
- **Back as well as forward.** `rewind.ts` keeps a snapshot every N frames; a step back
  restores the nearest snapshot and plays forward to the frame.
- **Watchpoints.** "Stop when this changes" compares a dword once a frame, which is cheap.
- **The game beside the code.** scm-sim renders the frame the debugger stands at.

## Part B — the language

Each slice states what changes in the IR, the simulator and the Python, and has a probe.
After A2, a probe without input steps also runs headless, and the user plays only what
needs Remastered's answer.

### B1. `async` / `await` (4.3.0)

The biggest change to the model since 3.0. Today a `sleep()` may only stand in a
program's own body or in an inlined function; a called function never sleeps.

```ts
async function wave(n: number) {
  createUnit(P8, units.ZergZergling, n * 4, locations.Gate);
  await until(() => countUnits(P8, units.ZergZergling) === 0);
  print(`Wave ${n} cleared`);
}

program(async () => {
  for (let n = 1; n <= 10; n++) {
    const done = await Promise.race([wave(n), sleep(seconds(90)).then(() => false)]);
    if (done === false) defeat();
  }
});
```

- **A task** is a frame record on the heap (its locals, and which `await` it is parked at)
  plus a resume point. The lowering is the one 3.0 uses for a program's top-level
  `sleep`, a switch on the resume point, applied to every `async` function.
- **The scheduler** keeps the live tasks in a list on the heap, and each frame runs every
  ready one until it awaits or ends. A `program()` is a task, so its meaning does not
  change.
- **What can be awaited:** `sleep(…)`, `until(() => condition)`, any `async` call,
  `Promise.all`, `Promise.race`, `Promise.any`.
- **Generators** (`function*`, `yield`) use the same machinery, for wave scripts and
  for anything that hands out one step at a time.
- **Recursion with `await`** — the frame is already on the heap, so the recursion stack
  of slice 8 may not be needed for an async function. To decide while building.
- **Errors:** `sleep()` outside an `async` function stays an error, with a fix that adds
  `async`. An `async` function that never awaits is a hint.

Open: whether `Promise.race` cancels the tasks that lost. JavaScript does not cancel
them, and a wave that keeps running after its race was lost is rarely what the author
meant. See *Open decisions*.

### B2. Events (4.4.0)

```ts
on.created(units.TerranMarine, (u) => { u.energy = 50; });
on.died({ owner: P8 }, async (u) => { await sleep(frames(24)); createUnit(P8, u.type, 1, locations.Spawn); });
on.order(units.ProtossHighTemplar, orders.CastPsionicStorm, (u) => …);
on.chat("-give {n}", (p, { n }) => …);
```

- **created**: eudplib's `EUDLoopNewCUnit` walks the units made since the last frame.
- **died**: a unit is kept in a table by the identity 8½'s unit keys already use (pointer
  plus the slot's use count, which the leftovers probe showed holding in the game) and is
  found gone when its slot no longer matches. Who killed it: scm-sim's analysis found a
  killer's kill count rises one frame before the victim leaves the lists, which may give
  `u.killedBy` on the same rule. That needs its own check.
- **order**: compares each unit's order with the last frame's; the cost is a scan, and the
  hint says so.
- A handler is a task (B1), so it may await.

### B3. Function values (4.5.0)

```ts
const effects: ((u: Unit) => void)[] = [heal, slow, (u) => { u.hp -= 10; }];
effects[random(effects.length)](target);
```

- A function value is a number, a function id. A call through it is a switch on the id
  (or `EUDTypedFuncPtr`, which eudplib 0.81 has; the build may choose).
- **What a closure captures:** a `const` captured by value is exactly JavaScript, since
  it cannot change. A captured `let` is the hard part: there is no garbage collector, and
  the heap's rule is "the holder owns the block". Proposed: a `let` may be captured only by
  a function that does not outlive the frame it was made in (passed down, never stored);
  otherwise an error that says to make it `const` or a field. See *Open decisions*.
- This also gives 8½'s callbacks a way to work when they are not inlined: a callback
  passed through two functions.

### B4. `try` / `catch` / `throw` (4.5.0, with B3)

- `throw` unwinds the frames on the heap, task frames and recursion frames both, to the
  nearest `catch`.
- The faults the game reports today (out of memory, recursion too deep, an index out of
  range) become thrown `RangeError`s that a program can catch. When nothing catches one,
  it is said in red, as now.
- `finally` runs on every way out, `await` included.

### B5. `Local<T>` and `sync()` (4.6.0)

Some values are true only on one machine: the local player, where its screen is, what it
has selected, what it is typing. TrigScript gives none of them out today; all input goes
through MSQC, which sends it to every machine. B5 offers them, typed so that a desync
cannot compile:

```ts
const sel = localSelection();            // Local<Unit[]>
centerView(sel[0]);                      // fine: the camera is the local machine's own
units.push(...sel);                      // error: a local value cannot change the game
const picked = await sync(sel[0]);       // Unit, the same on every machine, a few frames later
```

- **The check** is a taint pass over the IR. `Local` reaches what only the local machine
  sees (the camera, text shown to the current player, a sound for one player) and nothing
  that changes the game state for all: a store into a shared variable, an action's target,
  a condition of a branch that does either.
- **`sync()`** sends the value as a game command, as chatEvent's numbers already go
  through MSQC's `val`, and resolves when every machine has it. It is `async` by nature,
  which is why B5 comes after B1.
- **What can be local:** each read needs its address from the disassembly and a probe in
  Remastered. A3 checks the taint pass's answers in practice.

### B6. `fixed` and `Math` (4.7.0)

- `fixed` is a 16.16 number with `+ - * /` and comparisons; mixing it with `number`
  converts as TypeScript would round.
- `Math.sin`, `Math.cos`, `Math.atan2` work on the game's 256 directions. The tables are
  computed at build time from the formula, and A2 checks them against the game's own
  table. `Math.sqrt` and `Math.hypot` use an integer square root.
- Movement uses the actions Remastered allows: a location centred on a point and Move
  Unit to it. A unit's position is never written; that ends the game.

### B7. Typed memory (4.8.0)

```ts
unsafe("the guard's cooldown, read for the HUD; probe 23", () => {
  const cd = memory.unit(u).groundWeaponCooldown;   // u8, at +0x…
});
```

- The declarations for `memory.unit`, `memory.player`, `memory.sprite` and the others
  are generated from the disassembly's structs, with each field's comment and its
  allowlist state ("read: probe 12", "write: not seen", "write: ends the game").
- Reading a field that is on the allowlist needs no `unsafe`. Writing one, or reading one
  that is not on it, needs `unsafe` with a reason, and the reason is shown in the
  map-requirements view (3.12).
- This is the door the crazy tier walks through, so it comes after the allowlist and the
  tracer are settled.

### B8. Built from the game (4.9.0)

Tables a map could not afford to compute while it runs, computed by running the lifted
game when the map is built:

- `ground.distance(a, b)` and `ground.region(x, y)`, from the game's own regions for this
  map (Walkability already reads them out of the lifted engine).
- Anything else a function of the map: `atBuild(() => …)` runs in the lifted game at build
  time and its result becomes a constant table.

Cost: map size. The hint says how many bytes each table adds.

## Part C — the game, pushed

Each is a library over Part B, offered only after its probe. "Known" means a played probe
already says so.

| Idea | What it needs | Known |
| --- | --- | --- |
| Terrain as a framebuffer | tile buffer writes | **No.** Magenta 10: Remastered does not draw them. Dropped. (My first answer on 2026-10-15 proposed it; that was wrong.) |
| Units moved freely every frame (bullet hell, orbits) | location + Move Unit, B6 for the paths | position writes end the game (Magenta 6); moving by action is ordinary, so the probe is how many a frame before it lags (A4's dial) |
| Panels of text: objectives, leaderboard label, unit names as live UI | made texts in those fields | **Yes**, the strings spike (2026-09-19): re-read every draw, written only on the target's machine |
| Custom command buttons | button set data in memory | unknown: probe |
| Custom spells | B2's `on.order`, Magenta's damage/heal verb | partly: the verb is verified, the order watch is not |
| Save codes | strings, a checksum, `chatted()` | needs no new address; a probe for the round trip |
| Unit stats changed while the game runs | the type tables | Magenta-verified fields only |
| Computer players written in TrigScript | B1 tasks, unit orders through the scratch-box trick | the trick is verified (Magenta); a behaviour library is new |
| Camera work for one player | `centerView`, B5 | ordinary actions; B5 makes them safe |

## Slices

| # | Slice | What it proves | Size |
| --- | --- | --- | --- |
| A0 | Spike: an eudplib map in the lifted game (scm-sim) | EUD writes through a hooked bounds check; 1.16.1 loads the built map; probes print their expectations headless | 2–4 days, no release |
| A1 + A2 | Address tracer, allowlist, tests in the game (4.0.0) | every address a run touches held against Remastered's known answers at the line; each test judged twice; coverage | 6–8 days, plus scm-sim's `run` (contract 2) |
| A3 + A4 | Desync detector, the cost of a frame (4.1.0) | several seated copies hashed every frame; actions per frame per line; the first lag number from a probe | 4–5 days, one probe (the dial) |
| A5 | The debugger in the game (4.2.0) | variables from memory, step back, watchpoints, the frame drawn | 3–4 days, no probe |
| B1 | `async` / `await`, generators (4.3.0) | tasks on the heap, a scheduler, `Promise.all`/`race`/`any`, `until()` | 6–8 days, probe |
| B2 | Events (4.4.0) | created / died / order / chat, handlers as tasks | 3–4 days, probe |
| B3 + B4 | Function values, `try` / `catch` (4.5.0) | calls through an id, the capture rule, unwinding through tasks | 5–6 days, probe |
| B5 | `Local<T>` and `sync()` (4.6.0) | the taint pass; local reads, each probed; A3 confirms | 4–5 days, probe per read |
| B6 | `fixed` and `Math` (4.7.0) | 16.16 arithmetic, the direction tables against the game's | 2–3 days, probe |
| B7 | Typed memory (4.8.0) | generated structs with allowlist states; `unsafe` with a reason | 3–4 days, no probe of its own |
| B8 | Built from the game (4.9.0) | ground distances and regions baked in; `atBuild` | 3 days, probe |
| C | Libraries, one probe each (4.10 on) | the table above | per idea |

Ship order for every release, as for 3.x: plugin commit and tag → scm-js pin, vendor,
guide and catalogue note → registry → ai-server prompt. Anything scm-sim needs (A0's
build, contract 2) ships first, then plugin-scm-sim, then TrigScript.

## Work outside this repository

- **scm-sim:** the EUD-permitting module build (A0); the trigger hooks (A1); `run(…)` with
  seating, inputs, a trace and memory reads (A2, A3); UMS with several people on one
  instance (A3).
- **plugin-scm-sim:** contract version 2 for `run`; the `present` and `status()` answers
  saying whether the person's copy of the game allows a run.
- **plugin-eudplib:** the build returns the object address table (A1), if `trigscript.py`
  cannot get it on its own.
- **scm-js:** nothing until the guide pages; `docs/trigscript.md` gains *Run in the game*.

## Open decisions

- ~~Does a headless test run count as play?~~ Decided 2026-10-15 (the user: "headless
  test runs seem fine as long as theres no rendering"): a run in the game for tests,
  traces, desyncs and costs is allowed from any copy that unlocks the editor, provided
  nothing of the game is drawn. A5's "the game beside the code" draws, so it needs the
  person's own copy, as Test Map does.
- **Does `Promise.race` cancel the losers?** JavaScript: no. Proposed: no, as JavaScript,
  plus an explicit `task.cancel()` on what `spawn(…)` returns.
- **What a closure may capture.** Proposed above (B3): `const` by value, `let` only when
  the closure does not outlive its frame. The alternative is reference-counted
  environments: closer to JavaScript, more Python, and a new kind of fault.
- **How a trigger becomes a line.** The candidate is the object address table (A1). If
  eudplib does not keep objects in one piece, the fallback is a marker action per IR node,
  which costs triggers.
- ~~Where the hook for the EUD bounds check lives.~~ Settled by A0 (2026-10-15): nowhere
  in the build. The two routines are replaced at run time through the module's table of
  routines reached by pointer, only in a run that asks for EUD.
- **The version number.** 4.0.0 for A1 + A2 because *Run in the game* is a new mode, or
  3.13 until the language changes in B1. Proposed: 4.0.0 at A1 + A2.

## Facts this plan leans on

- scm-sim, `src/exact/` (2026-10-12 to 14): lifted 1.16.1 with storm.dll; maps, replays,
  several people on one instance; 2,200–4,100 frames a second in Node; snapshots ~45 ms /
  0.6 MB; hooks by address at generation; `callAt` between turns; `triggerView`;
  extended Deaths reads work and writes are refused by 1.16.1's check.
- Remastered's executable is encrypted; no disassembly of it is planned.
- Magenta's played probes 5–11 (2026-09-14/15): position, tint and image writes end the
  game; tile buffer writes are not drawn; per-unit speed and cloak flags do nothing; key
  hold does not exist; the scratch-box order trick and the damage/heal verb work.
- The strings spike (2026-09-19): objectives, leaderboard label, transmission line and
  unit type name show a made text and are re-read every draw.
- eudplib 0.81 (checked in the wheel 2026-10-15): `EUDFuncPtr`, `EUDTypedFuncPtr`,
  `EUDLoopNewUnit` / `EUDLoopNewCUnit`, `EUDLoopBullet`, `EUDLoopSprite`,
  `QueueGameCommand` and its select / right-click forms.
- TrigScript 3.12 (2026-10-16): the simulator keeps the game's trigger schedule;
  programs first run on frame 2; eudTurbo writes 0x6509A0 := 0 after the pass.
