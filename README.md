# Cryptiq Secure Line

Voice-only conference calls with continuous biometric identity verification. No cameras on the call — just verified voices.

## What it is

- **Voice-only tiles** with profile photos (no video streams between participants)
- **Continuous liveness** on each participant's own browser (FaceDetector API + FaceTec 2D liveness)
- **Tile states**: verified, speaking (pulsing speaker icon), away, intruder (auto-silences call audio so they can't eavesdrop), on-hold, wants-to-speak (bell)
- **Expiring invite links** per attendee (1h / 24h / 7d / 30d / never · single-use or multi-use)
- **Hold / return** — self-pause with a re-verify face-gate to rejoin
- **Dark / light theme**

## Local dev

```bash
# static site
python3 -m http.server 8000 &
# cross-device sync API
cd api && npm install && PORT=10100 npm start &
# point the client at the local API
# (run once in DevTools, persists in localStorage)
localStorage.setItem('cq.api.override', 'http://127.0.0.1:10100')
# visit http://localhost:8000
```

Camera & mic only work over `http://localhost` or `https://`. A deployed Render site is served over HTTPS automatically.

## Deploy to Render

Two services from this repo (`render.yaml` declares both; Render auto-creates / updates them on push):

1. **`cryptiq-secure-line`** — Static site (root). HTML/JS/CSS, no build.
2. **`cryptiq-secure-line-api`** — Node web service (`api/`). Holds line state in memory so two devices see the same call, pending guests, and admit decisions.

First-time connect: push the repo to GitHub, then Render → **Blueprints → New** → point at the repo. Render reads `render.yaml` and provisions both services. Every subsequent `git push origin main` auto-deploys both.

The API URL is hardcoded in `js/cq-cloud.js` (`DEFAULT_API = https://cryptiq-secure-line-api.onrender.com`). If your Render service name differs, override per-page with `<meta name="cq-api" content="https://your-api.example">` or `window.CQ_API = '...'` before the scripts load.

The free Render web service sleeps after 15 min of inactivity — the first request after a cold start may take ~30s while the dyno spins back up. For production traffic, upgrade the plan or swap the in-memory `Map` in `api/server.js` for Render Key Value / Redis.

To wire real FaceTec, set `window.CQ_FACETEC = { server, deviceKey }` before the scripts load.
