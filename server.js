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
const roomStates = new Map();       // roomName -> { waveIndex, nextNpcId, waveTimer, npcs: Map<id, {hp, sh}> }
let nextId = 1;
const MAX_PER_ROOM = 16;
const WAVE_INTERVAL_MS = 300 * 1000; // 每 5 分鐘 (300秒) 空投一波

function send(c, o) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o));
}

function broadcast(room, o, except) {
  for (const c of room) if (c !== except) send(c, o);
}

function broadcastAll(room, o) {
  for (const c of room) send(c, o);
}

function findIn(room, id) {
  for (const o of room) if (o.id === id) return o;
  return null;
}

function getRoomHost(room) {
  for (const c of room) return c;
  return null;
}

function clearHooks(c) {
  if (!c.room) return;
  for (const o of c.room) {
    if (c.hooking === o.id && o.hookedBy === c.id) { o.hookedBy = null; send(o, { t: 'freed' }); }
    if (c.hookedBy === o.id && o.hooking === c.id) { o.hooking = null; send(o, { t: 'cut' }); }
  }
  c.hooking = null;
  c.hookedBy = null;
}

// 與前端完全一致的迷宮建築格點雜湊判定，確保伺服器端空投點選在開放街道
function hash2(gx, gz, salt) {
  let n = Math.imul(gx, 374761393) ^ Math.imul(gz, 668265263) ^ Math.imul(salt || 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function isMazeWall(gx, gz) {
  if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1 && (gx === 0 || gz === 0)) return false;
  const ax = Math.abs(gx) & 1, az = Math.abs(gz) & 1;
  if (ax === 0 && az === 0) return false;
  if (ax === 1 && az === 1) return true;
  if (ax === 1 && az === 0) {
    const ix = (gx - 1) >> 1, iz = gz >> 1;
    return !(hash2(ix, iz, 11) < 0.52 || hash2(ix, iz, 23) < 0.38);
  } else {
    const ix2 = gx >> 1, iz2 = (gz - 1) >> 1;
    return !(!(hash2(ix2, iz2, 11) < 0.52) || hash2(ix2, iz2, 29) < 0.38);
  }
}

function pickDropZoneNear(px, pz) {
  const CELL = 24, MAX_R = 200;
  for (let i = 0; i < 40; i++) {
    const r = 32 + Math.sqrt(Math.random()) * (MAX_R - 32);
    const ang = Math.random() * Math.PI * 2;
    const tx = px + Math.cos(ang) * r;
    const tz = pz + Math.sin(ang) * r;
    const gx = Math.round(tx / CELL), gz = Math.round(tz / CELL);
    if (!isMazeWall(gx, gz)) {
      const wx = gx * CELL, wz = gz * CELL;
      if (Math.hypot(wx - px, wz - pz) <= MAX_R) return { x: wx, z: wz };
    }
  }
  const fgx = Math.round(px / CELL / 2) * 2 + 2;
  const fgz = Math.round(pz / CELL / 2) * 2;
  return { x: fgx * CELL, z: fgz * CELL };
}

function triggerRoomWave(roomName) {
  const room = rooms.get(roomName);
  const st = roomStates.get(roomName);
  if (!room || !st || room.size === 0) return;

  // 以房間內隨機一名存活玩家的平面座標為基準，在半徑 200 米內隨機空投
  const alive = [...room].filter(c => !c.dead);
  const ref = alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : getRoomHost(room);
  const drop = pickDropZoneNear(ref ? ref.x : 0, ref ? ref.z : 0);

  st.waveIndex += 1;
  const count = 2 + (st.waveIndex - 1); // 初始 2 人，每次進攻新增 1 人
  const baseId = st.nextNpcId;
  st.nextNpcId += count;
  st.lastWaveAt = Date.now();

  for (let i = 0; i < count; i++) {
    const id = baseId + i;
    st.npcs.set(id, { id, hp: 100, sh: 100 });
  }

  const flyAng = Math.round(Math.random() * Math.PI * 2 * 1000) / 1000;
  broadcastAll(room, {
    t: 'wave',
    w: st.waveIndex,
    cnt: count,
    baseId,
    dx: drop.x,
    dz: drop.z,
    ang: flyAng
  });
}

function ensureRoomState(roomName) {
  let st = roomStates.get(roomName);
  if (!st) {
    st = {
      waveIndex: 0,
      nextNpcId: 1,
      lastWaveAt: Date.now(),
      lastManualWave: 0,
      npcs: new Map(),
      waveTimer: setInterval(() => triggerRoomWave(roomName), WAVE_INTERVAL_MS)
    };
    roomStates.set(roomName, st);
  }
  return st;
}

function cleanupRoomState(roomName) {
  const st = roomStates.get(roomName);
  if (st) {
    clearInterval(st.waveTimer);
    roomStates.delete(roomName);
  }
}

wss.on('connection', (ws) => {
  const c = {
    ws,
    id: 'u' + (nextId++),
    room: null,
    roomName: '',
    name: '玩家',
    hp: 100,
    dead: false,
    x: 0, y: 0, z: 0,
    last80: 0, last10: 0, lastNpcHit: 0
  };

  ws.on('message', (raw) => {
    if (raw.length > 4096) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join' && !c.room) {
      const name = String(m.room || '');
      if (!/^[a-z0-9-]{1,32}$/.test(name)) return;
      let room = rooms.get(name);
      if (!room) { room = new Set(); rooms.set(name, room); }
      if (room.size >= MAX_PER_ROOM) { ws.close(); return; }
      c.room = room;
      c.roomName = name;
      c.name = String(m.name || '玩家').slice(0, 10);
      room.add(c);

      const st = ensureRoomState(name);
      const host = getRoomHost(room);
      const nextIn = Math.max(0, Math.round((WAVE_INTERVAL_MS - (Date.now() - st.lastWaveAt)) / 1000));
      send(c, { t: 'you', id: c.id, host: host ? host.id : c.id, w: st.waveIndex, next: nextIn });
      broadcast(room, { t: 'n', n: room.size, host: host ? host.id : c.id });
      send(c, { t: 'n', n: room.size, host: host ? host.id : c.id });

      // 房間首名玩家進入時，立即觸發第 1 波軍用運輸機空投 (初始 2 人)
      if (st.waveIndex === 0) {
        triggerRoomWave(name);
      }
      return;
    }

    if (!c.room) return;
    const st = roomStates.get(c.roomName);

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
      if (c.hooking) {
        const t = findIn(c.room, c.hooking);
        if (t && t.hookedBy === c.id) { t.hookedBy = null; send(t, { t: 'freed' }); }
        c.hooking = null;
      }
    } else if (m.t === 'escape') {
      if (c.hookedBy) {
        const hk = findIn(c.room, c.hookedBy);
        c.hookedBy = null; c.immune = Date.now() + 2500;
        if (hk && hk.hooking === c.id) { hk.hooking = null; send(hk, { t: 'cut' }); }
      }
    } else if (m.t === 'hit') {
      // PvP 玩家互擊判定：鋼刃 80 傷害、氣槍 10 傷害
      const dmg = m.d === 80 ? 80 : m.d === 10 ? 10 : 0;
      if (!dmg || c.dead) return;
      const target = findIn(c.room, m.to);
      if (!target || target === c || target.dead || target.iv) return;
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
    } else if (m.t === 'wave_req') {
      // 玩家手動呼叫下一波軍用運輸機空投（節流保護 3 秒）
      if (!st) return;
      const now = Date.now();
      if (now - st.lastManualWave < 3000) return;
      st.lastManualWave = now;
      clearInterval(st.waveTimer);
      triggerRoomWave(c.roomName);
      st.waveTimer = setInterval(() => triggerRoomWave(c.roomName), WAVE_INTERVAL_MS);
    } else if (m.t === 'npc_hit') {
      // 玩家攻擊 0級NPC敵人：同步防爆盾耐久 (100點) 與 NPC 血量 (100點)
      if (!st || c.dead) return;
      const npcId = Number(m.id);
      if (!Number.isFinite(npcId)) return;
      let npc = st.npcs.get(npcId);
      if (!npc) {
        npc = { id: npcId, hp: 100, sh: 100 };
        st.npcs.set(npcId, npc);
      }
      const shDmg = m.sh === 10 ? 10 : 0;
      const hpDmg = m.d === 80 ? 80 : m.d === 10 ? 10 : 0;
      if (shDmg > 0 && npc.sh > 0) {
        npc.sh = Math.max(0, npc.sh - shDmg);
      }
      if (hpDmg > 0 && npc.hp > 0) {
        npc.hp = Math.max(0, npc.hp - hpDmg);
      }
      broadcastAll(c.room, {
        t: 'npc_dmg',
        id: npcId,
        hp: npc.hp,
        sh: npc.sh,
        by: c.id,
        bn: c.name
      });
      if (npc.hp <= 0) {
        st.npcs.delete(npcId);
      }
    } else if (m.t === 'npc_spot') {
      // 任一 NPC 目擊玩家時，全房同步 2 秒追蹤座標
      if (![m.x, m.y, m.z].every(Number.isFinite)) return;
      broadcast(c.room, { t: 'npc_spot', x: m.x, y: m.y, z: m.z }, c);
    } else if (m.t === 'npc_me') {
      // 玩家受到 0級NPC 警棍 (15傷害+1秒眩暈) 或 手槍 (12傷害) 命中
      if (c.dead || c.iv) return;
      const now = Date.now();
      if (now - c.lastNpcHit < 120) return;
      c.lastNpcHit = now;
      const dmg = m.d === 15 ? 15 : m.d === 12 ? 12 : 0;
      if (!dmg) return;
      c.hp = Math.max(0, c.hp - dmg);
      send(c, { t: 'hp', hp: c.hp });
      if (c.hp <= 0) {
        c.dead = true;
        clearHooks(c);
        const killerName = String(m.bn || '0級敵兵').slice(0, 12);
        broadcastAll(c.room, { t: 'kill', by: 'npc', bn: killerName, to: c.id, n: c.name });
        setTimeout(() => { c.hp = 100; c.dead = false; send(c, { t: 'hp', hp: 100 }); }, 1500);
      }
    } else if (m.t === 'npc_sync') {
      // 房主同步 NPC 座標、動作與武器狀態給同房其他玩家
      const host = getRoomHost(c.room);
      if (host !== c || !Array.isArray(m.list) || m.list.length > 48) return;
      broadcast(c.room, { t: 'npc_sync', list: m.list }, c);
    } else if (m.t === 'npc_shot') {
      // 同步 NPC 手槍射擊子彈軌跡給同房玩家
      if (![m.x, m.y, m.z, m.vx, m.vy, m.vz].every(Number.isFinite)) return;
      broadcast(c.room, { t: 'npc_shot', x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz }, c);
    }
  });

  ws.on('close', () => {
    if (!c.room) return;
    clearHooks(c);
    c.room.delete(c);
    if (c.room.size === 0) {
      rooms.delete(c.roomName);
      cleanupRoomState(c.roomName);
    } else {
      const host = getRoomHost(c.room);
      broadcast(c.room, { t: 'left', id: c.id, host: host ? host.id : '' });
      broadcast(c.room, { t: 'n', n: c.room.size, host: host ? host.id : '' });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));