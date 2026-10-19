'use strict';
// sim.js — shared headless Money Grabber (Rubasoldi) simulation (netcode plan).
// Pure: explicit state in, events out. No DOM, no audio, no Math.random, no timing APIs.
// Spawning uses a seeded mulberry32 RNG whose state lives in S, so the authority can
// spawn deterministically and clients can replay identical states.
(function (root) {
  const FIXED = 1 / 50;                    // fixed tick (was Unity fixedDeltaTime)
  const SCORE_TO_WIN = 15;                 // punteggioPerVincere
  const SPAWN = {
    x: 2.9330454,        // LatoSinistro / LatoDestro at +/-2.933
    yMin: -3, yMax: 3,   // Random.Range(-3, 3)
    threshold: 1.0,      // sogliaSpawn seconds between spawns
    maxInPlay: 4,        // moneteInGioco < 4
    billChance: 0.2,     // Random.value < 0.2 -> Banconota
    delay: 1.0,          // seconds before SetActive(true)
  };
  const COIN = { speed: 4.0, radius: 2.0 };                 // Trascinabile.velocita / CircleCollider2D
  const BILL = { speed: 1.0, hx: 1.6, hy: 3.0, tear: 1.7 }; // vel 1, BoxCollider 3.2x6, soglia strappo
  const TEAR = { force: 700, fade: 1.5 };                   // BanconotaStrappata.potenzaGravita
  const MAX_TOUCHES = 2;               // tocchiMassimiConsentiSuQuestoTouchable
  const MAX_POINTERS_PER_PLAYER = 2;   // simultaneous fingers per online player
  const COORD_LIMIT = 30;
  const COLLECT_TIME = 0.5;            // suck-in tween seconds
  const RED = [0.8705882, 0.5607843, 0.4313726];
  const BLUE = [0.2470588, 0.4862745, 0.6745098];
  const SAFES = [
    { pos: [0, -14.89], angle: 0 },          // giocatore 0 (red, world bottom)
    { pos: [0, 14.98], angle: Math.PI },     // giocatore 1 (blue, world top)
  ];
  // Cassaforte BoxCollider2D: 26.746542 x 4.931286, offset (-0.0958, 2.1643)
  const SAFE_BOX = { hw: 26.746542 / 2, hh: 4.931286 / 2, ox: -0.0957537, oy: 2.1643009 };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = v => clamp(v, 0, 1);
  const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;

  // mulberry32 — deterministic 32-bit PRNG advanced from S.rngState
  function rng(S) {
    let t = (S.rngState = (S.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // money state: 0 pending (invisible), 1 active, 2 collecting (tween), 3 done (pruned)
  function makeMoney(S, isBill, x, y, dirSign) {
    return {
      id: S.nextId++,
      isBill: !!isBill,
      pos: [x, y, 0],
      up: [0, 1, 0],
      direzione: [x, y, 0],
      dirSign: dirSign || 1,
      speed: isBill ? BILL.speed : COIN.speed,
      speed0: isBill ? BILL.speed : COIN.speed,
      state: 0,
      activateAtTick: S.tick + Math.round(SPAWN.delay / FIXED),
      collect: null,
      meshY: 1,
    };
  }

  function create(seed) {
    return {
      authority: true,
      tick: 0,
      phase: 'playing',
      scores: [0, 0],
      winner: 0,
      rngState: seed == null ? 0x9E3779B9 : (seed >>> 0),
      spawnTimer: 0,
      moneyInPlay: 0,
      nextId: 1,
      moneys: [],
      // touches: { p: 1|2, pid, mid, x, z, sy } — sy canonical (1 = blue side)
      touches: [],
      events: [],
    };
  }

  // ControllerRubasoldi.SpawnaOggetto + <SpawnaOggettoCoroutine>d__35
  function spawnMoney(S, forceBill) {
    const isBill = forceBill != null ? !!forceBill : rng(S) < SPAWN.billChance;
    const x = -SPAWN.x + rng(S) * (SPAWN.x * 2);
    const y = SPAWN.yMin + rng(S) * (SPAWN.yMax - SPAWN.yMin);
    const dirSign = rng(S) < 0.5 ? 1 : -1;
    const m = makeMoney(S, isBill, x, y, dirSign);
    S.moneys.push(m);
    S.moneyInPlay++;
    S.spawnTimer = 0;
    return m;
  }

  const moneyAngle = m => Math.atan2(-m.up[0], m.up[1]);

  function touchesOf(S, mid) {
    return S.touches.filter(t => t.mid === mid);
  }
  function clearTouchesOf(S, mid) {
    for (let i = S.touches.length - 1; i >= 0; i--) if (S.touches[i].mid === mid) S.touches.splice(i, 1);
  }

  // Touchable hit shapes: point-in-oriented-box for bills, point-in-circle for coins
  function moneyHit(m, x, y) {
    const a = moneyAngle(m);
    const dx = x - m.pos[0], dy = y - m.pos[1];
    const lx = dx * Math.cos(a) + dy * Math.sin(a);
    const ly = -dx * Math.sin(a) + dy * Math.cos(a);
    if (m.isBill) return Math.abs(lx) <= BILL.hx && Math.abs(ly) <= BILL.hy;
    return lx * lx + ly * ly <= COIN.radius * COIN.radius;
  }
  // Trascinabile.OnPress pick: spawn order, bills sort above coins (51 > 50)
  function pickMoney(S, x, y) {
    let best = null;
    for (const m of S.moneys) {
      if (m.state !== 1) continue;
      if (touchesOf(S, m.id).length >= MAX_TOUCHES) continue;
      if (!moneyHit(m, x, y)) continue;
      if (!best || (m.isBill && !best.isBill)) best = m;
    }
    return best ? best.id : 0;
  }

  function applyInput(S, inp) {
    if (!inp || (inp.p !== 1 && inp.p !== 2)) return;
    if (S.phase !== 'playing') return;
    const p = inp.p;
    const pid = inp.pid;
    if (!Number.isInteger(pid) || pid < 0 || pid > 1e9) return;
    if (inp.k === 'd' || inp.k === 'm') {
      const x = +inp.x, z = +inp.z, sy = +inp.sy;
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(sy)) return;
      if (Math.abs(x) > COORD_LIMIT || Math.abs(z) > COORD_LIMIT || sy < 0 || sy > 1) return;
      let t = null;
      for (const e of S.touches) if (e.pid === pid && e.p === p) { t = e; break; }
      if (inp.k === 'd' && !t) {
        let mine = 0;
        for (const e of S.touches) if (e.p === p) mine++;
        if (mine >= MAX_POINTERS_PER_PLAYER) return;
        const mid = pickMoney(S, x, z);
        if (!mid) return;                       // pressed on empty space: no touch
        S.touches.push({ p, pid, mid, x, z, sy });
        return;
      }
      if (!t) return;
      t.x = x; t.z = z; t.sy = sy;
    } else if (inp.k === 'u') {
      for (let i = 0; i < S.touches.length; i++) {
        if (S.touches[i].pid === pid && S.touches[i].p === p) { S.touches.splice(i, 1); break; }
      }
    }
  }

  function centroid(a) {
    let x = 0, y = 0;
    for (const v of a) { x += v[0]; y += v[1]; }
    const n = a.length || 1;
    return [x / n, y / n];
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

  // ------------------------------------------------------------------ update
  // Trascinabile.Update at fixed dt
  function updateMoney(S, m) {
    if (m.state === 2) {
      m.collect.t += FIXED;
      const k = clamp01(m.collect.t / COLLECT_TIME);
      const e = k * k * (3 - 2 * k);        // JindoTween curve unknown -> smoothstep
      m.pos[0] = m.collect.from[0] + (m.collect.to[0] - m.collect.from[0]) * e;
      m.pos[1] = m.collect.from[1] + (m.collect.to[1] - m.collect.from[1]) * e;
      if (k >= 1) m.state = 3;
      return;
    }
    if (m.state !== 1) return;

    const ts = touchesOf(S, m.id);
    const arr = [];
    for (const t of ts) arr.push([t.x, t.z, 0]);

    if (arr.length === 0) {
      m.up = lerp3(m.up, [0, 1, 0], clamp01(FIXED));
      m.speed = m.speed0;
    } else {
      const c = centroid(arr);
      m.direzione = [c[0], c[1], 0];
      m.speed = m.speed0 * 1.5;
      const tilt = remap(c[0], -10, 10, -0.5, 0.5);
      const target = [c[1] > 0 ? tilt : -tilt, 1, 0];
      m.up = lerp3(m.up, target, clamp01(FIXED));

      if (m.isBill && arr.length > 1) {      // banconota tirata da due dita
        // sy is canonical (1 = blue side) so the stretch is view-independent
        let n = -1, s = 2;
        for (const t of ts) {
          if (t.sy > n) n = t.sy;
          if (t.sy < s) s = t.sy;
        }
        const targetY = 1 + remap(Math.abs(n - s), 0, 0.5, 0, 1);
        m.meshY += (targetY - m.meshY) * clamp01(2 * FIXED * m.speed);
        if (m.meshY > BILL.tear) { tearMoney(S, m); return; }
      }
    }

    if (m.isBill) {                          // spring back toward 1
      const k = clamp01(2 * FIXED * m.speed);
      m.meshY += (1 - m.meshY) * k;
    }

    const k = clamp01(FIXED * m.speed);
    m.pos[0] += (m.direzione[0] - m.pos[0]) * k;
    m.pos[1] += (m.direzione[1] - m.pos[1]) * k;
    m.pos[2] += (m.direzione[2] - m.pos[2]) * k;

    for (let i = 0; i < 2; i++) {
      if (overlapsSafe(m, i)) { collectMoney(S, m, i); break; }
    }
  }

  // Trascinabile.OnTriggerEnter2D -> Cassaforte.PrendiSoldo -> ControllerRubasoldi.Punto
  function collectMoney(S, m, i) {
    if (m.state === 2 || m.state === 3) return;
    clearTouchesOf(S, m.id);
    m.state = 2;
    m.collect = { t: 0, from: [m.pos[0], m.pos[1]], to: [SAFES[i].pos[0], SAFES[i].pos[1]], safe: i };
    S.moneyInPlay--;
    S.events.push({ ev: 'collect', p: i + 1, bill: m.isBill ? 1 : 0 });
    point(S, i, m.isBill ? 3 : 1);
  }

  // ControllerRubasoldi.Punto + ControllerLivello.AumentaPunteggioGiocatore
  function point(S, player, pts) {
    S.scores[player] += pts;
    if (S.scores[player] >= SCORE_TO_WIN) {
      S.phase = 'over';
      S.touches.length = 0;
      S.winner = player + 1;
      S.events.push({ ev: 'win', p: player + 1 });
    }
    S.events.push({ ev: 'point', p: player + 1, pts });
  }

  // Trascinabile.StrappaBanconota — piece visuals are rebuilt client-side from the event
  function tearMoney(S, m) {
    const ang = moneyAngle(m);
    S.events.push({
      ev: 'tear', mid: m.id,
      x: r2(m.pos[0]), y: r2(m.pos[1]), ang: r2(ang),
      meshY: r2(m.meshY), ux: r2(m.up[0]), uy: r2(m.up[1]),
    });
    clearTouchesOf(S, m.id);
    m.state = 3;
    S.moneyInPlay--;
  }

  function step(S, inputs) {
    S.tick++;
    S.events.length = 0;
    if (inputs) {
      for (let i = 0; i < inputs.length; i++) applyInput(S, inputs[i]);
    }
    // ControllerRubasoldi.Update spawn gating (authority only)
    if (S.authority && S.phase === 'playing') {
      if (S.moneyInPlay < SPAWN.maxInPlay) {
        S.spawnTimer += FIXED;
        if (S.spawnTimer > SPAWN.threshold) spawnMoney(S);
      }
    }
    // spawn coroutine, second step: SetActive(true)
    for (const m of S.moneys) {
      if (m.state === 0 && S.tick >= m.activateAtTick) {
        m.state = 1;
        m.direzione = [m.pos[0], m.pos[1] + m.dirSign, 0];
        m.speed0 = m.speed;
        S.events.push({ ev: 'activate', mid: m.id, x: r2(m.pos[0]), y: r2(m.pos[1]) });
      }
    }
    for (const m of S.moneys) updateMoney(S, m);
    S.moneys = S.moneys.filter(m => m.state !== 3);
    return S.events;
  }

  // ------------------------------------------------------------------ wire snapshot
  // money row: [id, bill, x, y, dx, dy, ux, uy, meshY, state]
  //   state 2 appends [collectT, fromX, fromY, safeIdx]
  //   state 0 appends [activateAtTick, dirSign]
  // touch row: [p, pid, mid, x, z, sy]
  function moneyRow(m) {
    const row = [m.id, m.isBill ? 1 : 0,
      r2(m.pos[0]), r2(m.pos[1]),
      r2(m.direzione[0]), r2(m.direzione[1]),
      r2(m.up[0]), r2(m.up[1]),
      r2(m.meshY), m.state];
    if (m.state === 2) {
      row.push(r2(m.collect.t), r2(m.collect.from[0]), r2(m.collect.from[1]), m.collect.safe);
    } else if (m.state === 0) {
      row.push(m.activateAtTick, m.dirSign);
    }
    return row;
  }
  function snapshot(S) {
    return {
      tk: S.tick,
      ph: S.phase,
      sc: [r2(S.scores[0]), r2(S.scores[1])],
      w: S.winner,
      m: S.moneys.map(moneyRow),
      tp: S.touches.map(t => [t.p, t.pid, t.mid, r2(t.x), r2(t.z), r3(t.sy)]),
    };
  }
  function moneyFromRow(row) {
    const m = {
      id: row[0],
      isBill: !!row[1],
      pos: [row[2], row[3], 0],
      direzione: [row[4], row[5], 0],
      up: [row[6], row[7], 0],
      dirSign: 1,
      speed: row[1] ? BILL.speed : COIN.speed,
      speed0: row[1] ? BILL.speed : COIN.speed,
      state: row[9],
      activateAtTick: 0,
      collect: null,
      meshY: row[8],
    };
    if (row[9] === 2) {
      const safe = row[13];
      m.collect = { t: row[10], from: [row[11], row[12]], to: [SAFES[safe].pos[0], SAFES[safe].pos[1]], safe };
    } else if (row[9] === 0) {
      m.activateAtTick = row[10];
      m.dirSign = row[11];
    }
    return m;
  }
  function applySnapshot(S, s) {
    if (!s) return S;
    S.tick = s.tk != null ? s.tk : S.tick;
    S.phase = s.ph != null ? s.ph : S.phase;
    if (s.sc) { S.scores[0] = s.sc[0]; S.scores[1] = s.sc[1]; }
    S.winner = s.w != null ? s.w : S.winner;
    S.moneys = (s.m || []).map(moneyFromRow);
    S.touches = (s.tp || []).map(r => ({ p: r[0], pid: r[1], mid: r[2], x: r[3], z: r[4], sy: r[5] }));
    // moneyInPlay = pending + active (collecting items were already decremented)
    let mip = 0;
    for (const m of S.moneys) if (m.state === 0 || m.state === 1) mip++;
    S.moneyInPlay = mip;
    S.events.length = 0;
    return S;
  }

  // ------------------------------------------------------------------ full state (start message / tests)
  function moneyFull(m) {
    return {
      id: m.id, isBill: m.isBill,
      pos: m.pos.slice(), direzione: m.direzione.slice(), up: m.up.slice(),
      dirSign: m.dirSign, speed: m.speed, speed0: m.speed0,
      state: m.state, activateAtTick: m.activateAtTick, meshY: m.meshY,
      collect: m.collect ? { t: m.collect.t, from: m.collect.from.slice(), to: m.collect.to.slice(), safe: m.collect.safe } : null,
    };
  }
  function dump(S) {
    return {
      _v: 1,
      authority: S.authority,
      tick: S.tick,
      ph: S.phase,
      sc: S.scores.slice(),
      w: S.winner,
      rs: S.rngState,
      spT: S.spawnTimer,
      mip: S.moneyInPlay,
      nid: S.nextId,
      m: S.moneys.map(moneyFull),
      tp: S.touches.map(t => ({ p: t.p, pid: t.pid, mid: t.mid, x: t.x, z: t.z, sy: t.sy })),
    };
  }
  function load(o) {
    const S = create();
    if (!o) return S;
    S.authority = !!o.authority;
    S.tick = o.tick;
    S.phase = o.ph;
    S.scores = o.sc.slice();
    S.winner = o.w;
    S.rngState = o.rs >>> 0;
    S.spawnTimer = o.spT;
    S.moneyInPlay = o.mip;
    S.nextId = o.nid;
    S.moneys = o.m.map(f => ({
      id: f.id, isBill: f.isBill,
      pos: f.pos.slice(), direzione: f.direzione.slice(), up: f.up.slice(),
      dirSign: f.dirSign, speed: f.speed, speed0: f.speed0,
      state: f.state, activateAtTick: f.activateAtTick, meshY: f.meshY,
      collect: f.collect ? { t: f.collect.t, from: f.collect.from.slice(), to: f.collect.to.slice(), safe: f.collect.safe } : null,
    }));
    S.touches = o.tp.map(t => ({ p: t.p, pid: t.pid, mid: t.mid, x: t.x, z: t.z, sy: t.sy }));
    return S;
  }

  const Sim = {
    FIXED, SCORE_TO_WIN, SPAWN, COIN, BILL, TEAR,
    MAX_TOUCHES, MAX_POINTERS_PER_PLAYER, COORD_LIMIT, COLLECT_TIME,
    RED, BLUE, SAFES, SAFE_BOX,
    create, step, snapshot, applySnapshot, dump, load, spawnMoney,
    moneyAngle, moneyHit, pickMoney,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
