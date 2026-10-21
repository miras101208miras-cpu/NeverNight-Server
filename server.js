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
  -- Каталог проектов экосистемы (NeverProjects)
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Онлайн',
    sort INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );
  -- Аналитика посещений (NeverStats)
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT NOT NULL DEFAULT '/',
    ref TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL
  );
  -- Рекорды мини-игры (NeverGame)
  CREATE TABLE IF NOT EXISTS game_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Гость',
    score INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL
  );
`);

// ---------- Веб-сервер ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

// Главная — хаб со ссылками на все сервисы (работает и на хостинге)
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'hub.html')));

// Health-check для хостинга / мониторинга
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Общие файлы экосистемы: /style.css и /app.js
app.use(express.static(path.join(__dirname, 'public')));

// Статика: портфолио лежит в родительской папке (при деплое сервера её может не быть)
if (fs.existsSync(ROOT)) {
  app.use(express.static(ROOT));
}

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
//  Защита админ-панели паролем
//  Пароль: ADMIN_PASSWORD (env) или secret.json.adminPassword
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (secret && secret.adminPassword) || 'nevernight';
function requireAdmin(req, res, next) {
  const pass = req.get('x-admin-pass') || req.query.pass || '';
  if (String(pass) !== String(ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  next();
}
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

app.get('/api/admin/all', requireAdmin, (_req, res) => {
  const ideas = db.prepare('SELECT id, text, author, votes, ts FROM ideas ORDER BY ts DESC').all();
  const guestbook = db.prepare('SELECT id, name, text, ts FROM guestbook ORDER BY ts DESC').all();
  const chatCount = db.prepare('SELECT COUNT(*) AS c FROM chat').get().c;
  res.json({ ideas, guestbook, chatCount });
});

// Проверка пароля (для формы входа в админку)
app.get('/api/admin/auth', requireAdmin, (_req, res) => res.json({ ok: true }));

// График активности за 14 дней (идеи / гостевая / чат по дням)
app.get('/api/admin/activity', requireAdmin, (_req, res) => {
  const days = 14;
  const now = Date.now();
  const since = now - (days - 1) * 86400000;
  const map = {};
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86400000);
    map[key] = { day: key, ideas: 0, guestbook: 0, chat: 0 };
  }
  const add = (table, field) => {
    db.prepare(`SELECT ts FROM ${table} WHERE ts >= ?`).all(since)
      .forEach((r) => { const k = dayKey(r.ts); if (map[k]) map[k][field]++; });
  };
  add('ideas', 'ideas'); add('guestbook', 'guestbook'); add('chat', 'chat');
  res.json(Object.values(map));
});

app.delete('/api/admin/idea/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM idea_votes WHERE idea_id = ?').run(id);
  db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/admin/guestbook/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM guestbook WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Страницы новых сервисов ----------
app.get('/projects', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'projects.html')));
app.get('/stats', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'stats.html')));
app.get('/profile', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'profile.html')));
app.get('/about', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'about.html')));
app.get('/game', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'game.html')));

// ============================================================
//  NeverPing — мониторинг сервисов экосистемы
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const TARGETS = [
  { name: 'EcosystemNever',   url: 'https://miras101208miras-cpu.github.io/EcosystemNever/' },
  { name: 'Портфолио',        url: 'https://miras101208miras-cpu.github.io/NeverNight-Portfolio/' },
  { name: 'NeverProduct: DS', url: 'https://miras101208miras-cpu.github.io/NeverProduct-Demon-Slayer/' },
  { name: 'NeverParty',       url: 'https://miras101208miras-cpu.github.io/EcosystemNever/party/index.html' },
  { name: 'NeverChat',        url: `${SELF_URL}/chat` },
  { name: 'NeverWall',        url: `${SELF_URL}/wall` },
  { name: 'NeverGuestbook',   url: `${SELF_URL}/guestbook` },
  { name: 'NeverProjects',    url: `${SELF_URL}/projects` },
  { name: 'NeverStats',       url: `${SELF_URL}/stats` },
  { name: 'NeverGame',        url: `${SELF_URL}/game` },
  { name: 'Telegram-бот',     url: 'https://t.me/ecosystem_never_bot' },
  { name: 'GitHub',           url: 'https://github.com/miras101208miras-cpu' }
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

// ============================================================
//  Аналитика посещений (NeverStats)
// ============================================================
app.post('/api/track', (req, res) => {
  const page = clean(req.body.page, 120) || '/';
  const ref = clean(req.body.ref, 120);
  const ua = String(req.get('user-agent') || '').slice(0, 200);
  const ip = req.ip || 'local';
  db.prepare('INSERT INTO visits (page, ref, ua, ip, ts) VALUES (?,?,?,?,?)')
    .run(page, ref, ua, ip, Date.now());
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const now = Date.now();
  const since = now - (days - 1) * 86400000;
  const map = {};
  for (let i = days - 1; i >= 0; i--) map[dayKey(now - i * 86400000)] = 0;
  db.prepare('SELECT ts FROM visits WHERE ts >= ?').all(since)
    .forEach((r) => { const k = dayKey(r.ts); if (k in map) map[k]++; });

  const total = db.prepare('SELECT COUNT(*) AS c FROM visits').get().c;
  const uniq = db.prepare('SELECT COUNT(DISTINCT ip) AS c FROM visits').get().c;
  const today = map[dayKey(now)] || 0;
  const byRef = db.prepare(
    "SELECT CASE WHEN ref = '' THEN 'прямой заход' ELSE ref END AS ref, COUNT(*) AS c FROM visits GROUP BY ref ORDER BY c DESC LIMIT 8"
  ).all();
  const byPage = db.prepare('SELECT page, COUNT(*) AS c FROM visits GROUP BY page ORDER BY c DESC LIMIT 8').all();
  res.json({
    total, uniq, today,
    series: Object.entries(map).map(([day, c]) => ({ day, c })),
    byRef, byPage
  });
});

// ---------- Каталог проектов (NeverProjects) ----------
app.get('/api/projects', (_req, res) => {
  const rows = db.prepare('SELECT id, name, desc, link, status, ts FROM projects ORDER BY sort DESC, id ASC').all();
  res.json(rows);
});
app.post('/api/admin/projects', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 50);
  const desc = clean(req.body.desc, 200);
  const link = clean(req.body.link, 300);
  const status = clean(req.body.status, 20) || 'Онлайн';
  const sort = Number(req.body.sort) || 0;
  if (!name) return res.status(400).json({ error: 'Название обязательно.' });
  const info = db.prepare('INSERT INTO projects (name, desc, link, status, sort, ts) VALUES (?,?,?,?,?,?)')
    .run(name, desc, link, status, sort, Date.now());
  res.json({ id: info.lastInsertRowid, name, desc, link, status, sort, ts: Date.now() });
});
app.delete('/api/admin/projects/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ============================================================
//  Мини-игра (NeverGame) — таблица рекордов
// ============================================================
app.get('/api/game/scores', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, name, score, level, ts FROM game_scores ORDER BY score DESC, ts ASC LIMIT 20'
  ).all();
  res.json(rows);
});

app.post('/api/game/score', (req, res) => {
  const name = clean(req.body.name, 20) || 'Гость';
  const score = Math.max(0, Math.min(1000000, Number(req.body.score) || 0));
  const level = Math.max(1, Math.min(999, Number(req.body.level) || 1));
  const info = db.prepare('INSERT INTO game_scores (name, score, level, ts) VALUES (?,?,?,?)')
    .run(name, score, level, Date.now());
  const rank = db.prepare('SELECT COUNT(*) AS c FROM game_scores WHERE score > ?').get(score).c + 1;
  res.json({ id: info.lastInsertRowid, name, score, level, rank });
});

app.delete('/api/admin/game/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM game_scores WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ============================================================
//  Модерация чата в админке (комнаты, сообщения, кто онлайн)
// ============================================================
app.get('/api/admin/rooms', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT room FROM chat ORDER BY room').all();
  const online = [...rooms.keys()];
  const all = new Set([...rows.map((r) => r.room), ...online, 'main']);
  res.json([...all]);
});

app.get('/api/admin/chat', requireAdmin, (req, res) => {
  const room = clean(req.query.room, 24) || 'main';
  const rows = db.prepare(
    'SELECT id, room, nick, color, text, ts FROM chat WHERE room = ? ORDER BY id DESC LIMIT 100'
  ).all(room);
  res.json(rows);
});

app.get('/api/admin/online', requireAdmin, (_req, res) => {
  const out = {};
  for (const [room, m] of rooms) out[room] = [...m.values()];
  res.json(out);
});

app.delete('/api/admin/chat/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM chat WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Стартовое наполнение каталога проектов ----------
if (db.prepare('SELECT COUNT(*) AS c FROM projects').get().c === 0) {
  const seed = [
    ['EcosystemNever', 'Главный сайт экосистемы NeverProduct', 'https://miras101208miras-cpu.github.io/EcosystemNever/', 'Онлайн', 10],
    ['NeverNight Portfolio', 'Портфолио NeverNight со всеми проектами и демо', 'https://miras101208miras-cpu.github.io/NeverNight-Portfolio/', 'Онлайн', 9],
    ['Demon Slayer', 'Фан-сайт по «Клинку, рассекающему демонов»', 'https://miras101208miras-cpu.github.io/NeverProduct-Demon-Slayer/', 'Онлайн', 8],
    ['NeverParty', 'Смотровая вечеринка — смотрите вместе', 'https://miras101208miras-cpu.github.io/EcosystemNever/party/index.html', 'Онлайн', 7],
    ['NeverGame', 'Неоновая мини-игра с таблицей рекордов', '/game', 'Онлайн', 7],
    ['NeverChat', 'Анонимный чат в реальном времени', '/chat', 'Бета', 6],
    ['NeverWall', 'Стена идей с голосованием', '/wall', 'Бета', 5],
    ['NeverGuestbook', 'Гостевая книга экосистемы', '/guestbook', 'Бета', 4],
    ['NeverPing', 'Мониторинг сервисов', '/status', 'Бета', 3],
    ['Telegram-бот', 'Бот экосистемы @ecosystem_never_bot', 'https://t.me/ecosystem_never_bot', 'Онлайн', 2]
  ];
  const ins = db.prepare('INSERT INTO projects (name, desc, link, status, sort, ts) VALUES (?,?,?,?,?,?)');
  const t = Date.now();
  seed.forEach((s) => ins.run(s[0], s[1], s[2], s[3], s[4], t));
}

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
