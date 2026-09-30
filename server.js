'use strict';

/*
 * 24 versus - WebSocket game server
 *
 * One Node process serves the page and runs every room.
 * Rooms live in memory, so a restart ends all games.
 *
 * Env vars:
 *   PORT      port to listen on (default 3000)
 *   HOST_KEY  if set, only people who know this key can create rooms
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || '';

const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;
const SUBMIT_COOLDOWN_MS = 250;
const HOST_GRACE_MS = 5 * 60 * 1000;   // room survives a host drop-out this long
const PLAYER_GRACE_MS = 2 * 60 * 1000; // disconnected guests are removed after this
const NAME_MAX = 20;

/* ------------------------------------------------------------------ */
/* Fractions (exact arithmetic, so 8 / (3 - 8 / 3) really equals 24)   */
/* ------------------------------------------------------------------ */

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; }
function frac(n, d = 1) {
  if (d === 0) return null;
  if (d < 0) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function applyOp(a, b, op) {
  if (!a || !b) return null;
  switch (op) {
    case '+': return frac(a.n * b.d + b.n * a.d, a.d * b.d);
    case '-': return frac(a.n * b.d - b.n * a.d, a.d * b.d);
    case '*': return frac(a.n * b.n, a.d * b.d);
    case '/': return b.n === 0 ? null : frac(a.n * b.d, a.d * b.n);
  }
  return null;
}
const is24 = (f) => f && f.n === 24 && f.d === 1;

/* ------------------------------------------------------------------ */
/* Solver: used to deal only solvable hands and to reveal an answer   */
/* ------------------------------------------------------------------ */

function solve(nums) {
  const items = nums.map((v) => ({ v: frac(v), e: String(v) }));
  const seen = new Set();
  function rec(list) {
    if (list.length === 1) return is24(list[0].v) ? list[0].e : null;
    const key = list.map((x) => `${x.v.n}/${x.v.d}`).sort().join(',');
    if (seen.has(key)) return null;
    seen.add(key);
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const rest = list.filter((_, k) => k !== i && k !== j);
        const a = list[i], b = list[j];
        for (const op of ['+', '-', '*', '/']) {
          if ((op === '+' || op === '*') && i > j) continue; // commutative
          const v = applyOp(a.v, b.v, op);
          if (!v) continue;
          const r = rec([...rest, { v, e: `(${a.e} ${op} ${b.e})` }]);
          if (r) return r;
        }
      }
    }
    return null;
  }
  const r = rec(items);
  return r ? stripOuter(r) : null;
}
function stripOuter(e) {
  if (!e.startsWith('(') || !e.endsWith(')')) return e;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++;
    else if (e[i] === ')') depth--;
    if (depth === 0 && i < e.length - 1) return e;
  }
  return e.slice(1, -1);
}

function dealHand() {
  for (;;) {
    const hand = Array.from({ length: 4 }, () => 1 + crypto.randomInt(13));
    const solution = solve(hand);
    if (solution) return { hand, solution };
  }
}

/* ------------------------------------------------------------------ */
/* Expression checker: parse, confirm the numbers, evaluate exactly    */
/* ------------------------------------------------------------------ */

function checkExpression(raw, hand) {
  if (typeof raw !== 'string' || raw.length > 200) return { ok: false, reason: 'That expression is too long.' };
  const src = raw.replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  const tokens = src.match(/\d+|[+\-*/()]/g);
  if (!tokens || tokens.join('') !== src) return { ok: false, reason: 'Use numbers, + - × ÷ and brackets only.' };

  let pos = 0;
  const used = [];
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = next(); v = applyOp(v, term(), op); }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = next(); v = applyOp(v, factor(), op); }
    return v;
  }
  function factor() {
    const t = next();
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error('bracket'); return v; }
    if (t && /^\d+$/.test(t)) { used.push(Number(t)); return frac(Number(t)); }
    throw new Error('syntax');
  }

  let value;
  try {
    value = expr();
    if (pos !== tokens.length) throw new Error('trailing');
  } catch {
    return { ok: false, reason: 'That expression does not parse.' };
  }
  const a = [...used].sort((x, y) => x - y).join(',');
  const b = [...hand].sort((x, y) => x - y).join(',');
  if (a !== b) return { ok: false, reason: 'Use each of the four numbers exactly once.' };
  if (!value) return { ok: false, reason: 'No dividing by zero.' };
  if (!is24(value)) return { ok: false, reason: `That makes ${value.d === 1 ? value.n : value.n + '/' + value.d}, not 24.` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map(); // code -> room
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return n || 'Player';
}

