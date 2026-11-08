import { createServer, type Server } from 'node:http';

/**
 * A small local shop that copies the hurdles of the real Vinted login: a cookie banner, a
 * domain modal over it, a sign-up page you have to switch to log-in from, a choice of log-in
 * methods, and a search with listings. It lets the bench check its own plumbing without the
 * network and with a scripted model, so a broken driver shows up before a paid run.
 */

const page = (title: string, body: string, opts: { banner?: boolean } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: sans-serif; margin: 0; }
  header, main, footer { padding: 12px 24px; }
  nav a { margin-right: 12px; }
  #cookies { position: fixed; bottom: 0; left: 0; right: 0; background: #eee; padding: 16px; }
  #domain { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
  #domain > div { background: white; padding: 24px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
</style></head>
<body>
<header>
  <a href="/">Shop</a>
  <form action="/catalog" method="get" role="search">
    <input name="q" aria-label="Search for items" placeholder="Search for items">
    <button type="submit">Search</button>
  </form>
  <nav>${['Women', 'Men', 'Kids', 'Home', 'Electronics', 'Entertainment', 'Hobbies', 'Sports'].map((c) => `<a href="/catalog?c=${c}">${c}</a>`).join('')}
    <a href="/member/signup/select_type">Sign up | Log in</a></nav>
</header>
<main>${body}</main>
<footer>${Array.from({ length: 30 }, (_, i) => `<a href="/help/${i}">Help article ${i}</a>`).join(' ')}</footer>
${
  opts.banner
    ? `<div id="cookies" role="dialog" aria-label="Cookies">
  <p>We use cookies to improve your experience. Choose which ones you allow.</p>
  <button onclick="document.cookie='c=all;path=/';this.parentNode.remove()">Accept all</button>
  <button onclick="document.cookie='c=essential;path=/';this.parentNode.remove()">Choose essential only</button>
  <button>Cookie settings</button>
</div>
<div id="domain" role="dialog" aria-label="Choose your country">
  <div><p>You are on the international site. Pick your country.</p>
  <a href="#">Belgium</a> <a href="#">France</a> <a href="#">Netherlands</a>
  <button aria-label="Close" data-testid="domain-close" onclick="document.getElementById('domain').remove()">×</button></div>
</div>
<script>if (document.cookie.includes('c=')) { document.getElementById('cookies').remove(); }
if (document.cookie.includes('d=')) { document.getElementById('domain').remove(); }
document.querySelector('[data-testid=domain-close]').addEventListener('click', () => document.cookie = 'd=1;path=/');</script>`
    : ''
}
</body></html>`;

const items = Array.from({ length: 24 }, (_, i) => ({
  id: 1000 + i,
  title: i % 3 === 0 ? `Nike Air Max 90 size ${38 + (i % 8)}` : `Item ${i} in good condition`,
  price: (5 + i * 1.5).toFixed(2),
}));

function route(url: URL): { status: number; html: string } {
  const p = url.pathname;
  if (p === '/')
    return {
      status: 200,
      html: page(
        'Shop: buy and sell second-hand',
        `<h1>Ready to declutter?</h1><a href="/items/new">Sell now</a>
         <h2>Popular items</h2><div class="grid">${items
           .map((i) => `<a href="/items/${i.id}">${i.title}<br>€${i.price}</a>`)
           .join('')}</div>`,
        { banner: true },
      ),
    };
  if (p === '/member/signup/select_type')
    return {
      status: 200,
      html: page(
        'Sign up',
        `<h1>Join and sell the clothes you don't wear anymore</h1>
         <button>Continue with Google</button><button>Continue with Apple</button><button>Continue with Facebook</button>
         <p>Or register with <a href="/member/signup/email">email</a></p>
         <p>Already have an account? <a href="/member/login/select_type" data-testid="register-switch">Log in</a></p>`,
        { banner: true },
      ),
    };
  if (p === '/member/login/select_type')
    return {
      status: 200,
      html: page(
        'Log in',
        `<h1>Welcome back!</h1>
         <a href="/auth/google">Continue with Google</a><button>Continue with Apple</button><button>Continue with Facebook</button>
         <p>Or log in with <a href="/member/login/email" data-testid="login-email">email</a></p>
         <p>Don't have an account? <a href="/member/signup/select_type">Sign up</a></p>`,
        { banner: true },
      ),
    };
  if (p === '/member/login/email')
    return {
      status: 200,
      html: page(
        'Log in with email',
        `<h1>Log in</h1><form><label>Email or username <input name="login"></label>
         <label>Password <input name="password" type="password"></label>
         <button type="button">Continue</button></form><a href="#">Forgot your password?</a>`,
        { banner: true },
      ),
    };
  if (p === '/auth/google')
    return {
      status: 200,
      html: page(
        'Sign in - Google Accounts',
        `<h1>Sign in with Google</h1><p>to continue to Shop</p>
         <label>Email or phone <input name="identifier" type="email"></label><button>Next</button>`,
      ),
    };
  if (p === '/catalog') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const found = items.filter((i) => !q || i.title.toLowerCase().includes(q));
    return {
      status: 200,
      html: page(
        `Results for ${q || 'all'}`,
        `<h1>${found.length} results</h1><div class="grid">${found
          .map((i) => `<a href="/items/${i.id}">${i.title}<br>€${i.price}</a>`)
          .join('')}</div>`,
        { banner: true },
      ),
    };
  }
  const item = /^\/items\/(\d+)$/.exec(p);
  if (item) {
    const it = items.find((i) => i.id === Number(item[1]));
    if (it)
      return {
        status: 200,
        html: page(it.title, `<h1>${it.title}</h1><p>€${it.price}</p><button>Buy now</button>`, {
          banner: true,
        }),
      };
  }
  return { status: 404, html: page('Not found', '<h1>Page not found</h1>') };
}

export async function startFixture(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const { status, html } = route(new URL(req.url ?? '/', 'http://localhost'));
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${p}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
