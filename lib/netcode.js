// netcode.js — pure, testable multiplayer smoothing for Pitthu.
// No React, no WebSocket, no DOM. Every function here is covered by
// scripts/test-netcode.mjs / scripts/test-v3-stress.mjs, so the fix can
// be verified without playing a live match.
//
// v2 (see NETCODE_FIX.md) fixed transport + smoothing but left three
// real bugs, all verified in the live code (see the v3 section of
// NETCODE_FIX.md):
//  1. Server ticked via alarm() — a durable storage write per tick,
//     best-effort timing, so ticks stalled.
//  2. reconcileLocal() compared the CURRENT predicted position against
//     a ~RTT-old snapshot with no input replay — at 150 ms RTT that is
//     a ~68 cm "error" with zero desync, so v2 yanked the player
//     backward on every snapshot (rubber-banding).
//  3. stepOnlineVisuals() + world.js dt*22 lerp smoothed remote
//     players a second and third time on top of interpolation.
//
// v3 fixes, in this file:
//  A. Prediction + input replay (predictStep / replayLocal): the server
//     echoes lastProcessedSeq (ack) per player; the client replays only
//     unacknowledged inputs through the exact server step.
//  B. Compact tick updates (compactTick / mergeTick): per-tick payload
//     without static fields or repeated keys; full states only on
//     transitions.
//  C. Server tick is a guarded in-memory setInterval at 20 Hz with a
//     fixed 50 ms step (worker/room-do.ts); alarm() is only a watchdog.
//     — v3.1 CORRECTION: that interval never ran a single tick live
//     (a hibernating DO is not woken by timers). The tick is now driven
//     by alarms (see alarmTickSteps below), one alarm per tick, with
//     catch-up steps so late alarms keep real-time pace up to the cap.

import { command, movePlayerStep } from './game.js';

export const INTERP_DELAY_MS = 100;
export const TICK_MS = 50; // v3: 20 Hz server tick + 20 Hz client input, 1:1
export const MAX_EXTRAPOLATE_MS = 100;

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

// ---- Snapshot buffer -------------------------------------------------
// v3.1 — alarm-driven server tick. The v3 setInterval tick never ran
// a single tick live: a Durable Object hibernates when idle, and
// setInterval does not wake it (Cloudflare's own guidance is to use
// alarms for periodic work in a DO). Alarms fire late — a storage write
// per tick with best-effort timing — so each alarm runs as many fixed
// 50 ms steps as elapsed since the last alarm, capped so a long stall
// cannot spiral into dozens of catch-up steps. The synthetic clock
// (tickNow += 50 per step) keeps the game deterministic; the cap bounds
// how far behind real time the game can fall after a stall.
export const MAX_TICK_CATCHUP = 4;
export function alarmTickSteps(elapsedMs, tickMs = TICK_MS, maxSteps = MAX_TICK_CATCHUP) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  return Math.min(maxSteps, Math.max(1, Math.round(elapsedMs / tickMs)));
}

export function createSnapshotBuffer() {
  return { snaps: [], lastTick: -1 };
}

// Push a server snapshot. Returns false when the snapshot is stale /
// out-of-order and must be dropped (tick <= last accepted tick).
export function pushSnapshot(buf, snap) {
  if (!snap || typeof snap.tick !== 'number') return false;
  if (snap.tick <= buf.lastTick) return false;
  buf.lastTick = snap.tick;
  buf.snaps.push(snap);
  // Keep only the last ~500 ms of history.
  while (buf.snaps.length > 18) buf.snaps.shift();
  const cutoff = snap.serverTime - 600;
  while (buf.snaps.length > 2 && buf.snaps[0].serverTime < cutoff) buf.snaps.shift();
  return true;
}

