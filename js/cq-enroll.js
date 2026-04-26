// Cryptiq Secure Line — reusable face-enrollment modal.
// Two tabs: live capture (manual shutter button) or upload (with pan/zoom
// editor). Both paths run through cqFacetec.verifyEnrollmentPhoto so only
// good, unobstructed faces ever come back through onCaptured.
//
// Usage:
//   cqEnroll.show({
//     headline: 'Capture your face',
//     sub: 'Take a photo or upload one. Eyes + mouth must be visible.',
//     onCaptured: (photo) => { /* validated dataURL */ },
//     onCancel:   () => { /* user backed out */ },
//   });
(function (root) {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  const ERROR_COPY = {
    'multiple-faces':   'TOO MANY FACES — TRY ANOTHER',
    'no-face-detected': 'NO CLEAR FACE — TRY ANOTHER',
    'eyes-obstructed':  'EYES NOT VISIBLE — REMOVE SUNGLASSES',
    'mouth-obstructed': 'MOUTH NOT VISIBLE — REMOVE MASK',
    'face-too-small':   'FACE TOO SMALL — USE A CLOSER PHOTO',
    'low-quality':      'PHOTO TOO LOW QUALITY — TRY A CLEARER ONE',
  };

  const show = (opts) => {
    opts = opts || {};
    const headline   = opts.headline   || 'Capture your face';
    const sub        = opts.sub        || 'Take a photo or upload one. Eyes + mouth must be visible.';
    const cancelText = opts.cancelText || 'Cancel';
    const onCaptured = opts.onCaptured;
    const onCancel   = opts.onCancel;

    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay is-open';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="capture-card">
        <button class="theme-toggle capture-theme" data-theme-toggle type="button" aria-label="Toggle theme for better lighting"></button>
        <div class="card-eyebrow"><span class="dot"></span>ENROLL FACE</div>
        <h2 class="cap-heading" style="font-size:22px; margin:0 0 8px; font-weight:600;">${escapeHtml(headline)}</h2>
        <p class="lead" style="margin:0 0 16px; font-size:13px; color:var(--fg-muted);">${escapeHtml(sub)}</p>

        <div class="mode-tabs">
          <button type="button" class="mode-tab is-on" data-mode="camera">
            <span data-icon="camera"></span> Live capture
          </button>
          <button type="button" class="mode-tab" data-mode="upload">
            <span data-icon="upload"></span> Upload photo
          </button>
        </div>

        <!-- ===== Camera pane ===== -->
        <div data-pane="camera">
          <div class="viewfinder" data-role="cam-vf">
            <video data-role="cam-video" autoplay playsinline muted></video>
            <div class="reticle"></div>
            <div class="scanline"></div>
          </div>
          <div class="viewfinder-status" data-role="cam-status">STARTING CAMERA…</div>
          <button class="btn btn-primary btn-block" data-role="cam-capture" type="button" disabled>
            <span data-icon="camera"></span> Capture photo
          </button>
        </div>

        <!-- ===== Upload pane ===== -->
        <div data-pane="upload" hidden>
          <div class="viewfinder upload-editor" data-role="upload-frame">
            <div class="upload-placeholder" data-role="upload-placeholder">
              <div class="upload-placeholder-icon" data-icon="upload"></div>
              <div class="upload-placeholder-text">tap to upload</div>
            </div>
            <img class="upload-img" data-role="upload-img" alt="" draggable="false" />
          </div>
          <input type="file" accept="image/*" style="display:none" data-role="upload-file" />
          <div class="viewfinder-status" data-role="upload-status">CHOOSE A PHOTO</div>
          <div class="upload-zoom-row" data-role="upload-zoom-row" style="display:none;">
            <span class="zoom-label">ZOOM</span>
            <input type="range" min="1" max="3" step="0.02" value="1" class="upload-zoom" data-role="upload-zoom" />
            <button class="btn-link-action" data-role="upload-redo" type="button">Choose different</button>
          </div>
        </div>

        <button class="btn btn-ghost btn-block" data-role="cancel" type="button" style="margin-top:10px;">${escapeHtml(cancelText)}</button>
      </div>
    `;
    document.body.appendChild(overlay);
    if (root.cqIconsHydrate) root.cqIconsHydrate(overlay);

    // Wire the local theme toggle (cqTheme exists once theme.js has run).
    if (root.cqTheme) {
      const tt = overlay.querySelector('[data-theme-toggle]');
      if (tt) {
        const paint = () => {
          const c = root.cqTheme.current ? root.cqTheme.current() : 'dark';
          const ik = c === 'light' ? 'moon' : 'sun';
          tt.innerHTML = (root.cqIcons && root.cqIcons[ik]) || '';
          tt.title = c === 'light' ? 'Switch to dark' : 'Switch to light';
        };
        paint();
        tt.addEventListener('click', () => { root.cqTheme.toggle && root.cqTheme.toggle(); paint(); });
      }
    }

    // ---- DOM refs ----
    const $ = (sel) => overlay.querySelector(sel);
    const camPane    = $('[data-pane="camera"]');
    const upPane     = $('[data-pane="upload"]');
    const camVf      = $('[data-role="cam-vf"]');
    const camVideo   = $('[data-role="cam-video"]');
    const camStatus  = $('[data-role="cam-status"]');
    const camCapture = $('[data-role="cam-capture"]');
    const upFrame    = $('[data-role="upload-frame"]');
    const upHolder   = $('[data-role="upload-placeholder"]');
    const upImg      = $('[data-role="upload-img"]');
    const upFile     = $('[data-role="upload-file"]');
    const upStatus   = $('[data-role="upload-status"]');
    const upZoomRow  = $('[data-role="upload-zoom-row"]');
    const upZoom     = $('[data-role="upload-zoom"]');
    const upRedo     = $('[data-role="upload-redo"]');
    const cancelBtn  = $('[data-role="cancel"]');

    // ---- State ----
    let mode = 'camera';
    let camStream = null;
    let camDetectTimer = null;
    let camFaceOk = false;
    let busy = false;        // true while validating; blocks other actions
    let done = false;

    const setStatus = (el, text, kind) => {
      el.textContent = text;
      el.className = 'viewfinder-status' + (kind ? ' ' + kind : '');
    };
    const setVfClass = (el, kind) => {
      // Preserve "upload-editor" on the upload frame even when status changes.
      const base = el.classList.contains('upload-editor') ? 'viewfinder upload-editor' : 'viewfinder';
      el.className = base + (kind ? ' ' + kind : '');
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      if (camDetectTimer) { clearInterval(camDetectTimer); camDetectTimer = null; }
      try { if (root.cqFacetec) root.cqFacetec.closeStream(camStream); } catch {}
      camStream = null;
      overlay.remove();
    };

    cancelBtn.addEventListener('click', () => {
      cleanup();
      if (typeof onCancel === 'function') onCancel();
    });

    // ---- Tab switching ----
    overlay.querySelectorAll('.mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.mode;
        if (next === mode) return;
        overlay.querySelectorAll('.mode-tab').forEach(b => b.classList.toggle('is-on', b === btn));
        mode = next;
        if (mode === 'camera') {
          camPane.hidden = false;
          upPane.hidden  = true;
          startCamera();
        } else {
          camPane.hidden = true;
          upPane.hidden  = false;
          stopCamera();
          resetUpload();
          setTimeout(() => { try { upFile.click(); } catch {} }, 60);
        }
      });
    });

    // ---- Camera mode ----
    const startCamera = async () => {
      if (camStream) return;
      setStatus(camStatus, 'STARTING CAMERA…');
      setVfClass(camVf, '');
      try {
        camStream = await root.cqFacetec.openCamera(camVideo);
      } catch {
        setStatus(camStatus, 'CAMERA BLOCKED — ALLOW ACCESS OR USE UPLOAD', 'is-denied');
        setVfClass(camVf, 'is-denied');
        return;
      }
      setStatus(camStatus, 'CENTER FACE THEN TAP CAPTURE', 'is-verifying');
      setVfClass(camVf, 'is-verifying');
      // Light face-detection loop: enables Capture only when one face is
      // centered. Doesn't auto-fire — the shutter is manual.
      if (camDetectTimer) clearInterval(camDetectTimer);
      camDetectTimer = setInterval(async () => {
        if (busy || mode !== 'camera') return;
        const n = await root.cqFacetec.detectFaceCount(camVideo);
        if (n === null) {
          // Detector unsupported — enable button optimistically.
          camFaceOk = true;
          camCapture.disabled = false;
          return;
        }
        if (n === 0) {
          camFaceOk = false;
          camCapture.disabled = true;
          setStatus(camStatus, 'CENTER FACE THEN TAP CAPTURE', 'is-verifying');
          setVfClass(camVf, 'is-verifying');
          return;
        }
        if (n > 1) {
          camFaceOk = false;
          camCapture.disabled = true;
          setStatus(camStatus, 'MULTIPLE FACES — STEP AWAY', 'is-denied');
          setVfClass(camVf, 'is-denied');
          return;
        }
        camFaceOk = true;
        camCapture.disabled = false;
        setStatus(camStatus, 'READY · TAP CAPTURE', 'is-verified');
        setVfClass(camVf, 'is-verified');
      }, 700);
    };
    const stopCamera = () => {
      if (camDetectTimer) { clearInterval(camDetectTimer); camDetectTimer = null; }
      try { root.cqFacetec.closeStream(camStream); } catch {}
      camStream = null;
    };

    camCapture.addEventListener('click', async () => {
      if (busy || !camFaceOk) return;
      busy = true;
      camCapture.disabled = true;
      setStatus(camStatus, 'CHECKING PHOTO…', 'is-verifying');
      setVfClass(camVf, 'is-verifying');
      // 720px output for enrollment — preserves enough detail for reliable
      // server-side feature extraction (480 was visibly degrading quality).
      const frame = await root.cqFacetec.captureAroundFace(camVideo, 720);
      const verdict = await root.cqFacetec.verifyEnrollmentPhoto(frame);
      busy = false;
      if (!verdict.ok) {
        const msg = ERROR_COPY[verdict.reason] || 'PHOTO REJECTED — TRY AGAIN';
        setStatus(camStatus, msg, 'is-denied');
        setVfClass(camVf, 'is-denied');
        // Briefly hold the error then reset to ready state (camera continues).
        setTimeout(() => {
          setStatus(camStatus, 'CENTER FACE THEN TAP CAPTURE', 'is-verifying');
          setVfClass(camVf, 'is-verifying');
          camCapture.disabled = false;
        }, 1800);
        return;
      }
      setStatus(camStatus, 'PHOTO ACCEPTED · CONTINUING…', 'is-verified');
      setVfClass(camVf, 'is-verified');
      setTimeout(() => {
        cleanup();
        if (typeof onCaptured === 'function') onCaptured(frame);
      }, 360);
    });

    // ---- Upload mode (pan/zoom editor + validation) ----
    const editor = {
      natW: 0, natH: 0,
      baseScale: 1,
      userScale: 1,
      tx: 0, ty: 0,
      frameSize: 220,
    };

    const applyXf = () => {
      const t = editor.baseScale * editor.userScale;
      upImg.style.transform =
        `translate(-50%, -50%) translate(${editor.tx}px, ${editor.ty}px) scale(${t})`;
    };
    const clampXf = () => {
      const t = editor.baseScale * editor.userScale;
      const half = editor.frameSize / 2;
      const halfDispW = (editor.natW * t) / 2;
      const halfDispH = (editor.natH * t) / 2;
      const maxTx = Math.max(0, halfDispW - half);
      const maxTy = Math.max(0, halfDispH - half);
      editor.tx = Math.max(-maxTx, Math.min(maxTx, editor.tx));
      editor.ty = Math.max(-maxTy, Math.min(maxTy, editor.ty));
    };
    const renderEditorPng = (out = 720) => {
      const c = document.createElement('canvas');
      c.width = out; c.height = out;
      const ctx = c.getContext('2d');
      const t = editor.baseScale * editor.userScale;
      const sw = editor.frameSize / t;
      const sh = editor.frameSize / t;
      const cx = editor.natW / 2 - editor.tx / t;
      const cy = editor.natH / 2 - editor.ty / t;
      ctx.drawImage(upImg, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, out, out);
      // 0.95 quality (near-lossless) — server-side feature extraction
      // works much better when the input isn't compression-degraded.
      return c.toDataURL('image/jpeg', 0.95);
    };

    const resetUpload = () => {
      upImg.src = '';
      upImg.classList.remove('is-loaded');
      upHolder.style.display = '';
      setStatus(upStatus, 'CHOOSE A PHOTO');
      setVfClass(upFrame, '');
      upZoomRow.style.display = 'none';
      upZoom.value = 1;
      editor.userScale = 1; editor.tx = 0; editor.ty = 0;
      upFile.value = '';
    };

    let revalidateTimer = null;
    let revalidateGen = 0;
    const scheduleRevalidate = () => {
      const gen = ++revalidateGen;
      if (revalidateTimer) clearTimeout(revalidateTimer);
      revalidateTimer = setTimeout(() => validateUpload(gen), 350);
    };
    const validateUpload = async (gen) => {
      if (!upImg.classList.contains('is-loaded')) return;
      busy = true;
      setStatus(upStatus, 'CHECKING PHOTO…', 'is-verifying');
      setVfClass(upFrame, 'is-verifying');
      const cropped = renderEditorPng(480);
      const verdict = await root.cqFacetec.verifyEnrollmentPhoto(cropped);
      if (gen !== revalidateGen) return; // user adjusted again
      busy = false;
      if (!verdict.ok) {
        const msg = ERROR_COPY[verdict.reason] || 'PHOTO REJECTED — TRY ANOTHER';
        setStatus(upStatus, msg, 'is-denied');
        setVfClass(upFrame, 'is-denied');
        return;
      }
      setStatus(upStatus, 'PHOTO ACCEPTED · TAP CONTINUE OR ADJUST', 'is-verified');
      setVfClass(upFrame, 'is-verified');
      // Auto-advance shortly after a passing crop so the user doesn't have
      // to hunt for a separate Continue button — but if they want to keep
      // adjusting, a new gesture cancels via scheduleRevalidate.
      setTimeout(() => {
        if (!upImg.classList.contains('is-loaded')) return;
        if (gen !== revalidateGen) return;
        cleanup();
        if (typeof onCaptured === 'function') onCaptured(cropped);
      }, 900);
    };

    upFile.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f || !f.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = async () => {
        // Decode to <img> so the editor knows natural dimensions.
        upImg.onload = () => {
          editor.natW = upImg.naturalWidth;
          editor.natH = upImg.naturalHeight;
          editor.frameSize = upFrame.offsetWidth || 220;
          editor.baseScale = Math.max(
            editor.frameSize / editor.natW,
            editor.frameSize / editor.natH
          );
          editor.userScale = 1; editor.tx = 0; editor.ty = 0;
          upImg.classList.add('is-loaded');
          upHolder.style.display = 'none';
          upZoomRow.style.display = 'flex';
          upZoom.value = 1;
          applyXf();
          scheduleRevalidate();
        };
        // Load at 1024 max to preserve detail for the editor; the cropped
        // output (720px) is what the server actually sees.
        upImg.src = await root.cqFacetec.captureFromDataUrl(reader.result, 1024);
        setStatus(upStatus, 'LOADING PHOTO…', 'is-verifying');
        setVfClass(upFrame, 'is-verifying');
      };
      reader.readAsDataURL(f);
    });

    upRedo.addEventListener('click', () => upFile.click());

    // Pinch + drag inside the upload frame.
    const ptrs = new Map();
    let panStart = null, pinchStart = null, rafQueued = false;
    const flush = () => { rafQueued = false; clampXf(); applyXf(); };
    const queue = () => { if (!rafQueued) { rafQueued = true; requestAnimationFrame(flush); } };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    upFrame.addEventListener('pointerdown', (e) => {
      if (!upImg.classList.contains('is-loaded')) {
        upFile.click();
        return;
      }
      e.preventDefault();
      upFrame.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        panStart = { tx: editor.tx, ty: editor.ty, x: e.clientX, y: e.clientY };
        pinchStart = null;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinchStart = { dist: dist(a, b), scale: editor.userScale };
        panStart = null;
      }
    });
    upFrame.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && pinchStart) {
        const [a, b] = [...ptrs.values()];
        const d = dist(a, b);
        if (pinchStart.dist > 8) {
          editor.userScale = Math.max(1, Math.min(3, pinchStart.scale * (d / pinchStart.dist)));
          upZoom.value = editor.userScale;
          queue();
        }
      } else if (ptrs.size === 1 && panStart) {
        editor.tx = panStart.tx + (e.clientX - panStart.x);
        editor.ty = panStart.ty + (e.clientY - panStart.y);
        queue();
      }
    });
    const ptrEnd = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      try { upFrame.releasePointerCapture(e.pointerId); } catch {}
      if (ptrs.size === 1) {
        const [p] = [...ptrs.values()];
        panStart = { tx: editor.tx, ty: editor.ty, x: p.x, y: p.y };
        pinchStart = null;
      } else if (ptrs.size === 0) {
        panStart = null;
        pinchStart = null;
        scheduleRevalidate();
      }
    };
    upFrame.addEventListener('pointerup', ptrEnd);
    upFrame.addEventListener('pointercancel', ptrEnd);
    upFrame.addEventListener('pointerleave', ptrEnd);

    upFrame.addEventListener('wheel', (e) => {
      if (!upImg.classList.contains('is-loaded')) return;
      e.preventDefault();
      editor.userScale = Math.max(1, Math.min(3, editor.userScale + (-e.deltaY * 0.0025)));
      upZoom.value = editor.userScale;
      queue();
      scheduleRevalidate();
    }, { passive: false });

    upZoom.addEventListener('input', (e) => {
      editor.userScale = parseFloat(e.target.value);
      queue();
      scheduleRevalidate();
    });

    // Empty-frame click opens the file picker. Status text too.
    upStatus.addEventListener('click', () => upFile.click());

    // Drag/drop into the frame.
    ['dragenter','dragover'].forEach(ev =>
      upFrame.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); })
    );
    upFrame.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        upFile.files = e.dataTransfer.files;
        upFile.dispatchEvent(new Event('change'));
      }
    });

    // Kick off camera mode by default.
    startCamera();
  };

  root.cqEnroll = { show };
})(window);
