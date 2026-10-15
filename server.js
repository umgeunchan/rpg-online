// 멀티플레이 RPG 서버: 의존성 없음. SSE로 상태 방송, POST /act로 행동 수신.
// 좌표 단위는 타일(1타일 = 1). 플레이어는 연속 좌표, 몬스터는 타일 중심을 한 칸씩 이동.
const http = require('http'), fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const H = 32, PORT = process.env.PORT || 3000, SPEED = 4, INV_MAX = 30;

// ---------- 월드 구조: 왼쪽에서 오른쪽으로 이어지는 선형 진행 ----------
const SEGMENTS = [
  { type: 'town', w: 12, name: '시작의 마을', minLv: 1 },
  { type: 'field', w: 36, name: '초록 들판', minLv: 1, theme: 'meadow', tier: 1, mobs: ['slime', 'goblin', 'wolf'], count: 22 },
  { type: 'town', w: 12, name: '숲속 마을', minLv: 6 },
  { type: 'field', w: 36, name: '어둠의 숲', minLv: 6, theme: 'dark', tier: 2, mobs: ['orc', 'skeleton', 'spider'], count: 22 },
  { type: 'town', w: 12, name: '설원 마을', minLv: 12 },
  { type: 'field', w: 36, name: '얼음 협곡', minLv: 12, theme: 'snow', tier: 3, mobs: ['troll', 'frostwolf', 'spirit'], count: 22 },
  { type: 'town', w: 12, name: '최후의 요새', minLv: 18 },
  { type: 'boss', w: 24, name: '마왕성', minLv: 18, theme: 'lava', tier: 4, mobs: ['demon'], count: 1 },
];
let W = 0, townNo = 0;
const zones = SEGMENTS.map((s, id) => {
  const z = { ...s, id, x0: W, x1: W + s.w };
  if (s.type === 'town') z.tier = ++townNo; // 마을 n번째 = 상점 물건 tier n
  W += s.w;
  return z;
});
const zoneAt = x => zones.find(z => x >= z.x0 && x < z.x1) || zones[0];

// 타일: 0 풀, 1 나무, 2 물(용암), 3 마을 바닥, 4 건물, 5 길
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const map = [];
for (let y = 0; y < H; y++) {
  map.push([]);
  for (let x = 0; x < W; x++) {
    const z = zoneAt(x), r = rnd();
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) map[y].push(1);
    else if (z.type === 'town') map[y].push(3);
    else if (z.type === 'boss') map[y].push(r < 0.03 ? 1 : r < 0.07 ? 2 : 0);
    else map[y].push(r < 0.09 ? 1 : r < 0.13 ? 2 : 0);
  }
}
// 가운데 길 + 구역 경계 벽(가운데 4칸만 관문)
for (let x = 1; x < W - 1; x++) for (const y of [15, 16]) if (zoneAt(x).type !== 'town') map[y][x] = 5;
for (const z of zones.slice(1)) for (let y = 1; y < H - 1; y++) {
  const gate = y >= 14 && y <= 17;
  map[y][z.x0] = gate ? (z.type === 'town' ? 3 : 5) : 1;
  if (gate) for (const dx of [-1, 1]) if (map[y][z.x0 + dx] !== 3) map[y][z.x0 + dx] = 5;
}
// 마을: 3x3 건물 4채, 상인과 대장장이
const npcs = [];
for (const z of zones.filter(z => z.type === 'town')) {
  for (const [hx, hy] of [[2, 5], [7, 5], [2, 24], [7, 24]])
    for (let y = hy; y < hy + 3; y++) for (let x = z.x0 + hx; x < z.x0 + hx + 3; x++) map[y][x] = 4;
  z.spawn = { x: z.x0 + 6, y: 15.5 };
  npcs.push({ type: 'shop', name: '상인', town: z.id, tier: z.tier, x: z.x0 + 3.5, y: 9.5 });
  npcs.push({ type: 'smith', name: '대장장이', town: z.id, tier: z.tier, x: z.x0 + 8.5, y: 9.5 });
}

