# Running 24 versus on Vercel

It works, mostly. But every so often a player gets kicked out of a game for no obvious reason. This is why.

## The short version

Each game room lives in the server's memory. On Vercel, the server can run as several separate copies at once, and each WebSocket connection gets cut after 5 minutes. When a player reconnects, they can end up on a copy that has never heard of their room.

## The two Vercel rules behind it

**Connections have a time limit.** Every WebSocket runs inside a Vercel Function, and it closes when that function hits its maximum duration. On the Hobby plan that's 300 seconds, and you can't raise it. Pro can go up to 800 seconds.

**Reconnects can land anywhere.** Vercel spreads connections across as many instances as it likes, and each instance has its own memory. An open connection stays on the same instance, but a new one ("not guaranteed to reach the same Vercel Function instance", in Vercel's words) might not. After a deploy, new connections go to the new version while old ones stay on the old one.

## How that plays out in the game

1. The host creates room `NC8T6`. It now exists only in instance A's memory.
2. Five minutes later, the host's connection is cut.
3. The page reconnects on its own and sends the saved room code and token.
4. Vercel routes it to instance B, where the rooms list is empty.
5. B replies "There is no game with the code NC8T6", and the next click gets "You are not in a game."

Meanwhile, anyone still connected to A carries on as if nothing happened.

## Why it feels random

- **Low traffic hides it.** Vercel often keeps a single instance warm, so most reconnects land back where they started and everything just works.
- **Everyone has their own clock.** Each player's 5 minutes starts when their browser connected, not when the room was made. The header timer shows yours. More players means more reconnects, and more chances to land in the wrong place.
- **Deploys make it worse.** Pushing a new version while a game is running almost guarantees it.

## What isn't the problem

The game code. The same `server.js` on one long-running server (Render, Railway, Fly.io or your own machine) never does this, because there's only one copy holding the rooms and nothing cuts the connection.

## Options

| Option | Effort | Fixes it? |
| --- | --- | --- |
| Move to Render, Railway or Fly.io | About 10 minutes, no code changes | Yes |
| Keep Vercel, store rooms in Redis and use pub/sub to broadcast | A proper refactor of rooms, timers and messaging | Yes |
| Keep Vercel as is | None | No, but fine for quick tests |

## Settings

The server sets the connection limit shown in the header on its own: 300 seconds when it detects Vercel, and no limit anywhere else. If you move to a plan with a longer duration, set `CONN_LIMIT_S` (for example `800`) in the environment variables so the timer matches.

## Sources

- [WebSockets on Vercel Functions](https://vercel.com/docs/functions/websockets)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
