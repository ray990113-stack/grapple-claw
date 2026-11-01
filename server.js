const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// 首頁啟動時讀入記憶體並預先壓縮 (brotli / gzip)，之後每次請求不再讀硬碟、不再重複壓縮
let page = null;
function loadPage() {
  const raw = fs.readFileSync(path.join(__dirname, 'index.html'));
  page = {
    raw,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: zlib.gzipSync(raw, { level: 9 }),
    etag: '"' + crypto.createHash('md5').update(raw).digest('hex') + '"'
  };
}
try { loadPage(); } catch (e) { page = null; }

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  if (!page) { try { loadPage(); } catch (e) { res.writeHead(500); res.end('index.html not found'); return; } }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Vary': 'Accept-Encoding', 'ETag': page.etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === page.etag) { res.writeHead(304, h); res.end(); return; }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = page.raw;
  if (/\bbr\b/.test(ae)) { h['Content-Encoding'] = 'br'; body = page.br; }
  else if (/\bgzip\b/.test(ae)) { h['Content-Encoding'] = 'gzip'; body = page.gz; }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
});

const wss = new WebSocketServer({ server });
const rooms = new Map();            // roomName -> Set<client>
const roomStates = new Map();       // roomName -> { waveIndex, nextNpcId, waveTimer, npcs: Map<id, {hp, sh}> }
let nextId = 1;
let nextTeam = 1;
const MAX_TEAM = 4;
const TEAM_INVITE_RANGE = 40;
const MAX_PER_ROOM = 16;
const WAVE_INTERVAL_MS = 300 * 1000; // 每 5 分鐘 (300秒) 空投一波

function send(c, o) {
  if (c.ws.readyState === 1) c.ws.send(typeof o === 'string' ? o : JSON.stringify(o));
}

// 廣播時只序列化一次 (原本每位收件者都重複 JSON.stringify)
function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const c of room) if (c !== except) send(c, s);
}

