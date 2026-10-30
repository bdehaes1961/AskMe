'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('askme:' + ADMIN_PASSWORD).digest('hex');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is niet gezet. Stop.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'askme.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_open INTEGER NOT NULL DEFAULT 1,
  ask_email INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('single','multi','scale','rank')),
  text TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  scale_max INTEGER
);
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (poll_id, voter)
);
CREATE TABLE IF NOT EXISTS answers (
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (response_id, question_id)
);
`);

// ---------- helpers ----------
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newId(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const SESSION_VALUE = 'admin.' + sign('admin');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAdmin(req) {
  const v = parseCookies(req).askme_session || '';
  const a = Buffer.from(v), b = Buffer.from(SESSION_VALUE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Niet ingelogd' });
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

function loadPoll(id) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return null;
  poll.questions = db
    .prepare('SELECT * FROM questions WHERE poll_id = ? ORDER BY position')
    .all(id)
    .map((q) => ({ id: q.id, type: q.type, text: q.text, options: JSON.parse(q.options), scale_max: q.scale_max }));
  poll.is_open = !!poll.is_open;
  poll.ask_email = !!poll.ask_email;
  return poll;
}
const responseCount = (id) => db.prepare('SELECT COUNT(*) n FROM responses WHERE poll_id = ?').get(id).n;

function validateQuestions(qs) {
  if (!Array.isArray(qs) || qs.length === 0) return 'Minstens één vraag nodig';
  if (qs.length > 50) return 'Maximaal 50 vragen';
  for (const [i, q] of qs.entries()) {
    const n = `Vraag ${i + 1}`;
    if (!['single', 'multi', 'scale', 'rank'].includes(q.type)) return `${n}: ongeldig type`;
    if (!q.text || !String(q.text).trim()) return `${n}: tekst ontbreekt`;
    if (q.type === 'scale') {
      if (![5, 10].includes(Number(q.scale_max))) return `${n}: schaal moet 1–5 of 1–10 zijn`;
    } else {
      const opts = (q.options || []).map((o) => String(o).trim()).filter(Boolean);
      if (opts.length < 2) return `${n}: minstens 2 opties`;
      if (opts.length > 10) return `${n}: maximaal 10 opties`;
      if (new Set(opts).size !== opts.length) return `${n}: dubbele opties`;
    }
  }
  return null;
}

function results(pollId) {
  const poll = loadPoll(pollId);
  if (!poll) return null;
  const total = responseCount(pollId);
  const getAnswers = db.prepare('SELECT value FROM answers WHERE question_id = ?');
  const out = poll.questions.map((q) => {
    const vals = getAnswers.all(q.id).map((r) => JSON.parse(r.value));
    const base = { id: q.id, type: q.type, text: q.text, answered: vals.length };
    if (q.type === 'single' || q.type === 'multi') {
      const counts = q.options.map(() => 0);
      vals.forEach((v) => (Array.isArray(v) ? v : [v]).forEach((i) => { if (counts[i] !== undefined) counts[i]++; }));
      return { ...base, options: q.options.map((label, i) => ({ label, count: counts[i] })) };
    }
    if (q.type === 'scale') {
      const dist = Array.from({ length: q.scale_max }, () => 0);
      let sum = 0;
      vals.forEach((v) => { if (dist[v - 1] !== undefined) { dist[v - 1]++; sum += v; } });
      return { ...base, scale_max: q.scale_max, distribution: dist, average: vals.length ? sum / vals.length : null };
    }
    // rank: Borda points (n-1 for #1 … 0 for last) and average position
    const n = q.options.length;
    const pts = q.options.map(() => 0), pos = q.options.map(() => 0);
    vals.forEach((order) => order.forEach((optIdx, rank) => {
      if (pts[optIdx] === undefined) return;
      pts[optIdx] += n - 1 - rank; pos[optIdx] += rank + 1;
    }));
    const items = q.options.map((label, i) => ({
      label, points: pts[i], avg_position: vals.length ? pos[i] / vals.length : null,
    }));
    items.sort((a, b) => b.points - a.points);
    return { ...base, max_points: (n - 1) * vals.length, items };
  });
  return { id: poll.id, title: poll.title, is_open: poll.is_open, total, questions: out };
}

// ---------- live (SSE) ----------
const streams = new Map(); // pollId -> Set<res>
function broadcast(pollId) {
  const set = streams.get(pollId);
  if (!set || !set.size) return;
  const payload = `data: ${JSON.stringify(results(pollId))}\n\n`;
  set.forEach((res) => res.write(payload));
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin'); if (!req.path.includes('.')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// auth
const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Te veel pogingen, probeer later opnieuw' });
  const given = Buffer.from(sign(String(req.body.password || '')));
  const want = Buffer.from(sign(ADMIN_PASSWORD));
  if (!crypto.timingSafeEqual(given, want)) {
    a.n++; loginAttempts.set(ip, a);
    return res.status(401).json({ error: 'Onjuist wachtwoord' });
  }
  loginAttempts.delete(ip);
  const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `askme_session=${SESSION_VALUE}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'askme_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req) }));

