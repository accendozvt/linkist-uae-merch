// server.js — Linkist UAE Merch · Stripe Checkout
// ─────────────────────────────────────────────
// Setup:
//   npm install
//   Set your Stripe key: export STRIPE_SECRET_KEY=sk_test_...
//   Run: node server.js
//   Visit: http://localhost:3000
// ─────────────────────────────────────────────

const express  = require('express');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));  // serves all HTML/CSS/JS files

// ── Product prices (server-side source of truth) ──
const PRICES = {
  circle:  149,
  smile:   149,
  stripe:  149,
  stealth: 169,
};

// ── Create Stripe Checkout Session ─────────
app.post('/create-checkout', async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Build Stripe line items — use server-side prices, never trust client prices
    const line_items = items.map(item => {
      const serverPrice = PRICES[item.id];
      if (!serverPrice) throw new Error(`Unknown product: ${item.id}`);

      return {
        price_data: {
          currency: 'aed',
          product_data: {
            name: `I Never Left — ${item.name}`,
            description: `Size: ${item.size} · Limited April 2026 Edition`,
            images: [item.image],
            metadata: { product_id: item.id, size: item.size }
          },
          unit_amount: serverPrice * 100,  // Stripe uses smallest currency unit (fils)
        },
        quantity: item.qty,
      };
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      currency: 'aed',
      success_url: `${req.headers.origin || 'http://localhost:' + PORT}/success.html`,
      cancel_url:  `${req.headers.origin || 'http://localhost:' + PORT}/cart.html`,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['AE', 'SA', 'KW', 'BH', 'QA', 'OM', 'IN', 'GB', 'US'],
      },
      metadata: {
        order_source: 'linkist-uae-merch',
        item_count: items.reduce((s, i) => s + i.qty, 0).toString()
      }
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────┐
  │   I Never Left — Linkist × UAE      │
  │   Server running on port ${PORT}        │
  │   http://localhost:${PORT}              │
  │                                     │
  │   Stripe key: ${process.env.STRIPE_SECRET_KEY ? '✓ Set' : '✗ NOT SET — export STRIPE_SECRET_KEY=sk_...'}  │
  └─────────────────────────────────────┘
  `);
});
