'use strict';
const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const PORT       = process.env.PORT || 3000;
const ADMIN      = process.env.ADMIN_USER || 'ecc_official';
const STATE_FILE = path.join(__dirname, 'state.json');

// ── Persistent state ──────────────────────────────────────────────────────
let db = { users: {}, games: {} };
try { db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

// In-memory sessions: token → username
const sessions = new Map();

function persist() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(db));
}

function getUser(u) {
  if (!db.users[u]) db.users[u] = { balance: 0 };
  return db.users[u];
}

function recalcMid(c) {
  const bb = c.bids.length ? Math.max(...c.bids.map(b => b.price)) : null;
  const ba = c.asks.length ? Math.min(...c.asks.map(a => a.price)) : null;
  if (bb != null && ba != null) c.mid = Math.round((bb + ba) / 2);
  else if (bb != null) c.mid = bb;
  else if (ba != null) c.mid = ba;
}

// ── Server setup ──────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'atomic.html')));

// ── WebSocket ─────────────────────────────────────────────────────────────
const gameSubs = new Map(); // gameId → Set<ws>

function wsSubscribe(ws, gameId) {
  if (ws._gameId) gameSubs.get(ws._gameId)?.delete(ws);
  ws._gameId = gameId;
  if (!gameSubs.has(gameId)) gameSubs.set(gameId, new Set());
  gameSubs.get(gameId).add(ws);
}

function broadcast(gameId) {
  const subs = gameSubs.get(gameId);
  if (!subs?.size) return;
  const game = db.games[gameId];
  if (!game) return;
  const msg = JSON.stringify({ type: 'state', game, users: db.users });
  subs.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.gameId) {
        wsSubscribe(ws, msg.gameId);
        const game = db.games[msg.gameId];
        if (game) ws.send(JSON.stringify({ type: 'state', game, users: db.users }));
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    if (ws._gameId) gameSubs.get(ws._gameId)?.delete(ws);
  });
});

// ── Auth middleware ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-session'];
  const username = sessions.get(token);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  req.username = username;
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────

// Exchange Lichess access token for a server session
app.post('/api/login', async (req, res) => {
  const { lichessToken } = req.body;
  if (!lichessToken) return res.status(400).json({ error: 'lichessToken required' });
  try {
    const r = await fetch('https://lichess.org/api/account', {
      headers: { Authorization: `Bearer ${lichessToken}` },
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid Lichess token' });
    const me = await r.json();
    const username = (me.id || me.username).toLowerCase();
    const user = getUser(username);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, username);
    persist();
    res.json({ token, username, balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Lichess' });
  }
});

// Fetch a user's balance
app.get('/api/balance/:username', auth, (req, res) => {
  const user = db.users[req.params.username];
  res.json({ balance: user?.balance ?? 0 });
});

// Get or initialize a game
app.post('/api/game/init', auth, (req, res) => {
  const { gameId, mids } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  if (!db.games[gameId]) {
    db.games[gameId] = {
      contracts: {
        white: { name: 'White wins', mid: mids?.white ?? 50, bids: [], asks: [] },
        draw:  { name: 'Draw',       mid: mids?.draw  ?? 10, bids: [], asks: [] },
        black: { name: 'Black wins', mid: mids?.black ?? 50, bids: [], asks: [] },
      },
      trades: [],
    };
    persist();
  }
  res.json(db.games[gameId]);
});

// Place an order
app.post('/api/order', auth, (req, res) => {
  const { gameId, side, contract: ck, price, shares } = req.body;
  const username = req.username;

  if (!['buy', 'sell'].includes(side) || !['white', 'draw', 'black'].includes(ck) ||
      price < 1 || price > 99 || shares < 1) {
    return res.status(400).json({ error: 'Invalid params' });
  }

  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const user = getUser(username);
  const c    = game.contracts[ck];
  let filled = 0;

  if (side === 'buy') {
    const cost = price * shares;
    if (cost > user.balance) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= cost; // lock full cost upfront

    const matchable = c.asks.filter(a => a.price <= price).sort((a, b) => a.price - b.price);
    let rem = shares;
    for (const ask of matchable) {
      if (rem <= 0) break;
      const f = Math.min(rem, ask.size);
      user.balance += (price - ask.price) * f; // refund overpay vs limit
      rem -= f; ask.size -= f; filled += f;
      if (f > 0) {
        const seller = db.users[ask.user];
        if (seller) seller.balance += ask.price * f;
        game.trades.unshift({ contract: c.name, price: ask.price, size: f, time: Date.now(), dir: 'up' });
      }
    }
    c.asks = c.asks.filter(a => a.size > 0);
    if (rem > 0) c.bids.push({ id: crypto.randomBytes(8).toString('hex'), price, size: rem, user: username });

  } else {
    const matchable = c.bids.filter(b => b.price >= price).sort((a, b) => b.price - a.price);
    let rem = shares;
    for (const bid of matchable) {
      if (rem <= 0) break;
      const f = Math.min(rem, bid.size);
      user.balance += bid.price * f; // seller receives at bid price
      rem -= f; bid.size -= f; filled += f;
      if (f > 0) {
        game.trades.unshift({ contract: c.name, price: bid.price, size: f, time: Date.now(), dir: 'dn' });
      }
    }
    c.bids = c.bids.filter(b => b.size > 0);
    if (rem > 0) c.asks.push({ id: crypto.randomBytes(8).toString('hex'), price, size: rem, user: username });
  }

  if (game.trades.length > 50) game.trades.length = 50;
  recalcMid(c);
  persist();
  broadcast(gameId);
  res.json({ ok: true, balance: user.balance, filled });
});

// Cancel an order
app.post('/api/cancel', auth, (req, res) => {
  const { gameId, contract: ck, orderId, side } = req.body;
  const username = req.username;

  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const c    = game.contracts[ck];
  const user = getUser(username);

  if (side === 'buy') {
    const order = c.bids.find(b => b.id === orderId && b.user === username);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    user.balance += order.price * order.size; // refund locked cost
    c.bids = c.bids.filter(b => b.id !== orderId);
  } else {
    const order = c.asks.find(a => a.id === orderId && a.user === username);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    c.asks = c.asks.filter(a => a.id !== orderId);
  }

  persist();
  broadcast(gameId);
  res.json({ ok: true, balance: user.balance });
});

// Admin: add pawns to a user
app.post('/api/admin/pawns', auth, (req, res) => {
  if (req.username !== ADMIN) return res.status(403).json({ error: 'Forbidden' });
  const { target, amount } = req.body;
  if (!target || amount <= 0) return res.status(400).json({ error: 'Invalid params' });
  const user = getUser(target);
  user.balance += amount;
  persist();
  const msg = JSON.stringify({ type: 'balance', username: target, balance: user.balance });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, balance: user.balance });
});

server.listen(PORT, () => console.log(`AtomicMarket running on :${PORT}`));
