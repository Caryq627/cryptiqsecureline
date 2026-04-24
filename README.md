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
python3 -m http.server 8000
# visit http://localhost:8000
```

Camera & mic only work over `http://localhost` or `https://`. A deployed Render site is served over HTTPS automatically.

## Deploy to Render

This is a pure static site (HTML/JS/CSS, no build step). On Render, pick **Static Site** — *not* Web Service.

1. Push this repo to GitHub / GitLab.
2. In Render: **New → Static Site** → connect the repo.
3. Settings:
   - **Build command**: *(leave blank)*
   - **Publish directory**: `.`
4. Deploy. Render reads `render.yaml` for the security headers.

The app is fully client-side. No server secrets, no env vars needed for a demo (sim mode passes liveness automatically). To wire real FaceTec, set `window.CQ_FACETEC = { server, deviceKey }` before the scripts load.
