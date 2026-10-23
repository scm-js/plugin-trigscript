// TrigScript 4, the backend: units in a map of our own (scripts/build-own.mts) — step 10 of the way off eudplib. A unit
// is two numbers, the EPD of its record and its place's uniqueness byte, checked before use when it was kept; a loop or
// a pick walks the game's unit table, place 0 and then 1 699 down, until it has met the units in use.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same
// frames; every line should end "ok", and a line ending "WRONG" names the check that failed. The frames after "Weighed"
// are walks of about 160 units, to weigh. In the game, at S two Marines are selected, and at T one walks right.
//   npx tsx scripts/build-own.mts probes/own-units.ts /tmp/own-units.scx
//   npx tsx scripts/build-fixture.mts probes/own-units.ts /tmp/own-units-eud.scx
// The map build-own makes: Player 1 a person with a Command Center and 4 Marines, Player 2 a computer with a Hatchery
// and 4 Zerglings.
import { program, print, sleep, frames } from "trigscript";
import { walk } from "trigscript/cutscene";

const spot = reserveLocation("own-units: where a unit is");

/** The unit of a player's with the fewest hit points, or none. */
function weakest(of: Player): Unit | null {
  let best: Unit | null = null;
  let least = 100000;
  for (const u of unitsOf(of, { type: units.Men })) if (u.hp < least) { least = u.hp; best = u; }
  return best;
}

/** Hit points down by a number: a unit as a parameter. */
function hurt(u: Unit, n: number) {
  u.damage(n);
}

