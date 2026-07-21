import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { PairConfig } from "@seltra/sdk";
import { PERMIT2_ADDRESS, MAX_EXPIRY_SECONDS } from "@seltra/sdk";

const zeroAddress = "0x0000000000000000000000000000000000000000" as Address;

// Minimal .env loader (no dotenv dep): KEY=VALUE lines, # comments, real env wins.
// ENV_FILE lets unprivileged maintenance commands load the same protected file
// that systemd injects into the service process.
try {
  const envFile = process.env.ENV_FILE?.trim() || fileURLToPath(new URL("../.env", import.meta.url));
  const raw = readFileSync(envFile, "utf8");
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
      const value = match[2];
      process.env[match[1]] =
        (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value;
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
const chainId = Number(env("CHAIN_ID", "43113"));
const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
if (chainId === 43_114 && !databaseUrl) {
  throw new Error("Avalanche mainnet requires DATABASE_URL; SQLite is staging-only");
}
if (chainId === 43_114 && databaseUrl) {
  const database = new URL(databaseUrl);
  if (database.searchParams.get("sslmode") !== "verify-full" || !database.searchParams.get("sslrootcert")) {
    throw new Error("Avalanche mainnet DATABASE_URL requires sslmode=verify-full and sslrootcert");
  }
}
const pairs: PairConfig[] = [
  {
    id: `${baseSymbol}-${quoteSymbol}`,
    baseAsset: env("BASE_TOKEN", "0x760D9a5B4ae94f5e6c3ce014e3C116544515C830") as Address,
    quoteAsset: env("QUOTE_TOKEN", "0x00B766567013BbCe12bF802f6E7C65F6da581Efe") as Address,
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
  chainId,
  databaseUrl,
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
  startBlock: Number(env("START_BLOCK", "57057712")),
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
