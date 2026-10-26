-- Additive merchant-only sandbox commerce schema. The original imported catalog remains
-- disabled and immutable as commerce inventory is owned by the website in this ledger.
CREATE TABLE merchant_commerce_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version=1), checksum text NOT NULL,
 application_id text NOT NULL CHECK(application_id LIKE 'sandbox-sq0idb-%'),
 enabled boolean NOT NULL DEFAULT false,
 quote_window timestamptz NOT NULL DEFAULT now(), quote_count integer NOT NULL DEFAULT 0 CHECK(quote_count>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE merchant_commerce_inventory (
 variant_id text PRIMARY KEY REFERENCES catalog_variants(id),
 stock_quantity integer NOT NULL CHECK(stock_quantity BETWEEN 0 AND 1000000),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE merchant_commerce_quotes (
 id uuid PRIMARY KEY, pricing jsonb NOT NULL, cart jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE merchant_commerce_attempts (
 id uuid PRIMARY KEY REFERENCES merchant_commerce_quotes(id), pickup jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('reserved','order_sending','order_ready','payment_sending','pending','completed','failed','review')),
 order_id text UNIQUE, order_evidence jsonb, payment_id text UNIQUE, payment_evidence jsonb,
 failure_code text, refunded_minor integer NOT NULL DEFAULT 0 CHECK(refunded_minor>=0),
 fulfillment_state text NOT NULL DEFAULT 'unfulfilled' CHECK(fulfillment_state IN('unfulfilled','ready','picked_up')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((order_id IS NULL)=(order_evidence IS NULL)),
 CHECK((payment_id IS NULL)=(payment_evidence IS NULL)),
 CHECK(state NOT IN('order_ready','payment_sending','pending','completed') OR order_id IS NOT NULL),
 CHECK(state NOT IN('pending','completed') OR payment_id IS NOT NULL)
);
CREATE TABLE merchant_commerce_reservations (
 attempt_id uuid NOT NULL REFERENCES merchant_commerce_attempts(id),
 variant_id text NOT NULL REFERENCES merchant_commerce_inventory(variant_id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 state text NOT NULL CHECK(state IN('held','committed','released')),
 PRIMARY KEY(attempt_id,variant_id)
);
CREATE TABLE merchant_commerce_refund_requests (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES merchant_commerce_attempts(id),
 amount_minor integer NOT NULL CHECK(amount_minor>0),
 state text NOT NULL CHECK(state IN('reserved','sending','pending','completed','failed','review')),
 refund_id text UNIQUE, evidence jsonb, requested_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
