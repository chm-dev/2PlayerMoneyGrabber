'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const Sim = require('../sim');
const srv = require('../server');

const MAX_INPUTS_PER_TICK = 8;
class Bot {
  constructor(ws) { this.ws = ws; this.msgs = []; this.waiters = []; ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } this.msgs.push(m); this.pump(); }); }
  pump() { for (const w of this.waiters.slice()) { const m = this.msgs.find(w.pred); if (m) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.to); w.res(m); } } }
  waitFor(pred, timeout = 5000) { const w = { pred, res: null, to: null }; return new Promise((res, rej) => { w.res = res; w.to = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout')); }, timeout); this.waiters.push(w); this.pump(); }); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch (e) {} }
}
function connect(port) { return new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:' + port); ws.on('open', () => resolve(new Bot(ws))); ws.on('error', reject); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// mirrors game.js: input log + fixed-step prediction + reconcile with replay
function makeClient(start) {
  const c = { P: Sim.load(start.S), token: start.token, seq: 0, inputs: [], maxErr: 0, snaps: 0 };
  c.P.authority = false;
  c.send = (k, pid, x, z, sy) => {
    c.seq++;
    const e = { seq: c.seq, p: 1, k, pid, x: x || 0, z: z || 0, sy: sy === undefined ? 0.5 : sy, tick: c.P.tick, used: false };
    c.inputs.push(e);
    c.ws.send({ t: 'i', seq: e.seq, k, pid, x: e.x, z: e.z, sy: e.sy, token: c.token }); // Bot.send stringifies
  };
  c.tick = () => {
    const t = c.P.tick + 1, batch = [];
    for (let i = 0; i < c.inputs.length && batch.length < MAX_INPUTS_PER_TICK; i++) {
      const e = c.inputs[i];
      if (!e.used && e.tick <= t) { e.used = true; batch.push(e); }
    }
    Sim.step(c.P, batch);
    c.P.events.length = 0;
  };
  c.onSnapshot = m => {
    c.snaps++;
    const A = m.a[0];
    const Tc = c.P.tick;
    const pre = new Map();
    for (const mo of c.P.moneys) pre.set(mo.id, [mo.pos[0], mo.pos[1]]);
    for (let i = c.inputs.length - 1; i >= 0; i--) if (c.inputs[i].seq <= A) c.inputs.splice(i, 1);
    Sim.applySnapshot(c.P, m);
    for (const e of c.inputs) { e.used = false; if (e.tick <= m.tk) e.tick = m.tk + 1; }
    c.inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
    let idx = 0;
    for (let t = m.tk + 1; t <= Tc; t++) {
      const batch = [];
      while (idx < c.inputs.length && c.inputs[idx].tick <= t && batch.length < MAX_INPUTS_PER_TICK) { c.inputs[idx].used = true; batch.push(c.inputs[idx]); idx++; }
      Sim.step(c.P, batch);
    }
    c.P.events.length = 0;
    // divergence between the predicted position and the authority's position,
    // measured only when the local tick is within 2 of the snapshot tick so
    // clock skew between the bot loop and the server loop doesn't dominate
    if (Tc - m.tk <= 2) {
      for (const row of m.m) {
        const p0 = pre.get(row[0]);
        if (!p0) continue;
        const err = Math.sqrt((p0[0] - row[2]) ** 2 + (p0[1] - row[3]) ** 2);
        if (err > c.maxErr) c.maxErr = err;
      }
    }
  };
  return c;
}

let port;
test.before(async () => { port = await srv.start(0); });
test.after(async () => { await srv.stop(); });

test('a predicting client tracks the authoritative money during play', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  const start = await a.waitFor(m => m.t === 'start');
  const bot = makeClient(start);
  bot.ws = a;
  let lastRow = null;
  a.ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t !== 's') return;
    bot.onSnapshot(m);
    if (bot.mid != null) { const r = m.m.find(r => r[0] === bot.mid); if (r) lastRow = r; }
  });

  // wait for the authority to spawn and activate something, then grab and drag it
  const withMoney = await a.waitFor(m => m.t === 's' && m.m.some(r => r[9] === 1), 8000);
  const row = withMoney.m.find(r => r[9] === 1);
  bot.mid = row[0];
  bot.send('d', 1, row[2], row[3], 0.5);
  await sleep(20);
  for (let i = 0; i < 20; i++) { bot.send('m', 1, 0, -7, 0.5); bot.tick(); await sleep(20); }
  bot.send('u', 1);
  for (let i = 0; i < 200; i++) { bot.tick(); await sleep(20); }

  assert.ok(bot.snaps > 20, 'expected a stream of snapshots, got ' + bot.snaps);
  assert.ok(bot.inputs.length < 5, 'acknowledged inputs should be pruned, left ' + bot.inputs.length);
  assert.ok(bot.maxErr < 2, 'prediction diverged from authority by ' + bot.maxErr.toFixed(2));
  assert.ok(lastRow, 'the grabbed money stayed in the snapshots');
  const dist = Math.sqrt((lastRow[2] - 0) ** 2 + (lastRow[3] - -7) ** 2);
  assert.ok(dist < 1, 'dragged money settled near the target, got ' + dist.toFixed(2));
  a.close(); b.close();
});