// Full states (hello/state) are authoritative transitions, not snapshots:
// accept them even when the server tick has not advanced since the last
// snapshot. The server tick stays 0 for the whole lobby phase (it only
// increments once a round is running), so without this every lobby
// broadcast — config acks, start acks, join updates — has the same tick
// as hello and pushSnapshot drops it as "stale": the lobby UI freezes
// (team sizes never change on screen, "Let's play" looks dead) even
// though the server accepted the op. A repeated "Let's play" then fails
// with "A round is already playing" because the first one DID start the
// round on the server. When the tick did not advance, re-base the
// interpolation history on the new state instead of dropping it. The
// stale guard stays in place for compact 'tick' messages, where
// ordering is what keeps interpolation smooth.
export function acceptFullState(buf, snap) {
  if (!snap || typeof snap.tick !== 'number') return false;
  if (pushSnapshot(buf, snap)) return true;
  buf.snaps.length = 0;
  buf.lastTick = -1;
  return pushSnapshot(buf, snap);
}

// Interpolate one player's continuous fields between two snapshots.
function interpPlayer(prev, next, t) {
  if (!prev) return { ...next };
  if (!next) return { ...prev };
  return {
    ...next,
    x: lerp(prev.x, next.x, t),
    z: lerp(prev.z, next.z, t),
  };
}

// Sample the render state for renderTime (server-clock ms).
// Returns {state, mode} where mode is 'interp' | 'latest' | 'extrap' | 'empty'.
// Discrete fields (phase, scores, round, ball holder, etc.) always come
// from the newer snapshot; only x/z are interpolated.
export function sampleRenderState(buf, renderTime) {
  const snaps = buf.snaps;
  if (snaps.length === 0) return { state: null, mode: 'empty' };
  if (snaps.length === 1) return { state: snaps[0].state, mode: 'latest' };
  // Find the pair bracketing renderTime.
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const next = snaps[i];
    if (renderTime >= prev.serverTime && renderTime <= next.serverTime) {
      const span = next.serverTime - prev.serverTime;
      const t = span > 0 ? (renderTime - prev.serverTime) / span : 1;
      const prevPlayers = new Map((prev.state.players || []).map((p) => [p.id, p]));
      const players = (next.state.players || []).map((p) =>
        interpPlayer(prevPlayers.get(p.id), p, t),
      );
      let ball = next.state.ball;
      if (prev.state.ball && next.state.ball) {
        ball = {
          ...next.state.ball,
          x: lerp(prev.state.ball.x, next.state.ball.x, t),
          z: lerp(prev.state.ball.z, next.state.ball.z, t),
        };
      }
      return { state: { ...next.state, players, ball }, mode: 'interp' };
    }
  }
  const latest = snaps[snaps.length - 1];
  if (renderTime > latest.serverTime) {
    // Short extrapolation, capped, using last known movement direction.
    const dt = Math.min(renderTime - latest.serverTime, MAX_EXTRAPOLATE_MS) / 1000;
    const prev = snaps[snaps.length - 2];
    const players = (latest.state.players || []).map((p) => {
      const q = prev ? (prev.state.players || []).find((x) => x.id === p.id) : null;
      if (!q) return { ...p };
      // Velocity implied by the last two snapshots.
      const span = Math.max(1, latest.serverTime - prev.serverTime) / 1000;
      const vx = (p.x - q.x) / span;
      const vz = (p.z - q.z) / span;
      return { ...p, x: clamp(p.x + vx * dt, -9.55, 9.55), z: clamp(p.z + vz * dt, -6.05, 6.05) };
    });
    return { state: { ...latest.state, players }, mode: 'extrap' };
  }
  return { state: snaps[0].state, mode: 'latest' };
}

