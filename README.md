# 24 versus

A head-to-head 24 game over WebSockets. The host creates a room, shares a five-character code, and races everyone who joins. Every player gets the same four numbers, and the first valid answer the server receives wins the round.

## Run it

Needs Node 22 or later.

```bash
npm install
HOST_KEY=choose-a-secret npm start
```

Open http://localhost:3000. Set `PORT` to change the port.

`HOST_KEY` is what makes you the webmaster: only someone with the key can create a room. Leave it unset and anyone can host.

## How it works

- **Host**: enter your name and the host key, create a game, share the code or the invite link (`/?code=ABCDE`). You deal rounds, skip a round (which reveals an answer), lock the room, reset scores, kick players and end the game.
- **Players**: enter a name and the code. Tap a number, an operator, then a second number to merge them. Get down to a single card reading 24 to win.
- **Fairness**: hands are hidden during a three-second countdown so nobody gets a head start, and the server checks every answer itself (exact fractions, each number used once) rather than trusting the browser.
- **Kicking**: a kicked player is disconnected and their session is banned from that room. Locking the room stops them coming back under a new name.
- **Dropped connections**: a refresh or a patchy connection rejoins automatically. Guests are removed after two minutes offline. If the host is gone for five minutes, the room closes.
- Every hand dealt is checked by a solver first, so there is always at least one answer.

## Deploying

Rooms live in memory, so run a single instance (no load-balanced replicas) and expect a restart to end open games.

Behind a reverse proxy, pass WebSocket upgrades through on `/ws`. For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 120s;
}
```

Serve it over HTTPS and the page switches to `wss://` on its own. Render, Railway and Fly.io all handle WebSockets out of the box; set `HOST_KEY` in their environment settings.

`GET /health` returns the number of open rooms, handy for uptime checks.

## Files

- `server.js`: HTTP server, WebSocket rooms, dealing, answer checking
- `public/index.html`: the whole client in one file
