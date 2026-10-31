const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();            // roomName -> Set<client>
let nextId = 1;
const MAX_PER_ROOM = 16;

function clearHooks(c) {
  if (!c.room) return;
  for (const o of c.room) {
    if (c.hooking === o.id && o.hookedBy === c.id) { o.hookedBy = null; send(o, { t: 'freed' }); }
    if (c.hookedBy === o.id && o.hooking === c.id) { o.hooking = null; send(o, { t: 'cut' }); }
  }
  c.hooking = null; c.hookedBy = null;
}
function findIn(room, id) { for (const o of room) if (o.id === id) return o; return null; }
function send(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function broadcast(room, o, except) { for (const c of room) if (c !== except) send(c, o); }

wss.on('connection', (ws) => {
  const c = { ws, id: 'u' + (nextId++), room: null, name: '玩家', hp: 100, dead: false, x: 0, y: 0, z: 0, last80: 0, last10: 0 };
  ws.on('message', (raw) => {
    if (raw.length > 2048) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !c.room) {
      const name = String(m.room || '');
      if (!/^[a-z0-9-]{1,32}$/.test(name)) return;
      let room = rooms.get(name);
      if (!room) { room = new Set(); rooms.set(name, room); }
      if (room.size >= MAX_PER_ROOM) { ws.close(); return; }
      c.room = room; c.roomName = name; c.name = String(m.name || '玩家').slice(0, 10);
      room.add(c);
      send(c, { t: 'you', id: c.id });
      broadcast(room, { t: 'n', n: room.size }); send(c, { t: 'n', n: room.size });
      return;
    }
    if (!c.room) return;
    if (m.t === 'p') {
      if (![m.x, m.y, m.z, m.yaw].every(Number.isFinite)) return;
      c.x = m.x; c.y = m.y; c.z = m.z; c.iv = !!m.iv;
      const q = Array.isArray(m.q) && m.q.length <= 64 && m.q.every(Number.isFinite) ? m.q : null;
      const cu = Array.isArray(m.c) && m.c.length === 3 && /^#[0-9a-fA-F]{6}$/.test(m.c[0]) && /^#[0-9a-fA-F]{6}$/.test(m.c[1]) && /^[a-z]{1,12}$/.test(m.c[2]) ? m.c : null;
      const gr = Array.isArray(m.g) && m.g.length === 10 && m.g.every(Number.isFinite) ? m.g : null;
      broadcast(c.room, { t: 'p', id: c.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, n: c.name, hp: c.hp, q, c: cu, g: gr, iv: c.iv ? 1 : 0 }, c);
    } else if (m.t === 'fx') {
      const now = Date.now();
      if (now - (c.lastFx || 0) < 30) return;
      if (!Array.isArray(m.e) || m.e.length > 40) return;
      for (const e of m.e) if (!Array.isArray(e) || e.length > 8 || typeof e[0] !== 'string' || !e.slice(1).every(Number.isFinite)) return;
      c.lastFx = now;
      broadcast(c.room, { t: 'fx', id: c.id, e: m.e }, c);
    } else if (m.t === 'hook') {
      const target = findIn(c.room, m.to), now = Date.now();
      const ok = target && target !== c && !c.dead && !target.dead && !c.hooking && !target.hookedBy && now > (target.immune || 0) && now - (c.lastHook || 0) > 400 && Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z) <= 140;
      if (!ok) { send(c, { t: 'cut' }); return; }
      c.hooking = target.id; target.hookedBy = c.id; c.lastHook = now;
      send(target, { t: 'hooked', by: c.id });
    } else if (m.t === 'unhook') {
      if (c.hooking) { const t = findIn(c.room, c.hooking); if (t && t.hookedBy === c.id) { t.hookedBy = null; send(t, { t: 'freed' }); } c.hooking = null; }
    } else if (m.t === 'escape') {
      if (c.hookedBy) {
        const hk = findIn(c.room, c.hookedBy);
        c.hookedBy = null; c.immune = Date.now() + 2500;
        if (hk && hk.hooking === c.id) { hk.hooking = null; send(hk, { t: 'cut' }); }
      }
    } else if (m.t === 'hit') {
      // server-authoritative damage: blade 80 (range 15, 0.5s cooldown), bullet 10 (50ms cooldown)
      const dmg = m.d === 80 ? 80 : m.d === 10 ? 10 : 0;
      if (!dmg || c.dead) return;
      let target = null;
      for (const o of c.room) if (o.id === m.to) target = o;
      if (!target || target === c || target.dead || target.iv) return;   // dodging (invulnerable) targets can't be hit
      const now = Date.now();
      const dist = Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z);
      if (dmg === 80) { if (now - c.last80 < 500 || dist > 15) return; c.last80 = now; }
      else { if (now - c.last10 < 50 || dist > 150) return; c.last10 = now; }
      target.hp = Math.max(0, target.hp - dmg);
      send(target, { t: 'hp', hp: target.hp });
      if (target.hp <= 0) {
        target.dead = true; clearHooks(target);
        broadcast(c.room, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        send(c, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        setTimeout(() => { target.hp = 100; target.dead = false; send(target, { t: 'hp', hp: 100 }); }, 1500);
      }
    }
  });
  ws.on('close', () => {
    if (!c.room) return;
    clearHooks(c);
    c.room.delete(c);
    if (c.room.size === 0) rooms.delete(c.roomName);
    else { broadcast(c.room, { t: 'left', id: c.id }); broadcast(c.room, { t: 'n', n: c.room.size }); }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
