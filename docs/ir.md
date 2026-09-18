# The TrigScript IR

What a `program(() => { … })` body means, written down as data. The compiler's front end
(`compiler/structured.ts`) turns the TypeScript into this, `python/trigscript.py` lowers
it to eudplib when the map is saved, and `compiler/simulateIr.ts` interprets it for
Simulate and the tests. **Version 3** (2 had no reads, no `random(n)`, no bitwise operators
and no `print`; 1 had the map's string indices in the records and a `cyclesPerSecond` on
the program, for the death-counter backend 3.0 removed). The types
are in `compiler/ir.ts`; this is the reference for anyone reading the lowering or writing
another.

## What is settled before the IR

Everything TypeScript-specific is gone by the time a program reaches the IR:

- Build-time values are evaluated. `bring(P1, units.Marine, base, ">=", 1)` is a
  condition record; `waves[2].count` is a number; a `const` computed when the script is
  built is its value.
- Records (`let p = { lives: 3, alive: true }`) are a variable per field, named
  `p.lives`, `p.alive`.
- Functions are inlined at each call as a `call` node holding the body, with
  parameter copies where the function assigns a parameter, and a result variable when
  it returns something. `return` inside the body writes the result and leaves.
- `for` loops whose start, bound and step are known, and `for…of` over a known list,
  are unrolled into an `unrolled` node: the body once per value.
- `if (false)` and `while (false)` are pruned; `if (true)` keeps only its then side.
- `once()` / `rose()` are `edge` expressions; `random()` is a `random` expression;
  `clamp(a, lo, hi)` is `min(max(a, lo), hi)`.
- What a read reads is known: `minerals(P1)` and `deaths(P1, unit)` arrive as `read`
  nodes with the player, the unit and the location as numbers. `isHuman(p)` is a
  comparison of the slot's byte with 2, `hasLeft(p)` of the left flag with 1.
- A text is in parts: a template literal, a `+` of texts and the `name()` / `color()`
  marks inside any string are taken apart into written text, number expressions, names
  and colours. A text with none of those stays the `text` of a Display Text action.

What is *not* settled is anything the lowering decides: what a temporary is, how a
`sleep` parks the program, how a per-player program finds its players.

## Programs

```
Program { version, name?, owner, owners, perPlayer, body: Stmt[], at }
```

`owner` is the first player slot among the owners (what a simulation runs the program
as); `owners` every player group the program was declared for — slots 0–7, All Players
(17) or a force (18–21), which the lowering resolves to the map's human and computer
players; `perPlayer` whether each player has variables of their own. A program runs every
frame; `sleep`'s `cycles` counts frames and its `ms` is twenty-four frames a second.

Every node carries `at: { file, line, column }`, 1-based, and most statements a `label`,
the statement as the source has it ("L12: while (x < 3)"), for a log or a debugger.

## Variables

```
VarDecl { id, name, kind: "number" | "boolean", shared, bits?: 8 | 16, temp?, at }
```

`id` is unique within the program (`name#n`); `name` is the source's. `shared` is a
`shared(…)` variable of a per-player program (one cell for everyone). `bits` is a `u8` /
`u16` annotation. `temp` marks a backend's scratch value that dies with its statement (a
call's result). A variable exists from its `declare` statement on; a backend allocates
storage in that order.

## Statements

