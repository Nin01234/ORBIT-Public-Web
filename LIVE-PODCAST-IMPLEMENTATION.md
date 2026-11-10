# ORBIT live podcast rooms

## Implemented in source
- Added a microphone-based live room UI to the Podcasts screen in the public-web staging project and desktop source.
- Uses WebRTC audio peer connections. Audio is sent directly from the host to each listener; the Node.js service only coordinates room creation and WebRTC signalling.
- Room codes are short-lived in-memory identifiers. The server supports up to 8 listeners per room, up to 2 active rooms per originating IP, and 150 active rooms total.
- Host microphone access is requested only after the host presses Start. The desktop Electron main window grants the media permission only to its own loopback-served app origin.
- Public web response policy permits microphone access for the same origin.
- Service-worker cache version is incremented and the new client asset is included.

## Required before remote use
1. Deploy the updated `ORBIT-Public-Web-Prep` Node web service with its `ws` dependency. Render must support WebSocket upgrades on `/signal`.
2. Verify the resulting public service hostname. The desktop client currently points to `wss://orbit-public-web.onrender.com/signal`; change that constant if Render assigns a different hostname.
3. Test actual microphone-to-listener audio from two separate networks and devices.

## Known limitations
- This first version broadcasts microphone input only; it does not relay a selected podcast episode or desktop system audio.
- It uses public STUN servers but no TURN relay. Some NATs, corporate networks, and mobile carriers will block direct peer-to-peer paths. Those listeners may not connect until a TURN service is configured.
- Mesh broadcasting sends one audio connection per listener, so host upload usage increases with every listener. The room is capped at 8 listeners in this first version.
- Rooms and signalling state are in memory and are lost if the web service restarts or sleeps.
- No recording, chat, moderation, persistent show directory, user accounts, or room discovery is included.
- Signalling has been tested locally for room creation, joining, and offer/answer message relay. Real browser microphone/ICE media testing and public deployment have not yet been completed.