// ---------- 데이터 ----------
const CLASSES = {
  warrior: { name: '전사', hp: 40, atk: 6, range: 1.6, crit: 0.1 },
  mage: { name: '마법사', hp: 22, atk: 8, range: 5, crit: 0.1 },
  rogue: { name: '도적', hp: 28, atk: 5, range: 1.6, crit: 0.4 },
};
const MOBS = {
  slime: { name: '슬라임', model: 'slime', color: 0x55dd66, scale: 1, hp: 10, atk: 2, xp: 4, gold: [2, 5] },
  goblin: { name: '고블린', model: 'goblin', color: 0x7fb03a, scale: 1, hp: 20, atk: 4, xp: 9, gold: [4, 9] },
  wolf: { name: '늑대', model: 'wolf', color: 0x7a7a80, scale: 1, hp: 30, atk: 6, xp: 14, gold: [6, 12] },
  orc: { name: '오크', model: 'goblin', color: 0x4a6b2a, scale: 1.4, hp: 90, atk: 14, xp: 35, gold: [18, 30] },
  skeleton: { name: '해골 전사', model: 'goblin', color: 0xe8e4d8, scale: 1.2, hp: 75, atk: 17, xp: 38, gold: [20, 32] },
  spider: { name: '거대 거미', model: 'wolf', color: 0x3d2352, scale: 1.1, hp: 110, atk: 15, xp: 42, gold: [22, 36] },
  troll: { name: '트롤', model: 'goblin', color: 0x6b7f99, scale: 1.8, hp: 280, atk: 30, xp: 95, gold: [60, 90] },
  frostwolf: { name: '서리 늑대', model: 'wolf', color: 0xbfe6ff, scale: 1.4, hp: 220, atk: 34, xp: 100, gold: [60, 95] },
  spirit: { name: '얼음 정령', model: 'slime', color: 0x7fd4ff, scale: 1.6, hp: 240, atk: 32, xp: 105, gold: [65, 100] },
  demon: { name: '마왕', model: 'goblin', color: 0x8b0000, scale: 3.2, hp: 4000, atk: 55, xp: 2000, gold: [3000, 5000], boss: true },
};
const GRADES = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSR'];
const GMULT = { D: 1, C: 1.5, B: 2.2, A: 3.2, S: 5, SS: 8, SSR: 13 };
const DROP_W = { normal: [40.2, 28, 18, 9, 3.5, 1, 0.3], boss: [0, 0, 20, 30, 27, 15, 8] }; // GRADES 순서
const TIER_NAME = ['', '낡은', '강철', '미스릴', '용의'];
const NOUN = { weapon: { warrior: '대검', mage: '지팡이', rogue: '단검' }, armor: '갑옷', relic: '유물', accessory: '반지' };
const BASE = {
  weapon: { atk: [0, 3, 8, 16, 30] },
  armor: { def: [0, 3, 8, 16, 30] },
  relic: { atk: [0, 1, 3, 6, 12], hp: [0, 10, 25, 50, 100] },
  accessory: { crit: [0, 0.02, 0.03, 0.04, 0.06], hp: [0, 5, 15, 30, 60] },
};
const SLOTS = Object.keys(BASE);
const POTION_PRICE = [0, 10, 30, 80, 150];

let nextId = 1;
function rollGrade(table) {
  let r = Math.random() * table.reduce((a, b) => a + b);
  for (let i = 0; i < GRADES.length; i++) if ((r -= table[i]) < 0) return GRADES[i];
  return 'D';
}
function makeItem(slot, tier, grade, cls) {
  const m = GMULT[grade] * (0.85 + Math.random() * 0.3), stats = {};
  for (const [k, arr] of Object.entries(BASE[slot])) stats[k] = k === 'crit' ? +(arr[tier] * m).toFixed(3) : Math.max(1, Math.round(arr[tier] * m));
  const noun = slot === 'weapon' ? NOUN.weapon[cls] : NOUN[slot];
  return { uid: nextId++, slot, tier, grade, name: `${TIER_NAME[tier]} ${noun}`, stats, plus: 0, value: Math.round([0, 5, 15, 40, 100][tier] * GMULT[grade] * 4) };
}
const enhanceCost = it => Math.round(it.value * (it.plus + 1) * 0.8);
const enhanceChance = it => Math.max(0.3, 1 - 0.07 * it.plus);
const xpNeed = lv => lv * 12;
const wares = tier => [
  { id: 'potion', name: '체력 물약', price: POTION_PRICE[tier] },
  { id: 'weapon', name: `C급 ${TIER_NAME[tier]} 무기`, price: Math.round([0, 5, 15, 40, 100][tier] * GMULT.C * 12) },
  { id: 'armor', name: `C급 ${TIER_NAME[tier]} 갑옷`, price: Math.round([0, 5, 15, 40, 100][tier] * GMULT.C * 12) },
];

