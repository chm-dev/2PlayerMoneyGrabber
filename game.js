'use strict';

/* Money Grabber (Rubasoldi) - web port of JungleFrog.TwoPlayers.Rubasoldi
   "2 Player Games: the Challenge" v7.20.4 (Unity 2022.3 / IL2CPP).

   Shipped values (prefab 9_RUBASOLDI): camera orthographic size 15 with clear colour
   #6D463C, first to 15, spawn band x in [-2.933, 2.933] / y in [-3, 3] every 1 s
   (max 4 in play), 20 % banknotes that become active after 1 s, coin speed 4 /
   banknote speed 1, tear at mesh scale 1.7, 3/5/5 CPU hooks with 1.2-2.5 / 0.7-1.5 /
   0.45-1.1 s reaction. Logic follows ControllerRubasoldi, Trascinabile,
   RampinoRubasoldi and BanconotaStrappata (see work/rubasoldi_named.c). */

const $ = id => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');

// ------------------------------------------------------------------ constants
const CAM_SIZE = 15;                     // Camera.orthographicSize
const DESIGN_ASPECT = 1080 / 2340;       // portrait framing of the shipped build
const BG = '#6D463C';                    // camera clear colour (0.427, 0.275, 0.235)
const SCORE_TO_WIN = 15;                 // punteggioPerVincere
const FIXED = 1 / 50;                    // Unity fixedDeltaTime (AddForce integration)

const SPAWN = {
  x: 2.9330454,        // LatoSinistro / LatoDestro at +/-2.933
  yMin: -3, yMax: 3,   // Random.Range(-3, 3)
  threshold: 1.0,      // sogliaSpawn seconds between spawns
  maxInPlay: 4,        // ControllerRubasoldi.Update: moneteInGioco < 4
  billChance: 0.2,     // Random.value < 0.2 -> Banconota
  delay: 1.0,          // WaitForSeconds before SetActive(true)
};
const COIN = { speed: 4.0, radius: 2.0 };        // Trascinabile.velocita / CircleCollider2D
const BILL = { speed: 1.0, hx: 1.6, hy: 3.0, tear: 1.7 }; // vel 1, BoxCollider 3.2x6, soglia strappo
const TEAR = { force: 700, fade: 1.5 };          // BanconotaStrappata.potenzaGravita / Alpha time
const MAX_TOUCHES = 2;                           // Touchable.tocchiMassimiConsentiSuQuestoTouchable
const LINE_W = 0.7;                              // Fune widthMultiplier

const RED = [0.8705882, 0.5607843, 0.4313726];   // Cassaforte_Rossa / hook red
const BLUE = [0.2470588, 0.4862745, 0.6745098];  // Cassaforte_Blu / hook blue
const SAFES = [
  { pos: [0, -14.89], angle: 0, colour: RED },         // giocatore 0 (bottom, human in 1P)
  { pos: [0, 14.98], angle: Math.PI, colour: BLUE },   // giocatore 1 (top, CPU)
];
// Cassaforte BoxCollider2D: 26.746542 x 4.931286, offset (-0.0958, 2.1643)
const SAFE_BOX = { hw: 26.746542 / 2, hh: 4.931286 / 2, ox: -0.0957537, oy: 2.1643009 };
// Cassaforte sprite (4480): 488x440 px at 100 ppu, pivot (0.5187, 0.0589)
const SAFE_SPRITE = { w: 4.87848, h: 4.39848, ax: -0.095753, ay: 2.138658 };

const DIFFS = {
  easy: { maxHooks: 3, reaction: [1.2, 2.5] },     // rampiniMassimiEasyModeCPU / intervalloEasy
  medium: { maxHooks: 5, reaction: [0.7, 1.5] },
  hard: { maxHooks: 5, reaction: [0.45, 1.1] },
};

