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
  -- История диалогов с ассистентом (Never Assist)
  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    text TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL
  );
  -- Треки плейлиста (NeverMusic)
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
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
app.get('/ai', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'ai.html')));
app.get('/music', (_req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'music.html')));

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
  { name: 'Never Assist',     url: `${SELF_URL}/ai` },
  { name: 'NeverMusic',       url: `${SELF_URL}/music` },
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
//  Never Assist — ассистент экосистемы (на правилах + поиск треков)
// ============================================================
const AI_KB = [
  {
    keys: ['привет', 'здравств', 'хай', 'hello', 'hi', 'ку'],
    a: 'Привет! 👋 Я Never Assist — ассистент экосистемы EcosystemNever. Спроси меня о чём угодно: проекты, сервисы, технологии, хостинг, код или NeverNight. А ещё могу добавить музыку в плейлист.'
  },
  {
    keys: ['кто ты', 'что ты', 'тебя зовут', 'твое имя', 'твоё имя'],
    a: 'Я Never Assist — ассистент экосистемы EcosystemNever. Отвечаю на вопросы про проекты, технологии и контакты, а ещё умею находить музыку и добавлять её в плейлист NeverMusic — просто напиши «добавь трек <название>».'
  },
  {
    keys: ['nevernight', 'никого', 'автор', 'владел', 'создател', 'кто сделал'],
    a: 'NeverNight — разработчик экосистемы EcosystemNever. Учится программировать, делает сайты, чаты, ботов и веб-сервисы на Node.js. Открыт к стажировкам и первым заказам. Telegram: @light18101'
  },
  {
    keys: ['контакт', 'связ', 'телеграм', 'telegram', 'написать', 'почт', 'email'],
    a: '📬 Связаться с NeverNight:\n• Telegram — @light18101\n• GitHub — github.com/miras101208miras-cpu\n• Телефон — +7 775 087 60 34'
  },
  {
    keys: ['проект', 'что есть', 'сервис', 'портфолио', 'список'],
    a: 'В экосистеме уже больше 20 проектов: портал EcosystemNever, фан-сайт Demon Slayer, NeverParty, NeverChat, NeverWall, NeverGuestbook, NeverPing, NeverProjects, NeverStats, NeverProfile, NeverAbout, NeverGame и Telegram-бот. Полный список — на странице /projects 🗂'
  },
  {
    keys: ['чат', 'neverchat', 'общени', 'комнат'],
    a: '💬 NeverChat — анонимный чат в реальном времени (Socket.IO): комнаты по ссылке, цветные ники, индикатор «печатает...», история в базе. Открыть: /chat'
  },
  {
    keys: ['гостев', 'guestbook', 'записи'],
    a: '📖 NeverGuestbook — гостевая книга экосистемы. Любой может оставить запись, её видят все. Открыть: /guestbook'
  },
  {
    keys: ['стена', 'иде', 'wall', 'голосован'],
    a: '📝 NeverWall — стена идей: предлагаешь фичу, другие голосуют. Лучшие идеи видно сверху. Открыть: /wall'
  },
  {
    keys: ['статус', 'ping', 'мониторинг', 'онлайн сервис'],
    a: '📡 NeverPing — статус-страница: сервер проверяет все сервисы и показывает онлайн/оффлайн, код ответа и время отклика. Открыть: /status'
  },
  {
    keys: ['игр', 'game', 'рекорд', 'аркад'],
    a: '🎮 NeverGame — неоновая аркада на Canvas: лови сферы, собирай комбо, бей рекорды. Открыть: /game'
  },
  {
    keys: ['музык', 'music', 'плеер', 'трек', 'песн'],
    a: '🎵 NeverMusic — музыкальный плеер экосистемы: общий плейлист, воспроизведение прямо на сайте. Можно добавить свой трек — просто укажи название и ссылку на MP3. Открыть: /music'
  },
  {
    keys: ['статист', 'аналитик', 'stats', 'посещен'],
    a: '📈 NeverStats — своя аналитика посещений: просмотры по дням, источники переходов, популярные страницы. Доступ закрыт паролем. Открыть: /stats'
  },
  {
    keys: ['бот', 'telegram', 'телеграм'],
    a: '🤖 @ecosystem_never_bot — бот экосистемы: присылает уведомления о новых записях, идеях и сообщениях в мой Telegram.'
  },
  {
    keys: ['домен', 'адрес', 'ссылка на сайт', 'сайт'],
    a: '🌐 Экосистема живёт на nevernight-server.onrender.com, портфолио — на GitHub Pages. Скоро будет красивый адрес nevernight.is-a.dev (заявка уже подана).'
  },
  {
    keys: ['технолог', 'стек', 'на чем', 'на чём', 'написан'],
    a: '⚙️ Стек: Node.js + Express, Socket.IO (реалтайм), SQLite (better-sqlite3), чистый HTML/CSS/JavaScript, Canvas API, Telegram Bot API. Хостинг — Render, статика — GitHub Pages.'
  },
  {
    keys: ['хостинг', 'хост', 'render', 'деплой', 'разверн'],
    a: '🚀 Хостинг: сервер — Render (Node 20, автодеплой из GitHub), сайты — GitHub Pages. Сервер сам собирается и перезапускается при каждом пуше в main.'
  },
  {
    keys: ['база', 'sqlite', 'данн', 'бд'],
    a: '🗄 Данные хранятся в SQLite (better-sqlite3): чат, гостевая, идеи, каталог проектов, аналитика, рекорды игры. На бесплатном Render база сбрасывается при деплое — поэтому есть стартовое наполнение каталога.'
  },
  {
    keys: ['админ', 'пароль', 'admin', 'вход'],
    a: '🛡 NeverAdmin — панель управления: идеи, гостевая, чат и график активности, управление каталогом и рекордами. Вход по паролю. Открыть: /admin'
  },
  {
    keys: ['спасибо', 'благодар', 'thanks'],
    a: 'Пожалуйста! 😊 Если что-то нужно — спрашивай. Ещё могу подсказать по проектам, стеку или контактам.'
  },
  {
    keys: ['помощь', 'help', 'что умеешь', 'команд'],
    a: 'Я умею:\n• рассказать про проекты, сервисы и технологии\n• подсказать контакты NeverNight\n• ответить про хостинг, базу данных и стек\n• добавить музыку — напиши «добавь трек <название>», и я найду его и добавлю в NeverMusic 🎵\nСпрашивай своими словами!'
  },
  {
    keys: ['never assist', 'neverassist', 'ассистент', 'помощник'],
    a: '🤖 Я Never Assist — ассистент экосистемы EcosystemNever. Отвечаю на вопросы про проекты, технологии, хостинг и контакты. Могу и музыку добавить: «добавь трек <название>» — и он появится в NeverMusic.'
  }
];