// 레벨, 스탯 포인트, 장비(강화 포함)로 최종 능력치 계산
function recalc(p) {
  const c = CLASSES[p.cls];
  let atk = c.atk + (p.lv - 1) + p.str, hp = c.hp + (p.lv - 1) * 5 + p.vit * 5, def = 0, crit = c.crit + p.agi * 0.01;
  for (const it of Object.values(p.equip)) if (it) {
    const k = 1 + 0.1 * it.plus;
    atk += (it.stats.atk || 0) * k; hp += (it.stats.hp || 0) * k; def += (it.stats.def || 0) * k; crit += (it.stats.crit || 0) * k;
  }
  p.atk = Math.round(atk); p.maxHp = Math.round(hp); p.def = Math.round(def); p.crit = Math.min(0.9, crit);
  p.hp = Math.min(p.hp, p.maxHp);
  p.meDirty = true;
}
const damageTaken = (atk, def) => Math.max(1, Math.round(atk * 60 / (60 + def)));

// ---------- 상태 ----------
const players = new Map(); // token -> player (연결이 끊겨도 10분간 보관해 재접속 시 이어서 플레이)
const monsters = [];
let dirty = true;
const online = () => [...players.values()].filter(p => p.res);
const tile = (x, y) => map[Math.floor(y)]?.[Math.floor(x)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a, x, y) => Math.floor(a.x) === Math.floor(x) && Math.floor(a.y) === Math.floor(y);
const monsterCanEnter = (x, y, zid) => [0, 5].includes(tile(x, y)) && zoneAt(x).id === zid && !monsters.some(m => same(m, x, y)) && !online().some(p => same(p, x, y));
const playerCanStand = (x, y) => [0, 3, 5].includes(tile(x, y));

function send(p, event, data) { p.res?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function log(text, kind = 'sys') { for (const p of online()) send(p, 'log', { text, kind }); }
const tell = (p, text, kind = 'sys') => send(p, 'log', { text, kind });

function spawnMonster(z) {
  const t = z.mobs[Math.floor(Math.random() * z.mobs.length)], def = MOBS[t];
  let x, y, tries = 0;
  do {
    x = def.boss ? z.x0 + z.w - 6.5 : z.x0 + 2.5 + Math.floor(Math.random() * (z.w - 4));
    y = def.boss ? 15.5 : 1.5 + Math.floor(Math.random() * (H - 3));
  } while (!monsterCanEnter(x, y, z.id) && ++tries < 200);
  monsters.push({ id: nextId++, type: t, ...def, maxHp: def.hp, x, y, zone: z.id });
  if (def.boss) log(`🔥 ${z.name}에 ${def.name}이(가) 나타났다!`, 'level');
}
for (const z of zones) for (let i = 0; i < (z.count || 0); i++) spawnMonster(z);

function spawnAt(p) {
  const s = zones[p.home].spawn;
  for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (playerCanStand(x, y) && !online().some(o => o !== p && same(o, x, y))) return { x, y };
  }
  return { ...s };
}
function teleport(p, pos) { Object.assign(p, pos); p.lastPosAt = Date.now(); send(p, 'correct', pos); }
const nearNpc = (p, type) => npcs.find(n => n.type === type && dist(n, p) <= 2.5);
function findItem(p, uid) {
  const i = p.inv.findIndex(it => it.uid === uid);
  if (i >= 0) return p.inv[i];
  return Object.values(p.equip).find(it => it && it.uid === uid);
}
function giveItem(p, it) {
  if (p.inv.length >= INV_MAX) { p.gold += it.value; tell(p, `가방이 가득 차서 ${it.name}을(를) ${it.value}골드에 팔았다.`); }
  else p.inv.push(it);
  p.meDirty = true;
}

