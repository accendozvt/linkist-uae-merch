// ── PRODUCTS CACHE (stale-while-revalidate) ───────────────────
// Cache /products responses in localStorage so returning visitors get instant,
// accurate renders without waiting for the network. Pages call:
//   const cached = getCachedProducts();          // null on first visit
//   fetchAndCacheProducts().then(fresh => ...)   // background refresh
const PRODUCTS_CACHE_KEY = 'products_cache_v1';
function getCachedProducts() {
  try {
    const raw = localStorage.getItem(PRODUCTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function setCachedProducts(products) {
  try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(products)); } catch {}
}
function fetchAndCacheProducts() {
  return fetch('/products')
    .then(r => r.json())
    .then(products => {
      if (Array.isArray(products) && products.length) setCachedProducts(products);
      return products;
    });
}

// ── AUTH HELPERS ──────────────────────────────────────────────
function getCustomer() {
  try {
    const token = localStorage.getItem('customer_token');
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) { localStorage.removeItem('customer_token'); return null; }
    return payload;
  } catch { return null; }
}

function logout() {
  localStorage.removeItem('customer_token');
  window.location.href = 'index.html';
}

// ── CART MANAGER ──────────────────────────────────────────────────────────────
const Cart = {
  get() {
    try { return JSON.parse(localStorage.getItem('inl_cart') || '[]'); }
    catch { return []; }
  },
  save(items) {
    localStorage.setItem('inl_cart', JSON.stringify(items));
    Cart.updateBadge();
    Cart.syncToServer(items);
  },
  add(product, size, qty) {
    const items = Cart.get();
    const key = `${product.id}-${size}`;
    const existing = items.find(i => i.key === key);
    if (existing) {
      existing.qty += qty;
    } else {
      items.push({ key, id: product.id, name: product.name, price: product.price, image: product.image, size, qty });
    }
    Cart.save(items);
  },
  remove(key) {
    Cart.save(Cart.get().filter(i => i.key !== key));
  },
  updateQty(key, qty) {
    const items = Cart.get();
    const item = items.find(i => i.key === key);
    if (item) { item.qty = Math.max(1, qty); Cart.save(items); }
  },
  total() {
    return Cart.get().reduce((s, i) => s + i.price * i.qty, 0);
  },
  count() {
    return Cart.get().reduce((s, i) => s + i.qty, 0);
  },
  clear() {
    localStorage.removeItem('inl_cart');
    Cart.updateBadge();
    Cart.syncToServer([]);
  },
  updateBadge() {
    document.querySelectorAll('.cart-count').forEach(el => {
      const n = Cart.count();
      el.textContent = n;
      el.classList.remove('bump');
      void el.offsetWidth;
      if (n > 0) el.classList.add('bump');
    });
  },
  syncToServer(items) {
    const token = localStorage.getItem('customer_token');
    if (!token) return;
    fetch('/customer/cart', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ items })
    }).catch(() => {});
  },
  async loadFromServer() {
    const token = localStorage.getItem('customer_token');
    if (!token) return;
    try {
      const res = await fetch('/customer/cart', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) return;
      const { items } = await res.json();
      if (!items || !items.length) return;
      // Merge server cart with local: server wins for items on both, local-only items preserved
      const local = Cart.get();
      const merged = [...items];
      local.forEach(li => {
        if (!merged.find(m => m.key === li.key)) merged.push(li);
      });
      localStorage.setItem('inl_cart', JSON.stringify(merged));
      Cart.updateBadge();
    } catch {}
  }
};

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, success = true) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    t.innerHTML = `<div class="toast-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span id="toast-msg"></span>`;
    document.body.appendChild(t);
  }
  t.style.borderLeftColor = success ? '#007A3D' : '#E53935';
  t.querySelector('.toast-icon').style.background = success ? 'rgba(0,122,61,0.2)' : 'rgba(229,57,53,0.2)';
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── MINI-CART DRAWER ──────────────────────────────────────────
(function injectMiniCartStyles() {
  if (document.getElementById('mini-cart-styles')) return;
  const style = document.createElement('style');
  style.id = 'mini-cart-styles';
  style.textContent = `
    .mc-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:900;opacity:0;pointer-events:none;transition:opacity 0.3s; }
    .mc-overlay.open { opacity:1;pointer-events:all; }
    .mc-drawer { position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);background:#111;border-left:1px solid #1e1e1e;z-index:901;transform:translateX(100%);transition:transform 0.35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column; }
    .mc-drawer.open { transform:translateX(0); }
    .mc-head { display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid #1e1e1e; }
    .mc-title { font-family:'Inter',sans-serif;font-weight:800;font-size:18px; }
    .mc-close { background:none;border:none;color:#555;font-size:24px;cursor:pointer;line-height:1;padding:4px; }
    .mc-close:hover { color:#fff; }
    .mc-items { flex:1;overflow-y:auto;padding:16px 22px;display:flex;flex-direction:column;gap:14px; }
    .mc-item { display:grid;grid-template-columns:56px 1fr auto;gap:12px;align-items:center; }
    .mc-img { width:56px;height:56px;border-radius:6px;background:#0d0d0d;overflow:hidden; }
    .mc-img img { width:100%;height:100%;object-fit:cover;display:block; }
    .mc-name { font-size:13px;font-weight:600;line-height:1.3; }
    .mc-meta { font-family:'Space Mono',monospace;font-size:9px;color:#555;margin-top:3px; }
    .mc-price { font-family:'Inter',sans-serif;font-weight:800;font-size:16px;white-space:nowrap; }
    .mc-footer { padding:18px 22px;border-top:1px solid #1e1e1e; }
    .mc-subtotal { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px; }
    .mc-subtotal-label { font-family:'Space Mono',monospace;font-size:10px;color:#555;letter-spacing:1px; }
    .mc-subtotal-val { font-family:'Inter',sans-serif;font-weight:800;font-size:22px; }
    .mc-actions { display:flex;flex-direction:column;gap:8px; }
    .mc-empty { text-align:center;padding:60px 20px;color:#444;font-family:'Space Mono',monospace;font-size:12px; }
  `;
  document.head.appendChild(style);
})();

