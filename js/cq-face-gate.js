// Cryptiq Secure Line — reusable face-gate modal.
// Opens an overlay with a live camera viewfinder, runs continuous 2D liveness
// + 1:1 match against a reference photo, and calls onVerified() on pass.
// Use this right before any privileged action (like entering a call) so the
// person at the keyboard is proven live and identity-matched in the moment.
//
// Usage:
//   cqFaceGate.verify({
//     refPhoto: me.photo,
//     headline: "Verify it's you",
//     sub: 'Live face check before entering.',
//     onVerified: () => cqConnecting.show({ onDone: () => location.href = url }),
//     onCancel:   () => { /* user closed the gate */ },
//   });
(function (root) {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  const verify = (opts) => {
    opts = opts || {};
    const refPhoto   = opts.refPhoto   || null;
    const onVerified = opts.onVerified;
    const onCancel   = opts.onCancel;
    const headline   = opts.headline   || 'Verify identity';
    const sub        = opts.sub        || 'Look at the camera — live face check before entering.';
    const cancelText = opts.cancelText || 'Cancel';

    const overlay = document.createElement('div');
    overlay.className = 'face-gate-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const provider = (root.cqFacetec && !root.cqFacetec.simMode)
      ? `<span class="provider-badge is-live" title="Live identity verification"><span class="dot"></span>LIVE VERIFY · MIN ${root.cqFacetec.minMatchLevel}/9</span>`
      : `<span class="provider-badge is-sim" title="Simulation mode — no live verification server configured"><span class="dot"></span>SIMULATION</span>`;

    overlay.innerHTML =
      `<div class="face-gate-card">
         <div class="card-eyebrow"><span class="dot"></span>IDENTITY GATE</div>
         <h2 class="face-gate-title">${escapeHtml(headline)}</h2>
         <p class="face-gate-lead">${escapeHtml(sub)}</p>
         <div class="viewfinder" data-role="vf">
           <video data-role="video" autoplay playsinline muted></video>
           <div class="reticle"></div>
           <div class="scanline"></div>
         </div>
         <div class="viewfinder-status" data-role="status">STARTING CAMERA…</div>
         ${provider}
         <button class="btn btn-ghost btn-block" data-role="cancel" type="button">${escapeHtml(cancelText)}</button>
       </div>`;
    document.body.appendChild(overlay);

    const video     = overlay.querySelector('[data-role="video"]');
    const vf        = overlay.querySelector('[data-role="vf"]');
    const statusEl  = overlay.querySelector('[data-role="status"]');
    const cancelBtn = overlay.querySelector('[data-role="cancel"]');

    let stream   = null;
    let timer    = null;
    let checking = false;
    let done     = false;
    let gateStart = 0;
    const GRACE_MS = 2500;  // settle-in window — hide transient negatives

    const cleanup = () => {
      if (done) return;
      done = true;
      if (timer) { clearInterval(timer); timer = null; }
      try { if (root.cqFacetec) cqFacetec.closeStream(stream); } catch {}
      overlay.remove();
    };

    cancelBtn.addEventListener('click', () => {
      cleanup();
      if (typeof onCancel === 'function') onCancel();
    });

    (async () => {
      try {
        stream = await cqFacetec.openCamera(video);
      } catch {
        statusEl.textContent = 'CAMERA BLOCKED';
        statusEl.className = 'viewfinder-status is-denied';
        vf.className = 'viewfinder is-denied';
        return;
      }
      gateStart = Date.now();
      statusEl.textContent = 'CENTER FACE IN RETICLE';
      statusEl.className = 'viewfinder-status is-verifying';
      vf.className = 'viewfinder is-verifying';

      const tick = async () => {
        if (checking || done) return;
        checking = true;
        const inGrace = Date.now() - gateStart < GRACE_MS;
        try {
          const faceN = await cqFacetec.detectFaceCount(video);

          // During the grace window (while the camera is focusing and the
          // user is settling into frame) suppress negative verdicts — just
          // keep the neutral "centre face" prompt.
          if (faceN !== null && faceN > 1) {
            if (inGrace) {
              statusEl.textContent = 'CENTER FACE IN RETICLE';
              statusEl.className = 'viewfinder-status is-verifying';
              vf.className = 'viewfinder is-verifying';
              return;
            }
            statusEl.textContent = 'MULTIPLE FACES — STEP AWAY';
            statusEl.className = 'viewfinder-status is-denied';
            vf.className = 'viewfinder is-denied';
            return;
          }
          if (faceN === 0) {
            statusEl.textContent = inGrace ? 'CENTER FACE IN RETICLE' : 'NO FACE DETECTED';
            statusEl.className = 'viewfinder-status is-verifying';
            vf.className = 'viewfinder is-verifying';
            return;
          }

          statusEl.textContent = 'VERIFYING LIVENESS…';
          const r = await cqFacetec.gate(video, refPhoto);
          if (r.ok) {
            statusEl.textContent = typeof r.matchLevel === 'number'
              ? `VERIFIED · MATCH ${r.matchLevel}/9 · ENTERING…`
              : 'VERIFIED · ENTERING…';
            statusEl.className = 'viewfinder-status is-verified';
            vf.className = 'viewfinder is-verified';
            if (timer) { clearInterval(timer); timer = null; }
            setTimeout(() => {
              cleanup();
              // Pass the captured frame + matchLevel to the caller so it
              // can be used as a reference photo for downstream matching
              // (e.g. seeding a demo participant with a real face).
              if (typeof onVerified === 'function') onVerified({ frame: r.frame, matchLevel: r.matchLevel, zoom: r.zoom });
            }, 420);
          } else if (r.refUnreadable) {
            // Hard fail: enrolled photo can't be processed for matching.
            // Without re-enrolling, the user can never pass — don't lie.
            statusEl.textContent = 'ENROLLED PHOTO UNUSABLE — RE-ENROLL';
            statusEl.className = 'viewfinder-status is-denied';
            vf.className = 'viewfinder is-denied';
            if (timer) { clearInterval(timer); timer = null; }
          } else if (String(r.reason || '').startsWith('no-match') && !inGrace) {
            // Surface the actual matchLevel so it's clear how far off we are.
            const lvl = r.bestMatchLevel;
            statusEl.textContent = (typeof lvl === 'number')
              ? `FACE DOES NOT MATCH · LEVEL ${lvl}/9 (NEED ${cqFacetec.minMatchLevel}+)`
              : 'FACE DOES NOT MATCH';
            statusEl.className = 'viewfinder-status is-denied';
            vf.className = 'viewfinder is-denied';
          } else {
            // Any other failure during grace stays neutral; after grace
            // just show verifying until the next tick resolves.
            statusEl.textContent = 'VERIFYING LIVENESS…';
          }
        } finally { checking = false; }
      };
      tick();
      timer = setInterval(tick, 900);
    })();
  };

  root.cqFaceGate = { verify };
})(window);
