# TrigScript

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It keeps TypeScript files inside the map and turns them into the
map's triggers.

The files are real TypeScript. They *run* when the script is applied, and every
`trigger()` call they make records one trigger of the map, so helpers, loops over the
players, arrays, classes and the standard library are all there. Those are ordinary
triggers and play on every version of the game.

Code inside `program(() => { … })` is the other half: it runs *in the game*, with
variables, loops, functions and `sleep`. A program is built into the map by
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
`github:scm-js/plugin-trigscript@v3.1.1`. The map maker's guide to the language is
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
| **Explorer**, at the left (Ctrl+B) | The script's files — `main.ts` is where the script starts, the *New file* icon on the section adds another, and a file's pencil and bin rename and remove it — and under them the **programs** with the variables each keeps in the game. A click goes to the line. |
| **Tabs**, over the editor | One per open file; a file with problems is red, with their count. Go to Definition on a name another file exports opens that file. |
| **Run controls**, right of the tabs | Test (F5), Simulate (Ctrl+F5), Apply (Ctrl+Shift+B), Pick from map, the switch between the window and the panel beside the map, and **…** for the rest. |
| **Panel**, under the editor (Ctrl+J) | **Problems** (Ctrl+Shift+M), **Output** (Ctrl+Shift+U) — what Apply, Test and the builds of the programs reported, with the build log — and **Simulate**. It takes its room from the bottom, and only when asked for or when something failed. |
| **Status bar** | The problem count, whether the script's triggers are in the map (a click applies it), the last build of the programs, the eudplib plugin's state, the cursor. |
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
the Trigger Editor without saving. **Test** applies, builds the map exactly as Save would
and hands it to Test Map: on the desktop the game starts with it, in a browser it goes
into the test folder you picked once.

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
with its frame and source line, plus each program variable's final value. The `trigger()` records run in a trigger
interpreter (death counters, switches, preserve, list order) and the programs in a
program interpreter that computes every number the way the game will, the two sharing one
world, so a program's `setDeaths` is seen by a trigger and the other way round. Reads
find what the simulation holds — death counters, the resources the programs themselves
set, the clock — and 0 for what it does not (unit counts, kills, scores); a printed text
shows with its numbers filled in and "Player 1" for a name. Unit conditions answer "false".
Units are the ones placed on the map, where they were placed and with the hit points their
type and their own settings give, inside the map's locations as they are drawn: a loop
over units, a pick, `kill()`, `give()`, a hit-point write all work on that list, and
`stats()` holds what the program wrote. Nothing moves or fights, and `createUnit` makes no unit. The same interpreters are what the test suite uses to prove
programs behave.

A script with programs shows, at the right of the status bar, whether the eudplib plugin
is running and whether its runtime is on this machine yet. The runtime — Pyodide, a
Python for the browser, and eudplib — is downloaded once, about 15 MB, after asking, the
first time a map with a program is saved; the desktop app and the container image carry
it. Every build after that runs on this machine and nothing about the map leaves it. The
status bar says how the last build went, Output keeps its log, and a failure that names a
line puts a marker on it.

