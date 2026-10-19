'use strict';
// Money Grabber (Rubasoldi) — online-only client (netcode plan). Server-authoritative.
// Rendering is ported from the original local game; input, flow and prediction are new.
const Sim = window.Sim;
const $ = id => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');

// ------------------------------------------------------------------ constants
const CAM_SIZE = 15;                     // Camera.orthographicSize
const DESIGN_ASPECT = 1080 / 2340;       // portrait framing of the shipped build
const BG = '#6D463C';
const FIXED = Sim.FIXED;                 // 1/50
const TEAR = { force: 700, fade: 1.5 };  // BanconotaStrappata.potenzaGravita / Alpha time
const RED = Sim.RED;
const BLUE = Sim.BLUE;
const SAFES = [
  { pos: Sim.SAFES[0].pos, angle: Sim.SAFES[0].angle, colour: RED },
  { pos: Sim.SAFES[1].pos, angle: Sim.SAFES[1].angle, colour: BLUE },
];

const MAX_INPUTS_PER_TICK = 8;
const SMOOTH_RATE = 10;                  // reconciliation error decay
const SNAP_DIST = 1.0;                   // beyond this, hard re-sync

// sprite textures + world size of the sprite rect + offset of the visible content centre
// Cassaforte sprite (4480): 488x440 px at 100 ppu, pivot (0.5187, 0.0589)
const SAFE_SPRITE = { w: 4.87848, h: 4.39848, ax: -0.095753, ay: 2.138658 };
const SPRITES = {
  safe: { file: 'Cassaforte_4480.png', w: SAFE_SPRITE.w, h: SAFE_SPRITE.h, ax: SAFE_SPRITE.ax, ay: SAFE_SPRITE.ay },
  coin: { file: 'Rubasoldi_Moneta_4417.png', w: 2.92791, h: 2.92791, ax: 0, ay: 0 },
  bill: { file: 'Rubasoldi_Banconota_4899.png', w: 2.56, h: 5.12, ax: 0, ay: 0 },
  paw: { file: 'ZampaGatto_4505.png', w: 3.06848, h: 3.09858, ax: 0, ay: 0 },
  dot: { file: 'Cerchio_1024_22.png', w: 10.24, h: 10.24, ax: 0, ay: 0 },
  tearTop: { file: 'Banconota_Sopra_4389.png', w: 3.5, h: 4.266667, ax: 0, ay: 0 },
  tearBot: { file: 'Banconota_Sotto_4588.png', w: 3.50391, h: 3.90077, ax: 0, ay: 0 },
};

const QS = new URLSearchParams(location.search);
const DEV_LAT = Math.max(0, +QS.get('lat') || 0);
const DEV_JIT = Math.max(0, +QS.get('jit') || 0);

// ------------------------------------------------------------------ math
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = v => clamp(v, 0, 1);
const rand = (a, b) => a + Math.random() * (b - a);
const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const rgb = c => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

// ------------------------------------------------------------------ assets
const IMGS = {};
const tintCache = new Map();
function loadAll() {
  const ps = Object.entries(SPRITES).map(([k, s]) => new Promise(res => {
    const i = new Image();
    i.onload = () => { IMGS[k] = i; res(); };
    i.onerror = () => res();
    i.src = 'assets/' + s.file;
  }));
  return Promise.all(ps);
}
function tinted(img, colour) {
  const key = img.src + colour;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = colour; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);
  tintCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ audio
let audioCtx = null;
const sounds = {};
function initAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    for (const [key, file] of [['soldi', 'assets/soldi.wav'], ['strappo', 'assets/strappo.wav']]) {
      fetch(file)
        .then(r => r.arrayBuffer())
        .then(b => audioCtx.decodeAudioData(b))
        .then(buf => { sounds[key] = buf; })
        .catch(() => {});
    }
  } catch (e) { audioCtx = null; }
}
// AudioManager.Play(clip, pitch 1, randomPitch 0, volume, ...)
function playSound(name, volume) {
  if (!audioCtx || !sounds[name]) return;
  const s = audioCtx.createBufferSource();
  s.buffer = sounds[name];
  s.playbackRate.value = 1;
  const g = audioCtx.createGain();
  g.gain.value = volume;
  s.connect(g); g.connect(audioCtx.destination);
  s.start();
}

