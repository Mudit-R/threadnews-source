'use strict';

customElements.define('threadnews-coverage', class extends HTMLElement {
  connectedCallback() {
    this.details = this.querySelector('details');
    this.details?.addEventListener('toggle', this.onToggle);
  }

  disconnectedCallback() {
    this.details?.removeEventListener('toggle', this.onToggle);
    this.unmount?.();
    this.unmount = null;
  }

  onToggle = async () => {
    if (!this.details?.open || this.unmount || this.pending) return;
    const body = this.querySelector('.coverage-panel-body');
    if (!body) return;
    this.pending = true;
    try {
      const { mount } = await import('/generated/coverage.js?v=20261125-1');
      if (this.isConnected) this.unmount = mount(body, {
        articleId: this.dataset.articleId,
        apiBase: this.dataset.apiBase || ''
      });
    } catch {
      if (this.isConnected) body.querySelector('[role="status"]').textContent = 'Coverage comparison could not load. Refresh the page to try again.';
    } finally {
      this.pending = false;
    }
  };
});