The files and a build manifest live in the map archive itself, under `trigscript\`
(`trigscript\main.ts`, `trigscript\build.json`, …) next to `staredit\scenario.chk`, so
they travel with the `.scx`. The editor's Save dialog lists them under the archive's
other files, with a tick each, so a copy for release can leave the source out.

## The language

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

**Variables** hold numbers and booleans. A `let p = { lives: 3, gold: 0, alive: true }`
is a **record**: a variable per field (`p.lives -= 1`, `if (p.alive)`), nested ones
included, declared types (`let p: { n: u8 } = { n: 0 }`) honoured, and a record passed to
a function reaches it by reference. They live in the game's memory while the map is
played and cost the map nothing: no death counters, no switches, no triggers in the list.

**Numbers** are 32-bit and never below zero: 0 to 4 294 967 295. An expression means what
it says. `a = a + b - 5` is the whole sum, then stored — a result below zero is stored as
0, one at 2³² or above wraps — and a `u8` or `u16` (`let lives: u8 = 3`) stops at its
maximum *after* the whole sum, never between its parts; a constant that does not fit one
is a compile error. A comparison is exact too: `if (a - b < 0)` is true when `b` is
larger, because what either side subtracts is added to the other before they are
compared, and `Math.abs(a - b)` is the distance whichever is larger. The one thing a
32-bit cell cannot promise is a running sum of the additions past 2³²: `a + b - 1` with
`a` at 4 294 967 295 wraps at the `+`.

**Arithmetic**: `+ − * / %` between variables and constants, `*=` `/=` `%=`, `++` `--`,
`Math.min`, `Math.max`, `Math.abs`, `clamp(x, lo, hi)`, and the bitwise `& | ^ << >>`
(with `&=` and the rest) over the same 32 unsigned bits — `>>` and `>>>` are one, and a
shift by 32 or more leaves 0. `/` is whole division (there are
no fractions in the game; `Math.floor`, `Math.trunc`, `Math.round` and `Math.ceil` around
it are accepted and change nothing), `*` wraps at 2³², and dividing by a variable that is
0 in the game gives 0. Dividing by a constant 0 is a compile error.

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

**Functions are inlined** at every call site, and arguments pass by value, as in
TypeScript: `function bump(x: number) { x++; }` leaves the caller's variable alone. A
parameter the function never assigns reads the argument's variable directly; one it
assigns is a copy made at the call. Locals are their own per call site. A function may
**return a number or a boolean** — `function canAfford(price: number) { return gold >=
price; }`, `x = twice(y) + 1`. A function may `sleep`: the program resumes inside it.
There is no recursion.

Functions the game runs can live in any file: `game()` marks them.

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

A `game()` function follows the program's rules — its body is inlined at each call, and
what it does is attributed to its own file and line. It sees its parameters and what any
file sees when the script is applied, not the calling program's variables. Calling one
outside a program is an error: it runs in the game, not when the script is applied.

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
parameter of an inlined function that was bound to a value does reach them, so
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

**Reads: every quantity a condition compares is also a value.** Leave the comparison and
the amount out of the call and it is a read, a number like any other:

```ts
if (deaths(P1, units.TerranMarine, ">=", 10)) …        // a condition, as ever
let lost = deaths(P1, units.TerranMarine);             // a read
if (minerals(CurrentPlayer) > price * 2) …             // compared with a variable
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

**A text can hold the program's values.** `displayText` takes a template literal (or
texts joined with `+`) with numbers of the program in it, `name(p)` and `color(p)`:

```ts
displayText(`${color(P2)}${name(P2)}\x01 has ${minerals(P2)} ore — wave ${wave + 1}`);
print(`Wave ${wave}`, { to: AllPlayers, position: "center" });
```

`name(p)` is the player's name and `color(p)` the colour code of their colour, both
filled in by the game; the ordinary colour codes work as ever. `displayText` shows it to
the current player, as it always has; `print(text, { to, position })` is the way to
show it to someone else — a player, `AllPlayers`, a force — or, with `position:
"center"`, on the line in the middle of the screen where the game's own messages ("Not
enough minerals") appear. Only `displayText` and `print` do this: every other text (a
mission objective, a leaderboard's label, a transmission) is fixed when the script is
applied. A boolean has no text of its own, and text is shown, not stored: there are no
string variables. A text with nothing of the program in it stays the plain Display Text
action it was. None of a program's texts enter the map's string table.

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

