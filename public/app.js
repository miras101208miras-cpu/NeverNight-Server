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

  function init() {
    placeButtons();
    track();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
