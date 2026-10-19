'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Sim = require('../sim');

function run(ticks, sc, seed) {
  const S = Sim.create(seed);
  const states = [];
  for (let t = 1; t <= ticks; t++) {
    Sim.step(S, (sc && sc[t]) || []);
    states.push(Sim.dump(S));
  }
  return { S, states };
}
// force a freshly spawned money active at a known spot
function placeActive(S, m, x, y) {
  m.pos = [x, y, 0];
  m.direzione = [x, y, 0];
  m.state = 1;
  m.activateAtTick = 0;
  return m;
}

test('initial state', () => {
  const S = Sim.create();
  assert.equal(S.phase, 'playing');
  assert.deepEqual(S.scores, [0, 0]);
  assert.deepEqual(S.moneys, []);
  assert.deepEqual(S.touches, []);
  assert.equal(S.tick, 0);
  assert.equal(S.authority, true);
  assert.equal(S.moneyInPlay, 0);
});

test('deterministic replay of the same seed', () => {
  const a = run(200, null, 42);
  const b = run(200, null, 42);
  for (let i = 0; i < a.states.length; i++) assert.deepEqual(a.states[i], b.states[i], 'tick ' + (i + 1));
});

test('authority spawns money, non-authority never does', () => {
  const a = run(120, null, 42);
  assert.ok(a.S.moneys.length > 0, 'authority spawns within 120 ticks');
  const S = Sim.create(42);
  S.authority = false;
  for (let t = 0; t < 120; t++) Sim.step(S, []);
  assert.equal(S.moneys.length, 0);
});

test('money spawns pending and activates after the 1 s delay', () => {
  const S = Sim.create(42);
  let activateEv = null;
  for (let t = 0; t < 110 && !activateEv; t++) {
    const evs = Sim.step(S, []);
    activateEv = evs.find(e => e.ev === 'activate') || null;
  }
  assert.ok(S.moneys.length > 0, 'a money exists');
  assert.equal(S.moneys[0].state, 1, 'it is active');
  assert.ok(activateEv, 'an activate event was emitted');
  assert.equal(activateEv.mid, S.moneys[0].id);
  // 20 % bills on average: just check the type flag is boolean-ish
  assert.equal(typeof S.moneys[0].isBill, 'boolean');
});

test('d binds a touch on the money under the pointer', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [{ p: 1, k: 'd', pid: 1, x: 0, z: 0, sy: 0.5 }]);
  assert.equal(S.touches.length, 1);
  assert.equal(S.touches[0].mid, m.id);
  assert.equal(S.touches[0].p, 1);
  // move updates the touch, u removes it
  Sim.step(S, [{ p: 1, k: 'm', pid: 1, x: 2, z: 0, sy: 0.6 }]);
  assert.equal(S.touches[0].x, 2);
  assert.equal(S.touches[0].sy, 0.6);
  Sim.step(S, [{ p: 1, k: 'u', pid: 1 }]);
  assert.equal(S.touches.length, 0);
});

test('a bound touch pulls the money toward the finger', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [{ p: 1, k: 'd', pid: 1, x: 0, z: 2, sy: 0.5 }]);
  for (let t = 0; t < 40; t++) Sim.step(S, []);
  assert.ok(m.pos[1] > 1.5, 'coin moved up toward the touch, got ' + m.pos[1]);
});

test('tug-of-war: both players hooking the same coin pulls it to the centroid', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: -1.5, z: 0, sy: 0.2 },
    { p: 2, k: 'd', pid: 1, x: 1.5, z: 0, sy: 0.8 },
  ]);
  assert.equal(S.touches.length, 2);
  assert.equal(S.touches[1].mid, m.id, 'p2 hooked the same coin');
  // players drag their fingers to opposite sides; the coin follows the centroid
  Sim.step(S, [
    { p: 1, k: 'm', pid: 1, x: -3, z: -2, sy: 0.2 },
    { p: 2, k: 'm', pid: 1, x: 3, z: -2, sy: 0.8 },
  ]);
  for (let t = 0; t < 60; t++) Sim.step(S, []);
  assert.ok(Math.abs(m.pos[0]) < 0.5, 'opposing pulls cancel, got x ' + m.pos[0]);
  assert.ok(m.pos[1] < -1, 'coin follows the shared centroid, got y ' + m.pos[1]);
});