// sprite textures + world size of the sprite rect + offset of the visible content centre
const SPRITES = {
  safe: { file: 'Cassaforte_4480.png', w: SAFE_SPRITE.w, h: SAFE_SPRITE.h, ax: SAFE_SPRITE.ax, ay: SAFE_SPRITE.ay },
  coin: { file: 'Rubasoldi_Moneta_4417.png', w: 2.92791, h: 2.92791, ax: 0, ay: 0 },
  bill: { file: 'Rubasoldi_Banconota_4899.png', w: 2.56, h: 5.12, ax: 0, ay: 0 },
  paw: { file: 'ZampaGatto_4505.png', w: 3.06848, h: 3.09858, ax: 0, ay: 0 },
  dot: { file: 'Cerchio_1024_22.png', w: 10.24, h: 10.24, ax: 0, ay: 0 },
  tearTop: { file: 'Banconota_Sopra_4389.png', w: 3.5, h: 4.266667, ax: 0, ay: 0 },
  tearBot: { file: 'Banconota_Sotto_4588.png', w: 3.50391, h: 3.90077, ax: 0, ay: 0 },
};

// ------------------------------------------------------------------ math
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const clamp01 = v => clamp(v, 0, 1);
const rand = (a, b) => a + Math.random() * (b - a);
const remap = (v, a, b, c, d) => c + (v - a) / (b - a) * (d - c);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const centroid = a => {
  let x = 0, y = 0, z = 0;
  for (const p of a) { x += p[0]; y += p[1]; z += p[2]; }
  const n = a.length || 1;
  return [x / n, y / n, z / n];
};
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
  if (audioCtx) return;
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

const toWorld = e => {
  const r = canvas.getBoundingClientRect();
  const sx = (e.clientX - r.left) / r.width * W;
  const sy = (e.clientY - r.top) / r.height * H;
  return [(sx - W / 2) / S, (H / 2 - sy) / S, 0];
};
const toViewport = e => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
};

// ------------------------------------------------------------------ state
let mode = 'cpu', diffName = 'medium', phase = 'menu';
const scores = [0, 0];
let clock = 0;             // seconds since page load (JindoFramework.Random delays)
let spawnTimer = 0;        // controller.timerSpawn
let spawning = false;      // controller.isSpawning
let canTap = false;        // controller.canTap
let moneyInPlay = 0;       // controller.moneteInGioco
let moneys = [];
let pending = [];          // spawned but still waiting the 1 s activation
let tears = [];
let sparks = [];
const punches = [0, 0];    // safe punch timers (seconds, 0 = idle)
const pointers = new Map(); // pointerId -> touch

const moneyAngle = m => Math.atan2(-m.up[0], m.up[1]);   // world CCW rotation from up
const countCpuHooks = () => moneys.reduce((n, m) => n + m.cpuTouches.length, 0);

// ------------------------------------------------------------------ spawn
// ControllerRubasoldi.SpawnaOggetto + <SpawnaOggettoCoroutine>d__35
function spawnMoney(forceBill) {
  if (spawning) return null;
  spawning = true;
  const isBill = forceBill != null ? forceBill : Math.random() < SPAWN.billChance;
  const x = rand(-SPAWN.x, SPAWN.x);
  const y = rand(SPAWN.yMin, SPAWN.yMax);
  const m = {
    isBill,
    pos: [x, y, 0],
    up: [0, 1, 0],
    direzione: [x, y, 0],
    dirSign: Math.random() < 0.5 ? 1 : -1,
    speed: isBill ? BILL.speed : COIN.speed,
    speed0: isBill ? BILL.speed : COIN.speed,
    visible: false,
    inSafe: false,
    touches: [],
    cpuTouches: [],
    meshY: 1,
    alpha: 1,
    scale: 1,
    collect: null,
    spawnPos: [x, y, 0],
    activateAt: clock + SPAWN.delay,
    cpuAt: null,
  };
  moneys.push(m);
  pending.push(m);
  moneyInPlay++;
  spawnTimer = 0;
  spawning = false;
  return m;
}

// second step of the coroutine: SetActive(true), particle burst, Start()
function activateMoney(m) {
  m.visible = true;
  m.direzione = [m.pos[0], m.pos[1] + m.dirSign, 0];
  m.speed0 = m.speed;
  burst(m.spawnPos);
  const d = DIFFS[diffName];
  if (mode === 'cpu' && countCpuHooks() < d.maxHooks) {
    m.cpuAt = clock + rand(d.reaction[0], d.reaction[1]);
  }
}

// Trascinabile.OnPressCPU / ControllerRubasoldi.PrendiCPU
function pressCPU(m) {
  if (mode !== 'cpu' || !canTap || !m.visible || m.inSafe) return;
  if (m.cpuTouches.length) return;
  m.cpuTouches.push({ cpu: true, pos: [0, 10, 0] });
}

