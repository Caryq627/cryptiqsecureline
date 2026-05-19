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

  // Set the shared-link expiry. Pass null to clear (= never expires).
  const setSharedExpiry = (lineId, expiresInMs) => {
    const line = getLine(lineId);
    if (!line) return null;
    line.sharedExpiresAt = (expiresInMs === null || expiresInMs === undefined)
      ? null
      : Date.now() + expiresInMs;
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

  // Mint a one-time link bound to a NAME + REFERENCE PHOTO that aren't yet
  // a participant on this line. The recipient gates against the photo; on
  // first successful gate pass, consumeOneTime materializes the participant
  // (so generating the link doesn't inflate the call roster).
  const mintNamedInvite = (lineId, opts = {}) => {
    const { name, photo, expiresInMs = DURATION_PRESETS['24h'], singleUse = true } = opts;
    const line = getLine(lineId);
    if (!line) throw new Error('Line not found');
    const token = randToken(20);
    line.oneTimeTokens[token] = {
      participantId: null,         // assigned at consume time
      name: String(name || '').trim() || 'Guest',
      photo: photo || null,         // ref photo for face-gate
      pending: true,                // marks "named invite" — see consumeOneTime
      createdAt: Date.now(),
      expiresAt: (expiresInMs === null || expiresInMs === undefined)
        ? null
        : Date.now() + expiresInMs,
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
    // Named invite (no participant yet): create them now. This is the
    // moment the host's "invitation" turns into a real attendee on the
    // call — only when they actually pass the gate, never at mint time.
    if (entry.pending && !entry.participantId) {
      const pid = randToken(10);
      line.participants.push({
        id: pid,
        name: entry.name,
        photo: entry.photo,
        role: 'guest',
        enrolledAt: Date.now(),
      });
      entry.participantId = pid;
      entry.pending = false;
    }
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

  const buildGuestLink = (line) => buildLinkUrl(
    'guest.html',
    [['line', line.id], ['g', line.openToken]],
    serializeLineForLink(line, { kind: 'guest' }),
  );

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

  // ---------- self-contained URL payloads ----------
  //
  // Lines live in localStorage on the host's device. For cross-device link
  // sharing (text the link to another phone) the recipient's browser has
  // no record of the line. We embed a stripped-down snapshot of the line
  // in every link as #d=<base64-json>; on the receiving end we hydrate
  // localStorage from that snapshot if the line isn't already there.
  //
  // The payload sits in the URL HASH (after #) — not the query string —
  // so the visible part of the URL stays clean. Hashes are also never
  // sent to servers, which is a privacy bonus.
  //
  // We strip photos for participants because data-URLs are too big for a
  // URL (~30-100KB each, vs ~2-8KB practical URL limit). Cross-device
  // users without photos get liveness-only entry; we capture their
  // gate-passing frame as their photo so active-monitoring still works.
  //
  // Schema v2 uses single-letter keys + only includes the ONE oneTimeToken
  // the link actually carries (not the whole token map), so a typical
  // link payload is a few hundred chars instead of several KB.

  // Build a compact, single-letter-key snapshot of the line.
  //
  // opts.kind  — 'shared' | 'one-time' | 'guest' | undefined
  //              Controls which top-level tokens are embedded. The recipient
  //              page only validates one of {sharedToken, openToken, oneTime
  //              token}, so we ship just the one this link is for.
  // opts.tokenId — when 'one-time', the exact token entry to embed (so the
  //                rest of the host's token map stays off the wire).
  const serializeLineForLink = (line, opts = {}) => {
    const kind = opts.kind || 'shared';
    const out = {
      v: 2,
      i: line.id,
      n: line.name,
      c: line.createdAt,
    };
    if (line.createdBy) out.b = line.createdBy;
    if (line.activeMonitoring) out.a = 1;

    if (kind === 'shared') {
      if (line.sharedToken) out.s = line.sharedToken;
      if (line.sharedExpiresAt) out.sx = line.sharedExpiresAt;
    } else if (kind === 'guest') {
      if (line.openToken) out.o = line.openToken;
    } else if (kind === 'one-time' && opts.tokenId) {
      const t = (line.oneTimeTokens || {})[opts.tokenId];
      if (t) out.t = { [opts.tokenId]: compactToken(t) };
    }

    // Participants: array-of-arrays [id, name, role, enrolledAt] — no photos.
    out.p = (line.participants || []).map(p => [
      p.id, p.name, p.role || '', p.enrolledAt || 0,
    ]);
    return out;
  };

  const compactToken = (t) => {
    const o = { c: t.createdAt };
    if (t.participantId) o.p = t.participantId;
    if (t.name) o.n = t.name;
    if (t.photo) o.f = t.photo;
    if (t.pending) o.e = 1;
    if (t.expiresAt) o.x = t.expiresAt;
    if (t.singleUse) o.s = 1;
    if (t.usedAt) o.u = t.usedAt;
    return o;
  };

  const inflateToken = (o) => ({
    participantId: o.p || null,
    name: o.n || null,
    photo: o.f || null,
    pending: !!o.e,
    expiresAt: o.x || null,
    singleUse: !!o.s,
    usedAt: o.u || null,
    usedCount: 0,
    createdAt: o.c || Date.now(),
  });

  // base64-url (RFC 4648 §5) — URL-safe, no padding.
  const encodePayload = (obj) => {
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const decodePayload = (b64) => {
    if (!b64) return null;
    try {
      const std = b64.replace(/-/g, '+').replace(/_/g, '/');
      const padded = std + '='.repeat((4 - std.length % 4) % 4);
      const json = decodeURIComponent(escape(atob(padded)));
      return JSON.parse(json);
    } catch { return null; }
  };

  // Inflate a compact (v2) snapshot back into the full line shape the rest
  // of the app expects. Accepts legacy (v1) snapshots unchanged for
  // backward compatibility with links already in the wild.
  const inflateLineSnapshot = (snap) => {
    if (!snap || typeof snap !== 'object') return null;
    if (snap.v !== 2) return snap.id ? snap : null; // v1 or unrecognized
    const line = {
      id: snap.i,
      name: snap.n,
      createdAt: snap.c || Date.now(),
      createdBy: snap.b || null,
      activeMonitoring: !!snap.a,
      sharedToken: snap.s || null,
      sharedExpiresAt: snap.sx || null,
      openToken: snap.o || null,
      participants: (snap.p || []).map(row => Array.isArray(row)
        ? { id: row[0], name: row[1], role: row[2] || '', enrolledAt: row[3] || 0 }
        : row),
      oneTimeTokens: {},
    };
    if (snap.t && typeof snap.t === 'object') {
      for (const [tid, t] of Object.entries(snap.t)) {
        line.oneTimeTokens[tid] = inflateToken(t);
      }
    }
    return line;
  };

  // Recipient-side: take a payload from the URL hash (or legacy ?d=) and
  // store the line locally so every cqLine.* helper just works.
  //
  // If the line already exists locally (host's own device, or any device
  // that's received this line before), MERGE — keep local photos, local
  // pending guest requests, and any host-side tokens the URL doesn't carry.
  //
  // Crucial: v2 payloads are PARTIAL. A one-time link doesn't carry the
  // line's openToken; a guest link doesn't carry the line's sharedToken.
  // So we explicitly fall back to existing values for any token-shaped
  // field the payload is silent about. Naïve `...payload` spread would
  // null those out and break later links.
  const hydrateFromPayload = (b64) => {
    const raw = decodePayload(b64);
    const payload = inflateLineSnapshot(raw);
    if (!payload || !payload.id) return null;
    const existing = getLine(payload.id);

    // Union participants: payload's entries (with local photos preserved)
    // PLUS any locally-known participants the payload didn't mention.
    const mergeParticipants = () => {
      const ex = existing && existing.participants || [];
      const pay = payload.participants || [];
      const seen = new Set();
      const out = [];
      for (const p of pay) {
        const local = ex.find(x => x.id === p.id);
        out.push(local && local.photo ? { ...p, photo: local.photo } : p);
        seen.add(p.id);
      }
      for (const p of ex) {
        if (!seen.has(p.id)) out.push(p);
      }
      return out;
    };

    if (existing) {
      const merged = {
        ...existing,
        // Adopt payload fields, but never let a missing field clobber an
        // existing non-null one. `payload.X || existing.X` keeps the
        // current value when the payload doesn't carry that slot.
        name: payload.name || existing.name,
        createdAt: payload.createdAt || existing.createdAt,
        createdBy: payload.createdBy || existing.createdBy,
        activeMonitoring: payload.activeMonitoring || existing.activeMonitoring || false,
        sharedToken: payload.sharedToken || existing.sharedToken || null,
        sharedExpiresAt: payload.sharedExpiresAt || existing.sharedExpiresAt || null,
        openToken: payload.openToken || existing.openToken || null,
        live: existing.live || {},
        pending: Array.isArray(existing.pending) ? existing.pending : [],
        participants: mergeParticipants(),
        oneTimeTokens: { ...(existing.oneTimeTokens || {}), ...(payload.oneTimeTokens || {}) },
      };
      saveLine(merged);
      return merged;
    }
    // Brand-new line on this device — accept the snapshot wholesale.
    const fresh = {
      ...payload,
      live: {},
      pending: [],
    };
    saveLine(fresh);
    return fresh;
  };

  // Convenience: read the encoded payload from this page's URL. Prefers
  // the hash fragment (#d=...), falls back to the legacy ?d=... query
  // param so old links still work.
  const readPayloadFromLocation = () => {
    const hash = (location.hash || '').replace(/^#/, '');
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      const d = hashParams.get('d');
      if (d) return d;
    }
    return new URLSearchParams(location.search).get('d');
  };

  // Build a URL with the payload tucked into the hash fragment. Anything
  // visible before the # in the user's clipboard looks like a normal URL.
  const buildLinkUrl = (path, queryEntries, snapshot) => {
    const url = new URL(path, location.href);
    for (const [k, v] of queryEntries) url.searchParams.set(k, v);
    if (snapshot) url.hash = 'd=' + encodePayload(snapshot);
    return url.toString();
  };

  // Shared link (legacy, still wired). Embeds a full snapshot minus tokens.
  const buildSharedLink = (line) => buildLinkUrl(
    'join.html',
    [['line', line.id], ['t', line.sharedToken]],
    serializeLineForLink(line, { kind: 'shared' }),
  );

  const buildOneTimeLink = (line, token) => buildLinkUrl(
    'join.html',
    [['line', line.id], ['o', token]],
    serializeLineForLink(line, { kind: 'one-time', tokenId: token }),
  );

  const buildCallLink = (line, participantId) => {
    const url = new URL('call.html', location.href);
    url.searchParams.set('line', line.id);
    if (participantId) url.searchParams.set('me', participantId);
    return url.toString();
  };

  // ---------- live-call markers ----------
  //
  // pingInCall: call this every few seconds from call.html so other tabs can
  // tell whether someone is actually IN the call. Stored as a per-participant
  // expiring timestamp. callIsLive: returns true if any participant has been
  // seen within the last `withinMs` (default 8s).

  const PRESENCE_TTL = 8000;

  // line.live[pid] is either a bare timestamp (legacy, from pingInCall)
  // or an object { ts, state, muted, handRaised, speaking } from the
  // cross-device cloud sync. Centralize the extraction so every callsite
  // sees a number.
  const liveTsOf = (v) => (v && typeof v === 'object') ? v.ts : (typeof v === 'number' ? v : 0);

  const pingInCall = (lineId, participantId) => {
    const line = getLine(lineId);
    if (!line) return;
    if (!line.live) line.live = {};
    // Preserve any state fields that the cloud sync layer may have written.
    const existing = line.live[participantId];
    if (existing && typeof existing === 'object') {
      line.live[participantId] = { ...existing, ts: Date.now() };
    } else {
      line.live[participantId] = Date.now();
    }
    saveLine(line);
  };

  const callIsLive = (lineId, withinMs = PRESENCE_TTL) => {
    const line = getLine(lineId);
    if (!line || !line.live) return false;
    const cutoff = Date.now() - withinMs;
    return Object.values(line.live).some(v => liveTsOf(v) > cutoff);
  };

  const liveParticipantIds = (lineId, withinMs = PRESENCE_TTL) => {
    const line = getLine(lineId);
    if (!line || !line.live) return [];
    const cutoff = Date.now() - withinMs;
    return Object.entries(line.live)
      .filter(([_, v]) => liveTsOf(v) > cutoff)
      .map(([pid]) => pid);
  };

  const clearLivePresence = (lineId, participantId) => {
    const line = getLine(lineId);
    if (!line || !line.live) return;
    delete line.live[participantId];
    saveLine(line);
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
    getLine, saveLine, deleteLine, createLine, setActiveMonitoring, setSharedExpiry,
    addParticipant, removeParticipant, setHost,
    mintOneTime, mintNamedInvite, consumeOneTime, revokeOneTime, findParticipantByToken,
    mintOpenLink, revokeOpenLink, buildGuestLink,
    requestGuestJoin, getPending, admitPending, denyPending,
    buildSharedLink, buildOneTimeLink, buildCallLink,
    serializeLineForLink, encodePayload, decodePayload, hydrateFromPayload,
    readPayloadFromLocation,
    pingInCall, callIsLive, liveParticipantIds, clearLivePresence,
    onPresence, emitPresence,
    setSession, getSession, clearSession,
    shortLink, copyToClipboard, formatAge, formatExpiresIn, formatDurationLabel,
    randToken, DURATION_PRESETS,
  };
})(window);