program(() => {
  print("Own units: the payload runs.");
  // A: loops, counted against the game's own counts.
  let marines = 0, lings = 0, men = 0, buildings = 0, all = 0;
  for (const u of unitsOf(P1, { type: units.TerranMarine })) marines += 1;
  for (const u of unitsOf(P2, { type: units.ZergZergling })) lings += 1;
  for (const u of unitsOf(P1, { type: units.Men })) men += 1;
  for (const u of unitsOf(P1, { type: units.Buildings })) buildings += 1;
  for (const u of allUnits()) all += 1;
  if (marines == 4 && command(P1, units.TerranMarine) == marines && lings == 4 && men == 4 && buildings == 1) print("A: loops ok");
  else print(`A: loops WRONG ${marines} ${lings} ${men} ${buildings}`);
  // B: a loop that stops, and one that goes on.
  let seen = 0;
  for (const u of unitsOf(P1)) { seen += 1; if (seen == 2) break; }
  let skipped = 0;
  for (const u of unitsOf(P1)) { if (u.type != units.TerranMarine) continue; skipped += 1; }
  if (seen == 2 && skipped == 4) print("B: break and continue ok"); else print(`B: break and continue WRONG ${seen} ${skipped}`);
  sleep(frames(4));

  // C: a pick's fields.
  const m = first({ owner: P1, type: units.TerranMarine });
  // (The map gives its Marines shields and energy: what they hold is printed, and must be the same both ways.)
  if (m && m.hp == 40 && m.maxHp == 40 && m.shields == m.maxShields && m.owner == 0 && m.type == units.TerranMarine && m.kills == 0 && m.x > 0 && m.y > 0) print(`C: a marine's fields ok (${m.shields} shields, ${m.energy} energy)`);
  else print("C: a marine's fields WRONG");
  const z = first({ owner: P2, type: units.ZergZergling });
  if (z && z.hp == 35 && z.owner == 1 && !z.cloaked && !z.burrowed && !z.hallucinated && !z.invincible && !z.underAttack) print("C: a zergling's fields ok");
  else print("C: a zergling's fields WRONG");
  const ore = first({ type: units.MineralFieldType1 });
  if (ore && ore.resources > 0) print(`C: a mineral field holds ${ore.resources} ok`); else print("C: a mineral field WRONG");
  // D: locate(): a location on the marine, and the units in it.
  m?.locate(spot);
  let inside = 0;
  for (const u of unitsAt(spot, { owner: P1, type: units.TerranMarine })) inside += 1;
  if (inside >= 1 && bring(P1, units.TerranMarine, spot) == inside) print(`D: ${inside} at the marine ok`); else print(`D: at the marine WRONG ${inside}`);
  sleep(frames(4));

  // E: writes, and hit points down and up.
  if (m) {
    m.hp = 10;
    const ten = m.hp;
    m.heal(5);
    const fifteen = m.hp;
    m.damage(3);
    const twelve = m.hp;
    m.heal({ percent: 50 });
    const most = m.hp;
    m.kills = 3;
    m.energy = 100;
    m.stim = 20;
    m.invincible = true;
    if (ten == 10 && fifteen == 15 && twelve == 12 && most == 32 && m.kills == 3 && m.energy == 100 && m.stim == 20 && m.invincible) print("E: writes ok");
    else print(`E: writes WRONG ${ten} ${fifteen} ${twelve} ${most} ${m.kills} ${m.energy} ${m.stim}`);
    m.invincible = false;
  } else print("E: no marine WRONG");
  // F: two units the same, and not.
  const again = first({ owner: P1, type: units.TerranMarine });
  if (m == again && m != z && first({ owner: P3 }) == null) print("F: the same unit ok"); else print("F: the same unit WRONG");
  sleep(frames(4));

  // G: a unit kept across a sleep, killed: then gone.
  const victim = nearest(units.ZergZergling, spot, { owner: P2 });
  if (victim) victim.kill();
  sleep(frames(2));
  let left = 0;
  for (const u of unitsOf(P2, { type: units.ZergZergling })) left += 1;
  if (!victim && left == 3) print("G: killed, gone ok"); else print(`G: killed WRONG ${left}`);
  // H: removed, and hit points at 0.
  first({ owner: P2, type: units.ZergZergling })?.remove();
  const last = first({ owner: P2, type: units.ZergZergling });
  if (last) last.hp = 0;
  sleep(frames(2));
  left = 0;
  for (const u of unitsOf(P2, { type: units.ZergZergling })) left += 1;
  if (left == 1 && !last) print("H: removed and hp 0 ok"); else print(`H: removed WRONG ${left}`);
  sleep(frames(4));

  // I: an order to this unit alone.
  const runner = first({ owner: P1, type: units.TerranMarine });
  runner?.order("move", locations.Anywhere);
  sleep(frames(2));
  if (runner && runner.orderId == 6) print("I: ordered to move ok"); else print(`I: ordered WRONG ${runner ? runner.orderId : -1}`);
  // J: given to another player (its owner and its player's list: the game's counts stay as they were, as eudplib's
  // `cgive` leaves them).
  const gift = first({ owner: P1, type: units.TerranMarine });
  gift?.give(P2);
  sleep(frames(2));
  let theirs = 0;
  for (const u of unitsOf(P2, { type: units.TerranMarine })) theirs += 1;
  if (gift && gift.owner == 1 && theirs == 1) print("J: given ok"); else print(`J: given WRONG ${theirs}`);
  sleep(frames(4));

  // K: a function giving back a unit, one taking one, an array of units.
  const w = weakest(P1);
  const was = w ? w.hp : 0;
  if (w) hurt(w, 2);
  const pair: (Unit | null)[] = [first({ owner: P1, type: units.TerranMarine }), w];
  let alive = 0;
  for (const u of pair) if (u) alive += 1;
  if (w && w.hp == was - 2 && alive == 2) print(`K: functions and arrays of units ok (${w.hp})`); else print(`K: functions and arrays WRONG ${w ? w.hp : -1} ${alive}`);
  // L: a random pick, of P1's marines.
  let marinesPicked = 0;
  for (let i = 0; i < 8; i++) { const r = randomUnit({ owner: P1, type: units.TerranMarine }); if (r && r.type == units.TerranMarine && r.owner == 0) marinesPicked += 1; }
  if (marinesPicked == 8) print("L: random picks ok"); else print(`L: random picks WRONG ${marinesPicked}`);
  sleep(frames(4));

  // Weighed: 150 more Zerglings, then a walk a frame.
  createUnit(P2, units.ZergZergling, 150, locations.Anywhere);
  sleep(frames(2));
  // (A walk first, in a frame of its own: a map of our own moves the lowest place ever handed out past the new units
  // once, which the frames after do not pay.)
  if (first({ owner: P4 })) print("P4 WRONG");
  print("Weighed:");
  sleep(frames(4));
  // W1: every unit counted.
  all = 0;
  for (const u of allUnits()) all += 1;
  sleep(frames(4));
  // W2: a player's few among many.
  marines = 0;
  for (const u of unitsOf(P1, { type: units.TerranMarine })) marines += 1;
  sleep(frames(4));
  // W3: a pick that finds none, the whole table walked.
  const none = first({ owner: P3 });
  sleep(frames(4));
  // W4: every Zergling's hit points added.
  let hp = 0;
  for (const u of unitsOf(P2, { type: units.ZergZergling })) hp += u.hp;
  sleep(frames(4));
  // W5: the nearest Zergling to the location.
  const near = nearest(units.ZergZergling, spot, { owner: P2 });
  sleep(frames(4));
  lings = 0;
  for (const u of unitsOf(P2, { type: units.ZergZergling })) lings += 1;
  if (all >= 100 && marines == 3 && !none && hp == 35 * lings && near && near.type == units.ZergZergling) print(`W: ${all} units, ${marines} marines, ${lings} zerglings ok`);
  else print(`W: WRONG ${all} ${marines} ${hp}`);
  sleep(frames(4));

  // S: two Marines selected for Player 1 (this computer's): the selection's first two slots hold them, the third is
  // empty — and in the game the panel shows two Marines.
  select(P1, [first({ owner: P1, type: units.TerranMarine })!, nearest(units.TerranMarine, spot, { owner: P1 })!]);
  sleep(frames(2));
  if (memory(0x6284b8, ">=", 1) && memory(0x6284bc, ">=", 1) && memory(0x6284c0, "==", 0)) print("S: two selected ok"); else print("S: selected WRONG");
});

// T: a cutscene's walk (a second program, after the first's lines): a Marine sent a little way along by a Move order,
// waited for frame by frame until it is there.
program(async () => {
  await sleep(frames(80));
  const u = first({ owner: P1, type: units.TerranMarine });
  if (u) {
    const there = await walk(u, u.x + 96, u.y);
    print(there ? "T: walked there ok" : "T: walked WRONG");
  } else print("T: no marine WRONG");
});
