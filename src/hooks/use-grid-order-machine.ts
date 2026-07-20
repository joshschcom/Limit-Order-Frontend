"use client";

import { useRef, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
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
  GridPlanError,
  buildGridManifest,
  buildGridOrders,
  collectGridSignatures,
  maxUint256,
  normalizeGridReason,
  planGrid,
  requiredGridApprovals,
  submitGridOrders,
  typedDataForSigning,
  type GridConfig,
  type GridManifest,
  type GridPlan,
  type GridSignedOrder,
  type GridSubmitResult,
} from "@seltra/sdk";
import { saveGridManifest } from "@/lib/grid-manifests";
import { activeChain } from "@/lib/wallet";
import { useWalletDialog } from "@/components/wallet-button";

// A finite grid is a batch of independent one-shot V1 orders. This machine is
// deliberately separate from the single-order entry machine: the flow has its
// own approval, per-child signing, and partial-failure lifecycle.

export type GridFlowState =
  | { tag: "editing" }
  | { tag: "reviewing" }
  | { tag: "needs-base-approval" }
  | { tag: "approving-base"; hash?: Hex }
  | { tag: "needs-quote-approval" }
  | { tag: "approving-quote"; hash?: Hex }
  | { tag: "ready-to-sign" }
  | { tag: "signing"; current: number; total: number }
  | { tag: "submitting"; current: number; total: number }
  | { tag: "complete"; manifest: GridManifest }
  | { tag: "partial-failure"; manifest: GridManifest }
  | { tag: "rejected"; reason: string };

export const GRID_EXPIRY_OPTIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
] as const;

export interface GridOrderMachine {
  pair: PairConfig;
  base: TokenConfig;
  quote: TokenConfig;

  lowerPrice: string;
  setLowerPrice: (value: string) => void;
  upperPrice: string;
  setUpperPrice: (value: string) => void;
  levels: string;
  setLevels: (value: string) => void;
  baseBudget: string;
  setBaseBudget: (value: string) => void;
  quoteBudget: string;
  setQuoteBudget: (value: string) => void;
  expirySeconds: number;
  setExpirySeconds: (seconds: number) => void;
  setMaxBaseBudget: () => void;
  setMaxQuoteBudget: () => void;

  /** Live executable (or mid) price the ladder is centered on; read-only. */
  referencePrice: string | null;
  plan: GridPlan | null;
  formError: string | null;

  baseBalance: bigint | undefined;
  quoteBalance: bigint | undefined;

  isConnected: boolean;
  wrongNetwork: boolean;
  fillsPaused: boolean;
  configured: boolean;
  busy: boolean;

  state: GridFlowState;
  /** Validate the form and open the review ladder. No wallet prompt. */
  review: () => void;
  /** From review: request the first missing approval or go straight to signing readiness. */
  beginApprovals: () => void;
  approve: () => void;
  signAndSubmit: () => void;
  /** Before submission: discard everything in memory and submit nothing. */
  stop: () => void;
  /** After a partial failure: resubmit only failed levels from the in-memory batch. */
  retryFailed: () => void;
  backToEdit: () => void;
  reset: () => void;
  connect: () => void;
  switchNetwork: () => void;
}

