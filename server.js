// server.js — Linkist UAE Merch · Full-stack with Supabase, Resend, PDFKit, Auth
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
const JWT_SECRET = process.env.JWT_SECRET;

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Image upload storage
const imgDir = path.join(__dirname, 'images');
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, imgDir),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safe);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (/\.(jpe?g|png|webp|gif)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Product name map for notifications
const PRODUCT_NAMES = { circle: 'Circle Edition', smile: 'Smile Edition', stripe: 'Stripe Edition', stealth: 'Stealth Edition' };

// Authoritative product catalog — used as fallback when products are missing/deleted from DB
// NOTE: Do NOT add original_price here — that column does not exist in Supabase schema
const CATALOG = [
  {
    id: 'circle', name: 'Circle Edition', tagline: 'The original statement piece',
    tag: 'DESIGN 01 · STATEMENT', price: 97.1, badge: 'BESTSELLER',
    page: 'circle-edition.html', image: '/images/Linkist%2001.png', images: [],
    description: 'A bold circular arc in UAE flag colors frames the words that say everything — <em>I Never Left</em>. Worn by those who stayed when it mattered most.',
    details: ['Dri-Fit performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop'],
    active: true
  },
  {
    id: 'smile', name: 'Smile Edition', tagline: 'Quiet pride, loud message',
    tag: 'DESIGN 02 · SUBTLE', price: 97.1, badge: 'NEW',
    page: 'smile-edition.html', image: '/images/Linkist%2002.png', images: [],
    description: 'A minimalist smile arc drawn in UAE flag colors sits above the words <em>I Never Left</em>. Subtle enough for everyday wear, meaningful enough to start a conversation.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop'],
    active: true
  },
  {
    id: 'stripe', name: 'Stripe Edition', tagline: 'Clean, wearable, timeless',
    tag: 'DESIGN 03 · CLASSIC', price: 97.1, badge: null,
    page: 'stripe-edition.html', image: '/images/Linkist%2003.png', images: [],
    description: 'Three lines in UAE flag colors underline the statement <em>I Never Left</em>. A classic design for those who carry their roots without making noise.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop'],
    active: true
  },
  {
    id: 'stealth', name: 'Stealth Edition', tagline: 'For those who know',
    tag: 'DESIGN 04 · PREMIUM', price: 169, badge: 'PREMIUM',
    page: 'stealth-edition.html', image: '/images/Linkist%2004.png', images: [],
    description: 'Ultra-minimal tone-on-tone typography with a subtle diagonal texture. <em>I Never Left</em> rendered almost invisible against the black. No noise. Just conviction.',
    details: ['Premium cotton fabric','Unisex fit — true to size','Crew neck, short sleeve','Subtle diagonal texture detail','100% proceeds to UAE relief','Limited April 2026 drop'],
    active: true
  }
];

// Original (pre-sale) prices — injected into API responses as fallback when DB original_price is not set
const ORIGINAL_PRICES = { circle: 149, smile: 149, stripe: 149, stealth: 199 };

// Linkist.ai parent-site URL for coupon redemption
const LINKIST_PARENT_URL = process.env.LINKIST_PARENT_URL || 'https://linkist.ai';

// Coupon code generator — format LK-XXXX-XXXX, no ambiguous chars (no 0/O/1/I)
function generateCouponCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n) => Array.from({ length: n }, () =>
    alphabet[crypto.randomInt(alphabet.length)]
  ).join('');
  return `LK-${rand(4)}-${rand(4)}`;
}

// Issue a coupon for first-time purchasers — UNIQUE(email) guarantees only first purchase succeeds.
// Returns { code, alreadyHad: bool } or null if DB unavailable.
async function issueCouponForEmail({ email, name, orderId }) {
  if (!supabase || !email) return null;
  const cleanEmail = String(email).toLowerCase().trim();
  // Already has one? Don't re-issue.
  const { data: existing } = await supabase
    .from('coupons').select('code, sent_at').eq('email', cleanEmail).maybeSingle();
  if (existing) return { code: existing.code, alreadyHad: true };

  // Generate unique code (retry on collision; UNIQUE(code) protects DB)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCouponCode();
    const { data, error } = await supabase.from('coupons').insert({
      email: cleanEmail, code, customer_name: name || null, order_id: orderId || null,
    }).select('code').single();
    if (!error && data) return { code: data.code, alreadyHad: false };
    // Email-uniqueness race: another insert beat us. Re-read.
    if (error && /duplicate.*email/i.test(error.message || '')) {
      const { data: row } = await supabase.from('coupons').select('code').eq('email', cleanEmail).maybeSingle();
      if (row) return { code: row.code, alreadyHad: true };
    }
    // else loop and try a new code (handles UNIQUE(code) collision)
  }
  console.error('[coupon] Failed to issue coupon for', cleanEmail);
  return null;
}

// ── Sort order (1=first). Admin can update sort_order column in DB; this is the catalog default ──
// Catalog order is the display order fallback when sort_order is not set in DB.

// CRITICAL: webhook raw body MUST come before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Security helpers ────────────────────────────────────────────

function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// Simple in-memory rate limiter — no external package required
const _rl = new Map();
function isRateLimited(key, max, windowMs) {
  const now = Date.now();
  let e = _rl.get(key);
  if (!e || now > e.reset) e = { n: 0, reset: now + windowMs };
  e.n++;
  _rl.set(key, e);
  return e.n > max;
}

// Whitelist origins used to build Stripe redirect URLs
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'linkist.ai,ineverleft.linkist.ai,localhost').split(',');
function safeOrigin(req) {
  const origin = req.headers.origin || '';
  try {
    const host = new URL(origin).hostname;
    if (ALLOWED_ORIGINS.some(o => host === o || host.endsWith('.' + o))) return origin;
  } catch {}
  return 'https://linkist.ai';
}

// ── Middleware helpers ──────────────────────────────────────────

