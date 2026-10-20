// ledger: step 12, refused: a task started
// A menu a player chooses from with W, S and Space, shown in the text lines, from `trigscript/ui`:
// `await choose(P1, ITEMS.length, shop)` and `<MenuList items={ITEMS} selected={shop.selected} />`.
import { MenuList, choose } from "trigscript/ui";
const ITEMS = ["Marine (50)", "Medic (75)", "Leave"];
program(async () => {
  const shop = { selected: 0, open: false };
  ui.lines(P1, () => <>{shop.open && <MenuList items={ITEMS} selected={shop.selected} />}</>);
  const picked = await choose(P1, ITEMS.length, shop);
  print(`Picked ${picked}`);
});
