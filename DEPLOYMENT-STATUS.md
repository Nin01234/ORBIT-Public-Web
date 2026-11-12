# ORBIT public web — deployment preparation

This is a separate public-web staging project. The existing desktop app, mobile project and original local web preview are not modified.

## Prepared
- Front-end assets copied into this folder.
- Independent Node.js 20+ HTTP server, using the hosting platform's PORT.
- Render Blueprint file (render.yaml), package.json and health check endpoint.
- Static-file allowlist, security headers and per-IP request throttling.
- API routes tested successfully against their upstream catalogues:
  - Radio station discovery (Spinn Radio directory)
  - Music search and Audius stream resolution
  - Podcast search and episode lookup (Apple/iTunes)
  - LibriVox audiobook catalogue and RSS
  - Global TV country list, channel catalogue and search (iptv-org)
  - Public-domain film catalogue and Archive.org file metadata
  - Spinn movie catalogue
- Local offline endpoints are deliberately isolated from the desktop library. Public web returns an empty per-browser library until browser-local download support is implemented.
- Desktop-only mobile QR and token endpoints are not exposed.

## Verified locally
- `node --check server.mjs` passes.
- Homepage, app.js, CSS and icon assets return HTTP 200.
- Radio (3 results), Apple podcasts (24 results), Audius music (30 results), country list (250), Ghana TV channels (218), public-domain films (27), Spinn movie catalogue and offline-list endpoint returned HTTP 200 during the local API smoke test.
- The public backend is running locally on port 3000.

## Remaining before a public launch
1. Implement a carefully restricted streaming relay for radio and TV (the desktop server's proxy must not be exposed as-is).
2. Add browser-local downloads using IndexedDB and wire the web downloads UI to it. Public downloads must never use or reveal the desktop user's local files.
3. YouTube search, audio extraction, music-video playback and movie-trailer embeds have been removed from the public website.
4. Complete end-to-end tests for every screen and playback flow in desktop and mobile browsers.
5. Review third-party terms, content rights, rate limits and attribution.
6. Connect a GitHub repository to Render (or another host), review the public files, and deploy only after owner approval.

## Run locally
Requires Node.js 20+:
```sh
npm start
```
Open http://localhost:3000. Health check: http://localhost:3000/healthz.

## Deployment
The Render Blueprint is a starting configuration, not a live deployment. It does not upload code or create a hosting service on its own.
