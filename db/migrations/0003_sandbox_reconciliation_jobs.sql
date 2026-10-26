CREATE TABLE sandbox_reconciliation_jobs (
  id uuid PRIMARY KEY,
  event_id text NOT NULL UNIQUE REFERENCES sandbox_webhook_events(event_id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry','succeeded','attention')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  failure_code text CHECK (failure_code IN ('WAITING_FOR_PAYMENT','TRANSIENT_DATABASE','RECONCILIATION_CONFLICT','UNEXPECTED_FAILURE','ATTEMPTS_EXHAUSTED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX sandbox_reconciliation_due ON sandbox_reconciliation_jobs(state,available_at);
-- Adopt only already verified/sanitized pending events; never import provider payloads or catalog data.
INSERT INTO sandbox_reconciliation_jobs(id,event_id)
SELECT md5('sandbox-reconciliation:' || event_id)::uuid,event_id FROM sandbox_webhook_events WHERE outcome='pending';
