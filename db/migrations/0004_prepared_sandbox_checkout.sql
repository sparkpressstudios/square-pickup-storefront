CREATE TABLE sandbox_checkout_attempts (
  attempt_id uuid PRIMARY KEY,
  checkout_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES demo_database_state(session_id),
  fingerprint text NOT NULL CHECK (length(fingerprint)=64),
  execution_mode text NOT NULL DEFAULT 'mocked-sandbox-protocol' CHECK (execution_mode='mocked-sandbox-protocol'),
  application_id text NOT NULL CHECK (application_id LIKE 'sandbox-sq0idb-%'),
  location_id text NOT NULL,
  request jsonb NOT NULL,
  catalog_snapshot jsonb NOT NULL,
  quote jsonb NOT NULL,
  order_key text NOT NULL UNIQUE CHECK (order_key='ord_' || checkout_id::text),
  payment_key text NOT NULL UNIQUE CHECK (payment_key='pay_' || checkout_id::text),
  state text NOT NULL CHECK (state IN ('reserved','order_sending','order_ready','payment_sending','pending','completed','failed','review')),
  order_id text UNIQUE,
  order_evidence jsonb,
  payment_id text UNIQUE,
  payment_evidence jsonb,
  failure_code text CHECK (failure_code IN ('CANCELED_BEFORE_DISPATCH','ORDER_REJECTED','PAYMENT_DECLINED','ORDER_OUTCOME_UNKNOWN','PAYMENT_OUTCOME_UNKNOWN')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((order_id IS NULL)=(order_evidence IS NULL)),
  CHECK ((payment_id IS NULL)=(payment_evidence IS NULL)),
  CHECK (state NOT IN ('order_ready','payment_sending','pending','completed') OR order_id IS NOT NULL),
  CHECK (state NOT IN ('pending','completed') OR payment_id IS NOT NULL),
  CHECK (order_id IS NULL OR left(order_id,5)<>'mock_'),
  CHECK (payment_id IS NULL OR left(payment_id,5)<>'mock_')
);
CREATE TABLE sandbox_checkout_reservations (
  attempt_id uuid NOT NULL REFERENCES sandbox_checkout_attempts(attempt_id),
  variant_id text NOT NULL REFERENCES catalog_variants(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  state text NOT NULL CHECK (state IN ('held','committed','released')),
  PRIMARY KEY(attempt_id,variant_id)
);
