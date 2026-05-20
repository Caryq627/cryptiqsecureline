// Cryptiq Secure Line — cross-device line-state API
//
// One process holds line state in memory keyed by line id. Clients
// (host + guest devices) GET fresh state, POST mutations, and poll a
// few times per second to learn about admit decisions / guest requests
// / live presence. Lines are evicted after 24h of inactivity.
//
// This is a demo server: no auth, no DB. Security relies on the line
// id being unguessable (~64 bits of entropy) and the biometric gate
// on the client. For production, swap the in-memory Map for Redis
// (or Render Key Value) and require a host-token for admit/sync.

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' })); // photos in named-invite tokens

const PORT = process.env.PORT || 10000;
const LINE_TTL_MS = 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 12 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000; // stale join requests auto-drop

const lines = new Map(); // id → { line, touchedAt }

// WebRTC signaling — per-line inbox of offer/answer/ICE messages addressed
// to specific participants. Each message has a monotonically increasing
// `seq` so clients can long-poll with ?since=<seq> and never miss one.
// Bounded by SIGNAL_TTL_MS — old messages drop off so a stuck client
// can't blow the queue up.
const signalInboxes = new Map(); // lineId → [{seq, from, to, type, data, ts}]
let signalSeq = 0;
const SIGNAL_TTL_MS = 30 * 1000;

const touch = (id) => {
  const entry = lines.get(id);
  if (entry) entry.touchedAt = Date.now();
};

const getLine = (id) => {
  const entry = lines.get(id);
  return entry ? entry.line : null;
};

const setLine = (id, line) => {
  lines.set(id, { line, touchedAt: Date.now() });
};

const randId = (len = 12) => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

