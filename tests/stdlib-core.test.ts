/**
 * The standard library's "trigscript/timers", "trigscript/signals", "trigscript/random" and "trigscript/math"
 * (TrigScript 4), run in the simulator — and, where a result can be, checked against JavaScript computing the same.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (source: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": source }, NAMES, { lib: LIB });
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  return r;
};
const shown = (source: string, frames = 1): string[] => {
  const r = compile(source);
  const sim = simulatePrograms(r.ir, frames, { strings: r.strings });
  expect(sim.faults).toEqual([]);
  return sim.events.map((e) => e.text ?? "");
};

describe("trigscript/timers", () => {
  it("every, after, a limited every and cancel, in the order they fall due", () => {
    expect(shown(`
      import { every, after } from "trigscript/timers";
      program(async () => {
        let log = "";
        const t = every(5, (n) => { log += \`e\${n} \`; });
        after(12, () => { log += "after "; });
        every(3, (n) => { log += \`x\${n} \`; }, 2);
        // On frame 25 the program runs before its tasks: the fifth never comes.
        await sleep(frames(25));
        t.cancel();
        await sleep(frames(10));
        print(log);
      });`, 40)).toEqual(["x1 e1 x2 e2 after e3 e4 "]);
  });
  it("after, cancelled before it falls due, never runs", () => {
    expect(shown(`
      import { after } from "trigscript/timers";
      program(async () => { let n = 0; const t = after(10, () => { n = 1; }); await sleep(frames(3)); t.cancel(); await sleep(frames(20)); print(\`\${n}\`); });`, 30)).toEqual(["0"]);
  });
  it("Cooldown, Countdown and Stopwatch read the game's frames", () => {
    expect(shown(`
      import { Cooldown, Countdown, Stopwatch } from "trigscript/timers";
      program(async () => {
        const cd = new Cooldown(10);
        const round = new Countdown(20);
        const sw = new Stopwatch();
        let uses = 0;
        let k = 0;
        while (k < 25) { if (cd.use()) uses++; k++; await nextFrame(); }
        round.add(10);
        print(\`\${uses} \${cd.left()} \${sw.elapsed()} \${round.left()} \${round.done() ? "done" : "running"}\`);
      });`, 30)).toEqual(["3 5 25 5 running"]);
  });
});

describe("trigscript/signals", () => {
  it("on, once and off; handlers in order, each handed the value", () => {
    expect(shown(`
      import { Signal } from "trigscript/signals";
      program(() => {
        const s = new Signal<number>();
        let got = "";
        const id = s.on((v) => { got += \`a\${v} \`; });
        s.once((v) => { got += \`b\${v} \`; });
        s.on((v) => { got += \`c\${v} \`; });
        s.emit(1); s.emit(2); s.off(id); s.emit(3);
        print(\`\${got}| \${s.count()}\`);
      });`)).toEqual(["a1 b1 c1 a2 c2 c3 | 1"]);
  });
  it("a signal of texts, and a handler's place given to the next one added", () => {
    expect(shown(`
      import { Signal } from "trigscript/signals";
      program(() => {
        const said = new Signal<string>();
        let log = "";
        const first = said.on((s) => { log += \`1\${s} \`; });
        said.off(first);
        const again = said.on((s) => { log += \`2\${s} \`; });
        let k = 4;
        said.emit(\`x\${k}\`);
        print(\`\${log}\${first === again ? "same place" : "another"}\`);
      });`)).toEqual(["2x4 same place"]);
  });
  it("handlers written in a loop keep their own turn's values", () => {
    expect(shown(`
      import { Signal } from "trigscript/signals";
      program(() => {
        const s = new Signal<number>();
        let total = 0;
        let k = 1;
        while (k <= 3) { const weight = k * 10; s.on((v) => { total += v * weight; }); k++; }
        s.emit(2);
        print(\`\${total}\`);
      });`)).toEqual(["120"]);
  });
});

describe("trigscript/random", () => {
  /** The same xorshift in JavaScript. */
  const xorshift = (seed: number) => { let st = seed || 1; return () => { let x = st; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; st = x; return x & 0x7fffffff; }; };
  it("Random: the same numbers as the same generator in JavaScript, and shuffle with them", () => {
    const next = xorshift(3007);
    const int = (n: number) => next() % n;
    let seq = "";
    for (let i = 0; i < 8; i++) seq += 1 + int(6);
    const xs = [1, 2, 3, 4, 5, 6];
    for (let i = xs.length - 1; i > 0; i--) { const j = int(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    expect(shown(`
      import { Random } from "trigscript/random";
      program(() => { let k = 3; const rng = new Random(k * 1000 + 7); let seq = ""; let i = 0; while (i < 8) { seq += \`\${rng.range(1, 6)}\`; i++; } const xs = [1, 2, 3, 4, 5, 6]; rng.shuffle(xs); print(\`\${seq} \${xs.join("")}\`); });`)).toEqual([`${seq} ${xs.join("")}`]);
  });
  it("chance, range, dice, pick, weighted and shuffle stay inside what they promise", () => {
    expect(shown(`
      import { chance, range, dice, pick, weighted, shuffle } from "trigscript/random";
      const NAMES = ["a", "b", "c"];
      program(() => {
        let ok = 0, heads = 0;
        let i = 0;
        while (i < 200) {
          const r = range(2, 4); const d = dice(2, 6); const w = weighted([0, 5, 0]); const p = pick(NAMES);
          if (r >= 2 && r <= 4 && d >= 2 && d <= 12 && w === 1 && (p == "a" || p == "b" || p == "c")) ok++;
          if (chance(50)) heads++;
          i++;
        }
        const xs = [1, 2, 3, 4, 5, 6, 7, 8];
        shuffle(xs);
        let sum = 0;
        for (const x of xs) sum += x;
        print(\`\${ok} \${heads > 60 && heads < 140 ? "fair" : "unfair"} \${sum} \${xs.length}\`);
      });`)).toEqual(["200 fair 36 8"]);
  });
});

