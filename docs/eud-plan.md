# TrigScript on the Remastered target — the plan

Written 2026-09-17; revised the same day when the build server was replaced by the
[eudplib plugin](https://github.com/scm-js/plugin-eudplib), which runs eudplib inside the
editor. Status: slice 0 built (`python/trigscript.py` lowers a hand-written IR,
`probes/spike.ts` since slice 1, into `fixtures/eud/spike-eud.scx`, which is ignored because it sits on a Blizzard map). **Played 2026-09-18, all pass**: the tick every second, ore by a constant, gas set from a variable, the per-player greeting after a sleep, and a unit created when the counter reached 5. The second play found the one bug so far: `EUDVariable(n)` is a load-time value, so a temporary built with it kept the last run's total (see `fresh()` in `python/trigscript.py`). The
question it answers: what does TrigScript become when eudplib can assemble its output,
and how do we get the best developer experience out of that.

> **Revised 2026-09-18, for TrigScript 3.0.** Two decisions changed the shape of this plan,
> and the sections below are to be read through them:
>
> 1. **Programs are Remastered only.** There is no Classic target for `program()` any more:
>    the death-counter backend, the target switch, cost hints and the parity suite are gone.
>    `trigger()` is untouched and plays on every version. Every "on the classic target…"
>    clause below is void, including *Reads on the classic target* and *The classic install
>    on the Remastered target* under Open decisions (the second is what forced the choice:
>    no limit could be lifted while every script also had to fit Classic).
> 2. **One file, built on save.** No `<name>-eud.scx` beside the map and no Build & Test.
>    The editor has build steps now (`api.document.buildSteps`); the eudplib plugin owns the
>    one eudplib step and TrigScript *contributes* its IR to it, so Save, Test Map and an
>    export write the built map, with the map as the user edits it kept inside the file and
>    given back on open. *Where the built map goes* under Open decisions is settled by this.
>
> Also settled in 3.0: the IR is version 2 (a program's text is written out in the IR and
> added to the built map by eudplib, never interned into the source map); a program's
> owners are honoured (All Players and forces resolved from the map's player settings,
> human and computer); `frames(n)` is the unit of `sleep`, `cycles(n)` its old name; the
> lowering's arithmetic was brought to the contract the simulator states (whole sums,
> exact comparisons, `abs` as a distance, a 0 divisor gives 0), and the simulator mirrors
> the lowering down to the 32-bit wrap. Slices 2–6 below stand as written.
>
> **Slice 2, as built (3.2.0, 2026-09-18).** Reads are the comparing conditions without
> their comparison and amount, plus the plainer names; a read means what its condition
> means, because where no table of the game is the value the lowering searches with the
> condition itself. Player facts as planned, with `races.` and `slots.` to compare against
> and `supply(p, of, race?)` as the top bar shows it. Text: `displayText` stays "for the
> current player"; `print(text, { to, position })` addresses anyone else, and its positions
> are the chat area and the centre line (`f_eprintln`); `name(p)` and `color(p)` are marks
> inside a string, so they survive a helper or a `+`, and only `displayText` / `print`
> take them. `random(n)`, seeded from the game, and `& | ^ << >>`. IR version 3. The probe
> is `probes/reads.ts`.
>
> **Revised 2026-09-18 (evening): the language before the tooling.** The order of what is
> left changed. `test()` and the debugger were next; they now come after four slices that
> make a program's language the TypeScript a person already writes — signed numbers,
> arrays and keyed tables, functions that are really called, recursion — because each of
> those changes what a debugger and a test's `sim` have to show (a call stack, an array,
> a number below zero), and because the examples of the last slice should be written in
> the language as it ends up. The cost is probes: slice 5 as planned needed none, and each
> of these has one to be played. See *The language slices* under Slices; the *Numbers* and
> *Arrays* paragraphs of the programming model below are superseded by it.
>
> **Revised 2026-09-19: a fifth language slice, 8½.** For the same reason the language went
> before the tooling: callbacks on arrays, destructuring and spread, classes, and a `Map`
> over any number are what a person writing TypeScript reaches for next, and each changes
> what the debugger shows and what the examples look like. It takes 3.9.0; `test()` and the
> debugger move to 3.10.0 and the examples to 3.11.0.

## What we are aiming for

TrigScript today is TypeScript that runs when you build, with `program()` bodies compiled
into a state machine of death counters. It is honest about its limits: `a = b` is 66
triggers, a condition cannot be compared against a variable, a loop runs one iteration per
trigger cycle, a text cannot contain a number, and a program cannot see a unit's hit points.

With eudplib generating the triggers, every one of those limits goes away. The aim is
that a map maker who knows TypeScript writes what they mean and it works:

```ts
program(() => {
  let gold = 0;
  const shop = locations.Shop;
  while (true) {
    for (const u of unitsAt(shop, { owner: CurrentPlayer, type: units.TerranMarine })) {
      if (u.hp < u.maxHp / 2) { u.hp = u.maxHp; gold -= 10; }
    }
    const m = chatted(CurrentPlayer, "-give {amount}");
    if (m) { gold += m.amount; displayText(`${name(CurrentPlayer)} now has ${gold} gold`); }
    if (minerals(CurrentPlayer) > 1000) victory();
    sleep(frames(1));
  }
}, { owner: AllPlayers });
```

Nothing in that example is legal today. Under the plan it is all ordinary TrigScript on the
Remastered target, costs nothing worth a hint, simulates in the editor, and builds to a
playable map in about a second.

## Principles

1. **It is TypeScript.** If a construct is valid TypeScript and has a sensible meaning in
   the game, it works. If it does not, the error says why and what to write instead. No
   new syntax, no annotations in comments, no framework of callbacks: a program is a
   function, a loop is a loop, a unit is an object with properties.
