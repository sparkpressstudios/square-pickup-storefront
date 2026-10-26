CREATE TABLE sandbox_payment_projections (
  payment_id text PRIMARY KEY CHECK (left(payment_id, 5) <> 'mock_'),
  checkout_id uuid NOT NULL UNIQUE,
  merchant_id text NOT NULL,
  location_id text NOT NULL,
  order_id text,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  payment_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (payment_status IN ('UNKNOWN','PENDING','APPROVED','COMPLETED','CANCELED','FAILED')),
  updated_at timestamptz
);
CREATE TABLE sandbox_refund_projections (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES sandbox_payment_projections(payment_id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  status text NOT NULL CHECK (status IN ('PENDING','COMPLETED','REJECTED','FAILED')),
  updated_at timestamptz NOT NULL
);
CREATE TABLE sandbox_webhook_events (
  event_id text PRIMARY KEY,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  event_type text NOT NULL,
  resource_id text NOT NULL,
  payment_id text NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pending','applied','ignored')),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_pending_payment_events ON sandbox_webhook_events(payment_id) WHERE outcome = 'pending';
