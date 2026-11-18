(() => {
  'use strict';
  function mount(container, { findArticle, originalLink, formatDate }) {
    const panel = document.createElement('section');
    panel.id = 'quick-brief';
    panel.className = 'quick-brief';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'quick-brief-title');
    panel.innerHTML = '<div class="quick-brief-top"><span class="quick-brief-kind"></span><button type="button" aria-label="Close quick brief">×</button></div><h2 id="quick-brief-title"></h2><p class="quick-brief-meta"></p><p class="quick-brief-copy"></p><a class="quick-brief-source" target="_blank" rel="noopener noreferrer"></a>';
    document.body.append(panel);
    const closeButton = panel.querySelector('button');
    const link = panel.querySelector('a');
    const selector = '[data-brief-id]';
    let trigger, pending, openTimer, closeTimer, pinned = false;

    function close(restore = false) {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      pending = null;
      if (!trigger) return;
      if (trigger.matches('button')) trigger.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      const previous = trigger;
      trigger = null;
      pinned = false;
      if (restore && previous.isConnected) previous.focus({ preventScroll: true });
    }

    function position() {
      if (!trigger?.isConnected) { close(); return; }
      const anchor = trigger.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const gap = 10;
      const left = Math.max(gap, Math.min(anchor.left, window.innerWidth - bounds.width - gap));
      const top = anchor.bottom + bounds.height + gap * 2 <= window.innerHeight ? anchor.bottom + gap : anchor.top - bounds.height - gap;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(Math.max(gap, Math.min(top, window.innerHeight - bounds.height - gap)))}px`;
    }

    function open(target, interactive) {
      const article = findArticle(target.dataset.briefId);
      if (!article || !target.isConnected) return;
      close();
      trigger = target;
      pinned = interactive;
      const brief = globalThis.ThreadNewsContent?.displayQuickBrief(article) || '';
      const original = originalLink(article);
      const kind = article.source.summaryMethod === 'original-source-excerpt' ? 'Source excerpt' : 'Quick brief';
      panel.querySelector('.quick-brief-kind').textContent = brief ? kind : 'Headline only';
      panel.querySelector('h2').textContent = article.title;
      const dateLabel = article.source?.dateBasis === 'updated' ? 'Updated' : article.source?.dateBasis === 'indexed' ? 'Indexed' : 'Published';
      panel.querySelector('.quick-brief-meta').textContent = `${article.source.publisher} · ${dateLabel} ${formatDate(article.publishedAt)}`;
      panel.querySelector('.quick-brief-copy').textContent = brief || 'The publisher headline is available. Open the report for the original context.';
      link.hidden = !original;
      if (original) { link.href = original.url; link.textContent = original.label; }
      if (target.matches('button')) target.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      position();
      if (interactive) closeButton.focus({ preventScroll: true });
    }

    container.addEventListener('pointerover', event => {
      const target = event.target.closest(selector);
      if (event.pointerType !== 'mouse' || !target || pinned) return;
      clearTimeout(closeTimer);
      if (target === trigger || target === pending) return;
      clearTimeout(openTimer);
      pending = target;
      openTimer = setTimeout(() => open(target, false), 240);
    });
    container.addEventListener('pointerout', event => {
      const target = event.target.closest(selector);
      if (!target || target.contains(event.relatedTarget) || pinned) return;
      clearTimeout(openTimer);
      pending = null;
      if (target === trigger) closeTimer = setTimeout(close, 215);
    });
    panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    panel.addEventListener('pointerleave', () => { if (!pinned) closeTimer = setTimeout(close, 215); });
    container.addEventListener('click', event => {
      const button = event.target.closest('button[data-brief-id]');
      if (!button) return;
      if (pinned && trigger === button) close(true);
      else open(button, true);
    });
    closeButton.addEventListener('click', () => close(pinned));
    document.addEventListener('pointerdown', event => {
      if (trigger && !panel.contains(event.target) && !event.target.closest('button[data-brief-id]')) close();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && trigger) close(pinned); });
    addEventListener('resize', () => { if (trigger) position(); });
    addEventListener('scroll', () => { if (trigger) position(); }, { passive: true });
    new MutationObserver(() => { if (trigger && !trigger.isConnected) close(); }).observe(container, { childList: true, subtree: true });
  }

  globalThis.ThreadNewsQuickBrief = Object.freeze({ mount });
})();
