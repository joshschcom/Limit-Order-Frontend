"use client";

import { Activity, BarChart3, Menu, ShieldCheck, Triangle, Wifi, WifiOff, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useBlockNumber, useReadContract } from "wagmi";
import { seltraConfig, isConfiguredAddress, pairById, defaultTradePath } from "@/config/seltra.config";
import { seltraSettlementAbi } from "@/lib/abi";
import { bookDepthQuote, bookMid, useOrderbook, useQuote, useStats, useWsStatus } from "@/lib/market-data";
import { SeltraMark } from "@/components/seltra-mark";
import { applyTradeMode, ThemeToggle } from "@/components/theme-controls";
import { WalletButton, WalletDialogProvider } from "@/components/wallet-button";

function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export function AppShell({ children, pairId, modeControl }: { children: React.ReactNode; pairId: string; modeControl?: React.ReactNode }) {
  const pair = pairById(pairId);
  const { data: fillsPaused } = useReadContract({
    address: seltraConfig.contracts.settlement,
    abi: seltraSettlementAbi,
    functionName: "fillsPaused",
    query: { enabled: isConfiguredAddress(seltraConfig.contracts.settlement) },
  });
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const { data: book, isError: bookError } = useOrderbook(pair.id);
  const { data: quote } = useQuote(pair.id);
  const { data: stats, isError: statsError } = useStats();
  const wsStatus = useWsStatus();

  const mid = bookMid(book);
  const depth = bookDepthQuote(book);
  const apiOffline = bookError && statsError;
  const live = wsStatus === "open";

  return (
    <WalletDialogProvider>
      <div className="app-shell">
        <header className="exchange-nav">
          <div className="exchange-nav-left">
            <Link className="brand" href="/" aria-label="Seltra home">
              <SeltraMark className="brand-mark" />
              <span className="brand-word">Seltra</span>
              {seltraConfig.chainId === 43113 ? <span className="testnet-tag">Testnet</span> : null}
            </Link>
            <nav className="nav-links" aria-label="Application">
              <Link href="/trade">Markets</Link>
              <Link href={defaultTradePath}>Trade</Link>
              <Link href="/orders">Orders</Link>
              <Link href="/stats">Stats</Link>
              <Link href="/docs">Docs</Link>
            </nav>
          </div>
          <div className="exchange-nav-actions">
            <ThemeToggle />
            {modeControl}
            <WalletButton />
            <MobileNav />
          </div>
        </header>
        <div className="market-strip" aria-label="Market summary">
          <div className="market-selector-wrap">
            <span className="network-chip"><Triangle size={9} fill="currentColor" /> Avalanche</span>
            <select className="pair-select" value={pair.id} aria-label="Market pair" onChange={(event) => (window.location.href = `/trade/${event.target.value}`)}>
              {seltraConfig.pairs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="ticker-strip">
            <TickerItem label="Executable" value={quote ? `$${quote.price.toFixed(pair.pricePrecision)}` : "—"} />
            <TickerItem label="Book mid" value={mid !== undefined ? `$${mid.toFixed(pair.pricePrecision)}` : "—"} />
            <TickerItem label="Book depth" value={depth !== undefined ? compactUsd(depth) : "—"} />
            <TickerItem label="Resting orders" value={stats ? String(stats.ordersResting) : "—"} />
            <TickerItem label="Orders filled" value={stats ? String(stats.ordersFilled) : "—"} />
            <span className={`chip conn-chip ${apiOffline ? "offline" : live ? "live" : "connecting"}`} title={apiOffline ? "Cannot reach the Seltra orderbook service" : live ? "Live data stream connected" : "Connecting to the live data stream"}>
              {apiOffline ? <WifiOff size={11} /> : <Wifi size={11} />}
              {apiOffline ? "Offline" : live ? "Live" : "Connecting"}
            </span>
          </div>
        </div>
        {fillsPaused ? (
          <div className="pause-banner">
            <ShieldCheck size={16} />
            Fills are paused by the guardian. Your funds are in your wallet. You can still cancel orders.
          </div>
        ) : null}
        {children}
        <footer className="footer">
          <span className="footer-brand">Seltra</span>
          <span>Wallet-native limit orders</span>
          <span className="mono">{isConfiguredAddress(seltraConfig.contracts.settlement) ? seltraConfig.contracts.settlement : "Settlement not configured"}</span>
          <span className="heartbeat">
            <Activity size={13} />
            {!isConfiguredAddress(seltraConfig.contracts.settlement)
              ? "Guardian status unavailable"
              : fillsPaused
                ? "Guardian pause active"
                : "Guardian active / Fills live"}
          </span>
          <span className="heartbeat">
            <BarChart3 size={13} /> {blockNumber !== undefined ? `Block ${blockNumber.toString()}` : "Block —"}
          </span>
        </footer>
      </div>
    </WalletDialogProvider>
  );
}

/**
 * Mobile-only (≤768px) menu for the nav links the compact header hides.
 * Mobile is deliberately Simple-only — no Pro toggle here — but a Pro cookie
 * carried over from desktop gets an escape hatch back to Simple.
 */
function MobileNav() {
  const [open, setOpen] = useState(false);
  const [showExitPro, setShowExitPro] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowExitPro(
      document.documentElement.dataset.density === "pro" && window.location.pathname.startsWith("/trade/"),
    );
  }, [open]);

  return (
    <div className="mobile-nav">
      <button
        className="icon-button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        {open ? <X size={17} /> : <Menu size={17} />}
      </button>
      {open ? (
        <nav className="popover mobile-nav-sheet" aria-label="Application">
          <Link href="/trade" onClick={() => setOpen(false)}>Markets</Link>
          <Link href={defaultTradePath} onClick={() => setOpen(false)}>Trade</Link>
          <Link href="/orders" onClick={() => setOpen(false)}>Orders</Link>
          <Link href="/stats" onClick={() => setOpen(false)}>Stats</Link>
          <Link href="/docs" onClick={() => setOpen(false)}>Docs</Link>
          {showExitPro ? (
            <a href="?mode=simple" onClick={() => applyTradeMode("simple")}>
              Exit Pro mode
            </a>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function TickerItem({ label, value, tone }: { label: string; value: string; tone?: "buy" | "sell" }) {
  return (
    <span>
      <small>{label}</small>
      <strong className={`number ${tone ?? ""}`}>{value}</strong>
    </span>
  );
}
