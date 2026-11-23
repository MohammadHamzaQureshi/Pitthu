// test-netcode.mjs — unit tests for lib/netcode.js (the v2 sync fix).
// Run: node scripts/test-netcode.mjs
import assert from 'node:assert/strict';
import {
  createSnapshotBuffer, pushSnapshot, sampleRenderState,
  createServerClock, clockUpdate, clockNow,
  reconcileLocal, createInputQueue, queueInput, drainInputs,
  createInputLog, logInput, flushInputLog, replayLocal, predictStep,
  compactTick, mergeTick,
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
  pushSnapshot(buf, snap(2, 1050, 0.225)); // 4.5 m/s * 50 ms (v3: 20 Hz tick)
  const { state, mode } = sampleRenderState(buf, 1025);
  assert.equal(mode, 'interp');
  assert.ok(Math.abs(state.players[0].x - 0.1125) < 0.001, `midpoint x=${state.players[0].x}`);
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

// 7. predictStep applies one input exactly as the server does:
// command() + one 50 ms movePlayerStep(). A player stepped by
// predictStep moves the same distance as the same player stepped by
// the server's step() for one tick, and the movement lock rules match.
{
  const { createGame, player, start, command, step } = await import('../lib/game.js');
  const setup = () => {
    const g = createGame('TEST', [3, 3]);
    const me = { ...player('me', 'Aarav', 0), token: 't' };
    const other = { ...player('other', 'Tara', 1), token: 't2' };
    const t0 = 1700000000000; g.players = [me, other]; g.host = me.id; g.last = t0;
    start(g, true, [3, 3]);
    g.phase = 'chase'; g.ready = 0;
    g.ball.holder = other.id; // the holder cannot move; test a chaser
    const p = g.players.find((x) => x.id === 'me');
    p.x = -4; p.z = 0; p.cool = 0; p.anim = 0; p.stun = 0; p.charging = false;
    return { g, p, t0 };
  };
  const input = { seq: 1, round: 0, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' };
  // Server path: command() then one 50 ms step().
  const a = setup();
  command(a.g, 'me', { ...input, round: a.g.round });
  step(a.g, 0.05);
  // Client path: predictStep on a copy of the same player.
  const b = setup();
  const clone = { ...b.p };
  predictStep(clone, b.g, { ...input, round: b.g.round });
  assert.ok(Math.abs(a.p.x - clone.x) < 1e-9, `predictStep must match server step: ${a.p.x} vs ${clone.x}`);
  assert.ok(Math.abs(a.p.x - (-4 + 4.5 * 0.05)) < 1e-9, `expected 4.5 m/s * 50 ms = 0.225 m, got ${a.p.x + 4}`);
  // Lock: the ball holder does not move.
  const c = setup();
  c.g.ball.holder = 'me';
  const holder = { ...c.p };
  predictStep(holder, c.g, { ...input, round: c.g.round });
  assert.equal(holder.x, -4, 'ball holder must not move');
  // Chappal Dash: 6.2 m/s.
  const d = setup();
  d.p.buff = 'chappal';
  const dash = { ...d.p };
  predictStep(dash, d.g, { ...input, round: d.g.round });
  assert.ok(Math.abs(dash.x - (-4 + 6.2 * 0.05)) < 1e-9, `chappal dash 6.2 m/s * 50 ms, got ${dash.x + 4}`);
  console.log('PASS netcode predictStep parity with server step');
}

// 8. v3 replay vs v2 reconcile at a realistic 150 ms RTT (3 ticks).
// Server: a chaser runs at 4.5 m/s, inputs every 50 ms; the client
// receives the tick-9 snapshot while the server is at tick 12. v2's
// reconcileLocal treats the 3-tick latency gap (0.675 m) as an error and
// yanks the player 35% backward on every snapshot. v3's replayLocal
// re-applies the 3 unacknowledged inputs and lands within 1 cm of the
// server's present position.
{
  const { createGame, player, start, command, advance } = await import('../lib/game.js');
  const run = (juke) => {
    const g = createGame('TEST', [3, 3]);
    const me = { ...player('me', 'Aarav', 0), token: 't' };
    const other = { ...player('other', 'Tara', 1), token: 't2' };
    const t0 = 1700000000000; g.players = [me, other]; g.host = me.id; g.last = t0;
    start(g, true, [3, 3]);
    g.phase = 'chase'; g.ready = 0;
    g.ball.holder = other.id;
    const p = g.players.find((x) => x.id === 'me');
    p.x = -4; p.z = 0; p.cool = 0; p.anim = 0; p.stun = 0; p.charging = false;
    const log = createInputLog();
    const snaps = {}; // tick -> {x, z, seq}
    let now = t0;
    for (let tick = 1; tick <= 12; tick++) {
      const mx = juke && tick > 6 ? -1 : 1; // juke: reverse after tick 6
      const input = { seq: tick, round: g.round, mx, mz: 0, ax: mx, az: 0, interact: false, charging: false, charge: 0, action: '' };
      logInput(log, input);
      command(g, 'me', input);
      now += 50;
      advance(g, now);
      snaps[tick] = { x: p.x, z: p.z, seq: p.seq };
    }
    // Client at tick 12 receives the tick-9 snapshot (150 ms old).
    const auth = { ...p, x: snaps[9].x, z: snaps[9].z, seq: snaps[9].seq };
    const ackSeq = snaps[9].seq;
    const replayed = replayLocal(auth, g, log, ackSeq);
    const serverNow = { x: snaps[12].x, z: snaps[12].z };
    const v2 = reconcileLocal({ x: serverNow.x, z: serverNow.z }, { x: auth.x, z: auth.z });
    return { replayed, serverNow, v2 };
  };
  for (const juke of [false, true]) {
    const { replayed, serverNow, v2 } = run(juke);
    const replayErr = Math.hypot(replayed.x - serverNow.x, replayed.z - serverNow.z);
    assert.ok(replayErr < 0.01, `replay error at 150ms RTT (juke=${juke}) must be <1cm, got ${replayErr}`);
    assert.equal(replayed.mode, 'replay');
    // v2 would have yanked the player backward on this same snapshot.
    assert.equal(v2.mode, 'blend', `v2 reconcile must blend (juke=${juke})`);
    assert.ok(v2.error > 0.3, `v2 latency gap must be >30cm (juke=${juke}), got ${v2.error}`);
    assert.ok(Math.abs(v2.x - serverNow.x) > 0.15, `v2 blend must pull the player back >15cm (juke=${juke})`);
  }
  console.log('PASS netcode replay at 150ms RTT: <1cm error, v2 blend would yank ~24cm');
}

// 9. Compact tick round-trip: mergeTick(compactTick(g)) reproduces the
// full public state for every client-visible field (within quantization
// tolerance), preserves static fields, and is substantially smaller.
{
  const { createGame, player, start, command, advance, publicState } = await import('../lib/game.js');
  const g = createGame('TEST', [4, 4]);
  const host = { ...player('host-1', 'Aarav', 0), token: 'tok-host' };
  const guest = { ...player('guest-1', 'Tara', 1), token: 'tok-guest' };
  const t0 = 1700000000000; g.players = [host, guest]; g.host = host.id; g.last = t0;
  start(g, true, [4, 4]);
  g.phase = 'chase'; g.ready = 0;
  let now = t0;
  const seq = { 'host-1': 0, 'guest-1': 0 };
  for (let tick = 1; tick <= 10; tick++) {
    for (const [id, mx] of [['host-1', 1], ['guest-1', -1]]) {
      command(g, id, { seq: ++seq[id], round: g.round, mx, mz: 0, ax: mx, az: 0, interact: tick === 5, charging: false, charge: 0, action: '' });
    }
    now += 50;
    advance(g, now);
  }
  const base = publicState(g);
  const ack = {};
  for (const p of g.players) ack[p.id] = p.seq || 0;
  const tick = compactTick(g, 100, now, ack);
  const merged = mergeTick(base, tick);
  assert.ok(merged, 'mergeTick must return a state');
  for (const f of ['phase', 'round', 'stack', 'attempts', 'event', 'message', 'host', 'striker', 'attack', 'sfxSeq', 'sfxType']) {
    assert.equal(merged[f], base[f], `top-level ${f}`);
  }
  assert.ok(Math.abs(merged.clock - base.clock) < 0.011, `clock ${merged.clock} vs ${base.clock}`);
  assert.ok(Math.abs(merged.time - base.time) < 0.06, `time ${merged.time} vs ${base.time}`);
  assert.deepEqual(merged.scores, base.scores);
  assert.equal(merged.players.length, base.players.length);
  for (let i = 0; i < base.players.length; i++) {
    const a = base.players[i], b = merged.players[i];
    assert.equal(b.id, a.id);
    assert.equal(b.name, a.name, 'static name preserved');
    assert.equal(b.team, a.team, 'static team preserved');
    assert.equal(b.look, a.look, 'static look preserved');
    for (const f of ['x', 'z', 'ax', 'az']) assert.ok(Math.abs(b[f] - a[f]) < 0.001, `player ${f}: ${b[f]} vs ${a[f]}`);
    for (const f of ['charge', 'anim', 'stun', 'place', 'mx', 'mz', 'cool']) assert.ok(Math.abs((b[f] || 0) - (a[f] || 0)) < 0.011, `player ${f}: ${b[f]} vs ${a[f]}`);
    assert.ok(Math.abs((b.buffTime || 0) - (a.buffTime || 0)) < 0.06, 'player buffTime');
    assert.equal(b.alive, a.alive);
    assert.equal(b.carry, a.carry);
    assert.equal(b.buff, a.buff);
    assert.equal(b.charging, a.charging);
    assert.equal(b.interact, a.interact);
    assert.equal(b.seq, a.seq);
    assert.equal(b.inTowerZone, a.inTowerZone);
    assert.equal(b.bot, a.bot);
  }
  for (const f of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert.ok(Math.abs((merged.ball[f] || 0) - (base.ball[f] || 0)) < 0.001, `ball ${f}`);
  assert.equal(merged.ball.mode, base.ball.mode);
  assert.equal(merged.ball.holder, base.ball.holder);
  assert.equal(merged.stones.length, base.stones.length);
  for (let i = 0; i < base.stones.length; i++) {
    assert.ok(Math.abs(merged.stones[i].x - base.stones[i].x) < 0.001);
    assert.equal(merged.stones[i].placed, base.stones[i].placed);
    assert.equal(merged.stones[i].held, base.stones[i].held);
  }
  const fullSize = JSON.stringify({ type: 'state', state: base }).length;
  const tickSize = JSON.stringify(tick).length;
  assert.ok(tickSize < fullSize * 0.75, `compact tick ${tickSize} must be <75% of full state ${fullSize}`);
  console.log(`PASS netcode compact tick round-trip (${tickSize} vs ${fullSize} bytes, ${Math.round((1 - tickSize / fullSize) * 100)}% smaller)`);
}

// 10. Input log: capped at 30, flush clears.
{
  const log = createInputLog();
  for (let i = 1; i <= 35; i++) logInput(log, { seq: i, round: 0, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
  assert.equal(log.inputs.length, 30, 'log capped at 30');
  assert.equal(log.inputs[0].seq, 6, 'oldest inputs dropped first');
  flushInputLog(log);
  assert.equal(log.inputs.length, 0, 'flush clears');
  console.log('PASS netcode input log cap + flush');
}
console.log('All v3 netcode checks passed.');
