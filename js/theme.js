// Cryptiq Secure Line — theme toggle (light/dark). Runs on every page.
(function (root) {
  const KEY = 'cq.secureline.theme.v1';

  const apply = (theme) => {
    if (theme === 'light') document.body.classList.add('theme-light');
    else document.body.classList.remove('theme-light');
  };

  const current = () => document.body.classList.contains('theme-light') ? 'light' : 'dark';

  const set = (theme) => {
    try { localStorage.setItem(KEY, theme); } catch {}
    apply(theme);
    updateToggleButtons();
  };

  const toggle = () => set(current() === 'light' ? 'dark' : 'light');

  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };

  const updateToggleButtons = () => {
    const c = current();
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      const iconKey = c === 'light' ? 'moon' : 'sun';
      btn.innerHTML = (root.cqIcons && root.cqIcons[iconKey]) || '';
      btn.setAttribute('aria-label', c === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
      btn.title = c === 'light' ? 'Switch to dark' : 'Switch to light';
    });
  };

  const init = () => {
    const s = stored();
    const prefs = (s === 'light' || s === 'dark') ? s : 'dark';
    apply(prefs);
    // Hydrate any theme-toggle buttons on the page and wire click handler.
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', toggle);
    });
    updateToggleButtons();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.cqTheme = { apply, set, toggle, current };
})(window);
