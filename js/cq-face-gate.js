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
    const refPhoto    = opts.refPhoto   || null;
    const onVerified  = opts.onVerified;
    const onCancel    = opts.onCancel;
    const headline    = opts.headline   || 'Verify identity';
    const sub         = opts.sub        || 'Look at the camera — live face check before entering.';
    const cancelText  = opts.cancelText || 'Cancel';
    // When `allowUpload` is true (typically for "capture a reference photo"
    // flows where refPhoto is null), the gate renders an additional
    // "Use a photo" button that opens the file picker. The selected photo
    // is validated for face quality + obstructions and then treated as the
    // captured frame, satisfying onVerified.
    const allowUpload = !!opts.allowUpload;

    const overlay = document.createElement('div');
    overlay.className = 'face-gate-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const provider = (root.cqFacetec && !root.cqFacetec.simMode)
      ? `<span class="provider-badge is-live" title="Live identity verification"><span class="dot"></span>LIVE VERIFY · MIN ${root.cqFacetec.minMatchLevel}/9</span>`
      : `<span class="provider-badge is-sim" title="Simulation mode — no live verification server configured"><span class="dot"></span>SIMULATION</span>`;

    const uploadBtnHtml = allowUpload
      ? `<button class="btn btn-ghost btn-block" data-role="upload" type="button" style="margin-top:6px;">
           <span data-icon="upload"></span> Use a photo instead
         </button>
         <input type="file" data-role="file" accept="image/*" style="display:none" />`
      : '';

    overlay.innerHTML =
      `<div class="face-gate-card">
         <button class="theme-toggle capture-theme" data-theme-toggle type="button" aria-label="Toggle theme for better lighting"></button>
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
         <button class="btn btn-ghost btn-block" data-role="refresh" type="button" style="display:none; margin-top:6px;">
           <span data-icon="refresh"></span> Refresh camera
         </button>
         ${uploadBtnHtml}
         <button class="btn btn-ghost btn-block" data-role="cancel" type="button" style="margin-top:6px;">${escapeHtml(cancelText)}</button>
       </div>`;
    document.body.appendChild(overlay);
    // Hydrate the theme toggle so its icon paints and click is wired.
    if (root.cqTheme) {
      const tt = overlay.querySelector('[data-theme-toggle]');
      if (tt) {
        const c = root.cqTheme.current ? root.cqTheme.current() : 'dark';
        const iconKey = c === 'light' ? 'moon' : 'sun';
        tt.innerHTML = (root.cqIcons && root.cqIcons[iconKey]) || '';
        tt.title = c === 'light' ? 'Switch to dark' : 'Switch to light';
        tt.addEventListener('click', () => {
          if (root.cqTheme.toggle) root.cqTheme.toggle();
          // Re-paint our local toggle icon since the global hydrator
          // doesn't run in this isolated overlay.
          const cn = root.cqTheme.current();
          const ik = cn === 'light' ? 'moon' : 'sun';
          tt.innerHTML = (root.cqIcons && root.cqIcons[ik]) || '';
        });
      }
    }

    const video     = overlay.querySelector('[data-role="video"]');
    const vf        = overlay.querySelector('[data-role="vf"]');
    const statusEl  = overlay.querySelector('[data-role="status"]');
    const cancelBtn = overlay.querySelector('[data-role="cancel"]');
    const refreshBtn= overlay.querySelector('[data-role="refresh"]');
    const uploadBtn = overlay.querySelector('[data-role="upload"]');
    const fileInput = overlay.querySelector('[data-role="file"]');
    cqIconsHydrate(overlay);

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

    // Camera initialization wrapped in a function so the "Refresh camera"
    // button can re-run it without reloading the page.
    const initCamera = async () => {
      // Tear down any prior stream cleanly.
      try { if (stream) cqFacetec.closeStream(stream); } catch {}
      stream = null;
      refreshBtn.style.display = 'none';
      try {
        stream = await cqFacetec.openCamera(video);
      } catch {
        statusEl.textContent = 'CAMERA BLOCKED — TAP REFRESH OR ALLOW ACCESS';
        statusEl.className = 'viewfinder-status is-denied';
        vf.className = 'viewfinder is-denied';
        refreshBtn.style.display = '';
        return false;
      }
      gateStart = Date.now();
      statusEl.textContent = 'CENTER FACE IN RETICLE';
      statusEl.className = 'viewfinder-status is-verifying';
      vf.className = 'viewfinder is-verifying';
      // Restart the verification tick.
      if (timer) { clearInterval(timer); timer = null; }
      tick();
      timer = setInterval(tick, 900);
      return true;
    };

    refreshBtn.addEventListener('click', () => { initCamera(); });

    // Upload-instead handler. Validates the photo (face + no obstructions)
    // and, if good, treats it as the captured frame for onVerified.
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f || !f.type.startsWith('image/')) return;
        statusEl.textContent = 'CHECKING PHOTO…';
        statusEl.className = 'viewfinder-status is-verifying';
        vf.className = 'viewfinder is-verifying';
        const reader = new FileReader();
        reader.onload = async () => {
          const resized = await cqFacetec.captureFromDataUrl(reader.result, 480);
          const verdict = await cqFacetec.verifyEnrollmentPhoto(resized);
          if (!verdict.ok) {
            const msg = ({
              'multiple-faces':   'TOO MANY FACES IN PHOTO',
              'no-face-detected': 'NO CLEAR FACE — TRY ANOTHER',
              'eyes-obstructed':  'EYES NOT VISIBLE — REMOVE SUNGLASSES',
              'mouth-obstructed': 'MOUTH NOT VISIBLE — REMOVE MASK',
              'face-too-small':   'FACE TOO SMALL — USE A CLOSER PHOTO',
            })[verdict.reason] || 'PHOTO REJECTED — TRY ANOTHER';
            statusEl.textContent = msg;
            statusEl.className = 'viewfinder-status is-denied';
            vf.className = 'viewfinder is-denied';
            return;
          }
          statusEl.textContent = 'PHOTO ACCEPTED · ENTERING…';
          statusEl.className = 'viewfinder-status is-verified';
          vf.className = 'viewfinder is-verified';
          if (timer) { clearInterval(timer); timer = null; }
          setTimeout(() => {
            cleanup();
            if (typeof onVerified === 'function') onVerified({ frame: resized, source: 'upload' });
          }, 380);
        };
        reader.readAsDataURL(f);
      });
    }

    // The tick function is the live verification loop (face count +
    // liveness + match). Defined out here so initCamera can re-arm it on
    // refresh without redefining the closure.
    tick = async () => {
      if (checking || done) return;
      checking = true;
      const inGrace = Date.now() - gateStart < GRACE_MS;
      try {
        const faceN = await cqFacetec.detectFaceCount(video);

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

        statusEl.textContent = 'VERIFYING IDENTITY…';
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
            if (typeof onVerified === 'function') onVerified({ frame: r.frame, matchLevel: r.matchLevel, zoom: r.zoom });
          }, 420);
        } else if (r.refUnreadable) {
          statusEl.textContent = 'ENROLLED PHOTO UNUSABLE — RE-ENROLL';
          statusEl.className = 'viewfinder-status is-denied';
          vf.className = 'viewfinder is-denied';
          if (timer) { clearInterval(timer); timer = null; }
        } else if (String(r.reason || '').startsWith('no-match') && !inGrace) {
          const lvl = r.bestMatchLevel;
          statusEl.textContent = (typeof lvl === 'number')
            ? `FACE DOES NOT MATCH · LEVEL ${lvl}/9 (NEED ${cqFacetec.minMatchLevel}+)`
            : 'FACE DOES NOT MATCH';
          statusEl.className = 'viewfinder-status is-denied';
          vf.className = 'viewfinder is-denied';
        } else {
          statusEl.textContent = 'VERIFYING IDENTITY…';
        }
      } finally { checking = false; }
    };

    initCamera();
  };

  root.cqFaceGate = { verify };
})(window);