// ---- Server-clock estimate ------------------------------------------
// renderTime must advance smoothly with the local clock, NOT jump every
// time a snapshot arrives (arrival times jitter by +/-30 ms, so
// `latestServerTime - 100` would itself jump, and anchoring
// `serverNow = lastServerTime + (localNow - lastRecvLocal)` stalls for
// one frame on every arrival and then jumps two frames' worth —
// measured in repro-jitter.mjs before this fix).
// Correct approach: keep ONE clock offset (serverTime - localTime),
// set it on the first snapshot, then slew it by at most 2 ms per
// snapshot. serverNow = localNow + offset advances at exactly 1x.
export function createServerClock() {
  return { offset: null };
}
export function clockUpdate(clock, serverTime, localNow) {
  const sample = serverTime - localNow;
  if (clock.offset === null) { clock.offset = sample; return; }
  const diff = sample - clock.offset;
  clock.offset += Math.max(-2, Math.min(2, diff));
}
export function clockNow(clock, localNow) {
  return clock.offset === null ? localNow : localNow + clock.offset;
}
export function estimateServerNow(lastServerTime, lastRecvLocal, localNow) {
  // Back-compat helper for the single-sample case; the clock above is
  // what the client actually uses (see createServerClock).
  if (lastServerTime == null || lastRecvLocal == null) return localNow;
  return lastServerTime + (localNow - lastRecvLocal);
}

// ---- Local-player reconciliation ------------------------------------
// predicted: where the client thinks the local player is (dead-reckoned
// from its own inputs). authoritative: where the server says it is.
// Small disagreement (<15 cm) is normal network noise — keep prediction,
// so the player never visibly snaps. Medium: blend 35% toward server.
// Large (>80 cm): something real happened (hit / teleport / round reset)
// — snap.
export function reconcileLocal(predicted, authoritative) {
  const dx = authoritative.x - predicted.x;
  const dz = authoritative.z - predicted.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.15) return { x: predicted.x, z: predicted.z, error: dist, mode: 'keep' };
  if (dist < 0.8) {
    return { x: predicted.x + dx * 0.35, z: predicted.z + dz * 0.35, error: dist, mode: 'blend' };
  }
  return { x: authoritative.x, z: authoritative.z, error: dist, mode: 'snap' };
}

// ---- Server-side input queue ----------------------------------------
// Inputs must be applied only at a tick boundary, in seq order, never
// on arrival — otherwise two inputs arriving 5 ms apart move the player
// by different amounts depending on network jitter, and an action
// broadcast immediately after arrival can overtake the previous tick.
export function createInputQueue() {
  return { byPlayer: new Map() };
}
export function queueInput(q, playerId, input) {
  if (!q.byPlayer.has(playerId)) q.byPlayer.set(playerId, []);
  const list = q.byPlayer.get(playerId);
  // Keep only the newest movement input per player per tick, but never
  // drop a one-shot action (throw/pass/interact/cancel).
  if (!input.action) {
    const idx = list.findIndex((x) => !x.action);
    if (idx >= 0) list[idx] = input;
    else list.push(input);
  } else {
    list.push(input);
  }
  if (list.length > 8) list.splice(0, list.length - 8);
}
export function drainInputs(q) {
  const out = [];
  for (const [playerId, list] of q.byPlayer) {
    list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    for (const input of list) out.push({ playerId, input });
  }
  q.byPlayer.clear();
  // Global seq order is not meaningful across players; per-player order
  // is what matters, and command() drops stale seqs anyway.
  return out;
}

// ---- v3: client-side prediction + input replay ----------------------
// v2's reconcileLocal() compared the CURRENT predicted position directly
// against a snapshot that is ~RTT old. At 150 ms RTT and 4.5 m/s that
// is a ~68 cm "error" even with zero desync — so v2 yanked the player
// backward on every snapshot (the rubber-banding). Correct approach:
// the server echoes lastProcessedSeq (ack) per player; the client keeps
// every input it sent (seq > ack), starts from the server's authoritative
// position, and REPLAYS only the unacknowledged inputs through the exact
// same step the server runs (command() + movePlayerStep(), one 50 ms
// step per input). The replayed position is the present-tense estimate;
// the gap to the authoritative position is expected latency, not an
// error. Only a huge gap (>80 cm) means a real event (hit / teleport /
// round reset) and snaps.

