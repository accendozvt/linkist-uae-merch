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
  },
  updateBadge() {
    document.querySelectorAll('.cart-count').forEach(el => {
      const n = Cart.count();
      el.textContent = n;
      el.classList.remove('bump');
      void el.offsetWidth;
      if (n > 0) el.classList.add('bump');
    });
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
    <div class="nav-right" style="display:none" id="nav-mobile-controls">
      <a href="cart.html" class="cart-btn">${CART_ICON}<div class="cart-count">0</div></a>
      <button class="nav-hamburger" onclick="toggleNavDrawer()" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>
  <div class="nav-drawer" id="nav-drawer">
    <a href="collection.html">Collection</a>
    ${drawerAuth}
  </div>
  <script>
    (function(){
      var mq = window.matchMedia('(max-width:768px)');
      function applyMq(e) {
        var mc = document.getElementById('nav-mobile-controls');
        if (mc) mc.style.display = e.matches ? 'flex' : 'none';
      }
      mq.addEventListener ? mq.addEventListener('change', applyMq) : mq.addListener(applyMq);
      applyMq(mq);
    })();
  </script>`;
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
      <span class="footer-tag">#istandwithUAE</span>
      <span class="footer-tag">#borninUAE</span>
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
    price: 149,
    badge: 'BESTSELLER',
    page: 'circle-edition.html',
    image: '/images/Linkist%2001.png',
    description: 'A bold circular arc in UAE flag colors frames the words that say everything — <em>I Never Left</em>. Worn by those who stayed when it mattered most.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop']
  },
  {
    id: 'smile',
    name: 'Smile Edition',
    tagline: 'Quiet pride, loud message',
    tag: 'DESIGN 02 · SUBTLE',
    price: 149,
    badge: 'NEW',
    page: 'smile-edition.html',
    image: '/images/Linkist%2002.png',
    description: 'A minimalist smile arc drawn in UAE flag colors sits above the words <em>I Never Left</em>. Subtle enough for everyday wear, meaningful enough to start a conversation.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','100% proceeds to UAE relief','Limited April 2026 drop']
  },
  {
    id: 'stripe',
    name: 'Stripe Edition',
    tagline: 'Clean, wearable, timeless',
    tag: 'DESIGN 03 · CLASSIC',
    price: 149,
    badge: null,
    page: 'stripe-edition.html',
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
    badge: 'PREMIUM',
    page: 'stealth-edition.html',
    image: '/images/Linkist%2004.png',
    description: 'Ultra-minimal tone-on-tone typography with a subtle diagonal texture. <em>I Never Left</em> rendered almost invisible against the black. No noise. Just conviction.',
    details: ['Premium performance fabric','Unisex fit — true to size','Crew neck, short sleeve','Subtle diagonal texture detail','100% proceeds to UAE relief','Limited April 2026 drop']
  }
];

const SIZES = ['XS','S','M','L','XL','XXL'];

// Init badge on load
document.addEventListener('DOMContentLoaded', () => Cart.updateBadge());
