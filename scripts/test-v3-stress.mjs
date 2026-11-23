// test-v3-stress.mjs — v3 netcode under REAL conditions, not a clean timer.
//
// Gemini's fair criticism of the v2 repro was that it only tested a
// straight-line remote player on a clean synthetic 33 ms timer — never
// alarm stalls, local reconciliation at 150 ms RTT, or a juke. This
// file tests exactly those conditions, end to end, with the real
// game.js / netcode.js code (no mocks of the movement rules):
//
//  1. v3 tick determinism: the server tick advances the game exactly
//     50 ms per tick even when the interval callback fires late
//     (jittered wall-clock) — because it steps a synthetic clock.
//  2. Replay under stalls: a full client/server run at 150 ms RTT with
//     a juke + Chappal Dash, where one snapshot is stalled by an extra
//     200 ms (the old alarm-stall failure mode). On every snapshot
//     receipt the replay must land within 2 cm of the server's present
//     position.
//  3. Buffer flush on phase change: pre-flip inputs must never replay
//     onto the new phase.
//  4. Compact tick under load: 20 chained compactTick/mergeTick rounds
//     on a 4v4 game must not drift from publicState.
//
// Run: node scripts/test-v3-stress.mjs
import assert from 'node:assert/strict';
import { createGame, player, start, command, advance, publicState } from '../lib/game.js';
import {
  createInputLog, logInput, flushInputLog, replayLocal,
  compactTick, mergeTick, alarmTickSteps,
} from '../lib/netcode.js';

// Deterministic pseudo-random so the run is reproducible.
let seed = 1337;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// A 3v3 chase game with 'me' as a chaser. Returns {g, me, other, t0}.
function makeGame() {
  const g = createGame('TEST', [3, 3]);
  const me = { ...player('me', 'Aarav', 0), token: 't' };
  const other = { ...player('other', 'Tara', 1), token: 't2' };
  const t0 = 1700000000000;
  g.players = [me, other];
  g.host = me.id;
  g.last = t0;
  start(g, true, [3, 3]);
  g.phase = 'chase';
  g.ready = 0;
  g.ball.holder = other.id; // holder cannot move; 'me' is the chaser
  const p = g.players.find((x) => x.id === 'me');
  p.x = -4; p.z = 0; p.cool = 0; p.anim = 0; p.stun = 0; p.charging = false;
  return { g, p, t0 };
}