2. **One language, two targets.** *Classic* (what exists today, runs on every version of
   the game) and *Remastered* (EUD, through the eudplib plugin). The Remastered target removes
   limits; it never changes what a program that compiles on both targets does. The
   simulator proves that: the test suite runs every classic program on both and expects
   the same events.
3. **The lowering takes data, never code.** The plugin emits an intermediate
   representation (IR) as JSON; its own euddraft plugin, `python/trigscript.py`, lowers
   it with eudplib inside the eudplib plugin's worker. There is no epScript and no
   `eval`, so an error is always a node of the IR and maps to a line in Monaco; and the
   Python ships with the TrigScript plugin, so the two halves of the IR version are
   always the same build.
4. **Everything is testable without the game.** The simulator moves up from triggers to
   the IR, so it runs both targets, and `test()` blocks let a script check itself when it
   is built.
5. **Only verified game facts ship.** A read or write on the Remastered target is offered
   only after a probe map has shown it working in the game. Magenta's catalogue (68 of 73
   entries verified as of 0.3.5) is the starting inventory; anything new gets a probe first.
6. **Costs stay visible.** The classic target keeps its trigger counts. The Remastered
   target shows what still costs something: a loop over every unit each frame, a print.

## The programming model on the Remastered target

**A program is a coroutine the game runs every frame.** The body runs from where it left
off until it reaches a `sleep()` or the end; `sleep(frames(n))` parks it for n frames,
`sleep(seconds(n))` converts at the game's frame rate (the build always includes eudTurbo,
so triggers run every frame; ~24 a second at Fastest, no hyper triggers needed). A program
that ends restarts next frame only if its body is a loop, as today. Several programs run
side by side, each with its own state, as today.

**Loops run to completion within the frame** unless they sleep. `for (let i = 0; i < n;
i++)` with a variable bound runs all n iterations before the next statement, as it reads.
The one rule the compiler enforces: a `while (true)` (or a loop whose condition never
mentions a variable the body changes) must `sleep()` on every path around it, otherwise it
would never give the frame back and the game would freeze. The error says so and points at
the loop.

**`CurrentPlayer` and per-player programs** stay. Per-player variables become a 12-slot
array per variable instead of a death-table row; `shared()` stays one value.

**Numbers** keep the classic contract: 32-bit, an expression is the exact sum, stored
below zero as 0 and at 2³² or above wrapped; `u8`/`u16` saturate at their maximum. Under
EUD this costs a compare instead of a decomposition, and the same test programs prove the
rule on both targets. Signed integers are not in the plan (see Open decisions).

**Booleans** are variables holding 0 or 1. **Records** stay a variable per field.
**Arrays** are new: `let hp = [0, 0, 0]` or `let lives: u8[] = new Array(12).fill(3)`
becomes an EUDArray, indexed by a constant or a variable, `.length` known when you build.
Nested arrays and arrays of records are allowed when their shape is known when you build.

**Strings are values in text, not variables.** A template literal in `displayText` may
contain a number expression, `name(player)` and `color(player)`; that becomes a dynamic
print. A `let s = "…"` variable is an error that says text is printed, not stored.

## The library

The vocabulary grows in four directions. Every item below is typed in the generated
`.d.ts`, completes in Monaco, and is marked with the target it needs, so on the classic
target it does not appear at all and an import of it is an error naming the target.

### Reads: every quantity a condition tests is also a value

Overloads, so nothing new has to be learned. Two arguments is a read; four is a condition:

```ts
if (deaths(P1, units.TerranMarine, ">=", 10)) …   // a condition, as today
let lost = deaths(P1, units.TerranMarine);          // a read
let ore = minerals(P1);                             // also resources(P1, "ore")
let n = countUnits(P2, units.ZergZergling, locations.Pen);   // what bring() tests
let k = kills(P1, units.AnyUnit);
let t = countdown();                                // what countdownTimer() tests
let e = elapsed();
```

Plus player facts: `race(p)`, `slot(p)`, `isHuman(p)`, `hasLeft(p)`, `supply(p, "used" |
"max", race?)`. A read anywhere a number is expected: `if (minerals(P1) > gold * 2)`.

On the classic target a read is also possible, by the same decomposition as a variable
copy, and is offered there too with a cost hint (this is the follow-up 2.5.0 left owed).
Player facts and supply are Remastered only.

### Units on the map as objects

A `Unit` is a unit that exists in the game right now (a CUnit pointer underneath). The
entries of the `units.` table are `UnitType`s, and `u.type` gives one. (Until 3.3 the table's
entries were typed `Unit<n>`; the rename came with slice 3, not slice 1 as first planned, and
a script using the old name is told the new one.)

```ts
for (const u of unitsAt(locations.Pen, { owner: P2 })) u.hp = u.maxHp / 2;
const target = nearest(units.TerranMarine, locations.Beacon, { owner: P1 });
if (target) target.order("move", locations.Exit);
```

Properties, each a read and, where the game allows it, a write: `hp`, `maxHp`, `shields`,
`energy`, `owner`, `type`, `x`, `y`, `kills`, `order` (read; a written order goes through
`.order(kind, target)` so the box trick Magenta verified is applied), `hallucinated`
(read), `cloaked` (read only: writing the cloak flags showed nothing in the probe),
`stim`/`ensnare`/`plague`/`lockdown`/`maelstrom`/`irradiate` timers in frames, `cooldown`
(write locks it), `invincible`, `speed` is *not* offered (per-unit speed fields failed).
Methods: `order(kind, target)`, `give(player)`, `kill()`, `remove()`, `damage(n | {percent})`,
`heal(n | {percent})`, `moveBy(dx, dy)` is on locations, not units (a position write exits
the game with "EUD not supported"; the probe proved it).

Sources of units: `unitsAt(location, filter?)`, `unitsOf(player, filter?)`, `allUnits(filter?)`
(each a loop over the unit table, cost shown as a hint), `nearest(type, location, filter?)`,
`first(...)`, `randomUnit(...)`, `underMouse(player)`. A `Unit` variable can be
stored and tested for `null`; it is a pointer and the compiler re-checks it is still the
same unit before each use (the game reuses slots).