// admin: polls
app.get('/api/polls', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.is_open, p.created_at,
      (SELECT COUNT(*) FROM questions q WHERE q.poll_id = p.id) AS questions,
      (SELECT COUNT(*) FROM responses r WHERE r.poll_id = p.id) AS responses
    FROM polls p ORDER BY p.created_at DESC`).all();
  res.json(rows.map((r) => ({ ...r, is_open: !!r.is_open })));
});

app.get('/api/polls/:id', requireAdmin, (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Niet gevonden' });
  res.json({ ...poll, responses: responseCount(poll.id), url: `${baseUrl(req)}/p/${poll.id}` });
});

function writeQuestions(pollId, qs) {
  db.prepare('DELETE FROM questions WHERE poll_id = ?').run(pollId);
  const ins = db.prepare('INSERT INTO questions (poll_id, position, type, text, options, scale_max) VALUES (?,?,?,?,?,?)');
  qs.forEach((q, i) => {
    const opts = q.type === 'scale' ? [] : q.options.map((o) => String(o).trim()).filter(Boolean);
    ins.run(pollId, i, q.type, String(q.text).trim(), JSON.stringify(opts), q.type === 'scale' ? Number(q.scale_max) : null);
  });
}

app.post('/api/polls', requireAdmin, (req, res) => {
  const { title, description = '', ask_email = true, questions } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Titel ontbreekt' });
  const err = validateQuestions(questions);
  if (err) return res.status(400).json({ error: err });
  let id;
  do { id = newId(); } while (db.prepare('SELECT 1 FROM polls WHERE id = ?').get(id));
  db.transaction(() => {
    db.prepare('INSERT INTO polls (id, title, description, ask_email) VALUES (?,?,?,?)')
      .run(id, String(title).trim(), String(description).trim(), ask_email ? 1 : 0);
    writeQuestions(id, questions);
  })();
  res.json({ id });
});

app.put('/api/polls/:id', requireAdmin, (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Niet gevonden' });
  const { title, description = '', ask_email = true, questions } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Titel ontbreekt' });
  const hasResponses = responseCount(poll.id) > 0;
  if (questions && !hasResponses) {
    const err = validateQuestions(questions);
    if (err) return res.status(400).json({ error: err });
  }
  db.transaction(() => {
    db.prepare('UPDATE polls SET title = ?, description = ?, ask_email = ? WHERE id = ?')
      .run(String(title).trim(), String(description).trim(), ask_email ? 1 : 0, poll.id);
    if (questions && !hasResponses) writeQuestions(poll.id, questions);
  })();
  res.json({ ok: true, questions_locked: hasResponses });
});

app.post('/api/polls/:id/state', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE polls SET is_open = ? WHERE id = ?').run(req.body.open ? 1 : 0, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Niet gevonden' });
  broadcast(req.params.id);
  res.json({ ok: true });
});

app.post('/api/polls/:id/reset', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM responses WHERE poll_id = ?').run(req.params.id);
  broadcast(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/polls/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM polls WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/polls/:id/results', requireAdmin, (req, res) => {
  const r = results(req.params.id);
  if (!r) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(r);
});

app.get('/api/polls/:id/stream', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!loadPoll(id)) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify(results(id))}\n\n`);
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => { clearInterval(ping); streams.get(id)?.delete(res); });
});

