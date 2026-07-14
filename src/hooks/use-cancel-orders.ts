"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { nonceToWordAndMask, type OrderRecord } from "@seltra/sdk";
import { permit2Abi, seltraSettlementAbi } from "@/lib/abi";
import { isConfiguredAddress, seltraConfig } from "@/config/seltra.config";
import { seltraApi } from "@/lib/api";
import { activeChain } from "@/lib/wallet";

export type CancelPhase = "wallet" | "mining";
/** Key for cancel-all in the pending map (order hashes are 0x-prefixed, so no collision). */
export const CANCEL_ALL = "all";

/**
 * On-chain cancellation. Single: Permit2 invalidateUnorderedNonces(wordPos, mask).
 * All: SeltraSettlement.incrementEpoch(). Both stay available while fills are
 * paused — they never touch the fill path. Status flips come back through the
 * indexer (reconcile poke for singles, EpochIncremented event for cancel-all).
 */
export function useCancelOrders() {
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, CancelPhase>>({});
  const [error, setError] = useState<string | null>(null);

  const wrongNetwork = isConnected && chainId !== seltraConfig.chainId;
  const canCancel = isConnected && !wrongNetwork;

  function ensureReady(): boolean {
    setError(null);
    if (!isConnected) {
      setError("Connect a wallet to cancel orders");
      return false;
    }
    if (wrongNetwork) {
      switchChain({ chainId: activeChain.id });
      return false;
    }
    return true;
  }

  async function refreshOrders() {
    await queryClient.invalidateQueries({ queryKey: ["seltra", "orders", address?.toLowerCase() ?? ""] });
  }

  async function cancelOrder(record: OrderRecord) {
    if (!ensureReady()) return;
    const key = record.orderHash;
    setPending((current) => ({ ...current, [key]: "wallet" }));
    try {
      const { wordPos, mask } = nonceToWordAndMask(BigInt(record.permit.nonce));
      const txHash = await writeContractAsync({
        address: seltraConfig.contracts.permit2,
        abi: permit2Abi,
        functionName: "invalidateUnorderedNonces",
        args: [wordPos, mask],
      });
      setPending((current) => ({ ...current, [key]: "mining" }));
      await publicClient?.waitForTransactionReceipt({ hash: txHash });
      // Nonce invalidation emits no settlement event; poke the API to re-check now.
      await seltraApi.reconcile(record.orderHash).catch(() => undefined);
      await refreshOrders();
    } catch (cause) {
      setError(cause instanceof Error ? shortReason(cause.message) : "Cancel rejected");
    } finally {
      setPending((current) => {
        const { [key]: _, ...rest } = current;
        return rest;
      });
    }
  }

  async function cancelAll() {
    if (!ensureReady()) return;
    if (!isConfiguredAddress(seltraConfig.contracts.settlement)) {
      setError("Settlement address is not configured");
      return;
    }
    setPending((current) => ({ ...current, [CANCEL_ALL]: "wallet" }));
    try {
      const txHash = await writeContractAsync({
        address: seltraConfig.contracts.settlement,
        abi: seltraSettlementAbi,
        functionName: "incrementEpoch",
      });
      setPending((current) => ({ ...current, [CANCEL_ALL]: "mining" }));
      await publicClient?.waitForTransactionReceipt({ hash: txHash });
      // The indexer picks up EpochIncremented within one poll (~4s); refresh then too.
      await refreshOrders();
      setTimeout(() => void refreshOrders(), 6_000);
    } catch (cause) {
      setError(cause instanceof Error ? shortReason(cause.message) : "Cancel rejected");
    } finally {
      setPending((current) => {
        const { [CANCEL_ALL]: _, ...rest } = current;
        return rest;
      });
    }
  }

  return { cancelOrder, cancelAll, pending, error, clearError: () => setError(null), canCancel, isConnected, wrongNetwork };
}

function shortReason(message: string): string {
  const firstLine = message.split("\n")[0];
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}
