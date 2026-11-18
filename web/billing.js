/* Server-driven membership page. The browser never grants or infers access. */
globalThis.createBillingView = function createBillingView({ connected, apiBase, getSession, esc, toast, navigate }) {
  const main = () => document.getElementById('main');
  let plansData = null, billingStatus = null, loading = false, busy = false, error = '', loadedAt = 0, loadedFor = null, confirming = false;

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch((apiBase || '') + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const failure = new Error(data.message || data.error || 'The billing service could not complete this request.');
      failure.status = response.status;
      failure.data = data;
      throw failure;
    }
    return data;
  }

  function price(plan) {
    if (typeof plan.formattedPrice === 'string' && plan.formattedPrice.trim()) return plan.formattedPrice;
    const amount = Number(plan.price ?? plan.amount ?? plan.value);
    const currency = String(plan.currency || 'USD').toUpperCase();
    if (!Number.isFinite(amount)) return 'Price shown at checkout';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); }
    catch { return `${currency} ${amount.toFixed(2)}`; }
  }

  function interval(plan) {
    const raw = String(plan.interval || plan.billingInterval || plan.period || '').toLowerCase();
    if (plan.checkout === 'order' || raw.includes('one-time')) return raw;
    if (raw.includes('year') || raw.includes('annual')) return 'per year';
    if (raw.includes('month')) return 'per month';
    return raw ? `per ${raw}` : '';
  }

  function friendlyError(failure) {
    if (failure.status === 401) return 'Sign in to manage a subscription. Your reading stays open as a guest.';
    if (failure.status === 503) return 'PayPal checkout is not ready yet. ThreadNews will keep the news open until live billing is configured.';
    if (failure.name === 'TimeoutError') return 'The billing service timed out. Please try again.';
    return failure.message || 'The billing service is unavailable. Please try again.';
  }

  function statusText() {
    const sub = billingStatus?.subscription;
    if (!sub) return 'No supporter plan is linked to this account.';
    const state = String(sub.status || 'unknown').replaceAll('_', ' ').toLowerCase();
    if (billingStatus?.entitled) return `${sub.checkoutKind === 'order' ? 'Supporter pass access' : 'Supporter access'} is active${sub.accessUntil ? ` through ${dateLabel(sub.accessUntil)}` : ''}.`;
    if (sub.checkoutKind === 'subscription' && sub.nextBillingTime && Date.parse(sub.nextBillingTime) > Date.now() && ['active', 'awaiting payment', 'approval pending'].includes(state)) return `Your subscription is scheduled. Your first charge is ${dateLabel(sub.nextBillingTime)}. Cancel before then to avoid being charged.`;
    if (state.includes('approval')) return 'PayPal approval is pending. Complete the secure approval flow to continue.';
    if (state.includes('past') || state.includes('failed')) return 'A payment needs attention. Supporter access may be limited until PayPal confirms payment.';
    return `Subscription status: ${state}. Access is granted only after PayPal verifies a successful payment.`;
  }

  function dateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function billingTerms() {
    return plansData?.billing || {};
  }

  function cancelControl() {
    const sub = billingStatus?.subscription;
    if (sub?.checkoutKind !== 'subscription' || !['ACTIVE', 'APPROVAL_PENDING', 'SUSPENDED', 'PAST_DUE'].includes(String(sub.status || '').toUpperCase())) return '';
    return `<button class="button billing-cancel" type="button" data-action="billing-cancel" ${busy ? 'disabled' : ''}>Cancel subscription</button>`;
  }

  function featureSummary(plan) {
    const features = Array.isArray(plan.features) ? plan.features.filter(item => typeof item === 'string' && item.trim()) : [];
    const planned = Array.isArray(plan.plannedFeatures) ? plan.plannedFeatures.filter(item => typeof item === 'string' && item.trim()) : [];
    const included = features.length
      ? `<div class="billing-feature-group"><span class="billing-feature-label">INCLUDED</span><ul>${features.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`
      : '<div class="billing-feature-group"><span class="billing-feature-label">PLAN DETAILS</span><p class="billing-feature-unavailable">Included features have not been published for this plan.</p></div>';
    return `${included}${planned.length ? `<div class="billing-feature-group billing-planned-group"><span class="billing-feature-label">PLANNED · NOT ACTIVE</span><ul>${planned.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}`;
  }

  function freeFeatureSummary() {
    const free = plansData?.freeTier;
    const features = ['Read current news and publisher links'];
    const limit = Number(free?.timelineMilestones);
    if (free?.fullTimelines === true) features.push('Explore full public timelines');
    if (Number.isInteger(limit) && limit > 0) features.push(`Explore the first ${limit} developments in each timeline`);
    if (free?.economyLatestValues === true) features.push('See the latest published economic data');
    if (free?.weeklyBrief === true) features.push('Read the weekly brief');
    const planned = Array.isArray(free?.plannedFeatures) ? free.plannedFeatures.filter(item => typeof item === 'string' && item.trim()) : [];
    return `<ul>${features.map(item => `<li>${esc(item)}</li>`).join('')}</ul>${planned.length ? `<div class="billing-feature-group billing-planned-group"><span class="billing-feature-label">PLANNED · NOT ACTIVE</span><ul>${planned.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}`;
  }

  function planCard(plan) {
    const key = String(plan.key || '');
    const name = esc(plan.name || (key === 'founding' ? 'Founding supporter' : key === 'monthly' ? 'Monthly supporter' : key === 'annual_pass' ? '12-month pass' : 'Annual supporter'));
    const amount = price(plan), cadence = interval(plan);
    const available = plan.available === true && plansData?.enabled === true && ['sandbox', 'live'].includes(plansData?.environment);
    const oneTime = plan.checkout === 'order';
    const schedule = billingTerms();
    const beforeFirstCharge = schedule.billingStartsAt && Date.now() < Date.parse(schedule.billingStartsAt);
    const payNow = !oneTime && beforeFirstCharge && schedule.allowImmediateCheckout === true;
    const firstChargeNote = !oneTime && beforeFirstCharge
      ? `<p class="billing-schedule-note">${payNow ? 'Choose to pay when you approve in PayPal, or schedule your first payment for' : 'No charge today. First payment is scheduled for'} ${esc(schedule.billingStartLabel || dateLabel(schedule.billingStartsAt))}.</p>`
      : '';
    let action;
    if (!connected) action = '<span class="billing-unavailable">Checkout is available on the connected deployment.</span>';
    else if (!available) action = `<button class="button" type="button" disabled>${plan.checkout === 'subscription' && plansData?.subscriptionsAccessRequired ? 'Recurring plan unavailable' : 'Membership not open yet'}</button>`;
    else if (!getSession()?.user) action = '<button class="button primary" type="button" data-action="billing-signin">Sign in to continue</button>';
    else if (billingStatus?.entitled) action = '<span class="billing-current">Your supporter access is active</span>';
    else if (payNow) action = `<div class="billing-checkout-options"><button class="button primary" type="button" data-action="billing-checkout" data-plan="${esc(key)}" data-start="immediate" ${busy ? 'disabled' : ''}>Pay ${esc(amount)} now</button><button class="button" type="button" data-action="billing-checkout" data-plan="${esc(key)}" data-start="scheduled" ${busy ? 'disabled' : ''}>Start payments Dec 1</button></div>`;
    else action = `<button class="button primary" type="button" data-action="billing-checkout" data-plan="${esc(key)}" ${busy ? 'disabled' : ''}>${busy ? 'Connecting to PayPal…' : oneTime ? 'Buy 12-month pass' : 'Continue with PayPal'}</button>`;
    const label = oneTime ? 'ONE-TIME PASS' : key === 'founding' ? 'LIMITED FOUNDING OFFER' : key === 'annual' ? 'BEST VALUE' : 'FLEXIBLE';
    return `<article class="billing-plan ${key === 'annual' ? 'billing-plan-featured' : ''}"><div class="billing-plan-top"><span class="eyebrow">${label}</span>${key === 'annual' ? '<span class="billing-plan-badge">Support the long view</span>' : ''}</div><h3>${name}</h3><p class="billing-price"><strong>${esc(amount)}</strong><span>${esc(cadence)}</span></p>${featureSummary(plan)}${firstChargeNote}${action}</article>`;
  }

  function render() {
    const target = main();
    if (!target) return;
    const user = getSession()?.user;
    const env = plansData?.environment === 'sandbox' ? 'PayPal sandbox · testing only' : plansData?.environment === 'live' ? plansData?.enabled ? 'PayPal live checkout ready' : 'Free launch · checkout not open yet' : 'Billing status unavailable';
    const active = billingStatus?.entitled === true;
    const freeFeatures = connected ? freeFeatureSummary() : '<ul><li>Read the dated news edition and publisher links</li><li>Explore the timeline previews included in this edition</li><li>No account or payment required</li></ul>';
    const plans = plansData?.plans || [];
    const recurring = plans.some(plan => plan.checkout === 'subscription'), passes = plans.some(plan => plan.checkout === 'order');
    const schedule = billingTerms();
    const firstCharge = schedule.billingStartLabel || dateLabel(schedule.billingStartsAt);
    const freeUntil = schedule.freeThroughDate ? dateLabel(`${schedule.freeThroughDate}T12:00:00`) : 'the published free period';
    const beforeBillingStart = schedule.billingStartsAt && Date.now() < Date.parse(schedule.billingStartsAt);
    const freePeriodCopy = plansData?.enabled
      ? schedule.allowImmediateCheckout ? `Supporters can pay when they approve in PayPal or choose their first charge on ${esc(firstCharge)}.` : `If you subscribe early, your first charge is scheduled for ${esc(firstCharge)}. You can cancel before then.`
      : `Live checkout is still being configured. If it is not ready by then, access will remain free until it is.`;
    const freeNotice = beforeBillingStart
      ? `<div class="billing-free-notice" role="status"><strong>${plansData?.freeTier?.fullTimelines?`Supporter tools are open through ${esc(freeUntil)}. Reading stays free.`:`Free for everyone through ${esc(freeUntil)}.`}</strong><span>${freePeriodCopy}</span></div>`
      : plansData?.enabled ? '' : '<div class="billing-free-notice" role="status"><strong>Live billing setup is pending.</strong><span>Reading stays free until PayPal checkout is ready.</span></div>';
    const recurringNotice = plansData?.subscriptionsAccessRequired ? '<div class="billing-alert" role="status"><p>PayPal has not confirmed recurring Subscriptions API access for this app yet. Checkout remains off until that access and the live plans are verified.</p></div>' : '';
    const renewalTerms = `${recurring ? 'Subscriptions renew automatically at the interval shown after the first charge date. Cancel from this page at any time before a future renewal. ' : ''}${passes ? 'A one-time pass does not auto-renew and provides the access period shown. ' : ''}${user ? 'Manage any recurring subscription on this page.' : ''}`;
    const freeEyebrow = beforeBillingStart ? `FREE THROUGH ${esc(freeUntil)}` : plansData?.enabled ? 'FREE READER' : 'FREE WHILE SETUP IS PENDING';
    const freeCadence = plansData?.freeTier?.fullTimelines ? 'always available' : beforeBillingStart ? `through ${esc(freeUntil)}` : plansData?.enabled ? 'limited access' : 'until checkout is ready';
    target.innerHTML = `<article class="billing-page"><header class="billing-hero"><a class="text-button" href="/account">← Your account</a><div class="eyebrow">THREADNEWS MEMBERSHIP</div><h1>Keep the story<br><em>open and unfolding.</em></h1><p class="billing-intro">Read the latest news for free. Supporter access expands the historical record and helps keep ThreadNews independent and source-led.</p><div class="billing-mode" role="status"><span aria-hidden="true"></span>${esc(env)}${plansData?.enabled ? '' : ' · billing is not active yet'}</div></header>${freeNotice}${error ? `<div class="billing-alert" role="alert"><p>${esc(error)}</p><button class="text-button" type="button" data-action="billing-retry">Retry</button></div>` : ''}${loading && !plansData ? '<p class="billing-loading" role="status">Loading current plans…</p>' : ''}${recurringNotice}<section class="billing-current-status" aria-live="polite"><div><span class="eyebrow">YOUR PLAN</span><p>${user ? esc(statusText()) : 'Sign in to see or manage a supporter plan. Reading remains open to everyone.'}</p></div>${active ? '<span class="billing-active-badge">SUPPORTER</span>' : ''}${cancelControl()}</section><section class="billing-plans" aria-labelledby="billing-plans-title"><div class="billing-section-heading"><span class="eyebrow">OPEN READING. DEEPER CONTEXT.</span><h2 id="billing-plans-title">Choose how you support the thread.</h2><p>Prices, included features and availability come from the current plan catalog.</p></div><div class="billing-grid"><article class="billing-plan billing-free"><div class="billing-plan-top"><span class="eyebrow">${freeEyebrow}</span></div><h3>Free reader</h3><p class="billing-price"><strong>$0</strong><span>${freeCadence}</span></p>${freeFeatures}<span class="billing-current">No account or payment required</span></article>${plans.length ? plans.map(planCard).join('') : '<div class="billing-empty"><h3>Supporter plans are being prepared.</h3><p>ThreadNews is free while the live PayPal app, recurring plans and webhook are being configured. No payment details are requested here.</p></div>'}</div></section><section class="billing-details"><div><span class="eyebrow">HOW MEMBERSHIP WORKS</span><h2>Clear prices. Clear access.</h2></div><p>Access is verified by ThreadNews after PayPal confirms payment. Membership does not change source attribution or how stories are selected.</p></section><p class="billing-terms">${plansData?.environment === 'sandbox' ? 'This is a PayPal sandbox flow. Sandbox transactions are for testing and do not collect live payments. ' : ''}${renewalTerms}ECB-derived information is also freely available from <a href="https://www.ecb.europa.eu/" target="_blank" rel="noopener noreferrer">the ECB</a>. Questions? <a href="mailto:contactus@threadnews.online">Contact ThreadNews</a>.</p></article>`;
    document.title = 'Membership — ThreadNews';
  }

  async function load(force = false) {
    if (!connected) { render(); return; }
    if (loading || (!force && loadedAt && Date.now() - loadedAt < 60000)) { render(); return; }
    loading = true; error = ''; render();
    try {
      plansData = await request('/api/billing/plans');
      billingStatus = getSession()?.user ? await request('/api/billing/status') : null;
      const params = new URLSearchParams(location.search);
      const subscriptionId = params.get('subscription_id') || params.get('subscriptionId');
      const checkout = params.get('checkout') || '';
      const orderId = checkout === 'order-approved' ? (params.get('token') || params.get('order_id') || params.get('orderId')) : null;
      if ((subscriptionId || orderId) && getSession()?.user && !confirming) {
        confirming = true;
        try {
          const result = subscriptionId
            ? await request('/api/billing/confirm', { method: 'POST', body: { subscriptionId } })
            : await request('/api/billing/confirm-order', { method: 'POST', body: { orderId } });
          billingStatus = result.status || result;
          if (billingStatus?.entitled) toast?.('PayPal confirmed your payment. Supporter access is active.');
          else toast?.('PayPal returned. ThreadNews is waiting for its verified payment confirmation before enabling supporter access.');
          const cleanUrl = new URL(location.href); ['subscription_id','subscriptionId','ba_token','order_id','orderId','token','PayerID','checkout'].forEach(key => cleanUrl.searchParams.delete(key));
          history.replaceState(history.state, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
        } finally { confirming = false; }
      } else if (checkout === 'cancelled') {
        toast?.('Checkout was not completed. Your ThreadNews access was not changed.');
        const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('checkout');
        history.replaceState(history.state, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
      loadedAt = Date.now();
      loadedFor = getSession()?.user?.id || null;
    } catch (failure) { error = friendlyError(failure); }
    finally { loading = false; render(); }
  }

  async function checkout(planKey, startChoice = 'scheduled') {
    if (busy) return;
    if (!getSession()?.user) { signIn(); return; }
    if (!['sandbox', 'live'].includes(plansData?.environment)) { error = 'PayPal checkout is not configured for this page.'; render(); return; }
    const plan = plansData?.plans?.find(item => item.key === planKey);
    if (!plan || !plan.available || !plansData.enabled || !['subscription', 'order'].includes(plan.checkout)) { error = 'That plan is not available for PayPal checkout.'; render(); return; }
    const terms=plansData.terms;
    const schedule=billingTerms();
    const future=startChoice!=='immediate'&&Date.now()<Date.parse(schedule.billingStartsAt);
    const charge=future?`Your first payment is scheduled for ${schedule.billingStartLabel || dateLabel(schedule.billingStartsAt)}.`:`You will be charged ${price(plan)} when you approve in PayPal.`;
    if(terms?.published&&!window.confirm(`${charge} This plan renews at ${price(plan)} ${interval(plan)} until cancelled. Read /terms for cancellation and refunds. Do you agree to membership terms ${terms.version} and this recurring plan?`))return;
    busy = true; error = ''; render();
    try {
      const endpoint = plan.checkout === 'order' ? '/api/billing/orders' : '/api/billing/subscriptions';
      const result = await request(endpoint, { method: 'POST', body: { planKey,...(startChoice==='immediate'?{startChoice}:{}),...(terms?.published?{acceptTerms:true,termsVersion:terms.version}:{}) } });
      const approval = new URL(result.approvalUrl);
      const liveHost = ['paypal.com', 'www.paypal.com', 'checkout.paypal.com'].includes(approval.hostname.toLowerCase());
      const sandboxHost = ['www.sandbox.paypal.com', 'sandbox.paypal.com', 'checkout.sandbox.paypal.com'].includes(approval.hostname.toLowerCase());
      if (approval.protocol !== 'https:' || (plansData.environment === 'live' ? !liveHost : !sandboxHost)) throw new Error('PayPal returned an unexpected checkout link. Please contact ThreadNews.');
      location.assign(approval.href);
    } catch (failure) { error = friendlyError(failure); busy = false; render(); }
  }

  function signIn() {
    try { sessionStorage.setItem('threadnews-after-signin', '/pricing'); } catch {}
    navigate?.('/signin');
  }

  async function cancel() {
    if (billingStatus?.subscription?.checkoutKind !== 'subscription') return;
    if (busy || !window.confirm('Cancel this ThreadNews subscription? PayPal will stop future charges. If the subscription has not started yet, you will not be charged.')) return;
    busy = true; error = ''; render();
    try { const result = await request('/api/billing/cancel', { method: 'POST' }); billingStatus = result.status || result; loadedAt = 0; toast?.('Cancellation request sent to PayPal.'); }
    catch (failure) { error = friendlyError(failure); }
    finally { busy = false; render(); }
  }

  function handleAction(event, button) {
    const action = button?.dataset?.action;
    if (!action?.startsWith('billing-')) return false;
    event.preventDefault();
    if (action === 'billing-checkout') void checkout(button.dataset.plan || '',button.dataset.start || 'scheduled');
    if (action === 'billing-cancel') void cancel();
    if (action === 'billing-retry') { loadedAt = 0; void load(true); }
    if (action === 'billing-signin') signIn();
    return true;
  }

  function renderPage() {
    render();
    const params = new URLSearchParams(location.search);
    const currentUser = getSession()?.user?.id || null;
    const hasReturn = params.has('subscription_id') || params.has('subscriptionId') || ['order-approved', 'cancelled'].includes(params.get('checkout')) && (params.get('checkout') !== 'order-approved' || params.has('token') || params.has('order_id') || params.has('orderId'));
    if (connected && (!loadedAt || loadedFor !== currentUser || hasReturn) && !loading) void load(true);
  }

  return { render: renderPage, handleAction, refresh: () => load(true) };
};
