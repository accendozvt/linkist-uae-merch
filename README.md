# I Never Left — Linkist × UAE Merch Store

## Files
```
index.html          ← Main landing page
circle-edition.html ← Product page
smile-edition.html  ← Product page
stripe-edition.html ← Product page
stealth-edition.html← Product page
cart.html           ← Cart + checkout
success.html        ← Order confirmation
style.css           ← Shared styles
cart.js             ← Shared cart logic + product data
server.js           ← Node.js + Stripe backend
package.json
```

## Setup on your server

### 1. Install Node.js
```bash
# Check if installed
node -v

# If not, install (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Upload all files to your server

### 3. Install dependencies
```bash
npm install
```

### 4. Get your Stripe keys
- Go to https://dashboard.stripe.com
- Developers → API Keys
- Copy your Secret Key (starts with sk_test_ or sk_live_)

### 5. Run the server
```bash
# Test mode
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx node server.js

# Production (use a process manager like PM2)
npm install -g pm2
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx pm2 start server.js --name linkist-uae
pm2 save
```

### 6. Test the checkout
Use Stripe test card: **4242 4242 4242 4242**
Expiry: any future date | CVC: any 3 digits

## Go Live Checklist
- [ ] Replace sk_test_ with sk_live_ key
- [ ] Set up your domain + SSL (HTTPS required for payments)
- [ ] Add shipping rates in Stripe Dashboard if needed
- [ ] Test a real payment end to end
