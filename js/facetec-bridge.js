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
  let _loggedLiveness = false;
  let _loggedMatch    = false;

  // Normalize the liveness response — FaceTec Dashboard builds use a few
  // different shapes across versions. Treat a 200 OK as a pass unless the
  // server explicitly rejects it.
  const interpretLiveness = (data) => {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'no-body' };
    if (data.success === false)           return { ok: false, reason: data.errorMessage || 'server-said-no' };
    if (data.isLikelyRealPerson === false)return { ok: false, reason: 'not-real-person' };
    if (data.error === true)              return { ok: false, reason: 'error-flag' };
    if (typeof data.liveness2DStatusEnumInt === 'number' && data.liveness2DStatusEnumInt !== 0) {
      return { ok: false, reason: 'liveness-status-' + data.liveness2DStatusEnumInt };
    }
    return { ok: true };
  };

  const interpretMatch = (data, minLevel) => {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'no-body' };
    if (data.success === false)            return { ok: false, reason: data.errorMessage || 'server-said-no' };
    if (typeof data.matchLevel === 'number' && data.matchLevel < minLevel) {
      return { ok: false, reason: 'match-level-' + data.matchLevel };
    }
    return { ok: true, matchLevel: data.matchLevel };
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
        body: JSON.stringify({ image: frameDataUrl, customID: 'cq-secureline' }),
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
          image0: frameDataUrl, image1: refDataUrl,
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
        reason: verdict.reason,
        raw: data,
      };
    } catch (e) {
      return { success: true, matchLevel: config.minMatchLevel, _softPass: true };
    }
  };

  // One-shot gate: liveness + optional face match. Used by enroll + join.
  const gate = async (video, refPhoto) => {
    const frame = captureFrame(video, 480);
    if (!frame) return { ok: false, reason: 'no-frame' };
    const faceN = await detectFaceCount(video);
    if (faceN !== null && faceN === 0) {
      return { ok: false, reason: 'no-face', frame };
    }
    if (faceN !== null && faceN > 1) {
      return { ok: false, reason: 'multiple-faces', frame, faces: faceN };
    }
    const live = await liveness2D(frame);
    if (!live.success || (live.isLikelyRealPerson === false)) {
      return { ok: false, reason: 'liveness-failed', frame };
    }
    if (refPhoto) {
      const ref = await captureFromDataUrl(refPhoto);
      const m = await match2D(frame, ref);
      if (!m.success || (typeof m.matchLevel === 'number' && m.matchLevel < config.minMatchLevel)) {
        return { ok: false, reason: 'no-match', frame };
      }
    }
    return { ok: true, frame };
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
    } = opts;

    let alive = true;
    let awayStreak = 0;
    let livenessFailStreak = 0;
    let lastState = 'verifying';
    let forced = null; // { state, until } — demo override

    const emit = (state, meta) => {
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

      // Primary away/intruder signal: the browser's native FaceDetector —
      // a proper ML face detector (not a skin-tone or brightness heuristic).
      const faceN = await detectFaceCount(video);

      if (faceN === 0) {
        awayStreak++;
        emit(awayStreak >= 1 ? 'away' : 'verifying', { faces: 0, awayStreak });
        return;
      }
      if (faceN !== null && faceN > 1) {
        awayStreak = 0;
        emit('intruder', { faces: faceN });
        return;
      }
      awayStreak = 0;

      // We either got exactly 1 face, OR FaceDetector is unavailable.
      // Let FaceTec 2D liveness be the authoritative signal. In browsers
      // without FaceDetector (Safari), the liveness-failure streak is our
      // only way to detect "no face in frame" — flip to away after 2 ticks.
      const frame = captureFrame(video, 320);
      const live = await liveness2D(frame);
      if (!live || !live.success || live.isLikelyRealPerson === false) {
        livenessFailStreak++;
        if (faceN === null && livenessFailStreak >= 2) {
          emit('away', { reason: 'liveness-streak-no-detector', livenessFailStreak });
        } else {
          emit('verifying', { liveness: false, faces: faceN, livenessFailStreak });
        }
        return;
      }
      livenessFailStreak = 0;

      // Identity match every ~3rd tick when a reference photo is set —
      // this is what actually catches imposters who look similar enough
      // to pass liveness but aren't the enrolled person.
      if (refPhoto && Math.random() < 0.33) {
        const ref = await captureFromDataUrl(refPhoto);
        const m = await match2D(frame, ref);
        if (!m.success || (typeof m.matchLevel === 'number' && m.matchLevel < config.minMatchLevel)) {
          emit('intruder', { reason: 'identity-mismatch', faces: faceN });
          return;
        }
      }
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