function aiReply(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return 'Напиши вопрос — и я отвечу 🙂';
  if (q.length > 500) return 'Слишком длинный вопрос — попробуй короче.';
  for (const item of AI_KB) {
    for (const k of item.keys) {
      if (q.includes(k)) return item.a;
    }
  }
  // если совсем ничего не подошло
  if (q.includes('?') || q.includes('как') || q.includes('почему') || q.includes('что')) {
    return 'Хм, не уверен, что понял 🤔 Попробуй спросить про: проекты, чат, музыку, статус, технологии, контакты или админку. Или напиши «помощь».';
  }
  return 'Не понял запрос 🤔 Напиши «помощь» — покажу, о чём можно спросить.';
}

// ============================================================
//  Never Assist — ассистент, который сам ищет и добавляет треки
//  Источники: Deezer (основной, без ключей) → iTunes (запасной)
//             → Spotify (если заданы ключи SPOTIFY_ID / SPOTIFY_SECRET)
// ============================================================
function looksLikeTrackRequest(q) {
  // Просим что-то добавить/найти именно в музыку (а не общий вопрос про музыку).
  // \w в JS не покрывает кириллицу — используем явные классы.
  return /(добав[а-яё]*|закин[а-яё]*|положи|поставь)\s+(пожалуйста\s+)?(трек|песн[а-яё]*|музык[а-яё]*|композиц[а-яё]*)/i.test(q)
    || /(найди|найти|подбер[а-яё]*)\s+(трек|песн[а-яё]*|музык[а-яё]*)/i.test(q)
    || /add\s+track/i.test(q);
}

