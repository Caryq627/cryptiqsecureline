// Cryptiq Secure Line — "Connecting to secure line…" transition overlay.
// Reuses the intro-loader styling, so the same bracket/dot link-up sequence
// and rotating rings play. Drop it in right before navigating to call.html.
//
// Usage:
//   cqConnecting.show({ onDone: () => { location.href = callUrl; } });
(function (root) {
  const TOTAL_MS   = 2800;   // total time before onDone fires
  const CONFIRM_AT = 2100;   // swap the tag to "secure line established" here

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  // Same glyph + rings as the landing intro. Inlined so CSS animations can
  // target each bracket/dot directly (no <use> shadow DOM).
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
    const tag      = opts.tag      || 'Establishing secure channel…';
    const tagAfter = opts.tagAfter || 'Secure line established — entering…';
    const onDone   = opts.onDone;

    // Prevent duplicate overlays if triggered twice in quick succession.
    if (document.querySelector('.intro-loader[data-cq-connecting]')) return;

    const wrap = document.createElement('div');
    wrap.className = 'intro-loader';
    wrap.setAttribute('data-cq-connecting', '1');
    wrap.setAttribute('aria-hidden', 'false');
    wrap.setAttribute('role', 'status');
    // Keep the headline option for custom messaging, but the brand image is
    // always the Cryptiq wordmark so it reads consistently everywhere.
    wrap.innerHTML =
      glyphMarkup() +
      `<div class="intro-wordmark">
         <span class="cq-wordmark-img" role="img" aria-label="${escapeHtml(headline)}"></span>
         <div class="sml">${escapeHtml(sub)}</div>
       </div>
       <div class="intro-tag" data-role="tag">${escapeHtml(tag)}</div>`;
    document.body.appendChild(wrap);

    // Swap the tag copy once the glyph finishes its link-up sequence.
    setTimeout(() => {
      const tagEl = wrap.querySelector('[data-role="tag"]');
      if (!tagEl) return;
      tagEl.style.transition = 'opacity 0.22s ease, color 0.22s ease';
      tagEl.style.opacity = '0';
      setTimeout(() => {
        tagEl.textContent = tagAfter;
        tagEl.style.color = 'var(--accent)';
        tagEl.style.opacity = '1';
      }, 230);
    }, CONFIRM_AT);

    setTimeout(() => {
      if (typeof onDone === 'function') onDone();
    }, TOTAL_MS);
  };

  root.cqConnecting = { show };
})(window);
