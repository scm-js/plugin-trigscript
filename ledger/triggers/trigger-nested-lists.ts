// ledger: step 13, takes
// A trigger's conditions and actions as nested lists, `null` entries left out: what a helper puts together.
const hard: boolean = false;
const reward = [setResources(P1, "add", 100, "ore"), hard ? setResources(P1, "subtract", 50, "gas") : null];
trigger(P1, [always(), [switchIs(switches.Switch1, "set")]], [reward, displayText("Bonus.")]);
program(() => {
  print("started");
});
