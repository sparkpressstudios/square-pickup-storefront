CREATE TABLE catalog_products (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  options jsonb NOT NULL
);
CREATE TABLE catalog_variants (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  sku text NOT NULL UNIQUE,
  selections jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  stock_quantity integer NOT NULL CHECK (stock_quantity >= 0),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, selections)
);
CREATE TABLE demo_database_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  session_id uuid NOT NULL UNIQUE,
  dataset text NOT NULL CHECK (dataset = 'synthetic-retail-v1')
);
CREATE TABLE checkout_attempts (
  attempt_id uuid PRIMARY KEY,
  checkout_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES demo_database_state(session_id),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  quote jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'simulated', 'declined', 'uncertain')),
  mock_payment_key text NOT NULL UNIQUE,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'simulated' AND receipt IS NOT NULL) OR (state <> 'simulated' AND receipt IS NULL))
);
CREATE TABLE inventory_reservations (
  attempt_id uuid NOT NULL REFERENCES checkout_attempts(attempt_id),
  variant_id text NOT NULL REFERENCES catalog_variants(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  state text NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
  PRIMARY KEY (attempt_id, variant_id)
);
CREATE TABLE mock_payment_ledger (
  idempotency_key text PRIMARY KEY,
  checkout_id uuid NOT NULL UNIQUE REFERENCES checkout_attempts(checkout_id),
  payment_id text NOT NULL UNIQUE CHECK (payment_id LIKE 'mock_%'),
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now()
);
