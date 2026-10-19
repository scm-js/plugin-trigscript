# TrigScript 4 — the plan

Written 2026-10-15. Status: Part A built (A0–A5, each with its *As built*), and Remastered's
emulator read from a dump (*R0*, 2026-10-16); Part B steered by three showpiece maps
(*Showpieces*, 2026-10-16), B1 and B2 built (2026-10-16/17), and an EUD error code taken back to its line
(*EUD error code to line*, 2026-10-17); a fourth showpiece, Bad Apple, with fog of war found to work as a
framebuffer in the lifted game (*S4*, 2026-10-17); B6, fixed numbers and Math, built with a fifth showpiece, a
raycaster in the fog (*S5*, 2026-10-17); B3, functions as values, and B4, `try` / `catch` / `throw`, built
(2026-10-17); closures over locals, and the text and array methods a program was missing, built (*Closures and the
missing methods*, 2026-10-17); JSX components, functions from any file and the first two libraries, `trigscript/ui` and
`trigscript/screen`, with Snake as their showpiece (*Components, functions from any file, and the first libraries*,
2026-10-17); generics and `timers`, `signals`, `random` and `math` (*timers, signals, random and math, and generics*, 2026-10-17); a sweep of what is still missing, B9, references and values, and generators finished with `trigscript/cutscene` (*What is still missing*, *B9*, *Generators finished*, 2026-10-18). The question it answers: now that there is a
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
| Magenta 6, I | a unit's position written | ~~ends the game~~ — the dump probe (R0) wrote it alone: the game goes on, nothing moves |
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
a probe still confirms each family before a library offers it. That was done on
2026-10-16 (*R0* below): the allowlist now knows, for every address, whether Remastered
lets a read or a write through, and a probe is needed only to learn what the game *does*
with it. The lifted game tells us **what an address means and what the triggers did with
it**; the dump tells us **whether Remastered allows it**; a played probe tells us **what it
looks like**. Part A turns that split
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
  - `program()` reads a program's variables where the build put them (below). Not yet: what
    another player was shown.
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
  - **End to end in a built editor (2026-10-16):** scm-js `main` built under `/editor/` and
    served by scm-sim's dev server beside its analysis page, with the local TrigScript and
    scm-sim plugin builds in place of the released ones, driven in headless Chromium:
    1. The probe map is opened and the script written into it.
    2. **Run all tests in the game** is clicked.
    3. eudplib asks for its one-time runtime and gets it, then builds the 721 KB map in 3.7 s.
    4. The status bar says "In the game: 4 of 5 tests passed. The simulator disagrees on 1
       test." That came about 9 seconds after the click.

    The fifth test reads `sim.program()`, which the game could not answer yet, and it showed as
    meant: a ringed red mark beside the simulator's green one, and the game's reason on its own
    line in Test Results. The game's mark sits beside the simulator's icon rather than at the
    row's end, where a narrow sidebar cut it off in the first run.
- **`sim.program()` in the game (2026-10-16).**
  - The build says where every variable is when asked (the `variableMap` setting, which
    **Run All Tests in the Game** and `scripts/test-game.mts` set). Once eudplib has laid the
    payload out, the lowering works out each cell's address, and it prints them once
    `initialize_payload` has placed the payload at the end of STRx (0x191943C8 plus the
    section's length): a `TRIGSCRIPT-VARS` line, then a `TRIGSCRIPT-PROGRAM` line a program.
    The editor keeps these lines out of Output.
  - `compiler/gameVariables.ts` reads them, and reads a program's variables out of the game's
    memory by the same rules as the simulator's lookup. That covers numbers (signed, `u8`/`u16`,
    `u32`), booleans, texts of the table and texts that are made, units (null once the slot's
    uniqueness byte has moved on), fixed and growing arrays, records and lists of records, and a
    per-player program's row by player.
  - Two differences, both because the game has every cell from the start. A variable not yet
    declared reads as its zero. Of two declarations with one name, the later in the source wins.
    A list inside a list and a row of a grid are not read.
  - Traps: an `EUDArray` is a proxy of its data's EPD, not of its address (relocation mode 1, so
    `4·offset + 0x58A364`). eudplib works addresses out only while it writes the payload, so the
    lowering sets that phase again for as long as it reads them.
  - Checked: `probes/game-program.ts` (every kind above, a unit, a per-player program by player)
    passes in the game and in the simulator under Node, and so does `probes/game-tests.ts`. In a
    built editor the five tests of the end-to-end run now pass in the game: "In the game: 5 of 5
    tests passed.", about 10 seconds after the click.
  - plugin-scm-sim released 0.9.0 with the Replay view's zoom in the meantime, so `test()`
    ships in 0.10, and TrigScript's message now asks for that.

### A3. The desync detector (4.1.0)

Run two to eight copies of the game seated as different local players
(`seatPlayers`, local-player words set per copy, as `net.ts` does for multiplayer), feed
them identical turns, and hash each game's state every frame. At the first frame the
hashes differ, report the frame, the last traced trigger in each copy, and its line.

A test can ask for it: `test("shop", { players: 4 }, …)`. The Testing view then shows
"desync at frame 312, line 48: the copies took different branches here".

To check first: UMS with several people on one instance (melee is measured, UMS is not).

**As built (2026-10-16, under Node and in the editor).** The check was already done:
scm-sim's `tests/exact-net-ums` plays two people on one instance in UMS. Two parts of the design
above changed. The option is a list (`{ players: [P1, P2] }`), because a test's inputs name the
player anyway. And the hash is not the game's own.

- **Copies.** scm-sim `src/exact/copies.ts`, `copyWorker.ts` and `copiesNode.ts`: one worker
  thread a copy (one game a process), each seated as a different person, 0.9 GB each.
  - Each turn, inside the game's own request for every player's turn (`TurnFeed.exchange`), the
    copies trade what their games queued, over a SharedArrayBuffer barrier. Every machine's
    commands reach every game in the same turn, as on a real network. Before this, `TurnFeed` sent
    only the checksum command, so a typed line or MSQC's commands from the map's own code went
    nowhere.
  - After every frame the copies also trade what each was shown, so `printed(P2)` reads the same
    at every copy.
- **The digest.** One FNV word per 256-byte block of the memory every machine must hold alike:
  units, deaths, kills, resources, supply, switches, locations, the seed.
  - The game's 0x37 checksum command does not do: it is built at 0x47CC50 from a ring at
    0x65EB30, filled at 0x47CFC0, and hashed at 0x47CF10. Depending on a mode byte (0x65FBF0) it
    hashes the units on some turns and the resources, seed and frame on others. It always folds
    in a rolling chunk of the map's tile flags. It never hashes death counts. And it mixes in the
    local player (0x47CF93), so machines that agree send different bytes. Measured: deaths, ore,
    hit points, position, the seed and a switch changed at frame 40 left 80 turns of it as they
    were.
  - Two unit fields are each machine's own, found by copies in step that disagreed, and left
    out:
    - +0x87, the under-attack alert's quiet time (0x48EB30 when the owner is 0x512684, then
      0x48EAE0);
    - +0x8A and +0x8B, the minimap blink (0x48F230, 0x45F08B).
  - eudplib's payload is **watched, not compared**. chatEvent's line and the unit MSQC selects
    for this computer's player differ on purpose, from frame 2 of every map that reads input. So
    a payload difference is noted with its frame, and is reported only once what the game holds
    splits.
  - The strings are never digested: TrigScript's made text for one player is written on that
    player's computer only (`IsUserCP`).
- **The report.** At the first turn the digests differ, every copy runs the same detail rounds and
  reports the same thing:
  - the dwords, named (unit slot and field, deaths of a unit for a player);
  - each copy's lines that wrote them that turn;
  - each copy's lines that read the local machine's memory (0x512684, the keys, the mouse, the
    screen);
  - the script's variables that had come apart before, named from the build's variable map.

  In the test it fails the test at that frame, in every copy alike: "the players' games stopped
  agreeing at frame 5: deaths of unit 7 for P1 is 1 at P1's computer, 0 at P2's computer. At P1's
  computer: line 12 wrote …".
- **TrigScript.**
  - `test(…, { players: [P1, P2] }, …)` runs in one copy for each player. `press`, `click`,
    `type` and `moveMouse` with a player act at that player's copy; with none, at the first
    player's.
  - A one-game run lists such a test as skipped ("runs as a copy of the game for each").
  - `scripts/test-game.mts` builds the map again with those slots open to people
    (build-fixture's `PEOPLE=0,1`), then runs them through `runCopies` with
    `dist/gametest.js`'s `drive`.
- **Measured.**
  - `probes/game-players.ts`: a key and a line from P2's computer reach P1's, and a text made for
    P2 is seen at P2's only. 3/3 pass in two copies with no desync, beside the one-computer test.
  - scm-sim `tests/exact-copies`: a classic EUD trigger on 0x512684 splits two copies at its
    first pass, and both name the trigger.
  - A 3000-frame fight with a computer player stays in step with 2 and with 4 copies (8 s,
    3.5 GB for four).
- **The editor.** "Run All Tests in the Game" runs a test of several players through the scm-sim
  plugin's `testCopies`. The analysis page runs one copy each in workers of its own
  (`web/copyWorker.ts`, sharing `src/exact/copy.ts` with Node), and the reports merge into one
  mark (`compiler/gameCopies.ts`). The build is asked for its trigger map beside the variable
  map, so a desync names lines.
  - The copies need SharedArrayBuffer, so the page must be cross-origin isolated. COOP/COEP
    cannot do it: the page is a frame inside the editor, isolation needs the top-level page too,
    and COOP `same-origin` on the editor cuts scmjs.dev's sign-in popup off from the editor
    (it posts back through `window.opener`).
  - `Document-Isolation-Policy: isolate-and-credentialless` isolates the one document instead:
    `/play/analyse.html`, sent by the site's worker (cloudflare-link-previews
    `ISOLATED_PLAY_PAGES`) and by the dev server. Chromium 137 on; elsewhere, or without the
    header, the tests are marked not run, and the mark says why.
  - Measured in headless Chromium 153 (`web/smoke-copies.mjs`, then a built editor):
    - the editor stays as it is;
    - `postMessage`, OPFS and the moments BroadcastChannel cross the boundary;
    - replay analysis, pathing and measure still pass under the header;
    - 4/4 tests in the game from the Testing view, three of them as two copies (11 s).
- **Not done.**
  - Dwords that come apart later in a payload block already watched are not reported.
  - `sim.place` and the other actions between frames run at every copy, as a trigger for that
    player would.

### A4. What a frame costs (4.1.0)

From A1's hooks: conditions and actions run per frame, by IR node and by line. Lifted
wall time is not the game's, so the count is the measure. The editor shows it per line
like the existing hints ("~1,200 actions a frame"), and as a graph over a test's run.

Open: what count, on what machine, actually lags Remastered. A probe with a dial (run
k × 1,000 actions a frame, the user says when it stutters) gives the first number.

**As built (2026-10-16, under Node and in the editor; the dial not yet played).**

- **The count.** scm-sim `src/exact/cost.ts`. The game runs a trigger's conditions at 0x489200 and its actions at
  0x489130, each through a table of routines by type: conditions at 0x515A98, actions at 0x512800, the record in
  ecx. Those routines are reached by pointer. `installCost` therefore wraps every one of them with a count, after
  `installEud`, so the two EUD routines are counted too. It also wraps the engine's own stand-ins behind import
  cells (Center View and Minimap Ping, from `live.ts`).
  - What is not counted: a switched-off condition and an empty slot cost nothing, because the game calls nothing
    for them.
  - What is counted every time: an action that waits (Wait, Transmission) is counted on every frame it runs, as
    the game does the work every frame.
  - A check: on the units probe the tap's Deaths and Set Deaths totals agree with `EudTap`'s.
- **Records to lines.** A group function turns a record into its line, through the build's map of triggers (A1).
  `CARRY` puts a record under the line that ran just before it in the frame. eudplib's variables, its functions
  and the triggers no statement made are carried. A variable is a trigger the line's triggers jump through, so a
  line's work includes the variables it touches. Measured on `for (…) { x += 1; }`, one turn of the loop is:
  - the compare: 21;
  - `i++`: 9;
  - `x += 1`: 9 (7 of its own and 2 in the variable).

  That is 39 conditions and actions a turn.
- **What is apart from the lines (`TestCost.other`).** Records carried before any line in a frame, and records
  outside the payload, count under no line:
  - eudplib's start, once: about 82–89 thousand at frame 2 on any map, mostly payload set-up reached from the
    scenario's own TRIG;
  - eudplib's work at the top of every frame: about 580 a frame on the game-tests probe (payloadMain, ReceiveQC
    for MSQC, RunTrigTrigger), more than that probe's own lines (about 225).

  Without this split, eudplib's start was every test's peak.
- **Where it shows.**
  - `scripts/exact-eud.ts` prints the totals and the costliest origins, and writes them with `--cost=`.
    `scripts/game-check.mts` passes `--cost` through.
  - The test handle carries the tap. It is paused for a test's own actions between frames, and cleared on
    `reset()`.
  - `GameSim.cost()` reads it after each test, so `TestResult.cost` holds a series a frame and the lines by their
    peak.
  - `scripts/test-game.mts` prints each test's average, peak and three costliest lines. The copies of A3 count too.
    A merged result keeps the first copy's.
  - The editor:
    - A line that ran 10,000 or more in one frame of any test gets a hint at its end, such as "31k a frame". The
      note names the test and frame.
    - The hint shows only while the file's text is what was measured.
    - Test Results shows a "cost" row (average and peak), a graph of the frames and the three costliest lines.
- **Measured.**
  - The units probe peaks at 103,639 in one frame (frame 842): three unit-loop lines of about 30 thousand each.
  - The game-tests probe runs about 225 a frame of its own.
  - **End to end in a built editor:** a program with `for (let i = 0; i < 200; i++) { x += 1; }` every frame and
    two tests. The status bar said "In the game: 2 of 2 tests passed." about 8 s after the click. Test Results
    showed:
    - the cost row: "1,834 conditions and actions a frame on average, 1,837 at the most (frame 49)";
    - the graph;
    - the line at 1,800 a frame.

    The line's hint read "1.8k a frame" after "unrolled ×200", the same numbers as under Node. A loop with bounds
    known at build time is unrolled, so it costs 9 a turn (only `x += 1`), not 39. The graph's colour first used a
    token the editor does not have (`--accent`); it now uses `--teal`.
- **The dial.** `probes/frame-cost.ts` climbs a ladder by itself, one step every 10 game seconds. Keys: W up,
  Q down, E holds. The steps aim at 1, 2, 5, 10, 20, 50, 100, 200, 500 and 1,000 thousand a frame. Measured in the
  lifted game (`--cost`), each step lands at its target plus about 630 (eudplib's own and the program's).
  1,004,714 at the top.
  - Built to `fixtures/eud/frame-cost.scx` and copied to the Remastered maps folder (`TrigScript/`).
  - **Played in Remastered (2026-10-16, single player, Fastest):**
    - steps 1–9, up to 500 thousand a frame: no visible effect;
    - step 10, a million: the screen flickers slightly, enough to distract, and the game does not slow.

    So the budget is 500 thousand a frame, about 12,800 turns of a plain loop. The editor's hint starts at 10,000 a
    line (2% of it). The cost row and the hint's note give a count as a share of the 500 thousand.
    - Steps 11 and 12 were added (2 and 5 million; measured 2,000,640 and 5,000,643) and played the same day:
      - 2 million: the flicker, no slowing;
      - 5 million: the game slows.
    - The machine: AMD Ryzen 9 7900X (12 cores, 4.7 GHz), a fast one. A slower computer reaches each step sooner,
      so the budget stays at 500 thousand and the note says it was a fast computer. Remastered 1.23.10.13515.

### A5. The debugger in the game (4.2.0)

9½'s debugger gets a second backend.

- **Variables** are read from memory: the build's address table (A1) knows where each
  `EUDVariable` and array lives.
- **Back as well as forward.** `rewind.ts` keeps a snapshot every N frames; a step back
  restores the nearest snapshot and plays forward to the frame.
- **Watchpoints.** "Stop when this changes" compares a dword once a frame, which is cheap.
- **The game beside the code.** scm-sim renders the frame the debugger stands at.

**As built (2026-10-16, under Node; the editor end to end below).** There was no first backend: 9½ was never
built, and 3.11.0 became the Korean release. So this is the debugger itself, with the game as its only backend.
It also does not stop a running game. A test is synchronous JavaScript and a frame is the game's trigger loop run
to its end, so neither can pause in the middle. Instead the test runs once with everything it did written down,
and the debugger walks the record.

- **The record** (`compiler/gameDebug.ts`, `RecordingHandle`). It wraps the host's test handle for one test, and
  writes down each frame of the run:
  - *Steps.* scm-sim's cost tap now also says each record as it runs (`CostTap.trace`), with the line A4's grouping
    gives it. Records of one line in a row make one step. A loop's turns come out as its lines over and over.
  - *Writes.* `EudTap.listen` now says what a dword held before. Every dword of the script's memory a step changed
    is kept with its value before and after. "The script's memory" is the start of `STRx` to the end of the payload:
    variables, arrays, the heap, made texts and the string table. With both values, a step back puts writes back,
    so it is as quick as a step forward.
  - *What no record said.* At each frame's end the memory is compared with the record's copy. A difference becomes
    the frame's last step ("the game itself"), so the copy cannot drift. None has turned up on the probes.
  - *The test's line* that asked for the frame. This is read from V8's call sites, not from stack text: under Node
    with source maps, formatting a stack every frame cost ten times what the game did. That took a 216-frame
    record from 4.6 s to 0.5 s.
  - *What was shown* on the text lines.
- **Pictures.** These stay on the host's side and are never sent with the record:
  - The handle can now keep the game and put it back (`keep()` / `restore()`): the engine's snapshot plus the
    payload range it does not cover.
  - A game is kept every 48 frames, and when the kept games pass 256 MB, half go and the spacing doubles.
  - `GameSim` now tells the handle of its own writes between frames (`wrote()`: keys, the mouse, a scratch
    location, hit points), and the recorder keeps those with the test's actions, typed lines and calls.
  - A picture of frame F is then the nearest kept game, those things done again at their frames, and the frames
    played. Mid-frame it is the frame before's end.
  - The analysis page holds the run in a session (`scmjs.sim.debug`, `picture`; the plugin's `debug()`). The
    viewer page starts the same map the same way and draws a kept game put back over it (`scmjs.view.debug`,
    `show`). It refuses one whose frame-0 state differs.
- **The walk** (`compiler/debugModel.ts`, `DebugCursor`):
  - a line or a frame, either way;
  - continue to a breakpoint or a watched variable's change, either way;
  - the variables at the cursor, read as `sim.program()` reads them, over the record's copy of the memory;
  - what each line wrote in the frame so far.
- **In the workspace** (`debugger.ts`):
  - *Starting.* *Debug this test in the game* is on each test's row in Testing, and *Debug Test at Cursor* is in
    the palette and the editor's menu. A failed test opens at its failure.
  - *The Debug view* has a bar of controls, a timeline (the frames' cost, breakpoint hits in red, shown text in
    gold; click or drag), the variables (changes in gold, an eye to watch one), the frame's steps, and the game
    with its text lines.
  - *The editor* shows breakpoints in the margin (F9 or a click), the line about to run and the test's line lit,
    and beside each line run in the frame, the values it wrote.
  - *Keys:* F5 and F6 continue forwards and back; F10 and F11 step a line and a frame, with Shift for back;
    Shift+F5 stops.
  - The marks show only while the script is the text that was run.
- **Found on the way:** the build's variable map crashed on any program with a loop over units (`LoopUnit` has no
  `decl`). Fixed in `trigscript.py`. The units probe could not run in the game before this.
- **Measured** (under Node, `scripts/debug-game.mts`, `probes/game-debug.ts`): recording costs about 2.5 ms a
  frame, kept games included.

  | Test | Frames | Steps | Writes | Record | Time |
  | --- | --- | --- | --- | --- | --- |
  | waves | 216 | 268 | 121,213 | 1.7 MB | 536 ms |
  | the failing test | 146 | 183 | 96,936 | 1.4 MB | 349 ms |

  Most writes are eudplib's own. A picture takes 45 ms (played on from the last) to 110 ms (from a kept game).
  At six frames of each test, both ways, the picture's memory was what the record said, and the variables read
  from each agreed.
- **End to end in a built editor (2026-10-16).** scm-js `main` was built under `/editor/` with scm-sim's dev server
  beside it and the local plugin builds, on `probes/game-debug.ts`.
  - *Debugging the failing test* took about 11 s from the click (the eudplib build was 3.4 s of it) and opened at
    frame 146: "failed: expected 0, got 5".
  - *Keys:* every key moved the cursor as it should. F6 with `wave` watched stopped at "wave changed: 2 → 3", then
    at "1 → 2".
  - *Breakpoints:* a click in the margin set one, and F5 stopped before its line.
  - *The picture* was drawn in the game column. The two workers' frame-0 states matched.
  - *Picture latency:* 210–250 ms a move, 60 ms of it the debounce.
  - *Fixed in that run:*
    - The view's frame was made inside a detached box and never loaded. It now lives in an overlay over the game
      column.
    - The keys stopped after a click in the view or the timeline.
    - The panel is now made 340 px tall for a session.
    - A second backwards continue on a watched variable stood still.
    - A passing test opened on frame 1, where no line runs.
  - *Seen:* the simulator and the game disagree on this test (6 Zerglings at Home against 5). That is the kind of
    finding A2 was for.
- **Not done:**
  - The picture's camera stays where the viewer put it first.
  - A test of several players. The debugger runs one game.
  - Units are known only by their slot: the record keeps the script's memory, not the unit table.
  - Conditional breakpoints, hover values, a call stack. The stack's frames are cells too, so the record has
    them, but nothing reads them yet.
  - On a copy that may only watch (StarEdit's download), there is no picture: a picture of a map's run is the map
    played. Everything else works.

### R0. Remastered's emulator, read from a dump (2026-10-16)

Asked for on 2026-10-16 ("start with the Remastered dump"), before B1, so that the
allowlist stops saying "not known" for most of the game.

- **The dump.** Remastered 1.23.10.13515, the 64-bit executable, in a single-player game
  on an EUD map. A small read-only dumper (Windows Python, `ReadProcessMemory`) wrote the
  executable's image and every readable region of the heap (2 GB). Its code section is
  encrypted on disk and plain in memory. The dump, the tools and everything read from it
  stay in a private folder outside every repository.
- **What Remastered's EUD support is.** An emulator object, reached from one global,
  holding a tree of 12,290 *regions*: each a 1.16.1 address range, a class (34 of them,
  each with its own read and write) and the game's own object behind it. The Deaths
  condition and the Set Deaths action look the address up; a dword in no region, or one
  whose class refuses it, ends the game. The object tables (1,700 units, 2,500 sprites,
  5,000 images, 100 bullets, the order queue) are a region per object. Writes are checked
  before the class sees them: unaligned dwords are split, a flag makes a region's writes
  accepted and dropped, and the mask is applied as A0 found by trying
  (`(old & ~mask) | (op(old & mask, value & mask) & mask)`).
- **Run, not read.** Rather than read 34 classes of decompiled code, the emulator itself was
  run under Unicorn from the dump: the image at its own address, heap pages mapped from the
  dump when touched, the game's main thread block for its thread-local data, and Windows
  stood in for (locks, the heap; the one other call is `GetKeyState`, for the keyboard
  region). Every dword of every region (the object tables sampled at four objects) was read
  and then written through Remastered's own entry points, and the memory before and after
  compared: 1,581,605 dwords in 20 minutes. A write lands in **the game's own object**, in
  **memory the emulator keeps beside it** (read back, never used by the game), or nowhere.
- **Pointers are typed.** A unit's pointer fields (+0x00, +0x04, +0x14, +0x5C order target,
  +0x68 … +0x11C) take the address of a unit and set the game's real pointer; +0x0C takes a
  sprite. Anything else written there is kept beside the game. So "make this unit target
  that one" works through memory.
- **Fields that end the game when read:** unit +0x74, +0x78, +0x88, +0xB0–0xBC, +0xF0,
  +0xF4, +0x100, +0x108, +0x10C, +0x130–0x148; and most of the block from 0x6D1200.
  Writes to the terrain buffers behind the tile pointers are dropped, as Magenta probe 10
  found by playing.
- **The probe** (`probes/remastered-dump.py`, played 2026-10-16) took Magenta's `nudge`
  apart: A, B (a unit's X, then Y) and C (its sprite's X and Y) went through with nothing
  seen to move; D (a read of unit +0x74) ended the game, as the dump said, with "EUD ERROR:
  0xFFA632E3", which is 0x0059CD1C with its bits flipped. **The error code is the refused
  address**, so a line can be named from it. Probe 6's "a position write ends the game"
  was wrong; what ended it is not known.