export const REPLAY_DT_S = 0.05; // one server tick (20 Hz)
export const MAX_PENDING_INPUTS = 30;

export function createInputLog() {
  return { inputs: [] };
}
export function logInput(log, input) {
  if (!log) return;
  log.inputs.push({
    seq: input.seq,
    round: input.round,
    mx: input.mx || 0,
    mz: input.mz || 0,
    ax: input.ax || 0,
    az: input.az || 0,
    interact: !!input.interact,
    charging: !!input.charging,
    charge: input.charge,
    action: input.action || '',
  });
  if (log.inputs.length > MAX_PENDING_INPUTS)
    log.inputs.splice(0, log.inputs.length - MAX_PENDING_INPUTS);
}
export function flushInputLog(log) {
  if (log) log.inputs.length = 0;
}

// Apply ONE input to a player object exactly as the server does:
// command() (input -> mx/mz/ax/az/charging/action) then one 50 ms
// movePlayerStep(). `gameCtx` is the authoritative state (phase,
// ball.holder, round, clock) — read-only here. This is the same code
// path the server runs, so replay parity is by construction.
export function predictStep(p, gameCtx, input) {
  const mini = {
    players: [p],
    phase: gameCtx.phase,
    round: gameCtx.round,
    clock: gameCtx.clock || 0,
    ready: gameCtx.ready || 0,
    striker: gameCtx.striker,
    // attack MUST be carried over: movePlayerStep's Tower Zone check is
    // `p.team !== g.attack` — without it, undefined !== team is always
    // true and every player replays at the 0.58 zone speed near center
    // (caught by test-netcode test 8).
    attack: gameCtx.attack,
    ball: { holder: gameCtx.ball ? gameCtx.ball.holder : null },
  };
  command(mini, p.id, input);
  movePlayerStep(p, mini, REPLAY_DT_S);
}

// Replay the client's unacknowledged inputs from the authoritative
// position. `authMe` is the authoritative local player from the latest
// snapshot/tick; `gameCtx` is that same state (phase/ball/round/clock);
// `log` is the pending-input log; `ackSeq` is the server's
// lastProcessedSeq for this player (falls back to authMe.seq, which the
// server sets to the last applied input seq). Returns a fresh player
// object with the replayed x/z/ax/az (all other fields copied from
// authMe) plus {error, mode}. The error is the distance between the
// replayed and authoritative positions — that is expected latency (the
// unacknowledged movement), NOT an error to correct, so there is
// deliberately NO distance-based snap here: at 150 ms RTT and Chappal
// Dash speed the gap is 0.93 m, and v2's 0.8 m snap threshold would
// have treated it as a teleport and yanked the player backward. The
// replay re-bases from the authoritative position on every snapshot,
// so a real event (hit / teleport / round reset) is picked up by the
// next snapshot and by the caller's flush on round/phase change, stun,
// or death. Only a non-finite result (a bug) falls back to
// authoritative (mode 'snap').
export function replayLocal(authMe, gameCtx, log, ackSeq) {
  const p = { ...authMe };
  if (!log || !log.inputs.length) return { ...p, error: 0, mode: 'replay' };
  const ack = Math.max(ackSeq || 0, authMe.seq || 0);
  const pending = log.inputs
    .filter(
      (i) =>
        (i.seq || 0) > ack &&
        (i.round === undefined || i.round === gameCtx.round),
    )
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  // Prune acknowledged inputs from the log so it stays small.
  log.inputs = pending;
  for (const input of pending) predictStep(p, gameCtx, input);
  const error = Math.hypot(p.x - authMe.x, p.z - authMe.z);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
    return { ...authMe, error, mode: 'snap' };
  }
  return { ...p, error, mode: 'replay' };
}

