import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/config";
import { compareSnapshots, PostgresOrderStore, SqliteOrderStore, type StoreSnapshot } from "../src/store";

const verifyOnly = process.argv.includes("--verify-only");
const databaseUrl = config.databaseUrl;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!verifyOnly && process.env.MIGRATION_ACK_SERVICE_STOPPED !== "YES") {
  throw new Error("stop seltra-api.service, then set MIGRATION_ACK_SERVICE_STOPPED=YES");
}

let source: SqliteOrderStore | undefined;
let target: PostgresOrderStore | undefined;

try {
  if (!verifyOnly) {
    const sqlite = new DatabaseSync(config.dbFile);
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backup = `${config.dbFile}.pre-postgres-${stamp}.bak`;
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(config.dbFile, backup);
    console.log(`SQLite backup: ${backup}`);

    const schema = readFileSync(fileURLToPath(new URL("../schema.postgres.sql", import.meta.url)), "utf8");
    const bootstrap = new pg.Pool({ connectionString: databaseUrl });
    try {
      await bootstrap.query(schema);
    } finally {
      await bootstrap.end();
    }
  }

  const options = { chainId: config.chainId, quoteHistoryMax: config.quoteHistoryMax };
  source = await SqliteOrderStore.open(config.dbFile, options, {
    ordersJson: config.dataFile,
    checkpointJson: config.checkpointFile,
    quoteHistoryJson: config.quoteHistoryFile,
  });
  target = await PostgresOrderStore.open(databaseUrl, options);

  if (!verifyOnly) await target.importSnapshot(source.snapshot());

  const sourceSnapshot = source.snapshot();
  const targetSnapshot = target.snapshot();
  const errors = compareSnapshots(sourceSnapshot, targetSnapshot);
  console.log(
    JSON.stringify(
      {
        source: summarize(sourceSnapshot),
        target: summarize(targetSnapshot),
        verified: errors.length === 0,
      },
      null,
      2,
    ),
  );
  if (errors.length > 0) throw new Error(`migration verification failed:\n- ${errors.join("\n- ")}`);
  console.log(verifyOnly ? "PostgreSQL verification passed." : "SQLite to PostgreSQL migration passed.");
} finally {
  await source?.close();
  await target?.close();
}

function summarize(snapshot: StoreSnapshot) {
  return {
    orders: snapshot.orders.length,
    events: snapshot.events.length,
    meta: snapshot.meta,
    quotes: snapshot.quotes.length,
  };
}