function kill(p, m) {
  monsters.splice(monsters.indexOf(m), 1);
  const gold = m.gold[0] + Math.floor(Math.random() * (m.gold[1] - m.gold[0] + 1));
  p.xp += m.xp; p.gold += gold;
  log(`${p.name}이(가) ${m.name}을(를) 쓰러뜨렸다! (+${m.xp} XP, +${gold}G)`, 'combat');
  const z = zones[m.zone];
  // 드롭: 일반 25% 확률 1개, 보스는 확정 3개 + 높은 등급표
  const drops = m.boss ? 3 : Math.random() < 0.25 ? 1 : 0;
  for (let i = 0; i < drops; i++) {
    const it = makeItem(SLOTS[Math.floor(Math.random() * SLOTS.length)], z.tier, rollGrade(DROP_W[m.boss ? 'boss' : 'normal']), p.cls);
    giveItem(p, it);
    if (GRADES.indexOf(it.grade) >= 4) log(`🌟 ${p.name}이(가) [${it.grade}] ${it.name}을(를) 손에 넣었다!`, 'level');
    else tell(p, `[${it.grade}] ${it.name} 획득`, 'loot');
  }
  while (p.xp >= xpNeed(p.lv)) {
    p.xp -= xpNeed(p.lv); p.lv++; p.points += 3;
    recalc(p); p.hp = p.maxHp;
    log(`✨ ${p.name}이(가) 레벨 ${p.lv}이(가) 되었다! (스탯 포인트 +3)`, 'level');
  }
  if (m.boss) log(`👑 ${p.name}의 손에 ${m.name}이(가) 쓰러졌다! 세계에 평화가... 2분 뒤 다시 깨어난다.`, 'level');
  setTimeout(() => spawnMonster(z), m.boss ? 120000 : 5000);
  p.meDirty = true;
}

