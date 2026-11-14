# ORBIT Public Web — deployment handoff

This folder is the web-only staging copy for a free public ORBIT website.

## Local preview
Run `npm start`, then open `http://localhost:3000`.
Health endpoint: `/healthz`.

## Hosting
A Render Blueprint is included as `render.yaml`.
To deploy:
1. Put the contents of this folder in a new private GitHub repository (recommended while reviewing).
2. In Render, choose New + → Blueprint and connect that repository.
3. Review the service settings from render.yaml, then create the service.
4. Once deployed, test the generated HTTPS URL before sharing it publicly.

The Render file is a starting point; it does not create an account, repository, or public deployment.

## Current feature coverage
Working API routes were smoke-tested locally for radio discovery, Audius music search/stream, Apple podcast search/episodes, LibriVox catalogue/RSS, IPTV country/channel catalogues, Archive.org public-domain film search/file metadata and the Spinn movie catalogue.

Browser radio and TV playback uses provider stream URLs directly. Some third-party broadcasters may block cross-origin browser playback, so this requires device-by-device testing. The original desktop proxy was intentionally not exposed.

## Not yet ready
- Browser-based downloads/offline library: the public web version does not access the desktop app's local downloads.
- YouTube search and movie trailers: not enabled in the public backend yet.
- A secure public streaming relay is not implemented.
- Full end-to-end tests have not been completed.
- Third-party service terms, licensing, attribution and quotas still need review.

Do not expose the original desktop server or its offline-file endpoints to the internet. Do not put API secrets in frontend JavaScript or commit .env files.


## YouTube video downloads (test branch)

The public web test adds a server-side download endpoint to the Music Videos section. Visitors do not install yt-dlp or FFmpeg: the Render service installs yt-dlp into a private Python virtual environment and installs FFmpeg from `apt.txt`. Downloads are streamed to the visitor's browser and temporary server files are deleted after transfer.

The endpoint accepts only an 11-character YouTube video ID (not arbitrary URLs), limits concurrent jobs to two, applies the existing per-IP API rate limiter, caps requested media size to 250 MB, and times out stalled downloads. It does not use browser cookies or attempt to access private, paid, DRM-protected or otherwise restricted content. Users must confirm that they own the video or have permission and that downloading is allowed by the source terms. Hosting providers may impose disk, CPU, bandwidth and execution limits; production capacity and platform terms must be reviewed before enabling this publicly.
