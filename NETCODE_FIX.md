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
