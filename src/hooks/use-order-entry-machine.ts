"use client";

import { useEffect, useReducer, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import {
  useAccount,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, seltraSettlementAbi } from "@/lib/abi";
import {
  isConfiguredAddress,
  pairById,
  seltraConfig,
  tokenBySymbol,
  type PairConfig,
  type TokenConfig,
} from "@/config/seltra.config";
import { seltraApi } from "@/lib/api";
import {
  buildAmounts,
  buildOrder,
  maxUint256,
  typedDataForSigning,
  type SignedOrder,
} from "@seltra/sdk";
import { activeChain } from "@/lib/wallet";
import { useWalletDialog } from "@/components/wallet-button";

export type OrderSide = "buy" | "sell";

export type OrderFlowState =
  | { tag: "idle" }
  | { tag: "validating" }
  | { tag: "needs-approval" }
  | { tag: "approving"; hash?: Hex }
  | { tag: "ready" }
  | { tag: "awaiting-signature" }
  | { tag: "submitting" }
  | { tag: "resting"; orderHash: Hex }
  | { tag: "rejected"; reason: string };

type FlowAction =
  | { type: "VALIDATE" }
  | { type: "NEEDS_APPROVAL" }
  | { type: "APPROVING"; hash?: Hex }
  | { type: "READY" }
  | { type: "SIGNING" }
  | { type: "SUBMITTING" }
  | { type: "RESTING"; orderHash: Hex }
  | { type: "REJECTED"; reason: string }
  | { type: "RESET" };

function flowReducer(_state: OrderFlowState, action: FlowAction): OrderFlowState {
  switch (action.type) {
    case "VALIDATE":
      return { tag: "validating" };
    case "NEEDS_APPROVAL":
      return { tag: "needs-approval" };
    case "APPROVING":
      return { tag: "approving", hash: action.hash };
    case "READY":
      return { tag: "ready" };
    case "SIGNING":
      return { tag: "awaiting-signature" };
    case "SUBMITTING":
      return { tag: "submitting" };
    case "RESTING":
      return { tag: "resting", orderHash: action.orderHash };
    case "REJECTED":
      return { tag: "rejected", reason: action.reason };
    case "RESET":
      return { tag: "idle" };
  }
}

export interface OrderEntryValues {
  side: OrderSide;
  amount: string;
  price: string;
  expirySeconds: number;
}

export type OrderKind = "limit" | "market";

/** Market orders sign a marketable limit with a short expiry so they never linger. */
const MARKET_EXPIRY_SECONDS = 600;

export interface OrderEntryMachine {
  pair: PairConfig;
  base: TokenConfig;
  quote: TokenConfig;
  makerAsset: TokenConfig;
  takerAsset: TokenConfig;

  kind: OrderKind;
  setKind: (kind: OrderKind) => void;
  slippageBps: number;
  setSlippageBps: (bps: number) => void;
  /** The live executable quote (from the terminal); market pricing anchor. */
  referencePrice?: number;
  /** The price the order will actually sign at: user limit, or quote ± slippage. */
  effectivePrice: string;

  side: OrderSide;
  setSide: (side: OrderSide) => void;
  amount: string;
  setAmount: (amount: string) => void;
  price: string;
  setPrice: (price: string) => void;
  expirySeconds: number;
  setExpirySeconds: (seconds: number) => void;
  setAmountPercent: (percent: bigint) => void;
  setMaxAmount: () => void;
  values: OrderEntryValues;

  makingAmount: bigint;
  takingAmount: bigint;

  balance: bigint | undefined;
  balanceKnown: boolean;
  insufficientBalance: boolean;
  needsApproval: boolean;

  isConnected: boolean;
  wrongNetwork: boolean;
  fillsPaused: boolean;

  state: OrderFlowState;
  busy: boolean;
  ctaLabel: string;
  ctaDisabled: boolean;
  approvalPending: boolean;
  primaryAction: () => void;
  reset: () => void;
}

export function useOrderEntryMachine(params: {
  pairId: string;
  initial?: Partial<OrderEntryValues>;
  /** Live executable quote price; enables market (marketable-limit) orders. */
  referencePrice?: number;
}): OrderEntryMachine {
  const pair = pairById(params.pairId);
  const base = tokenBySymbol(pair.base);
  const quote = tokenBySymbol(pair.quote);
  const { address, isConnected, chainId } = useAccount();
  const [kind, setKind] = useState<OrderKind>("limit");
  const [slippageBps, setSlippageBps] = useState(50);
  const [side, setSide] = useState<OrderSide>(params.initial?.side ?? "sell");
  const [amount, setAmount] = useState(params.initial?.amount ?? "");
  const [price, setPrice] = useState(params.initial?.price ?? "");
  const [expirySeconds, setExpirySeconds] = useState(params.initial?.expirySeconds ?? 86_400);
  const [state, dispatch] = useReducer(flowReducer, { tag: "idle" });

  const makerAsset = side === "sell" ? base : quote;
  const takerAsset = side === "sell" ? quote : base;

  // Market = marketable limit: quote minus the slippage bound for sells,
  // plus it for buys. The signed order can never fill worse than this.
  const effectivePrice =
    kind === "market"
      ? params.referencePrice !== undefined
        ? (params.referencePrice * (side === "sell" ? 1 - slippageBps / 10_000 : 1 + slippageBps / 10_000)).toFixed(pair.pricePrecision)
        : ""
      : price;
  const orderExpirySeconds = kind === "market" ? MARKET_EXPIRY_SECONDS : expirySeconds;

  const { makingAmount, takingAmount } = buildAmounts(side, amount, effectivePrice, base.decimals, quote.decimals);

  const { data: balance } = useReadContract({
    address: makerAsset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: makerAsset.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, seltraConfig.contracts.permit2] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: epoch } = useReadContract({
    address: seltraConfig.contracts.settlement,
    abi: seltraSettlementAbi,
    functionName: "currentEpoch",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) && isConfiguredAddress(seltraConfig.contracts.settlement) },
  });
  const { data: fillsPaused } = useReadContract({
    address: seltraConfig.contracts.settlement,
    abi: seltraSettlementAbi,
    functionName: "fillsPaused",
    query: { enabled: isConfiguredAddress(seltraConfig.contracts.settlement), refetchInterval: 15_000 },
  });
  const { writeContractAsync, data: approveHash } = useWriteContract();
  const { isLoading: approvalPending, isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approveHash });
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChain } = useSwitchChain();
  const openWalletDialog = useWalletDialog();

  const balanceKnown = balance !== undefined;
  const hasBalance = balanceKnown && balance >= makingAmount;
  const insufficientBalance = balanceKnown && balance < makingAmount;
  const hasAllowance = allowance !== undefined && allowance >= makingAmount;
  const needsApproval = isConnected && !hasAllowance;
  const wrongNetwork = isConnected && chainId !== seltraConfig.chainId;
  const canWrite = isConnected && Boolean(address) && !wrongNetwork;

  // Advance past `approving` only once the approval tx is mined and the
  // allowance re-read confirms it, so a click on "Place" can't race a stale allowance.
  useEffect(() => {
    if (!approvalConfirmed || state.tag !== "approving") return;
    void refetchAllowance().then(() => dispatch({ type: "READY" }));
  }, [approvalConfirmed, state.tag, refetchAllowance]);

  // A rejection belongs to the inputs it was raised for; editing them clears it.
  function clearRejection() {
    if (state.tag === "rejected") dispatch({ type: "RESET" });
  }

  function updateSide(next: OrderSide) {
    clearRejection();
    setSide(next);
  }

  function updateKind(next: OrderKind) {
    clearRejection();
    setKind(next);
  }

  function updateSlippage(next: number) {
    clearRejection();
    setSlippageBps(next);
  }

  function updateAmount(next: string) {
    clearRejection();
    setAmount(next);
  }

  function updatePrice(next: string) {
    clearRejection();
    setPrice(next);
  }

  function updateExpiry(next: number) {
    clearRejection();
    setExpirySeconds(next);
  }

  function setAmountPercent(percent: bigint) {
    if (!balance) return;
    updateAmount(formatUnits((balance * percent) / 100n, makerAsset.decimals));
  }

  function setMaxAmount() {
    if (!balance) return;
    updateAmount(formatUnits(balance, makerAsset.decimals));
  }

  async function approvePermit2() {
    if (!address) return;
    dispatch({ type: "APPROVING" });
    try {
      const hash = await writeContractAsync({
        address: makerAsset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [seltraConfig.contracts.permit2, maxUint256],
      });
      dispatch({ type: "APPROVING", hash });
    } catch (error) {
      dispatch({ type: "REJECTED", reason: error instanceof Error ? error.message : "Approval rejected" });
    }
  }

  async function placeOrder() {
    dispatch({ type: "VALIDATE" });
    if (!canWrite || !address) return;
    if (fillsPaused) {
      dispatch({ type: "REJECTED", reason: "Fills are paused by the guardian. You can still cancel orders." });
      return;
    }
    if (kind === "market" && params.referencePrice === undefined) {
      dispatch({ type: "REJECTED", reason: "No executable quote available for a market order right now" });
      return;
    }
    if (makingAmount <= 0n || takingAmount <= 0n) {
      dispatch({ type: "REJECTED", reason: "Amount and limit price must be above zero" });
      return;
    }
    if (!balanceKnown) {
      dispatch({ type: "REJECTED", reason: `${makerAsset.symbol} balance unavailable. Check your RPC connection and try again` });
      return;
    }
    if (!hasBalance) {
      dispatch({ type: "REJECTED", reason: `Insufficient ${makerAsset.symbol} balance` });
      return;
    }
    if (!hasAllowance) {
      dispatch({ type: "NEEDS_APPROVAL" });
      return;
    }
    if (!isConfiguredAddress(seltraConfig.contracts.settlement)) {
      dispatch({ type: "REJECTED", reason: "Settlement address is not configured" });
      return;
    }
    try {
      const { order, permit } = buildOrder({
        maker: address as Address,
        makerAsset: makerAsset.address,
        takerAsset: takerAsset.address,
        makingAmount,
        takingAmount,
        epoch: epoch ?? 0n,
        expirySeconds: orderExpirySeconds,
      });
      const typedData = typedDataForSigning({
        chainId: seltraConfig.chainId,
        permit2: seltraConfig.contracts.permit2,
        settlement: seltraConfig.contracts.settlement,
        order,
        permit,
      });
      dispatch({ type: "SIGNING" });
      const signature = await signTypedDataAsync(typedData);
      const signed: SignedOrder = { order, permit, signature };
      dispatch({ type: "SUBMITTING" });
      const result = await seltraApi.submitOrder(signed);
      dispatch({ type: "RESTING", orderHash: result.orderHash });
      setAmount("");
    } catch (error) {
      dispatch({ type: "REJECTED", reason: error instanceof Error ? error.message : "Order rejected" });
    }
  }

  function primaryAction() {
    if (!isConnected) {
      openWalletDialog();
      return;
    }
    if (wrongNetwork) {
      switchChain({ chainId: activeChain.id });
      return;
    }
    if (state.tag === "needs-approval") {
      void approvePermit2();
      return;
    }
    void placeOrder();
  }

  const busy =
    state.tag === "validating" ||
    state.tag === "approving" ||
    state.tag === "awaiting-signature" ||
    state.tag === "submitting" ||
    approvalPending;

  const ctaLabel = !isConnected
    ? "Connect wallet"
    : wrongNetwork
      ? "Switch to Avalanche"
      : fillsPaused
        ? "Fills are paused"
        : state.tag === "validating"
        ? "Checking order"
        : state.tag === "approving" || approvalPending
          ? `Approving ${makerAsset.symbol}`
          : state.tag === "needs-approval"
            ? `Approve ${makerAsset.symbol}`
            : state.tag === "awaiting-signature"
              ? "Awaiting signature"
              : state.tag === "submitting"
                ? "Submitting order"
                : `Place ${side} order`;

  const ctaDisabled =
    state.tag === "awaiting-signature" ||
    state.tag === "submitting" ||
    approvalPending ||
    // Paused fills block placement (with the reason as the CTA label); connect
    // and network-switch actions stay available, and cancels are never gated.
    Boolean(fillsPaused && isConnected && !wrongNetwork);

  return {
    pair,
    base,
    quote,
    makerAsset,
    takerAsset,
    kind,
    setKind: updateKind,
    slippageBps,
    setSlippageBps: updateSlippage,
    referencePrice: params.referencePrice,
    effectivePrice,
    side,
    setSide: updateSide,
    amount,
    setAmount: updateAmount,
    price,
    setPrice: updatePrice,
    expirySeconds,
    setExpirySeconds: updateExpiry,
    setAmountPercent,
    setMaxAmount,
    values: { side, amount, price, expirySeconds },
    makingAmount,
    takingAmount,
    balance,
    balanceKnown,
    insufficientBalance,
    needsApproval,
    isConnected,
    wrongNetwork,
    fillsPaused: Boolean(fillsPaused),
    state,
    busy,
    ctaLabel,
    ctaDisabled,
    approvalPending,
    primaryAction,
    reset: () => dispatch({ type: "RESET" }),
  };
}