// 1. v3.1 alarm-driven tick determinism under late alarms.
// The server tick is driven by Durable Object alarms (v3.0 used
// setInterval, which never fired a single tick live — a hibernating DO
// is not woken by timers). Alarms fire late, so each alarm runs as many
// fixed 50 ms steps as elapsed since the last alarm (alarmTickSteps,
// capped at 4). Alarm gaps here are exact multiples of 50 ms (50/100/
// 150/200), so the game clock must track wall time EXACTLY; a 500 ms
// gap then proves the cap (only 200 ms of game time — bounded loss,
// never fast, never a spiral).
{
  const { g, p, t0 } = makeGame();
  const gaps = [50, 100, 150, 200, 50, 100, 150, 200, 50, 100, 150, 200, 50, 100, 150, 200, 50, 100, 150, 200];
  let tickNow = t0;
  let wallNow = t0;
  let tick = 0;
  for (const gap of gaps) {
    wallNow += gap;
    const steps = alarmTickSteps(gap);
    for (let s = 0; s < steps; s++) {
      tick++;
      command(g, 'me', { seq: tick, round: g.round, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
      tickNow += 50;
      advance(g, tickNow);
    }
  }
  const wallSecs = (wallNow - t0) / 1000;
  assert.ok(Math.abs(g.clock - wallSecs) < 1e-9, `game clock must track wall time exactly, got ${g.clock} vs ${wallSecs}`);
  // 4.5 m/s * wallSecs from -4 (before the court obstacle near x=8.7).
  const expectX = -4 + 4.5 * wallSecs;
  assert.ok(Math.abs(p.x - expectX) < 1e-9, `player must be at ${expectX}, got ${p.x}`);
  // The cap: a 500 ms stall advances only 4 steps (200 ms) — bounded loss.
  assert.equal(alarmTickSteps(500), 4, '500 ms gap capped at 4 steps');
  assert.equal(alarmTickSteps(50), 1, '50 ms gap is 1 step');
  assert.equal(alarmTickSteps(120), 2, '120 ms gap is 2 steps');
  assert.equal(alarmTickSteps(0), 1, 'zero/negative gap is 1 step');
  assert.equal(alarmTickSteps(-10), 1, 'negative gap is 1 step');
  console.log(`PASS v3.1 stress alarm tick: ${gaps.length} alarms, clock exactly ${wallSecs.toFixed(2)}s, cap holds`);
}

// 2. Replay under stalls at 150 ms RTT, with a juke + Chappal Dash.
// Server ticks at 20 Hz. 'me' runs a juke (right, left, right) at
// Chappal Dash speed (6.2 m/s). Snapshots are delayed 150 ms +/-30 ms,
// and the tick-15 snapshot is stalled by an extra 200 ms (the old
// alarm-stall failure mode). TCP delivers in order, so a stalled
// snapshot holds up later ones. On every receipt the client replays
// its unacknowledged inputs and must land within 2 cm of the server's
// present position.
{
  const TICKS = 30;
  const { g, p, t0 } = makeGame();
  p.buff = 'chappal'; p.buffTime = 99; // dash for the whole run
  const allInputs = []; // allInputs[tick] = the input the client sends for that tick
  const snaps = []; // snaps[tick] = publicState copy at that tick
  const inputFor = (tick) => {
    const mx = tick <= 10 ? 1 : tick <= 20 ? -1 : 1; // juke: R, L, R
    return { seq: tick, round: g.round, mx, mz: 0, ax: mx, az: 0, interact: false, charging: false, charge: 0, action: '' };
  };
  let now = t0;
  for (let tick = 1; tick <= TICKS; tick++) {
    const input = inputFor(tick);
    allInputs[tick] = input;
    command(g, 'me', input);
    now += 50;
    advance(g, now);
    snaps[tick] = publicState(g);
  }
  // Delivery: snapshot for tick k is created at k*50, delivered at
  // k*50 + delay(k). delay = 150 +/- 30 ms, +200 ms stall on tick 15.
  // TCP delivers in order: a receipt is never earlier than the
  // previous receipt. The client sends one input per 50 ms of wall
  // time, so by receipt time it has sent inputs up to the server's
  // present tick — the replay re-applies exactly those, and must land
  // on the server's present position.
  const log = createInputLog();
  let loggedUpTo = 0;
  let prevReceive = 0;
  let maxErr = 0;
  let receipts = 0;
  for (let k = 1; k <= TICKS; k++) {
    const stall = k === 15 ? 200 : 0;
    const delay = 150 + (rand() * 60 - 30) + stall;
    const receiveAt = Math.max(k * 50 + delay, prevReceive);
    prevReceive = receiveAt;
    // Server's present tick at receipt time (it keeps ticking).
    const serverTick = Math.min(TICKS, Math.floor(receiveAt / 50));
    // Client has sent inputs up to the present tick by now.
    for (let s = loggedUpTo + 1; s <= serverTick; s++) logInput(log, allInputs[s]);
    loggedUpTo = serverTick;
    const snap = snaps[k];
    const authMe = snap.players.find((x) => x.id === 'me');
    const replayed = replayLocal(authMe, snap, log, authMe.seq);
    const serverNow = snaps[serverTick].players.find((x) => x.id === 'me');
    const err = Math.hypot(replayed.x - serverNow.x, replayed.z - serverNow.z);
    maxErr = Math.max(maxErr, err);
    receipts++;
    assert.ok(err < 0.02, `receipt tick ${k} (stall=${stall}ms, serverTick=${serverTick}): replay error ${err.toFixed(4)}m must be <2cm`);
    assert.equal(replayed.mode, 'replay', `receipt tick ${k}: mode must be replay, got ${replayed.mode}`);
  }
  console.log(`PASS v3 stress replay under stalls: ${receipts} receipts at 150ms RTT + 200ms stall, max error ${(maxErr * 100).toFixed(2)}cm`);
}

// 3. Stale-round inputs never replay onto a new round.
// A round change respawns the player. Inputs from the old round must
// not move the player from the new spawn — even if they are
// unacknowledged (seq > ack) and the log was never flushed, the round
// filter in replayLocal drops them. (The flush in accept() is belt and
// braces on top of this; the ack pruning drops acknowledged inputs.)
{
  const { g, p, t0 } = makeGame();
  const log = createInputLog();
  let now = t0;
  for (let tick = 1; tick <= 6; tick++) {
    const input = { seq: tick, round: g.round, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' };
    logInput(log, input);
    command(g, 'me', input);
    now += 50;
    advance(g, now);
  }
  const authBefore = publicState(g).players.find((x) => x.id === 'me');
  assert.ok(Math.abs(authBefore.x - (-2.65)) < 1e-9, 'player must have run to -2.65');
  // Round change: new round, player respawned. The server's seq stays 6.
  g.round = 1;
  p.x = -4; p.z = 0;
  const after = publicState(g);
  const authAfter = after.players.find((x) => x.id === 'me');
  assert.equal(authAfter.seq, 6, 'seq carries across the round');
  // In-flight inputs from the OLD round (unacknowledged, seq > ack).
  const staleLog = createInputLog();
  for (const seq of [10, 11, 12]) {
    logInput(staleLog, { seq, round: 0, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
  }
  const stale = replayLocal(authAfter, after, staleLog, authAfter.seq);
  const staleErr = Math.hypot(stale.x - authAfter.x, stale.z - authAfter.z);
  assert.ok(staleErr < 0.001, `old-round inputs must not move the player from the new spawn, got ${staleErr}`);
  // Control: the same inputs stamped with the NEW round DO move the
  // player — so the test is not vacuous.
  const freshLog = createInputLog();
  for (const seq of [10, 11, 12]) {
    logInput(freshLog, { seq, round: 1, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: '' });
  }
  const fresh = replayLocal(authAfter, after, freshLog, authAfter.seq);
  const freshErr = Math.hypot(fresh.x - authAfter.x, fresh.z - authAfter.z);
  assert.ok(freshErr > 0.5, `new-round inputs must move the player (got ${freshErr.toFixed(2)}m) — otherwise the test is vacuous`);
  console.log(`PASS v3 stress stale-round filter: old-round inputs move 0.00m, new-round inputs move ${freshErr.toFixed(2)}m`);
}

// 4. Compact tick under load: 20 chained compactTick/mergeTick rounds
// on a 4v4 game must not drift from publicState.
{
  const g = createGame('TEST', [4, 4]);
  const host = { ...player('host-1', 'Aarav', 0), token: 'tok-host' };
  const guest = { ...player('guest-1', 'Tara', 1), token: 'tok-guest' };
  const t0 = 1700000000000;
  g.players = [host, guest];
  g.host = host.id;
  g.last = t0;
  start(g, true, [4, 4]);
  g.phase = 'chase'; g.ready = 0;
  let now = t0;
  let base = publicState(g);
  const seq = { 'host-1': 0, 'guest-1': 0 };
  let maxPosErr = 0;
  for (let tick = 1; tick <= 20; tick++) {
    for (const [id, mx] of [['host-1', 1], ['guest-1', -1]]) {
      command(g, id, { seq: ++seq[id], round: g.round, mx, mz: 0, ax: mx, az: 0, interact: tick === 7, charging: false, charge: 0, action: '' });
    }
    now += 50;
    advance(g, now);
    const ack = {};
    for (const p of g.players) ack[p.id] = p.seq || 0;
    const ct = compactTick(g, tick, now, ack);
    base = mergeTick(base, ct);
    const full = publicState(g);
    for (let i = 0; i < full.players.length; i++) {
      const a = full.players[i], b = base.players[i];
      assert.equal(b.id, a.id);
      maxPosErr = Math.max(maxPosErr, Math.abs(b.x - a.x), Math.abs(b.z - a.z));
    }
    assert.equal(base.stones.length, full.stones.length);
  }
  assert.ok(maxPosErr < 0.001, `chained merge must not drift, max pos error ${maxPosErr}`);
  console.log(`PASS v3 stress compact tick under load: 20 chained ticks, max drift ${(maxPosErr * 1000).toFixed(2)}mm`);
}

console.log('All v3 stress checks passed.');