// Periodic TTL sweep — drops lines that haven't been touched in a day,
// along with their signal inboxes.
setInterval(() => {
  const cutoff = Date.now() - LINE_TTL_MS;
  for (const [id, entry] of lines) {
    if (entry.touchedAt < cutoff) {
      lines.delete(id);
      signalInboxes.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Strip stale presence pings on read so clients don't see zombies.
// live entries can be either a bare timestamp (legacy) or an object
// { ts, state, muted, handRaised, speaking } from a state-bearing ping.
const pruneLive = (line) => {
  if (!line || !line.live) return line;
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const pid of Object.keys(line.live)) {
    const v = line.live[pid];
    const ts = (v && typeof v === 'object') ? v.ts : v;
    if (!ts || ts < cutoff) delete line.live[pid];
  }
  return line;
};

// Drop join requests that have been hanging around for too long. A guest
// who hit the open link, never got admitted, and closed their tab would
// otherwise haunt the host's admit strip forever. Run on every read.
const prunePending = (line) => {
  if (!line || !Array.isArray(line.pending)) return line;
  const cutoff = Date.now() - PENDING_TTL_MS;
  line.pending = line.pending.filter(p => (p.requestedAt || 0) > cutoff);
  return line;
};

// Combined cleanup applied on every GET so polling clients converge on
// the same view the server has.
const sanitize = (line) => prunePending(pruneLive(line));

// ---------- routes ----------

app.get('/health', (_req, res) => {
  res.json({ ok: true, lines: lines.size, uptime: process.uptime() });
});

// Simple-flow line creator. The host's device POSTs once with their
// name + photo and gets back a short 6-char shareable code, their
// participantId, and a hostToken that authorizes admit/deny later.
// All subsequent state-changing calls (pending / admit / deny / ping
// / signal) go through the regular /api/line/:id endpoints with the
// short code as the id.
app.post('/api/simple/start', (req, res) => {
  const { name, photo } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) return res.status(400).json({ ok: false, reason: 'no-name' });

  // 20 chars from 30-char alphabet ≈ 3.5e29 combinations. Collisions
  // are statistically impossible at any realistic concurrency level,
  // but we still retry a few times defensively.
  let code = null;
  for (let i = 0; i < 25; i++) {
    const c = randId(20);
    if (!lines.has(c)) { code = c; break; }
  }
  if (!code) return res.status(503).json({ ok: false, reason: 'code-collision' });

  const participantId = randId(10);
  const hostToken = randId(20);
  const line = {
    id: code,
    name: cleanName + "'s Secure Line",
    createdAt: Date.now(),
    createdBy: participantId,
    hostToken,
    // joinPolicy: 'open' tells /api/line/:id/pending that anyone with
    // the line code can request to join — no openToken needed in the
    // URL. The host still gates by clicking Admit / Deny.
    joinPolicy: 'open',
    participants: [{
      id: participantId,
      name: cleanName,
      photo: photo || null,
      role: 'host',
      enrolledAt: Date.now(),
    }],
    pending: [],
    live: {},
    oneTimeTokens: {},
  };
  setLine(code, line);
  res.json({ ok: true, lineCode: code, participantId, hostToken });
});

// Fetch the latest line state.
app.get('/api/line/:id', (req, res) => {
  const line = getLine(req.params.id);
  if (!line) return res.status(404).json({ ok: false, reason: 'not-found' });
  touch(req.params.id);
  res.json({ ok: true, line: sanitize(line) });
});

// Host pushes (creates or updates) the full line snapshot. Server-side
// state for pending guests, admitted participants the host doesn't know
// about yet, live presence, and one-time token usage is preserved across
// the merge so we don't lose data the host hasn't polled yet.
app.put('/api/line/:id', (req, res) => {
  const incoming = req.body && req.body.line;
  if (!incoming || incoming.id !== req.params.id) {
    return res.status(400).json({ ok: false, reason: 'bad-line' });
  }
  const existing = getLine(req.params.id);
  const merged = mergeFromHost(existing, incoming);
  setLine(req.params.id, merged);
  res.json({ ok: true, line: sanitize(merged) });
});

// Guest submits a join request (open-link flow).
//
// Two acceptance modes:
//   1. Legacy lines minted an `openToken` that must match (the host
//      shared a URL with that token in the hash).
//   2. Simple-flow lines (created via /api/simple/start) set
//      joinPolicy: 'open' — anyone with the short line code can
//      request to join; the host gates on admit.
app.post('/api/line/:id/pending', (req, res) => {
  const line = getLine(req.params.id);
  if (!line) {
    console.log('[srv] /pending 404 — line not found', req.params.id);
    return res.status(404).json({ ok: false, reason: 'not-found' });
  }
  const { openToken, name, photo } = req.body || {};
  if (line.joinPolicy !== 'open') {
    if (!line.openToken || line.openToken !== openToken) {
      console.log('[srv] /pending 403 — invalid token', req.params.id, 'policy=', line.joinPolicy);
      return res.status(403).json({ ok: false, reason: 'invalid-token' });
    }
  }
  if (!Array.isArray(line.pending)) line.pending = [];
  const pendingId = randId();
  line.pending.push({
    id: pendingId,
    name: String(name || 'Guest').slice(0, 80),
    photo: photo || null,
    status: 'pending',
    requestedAt: Date.now(),
  });
  touch(req.params.id);
  console.log('[srv] /pending added', {
    lineId: req.params.id,
    pendingId,
    name: String(name || 'Guest').slice(0, 40),
    pendingCount: line.pending.length,
  });
  res.json({ ok: true, pendingId, line: sanitize(line) });
});

// Host admits a pending guest. Materializes them as a participant so
// every device that polls picks them up.
//
// If the line was created via /api/simple/start it has a hostToken; the
// caller must send it back to authorize admit. Lines from the legacy
// setup-wizard flow have no hostToken and are open (backward compat).
app.post('/api/line/:id/admit', (req, res) => {
  const line = getLine(req.params.id);
  if (!line || !Array.isArray(line.pending)) {
    return res.status(404).json({ ok: false, reason: 'not-found' });
  }
  const { pendingId, hostToken } = req.body || {};
  if (line.hostToken && line.hostToken !== hostToken) {
    return res.status(403).json({ ok: false, reason: 'not-host' });
  }
  const entry = line.pending.find(p => p.id === pendingId);
  if (!entry) return res.status(404).json({ ok: false, reason: 'pending-not-found' });
  entry.status = 'admitted';
  entry.admittedAt = Date.now();
  line.participants = line.participants || [];
  if (!line.participants.find(p => p.id === entry.id)) {
    line.participants.push({
      id: entry.id,
      name: entry.name,
      photo: entry.photo,
      role: 'guest',
      enrolledAt: entry.admittedAt,
    });
  }
  touch(req.params.id);
  res.json({ ok: true, line: sanitize(line) });
});

app.post('/api/line/:id/deny', (req, res) => {
  const line = getLine(req.params.id);
  if (!line || !Array.isArray(line.pending)) {
    return res.status(404).json({ ok: false, reason: 'not-found' });
  }
  const { pendingId, hostToken } = req.body || {};
  if (line.hostToken && line.hostToken !== hostToken) {
    return res.status(403).json({ ok: false, reason: 'not-host' });
  }
  const entry = line.pending.find(p => p.id === pendingId);
  if (!entry) return res.status(404).json({ ok: false, reason: 'pending-not-found' });
  entry.status = 'denied';
  entry.deniedAt = Date.now();
  touch(req.params.id);
  res.json({ ok: true, line: sanitize(line) });
});

// Consume a one-time token. For named-invite tokens (no participantId
// yet) this also materializes the recipient as a participant so the
// host's roster picks them up. Mirrors cqLine.consumeOneTime on the
// client, but server-side so the host learns about it.
app.post('/api/line/:id/consume-onetime', (req, res) => {
  const line = getLine(req.params.id);
  if (!line) return res.status(404).json({ ok: false, reason: 'not-found' });
  const { token } = req.body || {};
  const entry = line.oneTimeTokens && line.oneTimeTokens[token];
  if (!entry) return res.json({ ok: false, reason: 'invalid' });
  if (entry.singleUse && entry.usedAt) return res.json({ ok: false, reason: 'used' });
  if (entry.expiresAt && Date.now() > entry.expiresAt) return res.json({ ok: false, reason: 'expired' });
  if (entry.pending && !entry.participantId) {
    const pid = randId(10);
    line.participants = line.participants || [];
    line.participants.push({
      id: pid,
      name: entry.name || 'Guest',
      photo: entry.photo || null,
      role: 'guest',
      enrolledAt: Date.now(),
    });
    entry.participantId = pid;
    entry.pending = false;
  }
  entry.usedAt = Date.now();
  entry.usedCount = (entry.usedCount || 0) + 1;
  touch(req.params.id);
  res.json({ ok: true, participantId: entry.participantId, line: sanitize(line) });
});

// Presence heartbeat — every few seconds from each tab that's in the call.
// Carries the participant's tile state (verified/away/intruder/held),
// mic mute, hand-raise, and speaking flag so every other device can
// light up the tile correctly. The server doesn't interpret the state
// — it just stores+serves, and the receiving client maps it onto its
// own tile view.
app.post('/api/line/:id/ping', (req, res) => {
  const line = getLine(req.params.id);
  if (!line) return res.status(404).json({ ok: false, reason: 'not-found' });
  const { participantId, state, muted, handRaised, speaking } = req.body || {};
  if (!participantId) return res.status(400).json({ ok: false, reason: 'no-pid' });
  if (!line.live) line.live = {};
  line.live[participantId] = {
    ts: Date.now(),
    state: state || 'verified',
    muted: !!muted,
    handRaised: !!handRaised,
    speaking: !!speaking,
  };
  touch(req.params.id);
  res.json({ ok: true });
});

// Host wipes session-scoped state when starting a fresh call: pending
// guest requests from previous sessions, stale live presence, and any
// participants who joined as guests last time. The host's enrolled
// roster (role !== 'guest') and minted oneTimeTokens stay — those are
// configured state, not session state.
//
// Called once per fresh entry from setup.html → call.html. A mid-call
// refresh doesn't trigger this; only an explicit "Enter the line"
// after the host completes setup.
app.post('/api/line/:id/clear-session', (req, res) => {
  const line = getLine(req.params.id);
  if (!line) return res.status(404).json({ ok: false, reason: 'not-found' });
  line.pending = [];
  line.live = {};
  if (Array.isArray(line.participants)) {
    line.participants = line.participants.filter(p => p.role !== 'guest');
  }
  // Also drop signaling inbox for this line so leftover offers can't
  // pair stale guests with the fresh session.
  signalInboxes.delete(req.params.id);
  touch(req.params.id);
  res.json({ ok: true, line: sanitize(line) });
});

// ---------- WebRTC signaling ----------
//
// Each call participant POSTs SDP offer/answer + ICE candidates here
// addressed to a specific peer. Peers long-poll GET with the seq of
// the last message they saw and receive everything newer addressed to
// them. The server doesn't interpret payloads — it just routes JSON.

app.post('/api/line/:id/signal', (req, res) => {
  const { from, to, type, data } = req.body || {};
  if (!from || !to || !type) {
    return res.status(400).json({ ok: false, reason: 'bad-signal' });
  }
  let inbox = signalInboxes.get(req.params.id);
  if (!inbox) { inbox = []; signalInboxes.set(req.params.id, inbox); }
  signalSeq++;
  inbox.push({ seq: signalSeq, from, to, type, data, ts: Date.now() });
  // Drop messages older than the TTL so the queue doesn't grow forever.
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  while (inbox.length && inbox[0].ts < cutoff) inbox.shift();
  touch(req.params.id);
  res.json({ ok: true, seq: signalSeq });
});

app.get('/api/line/:id/signal/:pid', (req, res) => {
  const since = parseInt(req.query.since || '0', 10) || 0;
  const inbox = signalInboxes.get(req.params.id) || [];
  const pid = req.params.pid;
  const mine = inbox.filter(m => m.to === pid && m.seq > since);
  res.json({ ok: true, signals: mine });
});

// ---------- merge helper ----------

// Combine host's authoritative snapshot with server-side state the host
// may not know about. Rules:
//   - participants: union by id; host's entries win on conflict (host
//     mints/removes attendees). Anything the server has that the host
//     doesn't is something the host hasn't polled yet — keep it.
//   - oneTimeTokens: union by key; server-side `usedAt`/`usedCount`
//     beat host's older "unused" state.
//   - pending: keep server's list — guest requests live here and the
//     host learns about them via poll.
//   - live: union, max timestamp per participant.
function mergeFromHost(existing, host) {
  if (!existing) return { ...host, pending: host.pending || [], live: host.live || {} };

  const pById = new Map();
  for (const p of (existing.participants || [])) pById.set(p.id, p);
  for (const p of (host.participants || [])) {
    // Preserve the cloud's photo when the host's PUT lacks one
    // (recipient devices hydrate from URL payloads that strip photos
    // for size — they shouldn't degrade the cloud copy).
    const ex = pById.get(p.id);
    if (ex && ex.photo && !p.photo) {
      pById.set(p.id, { ...p, photo: ex.photo });
    } else {
      pById.set(p.id, p);
    }
  }

  const tokens = { ...(existing.oneTimeTokens || {}) };
  for (const [tid, t] of Object.entries(host.oneTimeTokens || {})) {
    const ex = tokens[tid];
    if (ex && (ex.usedAt || (ex.usedCount || 0) > 0)) {
      // Server saw it consumed — preserve the consume marker but adopt
      // host's photo/name/etc fields in case they changed.
      tokens[tid] = { ...t, usedAt: ex.usedAt, usedCount: ex.usedCount, participantId: ex.participantId || t.participantId, pending: ex.pending && t.pending };
    } else {
      tokens[tid] = t;
    }
  }

  const live = { ...(existing.live || {}) };
  for (const [pid, ts] of Object.entries(host.live || {})) {
    if (!live[pid] || live[pid] < ts) live[pid] = ts;
  }

  return {
    ...host,
    participants: Array.from(pById.values()),
    oneTimeTokens: tokens,
    pending: Array.isArray(existing.pending) ? existing.pending : (host.pending || []),
    live,
  };
}

// ---------- start ----------

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`cq-secure-line-api listening on :${PORT}`);
});