test('pointer caps: max 2 pointers per player', () => {
  const S = Sim.create(1);
  placeActive(S, Sim.spawnMoney(S, false), -5, 0);
  placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  placeActive(S, Sim.spawnMoney(S, false), 5, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: -5, z: 0, sy: 0.5 },
    { p: 1, k: 'd', pid: 2, x: 0, z: 0, sy: 0.5 },
    { p: 1, k: 'd', pid: 3, x: 5, z: 0, sy: 0.5 },
  ]);
  assert.equal(S.touches.length, 2);
  // the other player can still use two fingers
  Sim.step(S, [{ p: 2, k: 'd', pid: 1, x: 5, z: 0, sy: 0.5 }]);
  assert.equal(S.touches.length, 3);
});

test('money accepts at most 2 touches', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: 0, z: 0, sy: 0.5 },
    { p: 2, k: 'd', pid: 1, x: 0.5, z: 0.5, sy: 0.6 },
    { p: 2, k: 'd', pid: 2, x: 0, z: 0, sy: 0.5 },
  ]);
  assert.equal(S.touches.length, 2);
  assert.ok(S.touches.every(t => t.mid === m.id));
});

test('banknotes sort above coins when picking', () => {
  const S = Sim.create(1);
  const bill = placeActive(S, Sim.spawnMoney(S, true), 0, 0);
  placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [{ p: 1, k: 'd', pid: 1, x: 0, z: 0, sy: 0.5 }]);
  assert.equal(S.touches[0].mid, bill.id);
});

test('d on empty space creates no touch; inputs are ignored once the game is over', () => {
  const S = Sim.create(1);
  placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [{ p: 1, k: 'd', pid: 1, x: 12, z: 12, sy: 0.5 }]);
  assert.equal(S.touches.length, 0);
  S.phase = 'over';
  Sim.step(S, [{ p: 1, k: 'd', pid: 2, x: 0, z: 0, sy: 0.5 }]);
  assert.equal(S.touches.length, 0);
});

test('reaching a safe collects: tween, score, events, prune', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, -14.89);
  const evs = Sim.step(S, []);
  assert.equal(m.state, 2, 'money is collecting');
  assert.equal(S.moneyInPlay, 0, 'moneyInPlay decremented at collect');
  assert.ok(evs.some(e => e.ev === 'collect' && e.p === 1), 'collect event for the red safe');
  assert.ok(evs.some(e => e.ev === 'point' && e.p === 1 && e.pts === 1), 'point event with 1 pt');
  assert.equal(S.scores[0], 1);
  for (let t = 0; t < 26; t++) Sim.step(S, []);
  assert.equal(S.moneys.length, 0, 'finished tween is pruned');
  assert.equal(S.moneyInPlay, 0);
});

test('banknotes score 3', () => {
  const S = Sim.create(1);
  placeActive(S, Sim.spawnMoney(S, true), 0, -14.89);
  Sim.step(S, []);
  assert.equal(S.scores[0], 3);
});

test('first to 15 wins and clears touches', () => {
  const S = Sim.create(1);
  placeActive(S, Sim.spawnMoney(S, false), 0, -14.89);
  S.scores[0] = 14;                        // the collect below fires the winning point
  const evs = Sim.step(S, [{ p: 1, k: 'd', pid: 1, x: 0, z: -14, sy: 0.5 }]);
  assert.equal(S.scores[0], 15);
  assert.equal(S.phase, 'over');
  assert.equal(S.winner, 1);
  assert.deepEqual(S.touches, [], 'all touches cleared on win');
  assert.ok(evs.some(e => e.ev === 'win' && e.p === 1));
  assert.ok(evs.some(e => e.ev === 'point' && e.p === 1));
});

test('a bill stretched past the tear threshold rips for nobody', () => {
  const S = Sim.create(1);
  const bill = placeActive(S, Sim.spawnMoney(S, true), 0, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: -1, z: 0, sy: 0.1 },
    { p: 2, k: 'd', pid: 1, x: 1, z: 0, sy: 0.9 },
  ]);
  bill.meshY = 1.75;
  const evs = Sim.step(S, []);
  const tear = evs.find(e => e.ev === 'tear');
  assert.ok(tear, 'tear event emitted');
  assert.equal(tear.mid, bill.id);
  assert.equal(bill.state, 3);
  assert.equal(S.scores[0] + S.scores[1], 0, 'nobody scores a torn bill');
  Sim.step(S, []);
  assert.equal(S.moneys.length, 0, 'torn bill pruned');
  assert.deepEqual(S.touches, [], 'its touches were released');
});

