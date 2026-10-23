import { memo } from "react";

import { BtcTrapTable } from "@/components/BtcTrapTable";
import { useBtcTrap } from "@/store/BtcTrapProvider";

/** The BTCUSDT failed-breakout table, wired to the live watch. */
export const BtcTrapPanel = memo(function BtcTrapPanel() {
  const { rows, live, clear } = useBtcTrap();
  return <BtcTrapTable rows={rows} live={live} onClear={clear} />;
});
