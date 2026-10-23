// A bullet hell's data, weighed (TrigScript 4, cost in the language): N bullets as instances, each frame moved,
// bounced off the walls and aged. Nothing is drawn: this is what the bookkeeping costs a bullet, by line
// (`npx tsx scripts/weigh-map.mts fixtures/eud/bullets-bench.scx --frames=40`, after build-fixture with TRIGGER_MAP=1).
import { program, sleep, frames, deaths, units, P8 } from "trigscript";

const N = 200;
class Bullet {
  constructor(public x: number, public y: number, public dx: number, public dy: number, public life: number) {}
}

program(() => {
  const zero = deaths(P8, units.TerranMarine);
  const bullets: Bullet[] = [];
  for (let i = 0; i < N; i++) bullets.push(new Bullet(zero + i * 13 % 4000, zero + i * 7 % 3000, 3 + i % 5, 2 + i % 3, 100 + i));
  let alive = 0;
  while (true) {
    alive = 0;
    for (const b of bullets) { /* LOOP */
      b.x += b.dx; /* MOVE_X */
      b.y += b.dy; /* MOVE_Y */
      if (b.x >= 4000) b.dx = -3; /* BOUNCE_X */
      if (b.y >= 3000) b.dy = -2; /* BOUNCE_Y */
      if (b.life > 0) { b.life--; alive++; } /* AGE */
    }
    sleep(frames(1));
  }
});
