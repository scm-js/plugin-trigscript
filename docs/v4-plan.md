# TrigScript 4 — the plan

Written 2026-10-15. Status: Part A built (A0–A5, each with its *As built*), and Remastered's
emulator read from a dump (*R0*, 2026-10-16); Part B steered by three showpiece maps
(*Showpieces*, 2026-10-16), B1 and B2 built (2026-10-16/17), and an EUD error code taken back to its line
(*EUD error code to line*, 2026-10-17); a fourth showpiece, Bad Apple, with fog of war found to work as a
framebuffer in the lifted game (*S4*, 2026-10-17). The question it answers: now that there is a
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
| Fog of war as a framebuffer | the vision countdown `0x51CE98`, sight writes, Map Revealers made and removed in one pass | **Yes in the lifted game** (S4, 2026-10-17); Remastered's drawing of it is the probe |
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
