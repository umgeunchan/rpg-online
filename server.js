// 멀티플레이 RPG 서버: 의존성 없음. SSE로 상태 방송, POST /act로 행동 수신.
const http = require('http'), fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const W = 40, H = 30, PORT = process.env.PORT || 3000;

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
  warrior: { name: '전사', hp: 40, atk: 6, range: 1, crit: 0.1 },
  mage: { name: '마법사', hp: 22, atk: 8, range: 3, crit: 0.1 },
  rogue: { name: '도적', hp: 28, atk: 5, range: 1, crit: 0.4 },
};
const MONSTERS = [
  { kind: 'slime', name: '슬라임', hp: 10, atk: 2, xp: 4 },
  { kind: 'goblin', name: '고블린', hp: 20, atk: 4, xp: 9 },
  { kind: 'wolf', name: '늑대', hp: 30, atk: 6, xp: 15 },
];

const players = new Map(); // token -> player
const monsters = [];
let nextId = 1, dirty = true;

const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const occupied = (x, y) => [...players.values()].some(p => p.x === x && p.y === y) || monsters.some(m => m.x === x && m.y === y);
const walkable = (x, y, isMonster) => map[y]?.[x] !== undefined && (map[y][x] === 0 || (map[y][x] === 3 && !isMonster)) && !occupied(x, y);

function send(p, event, data) { p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function log(text, kind = 'sys') { for (const p of players.values()) send(p, 'log', { text, kind }); }

function spawnMonster() {
  const t = MONSTERS[Math.floor(Math.random() * MONSTERS.length)];
  let x, y;
  do { x = 1 + Math.floor(Math.random() * (W - 2)); y = 1 + Math.floor(Math.random() * (H - 2)); } while (!walkable(x, y, true));
  monsters.push({ id: nextId++, ...t, maxHp: t.hp, x, y });
}
for (let i = 0; i < 14; i++) spawnMonster();

function spawnPoint() {
  for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
    if (walkable(TOWN.x + dx, TOWN.y + dy)) return { x: TOWN.x + dx, y: TOWN.y + dy };
  return { ...TOWN };
}

function act(p, a) {
  const now = Date.now();
  if (a.type === 'move') {
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[a.dir];
    if (!d || now - p.lastMove < 120) return;
    p.lastMove = now;
    if (walkable(p.x + d[0], p.y + d[1])) { p.x += d[0]; p.y += d[1]; dirty = true; }
  } else if (a.type === 'attack') {
    if (now - p.lastAtk < 400) return;
    p.lastAtk = now;
    const c = CLASSES[p.cls];
    const target = monsters.filter(m => dist(m, p) <= c.range).sort((a, b) => dist(a, p) - dist(b, p))[0];
    if (!target) return;
    const crit = Math.random() < c.crit;
    const dmg = p.atk * (crit ? 2 : 1);
    target.hp -= dmg;
    p.fx = { x: target.x, y: target.y, at: now, crit };
    dirty = true;
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
    const near = list.filter(p => map[p.y][p.x] !== 3).sort((a, b) => dist(a, m) - dist(b, m))[0];
    if (near && dist(near, m) === 1) {
      near.hp -= m.atk;
      if (near.hp <= 0) {
        log(`💀 ${near.name}이(가) ${m.name}에게 쓰러졌다... 마을에서 부활합니다.`, 'combat');
        near.hp = near.maxHp;
        Object.assign(near, spawnPoint());
      }
      continue;
    }
    let dx = 0, dy = 0;
    if (near && dist(near, m) <= 5) { dx = Math.sign(near.x - m.x); dy = dx ? 0 : Math.sign(near.y - m.y); }
    else if (Math.random() < 0.5) [dx, dy] = [[0, 1], [0, -1], [1, 0], [-1, 0]][Math.floor(Math.random() * 4)];
    if ((dx || dy) && walkable(m.x + dx, m.y + dy, true)) { m.x += dx; m.y += dy; }
  }
  for (const p of list) if (map[p.y][p.x] === 3 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 3);
  dirty = true;
}, 1000);

// 변경이 있을 때만 100ms 간격으로 방송
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const now = Date.now();
  const state = {
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, cls: p.cls, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, lv: p.lv, xp: p.xp, atk: p.atk,
      say: now - p.sayAt < 5000 ? p.say : null, fx: p.fx && now - p.fx.at < 300 ? p.fx : null,
    })),
    monsters,
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
    const p = { id: nextId++, name, cls, ...spawnPoint(), hp: c.hp, maxHp: c.hp, atk: c.atk, lv: 1, xp: 0, res, lastMove: 0, lastAtk: 0, sayAt: 0 };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    players.set(token, p);
    // 호스팅 프록시가 조용한 연결을 끊지 않도록 주석 줄로 하트비트
    const beat = setInterval(() => res.write(':\n\n'), 15000);
    send(p, 'init', { token, id: p.id, map, W, H, classes: CLASSES });
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
