-- Standalone fresh merchant catalog schema.
-- Never include this in migrateSyntheticDatabase or its native allowed table set.
-- It creates NO payment paths, customer tables, admin users, or live checkout permissions.
CREATE TABLE merchant_catalog_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  dataset text NOT NULL CHECK (dataset = 'merchant-catalog-v1'),
  square_merchant_id text NOT NULL,
  square_location_id text NOT NULL,
  inventory_owner text NOT NULL DEFAULT 'unassigned' CHECK (inventory_owner IN ('unassigned', 'square', 'website')),
  checkout_enabled boolean NOT NULL DEFAULT false CHECK (checkout_enabled = false),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_products (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  options jsonb NOT NULL
);
CREATE TABLE catalog_variants (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
  sku text NOT NULL UNIQUE,
  selections jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  price_minor integer NOT NULL CHECK (price_minor>=0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity=0),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled=false),
  UNIQUE (product_id, selections)
);
CREATE TABLE merchant_square_item_links (
  square_item_id text PRIMARY KEY,
  product_id text NOT NULL UNIQUE REFERENCES catalog_products(id) ON DELETE RESTRICT
);
CREATE TABLE merchant_square_variation_links (
  square_variation_id text PRIMARY KEY,
  variant_id text NOT NULL UNIQUE REFERENCES catalog_variants(id) ON DELETE RESTRICT,
  square_item_id text NOT NULL REFERENCES merchant_square_item_links(square_item_id) ON DELETE RESTRICT
);
CREATE TABLE merchant_catalog_import_batches (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  square_merchant_id text NOT NULL,
  square_location_id text NOT NULL,
  requested_inventory_owner text NOT NULL CHECK (requested_inventory_owner IN ('square', 'website')),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','committed')),
  committed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  CHECK ((state='staged' AND committed_by IS NULL AND committed_at IS NULL)
    OR (state='committed' AND committed_by IS NOT NULL AND committed_at IS NOT NULL))
);

-- Authentication belongs only to a separately provisioned merchant database.
-- No default user, password, API token, or staff session is seeded.
CREATE TABLE merchant_staff_accounts (
  id text PRIMARY KEY CHECK (id='merchant-admin'),
  role text NOT NULL CHECK (role='admin'),
  password_salt text NOT NULL,
  password_digest text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE merchant_staff_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  staff_id text NOT NULL REFERENCES merchant_staff_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX merchant_staff_sessions_expiry ON merchant_staff_sessions(expires_at);
