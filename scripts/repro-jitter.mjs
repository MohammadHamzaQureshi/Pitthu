// repro-jitter.mjs — reproduces the reported jitter WITHOUT a live match.
// Simulates the exact old pipeline vs the new pipeline, with numbers.
//
// True motion: a player runs at 4.5 m/s (Pitthu chase speed, lib/game.js).
// Server: snapshots every 50 ms (v3: 20 Hz tick). Network: 120 ms base
// delay + +/-30 ms jitter (typical India mobile / home Wi-Fi to a far
// Durable Object). Client renders at 60 fps.
//
// OLD: render = latest snapshot received (what accept() did — snap).
// NEW: render = interpolated at (latestServerTime - 100 ms).
// Metric: per-frame position jump (what the eye sees as jitter) and
// error vs the true position at render time.
import { createSnapshotBuffer, pushSnapshot, sampleRenderState, createServerClock, clockUpdate, clockNow, INTERP_DELAY_MS } from '../lib/netcode.js';

function simulate(useInterp) {
  const SPEED = 4.5;
  const buf = createSnapshotBuffer();
  // Deterministic pseudo-random jitter so the run is reproducible.
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let tick = 0;
  let delay = 120;
  const clock = createServerClock();
  let nextSnapAt = 0;
  const inFlight = []; // {deliverAt, snap}
  let maxJump = 0, sumSqErr = 0, n = 0, prevRenderX = null;
  const DURATION = 3000, FRAME = 1000 / 60;
  for (let now = 0; now <= DURATION; now += FRAME) {
    // Server ticks.
    while (nextSnapAt <= now) {
      const serverTime = nextSnapAt;
      const trueX = SPEED * (serverTime / 1000);
      const snap = { tick: tick++, serverTime, state: { players: [{ id: 'p1', x: trueX, z: 0, mx: 1, mz: 0 }], ball: { x: 0, z: 0 } } };
      // FIFO: WebSocket/TCP delivers in order. Delay wanders slowly
      // (120ms +/-30ms) instead of reordering packets, which TCP forbids.
      delay = Math.max(90, Math.min(150, delay + (rand() * 20 - 10)));
      inFlight.push({ deliverAt: serverTime + delay, snap });
      nextSnapAt += 50; // v3: 20 Hz tick
    }
    // Deliver arrived snapshots, in order (head of queue only).
    while (inFlight.length > 0 && inFlight[0].deliverAt <= now) {
      const item = inFlight.shift();
      if (pushSnapshot(buf, item.snap)) clockUpdate(clock, item.snap.serverTime, now);
    }
    if (buf.snaps.length === 0) continue;
    let renderX, shownTime;
    if (useInterp) {
      // Smooth server clock: one slewed offset, advances at exactly 1x.
      const serverNow = clockNow(clock, now);
      shownTime = serverNow - INTERP_DELAY_MS;
      const { state } = sampleRenderState(buf, shownTime);
      if (!state) continue;
      renderX = state.players[0].x;
    } else {
      renderX = buf.snaps[buf.snaps.length - 1].state.players[0].x;
      shownTime = buf.snaps[buf.snaps.length - 1].serverTime;
    }
    if (prevRenderX !== null) maxJump = Math.max(maxJump, Math.abs(renderX - prevRenderX));
    prevRenderX = renderX;
    // Error vs the true position at the time actually being shown.
    // Interp intentionally shows ~220 ms in the past (120 ms network +
    // 100 ms buffer); snap shows the latest snapshot's time. Fair
    // comparison is error against that shown time, plus the jump metric.
    const shownTrueX = SPEED * (shownTime / 1000);
    sumSqErr += (renderX - shownTrueX) ** 2;
    n++;
  }
  return { maxJump: +maxJump.toFixed(3), rmse: +Math.sqrt(sumSqErr / Math.max(1, n)).toFixed(3), frames: n };
}

const oldR = simulate(false);
const newR = simulate(true);
console.log('OLD snap-to-latest-snapshot :', JSON.stringify(oldR), 'm per frame / RMSE');
console.log('NEW interpolated (100ms)    :', JSON.stringify(newR), 'm per frame / RMSE');
console.log(`Max per-frame jump: ${oldR.maxJump}m -> ${newR.maxJump}m (${(oldR.maxJump / Math.max(0.001, newR.maxJump)).toFixed(1)}x smoother)`);
if (!(newR.maxJump < oldR.maxJump * 0.6)) { console.error('FAIL: interpolation did not smooth the render'); process.exit(1); }
if (!(newR.rmse < 0.1)) { console.error('FAIL: interpolation error too large vs shown time'); process.exit(1); }
console.log('PASS repro-jitter: interpolation measurably smooths the same network conditions');