export function useGridOrderMachine(params: { pairId: string; referencePrice?: number }): GridOrderMachine {
  const pair = pairById(params.pairId);
  const base = tokenBySymbol(pair.base);
  const quote = tokenBySymbol(pair.quote);
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChain } = useSwitchChain();
  const openWalletDialog = useWalletDialog();

  const [lowerPrice, setLowerPriceRaw] = useState("");
  const [upperPrice, setUpperPriceRaw] = useState("");
  const [levels, setLevelsRaw] = useState("6");
  const [baseBudget, setBaseBudgetRaw] = useState("");
  const [quoteBudget, setQuoteBudgetRaw] = useState("");
  const [expirySeconds, setExpirySecondsRaw] = useState<number>(604_800);
  const [state, setState] = useState<GridFlowState>({ tag: "editing" });
  const [plan, setPlan] = useState<GridPlan | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const stopRef = useRef(false);
  // Signed children live only here (memory) so a partial API failure can be
  // retried while the page stays open. Never persisted anywhere.
  const signedRef = useRef<GridSignedOrder[]>([]);
  const planRef = useRef<{ plan: GridPlan; expiryAt: bigint } | null>(null);

  const referencePrice =
    params.referencePrice !== undefined && params.referencePrice > 0
      ? params.referencePrice.toFixed(pair.pricePrecision)
      : null;

  const { data: baseBalance } = useReadContract({
    address: base.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: quoteBalance } = useReadContract({
    address: quote.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: baseAllowance, refetch: refetchBaseAllowance } = useReadContract({
    address: base.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, seltraConfig.contracts.permit2] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: quoteAllowance, refetch: refetchQuoteAllowance } = useReadContract({
    address: quote.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, seltraConfig.contracts.permit2] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: fillsPaused } = useReadContract({
    address: seltraConfig.contracts.settlement,
    abi: seltraSettlementAbi,
    functionName: "fillsPaused",
    query: { enabled: isConfiguredAddress(seltraConfig.contracts.settlement), refetchInterval: 15_000 },
  });

  const wrongNetwork = isConnected && chainId !== seltraConfig.chainId;
  const configured = isConfiguredAddress(seltraConfig.contracts.settlement);

  function editField<T>(setter: (value: T) => void) {
    return (value: T) => {
      setFormError(null);
      if (state.tag === "rejected" || state.tag === "reviewing") setState({ tag: "editing" });
      setter(value);
    };
  }

  function currentConfig(): GridConfig | null {
    if (!referencePrice) return null;
    return {
      pairId: pair.id,
      lowerPrice: lowerPrice.trim(),
      upperPrice: upperPrice.trim(),
      referencePrice,
      levels: Number(levels),
      baseBudget: baseBudget.trim() === "" ? "0" : baseBudget.trim(),
      quoteBudget: quoteBudget.trim() === "" ? "0" : quoteBudget.trim(),
      expirySeconds,
    };
  }

  function review() {
    setFormError(null);
    if (!isConnected || !address) {
      openWalletDialog();
      return;
    }
    if (wrongNetwork) {
      switchChain({ chainId: activeChain.id });
      return;
    }
    if (!configured) {
      setFormError("Settlement address is not configured");
      return;
    }
    if (fillsPaused) {
      setFormError("Fills are paused by the guardian. You can still cancel orders, but new grids are blocked.");
      return;
    }
    const config = currentConfig();
    if (!config) {
      setFormError("No live reference price available — a grid needs a live executable or mid price.");
      return;
    }
    let nextPlan: GridPlan;
    try {
      nextPlan = planGrid(config, {
        baseDecimals: base.decimals,
        quoteDecimals: quote.decimals,
        pricePrecision: pair.pricePrecision,
      });
    } catch (cause) {
      setFormError(cause instanceof GridPlanError ? cause.userMessage : normalizeGridReason(cause));
      return;
    }
    if (baseBalance === undefined || quoteBalance === undefined) {
      setFormError("Wallet balances unavailable. Check your RPC connection and try again.");
      return;
    }
    if (nextPlan.requiredBase > baseBalance) {
      setFormError(`Base budget exceeds your ${base.symbol} balance`);
      return;
    }
    if (nextPlan.requiredQuote > quoteBalance) {
      setFormError(`Quote budget exceeds your ${quote.symbol} balance`);
      return;
    }
    setPlan(nextPlan);
    setState({ tag: "reviewing" });
  }

  function advanceApprovals(currentPlan: GridPlan, allowances: { base: bigint; quote: bigint }) {
    const needs = requiredGridApprovals(currentPlan, allowances);
    if (needs.base) setState({ tag: "needs-base-approval" });
    else if (needs.quote) setState({ tag: "needs-quote-approval" });
    else setState({ tag: "ready-to-sign" });
  }

  function beginApprovals() {
    if (!plan) return;
    advanceApprovals(plan, { base: baseAllowance ?? 0n, quote: quoteAllowance ?? 0n });
  }

  async function approveToken(token: TokenConfig, tag: "approving-base" | "approving-quote") {
    if (!plan || !address || !publicClient) return;
    setState({ tag });
    try {
      const hash = await writeContractAsync({
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [seltraConfig.contracts.permit2, maxUint256],
      });
      setState({ tag, hash });
      await publicClient.waitForTransactionReceipt({ hash });
      // Trust only a fresh allowance read before moving on.
      const [freshBase, freshQuote] = await Promise.all([
        publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "allowance", args: [address, seltraConfig.contracts.permit2] }),
        publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "allowance", args: [address, seltraConfig.contracts.permit2] }),
      ]);
      void refetchBaseAllowance();
      void refetchQuoteAllowance();
      advanceApprovals(plan, { base: freshBase, quote: freshQuote });
    } catch (cause) {
      setState({ tag: "rejected", reason: normalizeGridReason(cause) });
    }
  }

  function approve() {
    if (state.tag === "needs-base-approval") void approveToken(base, "approving-base");
    else if (state.tag === "needs-quote-approval") void approveToken(quote, "approving-quote");
  }

  async function runSignAndSubmit() {
    if (!plan || !address || !publicClient) return;
    stopRef.current = false;
    signedRef.current = [];
    const total = plan.levels.length;
    try {
      // Recheck balances, allowances, epoch and pause state immediately before
      // the first signature — the review screen may be stale.
      const [paused, epoch, freshBaseBal, freshQuoteBal, freshBaseAllow, freshQuoteAllow] = await Promise.all([
        publicClient.readContract({ address: seltraConfig.contracts.settlement, abi: seltraSettlementAbi, functionName: "fillsPaused" }),
        publicClient.readContract({ address: seltraConfig.contracts.settlement, abi: seltraSettlementAbi, functionName: "currentEpoch", args: [address] }),
        publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "allowance", args: [address, seltraConfig.contracts.permit2] }),
        publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "allowance", args: [address, seltraConfig.contracts.permit2] }),
      ]);
      if (paused) {
        setState({ tag: "rejected", reason: "Fills are paused by the guardian; grid creation is blocked." });
        return;
      }
      if (freshBaseBal < plan.requiredBase || freshQuoteBal < plan.requiredQuote) {
        setState({ tag: "rejected", reason: "Wallet balance dropped below the grid budgets. Adjust the budgets and review again." });
        return;
      }
      const needs = requiredGridApprovals(plan, { base: freshBaseAllow, quote: freshQuoteAllow });
      if (needs.base || needs.quote) {
        advanceApprovals(plan, { base: freshBaseAllow, quote: freshQuoteAllow });
        return;
      }

      // The epoch is read once here; every child of the batch shares it. If it
      // changes later, stale children simply become unfillable and any retry
      // must rebuild the batch from the form.
      const { built, expiryAt } = buildGridOrders(plan, {
        maker: address as Address,
        baseAsset: base.address,
        quoteAsset: quote.address,
        epoch,
      });
      planRef.current = { plan, expiryAt };

      setState({ tag: "signing", current: 1, total });
      const collected = await collectGridSignatures(
        built,
        (item) =>
          signTypedDataAsync(
            typedDataForSigning({
              chainId: seltraConfig.chainId,
              permit2: seltraConfig.contracts.permit2,
              settlement: seltraConfig.contracts.settlement,
              order: item.order,
              permit: item.permit,
            }),
          ),
        {
          onProgress: (current) => setState({ tag: "signing", current, total }),
          shouldStop: () => stopRef.current,
        },
      );
      if (collected.stopped) {
        // Whole in-memory batch discarded; nothing was submitted.
        setState({ tag: "reviewing" });
        return;
      }

      setState({ tag: "submitting", current: 0, total });
      const result = await submitGridOrders(collected.signed, (signedOrder) => seltraApi.submitOrder(signedOrder), {
        onProgress: (done) => setState({ tag: "submitting", current: done, total }),
      });
      signedRef.current = collected.signed;
      finishSubmission(plan, expiryAt, result);
    } catch (cause) {
      // A rejected signature (or any build failure) discards the entire batch.
      signedRef.current = [];
      setState({ tag: "rejected", reason: normalizeGridReason(cause) });
    }
  }

  function finishSubmission(currentPlan: GridPlan, expiryAt: bigint, result: GridSubmitResult) {
    const manifest = buildGridManifest({ plan: currentPlan, maker: (address as Address) ?? "0x", expiryAt, result });
    saveGridManifest(manifest);
    if (result.failed.length === 0) {
      signedRef.current = [];
      setState({ tag: "complete", manifest });
    } else {
      setState({ tag: "partial-failure", manifest });
    }
  }

  async function runRetryFailed() {
    if (state.tag !== "partial-failure" || !planRef.current) return;
    const { plan: submittedPlan, expiryAt } = planRef.current;
    const failedIndexes = new Set(state.manifest.failedLevels.map((f) => f.index));
    const toRetry = signedRef.current.filter((item) => failedIndexes.has(item.levelIndex));
    if (toRetry.length === 0) return;
    const total = toRetry.length;
    setState({ tag: "submitting", current: 0, total });
    const retryResult = await submitGridOrders(toRetry, (signedOrder) => seltraApi.submitOrder(signedOrder), {
      onProgress: (done) => setState({ tag: "submitting", current: done, total }),
    });
    // Union of previously accepted hashes and the retried acceptances; only
    // still-failing levels remain in failedLevels.
    const manifest: GridManifest = {
      ...state.manifest,
      orderHashes: [...state.manifest.orderHashes, ...retryResult.accepted.map((a) => a.orderHash)],
      failedLevels: retryResult.failed,
    };
    saveGridManifest(manifest);
    if (retryResult.failed.length === 0) {
      signedRef.current = [];
      setState({ tag: "complete", manifest });
    } else {
      setState({ tag: "partial-failure", manifest });
    }
  }

  function stop() {
    stopRef.current = true;
    if (
      state.tag === "reviewing" ||
      state.tag === "needs-base-approval" ||
      state.tag === "needs-quote-approval" ||
      state.tag === "ready-to-sign"
    ) {
      setState({ tag: "editing" });
    }
  }

  function backToEdit() {
    setPlan(null);
    setState({ tag: "editing" });
  }

  function reset() {
    stopRef.current = false;
    signedRef.current = [];
    planRef.current = null;
    setPlan(null);
    setFormError(null);
    setState({ tag: "editing" });
  }

  const busy =
    state.tag === "approving-base" ||
    state.tag === "approving-quote" ||
    state.tag === "signing" ||
    state.tag === "submitting";

  return {
    pair,
    base,
    quote,
    lowerPrice,
    setLowerPrice: editField(setLowerPriceRaw),
    upperPrice,
    setUpperPrice: editField(setUpperPriceRaw),
    levels,
    setLevels: editField(setLevelsRaw),
    baseBudget,
    setBaseBudget: editField(setBaseBudgetRaw),
    quoteBudget,
    setQuoteBudget: editField(setQuoteBudgetRaw),
    expirySeconds,
    setExpirySeconds: editField(setExpirySecondsRaw),
    setMaxBaseBudget: () => {
      if (baseBalance !== undefined) editField(setBaseBudgetRaw)(formatUnits(baseBalance, base.decimals));
    },
    setMaxQuoteBudget: () => {
      if (quoteBalance !== undefined) editField(setQuoteBudgetRaw)(formatUnits(quoteBalance, quote.decimals));
    },
    referencePrice,
    plan,
    formError,
    baseBalance,
    quoteBalance,
    isConnected,
    wrongNetwork,
    fillsPaused: Boolean(fillsPaused),
    configured,
    busy,
    state,
    review,
    beginApprovals,
    approve,
    signAndSubmit: () => void runSignAndSubmit(),
    stop,
    retryFailed: () => void runRetryFailed(),
    backToEdit,
    reset,
    connect: openWalletDialog,
    switchNetwork: () => switchChain({ chainId: activeChain.id }),
  };
}
