"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { BookSnapshot, Candle, ConnectionStatus, ExecutableQuote, OrderRecord, ProtocolStats, QuotePoint, TradePrint } from "@seltra/sdk";
import { seltraApi } from "@/lib/api";

export function useWsStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  useEffect(() => seltraApi.onStatus(setStatus), []);
  return status;
}

export function useOrderbook(pairId: string) {
  const queryClient = useQueryClient();
  const query = useQuery<BookSnapshot>({
    queryKey: ["seltra", "book", pairId],
    queryFn: () => seltraApi.getOrderbook(pairId),
    refetchInterval: 15_000,
    retry: 1,
  });
  useEffect(
    () =>
      seltraApi.subscribeBook(pairId, (msg) => {
        queryClient.setQueryData(["seltra", "book", pairId], msg.book);
        // Fills and cancels rebroadcast the book, so a book push is the signal
        // that the tape, candles, and stats may have moved too.
        if (msg.type === "book.update") {
          void queryClient.invalidateQueries({ queryKey: ["seltra", "trades", pairId] });
          void queryClient.invalidateQueries({ queryKey: ["seltra", "candles", pairId] });
          void queryClient.invalidateQueries({ queryKey: ["seltra", "stats"] });
        }
      }),
    [pairId, queryClient],
  );
  return query;
}

export function useMyOrders() {
  const { address, isConnected } = useAccount();
  const key = ["seltra", "orders", address?.toLowerCase() ?? ""];
  const queryClient = useQueryClient();
  const query = useQuery<OrderRecord[]>({
    queryKey: key,
    queryFn: () => seltraApi.getOrders({ maker: address }),
    enabled: Boolean(address),
    refetchInterval: 20_000,
    retry: 1,
  });
  useEffect(() => {
    if (!address) return;
    return seltraApi.subscribeUser(address, (msg) => {
      queryClient.setQueryData<OrderRecord[]>(["seltra", "orders", address.toLowerCase()], (current) => {
        const rest = (current ?? []).filter((record) => record.orderHash !== msg.order.orderHash);
        return [msg.order, ...rest].sort((a, b) => b.createdAt - a.createdAt);
      });
    });
  }, [address, queryClient]);
  return { ...query, address, isConnected };
}

export function useOrderRecord(orderHash: string) {
  return useQuery<OrderRecord | null>({
    queryKey: ["seltra", "order", orderHash.toLowerCase()],
    queryFn: () => seltraApi.getOrder(orderHash),
    retry: 1,
  });
}

export function useCandles(pairId: string, intervalSeconds: number) {
  return useQuery<Candle[]>({
    queryKey: ["seltra", "candles", pairId, intervalSeconds],
    queryFn: () => seltraApi.getCandles(pairId, intervalSeconds),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useQuote(pairId: string) {
  return useQuery<ExecutableQuote | null>({
    queryKey: ["seltra", "quote", pairId],
    queryFn: () => seltraApi.getQuote(pairId),
    refetchInterval: 10_000,
    retry: 1,
  });
}

export function useTrades(pairId: string) {
  return useQuery<TradePrint[]>({
    queryKey: ["seltra", "trades", pairId],
    queryFn: () => seltraApi.getTrades(pairId),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useQuoteHistory(pairId: string) {
  return useQuery<QuotePoint[]>({
    queryKey: ["seltra", "quote-history", pairId],
    queryFn: () => seltraApi.getQuoteHistory(pairId),
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useStats() {
  return useQuery<ProtocolStats>({
    queryKey: ["seltra", "stats"],
    queryFn: () => seltraApi.getStats(),
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** Book midpoint; falls back to the best single side when the other is empty. */
export function bookMid(book: BookSnapshot | undefined): number | undefined {
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined) return (bestBid + bestAsk) / 2;
  return bestBid ?? bestAsk;
}

/** Total resting notional (quote units) across both sides. */
export function bookDepthQuote(book: BookSnapshot | undefined): number | undefined {
  if (!book || (book.bids.length === 0 && book.asks.length === 0)) return undefined;
  const side = (levels: { price: number; size: number }[]) =>
    levels.reduce((sum, level) => sum + level.price * level.size, 0);
  return side(book.bids) + side(book.asks);
}

/** Shared 30s tick for expiry countdowns. */
export function useNowSeconds(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatCountdown(expirySeconds: number, now: number): { label: string; warn: boolean } {
  const remaining = expirySeconds - now;
  if (remaining <= 0) return { label: "expired", warn: false };
  if (remaining < 3600) return { label: `${Math.max(1, Math.floor(remaining / 60))}m`, warn: true };
  if (remaining < 86_400) return { label: `${Math.floor(remaining / 3600)}h`, warn: false };
  return { label: `${Math.floor(remaining / 86_400)}d`, warn: false };
}
