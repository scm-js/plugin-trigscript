// ledger: step 7, takes
// The fog library: a video played in the fog, a frame of it every frame of the game: `await fog.play(P1, video)`.
// A video comes only from a .video file the script imports, which a script of the ledger, one file, cannot:
// this one has none, and the call is left out when the map is built.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
const film: Video | null = null;
program(async () => {
  if (film) await fog.play(P1, film);
  fog.reveal(P1);
});