// ---- v3: compact tick updates ---------------------------------------
// Broadcasting the full publicState() 20x/sec repeats static data
// (names, teams, looks), full-precision floats and object keys on every
// tick. The compact tick sends only what changes, as positional arrays
// with quantized numbers; static per-player fields (name/team/look) are
// merged back from the last full state on the client. Full states are
// still sent on hello and on any discrete transition (event/phase/round/
// scores change), so a client that missed a field re-syncs within one
// event.

const q3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
const q2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const q1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);

// Player tick fields, in order:
// [id, x, z, ax, az, alive, carry, buff, buffTime, charge, charging,
//  anim, stun, place, interact, mx, mz, seq, inTowerZone, cool, bot]
// carry: stone id, or -1 for null. buff: '' for none.
function compactPlayer(p) {
  return [
    p.id,
    q3(p.x),
    q3(p.z),
    q3(p.ax),
    q3(p.az),
    p.alive ? 1 : 0,
    p.carry === null || p.carry === undefined ? -1 : p.carry,
    p.buff || '',
    q1(p.buffTime || 0),
    q2(p.charge || 0),
    p.charging ? 1 : 0,
    q2(p.anim || 0),
    q2(p.stun || 0),
    q2(p.place || 0),
    p.interact ? 1 : 0,
    q2(p.mx || 0),
    q2(p.mz || 0),
    p.seq || 0,
    p.inTowerZone ? 1 : 0,
    q2(p.cool || 0),
    p.bot ? 1 : 0,
  ];
}
// Ball tick fields: [x, y, z, vx, vy, vz, mode, holder, from, lock,
// power, passTo, reboundAt, travel, spin]
function compactBall(b) {
  if (!b) return null;
  return [
    q3(b.x),
    q3(b.y),
    q3(b.z),
    q3(b.vx),
    q3(b.vy),
    q3(b.vz),
    b.mode || '',
    b.holder || '',
    b.from || '',
    q2(b.lock || 0),
    q2(b.power || 0),
    b.passTo || '',
    q2(b.reboundAt || 0),
    q2(b.travel || 0),
    q2(b.spin || 0),
  ];
}

export function compactTick(g, tick, serverTime, ack) {
  return {
    type: 'tick',
    tick,
    serverTime,
    ack: ack || {},
    clock: q2(g.clock || 0),
    phase: g.phase,
    round: g.round,
    scores: g.scores || [0, 0],
    time: q1(g.time || 0),
    until: q1(g.until || 0),
    ready: q2(g.ready || 0),
    stack: g.stack || 0,
    attempts: g.attempts || 0,
    event: g.event || 0,
    message: g.message || '',
    host: g.host || '',
    striker: g.striker || '',
    attack: g.attack,
    sfxSeq: g.sfxSeq || 0,
    sfxType: g.sfxType || '',
    players: (g.players || []).map(compactPlayer),
    ball: compactBall(g.ball),
    stones: (g.stones || []).map((s) => [
      s.id,
      q3(s.x),
      q3(s.z),
      s.placed ? 1 : 0,
      s.held === null || s.held === undefined ? '' : s.held,
      q2(s.placedAt || 0),
    ]),
    // Powerups are keyed by uid (world.js renders them by uid) and the
    // visual needs name/color/duration/spawnAt — all carried here so a
    // powerup first seen via a tick still renders. (Spawns also force a
    // full state — see room-do.ts — this is belt and braces.)
    powerups: (g.powerups || []).map((pu) => [
      pu.uid || pu.id,
      q3(pu.x),
      q3(pu.z),
      pu.type || '',
      pu.name || '',
      pu.color || '',
      q1(pu.duration || 0),
      q2(pu.spawnAt || 0),
    ]),
    // Decoys: [id, x, z, ax, az, mx, mz, ownerId, team, carry, buffTime,
    // until]. Static display fields (name/look/anim/charge/...) come
    // from the base state via merge-by-id.
    decoys: (g.decoys || []).map((dc) => [
      dc.id,
      q3(dc.x),
      q3(dc.z),
      q3(dc.ax),
      q3(dc.az),
      q2(dc.mx || 0),
      q2(dc.mz || 0),
      dc.ownerId || '',
      dc.team,
      dc.carry === null || dc.carry === undefined ? -1 : dc.carry,
      q1(dc.buffTime || 0),
      q2(dc.until || 0),
    ]),
  };
}