function openMiniCart(highlightKey) {
  let overlay = document.getElementById('mc-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'mc-overlay';
    overlay.className = 'mc-overlay';
    overlay.onclick = closeMiniCart;
    const drawer = document.createElement('div');
    drawer.id = 'mc-drawer';
    drawer.className = 'mc-drawer';
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
  }
  // Render cart contents
  const items = Cart.get();
  const total = Cart.total().toFixed(2);
  const drawer = document.getElementById('mc-drawer');
  drawer.innerHTML = `
    <div class="mc-head">
      <div class="mc-title">Your Cart <span style="font-family:'Space Mono',monospace;font-size:11px;color:#555;font-weight:400;margin-left:6px;">${items.reduce((s,i)=>s+i.qty,0)} item${items.length!==1?'s':''}</span></div>
      <button class="mc-close" onclick="closeMiniCart()">×</button>
    </div>
    <div class="mc-items">
      ${items.length === 0
        ? '<div class="mc-empty">Your cart is empty</div>'
        : items.map(item => `
          <div class="mc-item" style="${item.key===highlightKey?'background:rgba(0,122,61,0.06);border-radius:8px;padding:6px;margin:-6px;':''}">
            <div class="mc-img"><img src="${item.image||''}" alt="${item.name||''}"/></div>
            <div>
              <div class="mc-name">${item.name||''}</div>
              <div class="mc-meta">${item.size} · Qty ${item.qty}</div>
            </div>
            <div class="mc-price">AED ${(item.price*item.qty).toFixed(2)}</div>
          </div>`).join('')
      }
    </div>
    ${items.length > 0 ? `
    <div class="mc-footer">
      <div class="mc-subtotal">
        <span class="mc-subtotal-label">SUBTOTAL</span>
        <span class="mc-subtotal-val">AED ${total}</span>
      </div>
      <div class="mc-actions">
        <a href="checkout.html" class="btn-primary" style="text-decoration:none;text-align:center;padding:14px;font-size:13px;">Checkout →</a>
        <a href="cart.html" class="btn-secondary" style="text-decoration:none;text-align:center;padding:11px;font-size:12px;">View Cart</a>
      </div>
    </div>` : ''}
  `;
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    drawer.classList.add('open');
  });
  clearTimeout(drawer._autoClose);
  drawer._autoClose = setTimeout(closeMiniCart, 8000);
}

function closeMiniCart() {
  const overlay = document.getElementById('mc-overlay');
  const drawer = document.getElementById('mc-drawer');
  if (overlay) overlay.classList.remove('open');
  if (drawer) { drawer.classList.remove('open'); clearTimeout(drawer._autoClose); }
}

