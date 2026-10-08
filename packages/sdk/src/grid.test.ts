import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import {
  GRID_CANCEL_ALL_WARNING,
  MARTINGALE_MAX_LEVELS,
  GridPlanError,
  buildGridManifest,
  buildGridOrders,
  collectGridSignatures,
  formatScaled,
  parseDecimal,
  estimateGridProfit,
  estimateMartingale,
  planGrid,
  planMartingale,
  requiredGridApprovals,
  submitGridOrders,
  type GridConfig,
  type GridPairMeta,
  type GridSignedOrder,
} from "./grid";

const pair: GridPairMeta = { baseDecimals: 18, quoteDecimals: 6, pricePrecision: 2 };

const maker = "0x1111111111111111111111111111111111111111" as Address;
const baseAsset = "0x2222222222222222222222222222222222222222" as Address;
const quoteAsset = "0x3333333333333333333333333333333333333333" as Address;

function config(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    pairId: "sWAVAX-sUSDC",
    lowerPrice: "30.00",
    upperPrice: "50.00",
    referencePrice: "40.00",
    levels: 5,
    baseBudget: "2",
    quoteBudget: "100",
    expirySeconds: 86_400,
    ...overrides,
  };
}

test("deterministic linear level generation with endpoints", () => {
  const plan = planGrid(config(), pair);
  const again = planGrid(config(), pair);
  assert.deepEqual(plan, again);
  // prices: 30.00 35.00 [40.00 neutral] 45.00 50.00
  assert.deepEqual(
    plan.levels.map((l) => l.price),
    ["30.00", "35.00", "45.00", "50.00"],
  );
  assert.equal(plan.gridId, again.gridId);
  assert.match(plan.gridId, /^0x[0-9a-f]{16}$/);
});

test("amounts are exact integer arithmetic, no floats", () => {
  const plan = planGrid(config(), pair);
  const buy30 = plan.levels.find((l) => l.price === "30.00")!;
  const buy35 = plan.levels.find((l) => l.price === "35.00")!;
  // 100 USDC over 2 buys = 50 USDC each; base out = floor(50e6 * 1e18 * 100 / (price * 1e6))
  assert.equal(buy30.makingAmount, 50_000_000n);
  assert.equal(buy30.takingAmount, 1_666_666_666_666_666_666n);
  assert.equal(buy35.takingAmount, 1_428_571_428_571_428_571n);
  // Values beyond float precision stay exact.
  const big = planGrid(config({ baseBudget: "9007199254740993.000000000000000001", quoteBudget: "9007199254740993.000001" }), pair);
  assert.equal(big.requiredBase, 9_007_199_254_740_993_000_000_000_000_000_001n);
  assert.equal(big.requiredQuote, 9_007_199_254_740_993_000_001n);
});

test("buy and sell orientation around the reference", () => {
  const plan = planGrid(config(), pair);
  for (const level of plan.levels) {
    const price = parseDecimal(level.price, pair.pricePrecision);
    const reference = parseDecimal("40.00", pair.pricePrecision);
    if (level.side === "buy") assert.ok(price < reference);
    else assert.ok(price > reference);
  }
  const sell45 = plan.levels.find((l) => l.price === "45.00")!;
  // 2 base over 2 sells = 1 base each; quote out = floor(1e18 * price * 1e6 / (100 * 1e18))
  assert.equal(sell45.makingAmount, 1_000_000_000_000_000_000n);
  assert.equal(sell45.takingAmount, 45_000_000n);
});

test("aggregate maker amounts equal the configured budgets exactly", () => {
  const plan = planGrid(config({ baseBudget: "1.000000000000000007", quoteBudget: "99.999999" }), pair);
  const sumBase = plan.levels.filter((l) => l.side === "sell").reduce((s, l) => s + l.makingAmount, 0n);
  const sumQuote = plan.levels.filter((l) => l.side === "buy").reduce((s, l) => s + l.makingAmount, 0n);
  assert.equal(sumBase, parseDecimal("1.000000000000000007", 18));
  assert.equal(sumQuote, parseDecimal("99.999999", 6));
  assert.equal(plan.requiredBase, sumBase);
  assert.equal(plan.requiredQuote, sumQuote);
});

test("division remainder goes to the earliest levels of each side", () => {
  // 5 quote units across 2 buys -> 3 then 2; 5 wei base across 2 sells would
  // produce a zero taking amount, so use amounts that stay above zero.
  const plan = planGrid(config({ quoteBudget: "0.000005" }), pair);
  const buys = plan.levels.filter((l) => l.side === "buy");
  assert.deepEqual(buys.map((l) => l.makingAmount), [3n, 2n]);
});

