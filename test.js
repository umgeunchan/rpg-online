// 자체 점검: 서버를 띄우고 2명 접속 → 이동/채팅/공격/잘못된 입력 확인. 실행: node test.js
const { spawn } = require('child_process'), assert = require('assert');
const PORT = 3999, base = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, PORT } });

async function join(name, cls) {
  const res = await fetch(`${base}/events?name=${encodeURIComponent(name)}&cls=${cls}`);
  const reader = res.body.getReader(), dec = new TextDecoder(), c = { events: [], buf: '' };
  (async () => {
    for (;;) {
      const { value, done } = await reader.read(); if (done) return;
      c.buf += dec.decode(value);
      let i;
      while ((i = c.buf.indexOf('\n\n')) >= 0) {
        const chunk = c.buf.slice(0, i); c.buf = c.buf.slice(i + 2);
        const ev = chunk.match(/event: (\w+)/)[1], data = JSON.parse(chunk.match(/data: (.*)/)[1]);
        c.events.push({ ev, data });
      }
    }
  })();
  await wait(300);
  c.init = c.events.find(e => e.ev === 'init').data;
  c.act = a => fetch(`${base}/act`, { method: 'POST', body: JSON.stringify({ token: c.init.token, ...a }) });
  c.state = () => c.events.filter(e => e.ev === 'state').at(-1).data;
  c.me = () => c.state().players.find(p => p.id === c.init.id);
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- 게임 로직 단위 점검 (서버 모듈 직접 호출) ----------
function unit() {
  const g = require('./server.js');
  const fake = () => ({ write() {} });
  // 시작 마을부터 보스까지 가운데 길로 끊김 없이 이어짐
  for (let x = 1; x < g.map[0].length - 1; x++) assert.ok([3, 5].includes(g.map[15][x]), `길이 끊김: x=${x}`);
  assert.equal(g.zones.at(-1).name, '마왕성');
  // 등급 편차: 같은 슬롯/단계에서 SSR이 D의 8배 이상
  const d = g.makeItem('weapon', 2, 'D', 'warrior'), ssr = g.makeItem('weapon', 2, 'SSR', 'warrior');
  assert.ok(ssr.stats.atk >= d.stats.atk * 8, `SSR ${ssr.stats.atk} vs D ${d.stats.atk}`);
  assert.equal(d.name, '강철 대검');
  // 보스 드롭은 D/C 안 나옴
  for (let i = 0; i < 500; i++) assert.ok(!['D', 'C'].includes(g.rollGrade(g.DROP_W.boss)));
  assert.ok(g.damageTaken(50, 60) < g.damageTaken(50, 0));
  // 장비 + 강화가 능력치에 반영
  const p = g.newPlayer('t', 'warrior', fake());
  const base = p.atk, w = g.makeItem('weapon', 1, 'A', 'warrior');
  p.inv.push(w);
  g.act(p, { type: 'equip', uid: w.uid });
  assert.equal(p.atk, base + w.stats.atk);
  assert.equal(p.inv.length, 0);
  // 레벨 제한 구역: Lv1은 숲속 마을 진입 거부, Lv6은 허용 + 부활 지점 변경
  const town2 = g.zones[2];
  p.lastPosAt = 0;
  g.act(p, { type: 'pos', x: town2.x0 + 1.5, y: 15.5, yaw: 0 });
  assert.ok(p.x < town2.x0, '레벨 부족 시 진입 거부');
  p.lv = 6; p.lastPosAt = 0;
  g.act(p, { type: 'pos', x: town2.x0 + 1.5, y: 15.5, yaw: 0 });
  assert.equal(p.home, 2);
  // 상점/대장간은 NPC 근처에서만
  p.gold = 1000;
  g.act(p, { type: 'buy', id: 'potion' });
  assert.equal(p.potions, 3, '멀리서는 구매 불가');
  const shop = g.npcs.find(n => n.type === 'shop' && n.town === 2), smith = g.npcs.find(n => n.type === 'smith' && n.town === 2);
  Object.assign(p, { x: shop.x, y: shop.y + 1 });
  g.act(p, { type: 'buy', id: 'potion' });
  assert.equal(p.potions, 4);
  assert.equal(p.gold, 1000 - 30, '2번째 마을 물약 30G');
  Object.assign(p, { x: smith.x, y: smith.y + 1, gold: 100000 });
  for (let i = 0; i < 40 && w.plus < 3; i++) g.act(p, { type: 'enhance', uid: w.uid });
  assert.equal(w.plus, 3);
  assert.equal(p.atk, 6 + 5 + Math.round(w.stats.atk * 1.3), "Lv6 기본 공격 11 + 강화 +3 무기");
  // 스탯 포인트
  p.points = 1;
  g.act(p, { type: 'stat', stat: 'vit' });
  g.act(p, { type: 'stat', stat: 'vit' });
  assert.equal(p.vit, 1, '포인트 없으면 증가 안 함');
}

(async () => {
  unit();
  await wait(500);
  const a = await join('철수', 'mage'), b = await join('<b>영희</b>', 'nope');
  await wait(200);
  assert.equal(a.state().players.length, 2, '두 플레이어가 서로 보여야 함');
  assert.equal(b.me().cls, 'warrior', '잘못된 직업은 전사로');
  assert.equal(a.init.map.length, 32);

  const before = a.me();
  await a.act({ type: 'pos', x: before.x + 0.3, y: before.y, yaw: 1 });
  await wait(200);
  assert.ok(Math.abs(a.me().x - (before.x + 0.3)) < 1e-9, '정상 이동은 반영');
  assert.equal(a.me().yaw, 1);
  await a.act({ type: 'pos', x: before.x + 10, y: before.y, yaw: 1 });
  await a.act({ type: 'pos', x: 'NaN', y: null, yaw: 1 });
  await wait(200);
  assert.ok(Math.abs(a.me().x - (before.x + 0.3)) < 1e-9, '순간이동/잘못된 좌표는 거부');
  assert.ok(a.events.some(e => e.ev === 'correct'), '거부 시 위치 보정 이벤트');

  await a.act({ type: 'chat', text: '안녕하세요!' });
  await a.act({ type: 'chat', text: '/me 손을 흔든다' });
  await wait(200);
  const logs = b.events.filter(e => e.ev === 'log').map(e => e.data.text);
  assert.ok(logs.includes('철수: 안녕하세요!'), '상대가 채팅을 받아야 함');
  assert.ok(logs.includes('* 철수 손을 흔든다'), '/me 행동 묘사');
  assert.equal(a.me().say, '안녕하세요!');

  await fetch(`${base}/act`, { method: 'POST', body: 'not json' });
  await fetch(`${base}/act`, { method: 'POST', body: JSON.stringify({ token: 'fake', type: 'chat', text: 'hack' }) });
  await a.act({ type: 'attack' }); // 주변에 몬스터가 없어도 죽지 않아야 함
  await wait(300);
  assert.ok(!b.events.some(e => e.ev === 'log' && e.data.text.includes('hack')), '가짜 토큰은 무시');
  assert.ok(a.state().monsters.length > 0);

  console.log('모든 점검 통과');
  srv.kill(); process.exit(0);
})().catch(e => { console.error('실패:', e.message); srv.kill(); process.exit(1); });
