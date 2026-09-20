# Frontline

A war-map style real-time strategy game that runs in the browser: divisions are country flags, territory is
coloured by owner, and the frontline moves smoothly as they push.

**Play:** https://pyroxzz.github.io/frontline/

- Single player against three AI countries, an interactive tutorial, and peer-to-peer multiplayer
  (host a game, share the room code - no server, no account).
- No build step and no dependencies: plain HTML, CSS and JavaScript (WebGL2 for the map, Canvas 2D for the units).
  To run it locally, open `index.html`, or serve the folder (`python -m http.server`) if you want to test
  multiplayer between two windows.

| File | What it is |
|---|---|
| `js/sim.js` | the whole simulation (deterministic, fixed 30 Hz tick) |
| `js/net.js` | lockstep multiplayer over WebRTC (Trystero) |
| `js/render.js` | map shader and unit drawing |
| `js/main.js` | camera, input, HUD, home page, tutorial |
