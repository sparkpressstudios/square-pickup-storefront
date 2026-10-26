ALTER TABLE sandbox_checkout_attempts DROP CONSTRAINT sandbox_checkout_attempts_execution_mode_check;
ALTER TABLE sandbox_checkout_attempts ADD CONSTRAINT sandbox_checkout_execution_mode CHECK (execution_mode IN ('mocked-sandbox-protocol','square-sandbox'));
ALTER TABLE sandbox_checkout_attempts ADD COLUMN merchant_id text;
ALTER TABLE sandbox_checkout_attempts ADD COLUMN refunded_minor integer NOT NULL DEFAULT 0 CHECK (refunded_minor>=0);
ALTER TABLE sandbox_checkout_attempts ADD CONSTRAINT sandbox_checkout_merchant CHECK (execution_mode<>'square-sandbox' OR merchant_id IS NOT NULL);
