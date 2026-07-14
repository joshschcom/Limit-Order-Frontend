import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { PairConfig } from "@seltra/sdk";
import { PERMIT2_ADDRESS, MAX_EXPIRY_SECONDS } from "@seltra/sdk";

const zeroAddress = "0x0000000000000000000000000000000000000000" as Address;

// Minimal .env loader (no dotenv dep): KEY=VALUE lines, # comments, real env wins.
try {
  const raw = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // No .env file: env vars or defaults apply.
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value !== "" ? value : fallback;
}

// Pair registry: the service is the authority on which pairs are accepted.
// Defaults are the deployed Fuji demo pair (open-mint sWAVAX/sUSDC), the only
// pair the deployed settlement allowlists. Mainnet pairs enter here only after
// adapter/liquidity validation (readiness plan §6).
const baseSymbol = env("BASE_SYMBOL", "sWAVAX");
const quoteSymbol = env("QUOTE_SYMBOL", "sUSDC");
const pairs: PairConfig[] = [
  {
    id: `${baseSymbol}-${quoteSymbol}`,
    baseAsset: env("BASE_TOKEN", "0x146a4Dc8aF9dEaa49030F4b47F5918113833b683") as Address,
    quoteAsset: env("QUOTE_TOKEN", "0xD3a5aaC492e43B160a41Fc766cf1A5000F560800") as Address,
    baseSymbol,
    quoteSymbol,
    baseDecimals: Number(env("BASE_DECIMALS", "18")),
    quoteDecimals: Number(env("QUOTE_DECIMALS", "6")),
    pricePrecision: 2,
    amountPrecision: 4,
  },
];

export const config = {
  port: Number(env("PORT", "8080")),
  chainId: Number(env("CHAIN_ID", "43113")),
  permit2: env("PERMIT2", PERMIT2_ADDRESS) as Address,
  settlement: env("SETTLEMENT", zeroAddress) as Address,
  router: env("ROUTER", zeroAddress) as Address,
  /** "adapterId:Name" comma-separated. Fuji demo deploy registered the mock adapter as 0. */
  venuesRaw: env("VENUES", "0:Demo DEX"),
  quotePollMs: Number(env("QUOTE_POLL_MS", "10000")),
  quoteHistoryFile: env("QUOTE_HISTORY_FILE", fileURLToPath(new URL("../data/quotes.json", import.meta.url))),
  quoteHistoryMax: Number(env("QUOTE_HISTORY_MAX", "20000")),
  rpcUrl: env("RPC_URL", "https://api.avax-test.network/ext/bc/C/rpc"),
  /** First block to scan when no checkpoint exists (settlement deploy era). */
  startBlock: Number(env("START_BLOCK", "56800000")),
  pollMs: Number(env("POLL_MS", "4000")),
  logChunk: Number(env("LOG_CHUNK", "2000")),
  maxExpirySeconds: Number(env("MAX_EXPIRY_SECONDS", String(MAX_EXPIRY_SECONDS))),
  /** Only index events at least this many blocks behind head. Avalanche finality makes deeper reorgs practically impossible. */
  confirmations: Number(env("CONFIRMATIONS", "2")),
  dbFile: env("DB_FILE", fileURLToPath(new URL("../data/seltra.db", import.meta.url))),
  // Legacy file-store paths, imported into SQLite once on first boot.
  dataFile: env("DATA_FILE", fileURLToPath(new URL("../data/orders.json", import.meta.url))),
  checkpointFile: env("CHECKPOINT_FILE", fileURLToPath(new URL("../data/checkpoint.json", import.meta.url))),
  heartbeatMs: 15_000,
  expirySweepMs: 15_000,
  /** Browser origin allowed by CORS. "*" for dev; set to the app origin in production. */
  corsOrigin: env("CORS_ORIGIN", "*"),
  /** Per-IP rate limits (sliding 60s window). Order submission is the abuse surface. */
  submitPerMinute: Number(env("RATE_SUBMIT_PER_MIN", "20")),
  requestsPerMinute: Number(env("RATE_REQUESTS_PER_MIN", "600")),
  pairs,
};

export function pairById(id: string): PairConfig | undefined {
  return config.pairs.find((pair) => pair.id === id);
}