// Merge a compact tick into the last full state, producing a full state
// (same shape as publicState) for the snapshot buffer. Static
// per-player fields (name/team/look) come from `base`; every tick field
// overwrites. Unknown player ids (should not happen — joins force a
// full state) get a minimal placeholder.
export function mergeTick(base, tick) {
  if (!base || !tick) return null;
  const byId = new Map((base.players || []).map((p) => [p.id, p]));
  const players = (tick.players || []).map((arr) => {
    const [
      id, x, z, ax, az, alive, carry, buff, buffTime, charge, charging,
      anim, stun, place, interact, mx, mz, seq, inTowerZone, cool, bot,
    ] = arr;
    const prev = byId.get(id) || { id, name: '', team: 0, look: 0 };
    return {
      ...prev,
      x, z, ax, az,
      alive: alive === 1,
      carry: carry === -1 ? null : carry,
      buff: buff || null,
      buffTime,
      charge,
      charging: charging === 1,
      anim,
      stun,
      place,
      interact: interact === 1,
      mx, mz,
      seq,
      inTowerZone: inTowerZone === 1,
      cool,
      bot: bot === 1,
    };
  });
  const b = tick.ball;
  const ball = base.ball ? { ...base.ball } : {};
  if (b) {
    const [x, y, z, vx, vy, vz, mode, holder, from, lock, power, passTo, reboundAt, travel, spin] = b;
    Object.assign(ball, {
      x, y, z, vx, vy, vz,
      mode,
      holder: holder || null,
      from: from || null,
      lock,
      power,
      passTo: passTo || null,
      reboundAt,
      travel,
      spin,
    });
  }
  return {
    ...base,
    clock: tick.clock,
    phase: tick.phase,
    round: tick.round,
    scores: tick.scores,
    time: tick.time,
    until: tick.until,
    ready: tick.ready,
    stack: tick.stack,
    attempts: tick.attempts,
    event: tick.event,
    message: tick.message,
    host: tick.host,
    striker: tick.striker,
    attack: tick.attack,
    sfxSeq: tick.sfxSeq,
    sfxType: tick.sfxType,
    players,
    ball,
    // Entity arrays merge by key, preserving base fields the tick does
    // not carry (stone scatterAt/peakY/spin, powerup display fields,
    // decoy look/name/anim/...). New entities (not in base) get a
    // minimal object from the tick fields — spawns also force a full
    // state, so this is only a safety net.
    stones: (tick.stones || []).map(([id, x, z, placed, held, placedAt]) => ({
      ...((base.stones || []).find((s) => s.id === id) || {}),
      id, x, z,
      placed: placed === 1,
      held: held === '' ? null : held,
      placedAt,
    })),
    powerups: (tick.powerups || []).map(([uid, x, z, type, name, color, duration, spawnAt]) => ({
      ...((base.powerups || []).find((pu) => (pu.uid || pu.id) === uid) || {}),
      uid, x, z, type,
      name: name || type,
      color: color || '#d88820',
      duration,
      spawnAt,
    })),
    decoys: (tick.decoys || []).map(([id, x, z, ax, az, mx, mz, ownerId, team, carry, buffTime, until]) => ({
      ...((base.decoys || []).find((dc) => dc.id === id) || {}),
      id, x, z, ax, az, mx, mz, ownerId, team,
      carry: carry === -1 ? null : carry,
      buffTime,
      until,
    })),
  };
}
