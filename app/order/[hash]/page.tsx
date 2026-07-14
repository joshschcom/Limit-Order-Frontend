"use client";

import { ExternalLink, Loader2, SearchX } from "lucide-react";
import { formatUnits } from "viem";
import type { OrderRecord } from "@seltra/sdk";
import { AppShell } from "@/components/app-shell";
import { NumberText } from "@/components/number-text";
import { fillImprovement } from "@/components/orders-table";
import { pairById, defaultPairId, seltraConfig, tokenBySymbol } from "@/config/seltra.config";
import { formatCountdown, useNowSeconds, useOrderRecord } from "@/lib/market-data";

export default function OrderDetailPage({ params }: { params: { hash: string } }) {
  const { data: order, isLoading, isError } = useOrderRecord(params.hash);
  const now = useNowSeconds();

  return (
    <AppShell pairId={defaultPairId}>
      <main className="page-stack">
        {isLoading ? (
          <section className="panel orders-empty">
            <Loader2 className="spin" size={22} />
            <div><strong>Loading order</strong><span>Fetching the signed order from the Seltra orderbook.</span></div>
          </section>
        ) : null}
        {!isLoading && (isError || !order) ? (
          <section className="panel orders-empty">
            <SearchX size={22} />
            <div>
              <strong>{isError ? "Order lookup unavailable" : "Order not found"}</strong>
              <span>{isError ? "Cannot reach the Seltra orderbook service. Retrying automatically." : "No order with this hash is known to the orderbook."}</span>
            </div>
          </section>
        ) : null}
        {order ? <OrderDetail order={order} now={now} /> : null}
      </main>
    </AppShell>
  );
}

function OrderDetail({ order, now }: { order: OrderRecord; now: number }) {
  const pair = pairById(order.pair);
  const countdown = formatCountdown(Number(order.order.expiry), now);
  const expiresAt = new Date(Number(order.order.expiry) * 1000);
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Order detail</p>
          <h1>{order.pair}</h1>
        </div>
        <span className={`chip status-chip ${order.status}`}>{order.status}</span>
      </section>
      <section className="panel detail-grid">
        <div>
          <span className="label">Order hash</span>
          <button className="copy-line" type="button" onClick={() => navigator.clipboard.writeText(order.orderHash)}>
            {order.orderHash}
          </button>
        </div>
        <div>
          <span className="label">Maker</span>
          <button className="copy-line" type="button" onClick={() => navigator.clipboard.writeText(order.order.maker)}>
            {order.order.maker}
          </button>
        </div>
        <div>
          <span className="label">Side</span>
          <strong className={order.side === "buy" ? "buy" : "sell"}>{order.side.toUpperCase()}</strong>
        </div>
        <div>
          <span className="label">Amount</span>
          <NumberText value={Number(order.baseAmount)} precision={pair.amountPrecision} suffix={` ${pair.base}`} />
        </div>
        <div>
          <span className="label">Limit</span>
          <NumberText value={Number(order.price)} precision={pair.pricePrecision} suffix={` ${pair.quote}`} />
        </div>
        <div>
          <span className="label">Expires</span>
          <strong className={`number ${countdown.warn ? "warn" : ""}`}>
            {order.status === "resting" ? `${countdown.label} · ` : ""}
            {expiresAt.toLocaleString()}
          </strong>
        </div>
        <div>
          <span className="label">Epoch</span>
          <NumberText value={Number(order.order.epoch)} precision={0} />
        </div>
        <div>
          <span className="label">Created</span>
          <strong className="number">{new Date(order.createdAt).toLocaleString()}</strong>
        </div>
      </section>
      {order.fill ? <FillDetail order={order} /> : null}
    </>
  );
}

function FillDetail({ order }: { order: OrderRecord }) {
  const fill = order.fill!;
  const pair = pairById(order.pair);
  const improvement = fillImprovement(order);
  const receiveSymbol = order.side === "sell" ? pair.quote : pair.base;
  const receiveToken = tokenBySymbol(receiveSymbol);
  const keeperReward = Number(formatUnits(BigInt(fill.keeperReward), receiveToken.decimals));
  return (
    <section className="panel detail-grid">
      <div>
        <span className="label">Fill path</span>
        <strong>{fill.path === "p2p" ? "P2P match — matched directly with another Seltra order. Zero slippage." : "DEX fill"}</strong>
      </div>
      <div>
        <span className="label">Filled</span>
        <strong className="number">{new Date(fill.timestamp * 1000).toLocaleString()}</strong>
      </div>
      <div>
        <span className="label">Price improvement</span>
        {improvement ? (
          <NumberText value={improvement.amount} precision={4} suffix={` ${improvement.symbol}`} signed tone="buy" />
        ) : (
          <strong className="number">—</strong>
        )}
      </div>
      <div>
        <span className="label">Keeper reward</span>
        <NumberText value={keeperReward} precision={4} suffix={` ${receiveSymbol}`} />
      </div>
      <div>
        <span className="label">Transaction</span>
        <a className="copy-line" href={`${seltraConfig.explorerBaseUrl}/tx/${fill.txHash}`} target="_blank" rel="noreferrer">
          {fill.txHash.slice(0, 22)}… <ExternalLink size={13} />
        </a>
      </div>
    </section>
  );
}
