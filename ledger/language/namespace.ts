// ledger: step 0, takes
// A `namespace` outside the program holding constants known when the map is built.
namespace Costs {
  export const Marine = 50;
  export const Medic = 75;
}
program(() => {
  let ore = 400;
  while (ore >= Costs.Medic) ore -= Costs.Marine;
  print(`${ore}`);
});