// ------------------------------------------------------------------ net state
const NET = { ws: null, connecting: false, pingTimer: null, rtt: 0, offset: null, snapLast: 0, jitter: 0, snapCount: 0, snapRate: 0, corrections: 0 };
const MY = { role: 0, seq: 0, token: null };
let P = null;                              // predicted sim state (null in menu)
const inputs = [];                         // local input log
const SNAP = new Snap.SnapshotInterpolation(25);   // opponent touch interpolation (~120 ms)
const smoothMap = new Map();               // money id -> {x, y} reconciliation offset
const localPtr = new Map();                // pointerId -> {x, z, sy} latest local finger
const lastMoveSend = new Map();            // pointerId -> ms of last 'm' send
const lastTp = new Map();                  // 'p:pid' -> {p, mid} from the newest snapshot
let oppRender = [];                        // interpolated opponent touches [{p, pid, x, z}]
const UI = { phase: 'menu', scores: [0, 0], winner: 0 };
let overShown = false;
let hudLast = 0;

// client-side visuals driven by authoritative events
const tears = [];
const sparks = [];
const punches = [0, 0];                    // safe punch timers (seconds, 0 = idle)

// dev latency queues
const outQ = [], inQ = []; let outAt = 0, inAt = 0;
function rawSend(m) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); }
function netSend(m) {
  if (!DEV_LAT && !DEV_JIT) return rawSend(m);
  const now = performance.now();
  outAt = Math.max(outAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
  outQ.push({ at: outAt, m });
}
function netConnect() {
  NET.connecting = true;
  let url;
  if (location.protocol.startsWith('http')) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  else url = 'ws://localhost:8080';
  try { NET.ws = new WebSocket(url); } catch (e) { netFail('Connection failed'); return; }
  NET.ws.onopen = () => { rawSend({ t: 'join', v: 1 }); $('netStatus').textContent = 'Waiting for opponent…'; };
  NET.ws.onmessage = e => {
    if (DEV_LAT || DEV_JIT) {
      const now = performance.now();
      inAt = Math.max(inAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
      inQ.push({ at: inAt, s: e.data });
    } else { try { netMessage(JSON.parse(e.data)); } catch (err) {} }
  };
  NET.ws.onclose = netClosed;
  NET.ws.onerror = () => {};
}
function netFail(msg) { NET.connecting = false; menuButtons(false); $('netStatus').textContent = msg; }
function netClosed() {
  NET.ws = null;
  if (MY.role) return netToMenu('Connection lost');
  if (NET.connecting) netFail('Connection failed');
}
function netToMenu(msg) {
  MY.role = 0; MY.token = null; MY.seq = 0;
  P = null; inputs.length = 0;
  localPtr.clear(); lastMoveSend.clear(); lastTp.clear();
  smoothMap.clear(); oppRender = [];
  tears.length = 0; sparks.length = 0; punches[0] = punches[1] = 0;
  overShown = false; hudLast = 0;
  clearInterval(NET.pingTimer); NET.pingTimer = null;
  outQ.length = 0; inQ.length = 0;
  if (NET.ws) { const ws = NET.ws; NET.ws = null; try { ws.close(); } catch (e) {} }
  UI.phase = 'menu'; UI.winner = 0;
  $('hud').style.display = 'none'; $('ping').style.display = 'none';
  $('over').classList.add('hidden'); $('menu').classList.remove('hidden');
  menuButtons(false);
  $('netStatus').textContent = msg;
}
function menuButtons(disabled) { const el = $('b2o'); if (el) el.disabled = disabled; }
function netMessage(m) {
  switch (m.t) {
    case 'room': NET.connecting = false; MY.role = m.role === 'p1' ? 1 : 2; break;
    case 'start': startMatch(m); break;
    case 's': if (P) onSnapshot(m); break;
    case 'e': if (P) onEvents(m); break;
    case 'pong': {
      NET.rtt = Math.max(0, Math.round(performance.now() - m.ts));
      if (typeof m.time === 'number') { const off = m.time + NET.rtt / 2 - Date.now(); NET.offset = NET.offset === null ? off : NET.offset + (off - NET.offset) * 0.1; }
      const el = $('ping'); el.style.display = 'block'; el.textContent = NET.rtt + ' ms';
      break;
    }
    case 'opp_left': netToMenu('Opponent left'); break;
    case 'ver': netFail('Please refresh — the server was updated'); break;
  }
}
function pingServer() { netSend({ t: 'ping', ts: performance.now() }); }

// ------------------------------------------------------------------ match start
function startMatch(m) {
  MY.token = m.token;
  P = Sim.load(m.S);
  P.authority = false;                     // clients never spawn
  inputs.length = 0; MY.seq = 0;
  localPtr.clear(); lastMoveSend.clear(); lastTp.clear();
  smoothMap.clear(); oppRender = [];
  tears.length = 0; sparks.length = 0; punches[0] = punches[1] = 0;
  overShown = false; NET.corrections = 0; hudLast = 0;
  SNAP.vault.clear();
  UI.phase = P.phase; UI.scores = [P.scores[0], P.scores[1]]; UI.winner = P.winner;
  acc = 0;
  $('menu').classList.add('hidden'); $('over').classList.add('hidden');
  $('netStatus').textContent = '';
  $('hud').style.display = 'block';
  clearInterval(NET.pingTimer);
  NET.pingTimer = setInterval(pingServer, 2000);
  pingServer();
}

// ------------------------------------------------------------------ input stream
function sendInput(k, pid, x, z, sy) {
  if (!MY.role || !MY.token || !P) return;
  MY.seq++;
  const e = {
    seq: MY.seq, p: MY.role, k, pid,
    x: x === undefined ? 0 : r2(x), z: z === undefined ? 0 : r2(z), sy: sy === undefined ? 0 : r3(sy),
    tick: P.tick, used: false,
  };
  inputs.push(e);
  if (inputs.length > 240) inputs.splice(0, inputs.length - 240);
  netSend({ t: 'i', seq: e.seq, k, pid, x: e.x, z: e.z, sy: e.sy, token: MY.token });
}

// ------------------------------------------------------------------ prediction
function simTick() {
  const t = P.tick + 1;
  const batch = [];
  for (let i = 0; i < inputs.length && batch.length < MAX_INPUTS_PER_TICK; i++) {
    const e = inputs[i];
    if (!e.used && e.tick <= t) { e.used = true; batch.push(e); }
  }
  Sim.step(P, batch);
  P.events.length = 0;   // prediction never emits effects (no double audio)
}

function onSnapshot(m) {
  const now = performance.now();
  if (NET.snapLast) { const d = Math.abs((now - NET.snapLast) - (1000 / 25)); NET.jitter += (d - NET.jitter) * 0.1; }
  NET.snapLast = now; NET.snapCount++;
  lastTp.clear();
  for (const r of m.tp) {
    lastTp.set(r[0] + ':' + r[1], { p: r[0], mid: r[2] });
    if (r[0] === MY.role) continue;        // own touches come from prediction
    const key = 't' + r[0] + '_' + r[1];
    SNAP.snapshot.add({ id: key, time: m.tm, state: [{ id: key, x: r[3], z: r[4] }] });
  }
  UI.phase = m.ph; UI.scores = [m.sc[0], m.sc[1]]; UI.winner = m.w;
  reconcile(m);
  if (m.ph === 'over' && !overShown) {
    overShown = true;
    setTimeout(() => {
      if (!P || UI.phase !== 'over') return;
      $('overTitle').textContent = UI.winner === MY.role ? 'You win!' : 'You lose';
      $('over').classList.remove('hidden');
    }, 600);
  }
}

function reconcile(m) {
  const A = (m.a && m.a[MY.role - 1]) || 0;
  const Tc = P.tick;
  const pre = new Map();                   // money positions before reconciliation
  for (const mo of P.moneys) pre.set(mo.id, [mo.pos[0], mo.pos[1]]);
  for (let i = inputs.length - 1; i >= 0; i--) if (inputs[i].seq <= A) inputs.splice(i, 1);
  Sim.applySnapshot(P, m);
  for (const e of inputs) { e.used = false; if (e.tick <= m.tk) e.tick = m.tk + 1; }
  inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  let idx = 0;
  for (let t = m.tk + 1; t <= Tc; t++) {
    const batch = [];
    while (idx < inputs.length && inputs[idx].tick <= t && batch.length < MAX_INPUTS_PER_TICK) { inputs[idx].used = true; batch.push(inputs[idx]); idx++; }
    Sim.step(P, batch);
  }
  P.events.length = 0;
  // fold per-money position error into render offsets
  for (const mo of P.moneys) {
    const p0 = pre.get(mo.id);
    if (!p0) continue;
    let sm = smoothMap.get(mo.id);
    if (!sm) { sm = { x: 0, y: 0 }; smoothMap.set(mo.id, sm); }
    sm.x += p0[0] - mo.pos[0];
    sm.y += p0[1] - mo.pos[1];
    if (Math.sqrt(sm.x * sm.x + sm.y * sm.y) > SNAP_DIST) { sm.x = 0; sm.y = 0; NET.corrections++; }
  }
  for (const id of [...smoothMap.keys()]) if (!P.moneys.some(mo => mo.id === id)) smoothMap.delete(id);
  // trust the local finger: the server's view of own touches is half an RTT late
  for (const t of P.touches) {
    if (t.p !== MY.role) continue;
    const lp = localPtr.get(t.pid);
    if (lp) { t.x = lp.x; t.z = lp.z; t.sy = lp.sy; }
  }
}

function onEvents(m) {
  for (const ev of m.evs) {
    if (ev.ev === 'collect') { playSound('soldi', 0.6); punches[ev.p - 1] = 1e-4; }
    else if (ev.ev === 'tear') { playSound('strappo', 0.5); spawnTearPieces(ev); }
    else if (ev.ev === 'activate') { burst(ev.x, ev.y); }
  }
}

// ------------------------------------------------------------------ input (Touchable)
function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  const sx = ((e.clientX - r.left) / r.width) * W;
  const syp = ((e.clientY - r.top) / r.height) * H;
  let wx, wy;
  if (MY.role === 2) { wx = (W / 2 - sx) / S; wy = (syp - H / 2) / S; }
  else { wx = (sx - W / 2) / S; wy = (H / 2 - syp) / S; }
  return [clamp(wx, -halfW, halfW), clamp(wy, -CAM_SIZE, CAM_SIZE), 0];
}
// canonical screen y: 1 = blue side (world top) for both roles
function canonicalY(e) {
  const r = canvas.getBoundingClientRect();
  const vy = 1 - (e.clientY - r.top) / r.height;
  return MY.role === 2 ? 1 - vy : vy;
}

canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (!P || P.phase !== 'playing') return;
  const [x, z] = toWorld(e);
  const sy = canonicalY(e);
  localPtr.set(e.pointerId, { x, z, sy });
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers */ }
  sendInput('d', e.pointerId, x, z, sy);
  lastMoveSend.set(e.pointerId, performance.now());
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  const lp = localPtr.get(e.pointerId);
  if (!lp) return;
  const [x, z] = toWorld(e);
  lp.x = x; lp.z = z; lp.sy = canonicalY(e);
  const now = performance.now();
  const lm = lastMoveSend.get(e.pointerId) || 0;
  if (now - lm >= 16) { sendInput('m', e.pointerId, x, z, lp.sy); lastMoveSend.set(e.pointerId, now); }
  e.preventDefault();
});
function releaseTouch(e) {
  if (!localPtr.has(e.pointerId)) return;
  localPtr.delete(e.pointerId);
  lastMoveSend.delete(e.pointerId);
  sendInput('u', e.pointerId);
}
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);
canvas.addEventListener('lostpointercapture', releaseTouch);

