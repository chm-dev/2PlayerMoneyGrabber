'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const srv = require('../server');

class Bot {
  constructor(ws) { this.ws = ws; this.msgs = []; this.waiters = []; ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } this.msgs.push(m); this.pump(); }); }
  pump() { for (const w of this.waiters.slice()) { const m = this.msgs.find(w.pred); if (m) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.to); w.res(m); } } }
  waitFor(pred, timeout = 3000) { const w = { pred, res: null, to: null }; return new Promise((res, rej) => { w.res = res; w.to = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout waiting for a message')); }, timeout); this.waiters.push(w); this.pump(); }); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  input(seq, k, pid, x, z, sy, token) { this.send({ t: 'i', seq, k, pid, x: x || 0, z: z || 0, sy: sy === undefined ? 0.5 : sy, token }); }
  close() { try { this.ws.close(); } catch (e) {} }
}
function connect(port) { return new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:' + port); ws.on('open', () => resolve(new Bot(ws))); ws.on('error', reject); }); }
async function pair(port) {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  await a.waitFor(m => m.t === 'room');
  await b.waitFor(m => m.t === 'room');
  const start = await a.waitFor(m => m.t === 'start');
  await b.waitFor(m => m.t === 'start');
  return { a, b, start };
}

let port;
test.before(async () => { port = await srv.start(0); });
test.after(async () => { await srv.stop(); });

test('two clients pair, receive roles and a full start state', async () => {
  const { a, b, start } = await pair(port);
  assert.ok(start.token, 'start carries a match token');
  assert.ok(start.S && Array.isArray(start.S.m), 'start carries the sim state');
  assert.equal(start.S.ph, 'playing');
  assert.equal(start.S.authority, true);
  assert.deepEqual(start.S.m, []);
  a.close(); b.close();
});

test('input is acknowledged and touches appear in snapshots', async () => {
  const { a, b, start } = await pair(port);
  a.input(1, 'd', 1, 0, 0, 0.5, start.token);
  const acked = await a.waitFor(m => m.t === 's' && m.a[0] >= 1);
  assert.ok(acked.a[0] >= 1, 'ack advances with the consumed input');
  assert.ok(acked.tk > 0, 'snapshots carry a tick');
  // d on empty space still consumes the input but binds nothing
  assert.ok(acked.tp.every(r => r[0] !== 1), 'no touch bound on empty space');
  a.close(); b.close();
});

test('a dragged money is collected and scores', async () => {
  const { a, b, start } = await pair(port);
  // wait for the authority to spawn and activate something
  const withMoney = await a.waitFor(m => m.t === 's' && m.m.some(r => r[9] === 1), 8000);
  const row = withMoney.m.find(r => r[9] === 1);
  a.input(1, 'd', 1, row[2], row[3], 0.5, start.token);
  await a.waitFor(m => m.t === 's' && m.a[0] >= 1, 5000);   // 'd' consumed in its own tick
  a.input(2, 'm', 1, 0, -13, 0.5, start.token);             // drag toward the red vault
  await a.waitFor(m => m.t === 's' && m.a[0] >= 2, 5000);
  a.input(3, 'u', 1, 0, 0, 0, start.token);
  const ev = await a.waitFor(m => m.t === 'e' && m.evs.some(e => e.ev === 'collect'), 10000);
  assert.ok(ev.evs.some(e => e.ev === 'collect' && e.p === 1), 'red vault collected');
  const scored = await a.waitFor(m => m.t === 's' && m.sc[0] >= 1, 5000);
  assert.ok(scored.sc[0] >= 1, 'score reached the client');
  a.close(); b.close();
});

test('out-of-range, malformed and stale-token inputs are never acknowledged', async () => {
  const { a, b, start } = await pair(port);
  a.input(1, 'd', 1, 999, 999, 0.5, start.token);   // coords out of range
  a.input(2, 'd', 1, 0, 0, 1.5, start.token);       // sy out of range
  a.input(3, 'd', 1, 0, 0, 0.5, 'bogus');           // wrong token
  a.input(4, 'z', 1, 0, 0, 0.5, start.token);       // bad kind
  a.send({ t: 'i', seq: 5, k: 'u', token: start.token }); // missing pid
  a.send({ t: 'i', seq: 1.5, k: 'u', pid: 1, token: start.token }); // bad seq
  const snap = await a.waitFor(m => m.t === 's' && m.tk >= 4);
  assert.equal(snap.a[0], 0, 'invalid inputs are never acknowledged');
  a.close(); b.close();
});

test('u input without coords is accepted', async () => {
  const { a, b, start } = await pair(port);
  a.input(1, 'd', 1, 0, 0, 0.5, start.token);
  await a.waitFor(m => m.t === 's' && m.a[0] >= 1);
  a.send({ t: 'i', seq: 2, k: 'u', pid: 1, token: start.token });
  const acked = await a.waitFor(m => m.t === 's' && m.a[0] >= 2);
  assert.ok(acked.a[0] >= 2, 'u input acknowledged');
  a.close(); b.close();
});

test('a client on the wrong protocol version is turned away', async () => {
  const c = await connect(port);
  c.send({ t: 'join', v: srv.PROTOCOL - 1 });
  const ver = await c.waitFor(m => m.t === 'ver');
  assert.equal(ver.v, srv.PROTOCOL);
  c.close();
});

test('disconnect notifies the partner', async () => {
  const { a, b } = await pair(port);
  b.close();
  const left = await a.waitFor(m => m.t === 'opp_left');
  assert.equal(left.t, 'opp_left');
  a.close();
});

test('either player can restart the match', async () => {
  const { a, b, start } = await pair(port);
  a.send({ t: 'again' });
  const second = await a.waitFor(m => m.t === 'start' && m.token !== start.token, 4000);
  assert.notEqual(second.token, start.token);
  assert.equal(second.S.tick, 0);
  b.close(); a.close();
});
