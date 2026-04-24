'use strict';
const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const PORT        = process.env.PORT || 3000;
const ADMINS      = new Set(['ecc_official', 'scenry1', 'seaside_tiramisu', ...(process.env.ADMIN_USERS || '').split(',').filter(Boolean)]);
const STATE_FILE  = path.join(__dirname, 'state.json');
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function isAdmin(u) { return ADMINS.has(u); }

// ── Redis helpers (Upstash REST API) ──────────────────────────────────────
async function redisLoad() {
  if (!REDIS_URL) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', 'atomicmarket_state']),
    });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  } catch(_) { return null; }
}

function redisSave(data) {
  if (!REDIS_URL) return;
  fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', 'atomicmarket_state', JSON.stringify(data)]),
  }).catch(() => {});
}

// ── Persistent state ──────────────────────────────────────────────────────
let db = { users: {}, games: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
if (!db.sessions) db.sessions = {};

const sessions = new Map(Object.entries(db.sessions));

function persist() {
  db.sessions = Object.fromEntries(sessions);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch(_) {}
  redisSave(db);
}

function getUser(u) {
  if (!db.users[u]) db.users[u] = { balance: 0, transactions: [], totalDeposited: 0 };
  if (!db.users[u].transactions)  db.users[u].transactions = [];
  if (db.users[u].totalDeposited == null) db.users[u].totalDeposited = 0;
  if (db.users[u].balance == null) db.users[u].balance = 0;
  if (!db.users[u].shares) db.users[u].shares = {};
  return db.users[u];
}

// shares ledger: user.shares["gameId:ck"] = net shares held
function skey(gameId, ck) { return `${gameId}:${ck}`; }
function addShares(username, gameId, ck, delta) {
  const u = getUser(username);
  const k = skey(gameId, ck);
  u.shares[k] = (u.shares[k] || 0) + delta;
}
function availableShares(username, gameId, ck, openAsks) {
  const u = db.users[username];
  const held = (u?.shares?.[skey(gameId, ck)]) || 0;
  const committed = openAsks.filter(a => a.user === username).reduce((s, a) => s + a.size, 0);
  return held - committed;
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

// Serve the SPA for all frontend routes
const html = path.join(__dirname, 'atomic.html');
app.get('/',           (_, res) => res.sendFile(html));
app.get('/profile',    (_, res) => res.sendFile(html));
app.get('/game/:id',   (_, res) => res.sendFile(html));

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
    res.json({ token, username, balance: user.balance, isAdmin: isAdmin(username) });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Lichess' });
  }
});

app.get('/api/balance/:username', auth, (req, res) => {
  const user = db.users[req.params.username];
  res.json({ balance: user?.balance ?? 0, isAdmin: isAdmin(req.params.username) });
});

app.get('/api/profile', auth, (req, res) => {
  const p = buildProfile(req.username);
  res.json(p);
});

app.get('/api/myorders', auth, (req, res) => {
  res.json({ orders: buildProfile(req.username).orders });
});

app.post('/api/game/settle', auth, (req, res) => {
  const { gameId, winner } = req.body;
  if (!['white', 'draw', 'black'].includes(winner))
    return res.status(400).json({ error: 'Invalid winner' });
  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.resolved) return res.json({ ok: true, alreadyResolved: true, ...game.resolved });

  game.resolved = { winner, at: Date.now() };

  // Settle the winning contract: pay longs 100/share, collect 100/share from shorts
  const winningContract = game.contracts[winner];
  const payouts = {};
  const losses  = {};
  for (const [username, user] of Object.entries(db.users)) {
    const shares = user.shares?.[skey(gameId, winner)] || 0;
    if (shares > 0) {
      const payout = shares * 100;
      user.balance += payout;
      payouts[username] = payout;
      logTx(username, { type: 'settlement', gameId, contract: winner, contractName: winningContract.name, shares, payout });
    } else if (shares < 0) {
      // Short sellers received cash at fill; they owe 100/share to cover longs
      const owed     = Math.abs(shares) * 100;
      const deducted = Math.min(owed, user.balance);
      user.balance  -= deducted;
      losses[username] = deducted;
      logTx(username, { type: 'settlement_loss', gameId, contract: winner, contractName: winningContract.name, shares: Math.abs(shares), owed, deducted });
    }
  }

  // Clear all share positions for this game (resolved, no longer tradeable)
  for (const user of Object.values(db.users)) {
    for (const ck of ['white', 'draw', 'black']) {
      if (user.shares) delete user.shares[skey(gameId, ck)];
    }
  }

  persist();
  broadcast(gameId);

  // Notify balance changes over WS for all affected users
  for (const uname of [...Object.keys(payouts), ...Object.keys(losses)]) {
    const msg = JSON.stringify({ type: 'balance', username: uname, balance: db.users[uname].balance });
    wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  }

  res.json({ ok: true, winner, winnerName: winningContract.name, payouts, losses });
});

