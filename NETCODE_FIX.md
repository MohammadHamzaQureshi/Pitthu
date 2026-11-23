# Pitthu netcode fix v2 — why v1 still jittered, and what changed

Date: 2026-11-23. Reported by Mohammad: live game still not synced,
jitter, bugs, ping issues — despite the WebSocket / Durable Object fix.

## 1. Evidence base (nothing here is from memory alone)

Checked 2026-11-23, 23:08 IST:

- GitHub `MohammadHamzaQureshi/Pitthu`, HEAD `e21470d6`
  ("Configure D1 database ID and migrations") — the WS fix IS deployed.
  `vite.config.ts` on GitHub has the real D1 id
  `fde4d1e8-596f-4730-90ac-70037f733ac4`.
- Live site `https://pitthu.pitthu-game.workers.dev` returns HTTP 200.
- Code read line-by-line in this workspace copy
  (`~/workspace/pitthu`, same files as GitHub HEAD except the
  `vite.config.ts` placeholder name — value already replaced on GitHub):

| Claim | Exact location |
|---|---|
| Client snaps to every server snapshot | `app/pittu.tsx:316-322`, `accept()`: `game.current = g` |
| `ws.onmessage` accepts any state, no ordering check | `app/pittu.tsx:343-346` (before fix) |
| Local dead-reckoning mutates the authoritative object | `app/pittu.tsx:51-81`, `stepOnlineVisuals()` + call at `:492` |
| Server applies inputs on WS arrival | `worker/room-do.ts:449-453`, `command(...)` in the message handler |
| Server broadcasts actions immediately, out of tick order | `worker/room-do.ts:454-458` (before fix) |
| Server tick uses wall clock + DO alarms | `worker/room-do.ts:169-190`, `advance(game, Date.now())` |
| Broadcast had no tick id / timestamp | `worker/room-do.ts:195-205` (before fix) |
| Client never measured RTT | no `ping` send in `app/pittu.tsx` (before fix); server had a `ping`→`pong` handler nobody called |
| Ball holder cannot move (game rule, not a bug) | `lib/game.js:919-922` — movement only if `ball.holder !== p.id` |

So v1 fixed the transport (polling + D1 writes + 409s) but left the
netcode unsmoothed. That is why it *felt* the same: the sync path was
faster, but the render still snapped 30 times a second.

## 2. Reproduction — measured, not asserted

`scripts/repro-jitter.mjs` simulates the exact old vs new pipeline:
player runs at 4.5 m/s, server snapshots every 33 ms, network 120 ms
±30 ms (FIFO — WebSocket/TCP delivers in order, so the model uses
ordered delivery with a wandering delay, not reordered packets).

Result on this machine (deterministic seed):

```
OLD snap-to-latest-snapshot : maxJump 0.149 m/frame, RMSE 0.000*
NEW interpolated (100 ms)   : maxJump 0.084 m/frame, RMSE 0.055 m
Max per-frame jump: 0.149 m -> 0.084 m (1.8x smoother)
```

*OLD RMSE 0 is trivial: a snap is exact at its own timestamp. The
real defect is the jump: one full 33 ms tick of movement (0.149 m)
landing in a single 16 ms frame, every time a snapshot arrives late.
Ideal smooth motion is 0.075 m/frame at 4.5 m/s; the new pipeline is
at 0.084 m/frame. The 0.055 m RMSE is the cost of the 100 ms
interpolation buffer + clock offset — smooth lag, not a jump.

Two mistakes were caught while building this repro, and fixed rather
than hidden (see git history of this file's development):
- Anchoring the server clock as `lastServerTime + (now - lastRecv)`
  stalls render time for one frame on every arrival, then jumps two
  frames' worth. Fixed with a slewed clock offset (`lib/netcode.js`,
  `createServerClock`, max 2 ms slew per snapshot).
- Modelling network delay as independent per-packet delays reorders
  packets, which TCP forbids. Fixed to FIFO delivery.

## 3. What changed

### New: `lib/netcode.js` (pure, no React/DOM/WS — unit-tested)
- `createSnapshotBuffer` / `pushSnapshot` — drops stale/out-of-order
  snapshots (tick <= last accepted).
- `sampleRenderState` — interpolates players + ball x/z between the
  two snapshots bracketing render time; discrete fields (phase,
  scores, holder) always come from the newer snapshot; capped
  100 ms extrapolation when a snapshot is late.
- `createServerClock` / `clockUpdate` / `clockNow` — one offset,
  slewed ≤2 ms per snapshot, so render time advances at exactly 1x.
