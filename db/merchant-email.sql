-- Optional, buyer-invoked migration. Base commerce schema stays at version 2.
CREATE TABLE merchant_email_schema (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version=1),checksum text NOT NULL,
 environment text NOT NULL CHECK(environment IN('sandbox','production')),
 merchant_id text NOT NULL,location_id text NOT NULL,application_id text NOT NULL,
 activated_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE merchant_email_outbox (
 id uuid PRIMARY KEY,attempt_id uuid NOT NULL REFERENCES merchant_commerce_attempts(id),
 kind text NOT NULL CHECK(kind='order_confirmation'),UNIQUE(attempt_id,kind),
 idempotency_key text NOT NULL UNIQUE,payload jsonb NOT NULL,payload_hash text NOT NULL,
 state text NOT NULL CHECK(state IN('queued','sending','retry','accepted','needs_review','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),first_dispatch_at timestamptz,
 claim_token uuid,lease_until timestamptz,credential_fingerprint text,
 provider_message_id text,failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='sending' AND claim_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'sending' AND claim_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX merchant_email_due ON merchant_email_outbox(state,next_attempt_at);