function act(p, a) {
  const now = Date.now();
  if (a.type === 'pos') {
    const { x, y, yaw } = a;
    if (![x, y, yaw].every(Number.isFinite)) return;
    // 이동 검증: 경과 시간 대비 속도 + 벽 통과 금지 + 레벨 제한 구역. 어긋나면 서버 위치로 되돌림.
    const max = SPEED * (now - p.lastPosAt) / 1000 * 1.5 + 0.3, z = zoneAt(x);
    if (Math.hypot(x - p.x, y - p.y) > max || !playerCanStand(x, y)) return send(p, 'correct', { x: p.x, y: p.y });
    if (z.minLv > p.lv) {
      if (now - (p.lockMsgAt || 0) > 3000) { p.lockMsgAt = now; tell(p, `🔒 ${z.name}은(는) 레벨 ${z.minLv} 이상만 들어갈 수 있다.`); }
      return send(p, 'correct', { x: p.x, y: p.y });
    }
    if (z.type === 'town' && p.home !== z.id) { p.home = z.id; tell(p, `🏠 ${z.name}이(가) 부활 지점이 되었다.`); p.meDirty = true; }
    Object.assign(p, { x, y, yaw, lastPosAt: now });
    dirty = true;
  } else if (a.type === 'attack') {
    if (now - p.lastAtk < 400) return;
    p.lastAtk = now;
    if (Number.isFinite(a.yaw)) p.yaw = a.yaw; // 시점 방향은 위치보다 자주 바뀌므로 공격 시점 값을 사용
    const c = CLASSES[p.cls], fx = -Math.sin(p.yaw), fy = -Math.cos(p.yaw);
    // 바라보는 방향 ±45° 안에서 가장 가까운 몬스터 (바로 붙어 있으면 방향 무관). 큰 몬스터는 몸집만큼 사거리 보정
    const target = monsters
      .filter(m => { const d = dist(m, p), r = c.range + (m.scale - 1) * 0.5; return d <= r && (d < 0.8 + (m.scale - 1) * 0.5 || ((m.x - p.x) * fx + (m.y - p.y) * fy) / d > 0.7); })
      .sort((a, b) => dist(a, p) - dist(b, p))[0];
    p.swing = now;
    dirty = true;
    if (!target) return;
    const crit = Math.random() < p.crit;
    target.hp -= p.atk * (crit ? 2 : 1);
    target.hitAt = now;
    if (crit) tell(p, '치명타!', 'level');
    if (target.hp <= 0) kill(p, target);
  } else if (a.type === 'chat') {
    const text = String(a.text || '').trim().slice(0, 120);
    if (!text) return;
    if (text.startsWith('/me ')) log(`* ${p.name} ${text.slice(4)}`, 'emote');
    else { log(`${p.name}: ${text}`, 'chat'); p.say = text; p.sayAt = now; dirty = true; }
  } else if (a.type === 'stat') {
    if (!['str', 'vit', 'agi'].includes(a.stat) || p.points <= 0) return;
    p[a.stat]++; p.points--;
    recalc(p);
  } else if (a.type === 'potion') {
    if (p.potions <= 0 || p.hp >= p.maxHp) return;
    p.potions--; p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.4));
    p.meDirty = dirty = true;
  } else if (a.type === 'equip') {
    const i = p.inv.findIndex(it => it.uid === a.uid);
    if (i < 0) return;
    const it = p.inv[i], old = p.equip[it.slot];
    p.inv.splice(i, 1);
    if (old) p.inv.push(old);
    p.equip[it.slot] = it;
    recalc(p);
  } else if (a.type === 'unequip') {
    const it = p.equip[a.slot];
    if (!it || p.inv.length >= INV_MAX) return;
    p.equip[a.slot] = null; p.inv.push(it);
    recalc(p);
  } else if (a.type === 'sell') {
    const i = p.inv.findIndex(it => it.uid === a.uid);
    if (i < 0 || !nearNpc(p, 'shop')) return;
    const it = p.inv.splice(i, 1)[0];
    const price = Math.round(it.value * (1 + 0.2 * it.plus));
    p.gold += price;
    tell(p, `${it.name}을(를) ${price}골드에 팔았다.`);
    p.meDirty = true;
  } else if (a.type === 'buy') {
    const npc = nearNpc(p, 'shop'), w = npc && wares(npc.tier).find(w => w.id === a.id);
    if (!w || p.gold < w.price) return tell(p, '골드가 부족하다.');
    if (w.id !== 'potion' && p.inv.length >= INV_MAX) return tell(p, '가방이 가득 찼다.');
    p.gold -= w.price;
    if (w.id === 'potion') p.potions++;
    else p.inv.push(makeItem(w.id, npc.tier, 'C', p.cls));
    tell(p, `${w.name} 구매 (-${w.price}G)`);
    p.meDirty = true;
  } else if (a.type === 'enhance') {
    const it = findItem(p, a.uid);
    if (!it || it.plus >= 10 || !nearNpc(p, 'smith')) return;
    const cost = enhanceCost(it);
    if (p.gold < cost) return tell(p, '골드가 부족하다.');
    p.gold -= cost;
    if (Math.random() < enhanceChance(it)) {
      it.plus++;
      if (it.plus >= 7) log(`🔨 ${p.name}의 [${it.grade}] ${it.name}이(가) +${it.plus} 강화에 성공했다!`, 'level');
      else tell(p, `🔨 강화 성공! ${it.name} +${it.plus}`, 'level');
      recalc(p);
    } else tell(p, `🔨 강화 실패... (${it.name} +${it.plus} 유지)`, 'combat');
    p.meDirty = true;
  }
}

// 몬스터 AI + 마을 회복: 1초마다
setInterval(() => {
  const list = online();
  for (const m of monsters) {
    const reach = 0.7 + 0.5 * m.scale;
    const near = list.filter(p => tile(p.x, p.y) !== 3 && zoneAt(p.x).id === m.zone).sort((a, b) => dist(a, m) - dist(b, m))[0];
    if (near && dist(near, m) <= reach) {
      const dmg = damageTaken(m.atk, near.def);
      near.hp -= dmg;
      near.meDirty = true;
      send(near, 'hurt', { dmg });
      if (near.hp <= 0) {
        const lost = Math.floor(near.gold * 0.1);
        near.gold -= lost;
        log(`💀 ${near.name}이(가) ${m.name}에게 쓰러졌다... (${lost}G 잃음)`, 'combat');
        near.hp = near.maxHp;
        teleport(near, spawnAt(near));
      }
      continue;
    }
    let dx = 0, dy = 0;
    if (near && dist(near, m) <= 6) {
      const ex = near.x - m.x, ey = near.y - m.y;
      if (Math.abs(ex) > Math.abs(ey)) dx = Math.sign(ex); else dy = Math.sign(ey);
    } else if (Math.random() < 0.5 && !m.boss) [dx, dy] = [[0, 1], [0, -1], [1, 0], [-1, 0]][Math.floor(Math.random() * 4)];
    if ((dx || dy) && monsterCanEnter(m.x + dx, m.y + dy, m.zone)) { m.x += dx; m.y += dy; }
  }
  for (const p of list) if (tile(p.x, p.y) === 3 && p.hp < p.maxHp) { p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * 0.05)); p.meDirty = true; }
  dirty = true;
}, 1000);

