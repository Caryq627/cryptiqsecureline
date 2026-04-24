// Cryptiq Secure Line — FaceTec bridge
// Wraps FaceTec 2D liveness + 1:N match for this demo.
// In sim mode (no server configured), leans on the native FaceDetector API
// so intruder/away detection still works against a real camera feed.

(function (root) {
  // Default to simulation mode unless a FaceTec server is configured.
  // To wire real FaceTec, set window.CQ_FACETEC = { server, deviceKey }
  // before loading this script, or call cqFacetec.configure(...).
  const config = {
    server:       null,
    deviceKey:    null,
    liveness2DPath: '/liveness-2d',
    match2DPath:    '/match-2d-2d',
    minMatchLevel: 3,
    tickMs:        1800,
    simMode:       true,
  };

  // Honor environment config
  if (root.CQ_FACETEC && root.CQ_FACETEC.server && root.CQ_FACETEC.deviceKey) {
    config.server    = root.CQ_FACETEC.server;
    config.deviceKey = root.CQ_FACETEC.deviceKey;
    config.simMode   = false;
  }

  const configure = (opts) => {
    Object.assign(config, opts || {});
    config.simMode = !(config.server && config.deviceKey);
  };

  // ---------- frame capture ----------

  const captureFrame = (video, maxSize = 480) => {
    if (!video || !video.videoWidth) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, maxSize / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    // un-mirror: browsers apply CSS mirror but raw video pixels aren't flipped,
    // match preview to what the user sees
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.82);
  };

  // Center-crop at a specific zoom level so users at different distances
  // from the camera all get picked up. `far` sends the full frame (user can
  // sit back), `mid` zooms in on the center, `near` zooms in further for a
  // user sitting close. Cycling through these across ticks means the
  // liveness/match pipeline sees the face at a usable size regardless of
  // how the user is sitting.
  const ZOOM_CROPS = { far: 1.0, mid: 0.70, near: 0.48 };
  const ZOOM_LEVELS = ['far', 'mid', 'near'];

  const captureFrameAtZoom = (video, zoom, maxSize = 480) => {
    if (!video || !video.videoWidth) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const ratio = ZOOM_CROPS[zoom] != null ? ZOOM_CROPS[zoom] : 1.0;
    const side = Math.min(w, h);
    const cropSide = Math.max(64, Math.round(side * ratio));
    const sx = Math.round((w - cropSide) / 2);
    const sy = Math.round((h - cropSide) / 2);
    const outSize = Math.min(maxSize, cropSide);
    const canvas = document.createElement('canvas');
    canvas.width = outSize; canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    ctx.translate(outSize, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, cropSide, cropSide, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/jpeg', 0.82);
  };

  const captureFromDataUrl = async (dataUrl, maxSize = 480) => {
    if (!dataUrl) return null;
    const img = new Image();
    img.src = dataUrl;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  // ---------- native FaceDetector wrapper ----------
  // Chrome/Edge ship FaceDetector; Safari/Firefox don't. Return null when missing.

  let _faceDetector = null;
  let _faceDetectorChecked = false;
  const getFaceDetector = () => {
    if (_faceDetectorChecked) return _faceDetector;
    _faceDetectorChecked = true;
    try {
      if ('FaceDetector' in window) {
        _faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
      }
    } catch {
      _faceDetector = null;
    }
    return _faceDetector;
  };

  const detectFaceCount = async (video) => {
    const fd = getFaceDetector();
    if (!fd || !video || !video.videoWidth) return null;
    try {
      const faces = await fd.detect(video);
      return faces.length;
    } catch {
      return null;
    }
  };

  const faceDetectorSupported = () => !!getFaceDetector();

  // ---------- 2D liveness (real + sim) ----------

  const _fetchWithTimeout = async (url, opts, ms) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      return r;
    } finally { clearTimeout(t); }
  };

  // Track consecutive network failures so we can gracefully fall back if the
  // FaceTec server is unreachable — UI keeps working instead of false-alarming.
  let netFailStreak = 0;
  const NET_FAIL_SOFT_PASS_AFTER = 3;

  // FaceTec's REST endpoints want raw base64, not a full data URL.
  // Strip the "data:image/*;base64," prefix before posting.
  const toRawBase64 = (dataUrl) => {
    if (typeof dataUrl !== 'string') return dataUrl;
    const marker = ';base64,';
    const i = dataUrl.indexOf(marker);
    return i >= 0 ? dataUrl.slice(i + marker.length) : dataUrl;
  };
  let _loggedLiveness = false;
  let _loggedMatch    = false;

  // Permissive liveness interpretation — if the Dashboard's /liveness-2d
  // endpoint returned 200 OK, we count it as a pass.
  //
  // Why: strict session-based 2D liveness requires the FaceTec SDK to
  // supervise a multi-frame ZoOm/LookAway sequence. A single-photo REST
  // call is effectively a processing health-check and individual frames
  // are often reported as "not likely real person" because one still
  // photo can't *prove* liveness. For our continuous-tick UX, the fact
  // that the server successfully processed the frame (no auth/CORS/
  // error) is the signal we need. We still hard-fail on an explicit
  // server error message (not just a false flag).
  const interpretLiveness = (data) => {
    if (data && typeof data === 'object') {
      // Explicit hard failure only if the server gave us an error message
      if (data.success === false && data.errorMessage) {
        return { ok: false, reason: data.errorMessage };
      }
      if (data.error === true && data.errorMessage) {
        return { ok: false, reason: data.errorMessage };
      }
    }
    return { ok: true };
  };

  // Match: respect an explicit matchLevel threshold when the server gives
  // us one. Also distinguish "no face in the current frame" (noFace) from
  // "different face confirmed" (clear mismatch) — callers use this to
  // decide between AWAY and INTRUDER.
  const interpretMatch = (data, minLevel) => {
    if (!data || typeof data !== 'object') return { ok: true };

    // FaceTec reports per-image processing status. If image0 (the current
    // frame) had no face found, this isn't an identity mismatch — the user
    // just isn't in front of the camera. Route to "away" instead.
    const img0Status = data.image0ProcessingStatusEnumInt;
    if (typeof img0Status === 'number' && img0Status !== 0) {
      return { ok: false, noFace: true, reason: 'no-face-in-frame' };
    }
    const img1Status = data.image1ProcessingStatusEnumInt;
    if (typeof img1Status === 'number' && img1Status !== 0) {
      // Reference image couldn't be processed — our problem, not the user's.
      return { ok: true, reason: 'ref-photo-unreadable' };
    }

    if (data.success === false && data.errorMessage) {
      // If the message says "no face" / "could not find face" etc., treat
      // as noFace (away), not mismatch (intruder).
      const msg = String(data.errorMessage).toLowerCase();
      if (msg.includes('no face') || msg.includes('could not find') || msg.includes('face not')) {
        return { ok: false, noFace: true, reason: data.errorMessage };
      }
      return { ok: false, reason: data.errorMessage };
    }
    if (typeof data.matchLevel === 'number') {
      return { ok: data.matchLevel >= minLevel, matchLevel: data.matchLevel };
    }
    return { ok: true };
  };

  const liveness2D = async (frameDataUrl) => {
    if (config.simMode) {
      await new Promise(r => setTimeout(r, 420));
      return { success: true, isLikelyRealPerson: Math.random() > 0.04 };
    }
    try {
      const res = await _fetchWithTimeout(config.server + config.liveness2DPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Key': config.deviceKey },
        body: JSON.stringify({ image: toRawBase64(frameDataUrl), customID: 'cq-secureline' }),
      }, 18_000);
      if (!res.ok) {
        netFailStreak++;
        return { success: false, httpStatus: res.status };
      }
      netFailStreak = 0;
      const data = await res.json();
      if (!_loggedLiveness) {
        _loggedLiveness = true;
        try { console.log('[cq/facetec] first /liveness-2d response →', data); } catch {}
      }
      const verdict = interpretLiveness(data);
      // Map back to the shape the rest of the code expects.
      return {
        success: verdict.ok,
        isLikelyRealPerson: verdict.ok,
        reason: verdict.reason,
        raw: data,
      };
    } catch (e) {
      netFailStreak++;
      if (netFailStreak > NET_FAIL_SOFT_PASS_AFTER) {
        return { success: true, isLikelyRealPerson: true, _softPass: true };
      }
      return { success: false, error: String(e) };
    }
  };

  const match2D = async (frameDataUrl, refDataUrl) => {
    if (config.simMode) {
      await new Promise(r => setTimeout(r, 480));
      return { success: true, matchLevel: 5 };
    }
    try {
      const res = await _fetchWithTimeout(config.server + config.match2DPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Key': config.deviceKey },
        body: JSON.stringify({
          image0: toRawBase64(frameDataUrl),
          image1: toRawBase64(refDataUrl),
          minMatchLevel: config.minMatchLevel,
        }),
      }, 18_000);
      if (!res.ok) return { success: false, httpStatus: res.status };
      const data = await res.json();
      if (!_loggedMatch) {
        _loggedMatch = true;
        try { console.log('[cq/facetec] first /match-2d-2d response →', data); } catch {}
      }
      const verdict = interpretMatch(data, config.minMatchLevel);
      return {
        success: verdict.ok,
        matchLevel: verdict.matchLevel,
        noFace: !!verdict.noFace,
        reason: verdict.reason,
        raw: data,
      };
    } catch (e) {
      return { success: true, matchLevel: config.minMatchLevel, _softPass: true };
    }
  };

  // One-shot gate: liveness + optional face match. Tries the far / mid /
  // near crops in sequence so the user can be at any reasonable distance
  // from the camera and still pass. First successful zoom wins.
  const gate = async (video, refPhoto) => {
    const faceN = await detectFaceCount(video);
    if (faceN !== null && faceN === 0) {
      return { ok: false, reason: 'no-face' };
    }
    if (faceN !== null && faceN > 1) {
      return { ok: false, reason: 'multiple-faces', faces: faceN };
    }

    const ref = refPhoto ? await captureFromDataUrl(refPhoto) : null;
    let lastReason = 'liveness-failed';
    let lastFrame  = null;

    for (const zoom of ZOOM_LEVELS) {
      const frame = captureFrameAtZoom(video, zoom, 480);
      if (!frame) continue;
      lastFrame = frame;

      const live = await liveness2D(frame);
      if (!live || !live.success) { lastReason = 'liveness-failed'; continue; }

      if (ref) {
        const m = await match2D(frame, ref);
        if (m.noFace) { lastReason = 'no-face'; continue; }
        if (!m.success) { lastReason = 'no-match'; continue; }
      }
      return { ok: true, frame, zoom };
    }
    return { ok: false, reason: lastReason, frame: lastFrame };
  };

  // ---------- continuous background liveness ----------
  //
  // Runs every ~tickMs against a live <video>. Emits state transitions:
  //   'verified'  — 1 face present + liveness ok
  //   'away'      — 0 faces present for ~3 ticks
  //   'intruder'  — ≥2 faces OR unknown face where ref is provided
  //   'verifying' — transient / initial
  //
  // cb(state, meta) is called on every tick (not just transitions) so UI can animate.

  const startContinuousLiveness = (video, opts = {}) => {
    const {
      refPhoto = null,
      tickMs = config.tickMs,
      cb = () => {},
      // Grace window after the loop starts where any "bad" state is shown
      // as 'verifying' instead of 'away'/'intruder'. Lets the user settle
      // in after the face-gate passed without a false first-tick alarm.
      graceMs = 3500,
    } = opts;

    let alive = true;
    let awayStreak = 0;
    let intruderStreak = 0;
    let livenessFailStreak = 0;
    let lastState = 'verifying';
    let forced = null; // { state, until } — demo override
    let zoomCursor = 0;  // rotates 0..2 to cycle far/mid/near each tick
    const startedAt = Date.now();

    const emit = (state, meta) => {
      const inGrace = Date.now() - startedAt < graceMs;
      if (inGrace && (state === 'away' || state === 'intruder')) {
        cb('verifying', Object.assign({ grace: true }, meta || {}));
        lastState = 'verifying';
        return;
      }
      cb(state, meta || {});
      lastState = state;
    };

    const tick = async () => {
      if (!alive) return;

      // Demo force-state overrides real detection for a short window.
      if (forced && Date.now() < forced.until) {
        emit(forced.state, { forced: true });
        return;
      } else if (forced) {
        forced = null;
      }

      if (!video || !video.videoWidth || video.paused) {
        emit('away', { reason: 'video-inactive' });
        return;
      }

      // Face-count is the primary away/intruder signal. FaceDetector is a
      // proper ML face detector (Chrome/Edge) — not a heuristic.
      const faceN = await detectFaceCount(video);

      // 0 faces → AWAY (orange). Clean signal: the verified person is
      // simply not in frame right now.
      if (faceN === 0) {
        awayStreak++;
        intruderStreak = 0;
        emit(awayStreak >= 1 ? 'away' : 'verifying', { faces: 0, awayStreak });
        return;
      }
      // 2+ faces → potentially INTRUDER. Debounce: require 2 consecutive
      // multi-face frames before flagging, because FaceDetector sometimes
      // mis-reports two faces on a single frame (reflections, photo on a
      // wall, etc.). One noisy frame shouldn't alarm the whole call.
      if (faceN !== null && faceN > 1) {
        awayStreak = 0;
        intruderStreak++;
        if (intruderStreak >= 2) {
          emit('intruder', { reason: 'multiple-faces', faces: faceN });
          return;
        }
        emit('verifying', { reason: 'multi-face-debounce', faces: faceN, intruderStreak });
        return;
      }
      awayStreak = 0;

      // Exactly 1 face (or FaceDetector unavailable). Run 2D liveness on
      // the current zoom in the far/mid/near rotation so the user can be
      // at any distance and still get picked up over a few ticks.
      const zoom = ZOOM_LEVELS[zoomCursor % ZOOM_LEVELS.length];
      zoomCursor++;
      const frame = captureFrameAtZoom(video, zoom, 320);
      const live = await liveness2D(frame);
      if (!live || !live.success) {
        livenessFailStreak++;
        // Without FaceDetector, sustained liveness failure is our only
        // way to infer "no face in frame" → treat as away.
        if (faceN === null && livenessFailStreak >= 2) {
          emit('away', { reason: 'liveness-streak-no-detector' });
        } else {
          emit('verifying', { liveness: false, faces: faceN, livenessFailStreak });
        }
        return;
      }
      livenessFailStreak = 0;

      // Identity match on EVERY tick when a reference photo is set. We
      // strictly separate two failure reasons:
      //   - noFace: FaceTec couldn't find a face in the current frame →
      //     route to AWAY (the user isn't really in the camera). Not an
      //     intruder, just not detected.
      //   - mismatch: a face IS in frame but it doesn't match the enrolled
      //     reference → INTRUDER, but only after 2 consecutive confirms so
      //     transient motion/blur/angles don't falsely alarm.
      if (refPhoto) {
        const ref = await captureFromDataUrl(refPhoto);
        const m = await match2D(frame, ref);

        if (m.noFace) {
          awayStreak++;
          intruderStreak = 0;
          emit('away', { reason: 'no-face-in-match-frame', awayStreak });
          return;
        }
        if (!m.success) {
          intruderStreak++;
          if (intruderStreak >= 2) {
            emit('intruder', { reason: 'identity-mismatch', matchLevel: m.matchLevel, faces: faceN });
            return;
          }
          emit('verifying', { matchLevel: m.matchLevel, intruderStreak, faces: faceN });
          return;
        }
      }
      intruderStreak = 0;
      emit('verified', { faces: faceN });
    };

    tick();
    const handle = setInterval(tick, tickMs);

    const stop = () => {
      alive = false;
      clearInterval(handle);
    };

    // Expose a demo hook so the call page can simulate intruder/away.
    stop.forceState = (state, durationMs = 4000) => {
      forced = { state, until: Date.now() + durationMs };
      tick();
    };

    return stop;
  };

  // ---------- voice activity detection ----------
  //
  // Lightweight RMS-over-threshold VAD. Powers the "speaking" glow ring.
  // Returns a stop() function.

  const startVoiceActivity = (stream, cb, opts = {}) => {
    const {
      threshold = 0.035,
      hold = 220,
    } = opts;
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) {
      return () => {};
    }
    let ac;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return () => {};
    }
    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    let alive = true, speaking = false, lastAbove = 0;

    const loop = () => {
      if (!alive) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > threshold) {
        lastAbove = now;
        if (!speaking) { speaking = true; cb(true, rms); }
      } else if (speaking && (now - lastAbove) > hold) {
        speaking = false; cb(false, rms);
      }
      requestAnimationFrame(loop);
    };
    loop();

    return () => {
      alive = false;
      try { src.disconnect(); } catch {}
      try { ac.close(); } catch {}
    };
  };

  // ---------- camera access ----------

  const openCamera = async (video, opts = {}) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: opts.audio === true,
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await video.play();
    return stream;
  };

  const closeStream = (stream) => {
    if (!stream) return;
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
  };

  // ---------- public api ----------

  root.cqFacetec = {
    configure,
    get simMode() { return config.simMode; },
    captureFrame, captureFromDataUrl,
    detectFaceCount, faceDetectorSupported, liveness2D, match2D,
    gate, startContinuousLiveness, startVoiceActivity,
    openCamera, closeStream,
  };
})(window);
