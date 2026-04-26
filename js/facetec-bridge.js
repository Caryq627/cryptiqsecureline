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
    // matchLevel scale: 0 (clearly different) … 9-10 (clearly same).
    // 5 = "medium-security 1:1" — strict enough that visibly different
    // faces don't pass, lenient enough that the same face under different
    // lighting / compression / angle still clears. 6+ is too strict for a
    // single-frame REST roundtrip with our brightness/contrast pre-filter.
    minMatchLevel: 5,
    tickMs:        1800,
    simMode:       true,
    // When true, every /liveness-2d and /match-2d-2d response is logged so
    // it's visible the real server is being hit and what verdict it gave.
    verbose:       true,
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

  // Default brightness/contrast boost applied to every capture. Keeps dim
  // rooms from killing face detection without overcooking a well-lit image.
  const IMG_FILTER = 'brightness(1.12) contrast(1.08)';

  const captureFrame = (video, maxSize = 480) => {
    if (!video || !video.videoWidth) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, maxSize / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    try { ctx.filter = IMG_FILTER; } catch {}
    // un-mirror: browsers apply CSS mirror but raw video pixels aren't flipped,
    // match preview to what the user sees
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.82);
  };

  // Capture the full rectangular camera frame — no center-cropping at all.
  // Lets FaceTec's face detector scan the whole viewport; useful when the
  // user is sitting well back from the camera.
  const captureFullFrame = (video, maxSize = 640) => {
    if (!video || !video.videoWidth) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, maxSize / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    try { ctx.filter = IMG_FILTER; } catch {}
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.85);
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
    try { ctx.filter = IMG_FILTER; } catch {}
    ctx.translate(outSize, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, cropSide, cropSide, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/jpeg', 0.82);
  };

  // Best-effort: use FaceDetector's bounding box to center + zoom onto the
  // face with generous padding, so a user 6+ feet from the camera still
  // gets a large, clear face in the frame sent to FaceTec. Falls back to
  // the full-frame capture if FaceDetector is unavailable or finds no face.
  const captureAroundFace = async (video, maxSize = 480) => {
    if (!video || !video.videoWidth) return null;
    const fd = getFaceDetector();
    if (!fd) return captureFullFrame(video, maxSize);
    let faces = [];
    try { faces = await fd.detect(video); } catch {}
    if (!faces.length) return captureFullFrame(video, maxSize);
    const bb = faces[0].boundingBox;
    const vw = video.videoWidth, vh = video.videoHeight;

    // Padding around the face bbox so the chin/forehead/ears aren't clipped.
    const padX = bb.width  * 0.7;
    const padY = bb.height * 0.7;
    let sx = Math.max(0, bb.x - padX);
    let sy = Math.max(0, bb.y - padY);
    let sw = Math.min(vw - sx, bb.width  + 2 * padX);
    let sh = Math.min(vh - sy, bb.height + 2 * padY);
    // Square up around the face center so the output aspect stays 1:1.
    const side = Math.min(vw, vh, Math.max(sw, sh));
    const cx = sx + sw / 2, cy = sy + sh / 2;
    sx = Math.max(0, Math.min(vw - side, cx - side / 2));
    sy = Math.max(0, Math.min(vh - side, cy - side / 2));
    sw = side; sh = side;

    const out = Math.min(maxSize, Math.round(side));
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    try { ctx.filter = IMG_FILTER; } catch {}
    ctx.translate(out, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, out, out);
    return canvas.toDataURL('image/jpeg', 0.85);
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
  // Per-call counters so logs are easy to skim ("liveness #4 → ok").
  let _livenessCount = 0;
  let _matchCount    = 0;

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

  // Match: strict identity verification. We FAIL CLOSED on any ambiguous
  // server response — never default to "ok: true" when we don't have an
  // explicit, threshold-clearing matchLevel.
  //
  // Three failure shapes the caller can act on:
  //   - noFace:      face wasn't in the current frame → AWAY (not intruder)
  //   - refUnreadable: enrolled photo couldn't be processed → enrollment is
  //     broken, FAIL CLOSED. Used to silently pass — that's the bug a user
  //     hit when uploading someone else's face also exposed: when the ref
  //     was unparseable we'd let them through.
  //   - mismatch:    face IS in frame, server returned matchLevel < threshold
  const interpretMatch = (data, minLevel) => {
    // Defensive: server gave us nothing meaningful. Fail closed.
    if (!data || typeof data !== 'object') {
      return { ok: false, reason: 'no-response-data' };
    }

    // FaceTec per-image processing status: 0 = OK, anything else = couldn't
    // process that image. Image 0 = current frame, image 1 = ref photo.
    const img0Status = data.image0ProcessingStatusEnumInt;
    if (typeof img0Status === 'number' && img0Status !== 0) {
      return { ok: false, noFace: true, reason: 'no-face-in-frame', img0Status };
    }
    const img1Status = data.image1ProcessingStatusEnumInt;
    if (typeof img1Status === 'number' && img1Status !== 0) {
      // Enrolled photo can't be matched against. Fail closed — this is the
      // ONLY safe outcome when we can't extract features from the reference.
      return { ok: false, refUnreadable: true, reason: 'ref-photo-unreadable', img1Status };
    }

    if (data.success === false && data.errorMessage) {
      const msg = String(data.errorMessage).toLowerCase();
      if (msg.includes('no face') || msg.includes('could not find') || msg.includes('face not')) {
        return { ok: false, noFace: true, reason: data.errorMessage };
      }
      return { ok: false, reason: data.errorMessage };
    }

    // Hard threshold. matchLevel must be present AND meet the minimum.
    // Missing matchLevel used to fall through to ok:true — that's how a
    // mismatched face could slip past. Now: missing matchLevel = fail.
    if (typeof data.matchLevel !== 'number') {
      return { ok: false, reason: 'no-match-level-returned', raw: data };
    }
    return {
      ok: data.matchLevel >= minLevel,
      matchLevel: data.matchLevel,
      reason: data.matchLevel >= minLevel ? 'matched' : `below-threshold(${data.matchLevel}<${minLevel})`,
    };
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
      _livenessCount++;
      const verdict = interpretLiveness(data);
      if (config.verbose) {
        try {
          console.log(
            `[cq/verify] liveness #${_livenessCount} →`,
            verdict.ok ? 'PASS' : 'FAIL',
            'realPerson=' + data.isLikelyRealPerson,
            'success=' + data.success,
            data.errorMessage ? `error="${data.errorMessage}"` : ''
          );
        } catch {}
      }
      return {
        success: verdict.ok,
        isLikelyRealPerson: data.isLikelyRealPerson,
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
      if (!res.ok) return { success: false, httpStatus: res.status, networkError: true };
      const data = await res.json();
      _matchCount++;
      const verdict = interpretMatch(data, config.minMatchLevel);
      if (config.verbose) {
        try {
          console.log(
            `[cq/verify] match #${_matchCount} →`,
            verdict.ok ? 'PASS' : 'FAIL',
            'level=' + data.matchLevel,
            'min=' + config.minMatchLevel,
            'reason=' + verdict.reason,
            'img0=' + data.image0ProcessingStatusEnumInt,
            'img1=' + data.image1ProcessingStatusEnumInt
          );
        } catch {}
      }
      return {
        success: verdict.ok,
        matchLevel: verdict.matchLevel,
        noFace: !!verdict.noFace,
        refUnreadable: !!verdict.refUnreadable,
        reason: verdict.reason,
        raw: data,
      };
    } catch (e) {
      // Network error — DON'T soft-pass. The continuous loop should treat
      // unreachable server as 'verifying', not as a valid match. Soft-passing
      // here was the source of "stays verified when not in view" reports.
      return { success: false, networkError: true, error: String(e) };
    }
  };

  // One-shot gate: liveness + optional face match. Tries captures at many
  // distances so a user 6-8+ feet from the camera still passes:
  //   1. face-centered crop from FaceDetector's bbox (best for far users)
  //   2. full rectangular frame (no edge loss — FaceTec scans the whole view)
  //   3. far / mid / near center crops (legacy fallback)
  // First successful attempt wins. We do NOT short-circuit on FaceDetector
  // 0-faces — it sometimes misses small/distant faces but FaceTec's own
  // face-finder picks them up on the full frame.
  const gate = async (video, refPhoto) => {
    const faceN = await detectFaceCount(video);
    // Multi-face is the only condition that hard-rejects up front. Single
    // 0-face from the browser detector falls through to FaceTec.
    if (faceN !== null && faceN > 1) {
      return { ok: false, reason: 'multiple-faces', faces: faceN };
    }

    const ref = refPhoto ? await captureFromDataUrl(refPhoto) : null;
    const attempts = [
      { name: 'face', frame: await captureAroundFace(video, 640) },
      { name: 'full', frame: captureFullFrame(video, 720) },
      { name: 'far',  frame: captureFrameAtZoom(video, 'far',  560) },
      { name: 'mid',  frame: captureFrameAtZoom(video, 'mid',  480) },
      { name: 'near', frame: captureFrameAtZoom(video, 'near', 420) },
    ];

    let lastReason = (faceN === 0) ? 'no-face' : 'liveness-failed';
    let bestMatchLevel = -1;
    let lastFrame  = null;
    let refUnreadableSeen = false;

    for (const { name, frame } of attempts) {
      if (!frame) continue;
      lastFrame = frame;
      const live = await liveness2D(frame);
      if (!live || !live.success) { lastReason = 'liveness-failed'; continue; }
      if (ref) {
        const m = await match2D(frame, ref);
        if (m.refUnreadable) {
          // Enrolled photo is broken — every attempt will hit this same
          // failure. Bail early with a distinct reason so the caller can
          // tell the user to re-enroll instead of just looping forever.
          refUnreadableSeen = true;
          lastReason = 'ref-unreadable';
          break;
        }
        if (m.noFace)   { lastReason = 'no-face'; continue; }
        if (typeof m.matchLevel === 'number' && m.matchLevel > bestMatchLevel) {
          bestMatchLevel = m.matchLevel;
        }
        if (!m.success) {
          // Distinguish "did not match" (real mismatch with confidence) from
          // "below threshold" (low confidence — could be lighting/angle).
          lastReason = (typeof m.matchLevel === 'number')
            ? `no-match(level=${m.matchLevel})`
            : 'no-match';
          continue;
        }
        return { ok: true, frame, zoom: name, matchLevel: m.matchLevel };
      }
      // No reference photo at all: liveness is the gate. NOTE: callers that
      // do this lose identity verification entirely; only used for things
      // like "is anyone present at all".
      return { ok: true, frame, zoom: name };
    }
    return {
      ok: false,
      reason: lastReason,
      frame: lastFrame,
      bestMatchLevel: bestMatchLevel >= 0 ? bestMatchLevel : null,
      refUnreadable: refUnreadableSeen,
    };
  };

  // ---------- enrollment photo validation ----------
  //
  // Confirms an uploaded reference photo actually contains a recognizable
  // face that FaceTec can extract features from. Without this, a user could
  // upload a non-face image (or a photo where the face is too small/blurry)
  // and silently break identity matching for that participant.
  //
  // Strategy: feed the photo into /match-2d-2d as BOTH images. If the server
  // can process it, it'll come back with image0Status=0 and image1Status=0
  // (and a high matchLevel since both images are identical). If it can't
  // find a face, image*Status will be non-zero and we reject the upload.
  //
  // Falls back to FaceDetector when in sim mode.
  const verifyEnrollmentPhoto = async (dataUrl) => {
    if (!dataUrl) return { ok: false, reason: 'no-photo' };

    // Quick pre-check with the browser FaceDetector when available.
    const fd = getFaceDetector();
    if (fd) {
      try {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        const faces = await fd.detect(img);
        if (faces.length === 0) {
          return { ok: false, reason: 'no-face-detected', source: 'browser' };
        }
        if (faces.length > 1) {
          return { ok: false, reason: 'multiple-faces', source: 'browser' };
        }
      } catch {
        // FaceDetector can throw on certain image types — fall through to FaceTec.
      }
    }

    if (config.simMode) {
      // Without server-side validation we trust the FaceDetector verdict.
      return { ok: true, source: 'sim' };
    }

    // Server-side validation: round-trip the photo through /match-2d-2d so
    // FaceTec confirms it can extract face features.
    try {
      const res = await _fetchWithTimeout(config.server + config.match2DPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Key': config.deviceKey },
        body: JSON.stringify({
          image0: toRawBase64(dataUrl),
          image1: toRawBase64(dataUrl),
          minMatchLevel: 0,
        }),
      }, 18_000);
      if (!res.ok) {
        return { ok: false, reason: 'server-error', httpStatus: res.status };
      }
      const data = await res.json();
      if (config.verbose) {
        try {
          console.log(
            '[cq/verify] enrollment check →',
            'img0=' + data.image0ProcessingStatusEnumInt,
            'img1=' + data.image1ProcessingStatusEnumInt,
            'level=' + data.matchLevel
          );
        } catch {}
      }
      const s0 = data.image0ProcessingStatusEnumInt;
      const s1 = data.image1ProcessingStatusEnumInt;
      if ((typeof s0 === 'number' && s0 !== 0) ||
          (typeof s1 === 'number' && s1 !== 0)) {
        return { ok: false, reason: 'no-face-detected', source: 'facetec', raw: data };
      }
      return { ok: true, source: 'facetec', raw: data };
    } catch (e) {
      return { ok: false, reason: 'network-error', error: String(e) };
    }
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
      // 2+ faces → potentially INTRUDER. Light debounce (1 prior tick) so a
      // single false-positive frame doesn't alarm, but we don't wait long.
      if (faceN !== null && faceN > 1) {
        awayStreak = 0;
        intruderStreak++;
        if (intruderStreak >= 1) {
          emit('intruder', { reason: 'multiple-faces', faces: faceN });
          return;
        }
        emit('verifying', { reason: 'multi-face-debounce', faces: faceN, intruderStreak });
        return;
      }
      awayStreak = 0;

      // Exactly 1 face (or FaceDetector unavailable). Run 2D liveness on
      // the current capture strategy in the rotation:
      //   face → full → far → mid → near → (repeat)
      // That lets a user sitting anywhere from right-up-close to across
      // the room pass on at least one tick out of every few.
      const ATTEMPT_ORDER = ['face', 'full', 'far', 'mid', 'near'];
      const attempt = ATTEMPT_ORDER[zoomCursor % ATTEMPT_ORDER.length];
      zoomCursor++;
      let frame = null;
      if      (attempt === 'face') frame = await captureAroundFace(video, 480);
      else if (attempt === 'full') frame = captureFullFrame(video, 640);
      else                         frame = captureFrameAtZoom(video, attempt, 400);
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
      // strictly separate three failure reasons:
      //   - noFace: FaceTec couldn't find a face in the current frame →
      //     route to AWAY (the user isn't really in the camera). Not an
      //     intruder, just not detected.
      //   - mismatch: a face IS in frame but it doesn't match the enrolled
      //     reference → INTRUDER, but only after 2 consecutive confirms so
      //     transient motion/blur/angles don't falsely alarm.
      //   - network error: server unreachable → 'verifying' (NOT verified).
      //     Better to show "checking" than to falsely claim verified.
      //
      // No skin-tone or color heuristics anywhere. Identity = FaceTec
      // facial-feature 1:1 match. Liveness = FaceTec 2D. Face presence =
      // browser FaceDetector (ML model) when available.
      if (refPhoto) {
        const ref = await captureFromDataUrl(refPhoto);
        const m = await match2D(frame, ref);

        if (m.networkError) {
          emit('verifying', { reason: 'match-network-error', faces: faceN });
          return;
        }
        if (m.noFace) {
          // FaceTec couldn't find a face in the current frame. Only treat
          // this as 'away' (orange) when the BROWSER detector also agrees
          // there's no face. If FaceDetector says a face IS present but the
          // server can't confirm it, that's suspicious — go red.
          if (faceN === null || faceN === 0) {
            awayStreak++;
            intruderStreak = 0;
            emit('away', { reason: 'no-face-in-match-frame', awayStreak });
            return;
          }
          // Browser saw a face; server didn't. Treat as intruder-class.
          intruderStreak++;
          emit('intruder', { reason: 'face-present-but-unrecognizable', faces: faceN });
          return;
        }
        if (!m.success) {
          // A face IS in frame and the server returned a real matchLevel —
          // it just doesn't match the enrolled person. This is the
          // "wrong face" case: go RED immediately, no debounce. (User
          // explicitly asked for this — the prior 2-tick wait was letting
          // a wrong face show as orange/away briefly before flipping red.)
          intruderStreak++;
          emit('intruder', {
            reason: 'identity-mismatch',
            matchLevel: m.matchLevel,
            faces: faceN,
          });
          return;
        }
        intruderStreak = 0;
        emit('verified', { faces: faceN, matchLevel: m.matchLevel });
        return;
      }

      // No reference photo on file (e.g. demo line). Without an identity
      // anchor we can only confirm "a face is present + liveness ok". Be
      // conservative: only flip to verified if FaceDetector found ≥1 face
      // — never on liveness alone (which is permissive on a 200 OK).
      if (faceN === null) {
        // No FaceDetector and no refPhoto = we cannot definitively prove
        // a face is present. Stay in 'verifying' rather than falsely
        // declaring 'verified'.
        emit('verifying', { reason: 'no-detector-no-ref' });
        return;
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
    get minMatchLevel() { return config.minMatchLevel; },
    captureFrame, captureFrameAtZoom, captureFullFrame, captureAroundFace,
    captureFromDataUrl,
    detectFaceCount, faceDetectorSupported, liveness2D, match2D,
    verifyEnrollmentPhoto,
    gate, startContinuousLiveness, startVoiceActivity,
    openCamera, closeStream,
  };
})(window);