test('two human fingers stretching a moderate gap never tears (shipped behaviour)', () => {
  const S = Sim.create(1);
  const bill = placeActive(S, Sim.spawnMoney(S, true), 0, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: 0, z: 0, sy: 0.3 },
    { p: 2, k: 'd', pid: 1, x: 0, z: 0, sy: 0.7 },
  ]);
  for (let t = 0; t < 200; t++) Sim.step(S, []);
  assert.ok(bill.meshY > 1.2, 'the bill visibly stretched, got ' + bill.meshY);
  assert.ok(bill.meshY <= 1.7, 'meshY settles below the tear threshold, got ' + bill.meshY);
  assert.equal(bill.state, 1);
});

test('invalid inputs are ignored by the sim', () => {
  const S = Sim.create(1);
  placeActive(S, Sim.spawnMoney(S, false), 0, 0);
  Sim.step(S, [
    { p: 1, k: 'd', pid: 1, x: 99, z: 0, sy: 0.5 },   // out of range
    { p: 1, k: 'd', pid: 1, x: 0, z: 0, sy: 1.5 },    // sy out of range
    { p: 1, k: 'd', pid: 1.5, x: 0, z: 0, sy: 0.5 },  // pid not an integer
    { p: 3, k: 'd', pid: 1, x: 0, z: 0, sy: 0.5 },    // no such player
    { p: 1, k: 'x', pid: 1, x: 0, z: 0, sy: 0.5 },    // bad kind
  ]);
  assert.equal(S.touches.length, 0);
});

test('dump/load round-trip resumes identically', () => {
  const full = run(200, null, 42);
  const S = Sim.load(full.states[99]);
  assert.deepEqual(Sim.dump(S), full.states[99]);
  for (let t = 101; t <= 200; t++) {
    Sim.step(S, []);
    assert.deepEqual(Sim.dump(S), full.states[t - 1], 'tick ' + t);
  }
});

test('wire snapshot round-trip keeps common money close', () => {
  const full = run(200, null, 42);
  const wire = Sim.snapshot(full.S);
  const C = Sim.create();
  C.authority = false;                     // clients adopt, never spawn
  Sim.applySnapshot(C, wire);
  assert.equal(C.tick, full.S.tick);
  assert.deepEqual(C.touches, full.S.touches.map(t => ({ p: t.p, pid: t.pid, mid: t.mid, x: t.x, z: t.z, sy: t.sy })));
  for (let i = 0; i < 30; i++) { Sim.step(C, []); Sim.step(full.S, []); }
  let maxErr = 0;
  for (const m of full.S.moneys) {
    const c = C.moneys.find(x => x.id === m.id);
    if (!c) continue;
    const err = Math.sqrt((m.pos[0] - c.pos[0]) ** 2 + (m.pos[1] - c.pos[1]) ** 2);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 0.2, 'divergence from 2-decimal snapshots should stay small, got ' + maxErr);
});

test('applySnapshot rebuilds collecting state and pending timers', () => {
  const S = Sim.create(1);
  const m = placeActive(S, Sim.spawnMoney(S, false), 0, -14.89);
  Sim.step(S, []);                          // -> state 2
  const wire = Sim.snapshot(S);
  const C = Sim.create();
  C.authority = false;
  Sim.applySnapshot(C, wire);
  const c = C.moneys[0];
  assert.equal(c.state, 2);
  assert.ok(c.collect && c.collect.safe === 0);
  assert.deepEqual(c.collect.to, [0, -14.89]);
  assert.equal(C.scores[0], 1);
  // pending money keeps its activation tick and dirSign
  const S2 = Sim.create(42);
  Sim.step(S2, []);                         // no spawn yet
  const p = Sim.spawnMoney(S2, true);
  const wire2 = Sim.snapshot(S2);
  const C2 = Sim.create();
  C2.authority = false;
  Sim.applySnapshot(C2, wire2);
  assert.equal(C2.moneys[0].state, 0);
  assert.equal(C2.moneys[0].activateAtTick, p.activateAtTick);
  assert.equal(C2.moneys[0].dirSign, p.dirSign);
  const evs = [];
  for (let t = 0; t < 60; t++) evs.push(...Sim.step(C2, []));
  assert.ok(evs.some(e => e.ev === 'activate'), 'adopted pending money activates on the client too');
});

test('determinism hygiene: no Math.hypot / Math.random in the sim', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sim.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/Math\.hypot\(/.test(code), 'sim.js must not use Math.hypot');
  assert.ok(!/Math\.random\(/.test(code), 'sim.js must not use Math.random');
});