app.post('/api/game/init', auth, (req, res) => {
  const { gameId, mids, players } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  if (!db.games[gameId]) {
    const wName = players?.white || 'White';
    const bName = players?.black || 'Black';
    db.games[gameId] = {
      players: players || {},
      contracts: {
        white: { name: `${wName} wins`, mid: mids?.white ?? 50, bids: [], asks: [] },
        draw:  { name: 'Draw',          mid: mids?.draw  ?? 10, bids: [], asks: [] },
        black: { name: `${bName} wins`, mid: mids?.black ?? 50, bids: [], asks: [] },
      },
      trades: [],
    };
    persist();
  }
  res.json(db.games[gameId]);
});

app.post('/api/order', auth, (req, res) => {
  const { gameId, side, contract: ck, price, shares, intent } = req.body;
  const username = req.username;

  if (!['buy', 'sell'].includes(side) || !['white', 'draw', 'black'].includes(ck) ||
      price < 1 || price > 99 || shares < 1) {
    return res.status(400).json({ error: 'Invalid params' });
  }

  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.resolved) return res.status(400).json({ error: 'This market has already resolved' });

  const gamePlayers = Object.values(game.players || {}).map(p => p.toLowerCase());
  if (gamePlayers.includes(username)) {
    return res.status(403).json({ error: 'You cannot bet on your own game' });
  }

  const user = getUser(username);
  const c    = game.contracts[ck];
  let filled = 0;

  if (side === 'buy') {
    const cost = price * shares;
    if (cost > user.balance) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= cost;

    const matchable = c.asks.filter(a => a.price <= price && a.user !== username).sort((a, b) => a.price - b.price);
    let rem = shares;
    for (const ask of matchable) {
      if (rem <= 0) break;
      const f = Math.min(rem, ask.size);
      user.balance += (price - ask.price) * f;
      rem -= f; ask.size -= f; filled += f;
      if (f > 0) {
        const seller = getUser(ask.user);
        seller.balance += ask.price * f;
        addShares(username,  gameId, ck, +f);
        addShares(ask.user,  gameId, ck, -f);
        game.trades.unshift({ contract: c.name, price: ask.price, size: f, time: Date.now(), dir: 'up' });
        logTx(username, { type: 'fill', side: 'buy',  contract: ck, contractName: c.name, price: ask.price, shares: f, spent: ask.price * f });
        logTx(ask.user, { type: 'fill', side: 'sell', contract: ck, contractName: c.name, price: ask.price, shares: f, received: ask.price * f });
      }
    }
    c.asks = c.asks.filter(a => a.size > 0);
    if (rem > 0) c.bids.push({ id: crypto.randomBytes(8).toString('hex'), price, size: rem, user: username });

  } else {
    // Enforce share ownership for Sell YES; enforce collateral for Buy NO (opening a short)
    if (intent === 'sell') {
      const avail = availableShares(username, gameId, ck, c.asks);
      if (shares > avail) {
        return res.status(400).json({ error: `You only have ${Math.max(0, avail)} share${avail === 1 ? '' : 's'} to sell` });
      }
    } else {
      // Buy NO: user will owe 100/share if this contract wins — require (100-price)*shares as collateral
      const collateral = (100 - price) * shares;
      if (collateral > user.balance) {
        return res.status(400).json({ error: `Insufficient balance: need ${collateral} pawns as collateral` });
      }
    }

    const matchable = c.bids.filter(b => b.price >= price && b.user !== username).sort((a, b) => b.price - a.price);
    let rem = shares;
    for (const bid of matchable) {
      if (rem <= 0) break;
      const f = Math.min(rem, bid.size);
      user.balance += bid.price * f;
      rem -= f; bid.size -= f; filled += f;
      if (f > 0) {
        addShares(username, gameId, ck, -f);
        addShares(bid.user, gameId, ck, +f);
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

app.post('/api/admin/sync', auth, async (req, res) => {
  if (!isAdmin(req.username)) return res.status(403).json({ error: 'Forbidden' });
  // Re-read live in case module-load constants differ from current env
  const liveUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const liveToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!liveUrl) return res.status(400).json({
    error: 'Redis not configured',
    hint: 'UPSTASH_REDIS_REST_URL env var is missing on this server instance',
    envKeys: Object.keys(process.env).filter(k => k.includes('REDIS') || k.includes('UPSTASH')),
    urlLikeKeys: Object.keys(process.env).filter(k => k.includes('URL') || k.includes('TOKEN') || k.includes('KV')),
    allEnvCount: Object.keys(process.env).length,
  });
  // Write using live credentials
  try {
    db.sessions = Object.fromEntries(sessions);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch(_) {}
    await fetch(liveUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${liveToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', 'atomicmarket_state', JSON.stringify(db)]),
    });
    // Verify round-trip
    const check = await fetch(liveUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${liveToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', 'atomicmarket_state']),
    });
    const j = await check.json();
    res.json({ ok: true, users: Object.keys(db.users).length, redisVerified: !!j.result });
  } catch(e) {
    res.status(500).json({ error: 'Redis write failed: ' + e.message });
  }
});

app.post('/api/admin/pawns', auth, (req, res) => {
  if (!isAdmin(req.username)) return res.status(403).json({ error: 'Forbidden' });
  const { target, amount } = req.body;
  if (!target || amount == null || amount === 0) return res.status(400).json({ error: 'Invalid params' });
  const user = getUser(target);
  if (amount < 0 && user.balance + amount < 0) return res.status(400).json({ error: 'Cannot remove more than current balance' });
  user.balance += amount;
  if (amount > 0) {
    user.totalDeposited = (user.totalDeposited || 0) + amount;
    logTx(target, { type: 'admin_add', amount, by: req.username });
  } else {
    // Treat removal as withdrawal — reduces net deposited so P&L stays accurate
    user.totalDeposited = Math.max(0, (user.totalDeposited || 0) + amount);
    logTx(target, { type: 'withdrawal', amount: Math.abs(amount), by: req.username });
  }
  persist();
  const msg = JSON.stringify({ type: 'balance', username: target, balance: user.balance });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ ok: true, balance: user.balance });
});

function buildProfile(username) {
  const user = getUser(username);
  const txs  = user.transactions || [];
  let totalSpent = 0, totalReceived = 0;
  for (const tx of txs) {
    if (tx.type !== 'fill') continue;
    if (tx.side === 'buy')  totalSpent    += tx.spent    || 0;
    if (tx.side === 'sell') totalReceived += tx.received || 0;
  }

  // Current positions: live shares from ledger, unresolved games only
  const positions = {};
  for (const [key, shares] of Object.entries(user.shares || {})) {
    if (shares <= 0) continue;
    const [gameId, ck] = key.split(':');
    const game = db.games[gameId];
    if (!game || game.resolved) continue;
    const c = game.contracts[ck];
    const label = `${c?.name || ck} (${gameId.slice(0,8)})`;
    positions[label] = { shares, gameId, ck, contractName: c?.name };
  }
  const orders = [];
  for (const [gameId, game] of Object.entries(db.games)) {
    for (const [ck, c] of Object.entries(game.contracts)) {
      for (const b of c.bids.filter(b => b.user === username))
        orders.push({ gameId, contract: ck, contractName: c.name, side: 'buy',  price: b.price, size: b.size, id: b.id, locked: b.price * b.size });
      for (const a of c.asks.filter(a => a.user === username))
        orders.push({ gameId, contract: ck, contractName: c.name, side: 'sell', price: a.price, size: a.size, id: a.id, locked: 0 });
    }
  }
  return {
    username,
    balance: user.balance,
    totalDeposited: user.totalDeposited || 0,
    pnl: user.balance - (user.totalDeposited || 0),
    totalSpent, totalReceived,
    tradingPnl: totalReceived - totalSpent,
    positions, orders,
    transactions: txs.slice(0, 100),
    isAdmin: isAdmin(username),
  };
}

app.post('/api/admin/reset', auth, (req, res) => {
  if (!isAdmin(req.username)) return res.status(403).json({ error: 'Forbidden' });
  db.users = {};
  db.games = {};
  sessions.clear();
  db.sessions = {};
  persist();
  res.json({ ok: true });
});

app.get('/api/admin/user/:target', auth, (req, res) => {
  if (!isAdmin(req.username)) return res.status(403).json({ error: 'Forbidden' });
  const target = req.params.target.toLowerCase();
  if (!db.users[target]) return res.status(404).json({ error: 'User not found' });
  res.json(buildProfile(target));
});

async function init() {
  // On each deploy the local file is gone, so prefer Redis as source of truth
  const redisState = await redisLoad();
  if (redisState) {
    db = redisState;
    if (!db.sessions) db.sessions = {};
    if (!db.users)    db.users    = {};
    if (!db.games)    db.games    = {};
    // Repopulate sessions map from Redis data
    sessions.clear();
    for (const [k, v] of Object.entries(db.sessions)) sessions.set(k, v);
    // Write to local file as a warm cache
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch(_) {}
    console.log('State loaded from Redis');
  } else {
    console.log('No Redis state found, using local file — saving current state to Redis');
    redisSave(db);
  }
  server.listen(PORT, () => console.log(`AtomicMarket running on :${PORT}`));
}
init();
