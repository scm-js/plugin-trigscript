// What StarCraft: Remastered does with sounds a program plays, read from a recording's audio: how steadily a sound
// starts from frame to frame, whether one the WAV list does not name starts late, whether playing a sound again
// restarts it or adds a second, how many play at once, whether eight copies are louder than one, whether loudness is
// kept, and which formats play. Every sound is a tone or click of its own (probes/lib/sound-probe-map.mts), so the
// audio alone says which played and when. The whole run repeats.
// Host it as a multiplayer game, alone, with the game's MUSIC turned off (Options > Sound) and the camera left alone.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx probes/lib/sound-probe-map.mts fixtures/eud/sound-base.scx fixtures/eud/sound-probe-base.scx
//   npx tsx scripts/build-fixture.mts probes/sound-probe.ts fixtures/eud/sound-probe.scx fixtures/eud/sound-probe-base.scx

const W = "staredit\\wav\\";
const CLICK = `${W}probe-click.wav`, UNLISTED = `${W}probe-click-unlisted.wav`, SWEEP = `${W}probe-sweep.wav`;
const SAME = `${W}probe-same.wav`, LOUD = `${W}probe-loud.wav`, QUIET = `${W}probe-quiet.wav`;
const TONES = [
  `${W}probe-tone-00.wav`, `${W}probe-tone-01.wav`, `${W}probe-tone-02.wav`, `${W}probe-tone-03.wav`,
  `${W}probe-tone-04.wav`, `${W}probe-tone-05.wav`, `${W}probe-tone-06.wav`, `${W}probe-tone-07.wav`,
  `${W}probe-tone-08.wav`, `${W}probe-tone-09.wav`, `${W}probe-tone-10.wav`, `${W}probe-tone-11.wav`,
  `${W}probe-tone-12.wav`, `${W}probe-tone-13.wav`, `${W}probe-tone-14.wav`, `${W}probe-tone-15.wav`,
  `${W}probe-tone-16.wav`, `${W}probe-tone-17.wav`, `${W}probe-tone-18.wav`, `${W}probe-tone-19.wav`,
  `${W}probe-tone-20.wav`, `${W}probe-tone-21.wav`, `${W}probe-tone-22.wav`, `${W}probe-tone-23.wav`,
  `${W}probe-tone-24.wav`, `${W}probe-tone-25.wav`, `${W}probe-tone-26.wav`, `${W}probe-tone-27.wav`,
  `${W}probe-tone-28.wav`, `${W}probe-tone-29.wav`, `${W}probe-tone-30.wav`, `${W}probe-tone-31.wav`,
] as const;
const FORMATS = [
  `${W}probe-fmt-8-11k.wav`, `${W}probe-fmt-8-22k.wav`, `${W}probe-fmt-16-22k.wav`, `${W}probe-fmt-16-44k-stereo.wav`,
  `${W}probe-fmt-16-48k.wav`, `${W}probe-fmt-ima-22k.wav`, `${W}probe-fmt-vorbis-44k.ogg`, `${W}probe-fmt-opus-48k.ogg`,
] as const;

/** Where the camera waits, out of the way. */
const PARK = reserveLocation("sound probe: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04Sound probe. Turn the game's MUSIC off (Options > Sound) and keep recording. It repeats.");
  await sleep(frames(168));
  let round = 1;
  while (true) {
    displayText(`\x11Round ${round}.`);
    await sleep(frames(48));

    displayText("\x04T1: a click every 6 frames.");
    let i = 0;
    while (i < 40) { playWav(CLICK, 0); await sleep(frames(6)); i++; }
    await sleep(frames(48));
    displayText("\x04T2: a click every 2 frames.");
    i = 0;
    while (i < 60) { playWav(CLICK, 0); await sleep(frames(2)); i++; }
    await sleep(frames(48));
    displayText("\x04T3: a click every frame.");
    i = 0;
    while (i < 60) { playWav(CLICK, 0); await nextFrame(); i++; }
    await sleep(frames(48));

    displayText("\x04T4: low clicks every 12 frames, a high one (not in the WAV list) halfway between.");
    i = 0;
    while (i < 12) { playWav(CLICK, 0); await sleep(frames(6)); playWav(UNLISTED, 0); await sleep(frames(6)); i++; }
    await sleep(frames(48));

    displayText("\x04T5: a falling sweep, then the same played again a quarter second in; then the sweep alone.");
    playWav(SWEEP, 0);
    await sleep(frames(6));
    playWav(SWEEP, 0);
    await sleep(frames(60));
    playWav(SWEEP, 0);
    await sleep(frames(72));

    displayText("\x04T6: 32 tones, one more every 3 frames, each 6 seconds long.");
    for (const tone of TONES) { playWav(tone, 0); await sleep(frames(3)); }
    await sleep(frames(168));

    displayText("\x04T7: one tone, then eight copies of it in the same frame.");
    playWav(SAME, 0);
    await sleep(frames(72));
    i = 0;
    while (i < 8) { playWav(SAME, 0); i++; }
    await sleep(frames(72));

    displayText("\x04T8: the same tone loud, then a quarter as loud.");
    playWav(LOUD, 0);
    await sleep(frames(36));
    playWav(QUIET, 0);
    await sleep(frames(48));

    displayText("\x04T9: formats, a pitch each: 8-bit 11k, 8-bit 22k, 16-bit 22k, 44k stereo, 48k, IMA ADPCM, Ogg Vorbis, Ogg Opus.");
    for (const f of FORMATS) { playWav(f, 0); await sleep(frames(36)); }
    await sleep(frames(48));

    displayText("\x04That is the round. It starts again.");
    await sleep(frames(96));
    round++;
  }
});