// ------------------------------------------------------------------ client-side particles
// ParticellaSpawn: burst of 10, circle radius 1, speed 20, lifetime 0.5
function burst(x, y) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({
      x: x + Math.cos(a), y: y + Math.sin(a),
      vx: Math.cos(a) * 20, vy: Math.sin(a) * 20,
      age: 0, life: 0.5, warm: Math.random() < 0.5,
    });
  }
}
// BanconotaStrappata.Start — pieces rebuilt from the authoritative tear event
function spawnTearPieces(ev) {
  const ang = ev.ang, sy = ev.meshY;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pieces = [
    { spr: 'tearTop', y: 1.5, w: 3.5 * 0.7, h: 4.266667 * 0.7, dir: 1 },
    { spr: 'tearBot', y: -0.527, w: 3.50391 * 0.7, h: 3.90077 * 0.7, dir: -1 },
  ];
  for (const p of pieces) {
    const oy = p.y * sy;
    tears.push({
      spr: p.spr,
      x: ev.x - oy * sa,
      y: ev.y + oy * ca,
      vx: ev.ux * TEAR.force * FIXED * p.dir,
      vy: ev.uy * TEAR.force * FIXED * p.dir,
      ang, w: p.w, h: p.h * sy, alpha: 1, age: 0,
    });
  }
}
function updateClientFx(dt) {
  for (const s of sparks) { s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; }
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age >= sparks[i].life) sparks.splice(i, 1);
  for (const t of tears) { t.age += dt; t.x += t.vx * dt; t.y += t.vy * dt; t.alpha = Math.max(0, 1 - t.age / TEAR.fade); }
  for (let i = tears.length - 1; i >= 0; i--) if (tears[i].age >= TEAR.fade) tears.splice(i, 1);
  for (let i = 0; i < 2; i++) {
    if (punches[i] > 0) { punches[i] += dt; if (punches[i] >= 0.3) punches[i] = 0; }
  }
}