test("duplicate rounded prices are rejected, not deduplicated", () => {
  assert.throws(
    () => planGrid(config({ lowerPrice: "39.98", upperPrice: "40.02", referencePrice: "40.00", levels: 20 }), pair),
    (error: unknown) => error instanceof GridPlanError && error.code === "duplicate-levels",
  );
});

test("levels with a zero-derived amount are rejected, not dropped", () => {
  // 3 wei of base across 2 sells: making 2/1 wei, quote out floors to zero.
  assert.throws(
    () => planGrid(config({ baseBudget: "0.000000000000000003" }), pair),
    (error: unknown) => error instanceof GridPlanError && error.code === "zero-amount-level",
  );
});

test("a level rounding onto the reference becomes neutral and is omitted", () => {
  const plan = planGrid(config(), pair);
  assert.equal(plan.neutralPrice, "40.00");
  assert.equal(plan.levels.length, 4);
  assert.ok(!plan.levels.some((l) => l.price === "40.00"));
  // Without a neutral hit, all levels become orders.
  const offset = planGrid(config({ referencePrice: "40.01" }), pair);
  assert.equal(offset.neutralPrice, undefined);
  assert.equal(offset.levels.length, 5);
});

test("range and side validation", () => {
  assert.throws(() => planGrid(config({ lowerPrice: "0.00" }), pair), /above zero/);
  assert.throws(() => planGrid(config({ lowerPrice: "41.00" }), pair), /below the reference/);
  assert.throws(() => planGrid(config({ upperPrice: "39.00" }), pair), /above the reference/);
  assert.throws(() => planGrid(config({ levels: 3 }), pair), /between 4 and 20/);
  assert.throws(() => planGrid(config({ levels: 21 }), pair), /between 4 and 20/);
  assert.throws(() => planGrid(config({ levels: 4.5 }), pair), /whole number/);
  // Reference below every level -> no buys.
  assert.throws(
    () => planGrid(config({ lowerPrice: "30.00", upperPrice: "50.00", referencePrice: "30.00" }), pair),
    /below the reference/,
  );
  assert.throws(() => planGrid(config({ baseBudget: "0" }), pair), /Base budget/);
  assert.throws(() => planGrid(config({ quoteBudget: "0" }), pair), /Quote budget/);
  assert.throws(() => planGrid(config({ quoteBudget: "1.2345678" }), pair), /decimal places/);
  assert.equal(planGrid(config({ lowerPrice: "30,00" }), pair).levels[0]?.price, "30.00");
});

test("children get unique salts and Permit2 nonces", () => {
  const plan = planGrid(config({ levels: 20, referencePrice: "40.01" }), pair);
  const { built } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 3n });
  assert.equal(built.length, 20);
  assert.equal(new Set(built.map((b) => b.order.salt)).size, built.length);
  assert.equal(new Set(built.map((b) => b.permit.nonce)).size, built.length);
});

test("children share one epoch and one expiry; permits mirror the orders", () => {
  const plan = planGrid(config(), pair);
  const { built, expiryAt } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 7n, nowSeconds: 1_800_000_000 });
  assert.equal(expiryAt, 1_800_000_000n + 86_400n);
  for (const child of built) {
    assert.equal(child.order.epoch, 7n);
    assert.equal(child.order.expiry, expiryAt);
    assert.equal(child.order.flags, 0);
    assert.equal(child.order.allowedSender, "0x0000000000000000000000000000000000000000");
    assert.equal(child.permit.deadline, child.order.expiry);
    assert.equal(child.permit.permitted.token, child.order.makerAsset);
    assert.equal(child.permit.permitted.amount, child.order.makingAmount);
    assert.equal(child.order.makerAsset, child.side === "sell" ? baseAsset : quoteAsset);
    assert.equal(child.order.takerAsset, child.side === "sell" ? quoteAsset : baseAsset);
  }
});

test("a signature rejection discards the whole batch before submission", async () => {
  const plan = planGrid(config(), pair);
  const { built } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 0n });
  let signCalls = 0;
  await assert.rejects(
    collectGridSignatures(built, async () => {
      signCalls += 1;
      if (signCalls === 3) throw new Error("User rejected the request");
      return "0xsig" as Hex;
    }),
    /User rejected/,
  );
  assert.equal(signCalls, 3); // stopped at the rejection, never signed the rest
});

