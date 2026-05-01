-- ============================================================
-- Linkist UAE Merch — Supabase migrations
-- Run these once in the Supabase SQL editor
-- ============================================================

-- Existing recommended (run if you haven't already):
ALTER TABLE products ALTER COLUMN price TYPE NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;

-- ── NEW: Billing address column on orders ───────────────────
-- Stored as JSONB (same shape as shipping_address). Falls back to shipping when same.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address JSONB;

-- ── NEW: Coupons table — one per email, bound to first purchase ─
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
