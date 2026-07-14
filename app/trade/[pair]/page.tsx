import { cookies } from "next/headers";
import { TradingTerminal } from "@/components/trading-terminal";
import type { TradeMode } from "@/components/theme-controls";

function resolveMode(param: string | undefined, cookie: string | undefined): TradeMode {
  const requested = param ?? cookie;
  return requested === "pro" ? "pro" : "simple";
}

export default function PairTradePage({
  params,
  searchParams,
}: {
  params: { pair: string };
  searchParams: { mode?: string };
}) {
  const initialMode = resolveMode(searchParams.mode, cookies().get("mode")?.value);
  return <TradingTerminal pairId={params.pair} initialMode={initialMode} />;
}