test("stop during signing yields no signed batch", async () => {
  const plan = planGrid(config(), pair);
  const { built } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 0n });
  let signCalls = 0;
  const result = await collectGridSignatures(
    built,
    async () => {
      signCalls += 1;
      return "0xsig" as Hex;
    },
    { shouldStop: () => signCalls >= 2 },
  );
  assert.deepEqual(result, { stopped: true });
  assert.equal(signCalls, 2);
});

function fakeSigned(plan = planGrid(config(), pair)): GridSignedOrder[] {
  const { built } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 0n });
  return built.map((b) => ({ ...b, signature: "0xdeadbeefcafe" as Hex }));
}

test("partial API failure reports every accepted and rejected child", async () => {
  const signed = fakeSigned();
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await submitGridOrders(signed, async (order) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    if (order.order.makingAmount === 50_000_000n) throw new Error("nonce\nalready used");
    return { orderHash: `0x${order.permit.nonce.toString(16)}` as Hex };
  });
  assert.equal(result.accepted.length, 2);
  assert.equal(result.failed.length, 2);
  assert.ok(maxInFlight <= 3);
  // Failure reasons are single display-safe lines.
  for (const failure of result.failed) assert.equal(failure.reason, "nonce");
});

test("approval paths: base-only, quote-only, both, neither", () => {
  const plan = planGrid(config(), pair);
  const enough = { base: plan.requiredBase, quote: plan.requiredQuote };
  assert.deepEqual(requiredGridApprovals(plan, enough), { base: false, quote: false });
  assert.deepEqual(requiredGridApprovals(plan, { ...enough, base: plan.requiredBase - 1n }), { base: true, quote: false });
  assert.deepEqual(requiredGridApprovals(plan, { ...enough, quote: 0n }), { base: false, quote: true });
  assert.deepEqual(requiredGridApprovals(plan, { base: 0n, quote: 0n }), { base: true, quote: true });
});

test("manifest persists hashes and config, never signatures", async () => {
  const plan = planGrid(config(), pair);
  const signed = fakeSigned(plan);
  const result = await submitGridOrders(signed, async (order) => {
    if (order.order.makingAmount === 50_000_000n) throw new Error("rejected");
    return { orderHash: "0xabc123" as Hex };
  });
  const manifest = buildGridManifest({ plan, maker, expiryAt: 1_800_086_400n, result, createdAt: 123 });
  const json = JSON.stringify(manifest);
  assert.ok(!json.toLowerCase().includes("signature"));
  assert.ok(!json.includes("deadbeef"));
  assert.equal(manifest.orderHashes.length, 2);
  assert.equal(manifest.failedLevels.length, 2);
  assert.equal(manifest.expiry, "1800086400");
  assert.equal(manifest.gridId, plan.gridId);
});

test("cancel-entire-grid warning states the epoch-wide effect", () => {
  assert.match(GRID_CANCEL_ALL_WARNING, /incrementEpoch/);
  assert.match(GRID_CANCEL_ALL_WARNING, /every outstanding Seltra order/i);
  assert.match(GRID_CANCEL_ALL_WARNING, /not only this grid/i);
});

test("parseDecimal/formatScaled round-trip", () => {
  assert.equal(parseDecimal("40.00", 2), 4000n);
  assert.equal(parseDecimal("40", 2), 4000n);
  assert.equal(parseDecimal("40.10", 2), 4010n);
  assert.equal(formatScaled(4010n, 2), "40.10");
  assert.equal(formatScaled(5n, 2), "0.05");
  assert.equal(parseDecimal("40,10", 2), 4010n);
  assert.throws(() => parseDecimal("-1", 2), /decimal number/);
  assert.throws(() => parseDecimal("1e5", 2), /decimal number/);
});

test("estimateGridProfit: per-grid gain is the level step over the price", () => {
  // lower 30, upper 50, 11 levels -> step 2; reference 40.
  const e = estimateGridProfit({ lowerPrice: "30", upperPrice: "50", referencePrice: "40", levels: 11 });
  assert.equal(e.stepQuote, 2);
  assert.equal(e.stepPct, 5); // 2/40
  assert.equal(e.profitPctLow, 4); // 2/50, tightest at the top
  assert.ok(Math.abs(e.profitPctHigh - 6.6667) < 0.001); // 2/30, widest at the bottom
});

test("estimateGridProfit: guards against a single level and zero prices", () => {
  const one = estimateGridProfit({ lowerPrice: "30", upperPrice: "50", referencePrice: "40", levels: 1 });
  assert.equal(one.stepQuote, 0);
  assert.equal(one.stepPct, 0);
  const zero = estimateGridProfit({ lowerPrice: "0", upperPrice: "50", referencePrice: "0", levels: 5 });
  assert.equal(zero.stepPct, 0); // reference 0 -> no divide-by-zero blowup
});

