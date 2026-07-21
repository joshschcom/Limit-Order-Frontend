BEGIN;

CREATE SCHEMA IF NOT EXISTS seltra_orderbook;

CREATE TABLE IF NOT EXISTS seltra_orderbook.orders (
    order_hash TEXT PRIMARY KEY,
    record JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seltra_orderbook.event_log (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS seltra_orderbook.meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seltra_orderbook.quote_history (
    pair_id TEXT NOT NULL,
    observed_at_ms BIGINT NOT NULL CHECK (observed_at_ms >= 0),
    price DOUBLE PRECISION NOT NULL CHECK (price > 0),
    PRIMARY KEY (pair_id, observed_at_ms)
);

CREATE INDEX IF NOT EXISTS quote_history_pair_time
    ON seltra_orderbook.quote_history (pair_id, observed_at_ms DESC);

COMMIT;