Still to come: `test()` blocks that run a script against the simulator, a debugger that
steps it, and a gallery of examples. The plan is `docs/eud-plan.md`, and the IR the
compiler hands eudplib is `docs/ir.md`.

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
| `monaco.ts` | Monaco from `dist/` on jsDelivr's GitHub mirror (the tag `DIST_TAG` names; the workers start as blob module workers), one model per file under `file:///` so imports resolve, the theme. The plugin storage key `monacoDist` overrides where the files are fetched from — set `scmjs.plugin.trigscript.monacoDist` in the browser to `"http://localhost:3000/dist"` while developing. |
| `bundle/`, `dist/` | `npm run bundle` builds Monaco with esbuild — the editor core, its features and the TypeScript language alone, styles injected by the module and the codicon font inlined, plus the two workers — and writes `lib.d.ts`, the standard library the compile worker checks scripts against (`bundle/lib.mjs`), into `dist/`, which is committed. A CDN's on-the-fly bundler turns Monaco's lazy language chunks into standalone bundles carrying a second editor core, which is why the plugin carries its own. After a Monaco bump: rebuild, commit, tag `monaco-<version>-<n>`, move `DIST_TAG`. |
| `compile.ts` | Compiling in a worker: a blob worker `importScripts` TypeScript from the CDN, fetches `lib.d.ts` once, and imports this plugin's own compiler module by the `blob:` URL the editor's loader gave it; a request the script does not answer in fifteen seconds (an endless loop outside `program()`) terminates the worker. A main-thread fallback loads TypeScript through a `<script>` tag. |
| `script.ts` | The files, the block and its manifest: hashing (the block, and every record on its own), finding the block by content, staleness and what a stale block can still be taken apart into, planning a build. Pure over a trigger list and a map of the members. |
| `compiler/` | The language. `names.ts` and `declarations.ts` generate the `.d.ts`; `runtime.ts` is the library the script calls; `compiler.ts` checks the files as one `ts.createProgram`, collects the map references, emits them through `hoist.ts`'s transformer, links and runs them (`link.ts`), and turns each `program()` — and the `game()` functions it calls — through `structured.ts` into the IR (`ir.ts`, `docs/ir.md`), which `eud.ts` checks (a loop that never sleeps, a constant divisor, a constant that does not fit its width) and serialises with every text written out; `python/trigscript.py` is the other half, the euddraft plugin that lowers the IR to eudplib, embedded by `npm run embed`; `simulate.ts` is the trigger-cycle interpreter and `simulateIr.ts` the program interpreter, which computes every number the way the Python does; `lower.ts` is what the raw level still needs (condition negation, hyper triggers); `print.ts` is the inverse for records; `api.ts` and `record.ts` are the shared vocabulary. Nothing in here touches the DOM or the editor. |
| `python/trigscript.py` | The Remastered lowering: the euddraft plugin that turns the IR into eudplib code, handed to the eudplib plugin with every build. `npm run embed` writes it into `compiler/generated/trigscriptPy.ts`; `tests/python.test.ts` fails when the two drift. `scripts/build-fixture.mts` builds a script into a playable map under Node through a plugin-eudplib checkout; `probes/spike.ts` is the probe script (its built map lands in the ignored `fixtures/` folder, since it sits on a Blizzard map). |
| `vendor/` | The tables the compiler reads, copied from the editor: the trigger record layout and its codec, the condition and action definitions, the unit names, the flag names. The editor is the source of truth; copy them again when it changes. |
| `dist/plugin.js`, `dist/compiler.js` | The bundle the editor loads, and the compiler alone (`compiler/entry.ts`) for the compile worker of a copy compiled into the editor, which has no `blob:` module to hand it; `npm run build` writes both — commit both before tagging (CI commits and checks `plugin.js` on its own). |
| `tests/` | vitest. `script.test.ts` pins the names, the declarations, the runtime's argument handling, files and imports, the printer and the block logic; `script-structured.test.ts` compiles programs and asserts the simulation; `simulate-ir.test.ts` pins the program interpreter's contract with the game (frames, and how a number comes out); `service.test.ts` the apply and the part in saving, against a stand-in host and library; `eud-build.test.ts` builds golden maps through a plugin-eudplib checkout beside this repository when there is one; `refs.test.ts` the references and renames. Copies of Blizzard's own maps in `fixtures/maps/` (gitignored) make every trigger eject to script and run back to the same record. |

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
a variable of the IR (number or boolean) or a record of them (an object literal), bound
in a scope keyed by declaration node so shadowing and inlining resolve as the checker
does; expressions become IR expressions as written; `&&` / `||` / `!` stay what they are,
and the lowering short-circuits them; functions declared in the body and `game()`
functions are inlined per call as `call` nodes — the walker switches to the function's
own plan, file and thunks for the duration; a call, member access or arithmetic over
values a parameter was bound to is evaluated on the spot; a `for` whose bounds evaluate
is unrolled like a `for…of`; an action with a variable argument carries the expression
beside its record. The thunks are memoised in the bodies, so the script's build-time
parts run once.

`python/trigscript.py` lowers a program to straight-line eudplib triggers with jumps
between labels. `sleep` stores the label to resume at in a state variable, sets a frame
counter and leaves the frame; the frame's entry counts the wait down and jumps to the
stored label. A sum is flattened into what it adds and what it subtracts, each side
totalled, the difference stopping at 0; a comparison moves what a side subtracts to the
other; `abs` is the distance between the two totals. A per-player program loops over the
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
