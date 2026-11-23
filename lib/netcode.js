// netcode.js — pure, testable multiplayer smoothing for Pitthu.
// No React, no WebSocket, no DOM. Every function here is covered by
// scripts/test-netcode.mjs, so the fix can be verified without playing
// a live match.
//
// Problem it fixes (all verified in the live code, see NETCODE_FIX.md):
//  1. app/pittu.tsx accept() (line 316) did `game.current = g` on every
//     30 Hz server snapshot — a wholesale snap, no interpolation.
//  2. stepOnlineVisuals() (line 51) mutated that SAME authoritative
//     object between snapshots, so the next snapshot overwrote local
//     dead-reckoning — rubber-banding.
//  3. Server worker/room-do.ts applied inputs the moment they arrived
//     (line 453) and broadcast one-shot actions immediately (line 457),
//     so snapshots could arrive out of tick order.
//  4. No server timestamp / tick id on broadcasts, and the client never
//     measured RTT — ping was unknowable, so "ping issues" could not be
//     diagnosed from inside the game.
//
// Fix, in three parts:
//  A. Server: queue inputs, drain them only inside alarm() at the tick
//     boundary, broadcast {tick, serverTime} with every state.
//  B. Client: keep snapshots in a buffer, render remote players + ball
//     interpolated at (latestServerTime - INTERP_DELAY_MS).
//  C. Client: local player is predicted locally and only *reconciled*
//     toward the authoritative position — small errors are kept,
//     medium errors are blended, only large errors snap.

export const INTERP_DELAY_MS = 100;
export const TICK_MS = 33;
export const MAX_EXTRAPOLATE_MS = 100;

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

// ---- Snapshot buffer -------------------------------------------------
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
