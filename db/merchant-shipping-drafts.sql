-- DEVELOPMENT-ONLY shipping draft persistence contract; not included in startup/setup migrations.
-- Never apply to an existing merchant automatically. No payable order is represented here.
CREATE TABLE merchant_shipping_drafts (
 id uuid PRIMARY KEY,
 merchant_id text NOT NULL,
 location_id text NOT NULL,
 cart_fingerprint text NOT NULL CHECK(cart_fingerprint ~ '^[a-f0-9]{64}$'),
 draft_fingerprint text NOT NULL CHECK(draft_fingerprint ~ '^[a-f0-9]{64}$'),
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object' AND draft ?& ARRAY['kind','taxStatus','checkoutEnabled'] AND draft->>'kind'='shipment' AND draft->>'taxStatus'='unresolved' AND draft->>'checkoutEnabled'='false'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at)
);
