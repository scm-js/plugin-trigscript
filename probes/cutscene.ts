// TrigScript 4: a scene acted out with trigscript/cutscene, then references (B9) at work — a played probe.
//   npx tsx scripts/build-fixture.mts probes/cutscene.ts fixtures/eud/cutscene.scx
// Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
//
//  1. The scene (Escape skips it; then "Scene skipped." and the camera goes back to the base):
//     A  the camera starts on your base; Raynor's portrait talks: "Raynor: Four of you, with me."
//     B  four Marines walk together about ten tiles east; the camera follows the first        — expect "B: 4 got there"
//     C  the camera glides to the Zerg base, slowing at both ends, and shakes                 — expect "C: the Zerg base"
//     D  the camera circles the Zerg base once, a quarter turn a second                       — expect "D: round"
//     E  back to your base                                                                     — expect "Scene played."
//  2. References, every two seconds a line, ten times:
//     F  "F: <n> pings <m> waves <k> live": a minimap ping on your base every 2 s (Ping), a Zergling made at the Zerg
//        base every 4 s (Wave), each a class of one list; the wave is let go of after its third Zergling — expect the
//        pings to count 0 … 9, the waves 0 … 3, and "2 live" to become "1 live" once the third Zergling is made
//     G  at the end: "G: done"
import { test, expect, program, print, createUnit, first, unitsOf, start, sleep, frames, units, minimapPing, centerLocation, reserveLocation, P1, P2, type Location, type Unit } from "trigscript";
import { Camera, walkAll, line, play, SECOND } from "trigscript/cutscene";
import { Vec } from "trigscript/math";

const HOME = 1 as Location;
const MARK = reserveLocation("probe: where a ping or a wave goes");

async function intro(squad: Unit[], homeX: number, homeY: number, zergX: number, zergY: number) {
  const cam = new Camera(homeX, homeY);
  await line(units.JimRaynorMarine, "Raynor: Four of you, with me.", 3 * SECOND);
  const lead = squad[0];
  const following = start(cam.follow(lead, 8 * SECOND));
  const got = await walkAll(squad, homeX + 320, homeY);
  following.cancel();
  print(`B: ${got} got there`);
  await cam.pan(zergX, zergY, 3 * SECOND);
  await cam.shake(18, 12);
  print("C: the Zerg base");
  // Round the Zerg base: a point 256 pixels out, turned a quarter every second.
  let arm = new Vec(256, 0);
  let i = 0;
  while (i < 4 * SECOND) {
    arm = arm.rotate(Math.PI / (2 * SECOND));
    cam.look(zergX + Math.round(arm.x), zergY + Math.round(arm.y));
    await sleep(frames(1));
    i++;
  }
  print("D: round");
  await cam.pan(homeX, homeY, 2 * SECOND);
}

/** Something that happens every so often while the game goes on. */
abstract class Effect {
  every: number;
  left: number;
  constructor(every: number) { this.every = every; this.left = every; }
  /** One frame: false once it is over. */
  tick(): boolean {
    this.left--;
    if (this.left > 0) return true;
    this.left = this.every;
    return this.fire();
  }
  abstract fire(): boolean;
}

class Ping extends Effect {
  x: number;
  y: number;
  count = 0;
  constructor(x: number, y: number) { super(2 * SECOND); this.x = x; this.y = y; }
  fire(): boolean {
    centerLocation(MARK, this.x, this.y);
    minimapPing(MARK);
    this.count++;
    return true;
  }
}

class Wave extends Effect {
  x: number;
  y: number;
  made = 0;
  constructor(x: number, y: number) { super(4 * SECOND); this.x = x; this.y = y; }
  fire(): boolean {
    centerLocation(MARK, this.x, this.y);
    createUnit(P2, units.ZergZergling, 1, MARK);
    this.made++;
    return this.made < 3;
  }
}

program(async () => {
  await sleep(frames(2));
  createUnit(P1, units.TerranMarine, 4, HOME);
  await sleep(frames(1));
  const squad: Unit[] = [];
  for (const u of unitsOf(P1, { type: units.TerranMarine })) if (squad.length < 4) { squad.push(u); u.invincible = true; }
  const home = first({ owner: P1 });
  const zerg = first({ owner: P2 });
  const homeX = home ? home.x : 1024, homeY = home ? home.y : 1024;
  const zergX = zerg ? zerg.x : 2048, zergY = zerg ? zerg.y : 2048;

  const skipped = await play(P1, start(intro(squad, homeX, homeY, zergX, zergY)));
  if (skipped) { const cam = new Camera(homeX, homeY); print("Scene skipped."); cam.look(homeX, homeY); }
  else print("Scene played.");

  const effects: Effect[] = [];
  effects.push(new Ping(homeX, homeY));
  effects.push(new Wave(zergX, zergY));
  let pings = 0, waves = 0;
  let turn = 0;
  while (turn < 10 * 2 * SECOND) {
    let k = effects.length - 1;
    while (k >= 0) {
      const e = effects[k];
      const going = e.tick();
      if (e instanceof Ping) pings = e.count;
      if (e instanceof Wave) waves = e.made;
      if (!going) effects.splice(k, 1);
      k--;
    }
    if (turn % (2 * SECOND) === 0) print(`F: ${pings} pings ${waves} waves ${effects.length} live`);
    await sleep(frames(1));
    turn++;
  }
  effects.length = 0;
  await sleep(frames(2));
  print("G: done");
});

test("the scene, then the effects", (sim) => {
  sim.frames(2100);
  expect(sim).toHavePrinted("Scene played.");
  expect(sim).toHavePrinted("G: done");
});
