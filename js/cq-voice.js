// Cryptiq Secure Line — WebRTC mesh
//
// Every participant in a call opens one RTCPeerConnection to every
// other participant, attaches their local mic stream, and plays the
// remote audio through hidden <audio> elements. Signaling (SDP +
// ICE) is relayed through the cq-cloud API — POST /signal to drop
// a message in a peer's inbox, GET /signal/:pid?since= to pull
// everything new for us.
//
// Mesh is the right call for this app: voice-only, typically 2–6
// people, and no extra infra. For >8 peers, swap this for an SFU.
//
// Glare avoidance: the participant with the LOWER id is the offerer.
// The other side waits for the offer. Both reconcile against the
// cloud's "who's currently live in the call" map so a late joiner
// auto-pairs with everyone already present.

(function (root) {
  const STUN_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // createRoom — returns a controller with .close(). Pass:
  //   lineId      — the line id
  //   mePid       — our participant id
  //   localStream — our mic MediaStream (audio track[s] attached)
  //   peerPids()  — function returning the LIVE-now peer ids (we
  //                 only open PCs to people who are actually in the
  //                 call right now; otherwise we'd spend ICE on
  //                 dead participants)
  //   onPeerAudio(pid, audioEl) — optional UI hook called the
  //                 first time we receive remote audio from a peer
  function createRoom({ lineId, mePid, localStream, peerPids, onPeerAudio }) {
    if (!lineId || !mePid || !localStream) {
      throw new Error('cqVoice.createRoom: lineId, mePid, localStream required');
    }
    if (!('RTCPeerConnection' in window)) {
      console.warn('[cqVoice] WebRTC not available — call will be UI-only');
      return { close() {}, peers: () => [] };
    }

    const pcs = new Map();      // peerPid -> RTCPeerConnection
    const audioEls = new Map(); // peerPid -> <audio>
    const pendingIce = new Map(); // peerPid -> [candidate, ...] queued before SRD
    let lastSeenSeq = 0;
    let stopped = false;
    let signalPollTimer = null;
    let reconcileTimer = null;
    let backoffMs = 1000;

    const audioContainer = document.createElement('div');
    audioContainer.style.display = 'none';
    audioContainer.setAttribute('data-cq-voice', String(mePid));
    document.body.appendChild(audioContainer);

    const isOfferer = (peerPid) => String(mePid) < String(peerPid);

    const attachLocalTracks = (pc) => {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    };

    const ensurePeer = (peerPid) => {
      let pc = pcs.get(peerPid);
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: STUN_ICE });
      pcs.set(peerPid, pc);

      attachLocalTracks(pc);

      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        let audio = audioEls.get(peerPid);
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.dataset.peer = peerPid;
          audioContainer.appendChild(audio);
          audioEls.set(peerPid, audio);
        }
        // Set srcObject BEFORE notifying the listener so an analyser
        // attached in onPeerAudio actually has a live stream to read.
        // (Previously the callback fired with srcObject still null and
        // any AudioContext analyser came up empty.) Always fire the
        // callback — on reconnects we want the listener to drop its
        // old analyser and attach a fresh one to the new stream.
        audio.srcObject = stream;
        if (typeof onPeerAudio === 'function') {
          try { onPeerAudio(peerPid, audio, stream); } catch {}
        }
        // Some browsers (mobile Safari) require an explicit play after
        // srcObject is set when autoplay had previously been blocked.
        const playP = audio.play();
        if (playP && playP.catch) playP.catch(() => {});
      };

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        sendSignal(peerPid, 'ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          // Drop so the next reconcile re-creates the PC.
          if (pcs.get(peerPid) === pc) pcs.delete(peerPid);
          const a = audioEls.get(peerPid);
          if (a) { a.remove(); audioEls.delete(peerPid); }
        }
      };

      pc.onnegotiationneeded = async () => {
        // Only the designated offerer initiates. The answerer's
        // negotiationneeded fires too (because we addTrack) but we
        // ignore it — the offer will arrive shortly.
        if (!isOfferer(peerPid)) return;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal(peerPid, 'offer', { type: offer.type, sdp: offer.sdp });
        } catch (err) {
          console.warn('[cqVoice] offer failed', err);
        }
      };

      return pc;
    };

    const sendSignal = (toPid, type, data) => {
      if (!root.cqCloud) return;
      cqCloud.signal(lineId, { from: mePid, to: toPid, type, data }).catch(() => {});
    };

    const drainQueuedIce = async (peerPid, pc) => {
      const q = pendingIce.get(peerPid);
      if (!q || !q.length) return;
      pendingIce.delete(peerPid);
      for (const c of q) {
        try { await pc.addIceCandidate(c); } catch (e) { console.warn('[cqVoice] queued ICE failed', e); }
      }
    };

    const handleSignal = async (msg) => {
      const peerPid = msg.from;
      const pc = ensurePeer(peerPid);
      try {
        if (msg.type === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.data.sdp });
          await drainQueuedIce(peerPid, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(peerPid, 'answer', { type: answer.type, sdp: answer.sdp });
        } else if (msg.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.data.sdp });
          await drainQueuedIce(peerPid, pc);
        } else if (msg.type === 'ice') {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try { await pc.addIceCandidate(msg.data); } catch (e) { console.warn('[cqVoice] ice failed', e); }
          } else {
            const q = pendingIce.get(peerPid) || [];
            q.push(msg.data);
            pendingIce.set(peerPid, q);
          }
        }
      } catch (e) {
        console.warn('[cqVoice] signal handler error', msg.type, e);
      }
    };

    const pollSignals = async () => {
      if (stopped) return;
      if (!root.cqCloud) {
        signalPollTimer = setTimeout(pollSignals, 2000);
        return;
      }
      try {
        const r = await cqCloud.pullSignals(lineId, mePid, lastSeenSeq);
        if (r && r.ok && Array.isArray(r.signals)) {
          backoffMs = 1000;
          for (const s of r.signals) {
            if (s.seq > lastSeenSeq) lastSeenSeq = s.seq;
            handleSignal(s);
          }
        } else {
          backoffMs = Math.min(backoffMs * 1.5, 8000);
        }
      } catch {
        backoffMs = Math.min(backoffMs * 1.5, 8000);
      }
      if (!stopped) signalPollTimer = setTimeout(pollSignals, backoffMs);
    };

    const reconcile = () => {
      if (stopped) return;
      let liveSet;
      try {
        liveSet = new Set(peerPids() || []);
      } catch {
        liveSet = new Set();
      }
      // Open PCs to peers we're missing (only if we're the offerer —
      // otherwise we wait for their offer).
      for (const pid of liveSet) {
        if (pid === mePid) continue;
        if (!pcs.has(pid) && isOfferer(pid)) ensurePeer(pid);
      }
      // Close PCs whose peer is no longer live.
      for (const pid of pcs.keys()) {
        if (!liveSet.has(pid)) {
          const pc = pcs.get(pid);
          try { pc.close(); } catch {}
          pcs.delete(pid);
          const a = audioEls.get(pid);
          if (a) { a.remove(); audioEls.delete(pid); }
          pendingIce.delete(pid);
        }
      }
    };

    pollSignals();
    reconcile();
    reconcileTimer = setInterval(reconcile, 2500);

    return {
      close() {
        stopped = true;
        clearTimeout(signalPollTimer);
        clearInterval(reconcileTimer);
        for (const pc of pcs.values()) { try { pc.close(); } catch {} }
        pcs.clear();
        for (const a of audioEls.values()) a.remove();
        audioEls.clear();
        try { audioContainer.remove(); } catch {}
      },
      peers: () => Array.from(pcs.keys()),
      pcs: () => pcs,
    };
  }

  root.cqVoice = { createRoom };
})(typeof window !== 'undefined' ? window : globalThis);
