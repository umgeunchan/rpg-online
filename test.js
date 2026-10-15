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

(async () => {
  await wait(500);
  const a = await join('철수', 'mage'), b = await join('<b>영희</b>', 'nope');
  await wait(200);
  assert.equal(a.state().players.length, 2, '두 플레이어가 서로 보여야 함');
  assert.equal(b.me().cls, 'warrior', '잘못된 직업은 전사로');
  assert.equal(a.init.map.length, 30);

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
