# Linkist UAE Merch — Setup Guide

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (starts with `sk_`) | [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (starts with `whsec_`) | Stripe Dashboard → Developers → Webhooks |
| `SUPABASE_URL` | Your Supabase project URL | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (secret) | Supabase Dashboard → Project Settings → API → service_role |
| `RESEND_API_KEY` | Resend email API key | [resend.com/api-keys](https://resend.com/api-keys) |
| `SELLER_EMAIL` | Email address to receive new order alerts | Your email address |
| `ADMIN_PASSWORD` | Password to access /admin.html dashboard | Choose a strong password |
| `JWT_SECRET` | Secret for signing customer JWTs | Any long random string (32+ chars) |
| `PORT` | Server port (optional, defaults to 3000) | Usually not needed |

### Local .env example

Create a `.env` file (never commit this):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
RESEND_API_KEY=re_...
SELLER_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET=a-very-long-random-secret-string-here
```

To load `.env` locally, install `dotenv` and add `require('dotenv').config()` at the top of server.js, or use:
```bash
node -r dotenv/config server.js
```

---

## Running Locally

```bash
npm install
node server.js
# Visit http://localhost:3000
```

---

## Supabase Database Setup

Run these SQL statements in your Supabase SQL editor (Dashboard → SQL Editor → New query):

```sql
-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Products table
create table products (
  id text primary key,
  name text not null,
  tag text,
  tagline text,
  price integer not null,
  badge text,
  page text,
  image text,
  description text,
  details jsonb,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Stock table
create table stock (
  id uuid primary key default uuid_generate_v4(),
  product_id text references products(id) on delete cascade,
  size text not null,
  quantity integer not null default 0,
  updated_at timestamptz default now(),
  unique(product_id, size)
);

-- Customers table
create table customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_login timestamptz
);

-- Orders table
create table orders (
  id uuid primary key default uuid_generate_v4(),
  stripe_session_id text unique,
  status text not null default 'processing',
  total_amount integer,
  currency text default 'aed',
  customer_name text,
  customer_email text,
  customer_id uuid references customers(id) on delete set null,
  shipping_address jsonb,
  tracking_number text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Order items table
create table order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  product_id text,
  product_name text,
  size text,
  quantity integer,
  unit_price integer,
  created_at timestamptz default now()
);

-- Optional: decrement_stock RPC for atomic stock deduction
create or replace function decrement_stock(p_product_id text, p_size text, p_qty integer)
returns void language plpgsql as $$
begin
  update stock
  set quantity = greatest(0, quantity - p_qty),
      updated_at = now()
  where product_id = p_product_id and size = p_size;
end;
$$;
```

### Seed products

```sql
insert into products (id, name, tag, tagline, price, badge, page, image, description, active) values
  ('circle', 'Circle Edition', 'DESIGN 01 · STATEMENT', 'The original statement piece', 149, 'BESTSELLER', 'circle-edition.html',
   'https://cdn.shopify.com/s/files/1/0803/8898/0982/files/Linkist_02.png?v=1777283800',
   'A bold circular arc in UAE flag colors frames the words that say everything — I Never Left.', true),
  ('smile', 'Smile Edition', 'DESIGN 02 · SUBTLE', 'Quiet pride, loud message', 149, 'NEW', 'smile-edition.html',
   'https://cdn.shopify.com/s/files/1/0803/8898/0982/files/Linkist_01.png?v=1777284868',
   'A minimalist smile arc drawn in UAE flag colors sits above the words I Never Left.', true),
  ('stripe', 'Stripe Edition', 'DESIGN 03 · CLASSIC', 'Clean, wearable, timeless', 149, null, 'stripe-edition.html',
   'https://cdn.shopify.com/s/files/1/0803/8898/0982/files/Linkist_04.png?v=1777283800',
   'Three lines in UAE flag colors underline the statement I Never Left.', true),
  ('stealth', 'Stealth Edition', 'DESIGN 04 · PREMIUM', 'For those who know', 169, 'PREMIUM', 'stealth-edition.html',
   'https://cdn.shopify.com/s/files/1/0803/8898/0982/files/Linkist_03.png?v=1777283800',
   'Ultra-minimal tone-on-tone typography. I Never Left rendered almost invisible against the black.', true);
```

### Seed stock (20 units per size per product)

```sql
insert into stock (product_id, size, quantity)
select p.id, s.size, 20
from products p
cross join (values ('XS'),('S'),('M'),('L'),('XL'),('XXL')) as s(size);
```

### Row Level Security (recommended for production)

```sql
-- Allow service role full access (server uses service role key so this is fine)
-- Restrict anon reads on sensitive tables
alter table orders enable row level security;
alter table customers enable row level security;
alter table order_items enable row level security;

-- Products and stock are public read
alter table products enable row level security;
alter table stock enable row level security;

create policy "Public read products" on products for select using (true);
create policy "Public read stock" on stock for select using (true);
```

---

## Stripe Webhook Setup

1. Go to [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks)
2. Click **Add endpoint**
3. Set endpoint URL: `https://your-domain.com/webhook`
4. Select events: `checkout.session.completed`
5. Copy the **Signing secret** → set as `STRIPE_WEBHOOK_SECRET`

### Local webhook testing with Stripe CLI

```bash
stripe listen --forward-to localhost:3000/webhook
# The CLI prints a whsec_... secret — use that as STRIPE_WEBHOOK_SECRET locally
```

---

## Deploying to Vercel

1. Push to GitHub
2. Import project at [vercel.com/new](https://vercel.com/new)
3. Add all environment variables in Vercel Dashboard → Project → Settings → Environment Variables
4. Deploy

The `vercel.json` routes all traffic through `server.js` which serves static files and API routes.

---

## Schema Updates

Run this in Supabase SQL Editor to enable multiple product images:

```sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]';
```

---

## Pages

| Page | URL | Description |
|---|---|---|
| Store front | `/` or `/index.html` | Product catalogue |
| Product pages | `/circle-edition.html` etc. | Individual product pages |
| Cart | `/cart.html` | Shopping cart + checkout |
| Success | `/success.html` | Post-purchase confirmation |
| Login / Register | `/account-login.html` | Customer auth |
| My Account | `/account.html` | Orders + profile |
| Admin | `/admin.html` | Admin dashboard (password protected) |
