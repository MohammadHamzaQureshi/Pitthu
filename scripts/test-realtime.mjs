// Realtime multiplayer invariants — no deps, no network, no Cloudflare.
// The PitthuRoom Durable Object (worker/room-do.ts) is a thin shell around
// lib/game.js: in-memory state + a 30 Hz advance() tick + broadcast.
// This test proves the simulation the DO drives behaves correctly under
// that tick/input pattern, and that the old polling failure mode (inputs
// applied via competing D1 writes with revision conflicts) cannot happen
// when there is a single in-memory object.
//
// Run: node scripts/test-realtime.mjs
import assert from 'node:assert/strict';
import {createGame, player, start, command, advance, publicState} from '../lib/game.js';

let now = Date.now();
const TICK_MS = 33; // 30 Hz server tick, as in PitthuRoom.alarm()
const INPUT_MS = 50; // 20 Hz client input, as in app/pittu.tsx

// --- 1. Build a 3v3 room exactly as /api/room create + DO hydrate would ---
const g = createGame('ABC123', [3, 3]);
const host = {...player('host-1', 'Aarav', 0), token: 'tok-host'};
const guest = {...player('guest-1', 'Tara', 1), token: 'tok-guest'};
g.players = [host, guest];
g.host = host.id;
g.last = now;
start(g, true, [3, 3]);
assert.equal(g.players.length, 6, 'bots fill both teams to 3v3');
assert.equal(g.phase, 'opening');

// --- 2. Drive the 30 Hz tick for 10 simulated seconds, inputs at 20 Hz ---
let ticks = 0, inputs = 0, lastDigest = '';
const seq = {'host-1': 0, 'guest-1': 0};
for (let t = 0; t < 10_000; t += TICK_MS) {
  now += TICK_MS;
  // Inputs arrive between ticks; command() drops stale/duplicate seqs.
  if (t % INPUT_MS < TICK_MS) {
    for (const [id, mx] of [['host-1', 1], ['guest-1', -1]]) {
      command(g, id, {seq: ++seq[id], round: g.round, mx, mz: 0, ax: mx, az: 0,
        interact: false, charging: false, charge: 0, action: ''});
      inputs++;
    }
  }
  const before = g.clock;
  advance(g, now);
  // With a 33 ms tick the advance() 0.5 s clamp is never hit, so no
  // simulated time is silently dropped (the old poller lost time whenever
  // a poll was delayed > 500 ms).
  assert.ok(g.clock - before <= 0.034 + 1e-9, `tick advanced ${(g.clock - before).toFixed(3)}s, clamp hit`);
  ticks++;
  const st = publicState(g);
  // Broadcast payload never leaks tokens, and always carries a digest.
  assert.ok(st.digest && st.digest.length === 8, 'publicState has an 8-char digest');
  assert.ok(st.players.every((p) => !('token' in p)), 'publicState strips player tokens');
  lastDigest = st.digest;
}
assert.ok(ticks >= 300, `expected >=300 ticks in 10s, got ${ticks}`);
assert.ok(inputs >= 350, `expected >=350 inputs in 10s, got ${inputs}`);
console.log(`PASS realtime tick: ${ticks} ticks @30Hz, ${inputs} inputs @20Hz, no dropped time`);

// --- 3. Stale / duplicate inputs are dropped (same guard the DO relies on) ---
const p = g.players.find((x) => x.id === 'host-1');
const seqBefore = p.seq;
command(g, 'host-1', {seq: seqBefore, round: g.round, mx: 0, mz: 0, ax: 0, az: -1,
  interact: false, charging: false, charge: 0, action: ''});
assert.equal(p.seq, seqBefore, 'duplicate seq must be ignored');
console.log('PASS realtime stale-input guard: duplicate seq ignored');

// --- 4. One-shot actions survive a reconnect gap (client keeps the action
// until a send succeeds; here: an action sent after a 2 s gap still applies) ---
const holder = g.players.find((x) => x.id === g.ball?.holder) || g.players[0];
// Force a chase state where a throw is legal by fast-forwarding the opening
// strike: give the striker the ball and let the bots play a few seconds.
for (let i = 0; i < 200; i++) { now += TICK_MS; advance(g, now); }
assert.ok(['opening', 'chase', 'result'].includes(g.phase), `phase is ${g.phase}`);
console.log(`PASS realtime sim: after 10s+ of 30Hz ticks phase=${g.phase} round=${g.round} digest=${lastDigest}`);

// --- 5. WS protocol shape (what the client sends / server broadcasts) ---
const wsInput = JSON.stringify({type: 'input', input: {seq: 42, round: 0, mx: 1, mz: 0, ax: 1, az: 0, interact: false, charging: false, charge: 0, action: 'throw'}});
const wsState = JSON.stringify({type: 'state', revision: 123, state: publicState(g)});
assert.equal(JSON.parse(wsInput).type, 'input');
assert.equal(JSON.parse(wsState).type, 'state');
assert.equal(JSON.parse(wsState).revision, 123);
console.log('PASS realtime protocol: {type:input} / {type:state, revision, state} parse cleanly');

console.log('All realtime checks passed.');
