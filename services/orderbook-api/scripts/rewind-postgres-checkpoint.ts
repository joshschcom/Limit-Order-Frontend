import { config } from "../src/config";
import { PostgresOrderStore } from "../src/store";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.MIGRATION_ACK_SERVICE_STOPPED !== "YES") {
  throw new Error("stop seltra-api.service, then set MIGRATION_ACK_SERVICE_STOPPED=YES");
}

const store = await PostgresOrderStore.open(config.databaseUrl, {
  chainId: config.chainId,
  quoteHistoryMax: config.quoteHistoryMax,
});

try {
  const current = store.getCheckpoint();
  const rewindTo = BigInt(config.startBlock) - 1n;
  if (current !== null && current < rewindTo) {
    throw new Error(`checkpoint ${current} is before ${rewindTo}; refusing to advance it with a rewind command`);
  }
  await store.setCheckpoint(rewindTo);
  console.log(`PostgreSQL checkpoint rewound from ${current ?? "unset"} to ${rewindTo}.`);
} finally {
  await store.close();
}