function broadcastAll(room, o) {
  const s = JSON.stringify(o);
  for (const c of room) send(c, s);
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

// ---- 組隊 ----
function teamMembers(room, tid) {
  const a = [];
  for (const o of room) if (o.team === tid) a.push(o);
  return a;
}
function teamsPayload(room) {
  const m = {}, h = {}, nx = {}, cp = {}, rc = {};
  const st = roomStates.get(room.rname), now = Date.now();
  for (const o of room) {
    m[o.id] = o.team;
    if (!h[o.team]) h[o.team] = o.id;
    if (!(o.team in nx)) { const T = st && st.teams.get(o.team); nx[o.team] = T ? Math.max(0, Math.round((T.nextAt - now) / 1000)) : 0; cp[o.team] = T ? T.captain : null; rc[o.team] = T ? !!T.recruit : false; }
  }
  return { m, h, nx, cp, rc };
}
function broadcastTeams(room, extra) {
  const p = teamsPayload(room);
  broadcastAll(room, Object.assign({ t: 'teams', m: p.m, h: p.h, nx: p.nx, cp: p.cp, rc: p.rc }, extra || {}));
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

const FAR_SPLIT_DIST = 500;   // 隊友平面距離超過此值 → 敵人平均分配到各處

// 隊員依平面距離分群(距離 <= 500m 視為同一處)
function clusterMembers(list) {
  const groups = [], seen = new Set();
  for (const a of list) {
    if (seen.has(a)) continue;
    const grp = [a], stack = [a];
    seen.add(a);
    while (stack.length) {
      const cur = stack.pop();
      for (const b of list) {
        if (!seen.has(b) && Math.hypot(cur.x - b.x, cur.z - b.z) <= FAR_SPLIT_DIST) { seen.add(b); grp.push(b); stack.push(b); }
      }
    }
    groups.push(grp);
  }
  return groups;
}

// 隊員變動後：隊長離開則由隊內第一人接任；剩一人時關閉成員招募；無人則刪除該隊
function fixTeam(st, room, tid) {
  const T = st.teams.get(tid);
  if (!T) return;
  const mem = teamMembers(room, tid);
  if (!mem.length) { st.teams.delete(tid); return; }
  if (!mem.some(o => o.id === T.captain)) T.captain = mem[0].id;
  if (mem.length === 1) T.recruit = false;
}

// 一隊的一次空投：人數 = 全隊每人各自「下一波人數」相加(組隊不會變少)；每人下次增加量不變
function fireTeamWave(roomName, tid) {
  const room = rooms.get(roomName), st = roomStates.get(roomName);
  if (!room || !st) return;
  const T = st.teams.get(tid);
  const members = [...room].filter(o => o.team === tid);
  if (!T || !members.length) { st.teams.delete(tid); return; }
  let total = 0, wmax = 0;
  for (const o of members) { total += 2 + o.wn; o.wn += 1; wmax = Math.max(wmax, o.wn); }
  T.nextAt = Date.now() + WAVE_INTERVAL_MS;

  const alive = members.filter(o => !o.dead);
  const clusters = clusterMembers(alive.length ? alive : members);
  const k = clusters.length, base = Math.floor(total / k), rem = total % k;
  clusters.forEach((grp, idx) => {
    const cnt = base + (idx < rem ? 1 : 0);
    if (cnt <= 0) return;
    const ref = grp[Math.floor(Math.random() * grp.length)];
    const drop = pickDropZoneNear(ref.x, ref.z);
    const baseId = st.nextNpcId;
    st.nextNpcId += cnt;
    for (let i = 0; i < cnt; i++) st.npcs.set(baseId + i, { id: baseId + i, hp: 100, sh: 100, tid });
    const flyAng = Math.round(Math.random() * Math.PI * 2 * 1000) / 1000;
    broadcastAll(room, { t: 'wave', w: wmax, cnt, baseId, dx: drop.x, dz: drop.z, ang: flyAng, tid });
  });
  broadcastTeams(room);   // 同步新的倒數
}

function tickRoom(roomName) {
  const room = rooms.get(roomName), st = roomStates.get(roomName);
  if (!room || !st || room.size === 0) return;
  const now = Date.now();
  for (const [tid, T] of [...st.teams]) if (now >= T.nextAt) fireTeamWave(roomName, tid);
}

function ensureRoomState(roomName) {
  let st = roomStates.get(roomName);
  if (!st) {
    st = {
      anchor: Date.now(),          // 以房間第一位玩家進入的時間為基準
      nextNpcId: 1,
      npcs: new Map(),
      teams: new Map(),            // tid -> { nextAt, lastManual }
      waveTimer: setInterval(() => tickRoom(roomName), 1000)
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
    team: null, invite: null, lastInv: 0, wn: 0,
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
      if (!room) { room = new Set(); room.rname = name; rooms.set(name, room); }
      if (room.size >= MAX_PER_ROOM) { ws.close(); return; }
      c.room = room;
      c.roomName = name;
      c.name = String(m.name || '玩家').slice(0, 10);
      c.team = 'T' + (nextTeam++);
      room.add(c);

      const st = ensureRoomState(name);
      // 每位玩家進入時都有自己的波次等級與計時；組隊後才會平均
      c.wn = 0;
      st.teams.set(c.team, { nextAt: Date.now() + WAVE_INTERVAL_MS, lastManual: 0, captain: c.id, recruit: false });
      const host = getRoomHost(room);
      const tp = teamsPayload(room);
      send(c, { t: 'you', id: c.id, host: host ? host.id : c.id, w: c.wn, next: tp.nx[c.team], tm: tp.m, th: tp.h, nx: tp.nx, cp: tp.cp, rc: tp.rc });
      broadcast(room, { t: 'n', n: room.size, host: host ? host.id : c.id });
      send(c, { t: 'n', n: room.size, host: host ? host.id : c.id });
      broadcast(room, { t: 'teams', m: tp.m, h: tp.h, nx: tp.nx, cp: tp.cp, rc: tp.rc }, c);

      fireTeamWave(name, c.team);   // 每位玩家進入即獲得自己的第 1 波(2 人)
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
      const ok = target && target !== c && target.team !== c.team && !c.dead && !target.dead && !c.hooking && !target.hookedBy && now > (target.immune || 0) && now - (c.lastHook || 0) > 400 && Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z) <= 140;
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
      // k: 'b' 刀(含特製)、'g' 槍(含特製)、's' 特製副傷害(爆炸/碎片)；舊客戶端以 d=80/10 判斷
      const dmg = Number.isFinite(m.d) ? Math.max(0, Math.min(80, Math.round(m.d))) : 0;
      const kind = m.k === 's' ? 's' : (m.k === 'b' || (m.k !== 'g' && m.d === 80)) ? 'b' : 'g';
      if (!dmg || c.dead) return;
      const target = findIn(c.room, m.to);
      if (!target || target === c || target.dead || target.iv || target.team === c.team) return; // 隊友不互傷
      const now = Date.now();
      const dist = Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z);
      if (kind === 'b') { if (now - c.last80 < 500 || dist > 15) return; c.last80 = now; }
      else if (kind === 'g') { if (now - c.last10 < 50 || dist > 150) return; c.last10 = now; }
      else {
        if (dist > 150) return;
        if (!c.sh || Object.keys(c.sh).length > 50) c.sh = {};
        if (now - (c.sh[target.id] || 0) < 20) return; c.sh[target.id] = now;
      }

      target.hp = Math.max(0, target.hp - dmg);
      send(target, { t: 'hp', hp: target.hp });
      if (target.hp <= 0) {
        target.dead = true; clearHooks(target);
        broadcast(c.room, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        send(c, { t: 'kill', by: c.id, bn: c.name, to: target.id, n: target.name });
        setTimeout(() => { target.hp = 100; target.dead = false; send(target, { t: 'hp', hp: 100 }); }, 1500);
      }
    } else if (m.t === 'slow') {
      // 玻璃碎片：對敵方玩家施加短暫緩速
      const target = findIn(c.room, m.to), now = Date.now();
      if (!target || target === c || target.team === c.team || c.dead || now - (c.lastSlow || 0) < 50) return;
      if (Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z) > 150) return;
      c.lastSlow = now; send(target, { t: 'slow' });
    } else if (m.t === 'team_inv') {
      const target = findIn(c.room, m.to), now = Date.now();
      if (!target || target === c || c.dead || target.dead || target.team === c.team) return;
      if (now - c.lastInv < 1000) return;
      if (Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z) > TEAM_INVITE_RANGE) return;
      const myT = st.teams.get(c.team), mySize = teamMembers(c.room, c.team).length;
      // 隊伍內第一次發出邀請的人為隊長；之後只有隊長可招募，除非隊長開放成員招募
      if (mySize > 1 && !(myT && (myT.captain === c.id || myT.recruit))) { send(c, { t: 'team_msg', k: 'noperm' }); return; }
      if (mySize >= MAX_TEAM) { send(c, { t: 'team_msg', k: 'full' }); return; }
      if (mySize <= 1 && myT) { myT.captain = c.id; myT.recruit = false; }
      c.lastInv = now;
      target.invite = { from: c.id, at: now };
      send(target, { t: 'team_inv', from: c.id, n: c.name });
      send(c, { t: 'team_msg', k: 'sent', n: target.name });
    } else if (m.t === 'team_acc') {
      const inv = c.invite; c.invite = null;
      if (!inv || Date.now() - inv.at > 20000) return;
      const from = findIn(c.room, inv.from);
      if (!from || from.team === c.team) return;
      if (teamMembers(c.room, from.team).length >= MAX_TEAM) { send(c, { t: 'team_msg', k: 'full' }); return; }
      const old = c.team;
      const n1 = teamMembers(c.room, from.team).length;           // 加入前的隊伍人數
      const fromT = st.teams.get(from.team), oldT = st.teams.get(old);
      if (fromT) {
        // 全隊所有人的「下一波時間」取平均
        const mine = oldT ? oldT.nextAt : fromT.nextAt;
        fromT.nextAt = Math.round((fromT.nextAt * n1 + mine) / (n1 + 1));
      }
      c.team = from.team;
      fixTeam(st, c.room, old);
      clearHooks(c); // 組隊後解除彼此的鉤索
      let mg = null;
      if (teamMembers(c.room, old).length === 0) {
        // 原本單人一隊：他那批敵人併入新隊伍
        st.teams.delete(old);
        for (const n of st.npcs.values()) if (n.tid === old) n.tid = c.team;
        mg = { from: old, to: c.team };
      }
      broadcastTeams(c.room, mg ? { mg } : null);
      broadcastAll(c.room, { t: 'team_msg', k: 'joined', n: c.name, to: from.name });
    } else if (m.t === 'team_recruit') {
      const T = st.teams.get(c.team);
      if (!T || T.captain !== c.id || teamMembers(c.room, c.team).length < 2) return;
      T.recruit = !T.recruit;
      broadcastTeams(c.room);
      for (const o of teamMembers(c.room, c.team)) send(o, { t: 'team_msg', k: 'recruit', on: T.recruit });
    } else if (m.t === 'team_leave') {
      if (teamMembers(c.room, c.team).length <= 1) return;
      const prevT = st.teams.get(c.team), prevTid = c.team;
      c.team = 'T' + (nextTeam++);
      st.teams.set(c.team, { nextAt: prevT ? prevT.nextAt : Date.now() + WAVE_INTERVAL_MS, lastManual: 0, captain: c.id, recruit: false });
      fixTeam(st, c.room, prevTid);
      broadcastTeams(c.room);
      broadcastAll(c.room, { t: 'team_msg', k: 'left', n: c.name });
    } else if (m.t === 'wave_req') {
      // 玩家手動呼叫自己這一隊的下一波空投（節流保護 3 秒），並重設該隊倒數
      if (!st) return;
      const T = st.teams.get(c.team);
      const now = Date.now();
      if (!T || now - (T.lastManual || 0) < 3000) return;
      T.lastManual = now;
      fireTeamWave(c.roomName, c.team);
    } else if (m.t === 'npc_me') {
      // 0級敵兵打到玩家：伺服器端扣血並同步 HP (警棍 15、手槍 12)
      const dmg = m.d === 15 ? 15 : m.d === 12 ? 12 : 0;
      const now = Date.now();
      if (!dmg || c.dead || c.iv) return;
      if (now - (c.lastNpcHit || 0) < 100) return;
      c.lastNpcHit = now;
      c.hp = Math.max(0, c.hp - dmg);
      send(c, { t: 'hp', hp: c.hp });
      if (c.hp <= 0) {
        c.dead = true; clearHooks(c);
        const bn = String(m.bn || '0級敵兵').slice(0, 16);
        const k = { t: 'kill', by: 'npc', bn, to: c.id, n: c.name };
        broadcast(c.room, k, c);
        send(c, k);
        setTimeout(() => { c.hp = 100; c.dead = false; send(c, { t: 'hp', hp: 100 }); }, 1500);
      }
    } else if (m.t === 'npc_hit') {
      // 玩家攻擊 0級NPC敵人：同步防爆盾耐久 (100點) 與 NPC 血量 (100點)
      if (!st || c.dead) return;
      const npcId = Number(m.id);
      if (!Number.isFinite(npcId)) return;
      const npc = st.npcs.get(npcId);
      if (!npc) return;
      const nowH = Date.now(); if (!c.nh || Object.keys(c.nh).length > 200) c.nh = {};
      if (m.d > 0 && nowH - (c.nh[npcId] || 0) < 20) return;   // 同一敵人節流
      c.nh[npcId] = nowH;
      const shDmg = m.sh === 10 ? 10 : 0;
      const hpDmg = Number.isFinite(m.d) ? Math.max(0, Math.min(80, Math.round(m.d))) : 0;
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
      // 某隊敵人目擊玩家時，同步該隊的 2 秒追蹤座標
      if (![m.x, m.y, m.z].every(Number.isFinite)) return;
      broadcast(c.room, { t: 'npc_spot', x: m.x, y: m.y, z: m.z, tid: String(m.tid || '').slice(0, 16), pid: String(m.pid || '').slice(0, 16) }, c);
    } else if (m.t === 'npc_sync') {
      // 各隊的模擬者(隊內第一人)同步自己這隊敵人的狀態；無人認領的敵人由房主同步
      if (!Array.isArray(m.list) || m.list.length > 48) return;
      const live = new Set();
      for (const o of c.room) live.add(o.team);
      const isRoomHost = getRoomHost(c.room) === c;
      const rows = m.list.filter(r => Array.isArray(r) && (r[11] === c.team || (isRoomHost && !live.has(r[11]))));
      if (!rows.length) return;
      broadcast(c.room, { t: 'npc_sync', list: rows }, c);
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
    { const stc = roomStates.get(c.roomName); if (stc) fixTeam(stc, c.room, c.team); }
    if (c.room.size === 0) {
      rooms.delete(c.roomName);
      cleanupRoomState(c.roomName);
    } else {
      const host = getRoomHost(c.room);
      broadcast(c.room, { t: 'left', id: c.id, host: host ? host.id : '' });
      broadcast(c.room, { t: 'n', n: c.room.size, host: host ? host.id : '' });
      broadcastTeams(c.room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));