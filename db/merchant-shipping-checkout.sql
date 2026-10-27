-- DEVELOPMENT ONLY: no startup/setup migration hooks. No real orders, stock or payments.
CREATE TABLE merchant_shipping_checkout_previews (
 request_id uuid PRIMARY KEY,
 merchant_id text NOT NULL, location_id text NOT NULL, cart_id text NOT NULL,
 input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('quoting','quoted','preview_prepared','failed')),
 quote_id uuid UNIQUE, quote jsonb,
 preparation jsonb, failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state IN('quoted','preview_prepared') AND quote_id IS NOT NULL AND quote IS NOT NULL AND quote ? 'paymentExecutionEnabled' AND quote->>'paymentExecutionEnabled'='false') OR state IN('quoting','failed'))
);
