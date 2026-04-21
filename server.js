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

const sessions = new Map();

function persist() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(db));
}

function getUser(u) {
  if (!db.users[u]) db.users[u] = { balance: 0, transactions: [], totalDeposited: 0 };
  if (!db.users[u].transactions) db.users[u].transactions = [];
  if (db.users[u].totalDeposited == null) db.users[u].totalDeposited = 0;
  return db.users[u];
}

function logTx(username, tx) {
  const user = getUser(username);
  user.transactions.unshift({ ...tx, time: Date.now() });
  if (user.transactions.length > 200) user.transactions.length = 200;
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'atomic.html')));
app.use(express.static(path.join(__dirname)));

// ── WebSocket ─────────────────────────────────────────────────────────────
const gameSubs = new Map();

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

app.get('/api/balance/:username', auth, (req, res) => {
  const user = db.users[req.params.username];
  res.json({ balance: user?.balance ?? 0 });
});

app.get('/api/profile', auth, (req, res) => {
  const user = getUser(req.username);
  res.json({
    username: req.username,
    balance: user.balance,
    totalDeposited: user.totalDeposited || 0,
    pnl: user.balance - (user.totalDeposited || 0),
    transactions: (user.transactions || []).slice(0, 100),
  });
});

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
    user.balance -= cost;

    const matchable = c.asks.filter(a => a.price <= price).sort((a, b) => a.price - b.price);
    let rem = shares;
    for (const ask of matchable) {
      if (rem <= 0) break;
      const f = Math.min(rem, ask.size);
      user.balance += (price - ask.price) * f;
      rem -= f; ask.size -= f; filled += f;
      if (f > 0) {
        const seller = getUser(ask.user);
        seller.balance += ask.price * f;
        game.trades.unshift({ contract: c.name, price: ask.price, size: f, time: Date.now(), dir: 'up' });
        logTx(username, { type: 'fill', side: 'buy', contract: ck, contractName: c.name, price: ask.price, shares: f, spent: ask.price * f });
        logTx(ask.user, { type: 'fill', side: 'sell', contract: ck, contractName: c.name, price: ask.price, shares: f, received: ask.price * f });
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
      user.balance += bid.price * f;
      rem -= f; bid.size -= f; filled += f;
      if (f > 0) {
        game.trades.unshift({ contract: c.name, price: bid.price, size: f, time: Date.now(), dir: 'dn' });
        logTx(username, { type: 'fill', side: 'sell', contract: ck, contractName: c.name, price: bid.price, shares: f, received: bid.price * f });
        logTx(bid.user,  { type: 'fill', side: 'buy',  contract: ck, contractName: c.name, price: bid.price, shares: f, spent: bid.price * f });
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
    user.balance += order.price * order.size;
    logTx(username, { type: 'cancel', side: 'buy', contract: ck, contractName: c.name, price: order.price, shares: order.size, refunded: order.price * order.size });
    c.bids = c.bids.filter(b => b.id !== orderId);
  } else {
    const order = c.asks.find(a => a.id === orderId && a.user === username);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    logTx(username, { type: 'cancel', side: 'sell', contract: ck, contractName: c.name, price: order.price, shares: order.size });
    c.asks = c.asks.filter(a => a.id !== orderId);
  }

  persist();
  broadcast(gameId);
  res.json({ ok: true, balance: user.balance });
});

// Admin: add or remove pawns (negative amount = remove)
app.post('/api/admin/pawns', auth, (req, res) => {
  if (req.username !== ADMIN) return res.status(403).json({ error: 'Forbidden' });
  const { target, amount } = req.body;
  if (!target || amount == null || amount === 0) return res.status(400).json({ error: 'Invalid params' });
  const user = getUser(target);
  if (amount < 0 && user.balance + amount < 0) return res.status(400).json({ error: 'Cannot remove more than current balance' });
  user.balance += amount;
  if (amount > 0) user.totalDeposited = (user.totalDeposited || 0) + amount;
  logTx(target, { type: amount > 0 ? 'admin_add' : 'admin_remove', amount: Math.abs(amount), by: ADMIN });
  persist();
  const msg = JSON.stringify({ type: 'balance', username: target, balance: user.balance });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, balance: user.balance });
});

server.listen(PORT, () => console.log(`AtomicMarket running on :${PORT}`));
