/* ============================================================
   EcosystemNever — общий скрипт всех страниц
   Подключается одной строкой:
   <script src="/app.js" defer></script>

   Делает:
   - переключатель светлой/тёмной темы (сохраняется в браузере)
   - кнопку темы в шапке (если её нет — создаёт)
   - трекер посещений (NeverStats)
   ============================================================ */
(function () {
  var KEY = 'nn_theme';

  // Применяем тему как можно раньше, чтобы не было «мигания»
  try {
    if (localStorage.getItem(KEY) === 'light') {
      document.documentElement.classList.add('light');
    }
  } catch (e) {}

  function current() {
    return document.documentElement.classList.contains('light') ? 'light' : 'dark';
  }

  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'light') root.classList.add('light');
    else root.classList.remove('light');
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = mode === 'light' ? '🌙' : '☀️';
      btns[i].setAttribute('aria-label', mode === 'light' ? 'Тёмная тема' : 'Светлая тема');
    }
  }

  function makeButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    btn.setAttribute('data-theme-toggle', '');
    btn.addEventListener('click', function () {
      apply(current() === 'light' ? 'dark' : 'light');
    });
    return btn;
  }

  function placeButtons() {
    var existing = document.querySelectorAll('[data-theme-toggle]');
    if (existing.length) { apply(current()); return; }
    // Ищем шапку и кладём кнопку в блок ссылок (или в саму шапку)
    var host = document.querySelector('.nav-links') || document.querySelector('.topbar');
    var btn = makeButton();
    if (host) {
      host.appendChild(btn);
    } else {
      btn.style.position = 'fixed';
      btn.style.top = '16px';
      btn.style.right = '16px';
      btn.style.zIndex = '40';
      document.body.appendChild(btn);
    }
    apply(current());
  }

  // Трекер посещений (NeverStats)
  function track() {
    try {
      var host = location.hostname;
      var isServer = host.indexOf('onrender') > -1 || host.indexOf('is-a.dev') > -1 || host === 'localhost' || host === '127.0.0.1';
      var url = isServer ? '/api/track' : 'https://nevernight-server.onrender.com/api/track';
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: location.pathname,
          ref: document.referrer ? (function () { try { return new URL(document.referrer).hostname; } catch (e) { return ''; } })() : ''
        })
      }).catch(function () {});
    } catch (e) {}
  }

  // ============================================================
  //  Never Assist — ассистент в нижнем углу на всех страницах
  // ============================================================
  function apiBase() {
    var host = location.hostname;
    var isServer = host.indexOf('onrender') > -1 || host.indexOf('is-a.dev') > -1 || host === 'localhost' || host === '127.0.0.1';
    return isServer ? '' : 'https://nevernight-server.onrender.com';
  }

  function buildAssistant() {
    if (document.getElementById('na-assist')) return;

    var base = apiBase();

    var wrap = document.createElement('div');
    wrap.id = 'na-assist';

    // Кнопка (лаунчер)
    var fab = document.createElement('button');
    fab.id = 'na-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Never Assist');
    fab.innerHTML = '<span class="na-fab-ico">🤖</span>';
    fab.addEventListener('click', function () { openPanel(); });

    // Панель
    var panel = document.createElement('div');
    panel.id = 'na-panel';
    panel.innerHTML =
      '<div class="na-head">' +
        '<div class="na-ava">🤖</div>' +
        '<div class="na-head-txt"><div class="na-name">Never Assist</div><div class="na-sub">онлайн · найдёт и добавит трек</div></div>' +
        '<button class="na-close" type="button" aria-label="Закрыть">✕</button>' +
      '</div>' +
      '<div class="na-chat" id="na-chat"></div>' +
      '<div class="na-chips">' +
        '<button class="na-chip" data-q="добавь трек Blinding Lights">🎵 Добавить трек</button>' +
        '<button class="na-chip" data-q="Какие есть проекты?">🗂 Проекты</button>' +
        '<button class="na-chip" data-q="Как связаться?">📬 Контакты</button>' +
      '</div>' +
      '<form class="na-form" id="na-form">' +
        '<input id="na-input" placeholder="Напиши вопрос или «добавь трек …»" autocomplete="off" maxlength="500">' +
        '<button type="submit" id="na-send" aria-label="Отправить">➤</button>' +
      '</form>';

    wrap.appendChild(panel);
    wrap.appendChild(fab);
    document.body.appendChild(wrap);

    var chat = panel.querySelector('#na-chat');
    var input = panel.querySelector('#na-input');
    var sendBtn = panel.querySelector('#na-send');
    var greeted = false;

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function addMsg(role, text) {
      var d = document.createElement('div');
      d.className = 'na-msg ' + role;
      d.innerHTML =
        '<div class="na-bub">' + esc(text).replace(/\n/g, '<br>') + '</div>';
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
      return d;
    }

    function typing() {
      var d = document.createElement('div');
      d.className = 'na-msg ai';
      d.innerHTML = '<div class="na-bub"><span class="na-dots"><i></i><i></i><i></i></span></div>';
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
      return d;
    }

    var session = (function () {
      try {
        var s = localStorage.getItem('nn_ai_session');
        if (!s) { s = 'w' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('nn_ai_session', s); }
        return s;
      } catch (e) { return 'anon'; }
    })();

    function greet() {
      if (greeted) return;
      greeted = true;
      addMsg('ai', 'Привет! 👋 Я Never Assist — ассистент EcosystemNever.\nСпроси про проекты, сервисы или контакты. А ещё напиши «добавь трек <название>» — я сам найду его и добавлю в плейлист 🎵');
    }

    async function ask(text) {
      text = (text || '').trim();
      if (!text) return;
      addMsg('user', text);
      input.value = '';
      sendBtn.disabled = true;
      var t = typing();
      try {
        var r = await fetch(base + '/api/ai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, session: session })
        });
        var d = await r.json();
        t.remove();
        addMsg('ai', d.answer || 'Что-то пошло не так 🤔');
        if (d.track) {
          var link = document.createElement('a');
          link.className = 'na-track-link';
          link.href = base + '/music';
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = '▶ Открыть в NeverMusic';
          chat.appendChild(link);
          chat.scrollTop = chat.scrollHeight;
        }
      } catch (e) {
        t.remove();
        addMsg('ai', '⚠ Не получилось связаться с сервером. Попробуй позже.');
      }
      sendBtn.disabled = false;
      input.focus();
    }

    panel.querySelector('.na-close').addEventListener('click', function () { closePanel(); });
    panel.querySelector('#na-form').addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
    panel.querySelector('.na-chips').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.na-chip') : null;
      if (b) ask(b.getAttribute('data-q'));
    });
  }

  function openPanel() {
    var p = document.getElementById('na-panel');
    var f = document.getElementById('na-fab');
    if (!p) return;
    p.classList.add('open');
    if (f) f.classList.add('hide');
    var i = document.getElementById('na-input');
    if (i) setTimeout(function () { i.focus(); }, 120);
  }
  function closePanel() {
    var p = document.getElementById('na-panel');
    var f = document.getElementById('na-fab');
    if (p) p.classList.remove('open');
    if (f) f.classList.remove('hide');
  }

  function init() {
    placeButtons();
    track();
    buildAssistant();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
