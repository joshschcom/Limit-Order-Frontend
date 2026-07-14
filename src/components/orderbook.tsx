"use client";

import type { BookLevel, BookSnapshot, ExecutableQuote, TradePrint } from "@seltra/sdk";
import { NumberText } from "@/components/number-text";
import { ChevronDown, Layers3, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { bookMid, useTrades } from "@/lib/market-data";

export function Orderbook({
  pairId,
  book,
  quote,
  isLoading = false,
  isOffline = false,
  onSelectPrice,
}: {
  pairId: string;
  book?: BookSnapshot;
  quote?: ExecutableQuote | null;
  isLoading?: boolean;
  isOffline?: boolean;
  onSelectPrice?: (price: number) => void;
}) {
  const [view, setView] = useState<"book" | "trades">("book");
  const { data: trades } = useTrades(pairId);
  const [precision, setPrecision] = useState(2);
  const [levelCount, setLevelCount] = useState(6);
  const [density, setDensity] = useState<"balanced" | "pro">("balanced");
  const [mobileExpanded, setMobileExpanded] = useState(false);
  useEffect(() => {
    const readDensity = () => {
      const nextDensity = document.documentElement.dataset.density === "pro" ? "pro" : "balanced";
      setDensity(nextDensity);
      setLevelCount(nextDensity === "pro" ? 8 : 6);
    };
    readDensity();
    const observer = new MutationObserver(readDensity);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, []);

  // Server sends best-first; the ask column renders worst→best so both sides meet at the mid row.
  const asks = (book?.asks ?? []).slice(0, levelCount);
  const bids = (book?.bids ?? []).slice(0, levelCount);
  const displayAsks = [...asks].reverse();
  const maxTotal = Math.max(1e-9, ...asks.map((row) => row.total), ...bids.map((row) => row.total));
  const hasOrders = asks.length + bids.length > 0;
  const mid = bookMid(book);
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  const spreadPct = bestBid !== undefined && bestAsk !== undefined && mid ? ((bestAsk - bestBid) / mid) * 100 : undefined;
  const showLoading = isLoading && !book;
  const showOffline = isOffline && !book;

  return (
    <section className={`panel orderbook-panel density-${density} ${mobileExpanded ? "mobile-expanded" : ""}`} aria-label="Seltra resting orderbook">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Book</p>
          <h2>Seltra resting orders</h2>
        </div>
        {isOffline && book ? <span className="chip stale-chip" title="Live connection lost. Showing the last known book."><WifiOff size={11} /> stale</span> : null}
      </div>
      <div className="book-toolbar">
        <div className="book-tabs" role="tablist" aria-label="Orderbook view">
          <button className={view === "book" ? "active" : ""} type="button" role="tab" aria-selected={view === "book"} onClick={() => setView("book")}>Orderbook</button>
          <button className={view === "trades" ? "active" : ""} type="button" role="tab" aria-selected={view === "trades"} onClick={() => setView("trades")}>Trades</button>
        </div>
        <div className="book-controls">
          <label><span className="sr-only">Price precision</span><select value={precision} onChange={(event) => setPrecision(Number(event.target.value))}><option value={2}>0.01</option><option value={1}>0.1</option></select><ChevronDown size={12} /></label>
          <button type="button" onClick={() => setLevelCount((current) => current === 6 ? 8 : 6)}>{levelCount} levels</button>
        </div>
      </div>
      {showLoading ? <BookSkeleton /> : null}
      {showOffline ? <BookOffline /> : null}
      {!showLoading && !showOffline && view === "book" && !hasOrders ? <BookEmpty /> : null}
      {!showLoading && !showOffline && hasOrders && view === "book" ? (
        <>
          <div className="book-grid header" aria-hidden="true">
            <span>Price</span>
            <span>Size</span>
            <span>Total</span>
          </div>
          <BookLevels side="ask" rows={displayAsks} maxTotal={maxTotal} precision={precision} onSelectPrice={onSelectPrice} />
          <div className="lfj-row" title="You fill when the book crosses you or when this executable DEX price reaches you.">
            <div>
              <span className="lfj-label">{quote ? `${quote.venue} executable` : "Book mid"}</span>
              <span className="lfj-spread">{spreadPct !== undefined ? `${spreadPct.toFixed(2)}% spread` : ""}</span>
            </div>
            <strong className="number">
              {quote ? `$${quote.price.toFixed(precision)}` : mid !== undefined ? `$${mid.toFixed(precision)}` : "—"}
            </strong>
          </div>
          <BookLevels side="bid" rows={bids} maxTotal={maxTotal} precision={precision} onSelectPrice={onSelectPrice} />
        </>
      ) : null}
      {!showLoading && !showOffline && view === "trades" ? <RecentTrades trades={trades ?? []} precision={precision} /> : null}
      {!showLoading && hasOrders && view === "book" ? <button className="mobile-book-toggle" type="button" onClick={() => setMobileExpanded((expanded) => !expanded)}>{mobileExpanded ? "Show compact book" : "Show all levels"}</button> : null}
    </section>
  );
}

function BookLevels({
  side,
  rows,
  maxTotal,
  precision,
  onSelectPrice,
}: {
  side: "ask" | "bid";
  rows: BookLevel[];
  maxTotal: number;
  precision: number;
  onSelectPrice?: (price: number) => void;
}) {
  return (
    <div className={`book-side ${side}s`}>
      {rows.map((row) => (
        <button className={`book-row book-${side}`} type="button" key={row.price} onClick={() => onSelectPrice?.(row.price)} aria-label={`Use ${row.price.toFixed(2)} as the limit price`}>
          <span className="depth" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
          <NumberText value={row.price} precision={precision} tone={side === "ask" ? "sell" : "buy"} />
          <NumberText value={row.size} precision={2} />
          <NumberText value={row.total} precision={2} />
        </button>
      ))}
    </div>
  );
}

function BookSkeleton() {
  return <div className="book-skeleton" aria-label="Loading orderbook"><span /><span /><span /><span /><span /><span /></div>;
}

function BookEmpty() {
  return (
    <div className="book-empty">
      <Layers3 size={20} />
      <strong>No resting orders</strong>
      <span>Signed orders appear here the moment they are placed.</span>
    </div>
  );
}

function BookOffline() {
  return (
    <div className="book-empty">
      <WifiOff size={20} />
      <strong>Orderbook unavailable</strong>
      <span>Cannot reach the Seltra orderbook service. Retrying automatically.</span>
    </div>
  );
}

function RecentTrades({ trades, precision }: { trades: TradePrint[]; precision: number }) {
  if (trades.length === 0) {
    return (
      <div className="book-empty">
        <Layers3 size={20} />
        <strong>No trades yet</strong>
        <span>Settled fills appear here — DEX fills and P2P matches alike.</span>
      </div>
    );
  }
  return (
    <div className="recent-trades">
      <div className="book-grid header" aria-hidden="true"><span>Price</span><span>Size</span><span>Time</span></div>
      {trades.map((trade) => (
        <div className={`trade-row ${trade.side}`} key={`${trade.orderHash}`} title={`${trade.path === "p2p" ? "P2P match" : "DEX fill"} · tx ${trade.txHash.slice(0, 14)}…`}>
          <NumberText value={trade.price} precision={precision} tone={trade.side} />
          <NumberText value={trade.size} precision={2} />
          <span className="number">
            {new Date(trade.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {trade.path === "p2p" ? <em className="trade-path">P2P</em> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