### The game's tables

Values that Magenta's probes verified as live writes, exposed as objects with writable
properties on a build-time table entry:

```ts
program(() => {
  stats(units.TerranMarine).minerals = 25;
  stats(units.TerranMarine).speed = 8;         // the four flingy records, as Magenta writes them
  stats(units.ZergZergling).name = "Dog";        // a map string
  stats(upgrades.InfantryArmor).minerals = 50;
  stats(units.TerranGhost).permanentCloak = true;
  stats(P3).color = "teal";                      // colour byte + minimap; the mapping write failed and is not offered
});
```

Only the fields the probes passed are declared; a field the game showed no effect for
(game speed, colour mapping, position, sprite tint, terrain) is left out on purpose, and
the note in Magenta's `docs/candidates.md` says why for each.

### Input

Synced input through the MSQC plugin and chat through chatEvent, both composed by the
compiler with no configuration:

```ts
const m = chatted(CurrentPlayer, "-spawn {n} {unit:name}");   // null or { n, unit } this frame
if (keyPressed(CurrentPlayer, "F2")) …                          // true on the frame the key went down
if (clicked(CurrentPlayer, "left")) { const at = mouse(CurrentPlayer); … }
const u = underMouse(CurrentPlayer);
```

`chatted()` patterns: `{name}` captures a number, `{name:unit}` a unit type by its
display name, `{name:word}` a word (compared against a constant list the pattern
declares). Literal text is exact. Chat needs exactly the regex shape chatEvent accepts;
the compiler builds it. The single-player chat caveat from the probes goes in the guide.

### Text

`displayText` takes a template literal with expressions, `name(p)`, `color(p)`, and the
existing colour codes; `print(text, { to: player, position?: "top" })` for the alternatives
eudplib offers. Text with variables becomes a dynamic print; text without stays a map
string, as today.

### Randomness and arithmetic

`random(n)` returns 0 … n−1 as a number; `random()` stays a boolean. `a / b`, `a % b`,
`a * b`, `&`, `|`, `^`, `<<`, `>>` between variables all work, each one call underneath;
`Math.min/max/abs/clamp` stay.

## The tooling

**The workspace (3.1).** Everything below lives in a frame laid out as VS Code is
(`shell.ts`): the Explorer with the files and the programs' variables, tabs with the run
controls at their right, a panel of views under the editor (Problems, Output, Simulate), a
status bar, notifications in the corner, and every command in Monaco's palette with VS
Code's keys. Nothing that appears moves the text. So where this plan says a *panel* — the
Tests panel, the Run panel, the world table — it means a view of that bottom panel (and,
once there are two things to switch between at the left, an activity bar over the
Explorer); where it says a *status line*, an item of the status bar; breakpoints are
Monaco's glyph margin, F5 starts what VS Code would start, and the debugger's controls are
a floating strip over the editor's top edge, as VS Code's are.

**Target switch.** A toolbar control, *Classic* / *Remastered (EUD)*, stored in
`build.json`. Switching regenerates the declarations, so completion shows only what the
target has; a script using Remastered names on the classic target gets one error per use
naming the target. The guide's first line about the Remastered target is that the built
map needs StarCraft: Remastered.

**Cost hints** keep their shape. Classic: trigger counts as today. Remastered: a label on
lines that iterate the unit table ("scans every unit each frame"), on prints, and on a
loop with no sleep on a path (an error, not a hint). The `program(` line shows the
payload's size in the map once the build has answered.

