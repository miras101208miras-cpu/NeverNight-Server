/* ============================================================
   NeverNight Server — онлайн-сервисы EcosystemNever
   Запуск:  npm start   (или node server.js)
   Адрес:   http://localhost:3000
   Сервисы:
     /            — портфолио (статика)
     /chat        — NeverChat: анонимный чат (Socket.IO)
     /guestbook   — NeverGuestbook: гостевая книга
     /wall        — NeverWall: стена идей с голосованием
     /status      — NeverPing: мониторинг сервисов экосистемы
   Хранение: SQLite (data/nevernight.db)
   ============================================================ */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- База данных ----------
const db = new Database(path.join(DATA_DIR, 'nevernight.db'));
db.pragma.journal_mode = 'WAL';
db.exec(`
  CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL DEFAULT 'main',
    nick TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#00f0ff',
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guestbook (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'Гость',
    votes INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS idea_votes (
    idea_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    PRIMARY KEY (idea_id, ip)
  );
`);

// ---------- Веб-сервер ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

// Статика: всё портфолио (index.html + demos/)
app.use(express.static(ROOT));

// Мелкая защита от спама в API
const rate = new Map();
function limited(ip, key, ms) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter((t) => now - t < ms);
  if (arr.length >= 5) { rate.set(ip, arr); return true; }
  arr.push(now);
  rate.set(ip, arr);
  return false;
}
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ============================================================
//  Telegram-уведомления (идеи, записи гостевой книги)
//  Токен и chat_id берутся из переменных окружения или secret.json
//  (secret.json в .gitignored — в репозиторий не попадает)
// ============================================================
let secret = {};
try { secret = require('./secret.json'); } catch { secret = {}; }
const TG_TOKEN = process.env.TG_TOKEN || secret.tgToken || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || secret.tgChatId || '';

async function notifyTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return; // уведомления не настроены — тихо пропускаем
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) {
    console.error('Telegram-уведомление не отправлено:', e.message);
  }
}

// ============================================================
//  NeverGuestbook — гостевая книга
// ============================================================
app.get('/guestbook', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'guestbook.html')));

app.get('/api/guestbook', (_req, res) => {
  const rows = db.prepare('SELECT id, name, text, ts FROM guestbook ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});

app.post('/api/guestbook', (req, res) => {
  const ip = req.ip || 'local';
  if (limited(ip, 'gb', 30000)) return res.status(429).json({ error: 'Слишком часто. Подожди 30 секунд.' });
  const name = clean(req.body.name, 24);
  const text = clean(req.body.text, 500);
  if (!name || !text) return res.status(400).json({ error: 'Имя и текст обязательны.' });
  const info = db.prepare('INSERT INTO guestbook (name, text, ts) VALUES (?,?,?)')
    .run(name, text, Date.now());
  notifyTelegram(
    `📖 <b>Запись в гостевой книге!</b>\n\n` +
    `${escapeHtml(name)}: «${escapeHtml(text)}»`
  );
  res.json({ id: info.lastInsertRowid, name, text, ts: Date.now() });
});

// ============================================================
//  NeverWall — стена идей с голосованием
// ============================================================
app.get('/wall', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'wall.html')));

app.get('/api/wall', (_req, res) => {
  const rows = db.prepare('SELECT id, text, author, votes, ts FROM ideas ORDER BY votes DESC, id DESC LIMIT 60').all();
  res.json(rows);
});

app.post('/api/wall', (req, res) => {
  const ip = req.ip || 'local';
  if (limited(ip, 'wall', 60000)) return res.status(429).json({ error: 'Идею можно добавлять раз в минуту.' });
  const text = clean(req.body.text, 200);
  const author = clean(req.body.author, 20) || 'Гость';
  if (!text) return res.status(400).json({ error: 'Напиши идею.' });
  const info = db.prepare('INSERT INTO ideas (text, author, votes, ts) VALUES (?,?,0,?)')
    .run(text, author, Date.now());
  notifyTelegram(
    `💡 <b>Новая идея на NeverWall!</b>\n\n` +
    `«${escapeHtml(text)}»\n\n` +
    `— ${escapeHtml(author)}`
  );
  res.json({ id: info.lastInsertRowid, text, author, votes: 0, ts: Date.now() });
});

app.post('/api/wall/:id/vote', (req, res) => {
  const id = Number(req.params.id);
  const ip = req.ip || 'local';
  const idea = db.prepare('SELECT id FROM ideas WHERE id = ?').get(id);
  if (!idea) return res.status(404).json({ error: 'Идея не найдена.' });
  const voted = db.prepare('SELECT 1 FROM idea_votes WHERE idea_id = ? AND ip = ?').get(id, ip);
  if (voted) {
    db.prepare('UPDATE idea_votes SET ip = ip WHERE 0').run(); // no-op, просто держим транзакцию
    db.prepare('UPDATE ideas SET votes = votes - 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM idea_votes WHERE idea_id = ? AND ip = ?').run(id, ip);
    const row = db.prepare('SELECT votes FROM ideas WHERE id = ?').get(id);
    return res.json({ votes: row.votes, voted: false });
  }
  db.prepare('INSERT INTO idea_votes (idea_id, ip) VALUES (?,?)').run(id, ip);
  db.prepare('UPDATE ideas SET votes = votes + 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT votes FROM ideas WHERE id = ?').get(id);
  res.json({ votes: row.votes, voted: true });
});

// ============================================================
//  Админ-панель — все идеи и записи в одном месте
// ============================================================
app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'admin.html')));

