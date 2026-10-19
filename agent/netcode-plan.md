# Money Grabber → WebSocket Online Multiplayer — Implementation Plan

Convert the static same-screen touch game into **server-authoritative online 2-player**,
replicating the architecture of `2PlayerPingPong` (its `agent/netcode-plan_beam.md` plan +
implementation): Node + `ws` server at a 50 Hz fixed tick, one shared headless `sim.js` used
by server, both clients (prediction/replay) and tests, 25 Hz snapshots, JSON protocol, FIFO
matchmaking, no reconnection. **Online-only** (CPU / local-2P modes removed).

## Game-specific design decisions

- **Roles/views**: `p1` = red vault (world bottom), `p2` = blue vault (world top). p2's
  entire render is rotated 180° (like PingPong) so each player's own vault is at the bottom
  of their screen. HUD scores counter-rotated for p2.
- **Touch input is the net input.** Pointer events become sequenced inputs: `k:'d'` (down:
  server runs deterministic `pickMoney` to bind pointer→money), `k:'m'` (move: update bound
  touch), `k:'u'` (release). Server validates and owns all binding; the 2-touches-per-money
  cap makes tug-of-war emerge naturally (each player hooks the same coin → it eases toward
  the centroid of both fingers).
- **Canonical screen-y**: the bill-stretch formula uses `t.screen[1]`, a 0..1 normalized
  viewport coord. Wire format carries a canonical sy where 1 = blue side (world top): p1
  sends `toViewport()[1]`, p2 sends `1 - toViewport()[1]`. Physics stays identical to the
  original formulas.
- **Spawning is server-only.** A seeded RNG (mulberry32, state in `Sim`, never on the wire)
  drives spawns on the authority. Clients never spawn locally; they **adopt money entities
  by id from snapshots** (invisible 1 s activation delay completely hides adoption latency).
  `Sim.step` gates spawn via an `authority` flag in state.
- **Prediction model** (beam-plan adapted): client predicts **all money** using exact own
  inputs + opponent touches frozen at the last snapshot; own touch *positions* are client
  truth (own-touch trust heuristic, mirroring the reference's own-racket trust). Opponent
  touch/hook rendering uses the vendored `snapshot-interpolation` vault (~120 ms behind),
  money uses per-entity error smoothing (`exp(-dt*10)` decay, hard re-sync beyond 1.0 world
  unit).
- **Effects**: authoritative event channel only for audio/juice: `activate` (spawn burst),
  `collect` (soldi sound + vault punch), `tear` (strappo sound + torn-piece visuals, spawned
  client-side from event payload), `point`, `win`. Prediction never emits effects. The 0.5 s
  suck-in tween stays *inside* sim state (`collect {t, from, to}`) and is serialized in
  snapshots, so prediction renders it seamlessly.
- **Determinism hygiene**: `sim.js` has no DOM/audio/timing/`Math.random`/`Math.hypot`;
  fixed `FIXED = 1/50`; golden-replay test enforces it.

## Protocol (JSON, `{t:...}`)

Client → server:
- `{t:'join', v:1}`
- `{t:'i', seq, k:'d'|'m'|'u', pid, x, z, sy, token}` (d/m carry coords; u needs pid)
- `{t:'ping', ts}` · `{t:'again'}`

Server → client:
- `{t:'room', role:'p1'|'p2'}`
- `{t:'start', tm, token, S: Sim.dump()}`
- `{t:'s', tm, a:[ack1,ack2], tk, ph, sc:[s1,s2], m:[[...]], tp:[[...]]}` @25 Hz, skippable
- `{t:'e', tick, evs:[{ev:'activate'|'collect'|'tear'|'point'|'win', ...}]}`
- `{t:'pong', ts, time}` · `{t:'opp_left'}` · `{t:'ver', v}`

Snapshot money row: `[id, bill, x, y, dx, dy, ux, uy, meshY, state]`, plus
`[ct, fx, fy, safeIdx]` appended when `state === 2` (collecting). state: 0 pending / 1 active /
2 collecting / 3 done. Touch row: `[p, pid, mid, x, z, sy]` (all touches, both players;
client uses opponent rows for prediction/render, own rows only as reconcile base).

## Shared constants (server / client / tests in sync)

`FIXED=1/50`, `SNAP_EVERY=2` (→25 Hz snapshots), `MAX_INPUTS_PER_TICK=8`,
`INPUT_QUEUE_MAX=64`, `COORD_LIMIT=30`, `MAX_POINTERS_PER_PLAYER=2`, `PROTOCOL=1`,
`RESTART_COOLDOWN=1000`, `BACKPRESSURE_LIMIT=65536`, port default 8080.

## Files

| File | Action |
|---|---|
| `package.json` | new — `ws` dep, `start`/`test` scripts |
| `lib/snapshot-interpolation.js` + `.LICENSE` | copied verbatim from `2PlayerPingPong/lib/` |
| `.gitignore` | new — `node_modules/` |
| `sim.js` | new — shared headless sim |
| `server.js` | new — authority server |
| `game.js` | rewrite — net client + prediction (render code largely reused) |
| `index.html` | rewrite — online menu/status overlays, cache-busted scripts |
| `test/{sim,server,prediction,client.boot}.test.js` | new, `node --test` |
| `agent/netcode-plan.md` | this document |
| `README.md` | append online-multiplayer section |

## Verification

`npm test` green; `npm start` + two browser windows — tug-of-war on shared coin, bill
cross-player tear, scoring to 15, win overlay, rematch, close-one → "Opponent left";
`?debug=1` shows prediction stats; `?lat=120&jit=30` stays playable.