// 공개 상태는 변경 시 100ms 간격으로, 개인 상태(가방 등)는 바뀐 사람에게만
const meState = p => ({
  gold: p.gold, potions: p.potions, points: p.points, str: p.str, vit: p.vit, agi: p.agi, lv: p.lv, xp: p.xp, xpNeed: xpNeed(p.lv),
  hp: p.hp, maxHp: p.maxHp, atk: p.atk, def: p.def, crit: p.crit, inv: p.inv, equip: p.equip, home: p.home,
});
setInterval(() => {
  const list = online();
  for (const p of list) if (p.meDirty) { p.meDirty = false; send(p, 'me', meState(p)); }
  if (!dirty) return;
  dirty = false;
  const now = Date.now();
  const state = {
    players: list.map(p => ({
      id: p.id, name: p.name, cls: p.cls, x: p.x, y: p.y, yaw: p.yaw, hp: p.hp, maxHp: p.maxHp, lv: p.lv,
      say: now - p.sayAt < 5000 ? p.say : null, swing: now - p.swing < 300,
    })),
    monsters: monsters.map(m => ({ id: m.id, type: m.type, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, hit: now - (m.hitAt || 0) < 200 })),
  };
  for (const p of list) send(p, 'state', state);
}, 100);
setInterval(() => { for (const [t, p] of players) if (!p.res && Date.now() - p.leftAt > 600000) players.delete(t); }, 60000);

function newPlayer(name, cls, res) {
  const c = CLASSES[cls];
  const p = {
    id: nextId++, name, cls, home: 0, yaw: Math.PI / 2 * -1, hp: c.hp, lv: 1, xp: 0, gold: 20, potions: 3, points: 0, str: 0, vit: 0, agi: 0,
    inv: [], equip: { weapon: null, armor: null, relic: null, accessory: null }, res, lastAtk: 0, swing: 0, sayAt: 0,
  };
  recalc(p);
  p.hp = p.maxHp;
  Object.assign(p, spawnAt(p), { lastPosAt: Date.now() });
  return p;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let token = url.searchParams.get('resume'), p = token && players.get(token);
    if (p) { p.res?.end(); p.res = res; p.lastPosAt = Date.now(); log(`${p.name}이(가) 돌아왔다.`); }
    else {
      const name = (url.searchParams.get('name') || '').trim().slice(0, 12) || '모험가';
      const cls = CLASSES[url.searchParams.get('cls')] ? url.searchParams.get('cls') : 'warrior';
      token = randomUUID();
      p = newPlayer(name, cls, res);
      players.set(token, p);
      log(`${name}(${CLASSES[cls].name})이(가) 세계에 들어왔다.`);
    }
    // 호스팅 프록시가 조용한 연결을 끊지 않도록 주석 줄로 하트비트
    const beat = setInterval(() => res.write(':\n\n'), 15000);
    send(p, 'init', {
      token, id: p.id, cls: p.cls, x: p.x, y: p.y, map, W, H, mobs: MOBS,
      zones: zones.map(({ name, type, x0, x1, minLv, theme }) => ({ name, type, x0, x1, minLv, theme })),
      npcs: npcs.map(n => ({ ...n, wares: n.type === 'shop' ? wares(n.tier) : undefined })),
    });
    send(p, 'me', meState(p));
    dirty = true;
    req.on('close', () => {
      clearInterval(beat);
      if (p.res !== res) return; // 다른 탭/재접속으로 교체된 연결
      p.res = null; p.leftAt = Date.now();
      log(`${p.name}이(가) 떠났다.`);
      dirty = true;
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/act') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), p = players.get(a.token);
        if (p?.res) act(p, a);
      } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`RPG 서버 실행 중: http://localhost:${PORT}`));
module.exports = { act, makeItem, recalc, newPlayer, rollGrade, zoneAt, zones, map, npcs, enhanceCost, enhanceChance, damageTaken, GRADES, DROP_W };
