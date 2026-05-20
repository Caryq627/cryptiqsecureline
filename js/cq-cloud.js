// Cryptiq Secure Line — cross-device sync layer
//
// The site itself is static (Render Static or any CDN). This module
// bridges to a tiny Node API (api/server.js, Render web service) that
// holds line state in memory, so two phones / a phone + laptop / etc
// can see the same call, pending guest requests, and admit decisions.
//
// localStorage is still the local cache + source of truth on the host
// device, but every host-side mutation pushes a fresh snapshot up, and
// every page polls every couple seconds for changes from the cloud.
//
// API base resolution order:
//   1. window.CQ_API  (per-page override, useful for previews)
//   2. <meta name="cq-api" content="https://...">
//   3. https://cryptiq-secure-line-api.onrender.com  (Render default)

(function (root) {
  const DEFAULT_API = 'https://cryptiq-secure-line-api.onrender.com';

  const resolveBase = () => {
    if (root.CQ_API) return String(root.CQ_API).replace(/\/$/, '');
    try {
      const ls = localStorage.getItem('cq.api.override');
      if (ls) return ls.replace(/\/$/, '');
    } catch {}
    const meta = document.querySelector('meta[name="cq-api"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
    return DEFAULT_API;
  };

  let API_BASE = resolveBase();

  const url = (path) => `${API_BASE}${path}`;

  // ---------- low-level fetch ----------

  const req = async (path, opts = {}) => {
    // Hard timeout so a slow Render dyno (cold start, sleeping free
    // tier) doesn't silently hang a ping for 30+ seconds. Default 6s,
    // overridable per-call via opts.timeoutMs.
    const timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : 6000;
    const ctrl = ('AbortController' in window) ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs) : null;
    try {
      const r = await fetch(url(path), {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
        // No credentials — the API is open and stateless per request.
      });
      if (!r.ok) {
        let detail = null;
        try { detail = await r.json(); } catch {}
        return { ok: false, status: r.status, reason: detail && detail.reason || `http-${r.status}`, ...detail };
      }
      return r.json();
    } catch (e) {
      // Network failure or aborted by timeout: surface as a soft error.
      const aborted = e && (e.name === 'AbortError');
      return { ok: false, reason: aborted ? 'timeout' : 'network', error: String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // ---------- public ops ----------

  // Host pushes a full line snapshot up. Stripped of `live` and `pending`
  // on send — those are server-authoritative and we'd overwrite real-time
  // state with a stale snapshot if we shipped them. The server's merge
  // function preserves them.
  const put = async (line) => {
    if (!line || !line.id) return { ok: false, reason: 'bad-line' };
    const stripped = { ...line };
    delete stripped.live;
    return req(`/api/line/${encodeURIComponent(line.id)}`, {
      method: 'PUT',
      body: { line: stripped },
    });
  };

  const fetchLine = (lineId) => req(`/api/line/${encodeURIComponent(lineId)}`);

  const addPending = (lineId, { openToken, name, photo }) =>
    req(`/api/line/${encodeURIComponent(lineId)}/pending`, {
      method: 'POST',
      body: { openToken, name, photo },
    });

  // Host auth happens server-side via EITHER:
  //   - legacy hostToken match, or
  //   - callerParticipantId === line.createdBy (simple flow). Both are
  //     forwarded; the server accepts whichever proves you're the host.
  //     This is what makes /transfer-host work — after rotating
  //     createdBy, the new host's mePid suffices and no secret had to
  //     be handed off.
  const admit = (lineId, pendingId, hostToken, callerParticipantId) =>
    req(`/api/line/${encodeURIComponent(lineId)}/admit`, {
      method: 'POST',
      body: { pendingId, hostToken, callerParticipantId },
    });

  const deny = (lineId, pendingId, hostToken, callerParticipantId) =>
    req(`/api/line/${encodeURIComponent(lineId)}/deny`, {
      method: 'POST',
      body: { pendingId, hostToken, callerParticipantId },
    });

  // Current host hands the host role to another participant. The
  // server checks fromPid is currently createdBy, then updates
  // createdBy = toPid. From the next poll onwards, the new host's
  // device sees isHost() === true and unlocks admit/deny/transfer.
  const transferHost = (lineId, fromPid, toPid, hostToken) =>
    req(`/api/line/${encodeURIComponent(lineId)}/transfer-host`, {
      method: 'POST',
      body: { fromPid, toPid, hostToken },
    });

  // Simple-flow: host POSTs name + photo once, gets a short shareable
  // code, their participantId, and a hostToken to authorize admit/deny.
  const simpleStart = (name, photo) =>
    req('/api/simple/start', {
      method: 'POST',
      body: { name, photo },
    });

  const consumeOneTime = (lineId, token) =>
    req(`/api/line/${encodeURIComponent(lineId)}/consume-onetime`, {
      method: 'POST',
      body: { token },
    });

  // Host-only — wipes session-scoped server state (pending guests,
  // live presence, guest participants from previous sessions) so a
  // fresh call doesn't inherit zombies. Enrolled attendees stay.
  const clearSession = (lineId) =>
    req(`/api/line/${encodeURIComponent(lineId)}/clear-session`, {
      method: 'POST',
      body: {},
    });

  // WebRTC signaling — drops a message in the addressed peer's inbox
  // and pulls everything new addressed to us. Used by js/cq-voice.js
  // for SDP offer/answer + ICE candidate trickling between peers.
  const signal = (lineId, payload) =>
    req(`/api/line/${encodeURIComponent(lineId)}/signal`, {
      method: 'POST',
      body: payload,
    });

  const pullSignals = (lineId, pid, since) =>
    req(`/api/line/${encodeURIComponent(lineId)}/signal/${encodeURIComponent(pid)}?since=${since || 0}`);

  // Tell the server we're leaving — drops us from live presence right
  // away (and from participants if we're a guest) so other devices
  // see us gone on their next poll, not after the 12s presence TTL.
  //
  // On pagehide / beforeunload the regular fetch can be aborted by
  // the browser. sendBeacon is designed exactly for this — it's
  // fire-and-forget and survives navigation. We use it when a `beacon`
  // option is passed, and fall back to a normal POST otherwise.
  const leave = (lineId, participantId, opts = {}) => {
    const path = `/api/line/${encodeURIComponent(lineId)}/leave`;
    const body = { participantId };
    if (opts.beacon && navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
        const ok = navigator.sendBeacon(url(path), blob);
        return Promise.resolve({ ok });
      } catch {}
    }
    return req(path, { method: 'POST', body });
  };

  // ping(lineId, participantId, state?) — heartbeat + tile state.
  // state is { state, muted, handRaised, speaking } so other devices
  // can render this participant's tile correctly. All fields optional;
  // default state is 'verified' on the server side.
  const ping = (lineId, participantId, state) =>
    req(`/api/line/${encodeURIComponent(lineId)}/ping`, {
      method: 'POST',
      body: { participantId, ...(state || {}) },
    });

  // ---------- polling ----------
  //
  // startSync(lineId, onUpdate): polls the cloud every `intervalMs` and
  // calls onUpdate(remoteLine) whenever the server returns a fresh
  // snapshot. Also merges the snapshot into localStorage via
  // cqLine.hydrateFromPayload-style merging, so the rest of the app
  // sees a single coherent line.

  const startSync = (lineId, onUpdate, opts = {}) => {
    const intervalMs = opts.intervalMs || 2500;
    let stopped = false;
    let lastSerialized = null;

    const tick = async () => {
      if (stopped) return;
      const r = await fetchLine(lineId);
      if (stopped) return;
      if (r && r.ok && r.line) {
        const snap = JSON.stringify(r.line);
        if (snap !== lastSerialized) {
          lastSerialized = snap;
          mergeIntoLocal(r.line);
          if (typeof onUpdate === 'function') {
            try { onUpdate(r.line); } catch (e) { console.warn('[cq-cloud] onUpdate threw', e); }
          }
        }
      }
      if (!stopped) setTimeout(tick, intervalMs);
    };

    tick();
    return () => { stopped = true; };
  };

  // Merge a fresh remote snapshot into the local cqLine line. Preserves
  // local photos (recipients pass their gate-frame photo; we keep that)
  // and local presence map — those are tab-local.
  const mergeIntoLocal = (remote) => {
    if (!root.cqLine || !remote || !remote.id) return;
    const local = root.cqLine.getLine(remote.id);
    if (!local) {
      // First time seeing this line on this device — accept wholesale.
      root.cqLine.saveLine({ ...remote, live: remote.live || {}, pending: remote.pending || [] });
      return;
    }
    // Union participants, prefer local photos when present.
    const byId = new Map();
    for (const p of (local.participants || [])) byId.set(p.id, p);
    for (const p of (remote.participants || [])) {
      const ex = byId.get(p.id);
      byId.set(p.id, ex && ex.photo ? { ...p, photo: ex.photo } : p);
    }
    const merged = {
      ...local,
      ...remote,
      participants: Array.from(byId.values()),
      oneTimeTokens: { ...(local.oneTimeTokens || {}), ...(remote.oneTimeTokens || {}) },
      pending: remote.pending || [],
      live: { ...(local.live || {}), ...(remote.live || {}) },
      // Carry through host-side fields the server doesn't track.
      createdBy: remote.createdBy || local.createdBy,
    };
    root.cqLine.saveLine(merged);
  };

  // ---------- public api ----------

  root.cqCloud = {
    base: () => API_BASE,
    setBase: (v) => { API_BASE = String(v).replace(/\/$/, ''); },
    put,
    fetch: fetchLine,
    addPending,
    admit,
    deny,
    consumeOneTime,
    clearSession,
    simpleStart,
    transferHost,
    leave,
    ping,
    signal,
    pullSignals,
    startSync,
    mergeIntoLocal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