**Simulator on the IR.** `simulate.ts` becomes an interpreter of the IR rather than of
trigger records. It gains a small world model: units with the properties above, resources,
kills, a chat and key queue, the mouse, the frame counter. Classic programs go through the
same IR (the classic backend lowers the IR to triggers; the trigger interpreter stays for
`trigger()` records and for the classic backend's own tests). Unit conditions stop
answering "false": `bring()` counts the simulated units.

**`test()` blocks.** Ordinary TypeScript run when the script is built, against the
simulator, so a script checks itself:

```ts
test("the first wave spawns after the beacon", (sim) => {
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.frames(24);
  expect(sim.count(P2, units.ZergZergling, locations.Spawn)).toBe(6);
});
```

`sim` is the world (`place`, `type(player, text)`, `press`, `click`, `frames`, `seconds`,
`count`, `resources`, `text()`, `events`), `expect` is a small matcher set. Results show in a
Tests panel of the workspace with pass/fail and the failing line; Build warns on a failing
test, and a preference makes it refuse.

**Debugger.** The simulator steps: a Run panel with *Frame*, *Step*, *Run to breakpoint*,
the current line highlighted in Monaco, variables and the world in a side table,
breakpoints in the glyph margin. Works on both targets because it is the IR.

**Build & Test.** One button on the Remastered target: compile, hand the IR, the map and
`trigscript.py` to the eudplib plugin's `eudplib.build` service (the library asks to
download its runtime the first time, about 15 MB, once), save `<name>-eud.scx` beside
the map (the Save dialog's file handles), then what *Test Map* does with it. A widget
shows the steps and the build log; a build error lands on the IR node's line in Monaco. The source map keeps its source and its classic
triggers; the built map is an output, as Magenta's is. *Build* alone on this target
produces the same file without launching.

**Library status.** TrigScript's manifest `requires` the eudplib plugin, so installing
TrigScript installs it and it cannot be turned off underneath. The workspace's status line
shows whether the library is running and its eudplib version (from the service's
`versions`), and the Remastered target refuses to build with a plain message when it is not.

**Examples.** *New from example…* in the file list: wave defence, a shop with chat
commands, mouse-controlled hero, per-player lives, a stat rework — each a complete script
with a `test()` block, each also a fixture in the test suite so they never rot. The guide
grows a "Remastered target" section built from them.

**The assistant.** The compact declarations carry the new vocabulary with the target, and
*Write Triggers* asks the state for the target, so the AI writes for the one the map is on.

## Architecture

### In the plugin

- `compiler/ir.ts`: the IR types. A `Program` is `{ owner, owners, perPlayer, variables,
  body }`; statements are `assign | if | while | for | switch | block | sleep | action |
  call | return | foreach | test`; expressions are `const | var | read | field | binary |
  unary | ternary | call | condition`; every node carries `at: { file, line, column }`.
  Versioned (`IR_VERSION`), documented in `docs/ir.md`, and the contract with `python/trigscript.py`.
- `structured.ts` emits IR instead of driving `Machine` directly. `lower.ts` (the classic
  backend) consumes IR: this is the one refactor with risk, done first and proven by the
  existing 137 tests running unchanged.
- `compiler/eud.ts`: the Remastered backend is a pass that checks the IR against the
  target (no unsupported reads on classic, sleep rule, string rule) and serialises it.
- `service.ts`: `build()` on the Remastered target calls the eudplib service; `BuildOptions.target`;
  the manifest gains `target` and `ir` version.
- `declarations.ts`: two flavours from one table, each entry tagged with its target; the
  brand `Unit<n>` becomes `UnitType<n>`, and `Unit` is the instance (declared on both
  targets; on classic nothing produces one and the compiler names the Remastered target).
- `simulate.ts`: rewritten over IR, with the world model; `tests/` gains the two-target
  parity suite.

### In `python/trigscript.py`

- The euddraft plugin, handed to the eudplib service as a `sources` entry with every
  build, the IR as a `files` entry (`/work/files/trigscript.json`, named by the plugin's
  `ir` setting). It reads the IR, checks `version`, lowers. Variables → `EUDVariable`
  (per-player → `EUDArray(12)` indexed by the current player); `if`/`while` →
  `EUDIf`/`EUDWhile` with variable-aware conditions; `sleep` → the state split (state
  variable + `EUDSwitch` per program, the same shape the classic backend uses; slice 0
  cuts the body at top-level sleeps, slice 1 lowers every block to jumps between labelled
  segments so a sleep may sit anywhere); actions with variables → eudplib actions taking
  `EUDVariable` fields; reads → `f_dwread_epd`/CUnit fields; `foreach` → `EUDLoopNewUnit`
  with the filter; chat and MSQC → the same composition Magenta uses (copied, the two
  plugins are independent repositories); prints → `f_simpleprint` with `PName`/`PColor`.
- Embedded into the bundle as a string (`scripts/embed-python.mts`, as Magenta does) with
  a test that fails on drift and pins the Python's `IR_VERSION` to the compiler's.
- Errors: the lowering raises with the offending node's `at`; the service rejects with
  the message, the plugin parses `at` out of it; unexpected eudplib exceptions carry the
  nearest node.
- Tests: `npm run build:map` in a plugin-eudplib checkout lowers fixture IRs under Node
  (the same worker the editor runs); a golden set of built maps checked for size and for
  the trigger count the bootstrap expects.

### What stays as it is

The run-at-build-time model, the hoist plan, the workspace, Import map triggers, the
stale block logic, the claim on the generated block, the commands other plugins use, the
classic target's numbers.

## Slices

Each slice ships as a tagged plugin version. Each has a probe map that gets played
before the slice is called done, in the Magenta manner.

| # | Slice | What it proves | Size |
| --- | --- | --- | --- |
| 0 | Spike: hand-written IR → eudplib plugin → map; a counter, a sleep, a dynamic print, per-player (built 2026-09-17, played 2026-09-18: all pass) | frames, eudTurbo, prints, per-player arrays work; a number for build time and payload size | 1 day |
| 1 | IR refactor + Remastered backend for today's language + Build & Test + simulator on IR | every existing test program simulates identically on both targets; `a = b` and `if (a < b)` cost nothing; loops run in-frame; the sleep rule | the big one, ~1 week |
| 1½ | The workspace as VS Code lays one out (3.1.0) | the frame slices 5 and 6 put their panels in: no banner moves the text, every command in the palette, the keys people already know | 2 days, no probe: nothing about the game changes |
| 2 | Reads and text (3.2.0) | `deaths(P1, u)` as a value, `minerals()`, `countUnits()`, player facts, template literals with numbers and names, `print()`, `random(n)`, the bitwise operators | 2–3 days |
| 3 | `Unit` objects, unit loops, picks, `stats()` (3.3.0; built 2026-09-18, the probe is `probes/units.ts`) | the Magenta-verified list as typed objects; the pointer re-check; hints for scans | 3–4 days |
| 4 | Input (3.4.0; built 2026-09-18, the probe is `probes/input.ts`) | `chatted()` with captures, `keyPressed`, `clicked`, `mouse`, `underMouse`; MSQC and chatEvent composed automatically | 2–3 days |
| 5 | Signed numbers (3.5.0; the probe is `probes/numbers.ts`, played 2026-09-18: every line as expected, the ore at 75 at the end) | `number` is a signed 32-bit integer, `u32` the unsigned one beside it, `>>>` apart from `>>`, division towards zero; IR 6 | 2–3 days |
| 6 | Arrays and keyed tables (3.6.0; the probe is `probes/arrays.ts`, played 2026-09-18: step L — 20 000 pushes at 500 a frame — did not stutter, said out of memory once and stopped at 4096, the push the simulator stops at; M found room again in the blocks given back, N had an array a player and one shared; played again 2026-09-19 with the records, the array of units and the Map loops — steps O to Q — all as expected) | `number[]`, `boolean[]`, arrays of records and of units, a variable index, `for…of`, `push` / `pop` on an array that grows out of a heap; `Record<K, V>`, `Map<K, V>` and `Set<K>` over a key set known when the script is built | 4–5 days |
| 7 | Functions that are called (3.7.0; the probe is `probes/functions.ts`, played 2026-09-19: every line as expected — 2000 calls in one frame without a stutter, one Marine at 10 hit points, the per-player line) | a function that never sleeps and whose parameters go only where a variable may go is one copy in the map, called from every site; the rest stay inlined; a hint says which; a function that takes an array is one copy an array passed; the simulator's faults shown in the Simulate view | 3 days |
| 8 | Recursion (3.8.0; the probe is `probes/recursion.ts`, played 2026-09-19: as expected — `fib(20)`, 21 891 calls in one frame, with basically no pause; the overflow said in red where the third program stopped and the first going on to its end) | a function on a cycle of the call graph saves its frame on a stack around the call; a depth limit that says so in the game and fails a test | 3–4 days |
| 8½ | The TypeScript people write (3.9.0) | `forEach` / `map` / `filter` / `some` / `every` / `find` / `reduce` / `sort` with the arrow inlined into the loop; destructuring and spread; arrays inside records and arrays of arrays; a class as a record and its functions; `Map<number, V>` and `Set<number>` over any key | 7–8 days |
| 9 | `test()` blocks + debugger (3.10.0) | Tests panel, frame stepping, breakpoints, a call stack, arrays in the variables view, the world table | 3–4 days, no probe |
| 10 | Examples, guide, assistant prompts, registry (3.11.0) | the five examples as fixtures; README and the user guide's Remastered section; scmjs.dev's Write Triggers knows the whole language | 2 days, no probe |

**Slice 3 as built**, where it differs from the sections above: the read of a unit's order is
`orderId` (a property and a method cannot share the name `order`); `underMouse()` waits for
slice 4, which brings the mouse; `locate(location)`, `underAttack`, `stasis` and `resources`
were added from Magenta's verified list; a `sleep()` inside a loop over units is an error (the
unit table moves between frames — the way to act on one unit at a time is to find it again
after each sleep), which also means the unit of a loop's turn needs no re-check; `stats()` is
one function told apart by the brand of its argument's type, since a table's index is a plain
number when the script runs; `stats(player)` has `color`, `upgrades[…]` and `researched[…]`;
a value with a scale (`speed`, `buildTime`, `supplyUsed`) takes a fraction when it is known at
build time. The unit classes turned out to be one too low in the editor's table (Any unit 228
for 229, and so on); corrected there and here with this slice.

