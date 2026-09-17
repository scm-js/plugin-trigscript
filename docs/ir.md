# The TrigScript IR

What a `program(() => { … })` body means, written down as data so that more than one
backend can build it. The compiler's front end (`compiler/structured.ts`) turns the
TypeScript into this; the classic backend (`compiler/classic.ts`) lowers it to
death-counter triggers, and `python/trigscript.py` lowers it to eudplib for the
Remastered target. Version 1. The types are in `compiler/ir.ts`; this is the reference
for anyone reading or writing a backend.

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

What is *not* settled is anything a target decides: the width a temp needs, what a
division by a variable costs (the classic target refuses it, eudplib divides), how a
`sleep` parks the program, what a loop's back edge costs.

## Programs

```
Program { version, name?, owner, owners, perPlayer, cyclesPerSecond, body: Stmt[], at }
```

`owner` is the player the classic target's triggers run as; `owners` every player group
the program was declared for; `perPlayer` whether each player has variables of their own.
`cyclesPerSecond` is what the classic target makes of `sleep(seconds(n))` (12 with hyper
triggers, ½ without); the Remastered target runs every frame.

Every node carries `at: { file, line, column }`, 1-based, and most statements a `label`,
the text a generated trigger's comment shows ("L12: while (x < 3)").

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
| `action` | `record`, `variable?` | A trigger action. `variable` names a field of the record that takes an expression's value: `{ field, bits: 8 or 32, name, expr }` — the unit count of `createUnit` and friends is an 8-bit field, an amount with a modifier a 32-bit one. |
| `call` | `call` | An inlined function as a statement (its result, if any, unused). |
| `block` | `body` | Scoping only. |
| `remark` | `text`, `short?` | A cost hint for the editor, tied to the line. |

## Expressions

Numbers (`NumExpr`):

| Kind | Fields |
| --- | --- |
| `const` | `value` (a whole number) |
| `var` | `id` |
| `unary` | `op: "-"`, `expr` |
| `binary` | `op: + - * / %`, `left`, `right` |
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

## Numbers, on every target

Unsigned 32-bit. An expression is its exact value; stored below zero it is 0, at 2³² or
above it wraps. A `u8` / `u16` variable saturates at its maximum. `/` and `%` are whole
division; the classic target takes a constant divisor only. Booleans are 0 or 1.

## Records

`ActionRecord` and `ConditionRecord` are the map's own trigger records, as
`vendor/triggers.ts` names their fields. Inside the compiler an action's `text` and
`wav` hold *local* string ids (into the compile's `strings`); `serializeIr` in
`compiler/eud.ts` writes the JSON with the map's indices in their place.
