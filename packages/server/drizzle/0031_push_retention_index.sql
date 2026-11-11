-- Orphaned pending receipts also expire. The earlier partial index excluded
-- exactly those rows, so it could not support the shared retention query.
DROP INDEX push_deliveries_retention_idx;
CREATE INDEX push_deliveries_retention_idx ON push_deliveries(expires_at, id);