// ------------------------------------------------------------------ update
// Trascinabile.Update
function updateMoney(m, dt) {
  if (m.collect) {
    m.collect.t += dt;
    const k = clamp01(m.collect.t / 0.5);
    const e = k * k * (3 - 2 * k);      // JindoTween curve unknown -> smoothstep
    m.pos[0] = m.collect.from[0] + (m.collect.to[0] - m.collect.from[0]) * e;
    m.pos[1] = m.collect.from[1] + (m.collect.to[1] - m.collect.from[1]) * e;
    m.scale = 1 - e;
    m.alpha = 1 - k;
    if (k >= 1) { m.collect = null; m.visible = false; }
    return;
  }
  if (!m.visible || m.inSafe) return;

  const arr = [];
  for (const t of m.touches) arr.push(t.world);
  for (const t of m.cpuTouches) arr.push(t.pos);

  if (arr.length === 0) {
    m.up = lerp3(m.up, [0, 1, 0], clamp01(dt));
    m.speed = m.speed0;
  } else {
    const c = centroid(arr);
    m.direzione = c;
    m.speed = m.speed0 * 1.5;
    const tilt = remap(c[0], -10, 10, -0.5, 0.5);
    const target = [c[1] > 0 ? tilt : -tilt, 1, 0];
    m.up = lerp3(m.up, target, clamp01(dt));

    if (m.isBill && arr.length > 1) {                // banconota tirata da due dita
      let targetY;
      if (m.cpuTouches.length < 1) {
        let n = -1, s = 2;
        for (const t of m.touches) {
          const v = t.screen[1];
          if (v > n) n = v;
          if (v < s) s = v;
        }
        targetY = 1 + remap(Math.abs(n - s), 0, 0.5, 0, 1);   // Remap(|nord - sud|, 0, .5, 0, 1) + 1
      } else targetY = 2.5;
      m.meshY += (targetY - m.meshY) * clamp01(2 * dt * m.speed);
      if (m.meshY > BILL.tear) { tearMoney(m); return; }
    }
  }

  if (m.isBill) {                                    // x/z (and leftover y) spring back to 1
    const k = clamp01(2 * dt * m.speed);
    m.meshY += (1 - m.meshY) * k;
  }

  const k = clamp01(dt * m.speed);
  m.pos[0] += (m.direzione[0] - m.pos[0]) * k;
  m.pos[1] += (m.direzione[1] - m.pos[1]) * k;
  m.pos[2] += (m.direzione[2] - m.pos[2]) * k;

  if (!m.inSafe) {
    for (let i = 0; i < 2; i++) if (overlapsSafe(m, i)) { collect(m, i); break; }
  }
}

// ------------------------------------------------------------------ collisions
function obbOverlap(A, B) {
  const axes = [];
  for (const o of [A, B]) {
    axes.push([Math.cos(o.a), Math.sin(o.a)], [-Math.sin(o.a), Math.cos(o.a)]);
  }
  for (const u of axes) {
    const rA = A.hx * Math.abs(u[0] * Math.cos(A.a) + u[1] * Math.sin(A.a)) +
               A.hy * Math.abs(-u[0] * Math.sin(A.a) + u[1] * Math.cos(A.a));
    const rB = B.hx * Math.abs(u[0] * Math.cos(B.a) + u[1] * Math.sin(B.a)) +
               B.hy * Math.abs(-u[0] * Math.sin(B.a) + u[1] * Math.cos(B.a));
    const d = Math.abs((B.c[0] - A.c[0]) * u[0] + (B.c[1] - A.c[1]) * u[1]);
    if (d > rA + rB) return false;
  }
  return true;
}
function circleBox(c, r, B) {
  const dx = c[0] - B.c[0], dy = c[1] - B.c[1];
  const lx = dx * Math.cos(B.a) + dy * Math.sin(B.a);
  const ly = -dx * Math.sin(B.a) + dy * Math.cos(B.a);
  const qx = Math.max(Math.abs(lx) - B.hx, 0);
  const qy = Math.max(Math.abs(ly) - B.hy, 0);
  return qx * qx + qy * qy <= r * r;
}
function overlapsSafe(m, i) {
  const s = SAFES[i];
  const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
  const c = [s.pos[0] + SAFE_BOX.ox * ca - SAFE_BOX.oy * sa,
             s.pos[1] + SAFE_BOX.ox * sa + SAFE_BOX.oy * ca];
  const box = { c, a: s.angle, hx: SAFE_BOX.hw, hy: SAFE_BOX.hh };
  if (m.isBill) {
    return obbOverlap({ c: m.pos, a: moneyAngle(m), hx: BILL.hx, hy: BILL.hy }, box);
  }
  return circleBox(m.pos, COIN.radius, box);
}