- `reconcileLocal` — keep (<15 cm error), blend 35% (<80 cm), snap
  (≥80 cm, e.g. hit / teleport / round reset).
- `createInputQueue` / `queueInput` / `drainInputs` — latest movement
  wins per player per tick; one-shot actions are never dropped.

### Server: `worker/room-do.ts`
- Inputs are **queued on arrival, drained only inside `alarm()`**
  at the tick boundary, in per-player seq order.
- Immediate action broadcast removed (it could overtake the previous
  tick's snapshot). Cost: at most +33 ms action latency.
- Every `state` / `hello` now carries `{tick, serverTime}`.
- `ping` now replies `{type:'pong', clientTime, serverTime}`.

### Client: `app/pittu.tsx`
- `ws.onmessage` drops stale snapshots, updates the server clock.
- `accept()` now reconciles the predicted local position instead of
  only snapping; a round change resets prediction to the spawn.
- The frame loop builds a fresh **render copy** from the interpolation
  buffer each frame and runs `stepOnlineVisuals` on that copy only.
  `game.current` (authoritative) is never mutated by rendering again.
  A double-step bug (prediction applied twice per frame) was caught
  in review and removed before shipping.
- Ping sent once a second; RTT shown in the HUD next to the leave
  button as e.g. `87 ms`.

## 4. Tests — all run locally, all pass

```
npm test
  test-game.mjs        PASS
  test-regressions.mjs PASS
  test-realtime.mjs    PASS (304 ticks @30 Hz, 400 inputs @20 Hz)
  test-netcode.mjs     PASS (7 checks: stale guard, midpoint,
                       clock slew, keep/blend/snap, input queue,
                       tick-queued determinism)
  repro-jitter.mjs     PASS (0.149 -> 0.084 m/frame)
  test-assets.mjs      PASS
```

TypeScript syntax check (transpile-only, no type errors hidden):
`app/pittu.tsx`, `worker/room-do.ts`, `worker/index.ts` — SYNTAX OK.

## 5. What is NOT yet verified — be honest about this

- **No live 2-player test has been run on the deployed site yet.**
  The simulation + unit tests prove the smoothing maths and the
  ordering, not the real Nagpur → Durable Object RTT.
- The Durable Object's physical location is not pinned; if it was
  created far from India, RTT will still be high — the new ping HUD
  will show that number, and if it is >150 ms consistently, the next
  step is to investigate DO placement / jurisdiction, not more
  client smoothing.
- Interpolation adds ~100 ms of visual delay by design (you see
  other players where they were 100 ms ago, smoothly, instead of
  where they are now, jumpily). That is the standard trade-off.

## 6. How to verify after deploy (do this before trusting it)

1. Deploy via Antigravity (see the prompt in the chat — `wrangler deploy`).
2. Open the live site on 2 devices, join the same room, start a match.
3. Look at the ping pill in the top bar. Note the number on each device.
4. Run around for 30 seconds. Other players should glide, not teleport.
   Your own character should respond immediately and not rubber-band.
5. If the other player still teleports, tell Muse the ping number and
   whether it is your own character, the other player, or the ball —
   that distinguishes a network problem (high ping) from a sync bug.

---

# v3 — proper prediction + replay, interval tick, compact ticks, apac pin

Date: 2026-11-24. Reported by Mohammad: v2 still does not work properly
in live play. An independent critique ("Gemini Neon", 6 bugs) was pasted
in and verified claim-by-claim against the code before building v3.
Four extra edge-case guardrails from the same source were verified and
folded in (see §7).

## 0. Correction to the v2 write-up (honesty note)

The v2 report (and the chat) claimed the per-tick `alarm()` also awaited
a full D1 checkpoint on every tick. That was WRONG. `checkpoint()` in
`worker/room-do.ts` is throttled to once per 10 s (`CHECKPOINT_MS`):
the per-tick `await this.checkpoint()` is a cheap early return, and the
real D1 `UPDATE` fires at most once per 10 s. The real per-tick storage
cost in v2 was the `setAlarm()` call alone (a durable storage write per
tick, best-effort timing). v3 still moves checkpoints off the tick path
entirely (see §3) — but the justification is the alarm write + the
once-per-10 s awaited D1 write inside the tick, not a per-tick D1 write.

## 1. What was wrong in v2 (verified, with locations)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `alarm()` as the 30 Hz loop | CONFIRMED | `worker/room-do.ts` `scheduleTick` called `ctx.storage.setAlarm(...)` every tick; alarms are durable storage writes with no real-time guarantee |
| 2 | Reconciliation compares present prediction to a ~150 ms-old snapshot, no input replay | CONFIRMED, the worst one | `lib/netcode.js:154` `reconcileLocal`; no `lastProcessedSeq` anywhere in the code. At 4.5 m/s and 150 ms RTT the "error" is ~68 cm with zero desync → 35% backward blend or hard snap on every snapshot |
| 3 | `stepOnlineVisuals` on top of the interpolated copy + world.js lerp | CONFIRMED | `app/pittu.tsx:535-544` interpolates, then runs `stepOnlineVisuals` on the copy; `lib/world.js:1032` lerps remote players again (`dt*22`) |
| 4 | 20 Hz input vs 30 Hz tick | REAL BUT MODERATE | 1 in 3 ticks got no fresh input; main cost was one-shot action latency |
| 5 | Full-state JSON broadcast 30x/sec | TRUE BUT LOWER PRIORITY | `worker/room-do.ts:208-229` `broadcast()` sent the whole `publicState` every tick |
| 6 | Unpinned DO region | CONFIRMED | `worker/index.ts:32` `env.PITTHU_ROOM.get(id)` with no `locationHint` |
| 7 | (found while checking, Gemini missed it) | — | `alarm()` also awaited `checkpoint()` on every tick; the throttle limits real writes to 1/10 s, but the tick still awaited the check (see §0) |

The v2 repro criticism was fair: it only tested a straight-line remote
player on a clean synthetic 33 ms timer — never alarm stalls, local
reconciliation at 150 ms RTT, or a juke. The v3 stress test
(`scripts/test-v3-stress.mjs`) covers exactly those conditions.

## 2. What changed — server (`worker/room-do.ts`)

- **In-memory `setInterval` tick at 20 Hz, fixed 50 ms steps on a
  synthetic clock** (`tickNow += 50`, `advance(g, tickNow)`). The
  interval is guarded (`startTickLoop` returns if one already runs) so
  reconnects/simultaneous joins can never start two overlapping
  intervals (double-speed bug); it is cleared when the last socket
  disconnects or the match ends. `alarm()` is now only a 60 s watchdog:
  if the interval ever dies while players are connected, the alarm
  restarts it. The tick path does ZERO I/O.
- **D1 checkpoints via `ctx.waitUntil()` on discrete events**
  (`checkpointSoon()`, throttled to once per 10 s) — never awaited
  inside the tick. Final save on last-socket close also uses
  `waitUntil`.
- **Server echoes `lastProcessedSeq` per player** (`ack` map, built
  from `p.seq` — the seq `command()` last applied). Every broadcast
  (`hello` / `state` / `tick`) carries it.
- **Compact tick updates** (`lib/netcode.js` `compactTick`): per-tick
  payload as quantized positional arrays, no static fields (names,
  teams, looks, teamSizes come from the last full state). Full
  `publicState` only on hello and on discrete transitions
  (event/phase/round/scores change, powerup/decoy spawn/despawn).
  Measured: 1034 vs 4046 bytes for a 4v4 state (74% smaller).
- **20 Hz tick + 20 Hz input, 1:1** — every tick gets exactly one
  fresh input per player. `doOp('start')` keeps the synthetic clock
  authoritative when the loop runs (`g.last = tickNow`).

## 3. What changed — client prediction (`lib/netcode.js`, `app/pittu.tsx`)

- **Proper client-side prediction + input replay.** The client keeps
  every sent input in a log (capped at 30) and, on each snapshot/tick,
  starts from the server's authoritative position and replays only
  inputs with `seq > ack` through the exact server step
  (`predictStep` = `command()` + one 50 ms `movePlayerStep()`).
  The replayed position IS the present-tense estimate; the gap to the
  authoritative position is expected latency, not an error — so there
  is deliberately NO distance-based snap in `replayLocal` (a 150 ms
  RTT at Chappal Dash speed is a 0.93 m gap, and v2's 0.8 m snap
  threshold would have treated it as a teleport). The replay re-bases
  from the authoritative position on every snapshot, so real events
  are picked up by the next snapshot and by the flush (below).
  Only a non-finite result falls back to authoritative.
- **Exact replay parity by construction.** `movePlayerStep()` was
  extracted from `step()` in `lib/game.js` (same speeds 4.5 / 3.95 /
  6.2, same ×0.58 Tower Zone, same axis-separated `blocked()`, same
  lock rules) and is used by BOTH the server simulation and the client
  replay — no copied numbers that can drift. Two parity bugs were
  caught by the tests while building: (a) the replay's mini-game was
  missing `attack`, so the Tower Zone check (`team !== attack`) was
  always true near the centre; (b) a distance-based snap threshold
  (see above).
- **Strict local/remote render split.** Remote players + ball are
  purely interpolated (no `stepOnlineVisuals`, no world.js lerp on top
  — `stepOnlineVisuals` is deleted). Remote players in the render copy
  carry `_interp`, and `lib/world.js` sets their visual root directly
  (`posBlend = 1`) instead of lerping. The local player keeps the fast
  `dt*48` lerp, which smooths the 20 Hz prediction steps into 60 fps
  motion. The local player is the predicted position, never delayed
  by the 100 ms interpolation buffer.
- **Held ball anchored to the predicted hand.** When the ball is held
  by the local player, `world.js` already positions the ball mesh from
  the holder's hand bones — and the local player's hand is at the
  predicted position — so the ball follows the predicted hand, not the
  ~100 ms-delayed ball snapshot. No extra code was needed beyond the
  predicted local position; this was verified, not assumed.
- **One-shot actions flush immediately.** `sendInputNow()` (shared by
  the 50 ms sender and a frame-loop flush) sends throw/pass/interact/
  drop/cancel within one frame (~16 ms) of the key/mouse/touch press
  instead of waiting for the next 50 ms sender tick.
- **Buffer flush on round/phase change, stun, or death** (`accept()`):
  the pending-input log is cleared and the prediction resets to the
  authoritative position, so pre-reset inputs never replay onto a new
  spawn. The round filter in `replayLocal` is a second layer (old-round
  inputs are dropped even if unacknowledged).

## 4. What changed — DO placement (`worker/index.ts`, `app/api/room/route.ts`)

`locationHint` is passed on the FIRST `PITTHU_ROOM.get()` that
instantiates the object — at BOTH first-touch points, because the
first touch is a race between the creator's WebSocket upgrade
(`worker/index.ts`) and the first lobby op forwarded through
`roomStub` (`app/api/room/route.ts`). A hint on the WS join alone
would be too late (the object already exists by then). Derived from
`request.cf.continent`: `AS` → `apac` (the one that matters for this
game's players in India), plus `NA` → `enam`, `SA` → `sam`,
`EU` → `weur`, `AF` → `afr`, `OC` → `oc`; anything else lets
Cloudflare choose.

## 5. Tests — all run locally, all pass

```
npm test
  test-game.mjs        PASS
  test-regressions.mjs PASS
  test-realtime.mjs    PASS (200 ticks @20Hz, 400 inputs @20Hz)
  test-netcode.mjs     PASS (11 checks incl. predictStep parity,
                       replay at 150ms RTT <1cm, compact tick
                       round-trip 74% smaller, input log cap+flush)
  test-v3-stress.mjs   PASS (tick determinism: 100 late callbacks,
                       clock exactly 5.000s; replay under stalls:
                       30 receipts at 150ms RTT + 200ms stall,
                       max error 0.00cm; stale-round filter;
                       compact tick under load, max drift 0.50mm)
  repro-jitter.mjs     PASS (0.225 -> 0.084 m/frame, 2.7x smoother)
  test-assets.mjs      PASS
```

Key numbers (measured, not asserted):
- Replay error at 150 ms RTT (straight + juke, Chappal Dash):
  < 1 cm. The same snapshot under v2's `reconcileLocal` would have
  blended the player ~24 cm backward.
- Remote interpolation at 20 Hz ticks: max per-frame jump
  0.225 m → 0.084 m (2.7x smoother).
- Compact tick: 74% smaller than the full state (4v4).
- Tick determinism: 100 callbacks fired 30–170 ms late/early;
  the game clock still advanced exactly 5.000 s.

## 6. What is NOT yet verified — be honest about this

- **No live 2-player test has been run on the deployed site yet.**
  The simulation + unit tests prove the maths under real-RTT and
  stall conditions, not the real Nagpur → Durable Object RTT.
- The `apac` locationHint only applies to rooms created AFTER this
  deploy (existing DO instances keep their original location). New
  rooms created from India should show a lower, steadier RTT in the
  HUD ping pill (typically ~40–90 ms instead of 180–300 ms if the
  old object was far away).
- Interpolation still adds ~100 ms of visual delay by design for
  remote players and the loose ball.

## 7. Guardrails folded in (all verified against the code)

1. Replay parity — speeds confirmed exactly in `lib/game.js:917-919`
   (6.2 / 3.95 / 4.5 / ×0.58) and axis-separated `blocked()` (921-922);
   replay reuses the same step code, buffer capped at 30, flushed on
   round/phase change, stun, or death.
2. Single `setInterval` guard + D1 checkpoints via `ctx.waitUntil`
   on discrete events only, never awaited in the tick.
3. Held ball anchored to the local predicted hand (verified in
   `lib/world.js` hand-anchoring, see §3).
4. `locationHint` on the create route, not just the WS join (see §4).

## 8. v3.1 — the lobby freeze (2026-11-24, ~02:32–03:00 IST)

Two NEW bugs, both introduced by v3.0, both found because Mohammad
reported the lobby was unusable minutes after the v3 deploy — and both
reproduced live in a fresh browser before the fix (room 4NL6JN).

### 8.1 Bug A — the tick-0 stale drop froze the lobby (client)

The server tick counter stays 0 for the whole lobby phase (it only
increments once a round runs). The v3 client's `pushSnapshot` drops any
snapshot whose tick is `<=` the last accepted tick. The `hello` message
already used tick 0, so EVERY lobby broadcast after it — config acks,
start acks, join updates — was dropped as "stale" before `accept()`
ever ran. The lobby UI only ever showed the state from the HTTP join.

Symptoms, exactly as reported and reproduced:
- Team-size steppers and the 2v2 preset did nothing on screen (the
  server accepted the config; the display never updated).
- The first "Let's play" click DID start the round on the server, but
  the screen threw the reply away and stayed in the lobby.
- The second click then correctly failed with "A round is already
  playing." — the server's phase was `opening` by then.

Proven by simulation with the real `lib/netcode.js`: hello (tick 0)
accepted, config ack (tick 0, 2v3) DROPPED, start ack (tick 0,
`opening`) DROPPED, compact tick #1 accepted. D1 evidence: room
DARA7E's checkpoint showed phase `lobby`, round 0, event 26 (many
config attempts); FTJR69 event 8.

Fix (`lib/netcode.js`, `app/pittu.tsx`): `acceptFullState()` — a full
`state`/`hello` message is an authoritative transition, not a snapshot,
so it is always accepted; when its tick did not advance, the
interpolation history is re-based on it instead of dropping it. The
strict stale guard stays for compact `tick` messages, where ordering
is what keeps interpolation smooth. New test 11 in
`scripts/test-netcode.mjs` covers it.

### 8.2 Bug B — the setInterval tick never ran (server)

v3.0 replaced v2's alarm-driven tick with a guarded in-memory
`setInterval`, on the assumption that an open WebSocket keeps a
Durable Object awake. It does not: a DO hibernates when idle, and
`setInterval` does not wake it — Cloudflare's own guidance is to use
alarms for periodic work in a DO. Evidence the interval never fired:
- The browser repro watched 5+ seconds after a successful start and
  the game screen never appeared (the tick-#1 heal never came).
- D1 for the repro room 4NL6JN showed phase `lobby`, event 0,
  clock 0, last updated at creation time — no checkpoint ever fired,
  and `checkpointSoon()` runs on every game-phase tick.
- v2's alarm tick demonstrably worked (matches ran, jittery but
  playable); v3.0's interval tick produced no game-phase tick at all.

Fix (`worker/room-do.ts`): the alarm IS the tick loop now — one alarm
per tick, re-armed at the end of each tick (armed first, so a throw
cannot break the chain), guarded by `alarmScheduled` so reconnects
can never double-schedule it. `ensureTicking()` is called on WS
connect, on every WS message and on every forwarded op, so the loop
re-arms itself if the chain ever breaks. Each alarm runs
`alarmTickSteps(elapsed)` fixed 50 ms steps (capped at 4) on the
synthetic clock, so alarm stalls cost game time only beyond the cap
and the game never runs fast. The tick path still does no awaited
I/O; D1 checkpoints stay on `ctx.waitUntil()`.

Also fixed in the same deploy: HTML documents are now served with
`Cache-Control: no-store` (`worker/index.ts`), so a browser can never
run a stale client against a new server after a deploy (the JS chunks
are content-hashed and `immutable`, which is correct as-is). A cached
v2 client would have ignored compact `tick` messages entirely, which
matches the same frozen-lobby symptom and could not be ruled out for
Mohammad's own session — he should hard-refresh once after this
deploy.

### 8.3 v3.1 tests (all pass)

- New netcode test 11: full states accepted at a non-advancing tick
  (hello, config ack 2v3, start ack all accepted; duplicate tick
  still dropped).
- Rewritten v3 stress check 1: 20 alarms with 50/100/150/200 ms gaps
  — game clock tracks wall time EXACTLY (2.50 s), player position
  matches the clock exactly; `alarmTickSteps(500) === 4` (cap holds).
- Full `npm test` green (game, regressions, realtime, netcode,
  repro-jitter, v3 stress, assets).