**Slice 4 as built** (3.4.0; the probe is `probes/input.ts`), where it differs from the
sections above. Nothing of the map's is used for the cells: chatEvent and MSQC take a *name*
wherever they take an address or a death-counter unit, so the lowering registers
`EUDArray(12)`s and `EUDVariable`s under names the compiler also writes into the two plugins'
settings (`compiler/input.ts`; Magenta uses death counters because its rows are conditions
of ordinary triggers — a program needs none). chatEvent is given no messages at all: it only
finds the local player's line, and `trigscript.py` matches every pattern itself, on the
computer the line was typed on, so there is one matcher, no two-`.*` rule and no clash
between patterns sharing a first word. chatEvent's result is local (it prints "desync"
beside it), so the pattern's number and its values go through MSQC's `val` to every
computer — which is why a typed number stops at 2²⁰ − 1 (what `val` carries on the smallest
map) and a pattern reads at most three values (one command unit per human each). A
`{name:unit}` capture is looked up by a hash of the lower-cased rest of the line in a
sorted table (a search by halves), a `{name:a|b}` capture the same way against its words.
`chatted()` gives a record of the program's numbers with a boolean of its own for `if (m)`;
`mouse()` a record of two. `mouse(p)` has no `locate()`: `centerLocation(location, x, y)`
is a statement of its own, useful with any two numbers. An action takes several fields from
the program at once, a unit type among them (`createUnit(p, m.what, m.n, at)`) — IR 5 has
`variables` where 4 had `variable`. The input functions refuse to run outside a program,
where a truthy object would make `if (keyPressed(…))` always true. An input never counts
as "moving" for the sleep rule: it cannot change within the frame. Locations come from the
map's first 63, highest first, which every map's table has. Found on the way: the lowering
waited one frame longer than every `sleep()` asked, so a loop sleeping a frame ran every
other frame and would have missed half the presses; fixed with this slice (the simulator
always had it right). What `test()` needs — `sim.press`, `sim.click`, `sim.type`,
`sim.moveMouse` — is in the interpreter already. The probe was played three times: everything
passed but F6, which the game never reports (silent first in MSQC's settings and silent
third, while F7, F8, `1`, Q, W and E answered), so F6 is not a `Key`. MSQC's unit type (the Valkyrie) and its
player (12) are fixed for now; a map that uses Valkyries has no way to say so yet.

### The language slices (5–8½)

Decided 2026-09-18 with the user. What they share: the source is TypeScript a person would
write anyway, and where the game cannot follow, the compiler says so at the line.

**5. Numbers (3.5.0).** Programs have been Remastered only since 3.0, so the reason a value
below zero was stored as 0 — parity with a death counter — is gone, and it was the least
TypeScript thing in the language.

| Type | Meaning |
| --- | --- |
| `number` | A signed 32-bit integer, −2 147 483 648 to 2 147 483 647, wrapping as `x \| 0` does. What everything is unless it says otherwise, and what every read of the game gives (`deaths()`, `minerals()`, `u.hp`). |
| `u32` | Unsigned, 0 to 4 294 967 295, wrapping as `x >>> 0` does. For bit masks, hashes, and a counter past two thousand million. |
| `u8`, `u16` | As they were: 0 to 255 / 65 535, stopping at either end when stored. |