function snapshot(room) {
  const r = room.round;
  return {
    code: room.code,
    hostId: room.hostId,
    locked: room.locked,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: !!p.ws, isHost: p.id === room.hostId,
    })),
    round: r && {
      n: r.n,
      status: r.status, // countdown | playing | won | skipped
      hand: r.status === 'countdown' ? null : r.hand,
      startsAt: r.startsAt,
      winnerId: r.winnerId || null,
      winningExpr: r.winningExpr || null,
      timeMs: r.timeMs || null,
      solution: r.status === 'won' || r.status === 'skipped' ? r.solution : null,
    },
    serverNow: Date.now(),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const p of room.players.values()) send(p.ws, msg);
}
function broadcastState(room) {
  broadcast(room, { type: 'state', room: snapshot(room) });
}
function notice(room, text) {
  broadcast(room, { type: 'notice', text });
}

function closeRoom(room, reason) {
  clearTimeout(room.countdownTimer);
  for (const p of room.players.values()) {
    clearTimeout(p.dropTimer);
    send(p.ws, { type: 'closed', reason });
    if (p.ws) p.ws.meta = {};
  }
  rooms.delete(room.code);
  log(`room ${room.code} closed (${reason})`);
}

function removePlayer(room, player, why) {
  clearTimeout(player.dropTimer);
  room.players.delete(player.id);
  if (player.ws) player.ws.meta = {};
  notice(room, `${player.name} ${why}.`);
  broadcastState(room);
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    send(player.ws, { type: 'closed', reason: 'You opened the game somewhere else.' });
    player.ws.meta = {};
    player.ws.close();
  }
  clearTimeout(player.dropTimer);
  player.ws = ws;
  ws.meta = { code: room.code, playerId: player.id };
  send(ws, { type: 'welcome', you: { id: player.id, token: player.token, name: player.name }, room: snapshot(room) });
}

function onDisconnect(ws) {
  const { code, playerId } = ws.meta || {};
  const room = code && rooms.get(code);
  const player = room && room.players.get(playerId);
  if (!player || player.ws !== ws) return;
  player.ws = null;
  const isHost = player.id === room.hostId;
  player.dropTimer = setTimeout(() => {
    if (!rooms.has(room.code) || player.ws) return;
    if (isHost) closeRoom(room, 'The host left the game.');
    else removePlayer(room, player, 'left the game');
  }, isHost ? HOST_GRACE_MS : PLAYER_GRACE_MS);
  broadcastState(room);
}

/* ------------------------------------------------------------------ */
/* Message handlers                                                    */
/* ------------------------------------------------------------------ */