// ------------------------------------------------------------------ view
let W = 0, H = 0, S = 1, halfW = CAM_SIZE * DESIGN_ASPECT, dpr = 1;
function resize() {
  const vw = innerWidth, vh = innerHeight;
  const w = Math.min(vw, vh * DESIGN_ASPECT);
  const h = w / DESIGN_ASPECT;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const st = $('stage');
  st.style.width = w + 'px';
  st.style.height = h + 'px';
  W = canvas.width; H = canvas.height;
  S = H / (CAM_SIZE * 2);
  halfW = (W / H) * CAM_SIZE;
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ drawing
function drawSprite(name, x, y, angle, w, h, opt = {}) {
  const img = IMGS[name];
  if (!img) return;
  const s = SPRITES[name];
  const ax = opt.ax == null ? s.ax : opt.ax;
  const ay = opt.ay == null ? s.ay : opt.ay;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const cx = x + ax * ca - ay * sa;
  const cy = y + ax * sa + ay * ca;
  ctx.save();
  ctx.translate(cx, cy);
  if (angle) ctx.rotate(angle);
  ctx.scale(1, -1);
  ctx.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
  ctx.drawImage(opt.tint ? tinted(img, opt.tint) : img, -(w == null ? s.w : w) / 2, -(h == null ? s.h : h) / 2,
    w == null ? s.w : w, h == null ? s.h : h);
  ctx.restore();
}
function drawLine(x1, y1, x2, y2, width, colour) {
  ctx.strokeStyle = rgb(colour);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function moneyRenderPos(m) {
  const sm = smoothMap.get(m.id);
  return [m.pos[0] + (sm ? sm.x : 0), m.pos[1] + (sm ? sm.y : 0)];
}
function drawMoney(m) {
  if (m.state === 0) return;               // pending money is invisible
  const rp = moneyRenderPos(m);
  let scale = 1, alpha = 1;
  if (m.state === 2 && m.collect) {        // suck-in tween: derive pose from t
    const k = clamp01(m.collect.t / Sim.COLLECT_TIME);
    const e = k * k * (3 - 2 * k);
    scale = 1 - e; alpha = 1 - k;
  }
  const ang = Sim.moneyAngle(m);
  if (m.isBill) {
    drawSprite('bill', rp[0], rp[1], ang, 2.56 * scale, 5.12 * m.meshY * scale, { alpha });
  } else {
    drawSprite('coin', rp[0], rp[1], ang, 2.92791 * scale, 2.92791 * scale, { alpha });
  }
}

// RampinoRubasoldi: Fune 75, Inizio 80/85, Zampa 100 — three draw passes.
// Hooks are player-coloured online (red player, blue player) instead of pull-direction.
function collectHooks() {
  const hooks = [];
  if (!P) return hooks;
  for (const t of P.touches) {
    const m = P.moneys.find(mo => mo.id === t.mid);
    if (!m || m.state !== 1) continue;
    hooks.push({ dito: [t.x, t.z], zampa: moneyRenderPos(m), colour: t.p === 1 ? RED : BLUE });
  }
  for (const ot of oppRender) {
    const lt = lastTp.get(ot.p + ':' + ot.pid);
    if (!lt) continue;
    const m = P.moneys.find(mo => mo.id === lt.mid);
    if (!m || m.state !== 1) continue;
    hooks.push({ dito: [ot.x, ot.z], zampa: moneyRenderPos(m), colour: ot.p === 1 ? RED : BLUE });
  }
  return hooks;
}
function drawHooks() {
  const hooks = collectHooks();
  for (const h of hooks) drawLine(h.dito[0], h.dito[1], h.zampa[0], h.zampa[1], 0.7, h.colour);
  for (const h of hooks) drawSprite('dot', h.dito[0], h.dito[1], 0, 10.24 * 0.2, 10.24 * 0.2, { tint: '#000' });
  for (const h of hooks) drawSprite('dot', h.dito[0], h.dito[1], 0, 10.24 * 0.15, 10.24 * 0.15, { tint: rgb(h.colour) });
  for (const h of hooks) {
    const dx = h.zampa[0] - h.dito[0], dy = h.zampa[1] - h.dito[1];
    const len = Math.hypot(dx, dy);
    const dir = len > 1e-5 ? [dx / len, dy / len] : [0, 1];
    drawSprite('paw', h.zampa[0], h.zampa[1], Math.atan2(-dir[0], dir[1]),
      3.06848 * 0.8, 3.09858 * 0.8, { tint: rgb(h.colour) });
  }
}

let sparkDot = null, sparkDotWarm = null;
function makeSparks() {
  const make = colour => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, colour.replace('ALPHA', '1'));
    grd.addColorStop(0.45, colour.replace('ALPHA', '0.95'));
    grd.addColorStop(1, colour.replace('ALPHA', '0'));
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return c;
  };
  sparkDot = make('rgba(255,255,255,ALPHA)');
  sparkDotWarm = make('rgba(219,213,110,ALPHA)');
}