// --- Martingale ladder ---------------------------------------------------

function mConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    pairId: "sWAVAX-sUSDC",
    lowerPrice: "30.00",
    upperPrice: "40.00",
    referencePrice: "40.00",
    levels: 4,
    baseBudget: "0",
    quoteBudget: "150",
    expirySeconds: 86_400,
    multiplier: "2",
    ...overrides,
  };
}

test("martingale: buy-only ladder from just under reference to the lower price", () => {
  const plan = planMartingale(mConfig(), pair);
  // span 10.00 over 4 levels: 37.50, 35.00, 32.50, 30.00 (deepest first by index)
  assert.deepEqual(plan.levels.map((l) => l.price), ["30.00", "32.50", "35.00", "37.50"]);
  assert.ok(plan.levels.every((l) => l.side === "buy"));
  assert.equal(plan.requiredBase, 0n);
  assert.equal(plan.config.strategy, "martingale");
  assert.deepEqual(plan, planMartingale(mConfig(), pair));
});

test("martingale: sizes follow the multiplier exactly and sum to the budget", () => {
  const plan = planMartingale(mConfig(), pair);
  // weights 1:2:4:8 over 150 USDC from shallowest to deepest
  assert.deepEqual(plan.levels.map((l) => l.makingAmount), [80_000_000n, 40_000_000n, 20_000_000n, 10_000_000n]);
  assert.equal(plan.requiredQuote, 150_000_000n);
});

test("martingale: remainder units are distributed so the sum is exact", () => {
  const plan = planMartingale(mConfig({ multiplier: "1.37", levels: 7, quoteBudget: "100.000001" }), pair);
  assert.equal(plan.requiredQuote, 100_000_001n);
  const amounts = plan.levels.map((l) => l.makingAmount);
  for (let i = 1; i < amounts.length; i++) assert.ok(amounts[i - 1] >= amounts[i]);
});

test("martingale: validates levels, multiplier, range and budget without clamping", () => {
  const code = (overrides: Partial<GridConfig>) => {
    try {
      planMartingale(mConfig(overrides), pair);
    } catch (cause) {
      return cause instanceof GridPlanError ? cause.code : "other";
    }
    return "ok";
  };
  assert.equal(code({ levels: 1 }), "bad-levels");
  assert.equal(code({ levels: MARTINGALE_MAX_LEVELS + 1 }), "bad-levels");
  assert.equal(code({ multiplier: "1" }), "bad-multiplier");
  assert.equal(code({ multiplier: "10.01" }), "bad-multiplier");
  assert.equal(code({ multiplier: "1.505" }), "too-precise");
  assert.equal(code({ multiplier: undefined }), "bad-number");
  assert.equal(code({ lowerPrice: "40.00" }), "bad-range");
  assert.equal(code({ quoteBudget: "0" }), "bad-budget");
  assert.equal(code({ lowerPrice: "39.98", levels: 4 }), "duplicate-levels");
  assert.equal(code({ quoteBudget: "0.000003", levels: 4, multiplier: "10" }), "zero-amount-level");
  assert.equal(code({ multiplier: "1,5" }), "ok");
  assert.equal(code({ multiplier: "1,234.5" }), "bad-number");
});

test("martingale: children build as ordinary quote-funded buy orders", () => {
  const plan = planMartingale(mConfig(), pair);
  const { built } = buildGridOrders(plan, { maker, baseAsset, quoteAsset, epoch: 0n, nowSeconds: 1_000 });
  assert.equal(built.length, 4);
  for (const item of built) {
    assert.equal(item.order.makerAsset.toLowerCase(), quoteAsset.toLowerCase());
    assert.equal(item.permit.permitted.token.toLowerCase(), quoteAsset.toLowerCase());
  }
  assert.equal(new Set(built.map((b) => b.order.salt)).size, 4);
});

test("martingale: display estimate reports drop, average entry and deepest share", () => {
  const plan = planMartingale(mConfig(), pair);
  const estimate = estimateMartingale(plan, pair);
  assert.equal(estimate.maxDropPct, 25);
  assert.ok(estimate.averageEntry > 30 && estimate.averageEntry < 37.5);
  assert.ok(estimate.breakEvenFromLowPct > 0);
  assert.ok(Math.abs(estimate.deepestSharePct - (80 / 150) * 100) < 1e-9);
});
