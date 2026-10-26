# TrigScript

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It keeps TypeScript files inside the map and turns them into the
map's triggers.

The files are real TypeScript. They *run* when the script is applied, and every
`trigger()` call they make records one trigger of the map, so helpers, loops over the
players, arrays, classes and the standard library are all there. Those are ordinary
triggers and play on every version of the game.

Code inside `program(() => { … })` is the other half: it runs *in the game*, with
variables, arrays, texts, functions, classes, loops, `sleep` and `await`. TrigScript builds
the programs into the map when you save, as the game's own triggers, in under a second and
with nothing else to install. A map with a program in it needs **StarCraft: Remastered**.
A script with something TrigScript does not take yet is not built, and Problems says why on
the line (see [Use](#use)). The guide's page [Coming from
eudplib](https://docs.scmjs.dev/trigscript/coming-from-eudplib/) is for map makers who
build with [eudplib](https://github.com/armoha/eudplib) and euddraft: where each of its
ideas went, and how the two compare in speed and size.

The editor is Monaco with a `.d.ts` generated from the open map, so `locations.`,
`switches.`, `units.` and `players.` complete to what your map has, and a location passed
where a unit belongs is a type error before you build.

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
with the plugin's own files. The first time the editor opens, they are fetched from
jsDelivr: Monaco and the library from this repository's own build of them (`dist/`), and
TypeScript from the npm package's `lib/typescript.js`. So the first open needs a
connection. The copy compiled into the editor also fetches the release's own
`dist/compiler.js` for its compile worker. The browser keeps them all in its cache
afterwards, and the desktop build relies on that cache when it is offline.

## Use

**Triggers ▸ TrigScript…** opens the map's script in a workspace laid out the way VS Code
is, with the same keys where it has one:

| Where | What is there |
| --- | --- |
| **Activity bar**, at the far left | The Explorer and **Testing**; the icon of the view that is showing hides the sidebar. Testing carries the count of the tests that fail. |
| **Explorer**, at the left (Ctrl+B) | The script's files as a tree, and under them the **programs** with the variables each keeps in the game. `main.ts` is where the script starts. *New file* and *New folder* are on the section and on a folder's row; a row's pencil and bin rename and remove it; the right-click menu has all of them. A click goes to the line. See [Folders](#folders). |
| **Tabs**, over the editor | One per open file; a file with problems is red, with their count, and two files of one name say their folder. Go to Definition on a name another file exports opens that file. |
| **Run controls**, right of the tabs | Play (F5), Simulate (Ctrl+F5), Apply (Ctrl+Shift+B), Pick from map, the switch between the window and the panel beside the map, and **…** for the rest. |
| **Panel**, under the editor (Ctrl+J) | **Problems** (Ctrl+Shift+M); **Output** (Ctrl+Shift+U), what Apply, Play and the builds reported, with the build log; **Simulate**; **Test Results**; and **Settings** (Ctrl+,), what the map's author chose about how its programs are built, kept in the map beside the script so that it builds the same on any computer. The panel opens when asked for or when something failed. |
| **Status bar** | The problem count; the tests (`12 passed`, or `1 failed` in red; a click opens Testing); whether the script's triggers are in the map (a click applies it); the last build of the programs (**built by TrigScript**); the cursor. |
| **Command palette** (F1 or Ctrl+Shift+P) | Every command above under *TrigScript:*, beside Monaco's own. |

Something that needs an answer, such as triggers edited outside the script or a location
the map renamed, is a notification in the corner. An item of the status bar brings it back
after it was dismissed. Nothing that appears moves the text.

Edits are saved into the map as you type (the files are members of the archive, like a
sound), and Ctrl+S saves the map from inside the editor too.

There is no build step to remember. **Saving the map applies the script**, and so do
Tools ▸ Test Map and anything that exports the map:

1. The script runs.
2. Its `trigger()` records go into the trigger list as one block. The block replaces the
   previous one, or is appended the first time.
3. Its programs are built into the file being written.

The map you keep editing never holds the build's output: the editor stores the map as you
see it inside the saved file and gives that back when you open it. If the script has an
error, the map is still saved, with the triggers from the last script that compiled, and a
notice names the file and line.

**Apply** does the first two steps on demand, so you can see the generated triggers in the
Trigger Editor without saving. **Play** applies, builds the map as Save would and hands it
to Test Map: on the desktop the game starts with it, and in a browser it goes into the test
folder you picked once. (Play was called Test until 3.10, when the script's own
[tests](#tests) took the word. F5 does what it did.)

The Trigger Editor shows the script's triggers with a `script` badge and will not edit
them; *Open TrigScript* there jumps to the file and line. The Text Trigger Editor fences
them in comments. Hand-made triggers around the block are left alone. A hand-made trigger
inserted before the block just moves it, since the block is found by its content, not its
position.

Editing a generated trigger from outside makes the block *stale*. The script remembers
every trigger it made, so the editor can say how many are still the script's and how many
were changed. While a block is stale, saving does not apply the script, and the notice on
Save says so. The notification offers two ways out:

- **Apply** replaces the unchanged triggers with the new block and keeps the edited ones as
  hand-made triggers right after it, so a wave system edited in one trigger does not come
  back twice.
- **Append instead** leaves them all in place and adds a fresh block after them. This is
  also what happens when the block was moved or removed rather than edited.

**Import the Map's Triggers** (under **…**) goes the other way: it rewrites the hand-made
triggers as script, in their order around the block, so the whole list is the script's.

**Simulate** runs the script for 480 frames, twenty seconds of the game at Fastest, in a
built-in interpreter. The panel's Simulate view lists every action that ran, with its
frame and source line, and each program variable's final value. First in the list, marked
as errors, are the mistakes the game passes over in silence: a read or a store past an
array's end, a push the heap had no room for, a recursion that ran out of stack (which
stops the program, here as in the game). Each is one row a line, however often a loop came
past it.

The `trigger()` records run in a trigger interpreter (death counters, switches, preserve,
list order, the wait slots), and the programs in a program interpreter that computes every
number the way the game will. The two share one world, so a program's `setDeaths` is seen
by a trigger and the other way round. Both keep the game's time. The game goes through the
trigger list in passes, the first on frame 2. A script with a program is built to have a
pass every frame, with the programs inside it. A script of `trigger()`s alone keeps the
game's own schedule: a pass every 31 frames (2, 33, 64, …), and on the frame after a Wait
runs out. A Wait holds its trigger for its time at Fastest. So the frames Simulate lists
are the frames the game would act on. Reads find what the simulation holds (death
counters, the resources the programs set, the clock, the units) and 0 for what it does not
(scores, the countdown). A printed text shows with its numbers filled in and "Player 1"
for a name.

**The simulated world has units.** It starts from the units placed on the map, where they
were placed, with the hit points their type and their own settings give, inside the map's
locations as they are drawn. From there:

- `createUnit` makes units at the location's centre, with the hit points and shields their
  type has (a program's earlier write to `stats()` counts), and
  `createUnitWithProperties` applies the map's properties slot.
- `giveUnits`, `moveUnit` (to the centre of where it goes), `killUnitAt` and
  `removeUnitAt` with their counts, `modifyHitPoints` and its kin, `moveLocation` and
  `setInvincibility` do what they say.
- `bring`, `command`, `commandTheMost` and the rest count what is there, and a unit that
  is killed is a death of its type for its owner.
- A unit takes the lowest free place of the unit table. A place used again is a new unit:
  a `Map<Unit, V>` or a variable that kept the dead unit does not find the new one, as in
  the game.

**The players are the map's.** A program owned by a force or by All Players runs once a
frame for each of its human and computer players, each with their own variables. A force
in an action is each of its players, and in a condition all of them together. Every line
of the list says whose it is; what several players did alike in a frame is one line
(`P1–P8 · …`).

What stays out, because it cannot be known without the game: nothing walks, fights or is
built over time; nothing is in anything's way (a unit that is made always finds room);
energy starts at 0 unless a properties slot says otherwise; and no unit dies except by the
script or, in a test, by the test. The order of the unit table is the simulator's own
rule, not the game's. The script's [tests](#tests) run in this same world.

### Folders

A file's name may have folders in it, and the Explorer shows them as a tree: folders
first, `main.ts` first of the files. No folder means anything to TrigScript; `tests/` is a
habit, not a rule. The archive the files are kept in has no empty folders, so a folder
exists while a file is in it: *New Folder…* asks for the folder's name and goes straight on
to its first file's.

Renaming a file or a folder (the pencil; a folder before the name moves a file), or
dragging a row onto a folder (or onto the empty space under the tree, for the top),
**takes the imports along**. Every `import … from "./path"` that named a moved file, and
the moved files' own imports, are rewritten so the script compiles as it did before, in
the form they were written (with `.js`, as a folder with an `index.ts`, or bare). The move
is one change, and the notification that says what moved has an **Undo**. `main.ts` stays
where it is. Removing a folder asks once and says how many files go.

### Tests

A script can test itself. A test is ordinary TypeScript that runs in the editor's
simulator after every change that compiles. It never runs in the game and adds nothing to
the map. The names are [Vitest](https://vitest.dev)'s, imported from `"trigscript"`
(`test`, `it`, `describe`, `beforeEach`, `afterEach`, `test.only`, `test.skip`,
`test.each`, `expect`). They are not globals, so a script's own `test` is its own.

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
what they test in any other file. The entry file runs first, so the programs are there.
Then each test file runs, linked as any file is, so it can import the script's own
functions and test them as plain TypeScript. A test file is never part of the build:
importing one from a file that is not a test file is an error, and so is a `program()` or
a `trigger()` inside one. Test files are kept in the map with the rest of the source and
go when the source is left out of a copy.

**What a test gets.** `sim`, a world of its own for each test. It is [the simulated
world](#use): the map's placed units, locations and players, the script's programs at
frame 0 and its `trigger()`s beside them. `random()` is seeded the same every time
(`sim.seed(n)` for another run). A test is not `async`: nothing in `sim` waits.

**Time is the game's.** The game goes through the trigger list in passes, the first on
frame 2. A script with a program is built to have a pass every frame, with its programs
inside it, so a program first runs on frame 2 and then every frame. A script of
`trigger()`s alone keeps the game's own schedule: a pass every 31 frames (2, 33, 64, …),
and on the frame after a Wait runs out. A Wait holds its trigger for its time, in
milliseconds at Fastest, and a player has one wait slot that their triggers share.

| `sim.` | |
| --- | --- |
| `place(player, type, at, count?)`, `kill(unit, by?)`, `remove(unit)`, `give(unit, to)`, `move(unit, to)` | What the test does to the world. `place` gives the units back; `kill` is what a fight is in a test, `by` the player whose kill it is. |
| `frames(n)`, `seconds(n)`, `until(() => …, most?)`, `frame` | Time. `until` fails the test when `most` frames pass first (2400 unless said), so no test hangs. |
| `press(key)`, `click(button)`, `type(line)`, `moveMouse(x, y)` | What a player does, found by the next frame; a player may be named last. |
| `count(player, type, at?)`, `units(filter?)`, `resources(player)`, `deaths(player, type)`, `kills(player, type)`, `switch(n)`, `location(n)` | The world read back. |
| `program(name?, player?)` | A program's variables by their names in the source: numbers, booleans, texts, arrays, a record as an object, a unit. The program is found by the `name` its options give it (`program(() => { … }, { name: "waves" })`, which the Explorer shows too), or by its place in the script from 0; of a per-player program, `player`'s. |
| `printed(player?)`, `events`, `faults` | What was shown, everything that happened by frame, and what went wrong. |

`expect` has `toBe`, `toEqual`, `not`, `toBeTruthy` / `toBeFalsy`, `toBeNull`,
`toBeDefined` / `toBeUndefined`, the four comparisons, `toContain`, `toHaveLength`,
`toMatch`, `toThrow`, and two of its own: `expect(sim).toHavePrinted(text | RegExp, { to?
})` and `expect(sim).toHaveFaulted(/depth/)`. **A fault the test did not ask for fails
it**: an index outside its array, the stack's depth, a full heap, which the game passes
over in silence. So does anything the test throws, and a frame past 100 000 statements.

**A test file, and the script's own functions as plain TypeScript.** A test file imports
the same module the map is built from, so a helper is tested without a world and a program
with one:

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

**Keys and chat.** A test says what a player does before the frame that finds it:

```ts
import { test, expect, program, keyPressed, chatted, setResources, print, sleep, frames, CurrentPlayer } from "trigscript";

program(() => {
  let shop = false;
  while (true) {
    if (keyPressed(CurrentPlayer, "F7")) { shop = !shop; print(shop ? "Shop open" : "Shop closed"); }
    const give = chatted(CurrentPlayer, "-give {n}");
    if (give && shop) setResources(CurrentPlayer, "add", give.n, "ore");
    sleep(frames(1));
  }
}, { name: "shop" });

test("-give pays only while the shop is open", (sim) => {
  sim.type("-give 100").frames(2);
  expect(sim.resources(0 as Player).ore).toBe(0);
  sim.press("F7").frames(1);
  expect(sim.program("shop").shop).toBe(true);
  sim.type("-give 100").frames(2);
  expect(sim.resources(0 as Player).ore).toBe(100);
  expect(sim.printed()).toEqual(["Shop open"]);
});
```

**Hooks, cases, and an expected fault.** `beforeEach` runs on the test's own world,
`test.each` makes a test of each row, and a test that expects a fault says so:

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
  beforeEach((sim) => { sim.frames(2); });

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

Without that last `toHaveFaulted` the test fails by itself, at the program's line. A read
past an array's end is 0 in the game and nobody is told, which is why it is worth a test.

Without the map's player settings (a test of the compiler, a map with no players set) the
world has one player; `test(name, { as: P2 }, (sim) => { … })` says which.

**In the workspace**, as in VS Code:

- A mark in the margin beside every `test(` and `describe(`: not run, passed, failed,
  skipped. A click runs that one.
- A failure is shown where it happened: `expected 8, got 6` at the end of the failing
  `expect`'s line, with the two values in full on hover. A test that threw says what at the
  line that threw.
- The **Testing** view in the activity bar: folder, file, `describe` and test, each with
  its mark. It runs all of them, a file, a `describe` or one test, or the failed ones, and
  can show only the failing ones.
- **Test Results** in the panel: the chosen test's message, what it printed, and what
  happened frame by frame, each a link to its line.
- Tests run again after every compile that goes through; the next keystroke drops a run
  in progress. If they all take more than two seconds, only the open file's tests run by
  themselves and the rest wait for *Run All*.
- A failing test is a warning in Problems at its line, and a build's log says so. An
  `only` left in is a warning too. **Settings ▸ Tests ▸ A failing test refuses the build**
  is kept in the map: with it on, Save, Test Map and an export say which test fails and
  write the map without applying the script again.
- Palette: *Run All Tests*, *Run Test at Cursor*, *Run Failed Tests*. *New File…* in a
  folder called `tests` proposes `<the open file>.test.ts` with one test written in it.

The right of the status bar says the programs are **built by TrigScript**: the plugin lays
them out into the map itself, in under a second, with nothing to download. A script with
something TrigScript does not take yet is not built; Problems says what, as a warning on the
line, and the save's notice says so again, with a button to save without the programs. A map
that also holds Magenta's triggers is not built either, until Magenta builds on TrigScript's
layout. Every build runs on this machine and nothing about the map leaves it.

The status bar says how the last build went, Output keeps its log, and a failure that
names a line puts a marker on it. A save whose build fails still writes the map and its
script, with no programs in it, and the status bar reads **Saved without its programs**
until a save that builds. After a good build it reads **edited since** once the script
changes, because the programs in the saved file are then the older ones.

The files and a build manifest live in the map archive under `trigscript\`
(`trigscript\main.ts`, `trigscript\build.json`, …) next to `staredit\scenario.chk`, so
they travel with the `.scx`. The editor's Save dialog lists them with the archive's other
files, each with a tick, so a copy for release can leave the source out.

## The language

The language is documented on the [scmJS documentation site](https://docs.scmjs.dev/),
beside the editor's other guides:

| Guide | What is in it |
| --- | --- |
| [TrigScript](https://docs.scmjs.dev/trigscript/) | A quick start, `trigger()` and its argument words, programs in brief, examples, Simulate and tests, the workspace beside the map, troubleshooting |
| [TrigScript language](https://docs.scmjs.dev/trigscript-language/) | Everything a program can say: numbers and fixed numbers, arrays, maps and sets, functions and closures, classes, errors, tasks, units, events, `stats()` and `memory`, keys, the mouse and chat, text and JSX, sounds, and where it differs from TypeScript |
| [TrigScript library](https://docs.scmjs.dev/trigscript-library/) | The standard library's modules, each with an example, and libraries from other plugins |
| [Coming from eudplib](https://docs.scmjs.dev/trigscript/coming-from-eudplib/) | eudplib's and epScript's ideas mapped to TrigScript's, for map makers who build with euddraft |

Their sources are `docs/trigscript.md`, `docs/trigscript-language.md` and
`docs/trigscript-library.md` in [scm-js/scm-js](https://github.com/scm-js/scm-js), whose
tests compile every example in them against the TrigScript version the editor ships. A
change to the language goes there. The sections below say what each version changed.

### Coming from 4.0

A 4.0 script builds into the same map. What 4.1 changed:

- **Libraries from other plugins.** A plugin can provide TrigScript modules that a script
  imports by id (`import { spawnWave } from "waves"`), and the map keeps a copy of each one
  it imports, so it still builds where that plugin is missing or at another version
  ([Libraries from other plugins](https://docs.scmjs.dev/trigscript-library/libraries-from-other-plugins/), [Providing a
  library](#providing-a-library)). `trigscript.build` is service version 2.
- **Long lists known when the script is built** are built, such as a video played in the
  fog: 4.0 refused one of more than 16,384 values wider than six bits ("arrays and stacks
  of … cells, past the 65536"), and now reads it where it is in the map, four bytes a
  value.

### Coming from 3.12

A 3.12 script builds into the same map, and its programs now build *without eudplib*:
TrigScript lays them out itself when you save, in under a second, with nothing to install
and no Build step. The eudplib plugin is no longer required, and a map that used it keeps
working. What 4.0 changed around that:

- **What the build refuses, it says.** A script with something TrigScript does not take is
  not built; Problems marks the line, and Save offers to save without it. Nothing is built
  through another compiler behind your back.
- **Tests run in the game as well.** With the lifted game installed, *Run all tests in the
  game* judges each test twice, and a test's frames carry a cost in milliseconds of
  Remastered's time. Every address a build touches is checked against what Remastered
  allows, line by line, before a map is written.
- **The language grew**: [functions as values](https://docs.scmjs.dev/trigscript-language/functions/#functions-as-values) and closures, [`try`
  / `catch` / `throw`](https://docs.scmjs.dev/trigscript-language/errors/), `async` functions, tasks and `Promise.*` ([Waiting and
  tasks](https://docs.scmjs.dev/trigscript-language/waiting-and-tasks/)), [`on.*` events](https://docs.scmjs.dev/trigscript-language/events/), [numbers with a
  fraction](https://docs.scmjs.dev/trigscript-language/variables-and-numbers/#numbers-with-a-fraction), [the game's tables and `memory`](https://docs.scmjs.dev/trigscript-language/the-games-tables-and-memory/),
  [`local` reads and `sync()`](https://docs.scmjs.dev/trigscript-language/keys-the-mouse-and-chat/), programs of a force or a list
  of players ([Owners](https://docs.scmjs.dev/trigscript-language/owners-and-per-player-programs/)), [sounds](https://docs.scmjs.dev/trigscript-language/sounds-and-imported-files/#sounds), pictures and
  videos the script imports, and a [standard library](https://docs.scmjs.dev/trigscript-library/) of nine
  modules.
- **Input is the build's own.** Keys, clicks, the mouse and typed lines reach every
  player's computer in step without MSQC or a chat plugin: `keyPressed`, `keyHeld`,
  `clicked`, `mouse`, `chatted`, `on.key`, `on.chat`.
- **Units** gained `buildTime`, `rank`, `matrix`, `speed`, `speedUpgrade`, `hasTarget`,
  `inTransport` and a writable `hallucinated`, and `bounds(location)` reads a location
  where it is now. `underAttack` is the game's own alert: a hit out of the player's view.
- **Other plugins build with TrigScript** through the `trigscript.build` service ([For
  other plugins](#for-other-plugins)); Magenta 0.12 is the first.

### Coming from 3.9

Nothing of the language has changed; a 3.9 script builds into the same map. What is new is
around it. The Explorer shows [folders](#folders), and moving a file takes its imports
along. The simulator's world [has units and players](#use): `createUnit` makes them, the
unit conditions count them, and a program of a force runs for each of its players. So
Simulate of a script that makes units says more than it did, and a line of its list that
said a unit condition was false may now say otherwise. The script can carry its own
[tests](#tests). **Test (F5) is now Play (F5)**, since "test" came to mean those. A
program can be given a name, which the Explorer shows and a test asks for:
`program(() => { … }, { name: "waves" })`.

### Coming from 3.8

Nothing a 3.8 script does has changed, with one exception that was a mistake before: a
`forEach` over a list of the script whose function only made actions, such as
`waves.forEach((w) => createUnit(P2, w.unit, w.count, at))`, used to build into nothing,
without a word. It now does what it says. And a loop that empties an array by the value of
its `pop()`, such as `while (queue.length > 0) { const i = queue.pop()!; … }`, was refused
as one whose condition never changes; it is the loop it looks like. What is new is the
array methods that take a function (*The methods that take a function*, above), on arrays,
arrays of records, arrays of units, the units of the game and the script's own lists. `findLast` and `findLastIndex`
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
them an array of records learnt to hold more than numbers and booleans: a unit, a text, an
array that grows, or a record inside the record, whether its rows are instances or records
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
`const { n, d } = waves[0]` over a list of the script, with nothing of the program in it, was
refused with "n is not defined". A constant taken out of a pattern is now the script's
constant like any other.

### Coming from 3.7

Nothing a 3.7 script does has changed. What is new is that a function may call itself
(*Functions*, above), and with it a second number in the panel's **Settings**: how many
calls deep such a function may go. Two smaller things came with it. A parameter given a
plain value can now be assigned inside the function: `function count(n: number) { n--; … }`
with `count(3)` used to be refused. And `const hit = found ? 1 : 0` is a number: TypeScript
calls it `0 | 1`, which the compiler did not take for one.

### Coming from 3.6

Nothing a 3.6 script does has changed; what changes is the map it builds into. A function
used more than once is now one body that is called, where it used to be a copy of its body
at every call (*Functions*, above), so a script with helpers builds into a smaller map.
Two things show in the editor: the hint at the end of a function's line, and the Variables
list, where a called function's parameter and its locals are one variable each instead of
one for every call. An array written empty, such as `let found: number[] = []`, is now
always one that grows, also when the only pushes are inside a function it is handed to. And the
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

- A value that relied on stopping at 0 (`lives -= 1` meant to rest at 0) goes below it.
  Declare it a `u8` or `u16`, which still stop (`let lives: u8 = 3`), or write
  `Math.max(lives - 1, 0)`.
- A constant above 2 147 483 647 in a plain variable is an error: declare the variable a
  `u32`, which is what `number` used to be in all but name.
- `/` rounds towards zero and `%` takes the dividend's sign. For numbers that are not below
  zero, which is every script until now, nothing changes.
- `>>>` is its own operator; `>>` of a number below zero keeps its sign.

### Coming from 3.3

`sleep(frames(1))` goes on in the next frame, as it was always described. Until 3.4 the
built map waited one frame longer than asked after every `sleep`, while Simulate did not:
a loop sleeping a frame ran every other frame, and `sleep(seconds(1))` took 25 frames. Now
both do what the words say. A script that counted on the longer wait runs a little faster.

A unit type can be a variable of the program in an action (`createUnit(P1, m.what, m.n,
at)`), along with the count or the amount; before, one argument at a time could be.

### Coming from 3.2

One name moved. `Unit` is a unit on the map now, and a unit *type* (an entry of `units.`,
what a condition or an action names) is a `UnitType`. A script that annotated a
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
`"commands"` event if you need to know when it arrives, since plugins activate in no fixed
order). A `source` argument is either the text of `main.ts` (the map's other files stay
as they are) or an object of every file by path.

| Command | |
| --- | --- |
| `trigscript.state()` | `{ files, source, manifest, block, stale, edited, unbuilt, programs, libraries }`: the map's script files, `main.ts` on its own, where the script's block sits in the trigger list (null when the records were edited by hand: `stale`, with `edited` counting how many are still the script's and how many changed, when that can be told), whether the files differ from what was last applied, and how many programs the script had then (any means the saved map has programs built into it and needs StarCraft: Remastered), and the libraries the map keeps a copy of (`{ id, label, version }`). Null with no map. |
| `trigscript.declarations({ compact? })` | The generated `.d.ts` the script type-checks against: the whole vocabulary for this map. `compact` is the shorter variant meant for a language model. Empty with no map. |
| `trigscript.compile(source)` | A promise of a `CompileResult`: `ok`, `diagnostics` (`file`, 1-based `line` / `column`, `message`, `source: "typescript"`, `"compiler"` or `"script"` for an error the script threw), the `trigger()` records, `sources` (per record, the file and line it came from), the `programs` and their `variables`, `ir` (the programs as IR, what the build lays out), `hints` per line, and `refs`: every `locations.X` / `switches.X` the files mention, resolved by the checker, present even when the script does not type-check. A newer compile supersedes an unfinished one, which rejects with `CompileSuperseded`. |
| `trigscript.build(source, { takeOver?, replaceStale? })` | Apply: compile and, when clean, write the `trigger()` records as the block and store the files with the map (the programs are built into the file when the map is saved): a promise of `{ compiled, block, refused?, replaced? }`. The build lands only on the map it was compiled for: `block` is null and `refused` says why when there were `"errors"`, the map `"closed"` or another one `"switched"` to the front while the script ran, or the map's names `"changed"` under it (that one is compiled again, twice at most, before it is reported). Files edited in the archive while the script ran are kept, and the state then reads as unbuilt. When the old block was edited by hand, the new one is appended, or with `replaceStale` put in the old one's place with its unchanged records removed and the edited ones kept after it (`replaced` counts both). `takeOver` replaces the whole trigger list with the script's. A settings-style transaction: not undoable, marks the map modified. |
| `trigscript.print(triggers, { imports?, header? })` | Records as `trigger()` calls in the script language: what Import map triggers writes. `imports` starts the text with an import of the names it uses. |
| `trigscript.simulate(triggers, cycles, { player? })` | The interpreter: `{ cycles, events, switches }`. |
| `trigscript.libraries()` | The [libraries](https://docs.scmjs.dev/trigscript-library/libraries-from-other-plugins/) the open map keeps a copy of and the ones plugins provide, side by side: `{ id, label, version, provided, update }`, with `version` the map's copy (null when it keeps none), `provided` what a plugin has now (null when none does), and `update` true when the two differ. |
| `trigscript.updateLibraries(ids?)` | Replace the map's copies of these libraries (every one with a newer version provided, by default) with what their plugins provide now; the ids it updated. The map is modified and the script reads as changed. |
| `trigscript.triggerAt(file, line)` | Which trigger (index in the map's list) a 1-based line of a file generated; null when none did or the block is stale. |
| `trigscript.open({ file?, line? })` | Open the editor, on a file and line. |

The scmjs.dev plugin's *Write Triggers…* is built on these.

### Building with TrigScript

A plugin whose rows need code in the map writes that code as TrigScript — `program(() => {
… })` bodies in the language this guide describes — and hands it to TrigScript's build instead
of building anything itself. The service is `trigscript.build` (`contract.d.ts` in this
repository is its shape; take it with `import type`):

```typescript
import type { TrigScriptBuildService } from "./vendor/trigscript";
api.services.watch<TrigScriptBuildService>("trigscript.build", (build) => {
  mine?.dispose();
  mine = build?.contribute({
    id: "magenta", label: "Magenta",
    applies: () => rowsNeedingCode() > 0,
    collect: async () => ({ files: { "magenta/main.ts": renderRows() }, entries: ["magenta/main.ts"] }),
  }) ?? null;
});
```

On Save, Test Map and an export, TrigScript compiles what every contribution brings together
with the map's own script — the contributed files run as entries after it, so their programs
come after the script's — and lays every program out into the saved map in one build. The
files go under a folder named after the plugin, so they cannot shadow the map's own, and they
never enter the archive: the map the user edits is untouched. A contribution holds programs
only; a `trigger()` in it fails the build, since nothing would write it into the trigger list.
`check(files, entries)` compiles the same source against the open map without building, for
the plugin's own preflight: the problems at their file and line, and how many programs.
`onBuild` says how each build went, with `from` naming the contribution a failure was in.
Magenta's build rows reach the map this way.

### Providing a library

A plugin can give scripts a library to import ([Libraries from other
plugins](https://docs.scmjs.dev/trigscript-library/libraries-from-other-plugins/)) through the same service, from version 2 of it
on: `provideLibrary` takes the library's id, which is what scripts import it by, a label
and version for the editor to show, and each module's TrigScript source by its path in the
library.

```typescript
api.services.watch<TrigScriptBuildService>("trigscript.build", (build, info) => {
  held?.dispose();
  held = build && (info?.version ?? 1) >= 2
    ? build.provideLibrary({ id: "waves", label: "Waves", version: "1.0.0", modules: { "index.ts": INDEX, "spawn.ts": SPAWN } })
    : null;
});
```

- **The id** is lower-case letters, digits and `-`, starting with a letter. `trigscript` is
  taken. A second library with the same id replaces the first.
- **A module** ends in `.ts` (or `.tsx` for JSX) and may sit in folders (`ai/waves.ts`). It
  imports the library's other modules by a relative path (`./spawn`), another library by its
  id, and `"trigscript"` and the standard library as a script does. Test files are refused:
  the script's tests would run them.
- **The version** is what the map maker sees beside the map's copy. Change it with every
  release, so a map with an older copy is offered the update.

A plugin cannot import a `.ts` file as text, so the modules travel as strings.
[`examples/library`](examples/library) is a complete library plugin to copy: its TrigScript
is in `lib/`, `node embed.mjs` writes it into `modules.ts`, and `plugin.ts` provides it. It
installs as it is from `github:scm-js/plugin-trigscript/examples/library`.

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
| `service.ts` | What the plugin does to the map: names off `api.settings` / `api.names` / `api.query`, the members through `api.document.extras`, an apply as one `document.update`, and its part in saving (`attach`): `buildSteps.before` applies a script that is newer than its block; the plugin's own build step (`buildOwn`, `compiler/backend/build.ts` in the compile worker) lays the programs out into the scenario the editor hands it, and fails with the reason, worded for the notice, when the build does not take the script or Magenta's triggers are in the map. A compile is `prepare`d into an artifact stamped with the map's id and a hash of its names, and `install` refuses an artifact whose map is not the one in front: the dialog compiles once and installs that, never a second run. |
| `editor.ts` | The dialog: the file list and Monaco, plain DOM in the editor's own classes. |
| `tree.ts` | The files as folders, and a move that takes the imports with it. Pure over strings. |
| `testState.ts` | What the workspace shows of a compile's test report: results kept between runs, marks, the failures said at their lines, the warnings, the Testing view's tree. |
| `monaco.ts` | Monaco from `dist/` on jsDelivr's GitHub mirror (the tag `DIST_TAG` names; the workers start as blob module workers), one model per file under `file:///` so imports resolve, the theme. The plugin storage key `monacoDist` overrides where the files are fetched from: set `scmjs.plugin.trigscript.monacoDist` in the browser to `"http://localhost:3000/dist"` while developing. |
| `ko.ts`, `i18n.ts` | The Korean for everything the workspace shows, English as the key, registered with `api.i18n` at activation; the open workspace is built again when the editor's language changes. Menu labels and command titles are English marked with `msg()`, and the editor translates them where it draws them. The language, the compiler's diagnostics and what a command returns stay English. `tests/ko.test.ts` keeps the catalogue and the source in step. |
| `bundle/`, `dist/` | `npm run bundle` builds Monaco with esbuild (the editor core, its features and the TypeScript language alone, styles injected by the module and the codicon font inlined, plus the two workers) and writes `lib.d.ts`, the standard library the compile worker checks scripts against (`bundle/lib.mjs`), into `dist/`, which is committed. A CDN's on-the-fly bundler turns Monaco's lazy language chunks into standalone bundles carrying a second editor core, which is why the plugin carries its own. After a Monaco bump: rebuild, commit, tag `monaco-<version>-<n>`, move `DIST_TAG`. |
| `compile.ts` | Compiling in a worker: a blob worker `importScripts` TypeScript from the CDN, fetches `lib.d.ts` once, and imports this plugin's own compiler module by the `blob:` URL the editor's loader gave it; a request the script does not answer in fifteen seconds (an endless loop outside `program()`) terminates the worker. A worker that cannot import the blob is replaced by one that imports the release's `dist/compiler.js`; when that fails too the compile rejects with `CompilerUnavailable` and a later one starts over. The script is never run on the main thread, where an endless loop could not be stopped. |
| `script.ts` | The files, the block and its manifest: hashing (the block, and every record on its own), finding the block by content, staleness and what a stale block can still be taken apart into, planning a build. Pure over a trigger list and a map of the members. |
| `compiler/` | The language. `names.ts` and `declarations.ts` generate the `.d.ts`; `runtime.ts` is the library the script calls; `compiler.ts` checks the files as one `ts.createProgram`, collects the map references, emits them through `hoist.ts`'s transformer, links and runs them (`link.ts`), and turns each `program()`, and the `game()` functions it calls, through `structured.ts` (with `scope.ts`, what a name is bound to, and `tables.ts`, the game's tables) into the IR (`ir.ts`, `docs/ir.md`); `input.ts` sets up what the programs read of keys, mouse and chat, `numbers.ts` writes into every operation whether it reads its 32 bits as a `number` or a `u32`, `recursion.ts` finds the functions that call themselves and what each call has to keep, and `check.ts` checks the result (a loop that never sleeps, a constant divisor, a constant that does not fit its width); `backend/` is the build of a map of our own: `emit.ts` lowers a program's whole body to a graph of the game's triggers, `own.ts` every program of a script (and says what it does not take), `layout.ts` lays the graph out as the game's trigger nodes at the addresses Remastered keeps the strings at, `build.ts` does it to a scenario's bytes (`chk.ts` reads and writes the sections it touches, `fixes.ts` does what eudplib does to a map before writing it, `maps.ts` says where each trigger and each variable is for the tools that read a built map in the lifted game); `simulate.ts` is the trigger-cycle interpreter and `simulateIr.ts` the program interpreter, which computes every number the way the Python does, the two over the one world of `world.ts` (the unit table, the players and forces, what is done to units and what the unit conditions count); `testing.ts` is the script's own `test()`s: the registry the script fills as it runs, `sim` and `expect`, and the runner, whose report is plain data because it crosses from the compile worker; `lower.ts` is what the raw level still needs (condition negation, hyper triggers); `print.ts` is the inverse for records; `api.ts` and `record.ts` are the shared vocabulary. Nothing in here touches the DOM or the editor. |
| `vendor/` | The tables the compiler reads, copied from the editor: the trigger record layout and its codec, the condition and action definitions, the unit names, the flag names, the text format's printer and parser. The editor is the source of truth; copy them again when it changes. |
| `dist/plugin.js`, `dist/compiler.js` | The bundle the editor loads, and the compiler alone (`compiler/entry.ts`) for the compile worker of a copy compiled into the editor, which has no `blob:` module to hand it; `npm run build` writes both. Commit both before tagging (CI commits and checks `plugin.js` on its own). |
| `dist/testing.js`, `dist/testing.d.ts` | Not loaded by the plugin. The trigger text parser (`vendor/text.ts`), the trigger interpreter and its world, and the record constants, bundled from `compiler/testingEntry.ts` so that another repository's tests can run trigger text instead of reading it, and compile a script (`compileScript`, `defaultScriptNames`, `defaultLib`) to check that the TrigScript it shows a model still compiles: a devDependency on the tarball of one of this repository's tags (`https://github.com/scm-js/plugin-trigscript/archive/refs/tags/v3.10.4.tar.gz`), then `import { parseTriggers, Simulation } from "scmjs-plugin-trigscript/testing"`. `npm run build` writes both and CI holds them to the same rule as `compiler.js`. |
| `tests/` | vitest. `script.test.ts` pins the names, the declarations, the runtime's argument handling, files and imports, the printer and the block logic; `script-structured.test.ts` compiles programs and asserts the simulation, and a file a part of the language does the same for it (`arrays`, `grids`, `callbacks`, `destructuring`, `functions`, `recursion`, `classes`, `strings`, `hash`, `leftovers`, `units`, `input`); `hash` and `leftovers` also run each body in JavaScript itself and compare what was printed; `readme.test.ts` compiles every example of this file, and checks what an example says it prints; `simulate-ir.test.ts` pins the program interpreter's contract with the game (frames, and how a number comes out); `service.test.ts` the apply and the part in saving (the build step) against a stand-in host and library; `own-build.test.ts` the build of a map of our own from a scenario's bytes (the payload after the strings, the start-up, eudplib's fixes, the map's triggers, the input's properties slot, a refusal said, the maps of triggers and variables) and the built file walked as the game walks it (`ownWalk.ts`), its lines against the simulator's and its variables read through the map; `eud-build.test.ts` builds golden maps through a plugin-eudplib checkout beside this repository when there is one; `refs.test.ts` the references and renames. Copies of Blizzard's own maps in `fixtures/maps/` (gitignored) make every trigger eject to script and run back to the same record. |

### How the compiler is built

`names.ts` turns the map into name tables (players, units, locations, switches, AI
scripts, and the fixed weapons, upgrades and technologies `stats()` takes). Each entry's
keys are an identifier derived from the display name first (`Terran Marine` →
`TerranMarine`), the display name itself second, then custom names, unique per table by
construction. `declarations.ts` generates the `.d.ts` from them plus
the library: values are branded literal types (`UnitType<0> = 0 & Brand<"unit">`; plain
numbers still pass, a `Location` where a `UnitType` belongs does not), enumerated kinds are
string unions of the canonical words, every condition and action is a `declare function`
whose identifier is its `ConditionType` / `ActionType` key in camel case, and the whole
thing is declared twice: as globals and as the ambient module `"trigscript"`.

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
`random()`, nor a call of a `game()` function, whose type carries a brand), and a
`const` of the body whose initialiser is hoistable is a build-time constant. The emit
transformer appends its position to every `trigger()` call and replaces each planned
arrow with a descriptor holding a function that returns the hoisted expressions as
thunks and the constants as memoised thunks, every reference to a constant rewritten to a
call of its thunk, so a constant is computed when first needed and never in a pruned
branch. The emitted CommonJS is linked by `link.ts` (relative imports against the files,
`"trigscript"` to the runtime, the library's names in scope as globals) and run; an
error the script throws is placed through the emitted source map. `game(descriptor)`
returns a function that throws if the script calls it and carries the descriptor for
the walker.

`structured.ts` then walks each program body against the same plan, with the thunks the
descriptor's function returned: where the plan says an expression was hoisted, the walker
takes its value: a number, a boolean, a condition, an action or a list of them. `let` →
a variable of the IR (a number, a boolean, a unit, a text), a record of them (an object
literal, an instance of a class) or an array, bound
in a scope keyed by declaration node so shadowing and inlining resolve as the checker
does; expressions become IR expressions as written; `&&` / `||` / `!` stay what they are,
and the lowering short-circuits them; functions declared in the body and `game()`
functions are `call` nodes, inlined where a function is first met, the walker switching
to the function's own plan, file and thunks for the duration, and from the second time on
a call of one body kept in `Program.functions`, when the function compiles with every
parameter a variable (the attempt's diagnostics are thrown away, and a first call already
inlined is changed to match; `settleFunctions` then inlines again whatever is left with one
call); a call, member access or arithmetic over
values a parameter was bound to is evaluated on the spot; a `for` whose bounds evaluate
is unrolled like a `for…of`; an action with a variable argument carries the expression
beside its record. The thunks are memoised in the bodies, so the script's build-time
parts run once.

TrigScript's own build is `compiler/backend/` (see the `compiler/` row above): a program's
body becomes one graph of triggers, laid out after the map's strings. Arithmetic is 32 bits
that wrap, and each comparison, division, shift right, `min`, `max` and printed number reads
them signed or unsigned as `numbers.ts` marked it. An array that grows is a block of one heap
the programs share (sizes double, and a block given back serves the next array of its size),
and a made text is such a block of bytes; an array's cells sit beside the heap's bytes as
cell triggers, 72 bytes each, so that a read or a write is a jump into the cell. A function
that is called is one body with its parameters as variables; one that calls itself keeps
what a call would overwrite on a stack of its own, a region beside the heap whose depth the
script's Settings give. A per-player program is laid out once for each of its owners, with
variables of its own but for the shared ones. A read is the condition itself where a table
of the game is the value (a player's deaths, kills, ore, gas; the player bytes and the supply
tables) and otherwise a search with the condition, "at least" a bit at a time from the top,
so it means what the condition means. A text with values in it is written over a string of
the map's table as long as its template, which is then shown. `docs/ir.md` says what each
node means to the backend. `simulateIr.ts` mirrors all of it, wrap included, so that what
Simulate shows is what the game does. (Until TrigScript 4's step 17 a second lowering,
`python/trigscript.py`, built through eudplib what the backend did not take yet; step 16's
random whole programs, run both ways, held the two to the same lines before it went.)
