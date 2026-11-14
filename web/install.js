(() => {
  'use strict';

  const button = document.getElementById('install-app-button');
  const dialog = document.getElementById('install-app-dialog');
  const steps = document.getElementById('install-app-steps');
  if (!button || !dialog || !steps) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  let installPrompt = null;

  button.hidden = isStandalone || (!isIOS && !isAndroid);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }, { once: true });
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    if (!isStandalone) button.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    button.hidden = true;
  });

  function showInstructions() {
    const instructions = isIOS
      ? [
          'Open this page in Safari if you are viewing it in another browser.',
          'Tap the Share button.',
          'Choose “Add to Home Screen,” turn on “Open as Web App,” then tap “Add.”'
        ]
      : [
          'Open the browser menu.',
          'Choose “Install app” or “Add to Home screen.”',
          'Confirm to add ThreadNews to your device.'
        ];
    steps.replaceChildren(...instructions.map(instruction => {
      const item = document.createElement('li');
      item.textContent = instruction;
      return item;
    }));
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  button.addEventListener('click', async () => {
    if (!installPrompt) {
      showInstructions();
      return;
    }
    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') button.hidden = true;
    } catch {
      showInstructions();
    }
  });

  dialog.addEventListener('click', event => {
    if (event.target === dialog
      || (event.target instanceof Element && event.target.closest('[data-install-close]'))) dialog.close();
  });
})();