// ── COOKIE CONSENT (UAE PDPL) ─────────────────────────────────
(function initCookieConsent() {
  if (localStorage.getItem('cookie_consent')) return; // Already decided
  // Vercel Analytics is loaded via script tag; we wrap it in consent
  document.addEventListener('DOMContentLoaded', function () {
    if (localStorage.getItem('cookie_consent')) return;
    const banner = document.createElement('div');
    banner.id = 'cookie-banner';
    banner.innerHTML = `
      <style>
        #cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#111;border-top:1px solid #1e1e1e;padding:16px 24px;z-index:9999;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
        #cookie-banner p{flex:1;font-size:12px;color:#888;margin:0;line-height:1.6;min-width:200px;}
        #cookie-banner a{color:#aaa;text-decoration:underline;}
        .cb-btns{display:flex;gap:8px;flex-shrink:0;}
        .cb-accept{background:#E53935;color:#fff;border:none;padding:9px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Space Mono',monospace;letter-spacing:0.05em;}
        .cb-decline{background:transparent;color:#555;border:1px solid #333;padding:9px 16px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Space Mono',monospace;}
        .cb-decline:hover{color:#888;border-color:#555;}
      </style>
      <p>We use cookies and anonymous analytics to improve your experience. By continuing you agree to our <a href="/privacy-policy.html">Privacy Policy</a>. UAE PDPL compliant.</p>
      <div class="cb-btns">
        <button class="cb-decline" onclick="setCookieConsent('essential')">Essential Only</button>
        <button class="cb-accept" onclick="setCookieConsent('all')">Accept All</button>
      </div>
    `;
    document.body.appendChild(banner);
  });
})();

function _syncConsentToServer(choice) {
  const token = localStorage.getItem('customer_token');
  if (!token) return; // not logged in — will sync at next login
  fetch('/customer/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ consent: choice })
  }).catch(() => {}); // fire-and-forget, non-critical
}

function setCookieConsent(choice) {
  localStorage.setItem('cookie_consent', choice);
  const banner = document.getElementById('cookie-banner');
  if (banner) banner.remove();
  // If they declined analytics, disable Vercel Analytics beacon
  if (choice === 'essential') {
    window.va = function() {}; // no-op the analytics queue
  }
  // Persist to server if a customer is logged in
  _syncConsentToServer(choice);
}

// ── LOGO SVG ─────────────────────────────────────────────────
const LOGO_SVG = `<svg viewBox="0 0 28 28" fill="none"><path d="M22 5C18 5 8 10 6 22C10 18 14 16 22 5Z" fill="#E53935"/><path d="M22 5C22 5 20 14 12 22C16 22 20 18 22 5Z" fill="#B71C1C"/></svg>`;
const LOGO_IMG = `<img src="/images/linkist-white.png" alt="Linkist" style="height:28px;width:auto;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/><span style="display:none">${LOGO_SVG}</span>`;

// ── NAV HTML ──────────────────────────────────────────────────
const CART_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`;

function renderNav(activePage) {
  const customer = getCustomer();
  const firstName = customer?.name?.split(' ')[0] || 'You';

  // Desktop links
  const desktopAuth = customer
    ? `<a href="account.html" class="nav-link" style="color:var(--white)">Hi ${firstName}</a>
       <a href="account.html" class="nav-link">My Orders</a>
       <a href="#" class="nav-link" onclick="logout();return false;" style="color:var(--accent)">Logout</a>`
    : `<a href="account-login.html" class="nav-link">Login</a>`;

  // Mobile drawer links
  const drawerAuth = customer
    ? `<a href="account.html">Hi ${firstName}</a>
       <a href="account.html">My Orders</a>
       <button class="drawer-logout" onclick="logout()">Logout</button>`
    : `<a href="account-login.html">Login</a>`;

  return `<nav id="main-nav">
    <a href="index.html" class="nav-logo">${LOGO_IMG}</a>
    <div class="nav-right">
      <a href="collection.html" class="nav-link nav-collection-link ${activePage==='collection'?'active':''}">Collection</a>
      ${desktopAuth}
      <a href="cart.html" class="cart-btn">${CART_ICON}<span>CART</span><div class="cart-count">0</div></a>
    </div>
    <div class="nav-mobile-bar">
      <a href="account-login.html" class="nav-link" style="font-size:11px;">${customer ? `Hi ${firstName}` : 'Login'}</a>
      <a href="cart.html" class="cart-btn" style="padding:6px 10px 6px 8px;">${CART_ICON}<div class="cart-count">0</div></a>
      <button class="nav-hamburger" onclick="toggleNavDrawer()" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>
  <div class="nav-drawer" id="nav-drawer">
    <a href="collection.html">Collection</a>
    ${drawerAuth}
  </div>`;
}

function toggleNavDrawer() {
  var nav = document.getElementById('main-nav');
  var drawer = document.getElementById('nav-drawer');
  if (!nav || !drawer) return;
  nav.classList.toggle('menu-open');
  drawer.classList.toggle('open');
}

// ── FOOTER HTML ───────────────────────────────────────────────
function renderFooter() {
  return `
  <footer>
    <a href="index.html" class="footer-logo">${LOGO_IMG}</a>
    <div class="footer-tags">
      <span class="footer-tag">#WeStandWithUAE</span>
      <span class="footer-tag">#BornInTheUAE</span>
    </div>
    <div class="footer-right">linkist.ai · April 2026<br>Limited Edition</div>
    <div class="footer-legal">
      <a href="privacy-policy.html">Privacy Policy</a>
      <a href="terms-conditions.html">Terms &amp; Conditions</a>
      <a href="refund-policy.html">Refund Policy</a>
      <a href="mailto:hello@linkist.ai">Contact</a>
    </div>
  </footer>`;
}

// ── STOCK LOADER ──────────────────────────────────────────────
async function loadProductStock(productId, sizeGridEl) {
  try {
    const res = await fetch('/products');
    const products = await res.json();
    const product = products.find(p => p.id === productId);
    if (!product?.stock) return;
    const stock = product.stock;
    sizeGridEl.querySelectorAll('.sz').forEach(btn => {
      const size = btn.dataset.size;
      const qty = stock[size] ?? 0;
      if (qty === 0) {
        btn.classList.add('sold-out');
        btn.disabled = true;
        btn.title = 'Sold Out';
      } else if (qty < 5) {
        btn.setAttribute('data-stock-warn', `Only ${qty} left`);
      }
    });
    // Add tooltips for low stock
    const style = document.createElement('style');
    style.textContent = `.sz[data-stock-warn]::after{content:attr(data-stock-warn);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#C8102E;color:#fff;font-size:9px;padding:2px 6px;border-radius:3px;white-space:nowrap;margin-bottom:4px;pointer-events:none;} .sz{position:relative;}`;
    document.head.appendChild(style);
  } catch (e) {
    console.warn('Could not load stock:', e.message);
  }
}

