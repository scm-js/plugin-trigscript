// ledger: step 6, refused: a read of memory.map.width
// The map's width and height in tiles: `memory.map.width`, `memory.map.height`.
program(() => {
  const w = memory.map.width;
  const h = memory.map.height;
  print(`${w} by ${h}`);
});