- **In the allowlist.** `data/remastered.json` (1,285 entries: addresses, widths, verdicts,
  notes; no code or bytes of the game) is the fourth source of `scripts/allowlist.mts`,
  each entry `from: "dump"`. What was played wins over it byte by byte; where they differ
  it is "played: ignored, dump: allowed" (the write reaches the game and nothing visible
  happens), never the other way. An address no region covers is `outside`: the game ends.
  The units probe's trace now has no finding at all, where before most unit fields were
  "not known". `verdictOf` indexes entries by 256-byte block (190 ms for 42,745 rows).
- **Still open:** the keyboard region (filled from Windows on each read, so local by
  construction); images, bullets and orders were sampled at objects not in use; the
  error-code-to-line feature; the dump is one build, so a Remastered patch means a new dump
  (the tools take an hour end to end). Ghidra's project of the dump exists for B7's struct
  names.

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

**As built, first part (2026-10-16, under Node and in the lifted game; branch `b1-async`).**
The design above was built in a smaller form. No task lives on the heap: every task is
known when the script is built, so its place and its wait are two cells, like a program's.

- **An async function is inlined where it is awaited.** A function that sleeps has been
  inlined since 3.0, so `await wave(n)` puts `wave`'s body in the program. Where it waits,
  the program waits. `await f()` reads as `f()` in the front end. The type checker's
  awaited type gives a call's kind, so `Promise<number>` is a number. An async function is
  never one called copy.
- **`until(test)`** is `while (!test()) sleep(frames(1))`. It asks once at once, then once
  a frame, and goes on in the frame the answer is true. A condition (`until(bring(…))`)
  is taken as it is. No new IR.
- **`Promise.all` / `race` / `any`** are the one new statement, `parallel` (IR 15). Each
  item is a branch, and each branch is a coroutine of its own: its state and wait cells
  (rows of twelve in a per-player program), its own jump table, and its own frame end. A
  branch's `sleep` parks that branch alone. The program waits at the statement through a
  resume point of its own, and the statement *is* that point: the first frame falls into
  it and later frames jump to it. There, each branch that has not ended goes on, in
  order. `all` goes on when every branch has ended. `race` goes on at the first one, and
  the others are set to "ended". `any` is a race, since nothing in a program fails. An
  item may be an async call, `sleep()`, `until()`, another `Promise.all` / `race`, an
  async arrow called where it is written, or any of these with `.then(() => value)`.
  `const v = await Promise.race([…])` keeps the winner's value: each branch sets a
  variable as it ends, and only the winner gets to the end.
- **The lowering.** `python/trigscript.py` gained a `Coroutine` (state, wait, resume points,
  frame end). The program's frame is the first coroutine, and a branch is another, lowered
  with the same code. The simulator runs each branch as a generator of its own and hands
  up any body run apart (recursion) from inside a branch.
- **What is said.** In an async function, a promise nothing awaits is an error that names
  the `await` to write. Without async, an async call says to make the program async.
  `sleep()` on its own in a program that is not async still pauses, as in 3.x. A race
  whose value is kept and has a branch without one says to add `.then(() => …)`.
  `Promise.all` has no value yet. `await` inside a loop over units or a text is refused,
  as `sleep` is.
- **Checked.** `tests/async.test.ts` (12) and two eudplib build fixtures (`tasks`,
  `tasksPerPlayer`). `probes/game-async.ts` runs in the lifted game and in the simulator,
  and both pass all three tests at the same frames: the branches side by side, `until()`
  in the frame its answer turns, a race's value and its losers stopped, and a wave whose
  Zerglings the test kills. Cost: a waiting `Promise.all` of two branches is about 60
  conditions and actions a frame.
- **Decided while building, confirmed by the user (2026-10-16):** a race's losers stop where they
  are. JavaScript does not cancel them, but here a branch is a fixed pair of cells, so a
  race met again in a loop could not run a second copy beside the first. Stopping is also
  what the plan's own example means. (Open decisions, below.)
- **Not yet** in the first part: starting a task and leaving it running, generators,
  `const [a, b] = await Promise.all(…)`, async methods, a parameter for `.then`'s
  function, recursion through `await`, the hint for an async function that never awaits.
  All but recursion are the second part, below.

**As built, second part (2026-10-16, under Node and in the lifted game; branch `b1-tasks`).**