- `+ − * & | ^ <<` are the same 32 bits whichever the type. The type decides five things: a
  comparison, `/` and `%` (towards zero for a `number`, as `Math.trunc(a / b)`; the remainder
  takes the dividend's sign, as in JavaScript), `>>` (keeps the sign of a `number`) against
  `>>>` (never does), `Math.min` / `Math.max`, and how a number is printed.
- **Mixing.** A whole-number constant that fits is either type. A `number` and a `u32` in one
  piece of arithmetic is a compile error that names `u32(x)` and `i32(x)`, which cost
  nothing; `x >>> 0` is `u32(x)`, as it is in JavaScript. A *comparison* between the two is
  not an error: it is computed exactly (a `number` below zero is smaller than any `u32`).
  Assigning one to a variable of the other keeps the bits, as the conversion functions do.
- **Where the game takes no number below zero** — a `u8` / `u16`, a unit's hit points, an
  action's amount, a cell of `stats()`, `random(n)`'s bound, a place on the map — a
  `number` below zero goes in as 0. The front end writes that as `max(v, 0)` where it cannot
  see that the value is never below zero (a read, a `u8`, `x & 0xff`, `x % n` of such), so
  the lowering's stores stay what they were.
- A signed comparison costs an addition a side (the top bit flipped); `==` and `!=` cost
  nothing extra, and neither does a comparison both of whose sides are never below zero.
- The one difference from a TypeScript `number` that is left: ours wraps at ±2³¹ where a
  double would go on. The README says so in a sentence; the simulator wraps the same way.
- IR 6: `VarDecl.unsigned`, the `>>>` operator, `unsigned` on `/` `%` `min` `max` and on a
  printed number, `unsigned: true | "left" | "right"` on a comparison. The flattening of `+`
  and `−` into two sides, which is how an unsigned cell was made to mean a difference, goes.

**6. Arrays and keyed tables (3.6.0).**

- `let hp = [0, 0, 0]`, `new Array(12).fill(3)`, `u8[]`, arrays of records (an array per
  field) and of units (three cells each, re-checked on use as a unit variable is). An index
  is a constant or a variable; `for…of`, `.length`, `indexOf`, `includes`, `fill` run within
  the frame. A per-player program has twelve of each, as it has of a variable.
- **An array that something pushes to grows** (decided 2026-09-18, when the user asked whether a declared capacity
  was "truly growable": it was not). `push`, `pop`, `length =`, `xs[xs.length] = v` make an array a handle on a block
  of a **heap** the programs share — 16 384 cells unless the map's script settings say otherwise (the workspace's
  Settings view; kept in the map, since the built map depends on it) — handed out in powers of two, a full block
  exchanged for one twice the size, a block given back kept for the next array of that size. A declaration first gives
  back what its handle held, so there is no collector and nothing to leak but one block a declaration. Out of memory:
  nothing is pushed, the game says so once, the simulator — which counts blocks as the game does — records a fault at
  the same push. (As first built the heap's top was the **stack**'s, growing down, for slice 8's saved frames;
  slice 8 gave the stack an array of its own instead — see there.) Locals stay cells of
  their own, because a condition or an action reaches a cell directly and a frame would make every access a read
  through a pointer. A read past the end is 0 and a write past it does nothing — in the game; the simulator says
  where, since it is always a mistake.
- **Keyed tables** (as built: keys are the library's branded ids — unit type, player, location, switch, weapon,
  upgrade, technology; a union of string literals is a record already, and a range of numbers an array).
  `Record<K, V>`, `Map<K, V>` and `Set<K>` are an array indexed by the key, so `price[u.type]` or
  `kills.get(CurrentPlayer)` with a key of the game is one read. `get`, `set`, `has`,
  `delete`, `clear`, `size` and `for…of` over the keys. `let s = {}` with fields added later
  is refused by TypeScript itself; its typed form, `Record<K, V>`, is this.
- A `Map<number, number>` over *any* key is a hash table, a few probes an operation. Not
  in this slice: it is the last part of slice 8½. A key that is a string of the
  game does not exist: there are no strings when the map is played.
- Left out of 3.6, and where each went (2026-09-19): an array inside a record and an array
  of arrays are a part of slice 8½, before the classes that need them; the simulator's
  faults shown in the Simulate view come with slice 7; arrays in the Explorer and the
  variables view are slice 9's, with the debugger that draws them anyway.