// ------------------------------------------------------------------ collect
// Trascinabile.OnTriggerEnter2D -> Cassaforte.PrendiSoldo -> ControllerRubasoldi.Punto
function collect(m, i) {
  if (m.inSafe || m.collect) return;
  clearTouches(m);
  m.inSafe = true;              // inCassaforte
  m.cpuAt = null;               // JindoTween.Cancella(money.gameObject)
  punches[i] = 1e-4;            // JindoTween.Punch(safeMesh, 1.2, 1, 0.3)
  m.collect = { t: 0, from: m.pos.slice(), to: [SAFES[i].pos[0], SAFES[i].pos[1]] };
  playSound('soldi', 0.6);
  moneyInPlay--;
  point(i, m.isBill ? 3 : 1);
}

// ControllerRubasoldi.Punto + ControllerLivello.AumentaPunteggioGiocatore
function point(player, pts) {
  scores[player] += pts;
  if (scores[player] >= SCORE_TO_WIN) {
    phase = 'over';
    canTap = false;
    clearAllTouches();
    $('overTitle').textContent = mode === 'cpu'
      ? (player === 0 ? 'You win!' : 'You lose')
      : (player === 0 ? 'Red wins!' : 'Blue wins!');
    $('over').classList.remove('hidden');
  }
}

// ------------------------------------------------------------------ tear
// Trascinabile.StrappaBanconota + BanconotaStrappata.Start
function tearMoney(m) {
  playSound('strappo', 0.5);
  const ang = moneyAngle(m);
  const sy = m.meshY;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pieces = [
    { spr: 'tearTop', y: 1.5, w: 3.5 * 0.7, h: 4.266667 * 0.7, dir: 1 },
    { spr: 'tearBot', y: -0.527, w: 3.50391 * 0.7, h: 3.90077 * 0.7, dir: -1 },
  ];
  for (const p of pieces) {
    const oy = p.y * sy;
    tears.push({
      spr: p.spr,
      x: m.pos[0] - oy * sa,
      y: m.pos[1] + oy * ca,
      vx: m.up[0] * TEAR.force * FIXED * p.dir,
      vy: m.up[1] * TEAR.force * FIXED * p.dir,
      ang,
      w: p.w,
      h: p.h * sy,
      alpha: 1,
      age: 0,
    });
  }
  clearTouches(m);
  m.inSafe = true;
  m.visible = false;
  m.cpuAt = null;
  moneyInPlay--;
}

function clearTouches(m) {
  for (const t of m.touches) pointers.delete(t.id);
  m.touches.length = 0;
  m.cpuTouches.length = 0;
}
function clearAllTouches() {
  for (const m of moneys) clearTouches(m);
  pointers.clear();
}

// ------------------------------------------------------------------ particles
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
// ParticellaSpawn: burst of 10, circle radius 1, speed 20, lifetime 0.5, size 1
function burst(pos) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({
      x: pos[0] + Math.cos(a),
      y: pos[1] + Math.sin(a),
      vx: Math.cos(a) * 20,
      vy: Math.sin(a) * 20,
      age: 0,
      life: 0.5,
      warm: Math.random() < 0.5,
    });
  }
}
function updateSparks(dt) {
  for (const s of sparks) {
    s.age += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }
  sparks = sparks.filter(s => s.age < s.life);
}
function updateTears(dt) {
  for (const t of tears) {
    t.age += dt;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.alpha = Math.max(0, 1 - t.age / TEAR.fade);
  }
  tears = tears.filter(t => t.age < TEAR.fade);
}

// ------------------------------------------------------------------ input (Touchable)
function moneyHit(m, x, y) {
  const a = moneyAngle(m);
  const dx = x - m.pos[0], dy = y - m.pos[1];
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a);
  if (m.isBill) return Math.abs(lx) <= BILL.hx && Math.abs(ly) <= BILL.hy;
  return lx * lx + ly * ly <= COIN.radius * COIN.radius;
}
function pickMoney(x, y) {
  let best = null;
  for (const m of moneys) {
    if (!m.visible || m.inSafe || m.collect) continue;
    if (m.touches.length >= MAX_TOUCHES) continue;
    if (!moneyHit(m, x, y)) continue;
    if (!best || (m.isBill && !best.isBill)) best = m;   // banknote sorts above the coin (51 > 50)
  }
  return best;
}

canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (phase !== 'playing' || !canTap) return;
  const world = toWorld(e);
  const m = pickMoney(world[0], world[1]);
  if (!m) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers */ }
  const t = {
    id: e.pointerId,
    money: m,
    world,
    screen: toViewport(e),
    cpu: false,
  };
  m.touches.push(t);          // Trascinabile.OnPress
  pointers.set(e.pointerId, t);
  e.preventDefault();
});

canvas.addEventListener('pointermove', e => {
  const t = pointers.get(e.pointerId);
  if (!t) return;
  t.world = toWorld(e);
  t.screen = toViewport(e);
});

function releaseTouch(e) {
  const t = pointers.get(e.pointerId);
  if (!t) return;
  const m = t.money;
  const i = m.touches.indexOf(t);   // Trascinabile.OnRelease
  if (i >= 0) m.touches.splice(i, 1);
  pointers.delete(e.pointerId);
}
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);
canvas.addEventListener('lostpointercapture', releaseTouch);

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

function drawMoney(m) {
  if (!m.visible) return;
  const ang = moneyAngle(m);
  if (m.isBill) {
    // root rotation + child mesh localScale (y stretched by the two-finger pull)
    drawSprite('bill', m.pos[0], m.pos[1], ang, 2.56 * m.scale, 5.12 * m.meshY * m.scale, { alpha: m.alpha });
  } else {
    drawSprite('coin', m.pos[0], m.pos[1], ang, 2.92791 * m.scale, 2.92791 * m.scale, { alpha: m.alpha });
  }
}

// RampinoRubasoldi.Update / Colora / SetPosizioni: Fune sortingOrder 75, Inizio 80,
// Inizio (1) 85, Zampa 100 - so the whole set is drawn in three passes.
function hookGeometry(m, t) {
  let dito, zampa;
  if (t.cpu) {
    dito = [0, 10, 0];
    zampa = [m.pos[0], m.pos[1] + 1.5, 0];
  } else {
    dito = t.world;
    zampa = m.pos;                     // offsetToccoInizialeWorld treated as 0
  }
  const colour = zampa[1] <= dito[1] ? BLUE : RED;
  return { dito, zampa, colour };
}
function drawHooks() {
  const hooks = [];
  for (const m of moneys) {
    if (!m.visible || m.inSafe) continue;
    for (const t of m.touches) hooks.push(hookGeometry(m, t));
    for (const t of m.cpuTouches) hooks.push(hookGeometry(m, t));
  }
  for (const h of hooks) drawLine(h.dito[0], h.dito[1], h.zampa[0], h.zampa[1], LINE_W, h.colour);
  for (const h of hooks) drawSprite('dot', h.dito[0], h.dito[1], 0, 10.24 * 0.2, 10.24 * 0.2, { tint: '#000' });
  for (const h of hooks) drawSprite('dot', h.dito[0], h.dito[1], 0, 10.24 * 0.15, 10.24 * 0.15, { tint: rgb(h.colour) });
  for (const h of hooks) {
    let dx = h.zampa[0] - h.dito[0], dy = h.zampa[1] - h.dito[1];
    const len = Math.hypot(dx, dy);
    const dir = len > 1e-5 ? [dx / len, dy / len] : [0, 1];
    drawSprite('paw', h.zampa[0], h.zampa[1], Math.atan2(-dir[0], dir[1]),
      3.06848 * 0.8, 3.09858 * 0.8, { tint: rgb(h.colour) });
  }
}