function drawHud() {
  const flip = MY.role === 2;
  const x = flip ? halfW - 0.95 : -halfW + 0.95;
  for (const [i, y] of [[1, 13.5], [0, -13.5]]) {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.rotate(Math.PI);
    ctx.scale(1, -1);
    ctx.fillStyle = rgb(SAFES[i].colour);
    ctx.beginPath();
    ctx.arc(-0.75, 0, 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 1.7px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 0.14;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.fillStyle = '#fff';
    const v = String(UI.scores[i]);
    ctx.strokeText(v, 0, 0);
    ctx.fillText(v, 0, 0);
    ctx.restore();
  }
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const flip = MY.role === 2;              // p2 sees the arena rotated 180°
  if (flip) ctx.setTransform(-S, 0, 0, S, W / 2, H / 2);
  else ctx.setTransform(S, 0, 0, -S, W / 2, H / 2);
  ctx.lineJoin = 'round';

  // sortingOrder 40: Cassaforte_Rossa / Cassaforte_Blu
  for (let i = 0; i < 2; i++) {
    const p = punches[i] > 0 ? 1 + 0.2 * Math.sin(Math.PI * Math.min(punches[i] / 0.3, 1)) : 1;
    drawSprite('safe', SAFES[i].pos[0], SAFES[i].pos[1], SAFES[i].angle,
      SAFE_SPRITE.w * p, SAFE_SPRITE.h * p,
      { ax: SAFE_SPRITE.ax * p, ay: SAFE_SPRITE.ay * p, tint: rgb(SAFES[i].colour) });
  }
  if (P) {
    // sortingOrder 50 (coins) / 51 (banknote mesh)
    for (const m of P.moneys) if (!m.isBill) drawMoney(m);
    for (const m of P.moneys) if (m.isBill) drawMoney(m);
  }
  // sortingOrder 52: BanconotaStrappata pieces
  for (const t of tears) drawSprite(t.spr, t.x, t.y, t.ang, t.w, t.h, { alpha: t.alpha });
  // sortingOrder 75..100: hooks
  drawHooks();
  // sortingOrder 150: spawn particles
  for (const s of sparks) {
    const a = 1 - s.age / s.life;
    ctx.globalAlpha = a * 0.9;
    ctx.drawImage(s.warm ? sparkDotWarm : sparkDot, s.x - 0.5, s.y - 0.5, 1, 1);
  }
  ctx.globalAlpha = 1;

  drawHud();
}

// ------------------------------------------------------------------ hud/debug
function updateHud() {
  const now = performance.now();
  if (!hudLast) { hudLast = now; return; }
  const span = (now - hudLast) / 1000;
  if (span < 0.25) return;
  NET.snapRate = Math.round(NET.snapCount / span);
  NET.snapCount = 0; hudLast = now;
  $('hud').textContent = 'rtt ' + NET.rtt + 'ms · snap ' + NET.snapRate + '/s · jit ' + Math.round(NET.jitter) + 'ms · corr ' + NET.corrections + (DEV_LAT || DEV_JIT ? ' · LAT SIM' : '');
}
let dbgOn = false;
function setDbg(on) { dbgOn = on; const el = $('dbg'); el.style.display = on ? 'block' : 'none'; if (!on) el.textContent = ''; }
addEventListener('keydown', e => { if (e.key === 'd' || e.key === 'D') setDbg(!dbgOn); });
let dbgAcc = 0;
function updateDebug(dt) {
  if (!dbgOn) return;
  const el = $('dbg'); dbgAcc += dt; if (dbgAcc < 0.1) return; dbgAcc = 0;
  const now = performance.now();
  const age = NET.snapLast ? Math.round(now - NET.snapLast) : -1;
  const L = [];
  L.push('p' + (MY.role || '-') + ' ph ' + UI.phase + ' ws ' + (NET.ws ? (NET.ws.readyState === 1 ? 'open' : 'state' + NET.ws.readyState) : 'none') +
    ' snap ' + NET.snapRate + '/s last ' + (age < 0 ? '-' : age + 'ms') + (age > 250 ? ' STALE!' : '') + ' vault ' + SNAP.vault.size);
  L.push('rtt ' + NET.rtt + 'ms jit ' + Math.round(NET.jitter) + 'ms corr ' + NET.corrections);
  if (P) {
    L.push('tick ' + P.tick + ' money ' + P.moneys.length + ' touches ' + P.touches.length + ' local ' + localPtr.size +
      ' sc ' + UI.scores[0] + '-' + UI.scores[1]);
    for (const mo of P.moneys) {
      const rp = moneyRenderPos(mo);
      L.push('m' + mo.id + ' ' + (mo.isBill ? 'bill' : 'coin') + ' st' + mo.state + ' ' + rp[0].toFixed(2) + ',' + rp[1].toFixed(2) +
        (mo.isBill ? ' meshY ' + mo.meshY.toFixed(2) : ''));
    }
  }
  el.textContent = L.join('\n');
}
function flushDevQueues() {
  if (!DEV_LAT && !DEV_JIT) return;
  const now = performance.now();
  while (outQ.length && outQ[0].at <= now) rawSend(outQ.shift().m);
  while (inQ.length && inQ[0].at <= now) { const p = inQ.shift(); try { netMessage(JSON.parse(p.s)); } catch (e) {} }
}

// ------------------------------------------------------------------ main loop
let acc = 0, last = 0;
function frame(ts) {
  const dt = Math.min((ts - last) / 1000 || 0, 0.05);
  last = ts;
  flushDevQueues();
  if (P) {
    acc = Math.min(acc + dt, 0.2);
    while (acc >= Sim.FIXED) { acc -= Sim.FIXED; simTick(); }
    const dec = Math.exp(-dt * SMOOTH_RATE);
    for (const sm of smoothMap.values()) { sm.x *= dec; sm.y *= dec; }
    const it = SNAP.calcInterpolation('x z');
    oppRender = [];
    if (it && it.state) {
      for (const e of it.state) {
        const mm = /^t(\d+)_(\d+)$/.exec(e.id);
        if (mm) oppRender.push({ p: +mm[1], pid: +mm[2], x: e.x, z: e.z });
      }
    }
    updateClientFx(dt);
    updateHud();
  }
  updateDebug(dt);
  render();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ flow
$('b2o').onclick = () => { initAudio(); menuButtons(true); $('netStatus').textContent = 'Connecting…'; netConnect(); };
$('again').onclick = () => netSend({ t: 'again' });
$('toMenu').onclick = () => netToMenu('');
if (QS.get('debug') === '1') setDbg(true);

resize();
makeSparks();
loadAll().then(() => requestAnimationFrame(frame));

// small hook used by the boot tests
window.__moneyGrabber = {
  NET, MY, UI, inputs, SNAP, localPtr, Sim,
  get P() { return P; },
  get oppRender() { return oppRender; },
};
