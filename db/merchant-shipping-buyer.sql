-- DEVELOPMENT ONLY. Not registered in setup/startup; no payment execution is enabled.
CREATE TABLE public.merchant_shipping_buyer_config (
 merchant_id text NOT NULL, location_id text NOT NULL, revision integer NOT NULL DEFAULT 1,
 policy jsonb NOT NULL, tax_categories jsonb NOT NULL, tax_configuration_id text NOT NULL,
 quote_window timestamptz NOT NULL DEFAULT now(), quote_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(merchant_id,location_id)
);
CREATE TABLE public.merchant_shipping_buyer_quotes (
 id uuid PRIMARY KEY, merchant_id text NOT NULL, location_id text NOT NULL,
 configuration_revision integer NOT NULL, cart jsonb NOT NULL, quote jsonb NOT NULL,
 checkout_token_hash text NOT NULL, expires_at timestamptz NOT NULL, canceled boolean NOT NULL DEFAULT false,
 fulfillment_kind text NOT NULL DEFAULT 'shipment' CHECK(fulfillment_kind='shipment'),
 CHECK(quote->>'paymentExecutionEnabled'='false'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.merchant_shipping_buyer_attempts (
 id uuid PRIMARY KEY REFERENCES public.merchant_shipping_buyer_quotes(id),
 fulfillment_kind text NOT NULL CHECK(fulfillment_kind='shipment'),
 fulfillment_snapshot jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('reserved','canceled','expired')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.merchant_shipping_buyer_reservations (
 attempt_id uuid NOT NULL REFERENCES public.merchant_shipping_buyer_attempts(id),
 variant_id text NOT NULL REFERENCES merchant_commerce_inventory(variant_id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 state text NOT NULL CHECK(state IN('held','released')),
 PRIMARY KEY(attempt_id,variant_id)
);
