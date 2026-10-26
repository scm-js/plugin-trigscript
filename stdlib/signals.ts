/**
 * Events of your own: the standard library's "trigscript/signals" (TrigScript 4).
 *
 *   import { Signal } from "trigscript/signals";
 *
 *   const waveCleared = new Signal<number>();
 *
 *   program(async () => {
 *     waveCleared.on((wave) => { setResources(P1, "add", 100 * wave, "ore"); });   // braces: a handler gives back no action
 *     waveCleared.once((wave) => print(`First wave down!`));
 *     const id = waveCleared.on((wave) => print(`Wave ${wave} cleared`));
 *     …
 *     waveCleared.emit(3);       // every handler, in the order they were added
 *     waveCleared.off(id);
 *   });
 *
 * A signal lets one part of a map say that something happened without knowing who listens: the shop, the score and the
 * music each add a handler, and the wave code only emits. What it carries is one value of the type it is made with —
 * a number, a boolean, a text or a unit (`new Signal<Unit>()`). Its handlers are functions kept as values: they may use
 * what the block they were written in has, and they run to their end, one after another, within the frame.
 *
 * Make a signal inside the program that uses it (`const s = new Signal<number>()` at its top): a signal is variables
 * of a program, as anything a program writes is.
 */

export class Signal<T> {
  /** The handlers, by the number `on` gave; one taken off is undefined, and its place is given to the next one added. */
  handlers: (((value: T) => void) | undefined)[] = [];
  /** Which handlers go once they have run once. */
  onceOnly: boolean[] = [];

  /**
   * Add a handler: it runs at every `emit`, handed the value.
   * @returns Its number, for `off`.
   */
  on(handler: (value: T) => void): number {
    return this.add(handler, false);
  }

  /** Add a handler that runs at the next `emit` only. @returns Its number, for `off` before then. */
  once(handler: (value: T) => void): number {
    return this.add(handler, true);
  }

  /** Take a handler off, by the number `on` or `once` gave. */
  off(id: number) {
    if (id >= 0 && id < this.handlers.length) this.handlers[id] = undefined;
  }

  /** Run every handler, in the order they were added, each handed `value`. */
  emit(value: T) {
    let i = 0;
    while (i < this.handlers.length) {
      const h = this.handlers[i];
      if (h) {
        if (this.onceOnly[i]) this.handlers[i] = undefined;
        h(value);
      }
      i++;
    }
  }

  /** How many handlers it has. */
  count(): number {
    let n = 0;
    for (const h of this.handlers) if (h) n++;
    return n;
  }

  /** Take every handler off. */
  clear() {
    let i = 0;
    while (i < this.handlers.length) { this.handlers[i] = undefined; i++; }
  }

  private add(handler: (value: T) => void, once: boolean): number {
    // A place one was taken off from, or a new one at the end.
    let i = 0;
    while (i < this.handlers.length) {
      if (!this.handlers[i]) {
        this.handlers[i] = handler;
        this.onceOnly[i] = once;
        return i;
      }
      i++;
    }
    this.handlers.push(handler);
    this.onceOnly.push(once);
    return this.handlers.length - 1;
  }
}