| Kind | Fields | Meaning |
| --- | --- | --- |
| `declare` | `decl`, `init`, `failed?` | The variable exists from here, holding `init` (a number or boolean expression). `failed` means the initializer did not compile — reported already — and the variable is left unset. |
| `assign` | `target`, `value` | `target = value` for a number. `x += y` and `x++` arrive as `x = x + y`, `x = x + 1`. |
| `assignBool` | `target`, `value` | `target = value` for a boolean. |
| `if` | `cond`, `then`, `else?` | As it reads. |
| `while` | `cond?`, `body` | `cond` absent means `while (true)`, or a condition known true when the script was built. |
| `do` | `body`, `cond`, `condLabel` | `do { … } while (cond)`. |
| `for` | `cond?`, `update`, `body` | A loop over a variable; its init statements precede the node. `continue` runs `update`. |
| `unrolled` | `iterations: Stmt[][]` | A loop unrolled when the script was built: each list is the body for one value, in order. `break` leaves the whole thing; `continue` moves to the next list. |
| `switch` | `value`, `cases: { value, body }[]` | Cases tested in order; `value` null is `default`, `NaN` a case whose value could not be read (no test, still fallen into). Bodies fall through unless they `break`. |
| `break`, `continue` | | Of the nearest loop (`break` also of a `switch`). |
| `return` | `value?` | Inside a `call` body: writes the result and leaves the call. |
| `sleep` | `ms?`, `cycles?` | Park the program: a duration in milliseconds, or in trigger cycles. |
| `print` | `parts`, `to`, `position` | Text with values in it. `parts` are `{ kind: "text", text }`, `{ kind: "number", expr }` (its digits), `{ kind: "name", player }` and `{ kind: "color", player }` (the colour code of the player's colour), a player being a slot or 13 for the current player. `to` is who sees it: a slot, 13, All Players (17) or a force (18–21). `position` is `chat` or `center`, the line the game's own errors use. Every number is evaluated before anything is shown. |
| `action` | `record`, `variable?` | A trigger action. `variable` names a field of the record that takes an expression's value: `{ field, bits: 8 or 32, name, expr }` — the unit count of `createUnit` and friends is an 8-bit field, an amount with a modifier a 32-bit one. |
| `call` | `call` | An inlined function as a statement (its result, if any, unused). |
| `block` | `body` | Scoping only. |
| `remark` | `text`, `short?` | A word for the editor about the line: a loop unrolled when the script was applied. |

## Expressions

Numbers (`NumExpr`):

| Kind | Fields |
| --- | --- |
| `const` | `value` (a whole number) |
| `var` | `id` |
| `unary` | `op: "-"`, `expr` |
| `binary` | `op: + - * / % & | ^ << >>`, `left`, `right` |
| `read` | `read` — a value of the game, taken when the expression is evaluated (below) |
| `randomInt` | `bound` — a whole number from 0 to `bound` − 1, fresh at every evaluation; 0 when `bound` is 0 |
| `ternary` | `cond`, `whenTrue`, `whenFalse` |
| `intrinsic` | `name: min | max | abs`, `args` |
| `call` | `call` (its result is the value) |

Booleans (`BoolExpr`):

| Kind | Fields |
| --- | --- |
| `const` | `value` |
| `cond` | `record` — a trigger condition, fields known |
| `var` | `id` of a boolean variable |
| `test` | `expr` — a number tested `!= 0` |
| `compare` | `op: < <= > >= == !=`, `left`, `right` |
| `and`, `or` | `items` |
| `not` | `expr` |
| `random` | a coin toss, fresh at every evaluation |
| `edge` | `edge: rose | once`, `cond` |
| `ternary` | `cond`, `whenTrue`, `whenFalse` |
| `call` | `call` (its boolean result) |

`a == b` between booleans arrives expanded: `(a && b) || (!a && !b)`.

A `Call`:

```
Call { name?, at, label, params: { decl, init, label }[], result?: { decl, kind }, body: Stmt[] }
```

`params` are the parameters bound by copy (the function assigns them), each a variable
initialised from the argument; a parameter the function only reads is the caller's own
variable, already substituted in the body. `result` is the variable `return` writes.

## Reads

```
{ source: "condition", record }                       what a comparing condition compares
{ source: "player", fact: "race" | "slot" | "left", player }
{ source: "supply", of: "used" | "max" | "provided", race: 0 | 1 | 2 | null, player }
```

A `condition` read carries the condition's own record with "at least 0" in it — Deaths,
Kill, Bring, Command, Accumulate, Score, Opponents, Countdown Timer, Elapsed Time (both
in *game* seconds, sixteen frames each, so about one and a half to a second of `sleep`) — and
means exactly what that condition would be asked: a group of players is the group's
figure, a unit class what the condition counts. The lowering reads the game's table
where one holds the value (a single player's deaths, kills, ore, gas) and otherwise
searches with the condition, "at least" a bit at a time from the top; either way the
result is the number for which "exactly n" would hold. `player` reads are bytes of the
player tables: race 0 Zerg, 1 Terran, 2 Protoss; slot 0 empty, 1 computer, 2 human, 3
rescuable, 7 neutral — a computer of a Use Map Settings game is 5 in the game's table (the
probe read that) and arrives as 1. `left` is 1 once a player the map's settings have as a
human or a computer is gone (slots 0–7), asked as eudplib's `f_playerexist` asks, from the
player's trigger list: the byte table at 0x581D62 reads 0 for a player who is there, but
nobody has watched it change. `supply` is as the top
bar shows it — the tables hold half supplies, so used is rounded up and the others down —
for one race, or for the race the player plays (`race` null), 0 when the slot plays none.
In these two `player` is a slot or 13, the player the program is running as.

## Numbers

Unsigned 32-bit, and the lowering and the interpreter agree on every case:

- A run of `+` and `−` (unary minus and constants below zero included) is flattened into
  what it adds and what it subtracts. Each side is totalled — exactly while every term is
  a constant, wrapping at 2³² once a variable is part of it — and the value is the
  difference, stopping at 0.
- A comparison flattens both sides together: what the left subtracts is added to the
  right and the other way round, then the two totals are compared. `a - b < 0` is true
  when `b` is larger; `x >= -1` is true.
- `abs(e)` is the distance between what `e` adds and what it subtracts.
- `& | ^` are over the 32 bits; `<<` drops what leaves the top and `>>` fills with zeros;
  a shift by 32 or more gives 0.
- `*` wraps at 2³². `/` and `%` round down; a constant divisor must be a whole number of
  at least 1 (the compiler checks), a variable divisor that is 0 in the game gives 0.
- Stored into a variable, a value at 2³² or above wraps and a `u8` / `u16` stops at its
  maximum. Booleans are 0 or 1.
- An action's variable `modifier` (a unit count) means that many units: the lowering does
  the action once for each, so 0 is none and 300 is 300.

## Records

`ActionRecord` and `ConditionRecord` are the map's own trigger records, as
`vendor/triggers.ts` names their fields. Inside the compiler an action's `text` and
`wav` hold *local* string ids (into the compile's `strings`); `serializeIr` in
`compiler/eud.ts` writes the JSON with the text itself in their place — eudplib adds it
to the built map's string table, so a program's strings never enter the map the user
edits — or a number where the script named an index of the map's own.
