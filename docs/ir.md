# The TrigScript IR

What a `program(() => { … })` body means, written down as data. The compiler's front end
(`compiler/structured.ts`) turns the TypeScript into this, `python/trigscript.py` lowers
it to eudplib when the map is saved, and `compiler/simulateIr.ts` interprets it for
Simulate and the tests. **Version 14** (13 had no text in the cells of an array: no `textAt`, `storeText`, `releaseText`; 12 had no texts: a text was the parts of a `print` and nothing else; 11 had no `slice` and no `through`: every array was cells of its own; 10 had no recursion: no `recursive`, no `saves`, and the heap's top set aside for a stack nothing used; 9 had no functions that are called: every `call` carried a body of its own; 8 had no `unitAt` / `unitPart`, so no array could hold a unit; 7 had no arrays that grow; 6 had no arrays; 5 had unsigned numbers only, the two-sided reading of `+` and `−`, no `>>>` and no `unsigned` anywhere; 4 had no input, no `centerLocation`, and one `variable` on an action where 5 has a list; 3 had no units and no tables; 2 had no reads, no `random(n)`, no bitwise operators
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
- A function used once is inlined at its call as a `call` node holding the body, with
  parameter copies where the function assigns a parameter, and a result variable when
  it returns something. `return` inside the body writes the result and leaves. A function
  used more than once is, when it can be, one of `Program.functions`, and its `call` nodes
  name it (`fn`) in place of carrying a body — see *Functions that are called*.
- `for` loops whose start, bound and step are known, and `for…of` over a known list,
  are unrolled into an `unrolled` node: the body once per value.
- `if (false)` and `while (false)` are pruned; `if (true)` keeps only its then side.
- `once()` / `rose()` are `edge` expressions; `random()` is a `random` expression;
  `clamp(a, lo, hi)` is `min(max(a, lo), hi)`.
- What a read reads is known: `minerals(P1)` and `deaths(P1, unit)` arrive as `read`
  nodes with the player, the unit and the location as numbers. `isHuman(p)` is a
  comparison of the slot's byte with 2, `hasLeft(p)` of the left flag with 1.
- Which units a loop or a pick looks at is known: the type, the owner and the location of
  a filter are numbers. `stats(units.TerranMarine).minerals` is a cell of the game's
  tables with its address worked out; a value known when the script was built is already
  scaled to what the cell stores.
- A text is in parts: a template literal, a `+` of texts and the `name()` / `color()`
  marks inside any string are taken apart into written text, number expressions, names
  and colours. A text with none of those stays the `text` of a Display Text action.

What is *not* settled is anything the lowering decides: what a temporary is, how a
`sleep` parks the program, how a per-player program finds its players.

## Programs

```
Program { version, name?, owner, owners, perPlayer, arrays: ArrayDecl[], functions?: FuncDecl[], body: Stmt[], at }
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
VarDecl { id, name, kind: "number" | "boolean" | "unit" | "text", text?: "id" | "made", shared, bits?: 8 | 16, unsigned?, temp?, at }
```

`id` is unique within the program (`name#n`); `name` is the source's. `shared` is a
`shared(…)` variable of a per-player program (one cell for everyone). `bits` is a `u8` /
`u16` annotation, `unsigned` a `u32`; with neither a number is signed. `temp` marks a backend's scratch value that dies with its statement (a
call's result). A variable exists from its `declare` statement on; a backend allocates
storage in that order. A `unit` variable holds a unit of the game or none; its `declare`,
a parameter's `init` and a `return` carry a unit expression (below). A `text` variable
is kept the way `text` says (*Texts*, below).

## Arrays

```
ArrayDecl { id, name, kind: "number" | "boolean", length, shared, bits?: 8 | 16, unsigned?, values?: number[], dynamic?, slice?, through?, at }
```

`Program.arrays` lists every array of the program, those of inlined functions included, so a
backend allocates them before anything runs: `length` cells, known when the script was built;
twelve rows of that in a per-player program unless `shared`. A cell is typed as a variable is
(`bits`, `unsigned`). `values` marks a list the script computed when it was built and a program
indexes with a value of its own — `const price = [50, 100, 150]; price[level]` — which is in the
map as it loads, is one for every player, and is never stored into (the front end refuses it; a
boolean list arrives as 1s and 0s). One `ArrayDecl` per list, however often it is read. A
`const` list the body *stores* into is an ordinary array (`hoist.ts` finds the stores first).

An array is declared by `declareArray`, which sets its cells, and used through `element` (a
number or a boolean, by the array's kind — as with `var`, the shape alone does not say) and
`store`. An index is any number expression. **Past either end a read is 0 (false) and a store
does nothing**; the index is read from 0 up, so one below zero is past the end. A constant
index is checked when the script is built and is an error; the interpreter records the rest in
`faults`, since in the game they pass without a word. An array handed to a function is the
same array (the parameter is bound to it, as a record's is). `for (const x of xs)` arrives as a
`for` over a hidden index with `x` declared from the cell at the top of the body.

### Arrays that grow, and the heap

`dynamic` marks an array something pushes to, pops from or sets the length of (`hoist.ts` finds those
before the body is walked; one that is pushed to only through a function's parameter is found when the
front end meets the push, so a backend goes by the flag in `Program.arrays`, never by the nodes). Its
`length` is only how many cells it starts with. Its cells are a block of **the heap**: 16 384 cells
(`HEAP_CELLS`) every program's growing arrays share, handed out in powers of two, four at least. The
array itself is a handle — where its block is (0: none yet), the cells in use, the block's room and its
size class — a cell each, or a row of twelve each in a per-player program.

- `push` at a full block takes a block twice the size, copies the cells over and gives the old one back;
  a block given back waits in its size's list for whoever wants that size next (its first cell links the
  next), and new ground is taken from the bottom of the heap up. Nothing splits or joins blocks. When
  there is no block to take, nothing is pushed and the game says so once, in red; the interpreter
  records a fault. `compiler/simulateIr.ts` counts blocks exactly as `python/trigscript.py` hands them
  out, so both run out at the same push — a probe expects the same number from each.
- `declareArray` of a growing array first gives back the block the handle holds. So an array declared in
  a loop, or in a function called again, holds one block at a time, and what the heap can lose is bounded
  by the number of declarations; there is no other freeing and no collector.
- Reads and stores are bounded by the cells in use. `store` at exactly the length is a push, as
  `xs[xs.length] = v` is in JavaScript; farther out is past the end. `pop` of an empty array is 0
  (`xs.pop() ?? d` arrives as a `ternary` on the length). `setLength` only cuts.
- `length` of an array that does not grow never reaches a backend: `numbers.ts` makes it a constant on
  its final pass, when every push has been met.
- The heap is the arrays' alone. Until version 11 its top was set aside for recursion's stack, growing down
  towards the blocks; the stack is an array of its own now (*Recursion*, below), so that how deep a
  function may go does not depend on what the arrays hold at that moment.
- **Records, units and keyed tables are not nodes either.** An array of records is an array a field
  (`waves.count`, `waves.delay`), a record of one a front-end binding of cells, so `waves[i].count` is an `element`
  and `w.delay = 9` a `store`. An array of units is three arrays of numbers — `squad (ptr)`, `(epd)`, `(uid)` —
  filled from `unitPart` and read back through `unitAt`; a unit is put into a temporary first, so it is found once
  and not three times. A `Record` / `Map` / `Set` keyed by an id of the game is an array with a cell an id, a `Map`
  or a `Set` with one of booleans beside it for which keys were set and a count; a loop over one is a `for` over
  every id with the body under an `if`. A list of the script indexed by a value of the program — numbers, booleans
  or records — is an array with `values`.
- `fill`, `includes` and `indexOf` are not nodes: the front end writes them as a loop, the last two as a
  `call` of its own making with the loop as its body.

### Arrays inside arrays

Since version 12 an `ArrayDecl` may be a way to another's cells instead of cells of its own. Both forms are
positioned by a variable of the program, which the front end sets before the array is used; neither is ever in a
frame's `saves`, and a `slice` is never declared.

- `slice: { of, offset }` — a **window**: `length` cells of the array `of`, from cell `offset` (a variable's id).
  It is a row of an array of arrays whose rows are all one length, which the front end keeps as one flat array
  (`grid[y][x]` with nothing else asked of the row never makes a window: it is `element(flat, y * width + x)`, the
  index −1 when `x` is past the row, which reads 0 and stores nothing as any index past an end does). Past its own
  end a window reads 0 and stores nothing, so a row never reaches into the next; what it is a window on keeps its
  own ends, width and row a player. It cannot grow.
- `through: { ptr, len, room, k, index }` — an array that grows **inside** another: its handle is cell `index`
  (a variable's id) of four arrays of numbers the outer one keeps, a handle a row. It is `dynamic`, and every
  statement and expression of a growing array works on it; the lowering reads and writes the handle's fields
  through the four arrays where a growing array of its own has four cells. `declareArray` of it with nothing gives
  its block back and leaves the row empty — which is how the front end keeps the rule that *what holds the handle
  owns the block*: before a row goes (popped, cut off by `length =`, the outer array declared again) it is declared
  empty. A row kept in a `const` is that *place* of the outer array, not a block, so nothing dangles: past the
  outer's end it reads nothing, and a row pushed there later is what it is then.

## Statements

| Kind | Fields | Meaning |
| --- | --- | --- |
| `declare` | `decl`, `init`, `failed?` | The variable exists from here, holding `init` (a number or boolean expression). `failed` means the initializer did not compile — reported already — and the variable is left unset. |
| `assign` | `target`, `value` | `target = value` for a number. `x += y` and `x++` arrive as `x = x + y`, `x = x + 1`. |
| `declareArray` | `array`, `init?` or `fill?` | The array's cells are set, here and now: `init` a value a cell (every value is evaluated before any is stored), `fill` one value for all of them. |
| `push` | `array`, `value` | One more cell at the end of an array that grows. |
| `pop` | `array` | `xs.pop();` with its value unused. |
| `setLength` | `array`, `value` | `xs.length = n`: cut to n cells; an n above the length changes nothing. |
| `store` | `array`, `index`, `value` | `hp[i] = value`; `hp[i] += v` arrives as a store of `hp[i] + v`. The value is evaluated, then the index; nothing is stored past either end. |
| `assignBool` | `target`, `value` | `target = value` for a boolean. |
| `assignUnit` | `target`, `value` | `target = value` for a unit variable. |
| `unitLoop` | `decl`, `filter`, `body` | `for (const u of unitsAt(…))`: the body once for every unit the filter matches, in the order of the game's unit table, within the frame (the compiler refuses a `sleep` inside). `decl` is the unit of the turn; `break` and `continue` are the loop's. |
| `unitWrite` | `unit`, `field`, `value` | `u.hp = 40`, `u.invincible = true`. Nothing happens when the unit is none or gone. Hit points at 0 kill. |
| `unitDo` | `unit`, `verb` | `{ do: "kill" }`, `{ do: "remove" }`, `{ do: "give", to }`, `{ do: "order", order, target }` (a location), `{ do: "damage" \| "heal", amount, percent }`, `{ do: "locate", location }`. Nothing happens when the unit is none or gone; an amount is evaluated either way. |
| `tableWrite` | `cell`, `value`, `scaled?`, `boolean?` | A cell of the game's tables. `value` is a number expression, a boolean one (`boolean`), or `{ kind: "text", text }` for a name. `scaled`: the number is already what the cell stores. |
| `if` | `cond`, `then`, `else?` | As it reads. |
| `while` | `cond?`, `body` | `cond` absent means `while (true)`, or a condition known true when the script was built. |
| `do` | `body`, `cond`, `condLabel` | `do { … } while (cond)`. |
| `for` | `cond?`, `update`, `body` | A loop over a variable; its init statements precede the node. `continue` runs `update`. |
| `unrolled` | `iterations: Stmt[][]` | A loop unrolled when the script was built: each list is the body for one value, in order. `break` leaves the whole thing; `continue` moves to the next list. |
| `switch` | `value`, `cases: { value, body }[]` | Cases tested in order; `value` null is `default`, `NaN` a case whose value could not be read (no test, still fallen into). Bodies fall through unless they `break`. |
| `break`, `continue` | | Of the nearest loop (`break` also of a `switch`). |
| `return` | `value?` | Inside a `call` body: writes the result and leaves the call. |
| `sleep` | `ms?`, `cycles?` | Park the program: a duration in milliseconds, or in frames (`cycles`). `cycles: 1` goes on in the very next frame. |
| `print` | `parts`, `to`, `position` | Text with values in it. `parts` are `{ kind: "text", text }`, `{ kind: "number", expr, unsigned? }` (its digits, with a minus sign when it is below zero and not `unsigned`), `{ kind: "name", player }` and `{ kind: "color", player }` (the colour code of the player's colour), a player being a slot or 13 for the current player. `to` is who sees it: a slot, 13, All Players (17) or a force (18–21). `position` is `chat` or `center`, the line the game's own errors use. Every number is evaluated before anything is shown. |
| `action` | `record`, `variables?` | A trigger action. Each of `variables` names a field of the record that takes an expression's value: `{ field, bits: 8, 16 or 32, name, expr }` — the unit count of `createUnit` and friends is an 8-bit field, a unit type a 16-bit one (the lowering stops it at 228), an amount with a modifier a 32-bit one. Version 4 had one, as `variable`. |
| `centerLocation` | `location`, `x`, `y` | Centre a location (1-based) on a point of the map in pixels, its size kept. |
| `call` | `call` | A function as a statement (its result, if any, unused): inlined, or with `fn` called. |
| `block` | `body` | Scoping only. |
| `remark` | `text`, `short?` | A word for the editor about the line: a loop unrolled when the script was applied. |

## Expressions

Numbers (`NumExpr`):

| Kind | Fields |
| --- | --- |
| `const` | `value` (a whole number) |
| `var` | `id` |
| `element` | `array`, `index` — a cell of an array of numbers; 0 past either end |
| `length` | `array` — the cells in use of an array that grows |
| `unitPart` | `unit`, `part: ptr | epd | uid` — one of the three numbers a unit is kept as: where it is in the game's unit table (0 for none), the same as an EPD, and the slot's uniqueness byte (as it sits in its dword, masked 0xFF00) as it was when the unit was taken. Typed a `u32`: bits to keep, never a number to reckon with |
| `pop` | `array` — the last cell, which the array then no longer has; 0 when it is empty |
| `unary` | `op: "-"`, `expr` |
| `binary` | `op: + - * / % & | ^ << >> >>>`, `left`, `right`, `unsigned?` (on `/` and `%`) |
| `read` | `read` — a value of the game, taken when the expression is evaluated (below) |
| `randomInt` | `bound` — a whole number from 0 to `bound` − 1, fresh at every evaluation; 0 when `bound` is 0 |
| `unitField` | `unit`, `field` — a number of a unit; 0 when the unit is none or gone |
| `tableRead` | `cell` — a cell of the game's tables in the script's units (stored ÷ `scale`, rounded down); a flag reads 1 or 0 |
| `input` | `input` — what a player did, as it reached every computer (below): a key, a click and a typed line read 1 on their frame, the mouse its place on the map |
| `ternary` | `cond`, `whenTrue`, `whenFalse` |
| `intrinsic` | `name: min | max | abs`, `args`, `unsigned?` (on `min` and `max`) |
| `call` | `call` (its result is the value) |

Booleans (`BoolExpr`):

| Kind | Fields |
| --- | --- |
| `const` | `value` |
| `cond` | `record` — a trigger condition, fields known |
| `var` | `id` of a boolean variable |
| `element` | `array`, `index` — a cell of an array of booleans; false past either end |
| `pop` | `array` — of an array of booleans; false when it is empty |
| `test` | `expr` — a number tested `!= 0` |
| `compare` | `op: < <= > >= == !=`, `left`, `right`, `unsigned?: true | "left" | "right"` |
| `and`, `or` | `items` |
| `not` | `expr` |
| `random` | a coin toss, fresh at every evaluation |
| `unitAlive` | `unit` — `if (target)`: there is a unit and it is still on the map |
| `unitSame` | `left`, `right` — both name one unit of the game (none is never the same as anything) |
| `unitFlag` | `unit`, `flag: hallucinated | cloaked | burrowed | invincible | underAttack`; false when the unit is none or gone |
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

### Functions that are called

```
FuncDecl { id, name, params: VarDecl[], result?: { decl, kind }, body: Stmt[], at }
Call     { …, fn: "twice#12", params: { decl, init, label }[], result?, body: [] }
```

Since version 10. A `Call` with `fn` runs the body of that one of `Program.functions`
instead of a body of its own. Its `params` are the function's parameters, in order, each
with this call's argument: **every `init` is worked out first, then every parameter is
set**, since an argument may be a call of the same function (`add(add(1, 2), 3)`). Then the
body runs; a `return` in it writes the function's `result.decl` and leaves; the call copies
that into its own `result.decl`, which is what the expression around it reads. (The
interpreter writes the call's result directly; the two cannot be told apart.) A function's
parameters, result and locals are variables like any other — a row a player in a per-player
program — declared once with the function, which is why a function is a program's own and
never shared between programs.

What the front end guarantees of a function in the list: it never sleeps (so it can be a
plain subroutine: the lowering makes it an `EUDFunc` of no arguments over the program's own
cells), it holds no `edge` (a latch belongs to a place in the source, and an inlined body
is a place each), and at least two calls that are part of the program name it — a function
left with one is inlined there again before the IR is handed on. Since version 11 it may
reach itself through its calls (*Recursion*, next). An array parameter is not a parameter in the IR at all: which array
it is was settled when the script was built, so the body names that array, and a function
handed two different arrays is two `FuncDecl`s of one name.

A `remark` first in a function's body is the hint for its line (*called ×3*); one first in
the program's body the hint for a function inlined more than once, with the reason.

Every pass that walks a program walks `bodiesOf(program)` — the body, then each function's
— and `programDeclarations(program)` lists the functions' variables with the rest.

### Recursion

```
FuncDecl { …, recursive: true }
Call     { …, fn, saves: { vars: string[], arrays: string[], within: "fill" } }
```

Since version 11. A function's cells are the program's own, one of each, so a function that
comes back into itself would write over what its outer run still needs. `recursion.ts` — a
pass over the IR, after the numbers are typed and the program has been checked as the
script wrote it — finds the functions on a cycle of the call graph (Tarjan's components
over `Call.fn`; a self-edge counts), marks them `recursive`, and makes three things true of
each. A function off every cycle, and the program's body, are left exactly as they were.

- **A call that may come back is a statement of its own**: `{ kind: "call" }` with a
  `Call` whose `fn` is of the same cycle, never inside an expression. `fib(n - 1) +
  fib(n - 2)` is two call statements and an addition of their `result.decl`s. A backend
  computes an expression through temporaries no frame knows of, so nothing may be half
  computed when such a call is made. What JavaScript evaluates before the call is evaluated
  before it still: an operand to the left of one is declared into a temporary first
  (`(kept)#r…`), unless it is a constant or a variable of the function's own, which comes
  back with the frame. `c ? f(x) : 0` becomes an `if` around an assignment (`(chosen)`),
  `a && f(x)` a chain of `if`s over one boolean (`(so far)`), and a loop whose condition holds
  such a call a `while` without a condition whose body begins by working the condition out
  and leaving on it — a `do` through a `(first turn)` flag, so that `continue` still comes to
  the check. An inlined call whose body holds such a call is taken out the same way, whole.
- **Such a call says what to keep** — `saves`. `vars`: every variable of the function it is
  in (parameters, locals, the parameters and results of what is inlined in it, other calls'
  results, the temporaries above) but this call's own result. `arrays`: the growing arrays
  declared in the function. `within`: the function's name, for the words of an overflow. A
  backend, in this order: works out every argument; puts on the stack where the function
  returns to, the `vars` (a cell each, three for a unit or a made text) and the `arrays`' handles (four
  cells each), and sets those handles to "no block"; sets the parameters; runs the body;
  gives back to the heap the block each of the `arrays`' handles now holds — the inner
  run's — and takes everything back; copies the result. A variable the lowering has not met
  a declaration of yet has no cell and is skipped: it is set before it is read.
- **An array declared in a recursive function grows** (`dynamic`), whatever it was, so that
  a run has its own by keeping a handle and not the cells.

The stack is one array for every program and every player — such a function never sleeps,
so nothing is on it when a frame ends — of as many frames of the largest `saves` in the file
as the depth allows: the IR file's `stack`, written only when the map's script settings
differ from `STACK_DEPTH` (1 024) and something recurses. What is counted is calls, not
cells: a `saves` call met at that depth says so in the game (*stack overflow in fill, line
12*), empties the stack and ends the program for good (for that player, in a per-player
program); the interpreter records a fault at the same call and ends the program the same
way. Arrays whose handles were on the stack then keep their blocks: the heap loses them.

The lowering cannot use an `EUDFunc` for these — it keeps one return address, and is not
there to be called until its body is whole — so a recursive function is triggers of its own
in a scope apart, ended by a trigger whose next-trigger field is the return address; the
address is kept a second time in a variable, since a frame can write a variable out in two
triggers and reading the field back would cost thirty. The interpreter runs the body of a
`saves` call apart from its caller (`ProgramRun.drive`), because a thousand calls deep
would otherwise be ten thousand frames of JavaScript's own stack.

What cannot recurse: a function that sleeps or holds an `edge` (it is not a called function
at all, and the front end says so when the inlined copies reach sixteen deep), and a
`unitLoop` holding a `saves` call (the scan's place in the unit table is the lowering's
own), nor a `textLoop` holding one, for the same reason. A function that calls itself on
every path is an error too.

**Texts in a frame.** A function that calls itself may hold texts. A made text among a
call's `vars` is three cells of the frame — where it is, its block, its length — and once
they are on the stack the variable holds *no block* for the length of the call, as an
array's handle does, so that the inner run's first text gives nothing of the outer run's
back. When the call returns, the block the inner run left in the variable goes back to the
heap, and then the three cells are the outer run's again. A text kept as its id is one
cell, as a number is. The pass takes a call that may come back out of a text as it does
out of any expression: a `textCall` of such a call becomes the call as a statement and a
`textVar` of its result (looked at, so copied where it is kept — the result keeps its
block until the next return, as it always does), and the numbers, conditions and texts
inside a text are rewritten in place.

**A text through a called function.** A `FuncDecl`'s parameter or result may be a `text`.
A call works every argument out first; a text argument is a copy of its own by then (what
it is made from may be the parameter itself). Setting the parameter gives back what it held
from the call before. The function's result moves to the call's own result variable, from
where a `textCall` takes it; a text result is not reset when a call starts.

## Texts

A text is a value, kept one of two ways, a variable at a time (`VarDecl.text`):

- `id` — the variable only ever receives texts known when the script was built, so it is one
  cell holding the text's id in the *built* map's string table (0 for the empty text, which
  the table does not hold). The front end decides this by reading the body: the first value
  and every `=` to the variable have an id, and nothing `+=`s it.
- `made` — three cells: where the text's bytes are (UTF-8, ended by a 0), the block of the
  heap it owns (0: none — the bytes are a string of the table), and its length in
  characters. A block is the heap's (*Arrays that grow*): its first cell is its size class,
  the bytes follow four to a cell, so a text of `b` bytes takes a block of at least
  `b / 4 + 2` cells (whole division). The most a made text holds is `TEXT_BYTES`, 1 023.

```
TextExpr =
  | { kind: "text", text }                              one written in the script
  | { kind: "textVar", id }
  | { kind: "textOf", array, index, at }                a cell of an ArrayDecl with `texts`
  | { kind: "textAt", addr, block, chars, index, at }   a made text kept in cell `index` of three arrays
  | { kind: "template", parts, at, label }              made: the parts one after another
  | { kind: "textTernary", cond, whenTrue, whenFalse, at, label }
  | { kind: "textSlice", of, start?, end?, at, label }  characters start … end − 1
  | { kind: "textPad", of, side: "start" | "end", width, with, at, label }
  | { kind: "textRepeat", of, count, at, label }
  | { kind: "textCall", call }                          a call whose result is a text
```

The first three, and a `textTernary` between such, *have an id* whatever happens in the
game (`textHasId`); everything else is made. A backend works a text out either as its id —
where only an id will do: an `id` variable, an action's text — or as a text that is
somewhere. An `ArrayDecl` with `texts` is a list of texts the script has; its `values` are
places in that list, and a lowering puts the texts' ids in the cells instead.

**Who owns a block.** A variable's text is only looked at by whatever reads it. Any other
made value owns its block until something takes it: a `declare`, an `assignText`, a
`return` or a parameter's `init` keeps the block (a variable's text is copied into a block
of the same size class first); anything that only uses the value — a comparison, a
`print`, a larger template, an action — gives the block back once it has. The variable's
old block goes back *after* the new value is worked out, since it may be made from the
old one (`s += "!"`). A `textTernary` that is not between two ids copies a variable's
text, so its value always owns. A `textCall` takes the text out of the call's result
variable, which then holds no block. A `text` result is not reset when a call starts: it
keeps its block until the next `return` puts another in it. Both backends take and give
blocks in this order, so they run out of heap at the same text; then the text is empty,
and the game says so once in red where Simulate records a fault.

**A text in the cells of arrays** (version 14) is what lets a row of an array of records
hold one. The three cells of a `made` variable are cells of three arrays instead — `addr`,
`block`, `chars`, all at one `index` — and a `textAt` reads them as a variable's are read:
looked at, never owned by the value, cells that were never given a text (0) the empty text.
Nothing but `storeText` and `releaseText` writes such cells as a text; the front end moves
them as the plain numbers they are (a sort, a pop), which moves the text with its block, and
says who owns what: before a row goes it emits a `releaseText` for each text it holds, and
where a row is copied (`filter`) it zeroes the copy's three cells and `storeText`s the
original's `textAt` into them, which makes the copy a block of its own. In the simulator
the number in the cells is a key to the text, so that what moves the numbers moves it.

Every operand is worked out before anything is written, in the order written. A variable's
text used as an operand is copied when a later operand holds a call, which may give that
variable another text.

| Node | Fields | Meaning |
| --- | --- | --- |
| `assignText` | `target`, `value` | `s = v`, `s += v` (the front end writes the template) |
| `storeText` | `addr`, `block`, `chars`, `index`, `value` | the same into cell `index` of three arrays: `value` is worked out first, then the block the cells held goes back, then the cells take the text — a copy of one that was only looked at |
| `releaseText` | `block`, `index` | the block cell `index` of `block` names goes back to the heap, and the cell is 0 |
| `textLoop` | `decl`, `of`, `body` | `for (const ch of s)`: the text — a copy of a variable's — walked once, `decl` a made text of one character each turn; no `sleep` inside |
| `textLength` | `of` | a number: characters (code points), not bytes |
| `textIndexOf` | `of`, `find`, `from?` | a number: the place in characters of the first match at or after `from`, −1 for none; an empty `find` is found at `from` |
| `textCode` | `of`, `index` | a number: the character's code point, −1 past either end |
| `textCompare` | `op`, `left`, `right` | a condition: by the bytes, which is by code point; two ids compare as numbers under `==` and `!=` |
| `textTest` | `test: startsWith | endsWith | includes`, `of`, `find` | a condition |

A `print`'s and a `template`'s parts gain `{ kind: "value", text }`. An `action` may carry
`text`, the program's text for its text field: an id goes into the action; a made text is
written over a string the build keeps for that *kind* of field (`ForceAddString`, 255 bytes:
`TEXT_FIELD_BYTES`) — the objectives, a leaderboard's label, a transmission — just before
the action runs, and only on the computer whose player the program is running as
(`IsUserCP`), because the game reads such a string again whenever it draws. The front end
lets a made text into those actions only. A `tableWrite` of a unit type's name takes a
`TextExpr`: an id is written as it is, a made text goes over a string kept for that unit
type, on every computer. The places a `textSlice` is given are inside 0 … the length
already: the front end counts from the end and clamps.

## Units

Units (`UnitExpr`):

| Kind | Fields |
| --- | --- |
| `unitNull` | none |
| `unitVar` | `id` of a unit variable |
| `unitAt` | `ptr`, `epd`, `uid` — the unit three numbers name, which `unitPart` gave of one and the program kept in cells of its own. None when `ptr` is 0; re-checked before use like any kept unit |
| `pick` | `by: first | nearest | random`, `filter`, `near?`, `mouse?`, `within?` — one of the units the filter matches: the first in table order, the nearest to the centre of location `near` by \|dx\| + \|dy\| (the first of equals), or one drawn at random; none when nothing matches. With `mouse` (a player: a slot, or 13) in place of `near`, the nearest to that player's mouse and no farther from it than `within` pixels |
| `call` | `call` whose result is a unit |

```
UnitFilter { type?, owner?, at? }
```

`type` is a units.dat id, or 230 Men, 231 Buildings, 232 Factories (units.dat's group
flags, as a trigger counts them); `owner` a slot or 13; `at` a 1-based location whose box
holds the unit's centre, edges included. An absent part matches all, and a unit that is
dying matches nothing. Number fields: `hp` (whole points, a started point counting, as
the game shows it), `maxHp`, `shields`, `maxShields`, `energy`, `owner`, `type`, `x`, `y`,
`kills`, `orderId`, `cooldown`, `resources`, and the timers `stim` `ensnare` `plague`
`lockdown` `maelstrom` `irradiate` `stasis`. A written value stops at what the game's
cell holds: 255 for a byte (kills, cooldown, timers, energy points), 65 535 for
resources, 2²⁴ − 1 hit points.

A unit variable is a pointer into the game's unit table with the slot's uniqueness byte
beside it: the game reuses a dead unit's slot, so the lowering checks before every use
that the slot has a sprite, its order is not "die" and the byte is the one taken with the
pointer. The unit of a `unitLoop`'s turn is there by construction and is not checked.

## Tables

```
TableCell { name, base, stride, index, key?, width: 1 | 2 | 4 | "bit", bit?, scale?, player?, special? }
```

The cell is at `base + index × stride + key`; `player` means `index` 13 is the current
player. Stored = value × `scale`. A written value stops at what `width` holds. `special`
cells have a routine of their own: `speed` (the type's flingy, read from units.dat when
the line runs, is switched to table control and given the speed, an acceleration of a
seventeenth of it and the braking distance v² / 2a), `color` (the units' palette entry
and the minimap's, 0x60 bytes on), `name` (the text becomes a string of the built map and
its id is written). `compiler/tables.ts` is the list of fields, each one played in
Remastered by Magenta's probes.

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

## Input

```
{ source: "key", key, player }                          1 on the frame the press arrives
{ source: "click", button: "left" | "right" | "middle", player }
{ source: "mouse", axis: "x" | "y", player }            map pixels
{ source: "chat", pattern, capture: number | null, player }
```

What a player does happens on one computer; two euddraft plugins the build adds bring it to
all of them in step, and the IR file's top-level `input` is what they are set up from
(`compiler/input.ts`):

```
input: {
  keys: string[], buttons: string[],          what is asked for, each once; an index is the cell's number
  chats: { pattern, segments, captures }[],   a typed line is the first of these it fits, in this order
  unitNames?: [lowerCaseName, unitType][],    only when a pattern reads a unit's name
  qcLocation,                                 the 0-based location slot MSQC keeps for itself
  mouseBase                                   the 1-based number of the first of eight locations MSQC keeps the mice in, or null
}
```

`player` is a slot (0–7) or 13. A `chat` with `capture` null is 1 on the frame a line
fitting `pattern` arrives from that player; with a number, that capture's value on that
frame and 0 otherwise. A pattern's `segments` are its written text (strings, matched
exactly) and its captures (their index); a capture is `{ name, kind: "number" }` (digits,
stopping at 1 048 575), `{ kind: "word", words }` (its place in the list) or
`{ kind: "unit" }` (a unit type by name, the rest of the line); words and names match
whatever the capitals. The whole line has to fit.

The build's plugin sections, in the order they run (`buildPlugins`): **chatEvent**, with no
messages of its own — it only finds the line the local player typed and leaves its address
and length; **trigscript**, which before the triggers matches that line against the patterns
on the computer it was typed on, into a number for the pattern and up to three values;
**MSQC**, which sends those, the keys (`KeyPress(K); NotTyping`) and the clicks
(`MouseDown(B)`) to every computer as the player they came from, and keeps each human's
mouse in a location; **eudTurbo**. Every cell is an `EUDArray(12)` or an `EUDVariable` the
lowering registers by name (`tsin_key0`, `tsin_chat_in`, …), which is how the other two
plugins' settings reach them: no death counter, switch or string of the map is used. MSQC
clears its cells every frame, so an input lasts the frame it arrives in. It makes its
command units of one unit type (58, the Valkyrie) owned by Player 12, which the map must
leave alone.

## Numbers

32 bits. A `number` reads them signed, −2³¹ to 2³¹ − 1; a `u32` (`VarDecl.unsigned`) from 0 up.
`+ − ×`, `& | ^` and `<<` give the same bits whichever way they are read, so neither backend
ever works a type out: `compiler/numbers.ts` does, once, over the IR the front end emitted,
and writes into each operation that cares which reading it takes. The lowering and the
interpreter agree on every case:

- `+`, `−`, `×` and unary minus wrap at 32 bits.
- `/` and `%`: signed unless `unsigned` — towards zero, the remainder with the dividend's
  sign (eudplib's `f_div_towards_zero`); `unsigned`, both sides from 0 up. A constant
  divisor is never 0 (the compiler checks); a variable divisor that is 0 in the game gives 0.
- `>>` keeps the sign of what it shifts, `>>>` fills with zeros (`numbers.ts` turns the `>>`
  of a `u32` into `>>>`). A count of 32 or more — read from 0 up, so a count below zero too —
  leaves 0, or −1 for the `>>` of a number below zero.
- `min` / `max` compare signed unless `unsigned`; `abs` is of a signed number (of a `u32` it
  is removed).
- A comparison: `unsigned` absent, both sides signed; `true`, both from 0 up — also written
  when neither side *can* be below zero, which comes to the same and costs the lowering
  nothing, where a signed order costs an addition a side (the top bit flipped); `"left"` /
  `"right"`, that side is a `u32` and the other signed, compared exactly: a number below
  zero is smaller than any `u32`. `==` and `!=` of two like sides compare the bits.
- Stored into a variable, the 32 bits are kept; a `u8` / `u16` stops at its maximum, read
  from 0 up. **Nothing below zero reaches a store that would misread it**: into a `u8` /
  `u16`, a unit's field, a table's cell, an action's variable field, `damage` / `heal`,
  `centerLocation` and `random(n)`'s bound, `numbers.ts` has wrapped a signed value in
  `max(v, 0)` unless it can see that it is never below zero — a constant, a read, a unit's
  field, an input, a `u8` / `u16`, `x & m`, `x % n`, `x / n` and `x >> n` of such, or a
  variable into which only such values are ever stored. A backend's stores are therefore
  what they were in version 5: from 0 up, stopping at the top.
- There are no casts by the time a backend sees the program: `u32(x)`, `i32(x)` and
  `x >>> 0` say how bits are read, and `numbers.ts` removes them once the operations around
  them are marked. (A `cast` node exists in `compiler/ir.ts` between the front end and that
  pass; a backend that met one would pass its `expr` through.)
- A `number` and a `u32` in one piece of arithmetic never arrive: that is a compile error.
- An action's variable `modifier` (a unit count) means that many units: the lowering does
  the action once for each, so 0 is none and 300 is 300.
- A `switch` compares bits: a case of −1 is 0xFFFFFFFF.

## Records

`ActionRecord` and `ConditionRecord` are the map's own trigger records, as
`vendor/triggers.ts` names their fields. Inside the compiler an action's `text` and
`wav` hold *local* string ids (into the compile's `strings`); `serializeIr` in
`compiler/eud.ts` writes the JSON with the text itself in their place — eudplib adds it
to the built map's string table, so a program's strings never enter the map the user
edits — or a number where the script named an index of the map's own.