// Достаём название трека из фразы: убираем команду и служебные слова
function extractQuery(q) {
  return q
    .replace(/(пожалуйста|плиз|мне|трек|песню|песн|музыку|музык|в плейлист|плейлист|добавь|добавить|закинь|положи|поставь|найди|найти|add track|add|трека|песни)/gi, ' ')
    .replace(/[«»"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Deezer (основной источник, без ключей) ---
async function searchDeezer(query) {
  const r = await fetch('https://api.deezer.com/search?limit=8&q=' + encodeURIComponent(query), { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('deezer ' + r.status);
  const data = await r.json();
  const item = (data.data || []).find((x) => x.preview);
  if (!item) return null;
  return {
    title: (item.title || query).slice(0, 80),
    artist: (item.artist && item.artist.name ? item.artist.name : '').slice(0, 80),
    url: item.preview,
    cover: (item.album && item.album.cover_xl) || (item.album && item.album.cover_big) || '',
    album: (item.album && item.album.title) || '',
    source: 'Deezer'
  };
}

// --- iTunes (запасной источник, без ключей) ---
async function searchItunes(query) {
  const r = await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=8&term=' + encodeURIComponent(query), { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('itunes ' + r.status);
  const data = await r.json();
  const item = (data.results || []).find((x) => x.previewUrl);
  if (!item) return null;
  return {
    title: (item.trackName || query).slice(0, 80),
    artist: (item.artistName || '').slice(0, 80),
    url: item.previewUrl,
    cover: (item.artworkUrl100 || '').replace('100x100', '300x300'),
    album: item.collectionName || '',
    source: 'iTunes'
  };
}

// --- Spotify (опционально: включается, если заданы SPOTIFY_ID и SPOTIFY_SECRET) ---
let spotifyToken = null, spotifyTokenExp = 0;
async function getSpotifyToken() {
  const id = process.env.SPOTIFY_ID || (secret && secret.spotifyId);
  const sec = process.env.SPOTIFY_SECRET || (secret && secret.spotifySecret);
  if (!id || !sec) return null;
  if (spotifyToken && Date.now() < spotifyTokenExp) return spotifyToken;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(id + ':' + sec).toString('base64') },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) return null;
  const d = await r.json();
  spotifyToken = d.access_token;
  spotifyTokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return spotifyToken;
}

async function searchSpotify(query) {
  const token = await getSpotifyToken();
  if (!token) return null;
  const r = await fetch('https://api.spotify.com/v1/search?type=track&limit=8&q=' + encodeURIComponent(query), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) return null;
  const data = await r.json();
  const item = (data.tracks && data.tracks.items || []).find((x) => x.preview_url);
  if (!item) return null;
  return {
    title: (item.name || query).slice(0, 80),
    artist: (item.artists || []).map((a) => a.name).join(', ').slice(0, 80),
    url: item.preview_url,
    cover: (item.album && item.album.images && item.album.images[0] && item.album.images[0].url) || '',
    album: (item.album && item.album.name) || '',
    source: 'Spotify'
  };
}

// Ищем трек по всем источникам: Spotify (если настроен) → Deezer → iTunes
async function searchTrack(query) {
  const chain = [searchSpotify, searchDeezer, searchItunes];
  for (const fn of chain) {
    try {
      const t = await fn(query);
      if (t) return t;
    } catch (e) { /* пробуем следующий источник */ }
  }
  return null;
}

async function assistAddTrack(text) {
  const query = extractQuery(text);
  if (!query || query.length < 2) {
    return 'Напиши название трека, который добавить — например: «добавь трек Blinding Lights».';
  }
  let t;
  try {
    t = await searchTrack(query);
  } catch (e) {
    return '⚠ Не получилось поискать трек — попробуй ещё раз чуть позже.';
  }
  if (!t) {
    return `Не нашёл трек «${query}» 🤔 Попробуй написать точнее — исполнителя и песню.`;
  }
  const ts = Date.now();
  const info = db.prepare('INSERT INTO tracks (title, artist, url, cover, sort, ts) VALUES (?,?,?,?,?,?)')
    .run(t.title, t.artist, t.url, t.cover, 0, ts);
  notifyTelegram(`🎵 Never Assist добавил трек: «${t.title}» — ${t.artist} (${t.source})`);
  return {
    answer: `🎵 Добавил в плейлист: «${t.title}» — ${t.artist}${t.album ? '\n💿 ' + t.album : ''}\nЭто превью трека, послушать можно на странице NeverMusic: /music`,
    track: { id: info.lastInsertRowid, title: t.title, artist: t.artist, url: t.url, cover: t.cover, source: t.source },
    added: true
  };
}

app.post('/api/ai', async (req, res) => {
  const text = clean(req.body.text, 600);
  const session = clean(req.body.session, 40) || 'anon';
  const ts = Date.now();
  const ins = db.prepare('INSERT INTO ai_messages (session, role, text, ts) VALUES (?,?,?,?)');
  ins.run(session, 'user', text, ts);

  let answer = null;
  let track = null;

  // Never Assist: если просят добавить трек — ищем и добавляем сами
  if (looksLikeTrackRequest(text)) {
    const r = await assistAddTrack(text);
    if (typeof r === 'string') {
      answer = r;
    } else {
      answer = r.answer;
      track = r.track;
    }
  } else {
    answer = aiReply(text);
  }

  ins.run(session, 'ai', answer, ts + 1);
  res.json({ answer, track });
});

app.get('/api/ai/history', (req, res) => {
  const session = clean(req.query.session, 40) || 'anon';
  const rows = db.prepare('SELECT role, text, ts FROM ai_messages WHERE session = ? ORDER BY id DESC LIMIT 50').all(session);
  res.json(rows.reverse());
});

// ---------- NeverMusic — плейлист ----------
app.get('/api/music/tracks', (_req, res) => {
  const rows = db.prepare('SELECT id, title, artist, url, cover, sort, ts FROM tracks ORDER BY sort DESC, id ASC').all();
  res.json(rows);
});

// Публичное добавление трека (свой плейлист — можно добавлять самому).
// Доступно всем, но с защитой от спама: лимит добавлений с одного IP.
const musicAddLog = new Map(); // ip -> массив timestamp

function validateTrack(body) {
  const title = clean(body.title, 80);
  const artist = clean(body.artist, 80);
  const url = clean(body.url, 400);
  const cover = clean(body.cover, 400);
  const sort = Number(body.sort) || 0;
  if (!title || !url) return { error: 'Нужны название и ссылка на трек.' };
  if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) return { error: 'Ссылка должна начинаться с http(s):// или /' };
  return { title, artist, url, cover, sort };
}

app.post('/api/music/tracks', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hist = (musicAddLog.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000); // за час
  if (hist.length >= 15) {
    return res.status(429).json({ error: 'Слишком много добавлений. Попробуй позже.' });
  }
  const v = validateTrack(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = Date.now();
  const info = db.prepare('INSERT INTO tracks (title, artist, url, cover, sort, ts) VALUES (?,?,?,?,?,?)')
    .run(v.title, v.artist, v.url, v.cover, v.sort, ts);
  hist.push(now);
  musicAddLog.set(ip, hist);
  // уведомим владельца в Telegram
  notifyTelegram(`🎵 Новый трек в NeverMusic: «${v.title}»${v.artist ? ' — ' + v.artist : ''}`);
  res.json({ id: info.lastInsertRowid, title: v.title, artist: v.artist, url: v.url, cover: v.cover, sort: v.sort, ts });
});

app.post('/api/admin/music', requireAdmin, (req, res) => {
  const v = validateTrack(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const info = db.prepare('INSERT INTO tracks (title, artist, url, cover, sort, ts) VALUES (?,?,?,?,?,?)')
    .run(v.title, v.artist, v.url, v.cover, v.sort, Date.now());
  res.json({ id: info.lastInsertRowid, title: v.title, artist: v.artist, url: v.url, cover: v.cover, sort: v.sort, ts: Date.now() });
});
app.delete('/api/admin/music/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tracks WHERE id = ?').run(Number(req.params.id));
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
    ['Never Assist', 'Ассистент экосистемы: сам ищет и добавляет треки', '/ai', 'Онлайн', 7],
    ['NeverMusic', 'Музыкальный плеер с общим плейлистом', '/music', 'Онлайн', 7],
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

// ---------- Стартовое наполнение плейлиста NeverMusic ----------
if (db.prepare('SELECT COUNT(*) AS c FROM tracks').get().c === 0) {
  const seedTracks = [
    ['Neon Drive', 'Synthwave', '/music/track1.mp3', '', 5],
    ['Cyber Pulse', 'Electro', '/music/track2.mp3', '', 4],
    ['Deep Space', 'Ambient', '/music/track3.mp3', '', 3],
    ['Morning Light', 'Chill', '/music/track4.mp3', '', 2],
    ['Night Runner', 'Electronica', '/music/track5.mp3', '', 1]
  ];
  const insT = db.prepare('INSERT INTO tracks (title, artist, url, cover, sort, ts) VALUES (?,?,?,?,?,?)');
  const tt = Date.now();
  seedTracks.forEach((s) => insT.run(s[0], s[1], s[2], s[3], s[4], tt));
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
