"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { GridPlanError, planTakeProfit, type GridManifest, type TakeProfitDraft, type TakeProfitTarget } from "@seltra/sdk";
import { pairById, tokenBySymbol } from "@/config/seltra.config";
import { formatToken } from "@/lib/format";
import type { LadderPosition } from "@/lib/grid-groups";
import { dismissTakeProfit } from "@/lib/grid-manifests";
import { displaySymbol } from "@/components/token-icon";

/** A sell the order form should be prefilled with; the user reviews and signs it there. */
export interface TakeProfitRequest {
  pairId: string;
  /** Base amount, decimal string. */
  amount: string;
  /** Limit price, decimal string at the pair's price precision. */
  price: string;
}

export interface TakeProfitHandler {
  /** The pair whose order form is on screen; prefill is only offered for that pair. */
  pairId: string;
  apply: (request: TakeProfitRequest) => void;
}

// Take-profit for a Martingale ladder is deliberately manual: it only prefills
// an ordinary limit sell. Nothing here signs, approves, or submits, and no sell
// is pre-signed — the order form owns every wallet interaction.

export function TakeProfitPanel({
  manifest,
  position,
  handler,
}: {
  manifest: GridManifest;
  position: LadderPosition;
  handler?: TakeProfitHandler;
}) {
  const pair = pairById(manifest.pairId);
  const base = tokenBySymbol(pair.base);
  const quote = tokenBySymbol(pair.quote);
  const [mode, setMode] = useState<TakeProfitTarget["mode"]>("percent");
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  const result = useMemo<{ draft: TakeProfitDraft } | { error: string } | null>(() => {
    if (trimmed === "") return null;
    try {
      const draft = planTakeProfit(
        { spentQuote: position.spentQuote, receivedBase: position.receivedBase, sellBase: position.unsoldBase },
        { mode, value: trimmed },
        { baseDecimals: base.decimals, quoteDecimals: quote.decimals, pricePrecision: pair.pricePrecision },
      );
      return { draft };
    } catch (cause) {
      return { error: cause instanceof GridPlanError ? cause.userMessage : "Enter a valid value" };
    }
  }, [trimmed, mode, position, base.decimals, quote.decimals, pair.pricePrecision]);

  const baseLabel = displaySymbol(base.symbol);
  const quoteLabel = displaySymbol(quote.symbol);
  const draft = result && "draft" in result ? result.draft : null;
  const canApply = handler !== undefined && handler.pairId === manifest.pairId;

  return (
    <div className="take-profit">
      <p className="take-profit-summary">
        Bought <strong className="number">{formatToken(position.receivedBase, base.decimals, 4)} {baseLabel}</strong> for{" "}
        <strong className="number">{formatToken(position.spentQuote, quote.decimals, 4)} {quoteLabel}</strong>
        {" · "}unsold <strong className="number">{formatToken(position.unsoldBase, base.decimals, 4)} {baseLabel}</strong>
      </p>
      <div className="take-profit-controls">
        <div className="order-kind-tabs take-profit-mode" role="tablist" aria-label="Take-profit type">
          <button className={mode === "percent" ? "active" : ""} type="button" role="tab" aria-selected={mode === "percent"} onClick={() => setMode("percent")}>% gain</button>
          <button className={mode === "price" ? "active" : ""} type="button" role="tab" aria-selected={mode === "price"} onClick={() => setMode("price")}>Price</button>
        </div>
        <div className="input-row take-profit-input">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            inputMode="decimal"
            placeholder={mode === "percent" ? "5" : "0.00"}
            aria-label={mode === "percent" ? "Take-profit gain over average entry, percent" : `Take-profit price in ${quoteLabel}`}
          />
          <span>{mode === "percent" ? "%" : quoteLabel}</span>
        </div>
      </div>
      {result && "error" in result ? <p className="form-error field-error" role="alert">{result.error}</p> : null}
      {draft ? (
        <p className="take-profit-preview">
          Sell {formatUnits(draft.amount, base.decimals)} {baseLabel} at{" "}
          <strong className="number">{draft.price} {quoteLabel}</strong>
          {" · "}avg entry {draft.averageEntry} · +{draft.gainPct.toFixed(2)}%
        </p>
      ) : null}
      <div className="take-profit-actions">
        {canApply ? (
          <button
            className="button accent"
            type="button"
            disabled={!draft}
            onClick={() => draft && handler.apply({ pairId: manifest.pairId, amount: formatUnits(draft.amount, base.decimals), price: draft.price })}
          >
            Prefill sell order
          </button>
        ) : (
          <a className="button outline" href={`/trade/${manifest.pairId}`}>Open {manifest.pairId} to sell</a>
        )}
        <button className="button outline" type="button" onClick={() => dismissTakeProfit(manifest)} title="Hide this prompt. Your filled orders stay in History.">
          Dismiss
        </button>
      </div>
      <p className="caption">
        {canApply
          ? "Fills the order form with a limit sell for the unsold amount; you review and sign it there. It fills right away if the market is already at or above that price."
          : "Take-profit sells are placed from this pair's order form, where you review and sign them."}
      </p>
    </div>
  );
}