const handlers = {
  create(ws, msg) {
    if (HOST_KEY && msg.hostKey !== HOST_KEY) return send(ws, { type: 'error', text: 'That host key is wrong.' });
    const code = newCode();
    const host = { id: newId(), token: newToken(), name: cleanName(msg.name), score: 0, ws: null, lastSubmit: 0 };
    const room = { code, hostId: host.id, players: new Map([[host.id, host]]), banned: new Set(), locked: false, round: null, roundCount: 0 };
    rooms.set(code, room);
    attach(ws, room, host);
    log(`room ${code} created by ${host.name}`);
  },

  join(ws, msg) {
    const code = String(msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', text: `There is no game with the code ${code || '(blank)'}. Check it with your host.` });

    // Coming back after a refresh or dropped connection
    if (msg.token) {
      const existing = [...room.players.values()].find((p) => p.token === msg.token);
      if (existing) { attach(ws, room, existing); broadcastState(room); return; }
      if (room.banned.has(msg.token)) return send(ws, { type: 'error', text: 'The host removed you from this game.' });
    }
    if (room.locked) return send(ws, { type: 'error', text: 'This game is locked. Ask the host to unlock it.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', text: `This game is full (${MAX_PLAYERS} players).` });

    const player = { id: newId(), token: newToken(), name: cleanName(msg.name), score: 0, ws: null, lastSubmit: 0 };
    room.players.set(player.id, player);
    attach(ws, room, player);
    notice(room, `${player.name} joined.`);
    broadcastState(room);
  },

  start(ws, _msg, room, me) {
    if (me.id !== room.hostId) return;
    if (room.round && (room.round.status === 'countdown' || room.round.status === 'playing')) return;
    const { hand, solution } = dealHand();
    room.roundCount += 1;
    room.round = { n: room.roundCount, status: 'countdown', hand, solution, startsAt: Date.now() + COUNTDOWN_MS };
    const round = room.round;
    broadcastState(room);
    room.countdownTimer = setTimeout(() => {
      if (room.round !== round || round.status !== 'countdown') return;
      round.status = 'playing';
      round.startsAt = Date.now();
      broadcastState(room);
    }, COUNTDOWN_MS);
  },

  skip(ws, _msg, room, me) {
    if (me.id !== room.hostId || !room.round) return;
    if (room.round.status !== 'playing' && room.round.status !== 'countdown') return;
    clearTimeout(room.countdownTimer);
    room.round.status = 'skipped';
    broadcastState(room);
  },

  submit(ws, msg, room, me) {
    const r = room.round;
    const now = Date.now();
    if (!r || r.status !== 'playing') return send(ws, { type: 'verdict', ok: false, reason: 'This round is over.' });
    if (now - me.lastSubmit < SUBMIT_COOLDOWN_MS) return;
    me.lastSubmit = now;
    const result = checkExpression(msg.expr, r.hand);
    if (!result.ok) return send(ws, { type: 'verdict', ok: false, reason: result.reason });
    // Node handles messages one at a time, so the first valid answer here is the winner.
    r.status = 'won';
    r.winnerId = me.id;
    r.winningExpr = stripOuter(String(msg.expr).replace(/\*/g, '×').replace(/\//g, '÷'));
    r.timeMs = now - r.startsAt;
    me.score += 1;
    broadcastState(room);
  },

  kick(ws, msg, room, me) {
    if (me.id !== room.hostId || msg.playerId === room.hostId) return;
    const target = room.players.get(msg.playerId);
    if (!target) return;
    room.banned.add(target.token);
    send(target.ws, { type: 'kicked' });
    const tws = target.ws;
    removePlayer(room, target, 'was removed by the host');
    if (tws) tws.close();
  },

  lock(ws, msg, room, me) {
    if (me.id !== room.hostId) return;
    room.locked = !!msg.locked;
    broadcastState(room);
  },

  resetScores(ws, _msg, room, me) {
    if (me.id !== room.hostId) return;
    for (const p of room.players.values()) p.score = 0;
    notice(room, 'The host reset the scores.');
    broadcastState(room);
  },

  leave(ws, _msg, room, me) {
    if (me.id === room.hostId) return closeRoom(room, 'The host ended the game.');
    removePlayer(room, me, 'left the game');
    ws.close();
  },
};

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket plumbing                                           */
/* ------------------------------------------------------------------ */

const PAGE = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(PAGE, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

wss.on('connection', (ws) => {
  ws.meta = {};
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'hello', hostKeyRequired: !!HOST_KEY });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const handler = Object.prototype.hasOwnProperty.call(handlers, msg.type) && handlers[msg.type];
    if (!handler) return;

    if (msg.type === 'create' || msg.type === 'join') {
      if (ws.meta.code) return send(ws, { type: 'error', text: 'You are already in a game.' });
      return handler(ws, msg);
    }
    const room = rooms.get(ws.meta.code);
    const me = room && room.players.get(ws.meta.playerId);
    if (!room || !me || me.ws !== ws) return send(ws, { type: 'error', text: 'You are not in a game.' });
    handler(ws, msg, room, me);
  });

  ws.on('close', () => onDisconnect(ws));
});

// Drop dead connections so "connected" dots stay honest
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

function log(...a) { console.log(new Date().toISOString(), ...a); }

if (require.main === module) {
  server.listen(PORT, () => log(`24 versus running on http://localhost:${PORT}${HOST_KEY ? ' (host key required)' : ''}`));
}

module.exports = { solve, checkExpression, dealHand, server };
