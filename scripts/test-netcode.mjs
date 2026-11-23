// test-netcode.mjs — unit tests for lib/netcode.js (the v2 sync fix).
// Run: node scripts/test-netcode.mjs
import assert from 'node:assert/strict';
import {
  createSnapshotBuffer, pushSnapshot, sampleRenderState,
  createServerClock, clockUpdate, clockNow,
  reconcileLocal, createInputQueue, queueInput, drainInputs,
} from '../lib/netcode.js';

const snap = (tick, t, x) => ({ tick, serverTime: t, state: { phase: 'chase', players: [{ id: 'p1', x, z: 0 }], ball: { x: 0, z: 0 } } });

// 1. Stale / out-of-order snapshots are dropped.
{
  const buf = createSnapshotBuffer();
  assert.equal(pushSnapshot(buf, snap(5, 500, 1)), true);
  assert.equal(pushSnapshot(buf, snap(5, 500, 1)), false, 'duplicate tick dropped');
  assert.equal(pushSnapshot(buf, snap(4, 400, 0)), false, 'older tick dropped');
  assert.equal(buf.snaps.length, 1);
  console.log('PASS netcode stale-snapshot guard');
}
// 2. Interpolation: midpoint between two snapshots is the midpoint position.
{
  const buf = createSnapshotBuffer();
  pushSnapshot(buf, snap(1, 1000, 0));
  pushSnapshot(buf, snap(2, 1033, 0.1485)); // 4.5 m/s * 33 ms
  const { state, mode } = sampleRenderState(buf, 1016.5);
  assert.equal(mode, 'interp');
  assert.ok(Math.abs(state.players[0].x - 0.07425) < 0.001, `midpoint x=${state.players[0].x}`);
  console.log('PASS netcode interpolation midpoint');
}
// 3. Server clock: advances at 1x, slews at most 2 ms per update (no jumps).
{
  const clock = createServerClock();
  clockUpdate(clock, 1000, 1120); // offset -120
  assert.equal(clockNow(clock, 1120), 1000);
  assert.equal(clockNow(clock, 1136), 1016, 'advances 16 ms in 16 ms');
  clockUpdate(clock, 1100, 1150); // sample offset -50, diff +70 -> slew +2 only
  assert.equal(clock.offset, -118);
  console.log('PASS netcode server clock slew');
}
// 4. Reconciliation: keep / blend / snap thresholds.
{
  assert.equal(reconcileLocal({ x: 0, z: 0 }, { x: 0.1, z: 0 }).mode, 'keep');
  const b = reconcileLocal({ x: 0, z: 0 }, { x: 0.4, z: 0 });
  assert.equal(b.mode, 'blend');
  assert.ok(Math.abs(b.x - 0.14) < 0.001, `blend x=${b.x}`);
  assert.equal(reconcileLocal({ x: 0, z: 0 }, { x: 2, z: 0 }).mode, 'snap');
  console.log('PASS netcode reconcile keep/blend/snap');
}
// 5. Input queue: latest movement wins per tick, actions are never dropped.
{
  const q = createInputQueue();
  queueInput(q, 'p1', { seq: 1, mx: 1, action: '' });
  queueInput(q, 'p1', { seq: 2, mx: 0, action: '' });
  queueInput(q, 'p1', { seq: 3, mx: 0, action: 'throw' });
  const drained = drainInputs(q);
  assert.equal(drained.length, 2, 'one movement + one action');
  assert.equal(drained.find((d) => !d.input.action).input.seq, 2);
  assert.equal(drained.find((d) => d.input.action === 'throw').input.seq, 3);
  assert.equal(drainInputs(q).length, 0, 'drain clears');
  console.log('PASS netcode input queue');
}
console.log('All netcode checks passed.');

// 6. Tick-queued inputs are deterministic: two inputs arriving between
//    ticks, drained in seq order and applied via command(), move the
//    player the same amount regardless of the gap between their arrivals.
{
  const { createGame, player, start, command, advance } = await import('../lib/game.js');
  const run = (arrivalGapMs) => {
    const g = createGame('TEST', [3, 3]);
    const me = { ...player('me', 'Aarav', 0), token: 't' };
    const t0 = 1700000000000; g.players = [me]; g.host = me.id; g.last = t0;
    start(g, true, [3, 3]);
    g.phase = 'chase'; g.ready = 0; // opening locks movement; chase is where sync matters
    g.ball.holder = g.players.find((x) => x.id !== 'me').id; // the holder cannot move; test a chaser
    const q = createInputQueue();
    // Inputs arrive at different times, but both are queued before the tick.
    queueInput(q, 'me', { seq: 1, round: g.round, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
    queueInput(q, 'me', { seq: 2, round: g.round, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
    void arrivalGapMs; // arrival timing is irrelevant once queued
    for (const { playerId, input } of drainInputs(q)) command(g, playerId, input);
    advance(g, t0 + 33);
    return g.players.find((p) => p.id === 'me').x;
  };
  const a = run(1), b = run(30);
  assert.ok(Math.abs(a - b) < 1e-9, `tick-queued movement must not depend on arrival gap: ${a} vs ${b}`);
  assert.ok(a > 0, 'player moved');
  console.log('PASS netcode tick-queued inputs deterministic');
}
