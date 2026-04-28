// server.js — Linkist UAE Merch · Full-stack with Supabase, Resend, PDFKit, Auth
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
const JWT_SECRET = process.env.JWT_SECRET;

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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
    if (!supabase) return res.json([]);
    const { data: products } = await supabase.from('products').select('*').eq('active', true).order('created_at');
    const { data: stock } = await supabase.from('stock').select('*');
    const result = (products || []).map(p => ({
      ...p,
      stock: (stock || []).filter(s => s.product_id === p.id).reduce((acc, s) => { acc[s.size] = s.quantity; return acc; }, {})
    }));
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
    const FALLBACK_PRICES = { circle: 149, smile: 149, stripe: 149, stealth: 169 };
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
        allowed_countries: ['AE', 'SA', 'KW', 'BH', 'QA', 'OM', 'IN', 'GB', 'US'],
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
    if (!cust?.line1 || !cust?.city || !cust?.country) return res.status(400).json({ error: 'Shipping address is required' });

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
    const FALLBACK_PRICES = { circle: 149, smile: 149, stripe: 149, stealth: 169 };
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
    };

    if (supabase) {
      let { data: order, error: oErr } = await supabase.from('orders').insert(orderData).select().single();
      if (oErr) {
        const { customer_phone, ...noPhone } = orderData;
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
      &nbsp;·&nbsp; #IstandwithUAE &nbsp;·&nbsp; #BornInTheUAE
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
    <div style="font-size:11px;color:#444;line-height:1.8;"><a href="https://linkist.ai" style="color:#666;text-decoration:none;">linkist.ai</a> &nbsp;·&nbsp; #IstandwithUAE &nbsp;·&nbsp; #BornInTheUAE</div>
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
        <div style="font-size:48px;margin:16px 0;">🚀</div>
        <h1 style="color:#fff;font-size:24px;">Your order is on its way!</h1>
        <p style="color:#888;font-size:13px;">Order #${orderId}</p>
        ${trackingNumber ? `<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:16px;margin:24px 0;"><p style="color:#888;margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Tracking Number</p><p style="color:#fff;font-family:monospace;font-size:16px;margin:0;">${escHtml(trackingNumber)}</p></div>` : ''}
        <div style="margin-top:24px;">
          ${(items || []).map(i => `<p style="color:#ccc;font-size:13px;">${escHtml(i.product_name)} — ${escHtml(i.size)} × ${i.quantity}</p>`).join('')}
        </div>
        <p style="color:#555;font-size:12px;margin-top:32px;">#istandwithUAE · linkist.ai</p>
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
        <div style="font-size:48px;margin:16px 0;">📦</div>
        <h1 style="color:#fff;font-size:24px;">Your order has arrived!</h1>
        <p style="color:#888;font-size:14px;line-height:1.7;">Order #${orderId}<br>Thank you for standing with the UAE.</p>
        <p style="color:#007A3D;font-size:16px;font-style:italic;margin-top:20px;">"I Never Left."</p>
        <p style="color:#555;font-size:12px;margin-top:32px;">#istandwithUAE · #borninUAE · linkist.ai</p>
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

    // Dark header band
    doc.rect(0, 0, 595, 75).fill('#0a0a0a');
    // UAE flag stripe at very top
    doc.rect(0, 0, 595, 3).fill('#C8102E');

    // Logo image (white on dark background) — fallback to text if file missing
    const logoPath = path.join(__dirname, 'images', 'linkist-white.png');
    try {
      doc.image(logoPath, 28, 16, { height: 38 });
    } catch {
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff').text('LINKIST', 28, 22);
    }
    doc.fontSize(8).font('Helvetica').fillColor('#666666').text('I NEVER LEFT · UAE · linkist.ai', 28, 58);

    // Invoice label (right side of dark header)
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#ffffff').text('INVOICE', 350, 18, { align: 'right', width: 215 });
    doc.fontSize(9).font('Helvetica').fillColor('#888888').text(`#${(order.id || '').slice(0,8).toUpperCase()}`, 350, 44, { align: 'right', width: 215 });
    doc.text(`${new Date(order.created_at || Date.now()).toLocaleDateString('en-GB')}`, 350, 56, { align: 'right', width: 215 });

    // Divider below header
    doc.moveTo(0, 75).lineTo(595, 75).lineWidth(2).stroke('#C8102E');

    // Bill to
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('BILL TO', 50, 95);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(order.customer_name || 'Customer', 50, 108);
    doc.fontSize(9).font('Helvetica').fillColor('#555555').text(order.customer_email || '', 50, 123);
    let billY = 137;
    if (order.customer_phone) {
      doc.text(order.customer_phone, 50, billY, { width: 250 });
      billY += 14;
    }
    if (order.shipping_address) {
      const addr = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address;
      const lines = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country].filter(Boolean);
      doc.text(lines.join(', '), 50, billY, { width: 250 });
    }

    // Items table
    const tY = 200;
    doc.rect(50, tY, 495, 22).fill('#f0f0f0');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#333333');
    doc.text('ITEM', 60, tY + 7);
    doc.text('SIZE', 290, tY + 7);
    doc.text('QTY', 350, tY + 7);
    doc.text('UNIT', 400, tY + 7);
    doc.text('SUBTOTAL', 470, tY + 7);

    let rowY = tY + 30;
    items.forEach((item, i) => {
      if (i % 2 === 0) doc.rect(50, rowY - 5, 495, 22).fill('#fafafa');
      doc.fontSize(10).font('Helvetica').fillColor('#000000').text(item.product_name || '', 60, rowY, { width: 220 });
      doc.text(item.size || '', 290, rowY);
      doc.text(String(item.quantity), 350, rowY);
      doc.text(`AED ${item.unit_price}`, 400, rowY);
      doc.text(`AED ${(item.unit_price || 0) * (item.quantity || 0)}`, 470, rowY);
      rowY += 26;
    });

    // Total line
    rowY += 6;
    doc.moveTo(50, rowY).lineTo(545, rowY).lineWidth(2).stroke('#C8102E');
    rowY += 12;
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text('TOTAL', 390, rowY);
    doc.text(`AED ${Math.round((order.total_amount || 0) / 100)}`, 460, rowY);

    // Footer
    doc.moveTo(50, 745).lineTo(545, 745).lineWidth(0.5).stroke('#cccccc');
    doc.fontSize(8).font('Helvetica').fillColor('#999999')
      .text('100% of proceeds go to UAE community relief · Thank you for standing with the UAE', 50, 755, { align: 'center', width: 495 })
      .text('linkist.ai  ·  #istandwithUAE  ·  #borninUAE', 50, 768, { align: 'center', width: 495 });

    // Bottom flag bar
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
    const { data: existing } = await supabase.from('customers').select('id').eq('email', email.toLowerCase()).single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const { data: customer, error } = await supabase.from('customers').insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password_hash,
    }).select('id, name, email, created_at').single();

    if (error) throw error;

    sendWelcomeEmail(customer).catch(e => console.error('Welcome email failed:', e.message));
    const token = makeToken(customer);
    res.status(201).json({ token, customer: { id: customer.id, name: customer.name, email: customer.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    if (!supabase) return res.json([]);
    const { data, error } = await supabase.from('products').select('*').order('created_at');
    if (error) throw error;
    res.json(data || []);
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
    const updates = { ...body, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('products').update(updates).eq('id', req.params.id).select().single();
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
    const productMap = {};
    (products || []).forEach(p => { productMap[p.id] = p; });
    const result = (stock || []).map(s => ({
      ...s,
      products: productMap[s.product_id] || { name: s.product_id, id: s.product_id }
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/stock', requireAdmin, async (req, res) => {
  try {
    const { productId, size, quantity } = req.body;
    if (!productId || !size || quantity === undefined) return res.status(400).json({ error: 'productId, size and quantity are required' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await supabase.from('stock').upsert({
      product_id: productId,
      size,
      quantity: Math.max(0, parseInt(quantity)),
      updated_at: new Date().toISOString()
    }, { onConflict: 'product_id,size' }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: images directory ──────────────────────────────────────

app.get('/admin/images', requireAdmin, (req, res) => {
  const fs = require('fs');
  const imgDir = path.join(__dirname, 'images');
  if (!fs.existsSync(imgDir)) return res.json([]);
  const files = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
  res.json(files.map(f => ({ name: f, url: `/images/${f}` })));
});

// ── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Linkist UAE Merch running on port ${PORT}`);
});