describe("trigscript/math", () => {
  it("lerp, remap, approach, wrap, sign, distances and angles", () => {
    expect(shown(`
      import { lerp, inverseLerp, remap, approach, wrap, sign, distance, distanceSq, manhattan, angleTo, degrees } from "trigscript/math";
      program(() => {
        let k = 3;
        const t = fixed(k) / 4;
        print(\`\${lerp(fixed(10), fixed(20), t)} \${inverseLerp(fixed(0), fixed(8), fixed(k * 2))} \${remap(fixed(k), fixed(0), fixed(6), fixed(100), fixed(200))} \${approach(k, 10, 4)} \${approach(k, 1, 4)} \${wrap(-k, 10)} \${sign(-k)}\`);
        print(\`\${Math.round(distance(0, 0, k, 4))} \${distanceSq(0, 0, k, 4)} \${manhattan(0, 0, k, -4)} \${Math.round(degrees(angleTo(0, 0, 0, k)))}\`);
      });`)).toEqual(["17.5 0.75 150 7 1 7 -1", "5 25 7 90"]);
  });
  it("easing, within a hundredth of JavaScript's", () => {
    const t = 0.75;
    const js = [t * (2 - t), -1 + (4 - 2 * t) * t, t * t * (3 - 2 * t), 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2].map((v) => Math.round(v * 100));
    expect(shown(`
      import { easeOutQuad, easeInOutQuad, smoothstep, easeOutBack } from "trigscript/math";
      program(() => { let k = 3; const t = fixed(k) / 4; print(\`\${Math.round(easeOutQuad(t) * 100)} \${Math.round(easeInOutQuad(t) * 100)} \${Math.round(smoothstep(t) * 100)} \${Math.round(easeOutBack(t) * 100)}\`); });`)).toEqual([js.join(" ")]);
  });
  it("Vec: fromAngle, add, length, angle, normalized, rotate, and a field of what a method gives", () => {
    expect(shown(`
      import { Vec, radians, degrees } from "trigscript/math";
      program(() => {
        let k = 2;
        const v = Vec.fromAngle(radians(fixed(90)), fixed(k)).add(new Vec(fixed(1), fixed(0)));
        print(\`\${Math.round(v.x * 100)} \${Math.round(v.y * 100)} \${Math.round(v.length() * 100)} \${Math.round(degrees(v.angle()))} \${Math.round(v.normalized().length() * 100)} \${Math.round(v.rotate(radians(fixed(90))).x * 100)}\`);
      });`)).toEqual(["100 200 224 63 100 -200"]);
  });
});
