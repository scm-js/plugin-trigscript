# TrigScript

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It keeps TypeScript files inside the map and turns them into the
map's triggers.

The files are real TypeScript. They *run* when the script is applied, and every
`trigger()` call they make records one trigger of the map, so helpers, loops over the
players, arrays, classes and the standard library are all there. Those are ordinary
triggers and play on every version of the game.

Code inside `program(() => { … })` is the other half: it runs *in the game*, with
variables, arrays, texts, functions, classes, loops and `sleep`. A program is built into the map by
[eudplib](https://github.com/scm-js/plugin-eudplib), the compiler behind euddraft, when
you save, and a map with a program in it needs **StarCraft: Remastered**. A script that
only calls `trigger()` never involves eudplib at all.

The editor is Monaco with a `.d.ts` generated from the open map, so `locations.`,
`switches.`, `units.` and `players.` complete to what your map actually has, and a
location passed where a unit belongs is a type error before you build.

## Install

It ships with scmJS as a default plugin, on from the start: **Triggers ▸ TrigScript…** is
there as soon as a map is open, and Plugins ▸ Manage Plugins… turns it off. To run a
different version than the editor's, or a fork, paste

```
https://github.com/scm-js/plugin-trigscript
```

into **Manage Plugins…** and press **Add**. To pin a version, add a ref:
`github:scm-js/plugin-trigscript@v3.9.0`. The map maker's guide to the language is
scmJS's own [user guide](https://docs.scmjs.dev/guide/trigscript/); the reference below
is the full one.

Monaco, the TypeScript compiler and the standard library's declarations are not loaded
with the plugin's own files: the first time the editor opens they are fetched from
jsDelivr — Monaco and the library from this repository's own build of them (`dist/`),
TypeScript from the npm package's `lib/typescript.js` — so that first open needs a
connection. The copy compiled into the editor also fetches the release's own
`dist/compiler.js` for its compile worker. The browser keeps them all in its cache
afterwards, which is also what the desktop build relies on when it is offline.

## Use

**Triggers ▸ TrigScript…** opens the map's script in a workspace laid out the way VS Code
is, with the same keys where it has one:

| Where | What is there |
| --- | --- |
| **Activity bar**, at the far left | The Explorer and **Testing**; the icon of the view that is showing hides the sidebar. Testing carries the count of the tests that fail. |
| **Explorer**, at the left (Ctrl+B) | The script's files as a tree — `main.ts` is where the script starts; *New file* and *New folder* are on the section and on a folder's row, a row's pencil and bin rename and remove it, and its right-click menu has all of them — and under them the **programs** with the variables each keeps in the game. A click goes to the line. See [Folders](#folders). |
| **Tabs**, over the editor | One per open file; a file with problems is red, with their count, and two files of one name say their folder. Go to Definition on a name another file exports opens that file. |
| **Run controls**, right of the tabs | Play (F5), Simulate (Ctrl+F5), Apply (Ctrl+Shift+B), Pick from map, the switch between the window and the panel beside the map, and **…** for the rest. |
| **Panel**, under the editor (Ctrl+J) | **Problems** (Ctrl+Shift+M), **Output** (Ctrl+Shift+U) — what Apply, Play and the builds of the programs reported, with the build log — **Simulate**, **Test Results**, and **Settings** (Ctrl+,): what the map's author chose about how its programs are built, kept in the map beside the script so that it builds the same on any computer. It takes its room from the bottom, and only when asked for or when something failed. |
| **Status bar** | The problem count, the tests (`12 passed`, or `1 failed` in red; a click opens Testing), whether the script's triggers are in the map (a click applies it), the last build of the programs, the eudplib plugin's state, the cursor. |
| **Command palette** (F1 or Ctrl+Shift+P) | Every command above under *TrigScript:*, beside Monaco's own. |

Something that needs an answer — the triggers were edited outside the script, the map
renamed a location — is a notification in the corner, and an item of the status bar brings
it back after it was dismissed. Nothing that appears moves the text.

Edits are saved into the map as you type (the files are members of the archive, like a
sound), and Ctrl+S saves the map from inside the editor too.

There is no build step to remember. **Saving the map applies the script**, and so do
Tools ▸ Test Map and anything that exports the map: the script runs, its `trigger()`
records are written into the trigger list as one contiguous block (replacing the previous
block, or appended the first time), and its programs are built into the file being
written. The map you keep editing never holds eudplib's output; the editor stores the map
as you see it inside the saved file and gives that back when you open it. If the script
has an error, the map is still saved, with the triggers from the last script that
compiled, and a notice names the file and line.

**Apply** does the first half on demand, which is how to see the generated triggers in
the Trigger Editor without saving. **Play** applies, builds the map exactly as Save would
and hands it to Test Map: on the desktop the game starts with it, in a browser it goes
into the test folder you picked once. (It was called Test until 3.10, when the script's
own [tests](#tests) took the word; F5 and what it does are as they were.)

The Trigger Editor shows the script's triggers with a `script` badge and will not edit
them; *Open TrigScript* there jumps to the file and line. The Text Trigger Editor fences
them in comments. Hand-made triggers around the block are left alone, and inserting one
before the block just moves it, since the block is found by content rather than
position.

Editing a generated trigger from outside makes the block *stale*. The script remembers
every trigger it made on its own, so the editor can say how many are still the script's
and how many were changed, and the next Apply replaces the unchanged ones with the new
block and keeps the edited ones as hand-made triggers right after it — a wave system
edited in one trigger does not come back twice. *Append instead* on the notification leaves them
all in place and adds a fresh block after them, which is also what happens when the block
was moved or removed rather than edited. While a block is stale, saving does not apply
the script; the notice on Save says so. **Import the Map's Triggers** (under **…**) goes the other way,
rewriting the hand-made triggers as script in their existing order around the block, so
the whole list becomes script-generated.

**Simulate** runs the script for 480 frames — twenty seconds of the game at Fastest — in
a built-in interpreter and lists, in the panel's Simulate view, every action that ran,
with its frame and source line, plus each program variable's final value. First in the
list, marked as errors, is what a program did that is always a mistake and that the game
passes over in silence — a read or a store past an array's end, a push the heap had no room
for — and a recursion that ran out of stack, which stops the program here as it does in the
game — one row a line however often a loop came past it. The `trigger()` records run in a trigger
interpreter (death counters, switches, preserve, list order) and the programs in a
program interpreter that computes every number the way the game will, the two sharing one
world, so a program's `setDeaths` is seen by a trigger and the other way round. Reads
find what the simulation holds — death counters, the resources the programs themselves
set, the clock, the units — and 0 for what it does not (scores, the countdown); a printed
text shows with its numbers filled in and "Player 1" for a name.

**The simulated world has units.** It starts from the ones placed on the map, where they
were placed and with the hit points their type and their own settings give, inside the
map's locations as they are drawn. From there `createUnit` makes units at the location's
centre with the hit points and shields their type has — what a program wrote into
`stats()` before counts — and `createUnitWithProperties` applies the map's slot;
`giveUnits`, `moveUnit` (to the centre of where it goes), `killUnitAt`, `removeUnitAt`
with their counts, `modifyHitPoints` and its kin, `moveLocation` and `setInvincibility` do
what they say; `bring`, `command`, `commandTheMost` and the rest count what is there, and
a unit that is killed is a death of its type for its owner. A unit takes the lowest free
place of the game's unit table, and a place that is used again is not the place it was:
a `Map<Unit, V>` or a variable that kept the dead unit does not find the new one, as in
the game. **The players are the map's**: a program owned by a force or by All Players
runs once a frame for each of its human and computer players, each with their own
variables, a force in an action is each of its players and in a condition all of them
together, and every line of the list says whose it is — what several players did alike in
a frame is one line for all of them (`P1–P8 · …`).

What stays out, because it cannot be known without the game: nothing walks, nothing
fights, nothing is built over time, nothing is in the way of anything (a unit that is made
always finds room), energy starts at 0 unless a properties slot says otherwise, and no
unit dies but by the script — or, in a test, by the test. The order of the unit table is
the simulator's own rule, not the game's. The same world is what the script's
[tests](#tests) run in.

### Folders

A file's name may have folders in it, and the Explorer shows them as a tree: folders
first, `main.ts` first of the files. No folder means anything to TrigScript — `tests/` is
a habit, not a rule. The archive the files are kept in has no empty folder, so a folder is
there while a file is in it: *New Folder…* asks for the folder's name and goes straight
on to its first file's.

Renaming a file or a folder (the pencil; a folder before the name moves a file) and
dragging a row onto a folder, or onto the empty space under the tree for the top, **take
the imports along**: every `import … from "./path"` that named a file that moved, and the
moved files' own, are rewritten so the script compiles after as it did before, written
the way they were (with `.js`, as a folder with an `index.ts`, or bare). It is one change:
the notification that says what moved has an **Undo**. `main.ts` stays where it is.
Removing a folder asks once and says how many files go.

### Tests

A script can test itself. A test is ordinary TypeScript that runs in the editor's
simulator after every change that compiles — never in the game, and it costs the map
nothing. The names are [Vitest](https://vitest.dev)'s, imported from `"trigscript"`
(`test`, `it`, `describe`, `beforeEach`, `afterEach`, `test.only`, `test.skip`,
`test.each`, `expect`); they are not globals, so a script's own `test` is its own.

```ts
import { test, expect, program, createUnit, killUnitAt, countUnits, print, sleep, frames, P1, P2, units, locations } from "trigscript";

// A Marine on the beacon calls the next wave, each bigger than the last.
program(() => {
  let wave = 0;
  while (true) {
    if (countUnits(P1, units.TerranMarine, locations.Beacon) > 0) {
      wave += 1;
      createUnit(P2, units.ZergZergling, wave * 4, locations.Spawn);
      print(`Wave ${wave}`);
      killUnitAt(P1, units.TerranMarine, "All", locations.Beacon);
    }
    sleep(frames(1));
  }
}, { name: "waves" });

test("the second wave is bigger", (sim) => {
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.until(() => sim.program("waves").wave === 1);
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.until(() => sim.program("waves").wave === 2);
  expect(sim.count(P2, units.ZergZergling, locations.Spawn)).toBe(12);
  expect(sim).toHavePrinted("Wave 2");
});
```

**Where tests are.** In a file whose name ends in `.test.ts`, in any folder, or beside
what they test in any other file. The entry file runs first, so the programs are there;
then each test file runs, linked as any file is, so it can import the script's own
functions and test them as plain TypeScript. A test file is never part of the build:
importing one from a file that is not a test file is an error, and so is a `program()` or
a `trigger()` inside one. Test files are kept in the map with the rest of the source and
go when the source is left out of a copy.

**What a test gets.** `sim`, a world of its own for each test: [the simulated
world](#use) — the map's placed units, locations and players, the script's programs at
frame 0 and its `trigger()`s beside them — with `random()` seeded the same every time
(`sim.seed(n)` for another run). A test is not `async`: nothing in `sim` waits.

| `sim.` | |
| --- | --- |
| `place(player, type, at, count?)`, `kill(unit, by?)`, `remove(unit)`, `give(unit, to)`, `move(unit, to)` | What the test does to the world. `place` gives the units back; `kill` is what a fight is in a test, `by` the player whose kill it is. |
| `frames(n)`, `seconds(n)`, `until(() => …, most?)`, `frame` | Time. `until` fails the test when `most` frames pass first (2400 unless said), so no test hangs. |
| `press(key)`, `click(button)`, `type(line)`, `moveMouse(x, y)` | What a player does, found by the next frame; a player may be named last. |
| `count(player, type, at?)`, `units(filter?)`, `resources(player)`, `deaths(player, type)`, `kills(player, type)`, `switch(n)`, `location(n)` | The world read back. |
| `program(name?, player?)` | A program's variables by their names in the source: numbers, booleans, texts, arrays, a record as an object, a unit. The program by the `name` its options give it — `program(() => { … }, { name: "waves" })`, which the Explorer shows too — or by its place in the script from 0; of a per-player program, `player`'s. |
| `printed(player?)`, `events`, `faults` | What was shown, everything that happened by frame, and what went wrong. |

`expect` has `toBe`, `toEqual`, `not`, `toBeTruthy` / `toBeFalsy`, `toBeNull`,
`toBeDefined` / `toBeUndefined`, the four comparisons, `toContain`, `toHaveLength`,
`toMatch`, `toThrow`, and two of its own: `expect(sim).toHavePrinted(text | RegExp, { to?
})` and `expect(sim).toHaveFaulted(/depth/)`. **A fault the test did not ask for fails
it**: an index outside its array, the stack's depth, the heap full — what the game passes
over in silence. So does anything the test throws, and a frame past 100 000 statements.

**A test file, and the script's own functions as plain TypeScript.** What a test file
imports is the same module the map is built from, so a helper is tested without a world
and a program with one:

```ts
// main.ts
import { program, setResources, sleep, seconds, P1 } from "trigscript";

// Worked out when the script is built: the program reads the list.
export const bounty = (wave: number) => 50 + wave * 25;
const bounties = [0, 1, 2, 3, 4, 5, 6, 7].map(bounty);

program(() => {
  let wave = 0;
  while (wave < 7) {
    sleep(seconds(10));
    wave += 1;
    setResources(P1, "add", bounties[wave], "ore");
  }
}, { name: "income" });

// tests/income.test.ts
import { test, expect, describe, P1 } from "trigscript";
import { bounty } from "../main";

describe("the bounty", () => {
  test("grows by the wave", () => {
    expect(bounty(0)).toBe(50);
    expect(bounty(4)).toBe(150);
  });

  test("is paid every ten seconds", (sim) => {
    sim.seconds(9);
    expect(sim.resources(P1).ore).toBe(0);
    // Not sim.seconds(21): a sleep wakes on the frame after it ends, and until() need not know.
    sim.until(() => sim.program("income").wave === 3);
    expect(sim.resources(P1).ore).toBe(75 + 100 + 125);
    expect(sim.frame).toBeLessThan(31 * 24);
  });
});
```

**Keys and chat.** What a player does is said before the frame that finds it:

```ts
import { test, expect, program, keyPressed, chatted, setResources, print, sleep, frames, CurrentPlayer } from "trigscript";

program(() => {
  let shop = false;
  while (true) {
    if (keyPressed(CurrentPlayer, "F2")) { shop = !shop; print(shop ? "Shop open" : "Shop closed"); }
    const give = chatted(CurrentPlayer, "-give {n}");
    if (give && shop) setResources(CurrentPlayer, "add", give.n, "ore");
    sleep(frames(1));
  }
}, { name: "shop" });

test("-give pays only while the shop is open", (sim) => {
  sim.type("-give 100").frames(2);
  expect(sim.resources(0 as Player).ore).toBe(0);
  sim.press("F2").frames(1);
  expect(sim.program("shop").shop).toBe(true);
  sim.type("-give 100").frames(2);
  expect(sim.resources(0 as Player).ore).toBe(100);
  expect(sim.printed()).toEqual(["Shop open"]);
});
```

**Hooks, cases, and a fault that is asked for.** `beforeEach` runs on the test's own
world, `test.each` makes a test a row, and a fault the test expects is said so:

```ts
import { test, describe, beforeEach, expect, program, createUnit, sleep, frames, P1, units, locations, type Sim } from "trigscript";

program(() => {
  const queue = [3, 1, 2];
  let served = 0;
  let next = 0;
  while (true) {
    if (next < 4) { createUnit(P1, units.TerranMarine, queue[next], locations.Base); served += queue[next]; next += 1; }
    sleep(frames(1));
  }
}, { name: "barracks" });

describe("the barracks", () => {
  beforeEach((sim) => { sim.frames(1); });

  test.each([[0, 3], [1, 4], [2, 6]])("after %i more frames %i Marines stand at the base", (sim: Sim, more: number, marines: number) => {
    sim.frames(more);
    expect(sim.count(P1, units.TerranMarine, locations.Base)).toBe(marines);
  });

  test("the fourth order reads past the end of the queue, and the simulator says so", (sim) => {
    sim.frames(3);
    expect(sim).toHaveFaulted(/queue\[3\] is past the end/);
    expect(sim.units({ owner: P1 }).every((u) => u.hp === u.maxHp)).toBe(true);
  });
});
```

Without that last `toHaveFaulted` the test fails by itself, at the program's line: a read
past an array's end is 0 in the game and nobody is told, which is what makes it worth a
test's while.

Without the map's player settings (a test of the compiler, a map with no players set) the
world has one player; `test(name, { as: P2 }, (sim) => { … })` says which.

**In the workspace**, as VS Code does it:

- A mark in the margin beside every `test(` and `describe(`: not run, passed, failed,
  skipped. A click runs that one.
- A failure is said where it is — `expected 8, got 6` at the end of the failing
  `expect`'s line, the two values in full on hover — and a test that threw says what at
  the line that threw.
- The **Testing** view in the activity bar: folder, file, `describe`, test, each with its
  mark; run all, a file, a `describe` or one; run the failed ones; show only the failing.
- **Test Results** in the panel: the chosen test's message, what it printed, and what
  happened by frame, each a link to its line.
- Tests run again after every compile that goes through, a run dropped by the next
  keystroke. If all of them take more than two seconds, only the open file's run by
  themselves and the rest wait for *Run All*.
- A failing test is a warning in Problems at its line, and a build's log says so; an
  `only` left in is a warning too. **Settings ▸ Tests ▸ A failing test refuses the build**
  is kept in the map: with it on, Save, Test Map and an export say which test fails and
  write the map without applying the script again.
- Palette: *Run All Tests*, *Run Test at Cursor*, *Run Failed Tests*. *New File…* in a
  folder called `tests` proposes `<the open file>.test.ts` with one test written in it.

A script with programs shows, at the right of the status bar, whether the eudplib plugin
is running and whether its runtime is on this machine yet. The runtime — Pyodide, a
Python for the browser, and eudplib — is downloaded once, about 15 MB, after asking, the
first time a map with a program is saved; the desktop app and the container image carry
it. Every build after that runs on this machine and nothing about the map leaves it. The
status bar says how the last build went, Output keeps its log, and a failure that names a
line puts a marker on it. A save whose build fails still writes the map and its script,
with no programs in it — the status bar reads **Saved without its programs** until a save
that builds — and a build that went well reads **edited since** once the script changes,
because the programs in the saved file are then the older ones.

The files and a build manifest live in the map archive itself, under `trigscript\`
(`trigscript\main.ts`, `trigscript\build.json`, …) next to `staredit\scenario.chk`, so
they travel with the `.scx`. The editor's Save dialog lists them under the archive's
other files, with a tick each, so a copy for release can leave the source out.

## The language

A script has two halves. [Triggers](#triggers) are what the script records while it runs:
ordinary triggers, for every version of the game. [Programs](#programs) are code the game
itself runs, for StarCraft: Remastered. [Beside the map](#beside-the-map) is how the editor
and the map work together. [TrigScript beside TypeScript](#trigscript-beside-typescript)
is the comparison in one table. Programs are most of this reference:

| Section | What is in it |
| --- | --- |
| [Variables and records](#variables-and-records) | numbers, booleans, texts, units; a record is a variable a field |
| [Arrays](#arrays) | fixed and growing arrays, arrays of records, of units, of texts and of arrays; `map`, `filter`, `sort` and the rest; patterns and spread; copies |
| [Tables, a `Map` and a `Set`](#tables-a-map-and-a-set) | lists the script has, tables keyed by an id of the game, a `Map` and a `Set` over any number or over units |
| [Numbers and arithmetic](#numbers-and-arithmetic) | `number`, `u32`, `u16`, `u8`; the operators and where they differ from JavaScript |
| [Control flow and loops](#control-flow-and-loops) | loops run within the frame; the loop that never sleeps; unrolling |
| [Functions](#functions) | inlined or called, functions that call themselves, `game()` functions in other files |
| [Classes](#classes) | instances, methods, `extends`, arrays of instances, and what is settled when the script is built |
| [What is worked out when the script is applied](#what-is-worked-out-when-the-script-is-applied) | the line between the script and the program |
| [Reading the game](#reading-the-game) | every condition's quantity as a value; player facts |
| [Units](#units) | loops over units, picks, a unit's fields and what it can be told |
| [The game's tables](#the-games-tables) | `stats()`: costs, weapons, upgrades, colours |
| [Keys, the mouse and chat](#keys-the-mouse-and-chat) | `keyPressed`, `clicked`, `mouse`, `underMouse`, `chatted` |
| [Text](#text) | templates with values, `print`, `string` variables and their methods |
| [Time and edges](#time-and-edges) | `sleep`, `rose`, `once` |
| [Owners and per-player programs](#owners-and-per-player-programs) | one program for every player, `shared()` |
| [What a program does not have](#what-a-program-does-not-have) | the parts of TypeScript a program refuses, and what to write instead |

After those, *Coming from 3.9* and the sections under it say what each version changed.

### TrigScript beside TypeScript

Outside `program()` there is nothing to compare: the script *is* TypeScript, checked by the
TypeScript compiler and run as JavaScript when it is applied, so every feature of the
language and its standard library is there. The table is about the inside of a program,
where what is written has to become something the game can do. **Same** means it is
written and behaves as in TypeScript; what differs is said, and what is missing is refused
with a message, never passed over in silence.

| TypeScript | In a program | What is different |
| --- | --- | --- |
| Types: annotations, `interface`, `type`, unions of literals, tuples, generic functions, `as`, `!`, `satisfies` | Same | Erased, as in TypeScript. They also decide things: `u8` / `u16` / `u32` are widths, `Map<UnitType, V>` and `Map<number, V>` are kept differently. No type parameters on a class. |
| `let`, `const`, `var` | Same | A variable needs a first value (`let n = 0`). A `const` whose value the script already knows is worked out when the script is applied and costs the map nothing. |
| `number` | Different | A whole number of 32 bits, signed, that wraps at its ends as `x \| 0` does. No fractions, no `NaN`, no `Infinity`, no `bigint`. `/` is whole division towards zero and dividing by 0 gives 0. `u8`, `u16` (stop at their ends) and `u32` are added. |
| `boolean` | Same | Assigned with `=` only: no `\|\|=`, `&&=`. |
| `string` | Mostly | A value with no length to declare. `length`, `s[i]` and `slice` count characters (code points), where JavaScript counts UTF-16 units: they differ only past U+FFFF. A made text holds 1 023 bytes. The methods are a subset: no `split`, `replace`, `trim`, `toUpperCase`, `parseInt`, regular expressions. |
| `null`, `undefined` | Units only | `Unit \| null` is real (`first(…)`, `if (u)`, `u?.kill()`). A number, a boolean or a text is never either: where JavaScript would give `undefined` — `pop()`, `find()`, `get()`, `at()` — say what it is then (`xs.pop() ?? 0`). No optional fields or parameters (`y?: number`); a parameter's default (`y = 1`) is there. |
| Operators: `+ - * / %`, comparisons, `&&` `\|\|` `!`, `c ? a : b`, `& \| ^ << >> >>>`, `??`, `?.`, `++` `--`, the compound assignments, the comma | Same | `==` and `===` are one thing, since nothing is coerced. A shift by 32 or more leaves nothing, where JavaScript shifts by the remainder. Missing: `**`, `typeof`, `in`, `delete`. |
| `if`, `while`, `do`, `for`, `for…of`, `switch`, `break`, `continue` | Same | A loop runs all its rounds within one frame of the game, so one that never ends must `sleep()` on every path; `while (true)` left only by a `break` needs the sleep too. A `for` over bounds the script knows is unrolled. No `for…in`, no labels. |
| Functions: declarations, parameters by value, defaults, rest parameters, recursion, generics | Same | The compiler inlines a function or calls it; the meaning is the same. One that calls itself cannot `sleep()` and has a depth limit. A function declared inside another does not see the outer one's locals (it sees the program's). It returns a number, a boolean, a text, a unit or an instance — not a record or an array it made. |
| Arrow functions, closures, functions as values | Callbacks only | An arrow is written where a method takes it (`xs.map((x) => x + bonus)`), and sees every variable in reach. It cannot be kept: not in a variable, an array, a field or a return value. |
| Object literals | Records | A variable a field: nested, passed by reference, spread, taken apart by patterns. The shape is fixed: no `p[key]` with a key that varies, no methods or getters on a literal (a class has them), no `Object.keys`. |
| Destructuring and spread | Same | `...rest` takes the tail of an array of numbers or booleans. `f(...xs)` wants a length the script knows, as TypeScript itself does. |
| Arrays | Mostly | Fixed or growing, of numbers, booleans, texts, units, records, instances and arrays. There: `push`, `pop`, `length`, `fill`, `includes`, `indexOf`, `forEach`, `map`, `filter`, `reduce`, `some`, `every`, `find`…, `sort`, `reverse`, `slice`, `concat`, `toSorted`, `toReversed`, `join` of texts, `Array.from`. Missing: `shift`, `unshift`, `splice`, `at`, `lastIndexOf`, `flat`; `map` into texts or records. `sort` wants its function. An index past the end reads 0 and stores nothing. `const b = a` is not a second name for an array; a row of rows that grow is a *place* in the outer array, and `filter` of rows copies them. |
| Classes: fields, constructor, parameter properties, methods, `get` / `set`, `static`, `private` / `#x`, `readonly`, `extends`, `super`, `abstract`, `implements`, `instanceof` | Same | Declared inside the program. The class of every instance is settled when the script is applied, so `instanceof` is answered then, an array of instances holds one class, and a function gives back an instance only when every `return` gives the same one. No type parameters, static blocks, decorators or class expressions. |
| `Map`, `Set` | Mostly | Keys are numbers, units, or ids of the game; values are numbers or booleans. Order is JavaScript's — the order the keys went in — except for a table keyed by ids of the game, which goes by id. No chained `set()`. |
| `enum` | Outside | Declared above the program, its members are numbers a program can use. Not declared inside one. |
| `try` / `catch` / `throw` | Missing | The game has no exceptions. What is always a mistake — an index past the end, a full heap, a stack overflow — is said in the game in red, or listed by Simulate. |
| `async` / `await`, promises, generators, timers | Missing | `sleep()` is how a program waits: it gives the frame back and carries on later, and may stand anywhere but in a function that calls itself or a loop over units. Something on its own clock is another `program()`. |
| Modules | Same | `import` between the script's files and from `"trigscript"`; nothing from npm. A function another file's program calls is made with `game()`. |
| The standard library | A little | `Math.min`, `Math.max`, `Math.abs` (and the rounding ones, which change nothing), `String(n)`, `n.toString()`, `Array.from`, `new Array(n).fill(v)`. For `console.log` there is `print()`, for `Math.random()` there is `random(n)`. No `JSON`, `Date`, `RegExp`, `Object.*`, and no `Math.sqrt` or `**` on a variable. |
| — | Added | What TypeScript has no word for: `sleep`, `rose` and `once`, reads of the game (`minerals(p)`), `Unit` objects and loops over units, `stats()`, `keyPressed` / `clicked` / `mouse` / `chatted`, `shared()`, per-player programs. |

The sections below say each of these in full, and [What a program does not
have](#what-a-program-does-not-have) lists what to write instead of what is missing.

### Triggers

A script is a TypeScript module. The library is available as globals and as the module
`"trigscript"`, so both of these work:

```ts
import { trigger, bring, displayText, preserve, units, locations, P1, AllPlayers, CurrentPlayer } from "trigscript";

trigger(AllPlayers, [
  bring(CurrentPlayer, units.AnyUnit, locations["Beacon Alpha"], ">=", 1),
], [
  displayText("You found it!"),
  preserve(),
]);
```

```ts
for (const p of [P1, P2, P3]) {
  trigger(p, [deaths(p, units.TerranMarine, ">=", 10)], [setDeaths(p, units.TerranMarine, "set", 0), displayText("Ten lost.")]);
}
```

`trigger(players, conditions, actions, options?)` records one trigger. `players` is a
player or an array of them; `conditions` and `actions` are arrays of what the condition
and action functions return — nested arrays are flattened and `false` / `null` /
`undefined` entries are skipped, so a helper can return a list and a condition can be
`enabled && bring(…)`. The options are the execution flags by name: `{ preserve: true }`
is the same as a `preserve()` action; `disabled`, `ignoreGameEnd` and the rest are there
too.

Every condition and action is a function named after StarEdit's, in camel case:
`bring`, `deaths`, `switchIs` (the one whose real name is a reserved word),
`commandTheMostAt`, `createUnit`, `displayText`, `setDeaths`, `runAiScript`, `wait`,
`victory`. Arguments come in the order the classic editor shows them, and the enumerated
ones take short words — `">="`, `"<="`, `"=="`; `"set"`, `"add"`, `"subtract"`; `"set"`,
`"clear"`, `"toggle"`, `"randomize"` — with StarEdit's own labels (`"At least"`) accepted
as well. `displayText(text)` always displays; `displayText(text, false)` does not. A
count is a number or `"All"`. `not(condition)` is the opposite of a condition where one
condition can say it: `not(bring(…, ">=", 1))` is "at most 0", a switch test flips,
`always()` becomes `never()`; "not exactly 3" has no single condition and throws.

A condition is a *value* here — the game tests it later — so `if (bring(…))` outside a
program tests whether the object exists, and `bring(…) && deaths(…)` is just
`deaths(…)`. TypeScript allows both; the compiler reports them as errors and says
where the test belongs: in a trigger's conditions list, or in an `if` inside `program()`.

Because the script runs, anything TypeScript can do at build time is fair game: a class
per base, a table of waves, `Array.from`, template strings, `Math`, a function that
returns the ten triggers a shop needs. Files import each other with `import { x } from
"./name"`; nothing else can be imported. The library is `import { … } from
"trigscript"`, `import * as ts from "trigscript"` for `ts.trigger(…)`, or simply the
globals. What the script records is what the map gets, and the order of `trigger()`
calls is the order of the triggers.

Names come from the map. `identifier()` derives an identifier from each display name
(`Terran Marine` becomes `units.TerranMarine`), and the display name itself still works
as an index (`units["Terran Marine"]`), as do custom names the map sets, force names
under `players`, and switch names under `switches`. `P1` … `P12`, `CurrentPlayer` and
`AllPlayers` are constants; the rest of the player groups are under `players`. Raw
numbers are accepted wherever a name is, which is how you reach EUD players and
out-of-range unit ids. Types the tables do not know can be written as `condition(type, …)`
or `action(type, …)`, and `memory(address, comparison, value)` / `setMemory(address,
modifier, value)` are the standard `deaths`-at-`EPD(address)` forms.

### Beside the map

The editor opens two ways: Triggers ▸ TrigScript… is a full-screen window, and
*Beside the map* (an icon right of the tabs, or Triggers ▸ TrigScript beside the map) is a
panel over the map that blocks nothing — drag it by its title, resize it by its corner,
and keep placing units while the code sits next to them. Beside the map:

- **Ctrl+click** on `locations.Beacon` scrolls the map to the location and flashes it;
  hovering the name says where it is and how big.
- **Pick from map** (the target icon, or the editor's right-click menu): click a location
  or a unit on the map, and its name (`locations.Beacon`, `units.TerranMarine`) lands at
  the cursor. From the window, it first moves the editor beside the map.
- When the map renames a location or a switch the script mentions — its custom name,
  for a switch — a notification offers to **update the references** in every file. The
  references are the compiler's, resolved like the code: `locations["Beacon"]`, an alias
  from `import { locations as L }` and `ts.locations.Beacon` follow the rename; a
  comment, a string, or a parameter that happens to be called `locations` is left alone.

### Programs

```ts
const spawnAt = locations.Spawn;
function burst(n: number) { return [createUnit(P2, units.ZergZergling, n, spawnAt), displayText(`Wave of ${n}`)]; }

program(() => {
  let wave = 0;
  let alarm = false;

  function next() {
    burst(4);
    wave += 1;
  }

  while (true) {
    if (bring(P1, units.AnyUnit, locations.Beacon, ">=", 1) && !alarm) {
      alarm = true;
      displayText("They are coming.");
    }
    if (alarm) next();
    if (wave >= 10 || deaths(P1, units.TerranMarine, ">=", 50)) defeat();
    sleep(seconds(2));
  }
}, { owner: P1 });
```

Everything inside the arrow runs in the game. **A program is a coroutine the game
resumes every frame.** Its body runs from where it left off until it reaches a `sleep()`
or its end, all within that frame; the next frame it goes on from there. A body that ends
stops for good. `while (true) { …; sleep(frames(1)); }` is therefore a game loop running
once per frame, and `sleep(seconds(2))` at its end makes it one every two seconds.

#### Variables and records

**Variables** hold numbers, booleans, texts (*A text is a value*, below) and units of the
game (*Units on the map are objects*, below). A `let p = { lives: 3, gold: 0, alive: true }`
is a **record**: a variable per field (`p.lives -= 1`, `if (p.alive)`), nested ones
included, declared types (`let p: { n: u8 } = { n: 0 }`, an `interface`, a `type`)
honoured, and a record passed to a function reaches it by reference. They live in the game's memory while the map is
played and cost the map nothing: no death counters, no switches, no triggers in the list.

#### Arrays

**Arrays** hold numbers, booleans, texts, units, records, instances of a class, or other
arrays; each kind has its paragraph below. `let hp = [10, 20, 30]`, `let xs = [a, a * 2, 0]`,
`let lives: u8[] = new Array(12).fill(3)`; an index is a constant or a variable
(`hp[i] += 7`, `hp[i + 1]++`), `.length`, `for (const x of xs)` with `break` and `continue`
(`x` is a copy of the cell, as in TypeScript), `fill(v)`, `includes(v)` and `indexOf(v)`
(−1 when there is none) all run within the frame. A `const` array the body stores into is an
array of the program like a `let` one. Cells keep their type: a `u8[]` stops at both ends, a
`number[]` goes below zero. An array handed to a function is the same array. In a program of
every player each player has one; `shared([0, 0, 0])` is one for everybody.

A constant index past the end is a compile error. A variable one reads 0 and stores nothing
— in the game, without a word; Simulate says where it happened, since it is always a mistake.

**An array that something pushes to grows.** `const queue: number[] = []; queue.push(x)`,
`queue.pop()` (`?? 0` or `!`, since TypeScript has a pop of an empty array undefined: here it
is 0), `queue.length`, `queue.length = 0`, `queue[queue.length] = x` — also when the push is in
a function the array was handed to. There is no size to declare. The cells come from one pool
the map's programs share, 16 384 of them unless **Settings** says otherwise: a block that is
full is exchanged for one twice the size, and a block given back serves the next array that
wants that size. An array declared again — in a loop, in a function called again — first gives
back the block it held, so a scratch array made every round holds one block at a time. A single
array can reach between a quarter and a half of the pool (the block after 4 096 cells is
8 192). When the pool has no block left, nothing more is pushed and the game says so once, in
red; Simulate counts blocks as the game does, so it runs out at the same push. `let xs = []`
wants its type said (`let xs: number[] = []`).

```ts
program(() => {
  const hp = [10, 20, 30];                  // three cells, for good
  const queue: number[] = [];               // starts empty and grows as it is pushed to
  let total = 0;
  for (const h of hp) total += h;
  for (let i = 0; i < hp.length; i++) if (hp[i] > 15) queue.push(i);
  while (queue.length > 0) {
    const i = queue.pop()!;
    hp[i] -= 5;
    print(`cell ${i} is now ${hp[i]} of ${total}`);
  }
});
```

**An array of records** is an array a field, all growing together: `let waves = [{ count: 4,
delay: 2 }]`, `waves[i].count += 1`, `waves.push({ count: 6, delay: 1 })`, `waves.pop()`,
`waves[i] = { … }`. A record taken out of one — `const w = waves[i]`, the variable of
`for (const w of waves)`, a record handed to a function — is the array's own, as an object of
a TypeScript array is a reference: `w.delay = 9` writes the array, and `w` stays the record
it was when `i` moves on. A field is a number or a boolean (with its declared width), a
unit, a text, an array of numbers, booleans or units, or a record of the same: `let squads =
[{ id: 1, name: "red", leader: first({ owner: P1 }), seen: [] as number[], at: { x: 0, y: 0
} }]`, `squads[i].seen.push(4)`, `squads[i].name += "!"`. An array in a row is always one
that grows, and the row owns it, as it owns a text that was made: `pop()`, `length =`,
`squads[i] = { … }` and declaring the array again give the blocks back, and `filter` gives
its rows arrays and texts of their own. The line's hint says how many cells a row comes to.

**An array of units** keeps the units themselves: `const squad: Unit[] = []`,
`squad.push(u)`, `squad[i].hp = 10`, `squad.pop()?.kill()`, `for (const u of squad)`,
`squad.length = 0`. It may be kept across a `sleep()`, which a loop over the game's units may
not: a unit of it that has died since reads 0, takes no order, and is false in an `if`, as any
kept unit is.

**The methods that take a function** work on all three kinds of array, and the function is
written as it is in TypeScript: `hp.forEach((h, i) => { total += h * i; })`,
`hp.some((h) => h > 20)`, `every`, `findIndex` and `findLastIndex` (−1 when nothing is found),
`hp.reduce((sum, h) => sum + h, 0)`, `hp.map((h) => h * 2)`, `hp.filter((h) => h > 7)`,
`hp.sort((a, b) => a - b)` and `hp.reverse()`, and chains of them —
`cells.filter((c) => c < 20).map((c) => c + 1).reduce((s, c) => s + c, 0)`. The function is
handed the item, its place and the array, as JavaScript hands them. It is copied into the
loop the method becomes, so a variable it uses from outside is simply that variable, it costs
nothing to write one, and the map holds no function. What follows from that is the one thing
that does not work: a function cannot be *kept* — in a variable, in an array, as something a
function returns. Write it where it is used, or give the name of one declared with `function`
in the program (`hp.forEach(report)`).

```ts
program(() => {
  const scores = [12, 7, 30, 7];
  let bonus = 5;
  const raised = scores.map((s) => s + bonus);
  const best = raised.reduce((m, s) => Math.max(m, s), 0);
  const below = raised.filter((s) => s < best);
  below.sort((a, b) => b - a);
  print(`best ${best}, ${below.length} below it, the next is ${below[0]}`);   // best 35, 3 below it, the next is 17
});
```

- `map` makes an array of numbers or of booleans: of the same fixed length when what it runs
  over is fixed, one that grows when that grows. `filter` always makes one that grows, of
  whatever it ran over — rows of an array of records stay whole, units stay units. Both are
  made again each time the line runs and give their block back first, as any declaration does.
  A chain makes the arrays in the middle as written. Neither can stand in the condition of a
  loop, which is worked out again every turn: make the array before the loop, or inside it.
- `find` and `findLast` give a unit or none from an array of units. Of numbers they would give
  `undefined` when nothing is found, which does not exist when the map is played, so say what
  it is then — `hp.find((h) => h > 20) ?? -1` — or take the place with `findIndex`; of records,
  take the place and read `waves[i]`.
- `reduce` wants what it starts from; without it JavaScript throws on an empty array.
- `sort` wants its function: without one JavaScript sorts numbers as text, 10 before 9. It
  sorts where the array stands, within the frame, keeping equals in the order they were in,
  and gives the same array back. A list nearly in order costs a pass; one in no order its
  length squared — dozens of items are nothing, hundreds every frame will be felt, and the end
  of the line says *sorts in the frame*. Records are sorted row by row
  (`waves.sort((a, b) => a.delay - b.delay)`), units too (`squad.sort((a, b) => a.hp - b.hp)`).
- No `sleep()` inside such a function: the method is one loop within the frame. A `for…of`
  over the same array can sleep between its turns.

The units of the game take them as well: `unitsOf(P1).forEach((u) => u.heal(10))`, `some`,
`every`, `reduce`, `map`, `find` (a unit or null) and `filter`, which is how to keep them —
`const weak = unitsOf(P1, { type: units.TerranMarine }).filter((u) => u.hp < 20)` is an array
of units, which can be sorted and kept across a `sleep()`. They come in no order, so there is
no place and no `sort` until they are in an array.

```ts
program(() => {
  const squad = unitsOf(P1, { type: units.TerranMarine }).filter((u) => u.hp < 20);
  squad.sort((a, b) => a.hp - b.hp);
  for (const u of squad) { u.heal(10); sleep(frames(4)); }    // the weakest first, one every four frames
});
```

A list the script made takes them too, the loop written out turn by turn as `for…of` over
one is: `waves.forEach((w) => createUnit(P2, w.unit, w.count, at))` is one Create Unit a
wave, and `prices.map((p) => p + bonus)` with `bonus` a variable is an array of the program.
With nothing of the program in it — `[1, 2, 3].map((x) => x * 2)` — it is still the script's
own arithmetic, done when the script is built.

`new Array(12).fill(0)` is an array of numbers; for booleans, `new Array<boolean>(12).fill(false)`.

**Patterns and spread** are TypeScript's. `const { x, y } = mouse(P1)`,
`const { count, delay: wait } = waves[i]`, `const [first, , third = 0, ...tail] = xs`, nested
as deep as they are written, in a declaration, in the variable of a `for…of`
(`for (const { count, delay } of waves)`), and in a parameter — of a function
(`function len({ x, y }: Point)`) or of one given to a method
(`waves.forEach(({ count }) => …)`). A name in a pattern is a variable of its own holding a
copy, as a number is copied in JavaScript: changing `x` does not change `p.x`. A record or
an array *inside* what is taken apart stays itself, as an object does — `const [a, b] = waves`
are two rows of `waves`. A default is for what is not there — a field the record has not
got, a place past a fixed array's end; a name with neither is an error, since it would be
undefined. `...tail` is an array of its own, which grows if what it was taken from does.

Assigned, a pattern is a swap: `[a, b] = [b, a]`, `[hp[i], hp[j]] = [hp[j], hp[i]]`,
`({ x: q.x, y: q.y } = p)` — every value is read before any is stored. `[...xs, v, ...ys]`
copies the cells into a new array (fixed when all of them are, else one that grows), and
`{ ...p, y: 9 }` the fields into a new record or a row — `waves.push({ ...w, count: 9 })`.
`function sum(...ns: number[])` takes the rest of a call's arguments as an array made at
that call; such a function is copied into each call rather than called, since every call
has its own number of them. An array is handed to a function as itself (`total(xs)`), not
spread into its arguments.

```ts
program(() => {
  const waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }];
  let a = 1;
  let b = 2;
  [a, b] = [b, a];
  for (const { count, delay } of waves) print(`${count} every ${delay}`);
  const xs = [a, b, 3];
  const [head, ...rest] = xs;
  waves.push({ ...waves[0], count: 9 });
  print(`${head}, then ${rest.length} more; ${waves.length} waves`);   // 2, then 2 more; 3 waves
});
```

**Arrays inside arrays, and inside records.** `let grid = [[0, 0, 0], [0, 0, 0]]`,
`new Array(8).fill(0).map(() => new Array(8).fill(0))`, `Array.from({ length: h }, () => …)`,
three deep if you like: `grid[y][x]`, `grid[y][x] += 1`, `grid.length`, `grid[y].length`,
`for (const row of grid)`, `grid.forEach((row, y) => …)`, `some`, `every`, `findIndex`,
`reduce`, `map`. A row is an array like any other — `const row = grid[y]` is the grid's own
cells, as it is in TypeScript, and takes `fill`, `sort`, `includes`, a function's parameter,
a pattern (`const [top, bottom] = grid`); `grid[y] = [a, b, c]` sets one. So does an array
in a record: `let p = { hp: 5, path: [0, 0, 0], seen: [] as number[] }`, `p.path[i]`,
`p.seen.push(v)`.

How it is kept is the compiler's choice, and the end of the line says which:

- **Every row the same length, and no row growing**, is *one flat array*, read at
  `y * width + x` — no dearer than an array. A row past its own end reads 0 and stores
  nothing, so it never reaches into the next row. The outer array may still grow by whole
  rows: `const path: number[][] = []; path.push([x, y]); path.pop(); path.length = 0`.
- **Rows of different lengths, or a row something pushes to** (`buckets[i].push(v)`), is
  *rows that grow*: each row a block of the heap of its own, found through the outer array —
  a few more triggers a read than a flat one. The outer array grows too
  (`buckets.push([1, 2], [])`, `buckets.pop()`, `buckets.length = 3`), a row can be given
  anew (`buckets[i] = [a, b]`, or an array, whose cells are copied), and a row that goes —
  popped, cut off, the whole declared again in a loop — gives its block back first, so
  nothing leaks. Two deep; not three.

One thing is not JavaScript's: a row of rows that grow kept in a `const` is that *place* in
the outer array, not the array that was there. `const last = buckets[2]; buckets.pop();
buckets.push([7])` leaves `last` reading `[7]`, where JavaScript would still have the row
that was popped. `sort`, `reverse` and `filter` work on an array of arrays, of either kind —
`points.sort((a, b) => a[0] - b[0])`, `buckets.filter((r) => r.length > 2)` — and `filter`
gives rows of their own, as it does of records: what is changed through the rows it made is
not changed in the rows it took them from, which is the one way it is not JavaScript's.

**Copies.** `xs.slice(1)`, `xs.slice(-2)`, `xs.concat(ys, 7, [a, b])`, `xs.toSorted(f)`,
`xs.toReversed()` and `Array.from(xs)` give a new array that grows, of numbers, booleans or
units, from an array of the program or a list the script has; `[...m.keys()]`,
`Array.from(m.values())` and `[...set]` give a `Map`'s or a `Set`'s as one. `f(...xs)` spreads
an array into a call's arguments when the script knows how many there are — a list it has, or
an array TypeScript knows as a tuple (`let box: [number, number, number] = [1, 1, 1]`), which
is what TypeScript itself asks of a spread argument; an array that grows is handed over as
itself.

**An array of texts** a program fills is `const names: string[] = []`: `push`, `pop()` (its
value too: `names.pop() ?? ""`), `names[i]` read, written and added to, `length` and `length
=`, `for…of`, `forEach`, `includes`, `indexOf`, `join`. Each text is what a text in a row
is, and the array gives a text's block back when it is replaced, popped or cut off. In a
variable, a record's field or a class's, or handed to a function; not inside a row of an
array of records, where a text is a field of its own.

```ts
program(() => {
  const log: string[] = [];
  let wave = 3;
  log.push(`wave ${wave} began`);
  log.push("boss down");
  print(log.join(" / "));                   // wave 3 began / boss down
});
```

#### Tables, a `Map` and a `Set`

**A list the script made is a table a program can look things up in.** `const price = [50,
100, 150]` outside the program, `price[level]` inside it, is in the map once, however often
it is read, and cannot be written. A list of records is a table a field — the wave table:
`const waves = [{ unit: units.ZergZergling, count: 4 }, …]` above the program,
`createUnit(P2, waves[wave].unit, waves[wave].count, at)` inside it.

**Tables keyed by an id of the game** — a unit type, a player, a location, a switch, a weapon,
an upgrade, a technology — are arrays with a cell for every id, so a key of the game is one
read:

```ts
const bounty: Record<UnitType, number> = { [units.ZergZergling]: 5, [units.ZergHydralisk]: 15 };

program(() => {
  const score: Record<Player, number> = { [P1]: 0 };
  const lost = new Map<UnitType, number>();
  const seen = new Set<UnitType>();
  for (const u of unitsOf(P2)) {
    if (u.hp < 10) {
      score[u.owner] += bounty[u.type];
      lost.set(u.type, (lost.get(u.type) ?? 0) + 1);
      seen.add(u.type);
      u.kill();
    }
  }
});
```

A `Record` is read and written by its keys and reads 0 where nothing was stored; a `Map` has
`get` (`?? d` for a key never set), `set`, `has`, `delete`, `clear` and `size`; a `Set` has
`add`, `has`, `delete`, `clear` and `size`. `for (const [key, value] of lost)`, `for (const key
of seen)`, `lost.keys()` and `lost.values()` go through the keys that are there, in the order
of the ids — every id is looked at, so the editor marks the line with how many. One made inside the program is the program's, to
be written while the map is played; one made outside it is the script's, and a program only
looks things up in it. `CurrentPlayer` is not a key — in a program of every player a plain
variable is already one per player.

**A `Map` and a `Set` over any number** are for keys that are no id of the game: a place
packed into one number, a unit's id of your own, a score. `new Map<number, number>()`,
`new Map<number, boolean>()`, `new Set<number>()`, empty or with what they start with
(`new Map([[1, 10], [k, 20]])`), in a variable, a record's field or a class's.

```ts
program(() => {
  const owner = new Map<number, number>();            // a tile, as x + y * 256, to who holds it
  const claimed = new Set<number>();
  for (const u of unitsOf(P1, { type: units.TerranMarine })) {
    const tile = (u.x >> 5) + (u.y >> 5) * 256;
    if (!claimed.has(tile)) { claimed.add(tile); owner.set(tile, 1); }
  }
  for (const [tile, who] of owner) if (who == 1) print(`tile ${tile % 256}, ${tile >> 8}`);
});
```

`get` (`?? d` for a key it has not got; without it such a key reads 0 or false), `set`,
`has`, `delete` (true when the key was there), `clear`, `size`, `forEach`, and `for…of` over
the table, its `keys()`, `values()` or `entries()`. **They go through their keys in the
order the keys went in, as JavaScript does**: a key set again stays where it was, one
deleted and set again goes to the end, what the loop's body adds is reached and what it
deletes is not. The tests run the same lines in JavaScript and compare.

What it costs is that a key is *looked for* — a few steps to find, set or delete one, where a
table keyed by ids of the game is one read, so where the keys are ids of the game, say so
(`Map<UnitType, number>`) — and that it lives in the memory the programs' arrays share: it
starts at eight slots and doubles as it fills, and deleted entries go when it is next made
again. The line's hint says which kind a `Map` became. Values are numbers or booleans; for
anything more keep the place of a row of an array of records. Left out: a text for a key,
and `m.set(…).set(…)` in a chain.

**A `Map` or a `Set` keyed by units** is the same table: `const cooldown = new Map<Unit,
number>()`, `cooldown.set(u, 72)`, `(cooldown.get(u) ?? 0)`, `new Set<Unit>()` for the units
already dealt with. A unit is found by where it is together with the byte that tells one
unit of that place from the next, so a unit made where a dead one was is *not* the dead
one's key, and reads as absent. A unit that died stays an entry until it is deleted; in a
loop (`for (const [u, n] of cooldown)`) it reads as no unit, which is where to delete it.
`Map<Unit | null, number>` is how TypeScript lets `first(…)` be a key without an `if`.

#### Numbers and arithmetic

**Numbers** are whole, and a `number` is what it is in TypeScript as far as 32 bits go:
signed, from −2 147 483 648 to 2 147 483 647. `a - b` is below zero when `b` is larger,
`while (i >= 0) { …; i--; }` ends, `-x`, `Math.abs`, `Math.min`, `Math.max` and
`clamp(x, lo, hi)` mean what they say, and a number below zero is printed with its minus
sign. The one difference from TypeScript is at the ends: a `number` wraps there, as
`x | 0` does — 2 147 483 647 + 1 is −2 147 483 648 — where TypeScript's would go on.

Beside it there are three types for a number that is never below zero:

| Type | Holds | At its ends |
| --- | --- | --- |
| `number` | −2 147 483 648 … 2 147 483 647 | wraps, as `x \| 0` |
| `u32` | 0 … 4 294 967 295 | wraps, as `x >>> 0` |
| `u16` | 0 … 65 535 | stops: below zero is 0, above is 65 535 |
| `u8` | 0 … 255 | stops: below zero is 0, above is 255 |

`let lives: u8 = 3` stops at its ends *after* the whole sum, never between its parts. A
`u32` is for bit masks, hashes and a count past two thousand million; everything the game
is asked — `minerals()`, `deaths()`, `u.hp` — is a `number`. A constant its variable
cannot hold is a compile error (`let mask = 0xffffffff` wants `let mask: u32`).

**A `number` and a `u32` do not mix in arithmetic** without saying which is meant: `h + n`
is an error that names the two ways out, `u32(n)` and `i32(h)`, which read the same 32
bits the other way and cost nothing (`n >>> 0` says `u32(n)` too, as in JavaScript). A
whole-number constant that fits is either, so `h * 31 + 7` needs nothing. A *comparison*
between the two is no error and is exact: a number below zero is smaller than any `u32`.
Storing one into a variable of the other keeps the bits.

**Where the game takes nothing below zero** — a `u8` or `u16`, a unit's hit points, an
action's amount or count, a cell of `stats()`, `random(n)`'s bound, a place on the map — a
number below zero goes in as 0: `u.hp -= 1000` kills, `createUnit(p, unit, n, at)` with
`n` at −3 makes none.

**Arithmetic**: `+ − * / %` between variables and constants, `*=` `/=` `%=`, `++` `--`,
`Math.min`, `Math.max`, `Math.abs`, `clamp(x, lo, hi)`, and the bitwise `& | ^ << >> >>>`
(with `&=` and the rest) over the 32 bits. `>>` keeps the sign of a `number` and `>>>`
never does, as in JavaScript; a shift by 32 or more leaves nothing but that sign, where
JavaScript would shift by the remainder. `/` is whole division towards zero — `-7 / 2` is
−3, as `Math.trunc(-7 / 2)` — and `%` takes the sign of what is divided, `-7 % 2` is −1,
as in JavaScript (there are no fractions in the game; `Math.floor`, `Math.trunc`,
`Math.round` and `Math.ceil` around a division are accepted and change nothing). `*`
wraps, and dividing by a variable that is 0 in the game gives 0, as `(a / 0) | 0` does.
Dividing by a constant 0 is a compile error.

#### Control flow and loops

`if`/`else`, `while`, `do`, `for`, `switch`, `break`, `continue` and `c ? a : b` all
work. `switch (x)` over a variable tests its cases in order and falls through without
`break` as TypeScript does; the case values are known when the script is applied. `&&`,
`||` and `!` short-circuit as in TypeScript: `n >= 1 && once(…)` consumes the edge only
once `n` is 1. Conditions of the game go where a boolean goes — `if (bring(P1,
units.AnyUnit, locations.Beacon, ">=", 1) && !alarm)` — `random()` is a coin toss, and
`random(n)` a whole number from 0 to n − 1 (`n` may be a variable; 0 gives 0). The game's
own randomness seeds them, so two games differ.

**Loops run to completion within the frame.** `while (i < 10) { …; i++; }` does all ten
rounds at once, which is what the source says. That has one consequence to keep in mind:
a loop that never ends and never sleeps would never give the frame back, and the game
would freeze. The compiler refuses one — a loop with no `sleep()` on some path around it,
whose condition never mentions a variable the body changes (or, for a condition or a read
of the game, whose body takes no action that could change it) — and says where to put a
`sleep(frames(1))`. The simulator has a guard of its own for what the check cannot see.

A `for` whose start, bound and step are known when the script is applied —
`for (let i = 0; i < 3; i++)`, counting down, stepping by two — is **unrolled**: the body
is compiled once per value with `i` a value and not a variable, so
`createUnit(P2, unit, i + 1, at)` is an ordinary action, and `break` and `continue` work.
The editor says so at the end of the line: *unrolled ×3*. A `for` over a variable bound,
or one that assigns its variable in the body, is a loop in the game. An unroll of more
than 256 iterations is an error that says how to write it as a loop instead.

**Lists are unrolled.** `for (const w of waves)` over a list known when the script is
applied compiles the body once per element, with `w` bound to that element, so a wave
table is ordinary data:

```ts
const waves = [{ unit: units.ZergZergling, n: 6 }, { unit: units.ZergHydralisk, n: 4 }];
program(() => {
  for (const w of waves) {
    createUnit(P2, w.unit, w.n, locations.Spawn);
    sleep(seconds(20));
  }
  victory();
});
```

#### Functions

**Functions.** Arguments pass by value, as in TypeScript: `function bump(x: number) { x++; }`
leaves the caller's variable alone. A function may **return a number, a boolean, a text
or a unit** — `function canAfford(price: number) { return gold >= price; }`,
`x = twice(y) + 1`, ``function label(n: number) { return `Wave ${n}`; }`` — and an instance
of a class under the rule in *Classes*, below. It does not return a record or an array it
made: hand it the one to fill in, which reaches it as itself. Parameters take defaults
(`function f(x: number, step = 1)`), and locals start afresh at every call.

A function used once is **inlined**: its body is written where the call stands, a
parameter that was given a value known when the script is built is that value, and one
given a variable the function never assigns reads that variable directly. A function used
a second time is **called** instead when it can be: one copy of its body in the built
map, its parameters variables that every call sets. The source is the same either way and
means the same; what calling buys is the size of the map — ten calls of a function are
one body, not ten. The end of the function's line says which it got: *called ×3*, or
*inlined ×3* with the reason when you hover it. Three things keep a function inlined:

- it **sleeps** — the program wakes up inside it, which only an inlined body can do;
- a parameter reaches something only a value known when the script is built can fill —
  `function pay(p: Player, n: number) { setResources(p, "add", n, "ore"); }` needs its
  player when the map is built, so `pay(P2, 4)` stays inlined (the amount could be a
  variable; the player cannot) — or an argument is a list only the script has (a text
  written in the script is no such thing: the parameter is a text variable, set at each
  call);
- it uses `rose()` or `once()`, which remember what they saw at each place they are
  written.

An array reaches a function as itself — what the function stores, the caller sees — and
which array is settled when the script is built. So a function that takes an array is one
copy *for each array it is passed*: `total(hp)` and `total(shields)` are two copies, five
calls of `total(hp)` one. The hint counts them: *called ×5, 2 copies*.

**A function may call itself**, directly or through another: `fib(n - 1) + fib(n - 2)`, a
flood fill over an array, two functions that call each other. Such a function is always a
called one — from the call inside itself on, whether or not anything else calls it twice —
and its line says *calls itself*. It means what it means in TypeScript: each run has its own
parameters and locals, an array declared in it is that run's own, and `c ? f(x) : 0` or
`ok && f(x)` makes the call only when TypeScript would. Three things show that it is a map
and not a JavaScript engine:

- **No `sleep()` in it.** A function that sleeps is inlined, and one that calls itself
  cannot be; the error says so.
- **A depth limit** — 1 024 calls deep unless the panel's **Settings** says otherwise (16 to
  65 536, kept in the map). A call past it stops the program for good, and the game says
  where: *stack overflow in fill, line 12*. **Simulate** stops at the same call and lists it
  with the other faults. A function with no way out at all — it calls itself on every path —
  is an error when the script is built.
- **It costs what it keeps.** A function's variables are single cells of the map, so around
  each call that may come back the function's variables are put on a stack and taken back
  after. That is a few dozen triggers a variable a call: nothing for a flood fill or a walk
  a thousand deep, a visible pause for tens of thousands of calls within one frame. The
  fewer variables the function has, the less a call costs. The stack is only in the built
  map when some function calls itself — Settings says how large it comes to for the script
  as it stands — and a function that does not call itself costs what it always did.

A flood fill over a grid, which is both of the last two sections at work:

```ts
program(() => {
  const grid = [
    [0, 0, 1, 0],
    [0, 1, 1, 0],
    [0, 0, 0, 0],
  ];
  function fill(x: number, y: number): number {
    if (x < 0 || y < 0 || y >= grid.length || x >= grid[0].length) return 0;
    if (grid[y][x] != 0) return 0;
    grid[y][x] = 2;
    return 1 + fill(x + 1, y) + fill(x - 1, y) + fill(x, y + 1) + fill(x, y - 1);
  }
  let x = 0;
  print(`${fill(x, 0)} cells filled`);      // 9 cells filled
});
```

A loop over units (`for (const u of unitsOf(…))`) cannot hold such a call: collect what it
finds into an array, and recurse from a loop over that.

**Functions the game runs can live in any file**: `game()` marks them.

```ts
// shop.ts
export const award = game((p: Player, n: number) => { setResources(p, "add", n, "ore"); });
export const canAfford = game((have: number, price: number) => have >= price);

// main.ts
import { award, canAfford } from "./shop";
program(() => {
  let gold: u8 = 10;
  if (canAfford(gold, 5)) { gold -= 5; award(P2, 3); }
});
```

A `game()` function follows the program's rules — inlined where it is used once, called
where it is used more, as above — and what it does is attributed to its own file and line. It sees its parameters and what any
file sees when the script is applied, not the calling program's variables. Calling one
outside a program is an error: it runs in the game, not when the script is applied.

#### Classes

**Classes** are TypeScript's, declared inside the program like its functions. An instance
is a record — a variable a field — and a method is a function that is handed the instance,
so everything above about functions holds for methods: one used once is inlined, one used
more is called (a copy an instance, as a function that takes an array is a copy an array),
one may call itself, and one that sleeps is inlined.

```ts
program(() => {
  class Wave {
    static made = 0;
    left: number;
    constructor(public unit: UnitType, public count: number) { this.left = count; Wave.made++; }
    spawn(at: Location) { if (this.left > 0) { createUnit(P2, this.unit, 1, at); this.left--; } }
    get done() { return this.left == 0; }
  }
  class Boss extends Wave {
    constructor(unit: UnitType) { super(unit, 1); }
    spawn(at: Location) { super.spawn(at); displayText("The boss is here"); }
  }
  const waves = [new Wave(units.ZergZergling, 12), new Wave(units.ZergHydralisk, 6)];
  const boss = new Boss(units.ZergUltralisk);
  while (!waves.every((w) => w.done)) {
    for (const w of waves) w.spawn(locations.Gate);
    sleep(seconds(1));
  }
  boss.spawn(locations.Gate);
});
```

Fields with their first values, a constructor, `constructor(public x: number)`, methods,
`get` and `set`, `static` fields and methods, `readonly`, `private` and `#x`, `extends`
with `super(…)` and `super.method()`, `abstract`. A field holds what a record's does: a
number, a boolean, a unit, a text, an array (`members: Unit[] = []`), a record, another
instance (`pos = new Vec(0, 0)`). `this.members = []` starts the array over.

What makes it work is that **the class of every instance is known when the script is
built** — nothing of a class is left when the map is played. So an overridden method is
found by what the instance is, even through a parameter typed as the class it extends;
`x instanceof Boss` is answered by the compiler, and the branch that is false is not built;
and the same is where the limits are:

- **An array of instances holds one class**, since a row has the fields of one. `const xs:
  Wave[] = []` that only ever gets `new Boss(…)` is an array of `Boss`; one that gets both
  is an error that says to keep an array for each.
- **`new` where the instance will live**: `const w = new Wave(…)`, a field's first value,
  `waves.push(new Wave(…))`, `waves[i] = new Wave(…)`, `[new Wave(…), …]`, an argument
  (`run(new Wave(…))`). A row *is* the instance, so `waves.push(w)` of one kept in a variable
  is refused rather than quietly copied. `const same = w` is another name for the same one.
- **A function may give an instance when every `return` gives the same one**: `return
  this` (so `v.add(w).scale(2)` chains, the calls running in the order written),
  `return new Wave(n, 10)` (a function that makes one: `const w = make(3)`), or one it was
  handed. `pick(a, b)` that returns one or the other is refused: which instance it is would
  only be known while the map is played. For that, keep the instances in an array and
  return the place.
- **A variable that is a row may be given another row of the same array**: `let cur =
  waves[0]; … cur = waves[i]`. Underneath, which row it is is a number. A variable holding an
  instance of its own (`let w = new Wave(…)`) is not given another.
- **A class is declared in the program** (or in a `game()` function) that uses it. One
  declared outside is the script's: fine for working things out when the script is
  applied, not something a program can write to.
- No type parameters, no static blocks, no decorators; a class written as a value
  (`const C = class { … }`) is refused.

#### What is worked out when the script is applied

**A `const` is what it can be.** `const limit = waves.length` is computed when the script
is applied and inlined; `const next = wave + 1` needs a variable of the program, so it is
one, which TypeScript keeps you from reassigning. A constant is computed when the
compiler reaches its declaration, or earlier if something needs it, and one inside a
branch that is never compiled is never computed at all.

**Everything else the body reads from outside is computed when the script is applied.**
A constant, a helper, a condition, an action: each is evaluated once, when the compiler
reaches it, and the compiler sees its value where the expression stood. The editor
underlines those parts with dots, so the boundary is visible as you type, and hovering a
variable says what it is. `if (false) …` and `while (false) …` are pruned, and nothing
inside them is evaluated. A helper that throws is reported at the expression that called
it, with a note that it ran when the script was applied. That is what makes `burst(4)`
above work — the helper is ordinary TypeScript, it returns two actions, and the program
runs them. It is also the one rule to keep in mind: a program variable cannot reach a
condition, an action or a helper, because those are computed before the game starts. A
parameter of a function that was given a value does reach them — such a function is
inlined, the parameter being that value — so
`function spawn(p: Player, n: number) { createUnit(p, units.Zergling, n, spawnAt); }`
works with `spawn(P2, 4)`.

**An action can take a variable amount**, which is the exception to that rule.
`setResources(P1, "add", n, "ore")`, `setResources(P2, "set", wave * 10 + 5, "gas")`,
`setDeaths(…, "add", n)`, `setScore(…)`, `setCountdownTimer("set", n + 1)` take a
variable where the amount goes, one action each. `createUnit`, `killUnitAt`,
`removeUnitAt` and `giveUnits` take a variable *count*: that many units, 0 being none.
A location, a unit type or a player is known when the script is applied, and a
*condition's* amount is too — to compare against a variable, read the value and compare
it yourself, as below.

#### Reading the game

**Reads: every quantity a condition compares is also a value.** Leave the comparison and
the amount out of the call and it is a read, a number like any other:

```ts
let price = 50;
if (deaths(P1, units.TerranMarine, ">=", 10)) print("ten lost");   // a condition, as ever
let lost = deaths(P1, units.TerranMarine);             // a read
if (minerals(CurrentPlayer) > price * 2) price += lost; // compared with a variable
setResources(P2, "set", minerals(P1) / 2, "ore");      // as an action's amount
let here = bring(P2, units.ZergZergling, locations.Pen);
```

That works for `deaths`, `kill`, `bring`, `command`, `accumulate`, `score`, `opponents`,
`countdownTimer` and `elapsedTime`, and there are plainer names for the common ones:
`minerals(p)`, `gas(p)`, `resources(p, "oreAndGas")`, `countUnits(p, unit, location?)`,
`kills(p, unit)`, `countdown()`, `elapsed()` (both in the game's own seconds, sixteen
frames each: at Fastest they run about one and a half times as fast as `sleep(seconds())`,
so `elapsed()` reads 21 after fourteen seconds of sleeping). A read means exactly what the condition
means — a force's minerals are the force's sum, `units.Men` counts what Bring counts —
because where the game keeps no table of the value, the program asks the condition
itself, a bit at a time. What to read (the player, the unit, the location) is known when
the script is applied; `CurrentPlayer` is the player the program is running as. A read is
taken when the line runs, each time it runs: `let ore = minerals(P1)` keeps the number,
`minerals(P1)` written twice reads twice.

**Player facts** are reads too: `race(p)` against `races.Zerg` / `.Terran` / `.Protoss`,
`slot(p)` against `slots.Human` / `.Computer` / `.Empty` / `.Rescuable` / `.Neutral`,
`isHuman(p)`, `hasLeft(p)` (P1 … P8: a human or computer slot of the map whose player
is gone — which a slot nobody took also is; a computer never leaves), and `supply(p, "used" |
"max" | "provided", race?)` as the top bar shows it, of the race the player plays unless
one is given.

#### Units

**Units on the map are objects.** A `Unit` is one of the game's units as it is right now
(the entries of `units.` are `UnitType`s, and `u.type` is one):

```ts
for (const u of unitsAt(locations.Pen, { owner: P2 })) u.hp = u.maxHp / 2;

const target = nearest(units.TerranMarine, locations.Beacon, { owner: P1 });
if (target) target.order("move", locations.Exit);
```

`unitsAt(location, filter?)`, `unitsOf(player, filter?)` and `allUnits(filter?)` are what a
`for…of` runs over; `first(filter?)`, `nearest(type, location, filter?)` and
`randomUnit(filter?)` pick one unit or `null`, and TypeScript wants the `if (target)` before
the unit is used (or `target?.kill()`). A filter is `{ type, owner, at }`, every part known
when you build; `units.Men`, `units.Buildings` and `units.Factories` work as a type, and
`CurrentPlayer` as an owner. Units come in the order of the game's unit table; a dying unit
is passed over, so `first()` after a `kill()` is the next one.

A unit has `hp`, `shields` and `energy` in whole points, `maxHp` / `maxShields` of its
type, `owner`, `type`, `x`, `y`, `kills`, `orderId`, `cooldown`, `resources` (a mineral
field's), the timers `stim` `ensnare` `plague` `lockdown` `maelstrom` `irradiate` `stasis`
in the game's own ticks, and the booleans `invincible`, `hallucinated`, `cloaked`,
`burrowed`, `underAttack`. Hit points, shields, energy, kills, the cooldown, the resources,
the timers and `invincible` can be written (`u.hp = 0` kills); the rest the game keeps for
itself — a position write ends the game with "EUD not supported", a cloak write showed
nothing — and the declarations have them `readonly`, so the editor says so as you type.
It can be told `order("move" | "patrol" | "attack", location)` (the game's own Order,
reaching this unit alone), `give(player)`, `kill()`, `remove()`, `damage(n)` and
`heal(n)` — or `{ percent: 50 }` of the type's maximum — and `locate(location)`, which
centres a location on it so that `createUnit` and the rest can happen where the unit is.
Functions take units and return them (`function weakest(): Unit | null`), and `a == b`
says whether two are one unit.

A variable can keep a unit across a `sleep()`. The game gives a dead unit's place to the
next unit made, so every use checks that the unit is still the one that was kept: once it
is gone its numbers read 0, its booleans false, and writing to it or telling it something
does nothing; `if (u)` asks. The unit of a loop's turn needs no check, and a loop over
units runs within one frame — a `sleep()` inside one is an error; to act on one unit at a
time, find it again after each sleep:

```ts
let u = first({ owner: P2, at: locations.Pen });
while (u) { u.kill(); sleep(seconds(1)); u = first({ owner: P2, at: locations.Pen }); }
```

Each loop and each pick looks through the game's 1700 unit slots when its line runs
(`randomUnit` twice), and in a per-player program once for each player. Once or a few times
a second is nothing; the editor notes it at the end of the line (`scans units`) so that a
scan inside a loop that runs every frame is a choice and not an accident.

#### The game's tables

**`stats()` is the game's own tables.** What a unit type costs, what a weapon does, a
player's upgrades, as properties a program reads, assigns and `+=`s:

```ts
stats(units.TerranMarine).minerals = 25;
stats(units.TerranMarine).speed = 6.5;            // pixels a frame: a fraction is fine when known when you build
stats(units.ZergZergling).name = "Dog";
stats(weapons.GaussRifle).damage += 2;
stats(upgrades.TerranInfantryArmor).minerals = 50;
stats(units.TerranGhost).permanentCloak = true;
stats(P3).color = "teal";                         // or colors.teal
stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;
stats(P1).researched[techs.Lockdown] = true;
if (stats(units.TerranMarine).minerals > minerals(CurrentPlayer)) print("too dear");
```

A unit type has `maxHp`, `maxShields`, `armor`, `minerals`, `gas`, `buildTime` (seconds on
the game's clock), `supplyUsed`, `supplyProvided`, `sight`, `groundWeapon`, `airWeapon`
(`weapons.*`), `size`, `speed`, `name` and the flags `detector`, `permanentCloak`,
`cloakable`, `burrowable`, `regenerates`, `invincible`, `hero`, `organic`, `mechanical`,
`robotic`; a weapon `damage`, `bonus`, `cooldown`, `factor`, `range`, `minRange`; an upgrade
`minerals`, `gas`, `time` and (read only) `maxLevel`; a technology `minerals`, `gas`,
`time`, `energy`; a player `color`, `upgrades[…]` and `researched[…]`. Only what was played
and seen working in StarCraft: Remastered is there — the hover on each says what it
reaches: most unit-type fields apply to units made after the write, a weapon's to every
unit using it at once. `speed` and `name` can be set but not read. A write lasts for the
game. `stats()` wants to see what it is given — `stats(units.TerranMarine)`, `stats(p)`
with `p: Player` — because a table's index is a plain number when the script runs and
only its type says which table.

#### Keys, the mouse and chat

**What the players do is `keyPressed`, `clicked`, `mouse` and `chatted`.** A key, a
click and a typed line are true on the one frame they arrive, so a program looks for them
in a loop that runs every frame:

```ts
program(() => {
  while (true) {
    if (keyPressed(CurrentPlayer, "F8")) createUnit(CurrentPlayer, units.TerranMarine, 1, locations.Base);

    if (clicked(CurrentPlayer, "right")) {
      const at = mouse(CurrentPlayer);                       // map pixels, kept as they are now
      centerLocation(locations.Cursor, at.x, at.y);
      createUnit(CurrentPlayer, units.TerranMarine, 1, locations.Cursor);
    }

    const m = chatted(CurrentPlayer, "-spawn {n} {what:unit}");
    if (m) createUnit(CurrentPlayer, m.what, m.n, locations.Base);

    underMouse(CurrentPlayer, { owner: CurrentPlayer })?.heal(10);
    sleep(frames(1));
  }
}, { owner: AllPlayers });
```

`keyPressed(player, key)` is true when the press arrives — once per press, not while the
key is held (the game reports no held key), and not while the player is typing a message.
Keys are the letters and digits, `"F1"` … `"F12"` without `"F6"` (the game keeps it to
itself and reports no press of it — played and seen — so it is an error to ask), `"Space"`, `"Enter"`, `"Escape"`,
`"Tab"`, `"Shift"`, `"Ctrl"`, `"Alt"`, the arrows (`"Left"` …), `"Backspace"`, `"Delete"`,
`"Insert"`, `"Home"`, `"End"`, `"PageUp"`, `"PageDown"` and `"Numpad0"` … `"Numpad9"`; the
game's own use of a key still happens. `clicked(player, "left" | "right" | "middle")` is
the same for a mouse button. `mouse(player)` is where the player's mouse is on the map,
`x` and `y` in pixels (32 to a tile); `const at = mouse(p)` keeps the place, and
`centerLocation(location, x, y)` moves a location there — its size kept — so that
`createUnit` and the rest can happen under the cursor. `underMouse(player, filter?)` is the
unit nearest the mouse and no farther than `within` pixels from it (48 unless the filter
says), or `null`.

`chatted(player, pattern)` is `null`, or what the pattern read out of the line the player
sent. The pattern's own text is matched exactly and the whole line has to fit. `{n}` reads
a whole number (up to 1 048 575); `{what:unit}` a unit type by its name — `Terran Marine`
or `TerranMarine`, a custom name too — which is the rest of the line, so it comes last;
`{kind:ore|gas}` one of the listed words, giving its place in the list (0, 1, …). Names
and words match whatever the capitals; up to three values a pattern. The values are typed
from the pattern itself — `m.n` is a number, `m.what` a `UnitType`, `m.amount` an error as
you type — and they are the program's numbers: an action takes a unit type and a count
from them at once. A pattern starts with a word of its own (`-spawn`), so ordinary talk is
never taken for it; a line that fits no pattern is just chat. A game played in single
player has no chat: test typed lines in a multiplayer game, which one person can host
alone.

The player is one of `P1` … `P8` or `CurrentPlayer`; in a per-player program each player's
own keys, mouse and lines. All of it reaches every player's computer in step, a few frames
after it happens — that is the trip between computers, and the same in a game alone. It
comes through two plugins the eudplib library carries (MSQC and chatEvent), set up by the
compiler from what the programs ask for. They take a little from the map, and only when a
program reads input: one free location among the map's first 63 (and eight more in a row
when the mouse is read — the script is told when there is no room), the Valkyrie, which
the map must not use (its type carries the input), and Player 12, who holds those units.
No death counter, switch or string is used. Outside a program these functions are an
error, where `if (keyPressed(…))` would otherwise quietly be true. Simulate presses no
keys: there they read as nothing (tests that press them come with `test()`).

#### Text

**A text can hold the program's values.** `displayText` takes a template literal (or
texts joined with `+`) with numbers of the program in it, `name(p)` and `color(p)`:

```ts
let wave = 3;
displayText(`${color(P2)}${name(P2)}\x01 has ${minerals(P2)} ore — wave ${wave + 1}`);
print(`Wave ${wave}`, { to: AllPlayers, position: "center" });
```

`name(p)` is the player's name and `color(p)` the colour code of their colour, both
filled in by the game; the ordinary colour codes work as ever. `displayText` shows it to
the current player, as it always has; `print(text, { to, position })` is the way to
show it to someone else — a player, `AllPlayers`, a force — or, with `position:
"center"`, on the line in the middle of the screen where the game's own messages ("Not
enough minerals") appear. A boolean has no text of its own. A text with nothing of the
program in it stays the plain Display Text action it was. None of a program's texts enter
the map's string table: they go into the built map's.

**A text is a value.** `string` is a type of a program as `number` is: a variable holds
one, a function takes and returns one, a record has one for a field, and there is nothing
to declare beside it — no length, no capacity.

```ts
let wave = 3, left = 12, shown = "";
let title = wave > 10 ? "Late game" : "Early game";   // texts written in the script
let line = `Wave ${wave}: ${left} left`;                // a text made in the game
line += "!";
if (line != shown) { print(line); shown = line; }
setMissionObjectives(`${title} - ${line}`);
```

The compiler keeps a text one of two ways, a variable at a time, and the end of the
declaration's line says which:

- *A text of the map* — a variable that only ever receives texts written in the script:
  `"Boss"`, `boss ? "Boss" : "Wave"`, `titles[level]` out of a list the script has. It
  holds the text's number in the built map's string table. Assigning it and comparing it
  cost what a number's do, and the text of **any** action takes it.
- *A text that is made* — a template with the program's values in it, `a + b`, `s += "!"`,
  `String(n)`, a method's result. Its characters are in a block of the memory the
  programs' arrays share (the script's Settings set its size), and the variable owns the
  block: assigning copies the characters, and what the variable held before goes back. A
  text is a value, as it is in TypeScript, so a copy never follows what it was copied
  from. A made text holds 1 023 bytes; past that it is cut off, which the game says once
  in red and Simulate says on the line.

What a text can do: `+`, `+=`, templates, `==` `!=` `<` `<=` `>` `>=`, `if (s)` (it is
not empty), `switch (s)` over texts written in the script, `length`, `s[i]`, `at()`,
`charAt()`, `slice()`, `substring()`, `indexOf()`, `includes()`, `startsWith()`,
`endsWith()`, `padStart()`, `padEnd()`, `repeat()`, `concat()`, `codePointAt()`,
`String(n)`, `n.toString()`, and `for (const ch of s)`. Anything else is refused by name;
a text the script has, with nothing of the program in it, takes every method JavaScript
has, since the script simply runs.

**A character is a character, not a byte.** The game keeps a text as UTF-8, where a
Korean syllable is three bytes; a program counts what JavaScript counts, so
`"저글링".length` is 3 and `"저글링"[1]` is `글`. The one difference is a character past
U+FFFF (an emoji, a rare ideograph): JavaScript counts two and a program one — and the
game draws a dark square in its place, which a hint on the line says. Since a character has no fixed
size in the game's memory, `s[i]` and `slice()` walk the text from its start; over a long
text, `for (const ch of s)` walks once. That loop runs within the frame, so `sleep()`
inside it is refused; a loop over the places can sleep between turns, which is how a text
is typed out a character at a time:

```ts
let wave = 3;
let line = `Wave ${wave} is here`;
let typed = "";
for (let i = 0; i < line.length; i++) { typed += line[i]; print(typed); sleep(frames(2)); }
```

`padStart` counts characters, as it does in a browser, and the game's font is
proportional and a colour code has no width: it does not line columns up.

**A made text outside the chat area.** The objectives, a leaderboard's label, a
transmission's line and a unit type's name (`stats(units.TerranMarine).name = …`) take a
made text. The game looks those texts up by number, so the build keeps a string of its
own for each kind — a player has one objectives text, one leaderboard and one transmission
at a time — and the text is written over it just before the action runs, up to 255 bytes.
The game reads such a string again whenever it draws, so the write happens only on the
computer of the player the action is for: in a program of every player, each sees their
own. What is on the screen is the text as it was when the action ran; changing the
variable afterwards changes nothing until the action runs again. Any other action's text
(`setNextScenario`, a sound's path) is a text of the map or an error that says so.

A function takes and returns a text like any other value — it is called from its second
use on, its parameter a variable set to a copy at each call — and one that calls itself may
hold texts: around each call that may come back a text's three cells go on the stack with
the rest, so each run has its own. The one thing such a function cannot do is go through a
text with `for…of` around the call; the error says to walk it by place. What is left out
for now: `parseInt`, regular expressions and the words a player typed in chat.

#### Time and edges

**Time is `sleep`.** `sleep(seconds(15))` gives the frame back and resumes that much
later; other programs and the map's triggers go on meanwhile. `frames(n)` is the game's
own clock, `seconds()` is twenty-four frames at Fastest, `minutes()` sixty of those.
(`cycles(n)`, from before 3.0, is the same as `frames(n)`.) `wait()` inside a program is
allowed but is a different thing: the game's own Wait stalls every trigger of that player
for the time, so use it for a short pause inside one frame (a text, then a sound) and
`sleep` to pass time. Something that runs on its own clock is another program: one
program per concurrent activity.

**Edges.** `if (rose(bring(P1, units.AnyUnit, locations.Beacon, ">=", 1)))` is true on
the frame the condition becomes true, and not again until it has been false in between;
`once(…)` is true the first time only.

#### Owners and per-player programs

**A program runs for its `owner`** (default P1), as a trigger would: one player is one
thread running as that player, only while that player is in the game, and
`CurrentPlayer` means that player. `AllPlayers`, a force (`players.Force1`) or a list of
players (`[P1, P2, P3]`) makes a **per-player program**: it runs once each frame for
every human or computer player among them who is in the game, `CurrentPlayer` is that
player, and every variable is per player, each with their own copy. `let total =
shared(0)` is one value they all share. That is how lives, scores and cooldowns per
player are written once:

```ts
program(() => {
  let lives: u8 = 3;
  while (true) {
    if (rose(deaths(CurrentPlayer, units.TerranMarine, ">=", 1))) {
      lives -= 1;
      setDeaths(CurrentPlayer, units.TerranMarine, "set", 0);
      if (lives == 0) defeat();
    }
    sleep(frames(1));
  }
}, { owner: AllPlayers });
```

The simulator runs such a program as one player at a time. A script may have several
programs, each a thread of its own with its own variables. A program's text
(`displayText("…")`) is put into the built map's string table by eudplib, so it never
takes a string of the map you edit; a `trigger()`'s text is interned into the map when
the script is applied, as it always was.

#### What a program does not have

Outside `program()` the script is all of TypeScript, since it simply runs. Inside one, what
is written has to become something the game can do, and these cannot. Each is refused with
a message that says so, none is passed over in silence:

| Not there | Write instead |
| --- | --- |
| Fractions: every number is whole | work in a smaller unit (pixels, frames, hundredths) |
| `**`, `Math.sqrt`, `Math.sign` and the rest of `Math` on a variable — `min`, `max` and `abs` are there, and the rounding ones around a division | a loop, or a list the script worked out (`const roots = Array.from({ length: 100 }, (_, n) => Math.floor(Math.sqrt(n)))`, then `roots[n]`) |
| A function kept as a value: `const f = (x: number) => x + k`, a function in an array, one returned | `function f(x: number) { … }` in the program; an arrow is fine where a method takes one |
| A function that returns a record or an array it made | hand it the record or the array to fill in; an instance of a class is the exception (*Classes*) |
| `try`, `catch`, `throw` — the game has no exceptions | return a number that says what happened |
| `async`, generators, `for…in`, a labelled `break`, `typeof` | — |
| An `enum` declared inside the program | declare it above the program: its members are numbers the script has, and a variable holds one |
| On an array: `shift`, `unshift`, `splice`, `at`, `lastIndexOf`, `join` of numbers | `pop` and `push`, a place kept in a variable, `xs[xs.length - 1]`, a template in a loop |
| `map` into texts or records | `push` in a `for…of` |
| On a made text: `split`, `trim`, `replace`, `toUpperCase`, `lastIndexOf`, `parseInt`, regular expressions | keep the number beside the text and make the text from it |
| A `Map` whose values are texts or records, or whose keys are texts | the place of a row of an array of records as the value |
| Writing a unit's position, cloak or tint | the game refuses these itself (*Units*) |

Still to come, in this order: a debugger that steps a script in the simulator, started
from a test if you like, and a gallery of examples with their tests. The plan is
`docs/eud-plan.md`, and the IR the compiler hands eudplib is `docs/ir.md`.

### Coming from 3.9

Nothing of the language has changed; a 3.9 script builds into the same map. What is new is
around it. The Explorer shows [folders](#folders), and moving a file takes its imports
along. The simulator's world [has units and players](#use): `createUnit` makes them, the
unit conditions count them, and a program of a force runs for each of its players — so
Simulate of a script that makes units says more than it did, and a line of its list that
said a unit condition was false may now say otherwise. The script can carry its own
[tests](#tests). **Test (F5) is now Play (F5)**, since "test" came to mean those. A
program can be given a name — `program(() => { … }, { name: "waves" })` — which the
Explorer shows and a test asks for.

### Coming from 3.8

Nothing a 3.8 script does has changed, with one exception that was a mistake before: a
`forEach` over a list of the script whose function only made actions —
`waves.forEach((w) => createUnit(P2, w.unit, w.count, at))` — used to build into nothing,
without a word. It now does what it says. And a loop that empties an array by the value of
its `pop()` — `while (queue.length > 0) { const i = queue.pop()!; … }` — was refused as one
whose condition never changes; it is the loop it looks like. What is new is the array methods that take a
function (*The methods that take a function*, above), on arrays, arrays of records, arrays
of units, the units of the game and the script's own lists. `findLast` and `findLastIndex`
brought the script's standard library to ES2023. `new Array(12)` is an array of numbers
where TypeScript's own declaration says `any[]`, so what is read out of one, or made from it
by `map` or `reduce`, has a type; an array of booleans made that way says so:
`new Array<boolean>(12).fill(false)`.

Arrays inside arrays and inside records (*Arrays inside arrays*, above) are new as well.

Texts are values now (*A text is a value*, above): `let s = "…"` inside a program was an
error in 3.8 and is a variable in 3.9, and the objectives, a leaderboard's label, a
transmission and a unit type's name take a text the program made, where 3.8 refused
anything but a text written in the script.

Classes (*Classes*, above) are new: a `class` inside a program was refused in 3.8. With
them an array of records learnt to hold more than numbers and booleans — a unit, a text, an
array that grows, a record inside the record — whether its rows are instances or records
written out. And `p.trail = []` on an array that grows, a record's or an instance's, starts
it over where 3.8 said an array is assigned cell by cell.

A `Map` and a `Set` take any number for a key (*A `Map` and a `Set` over any number*,
above), or a unit of the game, where 3.8 said a key has to be an id of the game. One keyed by
ids of the game is what it was.

Smaller things that 3.8 refused by name and 3.9 does: `slice`, `concat`, `toSorted`,
`toReversed` and `Array.from`; `sort`, `reverse` and `filter` of an array of arrays; a
spread into a call's arguments; an array of texts a program fills. One thing changed under
a script that already worked: a function handed a text written in the script
(`say("hello")`) used to be copied into each call, and is now one that is called, as a
function handed a number is. What it shows is the same.

Patterns and spread (*Patterns and spread*, above) are new too, and mended something:
`const { n, d } = waves[0]` over a list of the script — nothing of the program in it — was
refused with "n is not defined". A constant taken out of a pattern is now the script's
constant like any other.

### Coming from 3.7

Nothing a 3.7 script does has changed. What is new is that a function may call itself
(*Functions*, above), and with it a second number in the panel's **Settings**: how many
calls deep such a function may go. Two smaller things came with it. A parameter given a
plain value can now be assigned inside the function — `function count(n: number) { n--; … }`
with `count(3)` used to be refused. And `const hit = found ? 1 : 0` is a number: TypeScript
calls it `0 | 1`, which the compiler did not take for one.

### Coming from 3.6

Nothing a 3.6 script does has changed; what changes is the map it builds into. A function
used more than once is now one body that is called, where it used to be a copy of its body
at every call (*Functions*, above), so a script with helpers builds into a smaller map.
Two things show in the editor: the hint at the end of a function's line, and the Variables
list, where a called function's parameter and its locals are one variable each instead of
one for every call. An array written empty — `let found: number[] = []` — is now always one
that grows, also when the only pushes are inside a function it is handed to. And the
**Simulate** view lists what the interpreter has long recorded and never shown: a read or a
store past an array's end, a push the heap had no room for, each with its line.

### Coming from 3.5

Nothing a 3.5 script does has changed. What is new is arrays, arrays that grow, tables keyed
by an id of the game, and the workspace's **Settings** view (above). One thing the compiler
does differently that a script could notice: of a method call on a value the script made
(`waves.filter(…)` with a variable of the program among the arguments), what is known when
the script is built is now the object, not the method read off it.

### Coming from 3.4

A `number` is signed. Until 3.5 a program's numbers were never below zero: `3 - 10` stored
0, and a comparison was made exact by moving what either side subtracted to the other. Now
`3 - 10` is −7, stored, compared and printed as that. What changes for a script written
before:

- A value that relied on stopping at 0 — `lives -= 1` meant to rest at 0 — goes below it.
  Declare it a `u8` or `u16`, which still stop (`let lives: u8 = 3`), or write
  `Math.max(lives - 1, 0)`.
- A constant above 2 147 483 647 in a plain variable is an error: declare the variable a
  `u32`, which is what `number` used to be in all but name.
- `/` rounds towards zero and `%` takes the dividend's sign. For numbers that are not below
  zero — every script until now — nothing changes.
- `>>>` is its own operator; `>>` of a number below zero keeps its sign.

### Coming from 3.3

`sleep(frames(1))` goes on in the next frame, as it was always described. Until 3.4 the
built map waited one frame longer than asked after every `sleep` — a loop sleeping a frame
ran every other frame, `sleep(seconds(1))` took 25 — while Simulate did not; now both do
what the words say. A script that counted on the longer wait runs a little faster.

A unit type can be a variable of the program in an action (`createUnit(P1, m.what, m.n,
at)`), along with the count or the amount; before, one argument at a time could be.

### Coming from 3.2

One name moved. `Unit` is a unit on the map now, and a unit *type* — an entry of `units.`,
what a condition or an action names — is a `UnitType`. A script that annotated a
parameter with the old name (`(u: Unit) => createUnit(P1, u, 1, at)`) says
`u: UnitType`; the type error names both. Nothing else about existing scripts changes.

`units.AnyUnit`, `units.Men`, `units.Buildings` and `units.Factories` are 229 … 232, which
is what the game has them as; until 3.3 they were one lower (228 … 231, where 228 is the
game's "None"), so a condition over a class counted the wrong one. Building the script
again is the fix.

### Coming from 2.x

Until 3.0 a program was built as a state machine of death counters, so that it ran on
every version of the game, with a *Remastered target* beside it. That back end is gone:
it made `a = b` cost 66 triggers, ran one loop iteration per trigger cycle, could not
divide by a variable, and every feature had to be written twice. What changes for a
script:

- A map with a `program()` needs StarCraft: Remastered. `trigger()` is untouched.
- There is no Build, no target switch and no `-eud.scx` beside the map: saving builds.
- A game loop needs a `sleep()`: `while (true) { … }` alone is now an error that says
  where to put `sleep(frames(1))`. A loop with an end runs all its rounds at once.
- `sleep(seconds(n))` is twenty-four frames a second whether or not the script emits
  hyper triggers; `cycles(n)` means frames.
- The `comments` and `variableUnits` options of `program()` are gone, with the triggers
  and death counters they were about.
- The first Apply of a 2.x map replaces its block, programs' triggers included, with the
  script's `trigger()` records alone.

Version 2.6.1 stays installable for a map that must run on 1.16.1 with programs:
`github:scm-js/plugin-trigscript@v2.6.1`.

## For other plugins

The plugin registers commands, so another plugin gets the script without the editor
through `api.commands.run` (check `api.commands.has` first, and listen to the
`"commands"` event if you need to know when it arrives — plugins activate in no fixed
order). A `source` argument is either the text of `main.ts` (the map's other files stay
as they are) or an object of every file by path.

| Command | |
| --- | --- |
| `trigscript.state()` | `{ files, source, manifest, block, stale, edited, unbuilt, programs }`: the map's script files, `main.ts` on its own, where the script's block sits in the trigger list (null when the records were edited by hand — `stale`, with `edited` counting how many are still the script's and how many changed, when that can be told), whether the files differ from what was last applied, and how many programs the script had then (any means the saved map is built by eudplib and needs StarCraft: Remastered). Null with no map. |
| `trigscript.declarations({ compact? })` | The generated `.d.ts` the script type-checks against — the whole vocabulary for this map. `compact` is the shorter variant meant for a language model. Empty with no map. |
| `trigscript.compile(source)` | A promise of a `CompileResult`: `ok`, `diagnostics` (`file`, 1-based `line` / `column`, `message`, `source: "typescript"`, `"compiler"` or `"script"` for an error the script threw), the `trigger()` records, `sources` (per record, the file and line it came from), the `programs` and their `variables`, `ir` (the programs as IR, what eudplib builds), `hints` per line, and `refs` — every `locations.X` / `switches.X` the files mention, resolved by the checker, present even when the script does not type-check. A newer compile supersedes an unfinished one, which rejects with `CompileSuperseded`. |
| `trigscript.build(source, { takeOver?, replaceStale? })` | Apply: compile and, when clean, write the `trigger()` records as the block and store the files with the map (the programs are built into the file when the map is saved): a promise of `{ compiled, block, refused?, replaced? }`. The build lands only on the map it was compiled for: `block` is null and `refused` says why when there were `"errors"`, the map `"closed"` or another one `"switched"` to the front while the script ran, or the map's names `"changed"` under it (that one is compiled again, twice at most, before it is reported). Files edited in the archive while the script ran are kept, and the state then reads as unbuilt. When the old block was edited by hand, the new one is appended, or with `replaceStale` put in the old one's place with its unchanged records removed and the edited ones kept after it (`replaced` counts both). `takeOver` replaces the whole trigger list with the script's. A settings-style transaction: not undoable, marks the map modified. |
| `trigscript.print(triggers, { imports?, header? })` | Records as `trigger()` calls in the script language — what Import map triggers writes. `imports` starts the text with an import of the names it uses. |
| `trigscript.simulate(triggers, cycles, { player? })` | The interpreter: `{ cycles, events, switches }`. |
| `trigscript.triggerAt(file, line)` | Which trigger (index in the map's list) a 1-based line of a file generated; null when none did or the block is stale. |
| `trigscript.open({ file?, line? })` | Open the editor, on a file and line. |

The scmjs.dev plugin's *Write Triggers…* is built on these.

## Development

```sh
npm install
npm run typecheck   # tsc over the plugin and its tests, against @scm-js/plugin-api
npm test            # vitest: the runtime, the plan, the lowering, the simulator, the block logic
```

The layout:

| | |
| --- | --- |
| `plugin.ts` | Activation: the menu item, the claim on the generated block (`api.triggers.claim`), the commands. |
| `service.ts` | What the plugin does to the map: names off `api.settings` / `api.names` / `api.query`, the members through `api.document.extras`, an apply as one `document.update`, and its part in saving (`attach`): `buildSteps.before` applies a script that is newer than its block, and a contribution to the eudplib plugin's build hands over the IR, `python/trigscript.py` and eudTurbo. A compile is `prepare`d into an artifact stamped with the map's id and a hash of its names, and `install` refuses an artifact whose map is not the one in front — the dialog compiles once and installs that, never a second run. |
| `editor.ts` | The dialog: the file list and Monaco, plain DOM in the editor's own classes. |
| `tree.ts` | The files as folders, and a move that takes the imports with it. Pure over strings. |
| `testState.ts` | What the workspace shows of a compile's test report: results kept between runs, marks, the failures said at their lines, the warnings, the Testing view's tree. |
| `monaco.ts` | Monaco from `dist/` on jsDelivr's GitHub mirror (the tag `DIST_TAG` names; the workers start as blob module workers), one model per file under `file:///` so imports resolve, the theme. The plugin storage key `monacoDist` overrides where the files are fetched from — set `scmjs.plugin.trigscript.monacoDist` in the browser to `"http://localhost:3000/dist"` while developing. |
| `bundle/`, `dist/` | `npm run bundle` builds Monaco with esbuild — the editor core, its features and the TypeScript language alone, styles injected by the module and the codicon font inlined, plus the two workers — and writes `lib.d.ts`, the standard library the compile worker checks scripts against (`bundle/lib.mjs`), into `dist/`, which is committed. A CDN's on-the-fly bundler turns Monaco's lazy language chunks into standalone bundles carrying a second editor core, which is why the plugin carries its own. After a Monaco bump: rebuild, commit, tag `monaco-<version>-<n>`, move `DIST_TAG`. |
| `compile.ts` | Compiling in a worker: a blob worker `importScripts` TypeScript from the CDN, fetches `lib.d.ts` once, and imports this plugin's own compiler module by the `blob:` URL the editor's loader gave it; a request the script does not answer in fifteen seconds (an endless loop outside `program()`) terminates the worker. A worker that cannot import the blob is replaced by one that imports the release's `dist/compiler.js`; when that fails too the compile rejects with `CompilerUnavailable` and a later one starts over. The script is never run on the main thread, where an endless loop could not be stopped. |
| `script.ts` | The files, the block and its manifest: hashing (the block, and every record on its own), finding the block by content, staleness and what a stale block can still be taken apart into, planning a build. Pure over a trigger list and a map of the members. |
| `compiler/` | The language. `names.ts` and `declarations.ts` generate the `.d.ts`; `runtime.ts` is the library the script calls; `compiler.ts` checks the files as one `ts.createProgram`, collects the map references, emits them through `hoist.ts`'s transformer, links and runs them (`link.ts`), and turns each `program()` — and the `game()` functions it calls — through `structured.ts` (with `scope.ts`, what a name is bound to, and `tables.ts`, the game's tables) into the IR (`ir.ts`, `docs/ir.md`); `input.ts` sets up what the programs read of keys, mouse and chat, `numbers.ts` writes into every operation whether it reads its 32 bits as a `number` or a `u32`, `recursion.ts` finds the functions that call themselves and what each call has to keep, and `eud.ts` checks the result (a loop that never sleeps, a constant divisor, a constant that does not fit its width) and serialises it with every text written out; `python/trigscript.py` is the other half, the euddraft plugin that lowers the IR to eudplib, embedded by `npm run embed`; `simulate.ts` is the trigger-cycle interpreter and `simulateIr.ts` the program interpreter, which computes every number the way the Python does, the two over the one world of `world.ts` (the unit table, the players and forces, what is done to units and what the unit conditions count); `testing.ts` is the script's own `test()`s — the registry the script fills as it runs, `sim` and `expect`, and the runner, whose report is plain data because it crosses from the compile worker; `lower.ts` is what the raw level still needs (condition negation, hyper triggers); `print.ts` is the inverse for records; `api.ts` and `record.ts` are the shared vocabulary. Nothing in here touches the DOM or the editor. |
| `python/trigscript.py` | The Remastered lowering: the euddraft plugin that turns the IR into eudplib code, handed to the eudplib plugin with every build. `npm run embed` writes it into `compiler/generated/trigscriptPy.ts`; `tests/python.test.ts` fails when the two drift. `scripts/build-fixture.mts` builds a script into a playable map under Node through a plugin-eudplib checkout; `probes/` holds a probe script for each part of the language (`arrays.ts`, `recursion.ts`, `strings.ts`, `classes.ts`, `map.ts`, …): every line prints what it expects, a test plays it in the simulator against those lines, and the built map — in the ignored `fixtures/` folder, since it sits on a Blizzard map — is played in the game before the part ships, which is the only place the Python really runs. |
| `vendor/` | The tables the compiler reads, copied from the editor: the trigger record layout and its codec, the condition and action definitions, the unit names, the flag names, the text format's printer and parser. The editor is the source of truth; copy them again when it changes. |
| `dist/plugin.js`, `dist/compiler.js` | The bundle the editor loads, and the compiler alone (`compiler/entry.ts`) for the compile worker of a copy compiled into the editor, which has no `blob:` module to hand it; `npm run build` writes both — commit both before tagging (CI commits and checks `plugin.js` on its own). |
| `dist/testing.js`, `dist/testing.d.ts` | Not loaded by the plugin. The trigger text parser (`vendor/text.ts`), the trigger interpreter and its world, and the record constants, bundled from `compiler/testingEntry.ts` so that another repository's tests can run trigger text instead of reading it: a devDependency on the tarball of one of this repository's tags (`https://github.com/scm-js/plugin-trigscript/archive/refs/tags/v3.10.3.tar.gz`), then `import { parseTriggers, Simulation } from "scmjs-plugin-trigscript/testing"`. `npm run build` writes both and CI holds them to the same rule as `compiler.js`. |
| `tests/` | vitest. `script.test.ts` pins the names, the declarations, the runtime's argument handling, files and imports, the printer and the block logic; `script-structured.test.ts` compiles programs and asserts the simulation, and a file a part of the language does the same for it (`arrays`, `grids`, `callbacks`, `destructuring`, `functions`, `recursion`, `classes`, `strings`, `hash`, `leftovers`, `units`, `input`) — `hash` and `leftovers` also run each body in JavaScript itself and compare what was printed; `readme.test.ts` compiles every example of this file, and checks what an example says it prints; `python.test.ts` holds the Python to the compiler's IR version; `simulate-ir.test.ts` pins the program interpreter's contract with the game (frames, and how a number comes out); `service.test.ts` the apply and the part in saving, against a stand-in host and library; `eud-build.test.ts` builds golden maps through a plugin-eudplib checkout beside this repository when there is one; `refs.test.ts` the references and renames. Copies of Blizzard's own maps in `fixtures/maps/` (gitignored) make every trigger eject to script and run back to the same record. |

### How the compiler is built

`names.ts` turns the map into name tables (players, units, locations, switches, AI
scripts, and the fixed weapons, upgrades and technologies `stats()` takes); each entry's keys are an identifier derived from the display name first
(`Terran Marine` → `TerranMarine`), the display name itself second, then custom names —
unique per table by construction. `declarations.ts` generates the `.d.ts` from them plus
the library: values are branded literal types (`UnitType<0> = 0 & Brand<"unit">`; plain
numbers still pass, a `Location` where a `UnitType` belongs does not), enumerated kinds are
string unions of the canonical words, every condition and action is a `declare function`
whose identifier is its `ConditionType` / `ActionType` key in camel case, and the whole
thing is declared twice — as globals and as the ambient module `"trigscript"`.

`runtime.ts` is the same vocabulary as values: the tables as frozen objects and one
function per condition and action that validates its arguments and returns a record.
`trigger()` pushes a record onto a `Collector`; `program()` pushes the descriptor the
transformer made for it. Strings are not interned here: text and WAV fields hold local
ids into `CompileResult.strings`, and the build resolves them through the map's string
table.

`compiler.ts` builds a real `ts.createProgram` over the files, the declarations and the
standard library (in-memory host; `module: commonjs`, `moduleResolution: bundler`),
collects every reference to the map's tables while the checker is there (so a rename can
follow them even when they no longer type-check), and stops at the first type error. It
then plans every `program()` body and every `game()` arrow (`hoist.ts`): the *game
bindings* are the body's `let` / `var`, the parameters and the functions declared in it;
a *hoisted expression* is a maximal subexpression that mentions none of those (and is not
`random()`, nor a call of a `game()` function — the callee's type carries a brand), and a
`const` of the body whose initialiser is hoistable is a build-time constant. The emit
transformer appends its position to every `trigger()` call and replaces each planned
arrow with a descriptor holding a function that returns the hoisted expressions as
thunks and the constants as memoised thunks, every reference to a constant rewritten to a
call of its thunk — so a constant is computed when first needed and never in a pruned
branch. The emitted CommonJS is linked by `link.ts` — relative imports against the files,
`"trigscript"` to the runtime, the library's names in scope as globals — and run; an
error the script throws is placed through the emitted source map. `game(descriptor)`
returns a function that throws if the script calls it and carries the descriptor for
the walker.

`structured.ts` then walks each program body against the same plan, with the thunks the
descriptor's function returned: where the plan says an expression was hoisted, the walker
takes its value — a number, a boolean, a condition, an action or a list of them. `let` →
a variable of the IR (a number, a boolean, a unit, a text), a record of them (an object
literal, an instance of a class) or an array, bound
in a scope keyed by declaration node so shadowing and inlining resolve as the checker
does; expressions become IR expressions as written; `&&` / `||` / `!` stay what they are,
and the lowering short-circuits them; functions declared in the body and `game()`
functions are `call` nodes — inlined where a function is first met, the walker switching
to the function's own plan, file and thunks for the duration, and from the second time on
a call of one body kept in `Program.functions`, when the function compiles with every
parameter a variable (the attempt's diagnostics are thrown away, and a first call already
inlined is changed to match; `settleFunctions` then inlines again whatever is left with one
call); a call, member access or arithmetic over
values a parameter was bound to is evaluated on the spot; a `for` whose bounds evaluate
is unrolled like a `for…of`; an action with a variable argument carries the expression
beside its record. The thunks are memoised in the bodies, so the script's build-time
parts run once.

`python/trigscript.py` lowers a program to straight-line eudplib triggers with jumps
between labels. `sleep` stores the label to resume at in a state variable, sets a frame
counter and leaves the frame; the frame's entry counts the wait down and jumps to the
stored label. Arithmetic is 32 bits that wrap, and each comparison, division, shift
right, `min`, `max` and printed number reads them signed or unsigned as `numbers.ts`
marked it. An array that grows is a block of one heap the programs share — sizes double,
a block given back serves the next array of its size — and a made text is such a block
of bytes. A function that is called is one body with its parameters as variables; one
that calls itself keeps what a call would overwrite on a stack of its own, an array
beside the heap whose depth the script's Settings give. `docs/ir.md` says what each node
means to both backends. A per-player program loops over the
slots its owners name (All Players and a force resolved from the map's player settings)
who are in the game, its variables and state as twelve-slot arrays. `EUDVariable(n)` is a
cell's value at map load, not per run, so everything the lowering writes to starts from
`fresh()`; `tests/python.test.ts` refuses an unmarked one. A read is one `f_dwread_epd`
where a table of the game is the value (a player's deaths, kills, ore, gas; the player
bytes and the supply tables Magenta's probes verified; `hasLeft` is `f_playerexist`) and otherwise a search with the
condition itself, "at least" a bit at a time from the top, so it means what the condition
means. A text with values in it goes through eudplib's string buffer, or `f_eprintln` for
the middle of the screen — both show only on the computer of the player the text is for —
with the current player moved to each addressee and back. `random(n)` is `f_dwrand() % n`,
seeded once with `f_randomize()` when a program uses it. `simulateIr.ts` mirrors all of
it, wrap included, so that what Simulate shows is what the game does.