app.get('/api/polls/:id/qr.svg', requireAdmin, async (req, res) => {
  const url = `${baseUrl(req)}/p/${req.params.id}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#404040', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

app.get('/api/polls/:id/export.csv', requireAdmin, (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).end();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['response_id', 'tijdstip', 'email', ...poll.questions.map((q) => q.text)];
  const lines = [header.map(esc).join(',')];
  const resps = db.prepare('SELECT * FROM responses WHERE poll_id = ? ORDER BY id').all(poll.id);
  const ans = db.prepare('SELECT question_id, value FROM answers WHERE response_id = ?');
  for (const r of resps) {
    const map = new Map(ans.all(r.id).map((a) => [a.question_id, JSON.parse(a.value)]));
    const cells = poll.questions.map((q) => {
      const v = map.get(q.id);
      if (v === undefined) return '';
      if (q.type === 'single') return q.options[v];
      if (q.type === 'multi') return v.map((i) => q.options[i]).join('; ');
      if (q.type === 'scale') return v;
      return v.map((i, k) => `${k + 1}. ${q.options[i]}`).join(' | ');
    });
    lines.push([r.id, r.created_at, r.email || '', ...cells].map(esc).join(','));
  }
  res.setHeader('Content-Disposition', `attachment; filename="askme-${poll.id}.csv"`);
  res.type('text/csv; charset=utf-8').send('﻿' + lines.join('\r\n'));
});

// public: participant
app.get('/api/public/:id', (req, res) => {
  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Deze vragenlijst bestaat niet' });
  res.json({
    id: poll.id, title: poll.title, description: poll.description,
    is_open: poll.is_open, ask_email: poll.ask_email, voted: typeof req.query.voter === 'string' && !!db.prepare('SELECT 1 FROM responses WHERE poll_id = ? AND voter = ?').get(poll.id, req.query.voter),
    questions: poll.questions,
  });
});

const submitWindow = new Map();
app.post('/api/public/:id/submit', (req, res) => {
  // light per-IP throttle: 30 submissions / 10 min (events share wifi, so generous)
  const now = Date.now(), key = req.ip + ':' + req.params.id;
  const w = (submitWindow.get(key) || []).filter((t) => now - t < 10 * 60e3);
  if (w.length >= 30) return res.status(429).json({ error: 'Te veel inzendingen vanaf dit netwerk' });

  const poll = loadPoll(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Deze vragenlijst bestaat niet' });
  if (!poll.is_open) return res.status(403).json({ error: 'Stemmen is gesloten' });

  const { voter, email, answers } = req.body || {};
  if (!voter || typeof voter !== 'string' || voter.length < 16 || voter.length > 64) return res.status(400).json({ error: 'Ongeldig verzoek' });
  let mail = null;
  if (email && String(email).trim()) {
    mail = String(email).trim().toLowerCase();
    if (mail.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Ongeldig e-mailadres' });
  }
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Geen antwoorden' });

  const clean = [];
  for (const q of poll.questions) {
    const v = answers[q.id];
    const n = q.options.length;
    const isIdx = (x) => Number.isInteger(x) && x >= 0 && x < n;
    if (q.type === 'single') {
      if (!isIdx(v)) return res.status(400).json({ error: `Beantwoord: “${q.text}”` });
      clean.push([q.id, v]);
    } else if (q.type === 'multi') {
      if (!Array.isArray(v) || !v.length || !v.every(isIdx) || new Set(v).size !== v.length)
        return res.status(400).json({ error: `Beantwoord: “${q.text}”` });
      clean.push([q.id, [...v].sort((a, b) => a - b)]);
    } else if (q.type === 'scale') {
      if (!Number.isInteger(v) || v < 1 || v > q.scale_max) return res.status(400).json({ error: `Beantwoord: “${q.text}”` });
      clean.push([q.id, v]);
    } else {
      if (!Array.isArray(v) || v.length !== n || !v.every(isIdx) || new Set(v).size !== n)
        return res.status(400).json({ error: `Ongeldige rangschikking bij “${q.text}”` });
      clean.push([q.id, v]);
    }
  }

  try {
    db.transaction(() => {
      const r = db.prepare('INSERT INTO responses (poll_id, voter, email) VALUES (?,?,?)')
        .run(poll.id, voter, poll.ask_email ? mail : null);
      const ins = db.prepare('INSERT INTO answers (response_id, question_id, value) VALUES (?,?,?)');
      clean.forEach(([qid, val]) => ins.run(r.lastInsertRowid, qid, JSON.stringify(val)));
    })();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Je hebt al gestemd' });
    throw e;
  }
  w.push(now); submitWindow.set(key, w);
  broadcast(poll.id);
  res.json({ ok: true });
});

// pages
const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AskMe</title><link rel="stylesheet" href="/style.css"><style>body{display:grid;place-items:center;min-height:100vh;text-align:center;padding:20px;user-select:none;-webkit-user-select:none}#b{-webkit-appearance:none;appearance:none;font:inherit;font-weight:600;font-size:20px;color:inherit;background:none;border:0;padding:12px 24px;-webkit-touch-callout:none;touch-action:none;-webkit-tap-highlight-color:transparent;cursor:default}#b::before{content:"AskMe"}</style><div><button id="b" type="button" aria-label="AskMe"></button><p class="muted">Scan de QR-code om mee te doen.</p></div><script>let n=0,t;const b=document.getElementById("b");const hit=e=>{e.preventDefault();clearTimeout(t);t=setTimeout(()=>n=0,1500);if(++n>=5)location.href="/admin"};b.addEventListener("touchstart",hit,{passive:false});b.addEventListener("mousedown",hit);</script>'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/present/:id', (req, res) => res.sendFile(path.join(pub, 'present.html')));
app.get('/qr/:id', async (req, res) => { if (!isAdmin(req)) return res.redirect('/admin?next=' + encodeURIComponent(req.path)); const poll = loadPoll(req.params.id); if (!poll) return res.status(404).send('Niet gevonden'); const svg = await QRCode.toString(`${baseUrl(req)}/p/${poll.id}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#404040', light: '#ffffff' } }); const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR · ${esc(poll.title)}</title><link rel="stylesheet" href="/style.css"><style>body{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:24px;text-align:center}.q{width:min(86vw,70vh)}.q svg{width:100%;height:auto;display:block}h1{font-size:22px}a{color:var(--muted);font-size:14px}</style><h1>${esc(poll.title)}</h1><div class="q">${svg}</div><p class="muted">Scan om mee te doen</p><a href="/admin">← Beheer</a><script>navigator.wakeLock&&navigator.wakeLock.request("screen").catch(()=>{})</script>`); });
app.get('/p/:id', (req, res) => res.sendFile(path.join(pub, 'vote.html')));
app.get('/sw.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
app.use(express.static(pub, { maxAge: '1h', index: false }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Serverfout' });
});

app.listen(PORT, () => console.log(`AskMe draait op :${PORT}`));
