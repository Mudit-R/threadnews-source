(() => {
  'use strict';
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'threadnews-theme';
  let chosen;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') chosen = saved;
  } catch {}

  function apply() {
    const dark = chosen ? chosen === 'dark' : systemTheme.matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.querySelector('span').textContent = dark ? '☀' : '☾';
      toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      chosen = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(storageKey,chosen); } catch {}
      apply();
    });
  }, { once:true });
  systemTheme.addEventListener('change',apply);
})();
