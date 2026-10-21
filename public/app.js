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

  function injectStyles() {
    if (document.getElementById('na-assist-style')) return;
    var css = `
#na-assist{--na-cyan:var(--cyan,#00f0ff);--na-purple:var(--purple,#a855f7);
  --na-card:var(--card,rgba(16,23,38,0.92));--na-border:var(--border,rgba(0,240,255,0.16));
  --na-item:var(--item-bg,rgba(255,255,255,0.05));--na-text:var(--text,#f8fafc);
  --na-muted:var(--muted,#94a3b8);--na-input:var(--input-bg,rgba(255,255,255,0.05));
  position:fixed;right:22px;bottom:22px;z-index:9000}
#na-fab{width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;
  background:linear-gradient(135deg,var(--na-cyan),var(--na-purple));color:#04060a;font-size:1.5rem;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 25px rgba(0,240,255,0.5),0 8px 24px rgba(0,0,0,0.5);transition:transform .25s,opacity .25s}
#na-fab:hover{transform:scale(1.08) translateY(-2px)}
#na-fab.hide{opacity:0;pointer-events:none;transform:scale(0.6)}
#na-fab .na-fab-ico{animation:naBob 2.6s ease-in-out infinite}
@keyframes naBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
#na-panel{position:absolute;right:0;bottom:74px;width:340px;max-width:calc(100vw - 44px);
  height:460px;max-height:calc(100vh - 120px);display:flex;flex-direction:column;overflow:hidden;
  background:var(--na-card);border:1px solid var(--na-border);border-radius:20px;
  backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(0,0,0,0.6);
  transform:translateY(16px) scale(0.96);opacity:0;pointer-events:none;
  transition:transform .28s ease,opacity .28s ease}
#na-panel.open{transform:none;opacity:1;pointer-events:auto}
.na-head{display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--na-border)}
.na-ava{width:40px;height:40px;border-radius:12px;flex-shrink:0;font-size:1.2rem;display:flex;
  align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(0,240,255,0.18),rgba(168,85,247,0.18));
  border:1px solid rgba(0,240,255,0.5);box-shadow:0 0 15px rgba(0,240,255,0.3)}
.na-head-txt{flex:1;min-width:0}
.na-name{font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;color:var(--na-text)}
.na-sub{font-family:'JetBrains Mono',monospace;font-size:.6rem;color:#10b981;display:flex;align-items:center;gap:5px}
.na-sub::before{content:'';width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981}
.na-close{width:30px;height:30px;border-radius:9px;cursor:pointer;flex-shrink:0;
  background:var(--na-item);border:1px solid var(--na-border);color:var(--na-muted);font-size:.85rem}
.na-close:hover{color:var(--na-cyan);border-color:rgba(0,240,255,0.4)}
.na-chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.na-msg{display:flex;max-width:88%;animation:naUp .28s ease both}
@keyframes naUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.na-msg.user{align-self:flex-end}
.na-bub{padding:10px 14px;border-radius:14px;font-size:.82rem;line-height:1.5;word-break:break-word;color:var(--na-text)}
.na-msg.ai .na-bub{background:var(--na-item);border:1px solid var(--na-border);border-bottom-left-radius:4px}
.na-msg.user .na-bub{background:linear-gradient(135deg,var(--na-cyan),var(--na-purple));color:#04060a;font-weight:600;border-bottom-right-radius:4px}
.na-dots{display:inline-flex;gap:4px}
.na-dots i{width:6px;height:6px;border-radius:50%;background:var(--na-muted);animation:naBlink 1.2s infinite}
.na-dots i:nth-child(2){animation-delay:.2s}
.na-dots i:nth-child(3){animation-delay:.4s}
@keyframes naBlink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.na-track-link{align-self:flex-start;margin-left:4px;padding:7px 14px;border-radius:12px;text-decoration:none;
  font-family:'JetBrains Mono',monospace;font-size:.72rem;color:#04060a;
  background:linear-gradient(135deg,var(--na-cyan),var(--na-purple));font-weight:700}
.na-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 10px}
.na-chip{padding:6px 11px;border-radius:14px;cursor:pointer;font-size:.68rem;
  background:var(--na-item);border:1px solid var(--na-border);color:var(--na-text);
  font-family:'JetBrains Mono',monospace;transition:all .2s}
.na-chip:hover{border-color:rgba(0,240,255,0.5);color:var(--na-cyan)}
.na-form{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--na-border)}
.na-form input{flex:1;padding:11px 14px;border-radius:12px;background:var(--na-input);
  border:1px solid var(--na-border);color:var(--na-text);font-size:.82rem;outline:none;font-family:'Montserrat',sans-serif}
.na-form input:focus{border-color:rgba(0,240,255,0.5)}
.na-form button{width:44px;border:none;border-radius:12px;cursor:pointer;flex-shrink:0;
  background:linear-gradient(135deg,var(--na-cyan),var(--na-purple));color:#04060a;font-size:1rem}
.na-form button:disabled{opacity:.5;cursor:default}
@media (max-width:480px){#na-assist{right:14px;bottom:14px}#na-panel{width:calc(100vw - 28px);height:70vh}}
`;
    var s = document.createElement('style');
    s.id = 'na-assist-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildAssistant() {
    if (document.getElementById('na-assist')) return;
    injectStyles();

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
