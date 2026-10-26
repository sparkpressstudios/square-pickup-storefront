-- Reviewed additive migration: no catalog/checkout changes or merchant seed data.
CREATE TABLE merchant_presentation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  presentation jsonb CHECK (presentation IS NULL OR jsonb_typeof(presentation) = 'object'),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  updated_by text,
  updated_at timestamptz,
  CHECK ((presentation IS NULL AND updated_by IS NULL AND updated_at IS NULL)
      OR (presentation IS NOT NULL AND updated_by IS NOT NULL AND updated_at IS NOT NULL))
);
INSERT INTO merchant_presentation(singleton, revision) VALUES (true, repeat('0', 64));
