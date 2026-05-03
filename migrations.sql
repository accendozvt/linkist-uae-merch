-- ============================================================
-- Linkist UAE Merch — Supabase migrations
-- Run these once in the Supabase SQL editor
-- ============================================================

-- ── Earlier migrations (run if you haven't already) ────────────
ALTER TABLE products ALTER COLUMN price TYPE NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address JSONB;

-- ── Coupons table (per-email first-purchase coupons) ──────────
CREATE TABLE IF NOT EXISTS coupons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  code        TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  order_id    UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS coupons_email_idx ON coupons(email);
CREATE INDEX IF NOT EXISTS coupons_code_idx  ON coupons(code);

-- ============================================================
-- NEW (security + reliability hardening)
-- ============================================================

-- ── Atomic stock decrement (prevents oversell race) ──────────
-- Returns the new quantity, or NULL if there wasn't enough stock.
-- The webhook calls supabase.rpc('decrement_stock', ...) instead of
-- read-then-update, eliminating the TOCTOU window between two concurrent buyers.
CREATE OR REPLACE FUNCTION decrement_stock(p_id TEXT, p_size TEXT, p_qty INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE new_qty INT;
BEGIN
  UPDATE stock
     SET quantity = quantity - p_qty,
         updated_at = NOW()
   WHERE product_id = p_id
     AND size       = p_size
     AND quantity   >= p_qty
   RETURNING quantity INTO new_qty;
  RETURN new_qty;  -- NULL if no row matched (oversell guard tripped)
END $$;

-- Belt-and-braces: hard DB constraint so stock can never go below 0
-- even if some other code path bypasses the RPC.
ALTER TABLE stock
  DROP CONSTRAINT IF EXISTS stock_quantity_nonneg;
ALTER TABLE stock
  ADD CONSTRAINT stock_quantity_nonneg CHECK (quantity >= 0);

-- ── Webhook idempotency (deduplicate Stripe retries) ─────────
-- The webhook inserts event.id at the start. PK collision = duplicate, skip.
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS processed_webhook_events_processed_at_idx
  ON processed_webhook_events(processed_at);

-- Optional: cleanup old idempotency records after 30 days
-- (Stripe only retries within ~3 days, so 30 is plenty safe)
-- You can run this manually periodically:
--   DELETE FROM processed_webhook_events WHERE processed_at < NOW() - INTERVAL '30 days';

-- ── Forgot / Reset password ───────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_reset_token TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS customers_reset_token_idx ON customers(password_reset_token) WHERE password_reset_token IS NOT NULL;

-- ── Saved addresses (JSONB array per customer) ────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS saved_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── Cookie / PDPL consent tracking ───────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cookie_consent VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cookie_consent_at TIMESTAMPTZ;
