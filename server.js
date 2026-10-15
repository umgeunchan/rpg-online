// 멀티플레이 RPG 서버: 의존성 없음. SSE로 상태 방송, POST /act로 행동 수신.
// 좌표 단위는 타일(1타일 = 1). 플레이어는 연속 좌표, 몬스터는 타일 중심을 한 칸씩 이동.
const http = require('http'), fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const W = 40, H = 30, PORT = process.env.PORT || 3000, SPEED = 4;

// 0 풀, 1 나무, 2 물, 3 마을(안전지대)
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const map = [];
for (let y = 0; y < H; y++) {
  map.push([]);
  for (let x = 0; x < W; x++) {
    const r = rnd();
    map[y].push(x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 1 : r < 0.08 ? 1 : r < 0.12 ? 2 : 0);
  }
}
for (let y = 12; y <= 17; y++) for (let x = 17; x <= 22; x++) map[y][x] = 3;
const TOWN = { x: 20, y: 15 };

const CLASSES = {
  warrior: { name: '전사', hp: 40, atk: 6, range: 1.6, crit: 0.1 },
  mage: { name: '마법사', hp: 22, atk: 8, range: 5, crit: 0.1 },
  rogue: { name: '도적', hp: 28, atk: 5, range: 1.6, crit: 0.4 },
};
const MONSTERS = [
  { kind: 'slime', name: '슬라임', hp: 10, atk: 2, xp: 4 },
  { kind: 'goblin', name: '고블린', hp: 20, atk: 4, xp: 9 },
  { kind: 'wolf', name: '늑대', hp: 30, atk: 6, xp: 15 },
];

const players = new Map(); // token -> player
const monsters = [];
let nextId = 1, dirty = true;

const tile = (x, y) => map[Math.floor(y)]?.[Math.floor(x)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a, x, y) => Math.floor(a.x) === Math.floor(x) && Math.floor(a.y) === Math.floor(y);
const monsterCanEnter = (x, y) => tile(x, y) === 0 && !monsters.some(m => same(m, x, y)) && ![...players.values()].some(p => same(p, x, y));
const playerCanStand = (x, y) => tile(x, y) === 0 || tile(x, y) === 3;

function send(p, event, data) { p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function log(text, kind = 'sys') { for (const p of players.values()) send(p, 'log', { text, kind }); }

function spawnMonster() {
  const t = MONSTERS[Math.floor(Math.random() * MONSTERS.length)];
  let x, y;
  do { x = 1.5 + Math.floor(Math.random() * (W - 2)); y = 1.5 + Math.floor(Math.random() * (H - 2)); } while (!monsterCanEnter(x, y));
  monsters.push({ id: nextId++, ...t, maxHp: t.hp, x, y });
}
for (let i = 0; i < 14; i++) spawnMonster();

function spawnPoint() {
  for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = TOWN.x + dx + 0.5, y = TOWN.y + dy + 0.5;
    if (playerCanStand(x, y) && ![...players.values()].some(p => same(p, x, y))) return { x, y };
  }
  return { x: TOWN.x + 0.5, y: TOWN.y + 0.5 };
}
function teleport(p, pos) { Object.assign(p, pos); p.lastPosAt = Date.now(); send(p, 'correct', pos); }

function act(p, a) {
  const now = Date.now();
  if (a.type === 'pos') {
    const { x, y, yaw } = a;
    if (![x, y, yaw].every(Number.isFinite)) return;
    // 이동 검증: 경과 시간 대비 속도 + 벽 통과 금지. 어긋나면 서버 위치로 되돌림.
    const max = SPEED * (now - p.lastPosAt) / 1000 * 1.5 + 0.3;
    if (Math.hypot(x - p.x, y - p.y) > max || !playerCanStand(x, y)) return send(p, 'correct', { x: p.x, y: p.y });
    Object.assign(p, { x, y, yaw, lastPosAt: now });
    dirty = true;
  } else if (a.type === 'attack') {
    if (now - p.lastAtk < 400) return;
    p.lastAtk = now;
    if (Number.isFinite(a.yaw)) p.yaw = a.yaw; // 시점 방향은 위치보다 자주 바뀌므로 공격 시점 값을 사용
    const c = CLASSES[p.cls], fx = -Math.sin(p.yaw), fy = -Math.cos(p.yaw);
    // 바라보는 방향 ±45° 안에서 가장 가까운 몬스터 (바로 붙어 있으면 방향 무관)
    const target = monsters
      .filter(m => { const d = dist(m, p); return d <= c.range && (d < 0.8 || ((m.x - p.x) * fx + (m.y - p.y) * fy) / d > 0.7); })
      .sort((a, b) => dist(a, p) - dist(b, p))[0];
    p.swing = now;
    dirty = true;
    if (!target) return;
    const crit = Math.random() < c.crit;
    target.hp -= p.atk * (crit ? 2 : 1);
    target.hitAt = now;
    if (crit) send(p, 'log', { text: '치명타!', kind: 'level' });
    if (target.hp <= 0) {
      monsters.splice(monsters.indexOf(target), 1);
      p.xp += target.xp;
      log(`${p.name}이(가) ${target.name}을(를) 쓰러뜨렸다! (+${target.xp} XP)`, 'combat');
      while (p.xp >= p.lv * 10) {
        p.xp -= p.lv * 10; p.lv++; p.maxHp += 5; p.atk += 1; p.hp = p.maxHp;
        log(`✨ ${p.name}이(가) 레벨 ${p.lv}이(가) 되었다!`, 'level');
      }
      setTimeout(spawnMonster, 5000);
    }
  } else if (a.type === 'chat') {
    const text = String(a.text || '').trim().slice(0, 120);
    if (!text) return;
    if (text.startsWith('/me ')) log(`* ${p.name} ${text.slice(4)}`, 'emote');
    else { log(`${p.name}: ${text}`, 'chat'); p.say = text; p.sayAt = now; dirty = true; }
  }
}

