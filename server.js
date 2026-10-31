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
      c.x = m.x; c.y = m.y; c.z = m.z;
      broadcast(c.room, { t: 'p', id: c.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, w: m.w === 'airgun' ? 'airgun' : 'blades', n: c.name, hp: c.hp }, c);
    } else if (m.t === 'hit') {
      // server-authoritative damage: blade 80 (close range, 0.5s cooldown), bullet 10 (50ms cooldown)
      const dmg = m.d === 80 ? 80 : m.d === 10 ? 10 : 0;
      if (!dmg || c.dead) return;
      let target = null;
      for (const o of c.room) if (o.id === m.to) target = o;
      if (!target || target === c || target.dead) return;
      const now = Date.now();
      const dist = Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z);
      if (dmg === 80) { if (now - c.last80 < 500 || dist > 9) return; c.last80 = now; }
      else { if (now - c.last10 < 50 || dist > 150) return; c.last10 = now; }
      target.hp = Math.max(0, target.hp - dmg);
      send(target, { t: 'hp', hp: target.hp });
      if (target.hp <= 0) {
        target.dead = true;
        broadcast(c.room, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        send(c, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        setTimeout(() => { target.hp = 100; target.dead = false; send(target, { t: 'hp', hp: 100 }); }, 1500);
      }
    }
  });
  ws.on('close', () => {
    if (!c.room) return;
    c.room.delete(c);
    if (c.room.size === 0) rooms.delete(c.roomName);
    else { broadcast(c.room, { t: 'left', id: c.id }); broadcast(c.room, { t: 'n', n: c.room.size }); }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
