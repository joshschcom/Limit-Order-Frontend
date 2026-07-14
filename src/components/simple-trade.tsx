"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { BookSnapshot, ExecutableQuote } from "@seltra/sdk";
import { OrderForm } from "@/components/order-form";
import { Orderbook } from "@/components/orderbook";
import { PriceChart } from "@/components/price-chart";
import type { OrderEntryMachine } from "@/hooks/use-order-entry-machine";

export function SimpleTrade({
  machine,
  midPrice,
  book,
  quote,
  bookLoading,
  bookOffline,
  onSelectPrice,
}: {
  machine: OrderEntryMachine;
  midPrice?: number;
  book?: BookSnapshot;
  quote?: ExecutableQuote | null;
  bookLoading?: boolean;
  bookOffline?: boolean;
  onSelectPrice: (price: number) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <main className="simple-layout">
      <div className="simple-stack">
        <OrderForm machine={machine} midPrice={midPrice} />
        <section className="panel simple-details">
          <button
            className="simple-details-toggle"
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <span>Market details</span>
            <ChevronDown size={15} className={detailsOpen ? "flipped" : ""} />
          </button>
          {detailsOpen ? (
            <div className="simple-details-body">
              <PriceChart pairId={machine.pair.id} />
              <Orderbook pairId={machine.pair.id} book={book} quote={quote} isLoading={bookLoading} isOffline={bookOffline} onSelectPrice={onSelectPrice} />
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