// 몬스터 AI + 마을 회복: 1초마다
setInterval(() => {
  const list = [...players.values()];
  for (const m of monsters) {
    const near = list.filter(p => tile(p.x, p.y) !== 3).sort((a, b) => dist(a, m) - dist(b, m))[0];
    if (near && dist(near, m) <= 1.2) {
      near.hp -= m.atk;
      send(near, 'hurt', { dmg: m.atk });
      if (near.hp <= 0) {
        log(`💀 ${near.name}이(가) ${m.name}에게 쓰러졌다... 마을에서 부활합니다.`, 'combat');
        near.hp = near.maxHp;
        teleport(near, spawnPoint());
      }
      continue;
    }
    let dx = 0, dy = 0;
    if (near && dist(near, m) <= 6) {
      const ex = near.x - m.x, ey = near.y - m.y;
      if (Math.abs(ex) > Math.abs(ey)) dx = Math.sign(ex); else dy = Math.sign(ey);
    } else if (Math.random() < 0.5) [dx, dy] = [[0, 1], [0, -1], [1, 0], [-1, 0]][Math.floor(Math.random() * 4)];
    if ((dx || dy) && monsterCanEnter(m.x + dx, m.y + dy)) { m.x += dx; m.y += dy; }
  }
  for (const p of list) if (tile(p.x, p.y) === 3 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 3);
  dirty = true;
}, 1000);

// 변경이 있을 때만 100ms 간격으로 방송
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const now = Date.now();
  const state = {
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, cls: p.cls, x: p.x, y: p.y, yaw: p.yaw, hp: p.hp, maxHp: p.maxHp, lv: p.lv, xp: p.xp, atk: p.atk,
      say: now - p.sayAt < 5000 ? p.say : null, swing: now - p.swing < 300,
    })),
    monsters: monsters.map(m => ({ id: m.id, kind: m.kind, name: m.name, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, hit: now - (m.hitAt || 0) < 200 })),
  };
  for (const p of players.values()) send(p, 'state', state);
}, 100);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const name = (url.searchParams.get('name') || '').trim().slice(0, 12) || '모험가';
    const cls = CLASSES[url.searchParams.get('cls')] ? url.searchParams.get('cls') : 'warrior';
    const c = CLASSES[cls], token = randomUUID();
    const p = { id: nextId++, name, cls, ...spawnPoint(), yaw: 0, hp: c.hp, maxHp: c.hp, atk: c.atk, lv: 1, xp: 0, res, lastPosAt: Date.now(), lastAtk: 0, swing: 0, sayAt: 0 };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    players.set(token, p);
    // 호스팅 프록시가 조용한 연결을 끊지 않도록 주석 줄로 하트비트
    const beat = setInterval(() => res.write(':\n\n'), 15000);
    send(p, 'init', { token, id: p.id, x: p.x, y: p.y, map, W, H, classes: CLASSES });
    log(`${name}(${c.name})이(가) 세계에 들어왔다.`);
    dirty = true;
    req.on('close', () => { clearInterval(beat); players.delete(token); log(`${name}이(가) 떠났다.`); dirty = true; });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/act') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), p = players.get(a.token);
        if (p) act(p, a);
      } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(PORT, '0.0.0.0', () => console.log(`RPG 서버 실행 중: http://localhost:${PORT}`));