function requireAdmin(req, res, next) {
  const validEmail = process.env.ADMIN_EMAIL;
  const validPassword = process.env.ADMIN_PASSWORD;
  if (!validEmail || !validPassword) return res.status(503).json({ error: 'Admin credentials not configured' });
  if (req.headers['x-admin-email'] !== validEmail || req.headers['x-admin-password'] !== validPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireCustomer(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.customer = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function makeToken(customer) {
  return jwt.sign(
    { customerId: customer.id, email: customer.email, name: customer.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ── Health check ────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  let dbError = null;
  if (supabase) {
    const { error } = await supabase.from('products').select('id').limit(1);
    dbOk = !error;
    dbError = error?.message || null;
  }
  res.json({
    ok: dbOk,
    supabase_configured: !!process.env.SUPABASE_URL,
    supabase_connected: dbOk,
    supabase_error: dbError,
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET,
    resend_configured: !!process.env.RESEND_API_KEY,
    admin_configured: !!process.env.ADMIN_EMAIL,
  });
});

// ── Products ────────────────────────────────────────────────────

app.get('/products', async (req, res) => {
  try {
    // Build stock index from DB
    let dbMap = {}, stockMap = {};
    if (supabase) {
      const { data: products } = await supabase.from('products').select('*').order('created_at');
      const { data: stock } = await supabase.from('stock').select('*');
      (products || []).forEach(p => { dbMap[p.id] = p; });
      (stock || []).forEach(s => {
        if (!stockMap[s.product_id]) stockMap[s.product_id] = {};
        stockMap[s.product_id][s.size] = s.quantity;
      });
    }

    // Always return all CATALOG products (DB data takes precedence where present & active)
    const result = CATALOG.map(base => {
      const db = dbMap[base.id];
      // Use DB version if it exists; fall back to catalog if missing or soft-deleted
      const merged = (db && db.active !== false) ? { ...base, ...db } : { ...base };
      merged.stock = stockMap[base.id] || {};
      // Inject original price for sale display — prefer DB original_price, fall back to map
      const dbOrigPrice = merged.original_price ?? null;
      if (dbOrigPrice && parseFloat(dbOrigPrice) > parseFloat(merged.price || 0)) {
        merged.originalPrice = parseFloat(dbOrigPrice);
      } else if (ORIGINAL_PRICES[merged.id]) {
        merged.originalPrice = ORIGINAL_PRICES[merged.id];
      }
      return merged;
    });

    // Also include any DB-only active products not in the catalog
    Object.values(dbMap).forEach(p => {
      if (p.active !== false && !CATALOG.find(c => c.id === p.id)) {
        result.push({ ...p, stock: stockMap[p.id] || {} });
      }
    });

    // Sort by sort_order (lower=earlier) when set; CATALOG order otherwise.
    // Explicit sort_order beats null; ties broken by catalog index for stability.
    const catalogIndex = id => {
      const i = CATALOG.findIndex(c => c.id === id);
      return i >= 0 ? i : 999;
    };
    result.sort((a, b) => {
      const ao = (a.sort_order ?? null);
      const bo = (b.sort_order ?? null);
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (ao === null && bo !== null) return 1;
      return catalogIndex(a.id) - catalogIndex(b.id);
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Checkout ────────────────────────────────────────────────────

app.post('/create-checkout', async (req, res) => {
  try {
    const { items, customerId } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });

    // Stock validation
    if (supabase) {
      for (const item of items) {
        const { data: stockRow } = await supabase.from('stock')
          .select('quantity').eq('product_id', item.id).eq('size', item.size).single();
        if (!stockRow || stockRow.quantity < item.qty) {
          return res.status(400).json({ error: `${item.name} (${item.size}) is out of stock or insufficient quantity` });
        }
      }
    }

    // Load prices from DB (falls back to hardcoded for the 4 original products)
    const FALLBACK_PRICES = { circle: 97.1, smile: 97.1, stripe: 97.1, stealth: 169 };
    let dbPrices = {};
    if (supabase) {
      const { data: dbProducts } = await supabase.from('products').select('id, price').eq('active', true);
      if (dbProducts) dbProducts.forEach(p => { dbPrices[p.id] = p.price; });
    }
    const PRICES = { ...FALLBACK_PRICES, ...dbPrices };

    const line_items = items.map(item => {
      const serverPrice = PRICES[item.id];
      if (!serverPrice) throw new Error(`Unknown product: ${item.id}`);
      return {
        price_data: {
          currency: 'aed',
          product_data: {
            name: `I Never Left — ${item.name}`,
            description: `Size: ${item.size} · Limited April 2026 Edition`,
          },
          unit_amount: serverPrice * 100,
        },
        quantity: item.qty,
      };
    });

    const origin = safeOrigin(req);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      currency: 'aed',
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart.html`,
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },
      shipping_address_collection: {
        allowed_countries: ['AE'],
      },
      metadata: {
        items: JSON.stringify(items.map(i => ({
          id: i.id, name: i.name, size: i.size, qty: i.qty,
          price: PRICES[i.id], image: i.image
        }))),
        customer_id: customerId || '',
        order_source: 'linkist-uae-merch',
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pre-checkout: save order BEFORE Stripe ──────────────────────

app.post('/pre-checkout', async (req, res) => {
  try {
    const { items, customer: cust } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!cust?.name || !cust?.email) return res.status(400).json({ error: 'Name and email are required' });
    if (!cust?.line1 || !cust?.city) return res.status(400).json({ error: 'Shipping address is required' });
    // Force shipping country to UAE (delivery is UAE-only)
    cust.country = 'United Arab Emirates';
    // If billing differs, validate the billing fields too
    const billDiff = !!cust.billing_different;
    let billingAddress = null;
    if (billDiff) {
      if (!cust.billing_line1 || !cust.billing_city) {
        return res.status(400).json({ error: 'Billing address is required when different from shipping' });
      }
      billingAddress = {
        line1: cust.billing_line1,
        line2: cust.billing_line2 || null,
        city: cust.billing_city,
        state: cust.billing_state || null,
        postal_code: cust.billing_postal || null,
        country: cust.billing_country || 'United Arab Emirates',
      };
    }

    // Stock validation
    if (supabase) {
      for (const item of items) {
        const { data: stockRow } = await supabase.from('stock')
          .select('quantity').eq('product_id', item.id).eq('size', item.size).single();
        if (!stockRow || stockRow.quantity < item.qty) {
          return res.status(400).json({ error: `${item.name} (${item.size}) is out of stock` });
        }
      }
    }

    // Load prices
    const FALLBACK_PRICES = { circle: 97.1, smile: 97.1, stripe: 97.1, stealth: 169 };
    let dbPrices = {};
    if (supabase) {
      const { data: dbProducts } = await supabase.from('products').select('id, price').eq('active', true);
      if (dbProducts) dbProducts.forEach(p => { dbPrices[p.id] = p.price; });
    }
    const PRICES = { ...FALLBACK_PRICES, ...dbPrices };

    const line_items = items.map(item => {
      const serverPrice = PRICES[item.id];
      if (!serverPrice) throw new Error(`Unknown product: ${item.id}`);
      return {
        price_data: {
          currency: 'aed',
          product_data: { name: `I Never Left — ${item.name}`, description: `Size: ${item.size}` },
          unit_amount: serverPrice * 100,
        },
        quantity: item.qty,
      };
    });

    const totalAmount = line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    const origin = safeOrigin(req);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      currency: 'aed',
      customer_email: cust.email,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart.html`,
      metadata: {
        items: JSON.stringify(items.map(i => ({ id: i.id, name: i.name, size: i.size, qty: i.qty, price: PRICES[i.id], image: i.image }))),
        customer_id: cust.customerId || '',
      },
    });

    const shippingAddress = { line1: cust.line1, line2: cust.line2 || null, city: cust.city, state: cust.state || null, postal_code: cust.postal || null, country: cust.country };
    const orderData = {
      stripe_session_id: session.id,
      status: 'pending',
      total_amount: totalAmount,
      currency: 'aed',
      customer_name: cust.name,
      customer_email: cust.email,
      customer_phone: cust.phone || '',
      customer_id: cust.customerId || null,
      shipping_address: shippingAddress,
      // billing address — falls back to shipping when same. Stored as JSONB.
      billing_address: billingAddress || shippingAddress,
    };

    if (supabase) {
      let { data: order, error: oErr } = await supabase.from('orders').insert(orderData).select().single();
      if (oErr) {
        // Strip billing_address first if column missing, then phone if column missing
        if (/billing_address/i.test(oErr.message || '')) {
          const { billing_address, ...noBill } = orderData;
          const r1 = await supabase.from('orders').insert(noBill).select().single();
          if (!r1.error) { order = r1.data; oErr = null; }
          else oErr = r1.error;
        }
      }
      if (oErr) {
        const { customer_phone, billing_address, ...noPhone } = orderData;
        const retry = await supabase.from('orders').insert(noPhone).select().single();
        if (!retry.error) order = retry.data;
      }
      if (order) {
        await supabase.from('order_items').insert(
          items.map(item => ({ order_id: order.id, product_id: item.id, product_name: item.name, size: item.size, quantity: item.qty, unit_price: PRICES[item.id] }))
        );
        // Save address to customer profile if logged in and checkbox checked
        if (cust.customerId && cust.saveAddress) {
          await supabase.from('customers').update({
            phone: cust.phone || '', address_line1: cust.line1, address_line2: cust.line2 || '',
            address_city: cust.city, address_state: cust.state || '', address_postal: cust.postal || '',
            address_country: cust.country, updated_at: new Date().toISOString(),
          }).eq('id', cust.customerId);
        }
      }
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('Pre-checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook ─────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      if (supabase) {
        let order;
        let items;

        // Check if order already exists (created by /pre-checkout before payment)
        const { data: existingOrder } = await supabase.from('orders')
          .select('*').eq('stripe_session_id', session.id).single();

        if (existingOrder) {
          // Pre-checkout path: order already has all customer data — just flip status
          await supabase.from('orders')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', existingOrder.id);
          order = { ...existingOrder, status: 'processing' };
          const { data: savedItems } = await supabase.from('order_items').select('*').eq('order_id', order.id);
          items = savedItems || [];
        } else {
          // Legacy / direct path: create order from Stripe session data
          const metaItems = JSON.parse(session.metadata?.items || '[]');
          const customerId = session.metadata?.customer_id || null;
          const orderData = {
            stripe_session_id: session.id,
            status: 'processing',
            total_amount: session.amount_total,
            currency: 'aed',
            customer_name: session.shipping_details?.name || session.customer_details?.name || '',
            customer_email: session.customer_details?.email || '',
            customer_phone: session.customer_details?.phone || '',
            customer_id: customerId || null,
            shipping_address: session.shipping_details?.address || null,
          };

          let { data: newOrder, error: orderErr } = await supabase.from('orders').insert(orderData).select().single();
          if (orderErr) {
            const { customer_phone, ...dataWithoutPhone } = orderData;
            const retry = await supabase.from('orders').insert(dataWithoutPhone).select().single();
            if (retry.error) throw retry.error;
            newOrder = retry.data;
          }
          if (!newOrder) throw new Error('Order insert returned no data');
          order = newOrder;
          items = metaItems;
          if (items.length) {
            await supabase.from('order_items').insert(
              items.map(item => ({ order_id: order.id, product_id: item.id, product_name: item.name, size: item.size, quantity: item.qty, unit_price: item.price }))
            );
          }
        }

        // Always deduct stock — read then update (supabase-js never throws, .catch() is unreliable)
        for (const item of items) {
          const productId = item.product_id || item.id;
          const qty = item.quantity ?? item.qty ?? 0;
          const { data: stockRow } = await supabase.from('stock')
            .select('quantity').eq('product_id', productId).eq('size', item.size).single();
          if (stockRow) {
            await supabase.from('stock')
              .update({ quantity: Math.max(0, stockRow.quantity - qty), updated_at: new Date().toISOString() })
              .eq('product_id', productId).eq('size', item.size);
          }
        }

        // Send emails
        const orderWithItems = { ...order, items };
        await sendBuyerEmail(orderWithItems).catch(e => console.error('Buyer email failed:', e.message));
        await sendSellerEmail(orderWithItems).catch(e => console.error('Seller email failed:', e.message));

        // First-purchase coupon for linkist.ai — UNIQUE(email) ensures one-per-user
        try {
          const issued = await issueCouponForEmail({
            email: order.customer_email,
            name: order.customer_name,
            orderId: order.id
          });
          if (issued && !issued.alreadyHad) {
            await sendCouponEmail({
              email: order.customer_email,
              name: order.customer_name,
              code: issued.code
            }).catch(e => console.error('Coupon email failed:', e.message));
          }
        } catch (e) {
          console.error('[coupon] issue failed:', e.message);
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  }

  res.json({ received: true });
});

// ── Email helpers ───────────────────────────────────────────────

// Resend SDK returns { data, error } and does NOT throw. Wrap to make errors actually surface.
async function sendMail(payload) {
  if (!resend) {
    console.error('[email] resend not configured (RESEND_API_KEY missing)');
    throw new Error('Email service not configured');
  }
  const result = await resend.emails.send(payload);
  if (result?.error) {
    const errStr = JSON.stringify(result.error);
    console.error('[email] Resend rejected:', errStr, '— payload to:', payload.to, 'subject:', payload.subject);
    throw new Error(`Resend error: ${result.error.message || errStr}`);
  }
  console.log('[email] sent OK id=', result?.data?.id, 'to=', payload.to, 'subject=', payload.subject);
  return result.data;
}


function buyerEmailHtml(order, items) {
  const itemRows = items.map(item => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #222;color:#ccc;">${escHtml(item.product_name || item.name)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #222;color:#ccc;text-align:center;">${escHtml(item.size)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #222;color:#ccc;text-align:center;">×${item.quantity || item.qty}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #222;color:#fff;text-align:right;font-weight:bold;">AED ${(item.unit_price || item.price) * (item.quantity || item.qty)}</td>
    </tr>`).join('');

  const addr = order.shipping_address;
  const addrText = addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country].filter(Boolean).map(escHtml).join(', ') : '';
  const total = Math.round((order.total_amount || 0) / 100);
  const orderId = (order.id || '').slice(0, 8).toUpperCase();

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#0a0a0a;">
  <!-- UAE Flag Bar top -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#C8102E;height:5px;"></td>
    <td style="background:#ffffff;height:5px;"></td>
    <td style="background:#111111;height:5px;"></td>
    <td style="background:#007A3D;height:5px;"></td>
  </tr></table>
  <!-- Header with logo -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px 28px;text-align:center;border-bottom:1px solid #1e1e1e;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:5px;">LINKIST</div>
    <div style="font-size:11px;color:#555;letter-spacing:3px;margin-top:8px;text-transform:uppercase;">I Never Left · UAE</div>
  </td></tr></table>
  <!-- Success icon -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:36px 40px 0;">
    <div style="width:64px;height:64px;border-radius:50%;background:#007A3D;display:inline-block;text-align:center;line-height:64px;">
      <span style="color:#fff;font-size:32px;font-weight:bold;line-height:64px;">&#10003;</span>
    </div>
    <h1 style="color:#ffffff;font-size:26px;margin:18px 0 8px;font-family:Arial,sans-serif;">Order Confirmed!</h1>
    <p style="color:#888;font-size:14px;margin:0;">Thank you for standing with the UAE</p>
    <div style="font-family:monospace;font-size:12px;color:#555;margin-top:10px;letter-spacing:1px;">ORDER #${orderId}</div>
  </td></tr></table>
  <!-- Items -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px;">
    <div style="font-size:10px;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:14px;">Your Order</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid #222;">
          <th style="padding:8px 6px;text-align:left;font-size:10px;color:#555;font-weight:normal;letter-spacing:1px;">ITEM</th>
          <th style="padding:8px 6px;text-align:center;font-size:10px;color:#555;font-weight:normal;letter-spacing:1px;">SIZE</th>
          <th style="padding:8px 6px;text-align:center;font-size:10px;color:#555;font-weight:normal;letter-spacing:1px;">QTY</th>
          <th style="padding:8px 6px;text-align:right;font-size:10px;color:#555;font-weight:normal;letter-spacing:1px;">AMOUNT</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #C8102E;margin-top:16px;"><tr>
      <td style="padding-top:14px;color:#888;font-size:14px;">Total</td>
      <td style="padding-top:14px;color:#fff;font-size:22px;font-weight:bold;text-align:right;">AED ${total}</td>
    </tr></table>
  </td></tr></table>
  ${addrText ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 28px;">
    <div style="font-size:10px;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:10px;">Shipping To</div>
    <div style="color:#ccc;font-size:13px;line-height:1.7;">${escHtml(order.customer_name)}<br>${addrText}</div>
  </td></tr></table>` : ''}
  <!-- Message -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 32px;">
    <div style="padding:22px 24px;background:#111111;border-radius:8px;border-left:3px solid #007A3D;">
      <p style="color:#ccc;font-size:14px;line-height:1.8;margin:0;font-style:italic;">"I Never Left is not just a shirt. It's a statement of where we stand — and where we always will."</p>
      <div style="font-size:11px;color:#555;margin-top:10px;">— Linkist Team, UAE</div>
    </div>
  </td></tr></table>
  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 40px;text-align:center;border-top:1px solid #1e1e1e;">
    <div style="font-size:12px;color:#444;line-height:1.8;">
      <a href="https://linkist.ai" style="color:#666;text-decoration:none;">linkist.ai</a>
      &nbsp;·&nbsp; #WeStandWithUAE &nbsp;·&nbsp; #BornInTheUAE
    </div>
    <div style="font-size:10px;color:#333;margin-top:8px;">100% of proceeds go to UAE community relief</div>
  </td></tr></table>
  <!-- UAE Flag Bar bottom -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#007A3D;height:4px;"></td>
    <td style="background:#111111;height:4px;"></td>
    <td style="background:#ffffff;height:4px;"></td>
    <td style="background:#C8102E;height:4px;"></td>
  </tr></table>
</div></body></html>`;
}

async function sendWelcomeEmail(customer) {
  if (!resend || !customer.email) return;
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: customer.email,
    subject: 'Welcome to Linkist UAE — I Never Left',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#C8102E;height:5px;"></td><td style="background:#ffffff;height:5px;"></td>
    <td style="background:#111111;height:5px;"></td><td style="background:#007A3D;height:5px;"></td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px 28px;text-align:center;border-bottom:1px solid #1e1e1e;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:5px;">LINKIST</div>
    <div style="font-size:11px;color:#555;letter-spacing:3px;margin-top:8px;text-transform:uppercase;">I Never Left · UAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px;text-align:center;">
    <h1 style="color:#ffffff;font-size:24px;margin:0 0 12px;">Welcome, ${escHtml(customer.name.split(' ')[0])}!</h1>
    <p style="color:#888;font-size:14px;line-height:1.8;margin:0 0 24px;">Your account is ready. You can now track your orders and shop the limited edition I Never Left collection.</p>
    <a href="https://linkist.ai" style="display:inline-block;background:#E53935;color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;padding:14px 32px;border-radius:8px;letter-spacing:1px;">SHOP THE COLLECTION</a>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 32px;">
    <div style="padding:22px 24px;background:#111111;border-radius:8px;border-left:3px solid #C8102E;">
      <p style="color:#ccc;font-size:13px;line-height:1.8;margin:0;font-style:italic;">"When uncertainty came close, we stayed. Because the UAE is not just where we work — it is where Linkist was born."</p>
      <div style="font-size:11px;color:#555;margin-top:10px;">— Linkist Team, UAE</div>
    </div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 40px;text-align:center;border-top:1px solid #1e1e1e;">
    <div style="font-size:11px;color:#444;line-height:1.8;"><a href="https://linkist.ai" style="color:#666;text-decoration:none;">linkist.ai</a> &nbsp;·&nbsp; #WeStandWithUAE &nbsp;·&nbsp; #BornInTheUAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#007A3D;height:4px;"></td><td style="background:#111111;height:4px;"></td>
    <td style="background:#ffffff;height:4px;"></td><td style="background:#C8102E;height:4px;"></td>
  </tr></table>
</div></body></html>`
  });
}

async function sendBuyerEmail(order) {
  if (!resend || !order.customer_email) return;
  const items = order.items || [];
  const orderId = (order.id || '').slice(0, 8).toUpperCase();
  const payload = {
    from: 'Linkist UAE <hello@linkist.ai>',
    to: order.customer_email,
    subject: `Order Confirmed — I Never Left #${orderId}`,
    html: buyerEmailHtml(order, items),
  };
  try {
    const pdfBuffer = await generateInvoiceBuffer(order, items.map(i => ({
      product_name: i.product_name || i.name,
      size: i.size,
      quantity: i.quantity || i.qty,
      unit_price: i.unit_price || i.price
    })));
    payload.attachments = [{ filename: `invoice-${orderId}.pdf`, content: pdfBuffer.toString('base64') }];
  } catch (e) {
    console.error('Invoice PDF generation failed (email will send without attachment):', e.message);
  }
  await sendMail(payload);
}

// First-purchase coupon email — sends an exclusive code redeemable at linkist.ai
async function sendCouponEmail({ email, name, code }) {
  if (!resend || !email || !code) return;
  const firstName = (name || '').split(' ')[0] || 'there';
  const redeemUrl = `${LINKIST_PARENT_URL}/?coupon=${encodeURIComponent(code)}`;
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: email,
    subject: `Your exclusive Linkist.ai coupon — ${code}`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#C8102E;height:5px;"></td><td style="background:#ffffff;height:5px;"></td>
    <td style="background:#111111;height:5px;"></td><td style="background:#007A3D;height:5px;"></td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px 28px;text-align:center;border-bottom:1px solid #1e1e1e;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:5px;">LINKIST</div>
    <div style="font-size:11px;color:#555;letter-spacing:3px;margin-top:8px;text-transform:uppercase;">A thank-you from the team</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 40px 24px;text-align:center;">
    <div style="display:inline-block;padding:6px 14px;background:rgba(229,57,53,0.12);border:1px solid rgba(229,57,53,0.3);border-radius:100px;font-size:10px;letter-spacing:2px;color:#E53935;text-transform:uppercase;">Limited-time · For you only</div>
    <h1 style="color:#ffffff;font-size:26px;margin:18px 0 10px;font-family:Arial,sans-serif;line-height:1.25;">Hi ${escHtml(firstName)}, here's your exclusive coupon</h1>
    <p style="color:#888;font-size:14px;line-height:1.7;margin:0 0 26px;">As a thank-you for your first purchase, here's your personal coupon to unlock an exclusive limited-time discount on <strong style="color:#fff;">Linkist.ai</strong> — the world's first <strong style="color:#fff;">Personal Relationship Manager (PRM)</strong>.</p>
  </td></tr></table>
  <!-- Coupon ticket -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 28px;">
    <div style="border:1px dashed #C8102E;border-radius:12px;background:#111;padding:28px 20px;text-align:center;">
      <div style="font-size:10px;letter-spacing:3px;color:#666;text-transform:uppercase;margin-bottom:12px;">Your Coupon Code</div>
      <div style="font-family:'Courier New',monospace;font-size:30px;font-weight:bold;color:#fff;letter-spacing:4px;background:#0a0a0a;padding:16px 12px;border-radius:8px;border:1px solid #1e1e1e;display:inline-block;">${escHtml(code)}</div>
      <div style="font-size:11px;color:#777;margin-top:14px;line-height:1.6;">Bound to <strong style="color:#aaa;">${escHtml(email)}</strong><br>Redeemable on Linkist.ai when you sign up with the same email</div>
    </div>
  </td></tr></table>
  <!-- CTA -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 36px;text-align:center;">
    <a href="${redeemUrl}" style="display:inline-block;background:#E53935;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:8px;letter-spacing:1px;">REDEEM ON LINKIST.AI →</a>
    <div style="font-size:11px;color:#444;margin-top:14px;">Or visit <a href="${LINKIST_PARENT_URL}" style="color:#888;text-decoration:none;">linkist.ai</a> and apply the code at checkout.</div>
  </td></tr></table>
  <!-- How it works -->
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 40px 32px;">
    <div style="padding:18px 22px;background:#111;border-radius:8px;border-left:3px solid #007A3D;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:10px;">How it works</div>
      <ol style="margin:0;padding-left:20px;color:#aaa;font-size:13px;line-height:1.9;">
        <li>Visit <a href="${LINKIST_PARENT_URL}" style="color:#fff;">linkist.ai</a> and sign up using <strong style="color:#fff;">${escHtml(email)}</strong>.</li>
        <li>Apply your code <strong style="color:#fff;">${escHtml(code)}</strong> at checkout.</li>
        <li>Enjoy your exclusive limited-time discount on PRM.</li>
      </ol>
    </div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 40px;text-align:center;border-top:1px solid #1e1e1e;">
    <div style="font-size:11px;color:#444;line-height:1.8;">Code is valid for one Linkist.ai account · One use only · Bound to your email</div>
    <div style="font-size:11px;color:#666;margin-top:8px;"><a href="https://linkist.ai" style="color:#888;text-decoration:none;">linkist.ai</a> · #WeStandWithUAE · #BornInTheUAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#007A3D;height:4px;"></td><td style="background:#111111;height:4px;"></td>
    <td style="background:#ffffff;height:4px;"></td><td style="background:#C8102E;height:4px;"></td>
  </tr></table>
</div></body></html>`
  });
  // Mark sent
  if (supabase) {
    await supabase.from('coupons')
      .update({ sent_at: new Date().toISOString() })
      .eq('email', String(email).toLowerCase().trim());
  }
}

async function sendSellerEmail(order) {
  if (!resend) return;
  const adminRecipients = ['linkistai@gmail.com'];
  if (process.env.SELLER_EMAIL && process.env.SELLER_EMAIL !== 'linkistai@gmail.com') {
    adminRecipients.push(process.env.SELLER_EMAIL);
  }
  const items = order.items || [];
  const total = Math.round((order.total_amount || 0) / 100);
  const orderId = (order.id || '').slice(0, 8).toUpperCase();
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: adminRecipients,
    subject: `New Order — AED ${total} — ${order.customer_name || 'Customer'}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;background:#0a0a0a;color:#fff;padding:32px;border-radius:8px;">
      <h2 style="color:#fff;margin-top:0;">New Order Alert</h2>
      <div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:20px;margin-bottom:16px;">
        <p style="color:#888;margin:0 0 4px;font-size:12px;">ORDER ID</p>
        <p style="color:#fff;margin:0;font-family:monospace;">#${orderId}</p>
      </div>
      <div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:20px;margin-bottom:16px;">
        <p style="color:#888;margin:0 0 8px;font-size:12px;">CUSTOMER</p>
        <p style="color:#fff;margin:0 0 4px;font-size:15px;">${escHtml(order.customer_name || 'N/A')}</p>
        <p style="color:#aaa;margin:0 0 4px;font-size:13px;">${escHtml(order.customer_email || '')}</p>
        ${order.customer_phone ? `<p style="color:#aaa;margin:0 0 4px;font-size:13px;">${escHtml(order.customer_phone)}</p>` : ''}
        ${(() => { const a = order.shipping_address; if (!a) return ''; const lines = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).map(escHtml).join(', '); return lines ? `<p style="color:#888;margin:8px 0 0;font-size:12px;line-height:1.6;">${lines}</p>` : ''; })()}
      </div>
      <div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:20px;margin-bottom:16px;">
        <p style="color:#888;margin:0 0 8px;font-size:12px;">ITEMS</p>
        ${items.map(i => `<p style="color:#ccc;margin:0 0 4px;font-size:13px;">• ${escHtml(i.product_name || i.name)} — ${escHtml(i.size)} × ${i.quantity || i.qty}</p>`).join('')}
      </div>
      <div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:20px;margin-bottom:16px;">
        <p style="color:#888;margin:0 0 4px;font-size:12px;">TOTAL</p>
        <p style="color:#fff;font-size:24px;margin:0;font-weight:bold;">AED ${total}</p>
      </div>
    </div>`
  });
}

async function sendShippingEmail(order, items, trackingNumber) {
  if (!resend || !order.customer_email) return;
  const orderId = (order.id || '').slice(0, 8).toUpperCase();
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: order.customer_email,
    reply_to: process.env.SELLER_EMAIL,
    subject: `Your order has shipped! — Linkist UAE`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:0;">
      <div style="height:6px;background:linear-gradient(90deg,#C8102E 25%,#fff 25%,#fff 50%,#111 50%,#111 75%,#007A3D 75%);"></div>
      <div style="padding:40px;text-align:center;">
        <div style="font-size:24px;font-weight:900;letter-spacing:2px;">LINKIST</div>
        <div style="width:56px;height:56px;margin:20px auto;background:#1a1a1a;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #333;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C8102E" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div>
        <h1 style="color:#fff;font-size:24px;">Your order is on its way!</h1>
        <p style="color:#888;font-size:13px;">Order #${orderId}</p>
        ${trackingNumber ? `<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:16px;margin:24px 0;"><p style="color:#888;margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Tracking Number</p><p style="color:#fff;font-family:monospace;font-size:16px;margin:0;">${escHtml(trackingNumber)}</p></div>` : ''}
        <div style="margin-top:24px;">
          ${(items || []).map(i => `<p style="color:#ccc;font-size:13px;">${escHtml(i.product_name)} — ${escHtml(i.size)} × ${i.quantity}</p>`).join('')}
        </div>
        <p style="color:#555;font-size:12px;margin-top:32px;">#WeStandWithUAE · linkist.ai</p>
      </div>
    </div>`
  });
}

async function sendDeliveredEmail(order, items) {
  if (!resend || !order.customer_email) return;
  const orderId = (order.id || '').slice(0, 8).toUpperCase();
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: order.customer_email,
    subject: `Your order has arrived! — Linkist UAE`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:0;">
      <div style="height:6px;background:linear-gradient(90deg,#C8102E 25%,#fff 25%,#fff 50%,#111 50%,#111 75%,#007A3D 75%);"></div>
      <div style="padding:40px;text-align:center;">
        <div style="font-size:24px;font-weight:900;letter-spacing:2px;">LINKIST</div>
        <div style="width:56px;height:56px;margin:20px auto;background:#1a1a1a;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #333;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#007A3D" stroke-width="2"><path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><polyline points="16 3 12 7 8 3"/></svg></div>
        <h1 style="color:#fff;font-size:24px;">Your order has arrived!</h1>
        <p style="color:#888;font-size:14px;line-height:1.7;">Order #${orderId}<br>Thank you for standing with the UAE.</p>
        <p style="color:#007A3D;font-size:16px;font-style:italic;margin-top:20px;">"I Never Left."</p>
        <p style="color:#555;font-size:12px;margin-top:32px;">#WeStandWithUAE · #borninUAE · linkist.ai</p>
      </div>
    </div>`
  });
}

// ── Invoice PDF ─────────────────────────────────────────────────

async function generateInvoiceBuffer(order, items) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = v => 'AED ' + Number(v || 0).toFixed(2);
    const orderId = (order.id || '').slice(0, 8).toUpperCase();
    const totalMinor = order.total_amount || 0;
    const totalMajor = totalMinor / 100;
    const subtotalMajor = items.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
    const status = (order.status || 'pending').toUpperCase();

    // Parse JSON address fields if needed
    const parseAddr = a => !a ? null : (typeof a === 'string' ? JSON.parse(a) : a);
    const ship = parseAddr(order.shipping_address);
    const bill = parseAddr(order.billing_address) || ship;
    const sameAddr = ship && bill &&
      ['line1','line2','city','state','postal_code','country'].every(k => (ship[k] || '') === (bill[k] || ''));

    // ── Header ───────────────────────────────────────────────
    doc.rect(0, 0, 595, 75).fill('#0a0a0a');
    doc.rect(0, 0, 595, 3).fill('#C8102E');

    const logoPath = path.join(__dirname, 'images', 'linkist-white.png');
    try { doc.image(logoPath, 28, 16, { height: 38 }); }
    catch { doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff').text('LINKIST', 28, 22); }
    doc.fontSize(8).font('Helvetica').fillColor('#666666').text('I NEVER LEFT · UAE · linkist.ai', 28, 58);

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#ffffff').text('INVOICE', 350, 18, { align: 'right', width: 215 });
    doc.fontSize(9).font('Helvetica').fillColor('#888888').text(`#${orderId}`, 350, 44, { align: 'right', width: 215 });
    doc.text(new Date(order.created_at || Date.now()).toLocaleDateString('en-GB'), 350, 56, { align: 'right', width: 215 });

    doc.moveTo(0, 75).lineTo(595, 75).lineWidth(2).stroke('#C8102E');

    // ── Meta strip — Invoice Date · Status · Payment ─────────
    let metaY = 92;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888');
    doc.text('INVOICE DATE', 50, metaY);
    doc.text('STATUS', 230, metaY);
    doc.text('PAYMENT', 410, metaY);
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
    doc.text(new Date(order.created_at || Date.now()).toLocaleDateString('en-GB'), 50, metaY + 12);
    doc.text(status, 230, metaY + 12);
    doc.text(order.stripe_session_id ? 'Card · Stripe' : '—', 410, metaY + 12);

    // ── BILL TO + SHIP TO blocks ─────────────────────────────
    const blockY = 140;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('BILL TO', 50, blockY);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(order.customer_name || 'Customer', 50, blockY + 13);
    doc.fontSize(9).font('Helvetica').fillColor('#555555').text(order.customer_email || '', 50, blockY + 28);
    let yB = blockY + 42;
    if (order.customer_phone) { doc.text(order.customer_phone, 50, yB, { width: 240 }); yB += 12; }
    if (bill) {
      const lines = [bill.line1, bill.line2, bill.city, bill.state, bill.postal_code, bill.country].filter(Boolean);
      doc.text(lines.join(', '), 50, yB, { width: 240 });
    }

    // SHIP TO (right column)
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('SHIP TO', 310, blockY);
    if (sameAddr) {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#777777')
        .text('Same as billing address', 310, blockY + 13, { width: 240 });
    } else if (ship) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(order.customer_name || 'Customer', 310, blockY + 13);
      let yS = blockY + 28;
      const lines = [ship.line1, ship.line2, ship.city, ship.state, ship.postal_code, ship.country].filter(Boolean);
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text(lines.join(', '), 310, yS, { width: 240 });
    }

    // ── Items table ──────────────────────────────────────────
    const tY = 240;
    doc.rect(50, tY, 495, 22).fill('#f0f0f0');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#333333');
    doc.text('ITEM', 60, tY + 7);
    doc.text('SIZE', 290, tY + 7);
    doc.text('QTY', 340, tY + 7);
    doc.text('UNIT', 390, tY + 7);
    doc.text('SUBTOTAL', 470, tY + 7);

    let rowY = tY + 30;
    items.forEach((item, i) => {
      if (i % 2 === 0) doc.rect(50, rowY - 5, 495, 22).fill('#fafafa');
      doc.fontSize(10).font('Helvetica').fillColor('#000000').text(item.product_name || '', 60, rowY, { width: 220 });
      doc.text(item.size || '', 290, rowY);
      doc.text(String(item.quantity), 340, rowY);
      doc.text(fmt(item.unit_price), 390, rowY);
      doc.text(fmt((Number(item.unit_price) || 0) * (Number(item.quantity) || 0)), 470, rowY);
      rowY += 26;
    });

    // ── Totals breakdown ────────────────────────────────────
    rowY += 8;
    doc.moveTo(310, rowY).lineTo(545, rowY).lineWidth(0.5).stroke('#cccccc');
    rowY += 10;
    const totalsRow = (label, val, bold = false) => {
      doc.fontSize(bold ? 12 : 9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? '#000000' : '#555555');
      doc.text(label, 320, rowY);
      doc.text(val, 470, rowY, { width: 75, align: 'right' });
      rowY += bold ? 18 : 14;
    };
    totalsRow('Subtotal', fmt(subtotalMajor));
    totalsRow('Shipping', 'Free');
    totalsRow('Tax / VAT', 'Included');
    rowY += 4;
    doc.moveTo(310, rowY).lineTo(545, rowY).lineWidth(2).stroke('#C8102E');
    rowY += 10;
    totalsRow('TOTAL', fmt(totalMajor), true);

    // ── Notes ────────────────────────────────────────────────
    const notesY = Math.max(rowY + 30, 660);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('NOTES', 50, notesY);
    doc.fontSize(9).font('Helvetica').fillColor('#555555')
      .text('Thank you for your order. 100% of proceeds support UAE community relief efforts. Limited April 2026 drop. Please retain this invoice for your records. For any queries email hello@linkist.ai.', 50, notesY + 13, { width: 495, align: 'left' });

    // ── Footer ───────────────────────────────────────────────
    doc.moveTo(50, 745).lineTo(545, 745).lineWidth(0.5).stroke('#cccccc');
    doc.fontSize(8).font('Helvetica').fillColor('#999999')
      .text('Linkist · linkist.ai · hello@linkist.ai', 50, 755, { align: 'center', width: 495 })
      .text('#WeStandWithUAE · #BornInTheUAE · I Never Left', 50, 768, { align: 'center', width: 495 });

    doc.rect(0, 828, 595, 5).fill('#007A3D');
    doc.rect(0, 833, 595, 4).fill('#C8102E');

    doc.end();
  });
}

