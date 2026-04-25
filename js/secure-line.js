// Cryptiq Secure Line — core data model
// localStorage-backed (demo, no server). Cross-tab sync via BroadcastChannel.

(function (root) {
  const LS_KEY = 'cq.secureline.lines.v1';
  const PRESENCE_CHANNEL = 'cq.secureline.presence';

  // ---------- id / token helpers ----------

  const randToken = (len = 14) => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  };

  const lineCode = () =>
    `${randToken(3)}-${randToken(4)}-${randToken(3)}`;

  // ---------- store ----------

  const readAll = () => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch { return {}; }
  };

  const writeAll = (data) => {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  };

  const getLine = (id) => readAll()[id] || null;

  const saveLine = (line) => {
    const all = readAll();
    all[line.id] = line;
    writeAll(all);
    return line;
  };

  const deleteLine = (id) => {
    const all = readAll();
    delete all[id];
    writeAll(all);
  };

  // ---------- line factory ----------

  const createLine = (name, opts) => {
    opts = opts || {};
    const id = lineCode();
    const line = {
      id,
      name: (name || 'Secure Line').trim() || 'Secure Line',
      createdAt: Date.now(),
      createdBy: null,          // set after host enrollment
      participants: [],         // [{ id, name, photo (dataURL), role, enrolledAt }]
      sharedToken: randToken(16),
      oneTimeTokens: {},        // { [tokenId]: { participantId, createdAt, expiresAt, usedAt } }
      // When true, every participant is face-matched continuously for the
      // whole call (flip to away / intruder on the fly, auto-silence audio
      // if an imposter is detected, etc). Default is entry-gated only:
      // verify once at the door, then it's a normal call.
      activeMonitoring: !!opts.activeMonitoring,
    };
    saveLine(line);
    return line;
  };

  const setActiveMonitoring = (lineId, on) => {
    const line = getLine(lineId);
    if (!line) return;
    line.activeMonitoring = !!on;
    saveLine(line);
    return line;
  };

  const addParticipant = (lineId, { name, photo, role }) => {
    const line = getLine(lineId);
    if (!line) throw new Error('Line not found');
    const pid = randToken(10);
    const participant = {
      id: pid,
      name: (name || 'Unnamed').trim(),
      photo: photo || null,
      role: (role || '').trim(),
      enrolledAt: Date.now(),
    };
    line.participants.push(participant);
    saveLine(line);
    return participant;
  };

  const removeParticipant = (lineId, participantId) => {
    const line = getLine(lineId);
    if (!line) return;
    line.participants = line.participants.filter(p => p.id !== participantId);
    Object.keys(line.oneTimeTokens).forEach(tid => {
      if (line.oneTimeTokens[tid].participantId === participantId) delete line.oneTimeTokens[tid];
    });
    saveLine(line);
  };

  const setHost = (lineId, participantId) => {
    const line = getLine(lineId);
    if (!line) return;
    line.createdBy = participantId;
    saveLine(line);
  };

  // ---------- links ----------

  // Duration presets (ms). `null` = never expires.
  const DURATION_PRESETS = {
    '1h':  60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    never: null,
  };

  // Mint an attendee-bound token. Options:
  //   expiresInMs: number | null  — duration to expiry (null = no expiry)
  //   singleUse:   boolean        — burn on first consume
  // Rotates out prior unused tokens for the same participant so each person
  // only holds one active link at a time.
  const mintOneTime = (lineId, participantId, opts = {}) => {
    const { expiresInMs = DURATION_PRESETS['24h'], singleUse = true } = opts;
    const line = getLine(lineId);
    if (!line) throw new Error('Line not found');
    Object.keys(line.oneTimeTokens).forEach(tid => {
      const entry = line.oneTimeTokens[tid];
      if (entry.participantId === participantId) {
        if (!entry.usedAt || !entry.singleUse) delete line.oneTimeTokens[tid];
      }
    });
    const token = randToken(20);
    line.oneTimeTokens[token] = {
      participantId,
      createdAt: Date.now(),
      expiresAt: (expiresInMs === null || expiresInMs === undefined) ? null : Date.now() + expiresInMs,
      singleUse: !!singleUse,
      usedAt: null,
      usedCount: 0,
    };
    saveLine(line);
    return token;
  };

  const consumeOneTime = (lineId, token) => {
    const line = getLine(lineId);
    if (!line) return { ok: false, reason: 'line-missing' };
    const entry = line.oneTimeTokens[token];
    if (!entry) return { ok: false, reason: 'invalid' };
    if (entry.singleUse && entry.usedAt) return { ok: false, reason: 'used' };
    if (entry.expiresAt && Date.now() > entry.expiresAt) return { ok: false, reason: 'expired' };
    entry.usedAt = Date.now();
    entry.usedCount = (entry.usedCount || 0) + 1;
    saveLine(line);
    return { ok: true, participantId: entry.participantId };
  };

  const revokeOneTime = (lineId, token) => {
    const line = getLine(lineId);
    if (!line) return;
    delete line.oneTimeTokens[token];
    saveLine(line);
  };

  // ---------- open guest link + pending admissions ----------
  //
  // An "open" link lets anyone click, enter a name + photo, and request
  // to join. The host sees the request on the call page and admits or
  // denies. Useful for ad-hoc invites where you don't know the attendee
  // list in advance.

  const mintOpenLink = (lineId) => {
    const line = getLine(lineId);
    if (!line) throw new Error('Line not found');
    if (!line.openToken) line.openToken = randToken(20);
    if (!Array.isArray(line.pending)) line.pending = [];
    saveLine(line);
    return line.openToken;
  };

  const revokeOpenLink = (lineId) => {
    const line = getLine(lineId);
    if (!line) return;
    delete line.openToken;
    saveLine(line);
  };

  const buildGuestLink = (line) => {
    const url = new URL('guest.html', location.href);
    url.searchParams.set('line', line.id);
    url.searchParams.set('g', line.openToken);
    return url.toString();
  };

  // Guest submits name + photo. Creates a pending record on the line and
  // broadcasts a request so any host tab can react.
  const requestGuestJoin = (lineId, token, { name, photo }) => {
    const line = getLine(lineId);
    if (!line) return { ok: false, reason: 'line-missing' };
    if (!line.openToken || token !== line.openToken) return { ok: false, reason: 'invalid-token' };
    if (!Array.isArray(line.pending)) line.pending = [];
    const pid = randToken(10);
    line.pending.push({
      id: pid,
      name: String(name || '').trim() || 'Guest',
      photo: photo || null,
      status: 'pending',
      requestedAt: Date.now(),
    });
    saveLine(line);
    emitPresence({ type: 'guest-request', lineId, pendingId: pid });
    return { ok: true, pendingId: pid };
  };

  const getPending = (lineId, pendingId) => {
    const line = getLine(lineId);
    if (!line || !Array.isArray(line.pending)) return null;
    if (pendingId) return line.pending.find(p => p.id === pendingId) || null;
    return line.pending.filter(p => p.status === 'pending');
  };

  const admitPending = (lineId, pendingId) => {
    const line = getLine(lineId);
    if (!line || !Array.isArray(line.pending)) return null;
    const entry = line.pending.find(p => p.id === pendingId);
    if (!entry || entry.status !== 'pending') return null;
    entry.status = 'admitted';
    entry.admittedAt = Date.now();
    // Promote the guest into a real participant.
    line.participants.push({
      id: entry.id,
      name: entry.name,
      photo: entry.photo,
      role: 'guest',
      enrolledAt: entry.admittedAt,
    });
    saveLine(line);
    emitPresence({ type: 'guest-admitted', lineId, pendingId, participantId: entry.id });
    return entry;
  };

  const denyPending = (lineId, pendingId) => {
    const line = getLine(lineId);
    if (!line || !Array.isArray(line.pending)) return null;
    const entry = line.pending.find(p => p.id === pendingId);
    if (!entry) return null;
    entry.status = 'denied';
    entry.deniedAt = Date.now();
    saveLine(line);
    emitPresence({ type: 'guest-denied', lineId, pendingId });
    return entry;
  };

  const findParticipantByToken = (lineId, token) => {
    const line = getLine(lineId);
    if (!line) return null;
    const entry = line.oneTimeTokens[token];
    if (!entry) return null;
    return line.participants.find(p => p.id === entry.participantId) || null;
  };

  // Note: a secure line's shared link only encodes line id + shared token;
  // the recipient still must pass the face match against an enrolled participant.
  const buildSharedLink = (line) => {
    const url = new URL('join.html', location.href);
    url.searchParams.set('line', line.id);
    url.searchParams.set('t', line.sharedToken);
    return url.toString();
  };

  const buildOneTimeLink = (line, token) => {
    const url = new URL('join.html', location.href);
    url.searchParams.set('line', line.id);
    url.searchParams.set('o', token);
    return url.toString();
  };

  const buildCallLink = (line, participantId) => {
    const url = new URL('call.html', location.href);
    url.searchParams.set('line', line.id);
    if (participantId) url.searchParams.set('me', participantId);
    return url.toString();
  };

  // ---------- presence (cross-tab) ----------

  const channel = ('BroadcastChannel' in window)
    ? new BroadcastChannel(PRESENCE_CHANNEL)
    : null;

  const listeners = new Set();
  if (channel) {
    channel.addEventListener('message', (e) => {
      listeners.forEach(fn => { try { fn(e.data); } catch {} });
    });
  }

  const onPresence = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  const emitPresence = (msg) => {
    if (!channel) return;
    try { channel.postMessage(msg); } catch {}
  };

  // ---------- session (current tab's identity) ----------

  const SESSION_KEY = 'cq.secureline.session.v1';

  const setSession = (obj) => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj));
  };

  const getSession = () => {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  };

  const clearSession = () => sessionStorage.removeItem(SESSION_KEY);

  // ---------- utility ----------

  const shortLink = (full) => {
    try {
      const u = new URL(full);
      return u.pathname.replace(/^\//, '') + u.search;
    } catch {
      return full;
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      return false;
    }
  };

  const formatAge = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  };

  const formatExpiresIn = (ts) => {
    if (ts === null || ts === undefined) return 'never expires';
    const s = Math.max(0, Math.floor((ts - Date.now()) / 1000));
    if (s < 60) return `${s}s left`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m left`;
    const h = Math.floor(m / 60);
    if (h < 48) { const rm = m % 60; return `${h}h ${rm}m left`; }
    const d = Math.floor(h / 24);
    return `${d}d left`;
  };

  const formatDurationLabel = (expiresInMs) => {
    if (expiresInMs === null || expiresInMs === undefined) return 'no expiry';
    const keys = Object.keys(DURATION_PRESETS);
    for (const k of keys) {
      if (DURATION_PRESETS[k] === expiresInMs) return k;
    }
    return `${Math.round(expiresInMs / 60000)}m`;
  };

  // ---------- public api ----------

  root.cqLine = {
    getLine, saveLine, deleteLine, createLine, setActiveMonitoring,
    addParticipant, removeParticipant, setHost,
    mintOneTime, consumeOneTime, revokeOneTime, findParticipantByToken,
    mintOpenLink, revokeOpenLink, buildGuestLink,
    requestGuestJoin, getPending, admitPending, denyPending,
    buildSharedLink, buildOneTimeLink, buildCallLink,
    onPresence, emitPresence,
    setSession, getSession, clearSession,
    shortLink, copyToClipboard, formatAge, formatExpiresIn, formatDurationLabel,
    randToken, DURATION_PRESETS,
  };
})(window);