function drawHud() {
  ctx.save();
  ctx.scale(1, -1);                    // back to screen-oriented text inside the world transform
  ctx.font = 'bold 1.7px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.14;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  const x = -halfW + 0.95;
  for (const [i, y] of [[1, 13.5], [0, -13.5]]) {
    ctx.fillStyle = rgb(SAFES[i].colour);
    ctx.beginPath();
    ctx.arc(x - 0.75, -y, 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.strokeText(String(scores[i]), x, -y);
    ctx.fillText(String(scores[i]), x, -y);
  }
  ctx.restore();
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(S, 0, 0, -S, W / 2, H / 2);
  ctx.lineJoin = 'round';

  // sortingOrder 40: Cassaforte_Rossa / Cassaforte_Blu
  for (let i = 0; i < 2; i++) {
    const p = punches[i] > 0 ? 1 + 0.2 * Math.sin(Math.PI * Math.min(punches[i] / 0.3, 1)) : 1;
    drawSprite('safe', SAFES[i].pos[0], SAFES[i].pos[1], SAFES[i].angle,
      SAFE_SPRITE.w * p, SAFE_SPRITE.h * p,
      { ax: SAFE_SPRITE.ax * p, ay: SAFE_SPRITE.ay * p, tint: rgb(SAFES[i].colour) });
  }
  // sortingOrder 50 (coins) / 51 (banknote mesh)
  for (const m of moneys) if (!m.isBill) drawMoney(m);
  for (const m of moneys) if (m.isBill) drawMoney(m);
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

// ------------------------------------------------------------------ game flow
function newGame(m, d) {
  mode = m;
  diffName = d || 'medium';
  scores[0] = scores[1] = 0;
  moneys = [];
  pending = [];
  tears = [];
  sparks = [];
  pointers.clear();
  clock = 0;
  spawnTimer = 0;
  spawning = false;
  moneyInPlay = 0;
  punches[0] = punches[1] = 0;
  canTap = true;
  phase = 'playing';
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
}

$('b1e').onclick = () => { initAudio(); newGame('cpu', 'easy'); };
$('b1m').onclick = () => { initAudio(); newGame('cpu', 'medium'); };
$('b1h').onclick = () => { initAudio(); newGame('cpu', 'hard'); };
$('b2').onclick = () => { initAudio(); newGame('2p'); };
$('again').onclick = () => newGame(mode, diffName);
$('toMenu').onclick = () => {
  phase = 'menu';
  clearAllTouches();
  $('over').classList.add('hidden');
  $('menu').classList.remove('hidden');
};

// ------------------------------------------------------------------ main loop
let last = 0;
function frame(ts) {
  const now = ts / 1000;
  let dt = Math.min(now - last, 0.1);
  last = now;
  if (!isFinite(dt) || dt < 0) dt = 0;
  clock += dt;

  if (phase === 'playing') {
    // ControllerRubasoldi.Update
    if (moneyInPlay < SPAWN.maxInPlay) {
      spawnTimer += dt;
      if (spawnTimer > SPAWN.threshold) spawnMoney();
    }
    // DelayedCall(OnPressCPU)
    for (const m of moneys) {
      if (m.cpuAt != null && clock >= m.cpuAt) {
        m.cpuAt = null;
        pressCPU(m);
      }
    }
  }

  // spawn coroutine, second step (runs while a round is on screen)
  if (phase !== 'menu') {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (clock >= pending[i].activateAt) {
        activateMoney(pending[i]);
        pending.splice(i, 1);
      }
    }
  }

  if (phase !== 'menu') {
    for (const m of moneys) updateMoney(m, dt);
    updateTears(dt);
    updateSparks(dt);
    for (let i = 0; i < 2; i++) {
      if (punches[i] > 0) {
        punches[i] += dt;
        if (punches[i] >= 0.3) punches[i] = 0;
      }
    }
    moneys = moneys.filter(m => m.visible || m.collect || pending.includes(m));
  }

  render();
  requestAnimationFrame(frame);
}

resize();
makeSparks();
loadAll().then(() => requestAnimationFrame(frame));

// small debug hook used by the smoke tests
window.__moneyGrabber = {
  get state() {
    return {
      phase, mode, diffName, scores: scores.slice(), clock, moneyInPlay,
      moneys: moneys.map(m => ({
        isBill: m.isBill, pos: m.pos.slice(), up: m.up.slice(), visible: m.visible,
        inSafe: m.inSafe, meshY: m.meshY, alpha: m.alpha, touches: m.touches.length,
        cpu: m.cpuTouches.length,
      })),
      tears: tears.length,
    };
  },
  spawn: isBill => spawnMoney(isBill),
  point,
  toClient(x, y) {
    const r = canvas.getBoundingClientRect();
    return [r.left + (x * S + W / 2) / W * r.width, r.top + (H / 2 - y * S) / H * r.height];
  },
};