// ── Invoice download ────────────────────────────────────────────

app.get('/invoice/:orderId', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Access control: must provide matching Stripe session ID (guest) or be the owning customer
    const sid = req.query.sid;
    const auth = req.headers.authorization;
    let authorized = sid && order.stripe_session_id === sid;
    if (!authorized && auth?.startsWith('Bearer ')) {
      try {
        const p = jwt.verify(auth.slice(7), JWT_SECRET);
        if (p.customerId && p.customerId === order.customer_id) authorized = true;
      } catch {}
    }
    if (!authorized) return res.status(403).json({ error: 'Access denied' });

    const { data: items } = await supabase.from('order_items').select('*').eq('order_id', order.id);
    const pdfBuffer = await generateInvoiceBuffer(order, items || []);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${order.id.slice(0,8)}.pdf`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Invoice error:', err.message);
    res.status(500).json({ error: 'Could not generate invoice' });
  }
});

// ── Orders by session ───────────────────────────────────────────

app.get('/orders/by-session/:sessionId', async (req, res) => {
  try {
    if (!supabase) return res.json({});
    const { data } = await supabase.from('orders').select('id, status, total_amount, customer_id').eq('stripe_session_id', req.params.sessionId).single();
    res.json(data || {});
  } catch {
    res.json({});
  }
});

// ── Customer auth ───────────────────────────────────────────────

app.post('/customer/register', async (req, res) => {
  if (isRateLimited(`reg:${req.ip}`, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    // Check email unique
    const { data: existing } = await supabase.from('customers').select('id, email_verified').eq('email', email.toLowerCase()).single();
    if (existing) {
      if (!existing.email_verified) return res.status(409).json({ error: 'Email already registered but not verified. Check your inbox for the verification link.' });
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { data: customer, error } = await supabase.from('customers').insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password_hash,
      email_verified: false,
      verification_token: verificationToken,
      verification_expires: verificationExpires,
    }).select('id, name, email, created_at').single();

    if (error) throw error;

    // Send verification email
    const appOrigin = process.env.APP_URL || 'https://ineverleft.linkist.ai';
    const verifyUrl = `${appOrigin}/customer/verify-email?token=${verificationToken}&return=${req.body.returnTo || 'home'}`;
    if (resend) {
      await sendMail({
        from: 'Linkist UAE <hello@linkist.ai>',
        to: customer.email,
        subject: 'Verify your email — Linkist UAE',
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#C8102E;height:5px;"></td><td style="background:#fff;height:5px;"></td>
    <td style="background:#111;height:5px;"></td><td style="background:#007A3D;height:5px;"></td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px 28px;text-align:center;border-bottom:1px solid #1e1e1e;">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:5px;">LINKIST</div>
    <div style="font-size:11px;color:#555;letter-spacing:3px;margin-top:8px;">I Never Left · UAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px;text-align:center;">
    <h1 style="color:#fff;font-size:24px;margin:0 0 12px;">Verify your email</h1>
    <p style="color:#888;font-size:14px;line-height:1.8;margin:0 0 28px;">Hi ${escHtml(name.split(' ')[0])}, just one more step — click below to verify your email and activate your account.</p>
    <a href="${verifyUrl}" style="display:inline-block;background:#E53935;color:#fff;font-size:13px;font-weight:bold;text-decoration:none;padding:16px 36px;border-radius:8px;letter-spacing:1px;">VERIFY MY EMAIL</a>
    <p style="color:#444;font-size:12px;margin-top:24px;">This link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 40px;text-align:center;border-top:1px solid #1e1e1e;">
    <div style="font-size:11px;color:#444;">#WeStandWithUAE · linkist.ai</div>
  </td></tr></table>
</div></body></html>`
      }).catch(e => console.error('Verification email failed:', e.message));
    }

    res.status(201).json({ verification_sent: true, email: customer.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verify email ────────────────────────────────────────────────

app.get('/customer/verify-email', async (req, res) => {
  const { token, return: returnTo } = req.query;
  const appOrigin = process.env.APP_URL || '';
  if (!token) return res.redirect(`${appOrigin}/account-login.html?error=invalid_token`);
  try {
    if (!supabase) return res.redirect(`${appOrigin}/account-login.html?error=db_error`);
    const { data: customer } = await supabase.from('customers')
      .select('id, name, email, verification_token, verification_expires, email_verified')
      .eq('verification_token', token).single();

    if (!customer) return res.redirect(`${appOrigin}/account-login.html?error=invalid_token`);
    if (customer.email_verified) {
      // Already verified — just log them in
      const jwt_token = makeToken(customer);
      return res.redirect(`${appOrigin}/verify-success.html?jwt=${encodeURIComponent(jwt_token)}&return=${returnTo || 'home'}`);
    }
    if (new Date(customer.verification_expires) < new Date()) {
      return res.redirect(`${appOrigin}/account-login.html?error=token_expired`);
    }

    // Mark verified, clear token
    await supabase.from('customers')
      .update({ email_verified: true, verification_token: null, verification_expires: null })
      .eq('id', customer.id);

    const jwt_token = makeToken(customer);
    sendWelcomeEmail(customer).catch(e => console.error('Welcome email failed:', e.message));
    res.redirect(`${appOrigin}/verify-success.html?jwt=${encodeURIComponent(jwt_token)}&return=${returnTo || 'home'}`);
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.redirect(`${appOrigin}/account-login.html?error=server_error`);
  }
});

app.post('/customer/login', async (req, res) => {
  if (isRateLimited(`login:${req.ip}`, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { data: customer } = await supabase.from('customers').select('*').eq('email', email.toLowerCase()).single();
    if (!customer) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (customer.email_verified === false) {
      return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for the verification link.' });
    }

    await supabase.from('customers').update({ last_login: new Date().toISOString() }).eq('id', customer.id);

    const token = makeToken(customer);
    res.json({ token, customer: { id: customer.id, name: customer.name, email: customer.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/customer/me', requireCustomer, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { data: customer } = await supabase.from('customers')
      .select('id, name, email, phone, address_line1, address_line2, address_city, address_state, address_postal, address_country, created_at, last_login')
      .eq('id', req.customer.customerId).single();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/customer/orders', requireCustomer, async (req, res) => {
  try {
    if (!supabase) return res.json([]);
    const { data: orders } = await supabase.from('orders')
      .select('*')
      .eq('customer_id', req.customer.customerId)
      .order('created_at', { ascending: false });

    if (!orders || orders.length === 0) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const { data: allItems } = await supabase.from('order_items').select('*').in('order_id', orderIds);

    const result = orders.map(o => ({
      ...o,
      items: (allItems || []).filter(i => i.order_id === o.id)
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/customer/me', requireCustomer, async (req, res) => {
  try {
    const { name, phone, address_line1, address_line2, address_city, address_state, address_postal, address_country } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const updates = {
      name: name.trim(),
      phone: phone || '',
      address_line1: address_line1 || '',
      address_line2: address_line2 || '',
      address_city: address_city || '',
      address_state: address_state || '',
      address_postal: address_postal || '',
      address_country: address_country || '',
      updated_at: new Date().toISOString(),
    };

    const { data: customer, error } = await supabase.from('customers')
      .update(updates)
      .eq('id', req.customer.customerId)
      .select('id, name, email').single();

    if (error) throw error;
    const token = makeToken(customer);
    res.json({ token, customer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link a guest order to a newly registered/logged-in customer
app.post('/customer/link-order', requireCustomer, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { data, error } = await supabase.from('orders')
      .update({ customer_id: req.customer.customerId })
      .eq('stripe_session_id', session_id)
      .is('customer_id', null)
      .select('id').single();
    if (error) throw error;
    res.json({ linked: !!data, orderId: data?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cart sync ────────────────────────────────────────────────────

app.get('/customer/cart', requireCustomer, async (req, res) => {
  try {
    if (!supabase) return res.json({ items: [] });
    const { data } = await supabase.from('customers').select('cart_data').eq('id', req.customer.customerId).single();
    res.json({ items: data?.cart_data || [] });
  } catch (err) {
    res.json({ items: [] });
  }
});

app.put('/customer/cart', requireCustomer, async (req, res) => {
  try {
    const { items } = req.body;
    if (!supabase) return res.json({ ok: true });
    await supabase.from('customers').update({ cart_data: items || [] }).eq('id', req.customer.customerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/customer/password', requireCustomer, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { data: customer } = await supabase.from('customers').select('*').eq('id', req.customer.customerId).single();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const valid = await bcrypt.compare(currentPassword, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const password_hash = await bcrypt.hash(newPassword, 12);
    const { error } = await supabase.from('customers')
      .update({ password_hash, updated_at: new Date().toISOString() })
      .eq('id', req.customer.customerId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin routes ────────────────────────────────────────────────

app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json({ total_orders: 0, total_revenue: 0, pending_orders: 0, total_customers: 0 });

    const { data: orders } = await supabase.from('orders').select('status, total_amount');
    const { data: customers } = await supabase.from('customers').select('id');

    const total_orders = orders?.length || 0;
    const total_revenue = (orders || []).reduce((s, o) => s + (o.total_amount || 0), 0);
    const pending_orders = (orders || []).filter(o => o.status === 'processing').length;
    const total_customers = customers?.length || 0;

    res.json({ total_orders, total_revenue, pending_orders, total_customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json({ orders: [], total: 0 });

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const status = req.query.status;
    const search = req.query.search;
    if (search && !/^[\w\s.@+\-]{1,100}$/.test(search)) return res.status(400).json({ error: 'Invalid search' });
    const offset = (page - 1) * limit;

    let query = supabase.from('orders').select('*', { count: 'exact' });
    if (status) query = query.eq('status', status);
    if (search) query = query.or(`customer_name.ilike.%${search}%,customer_email.ilike.%${search}%`);
    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: orders, count, error } = await query;
    if (error) throw error;

    // Fetch items for these orders
    const orderIds = (orders || []).map(o => o.id);
    const { data: allItems } = orderIds.length
      ? await supabase.from('order_items').select('*').in('order_id', orderIds)
      : { data: [] };

    const result = (orders || []).map(o => ({
      ...o,
      items: (allItems || []).filter(i => i.order_id === o.id)
    }));

    res.json({ orders: result, total: count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, trackingNumber } = req.body;
    const validStatuses = ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const updateData = { status, updated_at: new Date().toISOString() };
    if (trackingNumber) updateData.tracking_number = trackingNumber;

    const { data: order, error } = await supabase.from('orders')
      .update(updateData)
      .eq('id', req.params.id)
      .select('*').single();

    if (error) throw error;

    // Fetch order items for email
    const { data: items } = await supabase.from('order_items').select('*').eq('order_id', order.id);

    // Send appropriate email
    if (status === 'shipped') {
      await sendShippingEmail(order, items || [], trackingNumber).catch(e => console.error('Shipping email failed:', e.message));
    } else if (status === 'delivered') {
      await sendDeliveredEmail(order, items || []).catch(e => console.error('Delivered email failed:', e.message));
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  try {
    let dbMap = {};
    if (supabase) {
      const { data, error } = await supabase.from('products').select('*').order('created_at');
      if (error) throw error;
      (data || []).forEach(p => { dbMap[p.id] = p; });
    }
    // Catalog products merged with DB data; missing ones marked as restorable
    const result = CATALOG.map(base => {
      const db = dbMap[base.id];
      return db ? db : { ...base, active: false, _catalog_missing: true };
    });
    // Also include DB-only products not in catalog
    Object.values(dbMap).forEach(p => {
      if (!CATALOG.find(c => c.id === p.id)) result.push(p);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/products', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { id, name, tag, tagline, price, badge, page, image, images, description, details, active } = req.body;
    if (!id) return res.status(400).json({ error: 'Product ID (slug) is required' });
    if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });
    const safeImages = Array.isArray(images) ? images : [];
    const safeDetails = Array.isArray(details) ? details : (typeof details === 'string' && details ? [details] : []);
    const { data, error } = await supabase.from('products').insert({
      id, name, tag, tagline, price, badge, page, image, images: safeImages, description, details: safeDetails, active: active !== false
    }).select().single();
    if (error) throw error;

    // Auto-create stock rows (0 qty) for all sizes
    const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    await supabase.from('stock').insert(
      SIZES.map(size => ({ product_id: id, size, quantity: 0 }))
    );

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const body = req.body;
    if ('name' in body && !body.name?.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    if ('price' in body && (body.price === null || body.price === undefined || isNaN(body.price))) return res.status(400).json({ error: 'Price must be a number' });
    if ('images' in body) body.images = Array.isArray(body.images) ? body.images : [];
    if ('details' in body) body.details = Array.isArray(body.details) ? body.details : (typeof body.details === 'string' && body.details ? [body.details] : []);
    // Strip client-only fields that are not DB columns
    const { originalPrice, _catalog_missing, _catalog_only, stock, id: _bodyId, ...safeBody } = body;
    const updates = { ...safeBody, updated_at: new Date().toISOString() };
    // Ensure price is always stored as float (DB column must be NUMERIC, not INTEGER)
    if ('price' in updates) updates.price = parseFloat(updates.price);
    if ('original_price' in updates) {
      const op = parseFloat(updates.original_price);
      updates.original_price = isNaN(op) ? null : op;
    }

    // Check if the row exists first
    const { data: existing } = await supabase.from('products').select('id').eq('id', req.params.id).maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase.from('products').update(updates).eq('id', req.params.id).select().single());
    } else {
      // Row missing from DB (hard-deleted) — re-insert from catalog base + requested updates
      const catalogBase = CATALOG.find(p => p.id === req.params.id);
      if (!catalogBase) return res.status(404).json({ error: 'Product not found in catalog or DB' });
      // Strip client-only fields that don't exist in the DB schema
      const { originalPrice, original_price, _catalog_missing, _catalog_only, stock, ...safeBase } = catalogBase;
      ({ data, error } = await supabase.from('products').insert({ ...safeBase, ...updates }).select().single());
      if (!error) {
        // Recreate stock rows at zero
        const SIZES = ['XS','S','M','L','XL','XXL'];
        await supabase.from('stock').insert(SIZES.map(s => ({ product_id: req.params.id, size: s, quantity: 0 })));
      }
    }
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { error } = await supabase.from('products').update({ active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/products/:id/permanent', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    await supabase.from('stock').delete().eq('product_id', req.params.id);
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/stock', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json([]);
    const [{ data: stock, error }, { data: products }] = await Promise.all([
      supabase.from('stock').select('*').order('product_id'),
      supabase.from('products').select('id, name')
    ]);
    if (error) throw error;

    // Build product name map — include DB products AND catalog products
    const productMap = {};
    (products || []).forEach(p => { productMap[p.id] = p; });
    CATALOG.forEach(c => { if (!productMap[c.id]) productMap[c.id] = { id: c.id, name: c.name }; });

    // Build stock rows map by product
    const stockByProduct = {};
    (stock || []).forEach(s => {
      if (!stockByProduct[s.product_id]) stockByProduct[s.product_id] = [];
      stockByProduct[s.product_id].push(s);
    });

    // Ensure all known products appear; for those with no stock rows, add virtual zero rows
    const SIZES_ORDER = ['XS','S','M','L','XL','XXL'];
    const result = [];
    Object.values(productMap).forEach(p => {
      const rows = stockByProduct[p.id];
      if (rows && rows.length > 0) {
        rows.forEach(s => result.push({ ...s, products: p }));
      } else {
        // No stock rows yet — show as all-zero so admin can fill them in
        SIZES_ORDER.forEach(size => result.push({ product_id: p.id, size, quantity: 0, products: p }));
      }
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ensure a product row exists in DB — inserts from CATALOG if missing.
// Required before stock upserts (FK constraint) and any product PATCH on a catalog-only product.
async function ensureProductInDb(productId) {
  if (!supabase) return false;
  const { data: existing } = await supabase.from('products').select('id').eq('id', productId).maybeSingle();
  if (existing) return true;
  const catalogBase = CATALOG.find(p => p.id === productId);
  if (!catalogBase) return false;
  // Strip client-only fields not in DB schema
  const { originalPrice, _catalog_missing, _catalog_only, stock, ...safeBase } = catalogBase;
  const { error } = await supabase.from('products').insert(safeBase);
  if (error) {
    console.error('ensureProductInDb insert failed:', productId, error.message);
    return false;
  }
  console.log('[ensureProductInDb] auto-inserted', productId, 'from catalog');
  return true;
}

app.patch('/admin/stock', requireAdmin, async (req, res) => {
  try {
    const { productId, size, quantity } = req.body;
    if (!productId || !size || quantity === undefined) return res.status(400).json({ error: 'productId, size and quantity are required' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    // Make sure the product exists in DB before upserting stock (avoid FK violation for catalog-only products)
    const ok = await ensureProductInDb(productId);
    if (!ok) return res.status(404).json({ error: `Product '${productId}' not found in catalog or DB` });

    const newQty = Math.max(0, parseInt(quantity));

    // Fetch the OLD quantity so we only fire notifications on a true out→in-stock transition
    const { data: existingStock } = await supabase.from('stock')
      .select('quantity').eq('product_id', productId).eq('size', size).maybeSingle();
    const oldQty = existingStock?.quantity ?? 0;

    const { data, error } = await supabase.from('stock').upsert({
      product_id: productId,
      size,
      quantity: newQty,
      updated_at: new Date().toISOString()
    }, { onConflict: 'product_id,size' }).select().single();

    if (error) throw error;

    // Only dispatch back-in-stock emails when stock truly transitions from 0 to >0
    if (oldQty === 0 && newQty > 0) {
      console.log(`[stock-notify] Trigger: ${productId}/${size} 0 → ${newQty}`);
      fireStockNotifications(productId, size, newQty).catch(e => console.error('[stock-notify] dispatch error:', e.message));
    }
    res.json(data);
  } catch (err) {
    console.error('PATCH /admin/stock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stock back-in-stock notifications ───────────────────────────

app.post('/notify-me', async (req, res) => {
  try {
    const { email, product_id, size } = req.body;
    // size is optional — empty string means "any size"
    if (!email || !product_id) return res.status(400).json({ error: 'email and product_id are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const cleanEmail = email.toLowerCase().trim();
    const notifSize = size || '';

    // Manual lookup → insert/update so re-subscribers get their notified_at reset to null,
    // which means a previously-notified user gets re-emailed on the NEXT 0→stock transition.
    const { data: existing } = await supabase.from('stock_notifications')
      .select('id, notified_at')
      .eq('email', cleanEmail)
      .eq('product_id', product_id)
      .eq('size', notifSize)
      .maybeSingle();

    if (existing) {
      // Reset notified_at so they get the next back-in-stock email
      if (existing.notified_at) {
        const { error: upErr } = await supabase.from('stock_notifications')
          .update({ notified_at: null }).eq('id', existing.id);
        if (upErr) throw upErr;
        console.log(`[notify-me] Re-subscribed ${cleanEmail} for ${product_id}/${notifSize || 'any'}`);
      } else {
        console.log(`[notify-me] Already pending for ${cleanEmail} on ${product_id}/${notifSize || 'any'}`);
      }
    } else {
      const { error: insErr } = await supabase.from('stock_notifications')
        .insert({ email: cleanEmail, product_id, size: notifSize, notified_at: null });
      if (insErr) throw insErr;
      console.log(`[notify-me] New subscriber ${cleanEmail} for ${product_id}/${notifSize || 'any'}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify-me] error:', err.message);
    res.status(500).json({ error: 'Could not save notification request' });
  }
});

async function fireStockNotifications(productId, size, newQty) {
  if (!supabase) { console.log('[stock-notify] skipped — supabase not configured'); return; }
  if (!resend) { console.log('[stock-notify] skipped — RESEND_API_KEY not configured'); return; }
  if (newQty <= 0) { console.log('[stock-notify] skipped — newQty=0'); return; }
  try {
    const productName = PRODUCT_NAMES[productId] || productId;
    // Notify both: size-specific subscribers AND any-size (size='') subscribers
    const sizesToQuery = size ? [size, ''] : [''];
    const { data: notifs, error: queryErr } = await supabase.from('stock_notifications')
      .select('id, email, size')
      .eq('product_id', productId)
      .in('size', sizesToQuery)
      .is('notified_at', null);
    if (queryErr) { console.error('[stock-notify] query error:', queryErr.message); return; }
    console.log(`[stock-notify] Found ${notifs?.length || 0} pending notif(s) for ${productId}/${size || 'any'}`);
    if (!notifs?.length) return;
    let sent = 0, failed = 0;
    for (const n of notifs) {
      // For any-size subscribers, tell them the specific size that came back
      const notifySize = n.size || size;
      try {
        await sendStockNotificationEmail(n.email, productName, productId, notifySize);
        sent++;
        console.log(`[stock-notify] ✓ sent to ${n.email} (${productId}/${notifySize})`);
      } catch (e) {
        failed++;
        console.error(`[stock-notify] ✗ failed for ${n.email}:`, e.message);
      }
    }
    // Mark only successfully-processed notifs as done (so failures retry on next stock change)
    if (sent > 0) {
      const ts = new Date().toISOString();
      await supabase.from('stock_notifications')
        .update({ notified_at: ts })
        .eq('product_id', productId).in('size', sizesToQuery).is('notified_at', null);
    }
    console.log(`[stock-notify] Done — sent: ${sent}, failed: ${failed}`);
  } catch (e) {
    console.error('[stock-notify] fatal error:', e.message);
  }
}

async function sendStockNotificationEmail(email, productName, productId, size) {
  const appOrigin = process.env.APP_URL || 'https://ineverleft.linkist.ai';
  const productPage = `${appOrigin}/${productId}-edition.html`;
  await sendMail({
    from: 'Linkist UAE <hello@linkist.ai>',
    to: email,
    subject: `${productName} (Size ${size}) is back in stock — I Never Left`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#C8102E;height:5px;"></td><td style="background:#ffffff;height:5px;"></td>
    <td style="background:#111111;height:5px;"></td><td style="background:#007A3D;height:5px;"></td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 40px 28px;text-align:center;border-bottom:1px solid #1e1e1e;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:5px;">LINKIST</div>
    <div style="font-size:11px;color:#555;letter-spacing:3px;margin-top:8px;text-transform:uppercase;">I Never Left · UAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px;text-align:center;">
    <div style="width:64px;height:64px;border-radius:50%;background:#007A3D;display:inline-block;line-height:64px;text-align:center;">
      <span style="color:#fff;font-size:32px;line-height:64px;">✓</span>
    </div>
    <h1 style="color:#ffffff;font-size:22px;margin:20px 0 8px;font-family:Arial,sans-serif;">It's Back in Stock!</h1>
    <p style="color:#888;font-size:14px;margin:0 0 24px;line-height:1.7;">
      <strong style="color:#fff;">${escHtml(productName)}</strong> in size <strong style="color:#fff;">${escHtml(size)}</strong><br>
      is now available. Grab it before it's gone.
    </p>
    <a href="${productPage}" style="display:inline-block;background:#E53935;color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:1px;">SHOP NOW →</a>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 40px;text-align:center;border-top:1px solid #1e1e1e;">
    <div style="font-size:11px;color:#444;">linkist.ai · #WeStandWithUAE · #BornInTheUAE</div>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#007A3D;height:4px;"></td><td style="background:#111111;height:4px;"></td>
    <td style="background:#ffffff;height:4px;"></td><td style="background:#C8102E;height:4px;"></td>
  </tr></table>
</div></body></html>`
  });
}

// ── Admin: images directory ──────────────────────────────────────

app.get('/admin/images', requireAdmin, (req, res) => {
  if (!fs.existsSync(imgDir)) return res.json([]);
  const files = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
  res.json(files.map(f => ({ name: f, url: `/images/${f}` })));
});

app.post('/admin/images/upload', requireAdmin, upload.array('images', 10), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const uploaded = req.files.map(f => ({ name: f.filename, url: `/images/${f.filename}` }));
  res.json({ ok: true, files: uploaded });
}, (err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// Build a unified customer list from BOTH:
//   1. registered customers (from `customers` table)
//   2. guest buyers (orders with email but no customer_id)
// Then enrich each row with coupon code from `coupons` table (keyed by email).
async function loadCustomersWithCoupons() {
  if (!supabase) return [];
  const [{ data: regs }, { data: orders }, { data: coupons }] = await Promise.all([
    supabase.from('customers').select('id, name, email, phone, created_at'),
    supabase.from('orders').select('customer_name, customer_email, customer_phone, created_at, customer_id'),
    supabase.from('coupons').select('email, code, sent_at'),
  ]);

  const couponByEmail = {};
  (coupons || []).forEach(c => { if (c.email) couponByEmail[c.email.toLowerCase()] = c; });

  const byEmail = {};
  (regs || []).forEach(r => {
    if (!r.email) return;
    byEmail[r.email.toLowerCase()] = {
      name: r.name || '', email: r.email, phone: r.phone || '',
      created_at: r.created_at, registered: true,
    };
  });
  // Pick up guest buyers whose email isn't in customers table yet
  (orders || []).forEach(o => {
    if (!o.customer_email) return;
    const k = o.customer_email.toLowerCase();
    if (!byEmail[k]) {
      byEmail[k] = {
        name: o.customer_name || '', email: o.customer_email, phone: o.customer_phone || '',
        created_at: o.created_at, registered: false,
      };
    } else if (!byEmail[k].phone && o.customer_phone) {
      byEmail[k].phone = o.customer_phone;
    }
  });

  const rows = Object.values(byEmail).map(r => {
    const c = couponByEmail[r.email.toLowerCase()];
    return {
      ...r,
      coupon_code: c?.code || '',
      coupon_sent_at: c?.sent_at || null,
    };
  });
  // Sort newest first
  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return rows;
}

app.get('/admin/customers', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const rows = await loadCustomersWithCoupons();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/customers/csv', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const rows = await loadCustomersWithCoupons();
    const csv = ['Name,Email,Phone,Coupon Code,Coupon Sent,Registered,Joined'];
    rows.forEach(c => {
      const cells = [
        c.name || '',
        c.email || '',
        c.phone || '',
        c.coupon_code || '',
        c.coupon_sent_at ? new Date(c.coupon_sent_at).toISOString() : '',
        c.registered ? 'Yes' : 'Guest',
        c.created_at ? new Date(c.created_at).toISOString() : '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
      csv.push(cells);
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=customers-${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual coupon resend (admin tool — useful if email failed first time)
app.post('/admin/customers/resend-coupon', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const cleanEmail = email.toLowerCase().trim();
    const { data: row } = await supabase.from('coupons').select('code, customer_name').eq('email', cleanEmail).maybeSingle();
    if (!row) return res.status(404).json({ error: 'No coupon found for this email' });
    await sendCouponEmail({ email: cleanEmail, name: row.customer_name, code: row.code });
    res.json({ ok: true, code: row.code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Linkist UAE Merch running on port ${PORT}`);
});
