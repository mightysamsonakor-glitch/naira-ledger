-- Double-entry ledger schema.
-- Every money movement is a `transaction` made of two or more `entries`
-- whose amounts must sum to zero. Balances are never stored; they are
-- derived from entries, so the books can always be audited.

CREATE TABLE IF NOT EXISTS accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  currency    CHAR(3) NOT NULL DEFAULT 'NGN',
  -- 'user' accounts may never go negative; 'system' accounts
  -- (e.g. the external funding source) are allowed to.
  kind        TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('transfer', 'deposit')),
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  -- Minor units (kobo). Negative = debit, positive = credit.
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account_id);
CREATE INDEX IF NOT EXISTS entries_tx_idx ON entries(transaction_id);

-- Stored responses for Idempotency-Key replay.
-- status_code IS NULL means the first request is still being processed.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The database itself refuses unbalanced books: at COMMIT time,
-- every transaction's entries must sum to exactly zero.
CREATE OR REPLACE FUNCTION assert_balanced() RETURNS trigger AS $$
DECLARE total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total
    FROM entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'unbalanced transaction % (sum=%)', NEW.transaction_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_balanced ON entries;
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_balanced();

-- The ledger is append-only: no edits, no deletes.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_append_only ON entries;
CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- System account that represents money coming in from the payment provider.
INSERT INTO accounts (id, name, kind)
VALUES ('00000000-0000-0000-0000-000000000001', 'Paystack funding source', 'system')
ON CONFLICT (id) DO NOTHING;
