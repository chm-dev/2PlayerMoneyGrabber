'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function stubTarget() {}
const stub = new Proxy(stubTarget, {
  get: (t, k) => {
    if (k === Symbol.toPrimitive) return () => 0;
    if (k === 'toString') return () => '';
    if (k === 'valueOf') return () => 0;
    return stub;
  },
  set: () => true,
  apply: () => stub,
});
function makeEl() {
  return {
    style: {}, textContent: '', disabled: false, onclick: null, src: '',
    classList: { add() {}, remove() {}, contains: () => false },
    width: 100, height: 100,
    getContext: () => new Proxy({}, { get: (t, k) => stub, set: (t, k, v) => { t[k] = v; return true; } }),
    addEventListener() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
}

test('game.js boots against a stubbed DOM and exposes its handle', async () => {
  const els = new Map();
  let raf = null;
  global.window = global;
  global.document = { getElementById: id => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); }, createElement: () => makeEl() };
  global.location = { search: '?lat=40&jit=10', protocol: 'http:', host: 'localhost:8080' };
  global.devicePixelRatio = 2;
  global.innerWidth = 800; global.innerHeight = 1200;
  global.addEventListener = () => {};
  global.requestAnimationFrame = cb => { raf = cb; };
  global.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
  global.Sim = require('../sim');
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'lib', 'snapshot-interpolation.js'), 'utf8'));
  assert.ok(global.Snap && global.Snap.SnapshotInterpolation, 'Snap global should be defined');

  require('../game.js');

  assert.ok(global.__moneyGrabber, 'game.js should expose window.__moneyGrabber');
  assert.equal(global.__moneyGrabber.P, null, 'no prediction state before a match');
  assert.equal(global.__moneyGrabber.UI.phase, 'menu');

  await new Promise(r => setTimeout(r, 5));
  assert.equal(typeof raf, 'function', 'the frame loop should be scheduled');
  raf(16);
  raf(32);
  assert.equal(global.__moneyGrabber.UI.phase, 'menu');
});
