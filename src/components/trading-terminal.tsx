"use client";

import { PenLine, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Orderbook } from "@/components/orderbook";
import { OrderForm } from "@/components/order-form";
import { OrdersTable } from "@/components/orders-table";
import { PriceChart } from "@/components/price-chart";
import { SimpleTrade } from "@/components/simple-trade";
import { applyTradeMode, ModeToggle, type TradeMode } from "@/components/theme-controls";
import { displaySymbol } from "@/components/token-icon";
import { pairById } from "@/config/seltra.config";
import type { TakeProfitRequest } from "@/components/take-profit-panel";
import { useOrderEntryMachine } from "@/hooks/use-order-entry-machine";
import { bookMid, useMyOrders, useOrderbook, useQuote } from "@/lib/market-data";

export function TradingTerminal({ pairId, initialMode }: { pairId: string; initialMode: TradeMode }) {
  const [mode, setMode] = useState<TradeMode>(initialMode);
  const [mobileTradeOpen, setMobileTradeOpen] = useState(false);
  // Bumped when a Martingale take-profit is prefilled so the order form leaves the Bot tab.
  const [limitFormSignal, setLimitFormSignal] = useState(0);
  const pair = pairById(pairId);
  const bookQuery = useOrderbook(pair.id);
  const quoteQuery = useQuote(pair.id);
  const machine = useOrderEntryMachine({ pairId, referencePrice: quoteQuery.data?.price });
  const ordersQuery = useMyOrders();

  useEffect(() => {
    applyTradeMode(mode);
  }, [mode]);

  // Live price in the tab title, like any exchange: glanceable without focus.
  useEffect(() => {
    const price = quoteQuery.data?.price;
    const pairLabel = `${displaySymbol(pair.base)}/${displaySymbol(pair.quote)}`;
    document.title =
      price !== undefined ? `${price.toFixed(pair.pricePrecision)} · ${pairLabel} — Seltra` : `${pairLabel} — Seltra`;
    return () => {
      document.title = "Seltra";
    };
  }, [quoteQuery.data?.price, pair]);

  // Quick-set anchor: the executable router quote when a venue has liquidity, else book mid.
  const midPrice = quoteQuery.data?.price ?? bookMid(bookQuery.data);
  // A Martingale take-profit is an ordinary limit sell: prefill it and let the
  // user review and sign through the normal order form.
  const prefillTakeProfit = (request: TakeProfitRequest) => {
    machine.setKind("limit");
    machine.setSide("sell");
    machine.setAmount(request.amount);
    machine.setPrice(request.price);
    setLimitFormSignal((value) => value + 1);
    setMobileTradeOpen(true);
  };
  const selectPrice = (price: number) => machine.setPrice(price.toFixed(machine.pair.pricePrecision));

  return (
    <AppShell pairId={pairId} modeControl={<ModeToggle mode={mode} onModeChange={setMode} />}>
      {mode === "simple" ? (
        <SimpleTrade
          machine={machine}
          midPrice={midPrice}
          book={bookQuery.data}
          quote={quoteQuery.data ?? null}
          bookLoading={bookQuery.isLoading}
          bookOffline={bookQuery.isError}
          onSelectPrice={selectPrice}
        />
      ) : (
        <>
          <main className="terminal-grid">
            <PriceChart pairId={machine.pair.id} />
            <Orderbook pairId={pair.id} book={bookQuery.data} quote={quoteQuery.data ?? null} isLoading={bookQuery.isLoading} isOffline={bookQuery.isError} onSelectPrice={selectPrice} />
            <div className={`trade-sheet ${mobileTradeOpen ? "open" : ""}`}>
              <button className="sheet-close icon-button" type="button" aria-label="Close order form" title="Close" onClick={() => setMobileTradeOpen(false)}><X size={17} /></button>
              <OrderForm machine={machine} midPrice={midPrice} limitFormSignal={limitFormSignal} />
            </div>
            <div className="terminal-orders">
              <OrdersTable
                orders={ordersQuery.data ?? []}
                isLoading={ordersQuery.isConnected && ordersQuery.isLoading}
                isOffline={ordersQuery.isError}
                isConnected={ordersQuery.isConnected}
                pro
                takeProfit={{ pairId: pair.id, apply: prefillTakeProfit }}
              />
            </div>
          </main>
          <button className="mobile-trade-trigger button accent" type="button" onClick={() => setMobileTradeOpen(true)}><PenLine size={16} /> Trade</button>
        </>
      )}
    </AppShell>
  );
}
