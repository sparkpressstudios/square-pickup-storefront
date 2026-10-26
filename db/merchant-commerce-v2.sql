-- Explicit additive upgrade. Never edit the applied v1 SQL/checksum.
ALTER TABLE merchant_commerce_config DROP CONSTRAINT merchant_commerce_config_version_check;
ALTER TABLE merchant_commerce_config ADD CONSTRAINT merchant_commerce_config_version_check CHECK(version IN(1,2));
ALTER TABLE merchant_commerce_config DROP CONSTRAINT merchant_commerce_config_application_id_check;
ALTER TABLE merchant_commerce_config ADD CONSTRAINT merchant_commerce_config_application_id_check CHECK(application_id LIKE 'sandbox-sq0idb-%' OR application_id LIKE 'sq0idp-%' OR application_id LIKE 'sq0idb-%');
ALTER TABLE merchant_commerce_config ADD COLUMN environment text NOT NULL DEFAULT 'sandbox' CHECK(environment IN('sandbox','production'));
ALTER TABLE merchant_commerce_config ADD COLUMN operating_settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE merchant_commerce_quotes ADD COLUMN line_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE merchant_commerce_quotes ADD COLUMN pickup_at timestamptz;
ALTER TABLE merchant_commerce_quotes ADD COLUMN pickup_time_zone text;
ALTER TABLE merchant_commerce_quotes ADD COLUMN checkout_token_hash text CHECK(checkout_token_hash IS NULL OR length(checkout_token_hash)=64);
ALTER TABLE merchant_commerce_attempts ADD COLUMN customer_lookup_hash text UNIQUE CHECK(customer_lookup_hash IS NULL OR length(customer_lookup_hash)=64);
ALTER TABLE merchant_commerce_attempts ADD COLUMN customer_lookup_expires_at timestamptz;
ALTER TABLE merchant_commerce_attempts ADD COLUMN pickup_at timestamptz;
ALTER TABLE merchant_commerce_attempts ADD COLUMN pickup_time_zone text;
CREATE TABLE merchant_commerce_fulfillment_requests (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES merchant_commerce_attempts(id),
 target_state text NOT NULL CHECK(target_state IN('ready','picked_up')),
 provider_state text NOT NULL CHECK(provider_state IN('RESERVED','PREPARED','COMPLETED')),
 fulfillment_id text NOT NULL, order_version integer NOT NULL CHECK(order_version>=0),
 idempotency_key text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('reserved','sending','completed','failed','review')),claim_token uuid,
 evidence jsonb, requested_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_commerce_order_history ON merchant_commerce_attempts(created_at DESC,id DESC);
