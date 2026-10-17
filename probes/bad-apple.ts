// Bad Apple!! in the fog of war (TrigScript 4, S4). The script below only keeps the map's triggers running every
// frame; the video is badApple, hand-written eudplib made by probes/lib/bad-apple-gen.mts from the encoder's brushes.
// Host it as a multiplayer game, alone, with Classic graphics. Built with (the video and the song are not ours and
// stay out of the repository):
//   ffmpeg -i <video> -vf "fps=1000/42,scale=128:96:flags=area,format=gray" -f rawvideo <frames.gray>
//   ffmpeg -i <video> -vn -ac 2 -ar 44100 -c:a libvorbis -q:a 3 <song.ogg>
//   npx tsx probes/lib/bad-apple-encode.mts <frames.gray> <brushes.bin> 20
//   npx tsx probes/lib/bad-apple-map.mts <base.scx> <song.ogg> 'staredit\wav\badapple.ogg'
//   npx tsx probes/lib/bad-apple-gen.mts <brushes.bin> <bad-apple.py> 'staredit\wav\badapple.ogg'
//   EXTRA_PLUGIN=badApple=<bad-apple.py> EXTRA_FILE=badapple.b64=<bad-apple.py>.b64 \
//     npx tsx scripts/build-fixture.mts probes/bad-apple.ts <map.scx> <base.scx>
import { program, sleep, frames } from "trigscript";
program(() => { while (true) sleep(frames(1)); });
