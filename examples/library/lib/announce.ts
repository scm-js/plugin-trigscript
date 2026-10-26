import { print } from "trigscript";

/** Say a line to every player, between dashes. */
export function announce(text: string) {
  print(`— ${text} —`);
}