app.get('/api/admin/all', (_req, res) => {
  const ideas = db.prepare('SELECT id, text, author, votes, ts FROM ideas ORDER BY ts DESC').all();
  const guestbook = db.prepare('SELECT id, name, text, ts FROM guestbook ORDER BY ts DESC').all();
  res.json({ ideas, guestbook });
});

app.delete('/api/admin/idea/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM idea_votes WHERE idea_id = ?').run(id);
  db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/admin/guestbook/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM guestbook WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============================================================
//  NeverPing — мониторинг сервисов экосистемы
// ============================================================
const TARGETS = [
  { name: 'EcosystemNever',        url: 'https://miras101208miras-cpu.github.io/EcosystemNever/' },
  { name: 'NeverProduct: DS',      url: 'https://miras101208miras-cpu.github.io/NeverProduct-Demon-Slayer/' },
  { name: 'NeverParty',            url: 'https://miras101208miras-cpu.github.io/EcosystemNever/party/index.html' },
  { name: 'Telegram-бот',          url: 'https://t.me/ecosystem_never_bot' },
  { name: 'GitHub',                url: 'https://github.com/miras101208miras-cpu' },
  { name: 'NeverNight (локально)', url: `http://localhost:${PORT}/` }
];
let lastCheck = [];

async function checkAll() {
  const results = await Promise.all(TARGETS.map(async (t) => {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(t.url, { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      return { name: t.name, url: t.url, ok: r.status < 400, code: r.status, ms: Date.now() - started };
    } catch {
      return { name: t.name, url: t.url, ok: false, code: 0, ms: Date.now() - started };
    }
  }));
  lastCheck = results;
  return results;
}

app.get('/status', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'status.html')));

app.get('/api/status', async (_req, res) => {
  const results = lastCheck.length ? lastCheck : await checkAll();
  res.json({ checkedAt: Date.now(), services: results });
});
app.post('/api/status/refresh', async (_req, res) => {
  const results = await checkAll();
  res.json({ checkedAt: Date.now(), services: results });
});
setInterval(checkAll, 60 * 1000); // авто-проверка раз в минуту

// ============================================================
//  NeverChat — анонимный чат (Socket.IO)
// ============================================================
app.get('/chat', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'chat.html')));

const rooms = new Map(); // room -> Map(socketId -> {nick, color})

function onlineList(room) {
  return [...(rooms.get(room)?.values() || [])];
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  socket.on('join', ({ nick, color, room: r } = {}) => {
    room = clean(r, 24) || 'main';
    me = {
      nick: clean(nick, 20) || 'Гость',
      color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#00f0ff'
    };
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room).set(socket.id, me);
    socket.join(room);

    const history = db.prepare(
      'SELECT nick, color, text, ts FROM chat WHERE room = ? ORDER BY id DESC LIMIT 50'
    ).all(room).reverse();
    socket.emit('history', history);
    io.to(room).emit('online', onlineList(room));
    io.to(room).emit('system', { text: `${me.nick} подключился(ась) к комнате «${room}»`, ts: Date.now() });
  });

  socket.on('msg', (text) => {
    text = clean(text, 500);
    if (!room || !me || !text) return;
    const ts = Date.now();
    db.prepare('INSERT INTO chat (room, nick, color, text, ts) VALUES (?,?,?,?,?)')
      .run(room, me.nick, me.color, text, ts);
    io.to(room).emit('msg', { nick: me.nick, color: me.color, text, ts });
  });

  socket.on('typing', (isTyping) => {
    if (room && me) socket.to(room).emit('typing', { nick: me.nick, typing: !!isTyping });
  });

  socket.on('disconnect', () => {
    if (room && me) {
      rooms.get(room)?.delete(socket.id);
      io.to(room).emit('online', onlineList(room));
      io.to(room).emit('system', { text: `${me.nick} вышел(ла)`, ts: Date.now() });
    }
  });
});

// ---------- Запуск ----------
server.listen(PORT, () => {
  console.log('');
  console.log('  ███╗   ██╗██╗██████╗ ███████╗███████╗██████╗ ███╗   ██╗');
  console.log('  ████╗  ██║██║██╔══██╗██╔════╝██╔════╝██╔══██╗████╗  ██║');
  console.log('  ██╔██╗ ██║██║██████╔╝█████╗  █████╗  ██████╔╝██╔██╗ ██║');
  console.log('  ██║╚██╗██║██║██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██║╚██╗██║');
  console.log('  ██║ ╚████║██║██║  ██║███████╗███████╗██║  ██║██║ ╚████║');
  console.log('  ╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝');
  console.log('');
  console.log(`  ✅ NeverNight Server запущен:  http://localhost:${PORT}`);
  console.log(`  💬 NeverChat:        http://localhost:${PORT}/chat`);
  console.log(`  📖 NeverGuestbook:   http://localhost:${PORT}/guestbook`);
  console.log(`  📝 NeverWall:        http://localhost:${PORT}/wall`);
  console.log(`  📡 NeverPing:        http://localhost:${PORT}/status`);
  console.log('');
  checkAll();
});
