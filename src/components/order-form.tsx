"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, PenLine, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { formatToken } from "@/lib/format";
import type { OrderEntryMachine } from "@/hooks/use-order-entry-machine";

export function OrderForm({ machine: m, midPrice }: { machine: OrderEntryMachine; midPrice?: number }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { pair, base, quote, makerAsset, takerAsset, state } = m;
  const setQuickPrice = (factor: number) => {
    if (midPrice) m.setPrice((midPrice * factor).toFixed(pair.pricePrecision));
  };

  return (
    <section className={`panel order-form flow-${state.tag} ${m.isConnected && !m.wrongNetwork ? `side-${m.side}` : ""}`} aria-busy={m.busy}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Order entry</p>
          <h2>Limit order</h2>
        </div>
      </div>
      <div className="order-kind-tabs" role="tablist" aria-label="Order type">
        <button className={m.kind === "limit" ? "active" : ""} type="button" role="tab" aria-selected={m.kind === "limit"} onClick={() => m.setKind("limit")}>Limit</button>
        <button className={m.kind === "market" ? "active" : ""} type="button" role="tab" aria-selected={m.kind === "market"} onClick={() => m.setKind("market")}>Market</button>
        <button type="button" role="tab" disabled title="Available after V1">Swap</button>
      </div>
      <div className="side-tabs">
        <button className={m.side === "buy" ? "active buy-tab" : ""} type="button" onClick={() => m.setSide("buy")}>
          Buy
        </button>
        <button className={m.side === "sell" ? "active sell-tab" : ""} type="button" onClick={() => m.setSide("sell")}>
          Sell
        </button>
      </div>
      <label className="field">
        <span className="field-label">Amount <small>{makerAsset.symbol}</small></span>
        <div className="input-row">
          <input value={m.amount} onChange={(event) => m.setAmount(event.target.value)} inputMode="decimal" />
          <button type="button" onClick={m.setMaxAmount}>
            MAX
          </button>
        </div>
        <small className="balance-line">Available <strong className="number">{m.balance === undefined ? "-" : formatToken(m.balance, makerAsset.decimals, 4)} {makerAsset.symbol}</strong></small>
      </label>
      <div className="percent-buttons" aria-label="Amount presets">
        {[25n, 50n, 75n, 100n].map((percent) => <button key={percent.toString()} type="button" onClick={() => m.setAmountPercent(percent)} disabled={!m.balance}>{percent.toString()}%</button>)}
      </div>
      {m.kind === "limit" ? (
        <>
          <label className="field">
            <span className="field-label">Limit price <small>{quote.symbol} per {base.symbol}</small></span>
            <div className="input-row">
              <input value={m.price} onChange={(event) => m.setPrice(event.target.value)} inputMode="decimal" />
              <span>{quote.symbol}</span>
            </div>
          </label>
          <div className="quick-price" aria-label="Quick price presets">
            <span>Quick set</span>
            <button type="button" disabled={!midPrice} title={midPrice ? undefined : "No executable quote or resting orders to derive a price from yet"} onClick={() => setQuickPrice(1)}>Mid</button>
            <button type="button" disabled={!midPrice} onClick={() => setQuickPrice(0.99)}>-1%</button>
            <button type="button" disabled={!midPrice} onClick={() => setQuickPrice(1.01)}>+1%</button>
          </div>
          <div className="advanced-settings">
            <button type="button" className="advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}><span>Advanced settings</span><ChevronDown size={15} /></button>
            {advancedOpen ? <label className="field advanced-field"><span className="field-label">Expiry <small>Maximum 30 days</small></span><select value={m.expirySeconds} onChange={(event) => m.setExpirySeconds(Number(event.target.value))}><option value={3600}>1h</option><option value={86400}>1d</option><option value={604800}>7d</option><option value={2592000}>30d</option></select></label> : null}
          </div>
        </>
      ) : (
        <>
          <div className="quick-price" aria-label="Slippage bound">
            <span>Max slippage</span>
            {[10, 50, 100].map((bps) => (
              <button key={bps} type="button" className={m.slippageBps === bps ? "active" : ""} onClick={() => m.setSlippageBps(bps)}>
                {(bps / 100).toFixed(bps === 10 ? 1 : 1)}%
              </button>
            ))}
          </div>
          <p className="caption market-note">
            {m.referencePrice !== undefined
              ? `Signs a limit at ${m.effectivePrice} ${quote.symbol} (executable ${m.referencePrice.toFixed(m.pair.pricePrecision)} ${m.side === "sell" ? "−" : "+"} ${(m.slippageBps / 100).toFixed(1)}%). It cannot fill worse than this bound and expires in 10 minutes if unfilled.`
              : "No executable quote available right now — market orders need a live venue price."}
          </p>
        </>
      )}
      <div className="summary-box">
        <div>
          <span>You pay at most</span>
          <strong className="number">
            {formatToken(m.makingAmount, makerAsset.decimals, 4)} {makerAsset.symbol}
          </strong>
        </div>
        <div>
          <span>You receive at least</span>
          <strong className="number">
            {formatToken(m.takingAmount, takerAsset.decimals, 4)} {takerAsset.symbol}
          </strong>
        </div>
        <div className="summary-improvement">
          <span>Price improvement</span>
          <strong><b>70%</b> of surplus is yours</strong>
        </div>
        <div>
          <span>Signing fee</span>
          <strong>Gasless</strong>
        </div>
        <div>
          <span>Expiry</span>
          <strong className="number">{m.kind === "market" ? "10m" : m.expirySeconds === 3600 ? "1h" : m.expirySeconds === 86400 ? "1d" : m.expirySeconds === 604800 ? "7d" : "30d"}</strong>
        </div>
      </div>
      {m.needsApproval ? <p className="approval-note"><ShieldCheck size={15} /> One-time Permit2 approval. Seltra never receives a standing approval.</p> : null}
      {m.insufficientBalance ? <p className="form-error"><AlertTriangle size={15} /> Insufficient {makerAsset.symbol} balance.</p> : null}
      {state.tag === "rejected" ? (
        <p className="form-error">
          <AlertTriangle size={14} /> {state.reason}
        </p>
      ) : null}
      {state.tag === "resting" ? (
        <p className="form-success">
          <CheckCircle2 size={14} /> Order placed. Resting until {m.effectivePrice} or better.
        </p>
      ) : null}
      <div className="order-action-footer">
        <button
          className="button accent full"
          type="button"
          disabled={m.ctaDisabled}
          onClick={m.primaryAction}
        >
          {m.busy && state.tag !== "validating" ? <Loader2 className="spin" size={16} /> : !m.isConnected ? <Wallet size={16} /> : <PenLine size={16} />}
          {m.ctaLabel}
        </button>
        <p className="caption">Your funds stay in your wallet until an exact fill. Signing an order is gasless.</p>
      </div>
      {state.tag === "awaiting-signature" ? <div className="signature-pending" role="status"><div><Loader2 className="spin" size={20} /><h3>Confirm in wallet</h3><p>One signature. No gas. Funds stay in your wallet until the exact fill.</p></div></div> : null}
    </section>
  );
}