**7. Functions that are called (3.7.0).** Inlining stays the default because two things
need it: a function that sleeps (the program resumes inside it, through the lowering's own
jumps), and a parameter that reaches a field only a value known at build time can fill
(`spawn(P2, 4)`'s player). A function with neither, called from more than one place, becomes
one copy that is called; the source is the same either way and the end of the line says
which, as *unrolled ×3* does. What it buys is the size of the built map.

An array parameter stays what it is in 3.6, a name for the caller's array settled when the
script is built — so a function that takes one is called as one copy *an array passed*, the
way a template is: `total(hp)` and `total(shields)` are two copies, five calls of
`total(hp)` one. No array is reached through a value of the game in this slice (that comes
with slice 8½'s arrays inside things), and slice 8's `fill(grid, x, y)` recurses on the
same terms. The hint counts the copies.

**As built.** The decision is made while the body is walked, not before: a function is
inlined where it is first met — exactly as 3.6 did it, so a function used once builds into
what it always did — and when it is met again (at the same arrays) the compiler tries it as
a called function, every parameter a variable, and throws the attempt away with its
diagnostics if it sleeps, holds a `rose()` / `once()` or does not compile that way. When
the attempt holds, the first call is changed to match. After the walk, a function left
with one call that is still part of the program (the others were in a body that was thrown
away) is inlined there again. "More than one place" counts calls as they are emitted, so a
call in a loop unrolled three times is three. Only functions declared at the top of a
program's body, and `game()` functions, are called; one declared inside a block may use
that block's variables and stays inlined. IR 10: `Program.functions`, `Call.fn`. The
lowering makes each an `EUDFunc` of no arguments — parameters and results are cells of the
program, a row a player, so nothing of eudplib's own argument passing is used, which is
also what slice 8 needs to save a frame. Measured on ten calls of a fifteen-statement
function: 735 objects for 1462, a built map of 53 KB for 81 KB. Also with it: an array
written empty is one that grows, whoever pushes to it.

With it, the small thing 3.6 left: the simulator has recorded its **faults** since arrays
came — a read or a store past an end, a push that found no memory — and shows them nowhere.
The Simulate view lists them with their lines, and slice 8's stack overflow joins the same
list.

**8. Recursion (3.8.0).** A called function's parameters, result and locals are cells of
the program (slice 7 as built: an `EUDFunc` of no arguments, so none of eudplib's `_fargs` /
`_frets` are in play), and eudplib keeps one return address a function (`_nptr`) — so a call
from inside itself overwrites the outer one's cells and its way back. Slice 7 refuses such a
call for now ("recursion is not possible"), and never makes a function on a cycle a called
one; this slice is what lifts that. A function on a cycle of the call graph — only
those pay — pushes its parameters, locals, live temporaries and return address on one stack
array around the call and pops them after; mutual recursion is the same. `fib`, a flood
fill over an array, a walk of a tree of indices compile as written. Three rules show that
it is not a JavaScript engine: no `sleep()` in such a function (which is also why one stack
serves every player — it is empty between frames); a depth limit, with a line in the game
("stack overflow in fill, line 12"), the program stopped, and the same as a failed test in
the simulator; and its parameters are variables, so one that reaches a build-time-only
field is a compile error. Cost: a store and a load a saved cell a call — fine in the tens
and hundreds, slow for thousands of calls in a frame; the probe times it.

**As built (2026-09-19).** Two things were decided with the user before building, both for
the sake of a limit that means the same every time. **The limit is a depth, not a size**:
the panel's Settings has *Recursion depth* beside the heap's size — 1 024 calls unless the
map says otherwise, 16 to 65 536, kept in the map and carried in the IR file as `stack` —
because a count of cells moves whenever a function gains a local, and "1 024 calls deep"
is what the message in the game can say. **The stack is an array of its own**, not the top
of the heap as slice 6 left it: sharing the pool made an overflow depend on what the arrays
held at that moment, so the same recursion could pass in Simulate and fail in the game, or
fail in one frame and not the next. It is as many frames of the script's largest frame as
the depth allows, there only when something recurses (Settings says what that comes to, and
a build refuses more than a million cells); `reserve` / `release` went from the heap.

The rest is `compiler/recursion.ts` and *Recursion* in `docs/ir.md`. The front end makes a
function a called one the moment it meets it inside itself — no second call from outside is
needed — and says why when it cannot (it sleeps; a parameter reaches a build-time-only
field), where 3.7 only said the copies nest too deeply. The pass finds the cycles, takes
every call that may come back out of the expression it is in — a backend's temporaries are
in no frame — turning `?:`, `&&`, `||` and loop conditions that hold one into the `if`s they
mean, and writes on each what to keep: everything of the function's but the call's own
result. Liveness was left out on purpose: a frame is three or four cells for the functions
people write, and a wrong "dead" is a wrong number in the game. Arrays declared in a
recursive function become growing ones, so a frame keeps a handle and not the cells. The
lowering could not use `EUDFunc` (one return address, and not callable until its body is
whole): a recursive function is a scope of triggers ended by one whose next-trigger field
is the return address. The interpreter runs such a body apart from its caller, since a
thousand calls deep was ten thousand frames of JavaScript's stack and ended the browser's
before the map's. Refused: such a call inside a loop over units, and a function that calls
itself on every path. Along the way: a parameter given a plain value may be assigned in the
function, and `c ? 1 : 0` is a number. What the probe had to say was step J — `fib(20)`,
21 891 calls in one frame — since a frame brought back is some thirty triggers a cell.
Played 2026-09-19: basically no pause. So the stack stays the plain array it is; had it
been slow, it could have become variable triggers chained frame by frame, which brings a
frame back in a trigger a cell, and that is where to start if a script ever needs more.

**8½. The TypeScript people write (3.9.0).** Added 2026-09-19. As 3.6 stands, an array of a
program has `push`, `pop`, `fill`, `includes`, `indexOf`, `length` and `for…of`, and says so
when anything else is called; a spread inside an array literal is refused; the only
destructuring is `for (const [k, v] of m.entries())`; a class is fine outside `program()`,
where the script simply runs, and nothing inside it. Five parts, in this order, each of which
can ship alone (but the classes want the arrays inside things first):

- **Callbacks on arrays.** `forEach`, `some`, `every`, `find`, `findIndex`, `findLast`,
  `reduce`, `map`, `filter`, `sort` and `reverse`. The arrow — or the
  name of a function — is known when the script is built, so it is inlined into a loop over
  the cells, the way `includes` and `indexOf` already are functions of the compiler's own. A
  variable the arrow uses from outside is a cell of the program, so capturing costs nothing
  and there is no closure when the map is played. What that rules out is a function as a
  *value*: kept in a variable of the game, put in an array, returned. That is an error at the
  line, which says the arrow has to be written where it is used. `map` gives an array of the
  source's length (fixed if the source is, from the heap if not); `filter` always gives one
  that grows. `sort` wants its comparator — without one JavaScript sorts numbers as text,
  which nobody means, so the error names `(a, b) => a - b` — and is an insertion sort within
  the frame, with a hint over a few hundred cells. No `sleep()` in a callback; the message
  names `for…of`. A chain (`xs.filter(f).map(g)`) makes the array in the middle as written;
  fusing the two loops is for later, if a probe says it matters. The unit sets (`unitsOf(…)`
  and the rest) take `forEach`, `some`, `every`, `find` and `filter` the same way, since
  they are loops already.
- **Destructuring and spread.** `const { x, y } = mouse(p)`, `const [a, b] = pair`, in a
  parameter, with defaults, nested, and `[a, b] = [b, a]` through temporaries. `[...xs, v]`
  and `{ ...r, hp: 5 }` copy cell by cell; `...rest` in a parameter list is the arguments of
  each call site, which keeps that function inlined under slice 7's rule. All of it is the
  front end: the IR does not change.
- **Arrays inside things.** What 3.6 left out: a record with an array for a field
  (`{ hp: 5, path: [0, 0, 0] }`) and an array of arrays (`grid[y][x]`). Of a *fixed* shape
  both are the front end's alone: a fixed array in a record is more cells of the record, in
  an array of records one array of `length × n`; a grid whose two sizes are known is one
  array read at `y * w + x`, a row past either end reading 0 as a cell does. An inner array
  that *grows* is the new thing: its handle becomes a value kept in the cells of something
  else, so the IR gains an array reached through a handle the game holds, where until now
  every array was a declaration — and 3.6's rule of one block a declaration site no longer
  covers it. The rule that replaces it: what holds the handle owns the block; `pop`,
  `length =`, `clear` and declaring the outer again give the inner blocks back first, and a
  copy of a row (`const r = grid[y]`) is a reference, as it is in TypeScript, never a second
  owner. The map over any number, below, also keeps blocks that a value owns: the two are
  designed together.
- **Classes.** A class used inside a program is a record and its methods functions with the
  instance first; `new` declares the cells and runs the constructor; a field that is an
  array (`members: Unit[]`) is the part above. Whether a method is
  called or inlined is slice 7's rule, nothing of its own. Fields, methods, getters and
  setters, `static`, `readonly`, `private` and `#x`. `extends` works because the class of
  every value is known when the script is built — there is no type when the map is played —
  so `super`, an overridden method and `instanceof` are all settled at build time, and an
  array of a base class that holds two different subclasses is an error. An array of
  instances is the array of records 3.6 has.
- **A map over any number.** `Map<number, V>` and `Set<number>`: open addressing in a block
  of the heap, exchanged for one twice the size at three quarters full, as an array that
  grows is. A few probes an operation where a keyed table is one read, so the hint says
  which one a `Map` became. To decide when it is built: JavaScript iterates a `Map` in the
  order the keys went in, and keeping that costs a second block of keys — either pay it, or
  say in the README that the order is not kept.

What stays out, each with an error that says so: a string made while the map is played
(there are none), a function as a value, generators and `async` (an error already),
`try` / `throw`, and anything that needs a type at run time (`typeof x === …` on a value of
the game). One probe, `probes/callbacks.ts`: a sort of 256 cells timed in the frame, a
`filter` that grows past its first block, a grid filled and read back, an array of arrays
that grow with the outer one cut and the blocks found again, a class with an array of
instances, and a `Map` through two doublings.

Slice 1 is where the value is and where the risk is; nothing after it is hard once the IR
and the Python lowering exist. Slices 2–4 can be reordered by what the user wants to play
with first; 5 and 6 are what make it feel finished.

## Open decisions

- ~~The name for a unit on the map.~~ Decided 2026-09-17: `Unit` is the unit on the map,
  `UnitType` the table entry, renamed in slice 1 (no users yet, so no migration).
- ~~Signed numbers.~~ Decided 2026-09-18: `number` is signed, `u32` is the unsigned type
  beside it (slice 5).
- **Reads on the classic target.** Planned in slice 2 for parity, with cost hints; they
  could be Remastered-only if the decomposition cost makes them a trap.
- **Where the built map goes.** Beside the source as `<name>-eud.scx`, like Magenta. The
  alternative, writing the payload into the source map, would make the editor's own
  trigger list unreadable and is not recommended.
- ~~Functions as real calls.~~ Decided 2026-09-18: the compiler chooses (slice 7), and
  recursion follows (slice 8).
- ~~A map over any key.~~ Decided 2026-09-19: the last part of slice 8½, in the heap
  rather than with a capacity. What is left open is whether it keeps insertion order.
- **A limit on scans.** A loop over every unit on every frame in a per-player program is
  twelve scans a frame. A hint is planned; a hard cap is not.
- **The classic install on the Remastered target.** As of 2.6 every compile still runs the
  classic backend and Build still writes the classic block into the source map, so a script on
  the Remastered target must fit Classic's limits (death counters free, the forms of division
  Classic takes) and pays Classic's trigger counts. No limit can be lifted until that is
  optional. The choice: a Remastered script skips the classic block entirely (the source map
  then carries the script but no playable triggers of its own), or keeps a classic block only
  for what Classic can express and leaves the rest to the built map. To settle before slice 2,
  since reads and text cannot compile on Classic as they are.
- ~~Rate limiting the server.~~ There is no server: the build runs in the editor.
- ~~Offline.~~ Solved by the eudplib plugin: after its one-time download every build is
  local, on the desktop as on the web.

## Facts this plan leans on

- plugin-eudplib 0.2: `eudplib.build` service — `{ map, plugins, sources, files, options }`
  → `{ map, log, chkBytes, ms }`; plugin values single-line and 64 KB, sources 512 KB each,
  files 4 MB in all; one build per worker, about 2 s of Python start plus the build (a
  probe map builds in under 4 s in the browser); eudTurbo is one of the bundled plugins.
- Magenta's probes 5–11 (2026-09-14/15): what passed and what exits the game; MSQC key
  pulse is one frame, mouse base is 1-based, chatEvent wants exactly two `.*`, a scratch
  box location for orders, generated guards should be counters not switches.
- eudplib 0.81: `EUDVariable`, `EUDArray`, `EUDIf`/`EUDWhile`/`EUDSwitch`, `EUDFunc`,
  `f_dwread_epd`, `CUnit` fields, `EUDLoopNewUnit`, `f_simpleprint`, `PName`/`PColor`,
  `f_rand`, `f_mul`/`f_div`; no `CImage` export.
- TrigScript 2.5.1: the language reference in README, `Machine.sleep`'s state split,
  the two-phase allocation, the 137 tests, the workspace hooks.
