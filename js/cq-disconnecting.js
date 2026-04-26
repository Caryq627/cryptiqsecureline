// Cryptiq Secure Line — "Disconnecting…" transition overlay.
// Mirror image of cq-connecting: same glyph, but the link-up sequence
// runs in reverse and the copy frames it as the channel tearing down.
//
// Usage:
//   cqDisconnecting.show({ onDone: () => { location.href = '/'; } });
(function (root) {
  const TOTAL_MS  = 2400;
  const SECOND_AT = 1500;

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  // Same glyph markup as the connecting overlay; only difference is we
  // tag the wrapper with `is-disconnecting` so the link-up CSS plays in
  // reverse (white-out → desaturate).
  const glyphMarkup = () => `
    <svg class="cq-logo intro-logo" viewBox="0 0 240 240" aria-hidden="true">
      <circle class="cq-ring cq-ring-1" cx="120" cy="120" r="114"
              fill="none" stroke="#2ec4b6" stroke-opacity="0.85"
              stroke-width="1.8" stroke-linecap="round"
              stroke-dasharray="110 40 78 30 120 32 60 34"/>
      <circle class="cq-ring cq-ring-2" cx="120" cy="120" r="96"
              fill="none" stroke="#2ec4b6" stroke-opacity="0.60"
              stroke-width="1.4" stroke-linecap="round"
              stroke-dasharray="58 28 95 24 72 28 95 28"/>
      <circle class="cq-ring cq-ring-3" cx="120" cy="120" r="80"
              fill="none" stroke="#2ec4b6" stroke-opacity="0.38"
              stroke-width="1.1" stroke-linecap="round"
              stroke-dasharray="70 22 90 28 110 26 50 24"/>
      <g class="cq-phones" transform="translate(120 120)">
        <polyline class="cq-bracket cq-bracket-l" points="-16,-36 -50,0 -16,36"
                  fill="none" stroke-width="11"
                  stroke-linecap="round" stroke-linejoin="round"/>
        <polyline class="cq-bracket cq-bracket-r" points="16,-36 50,0 16,36"
                  fill="none" stroke-width="11"
                  stroke-linecap="round" stroke-linejoin="round"/>
        <circle class="cq-dot cq-dot-1" cx="-18" cy="0" r="6"/>
        <circle class="cq-dot cq-dot-2" cx="0"   cy="0" r="6"/>
        <circle class="cq-dot cq-dot-3" cx="18"  cy="0" r="6"/>
      </g>
    </svg>
  `;

  const show = (opts) => {
    opts = opts || {};
    const headline = opts.headline || 'CRYPTIQ';
    const sub      = opts.sub      || 'SECURE LINE';
    const tag      = opts.tag      || 'Scrubbing records · burning connection…';
    const tagAfter = opts.tagAfter || 'Channel sealed. You are off the line.';
    const onDone   = opts.onDone;

    if (document.querySelector('.intro-loader[data-cq-disconnecting]')) return;

    const wrap = document.createElement('div');
    wrap.className = 'intro-loader is-disconnecting';
    wrap.setAttribute('data-cq-disconnecting', '1');
    wrap.setAttribute('aria-hidden', 'false');
    wrap.setAttribute('role', 'status');
    wrap.innerHTML =
      glyphMarkup() +
      `<div class="intro-wordmark">
         <span class="cq-wordmark-img" role="img" aria-label="${escapeHtml(headline)}"></span>
         <div class="sml">${escapeHtml(sub)}</div>
       </div>
       <div class="intro-tag" data-role="tag">${escapeHtml(tag)}</div>`;
    document.body.appendChild(wrap);

    setTimeout(() => {
      const tagEl = wrap.querySelector('[data-role="tag"]');
      if (!tagEl) return;
      tagEl.style.transition = 'opacity 0.22s ease, color 0.22s ease';
      tagEl.style.opacity = '0';
      setTimeout(() => {
        tagEl.textContent = tagAfter;
        tagEl.style.color = 'var(--fg-muted)';
        tagEl.style.opacity = '1';
      }, 230);
    }, SECOND_AT);

    setTimeout(() => {
      if (typeof onDone === 'function') onDone();
    }, TOTAL_MS);
  };

  root.cqDisconnecting = { show };
})(window);