- **Tasks: `start()`, not `spawn()`.** Scripts already call their own wave functions
  `spawn` (the guide's examples do, and so do the tests), so the library's name is
  `start`: `start(wave(3))`, `start(async () => { … })`, and `void wave(3)` as JavaScript
  leaves a promise nobody keeps. A bare `wave(3);` in an async function stays an error,
  which now names both `await` and `start()`.
- **No heap after all.** A task is not a frame on the heap. Each `start` is a body of its
  own, inlined once, with `max` slots (16 unless `{ max }` says, up to 255). A slot is a row
  of everything the body declares (`VarDecl.task`, `ArrayDecl.task` in IR 16), the same
  rows a per-player program has, one level down. In a per-player program they are rows
  within each player's. The arguments are worked out at the start, and the parameters
  are always copies, never the caller's variables. A start with every slot running starts
  nothing, and the game says so once.
- **When a task runs.** It starts in the frame it is started in, once the program has
  given the frame back. After that it goes on every frame after the program's turn, by
  start and then by slot, and it runs on after the program ends. A task started during
  the tasks' turn gets its first turn in the same frame: the slots are gone through
  again. Each start keeps a count of its running tasks, so a start with none costs a few
  conditions a frame, and the slots after the last running one are not looked at. That
  took the probe from about 7,700 conditions and actions a frame to about 1,000.
- **A Task.** `start()` gives a number:
  `slot | start << 8 | generation << 16`. `t.running`, `t.cancel()` and `await t` work
  through it, and a number of a slot that has been taken again finds nothing. A task
  that cancels itself stops at its next wait.
- **What is refused.** A task that reads a variable of the task it was started from is
  refused, because which of that task's copies it would find is not settled. So is a task
  closing over a variable that the loop around the `start()` changes (JavaScript gives
  each turn its own). A function that starts a task is never one called copy. A function
  that starts itself, directly or round about, is the inline limit's error, and the
  message now says to write it as a loop.
- **Generators** are walked by `for…of` (`for await` for an `async function*`). The
  generator's body is inlined, and at each `yield` sits a copy of the loop's body. The
  loop variable is what was yielded: a value the script knows stays one, as in an
  unrolled loop, and anything else goes in a variable of that turn. `continue` goes on
  after the yield, and `break` leaves the generator. A generator kept in a `const` and
  stepped with `.next()` is not supported, nor is `yield*` or a `return` in the loop's
  body. Each says so.
- **The rest.** `const [a, , c] = await Promise.all([…])` gives each name its item's
  value, set as the item ends. `.then((k) => …)` is handed what the promise gives. A
  class may have async methods. An async function that never awaits gets a hint on its
  name. Unrelated, but met on the way: a loop that has a `break` or a `return` in it is
  no longer reported as freezing the game.
- **Recursion through `await`: decided, not built.** An async function that waits keeps
  its place where it waits, one place for each copy, so a call of itself would need the
  whole chain of places kept and brought back. A loop does the same job, and the error
  says so.
- **Checked.** `tests/tasks.test.ts` (15) and three eudplib build fixtures (`started`,
  `startedPerPlayer`, `generators`). `probes/game-tasks.ts` (4) and
  `probes/game-generators.ts` (3) pass in the lifted game and in the simulator at the
  same frames. Every older game probe still passes.

### Classes from any file (built 2026-10-16, between B1 and B2)

Asked for while S2's Tetris grew a library (`probes/lib/unit-screen.ts`): a class declared at
the top of any of the script's files is the program's wherever a program makes an instance of
it, with no `game()` around it, and stays an ordinary class when the script is built
(`const AT_BUILD = new V(21).double()` beside `new V(n)` in a program).

- **Planned as a game function is** (`hoist.ts#planClass`): its parameters and variables are
  the game's, and what its field values and bodies compute when the script is built is
  hoisted. The emitter adds `__class(C, { at, pos, hoisted })` after each such class, so the
  run hands its own file's values — its imports, its constants — to the lowering.
- **In a program**, a script class is never hoisted (`new C(1)` is an instance, whatever its
  arguments). Before the program's first statement the lowering declares every script class
  the program names, the ones they name and extend, and those of the `game()` functions it
  calls — their static fields — then walks their bodies in their own files.
- **Errors wait for use:** a class only ever used when the script is built reports nothing.
- **The rules of a program's class still hold:** an array field has its first value where it
  is declared, a field holds no build-time object, and an action's player and location are
  known when the script is built — so the unit screen takes them with each `draw(board, look)`.
- Checked: same file, another file with its own imports, `extends` across files with a static
  field, a class used at build time and in a program, errors only where used; Tetris's
  `UnitScreen` follows the board in the lifted game as the function did.

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

**As built, first part (2026-10-16, under Node and in the lifted game; branch `b2-events`).** `on.created`,
`on.died`, `on.chat` and `on.key`; `on.order` and who killed a unit are the second part.

```ts
on.created(units.ZergZergling, (u) => { u.energy = 50; });
on.died({ owner: P8 }, async (u) => { await sleep(seconds(2)); createUnit(P8, u.type, 1, locations.Spawn); });
on.chat("-give {n}", (p, { n }) => setResources(p, "add", n, "ore"));
on.key("F2", (p) => print("Help", { to: p }), { from: P1 });
```

- **A listener is a task.** Each `on.…` is a `start` of one slot whose body is `while (true) { sleep 1; … }`,
  inside an async program, as `ui.lines` is; it gives a Task, so `cancel()` stops it. The first turn only waits:
  a listener hands on what happens from the next frame, as a JavaScript listener added now hears nothing from
  before. A handler that is not async is inlined in the loop; an async one is a `start` of its own each time
  (`{ max }`, 16 unless said), its parameters copies of what it was handed.
- **Where the units come from: the frame's events pass**, once a frame before the programs. It walks two of the
  game's lists from their heads, the visible units (0x628430) and the dying ones (0x62842C). The reader's spec
  `scm-sim docs/specs/unit-lists.md` says every list links a record in just behind its head, so what came in
  since the pass before lies between the head and the record that was behind it then: the walk is as long as
  what happened, and a frame where nothing did costs three conditions a list. A table of a cell for each unit slot,
  336 bytes apart as the slots are (eudplib's EUDLoopNewUnit keeps its marks that way), holds the uniqueness byte of
  the unit seen in the slot, and one more once its death has been handed on. Nothing of the game is written.
- **Remastered's dying list runs the other way (Ghidra, 2026-10-17).** Its kill routine unlinks the unit from the
  visible list (img+0xe77fc8 head, +0xe78078 tail) and links it into the dying list with the same link-in routine
  (img+0x1956a0: the record goes behind the first pointer it is given), passing img+0xe78080 as the end it links
  behind and img+0xe77fd0 as the other; the free step unlinks it the same way round. The EUD emulator maps 1.16.1's
  0x62842C to img+0xe77fd0 (traced under Unicorn: the region handler 0x2e1e50 reads that global), so a map reading
  the dying list's "head" gets Remastered's far end, whose "next" is 0, and 1.16.1's 0x59CC98 (where Remastered's
  linking end would be) is not readable. A walk along "next" from 0x62842C would see one death a frame. The visible
  list maps the right way (0x628430 → img+0xe77fc8, linked behind it); unit +0x00 / +0x04 map to Remastered's
  +0x00 / +0x08, previous and next, the same as 1.16.1. (The hidden and sweep lists are mapped the other way round
  too: 0x628428 and 0x628434, tails in 1.16.1, give Remastered's linking ends.) So the dying list is walked whole,
  both ways from the record at 0x62842C, every frame it is not empty; the cell says which records are new deaths.
  A record stays on it until its sprite is gone: 14 frames for a Zergling, and 200 of them cost about 21k a frame
  for those frames. The order a frame's deaths are handed on in is the list's, so it differs between the games.
- **What counts.** A unit that comes onto the visible list for the first time is made: made by an action or a
  program, trained (when it comes out, not when it is queued), placed by a test; a unit in a transport is made when
  it first comes out, and unloading it again is nothing new. A unit on the dying list that was seen is dead,
  killed or removed (both go through the dying list; Remove Unit releases the sprite at once), handed on once. So
  every unit `on.created` hands on gets one `on.died`, and a turret, a scanner sweep, a unit made and gone between
  two passes, or one that never left its transport is neither. A unit that turns into another — an egg hatching, a
  Drone becoming a building, a Siege Tank sieging — is the same unit: it was made once, as what it was then.
- **What a handler is handed.** `on.created`: the Unit. `on.died`: a `DeadUnit` record, `{ type, owner, x, y }`,
  read from the dying record as the unit died (the slot is not given to another unit before the next dying pass),
  and only the fields the handler reads; what the filter says for certain is a value of the script, so
  `on.died({ owner: P8 }, (u) => createUnit(u.owner, …))` has its player known. `on.chat` / `on.key`: the player,
  a value of the script in each of eight unrolled copies (P1 … P8, or `{ from }`, or CurrentPlayer in a program for
  several players), so an action can be for them; `on.chat` also the pattern's values, as `chatted()` gives them.
- **What it costs** (lifted game, Binary Burghs): a frame where nothing happened, about 46 conditions and actions for
  the pass and a listener, 2 more for each other listener; about 100 for each unit made and 80 for each death. Two
  things made it so: the task runner passes a listener's whole start by when it has nothing to hand on and no task
  that has not had its first turn (`start.listen` in IR 18; a skipped turn would have done nothing), and the pass
  passes the visible list's walk by when its head and the record behind it are as it left them (the dying list costs
  three conditions when empty, about 100 a record otherwise). Before either, two idle
  listeners cost about 1,240 a frame. `on.chat` and `on.key` for all eight players idle at about 1,290, where the
  same polled with `chatted()` / `keyPressed()` in a loop costs about 1,730.
- **Simulator.** The same pass over its world's units: a unit is seen at the first pass it is alive at, its death
  found by the first pass after, each list latest first.
- **Found on the way:** the build-time evaluator had no object literals, so `print(t, { to: p })` with `p` known
  failed; and a record's known field (`u.owner` above) was not a value. Both are fixed. The lifted game's
  `sim.printed()` folds a text shown twice in one frame (its text-line reader); the probe counts the actions.
- **Checked.** `tests/events.test.ts` (7), eudplib fixtures `events` and `eventsPerPlayer`, `probes/game-events.ts`
  (4) and `probes/events.ts` (3) in the lifted game and the simulator, at the same frames; every older game probe
  still passes. **Probe for Remastered:** `Maps/TrigScript/trigscript-b2-events.scx` with its answer sheet: whether
  every death reaches `on.died` in Remastered (rebuilt 2026-10-17 with the walk both ways), a trained SCV, unloading, 200 made and killed in a frame, and chat and a key in a multiplayer game. Not played yet.
- **Played in Remastered, 2026-10-17** (multiplayer, alone): every step passes but the key. A: three "made 0".
  B: three "died 0 at x, y" near the base, then three "back" and three new Marines, each "made 0". C: two Firebats
  made and removed, "died 32" twice. D: "made 7" when the SCV came out, not when queued (loading not tried: nothing
  to load). E: "E: made 200, died 200", no stutter. F: `-give 100` gave 100 and printed "gave 100" to the player.
  F2 moved the camera (the game's own key) and said nothing; a second probe (Q, F2–F5, F7, F9, each through
  `on.key`, and F2 through `keyPressed`) heard only Q, F7 and F9. So F2–F5 join F6 as keys Remastered keeps: they
  are not a `Key`, and the examples use F7. F1, F10–F12 not played.
**As built, second part (2026-10-17, branch `b2-events-2`).** `on.killed`, `on.order`, `on.morphed`, and a listener
at the top of a script; IR 19.

```ts
on.killed({ owner: P8 }, (u, by) => setResources(by, "add", 25, "ore"));   // the killer, a player the action can be for
on.order(units.ProtossHighTemplar, orders.CastPsionicStorm, (u) => print("Storm!"));
on.morphed(units.TerranSiegeTankSiegeMode, (u, was) => print(`sieged from ${was}`));
on.died(units.TerranMarine, (u) => print("Marine down"));                 // at the top of the file: listens from the start
```

- **Who killed a unit: the dying record says.** Measured in the lifted game first (a fight, Kill Unit, Remove Unit,
  marines inside a dropship killed by trigger, a marine hurt and later killed by trigger): a death in a fight leaves
  hit points 0 and the killer's player at +0x90 (lastAttackingPlayer, as BWAPI and scm-sim name it); Kill Unit leaves
  the hit points and +0x90 as they were (8 when nobody ever hurt the unit); Remove Unit the same with the sprite gone.
  So `on.killed` is the `died` turns with hp 0 and +0x90 below 8, the killer read from +0x90. The plan's other way
  (the killer's kill count rising a frame before) is not needed. A unit a program damages to death (`u.damage`)
  with an earlier attacker would count for that attacker: not seen yet, said here.
- **`removed` is not built: the game does not tell.** A Remove Unit and a unit killed inside a transport leave the
  same record — no sprite, hit points as they were, +0x90 untouched; 336 bytes compared, nothing else differs but
  timers. A flag that is wrong for a hero dying in a dropship is worse than none, so `on.killed` takes its place:
  "died in a fight" is what a map maker asking "was it removed?" usually wants. An Archon's partner leaves the same
  way (one High Templar turns into the Archon in its own slot, the other goes without a sprite).
- **The killer as a value of the script.** `setResources(by, …)` needs its player when the map is built, so a handler
  that takes `by` is copied for each of the eight killers (`if (was == p)`), as `on.chat` is for each typer; with
  `{ by: P1 }` in the filter it is known and not copied. First found when the eudplib fixture refused `setResources(by,
  …)`: the obvious way to reward a killer did not compile.
- **Orders and morphs: one walk of the visible list.** A unit's order byte and type are compared every frame with a
  table of the events pass's own (a cell a slot, as the uniqueness cells). The type is the same unit changing in
  place, measured in the lifted game: a Siege Tank goes 5 → 30 in its slot at the frame it finishes turning (order 98,
  Sieging, the frame before); one High Templar of two becomes the Archon in its slot. `on.order` hands the unit, the
  order it took up and the one it had (`{ order }` in the filter, or the plan's three-argument form); `on.morphed` the
  unit and the type it was, its filter on the new type. Each verb's order, from the lifted game: `move` 6 (Move),
  `patrol` 152, `attack` 14 (AttackMove); the simulator sets them. New units take up Guard (2) then PlayerGuard (3)
  in the game, which `on.order` hears; their first order is not a change.
- **What the walk costs** (lifted game, about 115 units, idle): 178 conditions and actions a frame without it; one
  of `on.order` / `on.morphed` about 11,000 (≈ 95 a unit), both about 16,000 (≈ 140). First built at 16,000 / 21,000:
  reading the uniqueness byte only when something changed, and the type as its low byte, took a third off. The
  pointer chase is about half of what is left. A hint on the line says it.
- **Listeners at the top of a script.** `on.…(…)` as a statement at the top of a file is planned as a program whose
  body is that statement (a block made around it, `hoist.ts#planListener`), and the transformer replaces it with
  `__listen(descriptor)`: a program of its own, owner Player 1, listening from the start.
- **Handlers return what they like.** The declarations had `=> void | Promise<void>`, which refuses `(p) =>
  setResources(…)` (an expression body that gives an action) — the examples in the declarations were written that
  way. Now `=> void`, which an async function also is.
- **`orders`**: a name table (`orders.Move`, `orders.CastPsionicStorm`; the community's names, as BWAPI and scm-sim
  have them), the `Order` brand, and `u.orderId` an `Order`. Typed chat patterns (`{n}` a number, `{u:unit}` a unit
  type, `{k:ore|gas}` the word's place) were already in part 1, from `chatted()`.
- **Tests:** `sim.morph(unit, type)` for the simulator (the lifted game turns a unit into another type only through
  a player's command, which a test cannot give yet: `GameSim.morph` says so); `GameSim.kill(unit, by)` now leaves the
  record a fight does (hp 0, +0x90 = by), so `on.killed` hears it in both.
- **Checked.** `tests/events.test.ts` (12), eudplib fixture `eventsMore` (three programs, two at the top of the
  file), `probes/game-events-2.ts` (3) in the lifted game and the simulator at the same frames, every older game
  probe; `game-check` of the Remastered probe: 0 accesses that end the game. **Probe for Remastered:**
  `Maps/TrigScript/trigscript-b2-events-2.scx` with its answer sheet — a fight (killer both ways), a program's kill,
  Psionic Storm (order and kills), an Archon, a Siege Tank both ways, a Drone into a Hatchery and a Larva into an
  egg into a Drone, a move order, 300 Overlords with the walk on. **Played in Remastered, 2026-10-17, A and B:** the fight said "killed 37 by P1" for each of the four Zerglings and gave 25 minerals each (75 after three, 100 after four), and for the one Marine that fell "killed 0 by P2" and the top-of-file listener's "top: Marine down"; the program's two Firebat kills said "died 32" twice and no "killed". So Remastered's dying record has hit points 0 and the killer at +0x90 after a fight, as 1.16.1's does. C and D (same day): "Storm!" when a Templar began casting (on.order, CastPsionicStorm); merging the Archon said "died 67" and "morphed 67 -> 68" while it was still summoning — the type changes when the merge starts; the tank said "morphed 5 -> 30" sieging and "morphed 30 -> 5" unsieging. The storm, played again on Zerglings of the player's own (the computer's had been made out of sight): every unit it killed — eight Zerglings, two Marines, both Templar — was handed to `on.died` and none to `on.killed`, minerals unchanged. **Friendly fire leaves no killer:** the lifted game with a storm cast through player commands gives the computer's Zerglings hp 0 and +0x90 = P1, the player's own hp 0 and +0x90 = 8 (one bitten first by a computer Zergling: 1). The game keeps no attacker for a unit its own player hurts, as it counts no kill for it (scm-sim's T-30). So `on.killed` hears a unit killed by another player; the simulator's `kill(u, owner)` and `GameSim.kill(u, owner)` now leave no killer either, and the declarations say so. E, first half (first build): `-zerg` made the two Drones, and a Drone told to mutate into a Hatchery said "morphed 41 -> 131" as it began. On the first build `-storm`'s computer Zerglings went to Away, past the edge of what the player could see (they are made there in the lifted game; not looked for in Remastered); the second build's Player 12 Zerglings at Home were not seen, whether made or not unknown. Rest of E, F, G (same day): a Larva into a Drone said "morphed 35 -> 36" when it became an egg and "morphed 36 -> 41" when it hatched (an Overlord egg "36 -> 42"); a Marine told to move said "move from 3". G: no lag, but `-many` made only about 23 of its 300 Overlords — Remastered said "WARNING: Unit unplaceable! (Zerg Overlord)" for the rest, as the lifted game does not (it put 168 in a 64-pixel box): Remastered keeps a created air unit inside the location, and Home was full. So the walk with ~60 units on the map; 300 not played. **Every event of the second part works in Remastered** but the storm on an enemy, which the lifted game covers.
- **Not yet:** a morph in a test in the lifted game (scm-sim's test handle would take a player's command); `on.order`
  only for units of the filter's types (skip the order read for the rest: cheaper, but a unit that morphs into a
  watched type would bring a stale order once); whether a program's `u.damage()` to 0 credits an earlier attacker.

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

**As built (2026-10-17).** Two kinds of function value, chosen by what the build knows, so that what costs nothing
stays free:

```ts
function twice(f: () => void) { f(); f(); }
twice(() => { n++; });                         // known when built: inlined, nothing kept
let state: () => void = idle;                  // kept: a number, and a call through it a switch
function idle() { ticks++; if (ticks == 3) state = busy; }
const handlers: ((p: number) => void)[] = [];
handlers.push((p) => { gold += p; });
for (const h of handlers) h(5);
```

- **Known when the script is built: no value at all.** An arrow handed to a parameter, a function named by its name, a
  `const f = (x) => …`, a parameter handed one — a call of it is a call of its body, inlined or called as any
  function's (`Binding` kind `fn`). A function that is called and takes a function is one copy for each function it is
  handed, as it is one for each array. Such a function sees every variable where it was written, a function's own
  included, since it can only run while that function does. `compose(f, g)` and `adder(3)` return functions whose
  captured `f`, `g`, `k` are known, so each is a function of its own with them folded in.
- **Kept: a number.** In a `let`, a cell of an array, a field (of a record or an instance: `b.onClick = () => …`), a
  `Map`, a function's result, a side of `?:`. Its number is the id of a function the build makes of it (one copy,
  parameters as variables, walked once the program's body has been, so `let state = idle` before `function idle()`
  sees `state`). A call through a number is a call of a **dispatcher**, one for each shape of call — its parameters'
  kinds in order and its result — whose body is a `switch` on the number over every function kept as a value that fits.
  0 is `undefined`: `f?.()`, `if (f)`, `f !== undefined`. No new IR kind; IR 21 adds `fn` to a `const`, which is how
  only the functions whose numbers the program can reach become cases.
- **What a kept function may use from outside it:** the program's own variables (one cell each, for good), values the
  script knows, and other functions known when built — checked as the body is walked (`Scope.watch`), with the variable
  named in the error. A variable of the function or block it was written in is refused, `const` too, where the plan
  proposed allowing a `const` by value: one by value needs somewhere to keep the value per function made, and that is an
  environment on the heap with an owner (see *Open decisions*). A `for` with bounds the build knows is unrolled, so
  `for (let i = 0; i < 3; i++) hs.push(() => i)` works, each function with its own `i`.
- **Not kept as a value:** an `async` function or a generator (call it where it is written, or `start()` it), one that
  takes an array or a record (it is a copy an array), one that sleeps or holds a `rose()` / `once()`.
- **Python lowering:** a dispatcher is lowered where it is first called, with every function among its cases, which can
  come before a variable one of them uses is declared (the instance a later line makes); the lowering now makes a
  variable where it is first used (`Lowering.early`), and its `declare` sets that one. Found by the lifted game, not by
  the simulator, which makes its variables as it goes.

Cost: a call through a number is a chain of compares, one a case before the one it takes (the state machine with its
loop: five calls in 515 conditions and actions). A jump table when the cases are many is for later. **Checked:**
`tests/function-values.test.ts` (24: each body also run as JavaScript and the prints compared, and the refusals);
`probes/game-function-values.ts`, six tests, the same lines from the lifted game and the simulator; game-check: no
access Remastered ends the game for. Found on the way: `flatMap` and the other methods a program does not have now say
so instead of "A call's arguments must be known…"; an optional function parameter left out folds `g?.()` and `if (g)`.

### B4. `try` / `catch` / `throw` (4.5.0, with B3)

- `throw` unwinds the frames on the heap, task frames and recursion frames both, to the
  nearest `catch`.
- The faults the game reports today (out of memory, recursion too deep, an index out of
  range) become thrown `RangeError`s that a program can catch. When nothing catches one,
  it is said in red, as now.
- `finally` runs on every way out, `await` included.

**As built (2026-10-17, IR 22).** What a script throws is an error, and everything else is what JavaScript does with one:

```ts
class OutOfGold extends Error { constructor(public need: number) { super(`need ${need} more`); } }
function buy(cost: number) { if (cost > gold) throw new OutOfGold(cost - gold); gold -= cost; }
try { buy(price); }
catch (e) { if (e instanceof OutOfGold) print(`${e.message} (${e.need})`); else throw e; }
finally { busy = false; }
```

- **What is thrown:** `new Error(…)`, `new RangeError(…)`, `new TypeError(…)`, an instance of a class that extends one of
  them (made where it is thrown or earlier), or what a catch took (`throw e`). Anything else is refused at the `throw`,
  saying so. A class of error has a `message` and a `name` (the `name` it gives itself, else what it extends gives, as
  JavaScript has it) and fields of its own: numbers, booleans, units and texts.
- **In flight:** an error between its `throw` and its catch is two shared variables of the program (`Program.errors`:
  its class's code, its message) and one more for each field name and kind any class has. Nothing is in flight across a
  frame, so one set serves every player and every task. The codes: 1 `Error`, 2 `RangeError`, 3 `TypeError`, 16 and up
  the program's own classes.
- **`catch (e)`:** `e` is a record whose fields are made as the body reads them — `e.message`, `e.name`, `e.need` — each a
  copy taken at the catch's start, so an error thrown and caught inside the catch changes none of them. `e instanceof
  OutOfGold` is a test of the code against that class and every class that extends it, filled in once the program has
  been walked and every class that is thrown is known. `` `${e}` `` and `String(e)` are "RangeError: too far", or the name
  alone with no message. `catch { }` takes nothing. A caught error handed to a function that is inlined is itself.
- **Through functions:** inlined, a throw is a jump to the catch. A called function returns at once with the error in
  flight, and a call of one that may (it throws, it calls itself, it calls one that may) is followed by a look at the
  code. Recursion needs nothing of its own: each frame comes back as on a return, and the look goes on up.
- **`finally`** is not in the IR. It is copied before each `break`, `continue` and `return` that leaves the try (a
  `return`'s value worked out first, as JavaScript does), after the try, and into a `try` around the whole that puts the
  error in flight aside, runs the finally, puts it back and throws on. A finally that would `return`, `break` or
  `continue` out of itself is refused: one copy of it runs on an error's way, where there is nowhere to go.
- **What nothing catches** is said in red, as the game's faults are — "TrigScript: uncaught OutOfGold: need 20 more, line
  12." — and in the simulator a fault at the throw's line. A program or a task then ends, as an async function does in
  JavaScript; a handler of an event that runs within the frame gives up that turn only, and the listener goes on.
- **Waiting:** a try may span `await` and `sleep`. An error in a branch of `Promise.all` / `race` leaves the statement,
  and the other branches stop where they are, as a race's losers do. A task's error never reaches what started it.
- **A stack that runs out** is a `RangeError`, "Maximum call stack size exceeded", which a catch takes — when the program
  throws or catches anything; one that does neither stops, as in 3.x. The other faults stay as they were: an index past
  either end is not an error in JavaScript either, and a heap that runs out is said once and the push does nothing.
- **Unwinding what is held:** a loop over a text gives the copy it walks back to the heap, and a loop over a `Map` or a
  `Set` counts itself out, on an error's way as on a `break`.
- **Generators:** a `break` out of a `for…of` over one runs the generator's finally blocks, as `return()` does. The loop's
  body is walked where the `yield` is, inside the generator's `try`, so an error of the body is put aside there, the
  generator leaves through its finally blocks, and the error is thrown on after the loop: the generator's own catch never
  takes it (it did, before this was found).
- **A caught error's methods and getters:** `e.describe()`, `e.short`. Every class `e` may be (what `instanceof` narrowed
  it to, and what extends that) is asked for the member; when they share one it is inlined with `this` the caught error,
  and when one overrides it each is, behind a test of the code.
- **`e.stack`:** "OutOfGold: need 20 more\n    at main.ts:12:5", made at each `throw` of a new error, and only when some
  catch reads a stack. A stack that runs out leaves the last one there (the lowering throws it, not the front end).
- **`await t` of a task that ended on an error throws it**, and so does `Promise.all` over tasks. Each slot of each
  start keeps the error its task ended on, beside the task's number (IR `taskHandle`), in arrays a cell a slot. A task
  that fails while something awaits it says nothing in red; one that fails while nothing does is said, as an unhandled
  rejection is in a browser, and an `await` of it later still throws.

Cost (lifted game, 100 a frame): a throw caught in the same body, about 37 conditions and actions; a `try` around calls
of a function that may throw, about 19, plus the look after each call; a `try` / `finally` that nothing leaves, about 18.
**Checked:** `tests/errors.test.ts` (40, each body also run as JavaScript and the prints compared, and the refusals; a
leak test that fails without the unwinding); `eud-build` fixture `errors` through eudplib; `probes/game-errors.ts`, six
tests (seven since: generators, methods, `await t`), the same lines from the lifted game and the simulator, among them
4 800 errors out of loops that hold something, and the stack run out at 1 024; game-check: no access Remastered ends the game for. The probes of B1–B3 and B6 still pass.

**Not yet:** an error kept in a variable, an array or a field (`last = e`, `errors.push(e)`): an error would be a new
kind of value in every kind of storage — its class, its message and every field of every class — for little a map does
with one; `new Error(m, { cause })`, refused, saying to put what it needs in a field (a cause is an error inside an
error, which the same storage would need); a throw while a text
is being put together (`${made()}${fails()}`) does not give back the block of a text made for an earlier part, in the
game or the simulator (both lose the same block, so they still run out at the same text).

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

**Probed (2026-10-17), before building.** First a correction to the above: the mouse is not a B5 value.
`mouse(p)`, `clicked(p, button)` and `underMouse(p)` have reached every machine through MSQC since 3.4, and
`keyHeld` since S2, so S3's aim and movement need nothing from B5. What is left is what only one machine knows:
its camera, its selection, the local player, and the cursor on the screen without the trip to the others.

The dump of Remastered's emulator (R0, read in Ghidra) says what each of those reads, and
`probes/local-reads.ts` + `.py` was played four times, in single player and in a multiplayer game hosted alone:

| Value | Remastered's emulator | Played |
| --- | --- | --- |
| Local player `0x512684` | the real local player number; a write is kept in a copy beside the game | 0 |
| Camera `0x62848C` / `0x6284A8` | the real camera, read by the drawing code; writes ignored | follows scrolling. The view is **853** wide in Remastered graphics (16:9) and **640** in Classic: the camera stops at 2219 and 2432 on a 3072-wide map |
| Mouse `0x6CDDC4` | Remastered's input record | screen pixels ÷ 3 at 2560 × 1440, so 853 × 480 in widescreen, not 640 × 480. A write changes what the game thinks (the cursor's icon, what MSQC sends) until the mouse moves; the drawn cursor does not move |
| Buttons `0x6CDDC0` | live | left 2, right 8, middle 32 |
| Selection `0x6284B8` | the local selection, read as 1.16.1 unit addresses; a write of a unit's address puts the real unit in the slot | read: right. Written: the circles and the panel stay where they were (the panel's copy is refreshed only when the game's "selection changed" flag is set: 1.16.1 `0x4C38B0`, Remastered `+0x400100`), but orders go to the written unit |
| A click's trip through MSQC | — | 5 to 6 frames, single player and multiplayer alone alike; a game between machines adds its turns |

**Why orders followed a written selection, and why it is safe.** Both games keep the local selection apart from
the one each player's orders run over (`0x6284E8 + player × 48`, which every machine holds alike and only a Select
command changes): 1.16.1's walk over a command's units, `0x49A850`, reads it, as does Remastered's `+0x3D8800`. A
right-click is sent with no units (1.16.1 `0x4563A0`), and 1.16.1 sends a Select only where the selection is set by
the player (`0x4C0860`, seven callers). What sent the written Marine was **MSQC**: each time it carries input it
saves the local selection from `0x6284B8`, selects its own Valkyrie, and puts the saved units back with a real
Select command (`RestoreSelUnits`). The probe's line for the selection every machine holds showed the Marine the
frame after F8, before any click. With MSQC in the map a written selection is sent to everyone; without it, the
write stays on the one machine and orders go to the old selection everywhere. Neither splits the game. So
`select(player, units)` is possible: write the local selection, send a Select command as MSQC does, and set the
flag that refreshes the circles and the panel.

**As built, first part (2026-10-17, IR 23, branch `b5-local`).** Differs from the above in these ways:

- **The values:** `local.player`, `local.camera.{x,y}` and `local.mouse.{x,y}` (on the screen), each a cell read as
  `memory`'s are (`memory.ts`: `LOCAL_FIELDS`), typed `Local<number>`. `Local<T>` is only a name for `T`: TypeScript
  loses a mark at the first sum, so the check is the compiler's, as planned. The selection waits for the second part.
- **The check** (`compiler/local.ts`) is a pass over each program's IR, gone round until nothing more is found. A cell
  — variable, array, text buffer, parameter, a function's result — given a Local value is Local, and so is a cell
  assigned under a test of one. Refused, at the line and naming where the value came from (`k (from local.camera.x)`):
  an action that is not only shown (Play WAV, Display Text, Center View, Minimap Ping and the objectives are), a unit
  changed or ordered, a location moved, a table of the game written; and under a test of one, waiting, starting or
  cancelling a task, throwing, `sync()`, and a random draw (each draw moves the game's random numbers on — also
  `local.mouse.x > 3 && random()`, where whether it is drawn depends on one). Leaving early is not refused: a loop,
  a switch, a function or the program that a `break`, `continue` or `return` under a Local test leaves on some
  computers only is walked again as a whole under the test, and what it does after is said where it does it. A called
  function run under a test is walked as if all of it were. A `memory(address, …)` condition on a local address
  counts. Not followed: the made texts' heap (a Local text may be longer on one computer).
- **`await sync(player, value)`**: `syncSend` clears the slot's arrival on every computer and, on the player's own
  (`f_getuserplayerid()`), puts value + 1 where MSQC's `val` sends it from; the program then waits a frame at a time
  until a value from 1 to 1 048 575 has arrived (MSQC's cell reads 0xFFFFFFFF on a frame with nothing: the first
  build waited for "not 0" and ended at once with 0, found by the lifted game), or the player is no person or has
  left (0). Only where it is assigned, in an async program. Slots are numbered across the build; the Python clears
  the sent cell after MSQC has sent it.
- **Checked:** `tests/local.test.ts` (30), an eudplib build fixture, `probes/game-local.ts` in the lifted game and
  the simulator, and `probes/game-local-players.ts` in two copies kept in step: each computer shows its own camera,
  P2's synced mouse reaches both, and the copies agree every frame. A deliberate leak through a `memory()` condition
  (before the check followed one) split the copies at frame 2, the detector naming the line that read the screen
  position — so the passing test is worth something.
- **The simulator** reads a program's local values at the computer of the player it runs for, and a `sync()`'s value
  at the sender's; an arrival lasts one frame, as MSQC's cell does. Tests gained `moveCamera(x, y, player?)`.
  `GameSim.moveMouse` wrote the mouse's y at 0x6CDDC6; the game keeps x and y in 32 bits each from the screen's corner
  (0x6CDDC4, 0x6CDDC8), now written so.
- **Played (2026-10-17, recording 21.11.18.13):** `probes/local-ui.tsx`, a live panel and Q / W sending a place with
  `sync()`. It works in Remastered: the panel follows the mouse every frame, MSQC's copy of the mouse trails it while
  it moves (779 against 666) and catches up when it stops; Q put a Marine at the screen's top left corner (64, 2688
  with the camera at 0, 2624) and W one under the cursor, each "sent in 6 frames" for two sync()s in a row. Hosted as a
  multiplayer game alone (21.12.36.14): the same, "sent in 12 frames" — about 6 a sync() against 3 in single player,
  the multiplayer game's turns. Found by it: two sync()s in a row read their values 6 frames apart, so a moving
  mouse's x and y come from two different places. A point wants both sent on the same frame.

**As built, second part (2026-10-17).**

- **`const [x, y] = await sync(P1, a, b)`**: up to four values, read and sent on the same frame, each caught on the
  frame it arrives (MSQC's cell holds an arrival for that frame only, so a value that comes first is kept while the
  others are waited for). One trip for a point, and one point.
- **`local.selected`**: the unit in slot 0 of this computer's selection, the one the panel shows — a `Unit`, so its
  fields read as any unit's, and re-checked before use like any kept unit (its uniqueness byte taken when read). A
  new kind of unit in the IR, `selected`. **`local.selectionCount`**: the slots that hold one. Both Local: `u.kill()`
  of the selected unit is refused, showing its hit points is not.
- **`select(player, units)`**, a unit or up to twelve written out. On the player's computer: the twelve slots written,
  the panel's flag set — 0x59723C, which Remastered's emulator backs with `+0x10A4450`, the flag its panel refresh
  (`+0x400100`) tests before copying the selection into the panel — and a Select command of the units' tags (place
  + 1, uniqueness byte << 11) queued, as MSQC's `RestoreSelUnits` does. Since it travels as a command, every
  computer runs it alike: it is allowed under a Local test, and of Local units. In the lifted game it selects, and
  two copies with P2 selecting stay in step.
- Found on the way: a field of the selected unit was worked out when the script was built (the build-time
  evaluator read `.type` off the marker object); it now stops there. `u?.type ?? -1` on a unit, and `if (a && b)` of
  two units, are not supported — older than B5.
- **To play:** `probes/local-select.tsx`: a live panel of the selection; S selects the Command Center, D the unit
  under the cursor; W walks the Marines to the cursor with one `sync()` of x and y. What playing answers: whether the
  circles follow a select() (nothing in the code says they do), whether the panel does, and who obeys a right-click.
- **Played (2026-10-17, single player, recording 21.35.21.15):** the panel at the top followed every click and drag;
  S with nothing selected made the bottom panel show the Command Center, D the Marine under the cursor (then the
  Command Center), each at once — the flag at 0x59723C works. **The selection circles do not follow**: no circle
  under the unit select() chose (the green swirl in the recording is the cursor's hover). W walked the Marines to the
  cursor, "sent in 3 frames (x and y together)", half of the two sync()s in a row of the first map. Hosted as a
  multiplayer game alone (21.38.15.16): with a Marine selected by hand, S turned the bottom panel to the Command
  Center, and the S key itself then went to the Command Center's buttons ("Not enough minerals", its Build SCV) — the
  command card follows too; right-clicks on the ground after it moved no Marine (the order went to the Command
  Center); the Marine kept its circle and its bar. W: "sent in 6 frames (x and y together)", half of the 12 of two in
  a row. So select() moves the panel, the buttons and the orders, in single player and in multiplayer; not the circles.

### B6. `fixed` and `Math` (4.7.0)

- `fixed` is a 16.16 number with `+ - * /` and comparisons; mixing it with `number`
  converts as TypeScript would round.
- `Math.sin`, `Math.cos`, `Math.atan2` work on the game's 256 directions. The tables are
  computed at build time from the formula, and A2 checks them against the game's own
  table. `Math.sqrt` and `Math.hypot` use an integer square root.
- Movement uses the actions Remastered allows: a location centred on a point and Move
  Unit to it. A unit's position is never written; that ends the game.

**As built (2026-10-17).** Differs from the above in four ways, each for the TypeScript people write:

- **A number is fixed when a fraction is stored into it**, not only when declared so: `let x = 1.5`, `x += 0.25`,
  `const d = Math.cos(a)`. `numbers.ts` finds which variables, arrays, parameters and results are fixed by going over
  the program until no more turn fixed (as it finds the never-below-zero ones), and remembers the line that made each
  one fixed for the error that names it. `fixed` (the type, and `fixed(x)`) says so before anything does; a value typed
  `fixed` is fixed even when whole (`fixed(2)`, a parameter). `u8` / `u16` / `u32` stay whole: a fraction into one is
  an error.
- **Whole numbers still divide as whole numbers**: `7 / 2` is 3, as since 3.5; `7 / fixed(2)` is 3.5. Mixing converts as
  TypeScript computes (`<< 16`, a constant times 65 536), except that a fixed number times or divided by a whole one is
  the raw cell's own `*` / `/`. Where only a whole number goes (an index, a count, a place, a shift, a unit's field) a
  fixed one is an error naming `Math.floor` / `round` / `trunc`; `x | 0` is `Math.trunc`.
- **Angles are radians**, as in JavaScript, not the game's 256 directions: `Math.sin(Math.PI / 6)` is 0.5. `sin` /
  `cos` read a table of 4 096 cells and `atan2` one of 1 025, each between its cells, added to the program by
  `numbers.ts`, so the game and the simulator read the same numbers: within 1/65 536 of JavaScript's. `tan`, `atan`,
  `hypot`, `sqrt` (of a whole number, the root is still fixed, so `Math.hypot` of distances in pixels does not
  overflow), `floor` / `ceil` / `round` / `trunc`, `abs` / `min` / `max`.
- **Printed as a decimal**, up to four places without trailing zeros (`${x}` of 1.25 is "1.25").

IR 20: `VarDecl.fixed`, `ArrayDecl.fixed`, `const.fixed` (the raw cell), the intrinsics `fmul` / `fdiv` / `sqrt` /
`atan2` / `sin` / `cos`, a printed number's `fixed`. A product and a quotient are rounded towards zero through the
magnitudes, wrapping at 32 bits, in Python (`fixed_fns()`: the four 16-bit partial products; eudplib's division then
sixteen bits one at a time) and in `compiler/fixedMath.ts` alike. In the lifted game, conditions and actions:
multiply 461, divide 562, `sqrt` 1 068, `sin` 856, `atan2` 960, a fixed times a whole number 164. **Checked:**
`probes/game-fixed.ts` (six tests: the same lines printed by the lifted game and the simulator), `tests/fixed.test.ts`
(16). Found on the way, fixed in the language: a switch over a value known when the script is built keeps the case that
applies (was an error); `??` `||` `&&` and the comparisons fold over known values; a `const` of a game function set from
a known parameter is a value; an optional parameter left out is `undefined`, and `xs !== undefined` of an array given is
known; `x * 2^n` is a shift in the lowering (`w * 32` cost 144, `w << 5` 30).

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

**Started 2026-10-17, steered by S4** (the user: "a fog screen library for awesome DX —
developer experience first, enjoyable and easy to use"). Bad Apple in TrigScript is the
first program that needs memory the language has no word for (the vision countdown), so B7
starts from what it needs, and the fog screen (Part C) is built on it in the same slice.
What a map maker should write:

```tsx
import { program, fog, playSound, nextFrame, P1 } from "trigscript";
import badApple from "./bad-apple.webm";   // B8: frames at the game's rate, as fog pictures
import song from "./bad-apple.ogg";        // put in the map's archive

program(async () => {
  fog.reveal(P1);                         // light the whole board once: dark is fog from now on
  playSound(song);
  for (const frame of badApple) {         // one frame of video a game frame
    fog.draw(P1, frame);
    await nextFrame();
  }
});
```

and, for anything drawn while the game runs (the raycaster's columns, a radar, a ripple):

```ts
program(async () => {
  while (true) {
    for (let i = 0; i < 8; i++) fog.light(P1, cx + dx[i], cy + dy[i], 3);   // this frame only
    await nextFrame();
  }
});
```

- **The model is a canvas cleared every frame**: what a program lights this frame is what
  shows this frame, and nothing else needs saying. The library's machinery is the
  compiler's: a map that uses `fog` gets the countdown written after every trigger pass
  and the brushes' sight ranges set every frame. The unit types the brushes are made of are
  heroes no ordinary map places (Remastered takes a sight write a frame late, so each size
  is a type of its own), and a free location is taken from the top of the first 63, as
  input does — the map maker never chooses either. A map that places or makes one of those
  heroes gets an error that says which and why.
- **Coordinates are tiles**, because fog is kept per tile, and a size is a sight range,
  1 to 11; the hover shows each size's shape (the game's own masks, lopsided by a row).
- `fog.draw(player, picture)` draws a picture made when the script is built:
  `fog.picture(["..##..", ".####.", "######"])` from rows of text, an imported image or a
  video's frames (B8). The encoder is `bad-apple-encode.mts`'s, moved into the compiler.
- **Memory** (`memory.vision.countdown` and the rest) is the general door the library walks
  through: fields from a list like `tables.ts`, each with Remastered's verdict from R0 and
  the played probes in its hover; a read-only field is `readonly` in the declarations, so a
  write is a type error before anything is built.

The order: the `memory` list and its lowering (a cell with no index, through the table
read and write that exist) → `fog.light`, the canvas machinery and `fog.reveal` → pictures
from text → B8's imports (an image, then a video, decoded in the editor where the script is
built; the plugin's 4 MB limit on data files is planned for) → Bad Apple written as above,
then its lyrics with S2's JSX and the never-seen opening.

**As built, first part (2026-10-17).** `memory` (`compiler/memory.ts`: vision.countdown,
game.frame, map.width/height, each with Remastered's verdict in its hover; a namespace merged
with the trigger level's `memory()` condition) and **the standard library**: modules of
TrigScript shipped with the compiler, `stdlib/<name>.ts`, embedded by `npm run embed`, joining
a script's files only when imported as `"trigscript/<name>"` (the compiler maps the path, the
linker runs it, Monaco reads it). `trigscript/fog` is the first: `light`, `draw`, `picture`,
`reveal` and a canvas program of its own. What it needed of the language, each general:
`reserveLocation(why)`, `nextFrame()`, `centerLocation(…, width, height)`, a `const` of a game
cell kept in the program, an `if` on two constants compiled to its live side. In the lifted
game every size lights its mask exactly, a picture and a disc draw where asked, `reveal`
explores every tile, ~280 conditions and actions a frame for the probe (`probes/fog-lib.ts`).
Found: Arcturus Mengsk's and Gerard DuGalle's Battlecruisers and Raszagal cannot be made by
a trigger; the brushes are Kukulza ×2, Yggdrasill, Magellan, Gantrithor, Hyperion, Norad II,
Tom Kazansky, Danimoth, Mojo and Artanis. Not yet: played in Remastered with the heroes; an
error when a map places one of them; `import` of a video (B8, built: see B8's As built).

### B8. Built from the game (4.9.0)

Tables a map could not afford to compute while it runs, computed by running the lifted
game when the map is built:

- `ground.distance(a, b)` and `ground.region(x, y)`, from the game's own regions for this
  map (Walkability already reads them out of the lifted engine).
- Anything else a function of the map: `atBuild(() => …)` runs in the lifted game at build
  time and its result becomes a constant table.

Cost: map size. The hint says how many bytes each table adds.

**As built, first part: imported videos (2026-10-17).** Started with what S4 needed rather than the game's tables:
a video a script imports, and the tables made from it when the script is built.

```ts
import { fog } from "trigscript/fog";
import badApple from "./bad-apple.video";

program(async () => {
  fog.reveal(P1);
  await nextFrame();
  playWav("staredit\\wav\\badapple.ogg", 0);
  await fog.play(P1, badApple);          // or fog.light(P1, x, y, badApple, frame) each frame
});
```

- **The `.video` file** (`compiler/media.ts`) is one of the script's files, kept in the map with the others: the
  frames the editor decoded, a tile a pixel, ink or not, a frame for every frame of the game (42 ms, Fastest). The
  source video is not kept: what the build reads is the same on every computer, whichever browser or codec decoded it.
  One line of JSON, the frames compressed as JBIG compresses a fax — LZMA's binary range coder, the odds from 11 tiles
  around each (six of this frame, five of the frame before). Bad Apple, 5,216 frames of 128 × 96: **559 KB** of text,
  where runs of tiles were 2.1 MB; read back in 0.7 s, every tile exact. `import x from "./x.video"` is typed by a
  `declare module "*.video"` (a `Video`: sizes, length, `frameMs`, `seconds`, `frame(i)` as rows of text); the
  linker hands the value over, kept while the file's text is the same. A `.video` is no TypeScript: the compiler,
  Monaco and the archive keep it beside the code (and `.tsx` files, which the archive dropped on reopening since 2.0,
  are kept now too).
- **`cover(picture, shapes)`** (`compiler/cover.ts`), new in the language: the brushes whose union is a picture's ink,
  each a shape on ink only, greedy, largest gain first. Lazy greedy over one candidate a tile — the largest shape that
  fits there (the game's sight ranges nest, so a smaller one on the same tile never gains more; found by halves, a fit
  tested a row at a time on prefix sums), candidates a larger fitting neighbour holds dropped, gains kept as prefix
  sums of covered tiles. **2.6 ms a 128 × 96 frame**, where S4's encoder took 130. Ink thinner than any shape gets the
  smallest shape placed, of every place it covers the tile from, inside the picture and on the fewest dark tiles:
  0.36% of Bad Apple's tiles lit that are dark, where it was 0.80%. Of a video, every frame's brushes, worked out once
  while the file and the shapes stay the same (Bad Apple: 11.6 s the first compile, 285 ms after). `fog.picture` is
  `cover` now.
- **The fog library** draws a video: `fog.light(player, x, y, video, frame)` reads the frame's brushes out of two
  tables made when the script is built (a word a brush, `x | y << 8 | size << 16`, and where each frame starts), so a
  frame can be a variable; `fog.play(player, video, x?, y?)` is `game(async …)`, a frame each game frame.
- **Tables a program only reads** may hold 1,048,576 entries (4,096 before), and the IR carries one of 256 or more
  packed — base64 of the narrowest little-endian width (1–4 bytes) — which the lowering widens back with slices and
  puts in the map as one `Db` (`EUDArray(_from=EPD(Db(…)))`, no Python list of a value at a time). Bad Apple's IR is
  2.77 MB, within the eudplib plugin's 4 MB of data.
- **Language:** `"key" in value` folds when the value is known when the script is built (TypeScript's other way of
  narrowing a union of objects; `fog.light` tells a picture from a video so). The map's sounds are a name table,
  `sounds.BadApple` (the Sound Editor's list, by file name or path), and a WAV argument takes one.
- **Import Video…** (`videoImport.ts`, the Explorer's camera button, the More menu, the palette, or a video or picture
  dropped on the Explorer): a preview frame, the size in tiles (the map's width, the video's shape), the threshold, which
  parts are ink, the name. A picture becomes a `.ts` file of rows of text — editable, what `fog.picture` takes. Clicking
  a `.video` opens a viewer: play or scrub, the tiles or **as the fog draws it** (the brushes `cover` makes, tiles off
  the video in red, brushes a frame).
- **Decoding** (`videoDecode.ts`): the file taken apart — WebM and Matroska (EBML), MP4 and QuickTime (boxes, with
  composition offsets and the edit list for B-frames) — its samples handed to WebCodecs' `VideoDecoder`, every frame
  with its own time; each game frame takes the video's frame nearest its time, as ffmpeg's fps filter does. Bad Apple
  (AV1 in WebM) in **12 s** in the editor, 3.3 tiles a frame off the source frame nearest in time (ffmpeg's import:
  24.9). Where that cannot be done, the video plays in an element and frames not shown are sought. Found on the way,
  in a busy editor page in headless Chromium: the browser shows 7.5 frames a second, `requestVideoFrameCallback`'s
  `mediaTime` names an earlier frame than the element holds when the callback draws it (`VideoFrame.timestamp` and
  `.duration` are the frame's own), and a seek takes 66 ms — the first three ways tried came out 300 tiles a frame off.
- **Under Node:** `scripts/import-video.mts` makes a `.video` with ffmpeg; `scripts/script-files.mts` follows imports
  of videos.

**Checked:** `tests/media.test.ts` (the format both ways and cut short, `cover` exact on ink a shape wide and a thin
line kept inside, the library's shapes the same as `compiler/fogShapes.ts`, packing at each width, a script playing a
video whose tables light what `cover` meant frame by frame, a missing file, sounds, `.tsx` and `.video` in the
archive); `tests/video-decode.test.ts` (H.264 with B-frames in MP4, MOV and MKV, HEVC, VP8, VP9, AV1 in WebM and MP4,
made by ffmpeg on the spot). **In the lifted game** (`probes/bad-apple.ts`, built with `scripts/build-fixture.mts` on
S4's white board): all 5,176 frames from the first with ink equal their cover, nothing lit off the board, 0.49% of
tiles off the video (S4's hand-written map: 1.17%); 54k conditions and actions a frame on average, 151k at most — about
twice the hand-written eudplib, within the 500k budget. **In the editor** (headless Chromium, the local build):
Import Video… on the real file, the script's "Cannot find ./bad-apple.video" gone after it, 0 problems, the viewer.
**Played in Remastered (2026-10-17): it works**, and felt in time to the player. `trigscript-b8-bad-apple.scx`,
Classic graphics: the countdown lines 24 frames (1.008 s) apart, the picture on time after it, matching the source at
0.998 with no drift over 3:39. The recording put the song 0.7 s ahead of the picture throughout; the map plays both on
frame 241 (the simulator and the lifted game agree), and that recording's audio track is 0.86 s shorter than its
video, both said to start at 0 — the recorder's, not the map's. **Not yet:** grey levels and colour (a
renderer that needs them — the raycaster's textures — will say which); the game's own tables (`ground.distance`,
`atBuild`), the rest of B8.

**Images (built 2026-10-19, the build-time half).** A picture can now be kept as pixels rather than as ink: Import
Video… on a picture asks how to keep it — pixels in colour or in grey (an `.image` file), or rows of ink to edit (the
`.ts` as before) — and `import logo from "./logo.image"` gives an `Image` worked on when the script is built:
`width`, `height`, `color`, `transparent`, `grey/rgb/alpha(x, y)`, `crop`, `scale` (each pixel the average of what it
covers, colour weighted by alpha; a block of itself growing by a whole number), `flip`, `rotate`, `invert`, and at the
end `threshold(level, { ink })` (rows for `fog.picture`) or `tones(n)` (rows of digits for a library's own renderer).
A pixel under half opaque is never ink. Nothing reaches the game but what the script makes of it.
- **The file** (`compiler/image.ts`): one line of JSON, 1 to 1024 pixels each way, planes grey or green / red − green /
  blue − green, then alpha if any pixel is less than opaque; each plane predicted pixel by pixel by JPEG-LS's median
  edge detector, the miss coded with LZMA's range coder (now `compiler/rangeCoder.ts`, shared with `.video`) under odds
  chosen by how busy the neighbourhood is. Real pictures at 128 and 256 pixels came back exact and 15–40% smaller than
  PNG at its strongest, both in base64. The decoded pixels are kept, not the PNG or JPEG, for the reason a video's are.
- **The editor:** the dialog's preview shows the pixels (in grey when grey is chosen); its size defaults to the
  picture's own, 256 the longer way at most, 1024 at most typed. An `.image` in the Explorer has its own icon and hover;
  clicking it opens a viewer — the image, or a threshold as the fog draws it (brushes, tiles off in red) with the
  `fog.picture(logo.threshold(…))` line that makes it — from the same `Image` the build has.
- **Left out:** a dither. Floyd–Steinberg made 4,066 brushes of a 256 × 192 logo (the game creates about 950 in a
  frame), and scattered single tiles are thinner than the smallest sight shape, so the fog cannot draw them.
- **Halftone instead** (`image.halftone(cellWidth, cellHeight = width + 1, { diffuse })`): the fog's own way of
  showing grey. Each cell gets one brush or none — the fog's shapes that fit, the largest a tile past the cell so
  neighbours run together into white, moved in from the picture's edges, never past them — chosen by the light it
  adds that nothing lit before (spill into a neighbour counts for the cell that made it), what it misses diffused
  to the next cells; `diffuse: false` is an even grid. The rows carry their brushes and `fog.picture` draws those, so
  it is a brush a cell at most (covering the union again took a fifth to a half more where discs merge). Two first
  tries were worse: mixing "lit whole" cells with discs made ragged ink at 2.4 brushes a cell, and choosing by the
  cell's own share alone came out 10% light where discs spilled into cells already chosen.
- **The third tone, answered without a play:** whether a map can mark tiles never seen again (black, below fog grey).
  Remastered's own EUD emulator run on the dump (scm-sim-reader `remastered/probe.py`): 0x6D1260 reads 0xAF1080 and
  is writable, but reads at that address give 0 and writes change only the emulator's cache — the fog tile array is
  not the map's to write in Remastered. Two tones it is.
- **Probe built** (`probes/halftone.ts`, pictures from `probes/lib/halftone-gen.mts`, base map
  `probes/lib/raycaster-map.mts` with `MAP_NAME`): A ramps at 4 × 5, 6 × 7, 8 × 9 diffused; B the same even; C a lit
  ball in two tones and five halftones; D five pre-rendered walks of the raycaster's maze with walls greyer by distance
  and side (whole, 4 diffused / even, 6 diffused / even; at most 558 brushes a frame). Played once in Classic and once
  in Remastered graphics: does Remastered's blur melt the dots into grey, which cell size, and do diffused dots
  shimmer when the picture moves.
- **Played 2026-10-19** (one round, F5 switching graphics, recording 11.06.27.24; minimap crops Classic 388 wide at
  (338, 1040), Remastered 386 at (17, 1042) in 2560 × 1440): everything drew where built in both. **Classic:** dots,
  sharp — tile to tile 9–13 apart — though a diffused ramp's averages climb steadily (108 → 164). **Remastered: the
  dots melt** (tile to tile about 2) and a diffused ramp climbs 73 → 93; the ball at 6 × 7 undiffused reads as real
  shading. But Remastered's minimap has a third of Classic's contrast — lit 97 against fog 71, Classic 169 against
  104 — so every grey there is dim. Undiffused ramps show steps (in Remastered not even climbing evenly); diffused
  leaves a dot texture at 4 × 5 in Remastered. Walks: walls read as grey in Remastered, near against far faintly.
  Open: shimmer while walking, and whether to use it in the raycaster — the player's eye. The player: the two-tone ball still
  looks best; D2's dots are distracting, D4 better but not great.
- **Remastered's minimap, surveyed** (`probes/tile-survey.ts`, `probes/lib/tile-survey-map.mts`: six tilesets, 88 tiles
  each lit and in fog; recording 11.37.09.25, minimap at (18, 1041), 3.03 pixels a tile). Remastered draws a tile on
  the minimap as its art's average — the art's average luminance and the minimap's agree at 0.96–0.99 in every
  tileset — and draws fog as **0.64 of lit, for every tile**: the contrast's ratio is fixed, only brightness can be
  chosen. The brightest is **Ice snow** (tile 66, group 4, walkable): lit 130, fog 82, a gap of 48 — the board we used,
  Badlands 23778, is lit 86, fog 57, a gap of 29 there (its art averages 71; 1.16.1 takes one bright pixel of it). The
  best of the other tilesets: gaps 39–40. So a fog map for Remastered graphics wants snow (two thirds more contrast),
  one for Classic graphics Badlands 23778 — Classic's minimap is still the sharper and wider (169 against 104).
- **Snow played in Remastered** (recording 11.54.03.26: raycaster, halftone probe, Bad Apple, built with `BOARD=snow`
  / `BA_TILE=66`): lit 129, fog 82, as surveyed. The fine grate texture the earlier Remastered recording showed was
  Badlands 23778's own HD art; snow is smooth. Diffused ramps climb 86 → 125 (twice Badlands' range), still smooth;
  halftone dots show as soft blobs; the walk at 4 × 5 undiffused reads most like shading. Outlines and silhouettes
  clean and soft-edged.
- **Not yet:** the runtime half — an image as a table a program reads while the game runs (textures, sprites, a level
  painted as a picture) — waits for the lowering work on `backend-limits`.

**Checked:** `tests/image.test.ts` (the format both ways — grey, colour, transparency, noise, one pixel — cut short,
too big, kept in the archive; every operation on a known picture; a script importing one, drawing it in the fog, a type
mistake and a build-time mistake each said on their line). **In the editor** (headless Chromium, the local build): a
PNG dropped on the Explorer, each way of keeping it previewed, imported, a script using it 0 problems, the viewer.

### Sounds: the probe (played 2026-10-19)

Wanted: sound effects and music from a program. Before the language: what StarCraft: Remastered does with sounds a
program plays (`probes/sound-probe.ts`; its sounds made by `probes/lib/sound-probe-map.mts`, each a tone or click of
its own so the audio says which played and when). Played, two rounds, recording 12.22.41.27; measured from its audio
(48 kHz, digital silence between sounds, so a start is read to the sample). Both rounds agree to the sample.

- **Timing.** A sound starts on a 21.3 ms grid — 1 024 samples at 48 kHz, the mixer's buffer — so up to one buffer
  after its frame (12–14 ms standard deviation); the spacing over time is exact (6 frames: 252.2 ms on average).
  One every frame plays every time (60 of 60). Good enough for music at game speeds; not for sub-buffer flams.
- **The WAV list.** A sound named by no WAV slot starts on the same grid as a listed one, the first time too: no
  loading delay. The list is for the editor, not for timing.
- **Again is another.** Playing a sound that is still playing starts a second copy beside it; there is no restart,
  and no action stops a sound — a note's length is the file's.
- **Voices.** 32 different sounds at once, all heard to their ends: none cut, none dropped.
- **Copies add.** Eight copies in one frame are exactly eight times as loud — summed, no limiter: a library keeps its
  own headroom.
- **Loudness kept.** A tone written at a quarter of another comes out at exactly a quarter: a gain made when the
  script is built is the gain heard.
- **Formats.** 8- and 16-bit PCM at 11, 22, 44 (stereo) and 48 kHz, IMA ADPCM and Ogg Vorbis all play; **Ogg Opus
  is silent.** Programs are Remastered-only, so Vorbis is open to them; IMA ADPCM is a quarter of 16-bit PCM and
  simple to write in the editor, where no Vorbis encoder is at hand.

So the music library can fire notes per frame (42 ms on Fastest) from pitched copies made at build, overlapping
freely within 32 voices, each note's length and loudness baked into its file.

### Closures and the missing methods (built 2026-10-17)

The language gaps a TypeScript programmer meets first, after B3–B5, closed before the libraries (`screen`, `ui`):

```ts
function makeCounter() { let count = 0; return () => ++count; }
const hs: (() => number)[] = [];
for (let i = 0; i < n; i++) hs.push(() => i);          // one i for each turn, as JavaScript has it
function counter() { let c = 0; return { inc: () => { c++; }, get: () => c }; }

const [cmd, who, amount] = line.trim().split(" ");
if (cmd == "-give" && !isNaN(parseInt(amount))) give(parseInt(who), parseInt(amount));
queue.push(x); const next = queue.shift() ?? -1; xs.splice(i, 1); xs.at(-1);
```

**Closures over locals** (`compiler/closures.ts`, IR 24). B3 refused a kept function that used a variable of the
block it was written in; the open decision above chose between "`let` only when the closure does not outlive its
frame" and reference-counted environments. Built: environments, counted.
- *What is kept where.* A variable a kept function uses is a cell of an array of its own at a row of a pool (1 023 rows
  a program, a player's own in a per-player program); the block it is declared in makes a row each time it runs, its
  parent the row around it. A closure is a row too: the function and the row it was made in. A function that keeps
  nothing is `FN_BASE` (2²⁰) plus its id, as B3's numbers were, moved out of the pool's way; a dispatcher takes a
  closure apart and hands the function its environment as a last parameter.
- *Which variables.* Found by walking the program once: the B3 watch, which refused, now records the declaration, and
  the program is walked again with those kept in environments (`compiler.ts`, up to five walks; only the last one's
  errors are said). Nothing is kept that no kept function uses: a function known when built (an arrow handed down,
  `xs.forEach(…)`) costs what it did.
- *Lifetime.* Counted, deferred: every store into a place that may hold a reference (found to a fixed point from
  what `make` gives) holds the new one and lets go of the old; a row at 0 is queued, and the program's next wait gives
  back what is still at 0 there. So a closure only just made, on its way into a variable, is never let go of under it,
  and one made and dropped in the same frame costs no sweep of its own. Parameters and results are not counted.
- *JavaScript's semantics, checked against it:* the function and its closures share the variable (a write either side
  is seen by the other); two closures of one run share it (`{ inc, get }`); a copy of a closure is the same closure
  (`a === b`); the `let` of a `for` is copied into a new environment at the end of each turn, before the update.
- *Not yet:* a function that calls itself may not declare a variable a kept function uses (its variables go on the
  stack, where nothing counts them); an array or a record of the function kept by a closure (copy it into the program,
  or into fields); more than 1 023 alive at once (said once, and the new one does nothing).
- *Cost, lifted game:* a variable-index read is about 70 conditions and actions, a write 15. A turn that makes an
  environment and a closure, calls it and lets go of the one before: about 1 700 (2 800 before the counting was made
  to read one cell where it read three). Found on the way, for every program: `xs[i] = xs[i] + n` (`xs[i] += n`) now
  lowers to the game's own Add (`EUDArray.iadditem`), nothing read — 85 down to about 25.

**Also found missing, and built:** `++n`, `n--`, `n = v`, `n += v` used as values (`return ++count`, `ids[k++] = id`,
`while (n-- > 0)`), as a call inlined where the expression is, so `&&` and `?:` run it only when JavaScript would; a
function may give a record it makes (`return { inc, get }`, `() => ({ x, y })`), inlined where it is called, as an
instance already could; `join` of an array is worked out where it is used (it was worked out before the statement it
was in, so `${xs.unshift(5)} ${xs.join()}` read the array too early).

**Texts:** `trim` / `trimStart` / `trimEnd`, `replace` / `replaceAll` (a text to find; an empty one matches before
every character, as JavaScript's), `toUpperCase` / `toLowerCase` (A–Z only; Korean is left as it is), `lastIndexOf`,
`split(sep, limit?)` (an array of texts, taken apart with `const [a, b] = …`, indexed, looped over), `parseInt(s,
radix?)`, `Number(s)`, `Number.parseInt`. A number of a program is never NaN, so `isNaN(parseInt(s))` /
`Number.isNaN(Number(s))` is compiled as "has no number at its start", and `isNaN` of anything else is refused with
that said. Regular expressions and `replace` with a function are refused.

**Arrays:** `shift` (a value, or `?? other` for an empty one), `unshift` (gives the new length), `splice(start,
deleteCount?, ...items)` standing on its own, `at(i)` (from the end below zero; `?? other` past either end), `lastIndexOf`,
`join` of numbers and booleans — on arrays of numbers, booleans, texts, records and units. One routine (`spliceRows`)
moves rows for all of them: the rows taken out give their blocks back, the rest move up or down a cell a column, and
the new rows are emptied before they are filled, so a text or an inner array that moved is never given back twice.
A `const` array that only these change is the program's (`hoist.ts`), not a list of the script.

**Checked:** `tests/closures.test.ts` (20) and `tests/text-array-methods.test.ts` (20), each body also run as
JavaScript and the prints compared; `tests/function-values.test.ts`'s two refusals are now working examples. In the
lifted game and the simulator, the same lines: `probes/game-closures.ts` (6: counters, a turn's own `i`, shared
variables, closures inside closures, handlers fired frames later, 3 000 made and let go of across 30 frames with the
kept ones still there) and `probes/game-text-arrays.ts` (4).

### Components, functions from any file, and the first libraries: ui and screen (built 2026-10-17)

The libraries the language was missing, and what they needed of it first.

**Language, found missing while writing them:**
- *JSX components.* `<Meter label="HP" value={hp} max={100} />`: a function of your own as an element. Its props are a
  record of the attributes (an optional one left out is `undefined`, which `??` folds; `children` is the text between
  the tags, typed `Children`), and its text is written into the text it stands in — its `<line>`s are lines there, as
  React has it, not a text pasted onto the line before. A component is a function declared in the program, a `const`
  arrow, a `game()` function, or (below) a function at the top of any file; its body is an expression or statements
  ending with the one `return <…/>`.
- *Functions from any file.* As classes from any file already were: a function declared at the top of a file — or a
  `const` arrow there — is called by a program with its own values without `game()`, planned as a game function is,
  its errors said only where a program uses it so. Called with values the script knows, it still runs when the script
  is built, whatever JavaScript it uses. Kept in an array or a record (`const fs = [a, b]`) it is the program's function
  as a value. Destructured parameters work for all of them.
- *A function declared in a block sees the block's variables* (it saw only the program's top).
- *What a function writes makes the array or record handed to it the program's:* `add(names, t)` where `add` pushes, a
  `const shop = { … }` that `choose(…, shop)` writes. And a `const` record written directly is the program's too, as a
  `const` array was (it said "declare it with let").
- *A record's text field is a made text when the record is handed to a function*, which may give it one.
- *JSX:* a colour worked out in the game by name (`color={i === sel ? "cyan" : "white"}`); `map` over an array of
  texts and over a list handed in as a prop.
- *The standard library may hold `.tsx` modules* (`STDLIB_EXT`).

**`trigscript/ui`** (`stdlib/ui.tsx`): `Meter` (a labelled bar, green / yellow / red by the share), `Panel` (a title
over its children), `MenuList` and `choose(player, count, menu)` (Up, Down, Enter; the state a record of yours that the
view shows), `DialogBox` and `say(player, box, speaker, text)` with `typewriter`, `LogLines` and `log(lines, text,
keep)`, `clock(frames)`, `thousands(n)`. One `ui.lines` a player, the components pieces of its view.

**`trigscript/screen`** (`stdlib/screen.tsx`): `Screen(x, y, width, height, cell?)` — `clear`, `set`, `get`, `rect`,
`line` (Bresenham), `blit(sprite(rows))`, `number` (3 × 5 digits) — and `present()`, which shows it on the map, and so
on the minimap, a pixel an Overlord of the colour's owner (P3 … P8 and P1), making and taking away only what changed
since the last time; `ScreenView` shows the same grid in the text lines. Generalises the Tetris probe's `UnitScreen`.

*Played and changed (2026-10-18, four rounds):* the board was invisible (other players' units under the fog of war:
`Screen.reveal(player)` makes Map Revealers over it) and the view showed twice (`ui.lines` now fills the eleven text
lines); then a 64 × 64 map of Space (`probes/lib/screen-map.mts`) so the board fills the minimap, the screen's owners in
the text colours' order, fixed arrays of 2 048 cells (the first frame 712k → 434k), Space rather than Enter (which opens
the chat). The minimap draws an Overlord as a dot with a gap round it; Overlords a tile apart do not fit (the game will
not place most of them), so `new Screen(…, "solid")` makes each pixel a Pylon, which the minimap draws as its two-tile
footprint: pixels side by side are one block, on buildable ground (`screen-map.mts --ground`). 320 Pylons on the grid
in the lifted game, none moved. Played (round 4): solid blocks on the minimap as expected, but on grey platform and with
the Protoss supply counter climbing; the user prefers the dots on Space, which stay the default.

**Showpiece: Snake** (`probes/snake.tsx`, `trigscript-snake.scx`): the board on the minimap with `screen`, the score,
a length meter and the game-over menu in the text lines with `ui`, the snake two arrays that `push` and `shift`. In the
lifted game: its test passes in both; about 14k conditions and actions a frame, 400k on the first (the screen's 768
cells pushed and the walls made — a fixed-size screen would cost less). Awaiting a play in Remastered.

**Checked:** `tests/ui.test.ts` (components, 4 more), `tests/script-functions.test.ts` (6), `tests/ui-kit.test.ts`
(5: the kit rendered, the meter's colour in the IR, the log, `choose` and `say` with keys pressed), `tests/screen.test.ts`
(4: drawing, digits, `present` making only what changed).

### timers, signals, random and math, and generics (built 2026-10-17)

Four modules of pure TrigScript, no probe needed, that the next showpieces lean on — and what the language needed first.

**Language:**
- *Generics.* A generic class's instance (`new Signal<number>()`) and a generic function at a call (`shuffle(names)`)
  are worked out with their type parameters standing for what they are there. The structured compiler's checker is
  wrapped so that a type it hands back that is a type parameter comes back as that type; the instance carries its type
  arguments (`typeArgs`) into its constructor and every method called on it; a call's are read from the checker's
  resolved signature (a parameter declared `T` or `T[]`); a function kept as a value inside a generic method is walked
  later with them; a generic function is a copy for each set of them. "A class of a program takes no type parameters"
  is gone.
- *A function handed to a task keeps what it uses*: a known function handed to `start(…)`'s call is kept as a value
  there, so its variables get an environment — `every(4, () => log += tag)` in a loop keeps each turn's `tag`, as a
  `setInterval` callback does — and the program holds it for the task's slot (an array a `start`, a cell a slot) until a
  later task takes the slot. A known function's environment is reached from where it was written, not from where its
  number is made (inside a game function, which sees nothing of the program).
- *A function of the script's own that uses the game* (`random`, a read, a wait, a print — itself or through another)
  is never run when the script is built, whatever its arguments (`hoist.ts#usesGame`): `range(2, 4)` drew at build.
- *A Task a function gives* (`every(…)`) is not a promise left unawaited.
- `v.rotate(a).x`: a field of the instance or record a call gives, the call made once a statement.
- A method that writes an array handed to it makes the array the program's, as a function already did; a class's text
  field written in its own methods (`this.value = v`) is a made text when the class is at the top of a file.

**`trigscript/timers`:** `every(period, fn, times?)` (handed the count), `after(delay, fn)` — tasks, so `cancel()` and
`running` — and `Cooldown` (`use()`, `ready()`, `left()`), `Countdown`, `Stopwatch`, `now()`, `SECOND` = 24.
**`trigscript/signals`:** `Signal<T>` — `on`, `once`, `off(id)` (the place reused), `emit`, `count`, `clear`.
**`trigscript/random`:** `chance`, `range`, `dice`, `pick<T>`, `weighted`, `shuffle<T>` on the game's synced random;
`Random(seed)`, xorshift, the same numbers as JavaScript's.
**`trigscript/math`:** `lerp`, `inverseLerp`, `remap`, `clamp01`, `approach`, `wrap`, `sign`, `distance`, `distanceSq`,
`manhattan`, `angleTo`, `radians` / `degrees`, `PI` / `TAU`, easing (`easeIn/Out/InOutQuad`, cubic, `easeOutBack`,
`smoothstep`), `Vec` (fixed `x`, `y`: `fromAngle`, `add`, `sub`, `scale`, `dot`, `length`, `normalized`, `angle`,
`rotate`, `distanceTo`, `lerp`).

**Checked:** `tests/generics.test.ts` (3, against JavaScript), `tests/stdlib-core.test.ts` (11; `Random` against the
same xorshift in JavaScript, easing within a hundredth), `tests/closures.test.ts` (+1, the task). In the lifted game and
the simulator, `probes/game-stdlib-core.ts` (4), about 4k conditions and actions a frame; the earlier probes and Snake
re-run, all passing.

### What is still missing: a sweep (2026-10-18)

Before more showpieces, about a hundred lines of the TypeScript people write were put through the compiler and the
simulator, each over values only the game has (`random(9)`), so that nothing was worked out when the script was built.
Control flow and syntax are nearly whole. What is left is mostly **what a value can be**.

**Refused:**
- *Instances as references.* An array or a variable of a base class or an interface holding more than one class
  (`const world: Entity[] = [new Bullet(), new Enemy()]`, `let x: Shape = c ? new Circle() : new Square()`); an instance
  that may be none (`target: Enemy | null`, `next: Node | null`); an array of instances inside an instance
  (`squad.members: Soldier[]`); a `Map` whose values are instances or records; an array of a union of records
  (`Event[]` with `kind: "hit" | "heal"`).
- *Records and instances as values.* `p = p.add(q)` ("a record is assigned field by field"), which makes `trigscript/math`'s
  `Vec` awkward; a `?:` that gives a record; `number | undefined`.
- *Generators and helpers.* `g.next()` by hand, a generator method, `yield*`, `[Symbol.iterator]`, a generator or an
  `async function` at the top of a file called with the program's values.
- *Small:* labelled `break` / `continue`; `sort()` of texts; `${flag}`; `String.fromCharCode`, `JSON.stringify` and
  `toFixed` of values of the game; `Object.keys` of a record of the program; `enum` inside `program()` (at the top of a
  file it works); `using`.

**Two faults found:** a function handed a value of the program that narrows with `typeof x === "string"` sends the
compiler into endless recursion ("Maximum call stack size exceeded"); `Date.now()` is the moment the script was built,
silently. *Both fixed:* `c ? a : b` (in a number, a text, a truth value, a colour, a record copied whole, a maybe) folds
a condition known when the script is built, as `if` did, so the side a narrowed argument does not take is never
compiled; and a variable of the program is read as its own kind whatever TypeScript narrowed its name to, which was the
loop. `Date.now()`, `new Date()`, `Math.random()` and `performance.now()` inside a program, or in a function of the
script's that a program calls, are refused with `elapsed()`, `memory.game.frame` or `random(n)` named instead; at the top
of a file they stay the build's (`tests/sweep-faults.test.ts`).

**Already working:** `enum` at the top of a file, `switch` on texts, unions of literal types as states, spread,
`extends` and `super`, getters and setters, statics, `#private`, tuples, `sort` with a comparison, `reduce`,
`Array.from`, async generators inside a program.

**In order of what the showpieces need:**
1. References and polymorphism (B9, below). *Built.*
2. Records and instances as values everywhere (B9, below). *Built.*
3. Generators finished, and async functions in libraries — with the cutscene library, which is written in them. *Built,
   but `g.next()` by hand (below).*
4. Abstractions over what a frame costs: `unroll`; a loop spread over frames by a budget (A4 knows each line's cost);
   fields packed into one cell and written with a mask; a view printed only when what it reads changed.
5. `using` for what a program holds for a while: a location (`reserveLocation`), a reveal, the camera.
6. The small ones and the two faults.

### B9. References and values

A showpiece with things in it — bullets, enemies, a tower and its targets — is a list of objects of several kinds, each
pointing at others. Until now an instance was its fields' variables, its class known when the script is built: cheap
(a field is a variable) and enough for one of each, but not for a list of kinds, a pointer that may be none, or a
variable that is one object now and another later.

**References.** A class the program keeps *by reference* has its instances in one table for the program: rows of the
pool the closures already keep (`closures.ts`), counted the same way, a column for each field.
- *A reference is the row*, 1 to 1 023; none (`null`, `undefined`) is 0. `x === y` compares rows; `if (x)`, `x?.hp`,
  `x ?? y` ask whether it is 0.
- *The columns* are shared between classes by field name and kind, so a field of an interface is one column whatever
  class the row is, and reading it needs no question of the class. A field of a unit is three columns, a text three, an
  array that grows four, as a row of an array of records already has them; the row is the same binding, so a method, a
  getter, a setter and a field's text or array work on it as they do on a row of an array.
- *The class of a row* is kept in the pool's function column. A method called through a reference whose class could be
  several asks it: one case for each class that gives the method its own body (one where they all share it), each the
  method with `this` that class. `instanceof` is the same question.
- *Which classes are kept so* is found by walking the program, as the closures' environments are: a class goes by
  reference when the program needs it to — a variable or a field that may be none, a variable given another instance, an
  array or a variable of a type more than one class fits, an array of instances inside an instance, a `Map` of them —
  and the program is walked again. Every other class stays as it was, its fields variables; nothing gets slower that
  does not need to.
- *Lifetime* is the closures': every place that holds a reference counts it, a row nothing holds is queued, and the next
  wait gives back what is still at nothing — what it held let go of too (its references, its texts, its arrays). Rows
  that hold each other in a ring are never given back (no collector looks for rings); said in the guide.
- *A method of a class kept by reference* is called, not copied, from its second call on: `this` is a number, so the
  method is one function for every instance — and a method that calls itself on another row (a list walked, a tree) is
  recursion as any function's is.
- *Through none:* a field of none reads 0, and a write to one does nothing (JavaScript would throw).

**Values.** A `let` record or instance of a class that is not kept by reference may be given another whole: `p =
p.add(q)`, `r = c ? a : b`, `r = { x: 1, y: 2 }` copy the fields. A copy is what JavaScript does only while nothing else
names the same fields, so a `const q = p` of such a `p` is a copy too, and a class whose instances are both given whole
and changed field by field where another name shares them goes by reference instead. `number | undefined` (and
`boolean | undefined`) is the value and a flag beside it: `=== undefined`, `??`, `!` and narrowing read them;
`xs.find(…)` gives one.

**As built (2026-10-18).** No new IR: the object table is arrays and statements the front end writes, as the closures'
pool is (`compiler/closures.ts`, `structured.ts` *References* and *Records and instances as values*).
- *Which classes.* `refs` is carried from walk to walk as `boxed` is (`compiler.ts`, up to seven walks). A class joins
  where the program would otherwise be refused: an array or a variable of a type more than one class fits or that may be
  none, a field that may be none or is an array of instances, a variable given another instance (of a class something
  changes in place), a function giving one instance or another, a `Map` of instances, a `Set` of them, an instance kept in
  a variable pushed to an array of instances. With it come the classes that fit it. Which classes a type may be is the
  checker's assignability over every class of the script's files (`instanceClasses`), so an interface fits whatever has
  its members.
- *A reference is a number.* `kindOf` says "number" for a type every class of which is kept by reference, as it does for
  a function (B3), so variables, arrays, parameters, results, `Map` values, `Set` keys, task arguments and fields of other
  rows hold one with nothing of their own. Where it is used as an object — a field, a method, `instanceof`, `?.` — it is a
  row binding (`refRow`): `rowOf` over the table, the place the number, the classes it may be beside it.
- *A call through a reference* of one class, or of several sharing the member, is that member's; of several with bodies of
  their own, a call whose body is a `switch` on the row's class (`virtualCall`), a case for each body. A method called
  twice is a called function whose last parameter is `this`, a number, one copy for the classes it may be; so a method
  that calls itself on other rows (`left.sum()`) is recursion's. Constructors stay copies at each `new`. Methods of a class
  at the top of a file may now be called functions too (they were always copies).
- *The table.* A column a field name and kind, shared between classes (`hp` of a `Grunt` and of a `Boss` is one array);
  two kinds under one name are said. 1 023 rows, the closures' own: a closure, an environment and an object are rows of
  one pool, each class a number in its function column (from 2²²). `new` takes a row (`make(class, 0)`) and runs the
  constructor on it under one test that there was one; a field's first value is stored with nothing let go of.
- *Counting* is the closures'. Two changes for every program: only a variable that a wait may come between its
  declaration and a use is counted (a loop's `const e = enemies[i]`, and every local of a called function, need nothing:
  no row is given back while they are read), which also fixed a variable of an unrolled loop holding its last object for
  good; and the sweep asks a row's class once, then lets go of that class's references, gives back its texts' and arrays'
  blocks, and empties only the cells its constructor does not write.
- *None.* 0. A field of none reads 0; a write to one is skipped (a test before each, except on a row being made);
  `x?.f`, `x?.m()` and `x ?? y` ask first. JavaScript would throw a `TypeError`.
- *Values.* `p = …` of a `let` record, or of an instance of a class whose fields only its constructors write
  (`isValueClass`: no write of one of its fields outside a constructor in any file), stores a copy into its fields:
  of a record written there, an instance made there, what a call gives (copied first: it may be `p` itself), another
  record's fields; `c ? a : b` is an `if`. `const q = p` of a `p` given whole is a copy, and is said when a field of
  either is written (the two would no longer be one record). `const r = c ? a : b` is declared empty and filled. A class
  changed in place and given whole goes by reference instead.
- *A number or nothing* (`number | undefined`, `boolean | undefined`, `?:` fields): a variable, or a column, and a
  boolean beside it, `(there)`. `=== undefined` and `== null` read the flag; `=== 3` reads both; `if (x)` is there and not
  0; `x ?? d` a ternary; narrowed (`if (x !== undefined)`, `x!`) it is the number, and read where the checker says it may
  be nothing it is said. `find()` / `findLast()` of any list and a `Map`'s `get()` give one; a record written out may
  leave an optional field out.
- *An array of a union of records* (`Event[]`): a row holds every kind's fields, a field one kind has not got empty in
  its rows. Narrowed by `kind`, as TypeScript narrows, each reads its own.
- **Not yet:** rows that hold each other in a ring are never given back (no collector looks for rings); more than 1 023
  closures, environments and objects alive at once; an object made and dropped within one frame is given back only at the
  next wait, so a frame that makes more than 1 023 runs out; a function that returns `number | undefined` (only `find`,
  `get` and variables give one); a field of the same name and two kinds in two classes kept by reference.
- *Cost, lifted game:* a field through a reference is a cell read with a place worked out in the game, about 70; made and
  given back, an object costs about 530 conditions and actions (`make`, the counting when it is let go of, the sweep) — 100
  a frame is about 53 000. A class that needs no reference costs what it did.
- **Checked:** `tests/references.test.ts` (20) and `tests/values.test.ts` (19), each body also run as JavaScript and the
  prints compared; in the lifted game and the simulator, the same lines: `probes/game-references.ts` (5: one of several
  classes, a list made, walked and reversed, a tree summed by a method that calls itself, instances in an instance with a
  text and a `Map`, 3 000 made and given back across frames) and `probes/game-values.ts` (3). Five older tests that said
  a refusal now say what the program prints.

### Generators finished, async functions in libraries, and trigscript/cutscene (built 2026-10-18)

The third of the sweep's list, and the library it was for.

**Generators.** Still walked where the `for…of` is (the loop's body put where each `yield` is), now from anywhere one is
written: a generator at the top of a file, a generator method (`squad.alive()`, `this` the instance), and an instance's
`*[Symbol.iterator]()` (`for (const u of squad)`). `yield*` walks another generator there, or a list (`yield* [1, 2]`,
`yield* xs`); a `break` in the loop leaves both. A generator method of a reference that may be of several classes with
bodies of their own is refused (which one runs is the game's, and a generator is walked where it is written).
**Not yet:** `g.next()` by hand. A generator stepped by a program is a coroutine that runs a turn when it is asked, inside
the frame of whoever asks; the lowering has coroutines (a program, a `parallel` branch, a task) but none that another
calls and comes back from. That is a lowering of its own (a `resume` of a task's body, returning to its caller) and the
simulator's, kept for later; a task and `await until(…)` do what a hand-stepped generator is wanted for.

**Async functions in libraries.** A generator or an `async function` at the top of a file is a function of the script's
own now (`isScriptFunction`), called, awaited and started with the program's values, as `trigscript/timers` had to wrap
its own in `game()` before. `sleep(frames(n))` and `sleep(seconds(n))` of a number the game holds count down a frame at
a time (the next frame at the least, as `frames(0)` waits), which a scene's timings need.

**Found on the way:** a class from another file used only inside a function at the top of a file was never declared for
the program, so its methods were walked in the calling file and their variables not found — a fault since functions
from any file (B3's time); a parameter's default naming a constant of its file (`limit = 30 * SECOND`) was not worked out
for such functions or for methods; a unit variable the checker narrowed to `null` where it is tested was read as a
boolean.

**`trigscript/cutscene`** (`stdlib/cutscene.ts`), everything a trigger can do, a frame at a time:
- `Camera(x, y)`: `look(x, y)` (Center View on a location the library keeps), `pan(x, y, frames, ease)` (`"linear"`,
  `"in"`, `"out"`, `"inOut"`, `"back"`, from `trigscript/math`), `follow(unit, frames)`, `shake(frames, size)`. The camera
  of the player the program runs as.
- `walk(unit, x, y, near?, limit?)` and `charge(…)` (a Move or an Attack order to another location the library keeps,
  then waiting until the unit is within `near` pixels, gone, or `limit` frames have passed), `walkAll(units, x, y)`.
- `line(speaker, text, frames)`: the speaker's portrait talks and the words show in the middle of the screen.
- `play(player, start(scene()), key?)`: a scene started as a task, which the key (Escape) skips; it says whether it was.
- **Checked:** `tests/cutscene.test.ts` (4, simulator); `probes/game-cutscene.ts` (3) passes in the lifted game and the
  simulator — a Marine really walks there, the camera's place after a glide and a shake, Escape skipping a scene.
  `probes/cutscene.ts` → `Maps/TrigScript/trigscript-cutscene.scx` and its answers sheet: a scene (Raynor's line, four
  Marines walking with the camera following, a glide and a shake to the Zerg base, a circle round it turned by `Vec`
  given whole, back), then a list of `Effect`s of two classes (`Ping`, `Wave`) ticked every frame for twenty seconds — B9
  in a map. In the lifted game every step prints what the sheet expects; a frame costs about 5 000 at the most. Awaiting a
  play in Remastered. Seen there: the centre line ("Raynor: …") is read back from the game's memory more than once
  by the lifted game; whether Remastered shows it again is the sheet's question 10.

### A second sweep, and what is left (2026-10-18)

After B9 and the generators, about seventy-five more lines were put through the compiler and the simulator, again over
values only the game has. What B9 was for holds: a linked list built in a loop, a tree summed by recursion, an abstract
class and an interface over several classes in one array, `instanceof`, an array of instances inside an instance,
`Map<number, Enemy>`, `?.` and `??` on a reference, two-dimensional arrays, `sort` of instances with a comparison, and
`trigscript/math`'s `Vec` given back whole (`v = v.add(w).scale(2)`) all compile and run. Data is no longer what
stops a showpiece; what a frame costs is, and a handful of small refusals.

**One fault:** a function at the top of a file that makes an instance whose field starts as `random(5)`
(`class E { hp = random(5) }`, `function mk() { return new E() }`) was worked out when the script was built, and refused
there ("random() is a coin toss … use them inside program()"): asking whether a function uses the game did not look
into a constructor or the fields' first values.

**The small refusals** (the next slice):
- labelled `break` and `continue` (`outer: for …`, `continue outer`);
- rest parameters (`function sum(...xs: number[])`);
- a function of the script's giving back an array (one giving back a record works);
- a function in a `namespace`, and a function with overloads, taken for helpers of the build and refused when called with
  the program's values;
- `find()` on an array of instances (a reference that may be none, which B9 has, rather than "take findIndex");
- `Map` keyed by a text or a union of literal texts (`Map<"a" | "b", number>`): the keys are known when the script is
  built, so each is a number;
- a record of functions keyed by states, `Record<State, () => State>`, called as `table[state]()`;
- `sort()` of texts; `${flag}` and `String(flag)`; `enum` inside `program()`;
- `push` of a record that is one of a union's kinds chosen by `?:`.

**Not worth it:** `JSON.stringify`, `Object.keys` and `for…in` over a record of the program, `WeakMap`, tagged
templates. None of the showpieces wants them, and each needs a runtime of its own.

**As built (2026-10-18).** All of the list, and the fault; no IR change (still 24). `tests/small-gaps.test.ts` (simulator,
22) and `probes/game-small-gaps.ts` (4 tests, passing in the lifted game and the simulator, about 10 thousand a frame,
32 thousand at the most).
- *The fault:* asking whether a function uses the game now looks at what `new` runs (the fields' first values, the
  constructor, the base class's) and follows a method or an accessor of the script's classes.
- *Labelled jumps* are lowered without anything new reaching a backend. A jump to the loop it is directly in is a plain
  one. From deeper, it sets a flag of the label's (`(break outer)`, `(continue outer)`, made only when such a jump is
  there) and breaks out of where it is. After each loop or switch it leaves, the flag is tested: in the labelled loop's
  own body, the loop is broken or continued and the flag cleared; further in, it is broken out of again. Each jump goes
  through the `finally` blocks of its level, and through a generator's loop as a `break` there does. A label on a block
  is refused.
- *Rest parameters* were built in the inliner already; the plan of a script function refused them.
- *A function giving back an array*: the call's own array, bound to the caller's name (`instanceCall` with `list`); a
  `return` of one it made, one written out, or one it was handed, every return the same one. Made again each time the
  call runs, as any declaration in it is. `for (const x of evens(n))` and `evens(n).length` take it too.
- *Namespaces*: a function, a class or a const arrow in a `namespace` at the top of a file (as deep as they go) is the
  file's (`atTop`). An exported const of one is registered as `Geo.mk`, since it has no name of its own once compiled.
  *Overloads*: the declaration with the body is the one a call names.
- *`find()` of instances or records* gives the row at the place found and a flag beside it, as `chatted()` does (`if (t)`,
  `t ? t.hp : 0`, `t?.hp ?? -1`, `t === undefined`). That fixed a fault on the way: `x === undefined` of such a record, or
  of what `chatted()` found, was answered "no" when the script was built.
- *Texts of a union as keys*: a `Map` or a `Set` keyed by `"red" | "blue"` has a cell for each text, in the union's order;
  a text of the program becomes its place by comparisons, as a `switch` over texts does. A `for…of` over one is unrolled,
  its key a text known when built. Any text as a key is still refused.
- *A record at a text of a union* (`cost[state]`, `NAMES[team]`, `step[state]()`): each field under its test, as a value
  (number, function, text, boolean); a write (`=`, compound, `++`) walks the statement once for each field.
- *`sort()` of texts*: by their characters (the game compares bytes, which is JavaScript's order for ASCII), or by a
  function; stable; a row moves with the block it owns. `reverse()` too.
- *`${flag}`, `String(flag)`*: `"true"` or `"false"`.
- *`enum` inside a program*: made where the build-time parts run (a plan item of its own), so its members are values.
- *`push(c ? { … } : { … })`*: an `if` with a push on each side.

**Then, in order:**
1. **What a frame costs, as the language's** (the fourth of the first sweep's list). Snake's first frame is 434 thousand
   of the 500 thousand.
   - A loop spread over frames by a budget, `for await (const e of over(enemies, { cost: 50_000 }))`: A4 knows each
     line's cost, so the compiler knows where to stop and carry on the next frame; a program's start spread the same
     way, which is Snake's first frame.
   - Fields packed into one cell and written with a mask (`hp: bits<7>`): a field of a reference costs about 70 to read,
     and a bullet hell reads many.
   - A view printed only when what it reads changed: `computed()` and `effect()` over `Signal`, one rule for what the ui
     kit and the fog framebuffer each do their own way now.
   - A size per class (`@pool(512) class Bullet`): instances and closures share one pool of 1 024 rows (`CLOSURE_CAP`);
     a size of their own gives each kind its room and its sweep a known cost.
2. **`g.next()` by hand**: a coroutine that another calls and comes back from (the lowering set aside above). Behaviour
   trees, dialogue trees and Part C's computer players are written in them.
3. **`using`** for what a program holds for a while (a location, a reveal, the camera): try/`finally`, which B4 already
   copies per exit, and `Disposable` in the editor's library (esnext).
4. **Texts made in the game**: `String.fromCharCode`, `toFixed`, a number with thousands. Save codes (Part C) need the
   first.

### What Remastered charges (cost step 1, 2026-10-18)

A4 counts conditions and actions, and the dial put the budget at 500 thousand of them. But the dial's loop is the
cheapest kind of work there is, and A4's count is a number of records, not a time. Before making the language
cheaper, step 1 finds what each kind of record costs Remastered. Read in the Ghidra project (1.23.10.13515):

- **Every Deaths and Set Deaths of an EUD map goes through the emulator**, even one in the real deaths table: the
  handlers (+0x28AB30, +0x288240) take the emulator's way whenever the map is an EUD map (+0x105423C), with no fast
  path. Inside (+0x2E1450, +0x2E18F0): a one-entry cache of the last region read (+0x80) and another of the last
  written (+0x88), else a search of a tree (+0x2DA5A0), then the region's own read or write through its vtable.
- **The tree holds about 12,300 regions**: every unit (336 bytes), sprite, image and bullet is a region of its own.
  So a read of a field of another unit than the last always misses the cache, and so does a read of a payload
  variable between two reads of a unit.
- **A masked Set Deaths is a read and a write** (+0x2E7DB0); an unaligned one two of each (+0x2E7A20). A masked
  Deaths condition costs only an AND.
- **A trigger costs something of its own.** The walk (+0x41B350) finds each trigger through the caches or the tree
  (+0x2E1940) and reads its next pointer through the emulator (+0x2E4540), and checks the game's state (+0x33D7C0,
  five instructions) after each condition and action. A4 counts none of that: an empty trigger counts 0.
- The game speed table (0x5124D8, backed by image+0xDCF050) and 0x51CE8C (image+0x1067BE8) are regions the emulator
  reads and writes; whether the game paces its frames from that copy is a probe of its own, later.

**The probe** (`probes/frame-weights.py`, hand-written eudplib, beside `probes/frame-weights.ts`): 13 mixes, each 8
game seconds at 200 thousand and at 800 thousand records a frame, idle stretches between, 32 phases in all
(`python3 probes/frame-weights.py` prints them). It writes its phase and frame as deaths of Player 12 (units
220–222), which the profiler reads from the game's own deaths array. The mixes: the dial's loop as eudplib writes it;
payload Set Deaths 64, 8 and 1 to a trigger; empty triggers; payload Deaths conditions; Set Deaths in the deaths
table; alternating payload and deaths table (the write cache misses every time); masked Set Deaths; conditions on one
unit's fields, on 256 different units, and alternating one unit with the payload; Set Switch.

In the lifted game every mix lands on its design count (201,741 and 806,494 a frame; empty: 781 and 3,125 turns of
256 triggers, 1,807 and 6,494 records, the loop's own). game-check: 0 accesses Remastered ends the game on, 0
ignored, 0 never seen. One number from the count already: **eudplib's own loop is 13 records a turn; TrigScript's
lowering of the same loop is 39** — the first thing the cheaper lowering should match.

**The profiler** (scm-sim-reader `remastered/profile.py`, Windows Python, read-only, not shipped): every 50 ms each
thread's CPU cycles (QueryThreadCycleTime) with the probe's marks, and ~1,000 stack samples a second of the busiest
threads: the instruction pointer and the stack's words that point into StarCraft.exe. A return address of the walk
among them says which of its calls the thread was under. `remastered/profile_report.py` takes the profile, the
probe's table and the lifted count, and gives cycles a record for each mix (between its two amounts, and against
idle), the trigger's own cost and an action's (from 64 to a trigger against 1), and where the samples were. Checked
on a synthetic profile first.

**Played 2026-10-18** (single player, Fastest; Ryzen 9 7900X, TSC 4.58 GHz; 266,178 samples). The game thread
spends 5.4 ms of CPU a frame with no trigger work, the same in every idle phase from the first to the last. Every
phase held 42 ms a frame; the most any took was 20.6 ms of CPU (act1 at 800 thousand). Cost a record, from the slope
between the two amounts (against idle agrees within 3 cycles everywhere, so the cost is linear):

| Mix | ns a record | What it says |
| --- | ---: | --- |
| switch64 | 3.2 | Set Switch: an action outside the emulator costs a third of a Set Deaths |
| cond16 | 5.4 | a payload Deaths condition, 16 to a trigger |
| empty | 9.0 a trigger | the walk alone, per trigger |
| act64 / deaths64 | 9.8 | Set Deaths, cache held; the deaths table costs the same as the payload |
| act8 | 10.0 | |
| mask64 | 12.8 | a masked write: +3 ns |
| unitSame | 13.1 | a unit field, the same unit: the unit region's read costs +8 ns over a plain one |
| loop | 14.6 | eudplib's loop, 13 records (190 ns) a turn |
| unitAlt | 16.5 | |
| alt64 | 17.1 | Set Deaths changing region every time: +7 ns, a quarter of the samples in the tree search |
| unitWalk | 17.5 | 256 different units: the tree search is a quarter of all samples |
| act1 | 18.3 | Set Deaths, 1 to a trigger |

From act1 against act64: **a trigger costs 8.6 ns of its own** (the empty triggers say 9.0), a Set Deaths 9.7 and a
Deaths condition 4.8. So a trigger with one action costs nearly twice what its action does, and eudplib's code is
mostly small triggers.

What the budget is, in time: the dial's 500 thousand loop records are 7.3 ms, its flicker at a million 14.6 ms, and
its slowdown between 2 and 5 million: with 5.4 ms of the game's own, 42 ms runs out at about 36 ms of trigger work
(2.5 million loop records), which fits. The flicker most likely comes from a drawn frame (16.7 ms at 60 Hz) missed
while a trigger pass holds the thread, so the smooth budget is about 7–11 ms of trigger work a frame on this
computer, and the hard one about 36 ms. A record count can't say either: 500 thousand records are 2.7 ms of
conditions or 9 ms of one-action triggers.

Asked afterwards, the player saw no flicker in any phase, the costliest 15 ms of trigger work (act1 at 800 thousand).
So the smooth budget on that computer is at least 15 ms; the dial's flicker at a million is not explained by its time
alone (TrigScript's loop records may cost more than eudplib's; not measured).

**As built: the weights in A4.**
- scm-sim's tap (`src/exact/cost.ts`) counts triggers. The lifted walk stores the trigger it stands at in 0x6509AC
  before running it, so each record says its trigger; a record whose slot is not past the last one's starts a new
  visit (a loop through one trigger). The triggers the walk passed without running anything (eudplib's jumps are
  empty triggers) are found by following next pointers from the trigger before, up to 4,096, and counted only when
  the chain reaches the record's trigger. Triggers before a frame's first record and after its last are not seen.
  On the probe every phase's count matches its design (the empty mix 201,815 a frame against ~201,700).
- The tap takes a `weigh` (`CostWeigh`: `trigger`, `record`, `reset`) and adds its nanoseconds by frame and by group
  beside the counts, with each group's costliest frame.
- TrigScript's `compiler/remasteredCost.ts`: `WEIGHTS` (the table above, as a model: trigger 8.6, Deaths condition
  4.8, Set Deaths 9.7, masked +3.0, a unit's field +7.5, a search +7.3, from one unit to the next +4.7, other actions
  3.1, other conditions counted as Deaths), `RegionMap` over `data/remastered-regions.json` (made from the dump by
  scm-sim-reader `remastered/regions.py`: 6 pools, units 1,700 × 336 among them, and 729 regions), and
  `RemasteredWeigh`, which keeps the two caches as the emulator does: a Deaths record's address (Current Player
  resolved, masks read), a trigger found through either cache, its next pointer read through the read cache before
  the next trigger.
- **Checked against the played run** (`scripts/weigh-map.mts` on the probe built with 4-frame phases): at 800
  thousand every mix is within 1.5–7.5% of what Remastered took; eudplib's loop, which no weight was fitted to,
  4% low. The model reads 0.2–0.5 ms low whenever there is work at all, an offset rather than a share.
- `gameTests.ts` sets a `RemasteredWeigh` on the host's tap where it has `weigh`; `CostLines.read` gives
  `TestCost.ms` (the script's milliseconds a frame, the rest apart, the peak) and `LineCost.ms`, lines in order of
  milliseconds. A host from before this change counts only, and everything shows counts as before.
- The editor: a line's hint is "2.7 ms a frame" from 0.3 ms (2% of 15 ms); the cost row says milliseconds on
  average and at the most as a share of the 15 ms, with the counts in its title; the graph is in milliseconds.
  `scripts/test-game.mts` prints the same. On Snake: the first frame's 440 thousand records are 6.5 ms, 1.4 ms a
  frame on average.
- Not yet in the editor's game: it runs scm-sim through plugin-scm-sim, which needs a build with the new tap.

### The cheaper lowering (2026-10-18)

With A4 in milliseconds, each change to the lowering is weighed before and after by **the lowering bench**:
`probes/lowering-bench.ts` runs one kind of statement a line, 100 times a frame, and `scripts/bench-lowering.mts`
builds it, weighs it by line in the lifted game and compares with `probes/lowering-bench.baseline.json` (the lowering
before this slice). `probes/game-lowering.ts` checks every new path in the game and the simulator.

Nanoseconds a turn, before → after:

| Line | Before | After | Records a turn, after |
| --- | ---: | ---: | ---: |
| `for (let i = 0; i < n; i++)`, the loop's own | 437 | 181 | 13 |
| `x += 1` | 134 | 18 | 1 |
| `x = y + z` | 177 | 124 | 8 |
| `k = (k + 1) & 15` | 360 | 40 | 2 |
| `x = cells[k]` | 897 | 376 | 27 |
| `x = cells[3]` | 653 | 130 | 8 |
| `cells[k] = y` | 157 | 204 | 15 |
| `cells[5] = y` | 62 | 62 | 4 |
| `if (y < z)`, both signed | 318 | 318 | 22 |
| `x = y * z` | 555 | 555 | 39 |
| one `for (const u of unitsOf(P1))`, a frame | 229 237 | 229 237 | 15 943 |

- **Adds in place.** `x = x + 1` was lowered as eudplib's `x + 1` (a copy into a temporary, the add) and a copy back:
  9 records and 4 triggers. A store whose value is the variable plus or minus something that only reads, and does not
  read the variable, is now eudplib's add where the variable is (it wraps, as numbers do); `x = y + e` is a copy and
  an add; `x = x & c` / `x | c` a masked write of the cell; and these nest, so `k = (k + 1) & 15` is an add and a
  mask on `k` itself.
- **A loop's counter is never below zero.** The number pass already knew which variables nothing puts below zero; an
  add put a variable out of it, as `wave += 1` wraps in the end. A `for` whose test is `i < e` (or `e > i`) and whose
  update adds 1 to `i` now keeps `i` in, when its other stores are never below zero and nothing in the loop's body or
  in a function stores into it: the update runs only after `i < e` held with that `i`, so `i + 1` is at most
  2 147 483 647. A comparison with one side never below zero is marked as reading it from 0 up, which it reads the
  same: `i < n` is `n >= 0` and `n > i` in one trigger, where it was an addition of 2^31 a side.
- **ANDs in one trigger.** `&&` of tests that do nothing was `EUDAnd`, a branch an item; it is one trigger's list of
  conditions, which the game ANDs. A negated one is a light bool set by one trigger and cleared by a second.
  `relation()` orders two variables with `>=` and `<=` too (eudplib does `<` and `>` only): `b - a`, which the game's
  Subtract stops at 0, is 0.
- **Cells of their own.** An array of up to 2 048 cells, and the rows of a per-player program and of a task's slots,
  are an `EUDVArray`: a cell is a variable of 72 bytes, which a read jumps to and which writes itself out. A read at a
  variable index is a jump by the index's bits; at a constant index two triggers. An `EUDArray` read takes the dword a
  bit at a time either way. A write at a variable index works the cell's address out by one trigger an index bit
  (`cell_write`; eudplib 0.81's `EUDVArray` has no add, and its own set is dearer). The map of variables says each
  row's `stride` (72, or 4), and the readers (`gameVariables.ts`, the debugger, the names in a desync or an EUD
  error) follow it.
- **A fault found on the way:** `a[i] -= v` used the game's Subtract, which stops at 0, where numbers wrap: `a[i] -= 5`
  of a 3 was 0 in the game and -2 in the simulator (`probes/game-lowering.ts` E and F failed on the lowering before).
  It is now the add of the negative, which wraps.

Not done here, and why:
- **A loop over the units** scans the 1 700 slots of the unit table, about 135 ns a slot, 229 µs a frame whatever the
  number of units. A condition on a unit's slot costs about 17 ns (the unit region's own read and the search), and a
  trigger cannot run again without a second one to put its next pointer back, so a scan has a floor near 30 µs. The
  game's lists of live units make the cost the units' own (eudplib's `f_cunitepdread_epd` follows them cheaply; the
  events pass already does), but they give the units in another order than the slots: a choice for the language.
- **The showpieces moved little** (weighed over 900 frames, before and after): Snake 1.73 → 1.69 ms a frame on
  average, Tetris 0.35 → 0.33, the raycaster 1.66 → 1.55, the units probe unchanged. Their costliest lines are not
  the bench's: Snake's HUD (`ui.lines`, its texts built again every frame) is 1.2 of its 1.7 ms; the raycaster's are
  fixed-point products and quotients and signed comparisons of values that can be below zero (`sideX < sideY`).
- `x * y` (555 ns), a signed comparison of two variables neither of which is known never below zero (318 ns), and a
  write at a variable index (204 ns, 157 into an `EUDArray`) are next.

### A view put together only when it changes (2026-10-18)

The cheaper lowering's showpiece check left Snake at 1.7 ms a frame, 1.2 of it under its `ui.lines` line. `views.ts`
already put a view together again only after a write to what it reads, but it gave up on a view that called a
function of the script's own and put that view together every frame: a call might read the game. Snake's view calls
`thousands()` twice, and a function called twice is kept as one rather than written out where it is called (a view
calling it once was followed, which is what hid this). In the simulator Snake's HUD was shown on 60 of 60 frames.

- **A call is followed into the function**: what the function reads of the program is what the view reads, its
  parameters and its own variables aside; a function that reads the game still makes the view one that does
  (`readsOf` with the program's functions, each worked out once, one that calls itself adding nothing while it is
  being worked out).
- **Shown again from the text it last put together.** The once-a-second showing, before the game's lines fade, put
  the view together again "in case". A followed view changes only when its flag is set, and a view that reads the
  game sets its flag every frame anyway, so the showing now prints the buffer as it is; counting the lines to fill
  moved into the putting together. In the lifted game the showing costs 6.9 thousand records, the putting together
  and showing 24 thousand, for a one-line view of two numbers.
- **Snake: 1.69 → 0.05 ms a frame on average** (900 frames weighed in the lifted game). What is left of it is the
  screen's `present()`, about 83 thousand records every move: it walks all the screen's pixels to find the changed
  ones.
- `probes/game-ui.tsx` checks the view in the game and the simulator; `tests/ui.test.ts` that a view calling kept
  functions is followed, and that one whose function reads the game is not. The lifted game does not tell a line
  shown again unchanged from the one before it, so the probe reads the texts in order with repeats taken out.

Found on the way: a line's cost in A4 takes in the eudplib work that runs after it with no line of its own (its
functions, its variables), so a task that runs every frame collects whatever follows it. `scripts/weigh-map.mts
--by-origin` weighs by each trigger's own origin instead, eudplib's functions among them, which is what showed that
the per-frame work was number-to-text and text functions.

### present() and arrays filled (2026-10-18)

What was left of Snake after the view was the screen's `present()`, which walked every pixel to find the changed ones
(about 83 thousand records a move). Drawing now lists each pixel it changes, with its place, through one private
`put()`; `present()` goes over the list and passes over a pixel drawn and drawn back, and falls back to every pixel
when more was drawn than the list holds (2 048). `new Array(n).fill(v)` on an array of cells wrote a cell at a time,
each working its address out a bit a trigger (~250 ns); `varray_fill` writes eight a trigger at addresses that move
on by themselves (~23 ns). Snake: 0.05 → 0.03 ms a frame, its first frame 7.58 → 4.61 ms.

### Fixed numbers, shifts, products by a constant, signed comparisons (2026-10-18)

Nanoseconds a turn on the bench, before → after:

| Line | Before | After |
| --- | ---: | ---: |
| `fr = fa * fb` (fixed) | 5 801 | 4 698 |
| `fr = fa / fb` | 8 976 | 7 384 |
| `Math.sqrt(fa)` | 15 218 | 10 130 |
| `fa * 3` | 1 697 | 569 |
| `Math.floor(fa)` | 518 | 252 |
| `z >> 2` | 695 | 308 |
| `y << 5` | 505 | 462 |
| `y < z`, both signed | 318 | 243 |
| `fa < fb` | 272 | 207 |
| `y * 12` (y is 3) | 555 | 597 |

- **Signed comparison of two variables**: `a < b` read from 0 up, turned over once for each side below zero, counted
  into a variable whose low bit is the answer (`signed_order`); no addition of 2^31 a side.
- **Shifts by a constant** (`shift_const`): a bit tested a trigger, its place in the result added; from the top, a
  group of eight bits none of which is set is jumped over; a short shift left is doublings.
- **A product by a constant**: eudplib's product goes over its first operand's bits and stops past the highest set,
  so the smaller of the two goes first, the constant by its distance from 0, the result negated after. It costs a
  comparison more when the variable was already the smaller (`y * 12` above), and saves most when it is large or
  below zero (`fa * 3`).
- **fmul**: the 16-bit halves are a masked copy and a shift, not divisions by 65 536; the products have their
  smaller side first.
- **fdiv** (`chain_fdiv`), for a divisor below 256.0: eudplib's division chain set up once and run for the whole part
  and twice more for eight bits of the fraction each; the same digits as the sixteen steps it replaces, which stay for
  larger divisors.
- **sqrt**: the input's bits read where they are instead of doubling it twice a step, and the fixed root kept as four
  times itself so a step's trial is one comparison.
- `probes/game-math.ts` checks every one of these over values the game gives (below zero, tiny, past the fixed range,
  divisors on both sides of 256, equal values) against the simulator's answers, in the lifted game.

The raycaster: 1.55 → 1.30 ms a frame on average, its costliest frame 3.09 → 2.58 ms (1.66 and 3.31 before the
cheaper lowering). A fixed product and quotient are still several microseconds: eudplib's own product and division
are the floor under them, and the raycaster does a few of each a column.

### A loop over units costs what the map holds (2026-10-18)

A loop over units, and a pick, walked the 1 700 places of the unit table every time: about 135 ns a place, 229 µs a
loop whatever the map held. Two ways to make it the units' cost were tried.

- **The players' lists**, built first: each player's list holds every unit of theirs from its making to its kill
  (those in transports, buildings and training, and subunits — what the table's walk found), latest first. In the game
  it ordered the units as the simulator could, but a step along a list reads a pointer, which eudplib does a bit at a
  time (`f_cunitepdread_epd`, about 82 records), and the step came to about 175 records a unit: better than the table
  only under about 100 units. Dropped.
- **The table, walked as the game hands its places out, stopping once every unit in use has been met** — as built.
  The game takes slot 0 first, then 1699 downwards, and a freed place goes in behind the next one handed out
  (scm-sim docs/specs/unit-lists.md, section 3), so the places in use lie at the top. The walk is slot 0, then 1699
  down, counting each place with a sprite against the count of records in use (0x6283F0), and stops at it. In a
  12 000-frame game of four in the lifted game, there were never more places with a sprite than records in use, and
  on one frame one fewer (a record in use whose sprite had gone): then the walk goes to the end, slower and still
  right. The order is the units oldest first, until a place freed is handed out again.
- **The simulator** hands places out the game's way (`World.free`), and its loops go oldest first (`World.living`): the
  game's order as long as no freed place has been handed out again. When the game frees a record, some frames after
  its unit is gone, is not something the simulator knows; a test that depends on the order of units made after
  others died can find the game's different. (The table's walk from slot 0 up differed from the simulator even
  without that.)
- **Cost**: the bench's loop 229 → 29 µs a frame; a loop over all 182 units of a map 34 µs, over 238 units 48 µs —
  about 0.2 µs a unit, the old cost only with the table nearly full. The units probe's costliest frame 1.48 → 1.08 ms.
- `probes/game-unit-order.ts` checks the order, a unit given away, a unit killed in the loop (its own and the next)
  and a unit made in it, in the game and the simulator. The guide, the README, the IR reference and the editor's
  *scans units* note say the order and the cost.

### What is next: arrays at their cost, cost in the language, the explorer (2026-10-18)

After the five cost slices the showpieces are well inside a frame: in the lifted game, weighed for Remastered, Snake
costs 0.04 ms a frame (4.5 ms on its first, the screen cleared and shown whole), Tetris 0.34 ms (8.4 ms on its first,
the view put together from nothing), the raycaster 1.30 ms (2.6 at the most). What a map that is heavy *because of
its data* pays was not yet weighed, so `probes/bullets-bench.ts` was written: 200 bullets in an array that grows,
each a record of five numbers, moved, bounced and aged every frame, nothing drawn.

| Line (a bullet) | ns | Records |
| --- | ---: | ---: |
| `b.x += b.dx` | 2 730 | 190 |
| `if (b.x >= 4000) b.dx = -3` | 1 185 | 83 |
| `if (b.life > 0) { b.life--; alive++; }` | 2 830 | 197 |

About 12 µs a bullet a frame, 2.4 ms for 200: the bookkeeping alone, before a bullet is drawn. The bench says why
(`probes/lowering-bench.ts` gained the lines):

| Line | ns | Records |
| --- | ---: | ---: |
| `x = cells[k]`, an array of a fixed length (cells of their own, #24) | 376 | 27 |
| `x = list[k]`, an array that grows | 1 128 | 78 |
| `list[k] = y` | 450 | 31 |
| `x = pts[j].x`, a field of an instance in an array | 340 | 24 |
| `for (const v of list) x += v`, a turn | 1 417 | 98 |

An array that grows (`const bullets: Bullet[] = []` and `push`, the way TypeScript is written) lives on the heap,
four bytes a cell, which the game can only read a bit at a time: 32 triggers a read, and a bounds check (a comparison
of two variables, 10 triggers) before each. A record in such an array is a growing array a field, so a bullet's line
reads two or three of them. Cells of their own (an EUDVArray, 72 bytes each, a variable the game jumps to) are read
by a jump worked out a bit of the index at a time, as many triggers as the index has bits, and written the same way.

**So the slice is, in order:**
1. **An index worked out once.** A cell's place is 72 × the index bytes past the first; a read or a write works that
   product out a bit at a time, for every access. A variable used as an index whose every assignment is a constant
   or a constant added (a loop's counter, `for…of`'s own) can carry the product beside it, kept by the same additions
   (`i++` is `off += 72`), and every read and write at it becomes the array's place plus the product: a few triggers
   whatever the length, and the same product serves every column of a record and every array the loop reads.
2. **Arrays that grow, in cells of their own.** A second heap for growing arrays of numbers (and the columns of
   records), its cells EUDVArray cells; texts stay on the heap of bytes, which their copies need. With 1, a read at a
   loop's index costs what a fixed array's does. Its size is a script setting beside the heap's, and each cell costs
   the map 72 bytes, so the setting says it.
3. **No bounds check at a `for…of`'s own index**, when the loop's body neither shortens the array nor calls what
   might: the loop has just compared the index with the length.
4. **`over(list, { per })`** in `trigscript/timers`: `for await (const b of over(bullets, { per: 50 }))`, a loop
   spread over frames, `per` elements a frame; `spread(n, { per })` the same over 0 … n − 1. Written as an async
   generator it compiles today; the library gives it a name, and A4's hint on a costly loop says the `per` that keeps
   it under a millisecond, from what a turn cost in the run.

**Weighed and set aside:**
- *Fields packed into one cell* (`bits<N>`). A field of an instance in an array is 340 ns to read; taking a field
  out of a packed cell is a shift right, about 300 ns for a byte, so two packed fields cost what two cells do. `u8`
  and `u16` already narrow what a store keeps. Only adding to several fields at once (four counters in a cell, one
  add) gains, and nothing written so far wants it.
- *A whole frame's start worked out when built*: Snake's and Tetris's first frames are the screen and the view
  made from nothing, inside the budget; the view's static parts could be made when built, later.

**After this slice, offered:** fast cells (a probe of Set Resources and Set Score for the neutral players against Set
Deaths, which Remastered sends through the emulator's region lookup); a division whose result is small worked out
as comparisons against thresholds computed when built (the raycaster's `Math.floor(HEIGHT / distance)`, 7 µs a
column, would be seven comparisons); the compiler explorer (the script beside its triggers, nanoseconds a line, from
the trigger map and A4's weights) and quick fixes from the cost hint; budgets in tests (`expect(frame).toCostUnder(ms(2))`);
the desync fuzzer, which waited for B5; per-unit behaviours over B2 and B9; then the language list above
(`g.next()`, `using`, texts made in the game) and the 4.0 release.

**As built (2026-10-18).** Steps 1–4; no IR change (still 24). Measured with the bench and `probes/bullets-bench.ts`
before and after, in the lifted game, weighed for Remastered.

- *Arrays that grow, in cells of their own* (`list_heap` in `python/trigscript.py`). Blocks are handed out exactly as
  before — the same allocator, the same count — so a text and an array still run out at the same push in the game and
  in the simulator, and the heap setting means what it did. What changed is where an array's cells are: an EUDVArray as
  long as the heap, made only when some array grows, beside the bytes texts keep. A block moving on a push is copied a
  cell at a time, both blocks walked by address (about 7 triggers a cell, where reading and writing at an index was 40).
  Costs: 72 bytes a cell while the map is played (1.2 MB at the default 16 384 cells; the Settings line says so), about
  22 KB of the saved file, which compresses the cells away. Past 65 536 heap cells (`CELL_HEAP_MOST`; the setting goes to
  a million) that would be too much memory, and arrays keep the heap's dwords as in 3.x: the probes pass both ways.
- *An index worked out once* (`Place`, `find_counters`). A number variable whose every store is a constant or itself
  plus or minus a constant, named nowhere else but in reads (not a call's result, not a function's saved frame, not a
  loop's own variable), and which indexes an array of cells, keeps two offsets beside it (72 bytes and 18 dwords a
  step) by the same stores: `i++` is one trigger with two adds more. A read at it is a jump to the array's first cell
  plus the offset (the offset's variable adds itself into its own next pointer); a write a Set Deaths whose
  destination is the first cell's plus the offset. A growing array keeps where its block starts, again when it moves.
  Per-player programs' variables are rows, and are left as they were.
- *No bounds check at a loop's own index* (`unchecked_loop`). For `for (…; i < xs.length; …)` at a counter, over a
  growing array, whose body has nothing that changes a length, calls, or waits (`lengths_fixed_in`), and stores nothing
  into `i`: a read or write of `xs[i]` is unchecked — the condition has just compared — and every other growing array
  the body reads or writes at `i` is checked once on the way in, its length against `xs`'s, into a flag the access
  tests instead of comparing two variables (a shorter array goes the checked way, so `b[i]` past `b`'s end still reads
  0 and a store at its length still pushes). A store at the index into the loop's own array cannot be a push there.
- *A push with room* is a write at where the next one goes, kept beside the block, and two adds; a push with none calls
  one function of the array's own (the heap's grow, the handle put back, the next place worked out again). Inlined
  whole at each push, a script that pushes in a loop the compiler unrolls came out 1.9 MB bigger; as a function, 0.3.
- *`over` and `spread`* in `trigscript/timers`, as async generators: the elements are the list's own, the length read
  as it goes, the next frame only between elements. The cost hint does not yet say a `per`: that wants a loop's turns a
  frame, and the cost tap counts by line.

| Line | Before | After |
| --- | ---: | ---: |
| `x = list[k]`, any index | 1 128 ns | 749 |
| `list[k] = y`, any index | 450 | 639 (the place worked out a bit at a time over 14 bits, where the heap's dword was 2 triggers) |
| a turn of `for (const v of list) x += v` | 1 417 | 564 |
| a turn of `for (let i = 0; i < m; i++) list[i] = y` (not the list's length: checked) | 829 | 625 |
| a turn of `for (let i = 0; i < m; i++) x += cells[i]`, 16 cells | 566 | 462 |
| a turn of `for (let i = 0; i < m; i++) cells[i] = y`, 16 cells | 394 | 404 (four bits of index were cheaper than the place's two variables; at 2 048 cells it is eleven) |
| bullets: `b.x += b.dx` | 2 730 | 410 |
| bullets: `if (b.life > 0) { b.life--; alive++; }` | 2 830 | 530 |
| bullets: 200 a frame, the loop | 2.38 ms | 0.44 ms |
| bullets: the frame that makes them (1 000 pushes) | 2.93 ms | 1.09 ms |
| bullets: the costliest frame | 6.60 ms | 3.26 ms |

`probes/game-arrays-cost.ts` (7 tests) checks every path in the game and the simulator: pushes past several block
sizes, other arrays read at a loop's index shorter and longer, loops that push and pop, `+=` in place, records in a
growing array, a counter counting down, an array declared again on each turn of a loop, shortened, and booleans;
`probes/game-stdlib-core.ts` gained `over` and `spread`.

**Left:** a write at an index that is not a counter (above); a counter in a per-player program; the hint's `per`.

### A division whose result is small, as comparisons (2026-10-18)

`Math.min(H, Math.floor(C / x))` — the raycaster's wall height, a bar's length from a distance — divides by a
variable, which the game does a bit at a time: 7.2 µs for a fixed quotient, 7.3 for a whole one. For `x` above zero
the quotient only falls as `x` grows and the `min` caps it, so the result is the largest `h` of 0 … H with
`x ≤ T(h)`: a tree of comparisons with constants, as deep as H has bits. `compiler/thresholds.ts`, called from the
final pass of `numbers.ts` on a `min` of a constant (1 … 256) and `fdiv(C, x) >> 16` (Math.floor), `(fdiv(C, x) + c) >> 16`
(Math.round, Math.ceil) or a whole `C / x`, `C` above zero and `x` a variable. No IR change: the tree is `ternary` and
`compare`.

- *Exact.* The thresholds are found with `fixedMath.ts` — the arithmetic the game does, which the simulator shares —
  and each is checked on both sides when built. Near zero `C × 65 536 / x` passes 31 bits and the game's quotient
  wraps (78 / 0.0023 is −31 683 in the game), so below the first `x` where it cannot (156 raw for 78), and at or below
  zero, the division is kept, behind one signed comparison. Past it, the tree's comparisons read `x` from 0 up: one
  condition each.
- *Cost* (the bench): `Math.min(78, Math.floor(78 / fa))` 7 213 → 805 ns; `Math.min(40, 1000 / y)` 7 335 → 786. The
  raycaster 1.30 → 1.15 ms a frame (peak 2.58 → 2.27), its height line out of the top ten.
- *Checked:* `tests/thresholds.test.ts` holds six shapes' trees against the division at every threshold's two sides,
  around zero and the wrap, and 20 000 divisors at random; `probes/game-thresholds.ts` prints each beside the division
  worked out without a `min` (`q < H ? q : H`), equal in the game and the simulator; the raycaster's tests pass on its
  board (they need the 128-wide map, `fixtures/eud/raycaster-base.scx`: on test-game's default 96-wide map the last ten
  columns are off the map, which once looked like a fault).

### Fast cells, the probe (2026-10-18, played the same day)

`probes/fast-cells.py` + `.ts`: the weights probe's schedule and marks (so `profile.py` and `profile_report.py` read it
unchanged) with its own mixes — the yardsticks again (`loop` first, act64, act1, cond16, switch64), then Set Resources
(ore, gas, a number set), Set Score (custom) on Player 9–12, Accumulate and Score conditions on them, Switch
conditions, and Player 1's own custom score (action and condition). Before the schedule it sets the cells and reads
them back by condition and through memory, on the screen. Map and answer sheet in `Maps/TrigScript/trigscript-fast-cells*`;
the lifted count of a PHASE=4 build in `fixtures/eud/fast-cells-short-cost.json`, the table beside it.

**The lifted game already says something:** 1.16.1 ignores Set Resources and Set Score for Player 9–12 (every value
reads back 0, by condition and in memory), as its Create Unit refuses those players; Player 1's and Player 8's custom
score read back right. Remastered allows Create Unit for them, so the played run decides; the fallback is the players'
own custom score, which nothing shows without a leaderboard.

**What it would give the language** (if they are as cheap as a switch, 3.2 ns against Set Deaths' 9.7): a counter or a
flag kept in such a cell is set, added to and compared with a constant without the emulator; a copy into one is a Set
Resources whose number a variable writes (the copy itself is a Set Deaths into the action). There is no copy out
short of reading it a bit at a time, so only what is compared with constants belongs there: loop counters against a
constant bound, states, countdowns.

**Played 2026-10-18** (single player, Fastest, the 7900X; `cells1/`; `profile_report.py` against the PHASE=4 lifted
count). No phase slowed: every one held 42 ms a frame at 800 thousand records. Nanoseconds a record:

| Mix | ns | Yardstick |
| --- | ---: | --- |
| Set Resources, ore / gas of P9–12, add | 4.19 / 3.68 | Set Deaths (act64) 9.47 |
| Set Resources, ore set to a number | 3.69 | |
| Set Score, custom, P9–12 / Player 1 | 3.84 / 4.16 | |
| Accumulate / Score (custom), P9–12 | 3.81 / 3.74 | Deaths condition (cond16) 6.20 |
| Score, Player 1's custom | 3.69 | |
| Switch condition / Set Switch | 3.01 / 3.31 | |

Derived again from act1 and act64: a trigger 8.27 ns (8.6 before), Set Deaths 9.34 (9.7), a Deaths condition 5.69
(4.8). So the tables outside the emulator are about 2.5 times cheaper an action and 1.6 times a condition — and the
neutral players' cost the same as Player 1's, whose custom score certainly holds (whether Remastered keeps the
neutral players' values was the screen's line, not in the profile).

**Set aside.** A trigger costs 8.6 ns before its records, and the lowering's statements are triggers: a counter's
`i++` kept in a custom score is 12.4 ns where it is 18.3, its comparison with a constant 3.7 where it is 4.8 — about 7
ns of a 181 ns loop turn, 4%, for at most twelve cells (eight if Remastered too refuses Players 9–12). Not worth a
second kind of variable. What the run did give: A4's weights for actions and conditions outside the emulator, which
were Set Switch's and a guess — `otherAction` 3.8, `otherCondition` 3.6 (was 4.8, a Deaths condition's) — so a
script's `trigger()` records and the classic backend's resources, scores and switches weigh what they cost.

## Part C — the game, pushed

Each is a library over Part B, offered only after its probe. "Known" means a played probe
already says so.

| Idea | What it needs | Known |
| --- | --- | --- |
| Terrain as a framebuffer | tile buffer writes | **No.** Magenta 10: Remastered does not draw them. Dropped. (My first answer on 2026-10-15 proposed it; that was wrong.) |
| Fog of war as a framebuffer | the vision countdown `0x51CE98`, sight writes, Map Revealers made and removed in one pass | **Yes**: S4, Bad Apple played in Remastered (2026-10-17) |
| A raycaster in the fog | B6, `fog.columns` | in the lifted game and the simulator (S5, 2026-10-17); Remastered is the probe |
| Units moved freely every frame (bullet hell, orbits) | location + Move Unit, B6 for the paths | position writes end the game (Magenta 6); moving by action is ordinary, so the probe is how many a frame before it lags (A4's dial) |
| Panels of text: objectives, leaderboard label, unit names as live UI | made texts in those fields | **Yes**, the strings spike (2026-09-19): re-read every draw, written only on the target's machine |
| Custom command buttons | button set data in memory | unknown: probe |
| Custom spells | B2's `on.order`, Magenta's damage/heal verb | partly: the verb is verified, the order watch is not |
| Save codes | strings, a checksum, `chatted()` | needs no new address; a probe for the round trip |
| Unit stats changed while the game runs | the type tables | Magenta-verified fields only |
| Computer players written in TrigScript | B1 tasks, unit orders through the scratch-box trick | the trick is verified (Magenta); a behaviour library is new |
| Camera work for one player | `centerView`, B5 | ordinary actions; B5 makes them safe |

## Showpieces

Added 2026-10-16, after Part A was built. Part A is tooling: it makes TrigScript right, and
a map maker sees little of it. What a map maker sees is what a map can do. So Part B is
steered by three demonstration maps, each a map someone would want to play, each built
from the slices it needs, in the order those slices come. A slice that no showpiece needs
waits behind one that does. Each showpiece is also a test: it runs in the lifted game
(A2) and in several copies (A3), its cost per frame is under the budget (A4), and it is
played in Remastered before it is shown to anyone.

### S1. Act out a cutscene

The map maker plays the scene in the editor's game: moves the units, sends them into the
fight, places the camera. TrigScript writes the script that plays it back.

```ts
// Written by Record Scene, 0:42 of play, 3 players' units, 61 orders.
export async function ambush() {
  centerView(locations.Ridge);
  order(group.raiders, "move", locations.Ford);
  await sleep(frames(96));
  order(group.raiders, "attack", locations.Camp);
  …
}
```

- **The recording** is scm-sim's: the person plays the map in the Replay view's game, and
  every command they give is a replay command with its frame. A cutscene is a replay of
  the person's own play.
- **Writing it back:** a trigger cannot give every command a player can. What it can give
  is the game's Order (move, patrol, attack) to a location, through the scratch-location
  trick Magenta verified, plus Create Unit, Center View and the transmission. A recorded
  command becomes the nearest of those; the rest (a spell, a build) are said at their
  line and left out. Units are named by groups the recorder makes (`group.raiders`), which
  are units found by type, owner and place when the scene starts.
- **Checking it:** the written script runs in the lifted game and the units' places are
  compared with the recording, frame by frame. The script will not match exactly (an order
  through a trigger lands on a trigger pass, a player's command on its turn), so the
  comparison has a tolerance, and the view shows where the two part.
- **Needs:** B1 (the script is an `async` function), B2 for "when the raiders arrive", and
  scm-sim's view taking commands from the editor (it plays the person's own copy: rendering,
  so the StarEdit rule applies).
- **Probe:** none of its own for the playback (only ordinary actions). Its probe is the
  scene played in Remastered beside the recording.

### S2. A live interface in the game's text

The objectives panel, the leaderboard's label and a unit type's name are re-read every
time the game draws them, and a made text can be written into them for one player (the
strings spike, 2026-09-19). That is a screen. S2 gives it a TypeScript way to be drawn:
JSX.

```tsx
ui.objectives(P1, () => (
  <panel>
    <line color="yellow">Wave {wave} of 10</line>
    <bar value={baseHp} max={1500} width={20} />
    {heroes.map((h) => <line>{h.name}: {h.kills} kills</line>)}
  </panel>
));
```

- **The compiler** reads the script as TSX. An element is a text built from its children;
  `<bar>` is characters in colour codes; `color` is the game's colour codes. Nothing of
  React runs in the game: the tree is lowered to a template (IR `template`), known parts at
  build time and the rest as values.
- **Redrawn when it changes:** the function is a reactive view. The compiler knows which
  variables it reads, and the lowering rewrites the text only on a frame when one of them
  changed, so a panel that is not changing costs a comparison a frame.
- **Needs:** 3.9's texts (built), B3 for `map` with a callback over an array that grows,
  and the made-text field writes (built). No new address.
- **Probe:** one, for how many characters and colour codes a panel holds before the game
  cuts it, and whether a rewrite every frame flickers.
- **Where it draws, first** (2026-10-16, started on S2 with a Tetris map as its target):
  the objectives panel is read again on every draw, but it is a dialog the player opens,
  and in a single-player game opening it may pause the game. A board the player watches
  while playing may belong in the text lines instead, which Remastered's emulator lets a
  map write (`0x640B60`, 13 lines of 218 bytes; the line pointer at `0x640B58` is kept
  beside the game). So the probe asks where before it asks how much:
  `probes/ui-spike.py` (hand-written eudplib, built beside `probes/ui-spike.ts`), steps
  A–I: how many text lines stay up, which cell characters line up (■ □ █ ▀ ▄ ░ ▓ ㅁ, a
  full-width space and more), which colour codes colour a cell, how many cells fit on a
  line, whether a line break in one Display Text makes several lines, a board redrawn every
  frame and every fourth frame, twenty rows in ten lines with half blocks, the lines'
  memory written with no action, a 22-row board in the open objectives with a clock in the
  leaderboard's label, and how much of that label shows. Run in the lifted game first: no
  address Remastered ends the game on, about 2.4k actions a frame on average and 82k at
  most (eudplib's start at frame 2). Copied to
  `Maps/TrigScript/trigscript-s2-ui-spike.scx`.

  **Played 2026-10-16** (A–G single player, H again hosted as multiplayer; Remastered at
  2560×1440, the bars measured in the screenshots):
  - **The board goes in the text lines.** 11 stay up (a header and ten rows). One Display
    Text with line breaks makes as many lines (E), so a board is one action. Redrawn every
    frame it neither flickers nor tears, and every fourth frame looks the same (F1, F2).
    Sixty cells still fit on one line (D).
  - **The lines are drawn from their memory, live** (G): text written into `0x640B60` with
    no action appeared and counted. But each line still fades on its own timer; a write
    changes the words, not how long the line stays. A Display Text restarts a line's timer.
  - **The objectives panel is out for anything live** (H): it pauses a single-player game,
    and in multiplayer the open panel is a picture taken when it opened (it said second 128
    at 137 and 146). It shows nine lines; past them the line breaks are lost and the rest
    runs together on one line. It is fine for a static text.
  - **The leaderboard's label** shows about 23 characters, then "..." (I). Live, as the
    strings spike found: a score or a level, not a board.
  - **Cells:** ■ □ ● are one width; ㅁ, the full-width space, Ｏ and ▒ are another (wider).
    █ ▀ ▄ ░ ▓ ▌ ▐ Ⅰ are not in the font and come out as narrow boxes, so half blocks are
    dead. Colour codes take no width.
  - **Colours:** 02 03 04 07 08 0E 0F 10 11 15 18 19 1B 1C 1D 1E 1F each draw a colour of
    their own (16 is 04's white; 01 takes the line's colour). **Grey sticks:** after 05,
    every later code on the line is ignored and the rest stays grey, so empty cells must not
    be grey. 06 was only seen after 05; a second round tests each code on a line of its own.

  **Second round played 2026-10-16** (`probes/ui-spike-2.*`): **only 05 sticks**; every
  other code lets later codes through, and 06 is red (as 08). A board made in the game and
  shown by one Display Text a frame draws right: orange piece, coloured stack. Empty cells:
  15 (brown) nearly vanishes over dirt, 18 (dark green) and 0E (blue) read on black, **1E
  (lavender) reads on black and over terrain and is no piece's colour**, so it is the
  default for an empty cell. How long a line lasts was not caught (under six seconds, from
  G), so a view that has not changed is still shown again once a second.

  So S2's first surface is `ui.lines(player, () => <…/>)`: the text lines, one Display
  Text a frame when the view's inputs changed (and again before the lines fade), ten rows
  under a header. The objectives and the label stay as plain made texts.

**As built (2026-10-16, IR 17).** JSX in a `.tsx` file (the entry may be `main.tsx`): the
compiler options say `jsx: react` with the factory `__jsx`, so TypeScript type-checks every
element against `JSX.IntrinsicElements` and a JSX expression is a `string`. The elements are
`<line color>` (a line of its own; a line break goes before each one but the first thing
written), `<span color>` (its colour comes back after it, lazily: the parent's next piece says
it again), `<cell color>` (■ in its colour; 0 or none is □ in lavender — a board's cell) and
`<bar value max width color>`. A colour is one of `textColors`' names (the codes the spike
measured) or a number of the program's. `{…}` is the program's value; `cond && …`, `?:` and
`.map((x, i) => …)` are its if and its loop — unrolled over a list the script has, so a board
drawn over `[...Array(10).keys()]` reads its cells at constant indices. Nothing in a text can
wait.

- **Lowering:** a JSX text is not a template. It has a buffer of its own (`buildText` writes
  parts at its end, `reset` empties it; `built` reads it), so a 100-cell board is written in
  place, never copied whole per piece. Parts gain `char`, a byte from a number. JSX is never
  hoisted (`hoist.ts#hasJsx`); outside a program `__jsx` makes the same text at build time
  (`compiler/jsx.ts`).
- **`ui.lines(player, () => …)`** is a task (`start`, one slot) that loops: built and printed
  when a flag says the view is stale or 24 frames after it was shown (the lines fade in under
  six seconds). `views.ts` declares the flag first in the program, finds what the view reads
  and sets the flag after every statement anywhere in the program that writes it. A view that
  reads the game is built every frame. It gives back the Task (`board.cancel()`).
- **Measured in the lifted game:** a static 10×10 board costs ~360 actions a frame when nothing
  changed, ~63k on a frame it is built and printed. Nothing Remastered refuses.
- **Found on the way:** the freeze check called `while (move(0, 1, 0)) {}` endless: a call in a
  loop's condition that writes what is outside it now counts as changing it. And, played
  (the user held D and the piece "moved in place"): **the Python lowering did not
  short-circuit `&&` / `||`** — every item's code ran before any was tested, so
  `keyPressed(P1, "W") && !move(0, 0, 1)` turned the piece every frame in the game and never
  in the simulator. Fixed (an item after the first that calls, pops or draws a random number is
  worked out inside the test of those before it); `probes/game-short-circuit.ts` fails on the
  old lowering in the lifted game and passes now. With it fixed, Tetris costs ~645 actions on
  a frame nothing moves, ~77k on one the board changes, 7.5k a frame on average.
- **Not yet:** components (`<Row />`: call a function in braces instead), `Array.from`, the
  per-cell cost (~600 actions: the colour byte and the glyph are copied in; a cell could be one
  dword), the editor's workspace knowing `.tsx`, guide and README (wait for 4.0).

**Held keys, played 2026-10-16** (`probes/key-held.tsx`, Remastered): a key held down reaches
the game on every frame it is down — the strip stays solid — and a tap is two or three frames
of it, counted as one press by `keyPressed` (MSQC's KeyDown since `b09f04d`). So `keyHeld()`
(MSQC's KeyPress, sent each frame) works today, for every player, through the same path as a
press: S3's movement needs no `Local<T>` and no `sync()`. Magenta probe 7's "one event a press,
no key-up" was its own setup; R0's `GetKeyState` reading agrees with what was played.

**Pixels made of units, played 2026-10-16** (`probes/unit-pixels.ts`, steps A–D; E not yet
reported). A board can be drawn with units on the map and the minimap:
- **Colours:** nine Overlords, P1 … P8 and P12, show nine colours on the minimap once the board
  is in sight (your own units are green there). Player 2 is a computer and its AI moved its
  Overlord a cell, so a board's owners are P1 and the empty slots P3 … P8 (P12 too: Remastered
  made it, the lifted game did not).
- **Vision:** Map Revealers of Player 1's lift the fog over the board. The lifted game never
  makes a Map Revealer — a gap in scm-sim, not the game.
- **The minimap merges neighbours:** units 64 pixels apart and of one owner join into one block,
  so a piece reads as a solid shape.
- **Overlords** sit on their cells on any ground. Science Vessels are wider than a cell and
  zigzag; Pylons, Flags and small items miss cells where the ground will not take them, and
  **Remastered prints "WARNING: Unit unplaceable! (Protoss Pylon) (1024,2304)" in the text lines
  for every Create Unit that fails** — so a unit board must never ask for a cell it cannot have,
  or it scribbles over a text board beside it.

### S3. A hero moved with the keys

W A S D move a hero, the mouse aims, a key casts. The map plays as an action game.

```ts
on.key("W", (p) => heroOf(p).order("move", ahead(heroOf(p), 64)));
const aim = await sync(localMouse());          // Local<Point> → Point, the same on every machine
```

- **Keys held:** Magenta 7 found that Remastered sends one event a press and no key-up, so
  "held" does not reach other machines today. R0 found that the keyboard region of
  Remastered's emulator calls `GetKeyState`: reading it gives the key's state on the local
  machine, now. That is a `Local<boolean>` (B5), and `sync()` makes it shared a few frames
  later.
- **Movement** is a location centred ahead of the hero and Order to it (positions are never
  written; Magenta 6 and R0). B6 gives the directions and distances.
- **Checking it:** A3 runs the map in two copies with keys held on one, and the copies must
  stay the same. That is the whole point of B5's type, shown working.
- **Needs:** B2 (`on.key`), B5 (`Local`, `sync`), B6 (directions).
- **Probe:** the first, before B5 is built: hold a key and read the keyboard region every
  frame in Remastered; then the same in a two-person game, to see each machine reads only
  its own.

### S4. Bad Apple

Added 2026-10-17. The shadow-play music video drawn by the game while the song plays, as the
renderer showpiece before a raycaster. It asks the questions a renderer has to answer —
where the game can draw, how fine, how much a frame costs — on a video that is mostly the
same from one frame to the next. A raycaster is the opposite (every column changes when the
player turns), so whatever S4 builds has to be cheap for a whole new frame too, and S4's
scene cuts are where that is measured.

**Where it draws.** Three surfaces, best first:

| Surface | Resolution | Known |
| --- | --- | --- |
| Fog of war, on the minimap | 128 × 96 on a 128 × 96 map, one tile a minimap pixel | works in the lifted game (below); Remastered's drawing of it is the probe |
| Units as pixels, on the minimap | ~40 × 30 filled (the 1,700-unit limit) | S2's unit-pixel probe; grey levels if Remastered's minimap takes custom colours (unknown) |
| Glyphs in the text lines | 11 rows × ~60 cells | S2, played; which glyphs exist is read from Remastered's font (below) |

#### Fog of war as a framebuffer

Found 2026-10-17 in the 1.16.1 decompile, OpenBW and the lifted game:

- **How the game keeps fog.** Each tile has a byte of "visible" bits and a byte of
  "explored" bits, a bit a player. A unit reveals at once when it is made or moves
  (`refresh_unit_vision`), and revealing only ever adds: nothing turns a tile dark again
  except a wipe. The wipe is in the frame step (`0x4D94B0`): a countdown at **`0x51CE98`**
  goes 100 → 0, and at 0 every tile's visible bits are cleared (`0x480880`) and every unit
  reveals again. Optical Flare sets the countdown to 1, so the game itself already
  asks for a wipe on the next frame.
- **Remastered's emulator allows `0x51CE98` both ways** (`data/remastered.json`, from R0),
  and units.dat's sight range (`0x663238`) both ways too; `stats(t).sight` is already in
  the language, played by Magenta.
- **The order of a frame** (`0x4D9670`): the frame step (countdown, wipe, units reveal)
  runs before the triggers, and the screen is drawn after both.

So a frame of video is painted like this, in one trigger pass:

1. for each brush: set the revealer's sight, centre a location on the brush, Create Unit a
   Map Revealer there (it reveals at once), Remove Unit it;
2. write 1 to the countdown.

The revealed tiles stay visible through the draw with no unit left on the map. The next
frame's step wipes them before the triggers paint the next picture, so nothing ghosts.
Tiles revealed once stay *explored*, so the picture is three-toned: never seen (black),
fog (dark) and visible (bright). The video opens on black, which is the never-seen board.

**Run in the lifted game** (`fog-spike`, scratch harness, 2026-10-17): the countdown is
seen at 99 … 0 every 100 frames untouched; written to 1, the next frame wipes. With two
brushes a frame (sight 2 and 4, the sight byte changed between the two Create Units) and
the positions alternating, every frame shows exactly that frame's two brushes visible and
the last frame's as fog. No ghost, no unit left alive.

**The brushes are the game's sight masks.** A Map Revealer is a flyer (units.dat flag
`0x4`), and air sight takes a path of its own (`reveal_sight_at`, in the air branch): it
leaves out the 3 × 3 core, so **sight 0 reveals nothing**, and every mask is a little
lopsided (one row more above the centre than below). Measured, in tiles: sight 1 = 3 × 4
(12), 2 = 28, 3 = 52, … 11 = 480. A ground unit's sight 0 is a plain 3 × 3, but ground
sight is cut by higher ground, and a revealer made ground (its flyer flag cleared before it
is made; `0x664080` is allowed) is untried.

**What a frame costs, worked out on test pictures** (128 × 96, greedy cover of the visible
pixels with masks that never touch a dark one):

| Picture | Brushes | Missed |
| --- | --- | --- |
| A dancer, black on white | 140 | 0.3% |
| An apple, black on white | 83 | 0.5% |
| "Bad Apple" in type | 143 | 0.5% |
| The dancer, white on black | 88 | 10% |

With five sight values (1, 2, 4, 8, 11) instead of all eleven it takes about 5% more
brushes. Thin *dark* detail is kept (fog fills the gaps between brushes: fingers 3 pixels
wide came out), thin *bright* detail under three tiles is lost. Bad Apple is mostly dark
figures on white, the case this surface draws best. For the white-on-dark scenes the
encoder may cover a few dark pixels next to a thin bright line, so it is drawn a pixel
too thick rather than not at all.

Every frame is drawn whole, so there is no diff to keep and a scene cut costs what any
frame costs. At ~150 brushes and some ten actions each (location, create, remove, a sight
write when the size changes), a frame is a few thousand actions against A4's budget of
500k. The data is ~3 bytes a brush (x, y, size): at most ~2.4 MB for 3:39 at 23.8 frames
a second before using what frames share. How big a map Remastered loads is not known.

**Read in Remastered's own code** (the Ghidra project `scr12310-full` and the R0 emulator,
2026-10-17; offsets from the image base):
- **The countdown write reaches the game.** The emulator's region for `0x51CE98` is backed
  by a real variable at `+0x1067C0C` (it held 20 in the dump), and Remastered's frame step
  (`+0x31C610`) is 1.16.1's line for line: 100 → 0, the flag, the wipe (`+0x3606C0`, the
  same OR of 0xFF into every tile). Optical Flare's routine still sets it to 1. The sight
  table is backed at `+0xE5A860` (Marine 7, Ghost 9, Vulture 8, Goliath 8).
- **The minimap draws fog a tile at a time, at once** (`+0x361980`): each tile's visible
  and explored bits against the local player's masks pick one of the remap tables at
  `+0xAD0200` (never seen, fog, visible), and the terrain's minimap colours go through it
  into the picture. No blur, no fading: the minimap shows the bits as they are when it is
  drawn.
- **Fog is in the multiplayer checksum** (`+0x3A0FF0` hashes one row of the tile array a
  frame). Painting is the same on every machine, so this is safe; a fog write made on one
  machine only would desync.
- Not found: the code that builds the main view's fog. The shaders have no fog shader;
  `mask.glsl` (black, alpha from a texture's red) and `blur.glsl` (a five-tap Gaussian) are
  the likely pair, which would give the soft edges, but whether it fades over time is the
  probe's to see.

**Open, for a probe in Remastered:**
- how the main view draws fog that changes every frame: at once or faded (fading would blur
  motion), and how soft the edges are;
- how often the minimap is redrawn, and how the three tones look on snow (Ice) against dark
  ground;
- whether a created Map Revealer lands on the location's centre (Remastered makes them;
  1.16.1 refuses: `lifted-create-unit-findings`), and whether a sight write between two
  Create Units in one pass holds as in the lifted game;
- how many brushes a frame before the game stutters (the unit-pixel probe made 80 a frame
  with no slowdown);
- a revealer made as a ground unit, for the 3 × 3 brush.

**The probe, built 2026-10-17** (`probes/fog-probe.ts` + `probes/fog-probe.py`, made by
`probes/lib/fog-gen.mts` on a 128 × 96 snow map from `probes/lib/fog-base-map.mts`; copied
to `Maps/TrigScript/trigscript-s4-fog-probe.scx` with an answers sheet). Steps A–H: a brush
jumping with the countdown written (A) and not (B), the eleven sizes (C), a brush sliding a
tile a frame (D), four pictures (E), a 72-frame animation (F), the dancer painted 1, 2, 4
and 8 times a frame (G), ground revealers beside air ones (H).

Run first in the lifted game with Overlords for the revealers (1.16.1 keeps no Map Revealer
a trigger makes), the tile array read every frame against the encoder's own picture:
**0 tiles differ** in every picture, every animation frame and at 8 paints a frame. A brush
centred on the last two rows or columns is moved inward to fit the map, so the encoder keeps
centres two tiles from the edge (the dancer then misses 58 tiles instead of 27). Ground at
sight 0 is a 3 × 3 (9 tiles), at sight 1 21 tiles.

Cost (A4's tap, conditions + actions a frame): a picture of 84–143 brushes 25k–42k; the
animation 41k on average, 48k at most; 8 paints a frame (~1,100 brushes) 322k, still under
the 500k budget. About 300 a brush read from the table, most of it `f_dwbreak` unpacking
x, y and size from one dword: a table of pixel positions laid out ready to copy is the first
thing to make cheaper. `game-check`: 0 accesses Remastered ends the game on, 0 ignored, 0
never seen.

**Played 2026-10-17** (Remastered, hosted as multiplayer alone, recorded at 2560 × 1440;
frames taken out of the recording and set beside the encoder's pictures):
- **The countdown write works.** A: the brush's old place drops to fog the frame it jumps;
  B, with the write left out, both places stay lit until the game's own wipe.
- **A sight write reaches the game a frame late.** Every brush of a pass came out at the
  size written last in the pass before: the sizes row (C) was eleven blobs of sight 11, and
  the dancer (E) lost her arms and legs to brushes of the largest size. A and D, one size a
  frame, were right. So the size can't change within a pass: round 2 gives each size a unit
  type of its own (eleven flyers, none with a sight upgrade), each type's sight written to
  the same value every frame.
- **The minimap is blurred** in Remastered graphics: soft round blobs, not tiles. The
  routine read in the code (`+0x361980`, 2 × 2 pixels a tile) is likely the Classic path;
  round 2 is played in both.
- **On the screen** fog over snow is a soft, only slightly darker grey; the strong contrast
  is never-seen black against lit snow, which can be had only once per tile.
- **"Cannot create more units."** at 8 paints a frame (~1,100 made and removed): a removed
  unit keeps its slot until the next frame. The lifted game agrees (round 2: from 959 a
  frame, not at 822). A picture needs 84–160.
- **No slowdown** at any step: the step texts stay on the same offset from game time.

**Round 2** (`probes/fog-probe-2.*`, `probes/lib/fog-gen-2.mts`, copied to
`Maps/TrigScript/trigscript-s4-fog-probe-2.scx` with an answers sheet): A again, the sizes
as eleven types (C), the pictures (E), the animation (F), ground Map Revealers at sight 0
in steps of their own (H), and 3 to 10 paints a frame for the unit cap (I). In the lifted
game: 0 tiles differ in C, E and F; the dancer costs 32k a frame (41k with the sight byte
written per brush); `game-check` clean.

**Round 2 played 2026-10-17**, once in each graphics mode (both recorded, minimaps set side
by side frame for frame):
- **One unit type per size works.** The sizes row grows left to right in both modes, and the
  pictures keep their thin parts: the dancer has her hair, both arms, the fingers and both
  legs; "Bad Apple" reads as type.
- **Classic graphics draws the minimap a tile a pixel, sharp** (the `+0x361980` routine);
  Remastered graphics blurs the same picture by a few tiles. Classic is the one that makes
  the video. A map cannot choose the mode, so the map says so when it starts.
- **Ground revealers work in Remastered:** the Map Revealer with its flyer flag cleared, at
  sight 0, drew 3 × 3 squares beside the air brushes' 3 × 4. (The flag write took effect
  within the pass, unlike the sight write.) A twelfth, finer brush.
- **"Cannot create more units."** from 7 paints a frame (959 made and removed), not at 6
  (822) — Remastered and the lifted game agree to the step. A picture needs 84–160.
- **Never-seen black is a third tone that runs out.** The first picture over a board that
  earlier steps had partly lit came out a patchwork: black where nothing had been lit yet,
  fog grey where something had. A video has to light the whole board once first (or use
  the black on purpose, once), so every figure is the same fog grey.
- **The camera's box is drawn on the minimap**, over the picture. The video's map needs room
  off the board to park the camera: a 128 × 128 map with the board in the top 96 rows keeps
  the minimap at a tile a pixel and puts the box below the picture.
- On the main view, fog over snow is a slightly darker grey in both modes, soft-edged in
  Remastered. The main view is not where the picture is.

So the renderer is settled: twelve brushes (a ground 3 × 3 and eleven flyer sizes, each its
own unit type, sights set every frame), made and removed in one pass, the countdown written
after it, the board lit once before the first picture, watched in Classic graphics.

**The video, built 2026-10-17** (the user: fetch one, put the song in the map). The PV
(YouTube FtutLA63Cp8, 480 × 360, 219.1 s) taken to 5,216 frames at the game's own rate
(`fps=1000/42`, area-averaged to 128 × 96, threshold at half); `probes/lib/bad-apple-encode.mts`
(a binary heap over every placement of twelve brushes — the ground 3 × 3 and the eleven air
shapes — then a 3 × 3 on every light tile still dark, so a thin light line is drawn a tile
thick rather than lost): 166 s on 20 processes, **117 brushes a frame on average, 386 at
most**, 0.74% of tiles off from the threshold picture, a table of 2.45 MB (1.34 MB gzipped;
only 19% of brushes carry over from the frame before as they are). `bad-apple-map.mts`
(128 × 128 snow, the song in the archive), `bad-apple-gen.mts` (the eudplib: the board lit once
at frame 2, ten seconds to switch to Classic, the song and the video from frame 240). The
table goes in as a data file (`EXTRA_FILE` in `build-fixture.mts`): a plugin's source may hold
512 KB, data files 4 MB in all — a limit a built-in video import has to plan around.

In the lifted game: **all 5,216 frames on the board exactly as encoded**, nothing lit below
it; 27.7k actions a frame on average, 90k at most; `game-check` clean (618,861 accesses, none
Remastered refuses). Maps: OGG song 4.4 MB, an 8-bit WAV fallback 6.3 MB. Not known until
played: whether Remastered loads a map this size, plays OGG from a map, and keeps the song in
time with the frames.

**Played 2026-10-17: it works.** The OGG map loads, the song plays, and the video runs on
the Classic minimap from start to end (the user's recording, 2560 × 1440). Measured by
correlating the board's brightness in the recording with the source frames, and the
recording's sound with the source song, over the whole run and in 25-second windows:
the picture follows the source with a correlation of 0.998; **the picture leads the sound
by 23 ms**, the same in every window to within one recorded frame — no drift over 3½
minutes, no stutter. Left as it is (half a game frame, below notice).

The weak point is contrast: fog over snow against lit snow is about 100 against 140 on the
minimap. The minimap's fog colours come from a remap table (1.16.1 `0x59C2C0`, four 256-byte
tables by visible / explored state, read by `0x4A3A40`; Remastered `+0xAD0200`), but the table
lies outside every region Remastered's emulator maps (a read ends the game). So contrast comes
from the terrain: the tile whose lit and fogged minimap colours lie furthest apart.

**The terrain survey (2026-10-17).** For each tileset a map whose tiles are every distinct
megatile once (1,346–4,668 of them), loaded in the lifted game; each tile's minimap colour
read from the buffer at `0x59C190`, its colour in each state through the tables at
`0x59C2C0` (state = visible × 2 + explored), and the tileset's palette. Our snow: lit 156,
fog 96 (the recording agreed). The best: **Badlands tile 23778** (and the same white in
Jungle and Twilight) — **lit 255, fog 104, never seen 4**, 2.5 times the difference. A board
can be one tile repeated: the game draws the tile ids the map holds. The whitest tiles are
not ground a unit stands on, so that board is drawn with the air brushes only
(`BA_AIR_ONLY=1`): 119 brushes a frame, 1.17% of tiles off instead of 0.74% (thin lines a
little thicker). Fully walkable tiles top out at a difference of 95. Built as
`trigscript-s4-bad-apple-white.scx`; in the lifted game all 5,216 frames exact, `game-check`
clean. Not yet played.

#### Glyphs in the text lines

Read from the install through kascade (2026-10-17). The text lines' shapes come from
`font/bl.ttf` ("BlizzardGlobal", TrueType, 512 units an em), the only font in the install
that fits every played fact (■ □ ● one width, ㅁ U+3000 Ｏ ▒ another, █ ▀ ▄ ░ ▓ ▌ ▐ Ⅰ
missing). The game's font sets (`+0x3484A0`, `+0x3466E0`) chain a Latin font first, then
bl.ttf; a Korean, Japanese or Chinese client puts Kostar, UDTypos or arud first instead.

| Advance | Glyphs |
| --- | --- |
| 427 | ■ □ ▣ ▤ ▥ ▦ ▧ ▨ ▩ ▼ ○ ● ◐ ◑ |
| 358 | ▲ △ ◆ ◈ |
| 393 | ▶ ▷ ◀ ◁ |
| 512 | ▽ ◇ ◎ ▒, box drawing U+2500–254B, arrows, U+3000, full-width forms, kana, CJK, Hangul jamo, 〓 ☆ |
| 461 | Hangul syllables |

- **No Braille** and no half or quarter blocks: ▒ is the only one of U+2580–259F.
- **A grey ramp at one width** (427, ink measured in the outlines): ○ 11%, □ 13%, ◐/◑ 18%,
  ▤ 19.5%, ▣ 20.5%, ▧ 22%, ▦ 24%, ● 25%, ▩ 27%, ■ 33%. Four levels: □ ▤ ▩ ■. ◐ ◑ split a cell
  left and right; nothing splits it top and bottom.
- The 427 shapes are small squares with a gap between them; ▒ and the box-drawing glyphs
  fill their whole 512 cell and join edge to edge.
- Six 427 cells (2,562) line up with five 512 cells (2,560).
- **A Korean client breaks the board:** Kostar draws the shapes and Hangul all at one width
  (900 of 1,000), so ■ and ㅁ come out the same width there.
- Not checked: which size the text lines use (font10 is the likely one), and how the
  widths round to pixels in the game. A probe line of ■▣■▣ over □□□□ answers both.

So the text lines can carry a four-level picture, but only 11 rows of it: the fog is the
picture, and the text lines are for lyrics and a small second copy.


#### Everything else that makes it look good

- **The sound.** 23.8 frames a second on Fastest against the video's 30: frames are chosen
  by time. Open: whether Remastered plays a 3:39 sound from a map (OGG or WAV) and how
  large; whether the frames keep time against it (under 500k actions they should); chunks
  restarted every few seconds as the fallback.
- **Every surface at once:** the video in fog on the minimap; the main view centred on the
  board, where the same fog is drawn with Remastered's soft edges; the lyrics in the
  transmission line, coloured word by word with S2's JSX; the time in the leaderboard
  label.
- **The encoding is most of the look:** frames blended before thresholding at 23.8 fps,
  the error spent on outlines (the silhouette's edge is what people recognise), brushes
  kept from one frame to the next where they still fit.
- **The music and the video are not ours.** The song is Alstroemeria Records', the video
  is Anira's. Fan remakes are a long tradition, but whether a map with the song in it goes
  on scmjs.dev or the registry is the user's decision; the video alone with the song
  played beside it is the safe form.

**Needs from the language:** a video imported at build time (`import video from
"./bad-apple.webm"` → a table of brushes, B8's machinery), typed memory for the countdown
(B7: `memory.vision.countdown`, allowed both ways by R0), and the lifted game's test of the
whole video read back from the tile array and held against the source frames (A2).

### S5. A raycaster in the fog

Added 2026-10-17, with B6. A 3D maze on the minimap, walked with W A S D: `probes/raycaster.ts`, the textbook DDA
raycaster (Lode Vandevenne's, a ray a column stepped from grid line to grid line) written as any TypeScript would
have it, fixed numbers for its fractions. 42 columns 3 tiles wide over 78 rows; under them the maze from above, three
tiles a cell, the player blinking on it; a way out that flickers; `I` switches between light walls on fog and dark
walls between a lit ceiling and floor.

**How it draws: `fog.columns(player, x, y, layout, heights, shaded?)`.** A brush every 3 × 4 tiles took 860 brushes a
frame in that maze, 1 008 at worst: past the game's limit of about 950 unit creations a frame. The columns are drawn
instead as rectangles whose covers the encoder works out when the script is built: a band across every column as deep
as the shallowest, a band a group of six as deep as that group's, and a bar a column for the rest, each half above
and below the middle (light ink) or below the top and above the bottom (dark ink). A cover a rectangle depth is a
table; a single column's bar is the smallest brush stacked, worked out rather than read. Shaded columns (the other
face of the walls, so corners show) are drawn hollow, lit a brush deep along their top and bottom edges: two brushes a
column. Lines across them at their quarters looked best but cost two dozen a column.

**Measured in the lifted game** (`scripts/fog-frames.mts`, which plays a map headless with keys held and writes the
fog as pictures): about 280 brushes a frame, 440 at worst over a walk through the level; 220k conditions and actions
a frame on average, 252k at most — the rays about 150k of it (four fixed multiplies and three divides a column, after
the ray's direction is stepped across the camera plane instead of computed a column at a time), the drawing the rest.
The tests hold the game's fog against a floating-point raycaster column by column (within a row) and pass in the game
and in the simulator, which now draws the fog of units a program set the sight of.

**Played (2026-10-17), three rounds.** Round 1: it works in Remastered. Its minimap changed 12 times a second, as
Bad Apple's recording does: Remastered redraws the fog on the minimap every other frame — so `fog.show(2)` keeps a
picture two frames and the raycaster draws every other one, half the work for the same picture. Round 2: panelled
faces (lit bands at the quarters) "look weird": combs. Six looks mocked up on the same views (solid, hollow,
panelled, outline, seams, floor lines); the user chose **outline** — every wall as its edges, top and bottom and a
column lit whole where one face meets another — now the default of `fog.columns` with its `faces` argument. Round 3
(outline, about 110k a frame): "it looks great", rendered cleanly throughout, and the way out was found in 22 s.

**Not yet:** Textures, sprites
(a monster drawn as a scaled picture in front of the walls), a floor with distance, more than one level.

### Smaller things that show well

Each is small and makes the editor feel like it knows the game. They go in where a slice
passes near them.

| Idea | Built from | Where |
| --- | --- | --- |
| EUD error code to line: Remastered's "EUD ERROR: 0x…" is the refused address inverted (R0); the editor reads the code and points at the line that touches that address | the trigger map and trace (A1), R0 | built 2026-10-17, below |
| Typed chat patterns: `on.chat("-give {n}", (p, { n }) => …)` with `n: number` worked out by template literal types | B2 | built: `chatted()`'s patterns, which `on.chat` took over in B2 |
| A line's values over time beside it, as a small graph, from the debugger's recording | A5 | after A5's open items |
| Changes kept while the game runs: edit the script, rebuild, carry the variables over by name into a snapshot and go on | A2's variable map, scm-sim snapshots | after B1 (a task's place has to carry over too) |
| Fuzzing: random inputs on every seat at the lifted game's speed, looking for desyncs, games that end and failed expectations, then the smallest input that still fails | A2, A3 | after B5 |
| A memory field's hover says what Remastered does with it ("read: fine, from the dump; write: ends the game, probe 6") | R0, Ghidra structs (the analysis has to be run again) | B7 |

#### EUD error code to line (built 2026-10-17)

**Find an EUD Error…** (the palette and the More menu) asks for the code Remastered showed and answers with the
lines. In the editor it goes:

1. **The code is read.** "EUD ERROR: 0xFFA632E3", "0xFFA632E3" or "FFA632E3"; the address is the code's bits inverted
   (R0, the dump probe's step D: 0xFFA632E3 is 0x59CD1C).
2. **The address is named.** `compiler/eudError.ts` knows 1.16.1's unit table field by field (CUnit, slot and offset:
   "the unit table: slot 0 of 1,700, order queue head (+0x74)"), the deaths and kills tables by player and unit type,
   resources, switches, locations, the text lines, the local machine's keys and mouse, the current player, every
   `stats()` field, and else an allowlist entry's name. The allowlist's read and write verdicts and their evidence come
   with it (`dist/allowlist.json`, a copy the build makes, fetched the first time a code is looked up).
3. **The map is traced in the game.** Built as Save builds it, then `runGameTests` with two new payload fields:
   `play` (3,000 frames with nobody at it, before the tests) and `trace`. `EudTracer` listens on the host's EUD tap
   (scm-sim's `installEud`, which the page's test worker already gave the handle) and takes each access's line from
   the cost tap's `trace`, which is told of each record before it runs, with eudplib's variables and functions under
   the line that ran before them. So a unit field read inside `f_dwread_epd` is the line that called it. The rows come
   back in the report (`trace`, or `traceError` saying why not). **No scm-sim change was needed.**
4. **The lines are found.** Those that touched the very dword first. In the unit table, a unit sits in a different
   slot from game to game, so lines that touched the same field of another unit are found too, marked so. Accesses
   under no line (eudplib's start, its work at the top of a frame, the map's other triggers) are counted apart.
5. **They are shown** as an inlay at the end of each line ("EUD ERROR 0xFFA632E3", with what the line did and what
   Remastered does with it), in Problems (source "game"), in Output, and the cursor goes to the first. Like a line's
   cost, they stay only while the file is the text that was traced.

Under Node: `npx tsx scripts/test-game.mts <script.ts> --error=0x… [--frames=N]` runs the same path (the handle
given the EUD tap, `runGameTests` with `trace` and `play`).

**Checked:**
- `tests/eud-error.test.ts` (11): the code both ways; the names; matching exact, by field, outside the unit table,
  and a byte inside a dword; the allowlist's verdicts and `outside`; `EudTracer` over taps shaped like scm-sim's, with
  CARRY; `runGameTests` playing frames for a script with no tests; `traceError` when the host or build cannot.
- In the lifted game: `probes/units.ts --error=0xFFA62F5F` (slot 3's hit points) names lines 38 (`sum += u.hp`),
  42 (`u.hp = …`), 105 (`u.hp < least`) and the other hit point lines, all as "the same field of another unit",
  since no unit stood in slot 3. `probes/remastered-dump.ts --error=0xFFA632E3` names the place and the played
  evidence and finds no line: step D's read is the probe's hand-written eudplib, not a line of the script.

**Not checked:** the command in the editor itself, end to end (it needs the person's copy of the game on the
engine's page). **Found on the way:** A1's Node trace (`exact-eud.ts --trace`) keys rows by the raw origin, so
eudplib's functions are "fn:…", never a line; a unit field read through `f_dwread_epd` there looks like eudplib's
own. The tap's CARRY is what puts it on its line, which is why `--error` lives in `test-game.mts` and not in
`game-check.mts`. The same would sharpen A1's check (it currently reads those as eudplib's).

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
  plus an explicit `task.cancel()` on what `start(…)` returns (built as `t.cancel()`). *Decided otherwise in B1's
  first part (2026-10-16), and confirmed by the user:* the losers stop, because a branch is
  a fixed pair of cells and a race met again cannot run beside its last run. A loser that
  should go on can be started with `start()` and raced as `await t` (built in B1's second
  part).
- **What a closure may capture.** Proposed above (B3): `const` by value, `let` only when
  the closure does not outlive its frame. The alternative is reference-counted
  environments: closer to JavaScript, more Python, and a new kind of fault.
  *Built (2026-10-17) narrower:* a function that does not outlive its frame (handed down) captures anything; one
  kept as a value captures only the program's own variables and values known when built. Capturing a local by value
  waits for an environment on the heap, owned the way a made text owns its block — `makeCounter()` returning
  `() => count++` over its own `let` needs that, and reference cells besides.
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
- Remastered's executable is encrypted on disk and decrypted in memory; its EUD emulator was read from a dump of the running game and run under Unicorn (R0, 2026-10-16). Nothing of it ships: only addresses and verdicts, in `data/remastered.json`.
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