// ── PRODUCT CATALOGUE ─────────────────────────────────────────
const PRODUCTS = [
  {
    id: 'circle',
    name: 'Circle Edition',
    tagline: 'The original statement piece',
    tag: 'DESIGN 01 · STATEMENT',
    price: 97.1,
    originalPrice: 149,
    badge: 'BESTSELLER',
    page: 'circle-edition-t-shirt.html',
    image: '/images/Linkist%2001.png',
    description: 'A bold circular arc in UAE flag colors frames the words that say everything — <em>I Never Left</em>. Worn by those who stayed when it mattered most.',
    details: ['Dri-Fit performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop']
  },
  {
    id: 'smile',
    name: 'Smile Edition',
    tagline: 'Quiet pride, loud message',
    tag: 'DESIGN 02 · SUBTLE',
    price: 97.1,
    originalPrice: 149,
    badge: 'NEW',
    page: 'smile-edition-t-shirt.html',
    image: '/images/Linkist%2002.png',
    description: 'A minimalist smile arc drawn in UAE flag colors sits above the words <em>I Never Left</em>. Subtle enough for everyday wear, meaningful enough to start a conversation.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop']
  },
  {
    id: 'stripe',
    name: 'Stripe Edition',
    tagline: 'Clean, wearable, timeless',
    tag: 'DESIGN 03 · CLASSIC',
    price: 97.1,
    originalPrice: 149,
    badge: null,
    page: 'stripe-edition-t-shirt.html',
    image: '/images/Linkist%2003.png',
    description: 'Three lines in UAE flag colors underline the statement <em>I Never Left</em>. A classic design for those who carry their roots without making noise.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop']
  },
  {
    id: 'stealth',
    name: 'Stealth Edition',
    tagline: 'For those who know',
    tag: 'DESIGN 04 · PREMIUM',
    price: 169,
    originalPrice: 199,
    badge: 'PREMIUM',
    page: 'stealth-edition-t-shirt.html',
    image: '/images/Linkist%2004.png',
    description: 'Ultra-minimal tone-on-tone typography with a subtle diagonal texture. <em>I Never Left</em> rendered almost invisible against the black. No noise. Just conviction.',
    details: ['Premium cotton fabric','Unisex fit — true to size','Crew neck, short sleeve','Subtle diagonal texture detail','100% proceeds to UAE relief','Limited April 2026 drop']
  }
];

const SIZES = ['XS','S','M','L','XL','XXL'];

// Init badge and sync cart on load
document.addEventListener('DOMContentLoaded', () => {
  Cart.updateBadge();
  Cart.loadFromServer();
});
